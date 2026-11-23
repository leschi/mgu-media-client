'use strict';
/**
 * jellyfin.js - talking to a Jellyfin server, for node 8 on the head unit.
 *
 * Signing in: the server's address, then either Quick Connect (the app shows a code, the user enters it
 * in a signed-in Jellyfin app or the web page: profile -> Quick Connect; no password typed in the car)
 * or the user name and password typed with the on-screen keyboard. What is kept is the access token,
 * not the password.
 *
 * Video: the server transcodes to HLS (H.264 + AAC in TS segments) at the size the cluster can take
 * (480x270 fits cluster-render's upload budget); our decoder takes H.264 Baseline only,
 * so the URL asks for it. The playlist covers the whole video (the server starts transcoding at the
 * segment asked for): a start position is a segment to start at (hls.js startAt).
 * Music: the track's own file where BMW's player plays it (mp3, flac, ogg, wav, aac, m4a), else an mp3.
 *
 *   const jf = new Jellyfin({ deviceId, lookup, base: 'http://192.168.1.10:8096' });
 *   await jf.info(); const qc = await jf.quickStart(); ... await jf.quickCheck(qc.secret) -> true; await jf.quickFinish(qc.secret)
 *   await jf.views(); await jf.children(view); jf.videoUrl(id, { mediaSourceId, playSessionId })
 */
const http = require('http');
const https = require('https');
const url = require('url');

const PRODUCT = 'MGU Media Client';
const VERSION = '0.6.0';
const TICKS = 10000;                  // Jellyfin's ticks: 100 ns, 10000 per ms
// what the car's player plays from a file, by Jellyfin's container name
const AUDIO_OK = [[/^mp3$/, 'mp3'], [/^flac$/, 'flac'], [/^wav$/, 'wav'], [/^aac$/, 'aac'], [/^ogg$/, 'ogg', /vorbis/], [/m4a|mp4/, 'm4a', /^aac$/]];
// the libraries the app lists (photos, books, live TV are left out)
const VIEW_KINDS = ['movies', 'tvshows', 'music', 'homevideos', 'musicvideos', 'boxsets', 'playlists', 'mixed', ''];

/** one HTTP(S) request -> { status, body (Buffer), json() } */
function request(method, u, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
        const headers = Object.assign({}, opts.headers || {});
        if (opts.body != null) headers['Content-Length'] = Buffer.byteLength(opts.body);
        // (ecdhCurve auto: node 8 offers only P-256 by default; servers that take P-384 only (a Let's Encrypt ECDSA setup) refused the handshake)
        const o = Object.assign(url.parse(u), { method, headers, lookup: opts.lookup, ecdhCurve: 'auto' });
        const req = (o.protocol === 'http:' ? http : https).request(o, (res) => {
            const parts = [];
            res.on('data', (d) => parts.push(d));
            res.on('end', () => {
                const body = Buffer.concat(parts);
                resolve({ status: res.statusCode, headers: res.headers, body, json: () => JSON.parse(String(body) || 'null') });
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        const ms = opts.timeout || 15000;
        req.setTimeout(ms, () => { req.abort(); reject(new Error('no answer in ' + ms / 1000 + ' s: ' + u.replace(/[?].*/, ''))); });
        req.end(opts.body);
    });
}

function qs(o) { return Object.keys(o).filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== '').map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&'); }

/** an item, as the lists need it (times in ms) */
function item(m) {
    const t = m.Type;
    const leaf = ['Movie', 'Episode', 'Audio', 'Video', 'MusicVideo'].indexOf(t) >= 0;
    const sub = t === 'Episode' ? [m.SeriesName, m.ParentIndexNumber != null ? 'S' + m.ParentIndexNumber + 'E' + (m.IndexNumber != null ? m.IndexNumber : '?') : ''].filter(Boolean).join(' ')
        : t === 'Audio' ? [m.AlbumArtist || (m.Artists || [])[0], m.Album].filter(Boolean).join(' - ')
        : t === 'MusicAlbum' ? m.AlbumArtist || ''
        : t === 'Season' ? m.SeriesName || ''
        : t === 'CollectionFolder' || t === 'UserView' ? m.CollectionType || ''
        : m.ProductionYear ? String(m.ProductionYear) : '';
    const ud = m.UserData || {}, tags = m.ImageTags || {};
    // the picture: its own, else the series' (an episode without one) or the album's (a track)
    const img = tags.Primary ? m.Id : m.SeriesPrimaryImageTag ? m.SeriesId : m.AlbumPrimaryImageTag ? m.AlbumId : null;
    return { id: m.Id, title: m.Name || '?', sub, type: t, kind: m.CollectionType || '', leaf, audio: t === 'Audio', img,
        duration: Math.round((m.RunTimeTicks || 0) / TICKS), offset: Math.round((ud.PlaybackPositionTicks || 0) / TICKS) };
}

class Jellyfin {
    constructor(o) {
        o = o || {};
        this.deviceId = o.deviceId;
        this.lookup = o.lookup;
        this.req = o.request || request;
        this.base = (o.base || '').replace(/\/+$/, '');
        this.token = o.token || '';
        this.userId = o.userId || '';
        this.legacy = null;           // the server has the /Users/{id}/... routes only (before 10.9)
    }

    auth(token) {
        const t = token === undefined ? this.token : token;
        return 'MediaBrowser Client="' + PRODUCT + '", Device="BMW MGU", DeviceId="' + this.deviceId + '", Version="' + VERSION + '"' + (t ? ', Token="' + t + '"' : '');
    }

    headers(token) {
        const a = this.auth(token);
        // (X-Emby-Authorization: what servers before 10.9 read)
        return { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: a, 'X-Emby-Authorization': a };
    }

    async _call(method, p, body, o) {
        o = o || {};
        const r = await this.req(method, this.base + p, { headers: this.headers(o.token), lookup: this.lookup, timeout: o.timeout, body: body != null ? JSON.stringify(body) : undefined });
        if (r.status === 401) throw new Error(o.signIn ? 'wrong user name or password (401)' : 'not signed in (401): sign in again');
        if (o.soft && (r.status === 404 || r.status === 405)) return { missing: r.status };
        if (r.status < 200 || r.status >= 300) throw new Error('http ' + r.status + ' ' + p.replace(/\?.*/, ''));
        return r.status === 204 || !r.body.length ? null : r.json();
    }

    /** the route of servers from 10.9 on, else the old /Users/{id}/... one */
    async _user(now, old, q) {
        const query = '?' + qs(q);
        if (this.legacy !== true) {
            const j = await this._call('GET', now + query, null, { soft: true });
            if (!j || !j.missing) { this.legacy = false; return j; }
            this.legacy = true;
        }
        return this._call('GET', old + query);
    }

    /* ---- signing in ---- */
    /** does a Jellyfin server answer at base: { name, version, id }; a redirect (http -> https) moves base */
    async info() {
        const r = await this.req('GET', this.base + '/System/Info/Public', { headers: this.headers(''), lookup: this.lookup, timeout: 6000 });
        const to = r.status >= 300 && r.status < 400 && r.headers && r.headers.location;
        if (to && !this.moved) {
            this.moved = true;
            this.base = url.resolve(this.base + '/System/Info/Public', to).replace(/\/System\/Info\/Public.*$/i, '');
            try { return await this.info(); } finally { this.moved = false; }
        }
        if (r.status !== 200) throw new Error('http ' + r.status + ': no Jellyfin server here');
        let j = null;
        try { j = r.json(); } catch (e) { /* not JSON */ }
        if (!j || !j.Version) throw new Error('no Jellyfin server here');
        return { name: j.ServerName || this.base, version: j.Version, id: j.Id };
    }

    _signedIn(j) {
        if (!j || !j.AccessToken) throw new Error('the server gave no token');
        this.token = j.AccessToken; this.userId = j.User && j.User.Id;
        return { token: this.token, userId: this.userId, userName: j.User && j.User.Name };
    }

    async signIn(user, pw) { return this._signedIn(await this._call('POST', '/Users/AuthenticateByName', { Username: user, Pw: pw }, { token: '', signIn: true })); }

    /** a Quick Connect code: { code, secret } (servers before 10.9 take GET) */
    async quickStart() {
        let j = await this._call('POST', '/QuickConnect/Initiate', null, { token: '', soft: true });
        if (j && j.missing) j = await this._call('GET', '/QuickConnect/Initiate', null, { token: '', soft: true });
        if (!j || j.missing || !j.Code) throw new Error('Quick Connect is off on this server (Dashboard -> General -> Quick Connect)');
        return { code: j.Code, secret: j.Secret };
    }

    /** true once the code was entered in a signed-in Jellyfin app */
    async quickCheck(secret) { const j = await this._call('GET', '/QuickConnect/Connect?' + qs({ Secret: secret }), null, { token: '' }); return !!(j && j.Authenticated); }

    async quickFinish(secret) { return this._signedIn(await this._call('POST', '/Users/AuthenticateWithQuickConnect', { Secret: secret }, { token: '' })); }

    /** a server and token entered earlier: still good? */
    async check() { const j = await this._call('GET', '/Users/Me', null, { timeout: 6000, soft: true }); return j && !j.missing ? j.Name : 'ok'; }

    /* ---- the library ---- */
    async views() {
        const j = await this._user('/UserViews', '/Users/' + this.userId + '/Views', { UserId: this.userId });
        return ((j && j.Items) || []).filter((v) => VIEW_KINDS.indexOf(v.CollectionType || '') >= 0).map(item);
    }

    /** what is in a library or folder: a music library by its albums, a series by its seasons */
    async children(it, max) {
        const q = { UserId: this.userId, ParentId: it.id, SortBy: 'SortName', SortOrder: 'Ascending', Limit: max || 300, StartIndex: 0,
            Fields: 'ProductionYear', EnableImages: true, ImageTypeLimit: 1, EnableImageTypes: 'Primary' };
        if (it.kind === 'music') Object.assign(q, { IncludeItemTypes: 'MusicAlbum', Recursive: true, SortBy: 'AlbumArtist,SortName' });
        else if (it.kind === 'tvshows') Object.assign(q, { IncludeItemTypes: 'Series' });
        else if (it.kind === 'movies') Object.assign(q, { IncludeItemTypes: 'Movie,BoxSet', Recursive: true });
        else if (it.type === 'MusicAlbum') Object.assign(q, { SortBy: 'ParentIndexNumber,IndexNumber,SortName' });
        else if (it.type === 'Season' || it.type === 'Series') Object.assign(q, { SortBy: 'ParentIndexNumber,IndexNumber,SortName' });
        const j = await this._user('/Items', '/Users/' + this.userId + '/Items', q);
        return ((j && j.Items) || []).map(item);
    }

    /** continue watching */
    async resume(max) {
        const j = await this._user('/UserItems/Resume', '/Users/' + this.userId + '/Items/Resume', { UserId: this.userId, Limit: max || 50, MediaTypes: 'Video', EnableImages: true, ImageTypeLimit: 1, EnableImageTypes: 'Primary' });
        return ((j && j.Items) || []).map(item);
    }

    /** items by their ids, in that order (what a phone sends the car to play: ./remote) */
    async items(ids) {
        if (!ids.length) return [];
        const j = await this._user('/Items', '/Users/' + this.userId + '/Items', { UserId: this.userId, Ids: ids.join(','), Fields: 'ProductionYear', EnableImages: true, ImageTypeLimit: 1, EnableImageTypes: 'Primary' });
        const got = ((j && j.Items) || []).map(item);
        return ids.map((id) => got.find((x) => x.id === id)).filter(Boolean);
    }

    /* ---- playing ---- */
    /** the item's media source and a play session: { mediaSourceId, playSessionId, container, audioCodec } */
    async playbackInfo(id) {
        const j = await this._call('GET', '/Items/' + id + '/PlaybackInfo?' + qs({ UserId: this.userId }), null, { soft: true });
        const ms = (j && !j.missing && j.MediaSources && j.MediaSources[0]) || {};
        const a = (ms.MediaStreams || []).filter((s) => s.Type === 'Audio')[0];
        return { mediaSourceId: ms.Id || String(id).replace(/-/g, ''), playSessionId: (j && j.PlaySessionId) || '', container: ms.Container || '', audioCodec: a ? a.Codec || '' : '' };
    }

    /** the item's saved resume position (ms), fresh from the server (set here or on another device), else null */
    async resumePos(id) {
        const j = await this._user('/Items/' + id, '/Users/' + this.userId + '/Items/' + id, { UserId: this.userId });
        const ud = j && !j.missing && j.UserData;
        return ud && ud.PlaybackPositionTicks ? Math.round(ud.PlaybackPositionTicks / TICKS) : null;
    }

    /**
     * The token for the streams (playlists, segments, track files): in the URL as ApiKey (10.11 on;
     * api_key, the old name, is off there by default: http 401 on the car with 12.4) and api_key (older
     * servers), and in the Authorization header, which the server's own segment URLs do not carry
     */
    streamHeaders() { return { Authorization: this.auth() }; }

    /** an item's picture (poster, cover) as a PNG no larger than w x h (./png decodes it) */
    async image(id, w, h) {
        const r = await this.req('GET', this.base + '/Items/' + id + '/Images/Primary?' + qs({ maxWidth: w, maxHeight: h, format: 'Png', ApiKey: this.token }),
            { headers: this.streamHeaders(), lookup: this.lookup, timeout: 15000 });
        if (r.status !== 200) throw new Error('picture: http ' + r.status);
        return r.body;
    }

    /** the HLS transcode of a video: H.264 Baseline at w x h, stereo AAC, TS segments */
    videoUrl(id, o) {
        o = o || {};
        const w = o.width || 480, h = o.height || 270;
        return this.base + '/Videos/' + id + '/master.m3u8?' + qs({
            MediaSourceId: o.mediaSourceId, PlaySessionId: o.playSessionId, DeviceId: this.deviceId, ApiKey: this.token, api_key: this.token,
            StartTimeTicks: o.startSec > 0 ? Math.round(o.startSec * 1000 * TICKS) : undefined,
            VideoCodec: 'h264', AudioCodec: 'aac', SegmentContainer: 'ts', Profile: 'baseline', 'h264-profile': 'baseline', Level: 31, 'h264-level': 31,
            MaxWidth: w, MaxHeight: h, VideoBitrate: o.bitrate || 1200000, AudioBitrate: 160000, AudioChannels: 2, TranscodingMaxAudioChannels: 2,
            MaxFramerate: o.fps || 30, AllowVideoStreamCopy: false, AllowAudioStreamCopy: false, BreakOnNonKeyFrames: false, RequireAvc: false,
            SubtitleMethod: o.subtitleIndex != null ? 'Encode' : undefined, SubtitleStreamIndex: o.subtitleIndex,
        });
    }

    /** a track: its own file where the car plays it, else an mp3 the server makes; { url, ext } */
    async trackFile(id) {
        const pi = await this.playbackInfo(id);
        const c = String(pi.container).toLowerCase(), codec = String(pi.audioCodec).toLowerCase();
        const ok = AUDIO_OK.find((x) => x[0].test(c) && (!x[2] || x[2].test(codec)));
        const key = { ApiKey: this.token, api_key: this.token }, headers = this.streamHeaders();
        if (ok) return { url: this.base + '/Audio/' + id + '/stream.' + ok[1] + '?' + qs(Object.assign({ static: true, MediaSourceId: pi.mediaSourceId }, key)), ext: ok[1], headers };
        return { url: this.base + '/Audio/' + id + '/stream.mp3?' + qs(Object.assign({ AudioCodec: 'mp3', AudioBitrate: 256000, MediaSourceId: pi.mediaSourceId, DeviceId: this.deviceId }, key)), ext: 'mp3', headers };
    }

    /** where it is: the server's "continue watching" and played marks (state: start | progress | stop) */
    report(state, o) {
        const p = { start: '/Sessions/Playing', progress: '/Sessions/Playing/Progress', stop: '/Sessions/Playing/Stopped' }[state];
        const body = { ItemId: o.id, MediaSourceId: o.mediaSourceId, PlaySessionId: o.playSessionId, PositionTicks: Math.round((o.timeMs || 0) * TICKS),
            PlayMethod: o.method || 'Transcode', CanSeek: true, IsPaused: !!o.paused };
        return this._call('POST', p, body, { timeout: 8000 }).catch(() => {});
    }

    /** the server's transcode for this session goes */
    stopTranscode(playSessionId) {
        return this._call('DELETE', '/Videos/ActiveEncodings?' + qs({ DeviceId: this.deviceId, PlaySessionId: playSessionId }), null, { timeout: 8000 }).catch(() => {});
    }
}

module.exports = { Jellyfin, request, item, TICKS, PRODUCT };

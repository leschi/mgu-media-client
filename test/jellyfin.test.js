'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('./_harness');
const { Jellyfin, item } = require('../apps/media/jellyfin');
const { HlsSource, hide } = require('../apps/media/hls');
const { demuxTsAll } = require('../apps/media/tsdemux');
const { MusicPlayer } = require('../apps/media/musicplayer');

/** a pretend Jellyfin server: answers by method + URL, records the requests */
function fakeNet(routes) {
    const seen = [];
    const request = (method, u, o) => {
        seen.push({ method, u, headers: o.headers, body: o.body ? JSON.parse(o.body) : null });
        for (const k of Object.keys(routes)) {
            const sp = k.indexOf(' ');
            const m = sp > 0 && /^[A-Z]+$/.test(k.slice(0, sp)) ? k.slice(0, sp) : null, frag = m ? k.slice(sp + 1) : k;
            if ((!m || m === method) && u.indexOf(frag) >= 0) {
                const r = typeof routes[k] === 'function' ? routes[k](u) : routes[k];
                if (r instanceof Error) return Promise.reject(r);
                const body = Buffer.from(r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
                return Promise.resolve({ status: r.status || 200, body, json: () => JSON.parse(String(body) || 'null') });
            }
        }
        return Promise.resolve({ status: 404, body: Buffer.alloc(0), json: () => null });
    };
    return { request, seen };
}

test('jellyfin: the server, Quick Connect (POST, else GET on older servers), the token kept', async () => {
    let approved = false;
    const net = fakeNet({
        '/System/Info/Public': { body: { ServerName: 'Home', Version: '10.10.3', Id: 'srv1' } },
        'POST /QuickConnect/Initiate': { status: 405 },                       // a 10.8 server: GET only
        'GET /QuickConnect/Initiate': { body: { Code: '123456', Secret: 'sec', Authenticated: false } },
        '/QuickConnect/Connect?Secret=sec': () => ({ body: { Authenticated: approved } }),
        'POST /Users/AuthenticateWithQuickConnect': { body: { AccessToken: 'tok', User: { Id: 'u1', Name: 'anna' } } },
    });
    const jf = new Jellyfin({ deviceId: 'dev1', request: net.request, base: 'http://192.168.1.10:8096/' });
    assert.strictEqual(jf.base, 'http://192.168.1.10:8096');
    assert.deepStrictEqual(await jf.info(), { name: 'Home', version: '10.10.3', id: 'srv1' });
    const qc = await jf.quickStart();
    assert.deepStrictEqual(qc, { code: '123456', secret: 'sec' });
    assert.strictEqual(await jf.quickCheck('sec'), false);
    approved = true;
    assert.strictEqual(await jf.quickCheck('sec'), true);
    assert.deepStrictEqual(await jf.quickFinish('sec'), { token: 'tok', userId: 'u1', userName: 'anna' });
    assert.strictEqual(jf.token, 'tok'); assert.strictEqual(jf.userId, 'u1');
    assert.deepStrictEqual(net.seen[net.seen.length - 1].body, { Secret: 'sec' });
    const a = net.seen[0].headers.Authorization;
    assert.ok(/^MediaBrowser Client="MGU Media Client", Device="BMW MGU", DeviceId="dev1", Version="[\d.]+"$/.test(a), a);   // no token yet
    assert.strictEqual(net.seen[0].headers['X-Emby-Authorization'], a);
    assert.ok(/Token="tok"/.test(jf.auth()));
});

test('jellyfin: user and password; a wrong one says so; Quick Connect off says where to turn it on', async () => {
    const net = fakeNet({
        'POST /Users/AuthenticateByName': (u) => ({ body: { AccessToken: 'pwtok', User: { Id: 'u2', Name: 'ben' } } }),
        '/QuickConnect/Initiate': { status: 401 },
    });
    const jf = new Jellyfin({ deviceId: 'd', request: net.request, base: 'http://s:8096' });
    assert.deepStrictEqual(await jf.signIn('ben', 'secret pw'), { token: 'pwtok', userId: 'u2', userName: 'ben' });
    assert.deepStrictEqual(net.seen[0].body, { Username: 'ben', Pw: 'secret pw' });
    let err = null;
    try { await jf.quickStart(); } catch (e) { err = e; }
    assert.ok(err, 'quick connect refused');
    const bad = new Jellyfin({ deviceId: 'd', base: 'http://s', request: fakeNet({ '/Users/AuthenticateByName': { status: 401 } }).request });
    err = null;
    try { await bad.signIn('ben', 'x'); } catch (e) { err = e; }
    assert.ok(err && /wrong user name or password/.test(err.message), err && err.message);
    const off = new Jellyfin({ deviceId: 'd', base: 'http://s', request: fakeNet({ '/QuickConnect/Initiate': { status: 404 } }).request });
    err = null;
    try { await off.quickStart(); } catch (e) { err = e; }
    assert.ok(err && /Quick Connect is off/.test(err.message), err && err.message);
});

test('jellyfin: libraries, a series, albums; the old /Users/{id} routes on a 10.8 server', async () => {
    const lists = {
        views: { Items: [{ Id: 'v1', Name: 'Movies', Type: 'CollectionFolder', CollectionType: 'movies' }, { Id: 'v2', Name: 'Photos', Type: 'CollectionFolder', CollectionType: 'photos' },
            { Id: 'v3', Name: 'Music', Type: 'CollectionFolder', CollectionType: 'music' }] },
        season: { Items: [{ Id: 'e1', Name: 'Pilot', Type: 'Episode', SeriesName: 'Show', ParentIndexNumber: 1, IndexNumber: 1, RunTimeTicks: 2700000 * 10000, UserData: { PlaybackPositionTicks: 600000 * 10000 } }] },
        album: { Items: [{ Id: 't1', Name: 'Song', Type: 'Audio', AlbumArtist: 'Band', Album: 'Album', RunTimeTicks: 2000000000 }] },
    };
    const net = fakeNet({
        '/UserViews': { status: 404 },                                            // (10.8: not there)
        '/Users/u1/Views': { body: lists.views },
        '/Users/u1/Items?': (u) => ({ body: /ParentId=s1/.test(u) ? lists.season : /ParentId=a1/.test(u) ? lists.album : /ParentId=v3/.test(u) ? { Items: [{ Id: 'a1', Name: 'Album', Type: 'MusicAlbum', AlbumArtist: 'Band' }] } : { Items: [] } }),
    });
    const jf = new Jellyfin({ deviceId: 'd', request: net.request, base: 'http://s:8096', token: 'tk', userId: 'u1' });
    const views = await jf.views();
    assert.deepStrictEqual(views.map((v) => [v.title, v.kind, v.leaf]), [['Movies', 'movies', false], ['Music', 'music', false]]);
    assert.strictEqual(jf.legacy, true);
    const albums = await jf.children(views[1]);
    assert.deepStrictEqual(albums.map((a) => [a.title, a.sub, a.leaf]), [['Album', 'Band', false]]);
    const q = net.seen[net.seen.length - 1].u;
    assert.ok(/IncludeItemTypes=MusicAlbum/.test(q) && /Recursive=true/.test(q), q);
    assert.ok(!/\/UserViews/.test(q), 'the old route remembered');
    const eps = await jf.children({ id: 's1', type: 'Season' });
    assert.deepStrictEqual(eps.map((e) => [e.title, e.sub, e.leaf, e.duration, e.offset]), [['Pilot', 'Show S1E1', true, 2700000, 600000]]);
    const tracks = await jf.children(albums[0]);
    assert.deepStrictEqual(tracks.map((t) => [t.title, t.sub, t.audio]), [['Song', 'Band - Album', true]]);
    assert.strictEqual(item({ Type: 'Series', Name: 'S', ProductionYear: 2020 }).leaf, false);
});

test('jellyfin: the video URL asks for Baseline H.264 in TS at 480x270; track files; play reports', async () => {
    const net = fakeNet({
        '/Items/m1/PlaybackInfo': { body: { PlaySessionId: 'ps1', MediaSources: [{ Id: 'src1', Container: 'mkv', MediaStreams: [{ Type: 'Video', Codec: 'hevc' }, { Type: 'Audio', Codec: 'eac3' }] }] } },
        '/Items/t1/PlaybackInfo': { body: { MediaSources: [{ Id: 't1', Container: 'flac', MediaStreams: [{ Type: 'Audio', Codec: 'flac' }] }] } },
        '/Items/t2/PlaybackInfo': { body: { MediaSources: [{ Id: 't2', Container: 'ogg', MediaStreams: [{ Type: 'Audio', Codec: 'opus' }] }] } },
        '/Items/t3/PlaybackInfo': { body: { MediaSources: [{ Id: 't3', Container: 'mov,mp4,m4a,3gp,3g2,mj2', MediaStreams: [{ Type: 'Audio', Codec: 'aac' }] }] } },
        'POST /Sessions/Playing': { status: 204 },
    });
    const jf = new Jellyfin({ deviceId: 'dev', request: net.request, base: 'http://s:8096', token: 'tk', userId: 'u1' });
    const pi = await jf.playbackInfo('m1');
    assert.deepStrictEqual(pi, { mediaSourceId: 'src1', playSessionId: 'ps1', container: 'mkv', audioCodec: 'eac3' });
    const u = jf.videoUrl('m1', pi);
    assert.ok(u.indexOf('http://s:8096/Videos/m1/master.m3u8?MediaSourceId=src1&PlaySessionId=ps1&DeviceId=dev&api_key=tk&') === 0, u);
    for (const p of ['VideoCodec=h264', 'AudioCodec=aac', 'SegmentContainer=ts', 'Profile=baseline', 'h264-profile=baseline', 'MaxWidth=480', 'MaxHeight=270', 'AudioChannels=2', 'AllowVideoStreamCopy=false'])
        assert.ok(u.indexOf('&' + p) > 0, p);
    assert.ok(!/StartTimeTicks/.test(u), 'a start is a segment to start at (hls startAt), not a server offset');
    assert.strictEqual(hide(u).indexOf('tk'), -1, 'the token is not logged');
    assert.deepStrictEqual(await jf.trackFile('t1'), { url: 'http://s:8096/Audio/t1/stream.flac?static=true&MediaSourceId=t1&api_key=tk', ext: 'flac' });
    const opus = await jf.trackFile('t2');
    assert.strictEqual(opus.ext, 'mp3'); assert.ok(/stream\.mp3\?AudioCodec=mp3&/.test(opus.url), opus.url);   // (opus: made an mp3)
    assert.strictEqual((await jf.trackFile('t3')).ext, 'm4a');
    await jf.report('progress', { id: 'm1', mediaSourceId: 'src1', playSessionId: 'ps1', timeMs: 61500 });
    const r = net.seen[net.seen.length - 1];
    assert.strictEqual(r.u, 'http://s:8096/Sessions/Playing/Progress');
    assert.strictEqual(r.body.PositionTicks, 615000000); assert.strictEqual(r.body.PlaySessionId, 'ps1');
});

test('jellyfin: a 401 says to sign in again', async () => {
    const jf = new Jellyfin({ deviceId: 'c', base: 'http://s', token: 'x', userId: 'u', request: fakeNet({ '/UserViews': { status: 401 } }).request });
    let err = null;
    try { await jf.views(); } catch (e) { err = e; }
    assert.ok(err && /sign in again/.test(err.message));
});

const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=480x270,CODECS="avc1.42c01f,mp4a.40.2"\nmain.m3u8?api_key=tk\n';
const whole = (n) => '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n' + Array.from({ length: n }, (x, i) => '#EXTINF:6.0,\nhls1/main/' + i + '.ts?api_key=tk\n').join('') + '#EXT-X-ENDLIST\n';

test('hls: start at a position - the segment holding it; times count from there (Jellyfin: the whole video listed)', async () => {
    const src = new HlsSource('http://s/Videos/m1/master.m3u8', { get: (u) => Promise.resolve(Buffer.from(/master/.test(u) ? MASTER : whole(10))), startAt: 20 });
    await src.open();
    assert.strictEqual(src.startT, 18);
    assert.strictEqual(src.video.segs.length, 7);
    assert.ok(/hls1\/main\/3\.ts/.test(src.video.segs[0].url), src.video.segs[0].url);
    assert.deepStrictEqual(src.video.segs.slice(0, 2).map((s) => s.t), [0, 6]);
    assert.strictEqual(src.warn, '', 'Baseline named: no warning');
    const at0 = new HlsSource('http://s/m.m3u8', { get: () => Promise.resolve(Buffer.from(whole(3))) });
    await at0.open();
    assert.strictEqual(at0.startT, 0); assert.strictEqual(at0.video.segs.length, 3);
});

test('hls: a transcode\'s playlist grows (refresh), segments cached and tried again while not made yet', async () => {
    let made = 2, fails = 0;
    const media = () => '#EXTM3U\n#EXT-X-TARGETDURATION:6\n' + Array.from({ length: made }, (x, i) => '#EXTINF:6.0,\nseg' + i + '.ts\n').join('') + (made >= 4 ? '#EXT-X-ENDLIST\n' : '');
    const get = (u) => {
        if (/index\.m3u8/.test(u)) return Promise.resolve(Buffer.from(media()));
        if (/start\.m3u8/.test(u)) return Promise.resolve(Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=480x270,CODECS="avc1.4d401e,mp4a.40.2"\nsession/x/base/index.m3u8\n'));
        if (/seg3/.test(u) && fails++ < 2) return Promise.reject(new Error('http 404'));
        return Promise.resolve(Buffer.from(u));
    };
    let calls = 0;
    const src = new HlsSource('http://s/video/start.m3u8', { get: (u) => { calls++; return get(u); }, anyProfile: true, retryMs: 5 });
    await src.open();
    assert.ok(/not named H.264 Baseline: avc1.4d401e/.test(src.warn), src.warn);
    assert.strictEqual(src.video.segs.length, 2); assert.strictEqual(src.video.ended, false);
    made = 4;
    await src.refresh();
    assert.deepStrictEqual(src.video.segs.map((s) => [s.url.slice(-8), s.t]), [['seg0.ts', 0], ['seg1.ts', 6], ['seg2.ts', 12], ['seg3.ts', 18]].map((x) => [('/' + x[0]).slice(-8), x[1]]));
    assert.strictEqual(src.video.ended, true);
    const c0 = calls;
    const [a, b] = await Promise.all([src.segment(src.video.segs[3].url), src.segment(src.video.segs[3].url)]);
    assert.strictEqual(String(a), String(b));
    assert.strictEqual(calls - c0, 3, 'one fetch for both askers, two 404s tried again');
    await src.segment(src.video.segs[3].url);
    assert.strictEqual(calls - c0, 3, 'cached');
});

test('tsdemux: a muxed segment (a server transcode) gives the picture and the AAC sound', () => {
    const r = demuxTsAll(fs.readFileSync(path.join(__dirname, 'fixtures', 'av0.ts')));
    assert.strictEqual(r.video.length, 12);
    assert.ok(r.audio && r.audio.length > 1000);
    assert.strictEqual(r.audio[0], 0xff); assert.strictEqual(r.audio[1] & 0xf0, 0xf0);   // ADTS sync
    assert.strictEqual(demuxTsAll(fs.readFileSync(path.join(__dirname, 'fixtures', 'seg0.ts'))).audio, null);
});

/** BMW's player as the music player sees it: a track plays for `len` ms (scaled), then stops */
function fakeSig(lenMs) {
    const calls = [];
    const st = { t0: 0, playing: false, path: '' };
    const elapsed = () => (st.playing ? Math.min(lenMs, Date.now() - st.t0) : 0);
    const sig = {
        hasNative: () => true,
        proxy: () => Promise.resolve({ getValue: (f) => Promise.resolve(f === 'playerState' ? (st.playing && elapsed() < lenMs ? 'PLAYER_STATE_PLAY' : 'PLAYER_STATE_STOP') : { elapsed: elapsed(), total: lenMs }) }),
        onAvailable: (p, fn) => { fn(true); return Promise.resolve(); },
        on: () => Promise.resolve(),
        call: (p, m, a) => {
            calls.push(m + (a && a.path ? ' ' + path.basename(a.path) : ''));
            if (m === 'getListMainSources') return Promise.resolve({ l: [{ sourceID: 1046, name: 'OAPGenericMedia' }] });
            if (m === 'getListMainSinks') return Promise.resolve({ l: [{ sinkID: 1024, name: 'MediaSink_Front' }] });
            if (m === 'getListMainConnections') return Promise.resolve({ l: [] });
            if (m === 'connect') return Promise.resolve({ mainConnectionID: 7, amError: 'E_OK' });
            if (m === 'playFile') { Object.assign(st, { t0: Date.now(), playing: true, path: a.path }); return Promise.resolve({ EntError: 'OK' }); }
            if (m === 'sendButtonEvent' && a.button === 'PAUSE') st.playing = false;
            return Promise.resolve({ EntError: 'OK' });
        },
    };
    return { sig, calls };
}

test('MusicPlayer: each track fetched to a file (named by the server\'s kind), played, the next one at the end; files go', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-music-'));
    const f = fakeSig(2600);
    const tracks = [1, 2, 3].map((i) => ({ id: 't' + i, title: 'T' + i, type: 'Audio', audio: true }));
    const fetched = [];
    const server = { trackFile: (id) => Promise.resolve({ url: 'http://s/' + id, ext: id === 't2' ? 'flac' : 'mp3' }) };
    const m = new MusicPlayer({ server, sig: f.sig, tmp,
        download: (u, file) => { fetched.push(u); fs.writeFileSync(file, 'x'); return Promise.resolve(1); } });
    await m.play(tracks, 0);
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(m.state, 'playing');
    assert.deepStrictEqual(fetched, ['http://s/t1', 'http://s/t2']);           // this one and the next
    m.next();
    await new Promise((r) => setTimeout(r, 1200));
    assert.strictEqual(m.i, 1);
    assert.ok(f.calls.some((c) => c === 'playFile mgu-media-track1.flac'), f.calls.join(', '));
    await new Promise((r) => setTimeout(r, 2400));                               // track 2 ends: track 3
    await new Promise((r) => setTimeout(r, 2400));
    assert.strictEqual(m.i, 2, m.lines().join(' | '));
    await m.stop();
    await new Promise((r) => setTimeout(r, 1700));
    assert.deepStrictEqual(fs.readdirSync(tmp), []);
    fs.rmdirSync(tmp);
});

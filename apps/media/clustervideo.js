'use strict';
/**
 * clustervideo.js - an HLS video on the instrument cluster or the HUD, ONLY WHILE PARKED (./parkgate:
 * speed under 1 km/h and the selector in P; unknown = not parked). Driving off drops the picture at
 * once; the sound goes on (BMW's media player); parked again, the picture comes back where the sound is.
 *
 * Picture: the app fetches the segments (./hls), takes the H.264 out (./tsdemux), decodes it
 * (./h264dec, Baseline) and sends frames to a cluster-render video layer (4:2:0 atlas). Sound: AAC -
 * the audio rendition's segments, or (a server transcode) the sound in the same TS segments - appended to
 * one local file BMW's player plays (it plays local files only; it follows the file as it grows, and
 * near the end it saw it is opened again at its time). Worked on the car in a prior project 0.2.40 - 0.2.44.
 *
 *   const v = new ClusterVideo({ url | source, target: 'map', gate, lookup, sig, log });
 *   v.start(); ... v.lines() (Diag) ... v.stop();
 */
const fs = require('fs');
const { ClusterRender } = require('./cluster_render_client');
const { fitRect, parseTargets, TARGETS } = require('./targets');
const { HlsSource, stripId3 } = require('./hls');
const { demuxTsAll } = require('./tsdemux');
const { SegmentBuffer } = require('./buffer');
const { ShmVideo } = require('./shmvideo');
const { H264Decoder, i420ToAtlas } = require('./h264dec');

const TICK_MS = 15;
const SLICE_MS = 25;                    // decode at most this long per tick (node stays free for the UI)
const AUDIO_FILE = '/tmp/mgu-media-sound.aac';
const AUDIO_LEAD = 2;                   // audio segments in the file before the player starts
const SKIP_NAL = { 6: 1, 9: 1, 12: 1 };   // SEI, access unit delimiter, filler: h264bsd refuses them
// cluster-render writes every layer within one upload budget, 5500 KB/s at most (more and the KOMBI
// dropped the picture): a 640x360 atlas at 24 fps is 8.3 MB/s, so frames went packed or waited - it
// stuttered (car v0.2.40). 'smooth' takes the stream variant whose atlases fit 85 % of it (480x270);
// 'sharp' the largest, as before.
const BUDGET_BPS = 5500 * 1000 * 0.85;
const STATUS_FILE = '/run/cluster-render/status.txt';
const SHM_FILE = '/dev/shm/mgu-video-media';       // the MGU display's video (./shmvideo)

class ClusterVideo {
    constructor(o) {
        this.o = o;
        this.log = o.log || { info() {}, warn() {} };
        // cid: the MGU's own display (./shmvideo), else a cluster-render target
        this.target = o.target === 'cid' || TARGETS[o.target] ? o.target : 'map';
        this.state = 'starting';
        this.events = [];
        this.stats = { decoded: 0, sent: 0, decMs: 0, segs: 0, dropped: 0 };
        this.cr = null; this.layer = 0; this.rect = null;
        this.src = null; this.dec = null; this.atlas = null;
        this.segIdx = 0; this.queue = []; this.pts0 = null;
        this.clock0 = 0;                 // Date.now() at video time 0
        this.fetching = null; this.next = null;
        this.showing = false; this.running = false;
        this.audio = { state: 'off', segs: 0, media: null, line: '' };
        this.quality = o.quality === 'sharp' ? 'sharp' : 'smooth';
        this.budget = '';
        this.svc = { t: 0, lines: [] };
        this.profile = null;             // the stream's H.264 profile_idc (66 Baseline, 77 Main, 100 High)
        this.refreshT = 0;
        this.paused = false; this.pauseAt = 0;
    }

    /** where the video is, in seconds (for a server's "continue watching") */
    position() { return this.paused ? this.pauseAt : this.clock0 ? (Date.now() - this.clock0) / 1000 : 0; }

    /** pause: the picture holds its frame, the clock stops, BMW's player pauses the sound */
    pause() {
        if (this.paused || !this.running) return;
        this.pauseAt = this.position(); this.paused = true;
        if (this.audio.media) this.audio.media.button('PAUSE').catch(() => {});
        this._event('paused at ' + this.pauseAt.toFixed(1) + ' s');
    }
    resume() {
        if (!this.paused) return;
        this.paused = false;
        if (this.clock0) this.clock0 = Date.now() - this.pauseAt * 1000;
        if (this.audio.media) this.audio.media.button('PLAY').catch(() => {});
        this._event('playing on');
    }

    /** the MGU display's picture as the app's page draws it: { file, w, h } while shown, else null */
    screen() { return this.target === 'cid' && this.cr && this.cr.shown && this.showing ? { file: this.cr.file, w: this.cr.w, h: this.cr.h } : null; }

    /** where it is in the whole video (a start position: the segment it started at, ./hls startAt) */
    at() { return ((this.src && this.src.startT) || 0) + this.position(); }

    /** a playlist that grows (a live transcode): read again, every 2 s at most */
    _refresh() {
        if (this.refreshing || Date.now() - this.refreshT < 2000) return this.refreshing || Promise.resolve();
        this.refreshT = Date.now();
        this.refreshing = this.src.refresh().catch((e) => this._event('playlist: ' + (e && e.message))).then(() => { this.refreshing = null; });
        return this.refreshing;
    }

    /** cluster-render's own status (its upload cap, what the target's layers wrote): every 5 s at most */
    _svcStatus() {
        const now = Date.now();
        if (now - this.svc.t < 5000) return this.svc.lines;
        this.svc.t = now;
        try {
            const txt = fs.readFileSync(this.o.statusFile || STATUS_FILE, 'utf8');
            const re = new RegExp('upload|target ' + this.target + '\\b|budget|wrote', 'i');
            this.svc.lines = txt.split('\n').filter((l) => re.test(l)).slice(0, 3).map((l) => 'service: ' + l.trim().slice(0, 150));
        } catch (e) { this.svc.lines = ['service status: ' + (e.code || e.message)]; }
        return this.svc.lines;
    }

    _event(l) { this.events.push(new Date().toTimeString().slice(0, 8) + ' ' + l); if (this.events.length > 6) this.events.shift(); this.log.info('cluster video: ' + l); }

    /** what the user must do for the picture to show ('' when nothing): the Player page shows it without Debug on */
    hint() {
        // (as waze-on-cluster: the middle is ours only in the cluster's Map view, or with it off)
        return this.stockSince && Date.now() - this.stockSince > 8000 ? 'NOT SHOWN: BMW content holds the cluster middle - set Instrument cluster >' +
            ' Central display area to Map view (or Off), as Waze needs; or choose Whole cluster / HUD' : '';
    }

    /** Diag lines */
    lines() {
        const s = this.stats, v = this.src && this.src.video;
        const t = this.clock0 ? this.position().toFixed(1) + ' s' : '-';
        const held = this.hint() ? [this.hint()] : [];
        return held.concat(['video ' + this.target + ': ' + this.state + ', parked check: ' + (this.o.gate ? this.o.gate.why() : '-'),
            'stream: ' + (v ? v.width + 'x' + v.height + ' ' + v.codecs + ', ' + v.segs.length + ' segments' : '-') + ', at ' + t + ', segment ' + this.segIdx,
            'decoded ' + s.decoded + ' (' + (s.decoded ? (s.decMs / s.decoded).toFixed(1) : '-') + ' ms each), sent ' + s.sent + ', late ' + s.dropped + (this.dec ? ', decoder errors ' + this.dec.errors : '') +
                (this.profile !== null ? ', H.264 ' + ({ 66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High' }[this.profile] || 'profile ' + this.profile) + (this.profile !== 66 ? ' (the decoder takes Baseline only)' : '') : '') +
                (this.rect ? ', layer ' + this.rect.w + 'x' + this.rect.h + ' at ' + this.rect.x + ',' + this.rect.y : ''),
            'sound: ' + this.audio.state + (this.audio.line ? ' - ' + this.audio.line : '') +
                (this.syncInfo ? '; sync: picture ' + (this.syncInfo.diff >= 0 ? '+' : '') + (this.syncInfo.diff / 1000).toFixed(2) + ' s to the sound, set ' + this.syncInfo.n + 'x' : ''),
            'quality ' + this.quality + (v && v.fps ? ', ' + Math.round(v.width * v.height * 1.5 * v.fps / 1000) + ' KB/s of atlases' : '') + (this.budget ? ', ' + this.budget : '')]
            .concat(this.buf ? [this.buf.lines()] : [], this._svcStatus(), this.events));
    }

    async start() {
        if (this.running) return;
        this.running = true;
        try {
            this.dec = H264Decoder.load();
            this.src = this.o.source || new HlsSource(this.o.url, { lookup: this.o.lookup, maxWidth: 1088, maxBps: this.quality === 'smooth' ? BUDGET_BPS : 0, get: this.o.get, anyProfile: this.o.anyProfile, startAt: this.o.startAt, headers: this.o.headers });
            this.state = 'loading the playlist';
            if (!this.src.video) await this.src.open();
            if (!this.running) return;
            const v = this.src.video;
            // the segments ahead on the unit's flash (./buffer): picture and sound read them from there
            if (this.o.bufferDir) {
                const segs = () => this.src.video.segs;
                this.buf = new SegmentBuffer({ dir: this.o.bufferDir, aheadS: this.o.bufferS || 600, df: this.o.df, log: this.log,
                    fetch: (i) => this.src.segment(segs()[i].url), count: () => segs().length, time: (i) => (segs()[i] ? segs()[i].t : 0),
                    dur: (i) => (segs()[i] ? segs()[i].dur : 6), ended: () => !!this.src.video.ended, more: () => this._refresh() });
                this.buf.start();
            }
            this._event('playlist: ' + (v.width + 'x' + v.height) + ' ' + v.codecs + ', ' + v.segs.length + ' segments' + (v.ended ? '' : ' so far') +
                (this.src.audio ? ', sound ' + this.src.audio.segs.length : ', sound in the segments') + (this.src.warn ? '; ' + this.src.warn : ''));
            this.cr = this.o.client || (this.target === 'cid' ? new ShmVideo(this.o.shmFile || SHM_FILE)
                : new ClusterRender(this.o.app || 'mgu_vnc', this.o.socketPath || process.env.CLUSTER_RENDER_SOCKET));
            // (a reconnect: the client sends its layers again itself - ours stays ours; a new one would
            // leave the old one stalled, and cluster-render takes 2 video layers in all)
            this.cr.on('ready', () => this._event('cluster-render connected'));
            this.cr.on('layer', (ref, state, reason) => {
                if (ref !== this.layer) return;
                // BMW's own content in the slot (the map area: the cluster's own view) - since when, for the hint
                if (/behind stock|parked/.test(reason || '') && state === 'waiting') { if (!this.stockSince) this.stockSince = Date.now(); }
                else if (state === 'shown') this.stockSince = 0;
                // (the same two states come every few seconds while the slot is retried: logged once)
                const ev = 'layer ' + state + (reason ? ' (' + reason + ')' : '');
                if (ev !== this.lastLayerEv) { this.lastLayerEv = ev; this._event(ev); }
            });
            this.cr.on('refused', (op, ref, reason) => this._event('refused ' + op + ': ' + reason));
            this.cr.on('budget', (cap, max, reason) => { this.budget = 'upload cap ' + cap + ' KB/s' + (reason ? ' (' + reason + ')' : ''); this._event(this.budget); });
            this.cr.connect();
            this.state = 'buffering';
            this.audioWait = Date.now() + 15000;
            this._audioStart();
            this.timer = setInterval(() => this._tick(), TICK_MS);
        } catch (e) {
            this.state = 'error: ' + (e && e.message || e);
            this._event(this.state);
            this.stop();
        }
    }

    /** resolves once the sound is off and the AudioManager connection gone (the next user of it waits) */
    stop() {
        this.running = false;
        clearInterval(this.timer); this.timer = null;
        this._hide();
        if (this.cr && !this.o.client) { try { this.cr.close(); } catch (e) { /* closing */ } }
        this.cr = null;
        if (this.dec) { this.dec.release(); this.dec = null; }
        if (this.buf) { this.buf.stop(); this.buf = null; }
        const m = this.audio.media;
        this.audio.media = null;
        const closing = m ? m.close().catch(() => {}) : Promise.resolve();
        if (this.audio.state !== 'off') this.audio.state = 'stopped';
        setTimeout(() => { try { fs.unlinkSync(AUDIO_FILE); } catch (e) { /* gone */ } }, 3000);
        if (!/^error/.test(this.state)) this.state = 'stopped';
        return closing;
    }

    _targetSize() { return (this.cr && parseTargets(this.cr.targets)[this.target]) || TARGETS[this.target] || [1600, 520]; }

    _show(w, h) {
        if (this.layer || !this.cr || !this.cr.ready) return;
        const sz = this._targetSize();
        this.rect = fitRect(w, h, sz[0], sz[1]);
        // stall_ms: a layer without a frame for that long un-wants the target, which gives the middle back
        // to BMW's map and starts the take-over again (flicker): 30 s rides out a slow segment (waze: 60 s)
        this.layer = this.cr.video(Object.assign({ target: this.target, klass: 'content', contend: 1, vw: w, vh: h, fps: 30, stall_ms: 30000 }, this.rect));
        this.atlas = Buffer.alloc(w * h * 3 / 2);
        this.showing = !!this.layer;
        this._event(this.layer ? 'layer ' + w + 'x' + h + ' on ' + this.target : 'layer refused by the client');
    }

    _hide() {
        if (this.layer && this.cr) { try { this.cr.drop(this.layer); } catch (e) { /* gone */ } }
        this.layer = 0; this.showing = false;
    }

    /** not parked / parked again: the same layer hidden and shown (as waze), not dropped and made anew */
    _visible(on) {
        if (!this.layer || !this.cr || this.showing === on) return;
        try { this.cr.set(this.layer, { visible: on ? 1 : 0 }); } catch (e) { /* gone */ }
        this.showing = on;
    }

    /**
     * The picture follows the sound: the player's own time (elapsed, ms) sets the video clock. Started
     * on the app's guess of when the sound began, the sound ran a few seconds ahead (car v0.2.41): the
     * player plays before its state says so, and the first video segment was still loading.
     */
    _sync(elapsedMs) {
        if (!(elapsedMs > 1000) || /reopen/.test(this.audio.pending || '') || this.paused) return;
        if (!this.clock0) { this.clock0 = Date.now() - elapsedMs; return; }
        const diff = (Date.now() - this.clock0) - elapsedMs;          // > 0: the picture is ahead of the sound
        this.syncInfo = { diff, n: (this.syncInfo ? this.syncInfo.n : 0) + (Math.abs(diff) > 250 ? 1 : 0) };
        if (Math.abs(diff) > 250) this.clock0 += diff;
    }

    /** the segment holding video time t (seconds from the start) */
    _segAt(t) {
        const segs = this.src.video.segs;
        for (let i = segs.length - 1; i >= 0; i--) if (segs[i].t <= t) return i;
        return 0;
    }

    _fetch(i) {
        const segs = this.src.video.segs;
        if (i >= segs.length) return Promise.resolve(null);
        return (this.buf ? this.buf.get(i) : this.src.segment(segs[i].url)).then((b) => { this.stats.segs++; return demuxTsAll(b).video; });
    }

    _tick() {
        if (!this.running || !this.src) return;
        // (the buffer follows the clock - the sound's - also while the picture is off)
        if (this.buf && this.clock0) this.buf.setPos(this._segAt(this.position()));
        const parked = !this.o.gate || this.o.gate.parked();
        if (!parked) {
            if (this.showing || this.state !== 'paused: not parked (the sound goes on)') { this._visible(false); this.queue = []; this.next = null; this.state = 'paused: not parked (the sound goes on)'; this._event('picture off: ' + (this.o.gate ? this.o.gate.why() : '')); }
            return;
        }
        // the clock starts with the sound (up to 15 s for it), else with the first segment
        if (!this.clock0 && this.queue.length && (!/^(fetching|starting)/.test(this.audio.state) || Date.now() > this.audioWait)) this.clock0 = Date.now();
        const now = this.position();
        // paused: the layer keeps its last frame (sent again now and then: cluster-render's stall_ms)
        if (this.paused) {
            if (this.layer && this.lastPic && !this.cr.wantsI420 && Date.now() - (this.lastSent || 0) > 1000) { this.lastSent = Date.now(); this.cr.frame(this.layer, this.lastPic, this.stats.sent + 1); }
            return;
        }
        // parked again after a pause: the picture starts where the sound is (from that segment's start)
        if (!this.queue.length && !this.fetching) {
            const want = this.clock0 ? Math.max(this.segIdx, this._segAt(now)) : this.segIdx;
            if (want >= this.src.video.segs.length) {
                if (!this.src.video.ended) { this._refresh(); return; }       // (a transcode: more is coming)
                if (this.state !== 'done') { this.state = 'done'; this._event('the end of the stream'); this._hide(); }
                return;
            }
            this.segIdx = want;
            this.fetching = (this.next && this.next.i === want ? this.next.p : this._fetch(want)).then((aus) => {
                this.fetching = null; this.next = null;
                if (!aus) return;
                const segT = this.src.video.segs[want].t;
                if (this.pts0 === null && aus.length) this.pts0 = aus[0].pts - segT;
                this.queue = aus.map((a) => ({ t: a.pts - this.pts0, nals: a.nals }));
                this.segIdx = want + 1;
                this.next = { i: want + 1, p: this._fetch(want + 1).catch(() => null) };      // one ahead
            }, (e) => { this.fetching = null; this._event('segment ' + want + ': ' + (e && e.message)); });
            return;
        }
        if (!this.queue.length) return;
        if (!this.clock0) return;
        if (this.state !== 'playing') this.state = 'playing';
        // decode what is due (frames before a jump in are decoded, not sent), within the slice
        const t0 = Date.now();
        let pic = null;
        while (this.queue.length && this.queue[0].t <= now + 0.01 && Date.now() - t0 < SLICE_MS) {
            const au = this.queue.shift();
            const d0 = Date.now();
            for (const n of au.nals) {
                if (SKIP_NAL[n[0] & 31]) continue;
                if ((n[0] & 31) === 7 && this.profile === null) this.profile = n[1];
                const p = this.dec.decode(n);
                if (p) { this.stats.decoded++; if (pic) this.stats.dropped++; pic = p; }
            }
            this.stats.decMs += Date.now() - d0;
        }
        if (pic) {
            // the picture as the playlist names it (h264bsd hands out whole macroblocks: 368 rows for 360)
            const v = this.src.video, w = v.width && v.width <= pic.w ? v.width : pic.w, h = v.height && v.height <= pic.h ? v.height : pic.h;
            const W = w & ~3, H = h & ~1;
            if (!this.layer) this._show(W, H); else this._visible(true);
            if (this.layer) {
                const i420 = W === pic.w && H === pic.h ? pic.i420 : crop(pic, W, H);
                // (the MGU display's renderer takes I420 as it is and keeps it while paused; cluster-render its atlas)
                const out = this.cr.wantsI420 ? i420 : (this.lastPic = i420ToAtlas(i420, W, H, this.atlas));
                this.lastSent = Date.now();
                if (this.cr.frame(this.layer, out, this.stats.sent + 1)) this.stats.sent++;
            }
        }
    }

    /**
     * The sound: the audio rendition's segments (ID3 cut off), or the AAC in the video's own TS segments
     * (a server transcode), appended to one .aac file; the player starts once AUDIO_LEAD segments are in,
     * the rest follows ahead of the picture. Its state and time show on Diag.
     */
    async _audioStart() {
        const sep = this.src.audio, sig = this.o.sig;
        const a = sep || this.src.video;
        const sound = sep ? (i) => this.src.segment(a.segs[i].url).then(stripId3) : (i) => (this.buf ? this.buf.get(i) : this.src.segment(a.segs[i].url)).then((b) => demuxTsAll(b).audio);
        if (!sig || !sig.hasNative()) { this.audio.state = 'none (no SOME/IP here)'; return; }
        try {
            this.audio.state = 'fetching';
            fs.writeFileSync(AUDIO_FILE, Buffer.alloc(0), { mode: 0o644 }); fs.chmodSync(AUDIO_FILE, 0o644);
            let i = 0;
            const more = async () => {
                const b = await sound(i);
                if (!b && i === 0) throw new Error('no sound in the stream');
                if (b) fs.appendFileSync(AUDIO_FILE, b);
                this.audio.segs = ++i;
            };
            while (i < AUDIO_LEAD && this.running) {
                if (i < a.segs.length) await more();
                else if (a.ended) break;
                else { await this._refresh(); await new Promise((r2) => setTimeout(r2, 1000)); }
            }
            if (!this.running) return;
            this.audio.state = 'starting';
            const media = await require('./oapmedia').openMedia(sig, (l) => this._event(l));
            if (!this.running) { media.close(); return; }
            this.audio.media = media;
            const r = await media.play(AUDIO_FILE, 8);
            this.audio.state = r.playing ? 'playing' : 'not playing: ' + r.answer + ', ' + r.state;
            this._event('sound: ' + this.audio.state);
            if (r.playing && this.queue.length && !this.clock0) this.clock0 = Date.now();
            // the rest: a segment ahead of the sound, while it plays; the player's time on Diag
            const poll = setInterval(() => {
                if (!this.running || !this.audio.media) return clearInterval(poll);
                media.get('currentItemTime').then((x) => {
                    this.audio.line = 'time ' + x + ', ' + this.audio.segs + '/' + a.segs.length + ' segments in the file' + (this.audio.reopened ? ', reopened ' + this.audio.reopened + 'x' : '');
                    // the player may keep the length it saw when it opened the file: near that end, while the
                    // file holds more, open it again at the time it was at (the assembly test's way E)
                    const e = /"elapsed":(\d+)/.exec(x), tot = /"total":(\d+)/.exec(x);
                    if (e) this._sync(+e[1]);
                    const fileS = this.audio.segs < a.segs.length ? a.segs[this.audio.segs].t : Infinity;
                    if (e && tot && !this.paused && +tot[1] - +e[1] < 3500 && fileS * 1000 > +tot[1] + 3000) {
                        this.audio.reopened = (this.audio.reopened || 0) + 1;
                        this.audio.pending = 'reopen';         // (its time jumps meanwhile: no sync from it)
                        media.call(media.mp, 'playFile', { path: AUDIO_FILE, languageCode: 0 })
                            .then(() => media.call(media.mp, 'setTime', { newTimeElapsed: +e[1] })).catch(() => {})
                            .then(() => setTimeout(() => { this.audio.pending = ''; }, 2500));
                    }
                });
                media.get('playerState').then((x) => { this.audio.state = /PLAY"/.test(x) ? 'playing' : this.paused ? 'paused' : 'stopped by the player: ' + x; });
                return undefined;
            }, 2000);
            while (this.running && (i < a.segs.length || !a.ended)) {
                if (i >= a.segs.length) { await this._refresh(); await new Promise((r2) => setTimeout(r2, 1000)); continue; }
                const ahead = a.segs[i].t - this.position();
                if (ahead > 12) { await new Promise((r2) => setTimeout(r2, 1000)); continue; }
                await more();
            }
        } catch (e) {
            this.audio.state = 'error: ' + (e && e.message || e);
            this._event('sound: ' + this.audio.state);
        }
    }
}

/** the top-left W x H of an I420 picture (pic.w x pic.h) */
function crop(pic, W, H) {
    const out = new Uint8Array(W * H * 3 / 2), src = pic.i420, w = pic.w, h = pic.h;
    for (let y = 0; y < H; y++) out.set(src.subarray(y * w, y * w + W), y * W);
    const cw = w >> 1, ch = h >> 1, CW = W >> 1, CH = H >> 1;
    for (let p = 0; p < 2; p++) {
        const so = w * h + p * cw * ch, oo = W * H + p * CW * CH;
        for (let y = 0; y < CH; y++) out.set(src.subarray(so + y * cw, so + y * cw + CW), oo + y * CW);
    }
    return out;
}

module.exports = { ClusterVideo, crop };

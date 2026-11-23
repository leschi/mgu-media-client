'use strict';
/**
 * airplay.js - the app's side of AirPlay: the connection to the receiver process (./backend), and its
 * picture where the app's videos go.
 *
 *   const air = new AirPlay(dataDir + '/airplay/control.sock');
 *   air.on('state', (st) => {}); air.connect(); air.start(w, h); air.endVideo(); air.stop();
 *   const v = new AirPlayVideo({ target, gate, client, air, log }); v.start(); v.stop();
 *
 * The picture: the receiver's frames lie as I420 in a /dev/shm file. The MGU display's renderer reads that file
 * itself (op 19); for the cluster and the HUD the newest frame is made smaller here and goes to a
 * cluster-render layer, as ./clustervideo's. Both only while parked.
 */
const fs = require('fs');
const net = require('net');
const EventEmitter = require('events');
const { ClusterVideo } = require('./clustervideo');
const { i420ToAtlas } = require('./h264dec');

const STATUS = '/run/mgu-media-airplay/status.json';
const OFF = { phase: 'off', mode: '', connected: false, code: '', file: '', frame: null, error: '', log: [] };
const FILE = /^\/dev\/shm\/mgu-video-airplay-[\w-]+$/;

class AirPlay extends EventEmitter {
    constructor(sock) { super(); this.path = sock; this.state = Object.assign({}, OFF); this.on_ = false; this.sock = null; this.size = null; }

    /** asked for (by the driver): kept over a lost connection */
    active() { return this.on_; }

    connect() {
        if (this.closed || this.sock) return;
        const s = this.sock = net.connect(this.path);
        s.setEncoding('utf8');
        let buf = '', beat = null;
        s.on('connect', () => {
            beat = setInterval(() => this._send({ command: 'beat' }), 3000);
            if (this.on_) this._start();
        });
        s.on('data', (d) => {
            buf += d;
            if (buf.length > 32768) { s.destroy(); return; }
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                try { const m = JSON.parse(buf.slice(0, i)); if (m && m.state) this._set(m.state); else if (m && m.sound) this.emit('sound', m.sound); } catch (e) { /* not ours */ }
                buf = buf.slice(i + 1);
            }
        });
        s.on('error', () => {});
        s.on('close', () => {
            clearInterval(beat);
            this.sock = null;
            this._set(OFF);
            if (!this.closed) this.retry = setTimeout(() => this.connect(), 2000);
        });
    }
    _set(st) {
        const f = st.frame && st.frame.w >= 16 && st.frame.h >= 16 && FILE.test(st.file) ? st.frame : null;
        const was = JSON.stringify(this.state);
        this.state = { phase: String(st.phase), mode: String(st.mode || ''), connected: !!st.connected, code: String(st.code || ''), file: f ? st.file : '', frame: f, error: String(st.error || ''),
            log: (Array.isArray(st.log) ? st.log : []).slice(-7).map((l) => String(l).slice(0, 120)) };
        if (JSON.stringify(this.state) !== was) this.emit('state', this.state);
    }
    _send(o) { if (this.sock && !this.sock.connecting) this.sock.write(JSON.stringify(o) + '\n'); }
    _start() { this._send(Object.assign({ command: 'start', name: 'BMW MGU' }, this.size)); }

    start(w, h) { this.on_ = true; this.size = { w, h }; this._start(); }
    /** the size of a video the car fetches itself (YouTube) */
    viewport(w, h) { this.size = { w, h }; this._send({ command: 'viewport', w, h }); }
    /** the receiver's process is there (it plays a film's sound too: ./ownsound) */
    here() { return !!this.sock && this.state.phase !== 'off'; }
    sound(op, o) { this._send(Object.assign({ command: 'sound', op }, o)); }
    endVideo() { this._send({ command: 'endVideo' }); }
    stop() { this.on_ = false; this._send({ command: 'stop' }); }
    close() { this.closed = true; clearTimeout(this.retry); if (this.sock) this.sock.destroy(); }

    /** why the receiver process is not there ('' when it is) */
    missing() {
        if (this.state.phase !== 'off') return '';
        let st = null;
        try { st = JSON.parse(fs.readFileSync(STATUS, 'utf8')); } catch (e) { /* the tool is not there */ }
        if (!st) return 'Install "Media Client AirPlay" in the MGU Store (the same source as this app), then restart the head unit.';
        return 'The receiver is starting (' + st.state + (st.detail ? ': ' + st.detail : '') + ')';
    }
}

/** the newest frame of an MGVF file: { w, h, seq, data: I420 }, null without one (or the same as seq) */
function readFrame(fd, seq) {
    const b = Buffer.alloc(64);
    if (fs.readSync(fd, b, 0, 64, 0) !== 64 || b.readUInt32LE(0) !== 0x4656474d) return null;
    const w = b.readUInt32LE(8), h = b.readUInt32LE(12), s = b.readUInt32LE(16), slot = b.readUInt32LE(20), n = b.readUInt32LE(24);
    if (!s || s === seq || !(w >= 16 && h >= 16 && w <= 2048 && h <= 2048) || (w & 1) || (h & 1) || n < 1 || n > 4 || slot >= n) return null;
    const size = w * h * 3 / 2, data = Buffer.allocUnsafe(size);
    return fs.readSync(fd, data, 0, size, 64 + slot * size) === size ? { w, h, seq: s, data } : null;
}

/** w x h made to fit maxW x maxH (never larger): a width cluster-render takes (a multiple of 4), an even height */
function fitSize(w, h, maxW, maxH) {
    const s = Math.min(1, maxW / w, maxH / h);
    return { w: Math.max(64, Math.round(w * s) & ~3), h: Math.max(32, Math.round(h * s) & ~1) };
}

/** I420 w x h -> I420 W x H (the nearest pixel) */
function scaleI420(src, w, h, W, H, out) {
    let o = 0, base = 0;
    for (let p = 0; p < 3; p++) {
        const sw = p ? w >> 1 : w, sh = p ? h >> 1 : h, dw = p ? W >> 1 : W, dh = p ? H >> 1 : H;
        const xs = new Uint16Array(dw);
        for (let x = 0; x < dw; x++) xs[x] = Math.floor((x + 0.5) * sw / dw);
        for (let y = 0; y < dh; y++) {
            const row = base + Math.floor((y + 0.5) * sh / dh) * sw;
            for (let x = 0; x < dw; x++) out[o++] = src[row + xs[x]];
        }
        base += sw * sh;
    }
    return out;
}

const TICK_AIR = 40;                    // 25 frames a second: 480x270 fits the upload budget

class AirPlayVideo extends ClusterVideo {
    constructor(o) { super(o); this.air = o.air; this.fd = null; this.gen = ''; this.seq = 0; this.parkedNow = false; }

    start() {
        if (this.running) return;
        this.running = true;
        this.state = 'waiting';
        if (this.target !== 'cid') this._wire();
        this.timer = setInterval(() => { try { this._tickAir(); } catch (e) { this._event('picture: ' + e.message); this._closeFile(); } }, TICK_AIR);
    }
    stop() { this._closeFile(); return super.stop(); }
    position() { return 0; }
    pause() {}
    resume() {}

    /** the MGU display's picture: { file, w, h, gen } while there is one and the car is parked */
    screen() {
        const st = this.air.state;
        return this.target === 'cid' && this.parkedNow && st.frame ? { file: st.file, w: st.frame.w, h: st.frame.h, gen: st.frame.gen } : null;
    }

    _closeFile() { if (this.fd !== null) { try { fs.closeSync(this.fd); } catch (e) { /* closing */ } } this.fd = null; this.gen = ''; this.seq = 0; }

    _tickAir() {
        if (!this.running) return;
        const st = this.air.state;
        // (as ./clustervideo: anything but true is not parked)
        this.parkedNow = this.o.gate.parked() === true;
        this.state = !st.frame ? 'waiting' : this.parkedNow ? 'playing' : 'paused: not parked (the sound goes on)';
        if (this.target === 'cid') return;
        if (!st.frame || !this.parkedNow) { this._visible(false); this._closeFile(); return; }
        if (this.gen !== st.file + st.frame.gen) {
            this._closeFile();
            this.fd = fs.openSync(st.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            this.gen = st.file + st.frame.gen;
        }
        const f = readFrame(this.fd, this.seq);
        if (!f) {
            // a still screen: the layer's last frame again now and then (cluster-render's stall_ms)
            if (this.layer && this.lastPic && this.showing && Date.now() - this.lastSent > 1000) { this.lastSent = Date.now(); this.cr.frame(this.layer, this.lastPic, ++this.stats.sent); }
            return;
        }
        this.seq = f.seq;
        const max = this.quality === 'sharp' ? [640, 360] : [480, 270];
        const d = fitSize(f.w, f.h, max[0], max[1]);
        if (this.size !== d.w + 'x' + d.h) { this._hide(); this.size = d.w + 'x' + d.h; this.small = Buffer.alloc(d.w * d.h * 3 / 2); }
        if (!this.layer) this._show(d.w, d.h); else this._visible(true);
        if (!this.layer) return;
        this.lastPic = i420ToAtlas(scaleI420(f.data, f.w, f.h, d.w, d.h, this.small), d.w, d.h, this.atlas);
        this.lastSent = Date.now();
        if (this.cr.frame(this.layer, this.lastPic, this.stats.sent + 1)) this.stats.sent++;
    }
}

module.exports = { AirPlay, AirPlayVideo, readFrame, fitSize, scaleI420 };

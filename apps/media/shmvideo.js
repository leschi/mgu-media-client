'use strict';
/**
 * shmvideo.js - the video on the MGU's own display: decoded frames (I420) written to a /dev/shm
 * file the GPU renderer (mgu-render) reads itself (kit/renderd PROTOCOL.md "Video"; a prior project writes
 * its screen the same way); the app's page draws op 19 (Recorder.video) where the picture goes.
 * It stands in for the cluster-render client in ./clustervideo (video, frame, drop): frames come as
 * I420 (wantsI420), not as cluster-render's atlas. No upload budget here: the decoder sets the pace.
 *
 *   const s = new ShmVideo('/dev/shm/mgu-video-media');
 *   const ref = s.video({ vw, vh }); s.frame(ref, i420, seq); s.drop(ref); s.close();
 */
const fs = require('fs');
const EventEmitter = require('events');

const NSLOT = 3;
const HEAD = 64;

class ShmVideo extends EventEmitter {
    constructor(file, o) {
        super();
        this.file = file;
        this.o = o || {};
        this.ready = true; this.targets = '';
        this.wantsI420 = true;
        this.fd = null; this.w = 0; this.h = 0; this.seq = 0; this.slot = 0;
        this.ref = 0; this.shown = false;
    }
    connect() { setImmediate(() => this.emit('ready')); }

    /** a layer: the file opened at vw x vh (even), 0 when it can't be */
    video(opts) {
        const w = opts.vw & ~1, h = opts.vh & ~1;
        if (!(w >= 16 && h >= 16 && w <= 2048 && h <= 2048)) return 0;
        if (this.fd === null || w !== this.w || h !== this.h) {
            this._close();
            const head = Buffer.alloc(HEAD);
            head.writeUInt32LE(0x4656474d, 0);                  // "MGVF"
            head.writeUInt32LE(1, 4);
            head.writeUInt32LE(w, 8); head.writeUInt32LE(h, 12);
            head.writeUInt32LE(NSLOT, 24);
            head.writeUInt32LE(this.o.bt601 ? 0 : 1, 28);       // matrix: BT.709 (a server's transcode keeps HD's)
            head.writeUInt32LE(0, 32);                          // range: limited (16-235), as H.264 is
            try {
                this.fd = fs.openSync(this.file, 'w', 0o644);
                fs.ftruncateSync(this.fd, HEAD + NSLOT * w * h * 3 / 2);
                fs.writeSync(this.fd, head, 0, HEAD, 0);
            } catch (e) { this.fd = null; this.emit('refused', 'video', 0, e.code || e.message); return 0; }
            this.w = w; this.h = h; this.seq = 0; this.slot = 0;
        }
        this.ref++;
        this.shown = true;
        return this.ref;
    }

    /** the newest frame into the next slot, then slot, then seq (the renderer reads the header first) */
    frame(ref, i420) {
        if (ref !== this.ref || this.fd === null) return false;
        const size = this.w * this.h * 3 / 2, next = (this.slot + 1) % NSLOT, hb = Buffer.alloc(4);
        try {
            fs.writeSync(this.fd, Buffer.from(i420.buffer, i420.byteOffset, size), 0, size, HEAD + next * size);
            hb.writeUInt32LE(next, 0); fs.writeSync(this.fd, hb, 0, 4, 20);
            this.seq = (this.seq + 1) >>> 0; hb.writeUInt32LE(this.seq, 0); fs.writeSync(this.fd, hb, 0, 4, 16);
            this.slot = next;
            return true;
        } catch (e) { return false; }
    }

    /** visible on / off (not parked: the page stops drawing it) */
    set(ref, o) { if (ref === this.ref && o && o.visible !== undefined) this.shown = !!o.visible; }

    /** the picture goes (the page stops drawing it; the file stays for the next layer) */
    drop(ref) { if (ref === this.ref) this.shown = false; }

    _close() { if (this.fd !== null) { try { fs.closeSync(this.fd); } catch (e) { /* closing */ } this.fd = null; } }
    close() { this.shown = false; this._close(); try { fs.unlinkSync(this.file); } catch (e) { /* gone */ } }
}

module.exports = { ShmVideo };

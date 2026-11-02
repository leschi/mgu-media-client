'use strict';
/**
 * buffer.js - a video's segments fetched ahead onto the unit's flash (the app's data folder), for a
 * stream that rides out gaps in the phone hotspot: up to `aheadS` seconds (10 minutes by default)
 * ahead of where the picture is. A ring: a segment goes once played (one kept behind); the folder
 * is emptied at the end. It never fills the disk: it keeps `reserveBytes` free (df, every 10 s)
 * and holds at most `maxBytes` itself.
 *
 *   const b = new SegmentBuffer({ dir, fetch: (i) => Promise<Buffer>, count: () => n, time: (i) => s,
 *       ended: () => bool, more: () => Promise, aheadS: 600 });
 *   b.start(); b.setPos(i); await b.get(i); b.lines(); b.stop();
 *
 * 10 minutes at 480x270 (1.2 Mbit/s video + 160 kbit/s sound) are about 100 MB.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const KEEP_BEHIND = 1;                 // segments kept behind the one playing
const DF_MS = 10000;

/** free bytes on the file system holding dir (df -k), null when df does not answer */
function dfFree(dir) {
    return new Promise((resolve) => {
        execFile('df', ['-k', dir], { timeout: 5000 }, (err, out) => {
            if (err) return resolve(null);
            const lines = String(out).trim().split('\n');
            // (a long device name wraps the line: the numbers are the last line's)
            const f = lines[lines.length - 1].trim().split(/\s+/).filter((x) => /^\d+$/.test(x));
            return resolve(f.length >= 3 ? +f[2] * 1024 : null);
        });
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
const mmss = (s) => Math.floor(s / 60) + ':' + ('0' + Math.floor(s % 60)).slice(-2);

class SegmentBuffer {
    constructor(o) {
        this.o = o;
        this.dir = o.dir;
        this.aheadS = o.aheadS || 600;
        this.maxBytes = o.maxBytes || 600 * 1048576;
        this.reserve = o.reserveBytes == null ? 1024 * 1048576 : o.reserveBytes;
        this.df = o.df || dfFree;
        this.log = o.log || { info() {}, warn() {} };
        this.files = new Map();        // index -> bytes
        this.inflight = new Map();     // index -> Promise<Buffer>
        this.pos = 0; this.next = 0; this.used = 0;
        this.free = null; this.dfT = 0;
        this.state = 'off'; this.err = '';
        this.running = false;
    }

    _file(i) { return path.join(this.dir, 'seg' + i + '.ts'); }

    start() {
        if (this.running) return;
        this.running = true;
        clearDir(this.dir);
        try { fs.mkdirSync(this.dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        this.state = 'filling';
        this._run().catch((e) => { this.state = 'error: ' + e.message; this.log.warn('buffer: ' + e.message); });
    }

    /** the picture is at segment i: the ones before it (but one) go */
    setPos(i) {
        if (i <= this.pos) return;
        this.pos = i;
        for (const k of Array.from(this.files.keys())) if (k < i - KEEP_BEHIND) this._drop(k);
    }

    _drop(k) {
        const n = this.files.get(k);
        this.files.delete(k);
        this.used -= n || 0;
        try { fs.unlinkSync(this._file(k)); } catch (e) { /* gone */ }
    }

    /** a segment fetched once (the loop and a reader asking for the same wait for one fetch), kept on disk */
    _load(i) {
        if (this.inflight.has(i)) return this.inflight.get(i);
        const p = this.o.fetch(i).then((b) => {
            this.inflight.delete(i);
            if (this.running && i >= this.pos - KEEP_BEHIND && !this.files.has(i)) {
                try {
                    fs.writeFileSync(this._file(i), b);
                    this.files.set(i, b.length); this.used += b.length;
                } catch (e) { this.err = 'write: ' + (e.code || e.message); if (e.code === 'ENOSPC') this.free = 0; }
            }
            return b;
        }, (e) => { this.inflight.delete(i); throw e; });
        this.inflight.set(i, p);
        return p;
    }

    /** segment i: from the disk if it is there, else fetched now (before the ones ahead) */
    get(i) {
        if (this.files.has(i)) {
            return new Promise((resolve, reject) => fs.readFile(this._file(i), (e, b) => {
                if (!e) return resolve(b);
                this._drop(i);
                return this._load(i).then(resolve, reject);
            }));
        }
        return this._load(i);
    }

    async _space() {
        if (Date.now() - this.dfT < DF_MS) return;
        this.dfT = Date.now();
        this.free = await this.df(this.dir);
    }

    /** room for one more segment: under maxBytes, and the disk keeps its reserve */
    _room(next) { return this.used + next <= this.maxBytes && (this.free === null || this.free - next >= this.reserve); }

    async _run() {
        while (this.running) {
            let i = Math.max(this.next, this.pos);
            while (this.files.has(i)) i++;
            this.next = i;
            if (i >= this.o.count()) {
                if (this.o.ended()) { this.state = 'all in'; await sleep(1000); continue; }
                this.state = 'waiting for the server';
                await (this.o.more ? this.o.more() : Promise.resolve()).catch(() => {});
                await sleep(1000);
                continue;
            }
            if (this.o.time(i) - this.o.time(this.pos) >= this.aheadS) { this.state = 'full'; await sleep(500); continue; }
            await this._space();
            if (this.files.has(i)) continue;                // (a reader fetched it meanwhile)
            const avg = this.files.size ? this.used / this.files.size : 1048576;
            if (!this._room(avg)) { this.state = 'held: ' + (this.used + avg > this.maxBytes ? 'at its ' + mb(this.maxBytes) : 'keeping ' + mb(this.reserve) + ' free on the disk'); this.dfT = 0; await sleep(3000); continue; }
            this.state = 'filling';
            try {
                await this._load(i);
                this.err = '';
                this.next = i + 1;
            } catch (e) {
                this.err = e.message;
                this.state = 'retrying';
                await sleep(3000);
            }
        }
    }

    /** seconds held ahead of the picture */
    ahead() {
        let i = this.pos;
        while (this.files.has(i)) i++;
        return i > this.pos && i <= this.o.count() ? this.o.time(i - 1) + segLen(this.o, i - 1) - this.o.time(this.pos) : 0;
    }

    lines() {
        return 'buffer: ' + mmss(this.ahead()) + ' of ' + mmss(this.aheadS) + ' ahead, ' + mb(this.used) + ' on disk (' + this.files.size + ' segments)' +
            (this.free !== null ? ', ' + mb(this.free) + ' free' : '') + ' - ' + this.state + (this.err ? ' (' + this.err + ')' : '');
    }

    /** the folder emptied */
    stop() {
        this.running = false;
        this.state = 'off';
        this.files.clear(); this.used = 0;
        clearDir(this.dir);
    }
}

function segLen(o, i) { return o.dur ? o.dur(i) : i + 1 < o.count() ? o.time(i + 1) - o.time(i) : 6; }

/** a buffer folder's segments deleted (left by a run that was killed) */
function clearDir(dir) {
    try { fs.readdirSync(dir).filter((f) => /^seg\d+\.ts$/.test(f)).forEach((f) => { try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* gone */ } }); } catch (e) { /* none */ }
}

module.exports = { SegmentBuffer, dfFree, clearDir };

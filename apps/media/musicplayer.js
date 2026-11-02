'use strict';
/**
 * musicplayer.js - tracks from the server through BMW's media player: each track's own file is fetched
 * to /tmp (RAM on the unit) and played from there (the player plays local files only, in every format:
 * a prior project 0.2.37), the next one fetched while this one plays; a track's file goes once it is over.
 * Sound only: it plays while driving too.
 *
 *   const m = new MusicPlayer({ server: jellyfin, sig, lookup, log });   (server.trackFile(id) -> { url, ext })
 *   m.play(tracks, 0); m.next(); m.prev(); m.lines(); await m.stop();
 */
const fs = require('fs');
const http = require('http');
const https = require('https');
const url = require('url');

const POLL_MS = 2000;

/** a URL streamed to a file (not held in memory: a FLAC is 30 MB); resolves with its size */
function download(u, file, lookup, ms) {
    return new Promise((resolve, reject) => {
        const o = Object.assign(url.parse(u), { lookup, ecdhCurve: 'auto' });      // (as ./jellyfin: node 8's P-256 only refused)
        const req = (o.protocol === 'http:' ? http : https).get(o, (res) => {
            if (res.statusCode !== 200) { res.resume(); return reject(new Error('http ' + res.statusCode)); }
            const out = fs.createWriteStream(file, { mode: 0o644 });
            let n = 0;
            res.on('data', (d) => { n += d.length; });
            res.pipe(out);
            out.on('finish', () => { try { fs.chmodSync(file, 0o644); } catch (e) { /* stays */ } resolve(n); });
            out.on('error', reject);
            res.on('error', reject);
            return undefined;
        });
        req.on('error', reject);
        req.setTimeout(ms || 60000, () => { req.abort(); reject(new Error('no data in ' + (ms || 60000) / 1000 + ' s')); });
    });
}

class MusicPlayer {
    constructor(o) {
        this.o = o;
        this.log = o.log || { info() {}, warn() {} };
        this.tmp = o.tmp || '/tmp';
        this.tracks = []; this.i = 0;
        this.media = null; this.state = 'off'; this.line = ''; this.events = [];
        this.files = {};                   // track index -> { file, ready: Promise }
        this.gen = 0;
    }

    _event(l) { this.events.push(new Date().toTimeString().slice(0, 8) + ' ' + l); if (this.events.length > 5) this.events.shift(); this.log.info('music: ' + l); }

    current() { return this.tracks[this.i] || null; }

    lines() {
        const t = this.current();
        return ['music: ' + this.state + (t ? ' - ' + (this.i + 1) + '/' + this.tracks.length + ' ' + t.title + (t.sub ? ' (' + t.sub + ')' : '') : ''),
            this.line].filter(Boolean).concat(this.events);
    }

    _file(i) {
        if (this.files[i]) return this.files[i].ready;
        const t = this.tracks[i];
        if (!t) return Promise.reject(new Error('no such track'));
        const entry = { file: null, ready: null };
        // the server says which file (its own, or an mp3 it makes): the name takes its kind
        entry.ready = this.o.server.trackFile(t.id).then((f) => {
            const ext = String(f.ext || 'mp3').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'mp3';
            entry.file = this.tmp + '/mgu-media-track' + i + '.' + ext;
            return (this.o.download || download)(f.url, entry.file, this.o.lookup);
        }).then((n) => { this._event('fetched ' + (i + 1) + ': ' + (n / 1e6).toFixed(1) + ' MB'); return entry.file; });
        const ready = entry.ready;
        this.files[i] = entry;
        ready.catch(() => { if (this.files[i] === entry) delete this.files[i]; try { if (entry.file) fs.unlinkSync(entry.file); } catch (e) { /* none */ } });
        return ready;
    }

    /** the files of tracks other than this one and the next go (RAM) */
    _tidy() {
        Object.keys(this.files).forEach((k) => {
            const i = +k;
            if (i === this.i || i === this.i + 1) return;
            const e = this.files[k];
            delete this.files[k];
            // (a file still being fetched goes once it is in)
            const rm = () => setTimeout(() => { try { if (e.file) fs.unlinkSync(e.file); } catch (x) { /* gone */ } }, 1000);
            e.ready.then(rm, rm);
        });
    }

    async play(tracks, i) {
        this.tracks = tracks.filter((t) => t.audio);
        const g = ++this.gen;
        if (!this.media) {
            this.state = 'connecting';
            this.media = await require('./oapmedia').openMedia(this.o.sig, (l) => this._event(l));
            if (g !== this.gen) return;
            this.timer = setInterval(() => this._poll(), POLL_MS);
        }
        await this._go(Math.max(0, Math.min(i || 0, this.tracks.length - 1)), g);
    }

    async _go(i, g) {
        this.i = i;
        this.played = false;
        this.state = 'fetching';
        this._tidy();
        try {
            const file = await this._file(i);
            if (g !== this.gen || !this.media) return;
            const r = await this.media.play(file, 8);
            this.state = r.playing ? 'playing' : 'not playing: ' + r.answer + ', ' + r.state;
            this._event((i + 1) + ' ' + this.state);
            if (i + 1 < this.tracks.length) this._file(i + 1).catch((e) => this._event('next track: ' + e.message));
        } catch (e) {
            this.state = 'error: ' + e.message;
            this._event(this.state);
        }
    }

    /** the player's time; at a track's end, the next one */
    _poll() {
        if (!this.media || this.state === 'fetching') return;
        Promise.all([this.media.get('currentItemTime'), this.media.get('playerState')]).then((r) => {
            const e = /"elapsed":(\d+)/.exec(r[0]), tot = /"total":(\d+)/.exec(r[0]), playing = /PLAY"/.test(r[1]);
            if (e && tot) this.line = 'time ' + Math.round(+e[1] / 1000) + ' / ' + Math.round(+tot[1] / 1000) + ' s';
            if (playing) this.played = true;
            const over = this.played && !playing && (!tot || !e || +tot[1] - +e[1] < 2500);
            if (over && this.state === 'playing') {
                if (this.i + 1 < this.tracks.length) this._go(this.i + 1, this.gen);
                else { this.state = 'done'; this._event('the end of the list'); }
            }
        }).catch(() => {});
    }

    next() { if (this.i + 1 < this.tracks.length) this._go(this.i + 1, ++this.gen); }
    prev() { this._go(Math.max(0, this.i - 1), ++this.gen); }

    /** resolves once the sound is off and the AudioManager connection gone */
    stop() {
        this.gen++;
        clearInterval(this.timer); this.timer = null;
        const m = this.media;
        this.media = null;
        this.state = 'off';
        Object.keys(this.files).forEach((k) => {
            const e = this.files[k], rm = () => setTimeout(() => { try { if (e.file) fs.unlinkSync(e.file); } catch (x) { /* gone */ } }, 1500);
            e.ready.then(rm, rm);
        });
        this.files = {};
        return m ? m.close().catch(() => {}) : Promise.resolve();
    }
}

module.exports = { MusicPlayer, download };

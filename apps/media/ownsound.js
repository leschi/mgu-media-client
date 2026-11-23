'use strict';
/**
 * ownsound.js - a film's sound played by the app's own player (`mgu-airplay sound`, run by ./backend) on BMW's
 * SmartX sink, as PllanaCast plays AirPlay's: the AudioManager connection first, the sound written once it stands.
 * BMW's own media player meanwhile plays silence with the title and the picture (the cluster's media display);
 * it goes again when the sound stops moving with it.
 *
 *   const s = new OwnSound({ sig, air, tag, add }); await s.open();
 *   s.add(buf); s.button('PAUSE' | 'PLAY'); s.on('time', (ms) => {}); await s.close();
 */
const fs = require('fs');
const EventEmitter = require('events');
const { connectSource, openPlayer } = require('./oapmedia');

const CARD = '/tmp/mgu-media-card.aac';
let ids = Date.now() % 1000000;

/** ADTS AAC-LC, stereo, 48 kHz: s seconds of silence */
function silence(s) {
    const raw = Buffer.from([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]), n = raw.length + 7;
    const f = Buffer.concat([Buffer.from([0xff, 0xf1, 0x4c, 0x80, n >> 3, (n & 7) << 5 | 0x1f, 0xfc]), raw]);
    return Buffer.alloc(f.length * Math.ceil(s * 48000 / 1024), f);
}

class OwnSound extends EventEmitter {
    constructor(o) {
        super();
        this.o = o; this.id = ++ids; this.n = 0;
        this.ms = 0; this.msT = 0; this.error = ''; this.playing = false; this.paused = false; this.closed = false;
        this.card = null; this.cardState = '';
        this.prefix = '/tmp/mgu-media-snd-' + process.pid + '-' + this.id + '-';
        this._on = (m) => this._msg(m);
        o.air.on('sound', this._on);
    }

    /** the speakers are ours and the player runs; throws when not */
    async open() {
        this.src = await connectSource(this.o.sig, this.o.add);
        if (this.src.conn == null) throw new Error('the car gives no sound connection');
        if (this.closed) return;
        this.o.air.sound('start', { id: this.id });
    }

    _msg(m) {
        if (m.id !== this.id || this.closed) return;
        if (m.playing) { this.playing = true; this.error = ''; this.o.add('sound: playing (own player)'); }
        if (m.ms !== undefined) {
            if (m.ms !== this.ms) { this.msT = Date.now(); this.error = ''; }
            this.ms = m.ms;
            this.emit('time', m.ms);
            if (m.ms > 3000 && !this.card && this.o.tag && this.o.tag.length) this._card();
        }
        if (m.error) { if (m.error !== this.error) this.o.add('sound: ' + m.error); this.error = m.error; if (this.card) this._cardOff('the sound failed with it'); }
        if (m.ended) { this.playing = false; this.emit('ended'); }
    }

    add(b) {
        const f = this.prefix + (this.n++) + '.aac';
        fs.writeFileSync(f, b, { mode: 0o644 });
        this.o.air.sound('add', { file: f });
    }

    button(b) {
        this.paused = b === 'PAUSE';
        this.msT = Date.now();
        this.o.air.sound(this.paused ? 'pause' : 'play');
        if (this.card && this.card.button) this.card.button(b).catch(() => {});
        return Promise.resolve();
    }

    /** BMW's player with the title and the picture, on silence as long as the film */
    _card() {
        this.card = {};
        const p = (async () => {
            fs.writeFileSync(CARD, Buffer.concat([this.o.tag, silence(Math.min(4 * 3600, Math.max(60, this.o.length || 3600)))]), { mode: 0o644 });
            const m = await openPlayer(this.o.sig, this.src);
            if (this.closed || !this.card) return;
            this.card = m;
            this.msT = Date.now();
            const r = await m.play(CARD, 8);
            this.cardState = r.playing ? 'shown' : 'not shown: ' + r.answer + ', ' + r.state;
            this.o.add('title and picture: ' + this.cardState);
        })();
        p.catch((e) => { this.cardState = e.message; this.o.add('title and picture: ' + e.message); });
        // the sound stands still with it: it goes
        const t = setInterval(() => {
            if (this.closed || !this.card) return clearInterval(t);
            if (!this.paused && Date.now() - this.msT > 3000) { clearInterval(t); this._cardOff('the sound stopped with it'); }
            return undefined;
        }, 500);
    }
    _cardOff(why) {
        const m = this.card;
        this.card = null; this.o.tag = null;
        this.cardState = why;
        this.o.add('title and picture off: ' + why);
        if (m && m.button) m.button('PAUSE').catch(() => {});
    }

    /** why nothing can be heard ('' when it can) */
    async problem() { return this.error || (this.src ? this.src.problem() : ''); }

    async close() {
        if (this.closed) return;
        this.closed = true;
        this.o.air.removeListener('sound', this._on);
        this.o.air.sound('stop');
        const m = this.card;
        this.card = null;
        if (m && m.button) await m.button('PAUSE').catch(() => {});
        for (let i = Math.max(0, this.n - 400); i < this.n; i++) try { fs.unlinkSync(this.prefix + i + '.aac'); } catch (e) { /* read */ }
        try { fs.unlinkSync(CARD); } catch (e) { /* none */ }
        if (this.src) await this.src.release();
    }
}

module.exports = { OwnSound, silence };

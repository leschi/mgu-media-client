'use strict';
/**
 * remote.js - the car as a cast target of the Jellyfin apps ("Play on" / the cast icon: "BMW MGU").
 * The app tells the server what it plays (Sessions/Capabilities) and keeps a WebSocket to it (/socket);
 * a phone signed in as the same user then sees the car in its list, and what it chooses there comes as
 * messages on that socket: Play (the items, where to start), Playstate (pause, stop, seek, next track),
 * GeneralCommand (a message to show). The video itself still comes from the server as before, made for
 * the car (./jellyfin videoUrl); the phone is only the remote. No common WLAN is needed: all goes through
 * the server. The socket comes back by itself after a drop (5 s, then up to 60 s apart).
 *
 *   const r = new Remote({ jf, log });
 *   r.on('play', ({ ids, startMs, command, startIndex }) => ...);   // startMs null: none given
 *   r.on('playstate', ({ command, seekMs }) => ...);                // Pause Unpause PlayPause Stop Seek NextTrack PreviousTrack Rewind FastForward
 *   r.on('message', ({ header, text }) => ...);
 *   r.start(); r.stop(); r.line()
 */
const EventEmitter = require('events');
const { WebSocket } = require('./websocket');
const { TICKS } = require('./jellyfin');

const CAPS = { PlayableMediaTypes: ['Video', 'Audio'], SupportedCommands: ['DisplayMessage'], SupportsMediaControl: true, SupportsPersistentIdentifier: true };
const CAPS_EVERY = 5 * 60000;          // told again: the session stays fresh in the phones' lists
const KEEPALIVE = 30000;               // until the server says how often (ForceKeepAlive)

class Remote extends EventEmitter {
    constructor(o) {
        super();
        this.jf = o.jf;
        this.log = o.log || { info() {}, warn() {} };
        this.Ws = o.WebSocket || WebSocket;
        this.on('error', () => {});
        this.state = 'off';
        this.running = false;
        this.ws = null;
        this.retry = o.retryMs || 5000;    // the first wait after a drop
        this.wait = this.retry;
        this.lastCmd = '';
    }

    line() { return 'cast target: ' + this.state + (this.lastCmd ? ', last ' + this.lastCmd : ''); }

    start() {
        if (this.running || !this.jf.token) return;
        this.running = true;
        this._connect();
        this.capsT = setInterval(() => this._caps(), CAPS_EVERY);
    }

    stop() {
        this.running = false;
        clearInterval(this.capsT); clearTimeout(this.again); clearInterval(this.aliveT);
        const ws = this.ws;
        this.ws = null;
        if (ws) ws.close();
        this.state = 'off';
    }

    /** what the car plays; a server that refuses the list of commands gets the short form */
    async _caps() {
        try {
            await this.jf._call('POST', '/Sessions/Capabilities/Full', CAPS, { timeout: 8000 });
        } catch (e) {
            if (!/http 400/.test(e.message)) throw e;
            await this.jf._call('POST', '/Sessions/Capabilities?PlayableMediaTypes=Video,Audio&SupportsMediaControl=true', null, { timeout: 8000 });
        }
    }

    _connect() {
        if (!this.running) return;
        this.state = 'connecting';
        const jf = this.jf;
        // the token in the header (10.11 on) and as ApiKey / api_key (older servers read the query only)
        const u = jf.base.replace(/^http/i, 'ws') + '/socket?ApiKey=' + encodeURIComponent(jf.token) + '&api_key=' + encodeURIComponent(jf.token) + '&deviceId=' + encodeURIComponent(jf.deviceId);
        const ws = new this.Ws(u, { headers: jf.streamHeaders(), lookup: jf.lookup });
        this.ws = ws;
        ws.on('error', (e) => { this.why = e.message; });
        ws.on('open', () => {
            if (ws !== this.ws) return ws.close();
            this.state = 'connected';
            this.wait = this.retry;
            this.log.info('cast target: connected (the Jellyfin apps list "BMW MGU")');
            this._alive(KEEPALIVE);
            ws.send(JSON.stringify({ MessageType: 'KeepAlive' }));
            this._caps().catch((e) => this.log.warn('cast target: capabilities: ' + e.message));
            return undefined;
        });
        ws.on('message', (text) => { if (ws === this.ws) this._message(text); });
        ws.on('close', (code) => {
            if (ws !== this.ws) return;
            clearInterval(this.aliveT);
            this.ws = null;
            if (!this.running) return;
            this.state = 'reconnecting in ' + Math.round(this.wait / 1000) + ' s (' + (this.why || 'closed ' + code) + ')';
            this.log.warn('cast target: ' + this.state);
            this.why = '';
            this.again = setTimeout(() => this._connect(), this.wait);
            this.wait = Math.min(60000, this.wait * 2);
        });
    }

    _alive(ms) {
        clearInterval(this.aliveT);
        this.aliveT = setInterval(() => { if (this.ws) this.ws.send(JSON.stringify({ MessageType: 'KeepAlive' })); }, ms);
    }

    _message(text) {
        let m;
        try { m = JSON.parse(text); } catch (e) { return; }
        const d = m.Data || {};
        const ms = (t) => (t == null || t === '' ? null : Math.round(+t / TICKS));
        switch (m.MessageType) {
        case 'ForceKeepAlive': this._alive(Math.max(5, (+m.Data || 60) / 2) * 1000); break;
        case 'Play':
            this.lastCmd = 'Play ' + (d.PlayCommand || 'PlayNow');
            this.emit('play', { ids: [].concat(d.ItemIds || []), startMs: ms(d.StartPositionTicks), command: d.PlayCommand || 'PlayNow', startIndex: d.StartIndex || 0,
                mediaSourceId: d.MediaSourceId || null });
            break;
        case 'Playstate':
            this.lastCmd = d.Command;
            this.emit('playstate', { command: d.Command, seekMs: ms(d.SeekPositionTicks) });
            break;
        case 'GeneralCommand': {
            const a = d.Arguments || {};
            this.lastCmd = d.Name;
            if (d.Name === 'DisplayMessage') this.emit('message', { header: a.Header || '', text: a.Text || '' });
            break;
        }
        default: break;
        }
    }
}

module.exports = { Remote, CAPS };

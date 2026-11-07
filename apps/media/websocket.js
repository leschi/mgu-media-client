'use strict';
/**
 * websocket.js - a WebSocket client (RFC 6455) for node 8 on the head unit, which has none built in:
 * text messages only (what Jellyfin's /socket speaks), ping answered, fragments put together, every frame
 * sent masked (as a client must). TLS as ./jellyfin (ecdhCurve auto), the name looked up by ./dns.
 *
 *   const ws = new WebSocket('wss://host/socket?x=1', { headers, lookup });
 *   ws.on('open', ...); ws.on('message', (text) => ...); ws.on('close', (code, why) => ...); ws.on('error', ...)
 *   ws.send('{"MessageType":"KeepAlive"}'); ws.close();
 */
const http = require('http');
const https = require('https');
const url = require('url');
const crypto = require('crypto');
const EventEmitter = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 4 * 1024 * 1024;   // (Jellyfin's messages are a few kB)

/** one frame, masked: opcode, payload (Buffer) */
function frame(op, payload) {
    const n = payload.length;
    const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    head[0] = 0x80 | op;
    if (n < 126) head[1] = 0x80 | n;
    else if (n < 65536) { head[1] = 0x80 | 126; head.writeUInt16BE(n, 2); }
    else { head[1] = 0x80 | 127; head.writeUInt32BE(Math.floor(n / 0x100000000), 2); head.writeUInt32BE(n >>> 0, 6); }
    const mask = crypto.randomBytes(4), body = Buffer.alloc(n);
    for (let i = 0; i < n; i++) body[i] = payload[i] ^ mask[i & 3];
    return Buffer.concat([head, mask, body]);
}

class WebSocket extends EventEmitter {
    constructor(u, o) {
        super();
        o = o || {};
        this.url = u;
        this.state = 'connecting';         // connecting | open | closing | closed
        this.buf = Buffer.alloc(0);
        this.parts = null;                 // the fragments of a message so far
        const p = url.parse(u.replace(/^ws/i, 'http'));
        const key = crypto.randomBytes(16).toString('base64');
        const headers = Object.assign({}, o.headers || {}, { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' });
        const req = (p.protocol === 'https:' ? https : http).request(Object.assign(p, { headers, lookup: o.lookup, ecdhCurve: 'auto' }));
        this.req = req;
        const ms = o.timeout || 15000;
        req.setTimeout(ms, () => { req.abort(); this._fail(new Error('no answer in ' + ms / 1000 + ' s')); });
        req.on('error', (e) => this._fail(e));
        req.on('response', (res) => { res.resume(); this._fail(new Error('http ' + res.statusCode + ' (no WebSocket)')); });
        req.on('upgrade', (res, socket, head) => {
            req.setTimeout(0);
            const want = crypto.createHash('sha1').update(key + GUID).digest('base64');
            if (res.headers['sec-websocket-accept'] !== want) { socket.destroy(); return this._fail(new Error('the server\'s WebSocket answer is wrong')); }
            this.socket = socket;
            socket.setNoDelay(true);
            socket.on('data', (d) => this._data(d));
            socket.on('error', (e) => this._fail(e));
            socket.on('close', () => this._closed(this.closeCode || 1006, this.closeWhy || 'connection lost'));
            this.state = 'open';
            this.emit('open');
            if (head && head.length) this._data(head);
            return undefined;
        });
        req.end();
    }

    send(text) {
        if (this.state !== 'open') return false;
        this.socket.write(frame(1, Buffer.from(String(text), 'utf8')));
        return true;
    }

    close(code) {
        if (this.state === 'open') {
            this.state = 'closing';
            const b = Buffer.alloc(2); b.writeUInt16BE(code || 1000, 0);
            try { this.socket.write(frame(8, b)); } catch (e) { /* gone */ }
            setTimeout(() => { if (this.socket) this.socket.destroy(); }, 1000);
        } else if (this.state === 'connecting') { this.req.abort(); this._closed(1006, 'closed while connecting'); }
    }

    _fail(e) {
        if (this.state === 'closed') return;
        this.emit('error', e);
        if (this.socket) this.socket.destroy(); else this._closed(1006, e.message);
    }

    _closed(code, why) {
        if (this.state === 'closed') return;
        this.state = 'closed';
        this.emit('close', code, why);
    }

    _data(d) {
        // a throw in here would reach the socket's 'data' event and crash the process: handle it instead
        try { this._parse(d); } catch (e) { this._fail(e instanceof Error ? e : new Error(String(e))); }
    }

    _parse(d) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
        for (;;) {
            const b = this.buf;
            if (b.length < 2) return;
            const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
            let n = b[1] & 0x7f, at = 2;
            if (n === 126) { if (b.length < 4) return; n = b.readUInt16BE(2); at = 4; }
            else if (n === 127) { if (b.length < 10) return; n = b.readUInt32BE(2) * 0x100000000 + b.readUInt32BE(6); at = 10; }
            if (n > MAX_MESSAGE) return this._fail(new Error('a message of ' + n + ' bytes'));
            const mask = masked ? b.slice(at, at + 4) : null;
            if (masked) at += 4;
            if (b.length < at + n) return;
            let payload = b.slice(at, at + n);
            if (mask) { payload = Buffer.from(payload); for (let i = 0; i < n; i++) payload[i] ^= mask[i & 3]; }
            this.buf = b.slice(at + n);
            this._frame(fin, op, payload);
            if (this.state === 'closed') return;
        }
    }

    _frame(fin, op, payload) {
        if (op === 9) { if (this.state === 'open') this.socket.write(frame(10, payload)); return; }   // ping -> pong
        if (op === 10) return;
        if (op === 8) {
            this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
            this.closeWhy = payload.slice(2).toString('utf8');
            if (this.state === 'open') { this.state = 'closing'; try { this.socket.write(frame(8, payload.slice(0, 2))); } catch (e) { /* gone */ } }
            // (the server closes the connection then; if it does not, it goes after 1 s)
            this.socket.end();
            const s = this.socket;
            setTimeout(() => s.destroy(), 1000);
            return;
        }
        if (op === 1 || op === 2) this.parts = { op, list: [payload] };
        else if (op === 0 && this.parts) this.parts.list.push(payload);
        else return;
        if (!fin) return;
        const m = this.parts; this.parts = null;
        const all = Buffer.concat(m.list);
        this.emit('message', m.op === 1 ? all.toString('utf8') : all);
    }
}

module.exports = { WebSocket, frame };

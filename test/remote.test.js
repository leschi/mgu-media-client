'use strict';
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { test } = require('./_harness');
const { WebSocket } = require('../apps/media/websocket');
const { Remote } = require('../apps/media/remote');
const { Jellyfin } = require('../apps/media/jellyfin');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** a server frame (unmasked): fin, opcode, payload */
function sframe(fin, op, payload) {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0, n]) : n < 65536 ? Buffer.from([0, 126, n >> 8, n & 255]) : Buffer.alloc(10);
    if (n >= 65536) { head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(n, 6); }
    head[0] = (fin ? 0x80 : 0) | op;
    return Buffer.concat([head, payload]);
}

/** a client frame read off the wire: { op, text } (must be masked) */
function readFrames(buf) {
    const out = [];
    while (buf.length >= 2) {
        let n = buf[1] & 0x7f, at = 2;
        assert.ok(buf[1] & 0x80, 'a client frame is masked');
        if (n === 126) { n = buf.readUInt16BE(2); at = 4; } else if (n === 127) { n = buf.readUInt32BE(6); at = 10; }
        const mask = buf.slice(at, at + 4), p = Buffer.from(buf.slice(at + 4, at + 4 + n));
        if (p.length < n) break;
        for (let i = 0; i < n; i++) p[i] ^= mask[i & 3];
        out.push({ op: buf[0] & 15, data: p });
        buf = buf.slice(at + 4 + n);
    }
    return out;
}

/** a pretend Jellyfin /socket: hands each connection to onConn(socket, req) */
function wsServer(onConn) {
    const srv = http.createServer((q, s) => { s.statusCode = 404; s.end(); });
    srv.on('upgrade', (req, socket) => {
        const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        onConn(socket, req);
    });
    return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

test('WebSocket: the handshake, masked frames out, fragments / 16-bit / 64-bit lengths / ping in', async () => {
    const got = [];
    let sock;
    const srv = await wsServer((s) => { sock = s; s.on('data', (d) => got.push(...readFrames(d))); });
    const ws = new WebSocket('ws://127.0.0.1:' + srv.address().port + '/socket?a=1', { headers: { Authorization: 'x' } });
    const msgs = [];
    ws.on('message', (m) => msgs.push(m));
    await new Promise((r) => ws.on('open', r));
    ws.send('hello');
    sock.write(Buffer.concat([sframe(false, 1, Buffer.from('frag')), sframe(false, 0, Buffer.from('men')), sframe(true, 0, Buffer.from('ted'))]));
    const mid = 'm'.repeat(300), big = 'b'.repeat(70000);
    const both = Buffer.concat([sframe(true, 1, Buffer.from(mid)), sframe(true, 9, Buffer.from('pp')), sframe(true, 1, Buffer.from(big))]);
    sock.write(both.slice(0, 7)); await wait(20); sock.write(both.slice(7));      // (a frame split across reads)
    await wait(100);
    assert.deepStrictEqual(msgs.map((m) => m.length), [10, 300, 70000]);
    assert.strictEqual(msgs[0], 'fragmented');
    assert.deepStrictEqual(got.map((f) => [f.op, f.data.toString()]), [[1, 'hello'], [10, 'pp']]);
    const closed = new Promise((r) => ws.on('close', (c) => r(c)));
    sock.write(sframe(true, 8, Buffer.from([0x03, 0xe8])));
    assert.strictEqual(await closed, 1000);
    srv.close();
});

test('WebSocket: a plain http answer is an error, not a hang', async () => {
    const srv = http.createServer((q, s) => { s.statusCode = 401; s.end(); });
    // (as a server that does not take the token: an http answer to the upgrade; node 8 drops an upgrade nobody listens for)
    srv.on('upgrade', (req, socket) => socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const ws = new WebSocket('ws://127.0.0.1:' + srv.address().port + '/socket');
    const err = await new Promise((r) => ws.on('error', r));
    assert.ok(/http 401/.test(err.message), err.message);
    srv.close();
});

test('Remote: capabilities, token in header and query, keep-alive, Play / Playstate / message, back after a drop', async () => {
    const conns = [];
    const srv = await wsServer((s, req) => {
        const c = { s, req, got: [] };
        s.on('data', (d) => c.got.push(...readFrames(d).map((f) => f.data.toString())));
        conns.push(c);
    });
    const calls = [];
    const jf = new Jellyfin({ deviceId: 'dev1', base: 'http://127.0.0.1:' + srv.address().port, token: 'tok',
        request: (m, u, o) => { calls.push(m + ' ' + u.replace(/^http:\/\/[^/]+/, '') + ' ' + (o.body || '')); return Promise.resolve({ status: 204, body: Buffer.alloc(0) }); } });
    const r = new Remote({ jf, retryMs: 50 });
    const ev = [];
    r.on('play', (x) => ev.push(['play', x]));
    r.on('playstate', (x) => ev.push(['state', x]));
    r.on('message', (x) => ev.push(['msg', x]));
    r.start();
    await wait(150);
    assert.strictEqual(r.state, 'connected');
    const c = conns[0];
    assert.ok(/ApiKey=tok/.test(c.req.url) && /deviceId=dev1/.test(c.req.url), c.req.url);
    assert.ok(/Token="tok"/.test(c.req.headers.authorization) && /DeviceId="dev1"/.test(c.req.headers.authorization));
    assert.ok(/^POST \/Sessions\/Capabilities\/Full .*"SupportsMediaControl":true/.test(calls[0]), calls[0]);
    assert.ok(/"PlayableMediaTypes":\["Video","Audio"\]/.test(calls[0]));
    assert.deepStrictEqual(c.got.map((g) => JSON.parse(g).MessageType), ['KeepAlive']);
    const send = (o) => c.s.write(sframe(true, 1, Buffer.from(JSON.stringify(o))));
    send({ MessageType: 'ForceKeepAlive', Data: 10 });                                // -> every 5 s
    send({ MessageType: 'Play', Data: { ItemIds: ['a', 'b'], StartPositionTicks: 600000000, PlayCommand: 'PlayNow', StartIndex: 1 } });
    send({ MessageType: 'Play', Data: { ItemIds: ['c'], PlayCommand: 'PlayNext' } });
    send({ MessageType: 'Playstate', Data: { Command: 'Seek', SeekPositionTicks: 1200000000 } });
    send({ MessageType: 'Playstate', Data: { Command: 'Pause' } });
    send({ MessageType: 'GeneralCommand', Data: { Name: 'DisplayMessage', Arguments: { Header: 'Hi', Text: 'there' } } });
    send({ MessageType: 'UserDataChanged', Data: {} });
    await wait(100);
    assert.deepStrictEqual(ev, [
        ['play', { ids: ['a', 'b'], startMs: 60000, command: 'PlayNow', startIndex: 1, mediaSourceId: null }],
        ['play', { ids: ['c'], startMs: null, command: 'PlayNext', startIndex: 0, mediaSourceId: null }],
        ['state', { command: 'Seek', seekMs: 120000 }],
        ['state', { command: 'Pause', seekMs: null }],
        ['msg', { header: 'Hi', text: 'there' }]]);
    assert.ok(/DisplayMessage/.test(r.line()), r.line());
    // the server goes away: back by itself, capabilities told again
    c.s.destroy();
    await wait(300);
    assert.strictEqual(conns.length, 2, 'connected again');
    assert.strictEqual(r.state, 'connected');
    assert.strictEqual(calls.filter((x) => /Capabilities/.test(x)).length, 2);
    r.stop();
    await wait(50);
    assert.strictEqual(r.state, 'off');
    await wait(200);
    assert.strictEqual(conns.length, 2, 'stopped: no new connection');
    srv.close();
});

test('Remote: a server that refuses the long capabilities gets the short form', async () => {
    const calls = [];
    const jf = new Jellyfin({ deviceId: 'd', base: 'http://x', token: 't',
        request: (m, u) => { calls.push(u.replace('http://x', '')); return Promise.resolve({ status: /Full/.test(u) ? 400 : 204, body: Buffer.alloc(0) }); } });
    await new Remote({ jf })._caps();
    assert.deepStrictEqual(calls, ['/Sessions/Capabilities/Full', '/Sessions/Capabilities?PlayableMediaTypes=Video,Audio&SupportsMediaControl=true']);
});

test('Jellyfin items(ids): in the order sent', async () => {
    const jf = new Jellyfin({ deviceId: 'd', base: 'http://x', token: 't', userId: 'u',
        request: (m, u) => Promise.resolve({ status: 200, body: Buffer.from('x'), json: () => ({ Items: [{ Id: 'b', Name: 'B', Type: 'Episode' }, { Id: 'a', Name: 'A', Type: 'Movie' }] }), u }) });
    const it = await jf.items(['a', 'b', 'zz']);
    assert.deepStrictEqual(it.map((x) => x.id + x.leaf), ['atrue', 'btrue']);
});

test('MusicPlayer: elapsed follows the player\'s time, seek sets it, add puts tracks next or last', () => {
    const { MusicPlayer } = require('../apps/media/musicplayer');
    const m = new MusicPlayer({ server: {}, sig: {} });
    const calls = [];
    m.media = { mp: 'mp', call: (p, k, a) => { calls.push([k, a]); return Promise.resolve(); }, button: () => Promise.resolve() };
    m.tracks = [{ id: 'a', audio: true }, { id: 'b', audio: true }]; m.i = 0; m.state = 'playing';
    m.at = { ms: 5000, t: Date.now() - 1000 };
    assert.ok(Math.abs(m.elapsed() - 6000) < 50, 'elapsed: ' + m.elapsed());
    m.seek(30000);
    assert.deepStrictEqual(calls[0], ['setTime', { newTimeElapsed: 30000 }]);
    m.pause();
    const held = m.elapsed();
    assert.ok(Math.abs(held - 30000) < 50);
    m.add([{ id: 'n', audio: true }, { id: 'v', audio: false }], true);
    m.add([{ id: 'l', audio: true }]);
    assert.deepStrictEqual(m.tracks.map((x) => x.id), ['a', 'n', 'b', 'l']);
});

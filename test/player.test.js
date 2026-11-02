'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('./_harness');
const { ShmVideo } = require('../apps/media/shmvideo');
const { ClusterVideo } = require('../apps/media/clustervideo');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SEG = [0, 1].map((i) => fs.readFileSync(path.join(__dirname, 'fixtures', 'seg' + i + '.ts')));
const files = { 'http://x/v.m3u8': '#EXTM3U\n#EXTINF:1.0,\ns0.ts\n#EXTINF:1.0,\ns1.ts\n#EXT-X-ENDLIST\n', 'http://x/s0.ts': SEG[0], 'http://x/s1.ts': SEG[1] };
const get = (u) => (files[u] ? Promise.resolve(Buffer.from(files[u])) : Promise.reject(new Error('404 ' + u)));

test('ShmVideo: the renderer\'s frame file - header, three slots, slot then seq', () => {
    const f = path.join(os.tmpdir(), 'mgu-video-test-' + process.pid);
    const s = new ShmVideo(f);
    const ref = s.video({ vw: 33, vh: 18 });                      // odd: made even
    assert.ok(ref > 0);
    const size = 32 * 18 * 3 / 2;
    assert.strictEqual(fs.statSync(f).size, 64 + 3 * size);
    const fr = new Uint8Array(size).fill(77);
    assert.ok(s.frame(ref, fr));
    const b = fs.readFileSync(f);
    assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => b.readUInt32LE(k * 4)), [0x4656474d, 1, 32, 18, 1, 1, 3, 1, 0]);
    assert.strictEqual(b[64 + size], 77);                          // slot 1 written first
    assert.strictEqual(s.frame(ref + 1, fr), false, 'an old layer writes nothing');
    s.drop(ref);
    assert.strictEqual(s.shown, false);
    s.close();
    assert.ok(!fs.existsSync(f));
});

test('ClusterVideo on the MGU display: I420 frames into the file, screen() while parked, gone when driving', async () => {
    const f = path.join(os.tmpdir(), 'mgu-video-cid-' + process.pid);
    let parked = true;
    const v = new ClusterVideo({ url: 'http://x/v.m3u8', target: 'cid', shmFile: f, get, gate: { parked: () => parked, why: () => '' } });
    await v.start();
    await wait(500);
    const scr = v.screen();
    assert.ok(scr, v.lines().join('\n'));
    assert.deepStrictEqual([scr.file, scr.w, scr.h], [f, 64, 48]);
    const b = fs.readFileSync(f);
    assert.ok(b.readUInt32LE(16) >= 3, 'frames written: seq ' + b.readUInt32LE(16));
    const slot = b.readUInt32LE(20), y = b[64 + slot * 64 * 48 * 1.5 + 100];
    assert.ok(y > 50 && y < 120, 'red\'s luma (limited range): ' + y);
    parked = false;
    await wait(100);
    assert.strictEqual(v.screen(), null, 'no picture while driving');
    v.stop();
    v.cr && v.cr.close && v.cr.close();
    try { fs.unlinkSync(f); } catch (e) { /* gone */ }
});

test('ClusterVideo: pause holds the clock and the picture, resume goes on from there', async () => {
    const frames = [];
    const client = { ready: true, targets: '', on() {}, connect() {}, close() {}, drop() {}, video: () => 1, frame: (ref, a) => { frames.push(Date.now()); return true; } };
    const v = new ClusterVideo({ url: 'http://x/v.m3u8', target: 'map', client, get, gate: { parked: () => true, why: () => '' } });
    await v.start();
    await wait(400);
    v.pause();
    const at = v.position(), n = frames.length;
    await wait(1300);
    assert.strictEqual(v.position(), at, 'the clock stands');
    assert.ok(frames.length - n <= 2, 'only the held frame again: ' + (frames.length - n));
    assert.ok(frames.length - n >= 1, 'held frame re-sent (stall_ms)');
    v.resume();
    await wait(200);
    assert.ok(v.position() > at && v.position() < at + 0.5, v.position() + ' after ' + at);
    v.stop();
});

test('MusicPlayer: paused is not the end of a track', async () => {
    const { MusicPlayer } = require('../apps/media/musicplayer');
    const m = new MusicPlayer({ server: {}, sig: {} });
    const buttons = [];
    m.media = { button: (b) => { buttons.push(b); return Promise.resolve(); }, get: () => Promise.resolve('{}') };
    m.tracks = [{ id: 'a' }, { id: 'b' }]; m.i = 0; m.state = 'playing'; m.played = true;
    let went = 0;
    m._go = () => { went++; };
    m.pause();
    m._poll();
    await wait(20);
    assert.strictEqual(went, 0);
    assert.ok(/paused/.test(m.lines()[0]));
    m.resume();
    assert.deepStrictEqual(buttons, ['PAUSE', 'PLAY']);
});

test('sound: on in a fresh file from the segment playing; the old one deleted; the picture clock counts from the file\'s start', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-sound-'));
    const v = new ClusterVideo({ url: 'http://x/v.m3u8', target: 'map', get, tmp: dir });
    const a = { segs: Array.from({ length: 10 }, (x, i) => ({ url: 's' + i, t: i * 6, dur: 6 })) };
    const calls = [];
    const old = path.join(dir, 'mgu-media-sound-a.aac');
    fs.writeFileSync(old, 'old');
    v.audio = { state: 'playing', segs: 8, chunks: new Map(Array.from({ length: 8 }, (x, i) => [i, Buffer.from('<' + i + '>')])), nameIdx: 0, file: old, first: 0, base: 0,
        media: { mp: 'mp', call: (p, m, arg) => { calls.push([m, arg]); return Promise.resolve({}); } } };
    v._rotate(a, 20500, Date.now(), dir);                              // at 20.5 s: segment 3 (18-24 s)
    const nu = dir + '/mgu-media-sound-b.aac';
    assert.strictEqual(fs.readFileSync(nu, 'utf8'), '<3><4><5><6><7>');
    assert.deepStrictEqual([v.audio.file, v.audio.first, v.audio.base], [nu, 3, 18]);
    assert.deepStrictEqual(Array.from(v.audio.chunks.keys()), [3, 4, 5, 6, 7]);
    await wait(50);
    assert.strictEqual(calls[0][0], 'playFile'); assert.strictEqual(calls[0][1].path, nu);
    assert.strictEqual(calls[1][0], 'setTime');
    assert.ok(Math.abs(calls[1][1].newTimeElapsed - 2500) < 100, 'at 2.5 s into the new file: ' + calls[1][1].newTimeElapsed);
    assert.strictEqual(v.audio.pending, 'reopen');
    v.running = true; v.clock0 = Date.now() - 20000;
    v._sync(3000);                                                     // (ignored while the reopen settles)
    await wait(2600);
    assert.ok(!fs.existsSync(old), 'the old file deleted');
    v._sync(3000);                                                     // 3 s into the new file = 21 s in all
    assert.ok(Math.abs(v.position() - 21) < 0.1, 'clock follows base + elapsed: ' + v.position());
    fs.unlinkSync(nu); fs.rmdirSync(dir);
});

test('one cluster-render connection for every video: a target change drops the old layer, then makes the new one; no handlers left', async () => {
    const EventEmitter = require('events');
    const ops = [];
    const c = new EventEmitter();
    c.ready = true; c.targets = 'map:1088x480,panel:1920x720,hud:800x480';
    let next = 1, connects = 0;
    c.connect = () => { connects++; };
    c.close = () => { ops.push('close'); };
    c.video = (o) => { const r = next++; ops.push('video ' + o.target + ' #' + r); return r; };
    c.frame = () => true;
    c.set = () => {};
    c.drop = (r) => { ops.push('drop #' + r); };
    const base = c.listenerCount('layer');
    const mk = (target) => new ClusterVideo({ url: 'http://x/v.m3u8', target, client: c, get, gate: { parked: () => true, why: () => '' } });
    const hud = mk('hud');
    await hud.start();
    await wait(300);
    hud.stop();
    const panel = mk('panel');
    await panel.start();
    await wait(300);
    assert.deepStrictEqual(ops, ['video hud #1', 'drop #1', 'video panel #2'], 'in order, on one socket, never closed');
    panel.stop();
    assert.strictEqual(c.listenerCount('layer'), base, 'the videos\' handlers gone');
    assert.strictEqual(connects, 2, '(connect on a live client does nothing)');
});

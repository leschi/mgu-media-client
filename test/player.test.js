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

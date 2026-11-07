'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { test } = require('./_harness');
const { H264Decoder, i420ToAtlas } = require('../apps/media/h264dec');
const { demuxTs, splitNals } = require('../apps/media/tsdemux');
const { parseMaster, parseMedia, pickVariant, stripId3 } = require('../apps/media/hls');
const { gate, stageFromGearbox, stageFromSelection } = require('../apps/media/parkgate');
const { ClusterVideo, crop } = require('../apps/media/clustervideo');

// two 1 s segments, 64x48, 12 fps, H.264 Baseline (ffmpeg testsrc): the first red, the second blue
const SEG = [0, 1].map((i) => fs.readFileSync(path.join(__dirname, 'fixtures', 'seg' + i + '.ts')));

test('tsdemux: access units with their time, NAL units without start codes', () => {
    const aus = demuxTs(SEG[0]);
    assert.strictEqual(aus.length, 12);
    assert.ok(Math.abs((aus[1].pts - aus[0].pts) - 1 / 12) < 0.001);
    assert.ok(aus[0].nals.some((n) => (n[0] & 31) === 7) && aus[0].nals.some((n) => (n[0] & 31) === 5), 'SPS and IDR first');
    assert.deepStrictEqual(splitNals(Buffer.from([0, 0, 0, 1, 9, 0xf0, 0, 0, 1, 0x67, 1, 2])).map((b) => Array.from(b)), [[9, 0xf0], [0x67, 1, 2]]);
});

test('h264dec: decodes the Baseline segments (red, then blue)', () => {
    const d = H264Decoder.load();
    const first = (seg) => { let p = null, n = 0; for (const a of demuxTs(seg)) for (const x of a.nals) { if ((x[0] & 31) === 9 || (x[0] & 31) === 6) continue; const q = d.decode(x); if (q) { n++; p = p || { w: q.w, h: q.h, y: q.i420[0], u: q.i420[64 * 48], v: q.i420[64 * 48 + 32 * 24] }; } } return { p, n }; };
    const red = first(SEG[0]), blue = first(SEG[1]);
    assert.strictEqual(red.n, 12); assert.strictEqual(blue.n, 12);
    assert.deepStrictEqual([red.p.w, red.p.h], [64, 48]);
    assert.ok(red.p.v > 200 && red.p.u < 128, JSON.stringify(red.p));     // red: V high
    assert.ok(blue.p.u > 200 && blue.p.v < 128, JSON.stringify(blue.p));  // blue: U high
    assert.strictEqual(d.errors, 0);
    d.release();
});

test('i420ToAtlas: Y, then U and V side by side per row; crop keeps the top-left', () => {
    const w = 4, h = 2, i420 = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, /* U */ 10, 11, /* V */ 20, 21]);
    assert.deepStrictEqual(Array.from(i420ToAtlas(i420, w, h, Buffer.alloc(12))), [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 20, 21]);
    const big = { w: 4, h: 4, i420: Uint8Array.from([...Array(16).keys(), 100, 101, 102, 103, 200, 201, 202, 203]) };
    assert.deepStrictEqual(Array.from(crop(big, 4, 2)), [0, 1, 2, 3, 4, 5, 6, 7, 100, 101, 200, 201]);
});

test('hls: master -> the Baseline variant and its audio; media playlist times; ID3 off', () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2540826,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,AUDIO="aac-1"\nplaylist_720.m3u8\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=1365701,CODECS="avc1.42c01e,mp4a.40.2",RESOLUTION=640x360,AUDIO="aac-1"\nplaylist_360.m3u8\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=807717,CODECS="avc1.42c015,mp4a.40.2",RESOLUTION=480x270,AUDIO="aac-1"\nplaylist_270.m3u8\n' +
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac-1",NAME="Alternate Audio",DEFAULT=YES,URI="playlist_audio_en_1.m3u8"\n';
    const m = parseMaster(master, 'https://cdn.example/hls/x/playlist.m3u8');
    const v = pickVariant(m.variants, 1088);
    assert.strictEqual(v.url, 'https://cdn.example/hls/x/playlist_360.m3u8');
    assert.strictEqual(m.audio[v.audio], 'https://cdn.example/hls/x/playlist_audio_en_1.m3u8');
    assert.strictEqual(pickVariant(m.variants.slice(0, 1)), null);           // High profile only: none
    const segs = parseMedia('#EXTM3U\n#EXTINF:6.000,\na_1.ts\n#EXTINF:5.5,\na_2.ts\n#EXT-X-ENDLIST\n', 'https://cdn.example/hls/x/playlist_360.m3u8');
    assert.deepStrictEqual(segs.map((s) => [s.url.slice(-6), s.dur, s.t]), [['a_1.ts', 6, 0], ['a_2.ts', 5.5, 6]]);
    const id3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 3, 1, 2, 3]), Buffer.from([0xff, 0xf1, 9])]);
    assert.deepStrictEqual(Array.from(stripId3(id3)), [0xff, 0xf1, 9]);
});

test('parkgate: parked only with a fresh speed under 1 km/h AND the selector in P', () => {
    let now = 1000;
    const g = gate(() => now);
    assert.strictEqual(g.parked(), false, 'nothing known');
    g.speed({ speedVehicleCentreOfGravity: 0 });
    assert.strictEqual(g.parked(), false, 'speed, no selector');
    g.stage(stageFromSelection({ statusGearSelectionDrive: 'P' }));
    assert.strictEqual(g.parked(), true);
    assert.strictEqual(g.why(), 'speed 0.0 km/h, selector P');
    g.speed({ speedVehicleCentreOfGravity: 64 * 2 });                     // 2 km/h
    assert.strictEqual(g.parked(), false, 'rolling');
    g.speed({ speedVehicleCentreOfGravity: 0 });
    g.stage(stageFromGearbox({ statusActualStageDrive: 'D' }));
    assert.strictEqual(g.parked(), false, 'in D at a standstill');
    g.stage(stageFromSelection({ statusGearSelectionDrive: 4 }));        // NP: not told apart
    assert.strictEqual(g.parked(), false, 'N or P');
    g.stage(stageFromGearbox({ statusActualStageDrive: 1 }));           // P as its wire number
    assert.strictEqual(g.parked(), true);
    g.speed({ speedVehicleCentreOfGravity: 65535 });                     // invalid: the last speed stays
    assert.strictEqual(g.parked(), true);
    now += 11000;                                                       // no speed read for 11 s
    assert.strictEqual(g.parked(), false, 'old speed');
    assert.ok(/\(old\)/.test(g.why()));
});

/** cluster-render as the client sees it: video layers and the frames sent to them */
function fakeClient() {
    const c = new EventEmitter();
    c.ready = false; c.targets = 'map:1088x480,panel:1920x720,hud:800x480';
    c.layers = new Map(); c.frames = []; c.dropped = [];
    let next = 1;
    c.connect = () => { c.ready = true; setImmediate(() => c.emit('ready')); };
    c.made = 0;
    c.video = (o) => { const r = next++; c.made++; c.layers.set(r, o); return r; };
    c.frame = (ref, atlas) => { if (!c.layers.has(ref)) return false; c.frames.push({ ref, y: atlas[0], u: atlas[64 * 48], v: atlas[64 * 48 + 32] }); return true; };
    c.drop = (ref) => { c.layers.delete(ref); c.dropped.push(ref); };
    c.sets = [];
    c.set = (ref, o) => { c.sets.push([ref, o.visible]); };
    c.close = () => {};
    return c;
}

test('ClusterVideo: frames go to a video layer while parked; driving off hides it, parked again it shows again (the same layer)', async () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000,CODECS="avc1.42c00a",RESOLUTION=64x48\nv.m3u8\n';
    const media = '#EXTM3U\n#EXTINF:1.0,\ns0.ts\n#EXTINF:1.0,\ns1.ts\n#EXT-X-ENDLIST\n';
    const files = { 'http://x/p.m3u8': master, 'http://x/v.m3u8': media, 'http://x/s0.ts': SEG[0], 'http://x/s1.ts': SEG[1] };
    const get = (u) => (files[u] ? Promise.resolve(Buffer.from(files[u])) : Promise.reject(new Error('404 ' + u)));
    let parked = true;
    const client = fakeClient();
    const v = new ClusterVideo({ url: 'http://x/p.m3u8', target: 'map', client, get, gate: { parked: () => parked, why: () => (parked ? 'parked' : 'driving') } });
    await v.start();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(500);
    assert.strictEqual(v.state, 'playing', v.lines().join('\n'));
    const ref = [...client.layers.keys()][0];
    const lo = client.layers.get(ref);
    assert.deepStrictEqual([lo.target, lo.vw, lo.vh, lo.klass], ['map', 64, 48, 'content']);
    assert.deepStrictEqual([lo.x, lo.y, lo.w, lo.h], [224, 0, 640, 480]);       // 4:3 fitted into 1088x480
    assert.ok(client.frames.length >= 3 && client.frames[0].v > 200, 'red frames: ' + JSON.stringify(client.frames.slice(0, 2)));
    parked = false;
    await wait(100);
    assert.deepStrictEqual(client.sets, [[ref, 0]], 'hidden, not dropped (as waze: the middle is not given up and taken over again)');
    assert.deepStrictEqual(client.dropped, []);
    assert.ok(/^paused: not parked/.test(v.state), v.state);
    const sent = client.frames.length;
    await wait(300);
    assert.strictEqual(client.frames.length, sent, 'no frames while driving');
    // parked again after the clock passed 1 s: the picture comes back in the second (blue) segment
    await wait(700);
    parked = true;
    await wait(400);
    assert.strictEqual(client.made, 1, 'the same layer once parked again');
    assert.deepStrictEqual(client.sets, [[ref, 0], [ref, 1]]);
    const last = client.frames[client.frames.length - 1];
    assert.ok(last.u > 200, 'blue after the pause: ' + JSON.stringify(last));
    await wait(1200);
    assert.strictEqual(v.state, 'done', v.lines().join('\n'));
    v.stop();
    assert.strictEqual(v.state, 'stopped');
});

test('ClusterVideo: never parked - no layer, no frame', async () => {
    const client = fakeClient();
    const files = { 'http://x/v.m3u8': '#EXTM3U\n#EXTINF:1.0,\ns0.ts\n', 'http://x/s0.ts': SEG[0] };
    const v = new ClusterVideo({ url: 'http://x/v.m3u8', target: 'hud', client, get: (u) => Promise.resolve(Buffer.from(files[u])), gate: { parked: () => false, why: () => 'selector unknown' } });
    await v.start();
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(client.layers.size, 0);
    assert.strictEqual(client.frames.length, 0);
    assert.ok(/not parked/.test(v.state) && /selector unknown/.test(v.lines()[0]), v.lines().join('\n'));
    v.stop();
});

test('hls: "smooth" picks the variant whose atlases fit the cluster upload budget', () => {
    const v = (w, h, codecs) => ({ url: w + 'p', width: w, height: h, fps: 24, bw: w * 1000, codecs });
    const list = [v(1280, 720, 'avc1.64001f'), v(640, 360, 'avc1.42c01e'), v(480, 270, 'avc1.42c015')];
    assert.strictEqual(pickVariant(list, 1088).width, 640);                       // sharp: the largest Baseline
    assert.strictEqual(pickVariant(list, 1088, 5500 * 1000 * 0.85).width, 480);   // 640x360x1.5x24 = 8.3 MB/s: too much
    assert.strictEqual(pickVariant(list.slice(0, 2), 1088, 1000).width, 640);     // none fits: the smallest there is
    const m = parseMaster('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.42c01e",RESOLUTION=640x360,FRAME-RATE=24.000\nv.m3u8\n', 'http://x/p.m3u8');
    assert.strictEqual(m.variants[0].fps, 24);
});

test('ClusterVideo: Diag shows the quality, the upload cap and the service status', async () => {
    const os = require('os');
    const st = path.join(os.tmpdir(), 'mgu-cr-status.txt');
    fs.writeFileSync(st, 'cluster-render 1.2\nupload: cap 5000 KB/s (ceiling 5500, floor 2000)\ntarget map: in the last 60 s its layers wrote 1440 frames\ntarget hud: idle\n');
    const client = fakeClient();
    const files = { 'http://x/v.m3u8': '#EXTM3U\n#EXTINF:1.0,\ns0.ts\n', 'http://x/s0.ts': SEG[0] };
    const v = new ClusterVideo({ url: 'http://x/v.m3u8', target: 'map', client, statusFile: st, get: (u) => Promise.resolve(Buffer.from(files[u])), gate: { parked: () => false, why: () => '-' } });
    await v.start();
    client.emit('budget', 4500, 5500, 'scene removed');
    const L = v.lines().join('\n');
    assert.ok(/quality smooth, .*upload cap 4500 KB\/s \(scene removed\)/.test(L), L);
    assert.ok(/service: upload: cap 5000/.test(L) && /service: target map: in the last 60 s/.test(L) && !/target hud/.test(L), L);
    v.stop(); fs.unlinkSync(st);
});

test('ClusterVideo: the picture follows the player\'s time (sound ahead -> the clock jumps forward)', () => {
    const v = new ClusterVideo({ url: 'x', client: fakeClient() });
    v._sync(3000);                                              // no clock yet: it starts at the sound's time
    assert.ok(Math.abs((Date.now() - v.clock0) - 3000) < 50);
    v.clock0 = Date.now() - 5000;                               // the picture at 5 s ...
    v._sync(8000);                                              // ... the sound at 8 s: 3 s ahead
    assert.ok(Math.abs((Date.now() - v.clock0) - 8000) < 50);
    assert.ok(/picture -3\.00 s to the sound, set 1x/.test(v.lines().join('\n')) || v.syncInfo.n === 1);
    const c = v.clock0;
    v._sync(Date.now() - c + 100);                              // within 0.25 s: left alone
    assert.strictEqual(v.clock0, c);
    v.audio.pending = 'reopen';
    v._sync(1);                                                 // reopening: no sync
    assert.strictEqual(v.clock0, c);
});

test('ClusterVideo: BMW content keeps the slot -> a hint on Diag after 8 s, logged once', async () => {
    const client = fakeClient();
    const files = { 'http://x/v.m3u8': '#EXTM3U\n#EXTINF:1.0,\ns0.ts\n', 'http://x/s0.ts': SEG[0] };
    const v = new ClusterVideo({ url: 'http://x/v.m3u8', target: 'map', client, get: (u) => Promise.resolve(Buffer.from(files[u])), gate: { parked: () => true, why: () => 'P' } });
    await v.start();
    await new Promise((r) => setTimeout(r, 300));
    const ref = v.layer;
    assert.ok(ref, 'a layer');
    for (let i = 0; i < 3; i++) { client.emit('layer', ref, 'waiting', 'target parked: parked behind stock'); client.emit('layer', ref, 'waiting', 'target parked: parked behind stock'); }
    assert.strictEqual(v.events.filter((e) => /behind stock/.test(e)).length, 1);
    assert.ok(!/NOT SHOWN/.test(v.lines().join('\n')));
    v.stockSince -= 9000;
    assert.ok(/^NOT SHOWN: BMW content holds the cluster middle - set Instrument cluster > Central display area to Map view/.test(v.lines()[0]), v.lines()[0]);
    assert.ok(/Map view/.test(v.hint()), 'the hint without Debug on too');
    client.emit('layer', ref, 'shown', '');
    assert.ok(!/NOT SHOWN/.test(v.lines().join('\n')));
    v.stop();
});

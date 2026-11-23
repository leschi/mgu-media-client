'use strict';
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { test } = require('./_harness');
const { AirPlay, AirPlayVideo, fitSize, scaleI420 } = require('../apps/media/airplay');
const { uidOf } = require('../tools/airplay/launch');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what) => { for (let i = 0; i < 100; i++) { if (fn()) return; await wait(50); } throw new Error('timeout: ' + what); };

test('airplay: the frame made smaller (aspect kept, a width of 4s, an even height), each plane its nearest pixels', () => {
    assert.deepStrictEqual(fitSize(1280, 720, 480, 270), { w: 480, h: 270 });
    assert.deepStrictEqual(fitSize(332, 720, 480, 270), { w: 124, h: 270 });             // a phone held upright
    assert.deepStrictEqual(fitSize(320, 180, 480, 270), { w: 320, h: 180 });             // never larger
    const src = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, /* U */ 20, 21, 22, 23, /* V */ 30, 31, 32, 33]);
    assert.deepStrictEqual(Array.from(scaleI420(src, 4, 4, 2, 2, Buffer.alloc(6))), [6, 8, 14, 16, 23, 33]);
});

test('airplay launcher: the app\'s uid from the app manager\'s list', () => {
    assert.strictEqual(uidOf('12210=media\n12211=pllana_airplay\n', 'media'), 12210);
    assert.strictEqual(uidOf('12211=pllana_airplay\n', 'media'), null);
    assert.throws(() => uidOf('12210=media\n12212=media\n', 'media'));
    assert.throws(() => uidOf('0=media\n', 'media'));
});

/** cluster-render as the client sees it */
function fakeClient() {
    const c = new EventEmitter();
    let next = 1;
    Object.assign(c, { ready: true, targets: 'map:1088x480,hud:800x480', layers: new Map(), frames: [], dropped: [], sets: [], connect() {}, close() {} });
    c.video = (o) => { c.layers.set(next, o); return next++; };
    c.frame = (ref, b) => { c.frames.push({ ref, y: b[0], n: b.length }); return true; };
    c.drop = (ref) => { c.layers.delete(ref); c.dropped.push(ref); };
    c.set = (ref, o) => c.sets.push([ref, o.visible]);
    return c;
}

// the receiver as backend.js sees it: its arguments kept, the same lines, frames in the file it is told
const RECEIVER = `
const fs = require('fs'), a = process.argv.slice(2), data = a[a.indexOf('-t') + 1];
fs.writeFileSync(data + '/args', JSON.stringify(a));
const file = a[a.indexOf('-f') + 1];
const say = (s) => process.stdout.write(s + '\\n');
const w = 1280, h = 720; let fd = null, seq = 0;
function frame(y) {
    if (fd === null) { fd = fs.openSync(file, 'wx', 0o600); fs.ftruncateSync(fd, 64 + 3 * w * h * 3 / 2); }
    seq++; const slot = seq % 3, b = Buffer.alloc(64);
    fs.writeSync(fd, Buffer.alloc(w * h, y), 0, w * h, 64 + slot * w * h * 3 / 2);
    [0x4656474d, 1, w, h, seq, slot, 3, 1, 0].forEach((v, i) => b.writeUInt32LE(v, i * 4));
    fs.writeSync(fd, b, 0, 64, 0);
}
say('ready 7110');
process.stdin.on('data', (d) => fs.appendFileSync(data + '/in', d));
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
setTimeout(() => { say('connected 1'); say('mode mirror'); setInterval(() => frame(100), 40); }, 400);
`;

if (process.platform === 'linux') test('airplay: the receiver process, its state, the picture on the HUD only while parked, stop', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-')), bin = dir + '/mgu-airplay', data = dir + '/data';
    fs.mkdirSync(data);
    fs.writeFileSync(dir + '/rx.js', RECEIVER);
    fs.writeFileSync(bin, '#!/bin/sh\nexec "' + process.execPath + '" "' + dir + '/rx.js" "$@"\n', { mode: 0o755 });
    const be = cp.spawn(process.execPath, [path.join(__dirname, '../apps/media/backend.js')], { env: Object.assign({}, process.env, { MGU_AIRPLAY_BIN: bin, MGU_AIRPLAY_DATA: data }), stdio: 'inherit' });
    const air = new AirPlay(data + '/control.sock');
    let parked = true;
    const client = fakeClient();
    const v = new AirPlayVideo({ target: 'hud', air, client, gate: { parked: () => parked, why: () => (parked ? 'P' : 'driving') } });
    try {
        air.connect();
        await until(() => air.state.phase === 'stopped', 'connected');
        assert.strictEqual(air.active(), false);
        air.start(480, 270); v.start();
        await until(() => air.state.phase === 'waiting', 'waiting');
        assert.ok(/^\d{6}$/.test(air.state.code), air.state.code);
        await until(() => air.state.frame && client.frames.length > 2, 'frames');
        const args = JSON.parse(fs.readFileSync(data + '/args', 'utf8'));
        assert.strictEqual(args[args.indexOf('-w') + 1], air.state.code);
        assert.strictEqual(args[args.indexOf('-n') + 1], 'BMW MGU');
        assert.strictEqual(args.indexOf('-u'), -1, 'no internet here: no video the car would have to fetch');
        assert.deepStrictEqual([fs.readFileSync(data + '/in', 'utf8'), fs.statSync(data + '/control.sock').mode & 0o777], ['size 480 270\n', 0o600]);
        assert.deepStrictEqual([air.state.mode, air.state.connected, air.state.frame.w], ['mirror', true, 1280]);
        const lo = client.layers.get(v.layer);
        assert.deepStrictEqual([lo.target, lo.vw, lo.vh, lo.w, lo.h], ['hud', 480, 270, 800, 450]);
        assert.deepStrictEqual([client.frames[0].y, client.frames[0].n], [100, 480 * 270 * 1.5]);
        // driving: hidden, nothing sent, the receiver (its sound) goes on
        parked = false;
        await wait(150);
        const n = client.frames.length;
        await wait(250);
        assert.strictEqual(client.frames.length, n);
        assert.deepStrictEqual(client.sets[client.sets.length - 1], [v.layer, 0]);
        assert.ok(/not parked/.test(v.state));
        assert.strictEqual(air.state.phase, 'playing');
        parked = true;
        await until(() => client.frames.length > n, 'shown again');
        // (a second app is not let in)
        const second = new AirPlay(data + '/control.sock');
        second.connect(); await wait(200);
        assert.strictEqual(second.state.phase, 'off');
        second.close();
        air.stop();
        await until(() => air.state.phase === 'stopped', 'stopped');
        assert.strictEqual(air.state.code + air.state.file, '');
        assert.deepStrictEqual(fs.readdirSync('/dev/shm').filter((f) => f.indexOf('mgu-video-airplay-' + process.getuid() + '-' + be.pid) === 0), []);
        await wait(150);
        assert.deepStrictEqual(client.sets[client.sets.length - 1], [v.layer, 0]);
    } finally {
        v.stop(); air.close();
        await new Promise((r) => { be.once('exit', r); be.kill('SIGTERM'); });
    }
    assert.ok(!fs.existsSync(data + '/control.sock'));
});

test('airplay: the MGU display gets the receiver\'s own file, only while parked; a file elsewhere is not taken', () => {
    const air = new AirPlay('/nowhere');
    let parked = false;
    const v = new AirPlayVideo({ target: 'cid', air, gate: { parked: () => parked, why: () => '' } });
    v.running = true;
    air._set({ phase: 'playing', file: '/dev/shm/mgu-video-airplay-1-2-3', frame: { w: 1280, h: 720, gen: '1:2' } });
    v._tickAir();
    assert.strictEqual(v.screen(), null);
    parked = true; v._tickAir();
    assert.deepStrictEqual(v.screen(), { file: '/dev/shm/mgu-video-airplay-1-2-3', w: 1280, h: 720, gen: '1:2' });
    air._set({ phase: 'playing', file: '/etc/passwd', frame: { w: 1280, h: 720, gen: '1:2' } });
    v._tickAir();
    assert.strictEqual(v.screen(), null);
});

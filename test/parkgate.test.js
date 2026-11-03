'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./_harness');
const park = require('../apps/media/parkgate');
const { ClusterVideo } = require('../apps/media/clustervideo');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** the kit's vehicle signals, pretend: the handlers start() gives, by service */
function fakeSignals(how) {
    const h = {};
    return {
        h,
        watch(svc, ver, handlers) {
            if (how === 'throw') throw new Error('no such service');
            Object.assign(h, handlers);
            return how === 'reject' ? Promise.reject(new Error('not offered')) : Promise.resolve({});
        },
    };
}

// NOTE: isParked() is force-overridden to true in parkgate.js for on-car testing (TEST build).
// These tests check the REAL parked decision through gate()/watchPark() and why(), which are NOT
// overridden, so they stay meaningful. When the "return true" line in parkgate.js is removed,
// isParked() tracks the gate again and the override marker test below flips to false.

test('parkgate why(): never throws, reports the reason it is not parked before/after start()', () => {
    park.reset();
    assert.ok(/not started/.test(park.why()), park.why());
    park.start(undefined);
    assert.ok(/no vehicle signals/.test(park.why()), park.why());
    park.reset();
    park.start(fakeSignals('throw'));
    assert.ok(/no such service/.test(park.why()), park.why());
    park.reset();
});

test('parkgate real decision gate(): true only with a fresh speed under 1 km/h AND P', () => {
    let t = 1000; const now = () => t;
    const g = park.gate(now);
    assert.strictEqual(g.parked(), false, 'nothing told yet');
    g.speed({ speedVehicleCentreOfGravity: 0 });
    assert.strictEqual(g.parked(), false, 'speed 0 but selector unknown');
    g.stage(park.stageFromGearbox({ statusActualStageDrive: 1 }));
    assert.strictEqual(g.parked(), true, g.why());
    g.speed({ speedVehicleCentreOfGravity: 64 });                 // 1 km/h
    assert.strictEqual(g.parked(), false, 'moving');
    g.speed({ speedVehicleCentreOfGravity: 0 });
    g.stage(park.stageFromSelection({ statusGearSelectionDrive: 4 }));  // 'NP'
    assert.strictEqual(g.parked(), false, 'NP is not P');
    g.stage(park.stageFromSelection({ statusGearSelectionDrive: 3 }));
    g.speed({ speedVehicleCentreOfGravity: 65535 });              // invalid: the last good one stays
    assert.strictEqual(g.parked(), true);
    t += 20000;                                                   // speed now older than STALE_MS
    assert.strictEqual(g.parked(), false, 'stale speed');
});

test('parkgate isParked(): FORCE OVERRIDE returns true (TEST build - remove before shipping)', () => {
    park.reset();
    assert.strictEqual(park.isParked(), true);
    assert.strictEqual(typeof park.isParked(), 'boolean');
});

test('ClusterVideo with a gate that is not parked: never a picture (fails closed)', async () => {
    // An explicit gate whose parked() is false, so this tests ClusterVideo's gating branch
    // independently of the isParked() TEST override (which forces the no-gate fallback to true).
    park.reset();
    const SEG = fs.readFileSync(path.join(__dirname, 'fixtures', 'seg0.ts'));
    const files = { 'http://x/v.m3u8': '#EXTM3U\n#EXTINF:1.0,\ns0.ts\n#EXT-X-ENDLIST\n', 'http://x/s0.ts': SEG };
    const get = (u) => (files[u] ? Promise.resolve(Buffer.from(files[u])) : Promise.reject(new Error('404 ' + u)));
    let frames = 0;
    const client = { ready: true, targets: '', on() {}, connect() {}, close() {}, drop() {}, set() {}, video: () => 1, frame: () => { frames++; return true; } };
    const v = new ClusterVideo({ url: 'http://x/v.m3u8', target: 'map', client, get, gate: { parked: () => false, why: () => 'test: not parked' } });
    await v.start();
    await wait(400);
    assert.strictEqual(frames, 0, 'no frame');
    assert.ok(/not parked/.test(v.state), v.state);
    v.stop();
});

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

test('parkgate isParked(): false before start(), and after a start() without signals - never throws', () => {
    park.reset();
    assert.strictEqual(park.isParked(), false);
    assert.ok(/not started/.test(park.why()), park.why());
    park.start(undefined);
    assert.strictEqual(park.isParked(), false);
    assert.ok(/no vehicle signals/.test(park.why()), park.why());
    park.reset();
    park.start(fakeSignals('throw'));
    assert.strictEqual(park.isParked(), false);
    assert.ok(/no such service/.test(park.why()), park.why());
    park.reset();
});

test('parkgate isParked(): true only with a speed under 1 km/h AND P; signals that are refused stay false', async () => {
    park.reset();
    const s = fakeSignals('reject');                        // (refused later: no unhandled rejection, still false)
    park.start(s);
    await wait(10);
    assert.strictEqual(park.isParked(), false, 'nothing told yet');
    s.h.statusCarSpeed2({ speedVehicleCentreOfGravity: 0 });
    assert.strictEqual(park.isParked(), false, 'speed 0 but selector unknown');
    s.h.statusGearboxDrive({ statusActualStageDrive: 1 });
    assert.strictEqual(park.isParked(), true, park.why());
    s.h.statusCarSpeed2({ speedVehicleCentreOfGravity: 64 });     // 1 km/h
    assert.strictEqual(park.isParked(), false, 'moving');
    s.h.statusCarSpeed2({ speedVehicleCentreOfGravity: 0 });
    s.h.DataPowerTrain2({ statusGearSelectionDrive: 4 });          // 'NP'
    assert.strictEqual(park.isParked(), false, 'NP is not P');
    s.h.DataPowerTrain2({ statusGearSelectionDrive: 3 });
    s.h.statusCarSpeed2({ speedVehicleCentreOfGravity: 65535 });   // invalid: the last good one stays
    assert.strictEqual(park.isParked(), true);
    assert.strictEqual(typeof park.isParked(), 'boolean');
    park.start(fakeSignals());                                     // a second start does nothing
    assert.strictEqual(park.isParked(), true);
    park.reset();
});

test('ClusterVideo without a gate: never a picture while ./parkgate is not started (fails closed)', async () => {
    park.reset();
    const SEG = fs.readFileSync(path.join(__dirname, 'fixtures', 'seg0.ts'));
    const files = { 'http://x/v.m3u8': '#EXTM3U\n#EXTINF:1.0,\ns0.ts\n#EXT-X-ENDLIST\n', 'http://x/s0.ts': SEG };
    const get = (u) => (files[u] ? Promise.resolve(Buffer.from(files[u])) : Promise.reject(new Error('404 ' + u)));
    let frames = 0;
    const client = { ready: true, targets: '', on() {}, connect() {}, close() {}, drop() {}, set() {}, video: () => 1, frame: () => { frames++; return true; } };
    const v = new ClusterVideo({ url: 'http://x/v.m3u8', target: 'map', client, get });
    await v.start();
    await wait(400);
    assert.strictEqual(frames, 0, 'no frame');
    assert.ok(/not parked/.test(v.state), v.state);
    v.stop();
});

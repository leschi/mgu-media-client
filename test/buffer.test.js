'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('./_harness');
const { SegmentBuffer, clearDir } = require('../apps/media/buffer');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > (ms || 3000)) throw new Error('timed out'); await wait(10); } };

/** a buffer over n segments of 6 s, 1000 bytes (o.size) each, from a pretend server */
function make(o) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-buf-'));
    const fetched = [];
    const n = o.n || 40;
    const b = new SegmentBuffer(Object.assign({
        dir: path.join(dir, 'buffer'),
        fetch: (i) => { fetched.push(i); return o.fail && o.fail(i) ? Promise.reject(new Error('http 503')) : Promise.resolve(Buffer.alloc(o.size || 1000, i & 255)); },
        count: () => n, time: (i) => i * 6, dur: () => 6, ended: () => true, df: () => Promise.resolve(o.free == null ? null : o.free),
    }, o.opts || {}));
    const files = () => (fs.existsSync(b.dir) ? fs.readdirSync(b.dir).sort((x, y) => parseInt(x.slice(3), 10) - parseInt(y.slice(3), 10)) : []);
    const done = () => { b.stop(); fs.rmdirSync(b.dir); fs.rmdirSync(dir); };
    return { b, fetched, files, done };
}

test('buffer: fetches ahead up to aheadS onto the disk, reads from there, a played segment goes', async () => {
    const { b, fetched, files, done } = make({ opts: { aheadS: 30 } });
    b.start();
    await until(() => b.state === 'full');
    assert.deepStrictEqual(files(), ['seg0.ts', 'seg1.ts', 'seg2.ts', 'seg3.ts', 'seg4.ts']);        // 5 x 6 s = 30 s
    assert.strictEqual(b.ahead(), 30);
    const n0 = fetched.length;
    assert.strictEqual((await b.get(2))[0], 2);
    assert.strictEqual(fetched.length, n0, 'from the disk, not fetched again');
    b.setPos(3);                                                                                    // playing segment 3: 0 and 1 go, 2 is kept
    await until(() => b.files.has(7));
    assert.deepStrictEqual(files(), ['seg2.ts', 'seg3.ts', 'seg4.ts', 'seg5.ts', 'seg6.ts', 'seg7.ts']);
    assert.ok(/buffer: 0:30 of 0:30 ahead, .* - full/.test(b.lines()) || /filling/.test(b.lines()), b.lines());
    done();
});

test('buffer: a segment asked for before the loop has it is fetched once; the folder is emptied at stop and at start', async () => {
    const { b, fetched, files, done } = make({ opts: { aheadS: 12 } });
    fs.mkdirSync(b.dir); fs.writeFileSync(path.join(b.dir, 'seg99.ts'), 'left by a killed run');
    b.start();
    assert.ok(!fs.existsSync(path.join(b.dir, 'seg99.ts')));
    const [x, y] = await Promise.all([b.get(0), b.get(0)]);
    assert.strictEqual(x[0], 0); assert.strictEqual(x, y);
    await until(() => b.state === 'full');
    assert.strictEqual(fetched.filter((i) => i === 0).length, 1);
    b.stop();
    assert.deepStrictEqual(files(), []);
    clearDir(b.dir);
    done();
});

test('buffer: keeps the disk\'s reserve free and stays under maxBytes; a failing fetch is tried again', async () => {
    const MB = 1048576;
    const low = make({ free: 1.5 * MB, size: MB, opts: { aheadS: 600, reserveBytes: MB } });   // room for none past the reserve
    low.b.start();
    await until(() => /held: keeping/.test(low.b.state));
    assert.deepStrictEqual(low.files(), []);
    low.done();
    const cap = make({ size: MB, opts: { aheadS: 600, maxBytes: 3 * MB + 10, reserveBytes: 0 } });
    cap.b.start();
    await until(() => /held: at its/.test(cap.b.state));
    assert.strictEqual(cap.files().length, 3);
    cap.b.setPos(3);                                                                     // played on: room again
    await until(() => cap.b.files.has(4), 6000);              // (2 is kept behind: 2, 3, 4 fill the 3 MB; a held buffer looks again every 3 s)
    cap.done();
    let fails = 2;
    const flaky = make({ fail: (i) => i === 1 && fails-- > 0, opts: { aheadS: 18 } });
    flaky.b.start();
    await until(() => flaky.b.state === 'retrying');
    assert.ok(/http 503/.test(flaky.b.lines()));
    await until(() => flaky.b.state === 'full', 9000);
    assert.deepStrictEqual(flaky.files(), ['seg0.ts', 'seg1.ts', 'seg2.ts']);
    flaky.done();
});

test('ClusterVideo with the disk buffer: the segments go through the folder, which is empty after stop', async () => {
    const { ClusterVideo } = require('../apps/media/clustervideo');
    const SEG = [0, 1].map((i) => fs.readFileSync(path.join(__dirname, 'fixtures', 'seg' + i + '.ts')));
    const media = '#EXTM3U\n#EXTINF:1.0,\ns0.ts\n#EXTINF:1.0,\ns1.ts\n#EXT-X-ENDLIST\n';
    const files = { 'http://x/v.m3u8': media, 'http://x/s0.ts': SEG[0], 'http://x/s1.ts': SEG[1] };
    const asked = [];
    const get = (u) => { asked.push(u); return files[u] ? Promise.resolve(Buffer.from(files[u])) : Promise.reject(new Error('404 ' + u)); };
    const frames = [];
    const client = { ready: true, targets: '', on() {}, connect() {}, close() {}, drop() {}, video: () => 1, frame: (ref, a) => { frames.push(a[0]); return true; } };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-cvbuf-'));
    const bufferDir = path.join(dir, 'buffer');
    const v = new ClusterVideo({ url: 'http://x/v.m3u8', target: 'map', client, get, bufferDir, bufferS: 60, df: () => Promise.resolve(null), gate: { parked: () => true, why: () => 'parked' } });
    await v.start();
    await until(() => v.buf && v.buf.state === 'all in');
    assert.deepStrictEqual(fs.readdirSync(bufferDir).sort(), ['seg0.ts', 'seg1.ts']);
    await wait(500);
    assert.strictEqual(v.state, 'playing', v.lines().join('\n'));
    assert.ok(frames.length >= 3, 'frames from the buffered segments');
    assert.ok(v.lines().some((l) => /^buffer: /.test(l)), v.lines().join('\n'));
    assert.strictEqual(asked.filter((u) => /s0\.ts/.test(u)).length, 1, 'each segment fetched once');
    v.stop();
    assert.deepStrictEqual(fs.readdirSync(bufferDir), []);
    fs.rmdirSync(bufferDir); fs.rmdirSync(dir);
});

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { test } = require('./_harness');
const { decode } = require('../apps/media/png');
const { item } = require('../apps/media/jellyfin');

/** a PNG of w x h pixels (bpp bytes each, from px(x, y)), row y filtered with filter y % 5 */
function encode(w, h, type, bpp, px, plte) {
    const raw = Buffer.alloc(h * (w * bpp + 1)), plain = Buffer.alloc(h * w * bpp);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px(x, y).forEach((v, k) => { plain[(y * w + x) * bpp + k] = v; });
    const st = w * bpp;
    for (let y = 0; y < h; y++) {
        const f = y % 5;
        raw[y * (st + 1)] = f;
        for (let i = 0; i < st; i++) {
            const v = plain[y * st + i], a = i >= bpp ? plain[y * st + i - bpp] : 0, b = y ? plain[(y - 1) * st + i] : 0, c = i >= bpp && y ? plain[(y - 1) * st + i - bpp] : 0;
            const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
            raw[y * (st + 1) + 1 + i] = (v - pred) & 255;
        }
    }
    const chunk = (k, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); return Buffer.concat([l, Buffer.from(k, 'ascii'), d, Buffer.alloc(4)]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = type;
    return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), plte ? chunk('PLTE', plte) : Buffer.alloc(0),
        chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('png: RGBA, RGB, grey and palette images, all five row filters', () => {
    const col = (x, y) => [(x * 37 + y * 11) & 255, (x * 5 + y * 90) & 255, (x * y * 3 + 7) & 255];
    const check = (img, w, h, want) => {
        assert.strictEqual(img.w, w); assert.strictEqual(img.h, h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const j = (y * w + x) * 4;
            assert.deepStrictEqual([img.rgba[j], img.rgba[j + 1], img.rgba[j + 2], img.rgba[j + 3]], want(x, y).concat([255]), x + ',' + y);
        }
    };
    check(decode(encode(9, 10, 6, 4, (x, y) => col(x, y).concat([x * 20]))), 9, 10, col);
    check(decode(encode(9, 10, 2, 3, col)), 9, 10, col);
    check(decode(encode(7, 6, 0, 1, (x, y) => [x * 30 + y])), 7, 6, (x, y) => [x * 30 + y, x * 30 + y, x * 30 + y]);
    const pal = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255]);
    check(decode(encode(6, 5, 3, 1, (x, y) => [(x + y) % 3], pal)), 6, 5, (x, y) => [...pal.slice(((x + y) % 3) * 3, ((x + y) % 3) * 3 + 3)]);
    assert.throws(() => decode(Buffer.from('not a png at all, really not one')), /not a PNG/);
});

test('png: a PNG FFmpeg wrote (mixed filters) gives its own pixels', () => {
    const img = decode(fs.readFileSync(path.join(__dirname, 'fixtures', 'pic.png')));
    const rgb = fs.readFileSync(path.join(__dirname, 'fixtures', 'pic.rgb'));
    assert.strictEqual(img.w * img.h * 3, rgb.length);
    for (let i = 0; i < img.w * img.h; i++) for (let k = 0; k < 3; k++) if (img.rgba[i * 4 + k] !== rgb[i * 3 + k]) assert.fail('pixel ' + i);
});

test('jellyfin item: its own picture, else the series\' or the album\'s', () => {
    assert.strictEqual(item({ Id: 'm', Type: 'Movie', ImageTags: { Primary: 'x' } }).img, 'm');
    assert.strictEqual(item({ Id: 'e', Type: 'Episode', SeriesId: 's', SeriesPrimaryImageTag: 'y' }).img, 's');
    assert.strictEqual(item({ Id: 't', Type: 'Audio', AlbumId: 'a', AlbumPrimaryImageTag: 'z' }).img, 'a');
    assert.strictEqual(item({ Id: 'n', Type: 'Folder' }).img, null);
});

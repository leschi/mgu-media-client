'use strict';
/**
 * qr.js - a minimal QR Code generator (byte mode), adapted from Nayuki's "QR Code generator library"
 * (MIT, Project Nayuki). Pure JavaScript, no dependencies, Node 8 compatible. Returns a square
 * boolean matrix (true = dark module). Used by the diagnostics screen to put data on the car's screen
 * so it can be read with a phone (there is no SSH access to the head unit).
 *
 * See NOTICE.md for the upstream attribution.
 */

const ECC = { L: 0, M: 1, Q: 2, H: 3 };

// Per (ecl, version 1..40): error-correction codewords per block, and number of blocks.
const ECC_CW_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

function numRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
        const numAlign = Math.floor(ver / 7) + 2;
        result -= (25 * numAlign - 10) * numAlign - 55;
        if (ver >= 7) result -= 36;
    }
    return result;
}
function numDataCodewords(ver, ecl) {
    return Math.floor(numRawDataModules(ver) / 8) - ECC_CW_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver];
}

/* ---- Reed-Solomon over GF(256), primitive polynomial 0x11D ---- */
function rsDivisor(degree) {
    const result = new Uint8Array(degree);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < degree; j++) {
            result[j] = rsMul(result[j], root);
            if (j + 1 < degree) result[j] ^= result[j + 1];
        }
        root = rsMul(root, 0x02);
    }
    return result;
}
function rsRemainder(data, divisor) {
    const result = new Uint8Array(divisor.length);
    for (const b of data) {
        const factor = b ^ result[0];
        result.copyWithin(0, 1);
        result[result.length - 1] = 0;
        for (let i = 0; i < result.length; i++) result[i] ^= rsMul(divisor[i], factor);
    }
    return result;
}
function rsMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11D);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
}

/* ---- bit buffer ---- */
function appendBits(bb, val, len) { for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1); }

/* ---- the QR matrix ---- */
function build(text, eclName) {
    const ecl = ECC[eclName] === undefined ? ECC.M : ECC[eclName];
    const data = Buffer.from(String(text), 'utf8');

    // smallest version that fits, byte mode
    let version = 0;
    for (let v = 1; v <= 40; v++) {
        const cap = numDataCodewords(v, ecl) * 8;
        const ccBits = v <= 9 ? 8 : 16;
        const need = 4 + ccBits + data.length * 8;
        if (need <= cap) { version = v; break; }
    }
    if (version === 0) throw new Error('data too long for a QR code');

    const ccBits = version <= 9 ? 8 : 16;
    const bb = [];
    appendBits(bb, 0x4, 4);                 // byte mode
    appendBits(bb, data.length, ccBits);
    for (const b of data) appendBits(bb, b, 8);

    const capacityBits = numDataCodewords(version, ecl) * 8;
    appendBits(bb, 0, Math.min(4, capacityBits - bb.length));   // terminator
    while (bb.length % 8 !== 0) bb.push(0);
    for (let pad = 0xEC; bb.length < capacityBits; pad ^= 0xEC ^ 0x11) appendBits(bb, pad, 8);

    const dataCw = new Uint8Array(bb.length / 8);
    for (let i = 0; i < dataCw.length; i++) for (let j = 0; j < 8; j++) dataCw[i] |= bb[i * 8 + j] << (7 - j);

    const allCw = addEcc(dataCw, version, ecl);
    return draw(allCw, version, ecl);
}

function addEcc(data, version, ecl) {
    const numBlocks = NUM_BLOCKS[ecl][version];
    const blockEccLen = ECC_CW_PER_BLOCK[ecl][version];
    const rawCw = Math.floor(numRawDataModules(version) / 8);
    const numShort = numBlocks - rawCw % numBlocks;
    const shortLen = Math.floor(rawCw / numBlocks);

    const blocks = [];
    const divisor = rsDivisor(blockEccLen);
    let k = 0;
    for (let i = 0; i < numBlocks; i++) {
        const datLen = shortLen - blockEccLen + (i < numShort ? 0 : 1);
        const dat = data.slice(k, k + datLen); k += datLen;
        const ecc = rsRemainder(dat, divisor);
        blocks.push({ dat, ecc });
    }
    // interleave
    const result = [];
    const maxDat = shortLen - blockEccLen + 1;
    for (let i = 0; i < maxDat; i++) for (let j = 0; j < blocks.length; j++) if (i < blocks[j].dat.length) result.push(blocks[j].dat[i]);
    for (let i = 0; i < blockEccLen; i++) for (let j = 0; j < blocks.length; j++) result.push(blocks[j].ecc[i]);
    return result;
}

function draw(allCw, version, ecl) {
    const size = version * 4 + 17;
    const modules = [], isFn = [];
    for (let i = 0; i < size; i++) { modules.push(new Array(size).fill(false)); isFn.push(new Array(size).fill(false)); }
    const set = (x, y, dark) => { modules[y][x] = dark; isFn[y][x] = true; };

    // timing patterns
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    // finder patterns
    const finder = (cx, cy) => {
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
            const x = cx + dx, y = cy + dy;
            if (x < 0 || x >= size || y < 0 || y >= size) continue;
            const d = Math.max(Math.abs(dx), Math.abs(dy));
            set(x, y, d !== 2 && d !== 4);
        }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    // alignment patterns
    const pos = alignPositions(version);
    for (let i = 0; i < pos.length; i++) for (let j = 0; j < pos.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
        const cx = pos[i], cy = pos[j];
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    // reserve format/version areas as function modules (filled later)
    reserveFormat(isFn, size);
    if (version >= 7) reserveVersion(isFn, size);

    // place data with the zigzag
    placeData(modules, isFn, allCw, size);

    // choose the mask with the lowest penalty
    let best = 0, bestPenalty = Infinity, bestModules = null;
    for (let mask = 0; mask < 8; mask++) {
        const m = modules.map((row) => row.slice());
        applyMask(m, isFn, mask);
        drawFormat(m, size, ecl, mask);
        if (version >= 7) drawVersion(m, size, version);
        const p = penalty(m, size);
        if (p < bestPenalty) { bestPenalty = p; best = mask; bestModules = m; }
    }
    return bestModules;
}

function alignPositions(ver) {
    if (ver === 1) return [];
    const num = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (num * 2 - 2)) * 2;
    const result = [6];
    for (let p = ver * 4 + 10; result.length < num; p -= step) result.splice(1, 0, p);
    return result;
}

function reserveFormat(isFn, size) {
    for (let i = 0; i < 9; i++) { isFn[8][i] = true; isFn[i][8] = true; }
    for (let i = 0; i < 8; i++) { isFn[8][size - 1 - i] = true; isFn[size - 1 - i][8] = true; }
    isFn[size - 8][8] = true; // dark module area
}
function reserveVersion(isFn, size) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { isFn[size - 11 + j][i] = true; isFn[i][size - 11 + j] = true; }
}

function placeData(modules, isFn, allCw, size) {
    let i = 0; // bit index
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const upward = ((right + 1) & 2) === 0;
                const y = upward ? size - 1 - vert : vert;
                if (!isFn[y][x] && i < allCw.length * 8) {
                    modules[y][x] = ((allCw[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
                    i++;
                }
            }
        }
    }
}

function maskFn(mask, x, y) {
    switch (mask) {
        case 0: return (x + y) % 2 === 0;
        case 1: return y % 2 === 0;
        case 2: return x % 3 === 0;
        case 3: return (x + y) % 3 === 0;
        case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
        case 5: return (x * y) % 2 + (x * y) % 3 === 0;
        case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
        case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    }
}
function applyMask(modules, isFn, mask) {
    for (let y = 0; y < modules.length; y++) for (let x = 0; x < modules.length; x++) if (!isFn[y][x] && maskFn(mask, x, y)) modules[y][x] = !modules[y][x];
}

function drawFormat(modules, size, ecl, mask) {
    const eclBits = [1, 0, 3, 2][ecl];        // L=01,M=00,Q=11,H=10
    const data = eclBits << 3 | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const get = (i) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) modules[i][8] = get(i);
    modules[7][8] = get(6); modules[8][8] = get(7); modules[8][7] = get(8);
    for (let i = 9; i < 15; i++) modules[8][14 - i] = get(i);
    for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = get(i);
    for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = get(i);
    modules[size - 8][8] = true; // dark module
}
function drawVersion(modules, size, version) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const bits = version << 12 | rem;
    for (let i = 0; i < 18; i++) {
        const bit = ((bits >>> i) & 1) !== 0;
        const a = size - 11 + i % 3, b = Math.floor(i / 3);
        modules[a][b] = bit; modules[b][a] = bit;
    }
}

function penalty(modules, size) {
    let p = 0;
    // rule 1: runs of 5+ same colour
    for (let y = 0; y < size; y++) {
        let runColor = modules[y][0], runLen = 1;
        for (let x = 1; x < size; x++) {
            if (modules[y][x] === runColor) { runLen++; if (runLen === 5) p += 3; else if (runLen > 5) p++; }
            else { runColor = modules[y][x]; runLen = 1; }
        }
    }
    for (let x = 0; x < size; x++) {
        let runColor = modules[0][x], runLen = 1;
        for (let y = 1; y < size; y++) {
            if (modules[y][x] === runColor) { runLen++; if (runLen === 5) p += 3; else if (runLen > 5) p++; }
            else { runColor = modules[y][x]; runLen = 1; }
        }
    }
    // rule 2: 2x2 blocks
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) p += 3;
    }
    // rule 4: dark proportion
    let dark = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) dark++;
    const percent = dark * 100 / (size * size);
    p += Math.floor(Math.abs(percent - 50) / 5) * 10;
    return p;
}

module.exports = { build, ECC };

'use strict';
/**
 * tsdemux.js - an MPEG-TS segment (HLS) taken apart: PAT -> PMT -> the H.264 video's PES packets as
 * access units of NAL units with their time (pts, seconds), and the AAC (ADTS) sound's bytes. A Media
 * transcode carries both in one segment; a stream with a separate audio rendition has video only.
 *
 *   const aus = demuxTs(segment);                // [{ pts, nals: [Buffer, ...] }, ...]
 *   const { video, audio, audioPts } = demuxTsAll(segment);   // audio: ADTS frames, end to end (or null)
 */
const PKT = 188;

/** Annex B byte stream -> NAL units (without their start codes) */
function splitNals(b) {
    const out = [];
    let i = 0, start = -1;
    while (i + 2 < b.length) {
        if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
            if (start >= 0) { let e = i; if (e > start && b[e - 1] === 0) e--; out.push(b.slice(start, e)); }
            i += 3; start = i;
        } else i++;
    }
    if (start >= 0 && start < b.length) out.push(b.slice(start));
    return out.filter((n) => n.length);
}

function pts33(b, o) {
    return ((b[o] & 0x0e) * 536870912 + b[o + 1] * 4194304 + (b[o + 2] & 0xfe) * 16384 + b[o + 3] * 128 + (b[o + 4] >> 1)) / 90000;
}

function demuxTsAll(buf) {
    let pmtPid = -1, vidPid = -1, audPid = -1;
    const pes = { v: [], a: [] };
    const cur = { v: null, a: null };
    for (let off = 0; off + PKT <= buf.length; off += PKT) {
        if (buf[off] !== 0x47) { // lost sync: find the next 0x47
            const n = buf.indexOf(0x47, off + 1);
            if (n < 0) break;
            off = n - PKT; continue;
        }
        const pusi = (buf[off + 1] & 0x40) !== 0, pid = ((buf[off + 1] & 0x1f) << 8) | buf[off + 2];
        const afc = (buf[off + 3] >> 4) & 3;
        let p = off + 4;
        if (afc === 2) continue;
        if (afc === 3) p += 1 + buf[p];
        if (p >= off + PKT) continue;
        if (pid === 0 && pusi) {                                     // PAT: the first program's PMT
            p += 1 + buf[p];
            const len = ((buf[p + 1] & 0x0f) << 8) | buf[p + 2];
            for (let q = p + 8; q + 4 <= p + 3 + len - 4; q += 4) {
                const prog = (buf[q] << 8) | buf[q + 1];
                if (prog !== 0) { pmtPid = ((buf[q + 2] & 0x1f) << 8) | buf[q + 3]; break; }
            }
        } else if (pid === pmtPid && pusi) {                         // PMT: H.264 (0x1b) and AAC ADTS (0x0f)
            p += 1 + buf[p];
            const len = ((buf[p + 1] & 0x0f) << 8) | buf[p + 2], end = p + 3 + len - 4;
            let q = p + 12 + (((buf[p + 10] & 0x0f) << 8) | buf[p + 11]);
            while (q + 5 <= end) {
                const type = buf[q], epid = ((buf[q + 1] & 0x1f) << 8) | buf[q + 2], il = ((buf[q + 3] & 0x0f) << 8) | buf[q + 4];
                if (type === 0x1b && vidPid < 0) vidPid = epid;
                if (type === 0x0f && audPid < 0) audPid = epid;
                q += 5 + il;
            }
        } else if (pid === vidPid || pid === audPid) {
            const k = pid === vidPid ? 'v' : 'a';
            if (pusi) {
                if (buf[p] !== 0 || buf[p + 1] !== 0 || buf[p + 2] !== 1) continue;
                const flags = buf[p + 7], hl = buf[p + 8];
                cur[k] = { pts: (flags & 0x80) ? pts33(buf, p + 9) : (cur[k] ? cur[k].pts : 0), parts: [] };
                pes[k].push(cur[k]);
                p += 9 + hl;
            }
            if (cur[k]) cur[k].parts.push(buf.slice(p, off + PKT));
        }
    }
    return {
        video: pes.v.map((x) => ({ pts: x.pts, nals: splitNals(Buffer.concat(x.parts)) })),
        audio: pes.a.length ? Buffer.concat(pes.a.map((x) => Buffer.concat(x.parts))) : null,
        audioPts: pes.a.length ? pes.a[0].pts : null,
    };
}

function demuxTs(buf) { return demuxTsAll(buf).video; }

module.exports = { demuxTs, demuxTsAll, splitNals };

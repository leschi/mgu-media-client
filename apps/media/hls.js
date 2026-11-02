'use strict';
/**
 * hls.js - an HLS (m3u8) source for the app: the master playlist, the variant our decoder takes
 * (H.264 Baseline: ./h264dec), its segments, and the audio-only rendition's segments. BMW's player
 * plays local files only (car v0.2.37: every URL ITEM_UNPLAYABLE), so the app fetches everything itself.
 *
 *   const src = new HlsSource(url, { lookup });
 *   await src.open();          // src.video: { width, height, segs: [{ url, dur, t }] }, src.audio: { segs } | null
 *   const buf = await src.get(src.video.segs[0].url);
 */
const http = require('http');
const https = require('https');
const url = require('url');

/** GET (http or https, redirects followed) -> Buffer; lookup: the DNS lookup (the car's own fails for apps) */
function get(u, opts, hops) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
        const o = Object.assign(url.parse(u), { lookup: opts.lookup, headers: { 'User-Agent': 'a prior project' } });
        const req = (o.protocol === 'http:' ? http : https).get(o, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (hops || 0) < 3) {
                res.resume();
                return resolve(get(url.resolve(u, res.headers.location), opts, (hops || 0) + 1));
            }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error('http ' + res.statusCode + ' ' + u)); }
            const parts = [];
            res.on('data', (d) => parts.push(d));
            res.on('end', () => resolve(Buffer.concat(parts)));
            res.on('error', reject);
            return undefined;
        });
        req.on('error', reject);
        const ms = opts.timeout || 20000;
        req.setTimeout(ms, () => { req.abort(); reject(new Error('no answer in ' + ms / 1000 + ' s: ' + u)); });
    });
}

function attrs(s) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
    return out;
}

/** a master playlist -> { variants: [{ url, bw, codecs, width, height, audio }], audio: { groupId: url } } */
function parseMaster(text, base) {
    const lines = String(text).split(/\r?\n/), variants = [], audio = {};
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i].trim();
        if (/^#EXT-X-STREAM-INF:/.test(l)) {
            const a = attrs(l.slice(18)), res = /^(\d+)x(\d+)$/.exec(a.RESOLUTION || '') || [];
            let j = i + 1;
            while (j < lines.length && (!lines[j].trim() || /^#/.test(lines[j].trim()))) j++;
            if (j < lines.length) variants.push({ url: url.resolve(base, lines[j].trim()), bw: +a.BANDWIDTH || 0, codecs: a.CODECS || '', width: +res[1] || 0, height: +res[2] || 0, fps: parseFloat(a['FRAME-RATE']) || 0, audio: a.AUDIO || '' });
        } else if (/^#EXT-X-MEDIA:/.test(l)) {
            const a = attrs(l.slice(13));
            if (a.TYPE === 'AUDIO' && a.URI && !audio[a['GROUP-ID']]) audio[a['GROUP-ID']] = url.resolve(base, a.URI);
        }
    }
    return { variants, audio };
}

/** a media playlist -> [{ url, dur, t }] (t: its start, seconds) */
function parseMedia(text, base) {
    const lines = String(text).split(/\r?\n/), segs = [];
    let dur = 0, t = 0;
    for (const raw of lines) {
        const l = raw.trim();
        if (/^#EXTINF:/.test(l)) dur = parseFloat(l.slice(8)) || 0;
        else if (l && !/^#/.test(l)) { segs.push({ url: url.resolve(base, l), dur, t }); t += dur; dur = 0; }
    }
    return segs;
}

/** H.264 Baseline (avc1.42...) or Constrained Baseline: what h264bsd decodes */
function baseline(codecs) { return /avc1\.42/i.test(codecs); }

/**
 * the variant to decode: Baseline, at most maxW wide, the widest such; else null. maxBps: the bytes a
 * second its frames may take as cluster-render atlases (w * h * 3/2 a frame, fps of them) - its upload
 * budget; the smallest Baseline variant when none fits.
 */
function pickVariant(variants, maxW, maxBps) {
    const ok = variants.filter((v) => baseline(v.codecs) && (!v.width || v.width <= (maxW || 1280)));
    ok.sort((a, b) => (b.width - a.width) || (b.bw - a.bw));
    if (!maxBps) return ok[0] || null;
    const rate = (v) => v.width * v.height * 1.5 * (v.fps || 30);
    return ok.find((v) => v.width && rate(v) <= maxBps) || ok[ok.length - 1] || null;
}

/** an ADTS AAC segment from HLS: its ID3 tag (the timestamp) cut off, so segments can follow one another */
function stripId3(b) {
    let o = 0;
    while (o + 10 <= b.length && b[o] === 0x49 && b[o + 1] === 0x44 && b[o + 2] === 0x33) {
        const size = ((b[o + 6] & 0x7f) << 21) | ((b[o + 7] & 0x7f) << 14) | ((b[o + 8] & 0x7f) << 7) | (b[o + 9] & 0x7f);
        o += 10 + size + ((b[o + 5] & 0x10) ? 10 : 0);
    }
    return o ? b.slice(o) : b;
}

/** a media playlist's text -> { segs, ended } (ended: #EXT-X-ENDLIST - else it may grow: a live transcode) */
function parseMediaInfo(text, base) { return { segs: parseMedia(text, base), ended: /#EXT-X-ENDLIST/.test(text) }; }

const CACHE_N = 4;                 // segments kept (the sound runs ahead and fetches them first: the picture reuses them)

class HlsSource {
    constructor(u, opts) {
        this.url = u; this.opts = opts || {}; this.video = null; this.audio = null;
        this.cache = new Map(); this.inflight = new Map(); this.warn = '';
    }

    get(u) { return (this.opts.get || get)(u, this.opts); }

    /**
     * a segment, from the cache or fetched once (a second asker waits for the same fetch); a transcoder
     * that has not made it yet answers 404 or 500 for a while: tried again (5 times, 1 s apart)
     */
    segment(u) {
        if (this.cache.has(u)) return Promise.resolve(this.cache.get(u));
        if (this.inflight.has(u)) return this.inflight.get(u);
        const tries = this.opts.tries || 5, gap = this.opts.retryMs == null ? 1000 : this.opts.retryMs;
        const go = (n) => this.get(u).catch((e) => (n > 1 ? new Promise((r) => setTimeout(r, gap)).then(() => go(n - 1)) : Promise.reject(e)));
        const p = go(tries).then((b) => {
            this.inflight.delete(u);
            this.cache.set(u, b);
            while (this.cache.size > CACHE_N) this.cache.delete(this.cache.keys().next().value);
            return b;
        }, (e) => { this.inflight.delete(u); throw e; });
        this.inflight.set(u, p);
        return p;
    }

    async open() {
        const text = String(await this.get(this.url));
        if (/#EXTINF:/.test(text)) {          // a media playlist straight away: no codec info, try it
            const mi = parseMediaInfo(text, this.url);
            this.video = { width: 0, height: 0, codecs: '', url: this.url, segs: mi.segs, ended: mi.ended };
            return this;
        }
        const m = parseMaster(text, this.url);
        let v = pickVariant(m.variants, this.opts.maxWidth, this.opts.maxBps);
        if (!v && this.opts.anyProfile && m.variants.length) {
            // (a transcode made for us has one variant, its profile maybe not named Baseline: the decoder says)
            v = m.variants.slice().sort((x, y) => x.width - y.width)[0];
            this.warn = 'not named H.264 Baseline: ' + (v.codecs || 'no codecs given');
        }
        if (!v) throw new Error('no H.264 Baseline variant (the decoder takes Baseline only): ' + m.variants.map((x) => x.codecs + ' ' + x.width + 'x' + x.height).join('; '));
        const mi = parseMediaInfo(String(await this.get(v.url)), v.url);
        this.video = { width: v.width, height: v.height, fps: v.fps, codecs: v.codecs, url: v.url, segs: mi.segs, ended: mi.ended };
        const au = m.audio[v.audio];
        if (au) { const ai = parseMediaInfo(String(await this.get(au)), au); this.audio = { url: au, segs: ai.segs, ended: ai.ended }; }
        return this;
    }

    /** a playlist that grows (no ENDLIST): read it again, new segments added to the same list */
    async refresh() {
        for (const pl of [this.video, this.audio]) {
            if (!pl || pl.ended) continue;
            const mi = parseMediaInfo(String(await this.get(pl.url)), pl.url);
            const have = new Set(pl.segs.map((x) => x.url));
            let t = pl.segs.length ? pl.segs[pl.segs.length - 1].t + pl.segs[pl.segs.length - 1].dur : 0;
            for (const sg of mi.segs) if (!have.has(sg.url)) { pl.segs.push({ url: sg.url, dur: sg.dur, t }); t += sg.dur; }
            pl.ended = mi.ended;
        }
    }
}

module.exports = { HlsSource, get, parseMaster, parseMedia, parseMediaInfo, pickVariant, stripId3 };

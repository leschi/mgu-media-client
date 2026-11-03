'use strict';
/**
 * remotelog.js - the app's diagnostics online, in a jsonbin.io bin per car (VIN), so they can be read
 * from a PC while the car is being tested: no photos of QR codes. A TEST facility with a throwaway key
 * (remotelog-config.json, deleted when testing ends).
 *
 * Requests are few (the free plan has a fixed number): per car once a bin (named after the VIN) and an
 * entry in the directory bin (VIN -> bin id); then one PUT per update - on events, at most one a minute
 * (pending ones are merged), or at once on demand. A counter in the data folder caps the app's
 * requests. The SOME/IP catalog goes once, in parts (a bin holds 100 kB), again only when it changes.
 *
 *   const r = new RemoteLog({ log, dataDir, config, vin: () => Promise<string> });
 *   r.update(() => ({ ...diagnostics }), 'audio test done');   // queued, sent within a minute
 *   r.update(fn, 'button', true);                               // now
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const dns = require('dns');

const API = 'api.jsonbin.io';
const MIN_GAP = 60000;            // automatic updates: at most one a minute
const NOW_GAP = 5000;             // on demand: at most one in 5 s
const MAX_BIN = 95 * 1024;        // a bin holds 100 kB (free plan)
const CHUNK = 90 * 1024;          // catalog part: base64 of this fits a 100 kB bin
const SPACING = 1500;             // one request at a time, at least this far apart (jsonbin answers 429 to bursts)
const BACKOFF = 30000;            // 429 Too Many Requests: wait this, then twice it, then three times, then give up

// network errors: the update waits and goes again (not a jsonbin answer: no request of the key used)
const NETWORK = /^429|Too many|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|timeout|socket hang up|no address/i;

/*
 * Name lookup with a fallback: on the car the app's own DNS lookup failed (ENOTFOUND api.jsonbin.io)
 * while connections to IP addresses worked. Then the name is looked up over HTTPS at a fixed IP
 * (DNS over HTTPS: Cloudflare 1.1.1.1, Google 8.8.8.8; their certificates name those IPs). The TLS
 * check of the real connection stays the same: it is made to the name, only its address comes from here.
 */
const resolved = {};                  // host -> { address, how, t }
function doh(server, p, host) {
    return new Promise((resolve, reject) => {
        const req = https.get({ host: server, path: p + encodeURIComponent(host) + '&type=A', headers: { Accept: 'application/dns-json' }, timeout: 8000 }, (res) => {
            const parts = [];
            res.on('data', (d) => parts.push(d));
            res.on('end', () => {
                try {
                    const a = (JSON.parse(Buffer.concat(parts).toString('utf8')).Answer || []).filter((x) => x.type === 1).map((x) => x.data);
                    if (a.length) resolve(a[0]); else reject(new Error('no address'));
                } catch (e) { reject(e); }
            });
        });
        req.on('timeout', () => { req.abort(); reject(new Error('timeout')); });
        req.on('error', reject);
    });
}
function lookup(host, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const done = (address, how) => {
        resolved[host] = { address, how, t: Date.now() };
        if (opts && opts.all) cb(null, [{ address, family: 4 }]); else cb(null, address, 4);
    };
    dns.lookup(host, { family: 4 }, (err, address) => {
        if (!err && address) return done(address, 'dns');
        const r = resolved[host];
        if (r && Date.now() - r.t < 6 * 3600000 && r.how !== 'dns') return done(r.address, r.how.replace(/ \(cached\)$/, '') + ' (cached)');
        doh('1.1.1.1', '/dns-query?name=', host).then((a) => done(a, 'DoH 1.1.1.1'),
            () => doh('8.8.8.8', '/resolve?name=', host).then((a) => done(a, 'DoH 8.8.8.8'),
                (e2) => cb(Object.assign(new Error('getaddrinfo ' + (err && err.code) + ', DoH: ' + e2.message), { code: (err && err.code) || 'ENOTFOUND' }))));
    });
}

class RemoteLog {
    constructor(opts) {
        this.log = opts.log || { info() {}, warn() {} };
        this.dataDir = opts.dataDir;
        this.cfg = opts.config || {};
        this.vinFn = opts.vin;
        this.stateFile = this.dataDir ? path.join(this.dataDir, 'remotelog-state.json') : null;
        this.state = this._load();
        this.lines = [];
        this.busy = false;
        this.pending = null;          // { fn, why } waiting for the gap
        this.lastT = 0;
        this.timer = null;
        this.queue = Promise.resolve();   // requests one at a time (_paced)
        this.lastReqT = 0;
        this.uploading = false;
    }

    get enabled() { return !!(this.cfg.accessKey && this.cfg.directoryBin); }
    get used() { return this.state.requests || 0; }
    get cap() { return this.cfg.maxRequests || 2000; }

    _load() { try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch (e) { return { requests: 0 }; } }
    _save() { if (this.stateFile) try { fs.writeFileSync(this.stateFile, JSON.stringify(this.state)); } catch (e) { /* next time */ } }
    _add(l) { this.lines.push(new Date().toTimeString().slice(0, 8) + ' ' + l); if (this.lines.length > 20) this.lines.shift(); this.log.info('remotelog: ' + l); }

    /**
     * One request, paced: one at a time, SPACING apart; a 429 (too many requests) waits and goes again
     * (BACKOFF, 2x, 3x), so a burst never turns into a row of failures.
     */
    _req(method, p, body, headers) {
        let tries = 0;
        const attempt = () => this._paced().then(() => this._send(method, p, body, headers)).catch((e) => {
            if (!/^429/.test(e.message) || tries >= 3) throw e;
            const ms = (this.cfg.backoffMs || BACKOFF) * ++tries;
            this._add('jsonbin: too many requests - waiting ' + Math.round(ms / 1000) + ' s');
            return new Promise((r) => setTimeout(r, ms)).then(attempt);
        });
        return attempt();
    }
    _paced() {
        const gap = this.cfg.spacingMs != null ? this.cfg.spacingMs : SPACING;
        const p = this.queue.then(() => new Promise((r) => setTimeout(r, Math.max(0, this.lastReqT + gap - Date.now())))).then(() => { this.lastReqT = Date.now(); });
        this.queue = p.catch(() => {});
        return p;
    }

    /** one request as it is (counted when jsonbin answers, capped): resolves { status, body } */
    _send(method, p, body, headers) {
        if (this.used >= this.cap) return Promise.reject(new Error('request cap reached (' + this.cap + ')'));
        const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        return new Promise((resolve, reject) => {
            const req = https.request({ host: API, path: p, method, timeout: 20000, lookup,
                headers: Object.assign({ 'X-Access-Key': this.cfg.accessKey, 'Content-Type': 'application/json' }, data ? { 'Content-Length': data.length } : {}, headers || {}) }, (res) => {
                this.state.requests = this.used + 1; this._save();         // (jsonbin answered: one of the key's requests)
                const parts = [];
                res.on('data', (d) => parts.push(d));
                res.on('end', () => {
                    const text = Buffer.concat(parts).toString('utf8');
                    let json = null; try { json = JSON.parse(text); } catch (e) { /* text */ }
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode, body: json });
                    else reject(new Error(res.statusCode + ' ' + ((json && json.message) || text).slice(0, 120)));
                });
            });
            req.on('timeout', () => { req.abort(); reject(new Error('timeout')); });
            req.on('error', (e) => reject(e));
            req.end(data || undefined);
        });
    }

    /** this car's bin: made once (named after the VIN) and entered in the directory bin */
    async _bin() {
        if (this.state.bin) return this.state.bin;
        let vin = this.state.vin;
        if (!vin) {
            try { vin = String(await Promise.race([Promise.resolve(this.vinFn && this.vinFn()), new Promise((r) => setTimeout(() => r(null), 5000))]) || ''); } catch (e) { vin = ''; }
            if (!/^[A-Z0-9]{5,20}$/i.test(vin)) vin = 'unknown-' + Math.random().toString(36).slice(2, 10);
            this.state.vin = vin; this._save();
        }
        const made = await this._req('POST', '/v3/b', { app: 'mgu-media', vin, created: new Date().toISOString() },
            { 'X-Bin-Name': 'mgu-media-' + vin, 'X-Bin-Private': 'true' });
        this.state.bin = made.body && made.body.metadata && made.body.metadata.id;
        if (!this.state.bin) throw new Error('no bin id in the answer');
        this._save();
        this._add('bin for ' + vin + ': ' + this.state.bin);
        // the directory: VIN -> bin (read, add, write: once per car)
        try {
            const dir = (await this._req('GET', '/v3/b/' + this.cfg.directoryBin + '/latest', undefined, { 'X-Bin-Meta': 'false' })).body || {};
            dir.app = 'mgu-media'; dir.cars = dir.cars && typeof dir.cars === 'object' ? dir.cars : {};
            dir.cars[vin] = { bin: this.state.bin, since: new Date().toISOString() };
            await this._req('PUT', '/v3/b/' + this.cfg.directoryBin, dir);
        } catch (e) { this._add('directory: ' + e.message); }
        return this.state.bin;
    }

    /**
     * Send what fn() gives (a plain object) to this car's bin. Automatic (now false): at most one a
     * minute, the newest fn wins meanwhile. now: at once (at most one in 5 s).
     */
    update(fn, why, now) {
        if (!this.enabled) return;
        this.pending = { fn, why };
        const gap = now ? (this.cfg.nowGapMs || NOW_GAP) : (this.cfg.minGapMs || MIN_GAP), wait = Math.max(0, this.lastT + gap - Date.now());
        if (this.timer && !now) return;                   // one is already waiting: it takes the newest fn
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; this._flush(); }, wait);
    }

    async _flush() {
        if (this.busy || !this.pending) return;
        const p = this.pending; this.pending = null;
        this.busy = true; this.lastT = Date.now();
        try {
            const bin = await this._bin();
            const doc = Object.assign({ app: 'mgu-media', vin: this.state.vin, sent: new Date().toISOString(), why: p.why, requestsUsed: this.used + 1 },
                this.state.catalog ? { catalog: this.state.catalog } : {}, p.fn());
            let body = JSON.stringify(doc);
            // a bin holds 100 kB: shorten the log, then cut
            if (body.length > MAX_BIN && Array.isArray(doc.log)) { doc.log = doc.log.slice(-40); body = JSON.stringify(doc); }
            if (body.length > MAX_BIN) body = JSON.stringify({ app: 'mgu-media', vin: this.state.vin, sent: doc.sent, why: p.why, truncated: true, text: body.slice(0, MAX_BIN - 500) });
            await this._req('PUT', '/v3/b/' + bin, body);
            this._add('sent (' + p.why + ', ' + Math.round(body.length / 1024) + ' kB), requests used ' + this.used + '/' + this.cap);
            if (this.state.catalogWanted && !this.uploading) { const w = this.state.catalogWanted; setTimeout(() => this.uploadFile(w.file, w.name), 1000); }
        } catch (e) {
            const again = NETWORK.test((e.code || '') + ' ' + e.message);
            this._add('not sent (' + p.why + '): ' + (e.code || e.message) + (again ? ' - again in a minute' : ''));
            if (again && !this.pending) this.pending = p;          // (a newer update replaces it)
        } finally {
            this.busy = false;
            if (this.pending && !this.timer) this.update(this.pending.fn, this.pending.why);
        }
    }

    /**
     * A file (the SOME/IP catalog) in parts: gzip, base64, CHUNK bytes a bin; their ids go into the
     * car's bin (catalog: { name, bytes, parts }). Again only when the file changed (size and mtime).
     */
    async uploadFile(file, name) {
        if (!this.enabled) return false;
        if (this.uploading) { this._add(name + ': upload already running'); return false; }
        let st, raw;
        try { st = fs.statSync(file); raw = fs.readFileSync(file); } catch (e) { this._add(name + ': ' + (e.code || e.message)); return false; }
        const stamp = st.size + ':' + st.mtime.getTime();
        if (this.state.catalog && this.state.catalog.stamp === stamp) { this._add(name + ': already online (' + this.state.catalog.parts.length + ' parts)'); return true; }
        this.state.catalogWanted = { file, name }; this._save();      // (sent with the next update that goes through)
        this.uploading = true;
        let up = null;
        try {
            await this._bin();                                        // (the VIN first: the parts are named after it)
            // minified (a JSON file: fewer bytes), gzip at its best: fewer parts, fewer requests
            let min = raw;
            try { min = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8')))); } catch (e) { /* not JSON: as it is */ }
            const b64 = zlib.gzipSync(min, { level: 9 }).toString('base64'), n = Math.ceil(b64.length / CHUNK);
            // parts sent before (a stop: too many requests, no network) are kept: it goes on from there
            up = this.state.upload && this.state.upload.stamp === stamp && this.state.upload.n === n ? this.state.upload : (this.state.upload = { stamp, n, parts: [] });
            const left = n - up.parts.length;
            if (this.used + left + 4 > this.cap) { this._add(name + ': would take ' + left + ' requests, too many left of the cap'); return false; }
            this._add(name + ': ' + Math.round(raw.length / 1024) + ' kB -> ' + n + ' parts' + (up.parts.length ? ', from part ' + (up.parts.length + 1) : ''));
            for (let i = up.parts.length; i < n; i++) {
                const r = await this._req('POST', '/v3/b', { app: 'mgu-media', file: name, part: i + 1, of: n, gzipBase64: b64.slice(i * CHUNK, (i + 1) * CHUNK) },
                    { 'X-Bin-Name': 'mgu-media-' + (this.state.vin || 'car') + '-' + name + '-' + (i + 1), 'X-Bin-Private': 'true' });
                up.parts.push(r.body.metadata.id);
                this._save();
                if ((i + 1) % 5 === 0 && i + 1 < n) this._add(name + ': part ' + (i + 1) + ' of ' + n);
            }
            this.state.catalog = { name, bytes: raw.length, stamp, parts: up.parts, uploaded: new Date().toISOString() };
            delete this.state.upload; delete this.state.catalogWanted;
            this._save();
            this._add(name + ': online in ' + n + ' parts');
            return true;
        } catch (e) {
            this._add(name + ': stopped' + (up ? ' at part ' + (up.parts.length + 1) + ' of ' + up.n : '') + ' (' + (e.code || e.message) + ') - goes on from there with the next update');
            return false;
        } finally { this.uploading = false; }
    }

    statusLines() {
        if (!this.enabled) return ['online log: off (no remotelog-config.js)'];
        const r = resolved[API];
        let ns = '';
        try { ns = (fs.readFileSync('/etc/resolv.conf', 'utf8').match(/^nameserver\s+\S+/gm) || []).map((l) => l.split(/\s+/)[1]).join(' '); } catch (e) { ns = 'no resolv.conf'; }
        return ['online log: car ' + (this.state.vin || '?') + ', bin ' + (this.state.bin || '(made at the first update)') + ', requests used ' + this.used + ' of ' + this.cap +
            (this.state.catalog ? ', catalog online (' + this.state.catalog.parts.length + ' parts)' : this.state.catalogWanted ? ', catalog waiting' : ''),
        'dns: ' + (ns || '-') + (r ? '; ' + API + ' = ' + r.address + ' via ' + r.how : '')].concat(this.lines.slice(-8));
    }
}

module.exports = { RemoteLog, lookup };

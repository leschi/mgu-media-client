'use strict';
/**
 * dns.js - name lookup with a fallback: on the car the app's own DNS lookup
 * failed (ENOTFOUND) while connections to IP addresses worked. Then the name is looked up over HTTPS at
 * a fixed IP (DNS over HTTPS: Cloudflare 1.1.1.1, Google 8.8.8.8; their certificates name those IPs).
 * The TLS check of the real connection stays the same: it is made to the name, only its address comes
 * from here. Pass it as the `lookup` option of http(s).request.
 */
const https = require('https');
const dns = require('dns');

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

module.exports = { lookup, resolved };

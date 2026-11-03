'use strict';
/**
 * remotelog-read.js - read what the cars sent to the online test log (apps/media/remotelog.js).
 *
 *   node tools/remotelog-read.js                  the directory: VIN -> bin (1 request)
 *   node tools/remotelog-read.js <VIN|bin>        that car's latest diagnostics (1 request, +1 once for the directory)
 *   node tools/remotelog-read.js <VIN|bin> --catalog [out.json]
 *                                                 also its SOME/IP catalog, put together from its parts
 *
 * Every read is a request of the key's fixed number: the directory is kept in tools/.remotelog-cache.json.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cfg = require('../apps/media/remotelog-config');

const CACHE = path.join(__dirname, '.remotelog-cache.json');
let used = 0;

function get(bin) {
    used++;
    return new Promise((resolve, reject) => {
        https.get({ host: 'api.jsonbin.io', path: '/v3/b/' + bin + '/latest', headers: { 'X-Access-Key': cfg.accessKey, 'X-Bin-Meta': 'false' } }, (res) => {
            const parts = [];
            res.on('data', (d) => parts.push(d));
            res.on('end', () => {
                const t = Buffer.concat(parts).toString('utf8');
                if (res.statusCode !== 200) return reject(new Error(res.statusCode + ' ' + t.slice(0, 200)));
                try { resolve(JSON.parse(t)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function directory(fresh) {
    if (!fresh) { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e) { /* read it */ } }
    const d = await get(cfg.directoryBin);
    fs.writeFileSync(CACHE, JSON.stringify(d, null, 1));
    return d;
}

async function main() {
    const args = process.argv.slice(2), who = args.find((a) => !a.startsWith('--') && !/\.json$/.test(a));
    if (!who) { console.log(JSON.stringify(await directory(true), null, 1)); return; }
    let bin = /^[0-9a-f]{24}$/.test(who) ? who : null;
    if (!bin) {
        let d = await directory(false);
        if (!(d.cars && d.cars[who])) d = await directory(true);
        bin = d.cars && d.cars[who] && d.cars[who].bin;
        if (!bin) throw new Error('no car ' + who + ' in the directory: ' + Object.keys(d.cars || {}).join(', '));
    }
    const doc = await get(bin);
    console.log(JSON.stringify(doc, null, 1));
    if (args.includes('--catalog')) {
        const c = doc.catalog;
        if (!c || !c.parts) throw new Error('no catalog in this car\'s bin (Diag -> Export -> Send)');
        let b64 = '';
        for (const id of c.parts) b64 += (await get(id)).gzipBase64;
        const out = args.find((a) => /\.json$/.test(a)) || 'someip-interfaces.json';
        const raw = zlib.gunzipSync(Buffer.from(b64, 'base64'));
        fs.writeFileSync(out, raw);
        console.error('catalog: ' + raw.length + ' bytes (' + c.parts.length + ' parts) -> ' + out);
    }
}

main().then(() => console.error('(' + used + ' request' + (used === 1 ? '' : 's') + ')'), (e) => { console.error('error: ' + e.message + ' (' + used + ' requests)'); process.exit(1); });

'use strict';
/**
 * backend.js - a process of its own (not part of the app's): runs the AirPlay receiver. The tool
 * mgu-media-airplay (tools/airplay) starts it under the app's uid; the app talks to it over a private
 * socket (./airplay). The receiver (tools/airplay/src/receiver.c) writes its frames as I420 into a
 * /dev/shm file (MGVF, as ./shmvideo) and its sound to BMW's SmartX sink, and tells what happens in lines.
 *
 *   commands (JSON lines): start { w, h, name }, viewport { w, h }, endVideo, stop, beat,
 *     sound { op: start | add | pause | play | stop, id, file } -> { sound: { id, playing | ms | error | ended } }
 *   answers: { state: { phase, mode, connected, code, file, frame, error } }
 */
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const BIN = process.env.MGU_AIRPLAY_BIN || '/var/opt/mgu-media-airplay/current/mgu-airplay';
const DATA = process.env.MGU_AIRPLAY_DATA || path.join(path.resolve(__dirname, '..', '..'), 'data', 'airplay');
const SOCK = path.join(DATA, 'control.sock');
const LEASE = '/run/mgu-uplink/lease.json';
const BEAT_MS = 12000, GRACE_MS = 30000;                 // the app gone this long: the receiver stops
const RESTART_MS = [1000, 2000, 4000, 8000, 15000];

try { fs.mkdirSync(DATA, 0o700); } catch (e) { if (e.code !== 'EEXIST') throw e; }

/** the car has internet (mgu-uplink's lease): YouTube's videos, which the car fetches itself */
function online() {
    try {
        const l = JSON.parse(fs.readFileSync(LEASE, 'utf8'));
        return !!l.interface && net.isIP(l.ip || '') === 4 && Array.isArray(l.dns) && l.dns.length > 0;
    } catch (e) { return false; }
}

/* ---------------- the state the app sees ---------------- */
const state = { phase: 'stopped', mode: '', connected: false, code: '', file: '', frame: null, error: '', log: [] };
let client = null, beat = 0, graceT = null;
function update(o) {
    Object.assign(state, o);
    if (client && !client.destroyed && client.bufferSize < 32768) client.write(JSON.stringify({ state }) + '\n');
}

/** what the receiver did last (the AirPlay page shows it while nothing plays) */
function note(l) { state.log = state.log.concat(new Date().toTimeString().slice(0, 8) + ' ' + String(l).replace(/[^\x20-\x7e]/g, '').slice(0, 110)).slice(-7); update({}); }

/* ---------------- frames ---------------- */
function frameOf(file) {
    let fd = null;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const st = fs.fstatSync(fd), b = Buffer.alloc(64);
        if (!st.isFile() || fs.readSync(fd, b, 0, 64, 0) !== 64 || b.readUInt32LE(0) !== 0x4656474d) return null;
        const w = b.readUInt32LE(8), h = b.readUInt32LE(12), n = b.readUInt32LE(24), seq = b.readUInt32LE(16);
        if (!seq || !(w >= 16 && h >= 16 && w <= 2048 && h <= 2048) || n < 1 || n > 4 || st.size < 64 + n * w * h * 3 / 2) return null;
        return { w, h, gen: st.dev + ':' + st.ino, seq };
    } catch (e) { return null; } finally { if (fd !== null) fs.closeSync(fd); }
}

/* ---------------- the receiver ---------------- */
let child = null, wanted = null, fails = 0, restartT = null, session = 0, oldFrame = '', view = null;
const tell = (l) => { if (child && child.stdin.writable) child.stdin.write(l + '\n'); };
/** the largest size of a video the car fetches itself (a mirrored screen keeps its own) */
function viewport(w, h) {
    const ok = (n) => Number.isInteger(n) && n >= 16 && n <= 2048 && !(n & 1);
    if (!ok(w) || !ok(h)) return;
    view = w + ' ' + h;
    tell('size ' + view);
}
/** this receiver's address: kept, so a phone knows it again */
function device() {
    const f = path.join(DATA, 'identity');
    try { const d = fs.readFileSync(f, 'utf8').trim(); if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(d)) return d; } catch (e) { /* first start */ }
    const m = crypto.randomBytes(6);
    m[0] = (m[0] & 0xfc) | 2;
    const d = Array.from(m).map((v) => ('0' + v.toString(16)).slice(-2)).join(':');
    fs.writeFileSync(f, d, { mode: 0o600 });
    return d;
}
// (the frames of the content before are not shown as the new one's)
function hideOld() { const f = state.file && frameOf(state.file); oldFrame = f ? f.gen + ':' + f.seq : ''; }

function line(l) {
    const m = /^(\w+) ?(.*)$/.exec(l);
    if (!m) return;
    if (m[1] === 'log') note(m[2]);
    else if (m[1] === 'connected') update({ connected: m[2] === '1' });
    else if (m[1] === 'mode') {
        hideOld();
        if (m[2] === 'none') update({ mode: '', phase: 'waiting', frame: null });
        else update({ mode: m[2], phase: m[2] === 'audio' ? 'playing' : 'loading', frame: null, error: '' });
    } else if (m[1] === 'loading') update({ phase: 'loading', error: '' });
    else if (m[1] === 'error') update({ error: m[2].slice(0, 120) });
}

function run(keepCode) {
    if (child || !wanted) return;
    clearTimeout(restartT); restartT = null;
    if (!fs.existsSync(BIN)) { update({ phase: 'error', error: 'the receiver is missing' }); return; }
    const code = keepCode && state.code ? state.code : String(100000 + crypto.randomBytes(4).readUInt32LE(0) % 900000);
    const file = '/dev/shm/mgu-video-airplay-' + process.getuid() + '-' + process.pid + '-' + (++session);
    const args = ['-n', wanted.name, '-m', device(), '-w', code, '-f', file, '-p', '7110', '-l', LEASE, '-t', DATA, '-k', path.join(DATA, 'key')].concat(online() ? ['-u'] : []);
    oldFrame = '';
    const c = child = cp.spawn(BIN, args, { cwd: DATA, detached: true, stdio: ['pipe', 'pipe', 'inherit'],
        env: Object.assign({}, process.env, { ALSA_PLUGIN_DIR: '/usr/lib/alsa-lib', DNSSD_UDS_PATH: '/run/mdnsd/mdnsd_uds' }) });
    c.stdin.on('error', () => {});
    if (view) tell('size ' + view);
    const t0 = Date.now();
    update({ phase: 'waiting', mode: '', connected: false, code, file, frame: null, error: '' });
    let buf = '';
    const eat = (d) => {
        if (child !== c) return;
        buf = (buf + d).slice(-8192);
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
    };
    c.stdout.on('data', eat);
    let key = '';
    const poll = setInterval(() => {
        const f = child === c && state.mode !== 'audio' ? frameOf(file) : null;
        if (!f || f.gen + ':' + f.seq === oldFrame) return;
        const k = [f.gen, f.w, f.h].join();
        if (k !== key || state.phase !== 'playing' || !state.frame) { key = k; update({ phase: 'playing', frame: { w: f.w, h: f.h, gen: f.gen } }); }
    }, 100);
    let over = false;
    const end = (why) => {
        if (over) return;
        over = true;
        clearInterval(poll);
        if (child === c) child = null;
        try { fs.unlinkSync(file); } catch (e) { /* gone with it */ }
        if (!wanted) return;
        note(why);
        if (Date.now() - t0 > 60000) fails = 0;
        update({ phase: 'restarting', mode: '', connected: false, frame: null, file: '', error: why });
        restartT = setTimeout(() => run(true), RESTART_MS[Math.min(fails++, RESTART_MS.length - 1)]);
    };
    c.on('error', (e) => end('the receiver did not start: ' + e.message));
    c.on('close', (rc, sig) => end('the receiver ended (' + (sig || rc) + ')'));
}
function signal(s) { if (child && child.pid) try { process.kill(-child.pid, s); } catch (e) { /* ended */ } }
/** -> a promise: the receiver is gone */
function stop() {
    wanted = null; fails = 0;
    clearTimeout(restartT); restartT = null;
    const c = child;
    const gone = () => update({ phase: 'stopped', mode: '', connected: false, code: '', file: '', frame: null, error: '' });
    if (!c) { gone(); return Promise.resolve(); }
    update({ phase: 'stopping', frame: null });
    return new Promise((resolve) => {
        const kill = setTimeout(() => signal('SIGKILL'), 3000);
        c.once('close', () => { clearTimeout(kill); if (!wanted) gone(); else run(false); resolve(); });
        signal('SIGTERM');
    });
}

/* ---------------- a film's sound (`mgu-airplay sound`) ---------------- */
let snd = null;
const PIECE = /^\/tmp\/mgu-media-snd-[\w-]+\.aac$/;
function soundTell(o) { if (client && !client.destroyed && client.bufferSize < 32768) client.write(JSON.stringify({ sound: o }) + '\n'); }
function soundStop() {
    const c = snd;
    snd = null;
    if (!c) return;
    c.stdin.end();
    setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { /* ended */ } }, 1000);
}
function soundStart(id) {
    soundStop();
    if (!fs.existsSync(BIN)) { soundTell({ id, error: 'the receiver is missing' }); return; }
    const c = snd = cp.spawn(BIN, ['sound'], { cwd: DATA, stdio: ['pipe', 'pipe', 'inherit'], env: Object.assign({}, process.env, { ALSA_PLUGIN_DIR: '/usr/lib/alsa-lib' }) });
    c.stdin.on('error', () => {});
    let buf = '';
    c.stdout.on('data', (d) => {
        if (snd !== c) return;
        buf = (buf + d).slice(-4096);
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const m = /^(playing|time|error) ?(.*)$/.exec(buf.slice(0, i).trim());
            buf = buf.slice(i + 1);
            if (m) soundTell(m[1] === 'time' ? { id, ms: +m[2] } : m[1] === 'error' ? { id, error: m[2].slice(0, 120) } : { id, playing: true });
        }
    });
    const over = (why) => { if (snd === c) { snd = null; soundTell({ id, ended: true, error: why }); } };
    c.on('error', (e) => over(e.message));
    c.on('close', (rc, sig) => over('the player ended (' + (sig || rc) + ')'));
}
function sound(r) {
    if (r.op === 'start') soundStart(+r.id || 0);
    else if (r.op === 'stop') soundStop();
    else if (snd && r.op === 'add' && PIECE.test(r.file)) snd.stdin.write('add ' + r.file + '\n');
    else if (snd && (r.op === 'pause' || r.op === 'play')) snd.stdin.write(r.op + '\n');
}

/* ---------------- the app's socket ---------------- */
function command(r) {
    if (r.command === 'start') {
        viewport(r.w, r.h);
        if (wanted) return;
        wanted = { name: String(r.name || '').replace(/[^\w .-]/g, '').slice(0, 40) || 'BMW MGU' };
        run(false);                        // (one still stopping: run again by its close)
    } else if (r.command === 'viewport') viewport(r.w, r.h);
    else if (r.command === 'endVideo') { if (state.mode === 'video') tell('end'); }
    else if (r.command === 'stop') stop();
    else if (r.command === 'sound') sound(r);
}
try { if (fs.lstatSync(SOCK).isSocket()) fs.unlinkSync(SOCK); } catch (e) { /* none */ }
const server = net.createServer((s) => {
    if (client && !client.destroyed) { s.destroy(); return; }       // (one app)
    clearTimeout(graceT);
    client = s;
    beat = Date.now();
    s.setEncoding('utf8');
    update({});
    let buf = '';
    s.on('data', (d) => {
        beat = Date.now();
        buf += d;
        if (buf.length > 8192) { s.destroy(); return; }
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            let r = null;
            try { r = JSON.parse(buf.slice(0, i)); } catch (e) { /* not ours */ }
            buf = buf.slice(i + 1);
            if (r) command(r);
        }
    });
    s.on('error', () => {});
    s.on('close', () => {
        if (client !== s) return;
        client = null;
        soundStop();
        clearTimeout(graceT);
        graceT = setTimeout(() => { if (!client) stop(); }, GRACE_MS);
    });
});
const id = (p) => { try { const s = fs.statSync(p); return s.dev + ':' + s.ino; } catch (e) { return ''; } };
const code0 = id(__filename);
let sock0 = '';
server.on('error', (e) => { console.error('AirPlay backend: ' + e.message); process.exit(1); });
server.listen(SOCK, () => { fs.chmodSync(SOCK, 0o600); sock0 = id(SOCK); });
let byeing = false;
function bye(rc) {
    if (byeing) return;
    byeing = true;
    soundStop();
    server.close();
    const out = () => { if (id(SOCK) === sock0) try { fs.unlinkSync(SOCK); } catch (e) { /* gone */ } process.exit(rc); };
    stop().then(out);
    setTimeout(out, 6000);
}
setInterval(() => {
    if (client && Date.now() - beat > BEAT_MS) client.destroy();
    // an app update moved this file or the socket away: the service starts the new one
    if (sock0 && (id(SOCK) !== sock0 || id(__filename) !== code0)) bye(75);
}, 2000);
['SIGTERM', 'SIGINT'].forEach((s) => process.on(s, () => bye(0)));
process.on('exit', () => signal('SIGTERM'));

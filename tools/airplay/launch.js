'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// After airplay/runtime/launch.js of https://github.com/pllanaio/bmw-airplay
// (Copyright (C) 2026 Leon Pllana IT-Solutions, GPL-3.0-or-later), changed for Media Client 2026-11.
/**
 * launch.js - root service: opens the receiver's ports for Media Client's uid (./network.js) and runs the
 * app's AirPlay backend (its backend.js) under that uid: `launch.js drop <uid>` gives up every root identity,
 * then loads it. The receiver itself is ./mgu-airplay (src/receiver.c). What this does is in
 * /run/mgu-media-airplay/status.json (the app's AirPlay page shows it). Node 8.
 */
const cp = require('child_process'), fs = require('fs');
const APP = 'media';
// the groups an app's native process needs: the SmartX sound, mDNS, the app platform's (tm_oap_app)
const GROUPS = [903, 904, 905, 917, 12202, 13003];
const UIDS = '/var/opt/public/oap/oap_12201/security/uids.txt';
const DIR = '/run/mgu-media-airplay', STATUS = DIR + '/status.json';
const RETRY_MS = 5000, NET_MS = 10000;

/** the uid the app manager gave an app ("<uid>=<id>" lines), null without one; throws on anything odd */
function uidOf(text, app) {
    const ids = String(text).split('\n').map((l) => /^([0-9]+)=([A-Za-z0-9_-]+)\s*$/.exec(l.trim())).filter((m) => m && m[2] === app).map((m) => +m[1]);
    if (ids.length > 1 || ids.some((n) => n < 12203 || n > 65535)) throw new Error('uids.txt names ' + app + ' oddly');
    return ids.length ? ids[0] : null;
}
function readUids() {
    const fd = fs.openSync(UIDS, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const s = fs.fstatSync(fd);
        if (!s.isFile() || (s.uid !== 0 && s.uid !== 12201) || (s.mode & 0o002) || s.size > 262144) throw new Error('uids.txt is not the app manager\'s');
        return fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
}
const home = (uid) => '/var/opt/public/oap/oap_' + uid;
const installed = (uid) => !!uid && fs.existsSync(home(uid) + '/source/javascript/backend.js');

let last = '';
function status(state, detail) {
    const key = state + '|' + (detail || '');
    if (key === last) return;
    last = key;
    console.log('AirPlay for Media Client: ' + state + (detail ? ' (' + detail + ')' : ''));
    try {
        try { fs.mkdirSync(DIR, 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        const st = fs.lstatSync(DIR);
        if (!st.isDirectory() || st.uid !== 0) return;
        fs.chmodSync(DIR, 0o755);
        fs.writeFileSync(STATUS + '.tmp', JSON.stringify({ state, detail: detail || '' }) + '\n');
        fs.chmodSync(STATUS + '.tmp', 0o644);
        fs.renameSync(STATUS + '.tmp', STATUS);
    } catch (e) { console.error('status: ' + e.message); }
}

/** the firewall rules ('' or why not) */
function network(args) {
    const r = cp.spawnSync('/usr/bin/node', [__dirname + '/network.js'].concat(args), { encoding: 'utf8', timeout: 20000, maxBuffer: 262144 });
    return r.status === 0 ? '' : String(r.stderr || r.error || 'failed').trim().split('\n').pop().slice(0, 160);
}

let child = null, stopping = false;
function start() {
    if (stopping) return;
    const again = () => { setTimeout(start, RETRY_MS); };
    let uid;
    try { uid = uidOf(readUids(), APP); } catch (e) { status('no_app_list', e.message); again(); return; }
    if (!installed(uid)) { status('waiting_for_app'); again(); return; }
    let net = network(['apply', String(uid)]);
    const data = home(uid) + '/data';
    child = cp.spawn('/usr/bin/node', [__filename, 'drop', String(uid)], { stdio: 'inherit', cwd: fs.existsSync(data) ? data : '/',
        env: Object.assign({}, process.env, { HOME: data, MGU_AIRPLAY_BIN: __dirname + '/mgu-airplay' }) });
    status('running', net && 'network: ' + net);
    // the uplink makes its firewall table anew when it changes; unchanged rules are not written again
    const watch = setInterval(() => {
        net = network(['apply', String(uid)]);
        status('running', net && 'network: ' + net);
    }, NET_MS);
    let over = false;
    const ended = (why) => {
        if (over) return;
        over = true;
        clearInterval(watch);
        child = null;
        status('ended', why);
        if (stopping) process.exit(0);
        again();
    };
    child.on('error', (e) => ended(e.message));
    child.on('exit', (code, signal) => ended(String(signal || code)));
}

/** this process becomes the app's: no root identity left, then its backend.js */
function drop(uid) {
    if (!(uid >= 12203 && uid <= 65535)) throw new Error('not an app uid');
    process.setgroups(GROUPS.concat([uid]));
    process.setgid(uid);
    process.setuid(uid);
    if ([process.getuid(), process.geteuid(), process.getgid(), process.getegid()].some((n) => n !== uid)) throw new Error('still root');
    try { process.setuid(0); } catch (e) { require(home(uid) + '/source/javascript/backend.js'); return; }
    throw new Error('root could come back');
}

if (require.main === module) {
    if (process.getuid() !== 0) throw new Error('runs as root');
    if (process.argv[2] === 'drop') drop(+process.argv[3]);
    else if (process.argv[2] === 'remove') network(['remove']);
    else {
        ['SIGTERM', 'SIGINT'].forEach((s) => process.on(s, () => { stopping = true; status('stopped'); if (child) child.kill(s); else process.exit(0); }));
        start();
    }
}
module.exports = { uidOf };

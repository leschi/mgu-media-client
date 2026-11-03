'use strict';
/**
 * Media Client - videos and music from a Jellyfin server on the BMW MGU (iDrive 7).
 *
 *   Server  the server's address, then Quick Connect (a code entered in a signed-in Jellyfin app: no
 *           password in the car) or user name and password, typed with the on-screen keyboard; the
 *           access token (not the password) is kept in the app's data folder
 *   Browse  the libraries (movies, shows, music), continue watching; the controller turns through the list,
 *           press opens / plays, tilt left goes back up
 *   Player  what plays: a video on the cluster (middle or whole) or the HUD - the picture ONLY while
 *           parked (./parkgate), the sound on through the car's speakers (BMW's media player) - or music
 *   Diag    what happened (the log), the video's and the sound's state
 *
 * The Jellyfin apps on a phone can play on the car too (cast icon -> "BMW MGU", ./remote): the phone
 * chooses and controls, the car gets the video from the server as when chosen here.
 *
 * The video path (decode in the app, cluster-render video layer, the sound as a local AAC file for
 * BMW's player, the park check) came from a prior project, where it ran on the car (0.2.40 - 0.2.44).
 */
const mgu = require('./kit/mgu');
const { withAlpha, rgba } = require('./kit/canvas');
const { setVideo } = require('./kit/record');
const G = require('./kit/gauges');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kbd = require('./keyboard');
const png = require('./png');
const { Jellyfin } = require('./jellyfin');
const { ClusterVideo } = require('./clustervideo');
const { ClusterRender } = require('./cluster_render_client');
const { MusicPlayer } = require('./musicplayer');
const { Remote } = require('./remote');
const { RemoteLog } = require('./remotelog');
const { lookup, resolved: dnsResolved } = require('./dns');

const W = 1600, H = 520;
// (Diag only with Settings -> Debug on)
const TABS_ALL = ['Server', 'Browse', 'Player', 'Diag'];
const PAGES_ALL = ['server', 'browse', 'player', 'diag'];
const ROWS = 8, ROW_H = 52, LIST_Y = 92;
const PIC = { x: W - 330, w: 290, h: 410 };       // the picture of the chosen item, right of the list
const TARGET_NAME = { map: 'Cluster middle', panel: 'Whole cluster', hud: 'Head-up display', cid: 'MGU display' };
const VID = 5;                                   // the MGU display's video (op 19, ./shmvideo)

mgu.run({
    async start(ctx) {
        const { ui, settings } = ctx;
        const debug = () => settings.get('debug') === true;
        const PAGES = () => (debug() ? PAGES_ALL : PAGES_ALL.slice(0, 3));
        const TABS = () => TABS_ALL.slice(0, PAGES().length);
        const dataDir = ctx.dataDir;

        /* ---------------- log ring (Diag) ---------------- */
        const ring = [];
        const log0 = ctx.log || { info() {}, warn() {}, error() {} };
        const put = (lvl, a) => { ring.push((new Date().toTimeString().slice(0, 8) + ' ' + lvl + ' ' + a.map((x) => (typeof x === 'string' ? x : x && x.message || String(x))).join(' ')).slice(0, 170)); if (ring.length > 40) ring.shift(); };
        const log = {
            info() { put('I', [].slice.call(arguments)); try { log0.info.apply(log0, arguments); } catch (e) { /* ignore */ } },
            warn() { put('W', [].slice.call(arguments)); try { log0.warn.apply(log0, arguments); } catch (e) { /* ignore */ } },
            error() { put('E', [].slice.call(arguments)); try { log0.error.apply(log0, arguments); } catch (e) { /* ignore */ } },
        };

        /* ---------------- what is kept (server, token, this client's id) ---------------- */
        const CONF = path.join(dataDir, 'media.json');
        let conf = {};
        try { conf = JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch (e) { /* first start */ }
        if (!conf.deviceId) conf.deviceId = 'mgu-media-' + crypto.randomBytes(8).toString('hex');
        const save = () => { try { fs.writeFileSync(CONF, JSON.stringify(conf), { mode: 0o600 }); } catch (e) { log.warn('save: ' + e.message); } };
        save();
        const jf = new Jellyfin({ deviceId: conf.deviceId, lookup, base: conf.base, token: conf.token, userId: conf.userId });

        // the video buffer on the flash (./buffer), emptied: what a killed run left
        const BUF_DIR = path.join(dataDir, 'buffer');
        require('./buffer').clearDir(BUF_DIR);

        // what an earlier run left in /tmp (RAM on the unit): sound and track files of a player that was killed
        try { fs.readdirSync('/tmp').filter((f) => /^mgu-media-/.test(f)).forEach((f) => { try { fs.unlinkSync('/tmp/' + f); } catch (e) { /* not ours */ } }); } catch (e) { /* no /tmp here */ }

        /* ---------------- why the last run ended, and how much memory this one uses ----------------
         * The app has restarted on the car after a while ("App wird geladen"). The kit writes the reason
         * to data/<id>.log (FATAL + stack on a crash, the RSS at exit). This reads the last such line so
         * it shows on Diag, and samples RSS: a steady climb points at a leak / out-of-memory restart. */
        let lastExit = '';
        try {
            const lf = path.join(dataDir, ((ctx.spec && ctx.spec.id) || 'media') + '.log');
            const lines = (fs.existsSync(lf) ? fs.readFileSync(lf, 'utf8') : '').trim().split('\n');
            for (let i = lines.length - 1; i >= 0 && !lastExit; i--) if (/ (FATAL|ERROR) /.test(lines[i])) lastExit = lines[i].replace(/\s+/g, ' ').slice(0, 150);
            if (lastExit) log.warn('last run ended with: ' + lastExit.replace(/^\S+ /, ''));
        } catch (e) { /* no log yet */ }
        const rssMB = () => Math.round(process.memoryUsage().rss / 1048576);
        let rss = rssMB(), peakRss = rss, rss0 = rss;
        setInterval(() => { rss = rssMB(); if (rss > peakRss) peakRss = rss; }, 10000);

        // the online diagnostics log (./remotelog): this car's data in a jsonbin.io bin, read on a PC
        // (so a crash that restarts the app leaves a trace off the car). OFF unless apps/media/remotelog-
        // config.js holds a key (git-ignored; see remotelog-config.sample.js). Few requests: on start
        // (carrying the reason the last run ended) and a memory line every 2 min; capped in the config.
        let REMOTE_CFG = {};
        try { REMOTE_CFG = require('./remotelog-config'); } catch (e) { /* no online log */ }
        const online = new RemoteLog({ log, dataDir, config: REMOTE_CFG, vin: carVin });
        function onlineDoc() {
            return { version: (ctx.spec && ctx.spec.version) || '?', lastExit: lastExit || null,
                memory: { rss: rssMB(), peak: peakRss, start: rss0 },
                page, signedIn: signedIn(), server: conf.base || null, park: gate.why(), cast: remote.line(),
                playing: playing ? { title: playing.title, sub: playing.sub, durationMs: playing.duration } : null,
                video: video ? video.lines() : [], music: music ? music.lines() : [], log: ring.slice(-120) };
        }
        if (online.enabled) { log.info('online log on (jsonbin)'); setTimeout(() => online.update(onlineDoc, 'start' + (lastExit ? ': last run ' + lastExit.replace(/^\S+ /, '') : ''), true), 20000); }
        setInterval(() => {
            log.info('memory: ' + rssMB() + ' MB (peak ' + peakRss + ', start ' + rss0 + ')' + (video ? ', video on ' + video.target : music ? ', music' : ''));
            if (online.enabled) online.update(onlineDoc, 'memory');
        }, 120000);

        let sig = null;
        try { sig = require('./kit/signals'); } catch (e) { /* not on a unit */ }
        // the park check (./parkgate): true only when parked; false when driving, not known, or not started
        const park = require('./parkgate');
        park.start(ctx.signals, log);
        const gate = { parked: park.isParked, why: park.why };

        /* ---------------- redraw only on change ---------------- */
        let rev = 1, drawn = -1, drawErr = '';
        const touch = () => { rev++; };
        setInterval(touch, 1000);              // time-based content (states, the player's time)

        const signedIn = () => !!(conf.token && conf.base && conf.userId);
        let page = signedIn() ? 'browse' : 'server';
        let status = signedIn() ? 'Server: ' + (conf.serverName || conf.base) + ', ' + (conf.userName || 'signed in') : 'Not signed in';

        /* ================= Server: sign in ================= */
        let srvMode = 'idle';                  // idle | quick | form
        let quick = null, quickTimer = null, busy = false;
        const fields = { url: kbd.makeField(conf.base || 'http://', { max: 200 }), user: kbd.makeField(conf.userName || '', { max: 80 }), pw: kbd.makeField('', { mask: true, max: 120 }) };
        const FIELDS = [['url', 'Server', 40, 700], ['user', 'User', 760, 380], ['pw', 'Password', 1160, 400]];
        let field = 'url';
        const keyboard = new kbd.Keyboard('abc');
        let keyRects = [];

        /**
         * The addresses to try for what was typed: as it is when it names http(s) and a port; a name
         * alone (jellyfin.example.com) https first, then Jellyfin's own http port 8096; http without a
         * port 8096 first, then 80 (which may send on to https: ./jellyfin info follows it)
         */
        function addresses() {
            const u = fields.url.value.trim().replace(/\/+$/, '');
            const scheme = /^(https?):\/\//i.exec(u), rest = u.replace(/^https?:\/\//i, '');
            const port = /^[^/]+:\d+/.test(rest);
            if (scheme && (port || scheme[1].toLowerCase() === 'https')) return [u];
            const host = rest.replace(/^([^/]+)/, '$1:8096');
            if (scheme) return ['http://' + host, 'http://' + rest];
            return port ? ['http://' + rest, 'https://' + rest] : ['https://' + rest, 'http://' + host, 'http://' + rest];
        }

        /** a Jellyfin server at the address? { name, version } */
        async function server() {
            if (fields.url.value.trim().replace(/^https?:\/\//i, '').length < 3) throw new Error('type the server address first');
            const tried = [];
            for (const a of addresses()) {
                jf.base = a;
                status = 'Looking for Jellyfin at ' + a + '...'; touch();
                try {
                    const i = await jf.info();
                    fields.url.value = jf.base; fields.url.caret = jf.base.length;
                    return i;
                } catch (e) { tried.push(a.replace(/^https?:\/\//, '') + ': ' + e.message); }
            }
            throw new Error(tried.join('; '));
        }

        function signedInAs(r, info) {
            conf.base = jf.base; conf.token = r.token; conf.userId = r.userId; conf.userName = r.userName || fields.user.value.trim(); conf.serverName = info.name; save();
            fields.pw.value = ''; fields.pw.caret = 0;
            status = 'Server: ' + info.name + ', ' + conf.userName;
            srvMode = 'idle';
            log.info('signed in to ' + info.name + ' (' + info.version + ') at ' + jf.base);
            remote.stop(); remote.start();
            openRoot();
            setPage('browse');
        }

        async function quickConnect() {
            stopQuick();
            if (busy) return;
            busy = true;
            try {
                const info = await server();
                quick = await jf.quickStart();
                srvMode = 'quick';
                status = info.name + ': enter the code in your Jellyfin app';
                const t0 = Date.now();
                quickTimer = setInterval(async () => {
                    if (Date.now() - t0 > 10 * 60000) { stopQuick(); status = 'The code expired: Quick Connect again'; srvMode = 'idle'; touch(); return; }
                    try {
                        if (!(await jf.quickCheck(quick.secret)) || !quickTimer) return;
                        stopQuick();
                        signedInAs(await jf.quickFinish(quick.secret), info);
                    } catch (e) { log.warn('quick connect: ' + e.message); }
                }, 3000);
            } catch (e) {
                status = 'Quick Connect: ' + e.message;
                if (/address/.test(e.message)) { srvMode = 'form'; field = 'url'; }
            }
            busy = false;
            buttons(); touch();
        }
        function stopQuick() { clearInterval(quickTimer); quickTimer = null; }

        async function signInPassword() {
            if (busy) return;
            busy = true;
            try {
                const info = await server();
                if (!fields.user.value.trim()) { field = 'user'; throw new Error('type your user name'); }
                status = 'Signing in as ' + fields.user.value.trim() + '...'; touch();
                signedInAs(await jf.signIn(fields.user.value.trim(), fields.pw.value), info);
            } catch (e) { status = 'Sign in: ' + e.message; }
            busy = false;
            touch();
        }

        function keyPress(id) {
            const r = keyboard.apply(id, fields[field]);
            if (r.action === 'enter') {
                if (field === 'url') {
                    field = 'user';
                    server().then((i) => { status = 'Found ' + i.name + ' (Jellyfin ' + i.version + '): Quick Connect, or user and password'; touch(); },
                        (e) => { status = 'Server: ' + e.message; field = 'url'; touch(); });
                } else if (field === 'user') field = 'pw';
                else signInPassword();
            }
            touch();
        }

        /* ================= pictures (posters, covers) ================= */
        // fetched once the selection rests (turning through a list fetches nothing), kept for the last 16
        const pics = new Map();                // img id -> { w, h, rgba } | 'loading' | 'none'
        let picWant = null, picTimer = null;
        function picture(img) {
            if (!img) return null;
            const p = pics.get(img);
            if (p !== undefined) return typeof p === 'object' ? p : null;
            if (picWant !== img) {
                picWant = img;
                clearTimeout(picTimer);
                picTimer = setTimeout(() => {
                    pics.set(img, 'loading');
                    jf.image(img, PIC.w, PIC.h).then((b) => png.decode(b)).then((d) => pics.set(img, d), (e) => { pics.set(img, 'none'); log.warn(e.message); })
                        .then(() => { while (pics.size > 16) pics.delete(pics.keys().next().value); if (picWant === img) picWant = null; touch(); });
                }, 300);
            }
            return null;
        }
        /**
         * The picture goes to the renderer as a mgu-render/1 pixmap (as a prior project's remote screen, on the
         * car): the canvas here records drawing ops for the GPU renderer and has no drawImage (0.2.2 drew
         * with it: the drawing stopped there and the screen stayed as it was). Uploaded when the picture,
         * the theme or the connection changes; without pixmaps (no GPU renderer) no picture.
         */
        const PIX_ID = 7;
        let pm = { g: null, gen: -1, img: null, bg: '' };
        function pixGpu() { const g = ctx.display && ctx.display.gpu; return g && g.ready && g.native && g.info && g.info.pixmap ? g : null; }
        function drawPic(cv, t, img, x, y) {
            const p = picture(img), g = pixGpu();
            if (!p || !g || typeof cv.pixmap !== 'function') return;
            if (g !== pm.g || g.resGen !== pm.gen) { g.pixmapDef(PIX_ID, PIC.w, PIC.h, 2, 1); pm = { g, gen: g.resGen, img: null, bg: '' }; }
            const bg = String(t.bg);
            if (pm.img !== img || pm.bg !== bg) {
                g.pixmapPixels(PIX_ID, [{ x: 0, y: 0, w: PIC.w, h: PIC.h, data: png.fit(p, rgba(t.bg), PIC.w, PIC.h) }]);
                pm.img = img; pm.bg = bg;
                if (ctx.display) ctx.display.lastWords = null;       // (the same op as before: sent again so the new pixels show)
            }
            cv.pixmap(PIX_ID, x, y, PIC.w, PIC.h);
        }

        /* ================= Browse ================= */
        let stack = [];                        // [{ title, path, items, sel, top }]
        let loading = '';
        async function open(title, p) {
            loading = title; touch();
            try {
                // (a list is opened by its item; the libraries by '#root')
                const items = p === '#root' ? [{ id: '#resume', title: 'Continue watching', sub: '', type: 'resume', leaf: false }].concat(await jf.views())
                    : p.id === '#resume' ? await jf.resume() : await jf.children(p);
                stack.push({ title, path: p, items, sel: 0, top: 0 });
            } catch (e) { status = title + ': ' + e.message; log.warn(status); }
            loading = ''; touch();
        }
        function openRoot() { stack = []; open('Libraries', '#root'); }
        const cur = () => stack[stack.length - 1];
        function moveSel(d) {
            const c = cur();
            if (!c || !c.items.length) return;
            c.sel = Math.max(0, Math.min(c.items.length - 1, c.sel + d));
            if (c.sel < c.top) c.top = c.sel;
            if (c.sel >= c.top + ROWS) c.top = c.sel - ROWS + 1;
            touch();
        }
        function back() { if (stack.length > 1) { stack.pop(); touch(); } }
        function choose() {
            const c = cur();
            const it = c && c.items[c.sel];
            if (!it) return;
            if (!it.leaf) return open(it.title, it);
            if (it.audio) return playMusic(c.items, c.sel);
            return playVideo(it, undefined, null);
        }

        /* ================= Player ================= */
        let video = null, music = null, playing = null;     // playing: the item
        let pb = null, progressT = null;                    // pb: the play session { id, mediaSourceId, playSessionId }
        let vq = null;                                      // videos a phone sent together (a season): { items, i }
        let mrep = null, musicT = null;                     // the track the server was told of: { id, ps, ms }
        const where = () => (video ? video.at() : 0);
        // one connection to cluster-render for every video, kept (as waze-on-cluster): a target change drops
        // the old layer and makes the new one on the same socket, in that order. A new connection per
        // video raced the old one's close (HUD and whole cluster share a scene): it worked half the time
        let crClient = null;
        function clusterClient() {
            if (!crClient) { crClient = new ClusterRender('mgu_media', process.env.CLUSTER_RENDER_SOCKET); crClient.on('error', () => {}); crClient.connect(); }
            return crClient;
        }

        async function stopAll() {
            clearInterval(progressT); progressT = null;
            clearInterval(musicT); musicT = null;
            const v = video, m = music, p = pb;
            if (m) musicReport(m, true);
            video = null; music = null; pb = null;
            const done = [];
            if (v) {
                if (p) { jf.report('stop', Object.assign({ timeMs: v.at() * 1000 }, p)); jf.stopTranscode(p.playSessionId); }
                done.push(v.stop());
            }
            if (m) done.push(m.stop());
            await Promise.all(done);
            touch();
        }

        async function playVideo(it, at, queue) {
            await stopAll();
            playing = it;
            vq = queue || null;
            // the resume point: the server's current one (set here or on another device), else what the list had
            let off = it.offset;
            if (at == null) { try { const rp = await jf.resumePos(it.id); if (rp != null) off = rp; } catch (e) { /* keep it.offset */ } }
            const resume = settings.get('resume') !== false && off > 30000 && (!it.duration || off < it.duration - 60000);
            const from = at != null ? at : resume ? off / 1000 : 0;
            const sharp = settings.get('quality') === 'sharp';
            status = 'Asking the server for ' + it.title + '...'; setPage('player');
            let info;
            try { info = await jf.playbackInfo(it.id); } catch (e) { status = it.title + ': ' + e.message; log.warn(status); touch(); return; }
            if (playing !== it || video || music) return;          // (something else was chosen meanwhile)
            const p = { id: it.id, mediaSourceId: info.mediaSourceId, playSessionId: info.playSessionId || crypto.randomBytes(8).toString('hex') };
            pb = p;
            // Sharp on the cluster / HUD: 15 fps, so 640x360 fits cluster-render's upload limit (5.5 MB/s);
            // the MGU display has none. Bitrates for Baseline (no B-frames, no CABAC: it needs more)
            const target = settings.get('target') || 'map';
            const fps = sharp && target !== 'cid' ? 15 : 30;
            // Seek / resume: NO StartTimeTicks. Jellyfin's HLS playlist lists the WHOLE runtime (absolute
            // segment indices); StartTimeTicks moves the transcoder but the client still has to ask for the
            // segment at that time - asking for segment 0 against a transcoder parked at 37 min is a http 400.
            // So we take the full playlist and skip to the segment holding `from` (startAt): the transcoder
            // starts producing at that segment, which is how every Jellyfin client seeks.
            const url = jf.videoUrl(it.id, Object.assign({ width: sharp ? 640 : 480, height: sharp ? 360 : 270, bitrate: sharp ? 3000000 : 2000000, fps }, p));
            const bufS = +(settings.get('buffer') || 600);
            video = new ClusterVideo({ url, client: target === 'cid' ? undefined : clusterClient(), headers: jf.streamHeaders(), startAt: from, bufferDir: bufS > 15 ? BUF_DIR : null, bufferS: bufS, target, gate, sig, lookup, log, app: 'mgu_media', quality: sharp ? 'sharp' : 'smooth', anyProfile: true });
            log.info('video ' + it.title + ' from ' + Math.round(from) + ' s on ' + (settings.get('target') || 'map'));
            video.start();
            jf.report('start', Object.assign({ timeMs: from * 1000 }, p));
            progressT = setInterval(() => {
                if (!video || pb !== p) return;
                // (a phone sent several: the next one once this is over)
                if (video.state === 'done' && vq && vq.i + 1 < vq.items.length) { vq.i++; playVideo(vq.items[vq.i], 0, vq); return; }
                jf.report('progress', Object.assign({ timeMs: video.at() * 1000, paused: video.paused }, p));
            }, 5000);
            touch();
        }

        async function playMusic(items, i) {
            await stopAll();
            const tracks = items.filter((x) => x.audio);
            const start = tracks.indexOf(items[i]);
            playing = items[i];
            if (!sig || !sig.hasNative()) { status = 'No sound here (BMW\'s player is on the unit only)'; setPage('player'); return; }
            const m = new MusicPlayer({ server: jf, sig, lookup, log });
            music = m;
            m.play(tracks, Math.max(0, start)).catch((e) => log.warn('music: ' + e.message));
            musicT = setInterval(() => musicReport(m), 5000);
            setPage('player');
        }

        /** the server told which track plays and where (its "now playing", which a phone's remote shows) */
        function musicReport(m, final) {
            const t = m.current(), ms = m.elapsed();
            if (mrep && (final || !t || t.id !== mrep.id)) { jf.report('stop', { id: mrep.id, playSessionId: mrep.ps, timeMs: mrep.ms, method: 'DirectPlay' }); mrep = null; }
            if (final || !t || (m.state !== 'playing' && !m.paused)) return;
            if (!mrep) { mrep = { id: t.id, ps: crypto.randomBytes(8).toString('hex'), ms }; jf.report('start', { id: t.id, playSessionId: mrep.ps, timeMs: ms, method: 'DirectPlay' }); }
            else { mrep.ms = ms; jf.report('progress', { id: t.id, playSessionId: mrep.ps, timeMs: ms, paused: m.paused, method: 'DirectPlay' }); }
        }

        const isPaused = () => !!((video && video.paused) || (music && music.paused));
        function togglePause() {
            const m = video || music;
            if (!m) return;
            if (m.paused) m.resume(); else m.pause();
            if (video && pb) jf.report('progress', Object.assign({ timeMs: video.at() * 1000, paused: video.paused }, pb));
            if (music) musicReport(music);
            buttons(); touch();
        }

        /* ================= a phone as the remote (the Jellyfin app's cast icon -> BMW MGU) ================= */
        const remote = new Remote({ jf, log });
        let notice = null;                                  // a message a phone sent: { text, until }
        /** to sec into what plays: a video starts again there (the server transcodes from that segment) */
        function seekTo(sec) {
            sec = Math.max(0, sec);
            if (video && playing) { log.info('seek to ' + Math.round(sec) + ' s (restart the transcode there)'); playVideo(playing, sec, vq); }
            else if (music) { music.seek(sec * 1000); musicReport(music); }
        }
        const position = () => (video ? video.at() : music ? music.elapsed() / 1000 : 0);
        // scrubbing (knob or a tap on the bar): the target is shown at once, the seek follows after a short
        // pause, so turning several notches restarts the transcode once, not every notch
        let scrubTo = null, scrubTimer = null;
        function scrubAbs(sec) {
            if (!video || !playing) return;
            const dur = playing.duration / 1000;
            scrubTo = Math.max(0, dur > 0 ? Math.min(dur - 3, sec) : sec);
            overlayUntil = Date.now() + 5000;                 // (full screen: show the overlay while scrubbing)
            clearTimeout(scrubTimer);
            scrubTimer = setTimeout(() => { const to = scrubTo; scrubTo = null; seekTo(to); }, 700);
            touch();
        }
        const scrub = (delta) => scrubAbs((scrubTo != null ? scrubTo : position()) + delta);
        const shownPos = () => (scrubTo != null ? scrubTo : where());
        /** a tap on the progress bar (bx..bx+bw wide, a band around by): seek to that point */
        function seekBarHit(x, y, bx, by, bw) {
            if (!video || !playing || !(playing.duration > 0)) return false;
            if (x < bx || x > bx + bw || y < by - 18 || y > by + 22) return false;
            scrubAbs(Math.max(0, Math.min(1, (x - bx) / bw)) * (playing.duration / 1000));
            return true;
        }
        async function castPlay(r) {
            let items = await jf.items(r.ids);
            // an album, a season, a playlist: what is in it
            if (items.length === 1 && !items[0].leaf) items = (await jf.children(items[0])).filter((x) => x.leaf);
            if (!items.length) throw new Error('nothing to play in what was sent');
            log.info('from a phone: ' + r.command + ' ' + items[0].title + (items.length > 1 ? ' and ' + (items.length - 1) + ' more' : '') + (r.startMs ? ' at ' + Math.round(r.startMs / 1000) + ' s' : ''));
            const later = r.command === 'PlayNext' || r.command === 'PlayLast';
            if (later && music && items[0].audio) { music.add(items, r.command === 'PlayNext'); touch(); return undefined; }
            if (later && video && !items[0].audio) {
                if (!vq) vq = { items: [playing], i: 0 };
                vq.items.splice(r.command === 'PlayNext' ? vq.i + 1 : vq.items.length, 0, ...items.filter((x) => !x.audio));
                return undefined;
            }
            const i = Math.max(0, Math.min(r.startIndex || 0, items.length - 1));
            if (items[i].audio) return playMusic(items, i);
            const vids = items.filter((x) => !x.audio);
            // (no start given: as when chosen here - where it was left, with Settings -> Resume on)
            return playVideo(items[i], r.startMs != null ? r.startMs / 1000 : undefined, vids.length > 1 ? { items: vids, i: vids.indexOf(items[i]) } : null);
        }
        remote.on('play', (r) => castPlay(r).catch((e) => { status = 'From the phone: ' + e.message; log.warn(status); touch(); }));
        remote.on('playstate', (r) => {
            const m = video || music;
            if (r.command === 'Pause') { if (m && !m.paused) togglePause(); }
            else if (r.command === 'Unpause') { if (m && m.paused) togglePause(); }
            else if (r.command === 'PlayPause') togglePause();
            else if (r.command === 'Stop') { stopAll(); playing = null; vq = null; status = 'Stopped from the phone'; }
            else if (r.command === 'Seek') { if (r.seekMs != null) seekTo(r.seekMs / 1000); }
            else if (r.command === 'Rewind') seekTo(position() - 10);
            else if (r.command === 'FastForward') seekTo(position() + 30);
            else if (r.command === 'NextTrack' || r.command === 'PreviousTrack') {
                const d = r.command === 'NextTrack' ? 1 : -1;
                if (music) { if (d > 0) music.next(); else music.prev(); }
                else if (vq && vq.items[vq.i + d]) { vq.i += d; playVideo(vq.items[vq.i], 0, vq); }
            }
            buttons(); touch();
        });
        remote.on('message', (r) => {
            const text = [r.header, r.text].filter(Boolean).join(': ');
            log.info('message from a phone: ' + text);
            notice = { text, until: Date.now() + 8000 };
            touch(); setTimeout(touch, 8100);
        });
        if (signedIn()) remote.start();

        /** another target while a video plays: it starts again there, where it was */
        settings.onChange((k) => {
            if (k === 'signOut' && settings.get('signOut')) {
                try { settings.set('signOut', false); } catch (e) { /* stays */ }
                stopAll(); remote.stop(); conf.token = ''; conf.userId = ''; save();          // (the address stays: signing in again is shorter)
                jf.token = ''; jf.userId = ''; stack = []; status = 'Signed out'; setPage('server');
            }
            if (k === 'debug' && !debug() && page === 'diag') setPage('player');
            if ((k === 'target' || k === 'quality' || k === 'buffer') && video && playing && !playing.audio) {
                playVideo(playing, where(), vq);
            }
            touch();
        });

        /* ================= pages, buttons, input ================= */
        const BTN = {
            server: () => [['BTN1', srvMode === 'quick' ? 'New code' : 'Quick Connect'], ['BTN2', srvMode === 'form' ? 'Sign in' : 'Enter by hand']],
            browse: () => [['BTN1', 'Open / Play'], ['BTN2', 'Back']],
            player: () => [['BTN1', isPaused() ? 'Play' : 'Pause'], ['BTN2', 'Stop']],
            diag: () => [['BTN1', 'Clear log'], ['BTN2', 'Back to browse']],
        };
        function buttons() { BTN[page]().forEach(([n, l]) => { try { ui.text(n, l); } catch (e) { /* ignore */ } }); }
        function setPage(p) { page = p; buttons(); touch(); }
        setPage(page);
        if (page === 'browse') openRoot();

        ui.onClick('BTN1', () => {
            if (page === 'server') quickConnect();
            else if (page === 'browse') choose();
            else if (page === 'player') togglePause();
            else if (page === 'diag') ring.length = 0;
            buttons(); touch();
        });
        ui.onClick('BTN2', () => {
            if (page === 'server') { if (srvMode === 'form') signInPassword(); else { stopQuick(); srvMode = 'form'; field = conf.base ? 'user' : 'url'; status = 'Server address (http://IP:8096), then Quick Connect - or user and password'; } }
            else if (page === 'browse') back();
            else if (page === 'player') { stopAll(); playing = null; vq = null; status = ''; }
            else if (page === 'diag') setPage('browse');
            buttons(); touch();
        });
        ui.onClick('BTN_PAGE', () => setPage(PAGES()[(PAGES().indexOf(page) + 1) % PAGES().length]));
        ctx.onTab((i) => { if (PAGES()[i]) setPage(PAGES()[i]); });

        ctx.onTap((x, y) => {
            if (page === 'browse') {
                const c = cur();
                if (!c) return;
                const i = c.top + Math.floor((y - LIST_Y) / ROW_H);
                if (y >= LIST_Y && i >= 0 && i < c.items.length && i < c.top + ROWS) { if (c.sel === i) choose(); else { c.sel = i; touch(); } }
            } else if (fullScreen()) {
                // full screen: a tap shows title, time and tabs; while they show, the bar seeks and elsewhere pauses
                if (overlay()) { if (!seekBarHit(x, y, 40, H - 60, W - 80)) togglePause(); }
                overlayUntil = Date.now() + 5000; touch();
                setTimeout(touch, 5100);
            } else if (page === 'player' && video) {
                seekBarHit(x, y, 40, 186, Math.min(PIC.x - 80, 700));
            } else if (page === 'server' && srvMode === 'form') {
                const f = FIELDS.find((d) => x >= d[2] && x < d[2] + d[3]);
                if (y >= 96 && y < 140 && f) field = f[0];
                const k = keyRects.find((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
                if (k) keyPress(k.id);
                touch();
            }
        });

        wireController(ctx, {
            move(dir, how, n) {
                const step = how === 'turn' ? (dir === 'right' ? 1 : -1) * (n || 1) : 0;
                if (page === 'browse') {
                    if (how === 'turn') moveSel(step);
                    else if (dir === 'up' || dir === 'down') moveSel(dir === 'up' ? -1 : 1);
                    else if (dir === 'left') back(); else if (dir === 'right') choose();
                } else if (page === 'server' && srvMode === 'form') {
                    if (how === 'turn') keyboard.move(step > 0 ? 'right' : 'left'); else keyboard.move(dir);
                    touch();
                } else if (page === 'player' && video) {
                    // turn: scrub +/- 10 s a notch; tilt left / right: -30 / +30 s
                    if (how === 'turn') scrub(step * 10);
                    else if (dir === 'left') scrub(-30);
                    else if (dir === 'right') scrub(30);
                } else if (page === 'player' && music) {
                    if (how === 'turn' || dir === 'left' || dir === 'right') { if (step > 0 || dir === 'right') music.next(); else music.prev(); touch(); }
                }
            },
            press() {
                if (page === 'browse') choose();
                else if (page === 'server' && srvMode === 'form') keyPress(keyboard.current());
                else if (page === 'player') togglePause();
            },
        }, () => page === 'browse' || (page === 'server' && srvMode === 'form') || (page === 'player' && !!(music || video)));

        /* ================= drawing ================= */
        const lit = { literal: true };
        function header(cv, t, title) { cv.text(title, 40, 74, 26, t.text, { font: 'bold', literal: true }); }
        function lines(cv, t, L, y, size, max, chars) { L.slice(0, max || 20).forEach((l, i) => cv.text(String(l).slice(0, chars || 150), 40, y + i * (size + 8), size, i === 0 ? t.text : t.dim, lit)); }

        function drawServer(cv, t) {
            header(cv, t, 'Jellyfin server');
            // (with the keyboard the fields take that line: the status goes up to the right)
            if (srvMode === 'form') cv.text(status, W - 40, 74, 20, t.accent, { align: 'right', literal: true });
            else cv.text(status, 40, 116, 22, t.accent, lit);
            if (srvMode === 'quick' && quick) {
                cv.text('1. On your phone open the Jellyfin app (or the web page), signed in', 40, 170, 24, t.text, lit);
                cv.text('2. Your profile -> Quick Connect, enter this code:', 40, 214, 24, t.text, lit);
                cv.text(quick.code, 40, 330, 104, t.text, { font: 'bold', spacing: 14, literal: true });
                cv.text('The car signs in by itself once the code is entered (no password here).', 40, 400, 20, t.dim, lit);
            } else if (srvMode === 'form') {
                FIELDS.forEach(([k, label, x, w]) => {
                    cv.fillRect(x, 96, w - 20, 44, withAlpha(field === k ? (t.sel || t.accent) : '#ffffff', field === k ? 0.25 : 0.06));
                    cv.text(label + ': ' + kbd.display(fields[k]).slice(-(k === 'url' ? 44 : 22)) + (field === k ? '_' : ''), x + 10, 126, 22, t.text, lit);
                });
                drawKeyboard(cv, t, 160);
            } else {
                lines(cv, t, ['Enter by hand: the server\'s address (http://192.168.x.x:8096 or your https address).',
                    'Then Quick Connect: a code you enter in your Jellyfin app (profile -> Quick Connect) - no password here.',
                    'Or type user name and password: only the server\'s access token is kept, not the password.',
                    'Then: Browse your libraries. A video plays on the cluster or the HUD (Settings -> Video on),',
                    'the picture only while parked (under 1 km/h, selector in P); the sound also while driving.'], 170, 22);
            }
        }

        function drawKeyboard(cv, t, y0) {
            keyRects = [];
            const rows = keyboard.rows(), kh = 76, gap = 6;
            const label = { '#shift': keyboard.layer === 'ABC' ? 'abc' : 'ABC', '#layer': keyboard.layer === '123' ? 'abc' : '123', '#back': 'Del', '#space': 'Space', '#enter': field === 'pw' ? 'Sign in' : 'Next' };
            rows.forEach((row, r) => {
                const wide = (id) => (id === '#space' ? 4 : id[0] === '#' ? 1.6 : 1);
                const units = row.reduce((a, id) => a + wide(id), 0), kw = Math.min(118, (W - 80) / units);
                let x = (W - units * kw) / 2;
                row.forEach((id, c) => {
                    const w = wide(id) * kw - gap, y = y0 + r * (kh + gap), on = keyboard.row === r && keyboard.col === c;
                    cv.fillRect(x, y, w, kh, on ? withAlpha(t.sel || t.accent, 0.6) : withAlpha('#ffffff', 0.1));
                    cv.text(label[id] || id, x + w / 2, y + kh / 2 + 9, 26, t.text, { align: 'center', literal: true });
                    keyRects.push({ x, y, w, h: kh, id });
                    x += wide(id) * kw;
                });
            });
        }

        function drawBrowse(cv, t) {
            const c = cur();
            header(cv, t, stack.map((s) => s.title).join('  >  ') || 'Libraries');
            if (loading) cv.text('Loading ' + loading + '...', W - 40, 74, 20, t.dim, { align: 'right', literal: true });
            if (!c) { cv.text(signedIn() ? status : 'Sign in first (Server)', 40, 130, 22, t.dim, lit); return; }
            if (!c.items.length) { cv.text('(empty)', 40, 130, 22, t.dim, lit); return; }
            for (let k = 0; k < ROWS; k++) {
                const i = c.top + k, it = c.items[i];
                if (!it) break;
                const y = LIST_Y + k * ROW_H;
                if (i === c.sel) cv.fillRect(30, y, PIC.x - 50, ROW_H - 4, withAlpha(t.sel || t.accent, 0.25));
                cv.text((it.leaf ? '' : '+ ') + it.title, 50, y + 34, 24, t.text, lit);
                const right = [it.sub, it.leaf && it.duration ? Math.round(it.duration / 60000) + ' min' : '', it.offset > 30000 ? 'resume ' + Math.round(it.offset / 60000) + ' min' : ''].filter(Boolean).join('   ');
                if (right) cv.text(right, PIC.x - 40, y + 34, 20, t.dim, { align: 'right', literal: true });
            }
            const it = c.items[c.sel];
            if (it) drawPic(cv, t, it.img, PIC.x, LIST_Y);
            if (c.items.length > ROWS) cv.text((c.sel + 1) + ' / ' + c.items.length, PIC.x - 40, 512, 16, t.dim, { align: 'right', literal: true });   // (left of the picture)
        }

        /**
         * The MGU display's video, full screen (op 19: the renderer reads the frames from the /dev/shm file
         * itself). On the car the app's page in the native dialect (mgu-render/1, embedded in the HMI's page)
         * drew it black, as a prior project's pixmap; IterioDev's dialect (the app on its own layer over the screen,
         * as IterioDev's YouTube player) draws op 19. So while a video plays there the display reconnects in
         * that dialect, and back afterwards. A tap shows the title, the time and the tabs for 5 s; a tap then,
         * or a press of the controller, pauses / plays.
         */
        const SCR = { x: 0, y: 0, w: W, h: H };
        let vidDecl = '', dialect = '', overlayUntil = 0;
        function useDialect(want) {
            const d = ctx.display;
            if (dialect === want || !d) return;
            dialect = want;
            log.info('display: ' + (want ? want + ' dialect (the MGU display\'s video)' : 'native dialect again'));
            if (want) process.env.MGU_RENDERD_PROTO = want; else delete process.env.MGU_RENDERD_PROTO;
            if (d.gpu) { try { d.gpu.show(false); d.gpu.close(); } catch (e) { /* closing */ } d.gpu = null; d.place = null; }
            d.blocked = false;
            try { d._lost(); } catch (e) { /* ignore */ }
            try { d._mode(); } catch (e) { log.error('display restart: ' + e.message); }
            pm = { g: null, gen: -1, img: null, bg: '' };
            setPage(page);
        }
        function videoGpu() { const g = ctx.display && ctx.display.gpu; return g && g.ready && (g.native ? g.info && g.info.video : g.opts && g.opts.iterio) ? g : null; }
        const fullScreen = () => page === 'player' && !!(video && video.screen());
        const overlay = () => Date.now() < overlayUntil;
        function drawScreen(cv, t, scr) {
            cv.fillRect(0, 0, W, H, '#000000');
            if (!videoGpu() || typeof cv.video !== 'function') { cv.text('Connecting the video to the screen...', W / 2, H / 2, 22, '#ffffff', { align: 'center', literal: true }); return; }
            const key = scr.file + scr.w + 'x' + scr.h;
            if (vidDecl !== key) { setVideo(VID, scr.file, scr.w, scr.h); vidDecl = key; }
            // fitted into the whole page, proportions kept
            const s = Math.min(W / scr.w, H / scr.h), w = Math.round(scr.w * s), h = Math.round(scr.h * s);
            cv.video(VID, Math.round((W - w) / 2), Math.round((H - h) / 2), w, h, 0);
            if (!overlay()) return;
            cv.fillRect(0, H - 120, W, 120, withAlpha('#000000', 0.7));
            cv.text(playing.title + (playing.sub ? '  -  ' + playing.sub : ''), 40, H - 82, 24, '#ffffff', { font: 'bold', literal: true });
            const pos = shownPos(), dur = playing.duration / 1000;
            cv.fillRect(40, H - 60, W - 80, 6, withAlpha('#ffffff', 0.25));
            if (dur > 0) cv.fillRect(40, H - 60, Math.round((W - 80) * Math.min(1, pos / dur)), 6, t.accent);
            cv.text(fmt(pos) + (dur > 0 ? '  /  ' + fmt(dur) : '') + (scrubTo != null ? '   ->   seeking' : video.paused ? '   -   Paused' : '') + (video.buf ? '   -   buffer ' + fmtAhead(video.buf.ahead()) : ''), 40, H - 22, 20, '#ffffff', lit);
            cv.text('Tap bar: seek   -   tap: ' + (video.paused ? 'play' : 'pause'), W - 40, H - 22, 20, '#ffffff', { align: 'right', literal: true });
        }

        const STATE_TEXT = (st) => (/^playing/.test(st) ? 'Playing' : /^(starting|loading|buffering)/.test(st) ? 'Loading...' : st === 'done' ? 'Finished'
            : /^error/.test(st) ? st.replace(/^error: /, 'Error: ') : st === 'stopped' ? 'Stopped' : st);

        function drawPlayer(cv, t) {
            if (!playing) { header(cv, t, 'Nothing plays'); cv.text(status || 'Choose a video or music in Browse.', 40, 130, 22, t.dim, lit);
                cv.text('Or from your phone: the Jellyfin app, signed in as ' + (conf.userName || 'you') + ' -> the cast icon -> BMW MGU.', 40, 170, 20, t.dim, lit); return; }
            const scr = video && video.screen();
            if (scr) { drawScreen(cv, t, scr); return; }
            header(cv, t, playing.title + (playing.sub ? '  -  ' + playing.sub : ''));
            drawPic(cv, t, playing.img, PIC.x, 96);
            const x = 40, wTxt = PIC.x - 80, chars = Math.floor(wTxt / 10);
            const say = (str, y, size, col) => cv.text(String(str).slice(0, chars), x, y, size, col, lit);
            if (video) {
                const parked = gate.parked();
                const loadingNow = parked && !video.paused && /^(starting|loading|buffering)/.test(video.state);
                const st = video.paused ? 'Paused' : !parked ? 'Picture only while parked (P) - the sound goes on'
                    : loadingNow ? 'Loading - ' + video.loadReason() : STATE_TEXT(video.state);
                say(st, 120, 24, !parked || /^Error/.test(st) ? (t.warn || t.accent) : t.text);
                say('Video on: ' + TARGET_NAME[video.target], 156, 20, t.dim);
                // where it is
                const pos = shownPos(), dur = playing.duration / 1000, bw = Math.min(wTxt, 700);
                cv.fillRect(x, 186, bw, 8, withAlpha('#ffffff', 0.15));
                if (dur > 0) cv.fillRect(x, 186, Math.round(bw * Math.min(1, pos / dur)), 8, t.accent);
                say(fmt(pos) + (dur > 0 ? '  /  ' + fmt(dur) : '') + (scrubTo != null ? '   ->   seeking' : ''), 226, 22, t.text);
                if (video.buf) say('Buffer: ' + fmtAhead(video.buf.ahead()) + ' ahead', 260, 18, t.dim);
                const hint = video.hint();
                if (hint && !debug()) {                    // (what the user must do: in two lines)
                    say(hint.slice(0, hint.indexOf(' - ') + 1), 420, 18, t.warn || t.accent);
                    say(hint.slice(hint.indexOf(' - ') + 3), 446, 18, t.warn || t.accent);
                }
                if (debug()) video.lines().slice(0, 9).forEach((l, i) => cv.text(String(l).slice(0, 118), x, 300 + i * 22, 16, t.dim, lit));
                else {
                    say((isPaused() ? 'Play' : 'Pause') + ': press the controller or the button below.', 480, 18, t.dim);
                    say('Seek: turn the controller (10 s), tilt left / right (30 s), or tap the bar.', 506, 18, t.dim);
                }
            } else if (music) {
                const L = music.lines();
                say(L[0].replace(/^music: /, ''), 120, 24, t.text);
                if (L[1]) say(L[1], 160, 20, t.dim);
                if (debug()) L.slice(2).forEach((l, i) => say(l, 200 + i * 24, 18, t.dim));
                say('Press the controller: pause / play. Turn or tilt: previous / next track. Plays while driving too.', 480, 18, t.dim);
            } else say(status, 120, 22, t.dim);
        }
        const fmtAhead = (sec) => Math.floor(sec / 60) + ':' + ('0' + Math.floor(sec % 60)).slice(-2);
        const two = (n) => (n < 10 ? '0' : '') + n;
        const fmt = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 3600) + ':' + two(Math.floor(s / 60) % 60) + ':' + two(s % 60); };

        function drawDiag(cv, t) {
            header(cv, t, 'Diagnostics  -  ' + ctx.spec.title + ' ' + ctx.spec.version);
            const host = (/^https?:\/\/([^/:]+)/.exec(conf.base || '') || [])[1], dn = host && dnsResolved[host];
            const L = ['server: ' + (conf.base || '-') + ', signed in: ' + (signedIn() ? conf.userName || 'yes' : 'no') + ', park check: ' + gate.why(),
                'name lookup: ' + (dn ? host + ' -> ' + dn.address + ' (' + dn.how + ')' : '-'), remote.line(),
                'memory: ' + rssMB() + ' MB (peak ' + peakRss + ', start ' + rss0 + ')' + (lastExit ? '   -   last run ended: ' + lastExit.replace(/^\S+ /, '') : '')]
                .concat(online.enabled ? online.statusLines().slice(0, 3) : [], video ? video.lines().slice(0, 5) : [], music ? music.lines().slice(0, 3) : [], ring.slice(-9));
            lines(cv, t, L, 110, 17, 22);
        }

        async function render() {
            if (drawn === rev) return undefined;
            drawn = rev;
            const t = ctx.theme();
            // the MGU display's video: IterioDev's dialect while it plays there (see useDialect)
            useDialect(video && video.target === 'cid' ? 'iterio' : '');
            const cv = ctx.canvas(W, H).clear(t.bg);
            // (a page that fails to draw must not stop the tabs and the screen: it says so instead)
            try {
                if (page === 'server') drawServer(cv, t);
                else if (page === 'browse') drawBrowse(cv, t);
                else if (page === 'player') drawPlayer(cv, t);
                else drawDiag(cv, t);
            } catch (e) {
                if (!drawErr) log.error('draw ' + page + ': ' + (e && e.stack || e));
                drawErr = (e && e.message) || String(e);
                cv.text('Drawing failed: ' + drawErr, 40, 480, 18, t.warn || t.accent, lit);
            }
            if (notice && Date.now() < notice.until) {
                cv.fillRect(W - 760, 92, 720, 56, withAlpha('#000000', 0.8));
                cv.text(notice.text.slice(0, 64), W - 740, 128, 22, '#ffffff', lit);
            }
            if (!fullScreen() || overlay()) G.frame(cv, t, TABS(), PAGES().indexOf(page), [video && !gate.parked() && { text: 'NOT PARKED' }, (video || music) && { text: isPaused() ? 'PAUSED' : 'PLAYING' }]);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 4, render);
        render().catch((e) => log.warn('first render: ' + e));
        log.info('Media Client ' + ctx.spec.version + ' started' + (conf.base ? ', server ' + conf.base : ''));
    },
});

/** the car's VIN from BMW's SDK (getVin: a value, a promise or a callback - whichever it is), or null */
function carVin() {
    let g;
    try { g = require('oap-sdk').getVin; } catch (e) { return Promise.resolve(null); }
    if (typeof g !== 'function') return Promise.resolve(null);
    const pick = (v) => (v && typeof v === 'object' ? v.vin || v.VIN || v.value || null : v) || null;
    return new Promise((resolve) => {
        let r;
        try { r = g((err, v) => resolve(pick(typeof err === 'string' ? err : v))); } catch (e) { resolve(null); return; }
        if (r && typeof r.then === 'function') r.then((v) => resolve(pick(v)), () => resolve(null));
        else if (r) resolve(pick(r));
    });
}

// FrontCCU rotary encoder -> move/press (as a prior project: the knob counts by position, tilt / push on a change)
function wireController(ctx, handlers, active) {
    const DEFL = { MITTELSTELLUNG: 0, NORD_KURZ_GEDRUECKT: 1, NORD_LANG_GEDRUECKT: 2, OST_KURZ_GEDRUECKT: 4, OST_LANG_GEDRUECKT: 5,
        SUED_KURZ_GEDRUECKT: 7, SUED_LANG_GEDRUECKT: 8, WEST_KURZ_GEDRUECKT: 10, WEST_LANG_GEDRUECKT: 11, SIGNAL_UNGUELTIG: 15 };
    const PUSH = { KEINE_BETAETIGUNG: 0, DREHGEBER_KURZ_GEDRUECKT: 1, DREHGEBER_LANG_GEDRUECKT: 2, SIGNAL_UNGUELTIG: 15 };
    const num = (v, names) => (typeof v === 'number' ? v : v != null && names[v] != null ? names[v] : 15);
    const DIR = { 1: 'up', 2: 'up', 7: 'down', 8: 'down', 10: 'left', 11: 'left', 4: 'right', 5: 'right' };
    let lastPos = null, pressed = false, lastDefl = 0;
    const handle = (v) => {
        if (!v) return;
        const on = active();
        const pos = v.frontRotaryEncoderOperation;
        if (typeof pos === 'number' && pos !== 65535) {
            if (on && lastPos != null && pos !== lastPos) {
                const d = (pos - lastPos + 65536) % 65536;
                handlers.move(d < 32768 ? 'right' : 'left', 'turn', d < 32768 ? d : 65536 - d);
            }
            lastPos = pos;
        }
        const defl = num(v.frontRotaryEncoderDeflection, DEFL);
        if (on && DIR[defl] && defl !== lastDefl) handlers.move(DIR[defl], 'tilt');
        if (defl !== 15) lastDefl = defl;
        const push = num(v.frontRotaryEncoderPushButton, PUSH);
        const now = push === 1 || push === 2;
        if (now && !pressed && on) handlers.press();
        if (push !== 15) pressed = now;
    };
    if (ctx.controller && ctx.controller.onInput) ctx.controller.onInput(handle);
    try {
        ctx.signals.watch('de.bmw.infotainment.controlelements.FrontCCU', '1', { statusRotaryEncoderState: handle }, ctx.log)
            .then((s) => ctx.log.info('controller ' + (s && s.error ? 'error: ' + s.error : 'ready')));
    } catch (e) { /* no controller signal: touch still works */ }
    // the controller is held only on the lists, the keyboard and the music player
    setInterval(() => { if (ctx.controller) ctx.controller.grab(active()); }, 300);
}

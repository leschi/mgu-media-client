'use strict';
/**
 * Media Client - videos and music from a Media Media Server on the BMW MGU (iDrive 7).
 *
 *   Server  sign in with a code at media.tv/link (no typing), or the server's URL and a token typed
 *           with the on-screen keyboard; the choice is kept in the app's data folder
 *   Browse  the libraries (movies, shows, music), on deck; the controller turns through the list,
 *           press opens / plays, tilt left goes back up
 *   Player  what plays: a video on the cluster (middle or whole) or the HUD - the picture ONLY while
 *           parked (./parkgate), the sound on through the car's speakers (BMW's media player) - or music
 *   Diag    what happened (the log), the video's and the sound's state
 *
 * The video path (decode in the app, cluster-render video layer, the sound as a local AAC file for
 * BMW's player, the park check) came from a prior project, where it ran on the car (0.2.40 - 0.2.44).
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kbd = require('./keyboard');
const qr = require('./qr');
const { Media } = require('./media');
const { ClusterVideo } = require('./clustervideo');
const { MusicPlayer } = require('./musicplayer');
const { lookup } = require('./dns');

const W = 1600, H = 520;
const TABS = ['Server', 'Browse', 'Player', 'Diag'];
const PAGES = ['server', 'browse', 'player', 'diag'];
const ROWS = 8, ROW_H = 52, LIST_Y = 92;
const TARGET_NAME = { map: 'Cluster middle', panel: 'Whole cluster', hud: 'Head-up display' };

mgu.run({
    async start(ctx) {
        const { ui, settings } = ctx;
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
        if (!conf.clientId) conf.clientId = 'mgu-media-' + crypto.randomBytes(8).toString('hex');
        const save = () => { try { fs.writeFileSync(CONF, JSON.stringify(conf), { mode: 0o600 }); } catch (e) { log.warn('save: ' + e.message); } };
        save();
        const media = new Media({ clientId: conf.clientId, lookup, base: conf.base, token: conf.token });

        // what an earlier run left in /tmp (RAM on the unit): sound and track files of a player that was killed
        try { fs.readdirSync('/tmp').filter((f) => /^mgu-media-/.test(f)).forEach((f) => { try { fs.unlinkSync('/tmp/' + f); } catch (e) { /* not ours */ } }); } catch (e) { /* no /tmp here */ }

        let sig = null;
        try { sig = require('./kit/signals'); } catch (e) { /* not on a unit */ }
        let parkGate = null;
        try { parkGate = require('./parkgate').watchPark(ctx.signals, log); } catch (e) { log.warn('park check: ' + e.message); }
        // no park check (no vehicle signals): never parked - the picture never shows without one
        const gate = parkGate || { parked: () => false, why: () => 'no vehicle signals' };

        /* ---------------- redraw only on change ---------------- */
        let rev = 1, drawn = -1;
        const touch = () => { rev++; };
        setInterval(touch, 1000);              // time-based content (states, the player's time)

        let page = conf.token && conf.base ? 'browse' : 'server';
        let status = conf.token && conf.base ? 'Server: ' + (conf.serverName || conf.base) : 'Not signed in';

        /* ================= Server: sign in ================= */
        let srvMode = 'idle';                  // idle | pin | pick | manual
        let pin = null, pinTimer = null, servers = [], srvSel = 0;
        const fields = { url: kbd.makeField(conf.base || 'http://', { max: 200 }), token: kbd.makeField(conf.token || '', { max: 100 }) };
        let field = 'url';
        const keyboard = new kbd.Keyboard('abc');
        let keyRects = [];

        async function signInCode() {
            stopPin();
            srvMode = 'pin'; pin = null; status = 'Asking media.tv for a code...'; touch();
            try {
                pin = await media.pinStart();
                status = 'Enter the code at media.tv/link';
                const t0 = Date.now();
                pinTimer = setInterval(async () => {
                    if (Date.now() - t0 > 10 * 60000) { stopPin(); status = 'The code expired: sign in again'; srvMode = 'idle'; touch(); return; }
                    try {
                        const token = await media.pinCheck(pin.id);
                        if (!token) return;
                        stopPin();
                        media.token = token;
                        status = 'Signed in - looking for your servers...'; touch();
                        await findServers();
                    } catch (e) { log.warn('code: ' + e.message); }
                }, 3000);
            } catch (e) { status = 'media.tv: ' + e.message; srvMode = 'idle'; }
            touch();
        }
        function stopPin() { clearInterval(pinTimer); pinTimer = null; }

        async function findServers() {
            try {
                servers = await media.servers();
                if (!servers.length) { status = 'No server on this account'; srvMode = 'idle'; touch(); return; }
                if (servers.length === 1) return useServer(servers[0]);
                srvMode = 'pick'; srvSel = 0; status = 'Choose a server'; touch();
            } catch (e) { status = 'Servers: ' + e.message; srvMode = 'idle'; touch(); }
            return undefined;
        }

        async function useServer(s) {
            status = 'Connecting to ' + s.name + '...'; touch();
            try {
                const c = await media.connect(s);
                conf.base = media.base; conf.token = media.token; conf.serverName = s.name; save();
                status = 'Server: ' + s.name + ' (' + (c.local ? 'home network' : c.relay ? 'Media relay' : 'internet') + ')';
                srvMode = 'idle';
                log.info('server ' + s.name + ' at ' + c.uri);
                openRoot();
                setPage('browse');
            } catch (e) { status = s.name + ': ' + e.message; touch(); }
        }

        async function useManual() {
            media.base = fields.url.value.replace(/\/+$/, ''); media.token = fields.token.value.trim();
            status = 'Checking ' + media.base + '...'; touch();
            try {
                await media.check();
                conf.base = media.base; conf.token = media.token; conf.serverName = media.base; save();
                status = 'Server: ' + media.base; srvMode = 'idle';
                openRoot(); setPage('browse');
            } catch (e) { status = 'That server: ' + e.message; touch(); }
        }

        function keyPress(id) {
            const r = keyboard.apply(id, fields[field]);
            if (r.action === 'enter') { if (field === 'url') field = 'token'; else useManual(); }
            touch();
        }

        /* ================= Browse ================= */
        let stack = [];                        // [{ title, path, items, sel, top }]
        let loading = '';
        async function open(title, p) {
            loading = title; touch();
            try {
                const items = p === '#root' ? (await media.sections()).concat([{ key: '/library/onDeck', title: 'On deck', sub: 'continue watching', type: 'section', leaf: false }])
                    : await media.items(p);
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
            if (!it.leaf) return open(it.title, it.key);
            if (it.type === 'track') return playMusic(c.items, c.sel);
            return playVideo(it);
        }

        /* ================= Player ================= */
        let video = null, music = null, playing = null;     // playing: the item
        let session = null, offset = 0, pingT = null, timelineT = null;

        async function stopAll() {
            clearInterval(pingT); clearInterval(timelineT); pingT = timelineT = null;
            const v = video, m = music, it = playing, s = session, off = offset;
            video = null; music = null; session = null;
            const done = [];
            if (v) {
                if (it) media.timeline({ ratingKey: it.ratingKey, state: 'stopped', timeMs: (off + v.position()) * 1000, durationMs: it.duration });
                done.push(v.stop());
                if (s) media.stop(s);
            }
            if (m) done.push(m.stop());
            await Promise.all(done);
            touch();
        }

        async function playVideo(it, at) {
            await stopAll();
            playing = it;
            const resume = settings.get('resume') !== false && it.offset > 30000 && it.offset < it.duration - 60000;
            offset = at != null ? at : resume ? it.offset / 1000 : 0;
            session = crypto.randomBytes(8).toString('hex');
            const sharp = settings.get('quality') === 'sharp';
            const url = media.transcodeUrl(it.ratingKey, { session, offset, resolution: sharp ? '640x360' : '480x270', bitrate: sharp ? 2000 : 1200 });
            video = new ClusterVideo({ url, target: settings.get('target') || 'map', gate, sig, lookup, log, app: 'mgu_media', quality: sharp ? 'sharp' : 'smooth', anyProfile: true });
            log.info('video ' + it.title + ' from ' + Math.round(offset) + ' s on ' + (settings.get('target') || 'map'));
            video.start();
            const s = session;
            pingT = setInterval(() => media.ping(s), 10000);
            timelineT = setInterval(() => { if (video && playing) media.timeline({ ratingKey: it.ratingKey, state: 'playing', timeMs: (offset + video.position()) * 1000, durationMs: it.duration }); }, 10000);
            setPage('player');
        }

        async function playMusic(items, i) {
            await stopAll();
            const tracks = items.filter((x) => x.type === 'track');
            const start = tracks.indexOf(items[i]);
            playing = items[i];
            if (!sig || !sig.hasNative()) { status = 'No sound here (BMW\'s player is on the unit only)'; setPage('player'); return; }
            music = new MusicPlayer({ media, sig, lookup, log });
            music.play(tracks, Math.max(0, start)).catch((e) => log.warn('music: ' + e.message));
            setPage('player');
        }

        /** another target while a video plays: it starts again there, where it was */
        settings.onChange((k) => {
            if (k === 'signOut' && settings.get('signOut')) {
                try { settings.set('signOut', false); } catch (e) { /* stays */ }
                stopAll(); conf.base = ''; conf.token = ''; conf.serverName = ''; save();
                media.base = ''; media.token = ''; stack = []; status = 'Signed out'; setPage('server');
            }
            if ((k === 'target' || k === 'quality') && video && playing && playing.type !== 'track') {
                const at = offset + video.position();
                playVideo(playing, at);
            }
            touch();
        });

        /* ================= pages, buttons, input ================= */
        const BTN = {
            server: () => [['BTN1', srvMode === 'pin' ? 'New code' : 'Sign in (code)'], ['BTN2', srvMode === 'manual' ? 'Connect' : 'Enter by hand']],
            browse: () => [['BTN1', 'Open / Play'], ['BTN2', 'Back']],
            player: () => [['BTN1', 'Stop'], ['BTN2', music ? 'Next track' : 'Restart']],
            diag: () => [['BTN1', 'Clear log'], ['BTN2', 'Back to browse']],
        };
        function buttons() { BTN[page]().forEach(([n, l]) => { try { ui.text(n, l); } catch (e) { /* ignore */ } }); }
        function setPage(p) { page = p; buttons(); touch(); }
        setPage(page);
        if (page === 'browse') openRoot();

        ui.onClick('BTN1', () => {
            if (page === 'server') signInCode();
            else if (page === 'browse') choose();
            else if (page === 'player') { stopAll(); playing = null; }
            else if (page === 'diag') ring.length = 0;
            buttons(); touch();
        });
        ui.onClick('BTN2', () => {
            if (page === 'server') { if (srvMode === 'manual') useManual(); else { stopPin(); srvMode = 'manual'; field = 'url'; status = 'Type the server address (http://IP:32400) and a token'; } }
            else if (page === 'browse') back();
            else if (page === 'player') { if (music) music.next(); else if (playing) playVideo(playing, 0); }
            else if (page === 'diag') setPage('browse');
            buttons(); touch();
        });
        ui.onClick('BTN_PAGE', () => setPage(PAGES[(PAGES.indexOf(page) + 1) % PAGES.length]));
        ctx.onTab((i) => { if (PAGES[i]) setPage(PAGES[i]); });

        ctx.onTap((x, y) => {
            if (page === 'browse') {
                const c = cur();
                if (!c) return;
                const i = c.top + Math.floor((y - LIST_Y) / ROW_H);
                if (y >= LIST_Y && i >= 0 && i < c.items.length && i < c.top + ROWS) { if (c.sel === i) choose(); else { c.sel = i; touch(); } }
            } else if (page === 'server' && srvMode === 'pick') {
                const i = Math.floor((y - 150) / ROW_H);
                if (i >= 0 && i < servers.length) useServer(servers[i]);
            } else if (page === 'server' && srvMode === 'manual') {
                if (y >= 96 && y < 140) field = x < W / 2 ? 'url' : 'token';
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
                } else if (page === 'server' && srvMode === 'manual') {
                    if (how === 'turn') keyboard.move(step > 0 ? 'right' : 'left'); else keyboard.move(dir);
                    touch();
                } else if (page === 'server' && srvMode === 'pick') {
                    srvSel = Math.max(0, Math.min(servers.length - 1, srvSel + (how === 'turn' ? step : dir === 'up' ? -1 : dir === 'down' ? 1 : 0))); touch();
                } else if (page === 'player' && music) {
                    if (how === 'turn' || dir === 'left' || dir === 'right') { if (step > 0 || dir === 'right') music.next(); else music.prev(); touch(); }
                }
            },
            press() {
                if (page === 'browse') choose();
                else if (page === 'server' && srvMode === 'manual') keyPress(keyboard.current());
                else if (page === 'server' && srvMode === 'pick' && servers[srvSel]) useServer(servers[srvSel]);
            },
        }, () => page === 'browse' || (page === 'server' && (srvMode === 'manual' || srvMode === 'pick')) || (page === 'player' && !!music));

        /* ================= drawing ================= */
        const lit = { literal: true };
        function header(cv, t, title) { cv.text(title, 40, 74, 26, t.text, { font: 'bold', literal: true }); }
        function lines(cv, t, L, y, size, max) { L.slice(0, max || 20).forEach((l, i) => cv.text(String(l).slice(0, 150), 40, y + i * (size + 8), size, i === 0 ? t.text : t.dim, lit)); }

        function drawServer(cv, t) {
            header(cv, t, 'Media server');
            // (with the keyboard the fields take that line: the status goes up to the right)
            if (srvMode === 'manual') cv.text(status, W - 40, 74, 20, t.accent, { align: 'right', literal: true });
            else cv.text(status, 40, 116, 22, t.accent, lit);
            if (srvMode === 'pin' && pin) {
                cv.text('1. On your phone open  media.tv/link  (or scan the code)', 40, 170, 24, t.text, lit);
                cv.text('2. Enter this code:', 40, 214, 24, t.text, lit);
                cv.text(pin.code, 40, 320, 96, t.text, { font: 'bold', spacing: 12, literal: true });
                drawQr(cv, t, 'https://media.tv/link', W - 340, 70, 300);
            } else if (srvMode === 'pick') {
                servers.forEach((s, i) => {
                    const y = 150 + i * ROW_H;
                    if (i === srvSel) cv.fillRect(30, y, 1000, ROW_H - 4, withAlpha(t.sel || t.accent, 0.25));
                    cv.text(s.name + (s.owned ? '' : '  (shared)'), 50, y + 34, 24, t.text, lit);
                });
            } else if (srvMode === 'manual') {
                [['url', 'Server', 40], ['token', 'Token', W / 2]].forEach(([k, label, x]) => {
                    cv.fillRect(x, 96, W / 2 - 60, 44, withAlpha(field === k ? (t.sel || t.accent) : '#ffffff', field === k ? 0.25 : 0.06));
                    cv.text(label + ': ' + kbd.display(fields[k]) + (field === k ? '_' : ''), x + 10, 126, 22, t.text, lit);
                });
                drawKeyboard(cv, t, 160);
            } else {
                lines(cv, t, ['Sign in (code): no typing - you enter a code at media.tv/link on your phone.',
                    'Enter by hand: the server\'s address (http://192.168.x.x:32400) and a Media token.',
                    'Then: Browse your libraries. A video plays on the cluster or the HUD (Settings -> Video on),',
                    'the picture only while parked (under 1 km/h, selector in P); the sound also while driving.'], 170, 22);
            }
        }

        function drawKeyboard(cv, t, y0) {
            keyRects = [];
            const rows = keyboard.rows(), kh = 76, gap = 6;
            const label = { '#shift': keyboard.layer === 'ABC' ? 'abc' : 'ABC', '#layer': keyboard.layer === '123' ? 'abc' : '123', '#back': 'Del', '#space': 'Space', '#enter': field === 'url' ? 'Next' : 'Connect' };
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

        let qrCache = null;
        function drawQr(cv, t, text, x, y, size) {
            if (!qrCache || qrCache.text !== text) { try { qrCache = { text, m: qr.build(text, 'M') }; } catch (e) { return; } }
            const m = qrCache.m, n = m.length, q = Math.floor(size / (n + 8)), off = Math.floor((size - n * q) / 2);
            cv.fillRect(x, y, size, size, '#ffffff');
            for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) cv.fillRect(x + off + c * q, y + off + r * q, q, q, '#000000');
        }

        function drawBrowse(cv, t) {
            const c = cur();
            header(cv, t, stack.map((s) => s.title).join('  >  ') || 'Libraries');
            if (loading) cv.text('Loading ' + loading + '...', W - 40, 74, 20, t.dim, { align: 'right', literal: true });
            if (!c) { cv.text(conf.token ? status : 'Sign in first (Server)', 40, 130, 22, t.dim, lit); return; }
            if (!c.items.length) { cv.text('(empty)', 40, 130, 22, t.dim, lit); return; }
            for (let k = 0; k < ROWS; k++) {
                const i = c.top + k, it = c.items[i];
                if (!it) break;
                const y = LIST_Y + k * ROW_H;
                if (i === c.sel) cv.fillRect(30, y, W - 60, ROW_H - 4, withAlpha(t.sel || t.accent, 0.25));
                cv.text((it.leaf ? '' : '+ ') + it.title, 50, y + 34, 24, t.text, lit);
                const right = [it.sub, it.leaf && it.duration ? Math.round(it.duration / 60000) + ' min' : '', it.offset > 30000 ? 'resume ' + Math.round(it.offset / 60000) + ' min' : ''].filter(Boolean).join('   ');
                if (right) cv.text(right, W - 50, y + 34, 20, t.dim, { align: 'right', literal: true });
            }
            if (c.items.length > ROWS) cv.text((c.sel + 1) + ' / ' + c.items.length, W - 40, 506, 18, t.dim, { align: 'right', literal: true });
        }

        function drawPlayer(cv, t) {
            if (!playing) { header(cv, t, 'Nothing plays'); cv.text('Choose a video or music in Browse.', 40, 130, 22, t.dim, lit); return; }
            header(cv, t, playing.title + (playing.sub ? '  -  ' + playing.sub : ''));
            if (video) {
                const parked = gate.parked();
                cv.text('Video on: ' + TARGET_NAME[video.target] + (parked ? '' : '  -  picture paused: not parked (the sound goes on)'), 40, 116, 22, parked ? t.accent : t.warn, lit);
                cv.text('Position ' + fmt(offset + video.position()) + (playing.duration ? ' / ' + fmt(playing.duration / 1000) : ''), 40, 150, 22, t.text, lit);
                lines(cv, t, video.lines().slice(0, 9), 190, 18);
            } else if (music) {
                lines(cv, t, music.lines(), 116, 22);
                cv.text('Turn or tilt the controller: previous / next track. Plays while driving too.', 40, 480, 18, t.dim, lit);
            } else cv.text(status, 40, 116, 22, t.dim, lit);
        }
        const two = (n) => (n < 10 ? '0' : '') + n;
        const fmt = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 3600) + ':' + two(Math.floor(s / 60) % 60) + ':' + two(s % 60); };

        function drawDiag(cv, t) {
            header(cv, t, 'Diagnostics  -  ' + ctx.spec.title + ' ' + ctx.spec.version);
            const L = ['server: ' + (conf.base || '-') + ', signed in: ' + (conf.token ? 'yes' : 'no') + ', park check: ' + gate.why()]
                .concat(video ? video.lines().slice(0, 6) : [], music ? music.lines().slice(0, 3) : [], ring.slice(-12));
            lines(cv, t, L, 110, 17, 22);
        }

        async function render() {
            if (drawn === rev) return undefined;
            drawn = rev;
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            if (page === 'server') drawServer(cv, t);
            else if (page === 'browse') drawBrowse(cv, t);
            else if (page === 'player') drawPlayer(cv, t);
            else drawDiag(cv, t);
            G.frame(cv, t, TABS, PAGES.indexOf(page), [video && !gate.parked() && { text: 'NOT PARKED' }, (video || music) && { text: 'PLAYING' }]);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 4, render);
        render().catch((e) => log.warn('first render: ' + e));
        log.info('Media Client ' + ctx.spec.version + ' started' + (conf.base ? ', server ' + conf.base : ''));
    },
});

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

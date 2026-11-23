'use strict';
/**
 * oapmedia.js - BMW's media player for an app: the AudioManager connection OAPGenericMedia ->
 * MediaSink_Front (without it the player plays to nobody, car v0.2.32), then the player itself
 * (MediaPlayer, instance OapGenericMedia). Works on the car since v0.2.35 (an "Online" source).
 *
 *   const m = await openMedia(sig, add);    // add(line): what it did, for the report
 *   await m.play(url);                      // -> { answer, playing, state }
 *   m.get('currentItemTime')                // a field, as one line of JSON
 *   await m.close();                        // pause, the connection goes, the source before comes back
 */
const AM = 'org.genivi.am.commandinterface.CommandControl';
const MP = 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer';

function oneLine(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function withTimeout(pr, ms, what) {
    return Promise.race([pr, new Promise((resolve, reject) => setTimeout(() => reject(new Error(what + ': no answer in ' + ms / 1000 + ' s')), ms))]);
}
function arr(r) { if (Array.isArray(r)) return r; if (r && typeof r === 'object') for (const k in r) if (Array.isArray(r[k])) return r[k]; return []; }

/** resolves once the proxy's service is there; rejects after ms */
function waitAvailable(sig, px, ms) {
    return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('service not found in ' + ms / 1000 + ' s (not offered, or not allowed for this app)')); } }, ms);
        sig.onAvailable(px, (a) => { if (a && !done) { done = true; clearTimeout(timer); resolve(); } }).catch(() => {});
    });
}

/**
 * The AudioManager connection alone: the app's source on the media sink -> { release() ... }. Throws when the
 * AudioManager or the source isn't there.
 */
async function connectSource(sig, add, opts) {
    const scale = opts && opts.scale != null ? opts.scale : 1;
    const w = (ms) => wait(ms * scale);
    const call = (px, m, a, ms) => withTimeout(sig.call(px, m, a || {}, ms || 8000), (ms || 8000) + 2000, m);
    const am = await withTimeout(sig.proxy(AM, '1'), 8000, 'proxy AM');
    await waitAvailable(sig, am, 10000);
    const lists = await Promise.all([call(am, 'getListMainSources'), call(am, 'getListMainSinks'), call(am, 'getListMainConnections')]);
    const src = arr(lists[0]).find((x) => /oap.?generic.?media/i.test(x.name));
    const snk = arr(lists[1]).find((x) => /mediasink.?front/i.test(x.name)) || arr(lists[1]).find((x) => /media/i.test(x.name));
    if (!src || !snk) throw new Error('no OAPGenericMedia source or media sink');
    const sinkId = snk.sinkID;
    // a connection of this source already there: one a killed run left, or another app's (it is every OAP app's
    // source). The AudioManager refuses a second one and the film plays to nobody: it goes first
    const own = arr(lists[2]).filter((c) => c.sinkID === sinkId && c.sourceID === src.sourceID);
    for (const c of own) {
        await call(am, 'disconnect', { mainConnectionID: c.mainConnectionID }).then((x) => add('am: old connection ' + c.mainConnectionID + ' (' + c.connectionState + ') ended: ' + oneLine(JSON.stringify(x), 40)), (e) => add('am: old connection: ' + e.message));
        await w(500);
    }
    const prev = arr(lists[2]).find((c) => c.sinkID === sinkId && c.sourceID !== src.sourceID) || null;
    const good = (x) => !!x && (x.amError === undefined || x.amError === 'E_OK' || x.amError === 0);
    let r = await call(am, 'connect', { sourceID: src.sourceID, sinkID: sinkId });
    if (!good(r)) {
        add('am: connect ' + oneLine(JSON.stringify(r), 60) + ', again');
        await w(1500);
        r = await call(am, 'connect', { sourceID: src.sourceID, sinkID: sinkId });
    }
    const conn = good(r) ? r.mainConnectionID : null;
    add('am: ' + (prev ? 'source ' + prev.sourceID + ' was on sink ' + sinkId + '; ' : '') + 'connect ' + src.sourceID + ' -> ' + sinkId + ': ' + oneLine(JSON.stringify(r), 60));

    const release = async () => {
        if (conn == null) return;
        await w(1000);
        await call(am, 'disconnect', { mainConnectionID: conn }).then((x) => add('am disconnect: ' + oneLine(JSON.stringify(x), 60)), (e) => add('am disconnect: ' + e.message));
        if (!prev) return;
        await w(1000);
        await call(am, 'getListMainConnections').then((x) => (arr(x).some((c) => c.sinkID === sinkId) ? add('am: sink ' + sinkId + ' in use again')
            : call(am, 'connect', { sourceID: prev.sourceID, sinkID: sinkId }).then((y) => add('am restore source ' + prev.sourceID + ': ' + oneLine(JSON.stringify(y), 60)))))
            .catch((e) => add('am restore: ' + e.message));
    };
    /** why nothing can be heard ('' when the connection stands) */
    const problem = async () => {
        if (conn == null) return 'the car gives no sound connection (' + (r && r.amError) + ')';
        const c = arr(await call(am, 'getListMainConnections')).find((x) => x.mainConnectionID === conn);
        return c && c.connectionState !== undefined && c.connectionState !== 'CS_CONNECTED' && c.connectionState !== 2 ? 'the car holds the sound (' + c.connectionState + ')' : '';
    };
    return { am, call, w, prev, sinkId, conn, release, problem };
}

/**
 * opts.scale: times scale for the waits (the tests run fast). Throws when the AudioManager or the player
 * isn't there; then nothing was connected.
 */
async function openMedia(sig, add, opts) {
    const { call, w, prev, sinkId, conn, release, problem } = await connectSource(sig, add, opts);
    const m = { sig, call, prev, sinkId, conn, problem, closed: false };
    try {
        m.mp = await withTimeout(sig.proxy(MP, 'OapGenericMedia'), 8000, 'proxy MP');
        await waitAvailable(sig, m.mp, 10000);
    } catch (e) { await release(); throw e; }

    m.get = (f) => withTimeout(new Promise((res) => setImmediate(() => res(m.mp.getValue(f, 3000)))), 4000, f)
        .then((v) => oneLine(JSON.stringify(v), 160), (e) => 'error ' + oneLine(e && e.message, 60));
    m.button = (b) => call(m.mp, 'sendButtonEvent', { button: b, action: 'PRESS' }, 4000).then(() => call(m.mp, 'sendButtonEvent', { button: b, action: 'RELEASE' }, 4000));
    /** playFile, then the state until it plays (a PLAY press after 2 s); polls: how many 0.5 s looks */
    m.play = async (path, polls) => {
        const answer = await call(m.mp, 'playFile', { path, languageCode: 0 }).then((x) => oneLine(JSON.stringify(x), 40), (e) => 'error ' + oneLine(e && e.message, 60));
        let state = '', playing = false;
        for (let k = 0; k < (polls || 8) && !playing; k++) {
            await w(500);
            state = await m.get('playerState');
            playing = /"PLAYER_STATE_PLAY"/.test(state);
            if (!playing && k === 3) await m.button('PLAY').catch(() => {});
        }
        return { answer, playing, state };
    };
    m.close = async () => {
        if (m.closed) return;
        m.closed = true;
        await m.button('PAUSE').catch(() => {});
        await release();
    };
    return m;
}

module.exports = { openMedia, connectSource, waitAvailable, withTimeout, oneLine };

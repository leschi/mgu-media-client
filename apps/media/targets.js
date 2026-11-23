'use strict';
/**
 * targets.js - cluster-render's targets and fitting a picture into one.
 */
// map = the area between the gauges (takes over the stock content with contend), panel = the whole
// cluster, hud. The service's hello names the real
// sizes (iDrive 8: others).
const TARGETS = { map: [1088, 480], panel: [1920, 720], hud: [800, 480] };

/** 'map:1088x480,panel:1920x720,...' (the service's hello) -> { map: [1088, 480], ... } */
function parseTargets(s) {
    const out = {};
    String(s || '').split(',').forEach((p) => { const m = /^\s*(\w+):(\d+)x(\d+)\s*$/.exec(p); if (m) out[m[1]] = [+m[2], +m[3]]; });
    return out;
}

/** An iw x ih picture fitted into the target (tw x th), aspect kept, centred: the layer's rect. */
function fitRect(iw, ih, tw, th) {
    const s = Math.min(tw / iw, th / ih), w = Math.max(1, Math.round(iw * s)), h = Math.max(1, Math.round(ih * s));
    return { x: Math.floor((tw - w) / 2), y: Math.floor((th - h) / 2), w, h };
}

/**
 * The picture at its own size, centred, at even x and y (cluster-render: only such videos share the
 * display's two video buffers); null when it is larger than the target.
 */
function ownRect(iw, ih, tw, th) {
    if (iw > tw || ih > th) return null;
    return { x: ((tw - iw) >> 1) & ~1, y: ((th - ih) >> 1) & ~1, w: iw, h: ih };
}

module.exports = { TARGETS, parseTargets, fitRect, ownRect };

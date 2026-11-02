'use strict';
/**
 * parkgate.js - is the car parked? For video in the driver's view (cluster, HUD): only then.
 *
 * Parked = a real speed under 1 km/h AND the selector in P. Anything unknown counts as NOT parked: no
 * speed yet, no selector signal, or a speed older than STALE_MS (it is re-read every 2 s: a car
 * standing still notifies nothing new). The selector counts as told until it changes (a change is
 * notified; 'NP' - N or P not told apart - is not P). The kit's
 * parked.js is the lenient one (no speed = parked, for games on a bench); this one is strict.
 *
 *   const gate = watchPark(ctx.signals, log);
 *   gate.parked()  -> true / false;  gate.why() -> 'speed 0.0 km/h, selector P' or why not
 */
const MAX_KMH = 1;
const STALE_MS = 10000;

// selector position: statusGearboxDrive.statusActualStageDrive (P = 1 or 'P') and
// DataPowerTrain2.statusGearSelectionDrive (P = 3 or 'P'; 4 = 'NP': N or P, not told apart)
function stageFromGearbox(v) { const x = v && v.statusActualStageDrive; return x === 1 || x === 'P' ? 'P' : x == null ? undefined : String(x); }
function stageFromSelection(v) { const x = v && v.statusGearSelectionDrive; return x === 3 || x === 'P' ? 'P' : x == null ? undefined : String(x); }

function gate(now) {
    const st = { speed: null, speedT: 0, stage: undefined, stageT: 0 };
    const t = now || Date.now;
    return {
        st,
        speed(v) {
            const k = v && v.speedVehicleCentreOfGravity;
            if (typeof k === 'number' && k !== 65535) { st.speed = k * 0.015625; st.speedT = t(); }
        },
        stage(s) { if (s !== undefined) { st.stage = s; st.stageT = t(); } },
        parked() {
            const n = t();
            return st.speed !== null && n - st.speedT < STALE_MS && st.speed < MAX_KMH && st.stage === 'P';
        },
        why() {
            const n = t();
            const sp = st.speed === null ? 'speed unknown' : 'speed ' + st.speed.toFixed(1) + ' km/h' + (n - st.speedT >= STALE_MS ? ' (old)' : '');
            const sg = st.stage === undefined ? 'selector unknown' : 'selector ' + st.stage;
            return sp + ', ' + sg;
        },
    };
}

function watchPark(signals, log, now) {
    const g = gate(now);
    signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', { statusCarSpeed2: (v) => g.speed(v) }, log, { pollMs: 2000 })
        .then((s) => log && log.info('park gate: speed ' + (s.error ? 'error: ' + s.error : 'subscribed')));
    signals.watch('de.bmw.infrastructure.VehicleInformation', '1', {
        statusGearboxDrive: (v) => g.stage(stageFromGearbox(v)),
        DataPowerTrain2: (v) => g.stage(stageFromSelection(v)),
    }, log, { pollMs: 2000 }).then((s) => log && log.info('park gate: selector ' + (s.error ? 'error: ' + s.error : 'subscribed')));
    return g;
}

module.exports = { watchPark, gate, stageFromGearbox, stageFromSelection, MAX_KMH, STALE_MS };

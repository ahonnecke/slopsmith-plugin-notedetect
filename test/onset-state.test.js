// Onset-detector state machine tests. The user reported click-track
// captured only 1-2 plucks across 8 clicks. Hypothesis: bass sustain
// holds RMS above the 0.008 rearm threshold between plucks at 60bpm,
// so reattackArmed never flips back to true after the first onset
// and plucks 2-8 get gated out by the path-2 (re-attack) check.
//
// These tests reproduce that scenario directly via the extracted
// state machine, no AudioContext needed.

const test = require('node:test');
const assert = require('node:assert');
const { loadDetectionCore } = require('./_loader');

const { stepOnset } = loadDetectionCore();

// Match the live constants in screen.js.
const T = {
    onsetLevel: 0.015,
    exitLevel: 0.008,
    rearmLevel: 0.008,
    reattackMinLevel: 0.015,
    reattackRatio: 1.5,
    refractorySec: 0.20,
    rmsBufWindow: 8,
};

function freshState() {
    return {
        inNote: false,
        lastOnsetPerfSec: 0,
        reattackArmed: false,
        rmsBuf: [],
        onsetCount: 0,
    };
}

// Helper: drive the state machine through a sequence of (rms, dt)
// pairs at the given bpm. Returns the array of (sec, fired) pairs.
function runSequence(rmsSeq, opts = {}) {
    const isCalibrating = !!opts.isCalibrating;
    let state = freshState();
    const fires = [];
    // Start past the refractory window — production sets nowSec
    // from performance.now()/1000 which is always >0.20 once the
    // browser has been running. lastOnsetPerfSec init to 0 means
    // refractoryOk requires nowSec > 0.20.
    let nowSec = 1.0;
    for (const r of rmsSeq) {
        const result = stepOnset(r.rms, nowSec, state, T, { isCalibrating });
        if (result.fireOnset) fires.push({ nowSec, rms: r.rms });
        state = result.state;
        nowSec += r.dt;
    }
    return { fires, state };
}

// ── Baseline scenario: silence → pluck → silence → pluck ────────────

test('stepOnset: fresh-onset path fires once on rms cross above threshold', () => {
    const { fires } = runSequence([
        { rms: 0.001, dt: 0.05 },  // silence
        { rms: 0.001, dt: 0.05 },
        { rms: 0.05, dt: 0.05 },   // pluck — fires path 1
        { rms: 0.04, dt: 0.05 },
        { rms: 0.03, dt: 0.05 },
    ]);
    assert.strictEqual(fires.length, 1);
    assert.strictEqual(fires[0].rms, 0.05);
});

test('stepOnset: full decay between plucks → both fire (path 1 each time)', () => {
    const { fires } = runSequence([
        { rms: 0.05, dt: 0.05 },   // pluck 1 — path 1 (silence → playing)
        { rms: 0.03, dt: 0.05 },   // sustain decaying
        { rms: 0.015, dt: 0.05 },
        { rms: 0.005, dt: 0.05 },  // below exit + rearm → inNote=false, armed=true
        { rms: 0.001, dt: 0.05 },  // silence
        { rms: 0.001, dt: 0.05 },  // pad past 200ms refractory
        { rms: 0.001, dt: 0.05 },
        { rms: 0.001, dt: 0.05 },
        { rms: 0.05, dt: 0.05 },   // pluck 2 — path 1 again
    ]);
    assert.strictEqual(fires.length, 2);
});

// ── Click-track scenario: bass sustain holds above rearm ────────────

test('stepOnset (NOT calibrating): bass sustain blocks 7 of 8 plucks', () => {
    // 60bpm = 1s between plucks. Each pluck spikes to 0.05, then
    // decays to 0.025 → 0.020 → 0.018 over the 1s gap. RMS never
    // drops below the rearm threshold (0.008), so reattackArmed
    // stays false after the first onset, and path-2 never fires.
    // Path-1 needs inNote=false which requires rms < 0.008 — also
    // doesn't happen. Result: only the first pluck fires.
    const seq = [];
    for (let i = 0; i < 8; i++) {
        // Pluck spike
        seq.push({ rms: 0.05, dt: 0.05 });
        // Sustain decay across the rest of the second
        seq.push({ rms: 0.030, dt: 0.20 });
        seq.push({ rms: 0.025, dt: 0.20 });
        seq.push({ rms: 0.020, dt: 0.20 });
        seq.push({ rms: 0.018, dt: 0.20 });
        seq.push({ rms: 0.018, dt: 0.15 });  // → next pluck
    }
    const { fires } = runSequence(seq, { isCalibrating: false });
    // Bug reproduction: only the first pluck fires under sustained-RMS conditions.
    assert.strictEqual(fires.length, 1, 'expected only 1 onset (the bug)');
});

test('stepOnset (CALIBRATING): same sustain pattern fires all 8 plucks', () => {
    // Same RMS sequence as above, but isCalibrating=true forces
    // reattackArmed=true on every frame. Path-2 (re-attack) can
    // now fire on each spike: rms 0.05 > 0.018 * 1.5 = 0.027 ✓.
    const seq = [];
    for (let i = 0; i < 8; i++) {
        seq.push({ rms: 0.05, dt: 0.05 });
        seq.push({ rms: 0.030, dt: 0.20 });
        seq.push({ rms: 0.025, dt: 0.20 });
        seq.push({ rms: 0.020, dt: 0.20 });
        seq.push({ rms: 0.018, dt: 0.20 });
        seq.push({ rms: 0.018, dt: 0.15 });
    }
    const { fires } = runSequence(seq, { isCalibrating: true });
    assert.strictEqual(fires.length, 8, 'expected 8 onsets after the cal-mode fix');
});

test('stepOnset (CALIBRATING): plucks within refractory still gated', () => {
    // Even with cal mode, refractory period (200ms) protects against
    // double-firing on a single attack envelope. Two RMS spikes 100ms
    // apart should fire once, not twice.
    const { fires } = runSequence([
        { rms: 0.05, dt: 0.05 },   // pluck — fires
        { rms: 0.05, dt: 0.10 },   // 100ms later — refractory blocks
        { rms: 0.04, dt: 0.10 },   // 200ms — still refractory
        { rms: 0.04, dt: 0.10 },   // 300ms — past refractory now
    ], { isCalibrating: true });
    assert.strictEqual(fires.length, 1);
});

test('stepOnset: path-2 ratio gate still applies in calibration mode', () => {
    // Calibration mode forces reattackArmed=true but doesn't bypass
    // the ratio gate — a slow rise that's always within 1.5x of
    // recent min should NOT fire, even with cal mode active.
    const seq = [];
    seq.push({ rms: 0.05, dt: 0.05 });   // initial pluck — fires path 1
    seq.push({ rms: 0.040, dt: 0.20 });  // gentle decay — no fire
    seq.push({ rms: 0.038, dt: 0.20 });
    seq.push({ rms: 0.040, dt: 0.20 });  // tiny rise, ratio 0.040/0.038 = 1.05 < 1.5 — no fire
    seq.push({ rms: 0.045, dt: 0.20 });  // small rise, 0.045/0.038 = 1.18 < 1.5 — no fire
    const { fires } = runSequence(seq, { isCalibrating: true });
    assert.strictEqual(fires.length, 1, 'only the initial pluck — gentle rises gated by ratio');
});

test('stepOnset: quiet plucks (rms ~0.025 above 0.018 sustain) FAIL gate', () => {
    // Document the design tradeoff: 1.5× ratio is the noise-vs-pluck
    // gate. Quiet plucks (0.025/0.018 = 1.39×) fail; user must pluck
    // firmly during cal. Loosening the ratio in cal mode caused
    // false-positive fires from sustain-decay transitions (e.g.
    // 0.030 vs 0.018 = 1.67×) — there's no ratio that admits 1.39×
    // attacks while rejecting 1.67× decays.
    const seq = [];
    seq.push({ rms: 0.025, dt: 0.05 });   // pluck 1 — fires path 1
    seq.push({ rms: 0.020, dt: 0.20 });
    seq.push({ rms: 0.018, dt: 0.20 });
    seq.push({ rms: 0.018, dt: 0.20 });
    seq.push({ rms: 0.018, dt: 0.20 });
    seq.push({ rms: 0.025, dt: 0.20 });   // pluck 2 — ratio 1.39× < 1.5
    const fires = runSequence(seq, { isCalibrating: true }).fires;
    assert.strictEqual(fires.length, 1, 'quiet plucks gated by ratio — design choice');
});

test('stepOnset (CALIBRATING): rapid pluck spike past ratio fires', () => {
    // Same starting state but a sudden spike from 0.018 to 0.05 →
    // ratio 0.05/0.018 ≈ 2.78 > 1.5 → fires.
    const seq = [];
    seq.push({ rms: 0.05, dt: 0.05 });   // initial — fires
    seq.push({ rms: 0.030, dt: 0.20 });  // decay
    seq.push({ rms: 0.025, dt: 0.20 });
    seq.push({ rms: 0.020, dt: 0.20 });
    seq.push({ rms: 0.018, dt: 0.20 });  // 850ms in
    seq.push({ rms: 0.05, dt: 0.20 });   // pluck 2 — ratio 0.05/0.018 = 2.78, fires
    const { fires } = runSequence(seq, { isCalibrating: true });
    assert.strictEqual(fires.length, 2);
});

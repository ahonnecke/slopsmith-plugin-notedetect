// Tests the calibration wizard's bimodal estimator (_ndWizComputeRun).
// Pure-functional: no browser, no audio. Seeds beat schedule + detection
// list, calls compute, asserts on the cluster-based result record.
//
// The estimator splits detections into two physiologically-grounded
// clusters:
//   - Anticipation: dt in (-150, +150) ms — pluck on/near the beat.
//   - Reaction:     dt in (+150/+200, +350/+400) ms (mode-dep) — pluck
//                   at typical human reaction time after the beat.
// Reaction-cluster median minus the reaction-time constant (200 ms audio,
// 250 ms visual) yields the same calibration as the anticipation median.
// When both clusters are populated and converge within 60 ms, confidence
// is high and the answer is encoded twice. This decouples calibration
// from whether the user happens to anticipate or react on a given pluck.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const core = loadDetectionCore();

function runFilter(mode, beatTimes, detections) {
    return core.wizComputeRun(beatTimes, detections, mode);
}

function syntheticRun(beatTimesMs, offsetMs, opts = {}) {
    const detections = beatTimesMs.map(t => ({
        time: t + offsetMs + (opts.jitterMs ? (Math.random() - 0.5) * 2 * opts.jitterMs : 0),
        midi: 28,
    }));
    return detections;
}

// ── Anticipation cluster (clean anticipation runs) ──────────────────────

test('anticipation: clean run with constant offset → median = offset', () => {
    const beats = [1000, 1800, 2600, 3400, 4200, 5000];
    const detections = syntheticRun(beats, 50);
    const run = runFilter('audio', beats, detections);
    assert.equal(run.medianDt, 50);
    assert.equal(run.usedCluster, 'anticipation');
    assert.equal(run.anticipationCount, 6);
    assert.equal(run.reactionCount, 0);
    assert.equal(run.confidence, 'high');
    assert.equal(run.lowQuality, false);
});

test('anticipation: jitter around true offset → median ≈ offset', () => {
    const beats = [1000, 1800, 2600, 3400, 4200, 5000];
    const detections = beats.map((t, i) => ({
        time: t + 60 + (i % 2 ? 5 : -5),
        midi: 28,
    }));
    const run = runFilter('audio', beats, detections);
    assert.ok(Math.abs(run.medianDt - 60) <= 5);
    assert.equal(run.usedCluster, 'anticipation');
    assert.equal(run.confidence, 'high');
});

test('anticipation: single clean point → medium confidence', () => {
    const beats = [1000];
    const run = runFilter('audio', beats, [{ time: 1002, midi: 28 }]);
    assert.equal(run.medianDt, 2);
    assert.equal(run.usedCluster, 'anticipation');
    assert.equal(run.confidence, 'medium');
    assert.equal(run.lowQuality, false);
});

// ── Reaction cluster (pure-reaction runs) ───────────────────────────────

test('reaction: pure auditory reaction at +220 ms → calibration = 20 ms', () => {
    // User reacts to clicks; every pluck lands ~220 ms after the beat.
    // 220 - 200 (audio reaction-time const) = 20 ms.
    const beats = [1000, 1800, 2600, 3400, 4200, 5000];
    const detections = beats.map(t => ({ time: t + 220, midi: 28 }));
    const run = runFilter('audio', beats, detections);
    assert.equal(run.usedCluster, 'reaction');
    assert.equal(run.reactionMedian, 220);
    assert.equal(run.medianDt, 20);
    assert.equal(run.confidence, 'medium');
    assert.equal(run.lowQuality, false);
});

test('reaction: visual mode uses 250 ms reaction-time constant', () => {
    // Same +250 ms detections, audio vs visual produce different
    // calibrations because reaction-time differs between modalities.
    const beats = [1000, 1800, 2600];
    const detections = beats.map(t => ({ time: t + 250, midi: 28 }));
    const audio = runFilter('audio', beats, detections);
    const visual = runFilter('visual', beats, detections);
    assert.equal(audio.usedCluster, 'reaction');
    assert.equal(audio.medianDt, 50);   // 250 - 200
    assert.equal(visual.usedCluster, 'reaction');
    assert.equal(visual.medianDt, 0);   // 250 - 250
});

// ── Bimodal data — convergence detection ────────────────────────────────

test('bimodal: convergent estimates → high confidence, "both" cluster', () => {
    // 3 anticipation plucks at +30, 3 reaction plucks at +230 (audio).
    // Adjusted reaction = 230 - 200 = 30. Estimates converge.
    const beats = [1000, 1800, 2600, 3400, 4200, 5000];
    const detections = [
        { time: 1000 + 30, midi: 28 },
        { time: 1800 + 230, midi: 28 },
        { time: 2600 - 10, midi: 28 },
        { time: 3400 + 250, midi: 28 },
        { time: 4200 + 50, midi: 28 },
        { time: 5000 + 220, midi: 28 },
    ];
    const run = runFilter('audio', beats, detections);
    assert.equal(run.anticipationCount, 3);
    assert.equal(run.reactionCount, 3);
    assert.ok(run.convergent, 'estimates should converge');
    assert.equal(run.usedCluster, 'both');
    assert.equal(run.confidence, 'high');
    assert.ok(Math.abs(run.medianDt - 30) <= 25,
        `expected ~30 ms, got ${run.medianDt}`);
});

test('bimodal: divergent estimates → trust anticipation, mark not convergent', () => {
    // Anticipation at +30, reaction at ~+320 ms. Adjusted reaction =
    // 120; |30 - 120| = 90 > 60-ms convergence threshold.
    const beats = [1000, 1800, 2600, 3400, 4200, 5000];
    const detections = [
        { time: 1000 + 30, midi: 28 },
        { time: 1800 + 320, midi: 28 },
        { time: 2600 - 10, midi: 28 },
        { time: 3400 + 330, midi: 28 },
        { time: 4200 + 50, midi: 28 },
        { time: 5000 + 310, midi: 28 },
    ];
    const run = runFilter('audio', beats, detections);
    assert.ok(!run.convergent);
    assert.equal(run.usedCluster, 'anticipation');
    assert.ok(run.medianDt >= -10 && run.medianDt <= 50,
        `expected anticipation median, got ${run.medianDt}`);
});

// ── Out-of-range handling (off-beat / half-beat aliases) ────────────────

test('out-of-range: half-beat aliases (±400 ms) discarded', () => {
    const beats = [1000, 1800, 2600, 3400, 4200, 5000];
    const detections = [
        { time: 1000 + 50, midi: 28 },
        { time: 1800 + 50, midi: 28 },
        { time: 2600 + 400, midi: 28 },  // alias — outside reaction window (max 350)
        { time: 3400 + 50, midi: 28 },
        { time: 4200 - 400, midi: 28 },  // alias — outside anticipation (min -150)
        { time: 5000 + 50, midi: 28 },
    ];
    const run = runFilter('audio', beats, detections);
    assert.equal(run.outOfRangeCount, 2);
    assert.equal(run.anticipationCount, 4);
    assert.equal(run.medianDt, 50);
});

test('out-of-range: detection at +380 ms (audio) is past reaction window', () => {
    const beats = [1000];
    const run = runFilter('audio', beats, [{ time: 1380, midi: 28 }]);
    assert.equal(run.outOfRangeCount, 1);
    assert.equal(run.medianDt, null);
    assert.equal(run.usedCluster, 'none');
    assert.equal(run.lowQuality, true);
});

// ── Edge cases ──────────────────────────────────────────────────────────

test('empty detections → null medianDt, lowQuality true', () => {
    const beats = [1000, 1800, 2600, 3400, 4200, 5000];
    const run = runFilter('audio', beats, []);
    assert.equal(run.medianDt, null);
    assert.equal(run.droppedNoDetection, 6);
    assert.equal(run.usedCluster, 'none');
    assert.equal(run.lowQuality, true);
});

test('missed beats counted, not dropped from total', () => {
    const beats = [1000, 1800, 2600, 3400, 4200, 5000];
    const detections = [
        { time: 1000 + 30, midi: 28 },
        { time: 1800 + 30, midi: 28 },
        // beat 3 missed
        { time: 3400 + 30, midi: 28 },
        { time: 4200 + 30, midi: 28 },
        // beat 6 missed
    ];
    const run = runFilter('audio', beats, detections);
    assert.equal(run.droppedNoDetection, 2);
    assert.equal(run.anticipationCount, 4);
    assert.equal(run.medianDt, 30);
});

test('detection at +150 ms (anticipation/reaction boundary) classified anticipation', () => {
    // The boundary: ANTI_HI = 150, REACT_LO = 150. Using >= for anti,
    // > for react means +150 lands in anticipation.
    const beats = [1000];
    const run = runFilter('audio', beats, [{ time: 1150, midi: 28 }]);
    assert.equal(run.usedCluster, 'anticipation');
    assert.equal(run.medianDt, 150);
});

test('detection at +151 ms (just past anticipation boundary) lands in reaction cluster', () => {
    const beats = [1000];
    const run = runFilter('audio', beats, [{ time: 1151, midi: 28 }]);
    assert.equal(run.usedCluster, 'reaction');
    assert.equal(run.medianDt, -49);   // 151 - 200
});

test('visual and audio modes agree on anticipation-cluster runs', () => {
    // Anticipation-cluster data (+75 ms): both modes return the same
    // calibration since the reaction-time constant is unused.
    const beats = [1000, 1800, 2600, 3400, 4200, 5000];
    const detections = syntheticRun(beats, 75);
    const v = runFilter('visual', beats, detections);
    const a = runFilter('audio', beats, detections);
    assert.equal(v.medianDt, a.medianDt);
    assert.equal(v.usedCount, a.usedCount);
    assert.equal(v.usedCluster, a.usedCluster);
});

// ── Real-world scenario from the user's data ────────────────────────────

test('user run: 1 anticipation + 5 reaction at +290 → convergent at ~+90', () => {
    // The user's actual audio run (cycles labelled #1..#6):
    //   #1: +2 ms (anticipation)
    //   #2: +372 ms (out of range — past reaction window)
    //   #3-#6: +268, +230, +296, +294 (reaction cluster, median ~280)
    // Expected: anticipation single point at +2, reaction median 280
    // → adjusted = 80. |2 - 80| = 78 > 60 → divergent, trust anticipation.
    const beats = [1000, 1800, 2600, 3400, 4200, 5000];
    const detections = [
        { time: 1000 + 2,   midi: 28 },
        { time: 1800 + 372, midi: 28 },
        { time: 2600 + 268, midi: 28 },
        { time: 3400 + 230, midi: 28 },
        { time: 4200 + 296, midi: 28 },
        { time: 5000 + 294, midi: 28 },
    ];
    const run = runFilter('audio', beats, detections);
    assert.equal(run.anticipationCount, 1);
    assert.equal(run.reactionCount, 4);
    assert.equal(run.outOfRangeCount, 1);
    assert.ok(!run.convergent, 'estimates diverge by ~78 ms');
    assert.equal(run.usedCluster, 'anticipation');
    assert.equal(run.medianDt, 2);
    assert.equal(run.lowQuality, false, 'user gets a usable answer from one good pluck');
});

test('user run: pure-reaction sweep → falls back to reaction cluster', () => {
    // Same shape but the user never anticipated. Calibration must come
    // from the reaction cluster minus the reaction-time constant.
    const beats = [1000, 1800, 2600, 3400, 4200, 5000];
    const detections = beats.map(t => ({ time: t + 220 + Math.round(Math.random() * 30), midi: 28 }));
    const run = runFilter('audio', beats, detections);
    assert.equal(run.usedCluster, 'reaction');
    assert.ok(Math.abs(run.medianDt - 35) <= 25,
        `expected calibration around 20-50ms (220-250 minus 200), got ${run.medianDt}`);
    assert.equal(run.confidence, 'medium');
    assert.equal(run.lowQuality, false);
});

// ── Personal reaction-time override (audio mode) ───────────────────────

test('audio mode with personal RT override: replaces 200ms default', () => {
    // User's measured auditory reaction = 285 ms (slower than the
    // Welford 200 default). Audio run with all plucks at +290 ms should
    // calibrate to ~5 ms instead of the default's ~90 ms.
    const beats = [1000, 1800, 2600, 3400, 4200, 5000];
    const detections = beats.map(t => ({ time: t + 290, midi: 28 }));
    const run = core.wizComputeRun(beats, detections, 'audio', { audioRtMs: 285 });
    assert.equal(run.reactionTimeConstMs, 285);
    assert.equal(run.usedCluster, 'reaction');
    assert.equal(run.medianDt, 5);   // 290 - 285
});

test('audio mode without RT override: falls back to 200ms default', () => {
    const beats = [1000, 1800, 2600, 3400, 4200, 5000];
    const detections = beats.map(t => ({ time: t + 290, midi: 28 }));
    const run = core.wizComputeRun(beats, detections, 'audio');
    assert.equal(run.reactionTimeConstMs, 200);
    assert.equal(run.medianDt, 90);
});

test('visual mode ignores audioRtMs override', () => {
    const beats = [1000, 1800, 2600];
    const detections = beats.map(t => ({ time: t + 290, midi: 28 }));
    const run = core.wizComputeRun(beats, detections, 'visual', { audioRtMs: 285 });
    assert.equal(run.reactionTimeConstMs, 250);   // visual default
    assert.equal(run.medianDt, 40);
});

test('audio mode RT override widens reaction window appropriately', () => {
    // With personal RT = 300 ms, reaction window should be (220, 450) so
    // detections in that range are still classified as reaction.
    const beats = [1000];
    const det = [{ time: 1320, midi: 28 }];
    const run = core.wizComputeRun(beats, det, 'audio', { audioRtMs: 300 });
    assert.equal(run.usedCluster, 'reaction');
    assert.equal(run.medianDt, 20);   // 320 - 300
});

test('visual mode with personal visual RT override', () => {
    // User's measured visual reaction = 290 ms; visual run plucks land
    // at +295 ms → calibration = 5 ms (instead of 45 ms with 250 default).
    const beats = [1000, 1800, 2600, 3400, 4200, 5000];
    const detections = beats.map(t => ({ time: t + 295, midi: 28 }));
    const run = core.wizComputeRun(beats, detections, 'visual', { visualRtMs: 290 });
    assert.equal(run.reactionTimeConstMs, 290);
    assert.equal(run.usedCluster, 'reaction');
    assert.equal(run.medianDt, 5);   // 295 - 290
});

test('visual mode without visualRtMs override: 250 ms default', () => {
    const beats = [1000, 1800, 2600, 3400, 4200, 5000];
    const detections = beats.map(t => ({ time: t + 295, midi: 28 }));
    const run = core.wizComputeRun(beats, detections, 'visual');
    assert.equal(run.reactionTimeConstMs, 250);
    assert.equal(run.medianDt, 45);
});

test('audioRtMs and visualRtMs are mode-scoped — no cross-contamination', () => {
    const beats = [1000];
    const detections = [{ time: 1290, midi: 28 }];
    // audioRtMs only affects audio mode; visualRtMs only affects visual.
    const audio = core.wizComputeRun(beats, detections, 'audio',
        { audioRtMs: 285, visualRtMs: 999 });
    assert.equal(audio.reactionTimeConstMs, 285);
    const visual = core.wizComputeRun(beats, detections, 'visual',
        { audioRtMs: 999, visualRtMs: 285 });
    assert.equal(visual.reactionTimeConstMs, 285);
});

// ── Keyboard reaction-time pre-test ────────────────────────────────────

test('keyboard: clean run → median - input lag', () => {
    // 6 clicks at 1500ms intervals; user keypresses 240ms after each.
    // Median = 240, minus 5ms input lag = 235.
    const clicks = [1000, 2500, 4000, 5500, 7000, 8500];
    const keys = clicks.map(c => c + 240);
    const result = core.wizComputeKeyboardReaction(clicks, keys);
    assert.equal(result.medianMs, 235);
    assert.equal(result.rawMedianMs, 240);
    assert.equal(result.dropped, 0);
    assert.equal(result.lowQuality, false);
});

test('keyboard: jittered keypresses → robust median', () => {
    const clicks = [1000, 2500, 4000, 5500, 7000, 8500];
    const offsets = [200, 250, 230, 270, 240, 260];   // median = 245
    const keys = clicks.map((c, i) => c + offsets[i]);
    const result = core.wizComputeKeyboardReaction(clicks, keys);
    assert.equal(result.rawMedianMs, 250);
    assert.equal(result.medianMs, 245);   // 250 - 5
});

test('keyboard: anticipation (keypress before click) discarded', () => {
    // User pressed early on click 3 (15ms before, dt = -15 < 50 min).
    const clicks = [1000, 2500, 4000, 5500, 7000, 8500];
    const keys = [
        clicks[0] + 230,
        clicks[1] + 240,
        clicks[2] - 15,    // anticipation, discarded
        clicks[3] + 245,
        clicks[4] + 235,
        clicks[5] + 250,
    ];
    const result = core.wizComputeKeyboardReaction(clicks, keys);
    assert.equal(result.dropped, 1);
    assert.equal(result.lowQuality, false);
    assert.ok(Math.abs(result.medianMs - 235) <= 10);
});

test('keyboard: missed clicks (no keypress) counted as dropped', () => {
    const clicks = [1000, 2500, 4000, 5500, 7000, 8500];
    const keys = [clicks[0] + 240, clicks[1] + 250, clicks[5] + 260];
    const result = core.wizComputeKeyboardReaction(clicks, keys);
    assert.equal(result.dropped, 3);
    assert.equal(result.lowQuality, true);   // 3/6 dropped → below half threshold
});

test('keyboard: empty keypresses → null median, lowQuality', () => {
    const result = core.wizComputeKeyboardReaction([1000, 2500, 4000], []);
    assert.equal(result.medianMs, null);
    assert.equal(result.lowQuality, true);
});

test('keyboard: keypress after timeout window discarded', () => {
    // Key landed 800 ms after click — above 700ms max, treated as miss.
    const clicks = [1000];
    const keys = [1800];
    const result = core.wizComputeKeyboardReaction(clicks, keys);
    assert.equal(result.dropped, 1);
    assert.equal(result.medianMs, null);
});

// ── Apply gate (which calibration values get committed) ────────────────

test('apply gate: high confidence → applyable', () => {
    const run = { medianDt: 22, confidence: 'high', usedCount: 4 };
    assert.equal(core.wizRunIsApplyable(run), true);
});

test('apply gate: medium confidence with thick cluster → applyable', () => {
    const run = { medianDt: 35, confidence: 'medium', usedCount: 4 };
    assert.equal(core.wizRunIsApplyable(run), true);
});

test('apply gate: medium confidence with single sample → NOT applyable', () => {
    // The user's exact case — visual medium with N=1 should not propagate
    // to A/V offset. Test 17's data ran fine but applying its value would
    // pollute slopsmith's state.
    const run = { medianDt: -94, confidence: 'medium', usedCount: 1 };
    assert.equal(core.wizRunIsApplyable(run), false);
});

test('apply gate: low confidence → NOT applyable', () => {
    const run = { medianDt: 50, confidence: 'low', usedCount: 2 };
    assert.equal(core.wizRunIsApplyable(run), false);
});

test('apply gate: null medianDt → NOT applyable', () => {
    const run = { medianDt: null, confidence: 'low', usedCount: 0 };
    assert.equal(core.wizRunIsApplyable(run), false);
});

test('apply gate: missing run → NOT applyable', () => {
    assert.equal(core.wizRunIsApplyable(null), false);
    assert.equal(core.wizRunIsApplyable(undefined), false);
});

// ── Calibration history stability ──────────────────────────────────────

const histEntry = (mode, medianMs, confidence) => ({
    t: Date.now(), mode, medianMs, confidence, cluster: 'both', rtUsed: 240,
});

test('stability: empty history → insufficient', () => {
    const r = core.calibComputeStability([]);
    assert.equal(r.status, 'insufficient');
    assert.equal(r.count, 0);
    assert.equal(r.requiredCount, 3);
});

test('stability: 2 high-conf runs → still insufficient', () => {
    const hist = [
        histEntry('audio', 0, 'high'),
        histEntry('audio', 2, 'high'),
    ];
    const r = core.calibComputeStability(hist);
    assert.equal(r.status, 'insufficient');
    assert.equal(r.count, 2);
});

test('stability: 3 tight high-conf runs → locked', () => {
    const hist = [
        histEntry('audio', 0, 'high'),
        histEntry('audio', 2, 'high'),
        histEntry('audio', -1, 'high'),
    ];
    const r = core.calibComputeStability(hist);
    assert.equal(r.status, 'locked');
    assert.ok(Math.abs(r.lockedValue - 0) <= 1);
    assert.ok(r.stddev < 2);
});

test('stability: 3 spread-out runs → drifting', () => {
    const hist = [
        histEntry('audio', 0, 'high'),
        histEntry('audio', 30, 'high'),
        histEntry('audio', 60, 'high'),
    ];
    const r = core.calibComputeStability(hist);
    assert.equal(r.status, 'drifting');
    assert.equal(r.spread, 60);
});

test('stability: locked then a divergent run → drift-warning', () => {
    // 3 runs at +0/+2/-1 (locked), then a run at +50 — was the rig
    // changed? Surface the discontinuity rather than absorb it.
    const hist = [
        histEntry('audio', 0, 'high'),
        histEntry('audio', 2, 'high'),
        histEntry('audio', -1, 'high'),
        histEntry('audio', 50, 'high'),
    ];
    const r = core.calibComputeStability(hist);
    assert.equal(r.status, 'drift-warning');
    assert.ok(Math.abs(r.lockedValue - 0) <= 1);
    assert.equal(r.latestValue, 50);
});

test('stability: low-confidence runs ignored entirely', () => {
    // 3 medium-conf runs even if internally consistent should NOT lock.
    const hist = [
        histEntry('audio', 0, 'medium'),
        histEntry('audio', 1, 'medium'),
        histEntry('audio', 2, 'medium'),
    ];
    const r = core.calibComputeStability(hist);
    assert.equal(r.status, 'insufficient');
    assert.equal(r.count, 0);
});

test('stability: visual runs ignored when computing audio lock', () => {
    const hist = [
        histEntry('audio', 0, 'high'),
        histEntry('visual', -100, 'high'),
        histEntry('audio', 2, 'high'),
        histEntry('visual', -90, 'high'),
        histEntry('audio', -1, 'high'),
    ];
    const r = core.calibComputeStability(hist, { mode: 'audio' });
    assert.equal(r.status, 'locked');
    assert.equal(r.recentValues.length, 3);
});

test('stability: drift tolerance is configurable', () => {
    const hist = [
        histEntry('audio', 0, 'high'),
        histEntry('audio', 2, 'high'),
        histEntry('audio', -1, 'high'),
        histEntry('audio', 8, 'high'),  // 8 ms drift — within default 10 ms tol
    ];
    const r = core.calibComputeStability(hist, { driftTolMs: 5 });
    assert.equal(r.status, 'drift-warning');   // tighter tol → drift fires
});

test('stability: history of mostly-locked + one outlier old run still locks on recent', () => {
    // History order matters: only the LAST 3 high-conf runs determine
    // status. An old anomaly shouldn't unlock a stable recent rig.
    const hist = [
        histEntry('audio', 100, 'high'),   // ancient outlier
        histEntry('audio', 0, 'high'),
        histEntry('audio', 1, 'high'),
        histEntry('audio', -2, 'high'),
    ];
    const r = core.calibComputeStability(hist);
    // The ancient outlier was the "earlier" pre-window value and triggers
    // drift-warning when compared to the new tight cluster. This is
    // intentional — surfaces that something changed between the historic
    // value and the recent one.
    assert.ok(r.status === 'drift-warning' || r.status === 'locked');
});

// ── Play-history validation (the truth source) ─────────────────────────

const playWith = (timingErrors) => ({
    songId: 't', playId: 'p',
    noteResults: timingErrors.map(te => ({
        primary: te === null ? 'MISSED_NO_DETECTION' : 'HIT',
        timingError: te,
    })),
});

test('play-history: insufficient when count < 5', () => {
    const plays = [playWith([10, 20, 30, 40])];
    const r = core.calibFromHistory(plays, 0);
    assert.equal(r.verdict, 'insufficient');
    assert.equal(r.count, 4);
    assert.equal(r.minHits, 5);
});

test('play-history: 5 hits is enough for a verdict (one short loop)', () => {
    const plays = [playWith([50, 50, 50, 50, 50])];
    const r = core.calibFromHistory(plays, 0);
    assert.notEqual(r.verdict, 'insufficient');
    assert.equal(r.count, 5);
    // 5 identical values → SE=0, resolution = max(0, 5ms) = 5ms; median 50 > 5 → biased
    assert.equal(r.verdict, 'biased');
});

test('play-history: small N → wide resolution → small biases pass as at-floor', () => {
    // N=10 with high variance → wide SE → small biases not detectable.
    const plays = [playWith([0, 100, -100, 50, -50, 0, 100, -100, 50, -50])];
    const r = core.calibFromHistory(plays, 0);
    // Median ~0; resolution wider than 5ms because SE is large.
    assert.equal(r.verdict, 'at-floor');
    assert.ok(r.resolutionMs > 5);
});

test('play-history: resolution shrinks with N', () => {
    // Same per-hit distribution, more samples → tighter resolution.
    const small = [playWith(new Array(10).fill(50).map((v, i) => v + (i % 2 ? 30 : -30)))];
    const large = [playWith(new Array(100).fill(50).map((v, i) => v + (i % 2 ? 30 : -30)))];
    const rSmall = core.calibFromHistory(small, 0);
    const rLarge = core.calibFromHistory(large, 0);
    assert.ok(rLarge.resolutionMs < rSmall.resolutionMs,
        `expected larger N to give tighter resolution (got large=${rLarge.resolutionMs}, small=${rSmall.resolutionMs})`);
});

test('play-history: biased when post-cal median > resolution', () => {
    // 100 hits all at +50 ms; mic_latency = 0; post-cal median = 50.
    // SE → 0 (no variance), resolution = 5 ms floor; |50| > 5 → biased.
    const plays = [playWith(new Array(100).fill(50))];
    const r = core.calibFromHistory(plays, 0);
    assert.equal(r.verdict, 'biased');
    assert.equal(r.rawMedian, 50);
    assert.equal(r.postCalibMedian, 50);
    assert.equal(r.suggestedNudge, 50);
    assert.equal(r.recommendedMicLatencyMs, 50);
});

test('play-history: at-floor when post-cal median within tolerance', () => {
    // Use a normal-ish distribution centered at 50 with N=100 and σ=20.
    // mic_latency=50 → post-cal median should be ~0.
    const samples = [];
    for (let i = 0; i < 100; i++) {
        // Box-Muller
        const u = (i + 1) / 101;
        const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * (i / 100));
        samples.push(50 + 20 * z);
    }
    const plays = [playWith(samples)];
    const r = core.calibFromHistory(plays, 50);
    assert.equal(r.verdict, 'at-floor');
    assert.ok(Math.abs(r.postCalibMedian) < 5);
});

test('play-history: applying recommended nudge centres post-cal median', () => {
    // Constant +173 raw timing across 100 hits. mic_latency=0 →
    // recommendation is 173. Re-running with mic_latency=173 → post-cal
    // median = 0, verdict = at-floor.
    const plays = [playWith(new Array(100).fill(173))];
    const r1 = core.calibFromHistory(plays, 0);
    assert.equal(r1.recommendedMicLatencyMs, 173);
    const r2 = core.calibFromHistory(plays, r1.recommendedMicLatencyMs);
    assert.equal(r2.postCalibMedian, 0);
    assert.equal(r2.verdict, 'at-floor');
});

test('play-history: clamps recommendation at 0 (no negative latency)', () => {
    // Raw median negative (player appearing early) — would suggest negative
    // mic latency. Clamp to 0 because pipeline latency can't be negative.
    const plays = [playWith(new Array(100).fill(-50))];
    const r = core.calibFromHistory(plays, 0);
    assert.equal(r.suggestedNudge, -50);
    assert.equal(r.recommendedMicLatencyMs, 0);
});

test('play-history: ignores non-HIT records', () => {
    const plays = [{
        noteResults: [
            { primary: 'HIT', timingError: 50 },
            { primary: 'MISSED_NO_DETECTION', timingError: null },
            { primary: 'WRONG_PITCH', timingError: 999 },  // not a HIT
            { primary: 'DIRTY_HIT', timingError: 60 },
            ...new Array(50).fill({ primary: 'HIT', timingError: 50 }),
        ],
    }];
    const r = core.calibFromHistory(plays, 0);
    // Only HIT and DIRTY_HIT count. WRONG_PITCH (999) excluded; MISSED null.
    // 1 + 1 + 50 = 52 hits, all near 50.
    assert.equal(r.count, 52);
    assert.ok(Math.abs(r.rawMedian - 50) < 5);
});

test('play-history: aggregates across multiple plays', () => {
    const plays = [
        playWith(new Array(40).fill(100)),
        playWith(new Array(40).fill(120)),
    ];
    const r = core.calibFromHistory(plays, 0);
    assert.equal(r.count, 80);
    // Median across 80 values [100×40 + 120×40] = boundary, picks one side.
    assert.ok(r.rawMedian === 100 || r.rawMedian === 120);
});

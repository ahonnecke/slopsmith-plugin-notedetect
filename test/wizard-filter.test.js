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

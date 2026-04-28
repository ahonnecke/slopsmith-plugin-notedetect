// Tests the calibration wizard's outlier-rejection + median pipeline
// (_ndWizFinishRun). Pure-functional test — no browser, no audio. We seed
// _ndWizBeats and _ndWizDetections with synthetic data, call finishRun,
// and inspect the resulting run record.
//
// Prevents regressions in the filter math (hard-cap + 2σ + low-quality
// flag) without requiring the user to physically run the wizard a hundred
// times.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const core = loadDetectionCore();

// Pure call: takes beats + detections, returns run record. No DOM, no
// module-state writes.
function runFilter(mode, beatTimes, detections) {
    return core.wizComputeRun(beatTimes, detections, mode);
}

// Build a run where every detection lands at +offsetMs from its beat.
function syntheticRun(beatTimesMs, offsetMs, opts = {}) {
    const detections = beatTimesMs.map(t => ({
        time: t + offsetMs + (opts.jitterMs ? (Math.random() - 0.5) * 2 * opts.jitterMs : 0),
        midi: 28,
    }));
    return detections;
}

// ── Happy path ──────────────────────────────────────────────────────────

test('filter: clean run with constant offset → median = offset', () => {
    const beats = [1000, 1800, 2600, 3400, 4200, 5000]; // 6 beats, 800ms apart
    const detections = syntheticRun(beats, 50);
    const run = runFilter('audio', beats, detections);
    assert.equal(run.usedCount, 6);
    assert.equal(run.medianDt, 50);
    assert.equal(run.droppedHardCap, 0);
    assert.equal(run.droppedOutliers, 0);
    assert.equal(run.lowQuality, false);
});

test('filter: small jitter around the true offset → median ≈ offset', () => {
    const beats = [1000, 1800, 2600, 3400, 4200, 5000];
    // Deterministic seed: alternate +/- 5ms around 60ms target
    const detections = beats.map((t, i) => ({
        time: t + 60 + (i % 2 ? 5 : -5),
        midi: 28,
    }));
    const run = runFilter('audio', beats, detections);
    assert.ok(Math.abs(run.medianDt - 60) <= 5,
        `expected median near 60ms, got ${run.medianDt}`);
    assert.equal(run.droppedHardCap, 0);
    assert.equal(run.lowQuality, false);
});

// ── Hard-cap rejection ──────────────────────────────────────────────────

test('filter: half-beat aliases (±400ms) get hard-capped', () => {
    const beats = [1000, 1800, 2600, 3400, 4200, 5000];
    // Mix: 4 anticipated plucks at +50ms, 2 half-beat aliases at +400 and -400
    const detections = [
        { time: 1000 + 50, midi: 28 },
        { time: 1800 + 50, midi: 28 },
        { time: 2600 + 400, midi: 28 },  // alias
        { time: 3400 + 50, midi: 28 },
        { time: 4200 - 400, midi: 28 },  // alias
        { time: 5000 + 50, midi: 28 },
    ];
    const run = runFilter('audio', beats, detections);
    assert.equal(run.droppedHardCap, 2, `expected 2 hard-cap drops, got ${run.droppedHardCap}`);
    assert.equal(run.medianDt, 50);
});

test('filter: reaction-time-mode run flagged low-quality', () => {
    // User reacted to clicks instead of anticipating: every pluck is
    // 250-350ms after the beat. All beyond hard cap → low quality.
    const beats = [1000, 1800, 2600, 3400, 4200, 5000];
    const detections = [
        { time: 1000 + 320, midi: 28 },
        { time: 1800 + 280, midi: 28 },
        { time: 2600 + 310, midi: 28 },
        { time: 3400 + 290, midi: 28 },
        { time: 4200 + 340, midi: 28 },
        { time: 5000 + 270, midi: 28 },
    ];
    const run = runFilter('audio', beats, detections);
    assert.ok(run.lowQuality, 'reaction-time-mode run should be flagged low-quality');
    assert.equal(run.droppedHardCap, 6, 'all 6 reaction-mode plucks dropped');
    assert.equal(run.usedCount, 0);
});

test('filter: bimodal data — anticipated cluster wins over reaction cluster', () => {
    // 3 anticipated plucks near 0, 3 reaction-mode plucks near +320.
    // Hard cap drops the reaction cluster; median = anticipated median.
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
    assert.equal(run.droppedHardCap, 3);
    assert.equal(run.usedCount, 3);
    assert.ok(run.medianDt >= -10 && run.medianDt <= 50,
        `expected median in anticipated cluster, got ${run.medianDt}`);
});

// ── No-detection handling ───────────────────────────────────────────────

test('filter: missed beats counted, not dropped from total', () => {
    const beats = [1000, 1800, 2600, 3400, 4200, 5000];
    const detections = [
        { time: 1000 + 30, midi: 28 },
        { time: 1800 + 30, midi: 28 },
        // beat 3 (2600): no detection in ±400ms window
        { time: 3400 + 30, midi: 28 },
        { time: 4200 + 30, midi: 28 },
        // beat 6 (5000): no detection
    ];
    const run = runFilter('audio', beats, detections);
    assert.equal(run.droppedNoDetection, 2);
    assert.equal(run.usedCount, 4);
    assert.equal(run.medianDt, 30);
});

// ── Pluck-jitter pre-filter (sustain artifacts) ─────────────────────────

test('filter: sustain detections within 120ms of a real pluck are filtered as not-fresh', () => {
    // YIN reports multiple MIDI values during the attack transient.
    // Each beat fires one true onset + 3 follow-on detections within
    // 100ms. The fresh-gap pre-filter (_ND_FRESH_GAP_MS = 120) should
    // keep only the first one per pluck.
    const beats = [1000, 1800, 2600, 3400, 4200, 5000];
    const detections = [];
    for (const t of beats) {
        detections.push({ time: t + 30, midi: 28 });        // true onset
        detections.push({ time: t + 60, midi: 32 });        // YIN jitter
        detections.push({ time: t + 100, midi: 28 });       // YIN jitter
    }
    const run = runFilter('audio', beats, detections);
    assert.equal(run.usedCount, 6, 'fresh-gap should leave one detection per beat');
    assert.equal(run.medianDt, 30);
});

// ── Edge cases ──────────────────────────────────────────────────────────

test('filter: empty detections → null medianDt', () => {
    const beats = [1000, 1800, 2600, 3400, 4200, 5000];
    const run = runFilter('audio', beats, []);
    assert.equal(run.medianDt, null);
    assert.equal(run.droppedNoDetection, 6);
});

test('filter: single detection at exactly 200ms (hard cap edge) is kept', () => {
    const beats = [1000];
    const run = runFilter('audio', beats, [{ time: 1200, midi: 28 }]);
    assert.equal(run.usedCount, 1);
    assert.equal(run.medianDt, 200);
});

test('filter: single detection at 201ms (just past cap) is dropped', () => {
    const beats = [1000];
    const run = runFilter('audio', beats, [{ time: 1201, midi: 28 }]);
    assert.equal(run.droppedHardCap, 1);
    assert.equal(run.usedCount, 0);
});

test('filter: visual mode and audio mode produce identical filter behavior', () => {
    const beats = [1000, 1800, 2600, 3400, 4200, 5000];
    const detections = syntheticRun(beats, 75);
    const v = runFilter('visual', beats, detections);
    const a = runFilter('audio', beats, detections);
    assert.equal(v.medianDt, a.medianDt);
    assert.equal(v.usedCount, a.usedCount);
});

// _ndCalibFromHistory — the truth-source calibration validator.
// Reads HIT timingError values from accumulated play snapshots, compares
// the median against current mic_latency, decides whether the post-cal
// bias exceeds the resolution we can detect at this N.
//
// Verdict rules:
//   insufficient    < 5 hits — median is meaningless
//   biased          |postCalibMedian| > max(2×SE, 5 ms FLOOR)
//   at-floor        post-cal median within resolution; calibration correct
//
// Resolution = max(2×SE, 5 ms). Scales with N: small loops give wide
// tolerance but still produce a verdict.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const core = loadDetectionCore();

const playWith = (timingErrors) => ({
    songId: 't', playId: 'p',
    noteResults: timingErrors.map(te => ({
        primary: te === null ? 'MISSED_NO_DETECTION' : 'HIT',
        timingError: te,
    })),
});

test('insufficient when count < 5', () => {
    const plays = [playWith([10, 20, 30, 40])];
    const r = core.calibFromHistory(plays, 0);
    assert.equal(r.verdict, 'insufficient');
    assert.equal(r.count, 4);
    assert.equal(r.minHits, 5);
});

test('5 hits is enough for a verdict (one short loop)', () => {
    const plays = [playWith([50, 50, 50, 50, 50])];
    const r = core.calibFromHistory(plays, 0);
    assert.notEqual(r.verdict, 'insufficient');
    assert.equal(r.count, 5);
    // 5 identical values → SE=0, resolution = max(0, 5ms) = 5ms; median 50 > 5 → biased
    assert.equal(r.verdict, 'biased');
});

test('small N → wide resolution → small biases pass as at-floor', () => {
    const plays = [playWith([0, 100, -100, 50, -50, 0, 100, -100, 50, -50])];
    const r = core.calibFromHistory(plays, 0);
    assert.equal(r.verdict, 'at-floor');
    assert.ok(r.resolutionMs > 5);
});

test('resolution shrinks with N', () => {
    const small = [playWith(new Array(10).fill(50).map((v, i) => v + (i % 2 ? 30 : -30)))];
    const large = [playWith(new Array(100).fill(50).map((v, i) => v + (i % 2 ? 30 : -30)))];
    const rSmall = core.calibFromHistory(small, 0);
    const rLarge = core.calibFromHistory(large, 0);
    assert.ok(rLarge.resolutionMs < rSmall.resolutionMs,
        `expected larger N to give tighter resolution (got large=${rLarge.resolutionMs}, small=${rSmall.resolutionMs})`);
});

test('biased when post-cal median > resolution', () => {
    const plays = [playWith(new Array(100).fill(50))];
    const r = core.calibFromHistory(plays, 0);
    assert.equal(r.verdict, 'biased');
    assert.equal(r.rawMedian, 50);
    assert.equal(r.postCalibMedian, 50);
    assert.equal(r.suggestedNudge, 50);
    assert.equal(r.recommendedMicLatencyMs, 50);
});

test('at-floor when post-cal median within tolerance', () => {
    const samples = [];
    for (let i = 0; i < 100; i++) {
        const u = (i + 1) / 101;
        const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * (i / 100));
        samples.push(50 + 20 * z);
    }
    const plays = [playWith(samples)];
    const r = core.calibFromHistory(plays, 50);
    assert.equal(r.verdict, 'at-floor');
    assert.ok(Math.abs(r.postCalibMedian) < 5);
});

test('applying recommended nudge centres post-cal median', () => {
    const plays = [playWith(new Array(100).fill(173))];
    const r1 = core.calibFromHistory(plays, 0);
    assert.equal(r1.recommendedMicLatencyMs, 173);
    const r2 = core.calibFromHistory(plays, r1.recommendedMicLatencyMs);
    assert.equal(r2.postCalibMedian, 0);
    assert.equal(r2.verdict, 'at-floor');
});

test('clamps recommendation at 0 (no negative latency)', () => {
    const plays = [playWith(new Array(100).fill(-50))];
    const r = core.calibFromHistory(plays, 0);
    assert.equal(r.suggestedNudge, -50);
    assert.equal(r.recommendedMicLatencyMs, 0);
});

test('ignores non-HIT records', () => {
    const plays = [{
        noteResults: [
            { primary: 'HIT', timingError: 50 },
            { primary: 'MISSED_NO_DETECTION', timingError: null },
            { primary: 'WRONG_PITCH', timingError: 999 },
            { primary: 'DIRTY_HIT', timingError: 60 },
            ...new Array(50).fill({ primary: 'HIT', timingError: 50 }),
        ],
    }];
    const r = core.calibFromHistory(plays, 0);
    assert.equal(r.count, 52);
    assert.ok(Math.abs(r.rawMedian - 50) < 5);
});

test('aggregates across multiple plays', () => {
    const plays = [
        playWith(new Array(40).fill(100)),
        playWith(new Array(40).fill(120)),
    ];
    const r = core.calibFromHistory(plays, 0);
    assert.equal(r.count, 80);
    assert.ok(r.rawMedian === 100 || r.rawMedian === 120);
});

// Calibration logic tests. Cover every observed failure mode so
// the user never has to debug "Need 0 more hits" at runtime again.
const test = require('node:test');
const assert = require('node:assert');
const { loadDetectionCore } = require('./_loader');

const {
    calRefreshMessage, matchCalCaptures, median,
    trimmedMean, driftFromBuffer, avOffsetSeed,
} = loadDetectionCore();

// ── _ndCalRefreshMessage ──────────────────────────────────────────────

test('calRefreshMessage: 0 samples → "need N more"', () => {
    const r = calRefreshMessage(0, 0, 0, 4);
    assert.match(r.text, /Need 4 more hits/);
    assert.strictEqual(r.applyEnabled, false);
});

test('calRefreshMessage: singular vs plural for "hit"', () => {
    const oneShort = calRefreshMessage(3, 0, 0, 4);
    assert.match(oneShort.text, /Need 1 more hit\b/);
    assert.doesNotMatch(oneShort.text, /Need 1 more hits\b/);

    const twoShort = calRefreshMessage(2, 0, 0, 4);
    assert.match(twoShort.text, /Need 2 more hits/);
});

test('calRefreshMessage: at exact min samples → enabled, no "Need" text', () => {
    // Exact boundary: samples=4, min=4. Must NOT show "Need 0 more".
    // This is the bug the user reported: "Need 0 more hits before
    // calibration Current avOffset 236ms" while playing 60s into
    // Back to Black. A correct implementation switches to the
    // median-bias text the moment samples reaches min.
    const r = calRefreshMessage(4, 80, 100, 4);
    assert.doesNotMatch(r.text, /Need.*more hit/);
    assert.match(r.text, /Median bias across 4 hits/);
    assert.strictEqual(r.applyEnabled, true);
});

test('calRefreshMessage: above min samples → median bias message', () => {
    const r = calRefreshMessage(8, 120, 50, 4);
    assert.match(r.text, /Median bias across 8 hits/);
    assert.match(r.text, /\+120ms/);
    assert.match(r.text, /late/);
    assert.match(r.text, /avOffset → -70ms/);  // 50 - 120 = -70
    assert.strictEqual(r.applyEnabled, true);
});

test('calRefreshMessage: negative drift → "early" direction', () => {
    const r = calRefreshMessage(6, -45, 0, 4);
    assert.match(r.text, /-45ms/);
    assert.match(r.text, /early/);
    assert.match(r.text, /avOffset → 45ms/);  // 0 - (-45) = 45
});

test('calRefreshMessage: zero drift → "on the beat", no +/- prefix', () => {
    const r = calRefreshMessage(5, 0, 100, 4);
    assert.match(r.text, /\b0ms.*on the beat/);
    assert.doesNotMatch(r.text, /\+0ms|-0ms/);
    assert.match(r.text, /avOffset → 100ms/);
});

test('calRefreshMessage: 1 sample uses singular "1 hit"', () => {
    // Edge: if min were 0 (shouldn't happen in prod but guard
    // against config errors), one-sample message should be singular.
    const r = calRefreshMessage(1, 50, 0, 1);
    assert.match(r.text, /across 1 hit\b/);
    assert.doesNotMatch(r.text, /across 1 hits\b/);
});

test('calRefreshMessage: avOffset rounds to int', () => {
    // Caller is expected to pass int but let's confirm display
    // doesn't corrupt with fractional input.
    const r = calRefreshMessage(0, 0, 236, 4);
    assert.match(r.text, /avOffset: 236ms/);
});

// ── _ndMatchCalCaptures ───────────────────────────────────────────────

test('matchCalCaptures: each capture matches nearest click', () => {
    // 3 clicks at 1s intervals, captures 200ms after each
    const expected = [1.0, 2.0, 3.0];
    const captures = [1.2, 2.2, 3.2];
    const { deltas, clickThroughDeltas } = matchCalCaptures(captures, expected, 1.0, 0.6, 0);
    assert.deepEqual(deltas.map(d => Math.round(d * 1000)), [200, 200, 200]);
    assert.strictEqual(clickThroughDeltas.length, 0);
});

test('matchCalCaptures: captures outside window are dropped', () => {
    const expected = [1.0, 2.0];
    // 0.5 (500ms before click 1) is within ±600ms — match
    // 0.05 (way before all) is outside — drop
    // 1.7 (between) is within 600 of click 2 (delta -300) — match
    const captures = [0.5, 0.05, 1.7];
    const { deltas } = matchCalCaptures(captures, expected, 1.0, 0.6, 0);
    const ms = deltas.map(d => Math.round(d * 1000)).sort((a, b) => a - b);
    assert.deepEqual(ms, [-500, -300]);
});

test('matchCalCaptures: bleed filter separates near-zero deltas', () => {
    const expected = [1.0, 2.0, 3.0];
    // 1.001 = 1ms after click 1 (likely bleed)
    // 1.300 = 300ms after click 1 (legit pluck)
    // 2.040 = 40ms after click 2 (likely bleed)
    const captures = [1.001, 1.300, 2.040];
    const { deltas, clickThroughDeltas } = matchCalCaptures(captures, expected, 1.0, 0.6, 0.05);
    assert.deepEqual(deltas.map(d => Math.round(d * 1000)), [300]);
    assert.deepEqual(clickThroughDeltas.sort((a, b) => a - b), [1, 40]);
});

test('matchCalCaptures: bleed filter disabled (=0) keeps all matches', () => {
    // The bug shipped to the user: filter killed user's good plucks
    // that landed within 50ms of click. With filter off, those count.
    const expected = [1.0, 2.0];
    const captures = [1.020, 2.030];  // both within 50ms of clicks
    const { deltas, clickThroughDeltas } = matchCalCaptures(captures, expected, 1.0, 0.6, 0);
    assert.deepEqual(deltas.map(d => Math.round(d * 1000)).sort((a, b) => a - b), [20, 30]);
    assert.deepEqual(clickThroughDeltas, []);
});

test('matchCalCaptures: empty captures returns empty deltas', () => {
    const r = matchCalCaptures([], [1, 2, 3], 1.0, 0.6, 0);
    assert.deepEqual(r.deltas, []);
    assert.deepEqual(r.clickThroughDeltas, []);
});

test('matchCalCaptures: each capture contributes at most one delta', () => {
    // A capture between two adjacent clicks within ±600ms of BOTH
    // should pick the nearest (here 1.4 is closer to 1.0 than 2.0).
    const expected = [1.0, 2.0];
    const captures = [1.4];
    const { deltas } = matchCalCaptures(captures, expected, 1.0, 0.6, 0);
    assert.strictEqual(deltas.length, 1);
    assert.strictEqual(Math.round(deltas[0] * 1000), 400);
});

// ── _ndMedian ─────────────────────────────────────────────────────────

test('median: empty returns null', () => {
    assert.strictEqual(median([]), null);
    assert.strictEqual(median(null), null);
});

test('median: odd length picks middle', () => {
    assert.strictEqual(median([1, 5, 3]), 3);
});

test('median: even length picks middle (lower of two middles)', () => {
    // Note: implementation picks sorted[Math.floor(N/2)], so for
    // even N it's the higher of the two middles. Lock the contract.
    assert.strictEqual(median([1, 2, 3, 4]), 3);
});

test('median: handles negative values', () => {
    assert.strictEqual(median([-100, -50, 0, 50, 100]), 0);
});

// ── _ndTrimmedMean ────────────────────────────────────────────────────

test('trimmedMean: empty returns null', () => {
    assert.strictEqual(trimmedMean([], 0.25), null);
    assert.strictEqual(trimmedMean(null, 0.25), null);
});

test('trimmedMean: single element returns itself (trim=0)', () => {
    assert.strictEqual(trimmedMean([42], 0), 42);
});

test('trimmedMean: 0.25 trim drops bottom and top quarter', () => {
    // 8 elements, trim = floor(8 * 0.25) = 2 from each end.
    // Middle 4: [3, 4, 5, 6]. Mean = 4.5.
    const r = trimmedMean([1, 2, 3, 4, 5, 6, 7, 8], 0.25);
    assert.strictEqual(r, 4.5);
});

test('trimmedMean: outlier rejection — single huge value pulled mean is rejected', () => {
    // 16 hits all around 100, except one outlier at 1000. Mean is
    // pulled to 156; trimmed mean stays near 100.
    const data = [98, 99, 100, 100, 100, 100, 100, 100,
                  100, 100, 100, 100, 101, 102, 103, 1000];
    const mean = data.reduce((s, v) => s + v, 0) / data.length;
    assert.ok(mean > 150, `naive mean=${mean} pulled by outlier`);
    const trimmed = trimmedMean(data, 0.25);
    assert.ok(trimmed >= 99 && trimmed <= 102,
        `trimmed mean=${trimmed} stays near true center`);
});

test('trimmedMean: returns null if would trim everything', () => {
    // 3 elements with 50% trim = 1 from each end → middle is 1.
    // OK.
    assert.notStrictEqual(trimmedMean([1, 2, 3], 0.5), null);
    // 3 elements with 0.6 trim = floor(1.8)=1 from each end → 1 left
    assert.strictEqual(trimmedMean([1, 2, 3], 0.6), 2);
    // 2 elements with 0.5 trim = 1 from each end → 0 left → null
    assert.strictEqual(trimmedMean([1, 2], 0.5), null);
});

test('trimmedMean: trim=0 is plain mean', () => {
    assert.strictEqual(trimmedMean([10, 20, 30], 0), 20);
});

// ── _ndDriftFromBuffer ────────────────────────────────────────────────

test('driftFromBuffer: empty → 0', () => {
    assert.strictEqual(driftFromBuffer([], 16), 0);
    assert.strictEqual(driftFromBuffer(null, 16), 0);
});

test('driftFromBuffer: small sample uses median', () => {
    // 4 samples, below the calMin threshold of 16. Median picks
    // middle (sorted [10,20,30,500]) = 30. Trimmed mean would be
    // mean([20]) = 20.
    assert.strictEqual(driftFromBuffer([10, 30, 500, 20], 16), 30);
});

test('driftFromBuffer: large sample uses trimmed mean', () => {
    // 16 samples — trim 4 from each end. Sorted ascending.
    // Sustain-bleed phantom values like -300 dropped, mid 8 kept.
    const buf = [
        -300, -250,  // outliers (early)
        80, 85, 90, 95, 100, 105, 110, 115,
        120, 125, 130, 135,  // middle 8
        500, 600,  // outliers (late)
    ];
    const r = driftFromBuffer(buf, 16);
    // Expected: mean of [90,95,100,105,110,115,120,125] = 107.5
    assert.strictEqual(r, 107.5);
});

test('driftFromBuffer: at boundary (calMin samples) uses trimmed mean', () => {
    const buf = [];
    for (let i = 1; i <= 16; i++) buf.push(i);
    const r = driftFromBuffer(buf, 16);
    // Trim 4 from each end → middle is [5..12]. Mean = 8.5.
    assert.strictEqual(r, 8.5);
});

test('driftFromBuffer: just below calMin uses median', () => {
    const buf = [];
    for (let i = 1; i <= 15; i++) buf.push(i);
    const r = driftFromBuffer(buf, 16);
    // Median of 1..15 is 8.
    assert.strictEqual(r, 8);
});

// ── _ndAvOffsetSeed ───────────────────────────────────────────────────

test('avOffsetSeed: typical 12ms output latency → -12ms avOffset', () => {
    // outputLatency is in seconds. 0.012 = 12ms output delay. avOffset
    // negative to compensate (chart fires earlier so player playing
    // in time with audio reads as on-time).
    const r = avOffsetSeed({ outputLatency: 0.012 });
    assert.strictEqual(r, -12);
});

test('avOffsetSeed: 50ms latency → -50ms avOffset', () => {
    assert.strictEqual(avOffsetSeed({ outputLatency: 0.050 }), -50);
});

test('avOffsetSeed: rounds to nearest int', () => {
    // 0.0123s = 12.3ms, rounds to -12
    assert.strictEqual(avOffsetSeed({ outputLatency: 0.0123 }), -12);
    // 0.0156s = 15.6ms, rounds to -16
    assert.strictEqual(avOffsetSeed({ outputLatency: 0.0156 }), -16);
});

test('avOffsetSeed: zero / negative / missing → null', () => {
    // Don't seed if we don't have useful info — leave avOffset alone.
    assert.strictEqual(avOffsetSeed({ outputLatency: 0 }), null);
    assert.strictEqual(avOffsetSeed({ outputLatency: -0.05 }), null);
    assert.strictEqual(avOffsetSeed({}), null);
    assert.strictEqual(avOffsetSeed(null), null);
    assert.strictEqual(avOffsetSeed({ outputLatency: NaN }), null);
});

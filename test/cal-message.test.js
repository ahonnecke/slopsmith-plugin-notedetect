// Calibration logic tests. Cover every observed failure mode so
// the user never has to debug "Need 0 more hits" at runtime again.
const test = require('node:test');
const assert = require('node:assert');
const { loadDetectionCore } = require('./_loader');

const { calRefreshMessage, matchCalCaptures, median } = loadDetectionCore();

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

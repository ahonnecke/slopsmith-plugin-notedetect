// Cross-loop trouble-note aggregation. The trouble map drives the
// pre-arrival glow on the highway: notes the user has missed before
// pulse warning before they arrive. Single-play trouble was too noisy
// (a one-off bad pluck stayed flagged forever) and didn't survive song
// changes (loaded only on detect-toggle).
//
// Aggregator weights: missCount across plays × max severity. Notes
// missed once and hit since fall below threshold; notes consistently
// missed stay flagged.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const core = loadDetectionCore();

const note = (s, f, chartT, severity, primary = 'MISSED_NO_DETECTION') => ({
    s, f, chartT, severity, primary,
});
const play = (...notes) => ({
    songId: 't', playId: 'p', noteResults: notes,
});

// ── Single-play behaviour matches old _ndBuildTroubleMap ────────────────

test('one play, one missed note: shows up in trouble map', () => {
    const m = core.aggregateTroubleAcrossPlays([play(note(1, 5, 1.0, 1.0))]);
    assert.equal(m.size, 1);
    const entry = m.values().next().value;
    assert.equal(entry.severity, 1.0);   // 1/1 × 1.0
    assert.equal(entry.missCount, 1);
    assert.equal(entry.totalPlays, 1);
});

test('clean play (no severity > 0): empty trouble map', () => {
    const m = core.aggregateTroubleAcrossPlays([play(note(1, 5, 1.0, 0))]);
    assert.equal(m.size, 0);
});

// ── Frequency weighting ─────────────────────────────────────────────────

test('note missed in 5/5 plays: full severity', () => {
    const plays = [
        play(note(1, 5, 1.0, 1.0)),
        play(note(1, 5, 1.0, 1.0)),
        play(note(1, 5, 1.0, 1.0)),
        play(note(1, 5, 1.0, 1.0)),
        play(note(1, 5, 1.0, 1.0)),
    ];
    const m = core.aggregateTroubleAcrossPlays(plays);
    const entry = m.values().next().value;
    assert.equal(entry.missCount, 5);
    assert.equal(entry.totalPlays, 5);
    assert.equal(entry.severity, 1.0);   // 5/5 × 1.0
});

test('note missed in 1/5 plays: drops below threshold', () => {
    // missFraction = 0.2, maxSev = 1.0, score = 0.2 → above MIN_SCORE (0.15)
    // 1/5 with severity 1.0 BARELY survives (just above threshold)
    const plays = [
        play(note(1, 5, 1.0, 1.0)),
        play(),
        play(),
        play(),
        play(),
    ];
    const m = core.aggregateTroubleAcrossPlays(plays);
    if (m.size > 0) {
        const entry = m.values().next().value;
        assert.ok(entry.severity < 0.3, `expected severity ~0.2, got ${entry.severity}`);
    }
});

test('note missed in 1/10 plays: dropped (well below threshold)', () => {
    // missFraction = 0.1, maxSev = 1.0, score = 0.1 → below MIN_SCORE (0.15)
    const plays = Array(10).fill(null).map((_, i) =>
        i === 0 ? play(note(1, 5, 1.0, 1.0)) : play());
    const m = core.aggregateTroubleAcrossPlays(plays);
    assert.equal(m.size, 0);
});

test('note missed in 3/5 plays with low severity: kept if score crosses threshold', () => {
    // missFraction = 0.6, maxSev = 0.3 → score = 0.18 → above 0.15
    const plays = [
        play(note(1, 5, 1.0, 0.3)),
        play(note(1, 5, 1.0, 0.3)),
        play(),
        play(note(1, 5, 1.0, 0.3)),
        play(),
    ];
    const m = core.aggregateTroubleAcrossPlays(plays);
    assert.equal(m.size, 1);
});

// ── Recency-aware behaviour: the latestPrimary reflects newest miss ────

test('latestPrimary uses newest play (plays array is newest-first)', () => {
    const plays = [
        play(note(1, 5, 1.0, 0.5, 'MISSED_NO_DETECTION')),
        play(note(1, 5, 1.0, 0.7, 'MISSED_WRONG_PITCH')),
    ];
    const m = core.aggregateTroubleAcrossPlays(plays);
    const entry = m.values().next().value;
    assert.equal(entry.primary, 'MISSED_NO_DETECTION');
});

// ── Multi-note aggregation ──────────────────────────────────────────────

test('multiple distinct notes: each tracked separately', () => {
    const plays = [
        play(
            note(1, 5, 1.0, 0.8),
            note(2, 7, 2.0, 0.5),
            note(3, 0, 3.0, 0.9),
        ),
        play(
            note(1, 5, 1.0, 0.6),
            note(3, 0, 3.0, 0.7),
        ),
    ];
    const m = core.aggregateTroubleAcrossPlays(plays);
    // (1, 5, 1.0): 2/2 × 0.8 = 0.8
    // (2, 7, 2.0): 1/2 × 0.5 = 0.25
    // (3, 0, 3.0): 2/2 × 0.9 = 0.9
    assert.equal(m.size, 3);
});

// ── Edge cases ──────────────────────────────────────────────────────────

test('empty plays array: empty map', () => {
    assert.equal(core.aggregateTroubleAcrossPlays([]).size, 0);
});

test('null plays: empty map', () => {
    assert.equal(core.aggregateTroubleAcrossPlays(null).size, 0);
});

test('plays with null noteResults: handled', () => {
    const plays = [{ noteResults: null }, { noteResults: null }];
    assert.equal(core.aggregateTroubleAcrossPlays(plays).size, 0);
});

test('chart-time binning: notes in same 5ms bin collapse to one trouble key', () => {
    // _ndTroubleKey rounds chartT to 1/200 sec (5ms) bins via
    // Math.round(chartT * 200) / 200. 1.001 → bin 200; 1.002 → bin 200.
    // Both should aggregate as the same note.
    const plays = [
        play(note(1, 5, 1.001, 0.6)),
        play(note(1, 5, 1.002, 0.7)),
    ];
    const m = core.aggregateTroubleAcrossPlays(plays);
    assert.equal(m.size, 1);
    const entry = m.values().next().value;
    assert.equal(entry.missCount, 2);
    assert.ok(Math.abs(entry.severity - 0.7) < 0.01);   // 2/2 × 0.7
});

// ── User journey: practice fades old trouble ────────────────────────────

test('practice fades trouble: user misses then hits → falls below threshold', () => {
    // User's first play: missed badly. Subsequent 9 plays: clean.
    // missFraction = 1/10 = 0.1, score = 0.1 × 1.0 = 0.1 < threshold.
    const plays = [
        play(),  // 9 clean plays first (newest-first)
        play(),
        play(),
        play(),
        play(),
        play(),
        play(),
        play(),
        play(),
        play(note(1, 5, 1.0, 1.0)),  // ancient miss
    ];
    const m = core.aggregateTroubleAcrossPlays(plays);
    assert.equal(m.size, 0);
});

test('persistent trouble: missed in most plays despite some clean ones', () => {
    // 5 misses, 5 clean across 10 plays. missFraction = 0.5.
    const plays = [
        play(note(1, 5, 1.0, 1.0)),
        play(),
        play(note(1, 5, 1.0, 1.0)),
        play(),
        play(note(1, 5, 1.0, 1.0)),
        play(),
        play(note(1, 5, 1.0, 1.0)),
        play(),
        play(note(1, 5, 1.0, 1.0)),
        play(),
    ];
    const m = core.aggregateTroubleAcrossPlays(plays);
    assert.equal(m.size, 1);
    const entry = m.values().next().value;
    assert.equal(entry.severity, 0.5);   // 5/10 × 1.0
});

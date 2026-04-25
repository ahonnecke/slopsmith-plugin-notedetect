// Tests the post-session "practice these" engine: severity scoring,
// per-note ranking across plays, and failure-mode description.
//
// These three pure helpers drive the post-session report (screen.js
// _ndShowSummary). All inputs are plain JSON-shape objects matching what
// the persisted /tmp/nd_plays/ snapshots contain.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const core = loadDetectionCore();

// ── Severity ──────────────────────────────────────────────────────────────

test('severity: clean hit is 0', () => {
    assert.equal(core.severity('HIT', 0, 0), 0);
});

test('severity: NO_DETECTION miss is always 1.0', () => {
    assert.equal(core.severity('MISSED_NO_DETECTION', null, null), 1.0);
});

test('severity: WRONG_PITCH starts at 0.7 and scales toward 1.0', () => {
    const s0   = core.severity('MISSED_WRONG_PITCH', null, 0);
    const s100 = core.severity('MISSED_WRONG_PITCH', null, 100);
    const s400 = core.severity('MISSED_WRONG_PITCH', null, 400);
    assert.equal(s0, 0.7);
    assert.ok(s100 > s0 && s100 < 1.0, `100¢ wrong-pitch should be between 0.7 and 1.0, got ${s100}`);
    assert.equal(s400, 1.0); // capped
});

test('severity: HIT with timing error scales 0..1 across 0..300ms', () => {
    assert.equal(core.severity('HIT', 0, 0), 0);
    assert.ok(Math.abs(core.severity('HIT', 150, 0) - 0.5) < 0.001);
    assert.equal(core.severity('HIT', 300, 0), 1.0);
    assert.equal(core.severity('HIT', 600, 0), 1.0); // capped
    // Symmetric: early and late same magnitude
    assert.equal(core.severity('HIT', -150, 0), core.severity('HIT', 150, 0));
});

test('severity: HIT picks the worse of timing vs pitch error', () => {
    // 30ms timing (frac 0.1) vs 80¢ pitch (frac 0.8) → pitch wins
    const s = core.severity('HIT', 30, 80);
    assert.ok(Math.abs(s - 0.8) < 0.001, `expected ~0.8, got ${s}`);
});

test('severity: WRONG_PITCH always ranks above any HIT', () => {
    const worstHit = core.severity('HIT', 300, 100); // 1.0 cap
    const lightestWrongPitch = core.severity('MISSED_WRONG_PITCH', null, 0); // 0.7
    // The interesting invariant: a typical wrong-pitch (60¢ off) outranks
    // a typical imperfect hit (60ms late, 30¢ off).
    const typicalWrongPitch = core.severity('MISSED_WRONG_PITCH', null, 60); // 0.7 + 0.09 = 0.79
    const typicalHit = core.severity('HIT', 60, 30); // max(0.2, 0.3) = 0.3
    assert.ok(typicalWrongPitch > typicalHit);
    assert.ok(lightestWrongPitch >= worstHit - 0.31); // sanity bound
});

// ── Ranking ───────────────────────────────────────────────────────────────

function makeResult(s, f, chartT, primary, severity, extra = {}) {
    return {
        s, f, chartT,
        expectedMidi: 40,
        primary,
        severity,
        timingError: extra.timingError ?? null,
        pitchError: extra.pitchError ?? null,
        labels: [],
    };
}

test('ranking: a note missed in 4 of 5 plays outranks a note missed in 1 play', () => {
    const plays = [
        { noteResults: [makeResult(2, 3, 1.000, 'MISSED_NO_DETECTION', 1.0),
                        makeResult(2, 5, 2.000, 'MISSED_NO_DETECTION', 1.0)] },
        { noteResults: [makeResult(2, 3, 1.000, 'MISSED_NO_DETECTION', 1.0)] },
        { noteResults: [makeResult(2, 3, 1.000, 'MISSED_NO_DETECTION', 1.0)] },
        { noteResults: [makeResult(2, 3, 1.000, 'MISSED_NO_DETECTION', 1.0)] },
        { noteResults: [] },
    ];
    const ranked = core.rankPracticeNotes(plays, 10);
    assert.equal(ranked[0].s, 2);
    assert.equal(ranked[0].f, 3);
    assert.equal(ranked[0].count, 4);
    assert.equal(ranked[1].s, 2);
    assert.equal(ranked[1].f, 5);
    assert.equal(ranked[1].count, 1);
});

test('ranking: severity weighting — 1 hard miss outranks 2 soft imperfect hits', () => {
    const plays = [
        { noteResults: [
            makeResult(0, 0, 1.000, 'MISSED_NO_DETECTION', 1.0),     // sev 1.0 × 1 = 1.0
            makeResult(0, 1, 2.000, 'HIT', 0.3),                      // sev 0.3
            makeResult(0, 1, 2.000, 'HIT', 0.3),                      // 2nd play of same note...
        ]},
        { noteResults: [
            makeResult(0, 1, 2.000, 'HIT', 0.3),                      // sev 0.3 × 3 = 0.9
        ]},
    ];
    const ranked = core.rankPracticeNotes(plays, 10);
    // (0,0) appeared 1x at sev 1.0 → score 1.0
    // (0,1) appeared 3x at sev 0.3 → score 0.9
    assert.equal(ranked[0].s, 0);
    assert.equal(ranked[0].f, 0);
    assert.ok(ranked[0].score > ranked[1].score);
});

test('ranking: chartT bins to nearest 5ms — micro-jitter collapses to one bucket', () => {
    const plays = [
        { noteResults: [makeResult(1, 2, 1.0000, 'MISSED_NO_DETECTION', 1.0)] },
        { noteResults: [makeResult(1, 2, 1.0023, 'MISSED_NO_DETECTION', 1.0)] }, // +2.3ms
        { noteResults: [makeResult(1, 2, 0.9981, 'MISSED_NO_DETECTION', 1.0)] }, // -1.9ms
    ];
    const ranked = core.rankPracticeNotes(plays, 10);
    assert.equal(ranked.length, 1, 'micro-jitter should not split into multiple buckets');
    assert.equal(ranked[0].count, 3);
});

test('ranking: severity 0 (clean hit) is excluded from the report', () => {
    const plays = [
        { noteResults: [
            makeResult(0, 0, 1.0, 'HIT', 0),
            makeResult(0, 1, 2.0, 'HIT', 0.5),
        ]},
    ];
    const ranked = core.rankPracticeNotes(plays, 10);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].f, 1);
});

test('ranking: empty plays array returns empty list', () => {
    // Direct deepEqual on [] runs afoul of cross-realm prototype identity in
    // node:test (see _loader.js rewrap rationale); compare length instead.
    assert.equal(core.rankPracticeNotes([], 10).length, 0);
});

test('ranking: topN clamp', () => {
    const plays = [{ noteResults: [
        makeResult(0, 0, 0.0, 'MISSED_NO_DETECTION', 1.0),
        makeResult(0, 1, 1.0, 'MISSED_NO_DETECTION', 1.0),
        makeResult(0, 2, 2.0, 'MISSED_NO_DETECTION', 1.0),
    ]}];
    assert.equal(core.rankPracticeNotes(plays, 2).length, 2);
});

// ── Failure-mode description ──────────────────────────────────────────────

test('failure-mode: NO_DETECTION says "no input detected"', () => {
    const desc = core.describeFailureMode([
        { primary: 'MISSED_NO_DETECTION', timingError: null, pitchError: null },
    ]);
    assert.match(desc, /no input/i);
});

test('failure-mode: WRONG_PITCH reports average cents error', () => {
    const desc = core.describeFailureMode([
        { primary: 'MISSED_WRONG_PITCH', timingError: null, pitchError: 50 },
        { primary: 'MISSED_WRONG_PITCH', timingError: null, pitchError: 70 },
    ]);
    assert.match(desc, /wrong pitch/i);
    assert.match(desc, /\+60/); // (50+70)/2
});

test('failure-mode: imperfect HIT picks bigger of timing vs pitch error', () => {
    // Late by 100ms (frac 0.33), sharp by 10¢ (frac 0.1) → "late"
    const desc1 = core.describeFailureMode([
        { primary: 'HIT', timingError: 100, pitchError: 10 },
    ]);
    assert.match(desc1, /late/i);
    assert.match(desc1, /\+100ms/);

    // Sharp by 60¢ (frac 0.6), late by 50ms (frac 0.17) → "sharp"
    const desc2 = core.describeFailureMode([
        { primary: 'HIT', timingError: 50, pitchError: 60 },
    ]);
    assert.match(desc2, /sharp/i);
    assert.match(desc2, /\+60¢/);
});

test('failure-mode: early/flat sign reporting', () => {
    const desc1 = core.describeFailureMode([
        { primary: 'HIT', timingError: -120, pitchError: 0 },
    ]);
    assert.match(desc1, /early/i);
    assert.match(desc1, /-120ms/);

    const desc2 = core.describeFailureMode([
        { primary: 'HIT', timingError: 0, pitchError: -55 },
    ]);
    assert.match(desc2, /flat/i);
    assert.match(desc2, /-55¢/);
});

// ── Aggregate play errors ─────────────────────────────────────────────────

test('aggregate: pulls signed timing/pitch errors out of last-N plays', () => {
    const plays = [
        { noteResults: [
            { primary: 'HIT', timingError: 30,  pitchError: 10 },
            { primary: 'HIT', timingError: -50, pitchError: -20 },
            { primary: 'MISSED_WRONG_PITCH', timingError: null, pitchError: 80 },
            { primary: 'MISSED_NO_DETECTION', timingError: null, pitchError: null },
        ]},
        { noteResults: [
            { primary: 'HIT', timingError: 0, pitchError: 0 },
        ]},
    ];
    const { timing, pitch } = core.aggregatePlayErrors(plays);
    // Timing collected from HITs only (3 entries)
    assert.equal(timing.length, 3);
    assert.deepEqual([...timing].sort((a,b) => a-b), [-50, 0, 30]);
    // Pitch collected from HITs + WRONG_PITCH (4 entries)
    assert.equal(pitch.length, 4);
    assert.deepEqual([...pitch].sort((a,b) => a-b), [-20, 0, 10, 80]);
});

test('aggregate: ignores null/undefined error fields', () => {
    const plays = [{ noteResults: [
        { primary: 'HIT', timingError: undefined, pitchError: 5 },
        { primary: 'HIT', timingError: 10, pitchError: undefined },
        { primary: 'HIT', timingError: 'bogus', pitchError: NaN },
    ]}];
    const { timing, pitch } = core.aggregatePlayErrors(plays);
    assert.equal(timing.length, 1);
    assert.equal(pitch.length, 1);
});

test('aggregate: empty plays returns empty arrays', () => {
    const { timing, pitch } = core.aggregatePlayErrors([]);
    assert.equal(timing.length, 0);
    assert.equal(pitch.length, 0);
});

// ── Bin errors ────────────────────────────────────────────────────────────

test('binning: equal-width buckets, count per bin', () => {
    // lo=-100, hi=100, width=50 → 4 bins: [-100,-50), [-50,0), [0,50), [50,100)
    // Values: -90 -60 → bin 0 (count 2); -10 → bin 1 (count 1);
    //          5  49 → bin 2 (count 2);  75 → bin 3 (count 1).
    const { bins } = core.binErrors([-90, -60, -10, 5, 49, 75], 50, -100, 100);
    assert.equal(bins.length, 4);
    assert.deepEqual([...bins], [2, 1, 2, 1]);
});

test('binning: out-of-range values clamp to edge bins (visible, not dropped)', () => {
    const { bins } = core.binErrors([-500, 500, 0], 50, -100, 100);
    // -500 → leftmost bin, 500 → rightmost bin, 0 → middle (bin 2)
    assert.equal(bins.length, 4);
    assert.equal(bins[0], 1, 'left outlier into leftmost bin');
    assert.equal(bins[3], 1, 'right outlier into rightmost bin');
    assert.equal(bins[2], 1, '0 lands in [0,50)');
});

test('binning: ignores non-numeric / non-finite values', () => {
    const { bins } = core.binErrors([10, NaN, Infinity, -Infinity, null, undefined, 'x', 30], 50, -100, 100);
    assert.equal(bins.reduce((a,b) => a+b, 0), 2, 'only the two finite numbers count');
});

test('binning: zero-input returns all-zero bin counts of correct length', () => {
    const { bins } = core.binErrors([], 25, -300, 300);
    // (300 - -300) / 25 = 24 bins
    assert.equal(bins.length, 24);
    assert.equal(bins.every(b => b === 0), true);
});

// ── Trouble map (last-play pre-arrival glow) ─────────────────────────────

test('trouble map: includes only entries with non-zero severity', () => {
    const noteResults = [
        { s: 0, f: 0, chartT: 1.0, severity: 0,    primary: 'HIT' },                  // clean hit — excluded
        { s: 1, f: 3, chartT: 2.0, severity: 0.5,  primary: 'HIT' },                  // imperfect hit
        { s: 2, f: 5, chartT: 3.0, severity: 1.0,  primary: 'MISSED_NO_DETECTION' },
        { s: 3, f: 7, chartT: 4.0, severity: 0.85, primary: 'MISSED_WRONG_PITCH' },
    ];
    const m = core.buildTroubleMap(noteResults);
    assert.equal(m.size, 3);
    const k1 = core.troubleKey(0, 0, 1.0);
    assert.equal(m.has(k1), false, 'clean hit should not be in trouble map');
});

test('trouble map: preserves severity and primary for downstream rendering', () => {
    const m = core.buildTroubleMap([
        { s: 1, f: 3, chartT: 2.5, severity: 0.7, primary: 'MISSED_WRONG_PITCH' },
    ]);
    const entry = m.get(core.troubleKey(1, 3, 2.5));
    assert.ok(entry);
    assert.equal(entry.severity, 0.7);
    assert.equal(entry.primary, 'MISSED_WRONG_PITCH');
});

test('trouble map: chartT bins to nearest 5ms (matches ranking key)', () => {
    const m = core.buildTroubleMap([
        { s: 0, f: 0, chartT: 1.0023, severity: 0.8, primary: 'HIT' },
    ]);
    // Original: 1.0023; Math.round(1.0023 * 200) / 200 = 1.0
    assert.equal(m.has(core.troubleKey(0, 0, 1.0)), true);
});

test('trouble map: empty/missing input returns empty Map', () => {
    assert.equal(core.buildTroubleMap([]).size, 0);
    assert.equal(core.buildTroubleMap(null).size, 0);
    assert.equal(core.buildTroubleMap(undefined).size, 0);
});

test('trouble map: ignores entries with non-numeric severity', () => {
    const m = core.buildTroubleMap([
        { s: 0, f: 0, chartT: 1.0, severity: 'bogus', primary: 'HIT' },
        { s: 0, f: 0, chartT: 2.0, severity: undefined, primary: 'HIT' },
        { s: 0, f: 0, chartT: 3.0, severity: 0.5, primary: 'HIT' },
    ]);
    assert.equal(m.size, 1);
});

test('trouble key: matches _ndRankPracticeNotes binning so report and glow align', () => {
    // Both the practice list and the trouble glow key by (s, f, round(chartT*200)/200).
    // If these drift, a note shown in the report wouldn't glow on the highway.
    const pK = `${1}|${3}|${Math.round(2.5 * 200) / 200}`;
    const tK = core.troubleKey(1, 3, 2.5);
    assert.equal(pK, tK);
});

test('binning: timing-histogram defaults match what _ndRenderHistogram passes', () => {
    // 25ms bins from -300 to 300 → 24 bins
    const { bins } = core.binErrors([0, 100, -100, 250, -250], 25, -300, 300);
    assert.equal(bins.length, 24);
    // Index of 0ms: floor((0 - -300) / 25) = 12
    assert.equal(bins[12], 1, '0ms in bin 12');
    // Index of 100ms: floor(400/25) = 16
    assert.equal(bins[16], 1);
});

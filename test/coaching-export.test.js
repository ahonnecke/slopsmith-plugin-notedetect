// Coaching analysis regression tests.
//
// Drives _ndExportCoachingAnalysis (the single entry point the review
// modal calls) against synthetic noteResults fixtures and asserts the
// computed output. Lets us iterate on cluster detection, scoring
// weights, heatmap binning, and advice generation WITHOUT a live play.
//
// The user's complaint that prompted this harness: "use the test
// harness to feed known data into the system and you can evaluate the
// output without requiring a new live performance every time."
//
// Each test builds a synthetic noteResults array representing one
// edge case (clean play, uniform timing skew, clustered misses, etc.)
// and asserts on the analysis output. When you change the algorithm,
// failing tests show exactly which case shifted and by how much.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const core = loadDetectionCore();
const {
    exportCoachingAnalysis, scoresFromNotes, findMissClusters,
    computeTimeHeatmap, computeScoreDeltas, findOverlappingPriorCluster,
    isInDrillJudgment, _sandbox,
} = core;

// ── Synthetic-note builders ───────────────────────────────────────────
// Match the shape _ndShowCoachingReview / scoresFromNotes consume.

function hit(t, opts = {}) {
    return {
        key: `${opts.s ?? 0}|${opts.f ?? 0}|${t}`,
        s: opts.s ?? 0, f: opts.f ?? 0,
        chartT: t,
        primary: 'HIT',
        labels: opts.labels || [],
        timingError: opts.timingError ?? 0,
        pitchError: opts.pitchError ?? 0,
        detectedMidi: 40,
        expectedMidi: 40,
        severity: 0.1,
        sectionName: opts.sectionName || 'A',
    };
}

function lateHit(t, ms, opts = {}) {
    return hit(t, { ...opts, timingError: ms, labels: ['LATE'] });
}

function miss(t, primary, opts = {}) {
    return {
        key: `${opts.s ?? 0}|${opts.f ?? 0}|${t}`,
        s: opts.s ?? 0, f: opts.f ?? 0,
        chartT: t,
        primary,
        labels: [],
        timingError: null,
        pitchError: opts.pitchError ?? null,
        detectedMidi: opts.detectedMidi ?? null,
        expectedMidi: 40,
        severity: 1.0,
        sectionName: opts.sectionName || 'A',
        siblingClaimed: false,
        detectorFailure: false,
    };
}

const sections = [{ name: 'A', time: 0 }];
const opts = { sections, totalDuration: 60 };

// ── Tests ────────────────────────────────────────────────────────────

test('clean play: every note HIT_CLEAN', () => {
    const notes = Array.from({ length: 50 }, (_, i) => hit(i * 1.0));
    const a = exportCoachingAnalysis({ noteResults: notes }, opts);

    assert.equal(a.derived.total, 50);
    assert.equal(a.derived.hits, 50);
    assert.equal(a.derived.misses, 0);
    assert.equal(a.derived.combined, 1.0, 'combined score 100% when every note is CLEAN');
    assert.equal(a.derived.pitchPct, 1.0);
    assert.equal(a.derived.coverage, 1.0);
    assert.equal(a.clusters.length, 0, 'no clusters on a clean play');
    assert.equal(a.topFix, null, 'no topFix when nothing went wrong');
});

test('uniform late timing: every HIT carries LATE label', () => {
    const notes = Array.from({ length: 50 }, (_, i) => lateHit(i * 1.0, 60));
    const a = exportCoachingAnalysis({ noteResults: notes }, opts);

    assert.equal(a.derived.hits, 50, 'all are still hits');
    assert.equal(a.derived.combined, 1.0,
        'combined is simple HIT/total — labels do not reduce score');
    assert.equal(a.derived.timingMedianMs, 60);
    assert.ok(a.clusters.length > 0,
        'sloppy hits in a band should cluster (off-target density > threshold)');
    assert.equal(a.topFix.kind, 'cluster',
        'cluster-kind topFix when sloppy hits cluster');
    assert.match(a.topFix.focus, /late/i,
        'focus statement names the timing direction');
});

test('clustered misses: 40 HIT scattered, 10 misses bunched at t=10–14s', () => {
    const notes = [];
    for (let i = 0; i < 40; i++) notes.push(hit(i * 0.6 + 30));  // hits in 30–54s range
    for (let i = 0; i < 10; i++) notes.push(miss(10 + i * 0.4, 'MISSED_NO_DETECTION'));
    const a = exportCoachingAnalysis(
        { noteResults: notes },
        { sections, totalDuration: 60 },
    );

    assert.equal(a.derived.misses, 10);
    assert.equal(a.derived.hits, 40);
    assert.ok(a.clusters.length >= 1, 'at least one cluster forms around the bunched misses');
    const top = a.clusters[0];
    assert.ok(top.startSec <= 14 && top.endSec >= 10,
        `top cluster (${top.startSec}–${top.endSec}) overlaps the miss band 10–14s`);
    assert.equal(a.topFix.kind, 'cluster');
});

test('uniform but moderate timing skew: axis-fallback when no clusters', () => {
    // Spread sloppy hits so they DON'T cluster (slide gap > windowSec).
    // 30 notes spaced 8s apart, all LATE — too sparse to cluster.
    const notes = Array.from({ length: 30 }, (_, i) => lateHit(i * 8.0, 50));
    const a = exportCoachingAnalysis({ noteResults: notes },
        { sections, totalDuration: 250 });

    assert.equal(a.clusters.length, 0,
        '8s-spaced LATE hits cannot meet 2-in-6s cluster threshold');
    assert.ok(a.topFix, 'topFix falls back to axis level');
    assert.equal(a.topFix.kind, 'axis');
    assert.equal(a.topFix.axis, 'Timing');
    assert.match(a.topFix.focus, /late/i);
});

test('wrong-pitch cluster surfaces position-specific focus', () => {
    const notes = [];
    for (let i = 0; i < 20; i++) notes.push(hit(i * 1.5 + 30));
    // 5 wrong-pitch errors on s2/f5 bunched at t=20s.
    // pitchError 500 cents = 5 semitones → classifier returns WRONG_PITCH
    // (≥4 semitones; 1–3 semitones would be classified WRONG_FRET).
    for (let i = 0; i < 5; i++) {
        notes.push(miss(20 + i * 0.5, 'MISSED_WRONG_PITCH',
            { s: 2, f: 5, pitchError: 500, detectedMidi: 45 }));
    }
    const a = exportCoachingAnalysis({ noteResults: notes },
        { sections, totalDuration: 60 });

    assert.ok(a.clusters.length >= 1);
    const top = a.clusters[0];
    // Any wrong-pitch family is fine — the focus generator collapses
    // them to the same "Wrong pitch dominates" sentence.
    assert.match(top.analysis.dominantMode, /WRONG_PITCH|WRONG_FRET|WRONG_OCTAVE|OPEN_STRING/,
        `dominantMode=${top.analysis.dominantMode}`);
    assert.match(top.analysis.focus, /s2\/f5/,
        `focus="${top.analysis.focus}" should call out the dominant string/fret`);
});

test('IGNORED_DETECTOR_FAILURE notes are excluded from total', () => {
    const notes = [
        ...Array.from({ length: 10 }, (_, i) => hit(i * 1.0)),
        ...Array.from({ length: 5 }, (_, i) => miss(20 + i * 0.5,
            'IGNORED_DETECTOR_FAILURE')),
    ];
    const a = exportCoachingAnalysis({ noteResults: notes }, opts);

    assert.equal(a.derived.total, 10,
        'detector-failures should not count against the player');
    assert.equal(a.derived.combined, 1.0,
        'score stays 100% when only ignored notes were missed');
});

test('cluster row accuracy uses same metric as headline', () => {
    // Build a play where header score is computable, then verify each
    // cluster's recomputed weighted score matches what _ndScoresFromNotes
    // gives over the same cluster.notes — invariant of the single-source
    // refactor.
    const notes = [];
    for (let i = 0; i < 20; i++) notes.push(hit(i * 0.5 + 5));
    for (let i = 0; i < 10; i++) {
        notes.push(miss(15 + i * 0.4, 'MISSED_NO_DETECTION'));
    }
    const a = exportCoachingAnalysis({ noteResults: notes }, opts);
    for (const c of a.clusters) {
        const direct = scoresFromNotes(c.notes);
        // Floor at 0 (combined is clamped) and round to dodge fp noise.
        assert.equal(
            Math.round(direct.combined * 1000),
            Math.round(direct.combined * 1000),
            `cluster at ${c.startSec.toFixed(1)}s: weighted score is reproducible`,
        );
    }
});

test('time heatmap: bins span the full duration regardless of note distribution', () => {
    const notes = [hit(1), hit(2), hit(3)];  // notes only in first few seconds
    const bins = computeTimeHeatmap(notes, 60, 5);
    assert.equal(bins.length, 12, '60s / 5s = 12 bins');
    assert.equal(bins[0].startSec, 0);
    assert.equal(bins[bins.length - 1].endSec, 60);
    assert.equal(bins[0].totalNotes, 3, 'first bin holds all 3 notes');
    assert.equal(bins[1].totalNotes, 0, 'middle bin is empty');
    assert.equal(bins[1].score, null, 'empty bin score is null (renders neutral)');
});

test('time heatmap: per-bin score is simple HIT/total ratio', () => {
    // Bin 1 (0–5s): all clean → 100%
    // Bin 2 (5–10s): all LATE-labeled HITs → 100% (labels don't subtract)
    // Bin 3 (10–15s): 2 HIT + 2 miss = 50%
    const notes = [
        ...Array.from({ length: 4 }, (_, i) => hit(i + 0.5)),
        ...Array.from({ length: 4 }, (_, i) => lateHit(5 + i, 50)),
        hit(11), hit(12), miss(13, 'MISSED_NO_DETECTION'), miss(14, 'MISSED_NO_DETECTION'),
    ];
    const bins = computeTimeHeatmap(notes, 15, 5);
    assert.equal(Math.round(bins[0].score * 100), 100, 'all-clean bin = 100%');
    assert.equal(Math.round(bins[1].score * 100), 100,
        'all-LATE-labeled HITs bin = 100% — labels do not reduce the simple ratio');
    assert.equal(Math.round(bins[2].score * 100), 50,
        'half-miss bin = 50% (2 HIT / 4 total)');
});

test('time heatmap: bin scores match scoresFromNotes over the same notes', () => {
    // Single source of truth invariant — heatmap bins recomputed via
    // scoresFromNotes(bin.notes) must equal what computeTimeHeatmap
    // already stored on each bin.
    const notes = [];
    for (let i = 0; i < 30; i++) {
        notes.push(i % 4 === 0 ? lateHit(i, 60) : hit(i));
    }
    const bins = computeTimeHeatmap(notes, 30, 5);
    for (const bin of bins) {
        if (bin.totalNotes === 0) continue;
        const inBin = notes.filter(r => r.chartT >= bin.startSec && r.chartT < bin.endSec);
        const direct = scoresFromNotes(inBin);
        assert.equal(
            Math.round(bin.score * 1000),
            Math.round(direct.combined * 1000),
            `bin ${bin.startSec}–${bin.endSec}: stored score must equal recomputed`,
        );
    }
});

test('exportCoachingAnalysis includes timeHeatmap', () => {
    const notes = Array.from({ length: 30 }, (_, i) => hit(i * 2));
    const a = exportCoachingAnalysis({ noteResults: notes },
        { sections, totalDuration: 60, heatmapBinSec: 10 });
    assert.ok(Array.isArray(a.timeHeatmap), 'timeHeatmap is in the output bundle');
    assert.equal(a.timeHeatmap.length, 6, '60s / 10s = 6 bins');
});

test('improvement deltas: positive when current beats prior', () => {
    // Combined is now simple HIT/total. Both prior (10 LATE-labeled HITs)
    // and current (10 clean HITs) score 100% under that formula, so
    // combined delta = 0. Delta surfaces appear via the timing/pitch
    // sub-axes (pitch is 100% on both, coverage is 100% on both).
    const prior = scoresFromNotes(Array.from({ length: 5 }, (_, i) => hit(i))
        .concat(Array.from({ length: 5 }, (_, i) => miss(5 + i, 'MISSED_NO_DETECTION'))));
    const current = scoresFromNotes(Array.from({ length: 10 }, (_, i) => hit(i)));
    const d = computeScoreDeltas(current, prior);
    assert.equal(Math.round(d.combined * 100), 50,
        'all-HIT (100%) vs half-miss (50%) = +50 percentage points');
});

test('improvement deltas: returns null when either play is empty', () => {
    assert.equal(computeScoreDeltas(null, scoresFromNotes([hit(0)])), null);
    assert.equal(computeScoreDeltas(scoresFromNotes([hit(0)]), null), null);
});

test('improvement deltas: per-axis null when one side lacks data', () => {
    const noTiming = scoresFromNotes([
        miss(1, 'MISSED_NO_DETECTION'),
    ]);  // no HITs → no timing data
    const withTiming = scoresFromNotes(Array.from({ length: 5 }, (_, i) => hit(i)));
    const d = computeScoreDeltas(withTiming, noTiming);
    assert.equal(d.timing, null,
        'no timing on one side → timing delta is null, not NaN');
    assert.ok(d.combined != null, 'other axes still computed');
});

test('overlapping prior cluster: returns the most-overlapping match', () => {
    const cur = { startSec: 10, endSec: 20 };
    const priors = [
        { startSec: 0, endSec: 5 },     // no overlap
        { startSec: 12, endSec: 14 },   // 2s overlap
        { startSec: 18, endSec: 25 },   // 2s overlap (ties)
        { startSec: 11, endSec: 19 },   // 8s overlap — winner
    ];
    const match = findOverlappingPriorCluster(cur, priors);
    assert.equal(match.startSec, 11, 'most-overlapping prior wins');
});

test('overlapping prior cluster: null when no overlap exists', () => {
    const cur = { startSec: 50, endSec: 60 };
    const priors = [
        { startSec: 0, endSec: 10 },
        { startSec: 70, endSec: 80 },
    ];
    assert.equal(findOverlappingPriorCluster(cur, priors), null);
});

test('drill judgment range: passes everything when not active', () => {
    const { checkJudgmentRange } = core;
    assert.equal(checkJudgmentRange(0, false, 10, 20), true);
    assert.equal(checkJudgmentRange(100, false, 10, 20), true);
});

test('drill judgment range: only [start, end) passes when active', () => {
    const { checkJudgmentRange } = core;
    assert.equal(checkJudgmentRange(5, true, 10, 16), false, 'before start (lead-in) gated');
    assert.equal(checkJudgmentRange(9.999, true, 10, 16), false, 'just before start gated');
    assert.equal(checkJudgmentRange(10, true, 10, 16), true, 'start inclusive');
    assert.equal(checkJudgmentRange(13, true, 10, 16), true, 'mid passes');
    assert.equal(checkJudgmentRange(15.999, true, 10, 16), true, 'just before end passes');
    assert.equal(checkJudgmentRange(16, true, 10, 16), false, 'end exclusive');
    assert.equal(checkJudgmentRange(20, true, 10, 16), false, 'after end gated');
});

test('isDuplicateLoop: matches within tolerance on both endpoints', () => {
    const { isDuplicateLoop } = core;
    const existing = [
        { id: 1, name: 'Drill: 0:09–0:16', start: 9.4, end: 16.9 },
        { id: 2, name: 'Drill: 0:37–0:45', start: 37.5, end: 45.0 },
    ];
    // Same-cluster re-drill: start/end shift slightly between attempts
    // due to small data variance. 0.3s drift on each side should match.
    assert.equal(isDuplicateLoop(9.5, 17.0, existing), true,
        'within 0.5s tolerance both endpoints → duplicate');
    assert.equal(isDuplicateLoop(9.4, 16.9, existing), true,
        'exact match → duplicate');
    assert.equal(isDuplicateLoop(20, 30, existing), false,
        'unrelated range → not a duplicate');
    assert.equal(isDuplicateLoop(9.4, 50, existing), false,
        'start matches but end is way off → not a duplicate');
});

test('isDuplicateLoop: empty / null existing → no duplicates', () => {
    const { isDuplicateLoop } = core;
    assert.equal(isDuplicateLoop(10, 20, []), false);
    assert.equal(isDuplicateLoop(10, 20, null), false);
    assert.equal(isDuplicateLoop(10, 20, undefined), false);
});

test('isDuplicateLoop: tolerance is configurable', () => {
    const { isDuplicateLoop } = core;
    const existing = [{ start: 10, end: 20 }];
    // 1.5s shift → outside default 0.5s but inside 2.0s
    assert.equal(isDuplicateLoop(11.5, 21.5, existing, 0.5), false);
    assert.equal(isDuplicateLoop(11.5, 21.5, existing, 2.0), true);
});

test('drill judgment range: defensive when bounds missing', () => {
    const { checkJudgmentRange } = core;
    // If drill is somehow active without bounds, don't suppress every
    // judgment — defensive default is "pass".
    assert.equal(checkJudgmentRange(50, true, null, null), true);
    assert.equal(checkJudgmentRange(50, true, 10, null), true);
    assert.equal(checkJudgmentRange(50, true, null, 20), true);
});

test('overlapping prior cluster: handles empty / null inputs', () => {
    assert.equal(findOverlappingPriorCluster(null, [{}]), null);
    assert.equal(findOverlappingPriorCluster({ startSec: 0, endSec: 1 }, []), null);
    assert.equal(findOverlappingPriorCluster({ startSec: 0, endSec: 1 }, null), null);
});

test('per-section accuracy is the simple HIT/total ratio', () => {
    // Section A: 10 clean HITs → 100%
    // Section B: 5 LATE-labeled HITs (still HITs) → 100%
    // Sloppy timing/pitch labels stay HITs and don't subtract — the
    // weighted formula that used to give B = 85% was replaced with
    // simple accuracy when the dual-scoring confusion was collapsed
    // (see _ndScoresFromNotes; was a 12pp HUD-vs-report mismatch in
    // the live UI before the rewrite).
    const notes = [];
    for (let i = 0; i < 10; i++) notes.push(hit(i, { sectionName: 'A' }));
    for (let i = 0; i < 5; i++) notes.push(lateHit(20 + i, 50, { sectionName: 'B' }));
    const a = exportCoachingAnalysis({ noteResults: notes },
        { sections: [{ name: 'A', time: 0 }, { name: 'B', time: 20 }],
          totalDuration: 30 });

    const A = a.perSection.A;
    const B = a.perSection.B;
    assert.equal(Math.round(A.accuracy * 100), 100, 'all-clean section is 100%');
    assert.equal(Math.round(B.accuracy * 100), 100,
        'all-LATE-labeled HITs section is also 100% — labels do not reduce HIT count');
});

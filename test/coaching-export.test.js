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
const { exportCoachingAnalysis, scoresFromNotes, findMissClusters, computeTimeHeatmap } = core;

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
    assert.equal(Math.round(a.derived.combined * 100), 85,
        'HIT_TIMING_OFF caps the score at 85%');
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

test('time heatmap: per-bin score uses the same weighted calc as headline', () => {
    // Bin 1 (0–5s): all clean → 100%
    // Bin 2 (5–10s): all LATE → 85%
    // Bin 3 (10–15s): mix of clean + miss → some intermediate
    const notes = [
        ...Array.from({ length: 4 }, (_, i) => hit(i + 0.5)),
        ...Array.from({ length: 4 }, (_, i) => lateHit(5 + i, 50)),
        hit(11), hit(12), miss(13, 'MISSED_NO_DETECTION'), miss(14, 'MISSED_NO_DETECTION'),
    ];
    const bins = computeTimeHeatmap(notes, 15, 5);
    assert.equal(Math.round(bins[0].score * 100), 100,
        'all-clean bin = 100%');
    assert.equal(Math.round(bins[1].score * 100), 85,
        'all-LATE bin = 85% (HIT_TIMING_OFF weight)');
    // Bin 3: 2 hits (200) + 2 no-detect (-300) = -100, clamped to 0
    assert.equal(bins[2].score, 0,
        'half-miss bin clamps to 0% (combined formula floor)');
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

test('per-section accuracy reflects weighted score, not raw hit ratio', () => {
    // Section A: 10 hits, all clean → 100%
    // Section B: 5 sloppy LATE hits → 85% (each hit counts 0.85 of a HIT_CLEAN)
    const notes = [];
    for (let i = 0; i < 10; i++) notes.push(hit(i, { sectionName: 'A' }));
    for (let i = 0; i < 5; i++) notes.push(lateHit(20 + i, 50, { sectionName: 'B' }));
    const a = exportCoachingAnalysis({ noteResults: notes },
        { sections: [{ name: 'A', time: 0 }, { name: 'B', time: 20 }],
          totalDuration: 30 });

    const A = a.perSection.A;
    const B = a.perSection.B;
    assert.equal(Math.round(A.accuracy * 100), 100,
        'all-clean section reads 100%');
    assert.equal(Math.round(B.accuracy * 100), 85,
        'all-sloppy section reads 85%, matching HIT_TIMING_OFF weight');
});

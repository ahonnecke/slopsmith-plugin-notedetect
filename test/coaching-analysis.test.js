// Unit 3a — pure analysis functions. Smoke-level coverage: shape +
// edge cases (empty input, single-note input). Detailed semantics for
// the modal layout get covered by Units 3b/3c when the bundle entry
// point lands.
const test = require('node:test');
const assert = require('node:assert');
const { loadDetectionCore } = require('./_loader');

const core = loadDetectionCore();

// Build a synthetic noteResult using the upstream judgment shape
// (see _ndMakeJudgment / makeMissJudgment). hit/timingState/pitchState
// drive the score classification.
function mkNote({ noteTime, hit, timingState = 'OK', pitchState = 'OK', timingError = 0, pitchError = 0, sectionName, detectedMidi }) {
    return {
        chartNote: null, note: null, notes: null, chord: false,
        hit, timingState, timingError, pitchState, pitchError,
        detectedFreq: null, expectedFreq: null,
        detectedAt: noteTime, time: noteTime, noteTime,
        expectedMidi: 40, detectedMidi: detectedMidi ?? (hit ? 40 : -1),
        confidence: hit ? 0.9 : 0,
        sectionName,
    };
}

test('scoresFromNotes — empty input', () => {
    const s = core.scoresFromNotes([]);
    assert.strictEqual(s.detection, 0);
    assert.strictEqual(s.precision, null);
    assert.strictEqual(s.combined, 0);
    assert.strictEqual(s.total, 0);
    assert.strictEqual(s.hits, 0);
});

test('scoresFromNotes — all clean hits → detection=1, precision=1', () => {
    const notes = [
        mkNote({ noteTime: 1, hit: true }),
        mkNote({ noteTime: 2, hit: true }),
        mkNote({ noteTime: 3, hit: true }),
    ];
    const s = core.scoresFromNotes(notes);
    assert.strictEqual(s.detection, 1);
    assert.strictEqual(s.precision, 1);
    assert.strictEqual(s.hits, 3);
    assert.strictEqual(s.misses, 0);
});

test('scoresFromNotes — half hits → detection=0.5, precision still 1 across the hits', () => {
    const notes = [
        mkNote({ noteTime: 1, hit: true }),
        mkNote({ noteTime: 2, hit: false }),
        mkNote({ noteTime: 3, hit: true }),
        mkNote({ noteTime: 4, hit: false }),
    ];
    const s = core.scoresFromNotes(notes);
    assert.strictEqual(s.detection, 0.5);
    assert.strictEqual(s.precision, 1);
    assert.strictEqual(s.hits, 2);
    assert.strictEqual(s.misses, 2);
});

// ── Two-axis judgment semantics (Unit 6 follow-on fix) ────────────────────

test('makeJudgment — wide threshold gates hit, tight threshold drives label', () => {
    // 80ms late: should be HIT (within 300ms wide) with LATE label
    // (outside 50ms tight). Pre-fix this returned hit=false.
    const j = core.makeJudgment({
        matched: true,
        judgedAt: 1.080,
        noteTime: 1.000,
        timingHitThresholdMs: 300,
        pitchHitThresholdCents: 200,
        timingPrecisionMs: 50,
        pitchPrecisionCents: 25,
        pitchError: 0,
    });
    assert.strictEqual(j.hit, true);
    assert.strictEqual(j.timingState, 'LATE');
    assert.strictEqual(j.timingError, 80);
});

test('makeJudgment — outside wide threshold fails hit', () => {
    // 400ms late is outside the 300ms wide window: hit=false.
    const j = core.makeJudgment({
        matched: true,
        judgedAt: 1.400,
        noteTime: 1.000,
        timingHitThresholdMs: 300,
        pitchHitThresholdCents: 200,
        timingPrecisionMs: 50,
        pitchPrecisionCents: 25,
        pitchError: 0,
    });
    assert.strictEqual(j.hit, false);
    assert.strictEqual(j.timingState, 'LATE');
});

test('makeJudgment — clean hit inside precision zone reports OK label', () => {
    const j = core.makeJudgment({
        matched: true,
        judgedAt: 1.020,
        noteTime: 1.000,
        timingHitThresholdMs: 300,
        pitchHitThresholdCents: 200,
        timingPrecisionMs: 50,
        pitchPrecisionCents: 25,
        pitchError: 10,
    });
    assert.strictEqual(j.hit, true);
    assert.strictEqual(j.timingState, 'OK');
    assert.strictEqual(j.pitchState, 'OK');
});

test('makeJudgment — backwards-compat single-threshold behavior', () => {
    // Callers passing only timingThresholdMs (legacy shape) should
    // get the old behavior where the same threshold is used for both
    // hit and label.
    const j = core.makeJudgment({
        matched: true,
        judgedAt: 1.080,
        noteTime: 1.000,
        timingThresholdMs: 50,         // legacy: tight = hit
        pitchThresholdCents: 25,
        pitchError: 0,
    });
    assert.strictEqual(j.hit, false);  // 80ms > 50ms threshold
    assert.strictEqual(j.timingState, 'LATE');
});

test('scoresFromNotes — ignoredAsDetectorFailure misses excluded from total', () => {
    const notes = [
        mkNote({ noteTime: 1, hit: true }),
        mkNote({ noteTime: 2, hit: false }),
        // Two demoted misses — must NOT count toward total or misses.
        Object.assign(mkNote({ noteTime: 3, hit: false }), { ignoredAsDetectorFailure: true }),
        Object.assign(mkNote({ noteTime: 4, hit: false }), { ignoredAsDetectorFailure: true }),
        mkNote({ noteTime: 5, hit: true }),
    ];
    const s = core.scoresFromNotes(notes);
    assert.strictEqual(s.total, 3);                 // 5 entries, 2 demoted
    assert.strictEqual(s.hits, 2);
    assert.strictEqual(s.misses, 1);
    assert.ok(Math.abs(s.detection - 2 / 3) < 1e-9);
});

test('scoresFromNotes — late hits drop precision, leave detection alone', () => {
    const notes = [
        mkNote({ noteTime: 1, hit: true, timingState: 'OK' }),
        mkNote({ noteTime: 2, hit: true, timingState: 'LATE', timingError: 80 }),
        mkNote({ noteTime: 3, hit: true, timingState: 'LATE', timingError: 70 }),
    ];
    const s = core.scoresFromNotes(notes);
    assert.strictEqual(s.detection, 1);          // all three hit
    assert.strictEqual(s.precision, 1 / 3);      // only one is precise
    assert.strictEqual(s.timingMedianMs, 70);    // median of [0, 80, 70] sorted = 70
});

test('computeScoreDeltas — both sides, returns signed diffs', () => {
    const cur = { detection: 0.8, precision: 0.5, combined: 0.8, pitchPct: 0.9, coverage: 1, timingMedianMs: 30 };
    const pri = { detection: 0.6, precision: 0.4, combined: 0.6, pitchPct: 0.7, coverage: 1, timingMedianMs: 50 };
    const d = core.computeScoreDeltas(cur, pri);
    assert.ok(Math.abs(d.detection - 0.2) < 1e-9);
    assert.ok(Math.abs(d.precision - 0.1) < 1e-9);
    assert.ok(Math.abs(d.timingMedianMs + 20) < 1e-9);
});

test('computeScoreDeltas — null inputs', () => {
    assert.strictEqual(core.computeScoreDeltas(null, {}), null);
    assert.strictEqual(core.computeScoreDeltas({}, null), null);
});

test('findMissClusters — no off-target → empty', () => {
    const notes = [
        mkNote({ noteTime: 1, hit: true }),
        mkNote({ noteTime: 2, hit: true }),
    ];
    const clusters = core.findMissClusters(notes);
    // Sandbox-realm arrays aren't reference-equal to main-realm `[]`,
    // so check length rather than identity.
    assert.strictEqual(clusters.length, 0);
});

test('findMissClusters — dense miss pocket → one cluster', () => {
    const notes = [
        mkNote({ noteTime: 0,  hit: true }),
        mkNote({ noteTime: 10, hit: false }),
        mkNote({ noteTime: 11, hit: false }),
        mkNote({ noteTime: 12, hit: false }),
        mkNote({ noteTime: 30, hit: true }),
    ];
    const clusters = core.findMissClusters(notes, { minOffTarget: 2 });
    assert.strictEqual(clusters.length, 1);
    assert.ok(clusters[0].misses >= 3);
    assert.ok(clusters[0].startSec <= 10);
    assert.ok(clusters[0].endSec >= 12);
});

test('findOverlappingPriorCluster — picks max-overlap', () => {
    const cur = { startSec: 10, endSec: 20 };
    const priors = [
        { startSec: 0, endSec: 5 },     // no overlap
        { startSec: 12, endSec: 15 },   // 3s overlap
        { startSec: 18, endSec: 25 },   // 2s overlap
    ];
    const best = core.findOverlappingPriorCluster(cur, priors);
    assert.deepStrictEqual(best, priors[1]);
});

test('findOverlappingPriorCluster — null when no overlap', () => {
    const cur = { startSec: 100, endSec: 110 };
    const priors = [{ startSec: 0, endSec: 50 }];
    assert.strictEqual(core.findOverlappingPriorCluster(cur, priors), null);
});

test('computeTimeHeatmap — bins span totalDuration, empties carry null score', () => {
    const notes = [
        mkNote({ noteTime: 1, hit: true }),
        mkNote({ noteTime: 2, hit: true }),
        // no notes in 5..10
        mkNote({ noteTime: 12, hit: false }),
    ];
    const bins = core.computeTimeHeatmap(notes, 15, 5);
    assert.strictEqual(bins.length, 3);
    assert.strictEqual(bins[0].score, 1);       // both hits in [0, 5)
    assert.strictEqual(bins[1].score, null);    // no notes in [5, 10)
    assert.strictEqual(bins[2].score, 0);       // miss in [10, 15)
});

test('aggregateBySection — assigns by sectionName field', () => {
    const notes = [
        mkNote({ noteTime: 1, hit: true,  sectionName: 'intro' }),
        mkNote({ noteTime: 2, hit: false, sectionName: 'intro' }),
        mkNote({ noteTime: 5, hit: true,  sectionName: 'verse' }),
    ];
    const agg = core.aggregateBySection(notes, []);
    assert.strictEqual(agg.get('intro').hits, 1);
    assert.strictEqual(agg.get('intro').misses, 1);
    assert.strictEqual(agg.get('intro').accuracy, 0.5);
    assert.strictEqual(agg.get('verse').hits, 1);
});

test('aggregateBySection — falls back to chart-time lookup when sectionName absent', () => {
    const notes = [
        mkNote({ noteTime: 1, hit: true }),
        mkNote({ noteTime: 4, hit: true }),
    ];
    const sections = [
        { name: 'intro', startTime: 0 },
        { name: 'verse', startTime: 3 },
    ];
    const agg = core.aggregateBySection(notes, sections);
    assert.strictEqual(agg.get('intro').hits, 1);
    assert.strictEqual(agg.get('verse').hits, 1);
});

test('isDuplicateLoop — within tolerance', () => {
    const existing = [{ start: 10, end: 20 }];
    assert.strictEqual(core.isDuplicateLoop(10.3, 20.2, existing, 0.5), true);
    assert.strictEqual(core.isDuplicateLoop(11, 20, existing, 0.5), false);
});

test('scoreColor — bands', () => {
    assert.strictEqual(core.scoreColor(0.95), '#10b981');  // green
    assert.strictEqual(core.scoreColor(0.75), '#eab308');  // yellow
    assert.strictEqual(core.scoreColor(0.50), '#f97316');  // orange
    assert.strictEqual(core.scoreColor(0.20), '#dc2626');  // red
    assert.strictEqual(core.scoreColor(null), '#4b5563');  // neutral
});

test('fmtMmSs — basic', () => {
    assert.strictEqual(core.fmtMmSs(0), '0:00');
    assert.strictEqual(core.fmtMmSs(65), '1:05');
    assert.strictEqual(core.fmtMmSs(125.7), '2:05');
});

// ── Unit 3b — exportCoachingAnalysis bundle ───────────────────────────────

test('exportCoachingAnalysis — empty play returns shaped bundle', () => {
    const result = core.exportCoachingAnalysis({ noteResults: [] }, { totalDuration: 0 });
    assert.strictEqual(typeof result, 'object');
    assert.ok('derived' in result);
    assert.ok('clusters' in result);
    assert.ok('perSection' in result);
    assert.ok('timeHeatmap' in result);
    assert.ok('topFix' in result);
    assert.strictEqual(result.derived.detection, 0);
    assert.strictEqual(result.clusters.length, 0);
    assert.strictEqual(result.topFix, null);
});

test('exportCoachingAnalysis — derived scores match scoresFromNotes for the same input', () => {
    const notes = [
        mkNote({ noteTime: 1, hit: true }),
        mkNote({ noteTime: 2, hit: false }),
        mkNote({ noteTime: 3, hit: true }),
    ];
    const bundle = core.exportCoachingAnalysis({ noteResults: notes }, { totalDuration: 10 });
    const direct = core.scoresFromNotes(notes);
    assert.strictEqual(bundle.derived.detection, direct.detection);
    assert.strictEqual(bundle.derived.precision, direct.precision);
    assert.strictEqual(bundle.derived.combined, direct.combined);
});

test('exportCoachingAnalysis — perSection serialized as plain object', () => {
    const notes = [
        mkNote({ noteTime: 1, hit: true,  sectionName: 'intro' }),
        mkNote({ noteTime: 2, hit: false, sectionName: 'intro' }),
    ];
    const bundle = core.exportCoachingAnalysis({ noteResults: notes }, { totalDuration: 10 });
    // Must be a plain object (NOT a Map) so it round-trips through JSON.
    assert.strictEqual(typeof bundle.perSection, 'object');
    assert.ok(bundle.perSection.intro);
    assert.strictEqual(bundle.perSection.intro.hits, 1);
    assert.strictEqual(bundle.perSection.intro.misses, 1);
    assert.strictEqual(bundle.perSection.intro.accuracy, 0.5);
});

test('exportCoachingAnalysis — axis-level topFix when timing is consistently late', () => {
    // 10 hits, all 100ms late → median 100ms triggers Timing axis
    const notes = [];
    for (let i = 0; i < 10; i++) {
        notes.push(mkNote({ noteTime: i, hit: true, timingState: 'LATE', timingError: 100 }));
    }
    const bundle = core.exportCoachingAnalysis({ noteResults: notes }, { totalDuration: 10 });
    assert.ok(bundle.topFix);
    assert.strictEqual(bundle.topFix.kind, 'axis');
    assert.strictEqual(bundle.topFix.axis, 'Timing');
    assert.ok(bundle.topFix.focus.includes('late'));
});

test('exportCoachingAnalysis — totalDuration passed through for renderer', () => {
    const bundle = core.exportCoachingAnalysis({ noteResults: [] }, { totalDuration: 240 });
    assert.strictEqual(bundle.totalDuration, 240);
});

// ── Unit 3c — modal HTML renderers ────────────────────────────────────────

test('renderSubScoreTile — basic shape', () => {
    const html = core.renderSubScoreTile('Pitch', '85%', '#10b981', 'nd-delta-pitch');
    assert.ok(html.includes('Pitch'));
    assert.ok(html.includes('85%'));
    assert.ok(html.includes('#10b981'));
    assert.ok(html.includes('id="nd-delta-pitch"'));
});

test('renderSubScoreTile — no delta slot when id omitted', () => {
    const html = core.renderSubScoreTile('Pitch', '85%', '#10b981');
    assert.ok(html.includes('Pitch'));
    assert.ok(!html.includes('nd-delta-'));
});

// ── Unit 3d — heatmap SVG renderers ───────────────────────────────────────

test('renderTimeHeatmapSvg — empty input returns valid empty SVG', () => {
    const html = core.renderTimeHeatmapSvg([], 0, []);
    assert.ok(html.startsWith('<svg'));
    assert.ok(html.includes('</svg>'));
    assert.ok(!html.includes('<rect'));
});

test('renderTimeHeatmapSvg — bins render as rects with score-derived colors', () => {
    const heatmap = [
        { startSec: 0,  endSec: 5,  score: 1.0,  hits: 5, totalNotes: 5, misses: 0 },
        { startSec: 5,  endSec: 10, score: null, hits: 0, totalNotes: 0, misses: 0 },
        { startSec: 10, endSec: 15, score: 0.2,  hits: 1, totalNotes: 5, misses: 4 },
    ];
    const html = core.renderTimeHeatmapSvg(heatmap, 15);
    // 3 bins → 3 rects
    const rectCount = (html.match(/<rect/g) || []).length;
    assert.strictEqual(rectCount, 3);
    // Score=1.0 → green, score=null → neutral, score=0.2 → red
    assert.ok(html.includes('#10b981'));   // green
    assert.ok(html.includes('#1f2937'));   // empty bin neutral
    assert.ok(html.includes('#dc2626'));   // red
    // Hover titles include time range
    assert.ok(html.includes('0:00'));
    assert.ok(html.includes('no notes'));
});

test('renderTimeHeatmapSvg — section markers overlay when sections provided', () => {
    const heatmap = [
        { startSec: 0, endSec: 30, score: 1, hits: 1, totalNotes: 1, misses: 0 },
    ];
    const sections = [{ name: 'intro', time: 0 }, { name: 'verse', time: 15 }];
    const html = core.renderTimeHeatmapSvg(heatmap, 30, sections);
    assert.ok(html.includes('<line'));
    assert.ok(html.includes('intro'));
    assert.ok(html.includes('verse'));
});

test('renderSectionHeatmapSvg — accepts perSection as plain object (Unit 3b shape)', () => {
    const sections = [
        { name: 'intro', time: 0 },
        { name: 'verse', time: 30 },
    ];
    const perSectionObj = {
        intro: { hits: 4, misses: 1, total: 5, accuracy: 0.8 },
        verse: { hits: 0, misses: 0, total: 0, accuracy: null },
    };
    const html = core.renderSectionHeatmapSvg(perSectionObj, sections, 60);
    const rectCount = (html.match(/<rect/g) || []).length;
    assert.strictEqual(rectCount, 2);
    assert.ok(html.includes('intro: 80%'));
    assert.ok(html.includes('verse: no notes'));
});

test('renderSectionHeatmapSvg — accepts perSection as Map (Unit 3a shape)', () => {
    const sections = [{ name: 'intro', time: 0 }];
    const perSectionMap = new Map();
    perSectionMap.set('intro', { hits: 5, misses: 0, total: 5, accuracy: 1.0 });
    const html = core.renderSectionHeatmapSvg(perSectionMap, sections, 30);
    assert.ok(html.includes('intro: 100%'));
});

test('renderSectionHeatmapSvg — empty sections → empty SVG', () => {
    const html = core.renderSectionHeatmapSvg({}, [], 60);
    assert.ok(html.startsWith('<svg'));
    assert.ok(!html.includes('<rect'));
});

test('renderClusterRow — uses _ndScoresFromNotes for accuracy', () => {
    const cluster = {
        startSec: 30,
        endSec: 36,
        misses: 2,
        total: 5,
        notes: [
            mkNote({ noteTime: 30, hit: true }),
            mkNote({ noteTime: 31, hit: false }),
            mkNote({ noteTime: 32, hit: true }),
            mkNote({ noteTime: 33, hit: false }),
            mkNote({ noteTime: 34, hit: true }),
        ],
    };
    const html = core.renderClusterRow(cluster, 0);
    assert.ok(html.includes('0:30'));      // _ndFmtMmSs(30)
    assert.ok(html.includes('0:36'));      // _ndFmtMmSs(36)
    assert.ok(html.includes('2 off-target'));
    assert.ok(html.includes('5 notes'));
    assert.ok(html.includes('data-drill-cluster="0"'));
    assert.ok(html.includes('data-drill-speed="1"') || html.includes('data-drill-speed="1.0"'));
});

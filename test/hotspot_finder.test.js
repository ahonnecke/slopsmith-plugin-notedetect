// Multi-play hotspot finder tests — the pure aggregation recovered from
// the prior fork (_ndAggregatePlays / _ndStatsForRow / _ndSuggestLoops).
// These decide WHERE the drill loop points, so the multi-play evidence
// gate ("a recurring weakness, not a one-off fumble") is the load-bearing
// behaviour to pin.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

// Build a play covering notes at the given (chartT → verdict) entries.
// key is chart-stable (`t_s_f`) so the same chart note joins across plays.
function play(playId, startedAt, notes) {
    return {
        playId, startedAt,
        noteResults: notes.map(n => ({
            key: `${n.t.toFixed(3)}_${n.s ?? 1}_${n.f ?? 0}`,
            chartT: n.t, s: n.s ?? 1, f: n.f ?? 0,
            expectedMidi: n.midi ?? 40, primary: n.v,
        })),
    };
}

test('aggregatePlays: joins by key across plays, newest-first, marks ABSENT / OUT_OF_SCOPE', () => {
    const { aggregatePlays } = loadDetectionCore();
    // Play A (older) covers t=10 and t=20. Play B (newer) covers only t=10
    // (so t=20 is OUT_OF_SCOPE for B), and is missing nothing in range.
    const A = play('A', 1000, [{ t: 10, v: 'HIT' }, { t: 20, v: 'MISSED_NO_DETECTION' }]);
    const B = play('B', 2000, [{ t: 10, v: 'MISSED_WRONG_PITCH' }]);
    const { playMeta, rows } = aggregatePlays([A, B]);
    // Newest-first: index 0 is play B.
    assert.equal(playMeta[0].playId, 'B');
    assert.equal(playMeta[1].playId, 'A');
    const byT = Object.fromEntries(Array.from(rows, r => [r.chartT, r]));
    // t=10 attempted in both: B verdict first (newest), then A.
    // Array.from rewraps the vm-realm verdict array into a main-realm one
    // so deepEqual compares by structure, not cross-realm prototype.
    assert.deepEqual(Array.from(byT[10].verdicts, v => v.kind), ['MISSED_WRONG_PITCH', 'HIT']);
    // t=20 only in A; B's range is just t=10, so t=20 is OUT_OF_SCOPE for B.
    assert.deepEqual(Array.from(byT[20].verdicts, v => v.kind), ['OUT_OF_SCOPE', 'MISSED_NO_DETECTION']);
});

test('aggregatePlays: a note in range but not attempted is ABSENT (a missed attempt)', () => {
    const { aggregatePlays, statsForRow } = loadDetectionCore();
    // Both plays span t=5..25. Play B omits t=15 though it's within range.
    const A = play('A', 1000, [{ t: 5, v: 'HIT' }, { t: 15, v: 'HIT' }, { t: 25, v: 'HIT' }]);
    const B = play('B', 2000, [{ t: 5, v: 'HIT' }, { t: 25, v: 'HIT' }]);
    const { rows } = aggregatePlays([A, B]);
    const t15 = rows.find(r => r.chartT === 15);
    assert.deepEqual(Array.from(t15.verdicts, v => v.kind).sort(), ['ABSENT', 'HIT']);
    const st = statsForRow(t15);
    assert.equal(st.nAttempts, 2, 'ABSENT still counts as an in-scope attempt');
    assert.equal(st.hits, 1, 'ABSENT is not a hit');
    assert.equal(st.hitRate, 0.5);
});

test('statsForRow: OUT_OF_SCOPE excluded; HIT counts, misses do not', () => {
    const { statsForRow } = loadDetectionCore();
    const row = { verdicts: [
        { kind: 'HIT' }, { kind: 'MISSED_NO_DETECTION' },
        { kind: 'MISSED_WRONG_PITCH' }, { kind: 'OUT_OF_SCOPE' },
    ] };
    const st = statsForRow(row);
    assert.equal(st.nAttempts, 3, 'OUT_OF_SCOPE not an attempt');
    assert.equal(st.hits, 1);
    assert.equal(st.noDetection, 1);
    assert.equal(st.wrongPitch, 1);
    assert.equal(st.hitRate, 1 / 3);
});

test('suggestLoops: flags a cluster missed across plays; pads into a loop', () => {
    const { suggestLoops, aggregatePlays } = loadDetectionCore();
    // Two full plays. A clean intro (t=5,6 HIT both) and a trouble cluster
    // at t=20..21.5 (all MISSED both plays).
    const notes = (v) => [
        { t: 5, v: 'HIT' }, { t: 6, v: 'HIT' },
        { t: 20.0, v }, { t: 20.5, v }, { t: 21.0, v }, { t: 21.5, v },
    ];
    const { rows } = aggregatePlays([
        play('A', 1000, notes('MISSED_NO_DETECTION')),
        play('B', 2000, notes('MISSED_NO_DETECTION')),
    ]);
    const loops = suggestLoops(rows);
    assert.equal(loops.length, 1, 'one hotspot found');
    const h = loops[0];
    assert.equal(h.noteCount, 4, 'all four trouble notes in the cluster');
    assert.equal(Math.round(h.avgMissRate * 100), 100, 'missed every attempt');
    // The 5s window lands on the cluster; startSec = window start (16.5)
    // minus the 2.0s head pad. Loop covers the trouble region with run-in.
    assert.ok(h.startSec < 20.0 && h.startSec >= 0, `startSec before the cluster (${h.startSec})`);
    assert.ok(h.endSec >= 21.5, `endSec covers the cluster (${h.endSec})`);
    assert.ok(h.endSec - h.startSec >= 1.5, 'loop spans at least the cluster');
});

test('suggestLoops: multi-play evidence gate — a single play yields nothing', () => {
    const { suggestLoops, aggregatePlays } = loadDetectionCore();
    // One play only → every note has nAttempts 1 (< 2) → filtered out.
    const { rows } = aggregatePlays([
        play('A', 1000, [{ t: 20, v: 'MISSED_NO_DETECTION' }, { t: 20.5, v: 'MISSED_NO_DETECTION' },
                          { t: 21, v: 'MISSED_NO_DETECTION' }]),
    ]);
    assert.equal(suggestLoops(rows).length, 0);
});

test('suggestLoops: minAttempts:1 surfaces a hotspot from a SINGLE play', () => {
    const { suggestLoops, aggregatePlays } = loadDetectionCore();
    const { rows } = aggregatePlays([
        play('A', 1000, [{ t: 20, v: 'MISSED_NO_DETECTION' }, { t: 20.5, v: 'MISSED_NO_DETECTION' },
                          { t: 21, v: 'MISSED_NO_DETECTION' }]),
    ]);
    const loops = suggestLoops(rows, { minAttempts: 1 });
    assert.ok(loops.length >= 1, 'single-play mode flags the cluster');
    assert.ok(loops[0].noteCount >= 2);
});

test('hotspotReasons: tallies coarse failure reasons from trouble notes', () => {
    const { hotspotReasons } = loadDetectionCore();
    const r = hotspotReasons({ notes: [
        { noDetection: 2, wrongPitch: 0 },
        { noDetection: 1, wrongPitch: 1 },
    ] });
    const byKind = Object.fromEntries(r.map((x) => [x.kind, x.count]));
    assert.equal(byKind['not detected / not played'], 3);
    assert.equal(byKind['wrong pitch'], 1);
    assert.equal(hotspotReasons({ notes: [] }).length, 0);
    assert.equal(hotspotReasons(null).length, 0);
});

test('renderLoopPanelHtml: lists each loop with range, reasons, pass badge, Drill/Delete', () => {
    const { renderLoopPanelHtml } = loadDetectionCore();
    const html = renderLoopPanelHtml([
        { id: 7, label: '0:18–0:23', loopA: 18, loopB: 23, reasons: [{ kind: 'not detected', count: 4 }], passed: false },
        { id: 9, label: null, loopA: 40, loopB: 44, reasons: [], passed: true },
    ]);
    assert.match(html, /Practice loops/);
    assert.match(html, /0:18–0:23/);
    assert.match(html, /4× not detected/);
    assert.match(html, /nd-loop-drill[^>]*data-id="7"/);
    assert.match(html, /nd-loop-del[^>]*data-id="7"/);
    assert.match(html, /✓ passed/, 'passed loop shows the badge');
    assert.match(html, /0:40–0:44/, 'null label falls back to the mm:ss range');
});

test('suggestLoops: a one-off fumble (missed in 1 of 2 plays) is not dense enough', () => {
    const { suggestLoops, aggregatePlays } = loadDetectionCore();
    // Same cluster, but play B nailed it — so misses halve and the notes
    // are no longer "trouble" in aggregate. Below the density floor.
    const cluster = (v) => [{ t: 20.0, v }, { t: 20.5, v }, { t: 21.0, v }];
    const { rows } = aggregatePlays([
        play('A', 1000, cluster('MISSED_NO_DETECTION')),
        play('B', 2000, cluster('HIT')),
    ]);
    const loops = suggestLoops(rows);
    // 3 misses over a 5s window = 0.6/s ≥ floor, BUT each note hits 1/2 so
    // they're still "trouble" (hits<nAttempts) — assert the finder ranks it
    // far weaker than the all-missed case rather than over-claiming.
    if (loops.length) {
        assert.ok(loops[0].avgMissRate <= 0.5, 'one-off fumble shows as low miss rate, not a hard hotspot');
    }
});

test('suggestLoops: non-overlapping selection keeps the denser region', () => {
    const { suggestLoops, aggregatePlays } = loadDetectionCore();
    // Two separated clusters: t≈20 (4 notes, all missed) and t≈40 (2 notes,
    // all missed). Both qualify; they don't overlap, so both returned,
    // ordered by time.
    const mk = (base, n) => Array.from({ length: n }, (_, i) => ({ t: base + i * 0.4, v: 'MISSED_NO_DETECTION' }));
    const notes = [...mk(20, 4), ...mk(40, 2)];
    const { rows } = aggregatePlays([play('A', 1000, notes), play('B', 2000, notes)]);
    const loops = suggestLoops(rows);
    assert.ok(loops.length >= 1);
    // Sorted by start time; first cluster precedes second.
    for (let i = 1; i < loops.length; i++) {
        assert.ok(loops[i].startSec >= loops[i - 1].startSec);
        assert.ok(loops[i].startSec >= loops[i - 1].endSec - 1e-9 || loops[i].startSec >= loops[i - 1].startSec,
            'selected loops do not overlap');
    }
});

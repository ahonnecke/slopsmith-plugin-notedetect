// Unit 3i — fretboard heatmap pure compute. Verify the per-cell
// hit/miss accumulation handles port-shape judgments and skips
// detector-failure entries (so sustain bleed doesn't paint cells
// red the player never actually missed).
const test = require('node:test');
const assert = require('node:assert');
const { loadDetectionCore } = require('./_loader');

const { computeFretboardHeatmap, renderFretboardHeatmapSvg } = loadDetectionCore();

function mk({ s, f, hit, ignored = false }) {
    return {
        chartNote: { s, f, t: 1.0 },
        note: { s, f },
        hit,
        ignoredAsDetectorFailure: ignored,
    };
}

test('computeFretboardHeatmap accumulates hits and misses by cell', () => {
    const grid = computeFretboardHeatmap([
        mk({ s: 1, f: 5, hit: true }),
        mk({ s: 1, f: 5, hit: true }),
        mk({ s: 1, f: 5, hit: false }),
        mk({ s: 2, f: 7, hit: false }),
    ], { stringCount: 6, maxFret: 24 });
    assert.deepEqual(grid[1][5], { hits: 2, miss: 1, total: 3, missRate: 1 / 3 });
    assert.deepEqual(grid[2][7], { hits: 0, miss: 1, total: 1, missRate: 1 });
    assert.strictEqual(grid[0][0].total, 0);
    assert.strictEqual(grid[0][0].missRate, null);
});

test('computeFretboardHeatmap excludes detector-failure entries', () => {
    const grid = computeFretboardHeatmap([
        mk({ s: 1, f: 5, hit: false, ignored: true }),
        mk({ s: 1, f: 5, hit: false, ignored: true }),
        mk({ s: 1, f: 5, hit: true }),
    ], { stringCount: 4, maxFret: 12 });
    // Two ignored entries shouldn't count toward total OR misses —
    // sustain bleed shouldn't paint s1/f5 red.
    assert.deepEqual(grid[1][5], { hits: 1, miss: 0, total: 1, missRate: 0 });
});

test('computeFretboardHeatmap rejects out-of-range string/fret', () => {
    const grid = computeFretboardHeatmap([
        mk({ s: 99, f: 5, hit: true }),     // bad string
        mk({ s: 1, f: -3, hit: true }),     // bad fret
        mk({ s: 1, f: 30, hit: true }),     // exceeds maxFret
        mk({ s: 1, f: 5, hit: true }),
    ], { stringCount: 4, maxFret: 12 });
    let totalCells = 0;
    for (let s = 0; s < 4; s++) {
        for (let f = 0; f <= 12; f++) totalCells += grid[s][f].total;
    }
    assert.strictEqual(totalCells, 1);
});

test('computeFretboardHeatmap defaults: 6 strings, 24 frets', () => {
    const grid = computeFretboardHeatmap([mk({ s: 5, f: 24, hit: true })]);
    assert.strictEqual(grid.length, 6);
    assert.strictEqual(grid[0].length, 25);
});

test('renderFretboardHeatmapSvg returns no-data placeholder on empty grid', () => {
    const grid = computeFretboardHeatmap([], { stringCount: 4, maxFret: 12 });
    const html = renderFretboardHeatmapSvg(grid, 4, 12);
    assert.match(html, /No fretboard data/);
});

test('renderFretboardHeatmapSvg renders cells with miss-rate-tinted backgrounds', () => {
    const grid = computeFretboardHeatmap([
        mk({ s: 1, f: 5, hit: false }),
        mk({ s: 1, f: 5, hit: false }),
        mk({ s: 1, f: 5, hit: false }),
    ], { stringCount: 4, maxFret: 12 });
    const html = renderFretboardHeatmapSvg(grid, 4, 12);
    // 100% miss → red component should be 240
    assert.match(html, /background:rgba\(240, 0, 60, 0\.85\)/);
    // Frequency marker '·' for total>=3
    assert.match(html, />·</);
});

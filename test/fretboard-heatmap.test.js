// _ndComputeFretboardHeatmap — pure 2D aggregation by (string, fret).
// Drives the fretboard heatmap UI: per-position miss rate across recent
// plays. Useful for spotting muscle-memory issues that the time-based
// timeline can't surface (e.g. always missing a specific fret regardless
// of where it appears in the song).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const core = loadDetectionCore();

const note = (s, f, primary, chartT = 1.0) => ({
    s, f, chartT, primary,
    key: `${chartT}-${s}-${f}`,
});
const play = (...notes) => ({ noteResults: notes });

test('empty plays: all cells null missRate', () => {
    const grid = core.computeFretboardHeatmap([], { stringCount: 4, maxFret: 12 });
    assert.equal(grid.length, 4);
    assert.equal(grid[0].length, 13);   // frets 0..12 inclusive
    for (let s = 0; s < 4; s++) {
        for (let f = 0; f <= 12; f++) {
            assert.equal(grid[s][f].missRate, null);
            assert.equal(grid[s][f].total, 0);
        }
    }
});

test('hits and misses tracked per position', () => {
    const plays = [play(
        note(1, 5, 'HIT'),
        note(1, 5, 'HIT'),
        note(1, 5, 'MISSED_NO_DETECTION'),
        note(2, 7, 'HIT'),
    )];
    const grid = core.computeFretboardHeatmap(plays, { stringCount: 4, maxFret: 12 });
    assert.equal(grid[1][5].total, 3);
    assert.equal(grid[1][5].hits, 2);
    assert.equal(grid[1][5].miss, 1);
    assert.ok(Math.abs(grid[1][5].missRate - 1/3) < 0.001);
    assert.equal(grid[2][7].total, 1);
    assert.equal(grid[2][7].missRate, 0);
});

test('multiple plays accumulate per position', () => {
    const plays = [
        play(note(1, 5, 'HIT'), note(1, 5, 'MISSED_NO_DETECTION')),
        play(note(1, 5, 'HIT'), note(1, 5, 'HIT')),
    ];
    const grid = core.computeFretboardHeatmap(plays, { stringCount: 4, maxFret: 12 });
    assert.equal(grid[1][5].total, 4);
    assert.equal(grid[1][5].hits, 3);
    assert.equal(grid[1][5].miss, 1);
});

test('out-of-bounds string/fret values ignored', () => {
    const plays = [play(
        note(99, 5, 'HIT'),       // string out of range
        note(-1, 5, 'HIT'),       // negative
        note(1, 99, 'HIT'),       // fret out of range
        note(1, -2, 'HIT'),       // negative fret
        note(1, 5, 'HIT'),        // valid
    )];
    const grid = core.computeFretboardHeatmap(plays, { stringCount: 4, maxFret: 12 });
    let total = 0;
    for (let s = 0; s < 4; s++)
        for (let f = 0; f <= 12; f++)
            total += grid[s][f].total;
    assert.equal(total, 1);
});

test('open string (fret 0) tracked separately from fretted notes', () => {
    const plays = [play(
        note(0, 0, 'HIT'),    // open
        note(0, 0, 'HIT'),
        note(0, 5, 'MISSED_NO_DETECTION'),  // fretted
    )];
    const grid = core.computeFretboardHeatmap(plays, { stringCount: 4, maxFret: 12 });
    assert.equal(grid[0][0].total, 2);
    assert.equal(grid[0][0].missRate, 0);
    assert.equal(grid[0][5].total, 1);
    assert.equal(grid[0][5].missRate, 1);
});

test('non-classifiable primary skipped', () => {
    const plays = [play(
        note(1, 5, 'HIT'),
        note(1, 5, 'WRONG_PITCH_OUTSIDE_TOLERANCE'),   // unknown
        note(1, 5, 'MISSED_NO_DETECTION'),
    )];
    const grid = core.computeFretboardHeatmap(plays, { stringCount: 4, maxFret: 12 });
    assert.equal(grid[1][5].total, 2);   // HIT + MISS, not the unknown
});

test('default options: 4 strings, 24 frets', () => {
    const plays = [play(note(0, 0, 'HIT'), note(3, 24, 'HIT'))];
    const grid = core.computeFretboardHeatmap(plays);
    assert.equal(grid.length, 4);
    assert.equal(grid[0].length, 25);
    assert.equal(grid[3][24].total, 1);
});

test('guitar (6 strings) opt-in', () => {
    const plays = [play(note(5, 4, 'HIT'))];
    const grid = core.computeFretboardHeatmap(plays, { stringCount: 6, maxFret: 24 });
    assert.equal(grid.length, 6);
    assert.equal(grid[5][4].total, 1);
});

test('null/undefined plays handled', () => {
    const a = core.computeFretboardHeatmap(null);
    const b = core.computeFretboardHeatmap(undefined);
    assert.equal(a.length, 4);
    assert.equal(b.length, 4);
});

test('missRate calculation: 60% miss rate', () => {
    const plays = [play(
        note(1, 5, 'HIT'),
        note(1, 5, 'HIT'),
        note(1, 5, 'MISSED_NO_DETECTION'),
        note(1, 5, 'MISSED_NO_DETECTION'),
        note(1, 5, 'MISSED_WRONG_PITCH'),
    )];
    const grid = core.computeFretboardHeatmap(plays, { stringCount: 4, maxFret: 12 });
    assert.equal(grid[1][5].total, 5);
    assert.equal(grid[1][5].miss, 3);
    assert.ok(Math.abs(grid[1][5].missRate - 0.6) < 0.001);
});

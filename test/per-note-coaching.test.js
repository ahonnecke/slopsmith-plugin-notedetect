// Per-note coaching feedback for a practice loop. Surfaces the dominant
// failure mode for each problem note so the user knows what to change.
//
// Output strings examples:
//   "Late ~80 ms (3/4)"        — mostly hits, but timing is consistently late
//   "Wrong fret (+85¢, 5/5)"    — wrong-pitch dominant, with average cents
//   "Not playing (3/4)"         — over half the attempts had no detection
//   "Never registered (4/4)"   — every attempt had no detection
//
// Notes with < 2 attempts return nothing (need multiple samples for signal).
// Clean notes (mostly hits, timing within ±50 ms) return nothing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const core = loadDetectionCore();

const note = (overrides) => ({
    key: `${overrides.s}|${overrides.f}|${overrides.chartT}`,
    primary: 'HIT',
    timingError: 0,
    pitchError: 0,
    s: 1, f: 5, chartT: 1.0, expectedMidi: 38,
    ...overrides,
});
const play = (...notes) => ({ noteResults: notes });

// ── Single-note coaching scenarios ──────────────────────────────────────

test('single attempt: no coaching (need >= 2 samples)', () => {
    const plays = [play(note({ primary: 'HIT', timingError: 200 }))];
    const items = core.perNoteCoaching(plays);
    assert.equal(items.length, 0);
});

test('clean playing: no coaching needed', () => {
    const plays = [
        play(note({ primary: 'HIT', timingError: 10 })),
        play(note({ primary: 'HIT', timingError: -5 })),
        play(note({ primary: 'HIT', timingError: 15 })),
    ];
    const items = core.perNoteCoaching(plays);
    assert.equal(items.length, 0);
});

test('consistently late: timing label', () => {
    const plays = [
        play(note({ primary: 'HIT', timingError: 80 })),
        play(note({ primary: 'HIT', timingError: 75 })),
        play(note({ primary: 'HIT', timingError: 90 })),
    ];
    const items = core.perNoteCoaching(plays);
    assert.equal(items.length, 1);
    assert.match(items[0].label, /Late/);
    assert.match(items[0].label, /3\/3/);
});

test('consistently early: timing label', () => {
    const plays = [
        play(note({ primary: 'HIT', timingError: -75 })),
        play(note({ primary: 'HIT', timingError: -90 })),
    ];
    const items = core.perNoteCoaching(plays);
    assert.equal(items.length, 1);
    assert.match(items[0].label, /Early/);
});

test('mostly missed: not-playing label', () => {
    const plays = [
        play(note({ primary: 'MISSED_NO_DETECTION' })),
        play(note({ primary: 'MISSED_NO_DETECTION' })),
        play(note({ primary: 'HIT', timingError: 10 })),
    ];
    const items = core.perNoteCoaching(plays);
    assert.equal(items.length, 1);
    assert.match(items[0].label, /Not playing/);
    assert.match(items[0].label, /2\/3/);
});

test('all attempts missed: never-registered label', () => {
    const plays = [
        play(note({ primary: 'MISSED_NO_DETECTION' })),
        play(note({ primary: 'MISSED_NO_DETECTION' })),
        play(note({ primary: 'MISSED_NO_DETECTION' })),
    ];
    const items = core.perNoteCoaching(plays);
    assert.equal(items.length, 1);
    assert.match(items[0].label, /Never registered/);
});

test('mostly wrong pitch: wrong-fret label with cents', () => {
    const plays = [
        play(note({ primary: 'MISSED_WRONG_PITCH', pitchError: 85 })),
        play(note({ primary: 'MISSED_WRONG_PITCH', pitchError: 95 })),
        play(note({ primary: 'MISSED_WRONG_PITCH', pitchError: 75 })),
    ];
    const items = core.perNoteCoaching(plays);
    assert.equal(items.length, 1);
    assert.match(items[0].label, /Wrong fret/);
    assert.match(items[0].label, /\+85¢|\+90¢|\+85¢/);
});

// ── Multi-note loop coaching ───────────────────────────────────────────

test('multiple problem notes: ranked by severity', () => {
    const plays = [
        play(
            note({ s: 1, f: 5, chartT: 1.0, primary: 'MISSED_NO_DETECTION' }),    // bad
            note({ s: 2, f: 7, chartT: 2.0, primary: 'HIT', timingError: 80 }),   // late
            note({ s: 3, f: 0, chartT: 3.0, primary: 'HIT', timingError: 5 }),    // clean
        ),
        play(
            note({ s: 1, f: 5, chartT: 1.0, primary: 'MISSED_NO_DETECTION' }),
            note({ s: 2, f: 7, chartT: 2.0, primary: 'HIT', timingError: 70 }),
            note({ s: 3, f: 0, chartT: 3.0, primary: 'HIT', timingError: -10 }),
        ),
    ];
    const items = core.perNoteCoaching(plays);
    assert.equal(items.length, 2);   // clean note excluded
    // Highest severity first (the never-played note)
    assert.equal(items[0].chartT, 1.0);
    assert.match(items[0].label, /Never registered/);
    assert.equal(items[1].chartT, 2.0);
    assert.match(items[1].label, /Late/);
});

test('loop range filter: notes outside range excluded', () => {
    const plays = [
        play(
            note({ s: 1, f: 5, chartT: 0.5, primary: 'MISSED_NO_DETECTION' }),
            note({ s: 1, f: 5, chartT: 1.5, primary: 'MISSED_NO_DETECTION' }),
            note({ s: 1, f: 5, chartT: 2.5, primary: 'MISSED_NO_DETECTION' }),
        ),
        play(
            note({ s: 1, f: 5, chartT: 0.5, primary: 'MISSED_NO_DETECTION' }),
            note({ s: 1, f: 5, chartT: 1.5, primary: 'MISSED_NO_DETECTION' }),
            note({ s: 1, f: 5, chartT: 2.5, primary: 'MISSED_NO_DETECTION' }),
        ),
    ];
    // Loop range 1.0-2.0 should only include chartT=1.5
    const items = core.perNoteCoaching(plays, 1.0, 2.0);
    assert.equal(items.length, 1);
    assert.equal(items[0].chartT, 1.5);
});

test('range tolerance: 50ms slop on either side of loop boundaries', () => {
    // Notes at chartT 0.97 and 2.03 should be included for a 1.0-2.0 loop
    // (within 50ms of the boundary). Real loops aren't pixel-precise.
    const plays = [
        play(note({ chartT: 0.97, primary: 'MISSED_NO_DETECTION' })),
        play(note({ chartT: 0.97, primary: 'MISSED_NO_DETECTION' })),
    ];
    const items = core.perNoteCoaching(plays, 1.0, 2.0);
    assert.equal(items.length, 1);
});

// ── Edge cases ──────────────────────────────────────────────────────────

test('empty plays: empty result', () => {
    assert.equal(core.perNoteCoaching([]).length, 0);
    assert.equal(core.perNoteCoaching(null).length, 0);
});

test('plays with null noteResults: handled', () => {
    const plays = [{ noteResults: null }, { noteResults: undefined }];
    assert.equal(core.perNoteCoaching(plays).length, 0);
});

test('mixed dirty hits + clean hits count toward total', () => {
    const plays = [
        play(note({ primary: 'HIT', timingError: 70 })),
        play(note({ primary: 'DIRTY_HIT', timingError: 90 })),
    ];
    const items = core.perNoteCoaching(plays);
    assert.equal(items.length, 1);
    assert.match(items[0].label, /Late/);
    assert.match(items[0].label, /2\/2/);
});

test('jitter around zero: not flagged as late or early', () => {
    // Mean within 50ms threshold → no timing label.
    const plays = [
        play(note({ primary: 'HIT', timingError: 30 })),
        play(note({ primary: 'HIT', timingError: -20 })),
        play(note({ primary: 'HIT', timingError: 10 })),
    ];
    const items = core.perNoteCoaching(plays);
    assert.equal(items.length, 0);
});

// ── Strictness threshold ────────────────────────────────────────────────

test('80ms late: flagged in default mode (50ms threshold)', () => {
    const plays = [
        play(note({ primary: 'HIT', timingError: 80 })),
        play(note({ primary: 'HIT', timingError: 85 })),
    ];
    const items = core.perNoteCoaching(plays, undefined, undefined, { timingThresholdMs: 50 });
    assert.equal(items.length, 1);
    assert.match(items[0].label, /Late/);
});

test('80ms late: NOT flagged in rocksmith mode (200ms threshold)', () => {
    const plays = [
        play(note({ primary: 'HIT', timingError: 80 })),
        play(note({ primary: 'HIT', timingError: 85 })),
    ];
    const items = core.perNoteCoaching(plays, undefined, undefined, { timingThresholdMs: 200 });
    assert.equal(items.length, 0);
});

test('250ms late: flagged even in rocksmith mode', () => {
    const plays = [
        play(note({ primary: 'HIT', timingError: 240 })),
        play(note({ primary: 'HIT', timingError: 260 })),
    ];
    const items = core.perNoteCoaching(plays, undefined, undefined, { timingThresholdMs: 200 });
    assert.equal(items.length, 1);
});

test('40ms late: flagged in strict mode (25ms threshold)', () => {
    const plays = [
        play(note({ primary: 'HIT', timingError: 40 })),
        play(note({ primary: 'HIT', timingError: 35 })),
    ];
    const items = core.perNoteCoaching(plays, undefined, undefined, { timingThresholdMs: 25 });
    assert.equal(items.length, 1);
});

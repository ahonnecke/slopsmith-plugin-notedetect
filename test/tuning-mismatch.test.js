// Tuning-mismatch detector. Catches the case where a song's chart was
// authored for one tuning (e.g. standard E) but the instrument is
// playing in a different tuning (e.g. Eb), making every note read as
// "wrong pitch" with a consistent semitone offset.
//
// Signal: pitch errors cluster tightly around a non-zero semitone
// boundary. Detector returns { likely, median, semitoneOffset, ... }.
// Practice features suppress recommendations when likely=true.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const core = loadDetectionCore();

const note = (pitchError, primary = 'MISSED_WRONG_PITCH') => ({
    primary, pitchError,
    s: 1, f: 5, chartT: 1.0, expectedMidi: 38,
});
const play = (...notes) => ({ noteResults: notes });

// ── Clean playing: not flagged ──────────────────────────────────────────

test('clean playing (errors near 0): not flagged', () => {
    const errors = Array.from({ length: 50 }, (_, i) => (i % 2 ? 5 : -5));
    const plays = [play(...errors.map(e => note(e, 'HIT')))];
    const r = core.detectTuningMismatch(plays);
    assert.equal(r.likely, false);
});

test('insufficient samples (<20): not flagged', () => {
    const plays = [play(...Array.from({ length: 10 }, () => note(-100)))];
    const r = core.detectTuningMismatch(plays);
    assert.equal(r.likely, false);
    assert.equal(r.reason, 'insufficient');
});

// ── Eb tuning case (Stand_by_Me-style) ─────────────────────────────────

test('Eb tuning (errors clustered at -100¢): flagged', () => {
    const errors = Array.from({ length: 50 }, () => -100 + (Math.random() - 0.5) * 30);
    const plays = [play(...errors.map(e => note(e)))];
    const r = core.detectTuningMismatch(plays);
    assert.equal(r.likely, true);
    assert.equal(r.semitoneOffset, -1);
    assert.ok(Math.abs(r.median - (-100)) < 30);
    assert.ok(r.clusterFraction >= 0.7);
});

test('D tuning (errors at -200¢): flagged', () => {
    const errors = Array.from({ length: 50 }, () => -200 + (Math.random() - 0.5) * 30);
    const plays = [play(...errors.map(e => note(e)))];
    const r = core.detectTuningMismatch(plays);
    assert.equal(r.likely, true);
    assert.equal(r.semitoneOffset, -2);
});

test('F tuning (errors at +100¢): flagged', () => {
    const errors = Array.from({ length: 50 }, () => 100 + (Math.random() - 0.5) * 30);
    const plays = [play(...errors.map(e => note(e)))];
    const r = core.detectTuningMismatch(plays);
    assert.equal(r.likely, true);
    assert.equal(r.semitoneOffset, 1);
});

// ── Negative cases ──────────────────────────────────────────────────────

test('scattered errors (no tight cluster): not flagged', () => {
    const errors = Array.from({ length: 50 }, () => (Math.random() - 0.5) * 600);
    const plays = [play(...errors.map(e => note(e)))];
    const r = core.detectTuningMismatch(plays);
    assert.equal(r.likely, false);
});

test('slight detuning (median 30¢, not at semitone): not flagged', () => {
    // User's bass is slightly detuned but not a half-step off.
    const errors = Array.from({ length: 50 }, () => 30 + (Math.random() - 0.5) * 20);
    const plays = [play(...errors.map(e => note(e)))];
    const r = core.detectTuningMismatch(plays);
    assert.equal(r.likely, false);
});

test('cluster centre 50¢ off semitone: not flagged', () => {
    // Cluster at -50¢, halfway between in-tune and Eb. Real wrong-fret
    // playing, not tuning mismatch.
    const errors = Array.from({ length: 50 }, () => -50 + (Math.random() - 0.5) * 20);
    const plays = [play(...errors.map(e => note(e)))];
    const r = core.detectTuningMismatch(plays);
    assert.equal(r.likely, false);
});

test('mostly-clean with 20% wrong-pitch outliers: not flagged', () => {
    // Real practice scenario: most notes hit cleanly, some finger slips.
    const errors = [];
    for (let i = 0; i < 80; i++) errors.push((Math.random() - 0.5) * 20);   // clean
    for (let i = 0; i < 20; i++) errors.push(-200 + (Math.random() - 0.5) * 50);   // slips
    const plays = [play(...errors.map(e => note(e)))];
    const r = core.detectTuningMismatch(plays);
    assert.equal(r.likely, false);
});

// ── Edge cases ──────────────────────────────────────────────────────────

test('empty plays: not flagged', () => {
    const r = core.detectTuningMismatch([]);
    assert.equal(r.likely, false);
});

test('null plays: not flagged', () => {
    const r = core.detectTuningMismatch(null);
    assert.equal(r.likely, false);
});

test('records without pitchError: ignored', () => {
    const plays = [play(
        ...Array.from({ length: 20 }, () => ({ s: 1, f: 5, chartT: 1, primary: 'MISSED_NO_DETECTION' })),
        ...Array.from({ length: 30 }, () => note(-100)),
    )];
    const r = core.detectTuningMismatch(plays);
    assert.equal(r.n, 30);
    assert.equal(r.likely, true);
});

test('mixed sources: HIT + WRONG_PITCH all contribute pitchError', () => {
    // Hits with small pitch errors don't pull a strong cluster off zero.
    const errors = [];
    for (let i = 0; i < 30; i++) errors.push(-100 + (Math.random() - 0.5) * 20);
    for (let i = 0; i < 30; i++) errors.push(-95 + (Math.random() - 0.5) * 20);
    const plays = [play(...errors.map(e => note(e, e < -50 ? 'MISSED_WRONG_PITCH' : 'HIT')))];
    const r = core.detectTuningMismatch(plays);
    assert.equal(r.likely, true);
    assert.equal(r.semitoneOffset, -1);
});

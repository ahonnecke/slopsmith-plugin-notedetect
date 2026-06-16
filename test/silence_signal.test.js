// Silence signal: distinguishing "the player stopped / didn't play" (input was
// quiet) from the detector's low-string blind spot (string ringing, pitch
// unresolved). _ndIsSilentWindow is the pure peak-level-in-window check behind
// the miss judgment's `silent` flag; coaching/the LLM turn that into a confident
// "you stopped here" instead of hedging every no_detection.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');
const { isSilentWindow } = loadDetectionCore();

// {songT, level} samples in visual time; threshold 0.02 (the production floor).
const HALF = 0.2, THRESH = 0.02;
const at = (t, level) => ({ songT: t, level });

test('no samples at all → null (unknown, never treat as silent)', () => {
    assert.equal(isSilentWindow([], 5.0, HALF, THRESH), null);
    assert.equal(isSilentWindow(null, 5.0, HALF, THRESH), null);
});

test('no samples within the window → null (startup / post-seek gap)', () => {
    // Samples exist but all far from the center → no coverage.
    const s = [at(0.0, 0.5), at(0.1, 0.5)];
    assert.equal(isSilentWindow(s, 5.0, HALF, THRESH), null);
});

test('quiet across the window → silent (player stopped)', () => {
    const s = [at(4.9, 0.005), at(5.0, 0.001), at(5.1, 0.008)];
    assert.equal(isSilentWindow(s, 5.0, HALF, THRESH), true);
});

test('any sample above threshold in the window → NOT silent (something rang)', () => {
    // A blind-spot miss: the string is ringing (level high) but pitch unresolved.
    const s = [at(4.95, 0.004), at(5.0, 0.35), at(5.05, 0.004)];
    assert.equal(isSilentWindow(s, 5.0, HALF, THRESH), false);
});

test('only the ±window counts — a loud note outside it does not save a silent moment', () => {
    const s = [at(4.0, 0.9), at(5.0, 0.003), at(6.0, 0.9)];   // loud at 4.0 and 6.0, quiet at 5.0
    assert.equal(isSilentWindow(s, 5.0, HALF, THRESH), true, 'energy 1s away is outside the 200ms window');
});

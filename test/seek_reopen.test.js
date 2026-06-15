// Backward-seek re-scoring: when the player backs the track up (or restarts) to
// replay a section, the matcher must RE-OPEN the notes it already judged so the
// replay re-scores — otherwise the first pass's verdicts stick (you nail the
// intro on the retry but it still reads as missed / a hotspot). _ndKeysToReopenOnSeek
// is the pure decision behind checkMisses()' reset.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');
const _core = loadDetectionCore();
// Wrap so the result is a main-realm array (the sandbox returns a sandbox-realm
// Array, which assert.deepEqual rejects on a cross-realm prototype mismatch).
const keysToReopenOnSeek = (...a) => Array.from(_core.keysToReopenOnSeek(...a));

// noteResults keys look like "<chartTime>_<string>_<fret>".
const KEYS = ['3.000_0_3', '5.500_1_5', '12.250_0_7', '40.000_2_0'];

test('forward playback re-opens nothing', () => {
    assert.deepEqual(keysToReopenOnSeek(10.0, 10.05, 0.15, KEYS), []);
});

test('first scan (no prior time) re-opens nothing', () => {
    assert.deepEqual(keysToReopenOnSeek(null, 5.0, 0.15, KEYS), []);
    assert.deepEqual(keysToReopenOnSeek(undefined, 5.0, 0.15, KEYS), []);
});

test('a tiny backward wobble (< 0.25s, frame jitter / pause) re-opens nothing', () => {
    assert.deepEqual(keysToReopenOnSeek(10.0, 9.9, 0.15, KEYS), []);
});

test('a real backward seek re-opens every note at/after the new playhead', () => {
    // Seeked from ~13s back to 5s → replay from 5s. Notes at 5.5 / 12.25 / 40
    // re-open (the 5.5 one within the timing window too); the 3.0 note stays.
    const reopened = keysToReopenOnSeek(13.0, 5.0, 0.15, KEYS);
    assert.deepEqual(reopened.sort(), ['12.250_0_7', '40.000_2_0', '5.500_1_5'].sort());
    assert.ok(!reopened.includes('3.000_0_3'), 'a note before the seek target stays judged');
});

test('seek-back to the start re-opens the whole take (clean fresh attempt)', () => {
    assert.deepEqual(keysToReopenOnSeek(45.0, 0, 0.15, KEYS).sort(), KEYS.slice().sort());
});

test('the timing window is honoured: a note just past the playhead still re-opens', () => {
    // Playhead 5.6, a note at 5.5 is 100ms behind but within the 150ms window.
    assert.ok(keysToReopenOnSeek(13.0, 5.6, 0.15, KEYS).includes('5.500_1_5'));
});

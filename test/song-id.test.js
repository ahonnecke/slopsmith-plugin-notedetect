// Unit S.2 — _ndCurrentSongId pure helper. Group key for the plays
// DB; lead vs bass arrangements of the same song must NOT collide,
// and a missing songInfo must NOT silently produce a string the
// server would index against.
const test = require('node:test');
const assert = require('node:assert');
const { loadDetectionCore } = require('./_loader');

const { currentSongId } = loadDetectionCore();

test('currentSongId combines filename + arrangement', () => {
    assert.strictEqual(
        currentSongId({ filename: 'gasoline.psarc', arrangement: 'bass' }),
        'gasoline.psarc__bass',
    );
});

test('currentSongId distinguishes lead vs bass on same filename', () => {
    const lead = currentSongId({ filename: 'gasoline.psarc', arrangement: 'lead' });
    const bass = currentSongId({ filename: 'gasoline.psarc', arrangement: 'bass' });
    assert.notStrictEqual(lead, bass);
});

test('currentSongId falls back to title when filename absent', () => {
    assert.strictEqual(
        currentSongId({ title: 'Gasoline', arrangement: 'bass' }),
        'Gasoline__bass',
    );
});

test('currentSongId defaults arrangement to "default"', () => {
    assert.strictEqual(
        currentSongId({ filename: 'gasoline.psarc' }),
        'gasoline.psarc__default',
    );
});

test('currentSongId returns null for null/empty songInfo', () => {
    assert.strictEqual(currentSongId(null), null);
    assert.strictEqual(currentSongId(undefined), null);
    assert.strictEqual(currentSongId({}), null);
    // No filename + no title → no usable id. Must NOT default to a
    // stable string ("unknown") because the server would happily
    // accumulate snapshots from disparate songs under the same id.
    assert.strictEqual(currentSongId({ arrangement: 'bass' }), null);
});

// Per-string energy tests — _ndPerStringEnergy reports the fraction of spectral
// energy in each string's band (incl. non-charted strings), the raw signal
// that lets coaching tell a clean hit from wrong-string / ambient / silence.
// Bands overlap, so these assert the unambiguous cases: a tone that sits in
// exactly one string's band localizes there; silence is ~zero everywhere; the
// vector length tracks string count.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');
const { sine } = require('./_signals');

const core = loadDetectionCore();
const SR = 48000;
const G6 = [0, 0, 0, 0, 0, 0];
const B4 = [0, 0, 0, 0];

test('perStringEnergy: a low-E sine localizes energy on string 0 (guitar)', () => {
    const buf = sine(82.4, SR, 0.25, 0.6);   // E2, guitar low-E open
    const { perString, totalEnergy } = core.perStringEnergy(buf, SR, 'guitar', 6, G6, 0);
    assert.equal(perString.length, 6, 'one entry per string');
    assert.ok(totalEnergy > 0, 'non-silent → energy present');
    // String 0's band reaches down to ~74 Hz; 82 Hz sits BELOW string 1's (A)
    // band (~99 Hz), so string 0 must be the clear winner.
    assert.equal(perString.indexOf(Math.max(...perString)), 0,
        `string 0 should dominate (got ${JSON.stringify(perString)})`);
    assert.ok(perString[0] > perString[1] + 0.1, 'string 0 clearly above string 1');
});

test('perStringEnergy: silence → ~zero energy on every string', () => {
    const buf = new Float32Array(Math.floor(SR * 0.25));   // all zeros
    const { perString, totalEnergy } = core.perStringEnergy(buf, SR, 'guitar', 6, G6, 0);
    assert.ok(totalEnergy < 1e-6, 'silence has ~no energy');
    assert.ok(perString.every((x) => x === 0), 'no string lights up on silence');
});

test('perStringEnergy: vector length tracks string count (bass = 4)', () => {
    const buf = sine(41.2, SR, 0.4, 0.6);    // E1, bass low-E open
    const { perString } = core.perStringEnergy(buf, SR, 'bass', 4, B4, 0);
    assert.equal(perString.length, 4, 'bass → 4 entries');
    // E1 (41 Hz) sits below the A-string band (~49 Hz) → low-E string wins.
    assert.equal(perString.indexOf(Math.max(...perString)), 0,
        `bass low-E should dominate (got ${JSON.stringify(perString)})`);
});

test('perStringEnergy: an out-of-instrument-range tone lights nothing much', () => {
    // 3 kHz is above every guitar string's fret-24 ceiling — energy should not
    // concentrate in any band (this is the "ambient / not a played note" shape).
    const buf = sine(3000, SR, 0.25, 0.6);
    const { perString } = core.perStringEnergy(buf, SR, 'guitar', 6, G6, 0);
    assert.ok(Math.max(...perString) < 0.2, `no band should claim a 3 kHz tone (got ${JSON.stringify(perString)})`);
});

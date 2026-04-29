// _ndComputeTimelineBins — pure binning fn that drives the hotspot
// timeline strip. Maps song time to N bins; each bin tracks
// hits/miss/total across plays. Bins with no data have missRate=null
// (rendered as dim grey, not "0% miss").

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const core = loadDetectionCore();

const note = (chartT, primary) => ({
    chartT, primary,
    s: 1, f: 5, key: `${chartT}-1-5`,
});
const play = (...notes) => ({ noteResults: notes });

test('empty plays: all bins have null missRate', () => {
    const bins = core.computeTimelineBins([], 5, 0, 100);
    assert.equal(bins.length, 5);
    for (const b of bins) {
        assert.equal(b.missRate, null);
        assert.equal(b.total, 0);
    }
});

test('single play, one note per bin: missRate reflects hit/miss', () => {
    // 5 notes evenly distributed across [0, 100], one per 20s bin.
    const plays = [play(
        note(10, 'HIT'),
        note(30, 'MISSED_NO_DETECTION'),
        note(50, 'HIT'),
        note(70, 'MISSED_WRONG_PITCH'),
        note(90, 'HIT'),
    )];
    const bins = core.computeTimelineBins(plays, 5, 0, 100);
    assert.equal(bins[0].missRate, 0);    // 0/1
    assert.equal(bins[1].missRate, 1);    // 1/1
    assert.equal(bins[2].missRate, 0);
    assert.equal(bins[3].missRate, 1);
    assert.equal(bins[4].missRate, 0);
});

test('multiple plays: bins accumulate', () => {
    const plays = [
        play(note(10, 'HIT'), note(10, 'MISSED_NO_DETECTION')),
        play(note(10, 'HIT'), note(10, 'HIT')),
    ];
    const bins = core.computeTimelineBins(plays, 5, 0, 100);
    assert.equal(bins[0].total, 4);
    assert.equal(bins[0].hits, 3);
    assert.equal(bins[0].miss, 1);
    assert.ok(Math.abs(bins[0].missRate - 0.25) < 0.001);
});

test('out-of-range notes excluded', () => {
    const plays = [play(
        note(-10, 'HIT'),    // before minT
        note(50, 'HIT'),      // in range
        note(150, 'HIT'),    // after maxT
    )];
    const bins = core.computeTimelineBins(plays, 4, 0, 100);
    let total = 0;
    for (const b of bins) total += b.total;
    assert.equal(total, 1);
});

test('boundary notes: chartT=minT goes to bin 0, chartT=maxT goes to last bin', () => {
    const plays = [play(
        note(0, 'HIT'),       // minT
        note(100, 'HIT'),    // maxT
    )];
    const bins = core.computeTimelineBins(plays, 5, 0, 100);
    assert.equal(bins[0].total, 1);
    assert.equal(bins[bins.length - 1].total, 1);
});

test('non-HIT non-MISS records ignored', () => {
    // WRONG_PITCH and unknown primaries don't count
    const plays = [{ noteResults: [
        { chartT: 50, primary: 'HIT', s: 1, f: 5 },
        { chartT: 50, primary: 'WRONG_PITCH_OUTSIDE_TOLERANCE', s: 1, f: 5 },
    ]}];
    const bins = core.computeTimelineBins(plays, 5, 0, 100);
    let totalCounted = 0;
    for (const b of bins) totalCounted += b.total;
    assert.equal(totalCounted, 1);   // only the HIT counted
});

test('null/undefined plays handled', () => {
    assert.equal(core.computeTimelineBins(null, 5, 0, 100).length, 5);
    assert.equal(core.computeTimelineBins(undefined, 5, 0, 100).length, 5);
});

test('zero-duration range: returns empty bins, no crash', () => {
    const plays = [play(note(50, 'HIT'))];
    const bins = core.computeTimelineBins(plays, 5, 50, 50);
    assert.equal(bins.length, 5);
    for (const b of bins) assert.equal(b.total, 0);
});

test('100-bin granularity: real-world song length', () => {
    // 180-second song, 100 bins = 1.8s per bin. Verify high-resolution
    // spread doesn't lose data.
    const notes = [];
    for (let t = 0; t < 180; t += 1) {
        notes.push(note(t, t % 3 === 0 ? 'MISSED_NO_DETECTION' : 'HIT'));
    }
    const plays = [play(...notes)];
    const bins = core.computeTimelineBins(plays, 100, 0, 180);
    let totalCounted = 0;
    for (const b of bins) totalCounted += b.total;
    assert.equal(totalCounted, 180);
});

test('chart-time ignoring NaN/non-numeric chartT', () => {
    const plays = [{ noteResults: [
        { chartT: 50, primary: 'HIT', s: 1, f: 5 },
        { chartT: NaN, primary: 'HIT', s: 1, f: 5 },
        { chartT: 'oops', primary: 'HIT', s: 1, f: 5 },
        { primary: 'HIT', s: 1, f: 5 },   // missing chartT
    ]}];
    const bins = core.computeTimelineBins(plays, 5, 0, 100);
    let totalCounted = 0;
    for (const b of bins) totalCounted += b.total;
    assert.equal(totalCounted, 1);
});

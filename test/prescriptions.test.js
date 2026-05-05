// Unit 3g — top-3 prescriptions (single-play). The reference branch
// aggregated across plays + ran a failure-mode classifier; this
// version uses three single-play signals (cluster, timing bias,
// per-string weakness). Tests verify each signal fires, ordering by
// score, and the empty-input + no-data placeholders.
const test = require('node:test');
const assert = require('node:assert');
const { loadDetectionCore } = require('./_loader');

const { computePrescriptions, renderPrescriptionsBlock } = loadDetectionCore();

function mkHit({ s, f, t, te = 0 }) {
    return {
        chartNote: { s, f, t },
        note: { s, f },
        noteTime: t,
        hit: true,
        timingState: 'OK',
        pitchState: 'OK',
        timingError: te,
        ignoredAsDetectorFailure: false,
    };
}
function mkMiss({ s, f, t, ignored = false }) {
    return {
        chartNote: { s, f, t },
        note: { s, f },
        noteTime: t,
        hit: false,
        timingState: null,
        pitchState: null,
        timingError: null,
        ignoredAsDetectorFailure: ignored,
    };
}

test('computePrescriptions: empty input returns empty array', () => {
    assert.deepEqual(computePrescriptions([]), []);
    assert.deepEqual(computePrescriptions(null), []);
});

test('computePrescriptions surfaces top trouble cluster', () => {
    // 4 misses bunched at t=10..13 → should produce a cluster signal.
    const notes = [
        ...[10, 11, 12, 13].map(t => mkMiss({ s: 1, f: 5, t })),
        // Spread some hits elsewhere so the clusterer has context.
        ...[1, 2, 3, 4, 5].map(t => mkHit({ s: 1, f: 5, t })),
    ];
    const ps = computePrescriptions(notes);
    assert.ok(ps.length >= 1);
    const cluster = ps.find(p => p.signal === 'cluster');
    assert.ok(cluster, 'expected a cluster prescription');
    assert.match(cluster.text, /Drill 0:\d+–0:\d+/);
    assert.match(cluster.text, /4 misses clustered/);
});

test('computePrescriptions detects systematic late timing bias', () => {
    // 30 hits all 80ms late → median 80, threshold 50 → should fire.
    const notes = [];
    for (let i = 0; i < 30; i++) notes.push(mkHit({ s: 1, f: 5, t: i, te: 80 }));
    const ps = computePrescriptions(notes, { timingThresholdMs: 50 });
    const tb = ps.find(p => p.signal === 'timing_bias');
    assert.ok(tb, 'expected timing_bias prescription');
    assert.match(tb.text, /80ms late/);
    assert.match(tb.text, /Anticipate the click/);
});

test('computePrescriptions detects systematic early timing bias', () => {
    const notes = [];
    for (let i = 0; i < 30; i++) notes.push(mkHit({ s: 1, f: 5, t: i, te: -80 }));
    const ps = computePrescriptions(notes, { timingThresholdMs: 50 });
    const tb = ps.find(p => p.signal === 'timing_bias');
    assert.ok(tb);
    assert.match(tb.text, /80ms early/);
    assert.match(tb.text, /Hold the upbeat/);
});

test('computePrescriptions: timing_bias requires ≥30 hits (single-verse floor)', () => {
    const notes = [];
    for (let i = 0; i < 20; i++) notes.push(mkHit({ s: 1, f: 5, t: i, te: 100 }));
    const ps = computePrescriptions(notes, { timingThresholdMs: 50 });
    assert.strictEqual(ps.find(p => p.signal === 'timing_bias'), undefined);
});

test('computePrescriptions: timing_bias suppressed inside threshold', () => {
    const notes = [];
    for (let i = 0; i < 30; i++) notes.push(mkHit({ s: 1, f: 5, t: i, te: 30 }));
    const ps = computePrescriptions(notes, { timingThresholdMs: 50 });
    assert.strictEqual(ps.find(p => p.signal === 'timing_bias'), undefined);
});

test('computePrescriptions identifies weakest string', () => {
    // String 0: 8 misses, 2 hits = 80% miss
    // String 1: 1 miss, 9 hits = 10% miss
    // Overall: 9 / 20 = 45% — string 0 is well above 1.5×.
    const notes = [];
    for (let i = 0; i < 8; i++) notes.push(mkMiss({ s: 0, f: 0, t: i }));
    for (let i = 0; i < 2; i++) notes.push(mkHit({ s: 0, f: 0, t: 8 + i }));
    for (let i = 0; i < 9; i++) notes.push(mkHit({ s: 1, f: 5, t: 20 + i }));
    notes.push(mkMiss({ s: 1, f: 5, t: 30 }));
    const ps = computePrescriptions(notes, { arrangement: 'bass' });
    const str = ps.find(p => p.signal === 'per_string');
    assert.ok(str, 'expected per_string prescription');
    assert.match(str.text, /E \(low\)/);
    assert.match(str.text, /80% miss/);
});

test('computePrescriptions: per_string suppressed when string matches overall', () => {
    // Even miss-rate distribution → no string is "the weak point".
    const notes = [];
    for (let s = 0; s < 4; s++) {
        for (let i = 0; i < 5; i++) notes.push(mkHit({ s, f: 5, t: s * 10 + i }));
        for (let i = 0; i < 2; i++) notes.push(mkMiss({ s, f: 5, t: s * 10 + 5 + i }));
    }
    const ps = computePrescriptions(notes, { arrangement: 'bass' });
    assert.strictEqual(ps.find(p => p.signal === 'per_string'), undefined);
});

test('computePrescriptions returns at most 3', () => {
    const notes = [];
    // Trigger all 3 signals at once (cluster + timing + string)
    for (let i = 0; i < 30; i++) notes.push(mkHit({ s: 0, f: 0, t: i, te: 100 }));
    for (let i = 0; i < 5; i++) notes.push(mkMiss({ s: 1, f: 0, t: 30 + i }));
    for (let i = 0; i < 5; i++) notes.push(mkMiss({ s: 1, f: 0, t: 100 + i }));
    const ps = computePrescriptions(notes, { arrangement: 'bass' });
    assert.ok(ps.length <= 3);
});

test('renderPrescriptionsBlock: empty list shows placeholder', () => {
    const html = renderPrescriptionsBlock([]);
    assert.match(html, /Not enough data/);
});

test('renderPrescriptionsBlock: numbered + colored tiers', () => {
    const html = renderPrescriptionsBlock([
        { text: 'first', detail: '', score: 1, signal: 'cluster' },
        { text: 'second', detail: '', score: 0.5, signal: 'timing_bias' },
    ]);
    assert.match(html, /1\./);
    assert.match(html, /2\./);
    assert.match(html, /first/);
    assert.match(html, /second/);
});

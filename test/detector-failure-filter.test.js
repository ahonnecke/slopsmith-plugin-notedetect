// Detector-failure filter — separates "user missed" from "plugin failed
// to detect". Practice features (coaching, timeline, heatmap) call this
// before aggregating misses so recommendations don't drill positions
// where the *detector* keeps losing the note.
//
// Three flagging heuristics:
//   1. NO_DETECTION with prev chart note < 400ms before — sustain-bleed
//      regime where onset detector can't fire fresh on the re-attack.
//   2. WRONG_PITCH with hygiene.onTargetRatio = 0 + contaminants — YIN
//      locked on a different pitch during the matching window.
//   3. WRONG_PITCH detected ≥ 4 semitones below expected — almost
//      certainly low-register sustain bleed; finger slips stay <= 3.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const core = loadDetectionCore();

const note = (overrides) => ({
    key: `${overrides.chartT || 0}-${overrides.s || 0}-${overrides.f || 0}`,
    primary: 'HIT',
    chartT: 1.0, s: 1, f: 5, expectedMidi: 38,
    ...overrides,
});

// ── Heuristic 1: fast-repeat NO_DETECTION ──────────────────────────────

test('fast-repeat NO_DETECTION (< 400ms gap) flagged as detector failure', () => {
    const notes = [
        note({ chartT: 1.0, primary: 'HIT' }),
        note({ chartT: 1.3, primary: 'MISSED_NO_DETECTION' }),   // 300ms gap
    ];
    const flagged = core.likelyDetectorFailures(notes);
    assert.ok(flagged.has(notes[1].key));
    assert.ok(!flagged.has(notes[0].key));
});

test('slow-repeat NO_DETECTION (>= 400ms gap) NOT flagged', () => {
    const notes = [
        note({ chartT: 1.0, primary: 'HIT' }),
        note({ chartT: 1.5, primary: 'MISSED_NO_DETECTION' }),   // 500ms gap
    ];
    const flagged = core.likelyDetectorFailures(notes);
    assert.equal(flagged.size, 0);
});

test('first-note NO_DETECTION (no previous) NOT flagged', () => {
    const notes = [note({ chartT: 1.0, primary: 'MISSED_NO_DETECTION' })];
    const flagged = core.likelyDetectorFailures(notes);
    assert.equal(flagged.size, 0);
});

// ── Heuristic 2: hygiene contaminants on WRONG_PITCH ───────────────────

test('WRONG_PITCH with onTargetRatio=0 + contaminants flagged', () => {
    const notes = [note({
        primary: 'MISSED_WRONG_PITCH',
        hygiene: {
            onTargetFrames: 0,
            offTargetFrames: 3,
            onTargetRatio: 0,
            contaminants: [{ midi: 22, count: 1 }],
        },
    })];
    const flagged = core.likelyDetectorFailures(notes);
    assert.ok(flagged.has(notes[0].key));
});

test('WRONG_PITCH with onTargetRatio > 0 NOT flagged (real wrong-pitch)', () => {
    const notes = [note({
        primary: 'MISSED_WRONG_PITCH',
        pitchError: 200,   // 2 semitones off, plausible finger slip
        hygiene: {
            onTargetRatio: 0.4,
            contaminants: [{ midi: 40, count: 1 }],
        },
    })];
    const flagged = core.likelyDetectorFailures(notes);
    assert.equal(flagged.size, 0);
});

test('WRONG_PITCH with no hygiene + small pitchError NOT flagged', () => {
    const notes = [note({
        primary: 'MISSED_WRONG_PITCH',
        pitchError: 200,   // 2 semitones, a real finger slip
    })];
    const flagged = core.likelyDetectorFailures(notes);
    assert.equal(flagged.size, 0);
});

// ── Heuristic 3: large pitch error (sustain bleed signature) ───────────

test('WRONG_PITCH detected 16 semitones below expected: flagged', () => {
    const notes = [note({
        primary: 'MISSED_WRONG_PITCH',
        pitchError: -1600,
    })];
    const flagged = core.likelyDetectorFailures(notes);
    assert.ok(flagged.has(notes[0].key));
});

test('WRONG_PITCH detected 4 semitones below: flagged (boundary)', () => {
    const notes = [note({
        primary: 'MISSED_WRONG_PITCH',
        pitchError: -400,
    })];
    const flagged = core.likelyDetectorFailures(notes);
    assert.ok(flagged.has(notes[0].key));
});

test('WRONG_PITCH detected 3 semitones below: NOT flagged (could be finger slip)', () => {
    const notes = [note({
        primary: 'MISSED_WRONG_PITCH',
        pitchError: -300,
    })];
    const flagged = core.likelyDetectorFailures(notes);
    assert.equal(flagged.size, 0);
});

test('WRONG_PITCH detected 4 semitones above: NOT flagged (sustain bleed is low not high)', () => {
    const notes = [note({
        primary: 'MISSED_WRONG_PITCH',
        pitchError: 400,
    })];
    const flagged = core.likelyDetectorFailures(notes);
    assert.equal(flagged.size, 0);
});

// ── HITs are never flagged ──────────────────────────────────────────────

test('HIT records never flagged', () => {
    const notes = [
        note({ chartT: 1.0, primary: 'HIT' }),
        note({ chartT: 1.1, primary: 'HIT' }),
        note({ chartT: 1.2, primary: 'DIRTY_HIT' }),
    ];
    const flagged = core.likelyDetectorFailures(notes);
    assert.equal(flagged.size, 0);
});

// ── filterDetectorFailures wraps the flagger ────────────────────────────

test('filterDetectorFailures: removes flagged misses, keeps everything else', () => {
    const play = {
        noteResults: [
            note({ chartT: 1.0, primary: 'HIT' }),
            note({ chartT: 1.2, primary: 'MISSED_NO_DETECTION' }),   // fast-repeat
            note({ chartT: 2.0, primary: 'MISSED_NO_DETECTION' }),   // slow, kept
        ],
    };
    const filtered = core.filterDetectorFailures([play]);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].noteResults.length, 2);
    // The fast-repeat miss should be gone
    assert.ok(!filtered[0].noteResults.some(r => r.chartT === 1.2));
});

test('filterDetectorFailures: returns plays unchanged if nothing flagged', () => {
    const plays = [{ noteResults: [note({ primary: 'HIT' })] }];
    const filtered = core.filterDetectorFailures(plays);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].noteResults.length, 1);
});

test('filterDetectorFailures: handles null/undefined', () => {
    assert.equal(core.filterDetectorFailures(null).length, 0);
    assert.equal(core.filterDetectorFailures(undefined).length, 0);
});

// ── Real-world scenario: Gasoline-style fast-repeat + sustain bleed ─────

test('Gasoline pattern: most s1/f5 misses are detector failures', () => {
    // 16th-note pattern, ~350ms gap. Half are HIT, half look like misses
    // but are really sustain-bleed false negatives.
    const noteResults = [];
    for (let i = 0; i < 8; i++) {
        const isHit = i % 2 === 0;
        noteResults.push(note({
            chartT: 9.95 + i * 0.353,
            s: 1, f: 5,
            primary: isHit ? 'HIT' : 'MISSED_NO_DETECTION',
        }));
    }
    const flagged = core.likelyDetectorFailures(noteResults);
    // 4 misses; all but the first should be fast-repeat-flagged
    // (each follows another note within 353ms).
    const missedAndFlagged = noteResults
        .filter(r => r.primary === 'MISSED_NO_DETECTION' && flagged.has(r.key));
    assert.ok(missedAndFlagged.length >= 3,
        `expected most misses flagged, got ${missedAndFlagged.length} of 4`);
});

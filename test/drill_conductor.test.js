// Drill-conductor tests — the speed/goal orchestrator layered on top of
// the loop:restart iteration foundation (see drill_mode.test.js).
//
// Two layers, matching the codebase convention (pure logic node-tested,
// DOM/audio wiring driven through enriched stubs):
//   1. _ndDrillRampDecision — the pure goal-gate (hold/advance/graduate).
//   2. The conductor state machine driven end-to-end: startDrill arms a
//      slowed loop, each cleared iteration steps the speed up, clearing
//      at the top rung graduates and restores the speed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

// 10 note slots inside the drill window [30, 50] (startDrill(30, 50)). The
// conductor scores each pass from noteResults in this window, so test notes
// must live here. Stable keys (time_s_f) so each pass OVERWRITES the prior
// verdict — exactly how the real matcher re-judges a looped passage.
const WINDOW_TS = [31, 33, 35, 37, 39, 41, 43, 45, 47, 49];

// Run one pass: mark the first `hits` of the 10 window notes as hits, the
// rest as misses, then fire the loop wrap the conductor listens for.
function runIteration(core, det, hits) {
    WINDOW_TS.forEach((t, i) => {
        const hit = i < hits;
        det._recordJudgment(`${t.toFixed(3)}_1_0`, {
            hit, note: { s: 1, f: 0 }, noteTime: t,
            detectedMidi: hit ? 45 : null,
            timingState: hit ? 'OK' : null,
        });
    });
    core.slopsmith._fire('loop:restart', { loopA: 28, loopB: 50, time: 28 });
}

// ── Pure goal-gate decision ──────────────────────────────────────────────

// Field-wise assert: drillRampDecision returns an object built inside the
// vm sandbox, so deepEqual sees a cross-realm prototype mismatch.
function assertDecision(d, action, nextRung, msg) {
    assert.equal(d.action, action, msg);
    assert.equal(d.nextRung, nextRung, msg);
}

test('_ndDrillRampDecision: missing the goal holds at the current rung', () => {
    const { drillRampDecision } = loadDetectionCore();
    assertDecision(drillRampDecision(0.5, 0.85, 0, 3), 'hold', 0);
    assertDecision(drillRampDecision(0.84, 0.85, 1, 3), 'hold', 1);
});

test('_ndDrillRampDecision: clearing the goal below full speed advances a rung', () => {
    const { drillRampDecision } = loadDetectionCore();
    assertDecision(drillRampDecision(0.9, 0.85, 0, 3), 'advance', 1);
    assertDecision(drillRampDecision(0.85, 0.85, 1, 3), 'advance', 2, 'score == goal counts as cleared');
});

test('_ndDrillRampDecision: clearing the goal at the top rung graduates', () => {
    const { drillRampDecision } = loadDetectionCore();
    assertDecision(drillRampDecision(0.95, 0.85, 2, 3), 'graduate', 2);
    // Single-rung ladder: rung 0 is also the top.
    assertDecision(drillRampDecision(1.0, 0.85, 0, 1), 'graduate', 0);
});

test('_ndDrillRampDecision: non-finite score never clears the goal', () => {
    const { drillRampDecision } = loadDetectionCore();
    assert.equal(drillRampDecision(NaN, 0.85, 0, 3).action, 'hold');
    assert.equal(drillRampDecision(undefined, 0.85, 0, 3).action, 'hold');
});

// ── Per-note "what you missed + how" (pure) ──────────────────────────────

test('_ndDescribeMiss: categorises a miss by failure mode with a human detail', () => {
    const { describeMiss } = loadDetectionCore();
    assert.equal(describeMiss({ detectedMidi: null }).how, 'missed');
    assert.match(describeMiss({ detectedMidi: null }).detail, /not played|not detected/);
    assert.deepEqual(pick(describeMiss({ detectedMidi: 45, timingState: 'LATE', timingError: 42 })), ['late', '42ms late']);
    assert.deepEqual(pick(describeMiss({ detectedMidi: 45, timingState: 'EARLY', timingError: -30 })), ['early', '30ms early']);
    assert.deepEqual(pick(describeMiss({ detectedMidi: 46, pitchState: 'SHARP', pitchError: 28 })), ['sharp', '28¢ sharp']);
    assert.deepEqual(pick(describeMiss({ detectedMidi: 44, pitchState: 'FLAT', pitchError: -19 })), ['flat', '19¢ flat']);
    function pick(d) { return [d.how, d.detail]; }
});

test('_ndSummarizeWindowMisses: only misses inside the window, tagged where+how, time-sorted', () => {
    const { summarizeWindowMisses } = loadDetectionCore();
    const judgments = [
        { hit: true, noteTime: 20.0, note: { s: 1, f: 5 } },                                   // hit — excluded
        { hit: false, noteTime: 21.0, note: { s: 2, f: 7 }, detectedMidi: null },              // miss in window
        { hit: false, noteTime: 20.5, note: { s: 1, f: 3 }, detectedMidi: 45, timingState: 'LATE', timingError: 40 },
        { hit: false, noteTime: 99.0, note: { s: 0, f: 0 }, detectedMidi: null },              // out of window
    ];
    const r = summarizeWindowMisses(judgments, 19, 23);
    assert.equal(r.length, 2, 'only the two in-window misses');
    assert.deepEqual([r[0].t, r[1].t], [20.5, 21.0], 'sorted by time');
    assert.equal(r[0].how, 'late');
    assert.equal(r[0].s, 1); assert.equal(r[0].f, 3);
    assert.equal(r[1].how, 'missed');
});

// ── Conductor state machine (enriched stubs) ─────────────────────────────

// Load the core with a sandbox rich enough for startDrill to run: a fake
// <audio>/#speed-slider, a window.setSpeed spy, and slopsmith
// setLoop/clearLoop/emit. Returns the core plus the recorded spies.
function loadConductorCore() {
    const spies = { speed: [], setLoop: [], clearLoop: [], emit: [] };
    const fakeAudio = { playbackRate: 1, duration: 200, play: async () => {} };
    const fakeSlider = { value: '100' };
    const core = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            const realGet = sandbox.document.getElementById;
            sandbox.document.getElementById = (id) => {
                if (id === 'audio') return fakeAudio;
                if (id === 'speed-slider') return fakeSlider;
                return realGet ? realGet(id) : null;
            };
            sandbox.setSpeed = (v) => { spies.speed.push(v); fakeSlider.value = String(v * 100); };
            sandbox.slopsmith.setLoop = async (a, b) => { spies.setLoop.push([a, b]); return true; };
            sandbox.slopsmith.clearLoop = (o) => { spies.clearLoop.push(o); };
            sandbox.slopsmith.emit = (e, d) => { spies.emit.push([e, d]); };
        },
    });
    return { core, spies, fakeSlider };
}

test('startDrill arms a slowed loop at the bottom rung', async () => {
    const { core, spies } = loadConductorCore();
    const det = core.createNoteDetector();
    assert.equal(det.isDrilling(), false, 'not drilling before startDrill');

    const ok = await det.startDrill(30, 50, { goal: 0.8, speedLadder: [0.7, 0.85, 1.0] });
    assert.equal(ok, true);
    assert.equal(det.isDrilling(), true);

    const st = det.getConductorState();
    assert.equal(st.active, true);
    assert.equal(st.rung, 0);
    assert.equal(st.speed, 0.7, 'starts at the slowest rung');
    assert.equal(st.goal, 0.8);
    assert.equal(spies.setLoop.length, 1, 'armed exactly one loop');
    assert.ok(spies.speed.includes(0.7), 'dropped playback to 0.7×');
    det.destroy();
});

test('clearing the goal steps the speed up one rung per iteration, then graduates', async () => {
    const { core, spies } = loadConductorCore();
    const det = core.createNoteDetector();
    await det.startDrill(30, 50, { goal: 0.8, speedLadder: [0.7, 0.85, 1.0] });
    // The conductor scores from its window via its OWN loop:restart listener
    // (bound in startDrill) — no foundation sync needed.

    // Pass 1: 9/10 = 90% ≥ 80% goal → advance to rung 1 (0.85×).
    runIteration(core, det, 9);
    assert.equal(det.getConductorState().rung, 1);
    assert.equal(det.getConductorState().speed, 0.85);

    // Pass 2: 4/10 = 40% holds at rung 1.
    runIteration(core, det, 4);
    assert.equal(det.getConductorState().rung, 1, 'missing the goal holds the rung');

    // Pass 3: 10/10 = 100% → advance to the top rung (1.0×).
    runIteration(core, det, 10);
    assert.equal(det.getConductorState().rung, 2);
    assert.equal(det.getConductorState().speed, 1.0);

    // Pass 4: clear the goal at full speed → graduate.
    runIteration(core, det, 9);
    assert.equal(det.isDrilling(), false, 'graduated → drill ended');
    assert.equal(spies.clearLoop.length, 1, 'dropped the A-B loop on graduation');
    const grad = spies.emit.find(([e]) => e === 'notedetect:drill-ended');
    assert.ok(grad, 'emitted notedetect:drill-ended');
    assert.equal(grad[1].graduated, true);
    // Speed restored to the pre-drill 1.0× (slider was 100 at startDrill).
    assert.equal(spies.speed[spies.speed.length - 1], 1.0, 'restored pre-drill speed');
    det.destroy();
});

test('endDrill bails early, restores speed, and clears the loop', async () => {
    const { core, spies } = loadConductorCore();
    const det = core.createNoteDetector();
    await det.startDrill(30, 50, { goal: 0.8, speedLadder: [0.7, 0.85, 1.0] });
    assert.equal(det.isDrilling(), true);

    det.endDrill('user');
    assert.equal(det.isDrilling(), false);
    assert.equal(spies.clearLoop.length, 1);
    assert.equal(spies.speed[spies.speed.length - 1], 1.0, 'restored pre-drill speed');
    const ended = spies.emit.find(([e]) => e === 'notedetect:drill-ended');
    assert.ok(ended && ended[1].graduated === false);
    det.destroy();
});

test('startDrill rejects a too-short range without arming a loop', async () => {
    const { core, spies } = loadConductorCore();
    const det = core.createNoteDetector();
    const ok = await det.startDrill(30, 30.2, {});  // 0.2s < 0.5s minimum
    assert.equal(ok, false);
    assert.equal(det.isDrilling(), false);
    assert.equal(spies.setLoop.length, 0, 'no loop armed for an invalid range');
    det.destroy();
});

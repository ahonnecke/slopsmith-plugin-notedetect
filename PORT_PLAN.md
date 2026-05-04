# Plugin port to factory pattern

This branch (`port/from-factory`) is based on `upstream/main` (the
post-`createNoteDetector()` codebase). The reference baseline tag
`reference/pre-port-baseline` points at the pre-port branch tip
(`97d73dd`); use `git show reference/pre-port-baseline:screen.js` to
inspect the pre-port shape during porting.

## Port units (one PR each, in order)

Each unit is a self-contained slice that should land cleanly with tests
green. Don't move on until tests pass.

### Unit 1 — Two-axis scoring (NEXT UP)

**Goal:** replace the four mutable tolerance settings with fixed
two-axis thresholds.

Upstream already has the structural shape (wide tolerance + tight hit
threshold per axis), just with different numbers. The port adds:

- Module-level constants (above the factory):
  ```js
  const _ND_DETECTION_PITCH_CENTS = 200;
  const _ND_DETECTION_TIMING_SEC  = 0.300;
  const _ND_PRECISION_PITCH_CENTS = 25;
  const _ND_PRECISION_TIMING_MS   = 50;
  const _ND_DIRTY_HIT_MAX_OFF_RATIO = 0.5;
  ```
- Inside `createNoteDetector(options)`:
  - Replace `let timingTolerance = 0.150;` etc. with `const`s wired
    to the module constants
  - Remove the `s.timingTolerance` / `s.pitchTolerance` /
    `s.timingHitThreshold` / `s.pitchHitThreshold` read paths from
    `applySettings()` — silently ignore (older saves)
  - Stop writing those keys from `saveSettings()`
- Add `_ndScoresFromNotes(notes)` pure function returning
  `{detection, precision, combined: detection, ...}`
- Update HUD render: large detection % + small precision % below
- Update settings panel: replace tolerance sliders with read-only
  "Detection 200¢/300ms · Precision 25¢/50ms" info card

Reference: `git show reference/pre-port-baseline:screen.js` lines 380-510
(constants + score function), 1700-1800 (HUD), 4150-4250 (settings panel).

Tests to keep passing (and update for the new semantics):
- `test/per-note-coaching.test.js`
- `test/practice-ranking.test.js`
- `test/coaching-export.test.js`

### Unit 2 — Drill mode

Lead-in, runway, slow-speed, HUD, save-loop integration. Constants
`_ND_DRILL_LEAD_IN_SEC`, `_ND_DRILL_FIRST_NOTE_RUNWAY_SEC`,
`_ND_DRILL_SLOW_SPEED` lift cleanly. The drill state lives on the
factory instance (drillActive, drillJudgeStart, drillJudgeEnd, …).

Reference lines 500-520 (constants), 5540-5620 (`_ndStartDrillRange`),
5560-5610 (judgment-window gating).

Pre-existing bug to fix during this port: drill lead-in is silent
because `setActiveLoop` seeks but doesn't `audio.play()`. Wire
`audio.play()` into `_ndStartDrillRange` post-setActiveLoop.

### Unit 3 — Coaching analysis

Cluster finder, time heatmap, per-section breakdown, history modal.
Pure function `_ndExportCoachingAnalysis()` is the entry point; all
modal rendering is consumer code that calls into it.

Reference lines 4500-5070.

### Unit 4 — Diagnostic recording / dump pipeline

WAV recording during play, auto-dump on session boundary, replay
through `_ndInjectTestWav`. Server-side endpoint reuse.

Reference lines 600-900.

### Unit 5 — Gain slider live-update

Captures gain node globally, applies value changes without restarting
audio graph. Trivial port.

Reference lines ~419, ~2814, ~4210.

## What NOT to port

- The flat module-level globals shape (`let _ndFoo`). Everything goes
  on the factory closure or into module-level `const`s.
- Strictness presets — already retired pre-port.
- The 9472-line monolith structure. Each unit should leave the file
  smaller or the same, never larger by more than its own additions.

## After the port

- Delete `reference/pre-port-baseline` once Unit 5 lands and all tests
  pass.
- Each unit should land upstream as a separate PR for reviewability.

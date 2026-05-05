# Plugin port to factory pattern

This branch (`port/from-factory`) is based on `upstream/main` (the
post-`createNoteDetector()` codebase). The reference baseline tag
`reference/pre-port-baseline` points at the pre-port branch tip; use
`git show reference/pre-port-baseline:screen.js` to inspect pre-port
shape during porting.

## Status (2026-05-04)

```
✓ Unit 1  — Two-axis scoring                    e035e9e
✓ Unit 2  — Drill mode core (start/end/gate)    9e0e2ec
✓ Unit 5  — Gain slider live-update             6d56a78
✓ Unit 2x — Drill HUD + iteration + auto-save  aae1593
✓ Unit 3a — Coaching analysis pure functions   253110e
✓ Unit 3b — exportCoachingAnalysis entry point e2e6a9a
✓ Unit 3c — Coaching review modal base layout  7f532d1
✓ Unit 3d — Modal heatmap SVGs                 7775a40
✓ Unit 6a — Drift compensation                  cafeb98
✓ Unit 6b — Tier-2 nearest-time selection      dff9855
✓ Unit 6d — IGNORED_DETECTOR_FAILURE demotion  4f22231
✗ Unit 6h — Chart-aware refractory (REGRESSED on user's audio,
              reverted in cce383f — body-peak resonance slipped
              through tightened 80ms refractory)
✓ Unit 6f — Dual-threshold judgment + raw timing aac2ce2
✓ Unit 6e — Onset detection + buffer flush     4fabac6
✓ Unit 6f — Dual-threshold judgment + raw timing aac2ce2
✓ Unit 6g — Stability voting (N-of-M)          7131698
✓ Unit 6i — Open-string contamination demotion 3eb88b0
✓ Unit H1 — testInjectWav in factory           45ae617
✓ Unit H2 — replay-baseline.js + routes        f1bf669
✓ Unit H1+ — chart-note injection from dumps    2c75be1
✓ Unit H1++ — avOffset override in replay      d995193
✓ Unit H2+ — onset-anchored matcher option     ccd0bf9
✓ Unit 3f — Improvement deltas (current vs prior) f1496fd

☐ Unit 6c  Sibling-claim accounting (coaching cosmetic, low priority)
☐ Unit 6j  YIN octave-down validation in _ndYinDetect
            (DEFERRED — analysis showed user's case is open-string
             contamination, not the harmonic-pick error 6j fixes;
             validate via fixtures with cleaner muting first)
☐ Unit 3e  Coaching review modal — history view
☐ Unit 3g  Top-3 prescriptions (cross-play)
☐ Unit 3h  Mid-session iteration banner
☐ Unit 3i  Fretboard heatmap
☐ Unit 4a  WAV recording during play
☐ Unit 4b  Auto-dump to server
☐ Unit 4d  Recording UI in settings panel
```

Each unit lands as its own commit on `port/from-factory` and (when the
dependency chain allows) ships as its own upstream PR.

---

## Unit conventions

- **Branch**: all work on `port/from-factory`. Direct commits, push at
  unit boundaries, then cherry-pick into a topic branch for the upstream
  PR.
- **Tests**: each unit must keep `npm test` green (currently 69 tests
  on this branch). Pre-port tests for two-axis / coaching / ranking
  haven't been ported yet — they come with their corresponding units.
- **Diff size**: target <300 lines added per unit. If a unit's diff
  blows past that, split it.
- **Reference grep**: the reference branch tag is the source of truth
  for the pre-port shape. Use line numbers from this doc to find
  reference code.

---

## Unit 2x — Drill HUD + iteration scoring + auto-save

**Why a follow-on:** the core drill (Unit 2, shipped) gets the player
into a loop with audible lead-in and judgment gating. The HUD and
iteration tracking are quality-of-life on top — important but
independent of the load-bearing fix.

**Reference:** `screen.js` lines 5618 (auto-save call site), 5623
(`_ndAutoSaveDrillLoop`), 5663 (`_ndShowDrillHud`), 5674
(`_ndUpdateDrillHud`), 5750 (`_ndDrillCaptureIterationScore`).

**Adds:**
- Drill HUD as a fixed overlay (focus / goal / iter-best / iter-current).
  Shown by `startDrillRange`, hidden by `endDrill`.
- Iteration scoring: capture combined score on each loop_restart event,
  push into `drillIterScores[]`, update best-so-far, mark goal hit.
- Auto-save the drill loop into slopsmith's saved-loops list (POST
  `/api/loops`) with dedupe so re-drilling doesn't pile copies.
- Per-instance state on factory: `drillFocus`, `drillGoal`,
  `drillIterScores[]`, `drillBestScore`, `drillGoalReached`.
- `loop_restart` listener — needs slopsmith to emit this event;
  upstream may already.

**Verify before porting:** does upstream emit `loop_restart` on the
slopsmith side? Check `static/app.js` and `slopsmith.emit` calls. If
not, this unit needs a slopsmith-side PR first.

**Diff target:** ~250 lines.

---

## Unit 3a — Coaching analysis pure functions

**Goal:** pure JS, no DOM, no factory state. Module-level functions the
modal code (and tests) can import.

**Adds (in order of dependency):**
- `_ndScoreColor(value)` — heat-map color ramp, used everywhere.
- `_ndComputeScores(noteResults)` — wraps `_ndScoresFromNotes` with
  pitch% and timing-quality fields the modal expects (already in Unit
  1; this is the wrapper).
- `_ndComputeScoreDeltas(current, prior)` — per-axis ± for the
  improvement-framing UI.
- `_ndFindMissClusters(noteResults, opts)` — sliding-window cluster
  finder. Groups adjacent error notes into time-bounded "trouble
  zones" with per-cluster failure-mode dominance.
- `_ndFindOverlappingPriorCluster(current, priorClusters)` — picks the
  prior cluster with maximum time overlap; used by per-cluster delta
  badges.
- `_ndComputeTimeHeatmap(noteResults, totalDuration, binSec=5)` — bins
  hits/misses across the song timeline.
- `_ndAggregateBySection(noteResults, sections)` — per-section
  hits/misses.
- `_ndComputeHygieneSummary(key)` — inferred from the localStorage
  hygiene-keys persistence; this is the per-note frame analysis.

**Reference:** lines 4490, 4521, 4584, 4631, 4653, 4678, 3293.

**No DOM.** No `document.querySelector`, no innerHTML, no factory
closure. Each function takes data, returns data.

**Tests to port:** `test/per-note-coaching.test.js`,
`test/practice-ranking.test.js`. Update for two-axis semantics if
needed.

**Diff target:** ~400 lines (mostly verbatim copy from reference).

---

## Unit 3b — `_ndExportCoachingAnalysis` entry point

**Goal:** the single source of truth the modal AND tests both consume.

**Adds:**
- `_ndExportCoachingAnalysis(play, opts)` — pure function returning
  `{ derived, clusters, perSection, timeHeatmap, topFix, sections,
  totalDuration }`. Shape locked so the modal renderer in 3c can
  hard-code its consumption.

**Reference:** line 4993, ~100 lines.

**Why separate from 3a:** this is the contract surface. 3a's functions
should be callable individually; 3b is the bundle. Splitting lets
plugin consumers (or tests) call individual pieces without depending
on the full pipeline.

**Tests:** add a regression test that asserts the bundle shape on a
fixture play. Catches schema drift.

**Diff target:** ~150 lines.

---

## Unit 3c — Coaching review modal (base layout)

**Goal:** the modal opens from the post-game session boundary and shows
the player their results. No history, no prescriptions, no per-cluster
drill buttons yet — those come in 3d/3e/3f.

**Adds:**
- `_ndShowCoachingReview({ playId, source })` — async; fetches the play
  JSON, calls `_ndExportCoachingAnalysis`, renders the modal.
- Modal HTML structure: header, two-axis score tiles (Detection +
  Precision), section breakdown table, cluster list (read-only —
  drill buttons come in 3c+).
- `_ndRenderSubScoreTile(label, valueText, color, deltaSlotId)` —
  reusable score tile. Delta slots are placeholders that 3f populates.
- Close button + backdrop click handler.

**Reference:** lines 5094 (entry point), 4729 (sub-score tile), 4925
(cluster row — basic version, drill button portion deferred).

**Verify:** modal-close path doesn't leak event listeners. Reference
already handles this; copy carefully.

**Diff target:** ~300 lines.

---

## Unit 3d — Coaching review modal (heatmap SVGs)

**Goal:** the time-binned and section-binned heat strips.

**Adds:**
- `_ndRenderTimeHeatmapSvg(timeHeatmap, totalDuration, sections)` —
  per-time-bin SVG with section boundary markers.
- `_ndRenderSectionHeatmapSvg(perSection, sections, totalDuration)` —
  per-section SVG, width-proportional to section duration.
- Inline both into the modal layout from 3c.

**Reference:** lines 4778, 4806.

**Diff target:** ~150 lines.

---

## Unit 3e — Coaching review modal (history view)

**Goal:** "your last N plays of this song" expandable section in the
modal. Line chart of detection % across plays + per-section trend
sparklines.

**Adds:**
- `_ndRenderHistoryLineChart(plays)` — SVG line chart, x = play index,
  y = detection %.
- `_ndRenderSectionTrends(sectionsData)` — sparkline per section.
- Lazy fetch on toggle expand (don't load history unless user asks).
- `/api/plugins/note_detect/plays?songId=...&limit=10` consumer.

**Reference:** lines 5412, 5447.

**Diff target:** ~250 lines.

---

## Unit 3f — Improvement deltas (current vs prior)

**Goal:** patch the score-tile delta slots in 3c with `+5%` / `-2%`
badges showing change since the last comparable play.

**Adds:**
- `_ndPatchImprovementDeltas(modal, currentPlay, currentDerived,
  currentClusters)` — async; fetches the most-recent non-drill play,
  computes deltas, patches DOM in place.
- `_ndComputeScoreDeltas` already added in 3a; this is the consumer.
- Prior-cluster matching for per-cluster deltas via
  `_ndFindOverlappingPriorCluster`.

**Reference:** at the bottom of `_ndShowCoachingReview` (line ~5290 in
reference), `_ndPatchImprovementDeltas` itself follows it.

**Diff target:** ~200 lines.

---

## Unit 3g — Top-3 prescriptions (cross-play)

**Goal:** "you have 3 main problems — here's how to drill them" panel.
Aggregates trouble notes across the last N plays into ranked
prescriptions.

**Adds:**
- `_ndAggregatePlays(plays)` — combines noteResults across plays
  weighted by recency.
- `_ndComputeTop3Prescriptions(plays, songFilename, avOffsetMs,
  micLatencyMs)` — picks the 3 highest-severity issues with prescription
  templates.
- `_ndRenderPrescriptionsBlock(top3)` — HTML for the modal section.
- `_ndShowTipCard(prescription)` — expanded view when user clicks a
  prescription.
- `_ndAggregateTroubleAcrossPlays(plays)` — used by trouble heatmaps.

**Reference:** lines 1045, 1185, 1376, 1419, 5998.

**Diff target:** ~400 lines (largest pure-function unit).

---

## Unit 3h — Mid-session iteration banner

**Goal:** during drill mode, a small floating banner shows iteration
results between loops without opening the full modal.

**Adds:**
- `_ndShowIterationBanner(noteResults)` — shows last-iteration combined
  score + delta vs previous iteration.
- Auto-dismisses after 3s, or stays sticky if goal hit.
- Tied to `loop_restart` event (same hook as Unit 2x).

**Reference:** line 6041.

**Depends on:** Unit 2x for the `loop_restart` event hookup.

**Diff target:** ~150 lines.

---

## Unit 3i — Fretboard heatmap

**Goal:** per-(string,fret) miss frequency rendered as a fretboard
graphic. Surfaces "you miss every D2 on string 2 fret 5" patterns.

**Adds:**
- `_ndComputeFretboardHeatmap(plays, opts)` — reduces noteResults to a
  string×fret grid of miss counts.
- `_ndRenderFretboardHeatmap(grid, stringCount, maxFret)` — SVG
  fretboard with cells colored by miss density.
- Adds another collapsible section to the modal.

**Reference:** lines 6553, 6633.

**Diff target:** ~250 lines.

---

## Unit 4a — WAV recording during play

**Goal:** capture the raw audio stream into a Float32Array buffer
during play, time-anchored to chart-time, so we can replay through
the detection pipeline offline.

**Adds (per-instance closure state):**
- `recording`, `recordChunks[]`, `recordTotalSamples`,
  `recordMaxSamples`, `recordSampleRate`, `recordChartStartTime`,
  `recordAnchored`, `recordArmedChartTime`, `recordFilename`.
- Public methods: `recordStart(maxSeconds, filename)`,
  `recordStartRaw`, `recordStop`, `recordStatus()`.
- Anchor logic: WAV t=0 corresponds to a sample taken while chart was
  advancing past `recordArmedChartTime` (so a paused-at-start chart
  doesn't anchor to silence).
- `_ndRecordToWavBlob(pcm, sampleRate)` — pure conversion.

**Reference:** lines 680, 701, 718, 731, 751, 781.

**Adds to `processFrame` (or wherever the raw buffer is observed):** a
hook that pushes the chunk into `recordChunks` when `recording` is
true.

**Diff target:** ~300 lines.

---

## Unit 4b — Auto-dump to server

**Goal:** at session boundaries (song end, detect off, drill iteration
end), if a recording is active, save it to the server's plays
directory with a JSON sidecar of judgments.

**Adds:**
- `_ndAutoDumpPost()` — POSTs WAV + sidecar to
  `/api/plugins/note_detect/recording`.
- Hooks into the session-boundary signal (which session-boundary path
  upstream uses needs verification).
- Filename convention: `<songId>__<timestamp>.{wav,json}`.

**Depends on:** 4a (recording).

**Reference:** line 869.

**Diff target:** ~150 lines.

---

## Unit 4c — Replay through pipeline (`_ndInjectTestWav`)

**Goal:** load a recorded WAV, route it through the same
gain → analyser → processor chain as live mic input, run the
detection pipeline against it, return the resulting hits/misses.

**Adds:**
- `_ndInjectTestWav(wavUrl, durationSec)` — async, returns summary.
- `_ndInjectTestAudio(noteSequence, options)` — synthetic-tone variant
  used by tests.
- Test infrastructure tie-in: the offline harness in
  `test/spectral-flux-sim.js` etc. depends on this for cross-fixture
  validation.

**Reference:** lines 8787, 8987.

**Why valuable:** the entire "trust sim, not user perception"
discipline (project memory `feedback_sim_vs_perception.md`) depends on
having a reproducible offline replay path. Without 4c, every detector
change requires live testing.

**Diff target:** ~400 lines.

---

## Unit 4d — Recording UI in settings panel

**Goal:** "Diagnostic Recording" section in the gear panel —
duration picker, start/stop button, status line, last-recording
filename.

**Adds:**
- HTML section in the settings panel.
- Wire to public methods from 4a/4b.
- Status polling for in-flight recordings.

**Depends on:** 4a + 4b.

**Reference:** within the settings panel in the reference around line
~4220 of the pre-port file (look for "Diagnostic Recording" string).

**Diff target:** ~150 lines.

---

## Cross-cutting deferrals

These existed in the reference but aren't tied to a port unit. Capture
when needed:

- `_ndRenderCalibrationModal` (line 3624) — A/V offset calibration
  wizard. Could be its own unit or rolled into Unit 3c.
- `_ndShowSettings` (line 4117) — settings-screen entry point. Already
  handled differently in the factory.
- `_ndRecordNowlineJudgment` (line 6918) — nowline annotation for
  recordings. Roll into 4a.
- `_ndComputeTimelineBins` / `_ndRenderTimelineStrip` (lines 6327,
  6469) — alternative timeline view. Probably skip — superseded by
  the time heatmap (3d).
- `_ndRenderCoachingMismatchNotice` (6736) — tuning-mismatch banner.
  Small, fold into 3c.
- `_ndRenderCoachingPanel` (6765) — alternative inline panel
  (vs. modal). Probably skip — modal is the primary surface.
- `_ndAutoSaveDrillLoop` (5623) — covered by Unit 2x.

---

## After all units ship

- Delete `reference/pre-port-baseline` once Unit 4d lands and all
  tests pass.
- Each unit becomes a separate PR upstream for reviewability. Don't
  bundle.
- Final test count target: ~150-200 (port the pre-port branch's full
  suite as units land). Currently 69.

---

## Order of execution (recommended)

```
2x → 3a → 3b → 3c → 3d → 3f → 3e → 3g → 3i → 3h
                                              ↑
                                           depends on 2x
4a → 4b → 4c → 4d
```

Rationale:
- 2x first: drill HUD is small and the `loop_restart` hookup unblocks
  3h later.
- 3a → 3b → 3c is the modal MVP path — pure functions first, contract
  next, base UI last.
- 3d / 3f before 3e because heat strips and deltas don't need the
  history fetch infrastructure that 3e introduces.
- 3g/3i are nice-to-haves that ship after the core modal works.
- Unit 4 chain is independent — could be done in parallel by a second
  agent or in an off-session.

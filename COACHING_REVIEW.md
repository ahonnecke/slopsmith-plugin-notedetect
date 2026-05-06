# Coaching review + drill mode

The post-play modal that opens at session boundaries (song-end,
restart, loop-clear, detect-off), plus the in-session drill mode
that loops a tight cluster of trouble notes with a goal-driven HUD.

## When the modal pops

| Trigger | Source | Wired in |
|---|---|---|
| Song reaches end | `audio.ended` event | global hook in screen.js |
| Detect toggled off | `disable()` directly | factory teardown |
| Loop cleared mid-drill | `endDrill()` → `_ndOnSessionBoundary` | drill teardown |
| Restart Song button | manual | host slopsmith control |

The `audio.ended` listener is registered ONCE at module init via
`_ndInstallAudioElementHooks` (dataset-guarded against double
registration). Without it, letting a song play to natural completion
left the user with no review surface — explicit Detect-off was the
only path. User-reported regression, fixed.

## What's in the modal

### Header
- Song title, played-at timestamp, source label
- Combined weighted score (color-coded) with `↑/↓ vs last attempt`
  delta when a prior comparable play exists

### Three sub-score tiles
- **Pitch %** — of detections, fraction that hit the right pitch
- **Timing** — median ± std of HIT timing error in ms (negative =
  early; positive = late; tighter=better in the delta)
- **Coverage %** — fraction of chart notes that produced any
  detection (HIT / DIRTY_HIT / MISSED_WRONG_PITCH)

Each tile has a delta badge below showing the change vs the prior
non-drill play of the same song. Drills are excluded from the
comparison set so a 7s drill-loop play can't claim "+47% vs last."

### Top fix headline
A single-sentence callout at the top of the modal:
- **Cluster-kind**: when at least one cluster exists, picks the
  densest by miss-rate × miss-count and surfaces its focus statement
  + advice. Click → scrolls to and highlights the matching row.
- **Axis-kind**: fallback when no clusters (uniform play). Picks the
  weakest sub-score axis and surfaces global coaching advice. Static
  card, not clickable. Without this, a 79% all-LATE play showed "no
  trouble clusters — clean play" which was wrong.

### Time-binned heatmap
Replaces the section-based heatmap. Independent of chart structure:
- 5-second bins, colored by per-bin weighted score
- Empty bins (no notes) render dark gray
- Chart section names floated above as guides

Section heatmaps were useless on sparse-section charts (Gasoline has
2 sections for a 3:46 song). Time bins guarantee consistent
granularity.

### Trouble spots — densest miss clusters
Sliding-window finder picks dense pockets of OFF-TARGET notes
(anything that isn't a clean HIT). Each row:
- mm:ss–mm:ss range
- Off-target count + total notes
- Focus statement (auto-generated from cluster characteristics)
- Authored advice from `_ND_FAILURE_MODE_INFO[mode].advice`
- Goal % (current accuracy + 20pp, capped at 90%)
- ↑/↓ delta vs same time-window in prior play (when overlap exists)
- Drill buttons (recommended speed prominent, alternative dimmer)

Off-target = HIT-with-EARLY/LATE/SHARP/FLAT label, DIRTY_HIT, or any
MISS. Clustering on miss-only (the original algorithm) reported
"clean play" on a 79% all-LATE attempt because it ignored sloppy
hits.

### History toggle
Lazy-loaded panel. Per-song accuracy line chart over last N plays
plus per-section trend bars. Drill plays render as smaller stroked
dots so they don't visually compete with full-song attempts.

## Score model

`_ND_SCORE_WEIGHTS` (one config block in screen.js):

| Verdict | Weight | Why |
|---|---|---|
| HIT (clean) | +1.00 | the bar |
| HIT with timing label | +0.85 | within window but sloppy timing |
| HIT with pitch label | +0.85 | within window but pitch-off |
| DIRTY_HIT | +0.60 | hit but with off-target frame contamination |
| MISSED_NO_DETECTION | -1.50 | no pluck or onset never fired |
| **MISSED_WRONG_PITCH** | **-2.50** | wrong note (the headline) |
| IGNORED_DETECTOR_FAILURE | 0 | detector fault, excluded from total |

User wanted coaching style: missing by 10ms shouldn't cost the same
as playing the wrong string. Wrong-pitch is ~3× harsher than a near-
miss timing slip.

Combined = `sum(weight) / (totalNotes * HIT_CLEAN)`, clamped [0, 1].

## Single source of truth

Every number in the modal derives from `play.noteResults` via one
function: `_ndScoresFromNotes`. Headline score, sub-score tiles,
cluster row accuracy, per-section heatmap fill — all share the same
math. The persisted `play.summary` exists for fast list views but
isn't authoritative; modal recomputes from raw notes at open time so
a future weight change can't desync the displayed numbers.

## Drill mode

Click "Drill this" on a cluster → `startDrillRange(start, end, ...)`:

1. **Audio loop**: `[clusterStart - 5, clusterEnd]` — 5s audible
   lead-in before the judgment window.
2. **Judgment window**: `[clusterStart, clusterEnd)` — only notes
   here count toward score. Notes during lead-in run through the
   detection pipeline but get neither HIT nor MISS verdicts. Gated
   in `_ndCheckJudgmentRange` (testable parameterized form) and
   `isInDrillJudgment` (module-state-bound wrapper) at both
   `matchNotes` and `checkMisses` call sites.
3. **Speed**: defaults to 1.0; cluster's analysis recommends 0.75
   when timing dominates the failure mode. Stored as
   `audio.playbackRate`; restored on drill end.
4. **Auto-save**: drill loop POSTed to slopsmith's `/api/loops` with
   name `Drill: mm:ss–mm:ss`. De-duplicates within 2.0s on each
   endpoint so re-drilling the same cluster doesn't pile copies.
5. **Count-in bypass**: `window._ndAnyDrillActive = true` — slopsmith
   reads this in its loop-wrap handler and skips the 4-beat click-
   track count-in for drill loops (see slopsmith/docs/LOOP_MANAGER.md).

### Drill HUD

Floating overlay top-center showing:
- Focus statement ("Consistently late by ~47ms")
- Goal target ("goal 80%")
- Iteration counter and per-iteration score (updates each loop wrap)
- Best-so-far score
- 🎯 sticky "Goal hit!" banner once the user crosses the target
- Current speed (e.g. `@ 75%`) when not at full speed
- × button to end the drill

Pause/play hooks update the HUD with a yellow border + "⏸ Paused"
tag so the user can see they're not in active drill state.

### Visual floor highlight

`drawOverlay` checks `drillActive` BEFORE the `!enabled` gate (so
the band reliably appears on the first iteration even when
getUserMedia is mid-setup). When chart-time is in the judgment
window, a blue gradient fills the bottom 40% of the highway with a
sharp 2px top border at the strikeline. Lead-in time has no band,
making the score-on transition unmissable.

## Test harness

`test/coaching-export.test.js` drives `_ndExportCoachingAnalysis` (the
single entry point the modal calls) against synthetic fixtures and
asserts the output. Lets coaching algorithms be iterated without
playing through a song every time. Cases covered:

- Clean play (no clusters, no topFix)
- Uniform LATE timing (cluster forms; focus says "late")
- Clustered misses (cluster aligns with miss band)
- Uniform sparse skew (axis-fallback topFix)
- Wrong-pitch position-specific focus
- IGNORED_DETECTOR_FAILURE excluded from total
- Cluster row accuracy = `_ndScoresFromNotes(cluster.notes)` (single-
  source-of-truth invariant)
- Per-section heatmap accuracy = weighted score (not raw hit ratio)
- Time-binned heatmap (full-duration coverage, score equality)
- Score deltas (positive when current beats prior, null guards)
- Overlap finder (largest-overlap match wins)
- Drill judgment range (parameterized; boundary inclusivity)
- Loop-dedup tolerance (configurable, both-endpoint match)

Pure-data fixtures only at this layer — no audio, no DOM, no
server. Runs in `make test` in seconds.

## Storage

Plays history persists in `CONFIG_DIR/notedetect_plays.db` (SQLite).
Endpoints in `routes.py`:

```
POST /api/plugins/note_detect/plays           — write a play snapshot
GET  /api/plugins/note_detect/plays?songId=…  — list recent plays
GET  /api/plugins/note_detect/play/<id>       — single play with notes
GET  /api/plugins/note_detect/sections/<id>   — per-section trend
```

Drill plays are tagged `is_drill = 1, drill_section_name = 'cluster N'`
so the history view can distinguish them from full song-pass plays.

## Self-diagnostic probes

Console-callable at `slopsmith.ndDiag.*` — let me debug without
asking the user to play through a song:

```js
slopsmith.ndDiag.client()           // deployed code, current state
await slopsmith.ndDiag.server()     // confirms server is on new SQLite routes
await slopsmith.ndDiag.clusters()   // computes clusters for the most recent play
slopsmith.ndDiag.drillRangeFor(name) // computes drill range for a section
await slopsmith.ndDiag.openReview()  // opens modal for most recent play
slopsmith.ndDiag.audioPath()         // captures audio + AudioContext state
await slopsmith.ndDiag.all()         // bundle-runs the above
```

`server()` explicitly detects whether the running slopsmith instance
is on the new SQLite routes vs the old `/tmp/nd_plays` JSON routes
— most common cause of "the modal didn't open" was a stale server.

## Files

- `screen.js` — everything (factory pattern; per-instance state)
- `routes.py` — SQLite plays storage + REST endpoints
- `test/coaching-export.test.js` — pure-data regression net
- `test/_loader.js` — vm-context loader exposing the pure functions

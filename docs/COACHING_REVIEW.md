# Coaching post-play review

The review modal pops at session boundaries and shows what just happened
in three coaching axes, plus a section heatmap and cluster-based trouble
spots you can drill in tight loops.

## When it pops

| Trigger | When it fires | Drill behavior |
|---|---|---|
| Song end (`<audio>` ended) | natural end of full song play-through | suppressed during drill (loop iteration is not an end) |
| Restart Song button (`song:restart`) | user clicks ↺ Restart in slopsmith | ends drill mode |
| Loop Clear (`btn-loop-clear`) | user clicks the A-B loop ✕ button | ends drill mode |
| Detect toggle off | user disables Detect mid-session | ends drill mode |

If `_ndNoteResults` is empty (loop_restart already drained it), the modal
falls back to the most recent play snapshotted in this session so the
user still sees a review.

## What's in the modal

- **Top stat row**: combined weighted score (color-coded), played-at
  timestamp, song title.
- **Three sub-scores**:
  - **Pitch %** — of detections, fraction that hit the right pitch.
    Excludes notes that produced no detection at all.
  - **Timing** — median ± std of HIT timing error in milliseconds.
    Negative = early; positive = late.
  - **Coverage %** — fraction of chart notes that produced any detection
    (HIT, DIRTY_HIT, or MISSED_WRONG_PITCH).
- **Section heatmap** — horizontal SVG bar with one cell per chart
  section, width proportional to section duration, fill color by combined
  weighted score in that section. Hover for breakdown.
- **Trouble spots — densest miss clusters** — sliding-window finder that
  picks the highest-density miss windows regardless of where chart
  sections fall. Each row shows a `mm:ss–mm:ss` time range, miss count,
  total notes in window, and a "Drill this" button.
- **History toggle** — lazy-loaded panel with a line chart of combined
  score across the last N plays + per-section trend bars.

### Why clusters, not sections

Many CDLCs label sections sparsely (Gasoline has 2 sections for a 3:46
song). Section-level drilling on a coarse chart effectively loops the
whole song. Cluster-level drilling produces tight 5–10s windows
regardless of chart structure.

The cluster algorithm: 6s sliding window, 0.5s slide, minimum 2 misses
per window, greedy non-overlap selection across the top candidates,
plus 0.5s lead + 1s tail padding so the user has runway. Set in
`_ndFindMissClusters` in `screen.js`.

## Coaching score weights

Defined in `_ND_SCORE_WEIGHTS` near the top of the scoring section in
`screen.js`. The user's headline complaint that motivated the design:
*"missing a note by 10ms shouldn't cost the same as playing the wrong
string."*

| Verdict | Weight | Why |
|---|---|---|
| HIT (clean) | +1.00 | the bar |
| HIT with EARLY/LATE label | +0.85 | within window but sloppy timing |
| HIT with SHARP/FLAT label | +0.85 | within window but pitch-off |
| DIRTY_HIT | +0.60 | hit but with off-target frame contamination |
| MISSED_NO_DETECTION | -1.50 | no pluck or onset never fired |
| **MISSED_WRONG_PITCH** | **-2.50** | wrong note, the coaching headline |
| IGNORED_DETECTOR_FAILURE | 0 | detector fault, excluded from total |

Combined score = `sum(weight) / (totalNotes * HIT_CLEAN)`, clamped
[0, 1]. Live HUD uses the same weighted accuracy.

## Storage

Plays persist in `CONFIG_DIR/notedetect_plays.db` (SQLite, two tables:
`plays` + `play_notes` with FK cascade). Survives reboots; supports
cross-session queries used by the history panel.

Endpoints:

```
POST /api/plugins/note_detect/plays           — write a play snapshot
GET  /api/plugins/note_detect/plays?songId=…  — list recent plays for song
GET  /api/plugins/note_detect/play/<id>       — single play with full notes
GET  /api/plugins/note_detect/sections/<id>   — per-section trend across recent plays
```

Retention: 50 most recent plays per song (bumped from JSON-era 10).
Old `/tmp/nd_plays/*.json` get one-shot imported on first server
startup with the new code.

## Drill mode

Click "Drill this" on a trouble cluster → `_ndStartDrillRange(start, end)`
does:

1. Clamps `loopB` to `audio.duration - 0.05` so the
   `audio.currentTime >= loopB` trigger always fires.
2. Sets `_ndDrillActive = true`, `_ndDrillSectionName` = a label.
3. `_ndResetScoring()` for a fresh window.
4. `window.setActiveLoop(start, end)` — slopsmith's built-in A-B loop +
   count-in machinery handles the rest.
5. Auto-enables Detect if it's off.

Drill ends on `loop_clear` / `detect_off` / `restart` / song change.
Plays from drill mode are tagged `is_drill = 1` and `drill_section_name`
in the DB so the history view can distinguish drill plays from full
song-pass plays.

## Coaching roadmap — making the report actually coach

The current report shows where the user missed. Coaching research
(deliberate-practice literature + rhythm-game design) says that's
necessary but not sufficient: feedback has to be **informative**
(what went wrong), **individualized** (keyed to YOUR weakness),
and **actionable** (what to DO next). Most rhythm games — including
Rocksmith 2014 — fail at the third. The plan below closes that gap
across five phases, ordered by ROI.

### Phase 1 — surface the advice we already have

`_ND_FAILURE_MODE_INFO` (screen.js) carries authored advice strings
for every failure mode (`OPEN_STRING`, `WRONG_OCTAVE`, `WRONG_PITCH`,
etc.) — e.g., *"Right-hand mute the lower strings — the unmuted
string is ringing alongside your fretted note."* The modal currently
renders only `info.label` and discards `info.advice`. Phase 1 adds
the advice text to each cluster row.

### Phase 2 — top-of-modal "top fix" headline

A single sentence at the top of the modal that distills the
single-most-actionable improvement: *"🎯 Top fix: 2 pitch errors at
0:09 — right-hand mute the lower strings."* Picks the worst cluster
by miss-density × severity and renders the relevant
`_ND_FAILURE_MODE_INFO[dominantMode].advice` with a clickable jump
to that cluster. Replaces the stat-dump-first layout with
recommendation-first.

### Phase 3 — improvement framing

Fetch the previous play for the same song, compute deltas on every
sub-score and per-cluster, render *"73% (+8% vs last attempt)"*
instead of just *"73%."* Frames absolute scores as progress, which
deliberate-practice research highlights as critical for sustained
motivation: people repeat behaviors they see improving. Per-cluster:
if the same time-window had a cluster in the prior play, show
delta on that range too.

### Phase 4 — focused drill with explicit goal

Each cluster gets a "focus" sentence describing the dominant problem
in motor terms: *"You were consistently late by 47ms here"* /
*"Wrong-pitch errors on s3/f5 dominated"* / *"Detection missed 4
plucks — check input gain."* Drill button splits into:

- **Drill @ 75%** — `audio.playbackRate = 0.75` for the loop.
  Suggested when timing errors dominate (slow practice consolidates
  motor patterns).
- **Drill @ full speed** — default. Suggested when pitch/coverage
  errors dominate.

The drill HUD shows the focus statement + an explicit numeric goal
("Aim for 80%") and the live combined-weighted-score for the drill
loop, so the user can watch the number rise across iterations.
Auto-advance suggestion when the goal is hit: *"You hit 82% — try
the next cluster?"*

The focus + goal is computed once per cluster and stored on the
cluster object, so Phase 4's drill UI reuses the same string Phase 1
shows in the cluster row.

### Phase 5 — auto-advance + session goal

Track which clusters the user has hit goal on across drill sessions
within a song. Surface progress: *"3 of 5 trouble spots cleared this
session — one more before you're ready to try the full song again."*
This is the long-arc engagement loop: clear the trouble spots, prove
mastery, level up the song.

### Open questions / non-goals

- **No video links / lesson integration in this pass.** Coaching is
  algorithmic + textual. Adding tutorial videos is a different
  product.
- **No per-string adaptive latency.** ROCKSMITH_TIMING_MODEL.md rules
  this out — one global offset is what scales.
- **No score multipliers or star ratings.** The combined weighted
  score is the headline; we don't bolt arcade-game flair on top of a
  practice tool.
- **No social / leaderboards.** Out of scope.

## Self-diagnostic probes

Console-callable so I can debug without making the user play:

```js
slopsmith.ndDiag.client()           // deployed code, current state, listener refs
await slopsmith.ndDiag.server()     // confirms server is on new SQLite routes
await slopsmith.ndDiag.clusters()   // computes clusters for the most recent play
slopsmith.ndDiag.drillRangeFor(name) // computes drill range for a section
await slopsmith.ndDiag.openReview()  // opens modal for most recent play
await slopsmith.ndDiag.all()         // bundle-runs the above
```

The `server()` probe explicitly detects whether the running slopsmith
instance is on the new SQLite routes vs the old `/tmp/nd_plays` JSON
routes — the most common cause of "the modal didn't open."

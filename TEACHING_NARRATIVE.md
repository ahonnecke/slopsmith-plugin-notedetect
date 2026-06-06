# note_detect as a teaching tool — feature narrative

Goal: a tool that **effectively teaches the user guitar/bass**, not just scores a
play. Base = upstream/main (Byron's clean, core-compatible version). Authorship
doesn't matter; pedagogy does. This doc inventories every available feature
(main + unmerged `feat/*` branches) and arranges them into a learning loop, then
names the one missing piece: turning the data into a coaching **narrative**.

## Signal chain & environment (2026-06-05)

- **Interface: Focusrite Scarlett Solo 3rd Gen** (replaced the low-output, noisy
  Hercules Rocksmith USB adapter). Class-compliant on Linux/PipeWire, 48 kHz.
  Instrument → 1/4" input (engage **INST**), gain set so the halo is green/amber.
- **Monitoring & routing:** Scarlett is the **default PipeWire sink**, so
  slopsmith's song audio plays *through* it; the guitar is heard via the
  Scarlett's **hardware Direct Monitor**. Both land in the Scarlett headphones.
  (The old PipeWire `make monitor-on` loopback for the Rocksmith adapter is
  retired.) Caveat: all system audio now goes to the Scarlett.
- **Noise:** the Scarlett preamp is clean (−95 dBFS empty channel); residual is
  ~60/180 Hz mains hum from the guitar/grounding, knocked down by lower gain.
  Not an interface fault and not a detection blocker at playing levels.
- **Detection method: HPS** for bass (locks on a weak fundamental).

## The learning loop (what already exists)

1. **Play** — real-time pitch detection from the DI/dry input.
   - Single notes: **YIN** (default), **HPS** (bass / weak fundamental),
     **CREPE/SPICE** (ML, robust to distortion). Chords: constraint-based
     per-string energy check (counts how many strings actually ring).
   - Guitar (6/7/8) and **bass** (4/5), tuning base auto-selected from the
     arrangement. *(Bass accuracy refinements live in `feat/bass-detection`,
     `fix/bass-wrong-position-precision`, `feat/ml-note-detection` — pull in.)*

2. **See, immediately, HOW you're wrong** — not just hit/miss.
   - Diagnostic misses: **EARLY / LATE** (timing) and **SHARP / FLAT** (pitch),
     with signed `timingError` (ms) and `pitchError` (cents) per note.
   - Live feedback on the highway: gem hit/active glow, red miss outline, and
     **on-strike sustain glow driven by input level** (`feat/live-sustain-note-glow`).
   - HUD: running accuracy + streak.

3. **Measure** — scoring with structure.
   - Per-**section** accuracy breakdown at stop; **clean** vs **outer** windows
     (a note inside the outer window but outside the clean threshold is a
     diagnostic miss, not a pass). This is where **difficulty presets** live —
     tighten the clean pitch/timing windows for a **"harder than Rocksmith"**
     mode (task #11).

4. **Drill** — deliberate practice on the hard part.
   - Set an A-B loop; each iteration is scored separately so you watch the same
     passage improve rep over rep (`getDrillStats()`). *(Robustness in
     `feat/drill-mode` — pull in.)*

5. **Track over time** — `notedetect:session` (+ `:hit`/`:miss`) events feed the
   **Practice Journal** plugin: history, trends, which songs/sections lag.

## The missing piece — the *narrative* (north star, task #14)

Today the output is numbers and per-section bars. To **teach**, the tool should
turn each play's rich JSON (every note's `timingError`/`pitchError`/detected vs
expected, section stats, drill deltas, the recording itself) into a short
**coaching narrative**: *"Your timing drifts late in the fast run at 0:48 — you're
rushing the position shift; the chorus is solid. Drill bars 17-20 at 80%."*

- Input already exists: the per-note judgment stream + `:session` aggregate +
  the harness recordings. This is exactly the structured data an LLM reads well.
- Plan: send that JSON to an LLM **using the user's own API key** (key in
  settings/localStorage; never server-side), with a prompt that produces a
  prioritized, encouraging, *specific* practice plan. Render it in the
  end-of-song panel and persist to the Practice Journal.
- This replaces/augments the programmatic coaching with explanation a learner
  can act on — the whole point of the tool.

### The target: every play yields *actionable* feedback (one of two forms)

The bar for "done" is that a play never just produces a bare number — it
produces something the learner (or the tool) can act on. Each flagged note
resolves to exactly one of two outcomes, and **both are acceptable because both
are actionable**:

1. **Localized + categorized failure** — *where* and *what*: a specific section
   (intro, the fast run at 0:48) plus a specific failure type (wrong note, late,
   string noise, muted/ghosted, wrong string). Actionable for the **learner** —
   they know exactly what to drill.
2. **"Looked right to the AI → send it to the harness."** When the play looked
   correct but the tool scored it a miss (the detector's fault, not the
   player's), the right output is to route that note/clip into the harness for
   offline detector work. Actionable for the **tool** — it becomes a detector
   fix, not a false "you missed" that erodes trust.

The system must be able to tell these apart — player error vs detector error —
and emit the matching action. Outcome 2 is exactly the loop that surfaced the
frame-size bass-recall fix: a "miss" that was really the detector, caught by the
harness. Wiring this judgment (player-fault vs tool-fault) into the per-play
feedback is the concrete shape of the north-star coaching output.

### Per-failure-type tools (the categorized half of outcome 1)

A localized + categorized failure shouldn't just be *named* — each category can
have a **tool** that fixes it, not only a drill that grinds it:

- **Tempo / timing off → a click track.** A metronome the user can play against.
  The sharp case is a **bass intro where the bass is the very first beat**: there
  is no preceding sound to lock to, so the bassist has nothing to time against
  and the timing scatters. Three modes: **off**, **always on**, or
  **bass-intros only** — where the click leads the player in and then *fades out
  once the rest of the mix enters*, so it's a crutch for the entrance only, not a
  permanent metronome over the whole song. This is the concrete tool behind the
  "your tempo is off" feedback (vs. the general drill loop below, which is the
  catch-all for any recurring hot spot).
- **Played-during-a-rest → score the silence (forward-looking).** "The notes you
  *don't* play are as important as the ones you do." Bass routinely drops a note
  on purpose — e.g. *Why'd You Only Call* ~0:45, where the lick that's normally
  4-5-5 (on the A string at ~0:40) becomes **4-5-SILENT** — and often the rest is
  the musical point (it lines up with the lyric / a drop-out that lands harder on
  the re-entry). Playing the dropped note should register as a **miss** (a new
  failure type, the inverse of `no_detection`: a detection where the chart wants
  silence). **Why this is harder than it sounds, and a prerequisite, not a quick
  win:** the chart has to *mark* intentional rests per instrument, and RS2014
  charts don't — you can't infer "deliberate silence" from a gap, because gaps
  between phrases are everywhere. `lib/song.py`'s `Note` has `mute`/`palm_mute`/
  `fret_hand_mute` (muted *notes*) but no rest concept, and `sloppak-spec` has
  none either. The path: extend the sloppak format (its unknown-keys hook
  allows it) with an explicit per-instrument **rests** track ("be quiet from t0
  to t1") — authored or, riskily, heuristically inferred — then the detector
  flags a confident detection inside a rest window as the error. The *scoring* is
  easy once the rests exist; **getting the rest markers into the chart is the
  real work.** (Same shape as a drums drop-out that hits harder on the re-entry —
  negative space as a first-class, scoreable chart event.)
- (Other categories — wrong note, string noise, muted/ghosted — get their own
  tools/coaching as they're built out.)

### The learner branch: the deliberate-practice drill loop

When the decision is **player-fault**, the feedback the user gets is not a list
of mistakes — it's a **practice loop** that walks the classic slow-it-down,
speed-it-up method automatically:

1. **Find the hot spot from MULTI-PLAY evidence** — a sliding-window finder over
   the per-note miss history flags a region only when it recurs (the prior
   implementation gated on **≥3 misses across plays**), so the loop targets a
   real weakness, not a one-off fumble.
2. **Offer it, then auto-set an A–B loop** — surface a banner ("N notes you keep
   missing · X% miss rate") whose action calls `setActiveLoop(start, end)`,
   bracketing a beat before/after so run-in and run-out are included.
3. **Drill the loop slowed down** — every note, at a reduced `speedMul`
   (playback rate) the user can hit cleanly; original speed is saved and
   restored on exit.
4. **Goal-gate the progression** — each loop iteration scores; track the best
   score; when an iteration clears a target (`drillGoal` → `drillGoalReached`),
   that's the signal to step the speed up. Concrete criterion, not a blind timer.
5. **Graduate** — play the section cleanly at full speed → drop the loop, replay
   the **full song**, find the next hot spot.
6. **Repeat** until no hot spot clears the evidence bar.

**This is the user's own prior method — recover it, don't re-derive it.** The
logic survives in `fix/bass-and-low-note-detection` (the sliding-window hotspot
finder `_ndFindHotspot` + `_ndShowPracticeBanner` → `setActiveLoop`; multi-play
miss aggregation) and `recover/reference-v1.2.0` (the speed/goal conductor:
`speedMul`, `drillSavedSpeed`, `drillGoal`/`drillBestScore`/`drillGoalReached`).
Upstream `feat/drill-mode` provides only the A–B-loop *scoring* foundation
(`drillIterations`/`Hits`/`Misses`/`Streak`); the hot-spot finder and the
speed/goal conductor are the missing halves to graft on. (Reliability
prerequisite still holds: a "mistake" must be real, or the loop drills the
player on the detector's blind spots — hence the bass-recall + A/V-calibration
fixes land first.)

**Status — conductor RECOVERED (2026-06-06, `feat/drill-loop-orchestrator`, v1.16.0).**
Step 3 (drill slowed) + step 4 (goal-gate the progression) + step 5 (graduate)
are ported onto the running build's loop:restart foundation, NOT re-derived:
- `startDrill(start, end, {label, focus, goal, speedLadder})` — runway-padded
  A-B loop via the host `slopsmith.setLoop`, dropped to the slowest ladder rung
  via the host `setSpeed` (keeps the speed slider / juce / preserve-pitch in
  sync; we never poke `audio.playbackRate`). Exposed on `window.noteDetect`.
- Each completed iteration feeds the pure goal-gate `_ndDrillRampDecision`
  (hold / advance / graduate). Clearing the goal steps the speed up one rung;
  clearing at full speed graduates: `clearLoop`, restore speed, emit
  `notedetect:drill-ended {graduated}`. `endDrill()` bails early.
- A floating HUD shows speed/goal/last-iter/best; `getConductorState()` exposes
  it to coaching and tests. Tested: 8 cases in `test/drill_conductor.test.js`
  (140/140 suite green).
- The chartTime-polling restart detector from `recover/reference-v1.2.0` was
  deliberately NOT ported — the running build gets real `loop:restart` events
  from the host, so the conductor hooks the existing iteration snapshot.

Still missing for the full loop: **step 1** (multi-play hotspot finder —
`_ndAggregatePlays`/`_ndSuggestLoops`, needs the SQLite plays history from the
`fix` branch's `routes.py`) and **step 2** (the "Practice now" banner that calls
`startDrill`). The conductor is reachable today via coaching's already-computed
`hotspot.drill = {loopA, loopB, speedMul, goal}` → `window.noteDetect.startDrill`.

## How we work (operating model)

**Human time is precious; LLM time is abundant.** The user's only scarce,
irreplaceable action is *playing/recording*. Everything else — iterating
detector params, sweeping av-offset, scoring, tuning, fixing — is done offline
against recorded takes via `tools/harness.js`. So:

- The user records a **batch of armed takes ONCE** (tuning-mode on → Arm → play
  at 1.0×). That's the only step that needs them in the loop.
- The LLM then iterates **indefinitely offline** on those WAVs — no replays.
- **Never send the user to play/click until the prerequisite is verified** (the
  feature exists in the *running* base, the save path works, the gate is on).
- Re-ground in the running `screen.js` whenever the base changes; don't quote a
  prior version's UI. (Running base = `adopt-upstream`; Arm + A/V auto-calibrate
  are gated behind `tuningMode`, toggled on the Settings page.)

## Where detection stands (measured) — SOLVED (2026-06-06)

Real bass play now scores ~90%, matching the user's own ear vs Rocksmith. Two
root causes, both found by **harnessing real takes offline** (never by asking
the user to keep replaying):

1. **Frame size starved low bass.** The ScriptProcessor callback was 1024
   samples (~21 ms) — shorter than a low-E period (~24 ms), so the detector
   silently dropped most bass notes. Harness on a real take: 1024→27%,
   **2048→77%**, 4096→68%. Fix: the `frameSize` setting, default **2048**
   (`v1.14.0`). This was the bulk of the old "low recall" — *not* signal
   quality, channel, or confidence gate (all ruled out).
2. **A/V offset was stale + hand-set.** Even with recall fixed, a wrong
   `av_offset_ms` (188 ms) judged every note ~188 ms late → 47%. Fix: the
   `autoCalibrate` setting (`v1.15.x`) — log offset-free detections, then on
   song-end **sweep for the offset that maximizes matched notes** (the harness
   objective) and apply it. On a real take it found **−186 ms, 303/306 matched
   (99%)** and the next play landed at the user's RS-equivalent score. The
   −186 (vs the harness's 0) correctly compensates the *live* detector's
   real-time processing lag, which the synchronous harness doesn't have.

   Bug that hid this for a day: calibrate unbound itself in `disable()`, which
   the host calls at song-end *before* the plugin's `song:ended` fires —
   diagnosed via a headless E2E driver + a server-log beacon, **not** by
   sending the user to replay-and-report.

When the detector reports a miss now, it's much more likely a *real* miss —
which is the reliability prerequisite the coaching loop (above) depends on.

## Retrospective — why the recording/harness loop kept failing

Every time-sink traced to an **undocumented pipeline internal** or an
**unverified assumption**, not the detector:

| What broke | Root cause | Fix |
|---|---|---|
| Recordings "never saved" (searched `static/`, empty) | `STATIC_DIR` unset → recordings fell to the `/config` Docker **volume**, invisible from the host | `STATIC_DIR=/app/static` in docker-compose (commit 68946a1); PR'd upstream |
| "Go play" → nothing captured | Sent the user to act without verifying tuning-mode/arm/save-fires first | Verify the whole pipeline before any human action; `tools/sweep-latest.sh` checks for a WAV first |
| Quoted "Calibrate from this play"/Arm that weren't there | Carried the *recovered fork's* UI after switching to Byron's base (those gate behind `tuningMode`, off) | Re-ground in the running `screen.js` after any base change |
| WAV save never fired | Save is song-end-only + the gear **Save** button; user stopped early | Flow: Arm → play → **Save** |
| "Recorded all morning", 0 WAVs, 64 live-judgments | **`tuningMode` was OFF** → the **Arm button isn't even rendered** (gated at screen.js:3803/3942), so nothing armed, `_recChunks` stayed empty, `saveRecordingNow()` bailed at the empty-check. Detect-on still streams judgments, which *looks* like recording. `tuningMode` is **localStorage-only** (`_ND_STORAGE_KEY`) — server can't see or set it | One-time: console `window.noteDetect.setTuningMode(true)` (persists via saveSettings). THEN Arm appears; a **partial** take saves fine via the gear **Save** button — no full song needed |
| Harness reported false 0% / low recall | Undocumented chart conventions: `tuning` must be **offsets** not absolute MIDI; bass needs `--string-count 4`; recovered dumps weren't aligned charts | Conventions baked into `tools/sweep-latest.sh`; prefer a sloppak's `arrangements/<id>.json` |

**Codified so it can't recur:** `tools/sweep-latest.sh` (one-command loop, all
six gotchas baked in), the `STATIC_DIR` fix, and this table. The lesson:
**human time is precious — verify the running code + the data path before asking
them to do anything.**

## Concrete plan

**SP-A (GATING — do first): fix & confirm the test harness + recording pipeline
work, end to end.** Nothing else is trustworthy until a take reliably becomes a
harness result without burning the user's time. Required:
- **Recordings land in a host-visible path.** Today they save to
  `/config/note_detect_recordings` (a Docker volume the host can't see), so
  harnessing a take needs a `docker cp`. Fix: write to (or also mirror into) the
  bind-mounted `static/note_detect_recordings/`, or add a one-command pull.
- **The WAV save must actually fire.** For the 2026-06-05 play it didn't (no
  `POST /recording`) — auto-save is song-end-only + a Save button; verify the
  trigger and that `_recChunks` capture when armed.
  **DONE (v1.13.0):** recording no longer hides behind tuning mode. The new
  `autoRecord` setting (default on) makes the default singleton auto-arm on
  every `song:loaded`, so each play with Detect on is captured and auto-saves
  on song:ended — no Arm click, no tuning mode. Stopping a song mid-play
  flushes the take on the next load. Opt out in Settings → "Auto-record every
  play". This was the real root cause of "recorded all morning, 0 WAVs":
  tuning mode was off → no Arm button → nothing ever armed.
- **A documented, repeatable harness invocation** (method, `--sample-rate 48000`,
  `--arrangement bass --string-count 4`, chart in wire format with tuning as
  *offsets*) plus one **known-good example** that reproduces a number, so the loop
  is provably reliable before we depend on it.
- Acceptance: arm → play → save → WAV at a known host path → `tools/harness.js`
  → result, with zero guesswork. THEN SP-B/C below are iterable offline.

**SP-B [human, once]** Tuning-mode on → Arm → record 3-4 short takes on the
   Scarlett, at 1.0×, on songs with charts. (Pipeline made reliable in SP-A.)
2. **[LLM, offline]** Harness those takes → Scarlett recall/precision baseline;
   **av-offset sweep** to separate calibration (#1) from detector (#3); compare
   to the Rocksmith golden. If recall still low at best offset, tune the
   detector gate/method offline against the takes.
3. **Auto-derive A/V latency** so the learner never sets it by hand — #13.
4. **Difficulty presets** incl. "harder than Rocksmith" (tighten clean windows) — #11.
5. **AI coaching narrative** from the play JSON via the user's API key — #14 (the north star).
6. Pull useful upstream `feat/*` (bass-detection, ml-note-detection, drill, sustain-glow) — #16.
7. Upstream clean fixes as we go (dockerignore #711, styles #57 landed) to avoid re-diverging.

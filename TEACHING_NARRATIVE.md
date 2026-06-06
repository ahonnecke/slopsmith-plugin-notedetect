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

### The learner branch: the deliberate-practice drill loop

When the decision is **player-fault**, the feedback the user gets is not a list
of mistakes — it's a **practice loop** that walks the classic slow-it-down,
speed-it-up method automatically:

1. **Find the hot spot** — the section with the most mistakes (from per-section
   miss stats), not scattered one-off errors.
2. **Auto-set an A–B loop** bracketing it: start a beat *before* the hot spot,
   end a beat *after*, so the run-in and run-out are included.
3. **Play the loop slowed down** — every note, at a reduced playback speed the
   user can actually hit cleanly.
4. **Ramp the speed** — once the user clears the loop at the current speed (a
   per-iteration accuracy threshold), bump the speed and continue.
5. **Graduate** — when they play the section cleanly at full speed, drop the
   loop, replay the **full song**, and find the next hot spot.
6. **Repeat** until no hot spot clears the threshold.

Building blocks that already exist (orchestration is the new part): A–B loops
(`feat/drill-mode`, the `/api/loops` endpoint), reduced playback speed (the
half-speed path), per-section accuracy for hot-spot detection, and
`getDrillStats()` for per-iteration scoring. What's missing is the conductor:
auto-pick the hot spot → auto-set the loop → auto-ramp speed on a clearance
criterion → graduate back to the full song. (Reliability prerequisite: the
detector must be trustworthy enough that a "mistake" is real — otherwise the
loop drills the player on the detector's blind spots. Hence the bass-recall
fix lands first.)

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

## Where detection stands (measured)

- **Rocksmith golden (harness):** detector **precise** (96% within 50¢, −6¢/+7 ms
  when it fires) but **low recall** (~16% pure no-detection); unaffected by
  gain/frame-size/method.
- **Scarlett live play (judgment log, 2026-06-05):** same story — **0/16 judged
  notes detected, `cnf=0` on every one.** So the clean DI did **not** fix it →
  it's **not** signal quality and **not** calibration; the HPS detector simply
  produces no pitch on real bass input. `getUserMedia` already disables
  echo-cancel/noise-suppress/AGC, so that's ruled out. Remaining suspects:
  **wrong channel** in the browser's stereo view (instrument may not be "right"
  to getUserMedia), or **input level / confidence gate**. Both are only
  diagnosable by **replaying a captured WAV offline** — which needs the recording
  pipeline working (see SP-A). Synth tracks pass; real mic input fails.

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

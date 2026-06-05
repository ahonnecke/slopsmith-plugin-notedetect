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

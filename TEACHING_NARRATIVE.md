# note_detect as a teaching tool — feature narrative

Goal: a tool that **effectively teaches the user guitar/bass**, not just scores a
play. Base = upstream/main (Byron's clean, core-compatible version). Authorship
doesn't matter; pedagogy does. This doc inventories every available feature
(main + unmerged `feat/*` branches) and arranges them into a learning loop, then
names the one missing piece: turning the data into a coaching **narrative**.

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

## Concrete plan
- [x] Adopt upstream/main as base (branch `adopt-upstream`, running).
- [ ] Pull the unmerged feat branches that matter: `feat/bass-detection`,
      `feat/ml-note-detection`, `feat/drill-mode`, `feat/live-sustain-note-glow`,
      `fix/bass-wrong-position-precision` (+ `feat/v3-player-control-slot` if on v3 core).
- [ ] Difficulty presets incl. "harder than Rocksmith" (tighten clean windows) — #11.
- [ ] Auto-derive A/V latency so the learner never sets it by hand — #13.
- [ ] **AI coaching narrative** from the play JSON via the user's API key — #14.
- [ ] Keep up with upstream (Byron's actively developing it) to avoid re-diverging.

# Sustain-bleed wall

Captured 2026-04-25 after the onset-flush work. Resume from this when we
return to the bleed problem.

## The bug

On bass passages where a held note rings into the next pluck (sustain-loud,
attack-soft), live YIN locks onto the *previous* note's pitch instead of
the new attack. Classifier surfaces these as `PIPELINE_YIN_DISAGREES`.

In the Level session forensic data, the canonical shape is:

- Previous chart note pitch 31 (G1) at chartT − ~410ms (often back-to-back
  same-pitch plucks, sometimes 1.0–1.4s).
- Current chart note pitch 28/29/30, soft pluck.
- Live YIN returns 31 (the sustain pitch).
- Offline YIN on the same audio window correctly returns expected pitch
  with `bestCents` within ±10¢ — the signal IS there.

## What we tried

| Step | Change | Bleed in DISAGREE | MISSED_REAL_PLAY | Total pipeline bugs |
| --- | --- | --- | --- | --- |
| Baseline | _ndRawMidiHistory clear on onset only | 9 / 18 (50%) | 8 | 26 |
| Buffer flush | also clear `_ndAccumBuffer` + `_ndPendingBuffer` | 8 / 16 (50%) | 10 | 26 |
| Tighter flush | also drop the trigger chunk (`return` from `_ndProcessAudioChunk`) | 3 / 14 (21%) | 12 | 26 |

Tighter flush eliminated 6 of 9 bleed cases. They didn't become hits — they
turned into MISSED_REAL_PLAY (no stable MIDI converged at all). Net change in
total pipeline bugs across all three configurations: zero.

Score on Level: 79.8% → 76.4% (different note count) → 79.2%. Effectively
unchanged. p95 scoring error stayed at 9ms; rawLatency p50 actually dropped
255ms → 218ms because YIN converges faster on clean post-onset buffers.

## Diagnosis of the wall

The soft-pluck-after-sustain notes have low signal-to-sustain ratio at the
acoustic level. Whatever pitch detector we point at the post-onset buffer
sees:

- Continuing sustain at the previous pitch, decaying slowly.
- Fresh attack at the new pitch, smaller amplitude, broadband.

Two failure modes given the current configuration:

1. **Sustain dominates** → YIN locks onto stale pitch → DISAGREE bug.
2. **Sustain + attack mixed below confidence threshold** → YIN no-decision →
   stability voter never settles → MISSED bug.

Onset-flush moves notes between these two buckets but doesn't recover any
of them as hits. The work was real (a wrong-pitch reading is a more
misleading failure than a missed note), but the score floor is the same.

## Why we paused

Three follow-ups are visible from here. None is obviously the right next
step until we have more data:

1. **Lower YIN confidence threshold post-onset** — recovers the missed
   cases as readings, but increases false positives on noise.
2. **Spectral subtraction** — track the previous note's fundamental,
   subtract it from the post-onset buffer before YIN. Heavier DSP,
   correctness risk, but addresses the signal directly.
3. **Loop-based recording** — let the player record a short passage many
   times and take the best read. Doesn't fix detection but gives us the
   high-quality runs we need to validate any of the above without burning
   a full session each time. (Investigating this next.)

## Per-session readouts (for comparison when we resume)

- Pre-fix: `test/fixtures/level_new-2026-04-24T22-08-54.classification.json`
- Post-buffer-flush: `test/fixtures/level_new-2026-04-25T17-42-18.classification.json`
- Post-tighter-flush: `test/fixtures/level_new-2026-04-25T19-39-32.classification.json`

The 26-bug ceiling is consistent across all three.

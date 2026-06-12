# Bass detection — recall improvement project

## Goal
A clean bass play should be *detected* as clean (~100% recall), so the raw
hit-rate score is meaningful. Rocksmith achieves this; we can too. Today a
clean bass take tops out ~70–85% recall — the detector drops ~30% of notes the
player plays correctly. Every scoring/attribution workaround failed because a
dropped note is indistinguishable from a player mistake (see memory obs 300–302).
The only real fix is to make the detector actually hear the notes.

## Method
Offline iteration on a labeled reference take, measuring recall against the
chart (ground truth for a near-clean take), using the production DSP primitives
(`constraintCheckString` / `_ndScoreChord` / `_ndFftMagnitude`) via
`test/_loader`. Diagnostics: `/tmp/bass_diag.js` (per-note band energy + pitch),
`/tmp/bass_win.js` (window-size sweep). Reference: `why_ref.wav` (Why'd You Only
Call, bass, 92% live; aligns in-harness).

## Baseline (2026-06-12)
- Current detector, 4096-sample (85 ms) analysis window: **85% recall**.
- KEY DIAGNOSIS: the dropped notes are NOT silent. Band energy on misses is
  HIGH (median 0.85 vs 0.015 hit threshold). The string is ringing — the player
  played the note. The failure is **pitch verification**: the dominant FFT peak
  in the string band is mis-located at low frequencies, so the ±60 ¢ pitch gate
  rejects a correctly-played note. At 55 Hz one FFT bin ≈ 90 ¢ — coarser than
  the 60 ¢ gate, so a one-bin peak error = a miss. A1 (55 Hz): 0/10 recall, all
  with high energy.

## Findings / iteration log
### #1 — longer analysis window (2026-06-12) — BIG WIN, +10pts
Frequency resolution is set by the *real* window length (Rayleigh ≈ 1/T), not
the zero-padded FFT size. Sweeping window length on `why_ref`:

| window | recall | A1(55Hz) | D2(73Hz) |
|---|---|---|---|
| 4096 / 85 ms (current) | 85% | 0/10 | 62/79 |
| 8192 / 171 ms | 88% | 3/10 | 64/79 |
| 16384 / 341 ms | **95%** | 7/10 | 78/79 |

A 341 ms window resolves the low fundamentals → pitch gate passes → recall 85→95%.

### #2 — precision check: the long window does NOT hallucinate (2026-06-12)
Risk: a 341 ms window could smear adjacent/ringing notes into false matches.
Tested on a deliberately BOMBED take (Creep, ~56% played; chart reconstructed
from its live log) — if the long window were smearing, the bombed take's recall
would balloon. It barely moved:

| window | clean (why_ref) | bombed (creep) | separation |
|---|---|---|---|
| 4096 | 85% | 61% | 24 pts |
| 8192 | 88% | 63% | 25 pts |
| 16384 | **95%** | 66% | **29 pts** |

The long window recovers real clean-play notes (+10) without inflating the
bombed take (+5), and WIDENS the clean-vs-bombed gap (24→29 pts). Precision is
fine and the score becomes more discriminating. Tool: `tools/bass-recall.js`.

## NEXT
1. Validate #1 on a second take (Gasoline — lower tessitura, denser).
2. Check the cost: does a 341 ms window cause TEMPORAL SMEARING on fast
   passages (false matches to neighbour notes, false positives)? Measure
   precision, not just recall, and test on a dense passage.
3. Find the recall/precision sweet spot (16384 vs an adaptive window).
4. Design integration: accumulate a longer buffer specifically for the bass
   pitch-verify path (the per-string `constraintCheckString`), without
   lengthening the onset/timing path. The frameSize setting (callback
   granularity) is separate and already tuned (2048).
5. Consider harmonic-sum pitch verification (sum f0+2f0+3f0…) as a
   complementary robustness win on weak fundamentals.

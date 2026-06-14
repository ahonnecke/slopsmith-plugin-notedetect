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

### #3 — naive rolling window is timing-limited; rescue is the right shape (2026-06-12)
Added `--win-size` / `--hop` to the harness (overlapping analysis window). A
rolling 16384 window hopped 2048 through the FULL pipeline (matchNotes +
checkMisses + timing) gives only **87%** (vs 85% baseline, best at av=-300) —
NOT the isolated 95%. A long rolling window detects each note late and at
variable time (it resolves somewhere between onset and onset+341 ms), so the
±100 ms timing matcher rejects many. Non-overlapping is even worse (37%).

Key insight: the isolated 95% used a window CENTERED on each note — and we KNOW
where each note should be (the chart). So the fix is NOT "make the detection
window longer" (that wrecks timing). It's a **long-window pitch RE-CHECK
centered on the expected note time**, run as a rescue when a note is about to
retire as a miss. Timing stays on the short-window path; the centered long
window only resolves pitch for about-to-miss notes — recovering the 95% with no
added detection latency.

### #4 — RESCUE BUILT + validated: 85→95% recall (2026-06-12) ✅
Implemented in screen.js: a rolling raw-audio buffer (`_rescueBuf`, 32k samples,
bass-only, fed in processFrame) + `_tryBassRescue()`, called in checkMisses
before a bass single-note retires. It maps the note's chart time to its audio
position (inverse of the match clock: hwTime = noteTime − avOffset + latency),
extracts a 16384 window CENTERED there, and re-runs `_ndConstraintCheckString`
at the 60c bass gate. A pass = an on-time hit.

Harness (full pipeline, why_ref, av=−186, the natural offset):
- baseline 85% (pure misses 45) → **with rescue 95%** (pure misses 15).
Precision (bombed Creep): 56–61% → 69% — rose ~the same as clean (+10 vs +8–13),
so it recovers REAL played notes, NOT hallucinating; clean-vs-bombed gap holds
(~26 pts). No added detection latency (re-checks buffered audio). Bass-only;
153 tests pass.

### #5 — rescue searches ±120 ms: robust to live drift (2026-06-12) ✅
First live play of the rescue scored 81% on a denser take, vs 95% in the
harness on the SAME audio/settings — the live audio path has processing latency
the harness lacks, so the buffer time-stamp drifts ~50-130 ms and the rescue
window lands on the neighbour in fast passages. Fix: the rescue now SCANS
±120 ms (40 ms steps) around the computed center and rescues if the expected
pitch resolves anywhere — absorbing the drift and the approximate per-take A/V
offset. Each window only checks the CHARTED pitch, so scanning can't admit a
wrong note. Harness: this take 95→99% and now offset-robust (99% at av -150
AND -240); why_ref 95→97%; bombed Creep 69→72% (rose less than clean, so still
recovering real notes). The build correctly surfaced the user's one real miss
(A-string fret 7, first instance miss / second hit) — which is the point:
removing the detector's ~30% false misses makes a REAL miss stand out instead
of drowning in noise.

### #6 — open-string BLEED is the primitive's core failure; harmonic-coherence fallback (2026-06-13) ✅
The rescue (#4) hides the problem at the *matcher* level, but the underlying
pitch-verify primitive (`_ndConstraintCheckString`, the browser/web-app path)
is itself only ~59% on a clean take — and the rescue, the chord scorer, and the
drill's "unhearable low E" all call it, so its weakness leaks everywhere.

REPRO (faithful harness, `tools/bass-recall.js`): clean Why'd-You-Only-Call take
(`live_20260613_123140` ↔ WAV `…183425`, stamped chart-start −0.0853), 16384
window — **59% primitive recall**, jagged per-pitch: A1(55) 0/9, G#1(52) 0/3,
E2(82) 2/11, C#2(69) 30/60, D2(73) 39/70, yet E1(41) 21/26 and B1(62) 38/47.

DIAGNOSIS (refines the baseline): not bin-resolution — it's BLEED. The pitch
check picks the single loudest bin across the WHOLE `[open..fret24]` string band
(2+ octaves) and asks "what note is this". On bass you fret without muting, so
an open string / neighbour rings LOUDER than the fretted note; the peak lands on
the wrong, lower frequency and the cents gate rejects a present note. That's why
A1-on-E-string (open-E bleed) is 0% while E1 (the open E itself) is 81%, and why
E1(41) beats A1(55) — the opposite of a bin-resolution story.

FIX (`_ndHarmonicCoherenceLow`, additive): when the cents check fails AND the
expected fundamental ≤ 140 Hz, confirm the EXPECTED note's own harmonic comb —
≥3 of harmonics 1–5 present as local-max peaks ≥40% of the band peak within
±80 ¢. Upper harmonics sit where bins are fine and are ratio-locked, so a bleed
/ neighbour collision rarely reproduces the whole comb. Purely additive — can
only flip a miss to a hit, so guitar / higher-bass behaviour is byte-identical.

RESULTS (`tools/probe-bleed.js` swept the frontier these thresholds sit on):
- Primitive recall (bass-recall, clean take): **59% → 73%** (G#1 0→100%, C#2
  30→44, D2 39→54, B1 38→41, E1 21→23). A1(55) still 0/9 — the open-A bleed peak
  is so dominant that 40%-of-band-peak excludes the real comb there; residual.
- End-to-end (full rescue+matcher, `replay-take.sh`, same take): **68% → 75%**
  best (191→210/281), +6–7 pts at every A/V offset.
- Precision held: cross-song control (this chart vs unrelated Creep bass audio,
  every hit a false positive) 5% → 10% — and that 10% is a harsh bound (only 8
  bass pitches share the 40–90 Hz range). 165/165 node tests green, incl. new
  bleed-rescue + bleed-precision + low-freq-gating tests.

Shipped 1.26.0. Tooling added: `tools/probe-bleed.js` (verifier frontier sweep),
`test/_loader` now exposes `fftMagnitude`.

### #7 — live confirmation + mute-fail classification; primitive at its frontier (2026-06-14)
LIVE on 1.26.0: a real WYOC play (`live_20260614_084452`, 306 notes) scored
**98%** (vs ~92% on comparable 1.25.0 takes), misses 23→6 — and the dead pitches
are clean live (A1 10/10, F#1 59/59, E2 14/14; the rescue+improved primitive
catch A1 in the full pipeline even though the centered primitive still drops it).

PER-NOTE forensics on that take's 6 misses (`tools/probe-bleed.js` alignment +
a centered harmonic-comb probe; WAV armed 2.22 s late, unstamped): 2 genuine
detector drops (D2 fret-5 — comb 3/5 present), 2 real flubs (C#2 fret-4 — comb
absent; at 92.9 s the OPEN A was ringing instead), 2 marginal. So the leftover
misses are mostly honest player misses, which is the goal.

NEGATIVE result on NEXT #1: tried ranking the harmonic floor off the local
spectral median (SNR×) and off a band-peak-excluding-the-open-string reference.
- SNR/noise-floor: WRECKS precision — cross-song FP 5%→36% (bass harmonics tower
  over the noise floor regardless of song, so any bass content passes). Dead end.
- exclude-open-string band peak: ~0 real gain (the +2 pts came from lowering the
  fraction to 0.35, not the exclusion). The masked notes' harmonics are GENUINELY
  weak, not merely under an inflated reference.
Conclusion: the band-peak-fraction floor is load-bearing for precision; the
primitive is at its recall/precision frontier (~72–74%). The remaining live D2
drops *pass* the primitive at a centered window — they're a RESCUE-window
alignment issue, not a threshold issue. Don't chase the primitive harder.

MUTE-FAIL (`_ndDetectMuteFail`, shipped 1.27.0): user confirmed "mute fail" is a
valid miss reason. On a conceded fretted-note miss, compare the harmonic comb at
the fretted pitch vs the open-string pitch (same `_rescueBuf` window the per-
string energy uses); flag `muteFail` when the open string's comb is clearly
present (≥3 harmonics) AND beats the fretted comb. Surfaced end-to-end: judgment
`muteFail` → diag `mf` → coaching `failureType:'mute_fail'` (`player_error`, NOT
detector_suspect) → `_ndDescribeMiss` how:'mute' + a COACH_SYSTEM rule. Validated
on the real take (fires on 64.5 s — open A rang where the chart wanted B1 fret-2).
NO audio ever leaves the device — pure local FFT/comb; only the verdict reaches
the LLM. Refactored `_ndHarmonicCombCount` out of `_ndHarmonicCoherenceLow`.

### #8 — rescue-window scan: center-outward + widened (2026-06-14, 1.29.0) ✅
The live D2-fret-5 drops (#7) PASS the centered primitive — a rescue-alignment
problem. `_tryBassRescue` scanned ±120 ms left-to-right and broke on the FIRST
hit, so on a REPEATED note (the same fret three bars running) it could lock onto
the PREVIOUS instance's audio, and live A/V drift on dense low passages was
landing just outside ±120 ms. Fix: scan CENTER-OUTWARD (0, +STEP, −STEP, …) so
the on-time position wins, and widen to ±160 ms. End-to-end on the clean WYOC
take (`replay-take.sh`): best recall **75% → 80%**, up at nearly every offset;
171/171 tests green. Only the EXPECTED pitch is matched, so the wider scan can't
admit a wrong note; center-outward bounds the same-pitch-neighbour risk.

### #9 — rescue CPU: silent-region early-out (2026-06-14, 1.30.0) ✅
The ±160 ms rescue scan is up to 9 × 16384-pt FFTs per conceded miss — the main-
thread load suspected in the input-dropout starvation (INPUT_DROPOUT.md). Measured
(instrumented `summary.rescue` in the diagnostic): clean WYOC take = 150 calls /
**534 FFTs** / 106 recovered. The true misses (~44) each burned the full 9-window
scan (~74% of the FFTs) finding nothing. Worse on a sparse/poor play — exactly
when dropouts were reported.

Fix: the center window is 340 ms wide and the search only ±160 ms, so a note
anywhere in range lights the CENTER window's string band. After the center FFT,
if its band energy is below a silent floor (0.008, under the 0.015 hit gate),
skip the remaining ≤8 FFTs — the note simply wasn't played here. A bleed-masked
real miss keeps HIGH band energy, so it's never skipped (gate is conservative).
Validated: clean take UNCHANGED (534 FFTs, 84% recall — nothing gated); a
silenced-half WAV (135 true gaps) dropped from ~1290 → **207 FFTs (~84% fewer)**
with recall on the played half unchanged. 171/171 tests green. `summary.rescue`
{calls,windows,hits,skipped_silent} now rides the diagnostic for live telemetry.

## NEXT
1. Live validation (needs the user): on 1.30.0, expect (a) the WYOC low notes to
   keep scoring high, (b) the drill's previously-"impossible" low-E frets to be
   hittable, (c) mute-fails labelled, (d) the dropout NOT to fire on a poor play
   (rescue FFTs now short-circuit on silence — watch `summary.rescue` telemetry).
2. The remaining live drops are rescue-window alignment, not threshold — the
   center-outward+widen (#8) helped; if drops persist, investigate the live A/V
   offset estimate feeding `noteHwTime` rather than widening further.
3. Port the harmonic-coherence fallback (#6) + mute-fail into the DESKTOP native
   verifier (`harmonicVerify` path) for parity with the browser/web-app path.
4. If still chasing the last points: notes that retire before `_rescueBuf` fills
   (very start of a song), and a possible wider bass pitchHitThreshold (the 20c
   hit gate vs the 60c verify gate loses notes that verify but don't hit).

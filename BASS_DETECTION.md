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

## NEXT
1. Validate live: user plays against the proj/bass-detection build (expect ~97%+).
2. Validate on a second clean take (Gasoline — lower tessitura, denser).
3. The last ~5 points: notes that retire before the rescue window is buffered
   (very start), and genuinely-coarse pitch reads. Consider widening the bass
   pitchHitThreshold (the 20c hit gate vs the 60c verify gate currently loses
   notes that verify but don't hit) and harmonic-sum verify.
4. Tune: rescue window length (16384 vs adaptive), buffer size, CPU on dense
   passages (one 16k FFT per retiring bass miss).
4. Design integration: accumulate a longer buffer specifically for the bass
   pitch-verify path (the per-string `constraintCheckString`), without
   lengthening the onset/timing path. The frameSize setting (callback
   granularity) is separate and already tuned (2048).
5. Consider harmonic-sum pitch verification (sum f0+2f0+3f0…) as a
   complementary robustness win on weak fundamentals.

# Calibration — design decisions

What we measure, why, and what we explicitly chose NOT to do. Read this
before changing the wizard or proposing "let's just …" alternatives. Most
of the alternatives have been tried; the why-not is captured below.

## Testing

Snapshots in `/tmp/nd_plays/` store **raw** `timingError`. Mic latency is
subtracted at validation time only. Validator is fully retroactive — no
re-playing needed to evaluate a new mic-latency value against existing
data.

Verdict thresholds: `insufficient` < 5 hits. Otherwise `biased` if median
is outside the resolution window, `at-floor` otherwise. Resolution =
max(2×SE, 5 ms) — scales with N. With 5-10 hits you can detect biases
> ~50-100 ms; with 30+ hits you can detect biases > ~10-20 ms. The CLI
prints the resolution explicitly so you know what you can and can't
detect.

### Calibrate from existing snapshots — no replay needed

```bash
docker cp slopsmith-web-1:/tmp/nd_plays /tmp/nd_plays
```
```bash
make calibrate-from-history
```

Aggregate verdict on the last line:
- `INSUFFICIENT — N hits, need 5` → no snapshots have any HITs yet
- `BIASED — ... Recommended mic latency: X ms` → use that value
- `AT-FLOOR` → no calibration needed; you're at the playing floor already

### Apply the recommended value

Open slopsmith devtools console (F12 in browser), paste this one line:

```js
_ndMicLatencyMs = 174; _ndSaveSettings(); window.slopsmith.emit('notedetect:calibrated', { micLatencyMs: 174 });
```

(replace `174` with the recommendation). No reload. Effective immediately.

### Verify against existing data

```bash
make calibrate-from-history MIC_LATENCY=174
```

Should print `AT-FLOOR` on the last line. If still `BIASED`, repeat with
the new recommendation.

### Validate ONE new loop in isolation (after applying a value)

Play one loop in the browser. The plugin saves a snapshot to
`/tmp/nd_plays/<song>__<arrangement>/<timestamp>.json` automatically on
loop restart, detect-off, or song change. Then:

```bash
docker cp slopsmith-web-1:/tmp/nd_plays /tmp/nd_plays
```
```bash
node test/calibrate-from-history.js --latest-only 1 --mic-latency 174
```

This filters to the single most recent snapshot file (one loop's worth
of HITs). Verdict + N visible on the last line.

- `INSUFFICIENT` only fires if you didn't hit 5 notes — play a longer
  segment.
- Otherwise you get a definitive `BIASED` or `AT-FLOOR` from one loop.
- Resolution column tells you the smallest bias detectable. With ~30
  hits per loop and σ ~ 100 ms, resolution is around ±35 ms.

### Read what's currently set

```bash
```
```js
JSON.parse(localStorage.getItem('slopsmith_notedetect')).micLatencyMs
```

### Reset everything

```js
_ndMicLatencyMs = 0; _ndUserReactionAuditoryMs = 0; _ndUserReactionVisualMs = 0; _ndCalibHistory = []; _ndSaveSettings(); location.reload();
```

### Code-change tests (no browser)

```bash
node --test test/wizard-filter.test.js
```
```bash
make test
```

### Code-change probe (browser, headless; needs slopsmith on :8088)

```bash
node test/probe-settings-wizard.js
```

Exits 0 on success.



## The two unknowns we calibrate

```
mic_latency       hardware/pipeline delay from speaker → onset detector.
                  USB ADC + OS audio stack + browser MediaStream + ScriptProcessor.
                  Subtracted from highway timing labels.

av_offset         visual-vs-audio rendering sync for slopsmith's renderer.
                  Used by the highway, NOT by note detection. Independent
                  of mic latency.
```

These are independent. Mic latency is the load-bearing one for scoring;
av_offset only affects how the highway visually aligns with audio playback.

## What we measure

The wizard runs four phases:

```
1a. Auditory reaction baseline    keyboard test, no instrument — personal auditory RT
1b. Visual reaction baseline      keyboard test, no instrument — personal visual RT
2.  Visual bass run               pluck on the green GO dot
3.  Audio bass run                pluck on the GO tone
```

For each bass run we collect dt = (detection_time − scheduled_GO_time)
across multiple cycles. The bimodal estimator clusters dt's into:

```
anticipation cluster   dt in (-150, +150) ms       pluck on/near beat
reaction cluster       dt in (RT-80, RT+150)        pluck reaction-time after beat
out-of-range           everything else              half-beat alias / off-beat / discarded
```

Mic latency = `anticipation_median` (when present) OR
`reaction_median - personal_RT` (when only reaction). When BOTH clusters
are populated and converge within 60 ms, confidence is high — the answer
is encoded twice.

## Decisions and why

### Mic latency is a separate knob from av_offset

**Decided in this session.** Earlier code added `residual = raw - avOffset + 20`
to subtract calibration drift through avOffset. That broke the abstraction:
chartTime already includes avOffsetSec, so subtracting it back is circular.
Symptom: setting avOffset = -103 (a calibrator suggestion) made audio sync
visibly off by ~200 ms.

**Don't:** route calibration through avOffset. It's slopsmith's visual-audio
sync knob, not a pipeline-compensation lever. Touching it breaks audio sync.

**Do:** keep `_ndMicLatencyMs` as an independent value, subtracted in the
display layer only.

### Bimodal estimator over single-cluster filter

**Decided when wizard runs kept producing bimodal data the σ filter
mishandled.** Humans are bad at anticipating clicks; they often react
instead. A pure-σ filter on a bimodal distribution produces a useless
mean. A hard cap at ±200 ms throws away half the data.

The bimodal model captures both stable strategies — anticipation cluster
gives the calibration directly; reaction cluster gives it after subtracting
reaction time. Convergence between the two is the strongest within-run
signal.

**Don't:** try to force the user to "play in time" with the wizard. They
can't reliably; cycle 1 is usually clean and cycles 2-6 drift toward
reaction mode.

**Do:** accept both modes as valid sources of the calibration value.

### Personal reaction-time measurement, not Welford default

**Decided after Welford's 200 ms default produced calibrations that
disagreed with the user's anticipation cluster by 30-50 ms.** Individual
auditory reaction time varies widely (160-300 ms); using a population
average means the calibration is wrong for any specific user by their
personal deviation from average.

**Don't:** ship hard-coded reaction-time constants and call calibration
"good enough". The error compounds straight into mic-latency miscalibration.

**Do:** measure auditory + visual personal reaction time via keyboard
pre-tests. Subtract YOUR number, not Welford's average.

### Apply gate by confidence

**Decided after a single-sample medium-confidence visual run produced a
-94 ms A/V offset that would have polluted slopsmith's renderer state.**
Mic latency and A/V offset apply independently; each writes only when its
source run is confidence='high' or 'medium' with N>=3 samples.

**Don't:** unconditionally write both values on Apply just because the
button was clicked. One side of the wizard can be solid while the other
is single-pluck noise.

**Do:** show "will apply" / "skipped — <why>" tags in the review panel
so the user sees what the click is actually going to do.

### Onset-detector + YIN-frame hybrid for wizard detections

**Decided after the time-gap "freshness" filter dropped re-attacks
during sustain.** If user plucks note 1, sustains, plucks note 2 over the
still-ringing string, there's no silence gap; the time-gap filter saw
the second pluck as continuation of the first. Symptom: many "no
detection" beats in wizard runs even though the user clearly played.

**Don't:** rely on raw YIN-frame detections with a time-gap dedupe. YIN
fires every ~25 ms during sustain; you can't tell a re-attack from sustain
by time alone.

**Do:** hook the onset detector (which has release/rearm logic to identify
re-attacks) for primary timing. Keep YIN-frame fallback for soft plucks
below the onset RMS threshold, gated by 120 ms silence-to-pitch transition.

### Single-run lock detection is consistency, not correctness

**Decided after one wizard run locked at 0 ms and the next at +67 ms,
both "high confidence convergent".** Three convergent runs within ±10 ms
proves the wizard reproduces itself. It does NOT prove the value is right.
A systematic bias (setTimeout jitter, code-path divergence) gets locked in
with high false confidence.

The cross-mode convergence (visual median ≈ audio median) is a stronger
signal than three same-mode runs agreeing. The wizard's noise floor is
~50 ms across runs, not the ±10 ms the lock UI suggests.

**Don't:** treat single-run convergence as the final answer. Don't treat
3-run lock-state as "calibration is correct". It's "calibration is stable
relative to the wizard's own measurement noise."

**Do:** validate against play-history (real-world chart matching, the same
code path the user experiences). If median chart-time-error across many
notes is centered on 0, calibration is correct in the context of use.

### Play-history validation is the truth source

**Decided in this session.** The wizard is artificial: scheduled clicks,
isolated cycles, anticipation pressure. The actual scoring pipeline runs
through chart matching, onset detection, and label generation. Bias
introduced anywhere in that chain doesn't show up in the wizard.

`/tmp/nd_plays/<songId>/*.json` already contains `timingError` per note
for every loop iteration. Aggregating across many hits gives:

```
median(timingError - micLatencyMs)   calibration bias (should be ~0 if correct)
stddev(timingError)                  playing variance (the floor)
SE = stddev / sqrt(N)                shrinks with more samples
```

If `|median| > SE`, calibration is biased — nudge by `-median`, retest.
If `|median| < SE`, you've hit the playing-variance floor; further
calibration won't tighten the answer.

**Don't:** ask the user to play more wizard runs once snapshots exist.
Their existing data has more samples and exercises the real pipeline.

**Do:** drive calibration verification from snapshots. The wizard is
bootstrap; the snapshots are truth.

## What we explicitly chose NOT to do

### Don't calibrate during normal song play

Tried multiple times across sessions. The user adapts: they get visual
feedback (hit/miss), start anticipating to compensate, contaminating the
data. Song-play data is never a clean calibration source while the user
is *trying* to play — only after they've stopped consciously timing.

The play-history approach side-steps this by aggregating across many
loop iterations of consistent material — adaptation noise averages out
over time, the systematic bias doesn't.

### Don't try to "play a known note" for pitch validation

Pitch verification doesn't help calibration. The issue was always timing,
not pitch attribution. Floated this once; the user correctly pushed back.

### Don't measure reaction time during the bass run

Considered: instead of two phases, just have the user pluck and infer
reaction from the data. Doesn't work because anticipation vs reaction is
unobservable from a single dt; the cluster boundaries are population
statistics. Direct keyboard measurement disambiguates.

### Don't apply low-confidence calibration values

Saw this break things directly: -94 ms A/V offset from a single visual
pluck made the highway visibly desync. Apply gate is non-negotiable.

### Don't put the user in the iteration loop for testing

User constraint: low upper bound on manual testing. Every fix needs an
offline validation path (puppeteer probe, synthetic data, snapshot
replay). "Try it again and tell me if it's better" doesn't scale.

### Don't trust Welford-survey reaction-time constants

50-100 ms personal-vs-population gap is real and propagates into mic
latency. Always measure.

### Don't treat the wizard's lock state as truth

It only proves consistency. Truth comes from play-history validation.

## Order of trust (most → least)

```
1. Play-history median across many real notes (truth)
2. Cross-mode convergence within a wizard run
   (visual_median ≈ audio_median both runs)
3. Cross-cluster convergence within a single run
   (anticipation_cluster ≈ reaction_adjusted)
4. Single cluster, multiple plucks
5. Single pluck (noise)
```

When sources disagree, higher-numbered ones win. The wizard exists to
produce a starting value when no play history exists; play history takes
over once it does.

## Constants

```
_ND_METRO_BPM                 75       wizard tempo
_ND_METRO_PREP_BEATS          3        ticks per cycle before GO
_ND_METRO_CYCLES              6        GO beats per run
_ND_METRO_BEAT_WINDOW_MS      400      max |dt| for beat assignment
_ND_WIZ_KEYBOARD_CLICKS       6        stimuli in keyboard pre-test
_ND_WIZ_KEYBOARD_INTERVAL_MS  1500     space between keyboard stimuli
_ND_WIZ_KEYBOARD_INPUT_LAG_MS 5        subtracted from keyboard medians
_ND_FRESH_GAP_MS              120      YIN-frame fallback silence gap
_ND_CALIB_LOCK_RUNS           3        wizard runs needed to "lock"
_ND_CALIB_LOCK_TOL_MS         10       spread within ±this to lock
_ND_CALIB_DRIFT_TOL_MS        10       latest run vs locked → drift

bimodal anticipation window    -150 to +150 ms   |dt| < 150 → pluck on beat
bimodal reaction window (audio)  RT-80 to RT+150 ms  centered on personal RT
bimodal reaction window (visual) 200 to 400 ms       (default; uses personal visual RT when set)
bimodal convergence threshold     60 ms             |anticipation_med - reaction_adj| < this → convergent
```

## Play-history validation harness

`make calibrate-from-history` reads every snapshot under `/tmp/nd_plays/`
(falls back to `test/fixtures/nd_plays/`), aggregates `timingError` across
all HIT records, and computes:

```
rawMedian          median(timingError) — pre-calibration
postCalibMedian    rawMedian - mic_latency — what scoring actually shows
stddev             playing variance proxy
SE = stddev/√N     bound on how confident the median is
suggestedNudge     +postCalibMedian when biased
verdict            insufficient | biased | at-floor
```

Verdict thresholds:
- `insufficient` — fewer than 30 hits aggregated
- `biased` — `|postCalibMedian| > max(2×SE, 5 ms)`
- `at-floor` — within those bounds; further calibration can't tighten

### Empirical finding (this session, 2026-04-29)

Running against 1176 hits across 6 songs with `mic_latency = 0`:

```
ALL    1176    rawMedian +173.6 ms    SE +3.9 ms    verdict: biased
Recommended mic latency: 174 ms
```

Re-running with `mic_latency = 174`:

```
ALL    1176    postCalibMedian -0.4 ms    SE +3.9 ms    verdict: at-floor
```

The wizard had been producing values 0-67 ms across runs — undershooting
the truth by 100-170 ms. Wizard noise floor across runs (~50-70 ms) is much
higher than the play-history SE (~4 ms with 1000+ hits). This is the
direct evidence that play-history validation > wizard for getting the
calibration *value*. Wizard is bootstrap; snapshots are truth.

## Open questions

- The visual GO dot does more DOM work than prep dots and paints ~16 ms
  later than scheduled. Visual run dt's are biased low by that amount.
  Fix: record actual frame-paint time via rAF, like the visual keyboard
  baseline already does. Not yet shipped.
- A/V offset apply gate requires both runs high-confidence. The visual
  bass run rarely hits high confidence — too few clean plucks per cycle.
  Either accept that A/V offset rarely auto-applies, or relax the gate
  for visual when audio is locked (since cross-validation can pin it).

# Calibration — design decisions

What we measure, why, and what we explicitly chose NOT to do. Read this
before changing calibration or proposing "let's just …" alternatives.
Most of the alternatives have been tried; the why-not is captured below.

## What we calibrate

```
mic_latency       hardware/pipeline delay from speaker → onset detector.
                  USB ADC + OS audio stack + browser MediaStream + ScriptProcessor.
                  Subtracted from highway timing labels.
                  Owned by the plugin; auto-applied via play-history.

av_offset         visual-vs-audio rendering sync for slopsmith's renderer.
                  Used by the highway, NOT by note detection. Independent
                  of mic latency.
                  Owned by the user; set manually via slopsmith's [/] keys.
                  The plugin used to derive this from wizard runs and
                  auto-apply it; that produced ~100 ms of compounded noise
                  on every wizard session and clobbered manual settings.
                  Removed.
```

## How calibration works (current)

The metronome wizard (visual + audio bass runs, keyboard reaction-time
pre-tests, lock-state UI, A/V offset auto-apply) was retired. Per-run
noise was ~50-70 ms while play-history aggregation gives ±4 ms SE at
N=1000 hits.

**Calibration is now driven by snapshots:**

1. Play the song normally. Each loop iteration writes a JSON snapshot
   to `/tmp/nd_plays/<songId>/<timestamp>.json` containing per-note
   `timingError` (raw — mic_latency NOT subtracted at save time).
2. `_ndCalibFromHistory(plays, currentMicLatencyMs)` aggregates HITs,
   subtracts current mic latency, reports verdict:
   - `insufficient` < 5 hits — median is meaningless
   - `biased` — post-cal median exceeds detection resolution
   - `at-floor` — within resolution; calibration is correct
3. Resolution scales with N: `max(2×SE, 5 ms)`. Small N → wide tolerance
   but still produces a verdict.
4. Settings → Calibrate latency reads play history for the current
   song, shows verdict + recommendation, applies on click.

## Testing

```bash
# Pull fresh snapshots from the running container
docker cp slopsmith-web-1:/tmp/nd_plays /tmp/nd_plays
```

```bash
# Aggregate verdict across all songs
make calibrate-from-history MIC_LATENCY=$CURRENT
```

```bash
# Validate one short loop in isolation (after applying a value)
node test/calibrate-from-history.js --latest-only 1 --mic-latency $CURRENT
```

Verdict on the last line:
- `INSUFFICIENT — N hits, need 5` → play a longer segment
- `BIASED — Recommended mic latency: X ms` → open Settings → Calibrate
  latency in the UI to apply
- `AT-FLOOR` → no change needed; remaining variance is your playing

### Apply the recommendation (in-app)

Open slopsmith → Settings → Note Detection → Calibrate latency. Reads
the current song's play history, displays verdict + recommendation,
single-click apply. No devtools, no copy-paste.

### Read what's currently set (devtools console)

```js
JSON.parse(localStorage.getItem('slopsmith_notedetect')).micLatencyMs
```

### Reset to defaults (devtools console)

```js
_ndMicLatencyMs = 0; _ndSaveSettings(); location.reload();
```

### Code-change tests (no browser)

```bash
node --test test/calib-from-history.test.js
node --test test/per-note-coaching.test.js
node --test test/trouble-aggregation.test.js
make test
```

## Decisions and why

### Don't iterate calibration on every loop

Tried. Auto-applying after each loop produced runaway adaptation: user
sees the new value's effect on highway labels, unconsciously shifts
playing to chase the green, validator detects "drift", auto-applies
again, repeat. Calibration is a one-time-per-rig setting.

The settings → calibrate button is a manual recheck, not an automatic
loop. User decides when to recheck.

### Don't trust single-run wizard convergence

The metronome wizard could produce "high-confidence convergent" runs
that disagreed by 50-70 ms across a session. Lock-state UI
(3 convergent runs within ±10 ms = "locked") sold false precision.

Play-history validation gives an order-of-magnitude tighter answer at
the same effort.

### Don't auto-apply A/V offset

Wizard used to write `visual_run_dt - audio_run_dt` to slopsmith's
av_offset. Each wizard run produced a ~100-ms-noisy diff that overwrote
the user's manual setting, putting visuals visibly out of sync.

A/V offset is a perceptual-sync knob the user owns. Wizard MEASURED
it (informational); never applied it. Wizard removed entirely; user
sets av_offset via slopsmith's [/] keys.

### Don't tell the user "play more loops" when N >= 5

Validator originally required 30 hits for a verdict. Lowered to 5 with
resolution-aware verdicts — at small N the tolerance is wide but the
answer is still definitive. The CLI/modal prints resolution so user
knows what bias they could/couldn't detect.

### The user adapts to applied calibration values

Real failure mode observed: applying mic_latency=120 caused the user's
raw timing to shift -150 ms next loop. The user wasn't told to ignore
the highway timing labels. Once told, raw median was stable across
7 uncontaminated loops at +131 ms.

The validator can't tell adaptive playing from rig drift. Document
the contamination mode in instructions.

### Don't conflate slopsmith bugs with calibration bugs

Per-song chart-vs-audio sync issues exist (some songs show 70 ms/sec
drift WITHIN a single loop iteration). That's not the plugin's
calibration system — it's a chart-data or playback-rate problem
specific to those songs. Calibration recommendations clamp at 0 mic
latency when that drift would push them negative.

### Don't put the user in the iteration loop for testing

User constraint: low upper bound on manual testing. Every fix needs an
offline validation path (snapshot replay, synthetic data, no live
"is it better?"). The play-history approach respects this.

### Don't measure reaction time

The metronome wizard used keyboard reaction-time pre-tests to feed
its bimodal estimator. Estimator gone, RT measurement gone. Reaction
time is irrelevant to play-history validation — the user plays the
song, snapshots record their actual timing, median is what it is.

## Sign convention

```
timingError = (detection_chartTime - chart_note.t) * 1000   ms
positive = detection arrived AFTER chart note (player late)
negative = detection arrived BEFORE chart note (player early)

shown_on_highway = timingError - mic_latency
```

If shown median is positive (player still appears late after applying
calibration), increase mic_latency by that amount. Validator returns
`suggestedNudge = +postCalibMedian`.

## Constants

```
_ndCalibFromHistory:
  MIN_HITS              5      need this many before issuing a verdict
  FLOOR_MS              5      min resolution; below this is perceptual noise
  resolutionMs          max(2×SE, FLOOR_MS)
```

## What was removed

Removed in the wizard retirement:
- `_ndOpenWizard`, `_ndCloseWizard`, `_ndOpenWizardFromSettings`
- `_ndWizStartRun`, `_ndWizFireBeat`, `_ndWizComputeRun`, `_ndWizFinishRun`
- `_ndWizApplyMetro`, `_ndWizRender`
- `_ndWizStartKeyboardRun`, `_ndWizFinishKeyboardRun`,
  `_ndWizComputeKeyboardReaction`, `_ndWizUpdateKeyboardCounter`
- `_ndWizOnOnset`, `_ndWizOnDetection`, `_ndWizCancelTimers`
- `_ndWizStartBall`, `_ndWizStopBall`, `_ndWizRunIsApplyable`
- `_ndCalibAppendRun`, `_ndCalibComputeStability`
- All `_ndWiz*` state, `_ND_METRO_*` and `_ND_WIZ_*` constants
- `_ndUserReactionAuditoryMs`, `_ndUserReactionVisualMs`,
  `_ndCalibHistory` (and their localStorage persistence)
- `test/wizard-filter.test.js`, `test/probe-settings-wizard.js`
- The wizard's POST to `/api/settings { av_offset_ms: N }`

What remains: `_ndCalibFromHistory` (the validator) and the
play-history-driven Settings → Calibrate latency entry point.

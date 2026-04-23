# WAV Replay Alignment — Issue Analysis

## Context

- **Live bass play**: ~85% hit rate
- **Synthetic sine replay**: 100% hit rate (30/30, 125/125)
- **Real-bass WAV replay**: 5/127 (3.9%) as of `e1f5cb2`

Same pipeline, same player, same song — the gap between live (85%) and WAV
replay (3.9%) is too large to be explained by "real audio is hard." The
pipeline clearly *can* detect this player's notes when they happen live. The
WAV replay path is shifting detection timestamps out of the chart's hit
window.

## What's been fixed so far

### Double-counted detection latency (was dominant term)

**Fixed in `5916f48`.** The highway.getTime() mock was adding
`_ndDetectionLatencySec` on top of natural elapsed time. Since `scoreT =
highway.getTime() - _ndDetectionLatencySec`, they cancelled out, leaving
`scoreT = baseChartTime + elapsed`. But `elapsed` at detection time includes
the full pipeline latency (~400ms), putting scoreT 400ms past the chart note.
With the asymmetric window (150ms early, 300ms late), this was outside bounds.

Fix: mock returns `baseChartTime + elapsed` (no offset). Now `scoreT =
baseChartTime + elapsed - _ndDetectionLatencySec`, which correctly
compensates the pipeline delay. Synthetic tests went from 0/0 to 30/30.

### Playback start anchor (was off by fetch+decode time)

**Fixed in `1273b3e`.** `testStartPerf` was set before `_ndInjectTestWav()`
fetched and decoded the WAV (~3s overhead). The mock clock was already running
during download. Fix: set `window._ndTestWavPlaybackStart = performance.now()`
inside `_ndInjectTestWav` right at `source.start()`.

### Chart start time not recorded

**Fixed in `ffffc63`.** `_ndRecordStart()` now captures `highway.getTime()` as
`_ndRecordChartStartTime` and includes it in the server upload. Test runner
reads it from sidecar JSON or accepts `--wav-offset`.

## Remaining error sources

Each item below is independent; they sum.

### 1. Record-side anchor drift

`_ndRecordChartStartTime` is captured when `_ndRecordStart()` is called. The
first audio sample is grabbed by the next ScriptProcessor callback, up to one
SP buffer period later (~42ms at 2048 samples / 48 kHz).

**Magnitude**: 0–42 ms
**Fix**: Capture chart time inside the SP callback on the first recorded chunk.

### 2. Replay-side anchor drift

`_ndTestWavPlaybackStart` is set at `source.start()`, but audio doesn't reach
the ScriptProcessor until the AudioContext renders ≥1 quantum (128 samples,
~2.7 ms) plus internal output latency (`baseLatency`, 10–50 ms on Linux).

**Magnitude**: 10–50 ms
**Fix**: Use `audioCtx.currentTime` at `source.start()` as the anchor, and
base the mock on `audioCtx.currentTime` instead of `performance.now()`.

### 3. Clock mismatch

The mock uses `performance.now()` but the WAV renders on the AudioContext
hardware clock. These drift independently. Over 60s, drift can reach tens of
ms.

**Magnitude**: 10–30 ms over 60s
**Fix**: Switch mock to `audioCtx.currentTime`.

### 4. Miss checker one-pass limitation

**Partially fixed in `2e99ab0`.** The miss checker scans 1s behind the
deadline per call (designed for per-frame use). The WAV test sweeps through
the full chart with stepped mock time. This is approximate — the stepping
granularity (0.5s) means some notes near step boundaries could be missed.

**Magnitude**: 0–2 notes per sweep
**Fix**: Finer sweep granularity or refactor miss checker to accept a time
range.

### 5. Asymmetric window + variable pipeline latency

The matching window is 150ms early / 300ms late. The pipeline latency in
replay (~400ms buffer + stability + timer jitter) varies by ±50ms between
notes. Notes at the edge of the window may fall outside on some runs.

**Magnitude**: 1–5% of notes near window boundary
**Fix**: The live system handles this because `_ndDetectionLatencySec` is
tuned for the live pipeline. The replay pipeline has different latency
characteristics. A replay-specific latency offset could help but adds
complexity.

## Hypothesis: why 3.9% not ~85%

Even after the fixes above, the combined remaining error budget is:

- Record anchor drift: ~42ms
- Replay anchor drift: ~30ms
- Clock drift: ~20ms over 60s
- Total: ~92ms systematic offset

With the asymmetric window (150ms early, 300ms late), a 92ms offset eats most
of the early window. Notes that in live play land at -50ms to +100ms would in
replay land at +42ms to +192ms — some falling outside the 300ms late bound.

But this only explains ~10-20% miss rate, not 96%. The remaining gap is likely:

1. **The recording captures 60s starting at chart time 3.5s**, but chart notes
   don't start until 29.87s. The first ~26s of the WAV is pre-chart silence.
   Of 127 chart notes, only ~30-40 fall within the 60s WAV window.
2. **Real bass audio characteristics**: harmonics confusing YIN, sustain bleed
   between notes, string resonance — factors the synthetic test doesn't model.
3. **The onset detection improvement (`e1f5cb2`) only marginally helped WAV
   replay** (4→5 hits) because the alignment error dwarfs the detection fix.

## Next steps (prioritized)

1. **Fix #2 and #3 together**: Switch the replay mock to use
   `audioCtx.currentTime` instead of `performance.now()`. This eliminates both
   the replay anchor drift and the clock mismatch. Single change, testable.

2. **Fix #1**: Capture chart time inside the SP callback on first chunk, not in
   `_ndRecordStart()`. Re-record the WAV fixture with the fix.

3. **Re-record with aligned start**: Start recording closer to the first chart
   note (e.g., start the song, let it reach the bass section, then record).
   This maximizes chart coverage in the 60s window.

4. **Measure per-note residuals**: After alignment fixes, compare each detected
   note's timing to its chart time. If median residual is <50ms, alignment is
   good enough and remaining misses are detection quality issues.

## Baseline to beat

- `e1f5cb2` — 5/127 (3.9%) on real bass WAV with onset detection
- `2e99ab0` — 4/127 (3.1%) previous baseline without onset detection
- 2 of the original 4 "hits" were false (octave-harmonic tolerance)
- Fixture: gitignored 5.5 MB WAV at `test/fixtures/` (recreate via
  `_ndRecordStart(60)` in browser console while playing Mexico bass)
- Chart start time for current fixture: 3.497s (from console log)

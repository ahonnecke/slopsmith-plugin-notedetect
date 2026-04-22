# Debug Chronicle: Note Detection Plugin

What has been tried, what failed, what's been eliminated.

---

## The Goal

When looping over a lick, the highway should show which notes were missed and
why (too early / too late / too sharp / too flat / not played). The user should
be able to tighten the loop around the notes they keep missing.

## Current State: Architecture Cannot Support Real-Time Chart Matching

As of 2026-04-22, the plugin's detection pipeline has **170-600ms of latency**
from pluck to first correct pitch detection. The timing tolerance is 110ms.
The detection literally cannot deliver the correct pitch before the chart note's
matching window closes.

This is not a parameter tuning problem. It's a structural limitation of:
- ScriptProcessor + buffer accumulation + setInterval polling
- JavaScript YIN on the main thread
- No onset detection (can't distinguish new pluck from sustained note)
- Continuous matching (sustained pitch poisons subsequent chart notes)

See `HOW_DETECTION_WORKS.md` for the full analysis with measured latencies.

---

## What Has Been Tried and What Failed

### 1. Draw Hook: String Comparison Bug (FIXED)

**Problem**: Draw hook compared `result === 'hit'` but results store `{ primary: 'HIT' }`.
**Fix**: Rewritten to use `judgment.primary`.
**Status**: Fixed. Now-line rendering confirmed visible.

### 2. Draw Hook: Lookback/Fade Too Short (FIXED)

**Problem**: 0.5s lookback with 0.6s fade = notes visible for 0.1s max.
**Fix**: Lookback 15s, fade 15s (misses), 4s (hits).
**Status**: Fixed.

### 3. Noise Floor Detection (FIXED + CONFIRMED)

**Problem**: YIN detected MIDI 34.5 at 0.90+ confidence on electrical hum.
**Fix**: Silence gate (`_ndSilenceGate = 0.02`).
**Status**: Confirmed working. Zero detections when silent.

### 4. Force-Inject Tests (FIXED after 4 attempts)

Built diagnostic panel with inject, pause, dump-to-console.
**Status**: Working. Panel is the primary diagnostic tool.

### 5. highway.project() Past Offsets (CONFIRMED BROKEN)

`project(negative_offset)` returns null/off-screen for past notes.
**Workaround**: Now-line judgment rendering at `project(0)`.
**Status**: Now-line markers work. Past-note highway markers don't.

### 6. Stability Voting Latency (FIXED — was 400-700ms)

**Problem**: 3-of-5 voting at 20fps = 250ms minimum. Actual measured: 400-700ms.
Detection arrived one full note behind the chart.
**Fix**: Removed stability voting from chart matching path. Use raw `_ndDetectedMidi`.
**Result**: Hit rate improved from 15% to 46%.

### 7. Onset Buffer Flushing (TRIED — MADE THINGS WORSE)

**Problem**: 4096-sample buffer contains previous note's sustain at transitions.
**Attempted fix**: Detect energy spike in audio callback, flush accumulation buffer.
**Result**: Onset detection fired correctly (27 flushes in test run), but
re-accumulation from scratch takes ~170ms vs ~85ms for natural buffer sliding.
Frame log showed old pitch STILL detected after flush because the onset chunk
itself was accumulated into the clean buffer.
**Status**: Removed. Natural buffer sliding is faster than flush + re-accumulate.

### 8. Transient Filter (ADDED — ACTIVELY HARMFUL)

**Problem**: Attack transient jitter after removing stability voting.
**Attempted fix**: Reject detections where MIDI jumps > 3 semitones in 150ms.
**Actual effect**: Blocks legitimate note transitions (E→A = 5 semitones = rejected).
**Status**: Still in code. Should be removed or threshold raised significantly.

### 9. Pipeline Latency Measurement (DONE — ROOT CAUSE IDENTIFIED)

Added frame-level diagnostic logging. Measured actual latency from chart note
time to first correct pitch detection:

- Favorable transitions (G1→F1, 2 semitones): **169ms**
- Typical transitions (B1→A1, 2 semitones): **568ms**
- Large intervals: **1000ms+**
- Sustained same note: **0ms** (already in buffer)

**Root cause**: The 170ms minimum detection latency (85ms accumulation + 50ms timer
+ attack transient settling) exceeds the 110ms timing tolerance. For most note
transitions, the previous note's sustain dominates the buffer for 2-4 cycles,
pushing latency to 400-600ms.

This is an **architectural limitation**, not a parameter tuning problem.

---

## Elimination Summary

| Hypothesis | Status | Evidence |
|---|---|---|
| Draw hook rendering broken | Fixed | Now-line markers visible |
| Noise floor as pitch | Fixed + confirmed | Silence gate works |
| Stability voting too slow | Fixed | Removed, 15%→46% hit rate |
| Onset flush helps | **Disproven** | Made latency worse (170ms→340ms) |
| Transient filter helps | **Harmful** | Blocks real note transitions |
| Buffer contamination | **Confirmed** | Frame log: old pitch persists 170-600ms |
| Pipeline latency < tolerance | **Disproven** | Measured 170-600ms vs 110ms tolerance |
| Parameters can compensate | **Disproven** | 600ms latency can't be offset-compensated |

---

## Conclusion

The current architecture (ScriptProcessor → accumulate → poll → JS YIN → continuous
matching) cannot support real-time chart matching. The detection pipeline's minimum
latency exceeds the maximum useful timing tolerance.

**Decision**: Build a flashcard plugin that proves pitch detection works in isolation
(no timing, no chart sync, no sustained-note contamination) before attempting
real-time chart matching. This mirrors TonalRecall's development path, which worked.

See: `FLASHCARD_PLUGIN_PLAN.md`

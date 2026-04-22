# How Note Detection Actually Works

Describes the actual behavior of `screen.js` as of 2026-04-22.
Based on reading the code, not aspirations.

---

## The Pipeline

### 1. Audio Capture

```
getUserMedia() → MediaStream → GainNode → ScriptProcessor(2048 samples)
                                        → AnalyserNode (VU meter, separate)
```

- Sample rate: browser's AudioContext default, typically 48000 Hz.
- ScriptProcessor fires `onaudioprocess` with 2048-sample chunks (~42ms each at 48kHz).
- Chunks are **concatenated** into `_ndAccumBuffer` until length >= 4096.
- When 4096 is reached, the **last 4096 samples** are sliced off as `_ndPendingBuffer`,
  and `_ndAccumBuffer` is reset to empty.

**What this means**: `_ndPendingBuffer` is NOT a sliding window. It's a snapshot of
the most recent 4096 contiguous samples, produced every 2 chunks (~85ms). Between
snapshots, `_ndPendingBuffer` is null and detection has nothing to work on.

### 2. Detection Scheduling

A `setInterval` at 50ms (~20 fps) checks if `_ndPendingBuffer` is non-null.
If so, it calls `_ndProcessFrame(buffer)` and sets `_ndPendingBuffer = null`.

**What this means**: Detection runs at most once per ~85ms buffer cycle, throttled
additionally by the 50ms poll. Worst case: buffer fills at t=0, timer fires at
t=49ms (just missed it), next timer at t=99ms picks up the buffer. Minimum latency
from pluck to YIN run: ~85ms (accumulation) + 0-50ms (timer alignment) = 85-135ms.

### 3. Pitch Detection (YIN)

`_ndYinDetect(buffer, sampleRate)`:

1. Difference function: O(halfLen^2) nested loop. halfLen = 2048.
   This is ~4 million multiply-accumulate operations per frame, on the main thread.
2. Cumulative mean normalization.
3. Walk lags from tau=2, find first dip below threshold **0.15**.
4. Parabolic interpolation for sub-sample accuracy.
5. `freq = sampleRate / betterTau`, `confidence = 1 - yinBuffer[tau]`.

Rejection: `freq <= 0` or `confidence < 0.3` → discard frame.

**What this means**: The confidence threshold is 0.3. This is very low — aubio uses 0.7
in TonalRecall. Attack transients and buffer-boundary artifacts easily clear 0.3,
producing confident-but-wrong detections.

### 4. Silence Gate

```
if (_ndInputLevel < 0.02) → discard
```

`_ndInputLevel` is computed on a **separate path** — the AnalyserNode, sampled via
`requestAnimationFrame` (not the audio thread). It's `rms * 5` from a 512-sample FFT
window with smoothingTimeConstant=0.8.

**What this means**: The level used for gating is (a) from a different audio path
than the detection buffer, (b) heavily smoothed (0.8 time constant), and (c) sampled
at display frame rate (~60fps), not audio rate. After a pluck, the AnalyserNode's
level lags behind reality. After a mute, it decays slowly. The gate can reject a
real pluck (level hasn't risen yet) or pass dead silence (level hasn't fallen yet).

### 5. Stability Voting

Still runs (computes `_ndStableMidi`) but is **no longer used for chart matching**.
Chart matching now uses raw `_ndDetectedMidi` directly. Stability voting only feeds
the HUD and calibration wizard.

### 6. Transient Filter

Before calling `_ndMatchNotes()`, checks if the detected MIDI jumped > 3 semitones
from the previous detection within 150ms. If so, the frame is skipped.

**What this means**: Intended to reject attack-transient jitter (E1→B0→E1 bouncing).
But it also rejects legitimate large interval jumps. Playing open E (MIDI 28) then
open A (MIDI 33) = 5 semitones = rejected. This filter actively prevents detection
of normal note transitions that span more than 3 semitones.

### 7. Note Matching (`_ndMatchNotes`)

Called on every raw detection frame that passes the filters above.
Computes "score time":

```
t = highway.getTime() + avOffsetSec - _ndLatencyOffset
```

Then binary-searches chart notes for candidates within `[t - tolerance, t + tolerance]`.

For each candidate:
- Compute pitch error (including octave-harmonic tolerance).
- Record closest pitch attempt in `_ndNotePitchAttempts` (even if too far off).
- If pitch within tolerance and not already judged → HIT.

**What this means**: Every detection frame generates match attempts against all chart
notes in the window. If you're sustaining note N and note N+1 enters the window,
the sustained pitch of N gets compared to N+1, fails on pitch, and gets recorded
as a pitch attempt. When N+1's deadline expires, it's marked MISSED_WRONG_PITCH
with the error from the sustained N pitch — even though the user may have played
N+1 correctly (just too late for the window).

### 8. Miss Detection (`_ndCheckMisses`)

Runs on a 100ms `setInterval`. For each chart note older than `t - tolerance * 2`:
- Not in `_ndNoteResults` and has a pitch attempt → `MISSED_WRONG_PITCH`
- Not in `_ndNoteResults` and no pitch attempt → `MISSED_NO_DETECTION`

**What this means**: The miss deadline is `tolerance * 2` after the note. With
tolerance=110ms, the deadline is 220ms after the chart note time. Any detection
of the correct pitch arriving after 220ms is wasted — the note is already judged.

### 9. VU Meter / Level Display

Completely separate from detection. Uses AnalyserNode → requestAnimationFrame.
Does not influence detection except through the silence gate (which uses its output).

---

## Measured Latency (from frame log data)

From actual frame log captures on bass:

| Transition | Chart note time | First correct detection | Latency |
|---|---|---|---|
| C2→B1 | 30.990 | **never within window** | >1s |
| B1→A1 | 32.170 | chartT 32.738 | 568ms |
| A1→G1 | 33.370 | chartT ~34.4 | ~1000ms |
| G1→F1 | 34.710 | chartT 34.879 | 169ms |
| F1 (sustained, same note) | 38.430 | immediate | 0ms (already in buffer) |

**Pattern**: The only notes that get detected in time are those where the buffer
already contains the correct pitch (sustained notes, repeated pitches). Note
transitions take 170-1000ms to register because:

1. The 4096-sample buffer contains ~85ms of audio, dominated by the previous note's sustain.
2. After a pluck, it takes 2 buffer cycles (~170ms) for the new pitch to dominate.
3. YIN returns LOW_CONF on attack transients, rejecting the first 1-2 valid buffers.
4. The transient filter may additionally reject the first frame with the new pitch.

With tolerance=110ms and latencyOffset=71ms, the matching window is ±110ms around
scoreTime. A detection arriving 170ms+ after the pluck is already outside this window.

---

## Comparison: TonalRecall vs Slopsmith Plugin

### TonalRecall (working)

```
sounddevice.InputStream(callback) → aubio.pitch("yin") → StabilityAnalyzer → callback
```

- **Audio**: sounddevice (direct ALSA/JACK), blocksize=4096 at 44100 Hz.
- **Detection**: aubio (C library, SIMD-optimized YIN). Runs **in the audio callback**,
  at audio callback rate (~10.7 fps at 4096/44100). Zero scheduling overhead.
- **Confidence threshold**: 0.7 (only high-confidence detections proceed).
- **Signal minimum**: 0.005 raw RMS (no scaling).
- **Stability**: Frequency-grouping analyzer (group within 1 Hz). Needs 3 of 5 detections
  in the same group. Callback fires only when stable note **changes**.
- **Matching**: Flashcard-style — compare stable note name to target. No timing window.
  No chart synchronization. Event-driven (callback on note change), not polled.
- **Latency**: ~93ms (one buffer at 44100/4096) from pluck to detection result.
  No additional scheduling, polling, or accumulation delay.
- **Octave correction**: FFT-based sub-harmonic analysis. If the sub-harmonic has
  2.5x the energy of the detected frequency, correct down one octave.
- **Attack detection**: In the UI state machine — signal must rise 1.8x above previous
  frame and exceed 0.1 to trigger an "attack" display.

### Slopsmith Plugin (not working)

```
getUserMedia → ScriptProcessor → accumulate → setInterval → JS YIN → filters → matchNotes
```

- **Audio**: Web Audio API getUserMedia → ScriptProcessor (deprecated API, main thread).
  Buffer size 2048, accumulated to 4096. Extra copy on every chunk.
- **Detection**: JavaScript YIN reimplementation. Runs on a **50ms setInterval**, not in
  the audio callback. Main thread, no SIMD, O(n^2) inner loop.
- **Confidence threshold**: 0.3 (allows low-quality detections through).
- **Signal gate**: 0.02 scaled (from a separate AnalyserNode path with 0.8 smoothing).
- **Stability**: 3-of-5 MIDI vote (no longer gating chart matching, but still computed).
- **Transient filter**: Rejects MIDI jumps > 3 semitones in 150ms.
- **Matching**: Continuous — every detection frame is matched against all chart notes
  in a ±tolerance timing window. Sustained notes generate repeated match attempts
  against subsequent chart notes.
- **Latency**: ~85ms accumulation + 0-50ms timer + ~5ms YIN + attack settling = **170-600ms**
  from pluck to first correct detection of new pitch.
- **Octave correction**: Octave-down cents comparison in matching, no FFT verification.
- **Attack detection**: None. No onset detection. Buffer transitions naturally as new
  samples accumulate. (Onset buffer flushing was tried and made latency worse.)

### Why TonalRecall Works and This Doesn't

| Factor | TonalRecall | Slopsmith Plugin |
|---|---|---|
| Detection runs | In audio callback | On a 50ms timer |
| Audio access | Direct ALSA (sounddevice) | Browser sandbox (getUserMedia) |
| YIN implementation | aubio C library, optimized | Naive JavaScript, main thread |
| Confidence threshold | 0.7 | 0.3 |
| Buffer strategy | Single 4096-sample block per callback | Accumulate 2x2048 → 4096 |
| Pluck-to-detection | ~93ms | 170-600ms |
| Matching strategy | Event-driven (on note change) | Continuous (every frame) |
| Timing requirement | None (flashcard: play when ready) | ±110ms window vs chart |

The fundamental problem is not any single parameter. It's architectural:

1. **TonalRecall detects pitch in the audio callback.** Detection happens as soon as
   audio arrives. There is no accumulation step, no timer poll, no scheduling delay.

2. **TonalRecall matches on note change events, not continuous polling.** The callback
   only fires when the stable note changes. There's no concept of "the sustained pitch
   of the old note accidentally matching against the new chart note."

3. **TonalRecall has no timing window.** It's flashcard-style: show a note, wait for
   the user to play it. The user controls the pace. Slopsmith requires the detection
   to land within a ±110ms window of a chart time — which is physically impossible
   when the detection pipeline adds 170-600ms of latency.

---

## What Would Need to Change

The current architecture cannot match notes in real-time against a moving chart.
The minimum detection latency (170ms for favorable transitions) exceeds the timing
tolerance (110ms) even before accounting for attack transients or buffer contamination.

Options (not recommendations — evaluation of feasibility):

1. **AudioWorklet**: Replace ScriptProcessor with AudioWorklet. Runs YIN in the audio
   thread on every buffer, like aubio does in TonalRecall. Eliminates the accumulation
   + timer poll latency (~85-135ms). Still JS, still O(n^2) YIN, still browser sandbox.

2. **WASM aubio**: Compile aubio to WebAssembly. Run it from an AudioWorklet. Gets
   native-quality detection in the browser. Eliminates the JS YIN quality gap.

3. **Flashcard mode first**: Build a mode that works like TonalRecall — show a note,
   wait for the user to play it, no timing window. This proves the detection pipeline
   works for pitch accuracy (which the tuner already confirms) before attempting
   real-time chart synchronization.

4. **Server-side detection**: Route audio via WebSocket to a Python process running
   aubio. Adds network latency but gets native detection quality. Original Phase 0 plan.

5. **Increase tolerance dramatically**: Set timing tolerance to 500ms+ and latency
   offset to 200ms+. This papers over the latency but produces very loose timing
   feedback.

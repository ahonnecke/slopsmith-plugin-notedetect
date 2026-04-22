# Plan: Programmatic Audio Test Harness

## Problem

Every code change requires a human to pick up a guitar, play a song section, put it down, and wait for analysis. This makes the iteration loop ~5 minutes per change. The LLM can't test its own changes, leading to speculative multi-change deploys that break things.

## Goal

Send known audio (specific frequencies at specific times) into the slopsmith note detection pipeline programmatically. Verify the pipeline produces the correct detections and chart matches. No guitar, no human, no browser interaction.

## How Audio Currently Enters the Pipeline

```
getUserMedia (mic) → MediaStreamSource → GainNode → ScriptProcessor.onaudioprocess
  → accumulate into 4096-sample buffer → YIN pitch detection → stability voting → chart matching
```

The ScriptProcessor callback receives Float32Array audio chunks of 2048 samples. It accumulates them to 4096 samples, then YIN runs on the accumulated buffer.

## Approach: Inject at the ScriptProcessor Level

Replace the mic source with an OscillatorNode that generates known frequencies. The rest of the pipeline (accumulation, YIN, stability voting, chart matching) runs unmodified.

### Why OscillatorNode, not raw buffer injection

- OscillatorNode is a real Web Audio API source — it flows through the same GainNode, AnalyserNode, and ScriptProcessor as the mic
- No mocking, no fake buffers — the actual pipeline processes actual audio samples
- We can precisely control frequency, amplitude, and timing (start/stop)
- Works in headless Chrome (Puppeteer) for CI

### Why not unit-test YIN in isolation

YIN already works — the flashcard plugin proves it detects every bass note correctly. The failures are in the chart-matching layer (timing, latency offset, miss detection). Testing YIN alone doesn't exercise the failing code.

## Implementation

### Phase 1: Synthetic audio source toggle

Add a function `_ndInjectTestAudio(noteSequence)` that:
1. Disconnects the mic source (if connected)
2. Creates an OscillatorNode per note in the sequence
3. Schedules each oscillator to start/stop at precise times using `AudioContext.currentTime`
4. Connects oscillators through the same gain → analyser → processor chain

```javascript
// noteSequence format:
[
  { midi: 36, startTime: 0.0, duration: 0.8 },  // C2 starting at t=0
  { midi: 35, startTime: 1.0, duration: 0.8 },  // B1 starting at t=1s
  { midi: 33, startTime: 2.0, duration: 0.8 },  // A1 starting at t=2s
]
```

The function:
- Converts MIDI to frequency: `440 * 2^((midi - 69) / 12)`
- Creates OscillatorNode for each note, sets frequency
- Uses `oscillator.start(ctx.currentTime + startTime)` and `.stop(... + startTime + duration)`
- Connects all through the existing gain node
- Returns a Promise that resolves when the sequence is complete

### Phase 2: Chart-synchronized test sequence

Build a test sequence from the actual chart data:
1. Read `highway.getNotes()` to get the chart's note times and pitches
2. Convert each chart note to a `{midi, startTime, duration}` entry
3. Offset startTimes so they align with the highway's score time
4. Inject the sequence and let the pipeline match against the chart

This answers: "If the player plays every note perfectly, does the pipeline score 100%?"

If it doesn't, the problem is in the pipeline, not the player.

### Phase 3: Headless test runner (Puppeteer)

A Node.js script that:
1. Launches headless Chrome with the slopsmith page
2. Loads a test song
3. Calls `_ndInjectTestAudio(sequence)` via `page.evaluate()`
4. Waits for the sequence to complete
5. Reads the dump from the server endpoint (`GET /api/plugins/note_detect/dump`)
6. Asserts: hit rate ≥ threshold, no false positives, timing errors within bounds

This runs without a browser window, without a guitar, without a human. It can run after every code change.

## Phase 1 Details (Start Here)

### What to build

One function in screen.js: `_ndInjectTestAudio(noteSequence)`

### What it does

1. If audio isn't started yet, call `_ndStartAudio()` but skip `getUserMedia` — create an AudioContext and the processing chain (gain → analyser → processor) without a mic source
2. For each note in the sequence:
   - Create an OscillatorNode with the correct frequency
   - Set a moderate gain (0.5) so the signal is above the silence gate
   - Schedule start/stop times relative to `AudioContext.currentTime`
3. After the last note ends, auto-dump results

### What it proves

- YIN detects the synthetic tones (should be trivial — pure sine waves at known frequencies)
- Stability voting converges on the correct MIDI
- Event-driven matching fires at the right time
- Chart matching finds the correct chart note within the timing window

### What it doesn't prove (yet)

- Real-world audio with harmonics, noise, string resonance
- Latency of the actual mic input path
- Whether the silence gate threshold is correct for real bass signal levels

### Test invocation

Console-callable:
```javascript
// Generate sequence from chart, play perfect, check results
_ndTestPerfectPlay()
```

Or with a manual sequence:
```javascript
_ndInjectTestAudio([
  { midi: 36, startTime: 0, duration: 0.5 },
  { midi: 35, startTime: 1, duration: 0.5 },
])
```

## Success Criteria

Phase 1: `_ndTestPerfectPlay()` on Mexico loop → 100% hit rate with synthetic audio. If it's not 100%, the bug is in the pipeline and can be debugged without a guitar.

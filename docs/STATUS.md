# Note Detection Plugin — Status (2026-04-22)

## What Works

- **Pitch detection**: JS YIN detects bass notes E1–G2 at confidence 0.7 with 0¢ accuracy. Proven in flashcard plugin, main game, and programmatic test harness.
- **Event-driven matching**: Fires on stable pitch CHANGE, not every frame. Eliminates sustained-note contamination.
- **Stability voting (2-of-3)**: Suppresses YIN's attack-transient jitter. Reduced from 3-of-5 to handle 400ms note spacing.
- **Same-note lock with 1s expiry**: Prevents sustained note from re-triggering, but allows replayed notes after a gap.
- **Silence gate + stability flush**: Prevents stale votes from carrying over between notes.
- **Auto-dump diagnostics**: POSTs data to server every 30s and on loop restart. No button clicking required.
- **Server-side dump endpoint**: routes.py saves to /tmp/nd_diag_dump.json, readable via docker exec.
- **Programmatic test harness**: 125/125 hits (100%) on full Mexico bass arrangement with synthetic audio. See [Test Harness](#test-harness).

## Test Harness

Injects synthetic sine waves via OscillatorNode through the same audio processing chain as the mic. No guitar, no human, no browser UI needed.

### Run

```bash
# Quick test (30 notes, ~45s)
node test/perfect-play.test.js

# Full song (127 notes, ~3min)
node test/perfect-play.test.js --max-notes 127

# Specific song/arrangement
node test/perfect-play.test.js --song "Mexico" --arrangement 3

# Show browser window
node test/perfect-play.test.js --headed
```

Requires slopsmith running at localhost:8088 (`docker compose up`).

### What it tests

1. Loads slopsmith, finds song, loads bass arrangement via Puppeteer
2. Reads chart notes from `highway.getNotes()`
3. Generates sine waves at exact chart-note frequencies
4. Mocks `highway.getTime()` to sync with oscillator schedule
5. Runs the full pipeline: YIN → stability voting → event-driven matching → chart scoring
6. Reports hit rate, timing errors, pitch errors per note

### Results (Mexico by Cake, bass, full song)

- **125/125 hits (100%)**, 0 misses
- All notes 0¢ pitch error
- Pipeline latency ~400ms (consistent, within ±500ms matching window)
- Every bass MIDI (29–48) detected correctly
- Notes at 400ms spacing (rapid passages) all hit with 2-of-3 stability

### What it doesn't test

- Real instrument audio (harmonics, string resonance, fret buzz)
- Mic input latency and ambient noise
- Browser audio device selection and routing
- The gap between 100% synthetic and 85% real play is in these factors

## Best Result With Real Guitar

85% hit rate (28/33 notes) on Mexico loop, all hits with perfect pitch (0¢). This was with the auto-calibration that later broke everything. Auto-calibration has been removed.

## Known Issues

- **Latency offset**: Pipeline adds ~400ms (buffer accumulation + stability voting). Code default is 350ms. The calibration wizard measures raw audio latency (~71ms) but doesn't account for stability voting. User's localStorage may have stale values from removed auto-calibration (0.599). The correct value based on real-play data is ~400ms.
- **Poisoned localStorage**: Auto-pitch calibration (now removed) set pitchOffset to +9 semitones. A ±1 guard on load rejects this, but the user may need to clear localStorage or use the pitch offset slider to reset.
- **Real-play hit rate**: 85% with real guitar vs 100% synthetic. The gap is likely: harmonics confusing YIN, string resonance bleeding between notes, and mic input noise.

## Architecture

### Detection Pipeline

```
Mic/Oscillator → GainNode → AnalyserNode → ScriptProcessor (2048 samples)
  → accumulate to 4096 samples → YIN pitch detection (confidence ≥ 0.7)
  → stability voting (2-of-3 agreement on rounded MIDI)
  → event-driven matching (fire on stable pitch CHANGE only)
  → chart matching (±500ms window, ±50¢ pitch tolerance)
```

### Key Parameters

| Parameter | Value | Why |
|---|---|---|
| Confidence threshold | 0.7 | Flashcard plugin proved 0.3 produces wrong pitches |
| Stability voting | 2-of-3 | Halved from 3-of-5 to handle 400ms note spacing |
| Matching window | ±500ms | Wide enough for ~400ms pipeline latency |
| Latency offset | 350ms | Compensates for buffer accumulation + stability voting |
| Silence gate | 0.02 | Rejects noise floor; flushes stability history |
| Same-note lock | 1s expiry | Prevents sustained note contamination; allows replays |

### How It Differs From TonalRecall

TonalRecall is a flashcard game — no timing, no chart, no latency compensation. Target stays on screen until you play the right note. The slopsmith plugin must match detections against a scrolling chart timeline, which requires:
1. A latency offset ("what chart time corresponds to this detection?")
2. A timing window (find candidate chart notes near the detection time)
3. A miss deadline (declare notes unplayed after they pass)

None of these exist in TonalRecall. The flashcard plugin (a TonalRecall port) works. The chart-matching layer is where real-play failures occur.

## What Was Tried and Failed

- **Auto-timing calibration**: Adjusted latency offset based on hit timing data. Overshot from 71ms → 456ms → 599ms. Removed.
- **Auto-pitch calibration**: Computed pitch offset from play data. Created feedback loop: timing mismatch → wrong chart note → computed +9 semitone "correction" → 0% hit rate. Removed.
- **3-of-5 stability voting**: Too slow for notes 400ms apart. Stability couldn't converge before the next note started.
- **Onset detection with buffer flush**: Flushing the buffer forced re-accumulation from scratch (~170ms), slower than the natural sliding window (~85ms). Removed.
- **Transient filter (MIDI jump > 3 semitones)**: Blocked real transitions like E→A (5 semitones). Removed — stability voting handles transient jitter.

## What's Needed Next

1. **Understand the 85% → 100% gap**: The test harness proves the pipeline works with clean audio. Real guitar at 85% suggests harmonics, noise, or sustained-note bleed are the remaining issues. Need to add test modes with harmonics and noise to isolate which factor matters.
2. **Fix latency offset for real play**: The 350ms code default is close but not empirically calibrated for the current 2-of-3 stability. Real-play hits arrived at +290–489ms with the old 71ms offset, suggesting ~400ms total pipeline latency.
3. **Per-note feedback on highway**: With working detection, render hit/miss markers on the note highway.
4. **Loop iteration tracking**: Track which notes are consistently missed across loop repetitions.

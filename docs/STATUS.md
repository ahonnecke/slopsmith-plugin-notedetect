# Note Detection Plugin — Status (2026-04-22)

## What Works

- **Pitch detection**: JS YIN detects bass notes E1–G2 at confidence 0.7 with 0¢ accuracy. Proven in flashcard plugin and main game (every hit in testing had 0¢ pitch error).
- **Event-driven matching**: Fires on stable pitch CHANGE, not every frame. Eliminates sustained-note contamination. Proven in flashcard plugin, ported to main game.
- **Stability voting (2-of-3)**: Suppresses YIN's attack-transient jitter. Reduced from 3-of-5 to handle 400ms note spacing.
- **Same-note lock with 1s expiry**: Prevents sustained note from re-triggering, but allows replayed notes after a gap.
- **Silence gate + stability flush**: Prevents stale votes from carrying over between notes.
- **Auto-dump diagnostics**: POSTs data to server every 30s and on loop restart. No button clicking required.
- **Server-side dump endpoint**: routes.py saves to /tmp/nd_diag_dump.json, readable via docker exec.

## Best Result Achieved

85% hit rate (28/33 notes) on Mexico by Cake loop, all hits with perfect pitch (0¢). This was before auto-calibration broke everything.

## What Doesn't Work

- **Latency offset**: The detection pipeline adds ~400ms latency (buffer accumulation + stability voting). This must be compensated in the chart-matching time calculation. The calibration wizard measures raw audio latency (~71ms) but doesn't account for stability voting delay. The correct total offset is ~400ms based on empirical hit data, but there's no reliable way to set it — auto-calibration overshot and was removed.
- **Pitch offset**: Auto-pitch calibration created a feedback loop (timing mismatch → wrong chart note match → computed +9 semitone "correction" → all detection broken). Removed. User's localStorage may still have poisoned values.
- **Higher notes on D/G strings**: MIDI 38+ detection is less reliable. G string notes (MIDI 43+, especially MIDI 48/C3) frequently show NO_DETECTION.
- **Fast passages**: Notes spaced <400ms apart can overwhelm stability voting even at 2-of-3.

## What's Different From TonalRecall

TonalRecall is a flashcard game — no timing, no chart, no latency compensation. Target stays on screen until you play the right note. The slopsmith plugin must match detections against a scrolling chart timeline, which requires:
1. A latency offset to compute "what chart time corresponds to this detection?"
2. A timing window to find candidate chart notes
3. A miss deadline to declare notes unplayed

None of these exist in TonalRecall. The flashcard plugin (which IS a TonalRecall port) works. The chart-matching layer on top is where failures occur.

## Root Cause of LLM Development Failures

1. **No automated testing**: Every change requires a human to pick up a guitar, play a song section, put down the guitar, and wait for analysis. This makes iteration impossibly slow and error-prone.
2. **Speculative systems**: Without tests, the LLM (me) invents complex systems (auto-calibration) that interact in untested ways and create feedback loops.
3. **No incremental commits**: 1200+ lines of mixed good/bad changes with no intermediate commits, making selective revert impossible.
4. **The chart-matching problem has no reference implementation to copy from**: TonalRecall doesn't solve timing. Rocksmith's implementation is closed-source.

## Current State of the Code

Branch: `fix/bass-and-low-note-detection`
Last commit: `00881ef` — Event-driven matching, auto-dump, remove auto-calibration

Key values in code (may be overridden by localStorage):
- `_ndLatencyOffset = 0.350` (code default; localStorage has 0.599 from removed auto-calibration)
- `_ndSilenceGate = 0.02`
- `_ndPitchOffset = 0` (code default; localStorage has 9 from removed auto-pitch, rejected on load by ±1 guard)
- Stability voting: 2-of-3
- Confidence threshold: 0.7
- Matching window: ±500ms

## What's Needed Next

A test harness that sends programmatic audio into the detection pipeline so changes can be validated without a human holding a guitar.

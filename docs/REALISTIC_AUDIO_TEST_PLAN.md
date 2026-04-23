# Plan: Realistic Audio Tests + Recording Harness

## Problem

The synthetic test (sine waves) gets 100%. Real bass gets ~85%. The gap is caused by factors sine waves don't have:
1. **Harmonics**: A bass E1 (41Hz) has strong harmonics at 82Hz (E2), 123Hz, 164Hz. YIN can lock onto the wrong harmonic.
2. **Sustain bleed**: After plucking note N, the string keeps ringing. When note N+1 is played, the buffer contains a mix of both. YIN may report the old pitch until the new one dominates.
3. **Attack transients**: The first ~50ms of a pluck contains broadband noise before the fundamental stabilizes. YIN can report spurious pitches.
4. **Ambient noise**: Hum, cable noise, room tone at low levels.

## Approach: Two parallel tracks

### Track 1: Synthetic tests with realistic impairments

Add test modes to the existing harness that simulate each impairment in isolation. This identifies which factor causes the 85% → 100% gap without needing a real instrument.

#### Test: Harmonics

Generate sine waves with overtones matching a real bass string (fundamental + 2nd + 3rd harmonic at decreasing amplitude). Bass strings have strong 2nd harmonic.

```javascript
_ndInjectTestAudio(sequence, { waveform: 'sawtooth' })  // rich harmonics
// or custom: fundamental + harmonics at specific amplitudes
```

#### Test: Sustain overlap

Instead of clean gaps between notes, let each oscillator ring for longer than the gap to the next note. The last ~100ms of note N overlaps the first ~100ms of note N+1.

```javascript
// Extend duration so notes overlap by 100ms
sequence.forEach((n, i) => {
    if (i < sequence.length - 1) {
        const gap = sequence[i + 1].startTime - n.startTime;
        n.duration = gap + 0.1; // overlap into next note
    }
});
```

#### Test: Attack noise

Add a short burst of white noise at the start of each note (simulates pick/pluck transient).

#### Test: Low-level noise floor

Add continuous low-amplitude noise to simulate ambient hum/cable noise near the silence gate threshold.

### Track 2: Record real bass audio and replay

Record the actual USB Rocksmith cable output while playing a known section, then replay that recording through the test harness.

#### Recording setup

1. Use ALSA/PulseAudio to capture the Rocksmith USB adapter output to a WAV file
2. Play a known section (e.g., Mexico loop) while Rocksmith or slopsmith scores it
3. The WAV file becomes a regression test fixture

```bash
# Record from Rocksmith USB adapter
# Find the device
arecord -l
# Record 60 seconds at 48kHz mono
arecord -D hw:X,0 -f S16_LE -r 48000 -c 1 -d 60 test/fixtures/mexico-bass-loop.wav
```

#### Replay in test harness

Instead of OscillatorNode, use an AudioBufferSourceNode loaded from the WAV file. Routes through the same gain → analyser → processor chain.

```javascript
async function _ndInjectTestWav(wavUrl) {
    const response = await fetch(wavUrl);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await _ndAudioCtx.decodeAudioData(arrayBuffer);
    const source = _ndAudioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(_ndTestGainNode);
    source.start();
    // Wait for playback to finish
    await new Promise(r => setTimeout(r, audioBuffer.duration * 1000 + 1000));
}
```

The Puppeteer test uploads the WAV to the server (or serves it from a local path) and replays it.

#### Advantage over live testing

- **Deterministic**: Same audio every run. A code change that regresses detection is caught immediately.
- **No human needed**: The recording is made once, then replayed indefinitely.
- **Debugging**: Can zoom into the WAV at specific timestamps where detection fails, correlate with frame log.

## Implementation Order

### Phase 1: Harmonics test (in-browser, no recording needed)

Add a `waveform: 'sawtooth'` option to the existing test. Sawtooth has all harmonics at 1/n amplitude — close to a real string. Run and see if hit rate drops.

If it drops: the problem is YIN + harmonics. Fix the detection.
If it doesn't: harmonics aren't the issue, move to sustain overlap.

### Phase 2: Sustain overlap test

Modify note durations so they overlap by 100ms. This directly tests the "registers the note that was last played if it's still playing" problem.

### Phase 3: Record real bass WAV

Record one loop of Mexico bass via the USB adapter. Build `_ndInjectTestWav()`. Replay and compare hit rate to the synthetic test.

### Phase 4: WAV-based regression suite

Store the WAV in `test/fixtures/`. The Puppeteer test replays it and asserts hit rate ≥ threshold. This becomes the primary regression test — it exercises the full pipeline with real instrument audio.

## Success Criteria

| Test | Current | Target |
|---|---|---|
| Synthetic sine (baseline) | 100% | 100% (regression guard) |
| Sawtooth harmonics | untested | 95%+ |
| Sustain overlap (100ms) | untested | 90%+ |
| Real bass WAV replay | ~85% | 90%+ |

# Plan: Get Note Detection Working for Bass in the Main Game

## What We Know

The flashcard plugin proves:
- JS YIN detects bass notes E1-G2 reliably at confidence 0.7
- Stability voting (3-of-5) gives correct note identification
- Event-driven matching (fire on note change, not every frame) works
- Silence gate + stability flush prevents stale detections

The main game's note_detect plugin fails because:
- Continuous matching: every 50ms frame is matched against all chart notes in a
  timing window. Sustained note N poisons match attempts against note N+1.
- Pipeline latency: 170-600ms from pluck to correct detection, vs 110ms tolerance.
- Transient filter: rejects MIDI jumps > 3 semitones, blocking real transitions.

## The Core Change

Switch from **continuous matching** to **event-driven matching**.

Current model:
```
every 50ms:
  detect pitch → match against all chart notes in [now-110ms, now+110ms]
```

New model:
```
when stable pitch CHANGES:
  find the best chart note match for this pitch within a wider lookback
```

This is the same architecture that makes TonalRecall and the flashcard plugin work.

---

## Phases

### Phase 1: Raise confidence threshold to 0.7

**What**: Change `FC_CONFIDENCE_THRESHOLD` from 0.3 to 0.7 in note_detect.

**Why**: The flashcard proves 0.7 works. The 0.3 threshold was set because
detections were "too sparse" — but that was because the timing window was too
narrow, not because 0.7 was wrong. Low-confidence detections produce wrong
pitches that poison the match attempts.

**Test**: Play Mexico, dump to console. Compare number of LOW_CONF rejections
vs before. Hit rate should not decrease (low-conf detections were wrong anyway).

**Risk**: None. Low-confidence detections were never producing hits.

### Phase 2: Remove transient filter

**What**: Remove the `_ND_TRANSIENT_JUMP > 3 semitone` filter.

**Why**: It blocks real note transitions. E1→A1 = 5 semitones = rejected.
The flashcard plugin doesn't use it and works fine — stability voting handles
transient jitter.

**Test**: Play Mexico, verify no regression. Open strings (E→A = 5st, A→D = 5st)
should no longer be filtered.

**Risk**: Attack transient jitter may produce brief wrong-pitch detections.
But at confidence 0.7 (Phase 1), these are already rejected.

### Phase 3: Switch to event-driven chart matching

**What**: Replace the current `_ndMatchNotes()` call on every frame with a
note-change-triggered match.

Current flow:
```javascript
// Called every frame
_ndMatchNotes();  // matches _ndDetectedMidi against chart window
```

New flow:
```javascript
// Only called when stable note changes
if (fcStableMidi >= 0 && fcStableMidi !== prevStableMidi) {
    prevStableMidi = fcStableMidi;
    _ndMatchNoteChange(fcStableMidi);
}
```

`_ndMatchNoteChange(midi)` is a new function that:
1. Computes score time (same as current: `getTime() + avOffset - latencyOffset`)
2. Searches chart notes in a **wider window** — not ±110ms, but ±500ms or even
   ±1000ms. The pitch match provides specificity that the tight timing window
   was supposed to provide.
3. Finds the closest UNJUDGED chart note whose expected MIDI matches within
   pitch tolerance.
4. If found: HIT. Record timing error for feedback.
5. If no match: the user played a note not in the chart. Ignore (don't score).

Miss detection (`_ndCheckMisses`) stays as-is — notes that pass their deadline
without a matching note-change event are misses.

**Key difference**: The sustained pitch of note N no longer generates match
attempts against note N+1. Only a CHANGE to a new pitch triggers matching.
And the wider window accommodates the ~200ms detection latency.

**Test**: Play Mexico. Compare hit rate to flashcard accuracy (should be similar
for the same notes). Timing errors should be measurable but notes should match.

**Risk**: Stability voting adds ~250ms latency. For fast passages (16th notes at
120bpm = 125ms per note), the note change may arrive after the next note has
started. This is a known limitation — same as TonalRecall. Slow/medium passages
should work.

### Phase 4: Tune timing and add silence-gap handling

**What**: Apply the flashcard's silence-gap logic to the game:
- Flush stability history on silence gate
- Lock out the last-correct MIDI until silence (prevent re-triggering on sustain)
- Clear the lock when the new target is the same pitch

Also tune:
- `_ndLatencyOffset`: with event-driven matching, this compensates for stability
  voting latency (~250ms), not buffer accumulation. May need to increase.
- Timing tolerance: with wider matching window, the tolerance is about diagnostic
  feedback quality, not hit/miss gating. Can be more generous.

**Test**: Play Mexico and a faster song. Check that:
- Sustained notes don't trigger false matches on subsequent chart notes
- Silence between notes clears stale state
- Hit rate on slow passages approaches flashcard accuracy

### Phase 5: Per-note feedback on highway

**What**: With working detection, render hit/miss markers on the highway.

This was previously attempted but couldn't be verified because detection was
broken. With event-driven matching producing real hits, the rendering can be
tested.

- Green marker at the note position for HITs
- Red marker with diagnostic label for MISSes
- Now-line rendering (proven working) as fallback for past-note rendering issues

**Test**: Visual — play a section, see green/red markers on the highway.

### Phase 6: Loop iteration tracking

**What**: When the user loops over a section, track which notes are consistently
missed across iterations. Surface this as "problem notes" feedback.

This is the original goal: "When looping over a lick, show which notes were
missed and WHY."

With working detection (Phases 1-4) and rendering (Phase 5), this becomes a
data aggregation problem, not a detection problem.

---

## What This Plan Does NOT Address

- **Fast passages**: Stability voting's 250ms latency means notes shorter than
  ~200ms will be missed. This affects 16th notes at 120+ BPM. For the user's
  current practice (slow bass songs), this isn't a blocker.

- **Polyphonic detection**: Chords. YIN is monophonic. Rocksmith handles chords
  differently (checks that all expected frequencies are present). Out of scope.

- **Highway string count**: Still hardcoded to 6 in highway.js. Separate fix.

- **AudioWorklet / WASM aubio**: If Phases 1-4 produce acceptable results with
  JS YIN, these aren't needed. If fast passages remain a problem, AudioWorklet
  would reduce latency by eliminating the setInterval polling.

---

## Success Criteria

| Metric | Current | Target |
|---|---|---|
| Hit rate (slow bass, Mexico) | 0-46% | 80%+ |
| Hit rate (medium bass) | untested | 60%+ |
| False positives (wrong note scored as hit) | unknown | <5% |
| Detection latency (note change to match) | 170-600ms | <300ms |
| Sustained note contamination | constant | zero |

The flashcard proves the detection pipeline can achieve ~100% accuracy with no
timing pressure. The game target of 80%+ accounts for the timing dimension that
the flashcard doesn't have.

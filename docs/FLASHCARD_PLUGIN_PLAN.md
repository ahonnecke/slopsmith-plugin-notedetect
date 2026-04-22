# Flashcard Plugin Plan

A new slopsmith plugin (`note_flashcard`) that tests pitch detection in isolation.
No timing window. No chart sync. No sustained-note contamination. Play a note,
see if the detector gets it right.

This is how TonalRecall was developed and why it works.

---

## Why

The note detection plugin's chart matching is broken because the detection pipeline
has 170-600ms of latency. But the **pitch detection itself** is accurate — the tuner
confirms it, Quick Calibrate confirms it. The problem is matching detected pitches
against a moving chart with tight timing windows.

A flashcard plugin isolates pitch accuracy from timing. If it works, the detection
pipeline is sound and the problem is chart synchronization. If it doesn't, we have
a pitch detection problem to fix before anything else.

---

## What It Does

1. Show a note on screen: "Play B1" (with fretboard position: A string, fret 2)
2. User plays the note
3. Plugin detects pitch, compares to target
4. Display result: correct / wrong (show what was detected)
5. On correct: advance to next note
6. Track stats: accuracy, response time, notes per minute

No timing pressure. The user plays when ready. Detection runs continuously but
only MATCHES when the stable pitch changes (event-driven, like TonalRecall).

---

## Architecture

### Reuses from note_detect plugin

- Audio capture: `getUserMedia` → ScriptProcessor → accumulate → YIN
- YIN pitch detection: `_ndYinDetect()`
- Silence gate
- Stability voting (this is where stability voting IS appropriate — no timing constraint)
- Frequency → MIDI conversion
- MIDI → note name conversion

### Does NOT reuse

- Chart matching (`_ndMatchNotes`) — no chart, no timing window
- Miss detection (`_ndCheckMisses`) — no deadlines
- Highway draw hook — no highway rendering
- Latency offset / AV offset ��� no timing compensation needed
- Transient filter — stability voting handles this

### New code

- Flashcard UI: target note display, result feedback, stats
- Note-change event detection: only evaluate when stable pitch changes
- Difficulty levels (borrowed from TonalRecall's proven progression):
  - Level 1: Open strings only (E, A, D, G)
  - Level 2: All natural notes
  - Level 3: E string chromatic (E1-A1)
  - Level 4: A string (A1-D2)
  - Level 5: D string (D2-G2)
  - Level 6: G string (G2-C3)
  - Level 7: Octave pairings
  - Level 8: Full chromatic low position
  - Level 9: High register
  - Level 10: All playable notes

---

## Implementation Phases

### Phase 1: Prove pitch detection works (single note, no UI)

**Goal**: Confirm that the existing YIN → stability voting pipeline can reliably
identify a single note played on bass, with no timing pressure.

**What to build**:
- Console-callable function `_fcTest(targetNote)` that:
  1. Starts audio capture (reuse `_ndStartAudio()`)
  2. Waits for stable MIDI (reuse stability voting)
  3. Converts to note name
  4. Compares to target
  5. Logs result to console: `"Target: B1, Detected: B1, Correct!"` or
     `"Target: B1, Detected: C2, Wrong (off by +1 semitone)"`
  6. Returns result object

**Test procedure**:
```
_fcTest('E1')   // play open E
_fcTest('A1')   // play open A
_fcTest('B1')   // play A string fret 2
_fcTest('G2')   // play D string fret 5
```

**Success criteria**: 95%+ accuracy on open strings, 90%+ on fretted notes.
If this fails, the YIN pipeline needs fixing before building any UI.

**Size**: ~50 lines of code. Add to existing screen.js or standalone test file.

### Phase 2: Flashcard plugin skeleton

**Goal**: A new slopsmith plugin that shows a target note and detects what you play.

**What to build**:
- New directory: `slopsmith-plugin-flashcard/`
- `plugin.json`: id=`note_flashcard`, name=`Note Flashcard`, script=`screen.js`
- `screen.js` containing:
  - Audio capture (copy from note_detect, strip chart-matching code)
  - YIN detection + stability voting
  - Simple UI: target note name, detected note name, correct/wrong indicator
  - Note-change detection: only evaluate when `_ndStableMidi` changes
  - Single difficulty level: open strings (E, A, D, G)

**Does NOT include yet**: fretboard visualization, stats, difficulty levels,
settings panel, persistence.

**Test procedure**: Load plugin in slopsmith, see target note, play it, see result.
Manual testing, ~5 minutes.

**Success criteria**: Can correctly identify open strings 95% of the time with no
false triggers from sustained notes.

### Phase 3: Full flashcard experience

**Goal**: Usable practice tool with progression, stats, fretboard visualization.

**What to build**:
- All 10 difficulty levels
- Fretboard diagram showing target position(s)
- Stats: accuracy %, notes per minute, streak, session summary
- Settings: difficulty selector, input device, confidence threshold
- localStorage persistence for stats and settings

**Test procedure**: Play through each difficulty level for 2 minutes each.

**Success criteria**: Matches TonalRecall's accuracy at each difficulty level.

### Phase 4: Evaluate real-time readiness

**Goal**: With proven pitch detection, assess what's needed for chart matching.

Based on Phase 1-3 results:
- If stability voting latency is acceptable (< 200ms): try matching against chart
  with wide tolerance (500ms), event-driven (on note change, not every frame)
- If latency is too high: investigate AudioWorklet or WASM aubio
- If pitch accuracy is insufficient: investigate FFT-based octave correction
  (like TonalRecall's FrequencyService)

This phase is planning only — no code until Phases 1-3 prove out.

---

## File Layout

```
slopsmith-plugin-flashcard/
  plugin.json          # plugin manifest
  screen.js            # all plugin code (audio + detection + UI)
  docs/
    FLASHCARD_PLAN.md  # this file (copy)
```

No routes.py (no server-side code needed).
No screen.html (UI built in JS, like note_detect).
No settings.html initially (settings in the main UI).

---

## What to Extract from note_detect

These functions/blocks should be copied (not shared — separate plugin):

1. **Audio capture**: `_ndStartAudio()` minus chart-matching setup
2. **YIN**: `_ndYinDetect()` — the entire function, unchanged
3. **Silence gate**: the `_ndInputLevel < _ndSilenceGate` check
4. **Stability voting**: the 3-of-5 MIDI vote block — this IS the right approach
   when there's no timing pressure
5. **MIDI conversion**: `_ndFreqToMidi()`, MIDI-to-note-name lookup
6. **Level meter**: `_ndStartLevelMeter()` for VU display

These should NOT be copied:

1. `_ndMatchNotes()` — wrong approach for flashcards
2. `_ndCheckMisses()` — no deadlines
3. Highway draw hook — no highway
4. Calibration wizard — no timing calibration needed
5. Transient filter — stability voting handles it
6. Auto pitch calibration — no chart to calibrate against
7. Diagnostic panel — build fresh, simpler

---

## Key Design Decisions

### Event-driven matching, not continuous polling

TonalRecall's architecture: callback fires only when stable note **changes**.
The flashcard plugin should do the same:

```javascript
// On each detection frame:
if (stableMidi !== previousStableMidi && stableMidi >= 0) {
    previousStableMidi = stableMidi;
    evaluateAgainstTarget(stableMidi);
}
```

This eliminates the sustained-note contamination problem entirely.

### Stability voting IS correct here

With no timing pressure, waiting 250ms for 3-of-5 agreement is fine.
The user plays a note, waits for feedback. 250ms is imperceptible in this context.
This is exactly how TonalRecall uses it.

### Confidence threshold should be 0.7

TonalRecall uses 0.7. The note_detect plugin lowered to 0.3 because detections
were too sparse — but that was because the timing window was too narrow, not
because 0.7 was wrong. In flashcard mode with no timing pressure, 0.7 is correct
and will reject the low-quality detections that cause false matches.

### Start with bass

The user plays bass. TonalRecall is bass-focused. Test with bass first.
Guitar support is a later addition (different tuning, different frequency range).

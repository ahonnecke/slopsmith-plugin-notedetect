# Note Detection Tests

## Programmatic audio test (Puppeteer)

Injects synthetic sine waves into the detection pipeline via OscillatorNode and verifies chart matching. Exercises the full pipeline: YIN → stability voting → event-driven matching → chart scoring.

Requires slopsmith running at `localhost:8088`.

```bash
# Install dependencies (first time)
npm install

# Quick test (30 notes, ~45s)
node test/perfect-play.test.js

# Full song (all notes, ~3min)
node test/perfect-play.test.js --max-notes 127

# Specific song/arrangement
node test/perfect-play.test.js --song "Mexico" --arrangement 3

# Show browser window for debugging
node test/perfect-play.test.js --headed
```

Pass criteria: 90%+ hit rate. Current result: 125/125 (100%) on Mexico bass.

## Detection-core unit tests (Node vm)

Pure pitch-detection and string/fret-mapping logic tests. Loads `screen.js` into a Node vm with DOM stubs. No browser needed.

```bash
npm test
```

### What the unit tests cover

| Test file | What it proves |
|---|---|
| `mapping-bass.test.js` | Bass MIDI mapping and string/fret resolution |
| `yin-buffer-sizing.test.js` | YIN needs 4096+ samples for frequencies below ~80 Hz |
| `yin-noise-tolerance.test.js` | YIN behavior with suppressed fundamentals and noise |
| `display-fingering.test.js` | Chart-context-aware fingering resolution |

## Architecture

The unit tests use a `vm`-based loader (`_loader.js`) that runs the real `screen.js` against DOM/Navigator stubs. This ensures tests exercise the shipping code, not a copy that could drift.

The Puppeteer test (`perfect-play.test.js`) runs against the actual slopsmith app in headless Chrome with real Web Audio API processing.

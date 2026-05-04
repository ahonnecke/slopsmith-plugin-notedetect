# Test harness port plan

User has hours of recorded play (WAVs + chart-time JSON sidecars)
under `test/fixtures/`. The pre-port branch had a working replay
harness that ran those fixtures through the detection pipeline
offline. Until that harness is ported, **detector quality changes
must NOT be evaluated against live user play.** Live play is a
limited, expensive resource; fixture replay is unlimited and free.

This plan ports the harness in three landable units. Each unit
should leave the branch in a state where I can run a single command
and get hit/miss numbers for each fixture, without the user playing
anything.

## Inventory: what already exists

### Fixtures (host disk, NOT in git)

```
test/fixtures/
  gasoline-2026-04-27T20-52-46.wav         ← recorded play
  gasoline-2026-04-27T20-52-46.dump.json   ← chart notes + judgments at record time
  gasoline-2026-04-27T20-52-46.report.md   ← human-readable report
  gasoline-2026-04-27T20-52-46.classification.json
  gasoline-2026-04-27T20-52-46.onset-probe.json (some takes)
  ... 20+ similar groups: gasoline / level / mexico / stand-by-me / etc.
  song-audio/                ← original song audio (mp3/wav)
  song-ceiling/              ← per-song "what's the best possible score"
  ground-truth/              ← curated ground-truth fixtures (gasoline-stitched)
  synth/                     ← synthetic test waveforms
```

WAV anchor: each WAV's t=0 corresponds to a specific chart-time
recorded in the `.json` sidecar. Replay must seek the chart to that
time before running.

### Reference branch test scripts (`reference/pre-port-baseline:test/`)

Headline tools (in priority order for porting):

- `replay-baseline.js` — multi-take WAV replay through the
  detection pipeline using **headless Chrome (puppeteer)**.
  Discovers `test/fixtures/*.wav`, reads sidecars, replays each in a
  single browser session, reports per-take hit rates + combined.
- `detector-bakeoff.js` — same machinery, runs WAV through both YIN
  and CREPE detectors, reports per-segment dominant MIDI.
- `replay-fix-impact.js` — replays the same fixture before and after
  a code change to measure impact.
- `onset-probe.js` — records onset firing patterns to a fixture
  sidecar.
- `session-report.js` — generates the `.report.md` from a dump.
- `classify-session.js` — generates `.classification.json` from a
  dump (per-note PASS/FAIL classification).
- `aggregate-plays.js` — cross-take aggregates.

Pure unit tests (already passing on the port branch — 104 tests):
- `coaching-analysis.test.js` (added on port branch)
- `display-fingering.test.js`, `mapping-bass.test.js`, etc.

Tests that need port-branch updates:
- `per-note-coaching.test.js`, `practice-ranking.test.js` —
  pre-port shape (`primary` / `labels`); needs translation to the
  factory's `hit` / `timingState` shape.
- `coaching-export.test.js` — likely the same.

## Unit H1 — Port `_ndInjectTestWav` into the factory

**Goal:** the factory exposes a public method `injectWav(wavUrl,
durationSec)` that loads a WAV and routes it through the same
gain → analyser → processor chain that live mic input uses, runs
the detection pipeline, returns a summary.

This is the load-bearing piece. Without it, the harness has nothing
to drive. PORT_PLAN's Unit 4c.

**Reference:** `git show reference/pre-port-baseline:screen.js` line
8987 (`_ndInjectTestWav`) and 8787 (`_ndInjectTestAudio`).

**Implementation notes:**
- The factory already has a ScriptProcessor + gain node chain.
  injectWav swaps an AudioBufferSourceNode in for the mic stream.
- `enabled` must be set so `processor.onaudioprocess` actually does
  work; need a "test mode" that skips `getUserMedia` but enables the
  rest.
- Returns `{hits, misses, total, hitRate, noteResults, settings}`.
- Caller-provided chart-start-time so the matcher's chart clock is
  aligned with WAV t=0.

**Diff target:** ~250 lines.

## Unit H2 — Port `replay-baseline.js`

**Goal:** a node script that:

1. Discovers `test/fixtures/*.wav` (filtered by `--song=<glob>`
   optional).
2. Boots slopsmith via puppeteer in a headless Chrome.
3. For each WAV: reads the JSON sidecar for `chartStartTime`, seeks
   the chart, calls `window.noteDetect.injectWav(...)`, captures
   the returned summary.
4. Writes results to `test/replay-results/<timestamp>.json` and
   prints a summary table.

**Reference:** `git show reference/pre-port-baseline:test/replay-baseline.js`
— the full pre-port version. Should land on the port branch with
minimal changes; the only API surface difference is `_ndInjectTestWav`
→ `window.noteDetect.injectWav`.

**Why puppeteer:** the detection pipeline uses Web Audio APIs and
the actual YIN / HPS code shipped in screen.js. Re-implementing in
node would diverge. Puppeteer runs the real code in a real browser
context.

**Make target:** `make replay-baseline` runs all fixtures.
`make replay-baseline FIXTURE=gasoline*` filters.

**Diff target:** ~300 lines (mostly the puppeteer boilerplate).

## Unit H3 — Port `replay-fix-impact.js` + classification reports

**Goal:** before/after impact reporting. Run a fixture, save the
result. Make a code change. Run the fixture again. Diff the result
and print which notes flipped (HIT → MISS, MISS → HIT, label changes).

This is the workflow for "did my fix actually help?"

**Reference:** `replay-fix-impact.js` from the pre-port branch.

**Make target:** `make replay-impact FIXTURE=gasoline-2026-04-28T19-19-04`.

**Diff target:** ~200 lines.

## Order of execution

1. H1 first — without `injectWav`, H2 has nothing to call. H1 is
   self-contained: port the function, add a sandbox-loader test
   that loads a tiny synthetic WAV and asserts hits ≥ 1.
2. H2 second — `replay-baseline` makes the harness usable from the
   command line. Once this works I can run fixtures whenever I
   want without bothering the user.
3. H3 third — quality-of-life for iteration.

Do not start any further detector-quality work until H1 + H2 are
landed and producing baseline numbers on the user's existing
fixtures.

## Test discipline once the harness is in place

- Every detector change runs `make replay-baseline` first.
- A fixture that DEGRADES from the baseline triggers a "what
  regressed?" investigation, not a commit.
- A fixture that IMPROVES gets the new number checked in to
  `test/replay-results/baseline.json` so future regressions are
  detected.
- `make replay-baseline` runs in CI eventually; for now it's a
  developer-side guard.

## What I will NOT do

- Ask the user to play through a song to evaluate a detector change
  without first running the same change against fixtures.
- Iterate on threshold values without a fixture-based feedback loop.
- Discard a fixture that "doesn't match the new shape" without
  asking the user first — those WAVs are the user's only ground
  truth for what they actually played.

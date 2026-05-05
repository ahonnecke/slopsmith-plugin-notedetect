# Plugin context — read on every session

Things I have lost time re-discovering. If I'm about to ask the user
a question whose answer is here, re-read this file first.

## Architecture

- **Slopsmith runs in a Docker container.** The host is the user's
  machine; the container is the FastAPI server (`uvicorn server:app`)
  on port 8000, mapped to host port 8088 (`http://localhost:8088`).
- **Plugin dirs are bind-mounted READ-ONLY** from the host into the
  container at `/opt/user-plugins/note_detect`. Editing
  `/home/ahonnecke/src/slopsmith-plugin-notedetect/screen.js` on the
  host changes what the running server serves (cache-buster headers
  do the rest). BUT: the container CANNOT WRITE back into the plugin
  dir. Anything that needs to write (state files, sqlite DBs, dumps)
  must go to a writable path. Verify with
  `docker inspect slopsmith-web-1 --format '{{range .Mounts}}{{.Source}}
  -> {{.Destination}} ({{.Mode}}){{println}}{{end}}'`.
- **`/config` is the writable persistent location.** It's a docker
  named volume `slopsmith_rocksmith-config` mounted at /config (rw),
  passed to plugins as `context["config_dir"]`. Survives container
  restarts. Use `<config_dir>/note_detect/...` for plays DB,
  recordings, etc. (Same convention highway_3d / practice_journal use.)
- **`/tmp` inside the container is NOT the host's `/tmp`.** It's
  overlay/tmpfs scoped to the container. Writable but doesn't persist
  across `docker restart` and host can't read it without
  docker exec/cp.
- **`routes.py` is loaded ONCE at server startup.** Adding or editing
  `routes.py` requires a slopsmith container restart. `screen.js` is
  hot-reloaded on browser refresh thanks to cache-buster headers; the
  Python side is not.
- **Plugin manifest is `plugin.json`.** Routes registered via
  `"routes": "routes.py"`. Without that field, the loader skips the
  routes file even if it exists.

## Audio routing on this user's box

- **User runs Linux + PipeWire.** A systemd user service named
  `guitar-capture-route.service` runs a `pw-loopback` that exposes the
  Rocksmith Hercules USB Guitar Adapter as a PipeWire `Audio/Source`
  named `guitar_capture` with `device.class=sound` (so Firefox lists
  it in `enumerateDevices()`).
- **Why the routing matters for detection thresholds:** the loopback
  attenuates the signal — peak ~0.32 in Firefox vs ~1.0 from a direct
  mic grab (verified via `parec` co-recording earlier this session).
  The pre-port branch's onset-detector RMS thresholds (0.04 / 0.02)
  were tuned for the direct path; on this user's routed path RMS
  during plucks lands at 0.015–0.10 and the original thresholds never
  fired. Lowered thresholds (0.015 / 0.008) are tuned for the routed
  path and live in `_ND_ONSET_LEVEL` etc.
- See `~/.config/systemd/user/guitar-capture-route.service` for the
  unit and `~/.local/bin/guitar-capture-route` for the wrapper script.
  `memory/project_audio_routing.md` has the full diagnosis.

## Branch landscape

- **`upstream/main`** — byrongamatos/slopsmith-plugin-notedetect's
  factory-pattern (createNoteDetector closure) codebase. Smaller and
  shaped differently from the pre-port branch.
- **`reference/pre-port-baseline`** — tag at the tip of the pre-port
  branch (commit `97d73dd`). 9472-line module-globals shape. Contains
  every detector refinement the user has tuned over weeks. **Use
  `git show reference/pre-port-baseline:<path>`** to inspect during
  porting.
- **`port/from-factory`** — current working branch. Branched off
  `upstream/main`, with units of pre-port behavior ported on top.
  Status tracked in `PORT_PLAN.md`.

## Two-axis scoring

- **Detection** = HIT/total at `_ND_DETECTION_PITCH_CENTS=200` /
  `_ND_DETECTION_TIMING_SEC=0.300`. Headline number. Wide on purpose.
- **Precision** = of HITs, fraction with `timingState='OK'` AND
  `pitchState in {'OK', null}` against `_ND_PRECISION_PITCH_CENTS=25`
  / `_ND_PRECISION_TIMING_MS=50`. Independent of detection.
- The factory's `_ndMakeJudgment` takes BOTH thresholds via
  `timingHitThresholdMs` / `pitchHitThresholdCents` (wide; gates
  `hit`) and `timingPrecisionMs` / `pitchPrecisionCents` (tight;
  gates label classification). Earlier port work collapsed these
  to a single tight threshold and produced the user's "detection
  regression."

## Judgment shape

The factory matcher writes judgment objects with this shape (see
`_ndMakeJudgment` and `makeMatchedJudgment`/`makeMissJudgment`):

```
{
  hit: boolean,                  // wide threshold gate
  timingState: 'OK'|'LATE'|'EARLY'|null,  // tight gate
  pitchState:  'OK'|'SHARP'|'FLAT'|null,
  timingError: number | null,    // ms, RAW (not drift-adjusted)
  pitchError:  number | null,    // cents
  expectedMidi, detectedMidi, noteTime, ...
  ignoredAsDetectorFailure: boolean,  // flag, not a primary state
}
```

**Important:** `timingError` is the RAW player-vs-chart skew. Drift
compensation only shifts the matcher's search center; it does NOT
adjust the recorded `timingError`. That's so coaching can surface
"consistently late" without the drift estimator hiding it.

The pre-port branch used a different shape (`primary: 'HIT' |
'MISSED_NO_DETECTION' | ...`, plus a `labels: []` array). When
porting analysis code from the pre-port branch, translate to the
factory shape rather than carrying the pre-port shape forward.

## Use the make targets, not inline commands

Past sessions repeated long inline commands hundreds of times. The
common ones now have shortcuts — use them so token budget goes to
analysis, not retyping. `make help` lists everything.

| If you'd type…                                                                             | Use instead              |
|--------------------------------------------------------------------------------------------|--------------------------|
| `node --test test/yin-*.test.js \| tail -N`                                                 | `make test-yin`          |
| `node -e "new Function(require('fs').readFileSync('screen.js','utf-8'))..."`                | `make syntax`            |
| `git diff --stat && echo --- && git status -s`                                              | `make stat`              |
| `docker exec slopsmith-web-1 ls -lt /tmp/nd_recordings/` then `docker cp …`                  | `make pull-recording`    |
| `grep -nE 'pat' screen.js \| head -N`                                                       | `bin/nd-grep pat N`      |
| `node test/analyze-replay.js` / diff two replay JSONs                                       | `make replay-analyze` / `make replay-diff OLD=… NEW=…` |

If you find yourself running the same multi-pipe one-liner more than
twice, propose adding it as a target rather than typing it a third time.

## What NOT to ask the user

- "Can you paste your console output?" — the diagnostics dumper
  (Unit 4-equivalent) writes to `<plugin_dir>/diagnostics/*.json`
  on every disable + every 30s. Read those files.
- "Can you play and tell me what feels off?" — when there's an
  existing fixture-based harness (`test/replay-baseline.js`,
  pre-port branch). User play tests are precious; fixture replay
  is the right default.
- "Can you check if it's a cache problem?" — cache-buster headers
  (`no-cache, must-revalidate` + `Last-Modified`) are in place; if
  the user did Cmd-Shift-R / Ctrl-Shift-R the new screen.js is loaded.
- "Can you restart the slopsmith server?" — fine to ask once when
  routes.py changes; not fine to ask repeatedly.

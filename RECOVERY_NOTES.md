# note_detect — recovery & status (2026-06-04)

## What happened
The machine failed and was recovered. The committed bass branch
`fix/bass-and-low-note-detection` **never parsed** — 161 commits, the last 120
all fail to parse (`await` inside a non-async `ensureDrawHook`, ~line 3992, a
bad-merge boundary scramble). The actual "playing well" build was a live-edited
working copy (`make dev` hot-reload) that was **never committed in a working
state** and was lost in the crash.

## Recovery
Restored a parseable working copy from
`/mnt/data/reference.recovered/slopsmith-plugin-notedetect` (**v1.2.0**, 7032
lines) onto branch **`recover/reference-v1.2.0`**. It parses, loads against the
245-commit-merged core (routes registered, button injects at load), and has HPS
bass pitch-detection. It is an *earlier* line than the broken 15k experiment
(no `NB_BASS_OPEN` constants / later coaching+drill).

## Merged-core adaptations applied
- Gear settings popover: pinned layout + z-index **inline** — its arbitrary
  Tailwind classes (`z-[150]`, `w-80`…) don't exist in core's **prebuilt**
  Tailwind (Principle II, no Play CDN), so it rendered behind the highway.
- Audio Latency Offset slider widened **250 → 500 ms** (real chain ≈300 ms).

## Monitoring
"Hear yourself" is the **OS PipeWire loopback** (`make monitor-on` →
module-loopback Rocksmith adapter → default sink, 50 ms), NOT in-app. Re-run
after reboot; `make monitor-off` to stop.

## Known issues (next session)
- **Coaching-review overlay** takes the whole page, no scroll / no exit.
- After **declining** coaching review, **"Calibrate from this play" is
  unclickable** (a leftover overlay still capturing pointer events).
- **Scoring**: a good-but-imperfect play ("Gasoline") reported **100% accuracy**.
- **Per-song reset is dead**: v1.2.0 resets via a `window.playSong` wrapper the
  merged core never calls (it uses local `playSong` + `song:*` events) → stale
  state on song change. Port to `window.slopsmith.on('song:loaded', …)`.
- **Systemic fix for the overlay/styling bugs**: ship a compiled plugin
  stylesheet via the **`styles` manifest key** (docs/plugin-styles.md). One fix
  covers the gear, coaching, summary, and visual-cal overlays — the inline
  patches above are per-overlay band-aids.

## Roadmap / intent
- **North star: a teaching tool** — the whole point is learning guitar. Analysis
  has been programmatic; consider having **AI analyze the recording JSON** (using
  the user's API key) for coaching feedback.
- **Auto-latency**: don't make the user set the offset by hand — derive it
  (AudioContext.outputLatency seed + calibrate-from-play, made robust).
- **Upstream**: PR the bits that were hard to merge; locate the test harness and
  check whether it's upstream; review the new upstream features that came down.

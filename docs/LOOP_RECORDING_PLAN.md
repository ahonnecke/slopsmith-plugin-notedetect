# Loop-based recording — what's already there, what's missing

User goal: instead of recording a 3-minute song where the player makes
inconsistent mistakes, loop a short passage many times, take the best read.
Better validation data per minute of playing, and the player can actually
get clean attempts on the hard sections.

## What already exists

### Slopsmith side (no plugin changes needed)

- **A/B loop UI**: `setLoopStart()` / `setLoopEnd()` buttons in
  `static/index.html`, state in `static/app.js` (`loopA`, `loopB`).
  Audio playback honours the A/B markers — when `currentTime` reaches B,
  it jumps to A.
- **Saved-loops persistence**: SQLite `loops` table in `server.py`,
  `/api/loops` GET/POST/DELETE. Loops are scoped by audio filename; a
  named loop is a `(filename, name, start_time, end_time)` row.
- Saved-loops dropdown loads them, `Save` button writes the current A/B
  range under an auto-incrementing name ("Loop 1", "Loop 2", ...).

### Plugin side (this repo)

- **Loop-restart detector** (`screen.js:806`): inside `_ndCheckAutoDump`,
  when `highway.getTime()` jumps backward by >1s the plugin treats it as
  a new loop iteration: fires `_ndAutoDumpPost()` and
  `_ndSnapshotPlay('loop_restart')`.
- **Per-play snapshots** (`screen.js:763`, `_ndSnapshotPlay`): each
  iteration POSTs a `{songId, playId, reason, startedAt, noteResults[]}`
  payload to `/api/plugins/note_detect/plays`. After serializing, it
  clears `_ndNoteResults` so the next iteration re-judges every chart
  note from scratch (the existing `_ndNoteResults.has(key)` guard would
  otherwise stick the first iteration's verdict across all subsequent
  loops).
- **Server storage** (`routes.py:92`): plays are stored under
  `<song_dir>/<playId>.json`, pruned to `PLAYS_KEEP_PER_SONG` entries.
- **Audio recording**: `_ndRecordStart(maxSeconds, filename)` captures a
  single continuous WAV with a chart-time anchor. Already gated to start
  on the first sample after the chart clock advances, so WAV t=0 lines up
  with chartT=0.

## What's missing for the user's workflow

Two gaps. Neither needs a plugin change — both are offline tooling on top
of the data we already collect.

### Gap 1: per-iteration classifier

Today's `make session-report` runs against ONE WAV + ONE dump and produces
one set of buckets. It doesn't know about loop iterations. Two ways to
adapt:

**Option A — aggregate the per-play JSON files (no WAV split).**
For a session with N loop iterations:

- Pull all `<song_dir>/<playId>.json` files for the song
- Join them by chart-note key (`chartT_string_fret`)
- For each chart note, produce a result vector: `[HIT, MISS, HIT, HIT, MISS]`
  across the N attempts
- Aggregate: best-of-N (1 if any attempt was HIT), worst-of-N, fraction-hit

Pros: uses existing data, zero plugin work, fast to build.
Cons: doesn't expose audio-truth. We can't tell whether a missed attempt
was a player error or a pipeline bug — only the live verdict.

**Option B — split the WAV by loop boundaries, classify each segment.**
The recording is a single continuous WAV. If we know the A/B loop times
(from the slopsmith DB) and the loop-restart timestamps (from the play
snapshots), we can carve the WAV into per-iteration sub-WAVs and run the
existing classifier on each. This gives per-iteration audio-truth +
pipeline buckets.

Pros: full classifier output per attempt. Lets us see if the same
sustain-bleed pattern shows up on every iteration's same-pitch transition.
Cons: more plumbing, requires reading the slopsmith loops DB or
reconstructing iteration boundaries from play timestamps.

### Gap 2: best-of-N score + diff report

Once Gap 1 is done, the report needs a different shape:

- **Best-of-N score**: chart note counts as hit if ≥1 attempt hit it.
- **Consistency score**: fraction of attempts that hit each note. Notes
  consistently missed → likely real player or pipeline weak spot. Notes
  hit sometimes → noise / inconsistency.
- **Per-note attempt vector**: `s0/f3 (MIDI 31) @47.05s: HIT MISS HIT HIT MISS`
  for the user to spot patterns.
- **"Practice these" pull-out**: top notes by miss rate across attempts.

## Recommended path

1. Start with **Option A** for Gap 1. It's a thin wrapper over `/api/plugins/note_detect/plays` that produces a per-attempt result matrix. Should be one new script (`test/aggregate-plays.js`) and a `make` target.
2. Wire it into the existing `session-report.js` so a multi-play song produces both the aggregate and the per-attempt breakdown in the same markdown.
3. **Defer Option B** until we actually need audio-truth per iteration. The
   per-play pipeline-verdict data alone should be enough to answer "which
   notes do you consistently miss across N attempts" — which is the core
   value of looping.

## Useful when we resume sustain-bleed work

The bleed problem is hard to validate in a 3-minute song because the
player can't reproduce the same soft-pluck-after-sustain pattern reliably.
If the user can loop a 10-second passage that hits the bleed pattern
consistently, we get N independent samples of the failing notes per
minute of playing. That's the validation harness the bleed work needs.

A natural fixture: the "Level" passage from chartT≈30s to chartT≈45s —
contains five same-pitch-31-into-soft-28 transitions back-to-back, the
exact bleed shape. Turn it into a saved slopsmith loop, play it 10 times,
and we have ~50 attempts at the bleed-prone notes for any future
detection-quality work.

## Open question

The slopsmith `loops` table is keyed on `filename` (the audio file). To
link a session WAV/dump to a specific loop entry, the plugin would need
to capture the loop name (or A/B times) at recording time. Currently the
plugin doesn't read slopsmith's loop state. Two paths:

- The plugin reads the active loop A/B from `window.loopA` / `window.loopB`
  when recording starts, stores it in the dump's `settings`. Cheap.
- The aggregator reads the loops from `/api/loops` and matches by
  filename + recording timestamp. More work, no plugin change.

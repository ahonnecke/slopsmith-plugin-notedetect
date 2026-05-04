# Note Failure / Practice Feedback (v1 — done 2026-04-25)

Post-session report MVP shipped:
- Per-note severity captured (NO_DETECTION / WRONG_PITCH / imperfect HIT)
- Per-play history persisted under `/tmp/nd_plays/<songId>/` (last 10 retained)
- Snapshot triggers: loop restart, detect-off, song change
- "Practice these (last N plays)" ranked list in the post-session modal
  (`miss_count × avg_severity`, severity-bar + dominant failure mode per row)
- "View Report" button in the gear menu (open mid-session)
- 16 unit tests for severity / ranking / failure-mode (`test/practice-ranking.test.js`)
- 22-check round-trip harness for the storage/prune path (`test/plays-roundtrip.py`,
  `make test-plays-roundtrip`)
- Hardened `_safe_song_dir` against `..` and `.` path-traversal songIds

# Auto Play on Detect — done 2026-04-24

`<audio id="audio">` 'play' event auto-enables Detect when
`_ndAutoDetectOnPlay` is true (default). Toggle in the gear-menu settings panel.

# Deferred (future work)

- Highway marker placement: currently rendered below the highway via
  `_ND_MISS_LOOKBACK = 15s`. The TODO wanted them ON the highway near each
  chord bar (Rocksmith parity). Not done.
- Cross-loop persistence on the *highway* itself (markers from past loop
  iterations dimmed alongside the current pass). The report aggregates across
  plays, but the live highway markers still fade after 15s.
- Histograms: timing-error and pitch-error distributions across all hits.
- 1D hotspot timeline strip under the highway.
- "Suggest a loop region" — find dense-miss windows and propose Riff Repeater
  bounds.
- Per-fret/string fretboard heatmap.

# investigate
recording a loop instead of a whole song, I could likely play it more accurately
and or we could record it a few times and take the best version

The "speed" slider needs to be wayy more granular, like a percentage of full
speed set to 100 granular

## Drill-record ground-truth fixtures

Whole-song WAVs are noisy validation fixtures: every miss is ambiguous (player
error vs detector limit), so when a detector change moves the HIT count by
N notes we can't tell whether N notes got better detection or N notes were
just played differently this time. The sim has no way to verify itself
against live behavior because there's no clean ground truth.

**Idea:** drill-mode workflow — user drills a short region (~8 notes) until
they think it's perfect, then a "Capture as fixture" button saves:
- the WAV slice for that loop iteration
- the chart notes the loop covered
- a `played_perfectly: true` flag the user explicitly set

Stored under `test/fixtures/ground-truth/drill-<song>-<section>-<timestamp>.{wav,json}`.

Why this unblocks sim work: when the user asserts they nailed the drill,
*every chart note in the WAV is a definite HIT* by player intent. A detector
change can be measured directly: how many of the ground-truth HITs did the
detector miss? No more "is the player or the detector at fault" ambiguity.

**Shape of the work:**
- drill-mode UI already loops a section, so the trigger surface is small —
  add a button next to the existing drill controls
- saver reuses `/api/plugins/note_detect/recording` (already saves WAVs)
  with a flag to mark it as a ground-truth fixture
- `test/spectral-flux-sim.js` and `test/onset-sim.js` learn to read the
  ground-truth flag and report misses against player-asserted HITs only

**Not done.** Build when sim validation becomes a blocker again — likely
the next time we try to ship a detector change.


# BUG: detect disables USB audio out — RESOLVED 2026-05-03

Root cause: Firefox's `getUserMedia` on the Rocksmith hardware source caused
PipeWire to renegotiate the source's graph (mono→stereo upmix node), corking
the user's pre-existing `module-loopback` to speakers. Compounded by ~50 dB
attenuation on Firefox's audio path (verified via `parec` co-recording:
device-direct peak 0.537, Firefox-side peak 0.0014).

Fix: user-side systemd service (`~/.config/systemd/user/guitar-capture-route.service`,
wrapper at `~/.local/bin/guitar-capture-route`) runs a `pw-loopback` exposing
`guitar_capture` as `Audio/Source` (`device.class=sound` so Firefox lists it;
`module-remap-source` couldn't be used because it forces `device.class=filter`
which Firefox hides). Both consumers (speakers loopback + guitar_capture) are
pinned permanently to the Rocksmith, so Firefox toggling getUserMedia on
`guitar_capture` doesn't touch the hardware graph.

Baseline established: with this routing + `_ndInputGain=1.0`, plays score
accurately and coaching feedback ("you could mute better") matches the
user's self-assessment of the play.

Original log preserved below for grep:

I had to go detect/nodetect/detect/nodetect/detect to get the instrument audio working, this bug seems worsk
[note_detect] Trouble map fetching for songId="unknown__default" screen.js:966:17
Loading: Extracting... highway.js:993:33
[note_detect] Trouble map fetch returned 0 play(s) screen.js:968:17
[note_detect] Trouble map empty — no prior plays for songId="unknown__default". screen.js:971:21
Highway ready: 305 notes, 0 chords highway.js:1124:33
[note_detect] Song info: {"title":"Gasoline","arrangement":"Bass","tuning":[0,0,0,0,0,0],"tuningType":"object","capo":0} screen.js:6695:17
[note_detect] YIN pre-filter: 30-250 Hz band-pass @ 48000 Hz (4th-order Butterworth) screen.js:1971:17
[note_detect] HUD created in #player screen.js:4308:13
[note_detect] Trouble map fetching for songId="Gasoline__Bass" screen.js:966:17
[note_detect] Trouble map fetch returned 10 play(s) screen.js:968:17
[note_detect] Trouble map loaded: 11 notes aggregated across 10 play(s) screen.js:978:17
[note_detect] Trouble keys sample: ["1|5|9.95","1|5|10.305","1|5|11.01","1|5|12.775","1|5|13.125"] screen.js:984:17
[note_detect] Chart keys sample (first frame): ["1|5|9.95","1|5|10.305","1|5|11.01","1|5|12.775","1|5|13.125"] screen.js:6255:21
[note_detect] Chart keys matching trouble map: 11 of 11 trouble entries screen.js:6272:21
[note_detect] AudioContext state → running screen.js:2732:21
[note_detect] session boundary: detect_off (results=0, lastId=null, drill=false) screen.js:4777:13
[note_detect] no playId resolved — skipping review (source=detect_off) screen.js:4807:17
[note_detect] AudioContext state → undefined screen.js:2732:21
[note_detect] Song info: {"title":"Gasoline","arrangement":"Bass","tuning":[0,0,0,0,0,0],"tuningType":"object","capo":0} screen.js:6695:17
[note_detect] YIN pre-filter: 30-250 Hz band-pass @ 48000 Hz (4th-order Butterworth) screen.js:1971:17
[note_detect] HUD created in #player screen.js:4308:13
[note_detect] Trouble map fetching for songId="Gasoline__Bass" screen.js:966:17
[note_detect] Trouble map fetch returned 10 play(s) screen.js:968:17
[note_detect] Trouble map loaded: 11 notes aggregated across 10 play(s) screen.js:978:17
[note_detect] Trouble keys sample: ["1|5|9.95","1|5|10.305","1|5|11.01","1|5|12.775","1|5|13.125"] screen.js:984:17
[note_detect] AudioContext state → running screen.js:2732:21
[note_detect] Chart keys sample (first frame): ["1|5|9.95","1|5|10.305","1|5|11.01","1|5|12.775","1|5|13.125"] screen.js:6255:21
[note_detect] Chart keys matching trouble map: 11 of 11 trouble entries screen.js:6272:21


# Gamified "Rocksmith-mode" plugin variant (future)

Strip the diagnostic UI down to a single-score experience that reads like
Rocksmith: one big number, no labels, no clusters, no histograms,
optionally streak / multiplier / combo mechanics. The current plugin is
a *practice instrument* — it surfaces the failure modes a player needs to
see to improve. A gamified variant would be a *game instrument* — it
hides the analysis and rewards the hit count.

Should ship as a separate plugin id (different folder, different
manifest), not a toggle inside the existing one. Keeping the modes
physically separate avoids the temptation to gate every feature on
"is gamified mode on" — the practice plugin stays focused on the
practice job, the game plugin stays focused on the game job.

Reuse points:
- detection pipeline (YIN, onset, matcher) — keep identical
- `_ndScoresFromNotes` — `detection` field IS the headline number a
  Rocksmith-mode HUD would display
- play storage — gamified plays should write the same JSON format so
  history aggregation across both plugins still works

Game-side additions:
- streak / combo / multiplier scoring layered on top of HIT/MISS
- one-screen end-of-song result (score, accuracy, best streak), no
  drill suggestions or coaching modal
- maybe per-section grades (S/A/B/C) instead of cluster analysis

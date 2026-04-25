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

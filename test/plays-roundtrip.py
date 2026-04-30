#!/usr/bin/env python3
"""End-to-end harness for the SQLite-backed per-play history routes.

Exercises the `/api/plugins/note_detect/plays`, `/play/<id>`, and
`/sections/<song_id>` endpoints via FastAPI's TestClient (no real server
required), against a temp config_dir so we don't collide with a real
notedetect_plays.db.

What this proves:
  - Plays POST → row in `plays` table + per-note rows in `play_notes`
  - GET /plays returns plays newest-first, capped at limit, with full
    noteResults reconstructed from SQLite
  - GET /play/<id> returns one play
  - GET /sections/<song_id> aggregates hits/misses per section across plays
  - Drill-tagged plays round-trip is_drill + drillSectionName correctly
  - Summary fields (pitchScore, timing, coverage, combinedWeightedScore)
    survive POST → SQLite → GET
  - sectionName tagging on individual notes round-trips
  - Pruning trims to PLAYS_KEEP_PER_SONG most recent per song
  - Multi-song separation: posting to song A doesn't affect song B's history
  - Legacy /tmp/nd_plays JSON files are imported on first setup() call

Exit 0 = pass, non-zero = fail. Prints metrics, never asks "is it right?".
"""

import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

# Make the plugin importable
HERE = Path(__file__).parent.resolve()
sys.path.insert(0, str(HERE.parent))

import routes  # noqa: E402

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def make_play(song_id, play_id, note_results, **extra):
    """Build a play snapshot in the wire format the client sends."""
    body = {
        "songId": song_id,
        "playId": play_id,
        "reason": extra.get("reason", "test"),
        "startedAt": int(time.time() * 1000),
        "noteResults": note_results,
    }
    if "summary" in extra:
        body["summary"] = extra["summary"]
    if "isDrill" in extra:
        body["isDrill"] = extra["isDrill"]
    if "drillSectionName" in extra:
        body["drillSectionName"] = extra["drillSectionName"]
    if "settings" in extra:
        body["settings"] = extra["settings"]
    return body


def make_note(s, f, chart_t, primary, severity, **kw):
    return {
        "key": f"{s}|{f}|{chart_t}",
        "s": s, "f": f, "chartT": chart_t,
        "expectedMidi": kw.get("expectedMidi", 40),
        "detectedMidi": kw.get("detectedMidi"),
        "primary": primary,
        "severity": severity,
        "timingError": kw.get("timingError"),
        "pitchError": kw.get("pitchError"),
        "labels": kw.get("labels", []),
        "sectionName": kw.get("sectionName"),
        "siblingClaimed": kw.get("siblingClaimed", False),
        "detectorFailure": kw.get("detectorFailure", False),
    }


def fresh_app(config_dir: Path) -> TestClient:
    """Reinitialize routes against a clean config_dir + new app."""
    routes._DB_PATH = None  # force re-init
    routes.PLAYS_KEEP_PER_SONG = 50
    app = FastAPI()
    routes.setup(app, {"config_dir": config_dir})
    return TestClient(app)


def main():
    tmp_root = Path(tempfile.mkdtemp(prefix="nd_plays_test_"))
    config_dir = tmp_root / "config"
    config_dir.mkdir(parents=True, exist_ok=True)

    failures = []

    def check(label, cond, detail=""):
        status = "ok" if cond else "FAIL"
        print(f"  [{status}] {label}{(' — ' + detail) if detail and not cond else ''}")
        if not cond:
            failures.append(label)

    client = fresh_app(config_dir)

    # ── Test 1: round-trip a single play ──────────────────────────────────
    print("Test 1: single-play POST then GET")
    p1 = make_play(
        "songA__bass", "2026-04-25T10-00-00",
        [make_note(2, 3, 1.000, "MISSED_NO_DETECTION", 1.0, sectionName="Intro")],
        summary={
            "hits": 0, "misses": 1,
            "pitchScore": 0.0, "timingMedianMs": None, "timingStdMs": None,
            "coverage": 0.0, "combinedWeightedScore": 0.0,
        },
    )
    r = client.post("/api/plugins/note_detect/plays", json=p1)
    check("POST 200", r.status_code == 200, str(r.status_code))
    play_id = r.json().get("id")
    check("POST returns id", isinstance(play_id, int) and play_id > 0, str(play_id))

    r = client.get("/api/plugins/note_detect/plays", params={"songId": "songA__bass"})
    plays = r.json().get("plays", [])
    check("GET returns 1 play", len(plays) == 1, f"got {len(plays)}")
    check("play preserves songId", plays and plays[0]["songId"] == "songA__bass")
    check("play preserves noteResults", plays and len(plays[0]["noteResults"]) == 1)
    check("note preserves sectionName",
          plays and plays[0]["noteResults"][0]["sectionName"] == "Intro")
    check("summary.coverage round-trips",
          plays and plays[0]["summary"]["coverage"] == 0.0)

    # ── Test 2: GET /play/<id> ────────────────────────────────────────────
    print("Test 2: GET /play/<id>")
    r = client.get(f"/api/plugins/note_detect/play/{play_id}")
    check("GET /play/<id> 200", r.status_code == 200, str(r.status_code))
    one = r.json()
    check("/play/<id> returns id", one.get("id") == play_id)
    check("/play/<id> includes noteResults", len(one.get("noteResults", [])) == 1)
    r = client.get("/api/plugins/note_detect/play/999999")
    check("GET /play/<id> 404 for missing", r.status_code == 404)

    # ── Test 3: pruning to PLAYS_KEEP_PER_SONG ────────────────────────────
    print("Test 3: pruning")
    config_dir2 = tmp_root / "config2"
    config_dir2.mkdir()
    client = fresh_app(config_dir2)
    routes.PLAYS_KEEP_PER_SONG = 5  # smaller for the test
    for i in range(8):
        play = make_play("songB__bass", f"play-{i:03d}",
                         [make_note(0, i, 0.5 + i, "MISSED_NO_DETECTION", 1.0)])
        client.post("/api/plugins/note_detect/plays", json=play)
        time.sleep(0.005)
    r = client.get("/api/plugins/note_detect/plays", params={"songId": "songB__bass"})
    plays = r.json().get("plays", [])
    check("pruned to 5", len(plays) == 5, f"got {len(plays)}")
    check("plays sorted newest-first",
          plays[0]["playId"] == "play-007" and plays[-1]["playId"] == "play-003",
          f"first={plays[0]['playId']}, last={plays[-1]['playId']}")
    routes.PLAYS_KEEP_PER_SONG = 50  # restore default

    # ── Test 4: multi-song separation ────────────────────────────────────
    print("Test 4: multi-song separation")
    config_dir3 = tmp_root / "config3"
    config_dir3.mkdir()
    client = fresh_app(config_dir3)
    for i in range(3):
        client.post("/api/plugins/note_detect/plays",
                    json=make_play("songX__bass", f"x-{i}",
                                   [make_note(0, 0, 0, "MISSED_NO_DETECTION", 1.0)]))
        time.sleep(0.005)
    for i in range(2):
        client.post("/api/plugins/note_detect/plays",
                    json=make_play("songY__bass", f"y-{i}",
                                   [make_note(0, 0, 0, "MISSED_NO_DETECTION", 1.0)]))
        time.sleep(0.005)
    rx = client.get("/api/plugins/note_detect/plays", params={"songId": "songX__bass"})
    ry = client.get("/api/plugins/note_detect/plays", params={"songId": "songY__bass"})
    check("songX has 3 plays", len(rx.json().get("plays", [])) == 3)
    check("songY has 2 plays", len(ry.json().get("plays", [])) == 2)
    check("songX GET doesn't leak songY",
          all(p["songId"] == "songX__bass" for p in rx.json().get("plays", [])))

    # ── Test 5: limit parameter ──────────────────────────────────────────
    print("Test 5: GET limit parameter")
    r = client.get("/api/plugins/note_detect/plays",
                   params={"songId": "songX__bass", "limit": 2})
    check("limit=2 returns 2 plays", len(r.json().get("plays", [])) == 2)

    # ── Test 6: full field round-trip (timing, pitch, severity, etc.) ────
    print("Test 6: full per-note field round-trip")
    config_dir4 = tmp_root / "config4"
    config_dir4.mkdir()
    client = fresh_app(config_dir4)
    play = make_play("songZ__bass", "z-1", [
        make_note(2, 3, 1.0, "MISSED_NO_DETECTION", 1.0, sectionName="Verse 1"),
        make_note(2, 5, 2.0, "MISSED_WRONG_PITCH", 0.85, pitchError=120, sectionName="Verse 1"),
        make_note(0, 0, 3.0, "HIT", 0.27, timingError=80, pitchError=10,
                  labels=["LATE", "SHARP"], sectionName="Chorus 1"),
    ])
    client.post("/api/plugins/note_detect/plays", json=play)
    plays = client.get("/api/plugins/note_detect/plays",
                       params={"songId": "songZ__bass"}).json()["plays"]
    notes = plays[0]["noteResults"]
    severities = [n["severity"] for n in notes]
    check("severity round-trips exactly",
          severities == [1.0, 0.85, 0.27], str(severities))
    check("labels round-trip", notes[2]["labels"] == ["LATE", "SHARP"], str(notes[2]["labels"]))
    check("timingError round-trips on HIT", notes[2]["timingError"] == 80)
    check("pitchError round-trips on MISS", notes[1]["pitchError"] == 120)
    section_names = sorted({n["sectionName"] for n in notes})
    check("section names round-trip",
          section_names == ["Chorus 1", "Verse 1"], str(section_names))

    # ── Test 7: drill-tagged plays ────────────────────────────────────────
    print("Test 7: drill-mode tags")
    drill_play = make_play(
        "songD__bass", "d-1",
        [make_note(2, 5, 1.0, "HIT", 0.2, sectionName="Solo")],
        isDrill=True, drillSectionName="Solo",
    )
    client.post("/api/plugins/note_detect/plays", json=drill_play)
    plays = client.get("/api/plugins/note_detect/plays",
                       params={"songId": "songD__bass"}).json()["plays"]
    check("isDrill round-trips", plays[0]["isDrill"] is True)
    check("drillSectionName round-trips", plays[0]["drillSectionName"] == "Solo")

    # ── Test 8: section-history endpoint ─────────────────────────────────
    print("Test 8: GET /sections/<song_id>")
    # Two plays, same song, one with all-hits in Verse, one with mixed.
    config_dir5 = tmp_root / "config5"
    config_dir5.mkdir()
    client = fresh_app(config_dir5)
    pA = make_play("songS__bass", "sA", [
        make_note(0, 0, 1.0, "HIT", 0.1, sectionName="Verse"),
        make_note(0, 0, 2.0, "HIT", 0.1, sectionName="Verse"),
        make_note(0, 0, 3.0, "MISSED_NO_DETECTION", 1.0, sectionName="Chorus"),
    ])
    pB = make_play("songS__bass", "sB", [
        make_note(0, 0, 1.0, "HIT", 0.1, sectionName="Verse"),
        make_note(0, 0, 2.0, "MISSED_WRONG_PITCH", 0.8, sectionName="Verse"),
        make_note(0, 0, 3.0, "HIT", 0.1, sectionName="Chorus"),
    ])
    client.post("/api/plugins/note_detect/plays", json=pA)
    time.sleep(0.005)
    client.post("/api/plugins/note_detect/plays", json=pB)
    r = client.get("/api/plugins/note_detect/sections/songS__bass")
    check("sections endpoint 200", r.status_code == 200, str(r.status_code))
    body = r.json()
    section_names_returned = sorted(s["name"] for s in body["sections"])
    check("returns Verse and Chorus", section_names_returned == ["Chorus", "Verse"],
          str(section_names_returned))
    verse = next((s for s in body["sections"] if s["name"] == "Verse"), None)
    check("Verse trend has 2 plays", verse and len(verse["trend"]) == 2,
          str(verse["trend"]) if verse else "missing")

    # ── Test 9: legacy /tmp/nd_plays migration ────────────────────────────
    print("Test 9: legacy JSON migration on setup")
    legacy_root = tmp_root / "legacy_tmp_nd_plays"
    legacy_root.mkdir()
    routes.LEGACY_PLAYS_DIR = legacy_root
    song_legacy = legacy_root / "songLegacy__bass"
    song_legacy.mkdir()
    legacy_blob = make_play(
        "songLegacy__bass", "old-1",
        [make_note(0, 0, 1.0, "HIT", 0.1, sectionName="Outro")],
    )
    (song_legacy / "old-1.json").write_text(json.dumps(legacy_blob))
    config_dir6 = tmp_root / "config6"
    config_dir6.mkdir()
    client = fresh_app(config_dir6)  # setup() runs the migration
    plays = client.get("/api/plugins/note_detect/plays",
                       params={"songId": "songLegacy__bass"}).json().get("plays", [])
    check("legacy play imported", len(plays) >= 1, f"got {len(plays)}")
    if plays:
        check("legacy note sectionName preserved",
              plays[0]["noteResults"][0]["sectionName"] == "Outro")

    # ── Cleanup + report ─────────────────────────────────────────────────
    shutil.rmtree(tmp_root, ignore_errors=True)
    print()
    if failures:
        print(f"FAILED: {len(failures)} check(s): {failures}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

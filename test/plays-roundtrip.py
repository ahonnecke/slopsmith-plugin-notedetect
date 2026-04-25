#!/usr/bin/env python3
"""End-to-end harness for the per-play history routes.

Exercises POST /api/plugins/note_detect/plays and GET .../plays via FastAPI's
TestClient (no real server required), against a temp PLAYS_DIR so we don't
collide with /tmp/nd_plays from a real session.

What this proves:
  - Synthetic plays serialize and persist as separate JSON files
  - Pruning trims to PLAYS_KEEP_PER_SONG (10) most recent per song
  - GET returns plays mtime-sorted, newest first, capped at limit
  - songId path sanitization handles slashes / unsafe chars without escaping
    the song directory
  - Multi-song separation: posting to song A doesn't affect song B's history

Exit 0 = pass, non-zero = fail. Prints metrics, never asks "is it right?".
"""

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


def make_play(song_id, play_id, note_results):
    return {
        "songId": song_id,
        "playId": play_id,
        "reason": "test",
        "startedAt": int(time.time() * 1000),
        "noteResults": note_results,
    }


def make_note(s, f, chart_t, primary, severity, **kw):
    return {
        "key": f"{s}|{f}|{chart_t}",
        "s": s, "f": f, "chartT": chart_t,
        "expectedMidi": 40,
        "primary": primary,
        "severity": severity,
        "timingError": kw.get("timingError"),
        "pitchError": kw.get("pitchError"),
        "labels": [],
    }


def main():
    tmp = Path(tempfile.mkdtemp(prefix="nd_plays_test_"))
    routes.PLAYS_DIR = tmp
    routes.PLAYS_KEEP_PER_SONG = 10

    app = FastAPI()
    routes.setup(app, {})
    client = TestClient(app)

    failures = []

    def check(label, cond, detail=""):
        status = "ok" if cond else "FAIL"
        print(f"  [{status}] {label}{(' — ' + detail) if detail and not cond else ''}")
        if not cond:
            failures.append(label)

    # ── Test 1: round-trip a single play ──────────────────────────────────
    print("Test 1: single-play POST then GET")
    p1 = make_play("songA__bass", "2026-04-25T10-00-00",
                   [make_note(2, 3, 1.000, "MISSED_NO_DETECTION", 1.0)])
    r = client.post("/api/plugins/note_detect/plays", json=p1)
    check("POST 200", r.status_code == 200, str(r.status_code))
    check("POST returns ok", r.json().get("ok") is True)

    r = client.get("/api/plugins/note_detect/plays", params={"songId": "songA__bass"})
    plays = r.json().get("plays", [])
    check("GET returns 1 play", len(plays) == 1, f"got {len(plays)}")
    check("play preserves songId", plays and plays[0]["songId"] == "songA__bass")
    check("play preserves noteResults", plays and len(plays[0]["noteResults"]) == 1)

    # ── Test 2: prune to PLAYS_KEEP_PER_SONG ──────────────────────────────
    print("Test 2: pruning to 10 latest")
    # Reset and POST 15 plays
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True, exist_ok=True)
    for i in range(15):
        play = make_play("songB__bass", f"play-{i:03d}",
                         [make_note(0, i, 0.5 + i, "MISSED_NO_DETECTION", 1.0)])
        client.post("/api/plugins/note_detect/plays", json=play)
        time.sleep(0.005)  # ensure mtime ordering is stable
    r = client.get("/api/plugins/note_detect/plays", params={"songId": "songB__bass"})
    plays = r.json().get("plays", [])
    check("pruned to 10 plays", len(plays) == 10, f"got {len(plays)}")
    # Newest-first ordering: most recent playId should be at index 0
    check("plays sorted newest-first",
          plays[0]["playId"] == "play-014" and plays[-1]["playId"] == "play-005",
          f"first={plays[0]['playId']}, last={plays[-1]['playId']}")
    # Disk-side: only 10 files exist for songB
    song_dir = tmp / "songB__bass"
    on_disk = list(song_dir.glob("*.json"))
    check("disk shows 10 files", len(on_disk) == 10, f"got {len(on_disk)}")

    # ── Test 3: songId sanitization (no path traversal) ──────────────────
    print("Test 3: songId path sanitization")
    # Snapshot tmp's direct children before the malicious POST so we can
    # diff what got created. Also snapshot tmp.parent so we can prove the
    # POST didn't create anything outside PLAYS_DIR.
    before_in_tmp = set(p.name for p in tmp.iterdir())
    before_in_parent = set(p.name for p in tmp.parent.iterdir())
    bad_id = "../../../etc/passwd"
    play = make_play(bad_id, "evil",
                     [make_note(0, 0, 0.0, "MISSED_NO_DETECTION", 1.0)])
    client.post("/api/plugins/note_detect/plays", json=play)
    after_in_tmp = set(p.name for p in tmp.iterdir())
    after_in_parent = set(p.name for p in tmp.parent.iterdir())
    new_in_tmp = after_in_tmp - before_in_tmp
    new_outside = after_in_parent - before_in_parent
    check("no new dirs/files outside PLAYS_DIR", len(new_outside) == 0,
          f"unexpected siblings: {new_outside}")
    check("exactly one new sanitized dir inside PLAYS_DIR", len(new_in_tmp) == 1,
          f"new entries: {new_in_tmp}")
    sanitized_name = next(iter(new_in_tmp), "")
    check("sanitized name has no path separators",
          "/" not in sanitized_name, f"name={sanitized_name!r}")
    # The killer cases: songId="." or ".." would resolve outside PLAYS_DIR
    # without explicit handling (".." → PLAYS_DIR.parent; "." → PLAYS_DIR
    # itself, mixing files with subdirs). Verify the *resolved* path always
    # sits strictly under PLAYS_DIR — direct static check on _safe_song_dir,
    # which is the function that would be exploited.
    plays_dir_resolved = tmp.resolve()
    for evil in (".", "..", "", "../../..", "/etc/passwd", "../"):
        resolved = routes._safe_song_dir(evil).resolve()
        is_inside = resolved != plays_dir_resolved and \
                    str(resolved).startswith(str(plays_dir_resolved) + "/")
        check(f"songId={evil!r} resolves strictly under PLAYS_DIR",
              is_inside, f"resolved={resolved}")

    # ── Test 4: multi-song separation ────────────────────────────────────
    print("Test 4: multi-song separation")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True, exist_ok=True)
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

    # ── Test 6: severity field is preserved through round-trip ───────────
    print("Test 6: severity preserved through round-trip")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True, exist_ok=True)
    play = make_play("songZ__bass", "z-1", [
        make_note(2, 3, 1.0, "MISSED_NO_DETECTION", 1.0),
        make_note(2, 5, 2.0, "MISSED_WRONG_PITCH", 0.85, pitchError=120),
        make_note(0, 0, 3.0, "HIT", 0.27, timingError=80, pitchError=10),
    ])
    client.post("/api/plugins/note_detect/plays", json=play)
    plays = client.get("/api/plugins/note_detect/plays",
                       params={"songId": "songZ__bass"}).json()["plays"]
    severities = [n["severity"] for n in plays[0]["noteResults"]]
    check("3 severity values preserved exactly",
          severities == [1.0, 0.85, 0.27], str(severities))

    # ── Cleanup + report ─────────────────────────────────────────────────
    shutil.rmtree(tmp, ignore_errors=True)
    print()
    if failures:
        print(f"FAILED: {len(failures)} check(s): {failures}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

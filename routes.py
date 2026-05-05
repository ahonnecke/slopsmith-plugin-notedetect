"""Server-side routes for the note detection plugin.

Three concerns live here:

1. Diagnostics dump endpoint (POST/GET /diagnostics) — periodic state
   capture so the user doesn't have to paste console output.
2. Fixture serving (GET /fixtures, /fixtures/{name}) — replay
   harness consumes these for offline detector validation.
3. Plays storage (POST /plays, GET /plays, GET /play/{id}) — Unit S.1.
   SQLite-backed snapshots of session-end note results so the modal,
   history view, prescriptions, and fretboard heatmap can show
   improvement-over-time + cross-play aggregates.

All three use the bind-mounted plugin directory (NOT /tmp, which is
tmpfs inside the slopsmith container) so files persist across
container restarts and are readable from the host.
"""

from __future__ import annotations

import json
import re
import sqlite3
import time
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse


# Write to the plugin's own directory rather than /tmp because
# slopsmith typically runs in a container where /tmp is tmpfs and
# Diagnostics dump dir is resolved lazily in setup() under
# context["config_dir"] for the same reason plays.db is — the plugin
# bind-mount is READ-ONLY inside the container, so any path under
# Path(__file__).parent fails silently with "read-only filesystem"
# on every write. The earlier note suggesting `<plugin_dir>/diagnostics/`
# was wrong and explains why no diagnostics were ever collected.
_DIAG_DIR: Path | None = None
# Fixture WAVs live under test/fixtures/ on the host (bind-mounted
# into the container at the same path). The replay-baseline harness
# (test/replay-baseline.js) drives puppeteer to fetch fixtures via
# the route below, so the browser context can replay them through
# the detection pipeline without a separate file server.
_FIXTURES_DIR = Path(__file__).parent / "test" / "fixtures"
# Cap retained dumps so a long-running session doesn't fill /tmp.
# Newest 50 retained; older silently dropped on each write.
_DIAG_RETENTION = 50

# SQLite DB for play snapshots. Path is resolved lazily inside
# setup() because we need context["config_dir"] — the plugin dir
# itself is bind-mounted READ-ONLY in the slopsmith container, so
# the DB has to live under /config (writable, persists across
# container restarts, host-readable). Per song we keep the newest
# _PLAYS_RETENTION_PER_SONG plays so a long-running player doesn't
# blow up the DB; older plays drop on each write.
_PLAYS_DB_PATH: Path | None = None
_PLAYS_RETENTION_PER_SONG = 50

_PLAYS_SCHEMA = """
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id TEXT NOT NULL,
  play_id_client TEXT,
  played_at TEXT NOT NULL,
  reason TEXT,
  is_drill INTEGER DEFAULT 0,
  drill_section_name TEXT,
  hits INTEGER,
  misses INTEGER,
  total INTEGER,
  detection REAL,
  precision_pct REAL,
  coverage REAL,
  pitch_pct REAL,
  timing_median_ms REAL,
  timing_std_ms REAL,
  combined_weighted_score REAL,
  settings_json TEXT,
  note_results_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plays_song ON plays(song_id, played_at DESC);
"""


@contextmanager
def _plays_db() -> Generator[sqlite3.Connection]:
    """Per-request SQLite connection. Row factory + FK enforcement.
    Caller must be inside a request handler — the connection is
    short-lived and committed/closed on context exit."""
    if _PLAYS_DB_PATH is None:
        raise RuntimeError("plays db path not configured — setup() never ran")
    conn = sqlite3.connect(str(_PLAYS_DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _init_plays_db() -> None:
    """Create the plays table on first startup. Idempotent — safe to
    call on every server boot."""
    if _PLAYS_DB_PATH is None:
        raise RuntimeError("plays db path not configured — setup() never ran")
    _PLAYS_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _plays_db() as conn:
        conn.executescript(_PLAYS_SCHEMA)


def _prune_plays(conn: sqlite3.Connection, song_id: str) -> None:
    """Drop oldest plays beyond _PLAYS_RETENTION_PER_SONG for this
    song. Keeps the DB bounded without a cron — runs on each insert."""
    extra = conn.execute(
        "SELECT id FROM plays WHERE song_id = ? "
        "ORDER BY played_at DESC, id DESC "
        "LIMIT -1 OFFSET ?",
        (song_id, _PLAYS_RETENTION_PER_SONG),
    ).fetchall()
    for row in extra:
        conn.execute("DELETE FROM plays WHERE id = ?", (row["id"],))


def _row_to_play(row: sqlite3.Row) -> dict[str, Any]:
    """Reconstruct the JSON shape the client expects from a plays row.
    note_results_json is the full snapshot — port-shape judgments
    (hit + timingState + pitchState + ignoredAsDetectorFailure +
    chartNote, etc.) — stored as a blob and returned untouched."""
    return {
        "id": row["id"],
        "songId": row["song_id"],
        "playId": row["play_id_client"],
        "playedAt": row["played_at"],
        "reason": row["reason"],
        "isDrill": bool(row["is_drill"]),
        "drillSectionName": row["drill_section_name"],
        "summary": {
            "hits": row["hits"],
            "misses": row["misses"],
            "total": row["total"],
            "detection": row["detection"],
            "precision": row["precision_pct"],
            "coverage": row["coverage"],
            "pitchPct": row["pitch_pct"],
            "timingMedianMs": row["timing_median_ms"],
            "timingStdMs": row["timing_std_ms"],
            "combinedWeightedScore": row["combined_weighted_score"],
        },
        "settings": (
            json.loads(row["settings_json"]) if row["settings_json"] else None
        ),
        "noteResults": json.loads(row["note_results_json"]),
    }


def _slug(s: str | None) -> str:
    """Slugify a song-id or title for filename use. Allows ascii
    letters, digits, underscore and dash; everything else becomes
    underscore. Empty / None → 'unknown'."""
    if not s:
        return "unknown"
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "_", s).strip("_")
    return cleaned or "unknown"


def _prune_old_dumps() -> None:
    """Drop everything beyond the newest _DIAG_RETENTION files. Called
    on every write so the directory stays bounded without a cron."""
    if _DIAG_DIR is None:
        return
    try:
        files = sorted(
            _DIAG_DIR.glob("*.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for stale in files[_DIAG_RETENTION:]:
            try:
                stale.unlink()
            except OSError:
                pass
    except OSError:
        pass


def setup(app: FastAPI, context: dict[str, Any]) -> None:
    """Plugin loader entry point. Called once at startup by the
    slopsmith plugin loader (see plugins/__init__.py:setup_plugin)."""

    # Resolve the plays DB path AND diagnostics dir under
    # context["config_dir"]. The plugin dir itself is mounted
    # read-only in the slopsmith container, so /config (writable,
    # persistent, bind-mounted to host) is the only valid home for
    # state files. Same convention the highway_3d and practice_journal
    # plugins use.
    global _PLAYS_DB_PATH, _DIAG_DIR
    config_dir = Path(context.get("config_dir") or "/config")
    _PLAYS_DB_PATH = config_dir / "note_detect" / "plays.db"
    _DIAG_DIR = config_dir / "note_detect" / "diagnostics"

    # Initialize the plays DB schema. Idempotent — safe even if the
    # file already exists from a prior run.
    try:
        _init_plays_db()
    except Exception:
        # Don't crash plugin load on a DB failure — the diagnostics +
        # fixtures endpoints should still work even if /plays is broken.
        pass

    @app.post("/api/plugins/note_detect/plays")
    async def post_plays(request: Request) -> dict[str, Any]:
        """Snapshot a finished play. Body: {songId, playId, reason,
        isDrill, drillSectionName, startedAt, summary, settings,
        noteResults}. Returns {id} for the new row.

        noteResults is stored as a JSON blob (not normalized into
        rows) — the client knows the shape, and the only access
        patterns are 'list plays' + 'load one full play', neither of
        which queries inner fields."""
        try:
            payload = await request.json()
        except Exception as e:
            raise HTTPException(400, f"invalid json: {e}")
        if not isinstance(payload, dict):
            raise HTTPException(400, "payload must be an object")
        song_id = payload.get("songId")
        if not song_id:
            raise HTTPException(400, "songId is required")
        note_results = payload.get("noteResults")
        if not isinstance(note_results, list):
            raise HTTPException(400, "noteResults must be a list")
        summary = payload.get("summary") or {}
        played_at = payload.get("playedAt") or time.strftime(
            "%Y-%m-%dT%H:%M:%S"
        )
        try:
            with _plays_db() as conn:
                cur = conn.execute(
                    "INSERT INTO plays ("
                    "song_id, play_id_client, played_at, reason, "
                    "is_drill, drill_section_name, "
                    "hits, misses, total, "
                    "detection, precision_pct, coverage, pitch_pct, "
                    "timing_median_ms, timing_std_ms, "
                    "combined_weighted_score, "
                    "settings_json, note_results_json"
                    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
                    "?, ?, ?, ?, ?)",
                    (
                        str(song_id),
                        payload.get("playId"),
                        played_at,
                        payload.get("reason"),
                        1 if payload.get("isDrill") else 0,
                        payload.get("drillSectionName"),
                        summary.get("hits"),
                        summary.get("misses"),
                        summary.get("total"),
                        summary.get("detection"),
                        summary.get("precision"),
                        summary.get("coverage"),
                        summary.get("pitchPct"),
                        summary.get("timingMedianMs"),
                        summary.get("timingStdMs"),
                        summary.get("combinedWeightedScore"),
                        (
                            json.dumps(payload["settings"])
                            if payload.get("settings") is not None
                            else None
                        ),
                        json.dumps(note_results),
                    ),
                )
                play_id = cur.lastrowid
                _prune_plays(conn, str(song_id))
        except sqlite3.Error as e:
            raise HTTPException(500, f"db error: {e}")
        return {"ok": True, "id": play_id}

    @app.get("/api/plugins/note_detect/plays")
    def list_plays(songId: str | None = None, limit: int = 10) -> dict[str, Any]:
        """List plays newest-first. Optional songId filter (most
        callers want this — history view + improvement deltas only
        compare against the same song). Limit caps at 50 to bound
        the response size; the per-song retention is the same so
        callers can request as many as exist."""
        try:
            limit = max(1, min(50, int(limit)))
        except (TypeError, ValueError):
            limit = 10
        try:
            with _plays_db() as conn:
                if songId:
                    rows = conn.execute(
                        "SELECT * FROM plays WHERE song_id = ? "
                        "ORDER BY played_at DESC, id DESC LIMIT ?",
                        (songId, limit),
                    ).fetchall()
                else:
                    rows = conn.execute(
                        "SELECT * FROM plays "
                        "ORDER BY played_at DESC, id DESC LIMIT ?",
                        (limit,),
                    ).fetchall()
        except sqlite3.Error as e:
            raise HTTPException(500, f"db error: {e}")
        return {"plays": [_row_to_play(r) for r in rows]}

    @app.get("/api/plugins/note_detect/play/{play_id}")
    def get_play(play_id: int) -> dict[str, Any]:
        """Fetch one play by id. Used by the coaching review modal."""
        try:
            with _plays_db() as conn:
                row = conn.execute(
                    "SELECT * FROM plays WHERE id = ?", (play_id,)
                ).fetchone()
        except sqlite3.Error as e:
            raise HTTPException(500, f"db error: {e}")
        if row is None:
            raise HTTPException(404, f"play {play_id} not found")
        return _row_to_play(row)

    @app.post("/api/plugins/note_detect/diagnostics")
    async def post_diagnostics(request: Request) -> dict[str, Any]:
        # Wide except: a malformed POST shouldn't crash the route.
        # The endpoint is best-effort — if a write fails we surface
        # the reason but don't propagate as a 500 because the plugin
        # uses fire-and-forget POSTs.
        try:
            payload = await request.json()
        except Exception as e:
            return {"ok": False, "error": f"invalid json: {e}"}

        if not isinstance(payload, dict):
            return {"ok": False, "error": "payload must be an object"}

        if _DIAG_DIR is None:
            return {"ok": False, "error": "diag dir not configured"}

        song_id = payload.get("songId") or payload.get("songTitle") or "unknown"
        ts = time.strftime("%Y-%m-%dT%H-%M-%S")
        slug = _slug(str(song_id))
        filename = f"{slug}-{ts}.json"

        try:
            _DIAG_DIR.mkdir(parents=True, exist_ok=True)
            target = _DIAG_DIR / filename
            target.write_text(json.dumps(payload, indent=2))
        except OSError as e:
            return {"ok": False, "error": f"write failed: {e}"}

        _prune_old_dumps()
        return {"ok": True, "path": str(target), "retained": _DIAG_RETENTION}

    # Fixtures known to be tuning-mismatched against their charts and
    # therefore meaningless for cross-fixture detector validation. Stand
    # By Me recordings are in standard E tuning but the chart authoring
    # expects Eb — every chart pitch is one semitone off. Tagged here
    # rather than deleted because the WAVs themselves are still useful
    # for non-pitch tests (onset density, sustain bleed, hygiene).
    _EXCLUDED_PREFIXES = ("stand_by_me", "stand-by-me")

    @app.get("/api/plugins/note_detect/fixtures")
    def list_fixtures() -> dict[str, Any]:
        """List the WAV fixtures + JSON sidecars available for replay.
        Used by test/replay-baseline.js to discover what's available
        without a host-side filesystem walk. Tuning-mismatched
        fixtures get an `excluded` flag so consumers default to
        skipping them."""
        if not _FIXTURES_DIR.is_dir():
            return {"fixtures": []}
        wavs = sorted(_FIXTURES_DIR.glob("*.wav"))
        out: list[dict[str, Any]] = []
        for w in wavs:
            sidecar = w.with_suffix(".json")
            chart_start = 0.0
            song_id = None
            if sidecar.is_file():
                try:
                    sc = json.loads(sidecar.read_text())
                    chart_start = float(sc.get("chartStartTime", 0.0))
                    song_id = sc.get("songId") or sc.get("filename")
                except Exception:
                    pass
            lname = w.name.lower()
            excluded = any(lname.startswith(p) for p in _EXCLUDED_PREFIXES)
            entry: dict[str, Any] = {
                "name": w.name,
                "size": w.stat().st_size,
                "chartStartTime": chart_start,
                "songId": song_id,
            }
            if excluded:
                entry["excluded"] = True
                entry["excludedReason"] = "tuning mismatch (chart in Eb, recording in E)"
            out.append(entry)
        return {"fixtures": out}

    @app.get("/api/plugins/note_detect/fixtures/{name}")
    def get_fixture(name: str) -> Any:
        """Serve a WAV fixture file. Path-traversal-safe via name
        sanitization: must be a single filename ending in .wav and
        must resolve inside _FIXTURES_DIR."""
        if "/" in name or "\\" in name or ".." in name.split("/"):
            raise HTTPException(400, "invalid fixture name")
        if not name.endswith(".wav"):
            raise HTTPException(400, "fixture must be a .wav file")
        target = (_FIXTURES_DIR / name).resolve()
        try:
            target.relative_to(_FIXTURES_DIR.resolve())
        except ValueError:
            raise HTTPException(400, "path escape detected")
        if not target.is_file():
            raise HTTPException(404, f"fixture not found: {name}")
        return FileResponse(target, media_type="audio/wav", filename=name)

    @app.get("/api/plugins/note_detect/diagnostics")
    def list_diagnostics() -> dict[str, Any]:
        # Useful for ad-hoc browsing — returns the most-recent dumps
        # newest-first as a small JSON listing.
        if _DIAG_DIR is None or not _DIAG_DIR.is_dir():
            return {"files": []}
        try:
            files = sorted(
                _DIAG_DIR.glob("*.json"),
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
        except OSError:
            return {"files": []}
        return {
            "files": [
                {
                    "name": f.name,
                    "size": f.stat().st_size,
                    "mtime": f.stat().st_mtime,
                }
                for f in files[:_DIAG_RETENTION]
            ],
        }

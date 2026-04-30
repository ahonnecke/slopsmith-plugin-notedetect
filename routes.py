"""Note detect plugin routes — diagnostic dump, audio recording, and play-history endpoints.

Plays history is stored in SQLite at CONFIG_DIR/notedetect_plays.db (two
tables: plays + play_notes). The diagnostic dump and per-recording
sidecars stay in /tmp because they are intentionally ephemeral.
"""

import json
import logging
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

logger = logging.getLogger("note_detect.routes")

DUMP_FILE = Path("/tmp/nd_diag_dump.json")
RECORDING_DIR = Path("/tmp/nd_recordings")
LEGACY_PLAYS_DIR = Path("/tmp/nd_plays")  # pre-SQLite location; one-shot import
PLAYS_KEEP_PER_SONG = 50  # SQLite makes retention cheap; bumped from JSON-era 10

_DB_PATH: Optional[str] = None  # populated by setup()

SCHEMA = """
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id TEXT NOT NULL,
  play_id_client TEXT,
  played_at TEXT NOT NULL,
  reason TEXT,
  is_drill INTEGER DEFAULT 0,
  drill_section_name TEXT,
  hits INTEGER DEFAULT 0,
  misses INTEGER DEFAULT 0,
  pitch_score REAL,
  timing_median_ms REAL,
  timing_std_ms REAL,
  coverage REAL,
  combined_weighted_score REAL,
  settings_json TEXT,
  raw_started_at INTEGER
);

CREATE TABLE IF NOT EXISTS play_notes (
  play_id INTEGER NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  section_name TEXT,
  chart_t REAL NOT NULL,
  string_idx INTEGER,
  fret INTEGER,
  expected_midi INTEGER,
  detected_midi INTEGER,
  primary_verdict TEXT NOT NULL,
  labels_json TEXT,
  timing_error_ms REAL,
  pitch_error_cents REAL,
  severity REAL,
  sibling_claimed INTEGER DEFAULT 0,
  detector_failure INTEGER DEFAULT 0,
  note_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_plays_song ON plays(song_id, played_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_notes_play ON play_notes(play_id);
CREATE INDEX IF NOT EXISTS idx_play_notes_section ON play_notes(play_id, section_name);
"""


@contextmanager
def _db():
    """Per-request SQLite connection with FK enforcement and dict-like rows."""
    if _DB_PATH is None:
        raise RuntimeError("notedetect plays DB not initialized — setup() never ran")
    conn = sqlite3.connect(_DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _init_schema():
    with _db() as conn:
        conn.executescript(SCHEMA)


def _insert_play(conn: sqlite3.Connection, data: dict, played_at_override: Optional[str] = None) -> int:
    """Insert a play snapshot into plays + play_notes. Returns the new play_id."""
    played_at = played_at_override or datetime.now(timezone.utc).isoformat()
    summary = data.get("summary") or {}
    hits = summary.get("hits", data.get("hits", 0))
    misses = summary.get("misses", data.get("misses", 0))
    cur = conn.execute(
        """INSERT INTO plays (
            song_id, play_id_client, played_at, reason,
            is_drill, drill_section_name,
            hits, misses, pitch_score, timing_median_ms, timing_std_ms,
            coverage, combined_weighted_score, settings_json, raw_started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            data.get("songId") or "unknown",
            data.get("playId"),
            played_at,
            data.get("reason"),
            1 if data.get("isDrill") else 0,
            data.get("drillSectionName"),
            int(hits or 0),
            int(misses or 0),
            summary.get("pitchScore"),
            summary.get("timingMedianMs"),
            summary.get("timingStdMs"),
            summary.get("coverage"),
            summary.get("combinedWeightedScore"),
            json.dumps(data.get("settings")) if data.get("settings") else None,
            data.get("startedAt"),
        ),
    )
    play_id = cur.lastrowid
    if play_id is None:
        # Defensive: SQLite always returns a rowid for AUTOINCREMENT inserts;
        # if it doesn't, the schema is wrong and we shouldn't write notes.
        raise RuntimeError("plays INSERT did not produce a rowid")
    notes = data.get("noteResults") or []
    rows = []
    for n in notes:
        rows.append(
            (
                play_id,
                n.get("sectionName"),
                float(n.get("chartT") or 0.0),
                n.get("s"),
                n.get("f"),
                n.get("expectedMidi"),
                n.get("detectedMidi"),
                n.get("primary") or "UNKNOWN",
                json.dumps(n.get("labels")) if n.get("labels") else None,
                n.get("timingError"),
                n.get("pitchError"),
                n.get("severity"),
                1 if n.get("siblingClaimed") else 0,
                1 if n.get("detectorFailure") else 0,
                n.get("key"),
            )
        )
    if rows:
        conn.executemany(
            """INSERT INTO play_notes (
                play_id, section_name, chart_t, string_idx, fret,
                expected_midi, detected_midi, primary_verdict, labels_json,
                timing_error_ms, pitch_error_cents, severity,
                sibling_claimed, detector_failure, note_key
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            rows,
        )
    return play_id


def _prune_plays(conn: sqlite3.Connection, song_id: str, keep: int):
    """Drop oldest plays beyond `keep` for this song. play_notes cascades via FK."""
    extra = conn.execute(
        "SELECT id FROM plays WHERE song_id = ? ORDER BY played_at DESC, id DESC LIMIT -1 OFFSET ?",
        (song_id, keep),
    ).fetchall()
    for r in extra:
        conn.execute("DELETE FROM plays WHERE id = ?", (r["id"],))


def _migrate_legacy_plays():
    """Best-effort one-shot import of /tmp/nd_plays/<songId>/*.json into SQLite.

    Idempotent: skips a song if its songId already has any plays in the DB.
    """
    if not LEGACY_PLAYS_DIR.exists():
        return 0
    imported = 0
    with _db() as conn:
        for song_dir in sorted(LEGACY_PLAYS_DIR.iterdir()):
            if not song_dir.is_dir():
                continue
            # The song_dir name is a sanitized version of songId, so we can't
            # exact-match against the original songId. Skip if any play whose
            # song_id contains the dir name already exists — good enough to
            # avoid double-import on repeated startups.
            existing = conn.execute(
                "SELECT 1 FROM plays WHERE song_id LIKE ? LIMIT 1",
                (f"%{song_dir.name}%",),
            ).fetchone()
            if existing:
                continue
            for f in sorted(song_dir.glob("*.json")):
                try:
                    data = json.loads(f.read_text())
                    _insert_play(conn, data)
                    imported += 1
                except Exception as e:
                    logger.warning(f"skipping legacy play {f}: {e}")
    if imported:
        logger.info(f"notedetect: migrated {imported} legacy plays from {LEGACY_PLAYS_DIR}")
    return imported


def _row_to_play(row: sqlite3.Row, notes_rows: list) -> dict:
    """Reconstruct the JSON shape the existing client expects."""
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
            "pitchScore": row["pitch_score"],
            "timingMedianMs": row["timing_median_ms"],
            "timingStdMs": row["timing_std_ms"],
            "coverage": row["coverage"],
            "combinedWeightedScore": row["combined_weighted_score"],
        },
        "settings": json.loads(row["settings_json"]) if row["settings_json"] else None,
        "startedAt": row["raw_started_at"],
        "noteResults": [
            {
                "key": n["note_key"],
                "sectionName": n["section_name"],
                "chartT": n["chart_t"],
                "s": n["string_idx"],
                "f": n["fret"],
                "expectedMidi": n["expected_midi"],
                "detectedMidi": n["detected_midi"],
                "primary": n["primary_verdict"],
                "labels": json.loads(n["labels_json"]) if n["labels_json"] else [],
                "timingError": n["timing_error_ms"],
                "pitchError": n["pitch_error_cents"],
                "severity": n["severity"],
                "siblingClaimed": bool(n["sibling_claimed"]),
                "detectorFailure": bool(n["detector_failure"]),
            }
            for n in notes_rows
        ],
    }


def setup(app: FastAPI, context: dict):
    global _DB_PATH
    config_dir = Path(context.get("config_dir") or (Path.home() / ".local" / "share" / "rocksmith-cdlc"))
    config_dir.mkdir(parents=True, exist_ok=True)
    _DB_PATH = str(config_dir / "notedetect_plays.db")
    _init_schema()
    try:
        _migrate_legacy_plays()
    except Exception as e:
        logger.warning(f"notedetect: legacy plays migration failed: {e}")

    # ── Diagnostic dump ─────────────────────────────────────────────────
    @app.post("/api/plugins/note_detect/dump")
    async def save_dump(request: Request):
        data = await request.json()
        DUMP_FILE.write_text(json.dumps(data, indent=2))
        return {"ok": True, "path": str(DUMP_FILE)}

    @app.get("/api/plugins/note_detect/dump")
    async def get_dump():
        if DUMP_FILE.exists():
            return json.loads(DUMP_FILE.read_text())
        return {"error": "no dump yet"}

    # ── Audio recording ─────────────────────────────────────────────────
    @app.post("/api/plugins/note_detect/recording")
    async def save_recording(request: Request, file: UploadFile = File(...)):
        RECORDING_DIR.mkdir(exist_ok=True)
        name = file.filename or "recording.wav"
        dest = RECORDING_DIR / name
        content = await file.read()
        dest.write_bytes(content)
        chart_start = request.query_params.get("chartStartTime", "0")
        meta = {"chartStartTime": float(chart_start), "sampleRate": 48000, "filename": name}
        meta_path = dest.with_suffix(".json")
        meta_path.write_text(json.dumps(meta, indent=2))
        # Snapshot the global diag dump beside the recording so each session
        # has its own immutable judgement log. Without this sidecar, the
        # /tmp/nd_diag_dump.json gets overwritten on every auto-dump and
        # post-hoc classify-session pulls whichever session's dump was last.
        dump_dest = dest.with_name(dest.stem + ".dump.json")
        if DUMP_FILE.exists():
            try:
                dump_dest.write_text(DUMP_FILE.read_text())
            except Exception:
                pass
        return {"ok": True, "path": str(dest), "size": len(content), "chartStartTime": float(chart_start)}

    @app.get("/api/plugins/note_detect/recording/{filename}")
    async def get_recording(filename: str):
        path = RECORDING_DIR / filename
        if path.exists():
            return FileResponse(path, media_type="audio/wav")
        return {"error": "recording not found"}

    @app.get("/api/plugins/note_detect/recordings")
    async def list_recordings():
        if not RECORDING_DIR.exists():
            return {"recordings": []}
        files = sorted(RECORDING_DIR.glob("*.wav"), key=lambda p: p.stat().st_mtime, reverse=True)
        return {"recordings": [{"name": f.name, "size": f.stat().st_size} for f in files]}

    # ── Plays history (SQLite-backed) ───────────────────────────────────
    @app.post("/api/plugins/note_detect/plays")
    async def save_play(request: Request):
        data = await request.json()
        song_id = data.get("songId") or "unknown"
        with _db() as conn:
            play_id = _insert_play(conn, data)
            _prune_plays(conn, song_id, PLAYS_KEEP_PER_SONG)
        return {"ok": True, "id": play_id}

    @app.get("/api/plugins/note_detect/plays")
    async def list_plays(songId: str, limit: int = PLAYS_KEEP_PER_SONG):
        with _db() as conn:
            rows = conn.execute(
                "SELECT * FROM plays WHERE song_id = ? ORDER BY played_at DESC, id DESC LIMIT ?",
                (songId, limit),
            ).fetchall()
            plays = []
            for r in rows:
                notes = conn.execute(
                    "SELECT * FROM play_notes WHERE play_id = ? ORDER BY chart_t",
                    (r["id"],),
                ).fetchall()
                plays.append(_row_to_play(r, notes))
        return {"plays": plays}

    @app.get("/api/plugins/note_detect/play/{play_id}")
    async def get_play(play_id: int):
        with _db() as conn:
            row = conn.execute("SELECT * FROM plays WHERE id = ?", (play_id,)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="play not found")
            notes = conn.execute(
                "SELECT * FROM play_notes WHERE play_id = ? ORDER BY chart_t",
                (play_id,),
            ).fetchall()
        return _row_to_play(row, notes)

    @app.get("/api/plugins/note_detect/sections/{song_id_b64:path}")
    async def section_history(song_id_b64: str, limit: int = 10):
        """Per-section trend across the most-recent plays for this song.

        Path-encoded song_id (with potential slashes) is matched literally.
        Returns one entry per distinct section_name with a trend array of
        per-play scores so the historical view can render a sparkline.
        """
        with _db() as conn:
            recent = conn.execute(
                "SELECT id, played_at FROM plays WHERE song_id = ? ORDER BY played_at DESC, id DESC LIMIT ?",
                (song_id_b64, limit),
            ).fetchall()
            if not recent:
                return {"sections": [], "plays": []}
            play_ids = [r["id"] for r in recent]
            placeholders = ",".join("?" for _ in play_ids)
            agg = conn.execute(
                f"""SELECT play_id, section_name,
                          SUM(CASE WHEN primary_verdict IN ('HIT','DIRTY_HIT') THEN 1 ELSE 0 END) AS hits,
                          SUM(CASE WHEN primary_verdict LIKE 'MISSED%' THEN 1 ELSE 0 END) AS misses,
                          COUNT(*) AS total
                   FROM play_notes
                   WHERE play_id IN ({placeholders}) AND section_name IS NOT NULL
                   GROUP BY play_id, section_name""",
                play_ids,
            ).fetchall()
        # Restructure: sections[name] -> [{playId, hits, misses, total, accuracy}, ...]
        sections: dict = {}
        for row in agg:
            sec = row["section_name"]
            if sec not in sections:
                sections[sec] = []
            total = row["total"] or 0
            hits = row["hits"] or 0
            sections[sec].append(
                {
                    "playId": row["play_id"],
                    "hits": hits,
                    "misses": row["misses"] or 0,
                    "total": total,
                    "accuracy": (hits / total) if total else None,
                }
            )
        return {
            "plays": [{"id": r["id"], "playedAt": r["played_at"]} for r in recent],
            "sections": [{"name": name, "trend": trend} for name, trend in sections.items()],
        }

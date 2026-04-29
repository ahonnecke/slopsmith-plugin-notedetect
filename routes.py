"""Note detect plugin routes — diagnostic dump and audio recording endpoints."""

import json
import os
import time
from pathlib import Path
from fastapi import FastAPI, Request, UploadFile, File
from fastapi.responses import FileResponse


DUMP_FILE = Path("/tmp/nd_diag_dump.json")
RECORDING_DIR = Path("/tmp/nd_recordings")
PLAYS_DIR = Path("/tmp/nd_plays")
PLAYS_KEEP_PER_SONG = 10
CALIBRATION_FILE = Path("/tmp/nd_pending_calibration.json")


def _safe_song_dir(song_id: str) -> Path:
    # songId is filename__arrangement; keep it filesystem-safe.
    # Reject pure-dot names (".", "..") which would resolve to PLAYS_DIR or
    # PLAYS_DIR.parent. Verified: the per-char filter alone would let
    # songId="../foo" through as ".._foo" (harmless) but songId=".." escapes.
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in song_id)[:200]
    if not safe or safe.strip(".") == "":
        safe = "unknown"
    return PLAYS_DIR / safe


def _prune_plays(song_dir: Path):
    if not song_dir.exists():
        return
    files = sorted(song_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in files[PLAYS_KEEP_PER_SONG:]:
        try:
            old.unlink()
        except Exception:
            pass


def setup(app: FastAPI, context: dict):
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

    @app.post("/api/plugins/note_detect/recording")
    async def save_recording(request: Request, file: UploadFile = File(...)):
        RECORDING_DIR.mkdir(exist_ok=True)
        name = file.filename or "recording.wav"
        dest = RECORDING_DIR / name
        content = await file.read()
        dest.write_bytes(content)
        # Save chart start time as sidecar metadata
        chart_start = request.query_params.get("chartStartTime", "0")
        meta = {"chartStartTime": float(chart_start), "sampleRate": 48000, "filename": name}
        meta_path = dest.with_suffix(".json")
        meta_path.write_text(json.dumps(meta, indent=2))
        # Also snapshot the diagnostic dump beside the recording so each
        # session has its own immutable judgement log. The global
        # /tmp/nd_diag_dump.json is overwritten on every auto-dump, which
        # made post-hoc classify-session unreliable — pulling a dump
        # alongside an older recording grabbed whichever session's dump
        # had been written last. The per-recording snapshot here is what
        # the classify-session Makefile target now reads.
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

    @app.post("/api/plugins/note_detect/plays")
    async def save_play(request: Request):
        data = await request.json()
        song_id = data.get("songId") or "unknown"
        play_id = data.get("playId") or ""
        song_dir = _safe_song_dir(song_id)
        song_dir.mkdir(parents=True, exist_ok=True)
        # playId is an ISO timestamp on the client; sanitize for fs use
        safe_play = "".join(c if c.isalnum() or c in "-_." else "_" for c in play_id)[:64] or "play"
        dest = song_dir / f"{safe_play}.json"
        dest.write_text(json.dumps(data, indent=2))
        _prune_plays(song_dir)
        return {"ok": True, "path": str(dest)}

    @app.get("/api/plugins/note_detect/plays")
    async def list_plays(songId: str, limit: int = PLAYS_KEEP_PER_SONG):
        song_dir = _safe_song_dir(songId)
        if not song_dir.exists():
            return {"plays": []}
        files = sorted(song_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]
        plays = []
        for f in files:
            try:
                plays.append(json.loads(f.read_text()))
            except Exception:
                pass
        return {"plays": plays}

    @app.post("/api/plugins/note_detect/calibration")
    async def set_calibration(request: Request):
        """Stage a calibration value for the next plugin poll to pick up.
        Used by `make calibrate-from-history --apply` so the user doesn't
        have to paste the value into devtools."""
        data = await request.json()
        try:
            mic_latency = float(data.get("micLatencyMs"))
        except (TypeError, ValueError):
            return {"error": "missing or invalid micLatencyMs"}
        # Hardware mic latency can't be negative; cap at a generous upper bound
        # so a CLI typo can't write absurd values into the plugin state.
        if not (0 <= mic_latency <= 1000):
            return {"error": f"out of range (0-1000 ms), got {mic_latency}"}
        payload = {"micLatencyMs": round(mic_latency, 1), "stagedAt": time.time()}
        CALIBRATION_FILE.write_text(json.dumps(payload))
        return {"ok": True, **payload}

    @app.get("/api/plugins/note_detect/calibration")
    async def get_calibration():
        """Plugin polls this. Returns the latest staged value (or null)."""
        if not CALIBRATION_FILE.exists():
            return {"micLatencyMs": None, "stagedAt": None}
        try:
            return json.loads(CALIBRATION_FILE.read_text())
        except Exception:
            return {"micLatencyMs": None, "stagedAt": None}

"""Note detect plugin routes — diagnostic dump and audio recording endpoints."""

import json
import os
from pathlib import Path
from fastapi import FastAPI, Request, UploadFile, File
from fastapi.responses import FileResponse


DUMP_FILE = Path("/tmp/nd_diag_dump.json")
RECORDING_DIR = Path("/tmp/nd_recordings")


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

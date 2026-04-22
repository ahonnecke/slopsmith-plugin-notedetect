"""Note detect plugin routes — diagnostic dump endpoint."""

import json
import os
from pathlib import Path
from fastapi import FastAPI, Request


DUMP_FILE = Path("/tmp/nd_diag_dump.json")


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

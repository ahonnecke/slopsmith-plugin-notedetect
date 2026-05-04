"""Server-side routes for the note detection plugin.

Currently exposes a single diagnostics-dump endpoint that the plugin
posts to periodically and at session boundaries. The dumps land in
/tmp/nd_diagnostics/ so they can be read directly from local disk
without the user having to paste console output. This is the auto-
collect path the user asked for after getting tired of manually
pasting getStats() results during port debugging.

The dump file naming is `<song-slug>-<iso-timestamp>.json` so multiple
sessions can be browsed chronologically. When no song info is
available (mid-page-load, before highway.getSongInfo() returns), we
fall back to "unknown".
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request


# Write to the plugin's own directory rather than /tmp because
# slopsmith typically runs in a container where /tmp is tmpfs and
# isn't bind-mounted to the host. The plugin dir IS bind-mounted
# (that's how live screen.js edits work in dev), so dumps land
# directly on the host filesystem and can be read without docker
# exec. The dir is computed at module-import time relative to this
# file's path — same trick as plugins/__init__.py uses.
_DIAG_DIR = Path(__file__).parent / "diagnostics"
# Cap retained dumps so a long-running session doesn't fill /tmp.
# Newest 50 retained; older silently dropped on each write.
_DIAG_RETENTION = 50


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

    @app.get("/api/plugins/note_detect/diagnostics")
    def list_diagnostics() -> dict[str, Any]:
        # Useful for ad-hoc browsing — returns the most-recent dumps
        # newest-first as a small JSON listing.
        if not _DIAG_DIR.is_dir():
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

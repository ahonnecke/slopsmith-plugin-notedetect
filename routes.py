"""Server routes for the note_detect plugin.

POST /api/plugins/note_detect/recording
    Body: raw bytes of a RIFF/WAVE file (mono PCM is what the browser
    encodes; we don't crack it open, just validate the header).
    Query: ?slug=<safe-filename-slug>   (optional, defaults to "recording").
    Returns JSON: { path_in_container, relative_path, filename, bytes }.

POST /api/plugins/note_detect/live-judgment
    Body: JSON object — one judgment record produced by the detector.
    Query: ?session=<id>   (sanitised; defaults to "default").
    Returns JSON: { ok: true, appended: <bytes> }.
    Appends one JSON line to
    ``static/note_detect_recordings/live_<session>.jsonl``. The plugin
    streams judgments here only when tuning mode is on (or while
    armed-for-training; see /training-bundle below), so steady-state
    play has zero overhead. Each line is a self-contained record —
    safe to tail / read partially / replay.

POST /api/plugins/note_detect/training-bundle
    Body: JSON { slug, wav_filename, session, manifest, arrangement, upload_url }.
        slug    — used to name the bundle, and to locate the WAV when
                  ``wav_filename`` is absent (newest matching
                  ``note_detect_<slug>_*.wav``).
        wav_filename — exact WAV filename from the /recording response;
                  preferred over the slug glob so concurrent same-slug
                  takes can't be paired with the wrong WAV. Optional.
        session — locates the live-judgment JSONL written by
                  /live-judgment (``live_<session>.jsonl``). Optional —
                  bundle proceeds without it if absent or empty.
        manifest — JSON object recorded as-is into ``manifest.json``
                   inside the bundle. The server adds schema, created_at,
                   and resolved filename/bytes fields before writing.
        arrangement — optional ground-truth note chart, written as
                   ``arrangement.json`` inside the bundle.
        upload_url — optional pCloud destination override.
    Bundles the located files + manifest into
    ``training_<slug>_<ts>.zip`` under the recordings directory, then
    POSTs the bundle (multipart/form-data) to the curated pCloud public
    upload link (``_PCLOUD_UPLOAD_CODE`` below). On upload failure the
    local zip is retained so the user can retry manually. Returns JSON
    with ``ok`` and either ``pcloud_result`` (success) or ``error``.

All three endpoints write under ``<base>/note_detect_recordings/``, where
``<base>`` is the first writable directory among ``$STATIC_DIR``,
``$CONFIG_DIR``, and ``/app/static``. In Docker, ``$STATIC_DIR`` (or the
``/app/static`` bind mount) is host-reachable, so recordings land there.
In the packaged desktop bundle ``$STATIC_DIR`` is unset and the bundled
static tree is read-only, so recordings fall back to ``$CONFIG_DIR`` —
the user's writable data directory. The base is resolved lazily on the
first write (and cached) so route registration never fails; a host with
no writable candidate at all turns into a clean 500 on save.
"""

import json
import os
import re
import secrets
import sqlite3
import time
import zipfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from fastapi import HTTPException, Request

# pCloud public upload link ("puplink") for the curated note_detect
# training set. Anyone with this code can upload to the destination
# folder; they cannot list or read it. Hardcoded as the fallback when
# the client doesn't supply an `upload_url` in the /training-bundle
# POST. This is the single source of truth for the default — the
# settings page fetches it via GET /api/plugins/note_detect/config
# rather than hardcoding its own copy.
_PCLOUD_UPLOAD_CODE = "itd7ZwmOK8S2D6XSAE1Q9cUPaF5c9WFfk"
_PCLOUD_DEFAULT_URL = "https://e.pcloud.com/#/puplink?code=" + _PCLOUD_UPLOAD_CODE
_PCLOUD_UPLOAD_URL = "https://eapi.pcloud.com/uploadtolink"
# Regex used to pull a pCloud upload code out of whatever the user
# pastes in the settings field. Anchored on `code=` so a share URL
# (`…/#/puplink?code=ABC`), an API URL
# (`…/uploadtolink?code=ABC`), or any other URL form work. The
# bare-code path is handled separately in `_parse_pcloud_code`.
_PCLOUD_CODE_RE = re.compile(r"code=([A-Za-z0-9_-]+)")
# Bare-code shape: pCloud upload codes are alphanumeric + `_`/`-`
# only, so anything matching the full string is treated as already-
# extracted.
_PCLOUD_BARE_RE = re.compile(r"^[A-Za-z0-9_-]+$")
# Conservative pCloud-safe filename normaliser applied to the name
# sent to pCloud as the `names` parameter: lowercase, ASCII
# alphanumeric + single dashes only, stem capped at 80 chars,
# extension preserved (but lowercased). The `result=2001 "Invalid
# file/folder name"` failures were caused by omitting the `names`
# parameter entirely (see `_upload_to_pcloud`), not by the name's
# contents; this normaliser is kept as defence-in-depth against
# genuinely odd names. Applied ONLY to the name we send pCloud — the
# local zip on disk keeps its original (readable) name so retries /
# forensics stay easy.
_PCLOUD_NAME_STEM_RE = re.compile(r"[^a-z0-9]+")
_PCLOUD_NAME_DASH_COLLAPSE_RE = re.compile(r"-+")


def _sanitize_pcloud_filename(name: str) -> str:
    p = Path(name)
    stem = (p.stem or "training").lower()
    ext = (p.suffix or ".zip").lower()
    stem = _PCLOUD_NAME_STEM_RE.sub("-", stem)
    stem = _PCLOUD_NAME_DASH_COLLAPSE_RE.sub("-", stem).strip("-")
    if not stem:
        stem = "training"
    if len(stem) > 80:
        stem = stem[:80].rstrip("-")
    # Defensive: extension should look like .zip / .ogg / etc. If
    # something exotic slipped through, fall back to .bin so pCloud's
    # validator doesn't choke on it.
    if not re.fullmatch(r"\.[a-z0-9]{1,8}", ext):
        ext = ".bin"
    return stem + ext
# Cap on the bundle size we'll attempt to upload. WAV+JSONL+manifest for
# a 3-minute take is ~15 MB; 64 MB lets longer takes and higher sample
# rates through while still refusing to upload pathological blobs.
_BUNDLE_MAX_BYTES = 64 * 1024 * 1024
# Cap on the JSON request body for /training-bundle and its /retry.
# The body is manifest + (optionally) the full note chart — a dense
# song's arrangement.json is well under 1 MB, so 16 MB is generous
# while refusing a blob that would balloon memory before the post-zip
# size check can run.
_TRAINING_BODY_MAX_BYTES = 16 * 1024 * 1024
# pCloud HTTP timeout for the upload POST. Slow links can take a while
# for a 15 MB body; 5 minutes is generous without pinning the request
# slot indefinitely.
_PCLOUD_TIMEOUT_S = 300

# Subdirectory under the slopsmith static tree where recordings land.
# Bind-mounted via docker-compose (`./static:/app/static`), so the host
# sees these files at `<slopsmith>/static/note_detect_recordings/`.
_RECORDINGS_REL = "note_detect_recordings"

# Filename slug — strip anything that isn't filesystem-safe. Length cap
# keeps us comfortably under any FS limit even with the timestamp tail.
_SLUG_RE = re.compile(r"[^A-Za-z0-9_-]+")
_SLUG_MAX = 40

# Cap to keep a runaway client from filling the disk via the POST body.
# A clean 3-minute recording at 44.1 kHz mono 16-bit PCM is ~15 MB; 32 MB
# leaves headroom for higher sample rates / longer takes while still
# refusing to write multi-GB blobs.
_MAX_BYTES = 32 * 1024 * 1024

# Per-judgment payloads are small (~150 bytes typical), but a buggy
# client could spam huge blobs. Cap individual payloads so the JSONL
# file can't be DoSed into millions of bytes per line.
_LIVE_JUDGMENT_MAX_BYTES = 8 * 1024

# ── Plays history (multi-play hotspot finder) ─────────────────────────────
# A per-play note-verdict store so the frontend finder can flag a region
# the user keeps missing ACROSS plays (not a one-off fumble) and offer to
# drill it. Deliberately LEAN — only the columns the finder reads: the
# rich per-note failure-classification model from the prior fork is not
# reproduced here (the running build doesn't populate it). SQLite lives at
# the first writable base (CONFIG_DIR persists across container restarts).
_PLAYS_DB_REL = "notedetect_plays.db"
_PLAYS_KEEP_PER_SONG = 25   # retain the most recent N full plays per song
_PLAYS_DB_PATH: Optional[str] = None  # resolved lazily in setup()

_PLAYS_SCHEMA = """
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id TEXT NOT NULL,
  play_id_client TEXT,
  played_at TEXT NOT NULL,
  reason TEXT,
  is_drill INTEGER DEFAULT 0,
  hits INTEGER DEFAULT 0,
  misses INTEGER DEFAULT 0,
  raw_started_at INTEGER
);

CREATE TABLE IF NOT EXISTS play_notes (
  play_id INTEGER NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  note_key TEXT,
  chart_t REAL NOT NULL,
  string_idx INTEGER,
  fret INTEGER,
  expected_midi INTEGER,
  primary_verdict TEXT NOT NULL,
  miss_kind TEXT
);

CREATE INDEX IF NOT EXISTS idx_plays_song ON plays(song_id, played_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_notes_play ON play_notes(play_id);

-- Practice loops: a hotspot saved as a drillable A-B loop for a song, with
-- its failure reasons and whether it's been passed at full speed. The host's
-- own `loops` table (id/filename/name/start/end) can't carry reasons/passed,
-- so the drill loop manager keeps its own richer store.
CREATE TABLE IF NOT EXISTS practice_loops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id TEXT NOT NULL,
  label TEXT,
  loop_a REAL NOT NULL,
  loop_b REAL NOT NULL,
  reasons_json TEXT,
  passed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_practice_loops_song ON practice_loops(song_id, loop_a);
"""


@contextmanager
def _plays_db():
    """Per-request SQLite connection with FK enforcement and dict rows."""
    if _PLAYS_DB_PATH is None:
        raise RuntimeError("notedetect plays DB not initialized — setup() never ran")
    conn = sqlite3.connect(_PLAYS_DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _insert_play(conn: sqlite3.Connection, data: dict) -> int:
    """Insert one play snapshot into plays + play_notes. Returns the play_id."""
    summary = data.get("summary") or {}
    cur = conn.execute(
        """INSERT INTO plays (
            song_id, play_id_client, played_at, reason, is_drill,
            hits, misses, raw_started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            data.get("songId") or "unknown",
            data.get("playId"),
            datetime.now(timezone.utc).isoformat(),
            data.get("reason"),
            1 if data.get("isDrill") else 0,
            int(summary.get("hits") or 0),
            int(summary.get("misses") or 0),
            data.get("startedAt"),
        ),
    )
    play_id = cur.lastrowid
    if play_id is None:
        raise RuntimeError("plays INSERT did not produce a rowid")
    rows = []
    for n in (data.get("noteResults") or []):
        rows.append((
            play_id,
            n.get("key"),
            float(n.get("chartT") or 0.0),
            n.get("s"),
            n.get("f"),
            n.get("expectedMidi"),
            n.get("primary") or "UNKNOWN",
            n.get("how"),
        ))
    if rows:
        conn.executemany(
            """INSERT INTO play_notes (
                play_id, note_key, chart_t, string_idx, fret,
                expected_midi, primary_verdict, miss_kind
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            rows,
        )
    return play_id


def _prune_plays(conn: sqlite3.Connection, song_id: str, keep: int):
    """Drop the oldest plays beyond `keep` for this song (notes cascade)."""
    extra = conn.execute(
        "SELECT id FROM plays WHERE song_id = ? ORDER BY played_at DESC, id DESC LIMIT -1 OFFSET ?",
        (song_id, keep),
    ).fetchall()
    for r in extra:
        conn.execute("DELETE FROM plays WHERE id = ?", (r["id"],))


def _row_to_play(row: sqlite3.Row, notes_rows: list) -> dict:
    """Reconstruct the JSON shape _ndFetchPlays / _ndAggregatePlays expect."""
    return {
        "id": row["id"],
        "songId": row["song_id"],
        "playId": row["play_id_client"],
        "playedAt": row["played_at"],
        "reason": row["reason"],
        "isDrill": bool(row["is_drill"]),
        "summary": {"hits": row["hits"], "misses": row["misses"]},
        "startedAt": row["raw_started_at"],
        "noteResults": [
            {
                "key": n["note_key"],
                "chartT": n["chart_t"],
                "s": n["string_idx"],
                "f": n["fret"],
                "expectedMidi": n["expected_midi"],
                "primary": n["primary_verdict"],
                "how": (n["miss_kind"] if "miss_kind" in n.keys() else None),
            }
            for n in notes_rows
        ],
    }

# JSONL files for a single session shouldn't exceed this — caps total
# accumulation per session. A 2-minute song produces ~60 KB; this gives
# 100× headroom while still bounding pathological cases.
_LIVE_FILE_MAX_BYTES = 8 * 1024 * 1024


def _parse_pcloud_code(upload_url: str | None) -> str | None:
    """Extract the pCloud upload-link code from a user-supplied string.

    Accepts:
      - a full share URL: ``https://e.pcloud.com/#/puplink?code=ABC``
      - the API URL form: ``https://eapi.pcloud.com/uploadtolink?code=ABC``
      - any other URL containing ``code=ABC`` somewhere
      - a bare code (no URL syntax at all): ``ABC``

    An empty / missing input returns the curated-default code (the
    user wants the default). A *non-empty* input that contains no
    parseable code returns ``None`` so the caller can reject it with a
    4xx — silently falling back to the default would route a
    contributor's recording to the public curated dataset when they
    meant to send it to their own folder.
    """
    if not upload_url:
        return _PCLOUD_UPLOAD_CODE
    s = upload_url.strip()
    if not s:
        return _PCLOUD_UPLOAD_CODE
    m = _PCLOUD_CODE_RE.search(s)
    if m:
        return m.group(1)
    if _PCLOUD_BARE_RE.fullmatch(s):
        return s
    return None


def _sanitize_slug(s: str, default: str = "recording") -> str:
    # `default` is parameterised because the same sanitiser feeds the
    # recording-filename slug (where "recording" is the obvious fallback)
    # AND the live-judgment session id (where each route's docstring
    # promises its own fallback — "default" for /live-judgment). If an
    # input sanitises to empty, fall back to the caller's chosen tag
    # rather than coalescing two unrelated routes onto the same name.
    s = (s or "").strip()
    s = _SLUG_RE.sub("_", s)[:_SLUG_MAX].strip("_")
    return s or default


async def _read_capped_body(request: Request, max_bytes: int) -> bytes:
    """Read the request body, refusing it the moment it exceeds
    ``max_bytes``.

    ``request.json()`` / ``request.body()`` buffer the WHOLE body into
    memory before any size check can run, so a cap applied afterwards
    doesn't protect the process. This checks ``Content-Length`` up
    front, then streams the body with a running byte count — a lying or
    absent header can't sneak an oversized payload past the cap.
    """
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            if int(cl) > max_bytes:
                raise HTTPException(
                    413, f"request body too large ({cl} bytes > {max_bytes})")
        except ValueError:
            pass  # unparseable header — fall through to the streamed count
    chunks: list = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                413, f"request body too large (> {max_bytes} bytes)")
        chunks.append(chunk)
    return b"".join(chunks)


def setup(app, context):
    log = context["log"]
    # Resolve the slopsmith static tree from $STATIC_DIR (set by native
    # uvicorn launches that don't see the Docker `/app` mount) and fall
    # back to the in-container path so this keeps working in compose.
    # The mkdir is deferred to the request handler so a missing/un-
    # writable static dir at plugin-load time can't take down route
    # registration — `/api/plugins/note_detect/recording` would 404 and
    # the in-app save would silently fail.
    # Recordings need a WRITABLE, user-reachable directory. Try, in order:
    #   STATIC_DIR  — Docker (bind-mounted, host-reachable) / native dev runs
    #   CONFIG_DIR  — desktop bundle: STATIC_DIR is unset there and the
    #                 bundled static tree is read-only, but CONFIG_DIR is the
    #                 user's writable data directory
    #   /app/static — last-resort Docker default
    # The first base that can actually be created AND written wins. It is
    # resolved lazily on the first write and cached, so a read-only candidate
    # turns into a clean fallback (and only an all-candidates-fail case 500s)
    # rather than a load-time crash that 404s the route.
    _candidate_dirs = []
    if os.environ.get("STATIC_DIR"):
        _candidate_dirs.append(Path(os.environ["STATIC_DIR"]) / _RECORDINGS_REL)
    if os.environ.get("CONFIG_DIR"):
        _candidate_dirs.append(Path(os.environ["CONFIG_DIR"]) / _RECORDINGS_REL)
    _candidate_dirs.append(Path("/app/static") / _RECORDINGS_REL)

    _resolved_dir: list = [None]  # mutable cell — set on first successful probe

    def _ensure_out_dir() -> Path:
        if _resolved_dir[0] is not None:
            return _resolved_dir[0]
        errors = []
        for cand in _candidate_dirs:
            try:
                cand.mkdir(parents=True, exist_ok=True)
                # A directory can exist but be read-only (packaged bundle) —
                # confirm with a probe file before committing to it. The probe
                # name is unique per call (pid + random) so two requests racing
                # this lazy init can't unlink each other's probe and spuriously
                # fail a directory that is in fact writable.
                probe = cand / f".write_test_{os.getpid()}_{secrets.token_hex(6)}"
                probe.write_bytes(b"")
                probe.unlink()
            except OSError as e:
                errors.append(f"{cand}: {e}")
                continue
            _resolved_dir[0] = cand
            log.info("note_detect recordings directory: %s", cand)
            return cand
        raise HTTPException(
            500,
            "could not find a writable recordings directory (tried: "
            + "; ".join(errors) + ")",
        )

    def _ensure_plays_db() -> str:
        # The plays DB lives in the same resolved writable base as
        # recordings (host-visible in Docker, CONFIG_DIR in the desktop
        # bundle). Resolved + schema-created lazily on first use so route
        # registration never fails on a read-only / missing base.
        global _PLAYS_DB_PATH
        if _PLAYS_DB_PATH is not None:
            return _PLAYS_DB_PATH
        base = _ensure_out_dir()
        _PLAYS_DB_PATH = str(base / _PLAYS_DB_REL)
        with _plays_db() as conn:
            conn.executescript(_PLAYS_SCHEMA)
            # Migrate an existing DB created before play_notes.miss_kind.
            try:
                conn.execute("ALTER TABLE play_notes ADD COLUMN miss_kind TEXT")
            except sqlite3.OperationalError:
                pass  # column already exists
        log.info("note_detect plays DB: %s", _PLAYS_DB_PATH)
        return _PLAYS_DB_PATH

    @app.post("/api/plugins/note_detect/plays")
    async def save_play(request: Request):
        import anyio
        try:
            data = await request.json()
        except Exception:
            raise HTTPException(400, "body must be JSON")
        if not isinstance(data, dict):
            raise HTTPException(400, "body must be a JSON object")
        song_id = data.get("songId")
        if not song_id:
            raise HTTPException(400, "songId required")
        _ensure_plays_db()

        def _work():
            with _plays_db() as conn:
                pid = _insert_play(conn, data)
                _prune_plays(conn, song_id, _PLAYS_KEEP_PER_SONG)
                return pid

        pid = await anyio.to_thread.run_sync(_work)
        return {"ok": True, "id": pid}

    @app.get("/api/plugins/note_detect/plays")
    async def list_plays(request: Request):
        import anyio
        song_id = request.query_params.get("songId")
        if not song_id:
            raise HTTPException(400, "songId required")
        try:
            limit = int(request.query_params.get("limit", "10"))
        except (TypeError, ValueError):
            limit = 10
        limit = max(1, min(50, limit))
        _ensure_plays_db()

        def _work():
            with _plays_db() as conn:
                prows = conn.execute(
                    "SELECT * FROM plays WHERE song_id = ? ORDER BY played_at DESC, id DESC LIMIT ?",
                    (song_id, limit),
                ).fetchall()
                out = []
                for pr in prows:
                    nrows = conn.execute(
                        "SELECT * FROM play_notes WHERE play_id = ? ORDER BY chart_t ASC",
                        (pr["id"],),
                    ).fetchall()
                    out.append(_row_to_play(pr, nrows))
                return out

        plays = await anyio.to_thread.run_sync(_work)
        return {"plays": plays}

    # ── Practice loops (drill loop manager) ───────────────────────────────
    @app.post("/api/plugins/note_detect/practice-loops")
    async def save_practice_loop(request: Request):
        import anyio
        try:
            data = await request.json()
        except Exception:
            raise HTTPException(400, "body must be JSON")
        if not isinstance(data, dict):
            raise HTTPException(400, "body must be a JSON object")
        song_id = data.get("songId")
        a, b = data.get("loopA"), data.get("loopB")
        if not song_id or not isinstance(a, (int, float)) or not isinstance(b, (int, float)) or b <= a:
            raise HTTPException(400, "songId and loopA<loopB required")
        _ensure_plays_db()

        def _work():
            with _plays_db() as conn:
                # De-dupe: a loop within 0.25s of an existing one for this song
                # is the same hotspot — update its label/reasons instead of
                # piling up near-identical rows across replays.
                existing = conn.execute(
                    "SELECT id FROM practice_loops WHERE song_id = ? AND ABS(loop_a - ?) < 0.25 AND ABS(loop_b - ?) < 0.25",
                    (song_id, float(a), float(b)),
                ).fetchone()
                reasons = json.dumps(data.get("reasons")) if data.get("reasons") is not None else None
                if existing:
                    conn.execute(
                        "UPDATE practice_loops SET label = ?, reasons_json = ? WHERE id = ?",
                        (data.get("label"), reasons, existing["id"]),
                    )
                    return existing["id"]
                cur = conn.execute(
                    "INSERT INTO practice_loops (song_id, label, loop_a, loop_b, reasons_json, passed, created_at) "
                    "VALUES (?, ?, ?, ?, ?, 0, ?)",
                    (song_id, data.get("label"), float(a), float(b), reasons,
                     datetime.now(timezone.utc).isoformat()),
                )
                return cur.lastrowid

        loop_id = await anyio.to_thread.run_sync(_work)
        return {"ok": True, "id": loop_id}

    @app.get("/api/plugins/note_detect/practice-loops")
    async def list_practice_loops(request: Request):
        import anyio
        song_id = request.query_params.get("songId")
        if not song_id:
            raise HTTPException(400, "songId required")
        _ensure_plays_db()

        def _work():
            with _plays_db() as conn:
                rows = conn.execute(
                    "SELECT id, song_id, label, loop_a, loop_b, reasons_json, passed, created_at "
                    "FROM practice_loops WHERE song_id = ? ORDER BY loop_a",
                    (song_id,),
                ).fetchall()
                return [{
                    "id": r["id"], "songId": r["song_id"], "label": r["label"],
                    "loopA": r["loop_a"], "loopB": r["loop_b"],
                    "reasons": json.loads(r["reasons_json"]) if r["reasons_json"] else [],
                    "passed": bool(r["passed"]), "createdAt": r["created_at"],
                } for r in rows]

        loops = await anyio.to_thread.run_sync(_work)
        return {"loops": loops}

    @app.post("/api/plugins/note_detect/practice-loops/{loop_id}/passed")
    async def mark_practice_loop_passed(loop_id: int, request: Request):
        import anyio
        try:
            data = await request.json()
        except Exception:
            data = {}
        passed = 0 if (isinstance(data, dict) and data.get("passed") is False) else 1
        _ensure_plays_db()

        def _work():
            with _plays_db() as conn:
                conn.execute("UPDATE practice_loops SET passed = ? WHERE id = ?", (passed, loop_id))

        await anyio.to_thread.run_sync(_work)
        return {"ok": True, "id": loop_id, "passed": bool(passed)}

    @app.delete("/api/plugins/note_detect/practice-loops/{loop_id}")
    async def delete_practice_loop(loop_id: int):
        import anyio
        _ensure_plays_db()

        def _work():
            with _plays_db() as conn:
                conn.execute("DELETE FROM practice_loops WHERE id = ?", (loop_id,))

        await anyio.to_thread.run_sync(_work)
        return {"ok": True, "id": loop_id}

    @app.post("/api/plugins/note_detect/recording")
    async def save_recording(request: Request):
        body = await request.body()
        # Tiny WAVs are almost certainly empty / corrupt — RIFF + fmt +
        # data chunks together are 44 bytes minimum even with zero
        # samples, so this is a real-input check, not a hard limit.
        if not body or len(body) < 44:
            raise HTTPException(400, "empty or too-short body (expected a WAV file)")
        if len(body) > _MAX_BYTES:
            raise HTTPException(413, f"recording too large ({len(body)} bytes > {_MAX_BYTES})")
        if body[:4] != b"RIFF" or body[8:12] != b"WAVE":
            raise HTTPException(400, "body is not a WAV file (no RIFF/WAVE header)")

        slug = _sanitize_slug(request.query_params.get("slug", "recording"))
        # Include milliseconds + a short random suffix so two saves in
        # the same second with the same slug don't overwrite each other
        # (two-panel splitscreen scenario, or rapid arm/save cycles).
        # `secrets.token_hex(3)` is plenty of entropy for human-scale
        # collision avoidance and keeps the filename short.
        now = time.time()
        ts = time.strftime("%Y%m%d_%H%M%S", time.localtime(now))
        ms = int((now - int(now)) * 1000)
        suffix = secrets.token_hex(3)
        filename = f"note_detect_{slug}_{ts}_{ms:03d}_{suffix}.wav"
        path = _ensure_out_dir() / filename
        # Use a `.tmp` then rename so a crashed write doesn't leave a
        # truncated WAV that the harness might pick up next time.
        tmp = path.with_suffix(path.suffix + ".tmp")
        try:
            tmp.write_bytes(body)
            tmp.replace(path)
        except OSError as e:
            raise HTTPException(
                500,
                f"could not write recording ({tmp}): {e}",
            )

        rel = f"static/{_RECORDINGS_REL}/{filename}"
        log.info(
            "saved recording (%d bytes, slug=%s) to %s",
            len(body), slug, str(path),
        )
        return {
            "path_in_container": str(path),
            "relative_path": rel,
            "filename": filename,
            "bytes": len(body),
        }

    @app.post("/api/plugins/note_detect/live-judgment")
    async def append_live_judgment(request: Request):
        body = await request.body()
        if not body:
            raise HTTPException(400, "empty body (expected a JSON judgment object)")
        if len(body) > _LIVE_JUDGMENT_MAX_BYTES:
            raise HTTPException(
                413,
                f"judgment too large ({len(body)} bytes > {_LIVE_JUDGMENT_MAX_BYTES})",
            )
        # Parse + re-emit so we (a) reject malformed JSON early and (b)
        # guarantee one self-contained record per line. A buggy client
        # POSTing a multi-line string would otherwise corrupt the JSONL
        # contract (each line = one valid object). Handle both
        # JSONDecodeError (well-formed UTF-8, bad JSON) AND
        # UnicodeDecodeError (raw bytes that aren't valid UTF-8) as
        # 400s — otherwise the latter trickles up as a 500 from
        # `json.loads`, which is misleading to a client sending bad
        # input.
        try:
            obj = json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            raise HTTPException(400, f"body is not valid JSON: {e}")
        if not isinstance(obj, dict):
            raise HTTPException(400, "judgment body must be a JSON object")

        session = _sanitize_slug(request.query_params.get("session", "default"), default="default")
        path = _ensure_out_dir() / f"live_{session}.jsonl"

        # Hard cap on file size — refuse the append rather than truncating
        # existing data, so a buggy client can't lose history. NOTE: the
        # pre-check + append is racy across concurrent POSTs to the same
        # session — two requests can both see `existing` below the cap
        # and then both write, briefly exceeding it. In practice this is
        # bounded by (concurrent-clients × _LIVE_JUDGMENT_MAX_BYTES), and
        # a typical live session has one client per session id, so the
        # race is theoretical. If a future scenario (shared session
        # across multiple panels) makes it real, the fix is to hold a
        # per-session asyncio.Lock around the stat + append.
        try:
            existing = path.stat().st_size
        except FileNotFoundError:
            existing = 0
        except OSError as e:
            raise HTTPException(
                500,
                f"could not stat live-judgment file ({path}): {e}",
            )
        line = json.dumps(obj, separators=(",", ":")) + "\n"
        line_bytes = line.encode("utf-8")
        if existing + len(line_bytes) > _LIVE_FILE_MAX_BYTES:
            raise HTTPException(
                413,
                f"live judgment file at cap ({existing} + {len(line_bytes)} > {_LIVE_FILE_MAX_BYTES})",
            )
        # Append-mode write — POSIX `O_APPEND` makes this atomic per-line
        # even under concurrent requests from a split-screen scenario.
        try:
            with path.open("ab") as f:
                f.write(line_bytes)
        except OSError as e:
            raise HTTPException(
                500,
                f"could not write to live-judgment file ({path}): {e}",
            )
        return {"ok": True, "appended": len(line_bytes), "file": f"static/{_RECORDINGS_REL}/{path.name}"}

    @app.post("/api/plugins/note_detect/training-bundle")
    async def upload_training_bundle(request: Request):
        # Body: { slug, wav_filename, session, manifest, arrangement, upload_url }.
        # Slug locates the WAV previously written by /recording; session
        # locates the JSONL written by /live-judgment (optional);
        # arrangement is the client-pinned ground-truth note chart
        # (optional). Bundles the WAV + JSONL + arrangement.json with the
        # supplied manifest into a zip and POSTs it to pCloud.
        # Cap the body as it streams in — refused before an oversized
        # manifest/arrangement is ever fully buffered into memory.
        raw = await _read_capped_body(request, _TRAINING_BODY_MAX_BYTES)
        try:
            body = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            raise HTTPException(400, f"body is not valid JSON: {e}")
        if not isinstance(body, dict):
            raise HTTPException(400, "body must be a JSON object")

        slug = _sanitize_slug(body.get("slug", ""), default="")
        if not slug:
            raise HTTPException(400, "missing or empty 'slug'")
        # session is optional. Do NOT coerce a missing one to a literal
        # "default" — that could attach a stale live_default.jsonl from
        # an unrelated take. An empty session simply means "no JSONL".
        session_raw = body.get("session")
        if session_raw is not None and not isinstance(session_raw, str):
            raise HTTPException(400, "'session' must be a string or null")
        session = _sanitize_slug(session_raw, default="") if session_raw else ""
        # `is None` → default to {}; any other non-dict (a list, "", 0)
        # is malformed input and rejected — `or {}` would have silently
        # swallowed those falsy non-dicts past the type check.
        manifest = body.get("manifest")
        if manifest is None:
            manifest = {}
        elif not isinstance(manifest, dict):
            raise HTTPException(400, "'manifest' must be a JSON object")
        # Per-request override for the pCloud destination — the user
        # sets this on the settings page. Null/missing falls back to the
        # curated default. A non-empty value that parses to no code is a
        # 400, NOT a silent fallback — otherwise a typo'd custom link
        # would route the contributor's take to the public dataset.
        upload_url_override = body.get("upload_url")
        if upload_url_override is not None and not isinstance(upload_url_override, str):
            raise HTTPException(400, "'upload_url' must be a string or null")
        pcloud_code = _parse_pcloud_code(upload_url_override)
        if pcloud_code is None:
            raise HTTPException(
                400,
                "'upload_url' contains no recognisable pCloud upload code "
                "(expected a puplink share URL, an uploadtolink URL, or a "
                "bare code) — clear the field to use the curated default",
            )

        base = _ensure_out_dir()

        # Locate the WAV. Prefer the exact filename the client got back
        # from its /recording save — globbing newest-for-slug can pair
        # this take's manifest/JSONL/arrangement with another panel's
        # WAV when two takes share a slug (splitscreen / rapid takes).
        wav_filename = body.get("wav_filename")
        if wav_filename is not None and not isinstance(wav_filename, str):
            raise HTTPException(400, "'wav_filename' must be a string or null")
        wav_path = None
        if wav_filename:
            cand = (base / wav_filename).resolve()
            try:
                cand.relative_to(base.resolve())
            except ValueError:
                raise HTTPException(400, "'wav_filename' is outside the recordings directory")
            if not re.fullmatch(r"note_detect_.+\.wav", cand.name):
                raise HTTPException(400, "'wav_filename' is not a note_detect recording")
            if not cand.is_file():
                raise HTTPException(404, f"recording not found: {cand.name}")
            wav_path = cand
        if wav_path is None:
            # Fallback for callers that didn't pass wav_filename: newest
            # WAV matching the slug.
            wav_candidates = sorted(
                base.glob(f"note_detect_{slug}_*.wav"),
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
            if not wav_candidates:
                raise HTTPException(
                    404,
                    f"no recording found for slug={slug!r} under {base} — "
                    "POST /recording first, then /training-bundle.",
                )
            wav_path = wav_candidates[0]

        # JSONL is optional — the client may have armed for training
        # without tuningMode on, or no judgments may have been streamed
        # yet. A missing session or missing file is a soft-skip.
        jsonl_path = (base / f"live_{session}.jsonl") if session else None
        has_jsonl = bool(jsonl_path) and jsonl_path.exists() and jsonl_path.is_file()

        # Compose server-authoritative manifest fields. The nested
        # sections we merge into must be objects: a client sending e.g.
        # "audio": "x" would otherwise make the `**` spread raise
        # TypeError and 500 instead of a clean 400.
        manifest = dict(manifest)
        for _sect in ("audio", "detect_stream"):
            if _sect in manifest and not isinstance(manifest[_sect], dict):
                raise HTTPException(
                    400, f"manifest '{_sect}' must be a JSON object if present")
        # schema / created_at identify THIS bundle format and build time
        # — assign unconditionally so a stale/malformed client value
        # can't mislabel the bundle.
        manifest["schema"] = "note_detect.training_bundle.v1"
        manifest["created_at"] = datetime.now(timezone.utc).isoformat()
        manifest["audio"] = {
            **(manifest.get("audio") or {}),
            "filename": wav_path.name,
            "bytes": wav_path.stat().st_size,
        }
        # detect_stream must reflect what's actually in the zip — set it
        # when a JSONL is bundled, drop any client-supplied section when
        # one isn't (else the manifest references a missing file).
        if has_jsonl:
            manifest["detect_stream"] = {
                **(manifest.get("detect_stream") or {}),
                "filename": jsonl_path.name,
                "bytes": jsonl_path.stat().st_size,
            }
        else:
            manifest.pop("detect_stream", None)

        # Ground-truth note chart supplied by the client (hw.getNotes /
        # getChords pinned at song:ended) — the training labels for the
        # recorded audio. Written into the bundle as arrangement.json.
        # Optional: a host that exposes no chart sends null.
        arrangement = body.get("arrangement")
        if arrangement is not None and not isinstance(arrangement, dict):
            raise HTTPException(400, "'arrangement' must be a JSON object or null")
        arrangement_json = None
        # `is not None`, not truthiness — a provided-but-empty object
        # ({}) is a valid chart submission and must still be written, to
        # match the documented contract (any arrangement object gets an
        # arrangement.json). Only a missing/null arrangement is omitted.
        if arrangement is not None:
            arrangement_json = json.dumps(arrangement, indent=2, sort_keys=True)
            notes = arrangement.get("notes")
            chords = arrangement.get("chords")
            manifest["arrangement_chart"] = {
                "filename": "arrangement.json",
                "note_count": len(notes) if isinstance(notes, list) else None,
                "chord_count": len(chords) if isinstance(chords, list) else None,
            }
        else:
            # No arrangement.json in the zip — drop any client-supplied
            # arrangement_chart so the manifest can't claim a chart the
            # bundle doesn't contain.
            manifest.pop("arrangement_chart", None)

        # Write the bundle zip. Filename mirrors the WAV's timestamp tail
        # so a take and its bundle sort adjacently in the recordings dir.
        bundle_name = "training_" + wav_path.stem.removeprefix("note_detect_") + ".zip"
        bundle_path = base / bundle_name
        tmp_path = bundle_path.with_suffix(bundle_path.suffix + ".tmp")
        try:
            with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.write(wav_path, arcname=wav_path.name)
                if has_jsonl:
                    zf.write(jsonl_path, arcname=jsonl_path.name)
                if arrangement_json is not None:
                    zf.writestr("arrangement.json", arrangement_json)
                zf.writestr(
                    "manifest.json",
                    json.dumps(manifest, indent=2, sort_keys=True),
                )
            tmp_path.replace(bundle_path)
        except OSError as e:
            if tmp_path.exists():
                try: tmp_path.unlink()
                except OSError: pass
            raise HTTPException(500, f"could not write training bundle: {e}")

        bundle_size = bundle_path.stat().st_size
        if bundle_size > _BUNDLE_MAX_BYTES:
            # Keep the zip on disk so the user can inspect / shrink it,
            # but don't ship a multi-GB blob to pCloud.
            raise HTTPException(
                413,
                f"bundle too large ({bundle_size} bytes > {_BUNDLE_MAX_BYTES}); "
                f"retained at {bundle_path}",
            )

        rel = f"static/{_RECORDINGS_REL}/{bundle_name}"
        log.info(
            "wrote training bundle %s (%d bytes); uploading to pCloud",
            bundle_name, bundle_size,
        )
        pcloud_filename = _sanitize_pcloud_filename(bundle_name)
        log.info(
            "uploading bundle to pCloud (local: %s, pcloud_filename: %s)",
            bundle_name, pcloud_filename,
        )
        try:
            pcloud_result = await _upload_to_pcloud(bundle_path, pcloud_filename, pcloud_code)
        except Exception as e:
            # Local bundle is retained so the user can retry. Don't 500
            # — the upload-failed-but-bundle-exists state is a valid
            # outcome the UI surfaces differently from "no bundle".
            log.warning(
                "pCloud upload failed (%s); bundle retained at %s, pcloud_filename=%s",
                e, bundle_path, pcloud_filename,
            )
            return {
                "ok": False,
                "error": str(e),
                "local_bundle": str(bundle_path),
                "relative_path": rel,
                "bundle_filename": bundle_name,
                # The name we ACTUALLY sent to pCloud (sanitized). Surfaced
                # so the UI can tell us "did the new sanitization even run"
                # — a tail of underscores here would mean the Python server
                # is still on stale code.
                "pcloud_filename": pcloud_filename,
                "bytes": bundle_size,
            }

        log.info(
            "uploaded training bundle %s (%d bytes) to pCloud: %s",
            bundle_name, bundle_size, pcloud_result,
        )
        return {
            "ok": True,
            "local_bundle": str(bundle_path),
            "relative_path": rel,
            "bundle_filename": bundle_name,
            "bytes": bundle_size,
            "pcloud_result": pcloud_result,
        }

    @app.get("/api/plugins/note_detect/config")
    async def get_config():
        # Single source of truth for the default pCloud upload
        # destination. settings.html fetches this on load so the default
        # code lives in exactly one place (here) instead of being
        # duplicated — and kept in sync by hand — in the renderer.
        return {"pcloud_default_url": _PCLOUD_DEFAULT_URL}

    @app.post("/api/plugins/note_detect/training-bundle/retry")
    async def retry_training_bundle(request: Request):
        # Re-upload a bundle zip that a previous /training-bundle call
        # wrote to disk but failed to push to pCloud. Body:
        # { local_bundle, upload_url }. No re-bundling — the existing zip
        # is sent verbatim, so a retry is cheap and the user keeps the
        # exact take they recorded.
        # Cap the body as it streams in — refused before an oversized
        # manifest/arrangement is ever fully buffered into memory.
        raw = await _read_capped_body(request, _TRAINING_BODY_MAX_BYTES)
        try:
            body = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            raise HTTPException(400, f"body is not valid JSON: {e}")
        if not isinstance(body, dict):
            raise HTTPException(400, "body must be a JSON object")

        local_bundle = body.get("local_bundle")
        if not local_bundle or not isinstance(local_bundle, str):
            raise HTTPException(400, "missing or invalid 'local_bundle'")
        upload_url_override = body.get("upload_url")
        if upload_url_override is not None and not isinstance(upload_url_override, str):
            raise HTTPException(400, "'upload_url' must be a string or null")
        pcloud_code = _parse_pcloud_code(upload_url_override)
        if pcloud_code is None:
            raise HTTPException(
                400,
                "'upload_url' contains no recognisable pCloud upload code "
                "— clear the field to use the curated default",
            )

        base = _ensure_out_dir()
        # Security: the client hands us a path, so confine it to the
        # recordings directory and require the training-bundle naming
        # shape. Anything else — a traversal, an arbitrary file — is
        # rejected; this endpoint must never upload a file the bundle
        # flow itself didn't create.
        try:
            bundle_path = Path(local_bundle).resolve()
            bundle_path.relative_to(base.resolve())
        except (ValueError, OSError):
            raise HTTPException(400, "'local_bundle' is outside the recordings directory")
        if not (bundle_path.name.startswith("training_")
                and bundle_path.suffix == ".zip"):
            raise HTTPException(400, "'local_bundle' is not a training bundle zip")
        if not bundle_path.is_file():
            raise HTTPException(404, f"bundle not found: {bundle_path}")

        bundle_size = bundle_path.stat().st_size
        # Same size guard as /training-bundle — a retry must not become a
        # way to push an arbitrarily large zip past the cap.
        if bundle_size > _BUNDLE_MAX_BYTES:
            raise HTTPException(
                413,
                f"bundle too large ({bundle_size} bytes > {_BUNDLE_MAX_BYTES}); "
                f"retained at {bundle_path}",
            )
        rel = f"static/{_RECORDINGS_REL}/{bundle_path.name}"
        pcloud_filename = _sanitize_pcloud_filename(bundle_path.name)
        log.info(
            "retrying pCloud upload for %s (pcloud_filename: %s)",
            bundle_path.name, pcloud_filename,
        )
        try:
            pcloud_result = await _upload_to_pcloud(bundle_path, pcloud_filename, pcloud_code)
        except Exception as e:
            log.warning(
                "pCloud retry upload failed (%s); bundle retained at %s",
                e, bundle_path,
            )
            return {
                "ok": False,
                "error": str(e),
                "local_bundle": str(bundle_path),
                "relative_path": rel,
                "bundle_filename": bundle_path.name,
                "pcloud_filename": pcloud_filename,
                "bytes": bundle_size,
            }

        log.info(
            "retry uploaded training bundle %s (%d bytes) to pCloud: %s",
            bundle_path.name, bundle_size, pcloud_result,
        )
        return {
            "ok": True,
            "local_bundle": str(bundle_path),
            "relative_path": rel,
            "bundle_filename": bundle_path.name,
            "bytes": bundle_size,
            "pcloud_result": pcloud_result,
        }

    async def _upload_to_pcloud(file_path: Path, filename: str, code: str) -> dict:
        # Stdlib-only (urllib) — the plugin must not hard-depend on a
        # third-party HTTP client (`requests` etc.) that isn't in
        # slopsmith's requirements. The urlopen call is sync, so wrap it
        # in a thread: a slow upload (15 MB over a residential up-link)
        # must not stall the event loop and starve other plugins.
        import urllib.parse
        import urllib.request
        import anyio

        def _post() -> dict:
            # pCloud's `uploadtolink` expects a POST with multipart/form-data
            # AND the stored filename supplied as the `names` query
            # parameter. It does NOT read the filename from the multipart
            # part — without `names` it rejects every upload with
            # `result=2001 "Invalid file/folder name"` (verified: the same
            # 2001 fires even for a request with no file at all, so it is
            # the missing `names`, not the file's name, that trips it).
            # The multipart file part must be field name `file`.
            query = urllib.parse.urlencode(
                {"code": code, "nopartial": "1", "names": filename})
            url = f"{_PCLOUD_UPLOAD_URL}?{query}"
            file_bytes = file_path.read_bytes()
            # Hand-built multipart/form-data body. The boundary is random
            # so it can't collide with the zip's bytes.
            boundary = "----slopsmithND" + secrets.token_hex(16)
            preamble = (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="file"; '
                f'filename="{filename}"\r\n'
                f"Content-Type: application/zip\r\n\r\n"
            ).encode("utf-8")
            epilogue = f"\r\n--{boundary}--\r\n".encode("utf-8")
            body = preamble + file_bytes + epilogue
            req = urllib.request.Request(
                url,
                data=body,
                method="POST",
                headers={
                    "Content-Type": f"multipart/form-data; boundary={boundary}",
                    "Content-Length": str(len(body)),
                },
            )
            with urllib.request.urlopen(req, timeout=_PCLOUD_TIMEOUT_S) as resp:
                status = resp.status
                raw = resp.read()
            try:
                data = json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError) as e:
                raise RuntimeError(
                    f"pCloud returned non-JSON response (HTTP {status}): "
                    f"{raw[:200]!r}"
                ) from e
            # pCloud encodes errors as a JSON 200 with `result != 0` —
            # don't rely on HTTP status alone.
            if data.get("result") != 0:
                raise RuntimeError(
                    f"pCloud rejected upload: result={data.get('result')}, "
                    f"error={data.get('error')!r}"
                )
            return data

        return await anyio.to_thread.run_sync(_post)

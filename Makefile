# slopsmith-plugin-notedetect — dev workflow
#
# Point SLOPSMITH_DIR at your slopsmith checkout (default: ../slopsmith).
# `make dev` brings up slopsmith with this plugin mounted via a compose overlay;
# edits to screen.js are live on the next page load.
#
# Put your per-machine settings (DLC_PATH, SLOPSMITH_PORT, SLOPSMITH_DIR) in
# a .env file next to this Makefile. It's gitignored and auto-loaded by both
# Make and Docker Compose, so `make dev` works without inline env vars.
# See .env.example for the full list.

# Load .env if present and export every variable it defines to the child
# processes Make spawns (compose needs them visible in its env, not just Make's).
-include .env
export

SLOPSMITH_DIR  ?= $(abspath ../slopsmith)
SLOPSMITH_PORT ?= 8000
PLUGIN_DIR     := $(abspath .)
FLASHCARD_DIR  ?= $(abspath ../slopsmith-plugin-flashcard)
OVERLAY        := $(PLUGIN_DIR)/docker-compose.slopsmith.yml
COMPOSE        := docker compose -f $(SLOPSMITH_DIR)/docker-compose.yml -f $(OVERLAY)

# PipeWire software monitor — routes your instrument input to speakers so you
# hear yourself while practicing. Hardware direct-monitor on your audio
# interface (if you have one) is always better; this is the zero-hardware fix.
#
# Picks a Rocksmith adapter automatically if present; override MONITOR_SRC to
# target something else (e.g. your USB audio interface's capture node).
MONITOR_SRC         ?= $(shell pactl list short sources 2>/dev/null | awk '/Rocksmith/ {print $$2; exit}')
MONITOR_SINK        ?= $(shell pactl get-default-sink 2>/dev/null)
MONITOR_LATENCY_MS  ?= 50
MONITOR_ID_FILE     := /tmp/slopsmith-monitor.id

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo
	@echo "Vars:"
	@echo "  SLOPSMITH_DIR=$(SLOPSMITH_DIR)"
	@echo "  SLOPSMITH_PORT=$(SLOPSMITH_PORT)   (override if 8000 is taken)"
	@echo "  PLUGIN_DIR=$(PLUGIN_DIR)"

.PHONY: check-slopsmith
check-slopsmith:
	@test -f $(SLOPSMITH_DIR)/docker-compose.yml || { \
	    echo "error: $(SLOPSMITH_DIR)/docker-compose.yml not found"; \
	    echo "       set SLOPSMITH_DIR=/path/to/slopsmith"; \
	    exit 1; }

# Scope to a single file with FILE=<name> (with or without .test.js suffix):
#   make test FILE=perfect-play
#   make test FILE=mapping-bass.test.js
TEST_FILES := $(if $(FILE),test/$(FILE:.test.js=).test.js,test/*.test.js)

.PHONY: test
test: ## Run node:test suite (FILE=<name> scopes to test/<name>.test.js)
	node --test $(TEST_FILES)

.PHONY: test-plays-roundtrip
test-plays-roundtrip: ## Server-side round-trip harness for the per-play history routes
	python3 test/plays-roundtrip.py

.PHONY: replay-fix-impact
replay-fix-impact: ## Replay snapshots through new analytics — measures residual / calibrator / sibling deltas. SONG=<dir> LIMIT=<N> VERBOSE=1.
	node test/replay-fix-impact.js --pull $(if $(SONG),--song $(SONG)) $(if $(LIMIT),--limit $(LIMIT)) $(if $(VERBOSE),--verbose)

.PHONY: calibrate-from-history
calibrate-from-history: ## Validate mic-latency against play snapshots. MIC_LATENCY=<ms> for current value (default 0).
	node test/calibrate-from-history.js $(if $(MIC_LATENCY),--mic-latency $(MIC_LATENCY)) $(if $(ROOT),--root $(ROOT))

# Default fixture matches the "4/127" baseline (commit 2e99ab0). Override with
# WAV=<path> for other takes. Companion .json in test/fixtures/ supplies
# chartStartTime automatically, so --wav-offset is not required.
WAV ?= test/fixtures/mexico-bass-take1.wav

.PHONY: test-wav
test-wav: ## Run WAV replay test on a fixture (WAV=<path> to override)
	node test/perfect-play.test.js --song Mexico --arrangement 3 --max-notes 200 --wav $(WAV)

# ── Harness layers ──────────────────────────────────────────────────────────
# Each target below is a discrete validation with quantitative output. They
# compose: `make test-pipeline` runs everything that doesn't need slopsmith
# running; `make test-all` additionally exercises the browser-pipeline paths.

.PHONY: test-ground-truth
test-ground-truth: ## Offline YIN per-pitch correctness against known-note WAVs (4 plucks, per-frame MIDI)
	node --test test/ground-truth.test.js

.PHONY: test-synth
test-synth: ## Synthesize a bass WAV from the chart and measure offline YIN hit rate against expected MIDIs
	node test/synthesize-bass.js
	node test/yin-offline.js test/fixtures/ground-truth/mexico-bass-synth.wav

.PHONY: test-pipeline
test-pipeline: ## Node-only validation bundle: pitch-relevant unit tests + ground-truth + offline synth analysis (no browser)
	@echo "=== Pitch-detection unit + ground-truth tests ==="
	node --test test/ground-truth.test.js test/yin-buffer-sizing.test.js test/yin-noise-tolerance.test.js
	@echo
	@echo "=== Offline YIN vs synthesized Mexico (pipeline capability ceiling) ==="
	$(MAKE) --no-print-directory test-synth
	@echo
	@echo "Note: test/mapping-bass.test.js and test/display-fingering.test.js"
	@echo "      have 7 pre-existing failures (unrelated to pitch detection)."
	@echo "      Run 'make test' to see them."

.PHONY: test-timing-latency
test-timing-latency: check-slopsmith ## Timing-latency harness: p95 scoring error vs onset-manifest attacks (browser)
	node test/timing-latency.test.js

.PHONY: test-replay
test-replay: check-slopsmith ## Replay-baseline on real-bass takes (browser; exposes player-accuracy floor)
	node test/replay-baseline.js

.PHONY: test-synth-replay
test-synth-replay: check-slopsmith ## Replay-baseline on the synthesized WAV (browser; measures end-to-end pipeline)
	node test/synthesize-bass.js
	node test/replay-baseline.js --fixture-dir test/fixtures/ground-truth --fixture-glob 'mexico-bass-synth.wav'

.PHONY: test-detector-bakeoff
test-detector-bakeoff: check-slopsmith ## YIN vs CREPE side-by-side on the open-strings ground-truth WAV (browser)
	node test/detector-bakeoff.js

# ── Session classifier ──────────────────────────────────────────────────────
# Decomposes a live-play session score into real buckets:
#   PIPELINE_HIT              — agreed by both pipeline and audio
#   PIPELINE_MISSED_REAL_PLAY — pipeline bug: audio had the expected pitch
#   USER_WRONG_PITCH          — player played different notes
#   USER_SILENT               — no pitch in the window
#
# Flow for a live session:
#   1) Load the song (don't click play yet). Paste into console:
#        _ndRecordStart(<seconds>, 'session.wav')
#      Use _ndRecordStart — NOT _ndRecordStartRaw — because _ndRecordStart
#      waits for the chart clock to advance before anchoring WAV t=0. That
#      elides the paste-to-click human lag and stores the correct
#      chartStartTime in the sidecar JSON, which the classifier needs for
#      per-chart-note alignment. _ndRecordStartRaw anchors at console-paste
#      time and is only correct when no song is playing.
#   2) Click play. Play through the song. Auto-stops at <seconds>, or call
#      _ndRecordStop() earlier.
#   3) make classify-session SESSION=session  (pulls WAV + dump, runs classifier)

# SESSION is optional — if unset, the latest .wav in the container is
# auto-selected. If set to a substring, the newest matching .wav is picked
# (so you can use SESSION=mexico to pick the latest mexico recording
# without knowing the timestamp suffix).
SESSION ?=

.PHONY: sessions
sessions: ## List available session recordings in the container (newest first)
	@docker exec slopsmith-web-1 sh -c 'ls -lt /tmp/nd_recordings/*.wav 2>/dev/null | awk "{ print \$$NF, \"(\"\$$5\" bytes)\" }"' | sed 's|/tmp/nd_recordings/||'

# Internal: resolve SESSION into an actual container filename stem.
# - SESSION empty           → newest .wav in the container
# - SESSION=foo (no dot)    → newest .wav whose name contains "foo"
# - SESSION=foo.wav or path → use verbatim (strip dir + .wav)
define RESOLVE_SESSION
  SRC=$$(docker exec slopsmith-web-1 sh -c '\
    if [ -z "$(SESSION)" ]; then \
      ls -t /tmp/nd_recordings/*.wav 2>/dev/null | head -1; \
    else \
      ls -t /tmp/nd_recordings/*$(SESSION)*.wav 2>/dev/null | head -1; \
    fi'); \
  if [ -z "$$SRC" ]; then \
    echo "no session WAV found$(if $(SESSION), matching '$(SESSION)',); available:"; \
    docker exec slopsmith-web-1 sh -c 'ls -t /tmp/nd_recordings/*.wav 2>/dev/null | sed "s|/tmp/nd_recordings/||"' | head -10 | sed 's/^/  /'; \
    exit 1; \
  fi; \
  NAME=$$(basename "$$SRC" .wav)
endef

.PHONY: pull-session
pull-session: ## Pull the latest (or matching) session + pipeline dump out of the container (SESSION=<substring> optional)
	@$(RESOLVE_SESSION); \
	echo "Pulling $$NAME..."; \
	docker cp slopsmith-web-1:$$SRC test/fixtures/$$NAME.wav && \
	(docker cp slopsmith-web-1:/tmp/nd_diag_dump.json test/fixtures/$$NAME.dump.json 2>/dev/null \
	    || echo "warn: no /tmp/nd_diag_dump.json in container (auto-dump needs to have fired)") ; \
	echo "Session artifacts: test/fixtures/$$NAME.{wav,dump.json}"

# Optional flags passed through to classify-session.js:
#   OFFSET_SWEEP=1 — run the audio-truth offset sweep to benchmark what score
#                    ceiling each hypothesized input-latency Δ would yield.
CLASSIFY_FLAGS := $(if $(OFFSET_SWEEP),--offset-sweep,)

.PHONY: classify-session
classify-session: ## Bucket a session (SESSION=<substring> optional; OFFSET_SWEEP=1 runs latency-offset ceiling curve)
	@$(RESOLVE_SESSION); \
	docker cp slopsmith-web-1:$$SRC test/fixtures/$$NAME.wav >/dev/null; \
	docker cp slopsmith-web-1:/tmp/nd_recordings/$$NAME.dump.json test/fixtures/$$NAME.dump.json >/dev/null 2>&1 || true; \
	echo "Classifying $$NAME..."; \
	DUMP_ARG=""; \
	if [ -f test/fixtures/$$NAME.dump.json ]; then \
	    DUMP_ARG="--dump test/fixtures/$$NAME.dump.json"; \
	else \
	    echo "warn: no per-recording dump snapshot for $$NAME (session was recorded before routes.py started snapshotting them)"; \
	fi; \
	node test/classify-session.js --wav test/fixtures/$$NAME.wav $$DUMP_ARG $(CLASSIFY_FLAGS)

.PHONY: session-report
session-report: classify-session ## Classify the newest session + emit a human-readable report (markdown + terminal summary)
	@$(RESOLVE_SESSION); \
	node test/session-report.js --session $$NAME

.PHONY: report-dump
report-dump: ## Report on the current pipeline dump only (no WAV needed — for when you played without clicking Record)
	@docker cp slopsmith-web-1:/tmp/nd_diag_dump.json test/fixtures/latest.dump.json >/dev/null
	@node test/session-report.js --dump test/fixtures/latest.dump.json

# ── Loop-attempt aggregation ────────────────────────────────────────────────
# When the player loops a passage with slopsmith's A/B markers, the plugin
# snapshots one play per loop iteration to /tmp/nd_plays/<songId>/. This
# target pulls all per-iteration snapshots for a song and produces a
# best-of-N report — which notes hit consistently, which need practice.

.PHONY: loop-songs
loop-songs: ## List songs that have play snapshots in the container (newest first)
	@docker exec slopsmith-web-1 sh -c 'ls -td /tmp/nd_plays/*/ 2>/dev/null | sed "s|/tmp/nd_plays/||;s|/$$||"' || echo "(no play snapshots found)"

.PHONY: loop-report
loop-report: ## Aggregate plays into a best-of-N report (SONG=<substring> optional, newest if unset)
	@SONG_ARG=""; \
	if [ -n "$(SONG)" ]; then SONG_ARG="--song $(SONG)"; fi; \
	LAST_ARG=""; \
	if [ -n "$(LAST)" ]; then LAST_ARG="--last $(LAST)"; fi; \
	node test/aggregate-plays.js $$SONG_ARG $$LAST_ARG

.PHONY: synth-track
synth-track: ## Generate a chart-aligned synth WAV for a song and inject it into slopsmith's audio cache (SONG=<query>)
	@SONG_ARG=""; \
	if [ -n "$(SONG)" ]; then SONG_ARG="--song $(SONG)"; fi; \
	EVERY_BEAT=""; \
	if [ -n "$(EVERY_BEAT)" ]; then EVERY_BEAT="$(EVERY_BEAT)"; else EVERY_BEAT=""; fi; \
	DOWNBEATS_FLAG="--downbeats-only"; \
	if [ -n "$(EVERY_BEAT)" ]; then DOWNBEATS_FLAG=""; fi; \
	node test/synth-track.js $$SONG_ARG $$DOWNBEATS_FLAG

.PHONY: synth-restore
synth-restore: ## Restore the original audio for a song (SONG=<query>)
	@SONG_ARG=""; \
	if [ -n "$(SONG)" ]; then SONG_ARG="--song $(SONG)"; fi; \
	node test/synth-track.js $$SONG_ARG --restore

.PHONY: song-ceiling
song-ceiling: ## Pipeline ceiling for a song — feeds its OWN audio through classifier (SONG=<query>)
	@SONG_ARG=""; \
	if [ -n "$(SONG)" ]; then SONG_ARG="--song $(SONG)"; fi; \
	node test/song-ceiling.js $$SONG_ARG

.PHONY: silent-probe
silent-probe: ## Root-cause split for the USER_SILENT bucket on a song (STEM=<ceiling-stem>)
	@if [ -z "$(STEM)" ]; then \
	    echo "usage: make silent-probe STEM=<ceiling-stem>"; \
	    echo "       (stem is the basename in test/fixtures/song-ceiling/, e.g. ragebulls_m)"; \
	    exit 1; \
	fi; \
	node test/silent-probe.js --stem $(STEM)

.PHONY: onset-probe
onset-probe: ## Root-cause split for PIPELINE_MISSED_REAL_PLAY (onset didn't fire) — SESSION=<name> or STEM=<ceiling-stem>
	@if [ -n "$(SESSION)" ]; then \
	    node test/onset-probe.js --session $(SESSION); \
	elif [ -n "$(STEM)" ]; then \
	    node test/onset-probe.js --stem $(STEM); \
	else \
	    echo "usage: make onset-probe SESSION=<session-name>  OR  STEM=<ceiling-stem>"; \
	    exit 1; \
	fi

.PHONY: song-ceiling-roster
song-ceiling-roster: ## Run ceiling test across the curated roster (FORCE=1, EXTENDED=1, BANDPASS=1, SONGS="a,b,c")
	@FLAGS=""; \
	if [ -n "$(FORCE)" ]; then FLAGS="$$FLAGS --force"; fi; \
	if [ -n "$(REUSE)" ]; then FLAGS="$$FLAGS --reuse"; fi; \
	if [ -n "$(EXTENDED)" ]; then FLAGS="$$FLAGS --extended"; fi; \
	if [ -n "$(BANDPASS)" ]; then FLAGS="$$FLAGS --band-pass"; fi; \
	if [ -n "$(SONGS)" ]; then FLAGS="$$FLAGS --songs \"$(SONGS)\""; fi; \
	eval "node test/song-ceiling-roster.js $$FLAGS"

.PHONY: hygiene
hygiene: ## Scan the newest session for string-hygiene issues (open strings ringing, off-pitch contamination)
	@$(RESOLVE_SESSION); \
	docker cp slopsmith-web-1:$$SRC test/fixtures/$$NAME.wav >/dev/null 2>&1 || true; \
	docker cp slopsmith-web-1:/tmp/nd_recordings/$$NAME.json test/fixtures/$$NAME.json >/dev/null 2>&1 || true; \
	docker cp slopsmith-web-1:/tmp/nd_recordings/$$NAME.dump.json test/fixtures/$$NAME.dump.json >/dev/null 2>&1 || true; \
	if [ ! -f test/fixtures/$$NAME.dump.json ]; then \
	    echo "error: no per-recording dump snapshot for $$NAME"; \
	    exit 1; \
	fi; \
	node test/string-hygiene.js --wav test/fixtures/$$NAME.wav --dump test/fixtures/$$NAME.dump.json

.PHONY: test-all
test-all: check-slopsmith ## Everything: node suite + offline synth + browser replay + timing latency
	$(MAKE) --no-print-directory test-pipeline
	@echo
	@echo "=== Browser: timing-latency ==="
	$(MAKE) --no-print-directory test-timing-latency
	@echo
	@echo "=== Browser: replay on real takes ==="
	$(MAKE) --no-print-directory test-replay
	@echo
	@echo "=== Browser: replay on synth ==="
	$(MAKE) --no-print-directory test-synth-replay

.PHONY: diagnostic
diagnostic: ## Copy test/diagnostic-inject.js to clipboard; paste into Slopsmith browser console
	@command -v xclip >/dev/null 2>&1 || { echo "error: xclip not found (install xclip)"; exit 1; }
	@xclip -sel clip < test/diagnostic-inject.js
	@echo "diagnostic-inject.js copied to clipboard ($$(wc -c < test/diagnostic-inject.js) bytes)"
	@echo
	@echo "1. Open http://localhost:$(SLOPSMITH_PORT) and start a song"
	@echo "2. Open browser devtools console (F12)"
	@echo "3. Paste (Ctrl-V) and press Enter — floating diagnostic panel appears"

.PHONY: orient
orient: ## Session-start overview: recent commits, working tree, docs
	@echo "=== Recent commits ==="
	@git log --oneline -10
	@echo
	@echo "=== Working tree ==="
	@git status -s
	@echo
	@echo "=== docs/ ==="
	@ls docs/

.PHONY: dev
dev: check-slopsmith ## Start slopsmith with this plugin mounted (http://localhost:$(SLOPSMITH_PORT))
	$(COMPOSE) up -d
	@echo
	@echo "Slopsmith running at http://localhost:$(SLOPSMITH_PORT)"
	@echo "Edit screen.js here; reload the browser to see changes."
	@echo "Tail logs: make logs"

.PHONY: logs
logs: check-slopsmith ## Tail slopsmith container logs (Ctrl-C to exit)
	$(COMPOSE) logs -f web

.PHONY: restart
restart: check-slopsmith ## Restart slopsmith (picks up plugin.json / routes.py changes)
	$(COMPOSE) restart web

.PHONY: down
down: check-slopsmith ## Stop slopsmith
	$(COMPOSE) down

.PHONY: ps
ps: check-slopsmith ## Show slopsmith container status
	$(COMPOSE) ps

.PHONY: shell
shell: check-slopsmith ## Open a shell in the running slopsmith container
	$(COMPOSE) exec web bash

.PHONY: verify-mount
verify-mount: check-slopsmith ## Confirm the plugin is visible inside the container
	@$(COMPOSE) exec web ls -la /opt/user-plugins/note_detect 2>&1 | head -10 \
	    || echo "container not running — try 'make dev' first"

.PHONY: monitor-on
monitor-on: ## Route instrument input to speakers via PipeWire loopback ($(MONITOR_LATENCY_MS)ms)
	@command -v pactl >/dev/null 2>&1 || { echo "error: pactl not found (install pulseaudio-utils)"; exit 1; }
	@test -n "$(MONITOR_SRC)"  || { echo "error: no Rocksmith adapter detected. Set MONITOR_SRC=<source-name> (see: pactl list short sources)"; exit 1; }
	@test -n "$(MONITOR_SINK)" || { echo "error: could not determine default sink"; exit 1; }
	@if [ -f $(MONITOR_ID_FILE) ]; then \
	    echo "monitor already running (module $$(cat $(MONITOR_ID_FILE))). run 'make monitor-off' first."; \
	    exit 1; \
	fi
	@id=$$(pactl load-module module-loopback source=$(MONITOR_SRC) sink=$(MONITOR_SINK) latency_msec=$(MONITOR_LATENCY_MS)); \
	    echo $$id > $(MONITOR_ID_FILE); \
	    echo "loopback up (module $$id)"; \
	    echo "  source:  $(MONITOR_SRC)"; \
	    echo "  sink:    $(MONITOR_SINK)"; \
	    echo "  latency: $(MONITOR_LATENCY_MS)ms"; \
	    echo "tear down: make monitor-off"

.PHONY: monitor-off
monitor-off: ## Tear down the monitor loopback
	@if [ ! -f $(MONITOR_ID_FILE) ]; then echo "no monitor running"; exit 0; fi
	@id=$$(cat $(MONITOR_ID_FILE)); \
	    pactl unload-module $$id 2>/dev/null \
	        && echo "unloaded module $$id" \
	        || echo "module $$id was already gone (removing stale id file)"; \
	    rm -f $(MONITOR_ID_FILE)

.PHONY: monitor-status
monitor-status: ## Show current monitor state and detected audio devices
	@if [ -f $(MONITOR_ID_FILE) ]; then \
	    echo "monitor active: module $$(cat $(MONITOR_ID_FILE))"; \
	else \
	    echo "monitor not active"; \
	fi
	@echo
	@echo "Detected instrument input (MONITOR_SRC):"
	@echo "  $(MONITOR_SRC)"
	@echo "Default output sink (MONITOR_SINK):"
	@echo "  $(MONITOR_SINK)"
	@echo
	@echo "All input sources:"
	@pactl list short sources 2>/dev/null | grep -v '\.monitor' || true

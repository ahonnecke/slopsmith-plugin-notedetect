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

SESSION ?= session

.PHONY: pull-session
pull-session: ## Pull a recorded session + pipeline dump out of the container (SESSION=<name>)
	@docker cp slopsmith-web-1:/tmp/nd_recordings/$(SESSION).wav test/fixtures/$(SESSION).wav 2>&1 \
	    || { echo "error: /tmp/nd_recordings/$(SESSION).wav not found in container — did you _ndRecordStartRaw($(SESSION).wav) / _ndRecordStop()?"; exit 1; }
	@docker cp slopsmith-web-1:/tmp/nd_diag_dump.json test/fixtures/$(SESSION).dump.json 2>&1 \
	    || { echo "warn: no /tmp/nd_diag_dump.json in container (auto-dump needs to have fired at least once)"; }
	@echo "Session artifacts pulled to test/fixtures/$(SESSION).{wav,dump.json}"

.PHONY: classify-session
classify-session: pull-session ## Bucket a session's chart notes into PIPELINE_HIT / PIPELINE_MISSED_REAL_PLAY / USER_WRONG_PITCH / USER_SILENT
	@node test/classify-session.js \
	    --wav test/fixtures/$(SESSION).wav \
	    $(if $(wildcard test/fixtures/$(SESSION).dump.json),--dump test/fixtures/$(SESSION).dump.json,)

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

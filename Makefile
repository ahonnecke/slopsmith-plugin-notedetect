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

.PHONY: test
test: ## Run the plugin's node:test suite (no deps)
	npm test

.PHONY: test-yin
test-yin: ## Run only the YIN test files (fast iteration during detector tuning)
	@node --test test/yin-*.test.js 2>&1 | grep -E "^(# (tests|pass|fail|skipped)|not ok)" || true

.PHONY: syntax
syntax: ## Parse screen.js as JS (catches typos before browser reload)
	@node -e "new Function(require('fs').readFileSync('screen.js','utf-8')); console.log('screen.js: OK');"

.PHONY: stat
stat: ## Show staged/unstaged diff stats and short status (frequent during porting)
	@git diff --stat
	@echo "---"
	@git status -s

.PHONY: pull-recording
pull-recording: check-slopsmith ## Copy newest recording WAV+sidecars out of the container
	@latest=$$($(COMPOSE) exec -T web sh -c 'ls -1t /config/note_detect/recordings/*.wav 2>/dev/null | head -1' | tr -d '\r'); \
	    test -n "$$latest" || { echo "no recordings in /config/note_detect/recordings/"; exit 1; }; \
	    stem=$$(basename $$latest .wav); \
	    suffix=$$(date +%s); \
	    dest_wav=test/fixtures/staging/$${stem}-$${suffix}.wav; \
	    dest_dump=test/fixtures/staging/$${stem}-$${suffix}.dump.json; \
	    mkdir -p test/fixtures/staging; \
	    cid=$$($(COMPOSE) ps -q web); \
	    docker cp $$cid:$$latest $$dest_wav; \
	    docker cp $$cid:$${latest%.wav}.dump.json $$dest_dump 2>/dev/null || true; \
	    echo "pulled: $$dest_wav"; \
	    test -f $$dest_dump && echo "        $$dest_dump"

.PHONY: replay-baseline
replay-baseline: ## Run all WAV fixtures through the detector via puppeteer (slopsmith must be running)
	node test/replay-baseline.js --url http://localhost:$(SLOPSMITH_PORT) $(REPLAY_ARGS)

.PHONY: replay-gasoline
replay-gasoline: ## Replay just the gasoline fixtures
	node test/replay-baseline.js --url http://localhost:$(SLOPSMITH_PORT) --fixture-glob 'gasoline*.wav'

.PHONY: replay-analyze
replay-analyze: ## Summarize the most recent replay-results JSON
	@node test/analyze-replay.js

.PHONY: replay-diff
replay-diff: ## Diff two replay results: make replay-diff OLD=... NEW=...
	@node test/analyze-replay.js --diff $(OLD) $(NEW)

.PHONY: rebuild
rebuild: check-slopsmith ## Rebuild slopsmith container image (after slopsmith requirements.txt changes)
	$(COMPOSE) build --no-cache web
	$(COMPOSE) up -d
	@echo
	@echo "Slopsmith rebuilt and running at http://localhost:$(SLOPSMITH_PORT)"

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

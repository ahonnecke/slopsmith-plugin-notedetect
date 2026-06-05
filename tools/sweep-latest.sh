#!/usr/bin/env bash
# Reliable offline harness loop for note_detect — one command, no guesswork.
#
# Takes the NEWEST recording in the host-visible recordings dir and sweeps it
# through tools/harness.js, printing hits + recall per av-offset. This exists
# because setting this up by hand repeatedly wasted time; the gotchas that cost
# the most are baked in here so they can't bite again:
#
#   1. RECORDINGS LOCATION: they only land in host-visible
#      static/note_detect_recordings/ when STATIC_DIR=/app/static is set in
#      docker-compose (otherwise they fall to the /config volume, invisible
#      from the host). That env is set in slopsmith's docker-compose.yml.
#   2. CHART FORMAT: --chart must be sloppak WIRE format with `tuning` as
#      OFFSETS-from-standard (NOT absolute MIDI). Standard bass = [0,0,0,0].
#      Easiest correct chart: a sloppak's arrangements/<id>.json (ships right).
#   3. STRING COUNT: bass needs --arrangement bass --string-count 4, else the
#      harness computes guitar-tuned expected pitches → ~0 hits (false negative).
#   4. SAMPLE RATE: pulled from the WAV (Scarlett = 48000). Wrong rate smears.
#   5. AV-OFFSET: input latency is hundreds of ms — sweep, don't assume 0.
#   6. SAVE MUST FIRE: a take only writes a WAV on song-end OR the gear's "Save"
#      button. Arm → play → click Save. If this script finds no WAV, that's why.
#
# Usage:
#   tools/sweep-latest.sh <wire-chart.json> [arrangement=bass] [string-count=4] [method=hps]
set -euo pipefail

CHART="${1:?usage: sweep-latest.sh <wire-chart.json> [arrangement=bass] [string-count=4] [method=hps]}"
ARR="${2:-bass}"; SC="${3:-4}"; METHOD="${4:-hps}"
REC="${STATIC_RECORDINGS:-$HOME/src/slopsmith/static/note_detect_recordings}"

WAV="$(ls -t "$REC"/*.wav 2>/dev/null | head -1 || true)"
if [ -z "$WAV" ]; then
    echo "No WAV in $REC."
    echo "  -> In slopsmith: tuning-mode on, gear -> Arm -> play -> click Save (auto-saves on song-end too)."
    echo "  -> Confirm STATIC_DIR=/app/static in docker-compose (else recordings hide in /config)."
    exit 1
fi
[ -f "$CHART" ] || { echo "chart not found: $CHART (need sloppak wire format, tuning as offsets)"; exit 1; }

SR="$(ffprobe -v error -show_entries stream=sample_rate -of default=nk=1:nw=1 "$WAV" 2>/dev/null | head -1)"
DUR="$(ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$WAV" 2>/dev/null)"
echo "WAV:   $WAV"
echo "       sample_rate=$SR  duration=${DUR}s  method=$METHOD  arrangement=$ARR/$SC-string"
echo "CHART: $CHART"
echo "sweeping av-offset (hits = scored, recall = detector fired at all):"

cd "$(dirname "$0")/.."
for off in -100 -50 0 50 100 150 200 250 300 350 400; do
    node tools/harness.js --audio "$WAV" --chart "$CHART" --arrangement "$ARR" \
        --string-count "$SC" --method "$METHOD" --sample-rate "$SR" \
        --av-offset-ms="$off" --out /tmp/nd-sweep.json 2>/dev/null || { echo "  off=${off}ms  harness ERROR"; continue; }
    python3 - "$off" <<'PY'
import json,sys
off=sys.argv[1]; d=json.load(open('/tmp/nd-sweep.json')); s=d['summary']
ev=d.get('events',[]); fired=sum(1 for n in ev if n.get('dx') is not None)
acc=round(s['accuracy']*100) if s['accuracy']<1.5 else round(s['accuracy'])
print(f"  off={off:>4}ms  hits={s['hits']}/{s['total']} ({acc}%)  recall={round(100*fired/max(1,len(ev)))}%")
PY
done

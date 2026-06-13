#!/usr/bin/env bash
# Replay a RECORDED take through the detection pipeline — iterate without playing.
#
# A take is a (WAV, live_<id>.jsonl) pair in static/note_detect_recordings/.
# This reconstructs the chart from the log (chart-from-log.js), then sweeps the
# WAV through tools/harness.js across A/V offsets, printing hits + recall per
# offset. Same processFrame/matchNotes/checkMisses pipeline the browser runs —
# so detector tuning, A/V-offset calibration, and regression checks need ZERO
# human playing. Pass a WAV+log explicitly, or let it auto-pair the newest WAV
# with the newest log of the same song.
#
# Usage:
#   tools/replay-take.sh [<take.wav> <live_log.jsonl>] [arrangement=bass] [string-count=4] [method=hps]
#
# Examples:
#   tools/replay-take.sh                                  # newest WAV + its log
#   tools/replay-take.sh take.wav live_….jsonl bass 4 hps
set -euo pipefail

REC="${STATIC_RECORDINGS:-$HOME/src/slopsmith/static/note_detect_recordings}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

WAV="${1:-}"; LOG="${2:-}"
ARR="${3:-bass}"; SC="${4:-4}"; METHOD="${5:-hps}"

if [ -z "$WAV" ]; then
    WAV="$(ls -t "$REC"/*.wav 2>/dev/null | head -1 || true)"
    [ -n "$WAV" ] || { echo "No WAV in $REC. Arm tuning-mode, play, Save (auto-saves on song-end)."; exit 1; }
fi
if [ -z "$LOG" ]; then
    # Pair by song token in the WAV filename (note_detect_<SongTokens>_<ts>.wav).
    base="$(basename "$WAV")"; token="$(echo "$base" | sed -E 's/^note_detect_//; s/_[0-9]{8}_.*$//')"
    LOG="$(ls -t "$REC"/live_*.jsonl 2>/dev/null | while read -r f; do
        grep -q "\"title\": *\"$(echo "$token" | tr '_' ' ')" "$f" 2>/dev/null && echo "$f" && break
    done || true)"
    [ -n "$LOG" ] || LOG="$(ls -t "$REC"/live_*.jsonl 2>/dev/null | head -1)"
fi
[ -f "$WAV" ] || { echo "WAV not found: $WAV"; exit 1; }
[ -f "$LOG" ] || { echo "log not found: $LOG"; exit 1; }

CHART="$(mktemp /tmp/nd-replay-chart.XXXX.json)"
node "$HERE/tools/chart-from-log.js" "$LOG" --arrangement "$ARR" > "$CHART"
SR="$(ffprobe -v error -show_entries stream=sample_rate -of default=nk=1:nw=1 "$WAV" 2>/dev/null || echo 48000)"

echo "WAV:   $(basename "$WAV")  (sample_rate=$SR)"
echo "LOG:   $(basename "$LOG")"
echo "sweeping av-offset (hits = scored; recall = detector fired at all):"
cd "$HERE"
for off in -150 -100 -50 0 50 100 150 200 250 300 350; do
    node tools/harness.js --audio "$WAV" --chart "$CHART" --arrangement "$ARR" \
        --string-count "$SC" --method "$METHOD" --sample-rate "$SR" \
        --av-offset-ms="$off" --out /tmp/nd-replay.json 2>/dev/null || { echo "  off=${off}ms ERROR"; continue; }
    python3 - "$off" <<'PY'
import json,sys
off=sys.argv[1]; d=json.load(open('/tmp/nd-replay.json')); s=d['summary']
ev=d.get('events',[]); fired=sum(1 for n in ev if n.get('dx') is not None)
acc=round(s['accuracy']*100) if s['accuracy']<1.5 else round(s['accuracy'])
print(f"  off={off:>5}ms  hits={s['hits']}/{s['total']} ({acc}%)  recall={round(100*fired/max(1,len(ev)))}%")
PY
done
#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Reconstruct a sloppak-wire-format chart from a note_detect live JSONL log.
 *
 * A take's live_<id>.jsonl records every CHARTED note it judged — each row
 * carries t (chart time), s (string), f (fret), sus (sustain). Those are the
 * exact fields the matcher reads from getNotes(), so we can rebuild the chart
 * the take played against WITHOUT locating the original sloppak. Paired with
 * the take's WAV, this makes any recorded take replayable through tools/
 * harness.js — i.e. iterate on detection / A/V offset with ZERO playing.
 *
 *   node tools/chart-from-log.js <live_*.jsonl> [--arrangement bass] > chart.json
 *
 * Then: node tools/harness.js --audio take.wav --chart chart.json \
 *         --arrangement bass --string-count 4 --av-offset-ms=<N>
 * Or sweep offsets directly via tools/replay-take.sh.
 */
'use strict';

const fs = require('node:fs');

const logPath = process.argv[2];
if (!logPath || process.argv.includes('--help')) {
    process.stderr.write('usage: chart-from-log.js <live_*.jsonl> [--arrangement bass|guitar] > chart.json\n');
    process.exit(logPath ? 0 : 1);
}
const arrIdx = process.argv.indexOf('--arrangement');
const arrangement = arrIdx > -1 ? process.argv[arrIdx + 1] : 'bass';

const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim());
if (!lines.length) { process.stderr.write('empty log\n'); process.exit(1); }

let header = {};
try { header = JSON.parse(lines[0]); } catch (_) { /* not a session_start; treat all as rows */ }
const parsed = lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } });
// The WAV's chart-start offset (recording arms after song:play), stamped by
// auto-record as a rec_start row — replay-take.sh passes it to the harness so
// the audio aligns to the chart deterministically. Null if the take predates
// the stamp (then replay falls back to a coarse offset sweep).
const recStart = parsed.find((r) => r && r.type === 'rec_start');
const chartStartS = recStart && Number.isFinite(recStart.chart_start_s) ? recStart.chart_start_s : null;
const rows = parsed.filter((r) => r && r.type !== 'session_start' && r.type !== 'rec_start' && Number.isFinite(r.t));

// Dedup by chart key (a note may be re-judged across a drill loop) — keep the
// first occurrence. Single notes only: a chord logs one aggregate row, which
// still carries s/f so it reconstructs as a representative note (bass is
// overwhelmingly single-note; good enough for an A/V-offset sweep).
const seen = new Set();
const notes = [];
for (const r of rows) {
    const key = `${r.t}_${r.s}_${r.f}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notes.push({ t: r.t, s: r.s, f: r.f, sus: Number.isFinite(r.sus) ? r.sus : 0 });
}
notes.sort((a, b) => a.t - b.t);

// Bass standard tuning = offsets-from-standard [0,0,0,0] (4-string). The wire
// format wants OFFSETS, not absolute MIDI. Guitar = [0,0,0,0,0,0].
const tuning = arrangement === 'bass' ? [0, 0, 0, 0] : [0, 0, 0, 0, 0, 0];
const chart = {
    tuning,
    capo: (header.song && Number.isFinite(header.song.capo)) ? header.song.capo : 0,
    notes,
    chords: [],
    sections: [],
    chartStartS,   // chart time of the WAV's first sample (null if un-stamped)
    _source: { from: 'chart-from-log', log: logPath.split('/').pop(), song: header.song && header.song.title },
};
process.stdout.write(JSON.stringify(chart, null, 2));
process.stderr.write(`[chart-from-log] ${notes.length} notes, ${arrangement} tuning ${JSON.stringify(tuning)}, song=${(header.song && header.song.title) || '?'}, chartStartS=${chartStartS}\n`);

#!/usr/bin/env node
/**
 * String hygiene scanner — flags audio where the player should be silent
 * (or playing a different string) but a pitch is ringing through.
 *
 * Two failure modes addressed:
 *   1. Ringing during chart rests. The chart has gaps between notes; if
 *      pitched audio above a level threshold persists into those gaps,
 *      the player isn't damping the previous note before the next.
 *   2. Off-string contamination during a held note. Within an active
 *      chart note's window, multiple distinct pitches detected suggests
 *      another string is sounding alongside the intended one.
 *
 * Reads the same WAV + dump pair the classifier uses, derives the chart
 * from the dump (most accurate — captures the live chart at recording
 * time), and emits a per-event report plus an overall hygiene score.
 *
 * Usage:
 *   node test/string-hygiene.js --wav <wav> --dump <dump>
 *                               [--rest-min-sec 0.4]
 *                               [--ring-level 0.04]
 *                               [--cents-tolerance 50]
 *
 * Hygiene score = 1 - (rest-time-with-ringing / total-rest-time). 1.0
 * means clean rests; lower numbers mean strings are leaking through.
 */

const fs = require('fs');
const path = require('path');
const { loadDetectionCore } = require('./_loader');
const core = loadDetectionCore();

const args = process.argv.slice(2);
function getArg(n, d) { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; }

const WAV_PATH = getArg('wav', null);
const DUMP_PATH = getArg('dump', null);
const REST_MIN_SEC = parseFloat(getArg('rest-min-sec', '0.4'));
const RING_LEVEL = parseFloat(getArg('ring-level', '0.04')); // matches pipeline's onset gate
const CENTS_TOLERANCE = parseFloat(getArg('cents-tolerance', '50'));

if (!WAV_PATH || !DUMP_PATH) {
    console.error('usage: string-hygiene.js --wav <wav> --dump <dump>');
    process.exit(1);
}

const YIN_BUF = 4096;
const HOP_MS = 25;

function readWav(p) {
    const buf = fs.readFileSync(p);
    const sr = buf.readUInt32LE(24);
    const dataLen = buf.readUInt32LE(40);
    const n = dataLen / 2;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(44 + i * 2) / 32768;
    return { samples, sampleRate: sr };
}

function readSidecar(wavPath) {
    const j = wavPath.replace(/\.wav$/, '.json');
    return fs.existsSync(j) ? JSON.parse(fs.readFileSync(j, 'utf8')) : { chartStartTime: 0 };
}

function rms(samples, start, n) {
    let s = 0;
    const end = Math.min(samples.length, start + n);
    for (let i = start; i < end; i++) s += samples[i] * samples[i];
    return Math.sqrt(s / (end - start)) * 5;
}

function midiName(m) {
    return ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][m % 12] + (Math.floor(m / 12) - 1);
}

// Pull chart from dump and project chart times to WAV times.
function chartFromDump(dumpPath, chartStartTime) {
    const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
    const notes = [];
    const seen = new Set();
    for (const r of dump.noteResults || []) {
        const m = /^([\d.]+)_(\d+)_(\d+)$/.exec(r.key);
        if (!m) continue;
        if (seen.has(r.key)) continue;
        seen.add(r.key);
        notes.push({
            chartT: parseFloat(m[1]),
            wavT: parseFloat(m[1]) - chartStartTime,
            s: parseInt(m[2], 10),
            f: parseInt(m[3], 10),
            midi: r.expectedMidi ?? null,
        });
    }
    notes.sort((a, b) => a.wavT - b.wavT);
    const settings = dump.settings || {};
    return {
        notes,
        timingTolerance: settings.timingTolerance ?? 0.3,
        pitchTolerance: settings.pitchTolerance ?? 50,
    };
}

// Compute "rest periods" — gaps between active note windows. Each chart
// note is considered active from chartT - timingTolerance to
// chartT + 2*timingTolerance (matches the pipeline's asymmetric hit window).
function computeRestPeriods(notes, timingTolerance, wavDur) {
    const occupied = notes.map(n => ({
        start: Math.max(0, n.wavT - timingTolerance),
        end: n.wavT + 2 * timingTolerance,
    })).sort((a, b) => a.start - b.start);

    // Merge overlapping windows into contiguous "active" intervals.
    const merged = [];
    for (const w of occupied) {
        if (merged.length && w.start <= merged[merged.length - 1].end) {
            merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, w.end);
        } else {
            merged.push({ ...w });
        }
    }

    // Rests are the complement of merged within [0, wavDur].
    const rests = [];
    let cursor = 0;
    for (const w of merged) {
        if (w.start - cursor > 0) rests.push({ start: cursor, end: w.start });
        cursor = w.end;
    }
    if (wavDur - cursor > 0) rests.push({ start: cursor, end: wavDur });
    return rests.filter(r => r.end - r.start >= REST_MIN_SEC);
}

// Scan a time range with YIN, return per-frame readings.
function scanRange(samples, sampleRate, startSec, endSec) {
    const startSample = Math.floor(startSec * sampleRate);
    const endSample = Math.min(samples.length, Math.floor(endSec * sampleRate));
    const hop = Math.floor(sampleRate * HOP_MS / 1000);
    const frames = [];
    for (let s = startSample; s + YIN_BUF <= endSample; s += hop) {
        const level = rms(samples, s, YIN_BUF);
        const t = (s + YIN_BUF / 2) / sampleRate;
        if (level < RING_LEVEL) { frames.push({ t, level, midi: null, freq: 0 }); continue; }
        const r = core.yinDetect(samples.slice(s, s + YIN_BUF), sampleRate);
        if (r.freq <= 0 || r.confidence < 0.7) {
            frames.push({ t, level, midi: null, freq: 0 });
            continue;
        }
        const continuous = 69 + 12 * Math.log2(r.freq / 440);
        frames.push({ t, level, midi: Math.round(continuous), continuous, freq: r.freq });
    }
    return frames;
}

// Take a list of frames and return contiguous "ringing events" — runs
// where consecutive frames have midi != null and stay close in pitch.
function findRingingEvents(frames) {
    const events = [];
    let current = null;
    for (const fr of frames) {
        if (fr.midi == null) {
            if (current) { events.push(current); current = null; }
            continue;
        }
        if (current && Math.abs(fr.midi - current.midi) <= 1) {
            current.endT = fr.t;
            current.maxLevel = Math.max(current.maxLevel, fr.level);
            current.frameCount++;
        } else {
            if (current) events.push(current);
            current = { startT: fr.t, endT: fr.t, midi: fr.midi, maxLevel: fr.level, frameCount: 1 };
        }
    }
    if (current) events.push(current);
    // Drop tiny blips — need at least 3 frames (~75ms) to count as ringing.
    return events.filter(e => e.frameCount >= 3);
}

function main() {
    const wav = readWav(WAV_PATH);
    const meta = readSidecar(WAV_PATH);
    const wavDur = wav.samples.length / wav.sampleRate;
    const chart = chartFromDump(DUMP_PATH, meta.chartStartTime);

    // Looped recordings span multiple iterations of the chart, but the
    // dump deduplicates by (chartT, string, fret) so every chartT only
    // appears once. If we naïvely treat anything past the chart's last
    // note as "rest," all the iteration-2+ audio looks like ringing rest.
    // Limit the analysis window to one chart pass: from WAV t=0 up to
    // the last chart note's late-window edge.
    const chartMaxWavT = chart.notes.length > 0
        ? Math.max(...chart.notes.map(n => n.wavT)) + 2 * chart.timingTolerance
        : wavDur;
    const analyzeUntil = Math.min(wavDur, chartMaxWavT + 0.5);

    const rests = computeRestPeriods(chart.notes, chart.timingTolerance, analyzeUntil);

    console.log(`WAV:           ${WAV_PATH}  (${wavDur.toFixed(1)}s, analyzing first ${analyzeUntil.toFixed(1)}s — one chart pass)`);
    console.log(`Dump:          ${DUMP_PATH}`);
    console.log(`chartStartTime: ${meta.chartStartTime.toFixed(3)}s  (chart→wav offset)`);
    console.log(`Notes:         ${chart.notes.length}  timingTol=${chart.timingTolerance}s`);
    console.log(`Rest periods:  ${rests.length} (≥${REST_MIN_SEC}s)`);
    console.log(`Ring level:    ≥${RING_LEVEL} RMS, YIN conf ≥0.7`);
    console.log();

    // Scan each rest period for ringing events.
    let totalRestSec = 0;
    let ringingSec = 0;
    const allEvents = [];
    for (const rest of rests) {
        totalRestSec += rest.end - rest.start;
        const frames = scanRange(wav.samples, wav.sampleRate, rest.start, rest.end);
        const events = findRingingEvents(frames);
        for (const e of events) {
            ringingSec += e.endT - e.startT;
            // Find the previous chart note for context.
            const prev = chart.notes.filter(n => n.wavT <= rest.start).pop();
            const next = chart.notes.find(n => n.wavT >= rest.end);
            allEvents.push({
                ...e,
                duration: e.endT - e.startT,
                restStart: rest.start,
                restEnd: rest.end,
                prevNote: prev ? { wavT: prev.wavT, midi: prev.midi, sf: `s${prev.s}/f${prev.f}` } : null,
                nextNote: next ? { wavT: next.wavT, midi: next.midi, sf: `s${next.s}/f${next.f}` } : null,
            });
        }
    }

    const restHygiene = totalRestSec > 0 ? 1 - ringingSec / totalRestSec : 1;
    console.log(`── Pass 1: rest-period ringing ──`);
    console.log(`  Total rest time:    ${totalRestSec.toFixed(2)}s`);
    console.log(`  Time with ringing:  ${ringingSec.toFixed(2)}s`);
    console.log(`  Rest-hygiene score: ${(restHygiene * 100).toFixed(1)}%   (1.0 = clean rests, lower = strings leaking through silence)`);
    console.log(`  Ringing events:     ${allEvents.length}`);
    console.log();

    // ── Pass 2: off-pitch contamination during active note windows ──
    // For each chart note, scan its hit window. Count frames where YIN
    // returned a pitch that is NOT compatible with the expected MIDI
    // (compatible = ±cents-tolerance, OR exactly +12 semitones above —
    // octave harmonics are accepted by the live pipeline). Off-pitch
    // frames during an active note window mean another string is
    // ringing alongside the intended one. Open-string MIDIs (E1=28,
    // A1=33, D2=38, G2=43 for standard bass) are called out specifically
    // since those are what an undamped string sounds like.
    const OPEN_STRING_MIDIS = new Set([28, 33, 38, 43]);
    const contaminatedNotes = [];
    const contaminantCounts = new Map();
    for (const note of chart.notes) {
        if (note.midi == null) continue;
        if (note.wavT > analyzeUntil) continue;
        const winStart = Math.max(0, note.wavT - chart.timingTolerance);
        const winEnd = Math.min(analyzeUntil, note.wavT + 2 * chart.timingTolerance);
        const frames = scanRange(wav.samples, wav.sampleRate, winStart, winEnd);
        let pitchedFrames = 0;
        let onTarget = 0;
        const offTargetMidis = new Map();
        for (const fr of frames) {
            if (fr.midi == null) continue;
            pitchedFrames++;
            const fineCents = (fr.continuous - note.midi) * 100;
            const octCents = fineCents - 1200;
            const cents = Math.abs(octCents) < Math.abs(fineCents) ? octCents : fineCents;
            if (Math.abs(cents) <= CENTS_TOLERANCE) { onTarget++; continue; }
            offTargetMidis.set(fr.midi, (offTargetMidis.get(fr.midi) || 0) + 1);
        }
        if (pitchedFrames === 0) continue;
        const offRate = 1 - onTarget / pitchedFrames;
        const offMidis = [...offTargetMidis.entries()].sort((a, b) => b[1] - a[1]);
        const openLeaks = offMidis.filter(([m]) => OPEN_STRING_MIDIS.has(m));
        if (offRate >= 0.5) {
            contaminatedNotes.push({
                chartT: note.chartT,
                wavT: note.wavT,
                expectedMidi: note.midi,
                stringFret: `s${note.s}/f${note.f}`,
                pitchedFrames, onTarget, offRate,
                offMidis,
                openLeaks,
            });
        }
        for (const [m, c] of offMidis) {
            contaminantCounts.set(m, (contaminantCounts.get(m) || 0) + c);
        }
    }

    const noteHygiene = chart.notes.length > 0
        ? 1 - contaminatedNotes.length / chart.notes.length : 1;
    console.log(`── Pass 2: contamination during active note windows ──`);
    console.log(`  Notes scanned:           ${chart.notes.length}`);
    console.log(`  Notes with ≥50% off-pitch frames: ${contaminatedNotes.length}`);
    console.log(`  Note-hygiene score:      ${(noteHygiene * 100).toFixed(1)}%   (1.0 = every active window is clean)`);
    console.log();

    if (contaminantCounts.size > 0) {
        const sortedContaminants = [...contaminantCounts.entries()]
            .sort((a, b) => b[1] - a[1]);
        console.log(`── Top contaminating pitches across active windows ──`);
        console.log('  MIDI  note     frames  open string?');
        for (const [midi, count] of sortedContaminants.slice(0, 10)) {
            const tag = OPEN_STRING_MIDIS.has(midi) ? `← ${midiName(midi)} = open ${midi === 28 ? 'E' : midi === 33 ? 'A' : midi === 38 ? 'D' : 'G'}` : '';
            console.log(`  ${String(midi).padStart(4)}  ${midiName(midi).padEnd(5)}    ${String(count).padStart(4)}   ${tag}`);
        }
        console.log();
    }

    if (contaminatedNotes.length > 0) {
        console.log(`── Worst-contaminated chart notes (top 10) ──`);
        console.log('  chartT     exp   s/f    off%    contaminating pitches');
        for (const c of contaminatedNotes.slice().sort((a, b) => b.offRate - a.offRate).slice(0, 10)) {
            const top = c.offMidis.slice(0, 3).map(([m, n]) => `${midiName(m)}(${n})`).join(' ');
            console.log(`  ${c.chartT.toFixed(2).padStart(7)}s  ${String(c.expectedMidi).padStart(3)}   ${c.stringFret.padEnd(6)} ${(c.offRate * 100).toFixed(0).padStart(3)}%   ${top}`);
        }
        console.log();
    }

    // Pitch breakdown — what notes are leaking?
    const pitchTime = new Map();
    for (const e of allEvents) {
        const t = pitchTime.get(e.midi) || { duration: 0, count: 0 };
        t.duration += e.duration;
        t.count++;
        pitchTime.set(e.midi, t);
    }
    const sortedPitches = [...pitchTime.entries()].sort((a, b) => b[1].duration - a[1].duration);
    if (sortedPitches.length > 0) {
        console.log(`── Top leaking pitches ──`);
        console.log('  MIDI  note     events   total duration');
        for (const [midi, stats] of sortedPitches.slice(0, 8)) {
            console.log(`  ${String(midi).padStart(4)}  ${midiName(midi).padEnd(5)}    ${String(stats.count).padStart(4)}    ${stats.duration.toFixed(2)}s`);
        }
        console.log();
    }

    // Worst offenders — top events by max level (loudest leaks).
    const sortedEvents = [...allEvents].sort((a, b) => b.maxLevel - a.maxLevel);
    if (sortedEvents.length > 0) {
        console.log(`── Loudest leaks (top 10) ──`);
        console.log('  WAV-t       dur    midi/note  peak  prev chart note');
        for (const e of sortedEvents.slice(0, 10)) {
            const prev = e.prevNote ? `${e.prevNote.sf} MIDI ${e.prevNote.midi} @ ${e.prevNote.wavT.toFixed(2)}s` : '—';
            console.log(`  ${e.startT.toFixed(2).padStart(7)}s   ${e.duration.toFixed(2)}s   ${String(e.midi).padStart(3)} ${midiName(e.midi).padEnd(4)}    ${e.maxLevel.toFixed(2)}  ${prev}`);
        }
        console.log();
    }

    // Persist details for downstream consumers.
    const outPath = WAV_PATH.replace(/\.wav$/, '.hygiene.json');
    fs.writeFileSync(outPath, JSON.stringify({
        wav: WAV_PATH, dump: DUMP_PATH, chartStartTime: meta.chartStartTime,
        params: { REST_MIN_SEC, RING_LEVEL, CENTS_TOLERANCE, YIN_BUF, HOP_MS, analyzeUntil },
        passes: {
            rest: { totalRestSec, ringingSec, hygieneScore: restHygiene, eventCount: allEvents.length, events: allEvents,
                pitchBreakdown: sortedPitches.map(([m, s]) => ({ midi: m, name: midiName(m), ...s })) },
            note: {
                noteCount: chart.notes.length,
                contaminatedCount: contaminatedNotes.length,
                hygieneScore: noteHygiene,
                contaminantCounts: [...contaminantCounts.entries()].map(([m, c]) => ({ midi: m, name: midiName(m), frames: c })),
                contaminatedNotes,
            },
        },
    }, null, 2));
    console.log(`Details written to ${path.relative(process.cwd(), outPath)}`);
}

main();

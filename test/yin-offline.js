#!/usr/bin/env node
/**
 * Offline YIN analysis — runs YIN on WAV samples directly, bypassing
 * AudioContext / ScriptProcessor. Isolates "is YIN broken on this audio"
 * from "is the replay pipeline mangling the audio before YIN sees it."
 *
 * Compares detected MIDI to the chart notes in the WAV's time window and
 * reports pitch-match rate.
 *
 * Usage:
 *   node test/yin-offline.js test/fixtures/mexico-bass-take1.wav
 *   node test/yin-offline.js test/fixtures/mexico-bass-take1.wav --hop 50 --stability 3
 */

const fs = require('fs');
const path = require('path');
const { loadDetectionCore } = require('./_loader');

const core = loadDetectionCore();

const args = process.argv.slice(2);
function getArg(name, d) {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
}
const WAV_PATH = args.find(a => a.endsWith('.wav')) || 'test/fixtures/mexico-bass-take1.wav';
const HOP_MS = parseInt(getArg('hop', '50'), 10);
const YIN_BUF = parseInt(getArg('buf', '4096'), 10);
const STABILITY = parseInt(getArg('stability', '3'), 10); // N-of-5 majority
const WINDOW_SIZE = 5;
const CENTS_TOL = parseInt(getArg('cents', '50'), 10);

function readWav(p) {
    const buf = fs.readFileSync(p);
    // Minimal WAV parser — PCM, 16-bit mono, RIFF/WAVE.
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('not a RIFF/WAVE file');
    }
    let off = 12;
    let fmt = null;
    let dataStart = -1, dataLen = -1;
    while (off < buf.length - 8) {
        const id = buf.toString('ascii', off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        if (id === 'fmt ') {
            fmt = {
                format: buf.readUInt16LE(off + 8),
                channels: buf.readUInt16LE(off + 10),
                sampleRate: buf.readUInt32LE(off + 12),
                bitsPerSample: buf.readUInt16LE(off + 22),
            };
        } else if (id === 'data') {
            dataStart = off + 8;
            dataLen = size;
            break;
        }
        off += 8 + size;
    }
    if (!fmt || dataStart < 0) throw new Error('malformed WAV');
    if (fmt.format !== 1) throw new Error(`expected PCM (1), got format ${fmt.format}`);
    if (fmt.bitsPerSample !== 16) throw new Error(`expected 16-bit PCM, got ${fmt.bitsPerSample}`);

    const sampleCount = dataLen / 2 / fmt.channels;
    const samples = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
        // Read first channel only; convert int16 -> float [-1, 1]
        const s = buf.readInt16LE(dataStart + i * 2 * fmt.channels);
        samples[i] = s / 32768;
    }
    return { samples, sampleRate: fmt.sampleRate, channels: fmt.channels, duration: sampleCount / fmt.sampleRate };
}

function readSidecar(wavPath) {
    const jsonPath = wavPath.replace(/\.wav$/, '.json');
    if (!fs.existsSync(jsonPath)) return { chartStartTime: 0 };
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

function rmsLevel(samples, start, n) {
    let sum = 0;
    const end = Math.min(samples.length, start + n);
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / (end - start)) * 5; // same *5 scaling as _ndInputLevel
}

function stabilityVote(history) {
    // Majority MIDI in the last WINDOW_SIZE frames, requires >= STABILITY agreement
    if (history.length < STABILITY) return -1;
    const counts = new Map();
    for (const m of history.slice(-WINDOW_SIZE)) {
        if (m < 0) continue;
        counts.set(m, (counts.get(m) || 0) + 1);
    }
    let best = -1, bestN = 0;
    for (const [m, n] of counts) if (n > bestN) { best = m; bestN = n; }
    return bestN >= STABILITY ? best : -1;
}

function main() {
    const wav = readWav(WAV_PATH);
    const meta = readSidecar(WAV_PATH);
    console.log(`WAV: ${WAV_PATH}`);
    console.log(`     ${wav.duration.toFixed(1)}s, ${wav.sampleRate}Hz, ${wav.channels}ch, ${wav.samples.length} samples`);
    console.log(`     chartStartTime: ${meta.chartStartTime}s`);
    console.log(`Analysis: YIN buf=${YIN_BUF} hop=${HOP_MS}ms stability=${STABILITY}-of-${WINDOW_SIZE} cents=${CENTS_TOL}`);

    const hopSamples = Math.floor(wav.sampleRate * HOP_MS / 1000);
    const silenceGate = 0.01;

    const rawDetections = []; // {wavT, midi, conf, level}
    const stableDetections = []; // {wavT, midi}

    const history = [];
    let rejConf = 0, rejGate = 0, rejUnderBuf = 0, yielded = 0;

    for (let start = 0; start + YIN_BUF <= wav.samples.length; start += hopSamples) {
        const frame = wav.samples.slice(start, start + YIN_BUF);
        const wavT = start / wav.sampleRate;
        const level = rmsLevel(wav.samples, start, YIN_BUF);

        if (level < silenceGate) {
            rejGate++;
            history.push(-1);
            if (history.length > WINDOW_SIZE) history.shift();
            continue;
        }

        const r = core.yinDetect(frame, wav.sampleRate);
        if (r.underBuffered) { rejUnderBuf++; history.push(-1); if (history.length > WINDOW_SIZE) history.shift(); continue; }
        if (r.freq <= 0 || r.confidence < 0.7) {
            rejConf++;
            history.push(-1);
            if (history.length > WINDOW_SIZE) history.shift();
            continue;
        }

        const midi = Math.round(core.freqToMidi(r.freq));
        rawDetections.push({ wavT, midi, freq: r.freq, conf: r.confidence, level });
        history.push(midi);
        if (history.length > WINDOW_SIZE) history.shift();

        const stable = stabilityVote(history);
        if (stable > 0) {
            const prev = stableDetections[stableDetections.length - 1];
            if (!prev || prev.midi !== stable) {
                stableDetections.push({ wavT, midi: stable });
                yielded++;
            }
        }
    }

    console.log(`\nDetection counts:`);
    console.log(`  frames processed: ${Math.floor((wav.samples.length - YIN_BUF) / hopSamples) + 1}`);
    console.log(`  rejected (silence): ${rejGate}`);
    console.log(`  rejected (low conf / no pitch): ${rejConf}`);
    console.log(`  rejected (underbuffered): ${rejUnderBuf}`);
    console.log(`  raw detections: ${rawDetections.length}`);
    console.log(`  stable detections (new note): ${stableDetections.length}`);

    // Build chart-note list (in-window)
    const chartNotes = parseChartNotes(meta.chartStartTime, wav.duration);
    console.log(`\nChart notes in WAV window [${meta.chartStartTime}s..${meta.chartStartTime + wav.duration}s]: ${chartNotes.length}`);

    // For each chart note, find nearest stable detection within ±500ms.
    // "Hit" = same MIDI (within cents tolerance).
    const searchMs = 500;
    let hits = 0, pitchMiss = 0, noCandidate = 0;
    const details = [];
    for (const cn of chartNotes) {
        const wavT = cn.chartT - meta.chartStartTime;
        // Find all stable detections within ±searchMs
        const windowed = stableDetections.filter(s => Math.abs(s.wavT - wavT) * 1000 <= searchMs);
        if (windowed.length === 0) {
            noCandidate++;
            details.push({ chartT: cn.chartT, expMidi: cn.midi, status: 'NO_CANDIDATE' });
            continue;
        }
        // Pick closest
        windowed.sort((a, b) => Math.abs(a.wavT - wavT) - Math.abs(b.wavT - wavT));
        const best = windowed[0];
        const cents = (best.midi - cn.midi) * 100;
        if (Math.abs(cents) <= CENTS_TOL) {
            hits++;
            details.push({ chartT: cn.chartT, expMidi: cn.midi, detMidi: best.midi, dtMs: (best.wavT - wavT) * 1000, status: 'HIT' });
        } else {
            pitchMiss++;
            details.push({ chartT: cn.chartT, expMidi: cn.midi, detMidi: best.midi, cents, status: 'PITCH_MISS' });
        }
    }

    console.log(`\nOffline YIN vs chart notes (±${searchMs}ms search, ±${CENTS_TOL}¢):`);
    console.log(`  ${hits}/${chartNotes.length} hits  (${(hits / chartNotes.length * 100).toFixed(1)}%)`);
    console.log(`  pitch misses: ${pitchMiss}`);
    console.log(`  no stable detection within ±${searchMs}ms: ${noCandidate}`);

    // Histogram of detected-vs-expected MIDI errors (for pitch misses)
    const errors = details.filter(d => d.status === 'PITCH_MISS').map(d => d.detMidi - d.expMidi);
    if (errors.length > 0) {
        const counts = new Map();
        for (const e of errors) counts.set(e, (counts.get(e) || 0) + 1);
        console.log(`\n  Pitch-miss semitone error histogram:`);
        [...counts.entries()].sort((a, b) => a[0] - b[0]).forEach(([k, v]) => {
            console.log(`    ${k >= 0 ? '+' : ''}${k} semitones: ${v}`);
        });
    }

    // Save details for further analysis
    const outPath = WAV_PATH.replace(/\.wav$/, '.yin-offline.json');
    fs.writeFileSync(outPath, JSON.stringify({
        wav: WAV_PATH,
        sampleRate: wav.sampleRate,
        chartStartTime: meta.chartStartTime,
        params: { YIN_BUF, HOP_MS, STABILITY, CENTS_TOL },
        summary: { hits, pitchMiss, noCandidate, totalChart: chartNotes.length, rawDet: rawDetections.length, stableDet: stableDetections.length },
        rawDetections, stableDetections, details,
    }, null, 2));
    console.log(`\n  details written to ${path.relative(process.cwd(), outPath)}`);
}

// Temporary chart-note fixture — Mexico bass, sourced from the browser's
// highway.getNotes() on 2026-04-23. Each entry is {chartT, s, f, midi}.
// TODO: auto-fetch from the running slopsmith to avoid drift.
function parseChartNotes(chartStart, wavDur) {
    const wavEnd = chartStart + wavDur;
    return MEXICO_BASS_NOTES.filter(n => n.chartT >= chartStart && n.chartT <= wavEnd);
}

// Mexico bass — placeholder; loaded from a side file to avoid bloating this script.
// We'll dump this the first time the script runs (via a --capture flag) so it
// can be reused.
let MEXICO_BASS_NOTES = [];
try {
    MEXICO_BASS_NOTES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mexico-bass-notes.json'), 'utf8'));
} catch (e) {
    console.error(`\nERROR: test/fixtures/mexico-bass-notes.json not found.`);
    console.error(`Run the replay baseline once to capture chart notes, then retry.`);
    process.exit(1);
}

main();

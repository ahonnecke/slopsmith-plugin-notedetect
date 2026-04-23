#!/usr/bin/env node
/**
 * Run YIN on a WAV and segment by silence. For each non-silent segment,
 * report the dominant detected MIDI (pitch histogram + median).
 * Used for ground-truth recordings where the user plays known notes
 * separated by mutes.
 *
 * Usage:
 *   node test/yin-segments.js test/fixtures/ground-truth/open-strings.wav
 */

const fs = require('fs');
const { loadDetectionCore } = require('./_loader');
const core = loadDetectionCore();

const WAV_PATH = process.argv[2] || 'test/fixtures/ground-truth/open-strings.wav';
const YIN_BUF = 4096;
const HOP_MS = 50;
const SILENCE_LEVEL = 0.01;   // same as pipeline default
const SILENCE_MIN_S = 0.3;    // gap ≥300ms counts as a break between segments

function readWav(p) {
    const buf = fs.readFileSync(p);
    if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not RIFF');
    let off = 12, fmt = null, dataStart = -1, dataLen = -1;
    while (off < buf.length - 8) {
        const id = buf.toString('ascii', off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        if (id === 'fmt ') fmt = { sampleRate: buf.readUInt32LE(off + 12), channels: buf.readUInt16LE(off + 10), bps: buf.readUInt16LE(off + 22) };
        else if (id === 'data') { dataStart = off + 8; dataLen = size; break; }
        off += 8 + size;
    }
    const n = dataLen / 2 / fmt.channels;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(dataStart + i * 2 * fmt.channels) / 32768;
    return { samples, sampleRate: fmt.sampleRate };
}

function rms(samples, start, n) {
    let s = 0;
    const end = Math.min(samples.length, start + n);
    for (let i = start; i < end; i++) s += samples[i] * samples[i];
    return Math.sqrt(s / (end - start)) * 5;
}

function hzToNoteName(hz) {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const midi = Math.round(69 + 12 * Math.log2(hz / 440));
    return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

function analyze() {
    const wav = readWav(WAV_PATH);
    console.log(`WAV: ${WAV_PATH}  ${(wav.samples.length / wav.sampleRate).toFixed(1)}s, ${wav.sampleRate}Hz`);
    console.log(`YIN buf=${YIN_BUF} hop=${HOP_MS}ms silence<${SILENCE_LEVEL}\n`);

    const hop = Math.floor(wav.sampleRate * HOP_MS / 1000);
    const frames = []; // {wavT, active, midi, freq, conf}
    for (let start = 0; start + YIN_BUF <= wav.samples.length; start += hop) {
        const wavT = start / wav.sampleRate;
        const level = rms(wav.samples, start, YIN_BUF);
        if (level < SILENCE_LEVEL) {
            frames.push({ wavT, active: false });
            continue;
        }
        const frame = wav.samples.slice(start, start + YIN_BUF);
        const r = core.yinDetect(frame, wav.sampleRate);
        if (r.freq <= 0 || r.confidence < 0.7) {
            frames.push({ wavT, active: true, midi: null, level });
            continue;
        }
        const midi = Math.round(core.freqToMidi(r.freq));
        frames.push({ wavT, active: true, midi, freq: r.freq, conf: r.confidence, level });
    }

    // Segment: contiguous runs of "active" frames separated by >=SILENCE_MIN_S of silent frames
    const segments = [];
    let seg = null;
    let silenceRun = 0;
    for (const f of frames) {
        if (f.active) {
            if (!seg) seg = { start: f.wavT, end: f.wavT, frames: [] };
            seg.end = f.wavT;
            seg.frames.push(f);
            silenceRun = 0;
        } else {
            silenceRun += HOP_MS / 1000;
            if (seg && silenceRun >= SILENCE_MIN_S) {
                segments.push(seg);
                seg = null;
            }
        }
    }
    if (seg) segments.push(seg);

    console.log(`${segments.length} non-silent segments detected:\n`);
    for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        const midiFrames = s.frames.filter(f => f.midi != null);
        // Dominant MIDI histogram
        const counts = new Map();
        for (const f of midiFrames) counts.set(f.midi, (counts.get(f.midi) || 0) + 1);
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        const top3 = sorted.slice(0, 3).map(([m, n]) => `MIDI ${m} (${hzToNoteName(440 * Math.pow(2, (m - 69) / 12))}) ×${n}`).join(', ');
        const freqs = midiFrames.map(f => f.freq).sort((a, b) => a - b);
        const medianFreq = freqs.length ? freqs[Math.floor(freqs.length / 2)] : NaN;
        console.log(`  segment ${i + 1}: ${s.start.toFixed(2)}s–${s.end.toFixed(2)}s  (${(s.end - s.start).toFixed(1)}s, ${s.frames.length} frames, ${midiFrames.length} with pitch)`);
        console.log(`    top: ${top3 || '(none)'}`);
        if (isFinite(medianFreq)) console.log(`    median freq: ${medianFreq.toFixed(1)} Hz  (${hzToNoteName(medianFreq)})`);
    }

    // Overall timeline (every 0.5s)
    console.log(`\nTimeline (one line per 0.5s — dominant MIDI in that window):`);
    for (let t = 0; t < frames.length * HOP_MS / 1000; t += 0.5) {
        const inWin = frames.filter(f => f.wavT >= t && f.wavT < t + 0.5);
        const active = inWin.filter(f => f.active);
        if (active.length === 0) {
            console.log(`  ${t.toFixed(1).padStart(5)}s: (silence)`);
            continue;
        }
        const midiCounts = new Map();
        for (const f of active) if (f.midi != null) midiCounts.set(f.midi, (midiCounts.get(f.midi) || 0) + 1);
        const top = [...midiCounts.entries()].sort((a, b) => b[1] - a[1])[0];
        const level = active.reduce((s, f) => s + (f.level || 0), 0) / active.length;
        if (top) {
            console.log(`  ${t.toFixed(1).padStart(5)}s: MIDI ${top[0]} (${hzToNoteName(440 * Math.pow(2, (top[0] - 69) / 12))}) ×${top[1]}/${active.length}  level=${level.toFixed(3)}`);
        } else {
            console.log(`  ${t.toFixed(1).padStart(5)}s: active but no pitch, level=${level.toFixed(3)}`);
        }
    }
}

analyze();

#!/usr/bin/env node
/**
 * Mexico pitch autopsy — for each chart note in the replay window, extract
 * the audio around the note's chart time, run YIN on sliding windows, and
 * dump the full per-window detection. The question: when YIN reports
 * (e.g.) MIDI 41 where the chart expects MIDI 33, is that detection
 * CORRECT (the audio actually contains 82 Hz = E2) or WRONG (YIN is
 * making a mistake on a signal that contains the right fundamental)?
 *
 * Writes per-chart-note windows with raw YIN output so we can tell whether
 * to fix YIN, fix the audio pipeline, or accept that the recording
 * contains different notes than the chart expects.
 *
 * Usage:
 *   node test/mexico-pitch-autopsy.js test/fixtures/mexico-bass-take2.wav
 */

const fs = require('fs');
const path = require('path');
const { loadDetectionCore } = require('./_loader');
const core = loadDetectionCore();

const WAV_PATH = process.argv[2] || 'test/fixtures/mexico-bass-take2.wav';
const CHART_PATH = path.join(__dirname, 'fixtures', 'mexico-bass-notes.json');
const YIN_BUF = 4096;
const HOP_MS = 25;
const WINDOW_MS_BEFORE = 100;  // analyse from 100ms before chart time
const WINDOW_MS_AFTER = 400;   // ... to 400ms after
const SILENCE_GATE = 0.01;

function readWav(p) {
    const buf = fs.readFileSync(p);
    let off = 12, fmt = null, dataStart = -1, dataLen = -1;
    while (off < buf.length - 8) {
        const id = buf.toString('ascii', off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        if (id === 'fmt ') fmt = { sampleRate: buf.readUInt32LE(off + 12), channels: buf.readUInt16LE(off + 10) };
        else if (id === 'data') { dataStart = off + 8; dataLen = size; break; }
        off += 8 + size;
    }
    const n = dataLen / 2 / fmt.channels;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(dataStart + i * 2 * fmt.channels) / 32768;
    return { samples, sampleRate: fmt.sampleRate };
}

function readSidecar(wavPath) {
    const jsonPath = wavPath.replace(/\.wav$/, '.json');
    return fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : { chartStartTime: 0 };
}

function rms(samples, start, n) {
    let s = 0;
    const end = Math.min(samples.length, start + n);
    for (let i = start; i < end; i++) s += samples[i] * samples[i];
    return Math.sqrt(s / (end - start)) * 5;
}

function hzToMidiName(hz) {
    if (hz <= 0) return '';
    const midi = 69 + 12 * Math.log2(hz / 440);
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const r = Math.round(midi);
    return `MIDI ${r} ${names[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
}

function main() {
    const wav = readWav(WAV_PATH);
    const meta = readSidecar(WAV_PATH);
    const chart = JSON.parse(fs.readFileSync(CHART_PATH, 'utf8'));
    const inWindow = chart.filter(n => n.chartT >= meta.chartStartTime && n.chartT <= meta.chartStartTime + wav.samples.length / wav.sampleRate);

    console.log(`WAV: ${WAV_PATH}`);
    console.log(`Chart notes in WAV window: ${inWindow.length}  (chartStartTime=${meta.chartStartTime})`);
    console.log(`Per-note analysis: ${-WINDOW_MS_BEFORE}ms..+${WINDOW_MS_AFTER}ms around each chart time, YIN hop=${HOP_MS}ms\n`);

    const hop = Math.floor(wav.sampleRate * HOP_MS / 1000);
    const results = [];

    for (const cn of inWindow.slice(0, 20)) {
        const wavTchart = cn.chartT - meta.chartStartTime;
        const startT = wavTchart - WINDOW_MS_BEFORE / 1000;
        const endT = wavTchart + WINDOW_MS_AFTER / 1000;
        const startSample = Math.max(0, Math.floor(startT * wav.sampleRate));
        const endSample = Math.min(wav.samples.length, Math.floor(endT * wav.sampleRate));

        const detections = [];
        for (let s = startSample; s + YIN_BUF <= endSample; s += hop) {
            const level = rms(wav.samples, s, YIN_BUF);
            if (level < SILENCE_GATE) continue;
            const frame = wav.samples.slice(s, s + YIN_BUF);
            const r = core.yinDetect(frame, wav.sampleRate);
            const wavT = s / wav.sampleRate;
            if (r.freq <= 0 || r.confidence < 0.7) {
                detections.push({ wavT, offsetMs: (wavT - wavTchart) * 1000, midi: null, freq: r.freq, conf: r.confidence, level });
                continue;
            }
            const midi = Math.round(69 + 12 * Math.log2(r.freq / 440));
            detections.push({ wavT, offsetMs: (wavT - wavTchart) * 1000, midi, freq: r.freq, conf: r.confidence, level });
        }

        // Dominant MIDI histogram
        const counts = new Map();
        for (const d of detections) if (d.midi != null) counts.set(d.midi, (counts.get(d.midi) || 0) + 1);
        const topMidi = [...counts.entries()].sort((a, b) => b[1] - a[1]);

        console.log(`--- chart ${cn.chartT.toFixed(2)}s  s${cn.s}/f${cn.f}  expected MIDI ${cn.midi} (${hzToMidiName(440 * Math.pow(2, (cn.midi - 69) / 12))}) ---`);
        const hit = counts.get(cn.midi) || 0;
        const total = detections.filter(d => d.midi != null).length;
        console.log(`  ${total} pitched detections in window; expected-MIDI hits: ${hit}/${total}`);
        console.log(`  dominant MIDIs: ${topMidi.slice(0, 5).map(([m, n]) => `${m}×${n}`).join(' ')}`);
        // Print a compact per-frame view
        for (const d of detections) {
            const off = d.offsetMs.toFixed(0).padStart(5);
            const l = (d.level ?? 0).toFixed(3);
            if (d.midi == null) {
                console.log(`    ${off}ms  (no pitch)  lvl=${l}  conf=${(d.conf||0).toFixed(2)}  freq=${(d.freq||0).toFixed(1)}Hz`);
            } else {
                const matches = d.midi === cn.midi ? '✓' : '✗';
                console.log(`    ${off}ms  midi=${d.midi}  freq=${d.freq.toFixed(1)}Hz  conf=${d.conf.toFixed(2)}  lvl=${l}  ${matches}`);
            }
        }
        results.push({ chartT: cn.chartT, expectedMidi: cn.midi, expectedHits: hit, total, topMidi: topMidi.slice(0, 3) });
    }

    console.log(`\n=== Summary ===`);
    let totalExpectedHits = 0, totalPitched = 0;
    for (const r of results) {
        totalExpectedHits += r.expectedHits;
        totalPitched += r.total;
    }
    console.log(`Across ${results.length} analyzed chart notes:`);
    console.log(`  ${totalExpectedHits}/${totalPitched} frames detected the EXPECTED MIDI (${totalPitched > 0 ? (totalExpectedHits / totalPitched * 100).toFixed(1) : 0}%)`);
    const correctly_dominant = results.filter(r => r.topMidi[0] && r.topMidi[0][0] === r.expectedMidi).length;
    console.log(`  ${correctly_dominant}/${results.length} chart notes have EXPECTED MIDI as the dominant detection`);
    console.log(`\nIf the "frames correct" rate is low but the audio at the attack DOES briefly pass through expected MIDI, this is a stability-voting / buffer-sizing issue.`);
    console.log(`If the expected MIDI never appears in the detections even in the first 50-100ms post-attack, the audio genuinely doesn't contain that fundamental at that time — that's a play-accuracy or instrument-setup issue, not a pipeline fix.`);
}

main();

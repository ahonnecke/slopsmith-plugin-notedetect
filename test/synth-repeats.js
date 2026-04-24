#!/usr/bin/env node
/**
 * Synthesize a bass WAV of same-pitch plucks at 1.01 s intervals with
 * realistic sustain tails (so RMS doesn't fall below the onset-exit
 * threshold between plucks). Reproduces the MISSED_NO_DETECTION pattern
 * seen in the Level session where 10 of 12 pipeline misses were
 * same-pitch-as-previous with ~1000 ms gaps.
 *
 * Writes test/fixtures/ground-truth/same-pitch-repeats.wav + manifest.
 */

const fs = require('fs');
const path = require('path');

const SR = 48000;
const MIDI = 31;                // G1 — matches the Level pattern
const GAP_SEC = 1.010;          // just over the 1-sec same-MIDI guard
const NUM_PLUCKS = 6;
const PLUCK_AMP = 0.5;
const ATTACK_SEC = 0.008;
const TOTAL_SEC = GAP_SEC * NUM_PLUCKS + 0.5;
const OUT_WAV = path.join(__dirname, 'fixtures', 'ground-truth', 'same-pitch-repeats.wav');
const OUT_JSON = path.join(__dirname, 'fixtures', 'ground-truth', 'same-pitch-repeats.json');

function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

function renderPluck(samples, startSample, midi, amp) {
    const freq = midiToHz(midi);
    const attackSamples = Math.floor(SR * ATTACK_SEC);
    // Exponential decay spanning ~1.5 s so sustain overlaps the next pluck.
    const decayLen = Math.floor(SR * 1.5);
    const harmonics = [[1, 0.08], [2, 0.50], [3, 0.30], [4, 0.12]];
    for (let n = 0; n < decayLen; n++) {
        const i = startSample + n;
        if (i >= samples.length) break;
        let env;
        if (n < attackSamples) env = n / attackSamples;
        else {
            const d = (n - attackSamples) / decayLen;
            env = Math.pow(10, -2 * d); // -40 dB over decay span
        }
        let sum = 0;
        const t = i / SR;
        for (const [mult, w] of harmonics) sum += w * Math.sin(2 * Math.PI * freq * mult * t);
        samples[i] += sum * env * amp;
    }
}

function writeWav(p, samples) {
    const n = samples.length;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + n * 2, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(SR, 24);
    buf.writeUInt32LE(SR * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) {
        const c = Math.max(-1, Math.min(1, samples[i]));
        buf.writeInt16LE(c * 0x7FFF, 44 + i * 2);
    }
    fs.writeFileSync(p, buf);
}

function main() {
    const samples = new Float32Array(Math.floor(SR * TOTAL_SEC));
    const pluckTimes = [];
    for (let i = 0; i < NUM_PLUCKS; i++) {
        const t = 0.2 + i * GAP_SEC;
        pluckTimes.push(t);
        renderPluck(samples, Math.floor(t * SR), MIDI, PLUCK_AMP);
    }
    fs.mkdirSync(path.dirname(OUT_WAV), { recursive: true });
    writeWav(OUT_WAV, samples);
    fs.writeFileSync(OUT_JSON, JSON.stringify({
        chartStartTime: 0,
        sampleRate: SR,
        synthesized: true,
        kind: 'same-pitch-repeats',
        midi: MIDI,
        gap: GAP_SEC,
        plucks: pluckTimes.map(t => ({ chartT: t, expectedMidi: MIDI })),
    }, null, 2));
    console.log(`Wrote ${OUT_WAV} (${NUM_PLUCKS} plucks of MIDI ${MIDI} at ${GAP_SEC}s intervals, ${TOTAL_SEC.toFixed(1)}s total)`);
    console.log(`Pluck times: ${pluckTimes.map(t => t.toFixed(3)).join(', ')}`);
}

main();

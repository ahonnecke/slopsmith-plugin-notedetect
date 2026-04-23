#!/usr/bin/env node
/**
 * Synthesize a bass WAV from a chart-notes JSON. Produces clean, known-pitch
 * audio that can be run through the full pipeline to isolate "pipeline can
 * detect this" from "user played the right notes." If the pipeline scores
 * well on this, remaining real-recording misses are player-accuracy, not
 * a pipeline bug.
 *
 * Each chart note becomes a bass-like tone: weak fundamental + strong 2nd
 * harmonic + moderate 3rd + weak 4th (matches the profile used by
 * test/yin-noise-tolerance.test.js, which mirrors real bass harmonic
 * structure). Brief linear attack, exponential decay; notes mute before the
 * next attack to eliminate sustain-bleed confounds.
 *
 * Output: 16-bit PCM mono WAV at 48 kHz + a sidecar manifest compatible
 * with the replay-baseline harness (chartStartTime, sampleRate).
 *
 * Usage:
 *   node test/synthesize-bass.js                    # defaults
 *   node test/synthesize-bass.js --chart-start 25 --duration 60
 *   node test/synthesize-bass.js --out test/fixtures/ground-truth/mexico-bass-synth.wav
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function getArg(n, d) { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; }

const CHART_PATH = getArg('chart', path.join(__dirname, 'fixtures', 'mexico-bass-notes.json'));
const OUT_PATH = getArg('out', path.join(__dirname, 'fixtures', 'ground-truth', 'mexico-bass-synth.wav'));
const SAMPLE_RATE = parseInt(getArg('sample-rate', '48000'), 10);
const CHART_START = parseFloat(getArg('chart-start', '25.0')); // matches the real-take fixtures
const DURATION = parseFloat(getArg('duration', '60.0'));       // WAV length in seconds
const NOTE_SUSTAIN_SEC = parseFloat(getArg('note-sustain', '0.40')); // max ring time; auto-shortened if next note arrives sooner
const ATTACK_MS = parseFloat(getArg('attack-ms', '8'));
const AMPLITUDE = parseFloat(getArg('amplitude', '0.5'));
const NOISE_FLOOR = parseFloat(getArg('noise-floor', '0.002')); // ambient hum so silence-gate behavior is exercised

// Harmonic mix — same ratios as test/_signals.js realisticBass. Weak
// fundamental + strong 2nd is the reason the YIN octave-down fix matters;
// using the same profile here makes the synth pipeline test representative.
const HARMONICS = [
    [1, 0.08],
    [2, 0.50],
    [3, 0.30],
    [4, 0.12],
];

function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

function renderNote(samples, sampleRate, startSample, endSample, midi, amplitude) {
    const freq = midiToHz(midi);
    const attackSamples = Math.floor(sampleRate * ATTACK_MS / 1000);
    const decayLen = endSample - startSample - attackSamples;
    for (let i = startSample; i < endSample && i < samples.length; i++) {
        const n = i - startSample;
        let env;
        if (n < attackSamples) {
            env = n / attackSamples; // linear attack
        } else {
            // Exponential decay — full amplitude at attack end, -40 dB at endSample.
            const d = (n - attackSamples) / decayLen;
            env = Math.pow(10, -2 * d); // -40 dB over the decay span
        }
        let sum = 0;
        const t = i / sampleRate;
        for (const [mult, w] of HARMONICS) {
            sum += w * Math.sin(2 * Math.PI * freq * mult * t);
        }
        samples[i] += sum * env * amplitude;
    }
}

function addNoiseFloor(samples, rms, seed = 42) {
    let s = seed;
    const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; s ^= s >>> 16; return (s >>> 0) / 0xffffffff; };
    for (let i = 0; i < samples.length; i++) {
        samples[i] += (rng() - 0.5) * 2 * rms;
    }
}

function writeWav(path, samples, sampleRate) {
    const n = samples.length;
    const buffer = new ArrayBuffer(44 + n * 2);
    const view = new DataView(buffer);
    const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + n * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);  // PCM
    view.setUint16(22, 1, true);  // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
        const clamped = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, clamped * 0x7FFF, true);
    }
    fs.writeFileSync(path, Buffer.from(buffer));
}

function main() {
    const chart = JSON.parse(fs.readFileSync(CHART_PATH, 'utf8'));
    const inWindow = chart.filter(n => n.chartT >= CHART_START && n.chartT <= CHART_START + DURATION);
    console.log(`Chart: ${CHART_PATH}`);
    console.log(`Notes in window [${CHART_START}..${CHART_START + DURATION}]: ${inWindow.length} / ${chart.length}`);
    console.log(`Synth: ${SAMPLE_RATE} Hz, ${DURATION}s, amp=${AMPLITUDE}, attack=${ATTACK_MS}ms, sustain<=${NOTE_SUSTAIN_SEC}s`);

    const totalSamples = Math.floor(DURATION * SAMPLE_RATE);
    const samples = new Float32Array(totalSamples);

    for (let i = 0; i < inWindow.length; i++) {
        const n = inWindow[i];
        const startWavT = n.chartT - CHART_START;
        // End the note at min(sustain, next-note-time - small gap), so the
        // next attack rings cleanly without overlap from this note.
        const nextNoteWavT = i + 1 < inWindow.length
            ? (inWindow[i + 1].chartT - CHART_START - 0.020) // 20 ms mute gap before next
            : startWavT + NOTE_SUSTAIN_SEC;
        const endWavT = Math.min(startWavT + NOTE_SUSTAIN_SEC, nextNoteWavT);
        const startSample = Math.floor(startWavT * SAMPLE_RATE);
        const endSample = Math.floor(endWavT * SAMPLE_RATE);
        if (endSample <= startSample) continue;
        renderNote(samples, SAMPLE_RATE, startSample, endSample, n.midi, AMPLITUDE);
    }

    if (NOISE_FLOOR > 0) addNoiseFloor(samples, NOISE_FLOOR);

    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    writeWav(OUT_PATH, samples, SAMPLE_RATE);
    console.log(`Wrote WAV: ${OUT_PATH} (${(fs.statSync(OUT_PATH).size / 1024).toFixed(0)} KB)`);

    // Sidecar that matches the replay-baseline format.
    const sidecarPath = OUT_PATH.replace(/\.wav$/, '.json');
    fs.writeFileSync(sidecarPath, JSON.stringify({
        chartStartTime: CHART_START,
        sampleRate: SAMPLE_RATE,
        synthesized: true,
        chart: path.basename(CHART_PATH),
        noteCount: inWindow.length,
    }, null, 2));
    console.log(`Wrote sidecar: ${sidecarPath}`);
    console.log(`\nRun: make test-synth-replay`);
}

main();

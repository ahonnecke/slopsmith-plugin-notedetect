#!/usr/bin/env node
/**
 * Find pluck onsets in a WAV by RMS-spike detection, label each by running
 * YIN on the post-onset frame, and emit a ground-truth manifest suitable for
 * the timing-latency harness.
 *
 * Usage:
 *   node test/detect-onsets.js test/fixtures/ground-truth/timing-plucks.wav
 *
 * Writes `<wav-stem>.json` next to the WAV with per-onset `attackT` and
 * `expectedMidi`. Review the output — automatic onset finders are only about
 * as good as the signal and may need hand-editing for borderline cases.
 */

const fs = require('fs');
const path = require('path');
const { loadDetectionCore } = require('./_loader');
const core = loadDetectionCore();

const WAV_PATH = process.argv[2] || 'test/fixtures/ground-truth/timing-plucks.wav';
const OUT_PATH = WAV_PATH.replace(/\.wav$/, '.json');

// Onset detection parameters.
//
// Using threshold-crossing rather than a ratio-against-history detector
// because the latter has a warm-up problem: it needs N frames of history
// before it can evaluate a ratio, and a fresh attack after silence has no
// history (or history of silence) to compare against. Threshold-crossing
// handles silence → attack cleanly and is sufficient for curated fixtures.
// (The RUNTIME pipeline's onset detector — screen.js:747-762 — uses a ratio
// for different reasons: it's picking onsets out of continuous playing.
// Different problem, different tool.)
const RMS_FRAME_MS = 20;        // analysis frame
const ONSET_LEVEL = 0.04;       // RMS above this = playing; below = silence
const REFRACTORY_MS = 200;      // don't re-trigger inside an ongoing note
const LABEL_FRAME_SAMPLES = 4096; // YIN buffer for pitch label
const LABEL_OFFSET_MS = 100;    // wait this long after onset before labeling (let the transient settle)

function readWav(p) {
    const buf = fs.readFileSync(p);
    if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not RIFF');
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

function rms(samples, start, n) {
    let s = 0;
    const end = Math.min(samples.length, start + n);
    for (let i = start; i < end; i++) s += samples[i] * samples[i];
    return Math.sqrt(s / (end - start));
}

function findOnsets(samples, sampleRate) {
    const frameLen = Math.floor(sampleRate * RMS_FRAME_MS / 1000);
    const refractoryFrames = Math.floor(REFRACTORY_MS / RMS_FRAME_MS);
    const onsets = []; // {frameIdx, wavT, rms}
    let inNote = false;
    let lastOnsetFrame = -Infinity;

    for (let f = 0; f * frameLen + frameLen < samples.length; f++) {
        const frameRms = rms(samples, f * frameLen, frameLen);
        const playing = frameRms > ONSET_LEVEL;
        if (playing && !inNote && f - lastOnsetFrame > refractoryFrames) {
            onsets.push({ frameIdx: f, wavT: f * RMS_FRAME_MS / 1000, rms: frameRms });
            lastOnsetFrame = f;
            inNote = true;
        } else if (!playing && frameRms < ONSET_LEVEL * 0.5) {
            // Hysteresis — need to drop well below the threshold before we
            // consider the note ended. Otherwise a noisy sustain that
            // crosses the line both ways produces false re-triggers.
            inNote = false;
        }
    }
    return onsets;
}

function labelOnset(samples, sampleRate, onsetWavT) {
    // Sample a YIN frame LABEL_OFFSET_MS after the onset
    const start = Math.floor((onsetWavT + LABEL_OFFSET_MS / 1000) * sampleRate);
    if (start + LABEL_FRAME_SAMPLES > samples.length) return null;
    const frame = samples.slice(start, start + LABEL_FRAME_SAMPLES);
    const r = core.yinDetect(frame, sampleRate);
    if (r.freq <= 0 || r.confidence < 0.7) return null;
    return Math.round(69 + 12 * Math.log2(r.freq / 440));
}

function main() {
    const wav = readWav(WAV_PATH);
    console.log(`WAV: ${WAV_PATH}  (${(wav.samples.length / wav.sampleRate).toFixed(1)}s, ${wav.sampleRate}Hz)`);

    const onsets = findOnsets(wav.samples, wav.sampleRate);
    console.log(`\n${onsets.length} onset candidates:`);
    const labeled = [];
    for (const o of onsets) {
        const midi = labelOnset(wav.samples, wav.sampleRate, o.wavT);
        console.log(`  t=${o.wavT.toFixed(3)}s  rms=${o.rms.toFixed(3)}  ${midi != null ? `MIDI ${midi}` : 'no pitch'}`);
        if (midi != null) labeled.push({ attackT: o.wavT, expectedMidi: midi });
    }

    if (labeled.length === 0) {
        console.error('\nNo labeled onsets — nothing to write.');
        process.exit(1);
    }

    const manifest = {
        wav: path.basename(WAV_PATH),
        sampleRate: wav.sampleRate,
        arrangement: 'bass',
        kind: 'timing-latency',
        plucks: labeled.map((l, i) => ({
            label: `pluck ${i + 1} MIDI ${l.expectedMidi}`,
            attackT: l.attackT,
            expectedMidi: l.expectedMidi,
        })),
    };
    fs.writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2));
    console.log(`\nWrote ${path.relative(process.cwd(), OUT_PATH)}`);
    console.log('Review the manifest; hand-edit if any onset was missed or mislabeled.');
}

main();

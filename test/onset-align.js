#!/usr/bin/env node
/**
 * Onset-align salvage — scans a WAV for the first sustained audio onset and
 * (optionally) rewrites the sidecar chartStartTime to a correct value.
 *
 * Why this exists: older fixtures were captured with a procedure where the
 * user armed recording in the console, then clicked play some time later.
 * During the wait, the chart was paused, so the WAV has a silent prefix
 * that the sidecar's chartStartTime doesn't account for. The audio at
 * WAV t < onset is pre-play silence (chart frozen); audio at WAV t >= onset
 * is real playing content.
 *
 * To correctly rewrite chartStartTime, the script needs to know what chart
 * time corresponds to the detected onset. That's one of:
 *   --first-note-time <seconds>   chart time of the first note the user played
 *                                 (look up in the chart — the onset is assumed
 *                                 to be that note)
 *   --play-start-chart-time <sec> chart time when play was pressed (onset is
 *                                 then `firstNoteTime - playStartChartTime`
 *                                 into the WAV — requires knowing both)
 *
 * Without those, the script only reports the onset and annotates the sidecar;
 * it will NOT modify chartStartTime, because the naive
 * `newChartStart = oldChartStart + onsetSec` is wrong for paused-prefix
 * recordings (chart time doesn't advance during the silent prefix).
 *
 * Dry-run by default. Pass --write to update the sidecar on disk.
 *
 * Usage:
 *   node test/onset-align.js test/fixtures/mexico-bass-take1.wav
 *   node test/onset-align.js test/fixtures/*.wav --first-note-time 29.87 --write
 *   node test/onset-align.js path/to.wav --window-ms 20 --noise-mult 5
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function flag(name) { return args.includes(`--${name}`); }
function opt(name, def) {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const WRITE = flag('write');
const WINDOW_MS = parseInt(opt('window-ms', '20'), 10);
const NOISE_MULT = parseFloat(opt('noise-mult', '5')); // onset = noise_floor * mult
const NOISE_SECS = parseFloat(opt('noise-secs', '0.5')); // first N seconds = noise baseline
const MIN_ONSET_DB = parseFloat(opt('min-onset-db', '-40')); // never declare onset below this level
const SUSTAIN_MS = parseInt(opt('sustain-ms', '40'), 10); // require N ms of above-threshold
const FIRST_NOTE_TIME = opt('first-note-time', null); // chart-time of the first note (seconds)

const wavPaths = args.filter(a => !a.startsWith('--') && a.endsWith('.wav'));
if (wavPaths.length === 0) {
    console.error('usage: node test/onset-align.js <wav> [<wav>...] [--write] [--window-ms N] [--noise-mult K] [--noise-secs S] [--min-onset-db D] [--sustain-ms M]');
    process.exit(2);
}

function readWav(filePath) {
    const buf = fs.readFileSync(filePath);
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error(`${filePath}: not a RIFF/WAVE file`);
    }
    // Walk subchunks to find 'fmt ' and 'data'
    let off = 12;
    let fmt = null, data = null;
    while (off + 8 <= buf.length) {
        const id = buf.toString('ascii', off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        if (id === 'fmt ') {
            fmt = {
                audioFormat: buf.readUInt16LE(off + 8),
                numChannels: buf.readUInt16LE(off + 10),
                sampleRate: buf.readUInt32LE(off + 12),
                bitsPerSample: buf.readUInt16LE(off + 22),
            };
        } else if (id === 'data') {
            data = buf.slice(off + 8, off + 8 + size);
        }
        off += 8 + size + (size % 2); // pad to even
    }
    if (!fmt || !data) throw new Error(`${filePath}: missing fmt or data chunk`);
    if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
        throw new Error(`${filePath}: expected 16-bit PCM (got format=${fmt.audioFormat}, bits=${fmt.bitsPerSample})`);
    }
    // Decode as Float32 normalized to [-1, 1]. Mix channels if stereo.
    const numSamples = data.length / 2 / fmt.numChannels;
    const samples = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.numChannels; c++) {
            sum += data.readInt16LE((i * fmt.numChannels + c) * 2) / 0x7FFF;
        }
        samples[i] = sum / fmt.numChannels;
    }
    return { samples, sampleRate: fmt.sampleRate, numChannels: fmt.numChannels };
}

// Compute RMS over non-overlapping windows of windowSamples.
function windowedRms(samples, windowSamples) {
    const numWindows = Math.floor(samples.length / windowSamples);
    const rms = new Float32Array(numWindows);
    for (let w = 0; w < numWindows; w++) {
        const base = w * windowSamples;
        let sum = 0;
        for (let i = 0; i < windowSamples; i++) {
            const s = samples[base + i];
            sum += s * s;
        }
        rms[w] = Math.sqrt(sum / windowSamples);
    }
    return rms;
}

function median(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function toDb(rms) {
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

function detectOnset(wav) {
    const windowSamples = Math.floor(wav.sampleRate * WINDOW_MS / 1000);
    const rms = windowedRms(wav.samples, windowSamples);
    const windowsPerSec = wav.sampleRate / windowSamples;

    const noiseWindows = Math.floor(NOISE_SECS * windowsPerSec);
    if (noiseWindows >= rms.length) throw new Error('WAV shorter than noise baseline');
    const noiseFloor = median(rms.slice(0, noiseWindows)) || 1e-6;
    const thresholdRms = noiseFloor * NOISE_MULT;
    const minOnsetRms = Math.pow(10, MIN_ONSET_DB / 20);
    const effectiveThreshold = Math.max(thresholdRms, minOnsetRms);
    const sustainWindows = Math.max(1, Math.floor(SUSTAIN_MS / WINDOW_MS));

    let onsetWindow = -1;
    for (let w = noiseWindows; w + sustainWindows <= rms.length; w++) {
        let allAbove = true;
        for (let s = 0; s < sustainWindows; s++) {
            if (rms[w + s] < effectiveThreshold) { allAbove = false; break; }
        }
        if (allAbove) { onsetWindow = w; break; }
    }

    return {
        noiseFloorRms: noiseFloor,
        noiseFloorDb: toDb(noiseFloor),
        thresholdRms: effectiveThreshold,
        thresholdDb: toDb(effectiveThreshold),
        onsetWindow,
        onsetSec: onsetWindow >= 0 ? onsetWindow * WINDOW_MS / 1000 : null,
        onsetRmsDb: onsetWindow >= 0 ? toDb(rms[onsetWindow]) : null,
        totalDurationSec: wav.samples.length / wav.sampleRate,
    };
}

let anyWritten = false;
for (const wavPath of wavPaths) {
    const jsonPath = wavPath.replace(/\.wav$/, '.json');
    const abs = path.resolve(wavPath);
    console.log(`\n${path.relative(process.cwd(), abs)}`);

    let sidecar = null;
    if (fs.existsSync(jsonPath)) {
        sidecar = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        console.log(`  sidecar: chartStartTime=${sidecar.chartStartTime}s, sampleRate=${sidecar.sampleRate}`);
    } else {
        console.log(`  sidecar: (missing — will create ${path.basename(jsonPath)})`);
        sidecar = { chartStartTime: 0, sampleRate: 48000 };
    }

    let wav;
    try { wav = readWav(wavPath); }
    catch (e) { console.error(`  ERROR: ${e.message}`); continue; }

    const analysis = detectOnset(wav);
    console.log(`  duration: ${analysis.totalDurationSec.toFixed(2)}s  sampleRate: ${wav.sampleRate}Hz  channels: ${wav.numChannels}`);
    console.log(`  noise floor (first ${NOISE_SECS}s): ${analysis.noiseFloorDb.toFixed(1)} dB`);
    console.log(`  onset threshold: ${analysis.thresholdDb.toFixed(1)} dB (noise * ${NOISE_MULT}, floor ${MIN_ONSET_DB} dB)`);

    if (analysis.onsetSec === null) {
        console.log('  NO ONSET FOUND — cannot correct sidecar. Is the recording silent, or is the noise floor too high?');
        continue;
    }
    console.log(`  first sustained onset at: ${analysis.onsetSec.toFixed(3)}s (level ${analysis.onsetRmsDb.toFixed(1)} dB)`);

    const oldChartStart = Number(sidecar.chartStartTime) || 0;

    // Correct salvage requires knowing what chart time the onset corresponds to.
    // If --first-note-time is supplied, we assume the onset IS that first note
    // and derive chartStartTime = firstNoteTime - onsetSec (i.e., WAV t=0 is
    // in the paused-prefix region, and chart time advances normally from there
    // once playback begins).
    let newChartStart = null;
    let writableSidecar = { ...sidecar };
    writableSidecar.onsetAnalysis = {
        detectedOnsetSec: Number(analysis.onsetSec.toFixed(3)),
        onsetLevelDb: Number(analysis.onsetRmsDb.toFixed(1)),
        noiseFloorDb: Number(analysis.noiseFloorDb.toFixed(1)),
        thresholdDb: Number(analysis.thresholdDb.toFixed(1)),
        originalChartStartTime: oldChartStart,
        at: new Date().toISOString(),
    };

    if (FIRST_NOTE_TIME !== null) {
        const firstNote = parseFloat(FIRST_NOTE_TIME);
        newChartStart = firstNote - analysis.onsetSec;
        console.log(`  --first-note-time ${firstNote.toFixed(3)}s supplied → chartStartTime ${oldChartStart.toFixed(3)}s → ${newChartStart.toFixed(3)}s  (shift ${(newChartStart - oldChartStart).toFixed(3)}s)`);
        writableSidecar.chartStartTime = Number(newChartStart.toFixed(3));
        writableSidecar.onsetAnalysis.assumedFirstNoteTime = firstNote;
    } else {
        console.log(`  (no --first-note-time supplied — chartStartTime NOT modified; onset annotation only)`);
        console.log(`    To salvage: find the chart time of the first note you played in this take, then rerun with --first-note-time <sec> --write`);
    }

    if (WRITE) {
        fs.writeFileSync(jsonPath, JSON.stringify(writableSidecar, null, 2));
        console.log(`  WROTE ${path.relative(process.cwd(), jsonPath)}`);
        anyWritten = true;
    } else {
        console.log('  (dry-run — pass --write to update sidecar)');
    }
}

if (!WRITE) console.log('\nDry-run complete. Pass --write to apply.');
else if (anyWritten) console.log('\nSidecars updated. Re-run test/replay-baseline.js to measure impact.');

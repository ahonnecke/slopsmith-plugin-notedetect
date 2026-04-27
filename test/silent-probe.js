#!/usr/bin/env node
/**
 * Silent-bucket root-cause probe.
 *
 * `classify-session.js` puts a chart note in USER_SILENT when offline YIN
 * produced fewer than MIN_EXPECTED_FRAMES (= 2) pitched frames in the
 * analysis window. There are three distinct ways that can happen, with
 * very different fixes:
 *
 *   rms-gated        — every frame's raw RMS was below SILENCE_LEVEL.
 *                      Fix: lower the silence gate. Cheap and targeted.
 *
 *   yin-rejected     — frames had RMS, but YIN's confidence stayed below
 *                      MIN_CONFIDENCE (0.7). The bass-band signal was
 *                      contaminated by drums/guitar/vocals at higher
 *                      energy than the bass fundamental.
 *                      Fix: 30–250 Hz band-pass before YIN.
 *
 *   spectrum-missing — even after band-passing to the bass band, YIN
 *                      still rejects. The bass really isn't tonally
 *                      present — mastered into the floor, sub-octave
 *                      kick masking, or a part the chart claims but the
 *                      mix doesn't have.
 *                      Fix: nothing pipeline-side. This is a mix-quality
 *                      ceiling — only stems / DI tracks recover those notes.
 *
 * Probe runs the band-pass test in-line so we can split the bucket without
 * needing a second classifier pass.
 *
 * Usage:
 *   node test/silent-probe.js --classification <path>
 *   node test/silent-probe.js --stem <ceiling-stem>          # pick by stem
 *
 * The classification JSON is produced by `classify-session.js` and lives
 * next to the WAV at test/fixtures/song-ceiling/<stem>.classification.json.
 */

const fs = require('fs');
const path = require('path');
const { loadDetectionCore } = require('./_loader');

const args = process.argv.slice(2);
function getArg(n, d) { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; }

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'song-ceiling');
const STEM = getArg('stem', null);
const CLASSIFICATION_PATH = getArg('classification',
    STEM ? path.join(FIXTURE_DIR, `${STEM}.classification.json`) : null);
if (!CLASSIFICATION_PATH) {
    console.error('usage: --classification <path>  OR  --stem <ceiling-stem>');
    process.exit(1);
}

// Pipeline-matched constants (kept in sync with classify-session.js).
const YIN_BUF = 4096;
const HOP_MS = 25;
const SILENCE_LEVEL = 0.01;
const MIN_CONFIDENCE = 0.7;
const BAND_LOW_HZ = 30;
const BAND_HIGH_HZ = 250;

const core = loadDetectionCore();

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

// Audio EQ Cookbook biquad: 2nd-order Butterworth (Q = 1/√2).
// Cascading two of these = 4th-order = 24 dB/octave rolloff each side.
function biquadCoefs(type, fc, sampleRate) {
    const w0 = 2 * Math.PI * fc / sampleRate;
    const cs = Math.cos(w0), sn = Math.sin(w0);
    const Q = Math.SQRT1_2;
    const alpha = sn / (2 * Q);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'highpass') {
        b0 = (1 + cs) / 2;  b1 = -(1 + cs);  b2 = (1 + cs) / 2;
        a0 = 1 + alpha;     a1 = -2 * cs;    a2 = 1 - alpha;
    } else { // lowpass
        b0 = (1 - cs) / 2;  b1 = 1 - cs;     b2 = (1 - cs) / 2;
        a0 = 1 + alpha;     a1 = -2 * cs;    a2 = 1 - alpha;
    }
    return [b0/a0, b1/a0, b2/a0, a1/a0, a2/a0];
}

function applyBiquad(input, coefs) {
    const [b0, b1, b2, a1, a2] = coefs;
    const out = new Float32Array(input.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < input.length; i++) {
        const x = input[i];
        const y = b0*x + b1*x1 + b2*x2 - a1*y1 - a2*y2;
        out[i] = y;
        x2 = x1; x1 = x;
        y2 = y1; y1 = y;
    }
    return out;
}

// Cascade hp×2 + lp×2 (4th-order Butterworth band-pass 30–250 Hz).
function bandpass(input, sampleRate) {
    const hp = biquadCoefs('highpass', BAND_LOW_HZ, sampleRate);
    const lp = biquadCoefs('lowpass', BAND_HIGH_HZ, sampleRate);
    let s = input;
    s = applyBiquad(s, hp);
    s = applyBiquad(s, hp);
    s = applyBiquad(s, lp);
    s = applyBiquad(s, lp);
    return s;
}

function rms(samples, start, n) {
    let s = 0;
    const end = Math.min(samples.length, start + n);
    for (let i = start; i < end; i++) s += samples[i] * samples[i];
    return Math.sqrt(s / (end - start)) * 5;  // matches classify-session normalisation
}

// Scan a window with both raw and band-passed audio, returning per-frame
// max RMS and max YIN confidence for each path.
function scanForDiagnostics(samples, samplesBP, sampleRate, wavTchart, expectedMidi, beforeMs, afterMs) {
    const startSample = Math.max(0, Math.floor((wavTchart - beforeMs / 1000) * sampleRate));
    const endSample = Math.min(samples.length, Math.floor((wavTchart + afterMs / 1000) * sampleRate));
    const hop = Math.floor(sampleRate * HOP_MS / 1000);

    let rawRmsMax = 0, bpRmsMax = 0;
    let rawConfMax = 0, bpConfMax = 0;
    let rawPitchedFrames = 0, bpPitchedFrames = 0;
    let bpExpectedFrames = 0;
    let totalFrames = 0;

    for (let s = startSample; s + YIN_BUF <= endSample; s += hop) {
        totalFrames++;
        const lvlRaw = rms(samples, s, YIN_BUF);
        const lvlBP = rms(samplesBP, s, YIN_BUF);
        if (lvlRaw > rawRmsMax) rawRmsMax = lvlRaw;
        if (lvlBP > bpRmsMax) bpRmsMax = lvlBP;

        if (lvlRaw >= SILENCE_LEVEL) {
            const r = core.yinDetect(samples.slice(s, s + YIN_BUF), sampleRate);
            if (r.confidence > rawConfMax) rawConfMax = r.confidence;
            if (r.freq > 0 && r.confidence >= MIN_CONFIDENCE) rawPitchedFrames++;
        }
        if (lvlBP >= SILENCE_LEVEL) {
            const r = core.yinDetect(samplesBP.slice(s, s + YIN_BUF), sampleRate);
            if (r.confidence > bpConfMax) bpConfMax = r.confidence;
            if (r.freq > 0 && r.confidence >= MIN_CONFIDENCE) {
                bpPitchedFrames++;
                const midi = Math.round(69 + 12 * Math.log2(r.freq / 440));
                if (midi === expectedMidi) bpExpectedFrames++;
            }
        }
    }
    return { rawRmsMax, bpRmsMax, rawConfMax, bpConfMax,
             rawPitchedFrames, bpPitchedFrames, bpExpectedFrames, totalFrames };
}

function classifyCause(d) {
    if (d.rawRmsMax < SILENCE_LEVEL) return 'rms-gated';
    if (d.bpExpectedFrames >= 2) return 'yin-rejected-bp-recovers';
    if (d.bpPitchedFrames >= 2 && d.bpConfMax > MIN_CONFIDENCE) return 'yin-rejected-bp-wrong-pitch';
    return 'spectrum-missing';
}

function median(a) {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }

(function main() {
    const cls = JSON.parse(fs.readFileSync(CLASSIFICATION_PATH, 'utf8'));
    const wavPath = cls.wav;
    if (!fs.existsSync(wavPath)) throw new Error(`missing wav: ${wavPath}`);
    console.log(`Loading ${path.basename(wavPath)}…`);
    const { samples, sampleRate } = readWav(wavPath);
    console.log(`  ${samples.length} samples @ ${sampleRate}Hz (${(samples.length / sampleRate).toFixed(1)}s)`);

    console.log(`Band-passing ${BAND_LOW_HZ}–${BAND_HIGH_HZ} Hz (4th-order Butterworth)…`);
    const samplesBP = bandpass(samples, sampleRate);

    const beforeMs = cls.params.WINDOW_BEFORE_MS;
    const afterMs = cls.params.WINDOW_AFTER_MS;

    const silent = (cls.notes || []).filter(n => n.category === 'USER_SILENT');
    console.log(`USER_SILENT chart notes: ${silent.length}/${cls.totalNotes}`);
    if (!silent.length) { console.log('nothing to probe'); return; }

    const causes = { 'rms-gated': [], 'yin-rejected-bp-recovers': [],
                     'yin-rejected-bp-wrong-pitch': [], 'spectrum-missing': [] };
    const chartStartTime = cls.chartStartTime || 0;

    for (let i = 0; i < silent.length; i++) {
        const n = silent[i];
        const wavT = n.chartT - chartStartTime;
        const d = scanForDiagnostics(samples, samplesBP, sampleRate, wavT, n.expectedMidi, beforeMs, afterMs);
        const cause = classifyCause(d);
        causes[cause].push({ chartT: n.chartT, expectedMidi: n.expectedMidi, ...d });
        if ((i + 1) % 50 === 0 || i + 1 === silent.length) {
            process.stderr.write(`\r  scanned ${i + 1}/${silent.length}`);
        }
    }
    process.stderr.write('\n');

    console.log('\n═══ Silent-bucket root-cause split ═══');
    const order = ['rms-gated', 'yin-rejected-bp-recovers', 'yin-rejected-bp-wrong-pitch', 'spectrum-missing'];
    for (const k of order) {
        const bucket = causes[k];
        const pct = (bucket.length / silent.length * 100).toFixed(1).padStart(5);
        console.log(`  ${k.padEnd(30)} ${String(bucket.length).padStart(4)}/${silent.length}  ${pct}%`);
    }

    console.log('\n═══ Per-cause diagnostics (median / mean) ═══');
    for (const k of order) {
        const bucket = causes[k];
        if (!bucket.length) continue;
        console.log(`\n  ${k} (${bucket.length} notes):`);
        const rmsRaw = bucket.map(b => b.rawRmsMax);
        const rmsBP  = bucket.map(b => b.bpRmsMax);
        const confRaw = bucket.map(b => b.rawConfMax);
        const confBP = bucket.map(b => b.bpConfMax);
        console.log(`    raw rms_max:  median=${median(rmsRaw).toFixed(3)}  mean=${mean(rmsRaw).toFixed(3)}  (gate=${SILENCE_LEVEL})`);
        console.log(`    bp  rms_max:  median=${median(rmsBP).toFixed(3)}  mean=${mean(rmsBP).toFixed(3)}`);
        console.log(`    raw conf_max: median=${median(confRaw).toFixed(2)}  mean=${mean(confRaw).toFixed(2)}  (need=${MIN_CONFIDENCE})`);
        console.log(`    bp  conf_max: median=${median(confBP).toFixed(2)}  mean=${mean(confBP).toFixed(2)}`);
    }

    console.log('\n═══ Interpretation ═══');
    const recoverable = causes['yin-rejected-bp-recovers'].length;
    const recoverablePct = (recoverable / silent.length * 100).toFixed(1);
    if (recoverable / silent.length > 0.3) {
        console.log(`  ${recoverable}/${silent.length} (${recoverablePct}%) of silent notes RECOVER under a 30–250 Hz band-pass.`);
        console.log(`  → A pre-filter would lift the ceiling on this song. Consider implementing.`);
    } else if (causes['rms-gated'].length / silent.length > 0.2) {
        const rg = causes['rms-gated'].length;
        console.log(`  ${rg}/${silent.length} (${(rg / silent.length * 100).toFixed(1)}%) of silent notes are gate-rejected.`);
        console.log(`  → Lower the silence gate (or use median-of-window RMS instead of frame-RMS).`);
    } else {
        console.log(`  Most silent notes have no recoverable bass-band signal — this is a mix-quality ceiling, not a pipeline bug.`);
        console.log(`  → Pipeline change cannot lift this song. Look at stems or DI tracks instead.`);
    }

    const outPath = CLASSIFICATION_PATH.replace(/\.classification\.json$/, '.silent-probe.json');
    fs.writeFileSync(outPath, JSON.stringify({
        classification: path.basename(CLASSIFICATION_PATH),
        wav: wavPath,
        bandLowHz: BAND_LOW_HZ, bandHighHz: BAND_HIGH_HZ,
        silentTotal: silent.length,
        causeCounts: Object.fromEntries(order.map(k => [k, causes[k].length])),
        causes,
        measuredAt: new Date().toISOString(),
    }, null, 2));
    console.log(`\nwritten: ${path.relative(process.cwd(), outPath)}`);
})();

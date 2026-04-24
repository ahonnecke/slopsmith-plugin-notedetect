#!/usr/bin/env node
/**
 * Session classifier — given a recording + chart + optional pipeline dump,
 * classify every in-window chart note into one of:
 *
 *   PIPELINE_HIT              — pipeline said HIT (audio optional here)
 *   PIPELINE_MISSED_REAL_PLAY — pipeline said MISS but audio contains the
 *                               expected MIDI in the note's window. This
 *                               is the "pipeline bug" bucket.
 *   USER_WRONG_PITCH          — pipeline said MISS and audio contains a
 *                               different pitch. Player error.
 *   USER_SILENT               — pipeline said MISS and audio has no
 *                               confident pitch in the window.
 *   FALSE_POSITIVE            — pipeline said HIT but audio doesn't have
 *                               the expected pitch (rare; detector glitch).
 *
 * With no pipeline dump, runs in "audio-truth only" mode and reports what
 * the ceiling would be — how many notes have the expected pitch audibly
 * present, regardless of whether the live pipeline caught them.
 *
 * Also does a tolerance-sweep: for each chart note, reports the minimum
 * cents tolerance at which the audio would resolve to the expected MIDI.
 * Surfaces whether the defaults (50¢) are too tight for the recording.
 *
 * Usage:
 *   node test/classify-session.js --wav <wav> [--dump <dump.json>] [--chart <chart.json>]
 *
 * Example (validation against a known-bad take):
 *   node test/classify-session.js --wav test/fixtures/mexico-bass-take2.wav
 */

const fs = require('fs');
const path = require('path');
const { loadDetectionCore } = require('./_loader');
const core = loadDetectionCore();

const args = process.argv.slice(2);
function getArg(n, d) { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; }
const WAV_PATH = getArg('wav', 'test/fixtures/mexico-bass-take2.wav');
const CHART_PATH = getArg('chart', path.join(__dirname, 'fixtures', 'mexico-bass-notes.json'));
const DUMP_PATH = getArg('dump', null);

// Analysis parameters. The WINDOW_BEFORE/AFTER mirror the pipeline's
// asymmetric hit window (early 110 ms, late 220 ms at default tolerance)
// plus some margin on each side so we see the attack even if the player
// was early/late.
const YIN_BUF = 4096;
const HOP_MS = 25;
const WINDOW_BEFORE_MS = 150;
const WINDOW_AFTER_MS = 350;
const SILENCE_LEVEL = 0.01;       // same as pipeline silence gate
const MIN_CONFIDENCE = 0.7;       // same as pipeline
const MIN_EXPECTED_FRAMES = 2;    // need at least this many frames of expected pitch to call it "in the audio"

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

// For one chart note, analyze the audio window around chartT.
// Returns {expectedFrames, pitchedFrames, totalFrames, dominantMidi,
//          minCentsToMatch, bestCents} — the minimum cents tolerance
// at which the dominant detection would match expected.
function analyzeNoteWindow(samples, sampleRate, wavTchart, expectedMidi) {
    const startSample = Math.max(0, Math.floor((wavTchart - WINDOW_BEFORE_MS / 1000) * sampleRate));
    const endSample = Math.min(samples.length, Math.floor((wavTchart + WINDOW_AFTER_MS / 1000) * sampleRate));
    const hop = Math.floor(sampleRate * HOP_MS / 1000);

    const midiCounts = new Map();
    let expectedFrames = 0;
    let pitchedFrames = 0;
    let totalFrames = 0;
    let bestCentsErr = Infinity;

    for (let s = startSample; s + YIN_BUF <= endSample; s += hop) {
        totalFrames++;
        const level = rms(samples, s, YIN_BUF);
        if (level < SILENCE_LEVEL) continue;
        const frame = samples.slice(s, s + YIN_BUF);
        const r = core.yinDetect(frame, sampleRate);
        if (r.freq <= 0 || r.confidence < MIN_CONFIDENCE) continue;
        pitchedFrames++;
        const detMidi = Math.round(69 + 12 * Math.log2(r.freq / 440));
        midiCounts.set(detMidi, (midiCounts.get(detMidi) || 0) + 1);
        // Continuous-cents distance to expected (how close was the best frame?)
        const fineCents = (69 + 12 * Math.log2(r.freq / 440) - expectedMidi) * 100;
        // Also consider octave-up harmonic: a detection 12 semitones high
        // is tolerated by the live pipeline.
        const octCents = fineCents - 1200;
        const cents = Math.abs(octCents) < Math.abs(fineCents) ? octCents : fineCents;
        if (Math.abs(cents) < Math.abs(bestCentsErr)) bestCentsErr = cents;
        if (detMidi === expectedMidi) expectedFrames++;
    }

    // Dominant detected MIDI (for the USER_WRONG_PITCH case)
    const sorted = [...midiCounts.entries()].sort((a, b) => b[1] - a[1]);
    const dominantMidi = sorted[0]?.[0] ?? null;
    const dominantCount = sorted[0]?.[1] ?? 0;

    return {
        expectedFrames, pitchedFrames, totalFrames,
        dominantMidi, dominantCount,
        bestCents: isFinite(bestCentsErr) ? bestCentsErr : null,
    };
}

function classifyNote(audio, pipelineVerdict, chartNote) {
    // "Audio has expected" — at least N frames detected the expected MIDI.
    const audioHasExpected = audio.expectedFrames >= MIN_EXPECTED_FRAMES;
    const audioHasAnyPitch = audio.pitchedFrames >= MIN_EXPECTED_FRAMES;

    if (pipelineVerdict === 'HIT') {
        return audioHasExpected ? 'PIPELINE_HIT' : 'FALSE_POSITIVE';
    }
    // Pipeline MISS (or no verdict — treat as miss for out-of-pipeline runs).
    if (audioHasExpected) return 'PIPELINE_MISSED_REAL_PLAY';
    if (audioHasAnyPitch) return 'USER_WRONG_PITCH';
    return 'USER_SILENT';
}

function loadPipelineVerdicts(dumpPath) {
    if (!dumpPath) return new Map(); // audio-truth mode — every note defaults to MISS
    const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
    // noteResults is an array of {key, primary, ...} — key is like "s0/f3@32.17"
    const byChartT = new Map();
    for (const r of dump.noteResults || []) {
        const m = /@([\d.]+)$/.exec(r.key);
        if (m) byChartT.set(Math.round(parseFloat(m[1]) * 1000), r.primary || 'HIT');
    }
    return byChartT;
}

function main() {
    const wav = readWav(WAV_PATH);
    const meta = readSidecar(WAV_PATH);
    const chartStart = meta.chartStartTime;
    const wavDur = wav.samples.length / wav.sampleRate;
    const chart = JSON.parse(fs.readFileSync(CHART_PATH, 'utf8'));
    const inWindow = chart.filter(n => n.chartT >= chartStart && n.chartT <= chartStart + wavDur);

    const verdicts = loadPipelineVerdicts(DUMP_PATH);
    const hasDump = DUMP_PATH != null;

    console.log(`WAV:    ${WAV_PATH}  (${wavDur.toFixed(1)}s at ${wav.sampleRate}Hz)`);
    console.log(`Chart:  ${CHART_PATH}  — ${inWindow.length} notes in window [${chartStart}..${(chartStart + wavDur).toFixed(1)}]s`);
    console.log(`Dump:   ${hasDump ? DUMP_PATH : '(none — audio-truth mode; pipeline verdict assumed MISS)'}`);
    console.log(`Params: yin=${YIN_BUF}, hop=${HOP_MS}ms, window=${-WINDOW_BEFORE_MS}..+${WINDOW_AFTER_MS}ms, min-expected-frames=${MIN_EXPECTED_FRAMES}`);
    console.log();

    const classifications = [];
    const tolSweep = [25, 50, 75, 100, 150, 200];
    const tolWould = new Map(tolSweep.map(t => [t, 0]));

    for (const cn of inWindow) {
        const wavTchart = cn.chartT - chartStart;
        const audio = analyzeNoteWindow(wav.samples, wav.sampleRate, wavTchart, cn.midi);
        const verdictKey = Math.round(cn.chartT * 1000);
        const pipelineVerdict = verdicts.get(verdictKey) || 'MISS';
        const category = classifyNote(audio, pipelineVerdict, cn);

        classifications.push({ cn, audio, pipelineVerdict, category });

        // Tolerance sweep: at each cents tolerance, would the BEST frame
        // have matched? Uses the (already-octave-aware) bestCents.
        if (audio.bestCents != null) {
            for (const t of tolSweep) {
                if (Math.abs(audio.bestCents) <= t) tolWould.set(t, tolWould.get(t) + 1);
            }
        }
    }

    // Summary
    const buckets = new Map();
    for (const c of classifications) buckets.set(c.category, (buckets.get(c.category) || 0) + 1);
    const order = ['PIPELINE_HIT', 'PIPELINE_MISSED_REAL_PLAY', 'USER_WRONG_PITCH', 'USER_SILENT', 'FALSE_POSITIVE'];

    console.log('=== Classification ===');
    for (const k of order) {
        const n = buckets.get(k) || 0;
        const pct = inWindow.length ? (n / inWindow.length * 100).toFixed(1) : '0.0';
        console.log(`  ${k.padEnd(30)} ${String(n).padStart(4)} / ${inWindow.length}  (${pct.padStart(5)}%)`);
    }

    console.log();
    console.log('=== Tolerance sweep (how many notes would be audibly-in-pitch at each cents threshold) ===');
    console.log('  cents   hittable   % of chart');
    for (const t of tolSweep) {
        const n = tolWould.get(t);
        const pct = inWindow.length ? (n / inWindow.length * 100).toFixed(1) : '0.0';
        console.log(`  ±${String(t).padStart(3)}¢     ${String(n).padStart(4)}   ${pct.padStart(5)}%`);
    }

    // Per-note detail — only the misses, for post-mortem.
    console.log();
    console.log('=== Per-note detail (misses only) ===');
    console.log('  chartT   exp   dominant  frames-expected/total-pitched  bestCents   category');
    for (const c of classifications) {
        if (c.category === 'PIPELINE_HIT') continue;
        const a = c.audio;
        const best = a.bestCents != null ? `${a.bestCents.toFixed(0).padStart(5)}¢` : '    —';
        console.log(`  ${c.cn.chartT.toFixed(2).padStart(6)}s  ${String(c.cn.midi).padStart(3)}   ${String(a.dominantMidi ?? '—').padStart(8)}  ${String(a.expectedFrames).padStart(3)}/${String(a.pitchedFrames).padStart(3)}                    ${best}   ${c.category}`);
    }

    // Dump for further offline analysis (optional downstream consumers)
    const outPath = WAV_PATH.replace(/\.wav$/, '.classification.json');
    fs.writeFileSync(outPath, JSON.stringify({
        wav: WAV_PATH,
        chart: CHART_PATH,
        dump: DUMP_PATH,
        chartStartTime: chartStart,
        params: { YIN_BUF, HOP_MS, WINDOW_BEFORE_MS, WINDOW_AFTER_MS, MIN_EXPECTED_FRAMES },
        totalNotes: inWindow.length,
        buckets: Object.fromEntries(buckets),
        toleranceSweep: Object.fromEntries(tolWould),
        notes: classifications.map(c => ({
            chartT: c.cn.chartT,
            expectedMidi: c.cn.midi,
            stringFret: `s${c.cn.s}/f${c.cn.f}`,
            audio: c.audio,
            pipelineVerdict: c.pipelineVerdict,
            category: c.category,
        })),
    }, null, 2));
    console.log(`\nDetails written to ${path.relative(process.cwd(), outPath)}`);
}

main();

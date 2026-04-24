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
// Flags kept for explicit override, but the sensible defaults are
// automatic: if a dump is supplied, use its chart (fresher than any
// stored JSON); if the sidecar says chartStartTime=0, sweep for the
// real offset. --no-chart-from-dump and --no-auto-align disable them.
const CHART_FROM_DUMP = !args.includes('--no-chart-from-dump');
const AUTO_ALIGN_FORCE_ON = args.includes('--auto-align');
const AUTO_ALIGN_DISABLE = args.includes('--no-auto-align');
const AUTO_ALIGN_MIN = parseFloat(getArg('align-min', '-15'));
const AUTO_ALIGN_MAX = parseFloat(getArg('align-max', '5'));
const AUTO_ALIGN_STEP = parseFloat(getArg('align-step', '0.25'));

// Analysis parameters. The WINDOW_BEFORE/AFTER mirror the pipeline's
// asymmetric hit window (early 110 ms, late 220 ms at default tolerance)
// plus some margin on each side so we see the attack even if the player
// was early/late.
const YIN_BUF = 4096;
const HOP_MS = 25;
// Analysis window — matches the pipeline's asymmetric hit window at the
// session's timingTolerance (early=tolerance, late=2*tolerance). Widened
// when a dump supplies the live setting. Defaults cover the most-lenient
// 300 ms tolerance (early 300, late 600).
let WINDOW_BEFORE_MS = parseFloat(getArg('window-before-ms', '300'));
let WINDOW_AFTER_MS = parseFloat(getArg('window-after-ms', '600'));
const SILENCE_LEVEL = 0.01;       // same as pipeline silence gate
const MIN_CONFIDENCE = 0.7;       // same as pipeline
const MIN_EXPECTED_FRAMES = 2;    // need at least this many frames of expected pitch to call it "in the audio"
// Cents tolerance for "audio contains the expected pitch" — overridden by
// the dump's pitchTolerance when a dump is provided. Default matches the
// pipeline default of 50¢.
const DEFAULT_CENTS_TOLERANCE = parseFloat(getArg('cents-tolerance', '50'));

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

function classifyNote(audio, verdict, chartNote, centsTolerance) {
    // verdict is either a string 'MISS' (no dump) or a {primary, detectedMidi, ...}
    // object from the dump.
    const primary = typeof verdict === 'string' ? verdict : verdict.primary;
    if (primary === 'HIT') return 'PIPELINE_HIT';

    const audioHasExpected = audio.bestCents != null
        && Math.abs(audio.bestCents) <= centsTolerance;
    const audioHasAnyPitch = audio.pitchedFrames >= MIN_EXPECTED_FRAMES;

    // If audio lacks expected pitch, buckets are easy.
    if (!audioHasExpected) return audioHasAnyPitch ? 'USER_WRONG_PITCH' : 'USER_SILENT';

    // Audio HAS expected pitch but pipeline missed it. Distinguish:
    //   PIPELINE_MISSED_REAL_PLAY  — no detection attempted (onset didn't fire)
    //   PIPELINE_YIN_DISAGREES     — live YIN produced a different pitch than
    //                                offline YIN sees in the audio. That's a
    //                                live-state issue (buffer mixing,
    //                                octave-down misfire) distinct from onset.
    //   USER_WRONG_PITCH           — both live and offline YIN agree on a
    //                                pitch that doesn't match chart (the
    //                                detection was correctly attributed to
    //                                a same-pitch neighbor via nearest-in-time;
    //                                offline YIN happens to find the expected
    //                                pitch nearby but it's not what this
    //                                specific chart note got).
    if (primary === 'MISSED_NO_DETECTION') return 'PIPELINE_MISSED_REAL_PLAY';

    if (primary === 'MISSED_WRONG_PITCH' && typeof verdict === 'object'
            && verdict.pitchError != null && verdict.expectedMidi != null
            && audio.dominantMidi != null) {
        // Dump stores pitchError but NOT detectedMidi on MISS entries
        // (detectedMidi is null for MISSes). Reconstruct what live YIN
        // returned: scoreMidi = expectedMidi + pitchError/100, rounded.
        // (For MISS entries this is unambiguous — if the octave-up
        // adjustment would have been a closer fit, the note would have
        // been scored HIT rather than MISSED_WRONG_PITCH.)
        const liveMidi = Math.round(verdict.expectedMidi + verdict.pitchError / 100);
        const liveOfflineAgree = Math.abs(liveMidi - audio.dominantMidi) <= 0.5;
        if (!liveOfflineAgree) return 'PIPELINE_YIN_DISAGREES';
    }
    return 'USER_WRONG_PITCH';
}

// Dump key format: "chartT_string_fret" — a stringified triple, e.g. "11.918_0_1".
function parseDumpKey(k) {
    const m = /^([\d.]+)_(\d+)_(\d+)$/.exec(k);
    if (!m) return null;
    return { chartT: parseFloat(m[1]), s: parseInt(m[2], 10), f: parseInt(m[3], 10) };
}

function loadPipelineVerdicts(dumpPath) {
    if (!dumpPath) return new Map(); // audio-truth mode — every note defaults to MISS
    const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
    const byChartT = new Map();
    for (const r of dump.noteResults || []) {
        const parsed = parseDumpKey(r.key);
        if (!parsed) continue;
        byChartT.set(Math.round(parsed.chartT * 1000), {
            primary: r.primary || 'HIT',
            detectedMidi: r.detectedMidi,  // what live YIN output; null on NO_DETECTION
            pitchError: r.pitchError,
            timingError: r.timingError,
            expectedMidi: r.expectedMidi,
            labels: r.labels || [],
        });
    }
    return byChartT;
}

// The pipeline's primary flag distinguishes two kinds of MISS:
//   MISSED_NO_DETECTION  — no pitched audio attempted this note's window
//   MISSED_WRONG_PITCH   — a detection was attempted but failed pitch tolerance
// Classifier uses these to separate "pipeline dropped a correct pluck" (the
// real bug bucket) from "pipeline saw something that didn't match"
// (including nearest-in-time consumption by a same-pitch neighbor).
function pipelineMissKind(primary) {
    if (primary === 'MISSED_NO_DETECTION') return 'NO_DETECTION';
    if (primary === 'MISSED_WRONG_PITCH') return 'WRONG_PITCH_ATTEMPTED';
    return 'UNKNOWN'; // dump didn't judge this note at all
}

function chartFromDump(dumpPath) {
    const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
    const notes = [];
    const seen = new Set();
    for (const r of dump.noteResults || []) {
        const parsed = parseDumpKey(r.key);
        if (!parsed) continue;
        if (seen.has(r.key)) continue;
        seen.add(r.key);
        // expectedMidi is present on the result when the note ever had a pitch
        // attempt; default to computing from string/fret if absent.
        notes.push({
            chartT: parsed.chartT,
            s: parsed.s,
            f: parsed.f,
            midi: r.expectedMidi ?? null,
        });
    }
    notes.sort((a, b) => a.chartT - b.chartT);
    return notes;
}

// Audio-truth scoring of a proposed chartStartTime — count chart notes
// whose audio window contains the expected pitch within `centsTolerance`.
// Cents-based (not rounded-MIDI) so a detection at e.g. -82¢ still counts
// when the pipeline's tolerance is 100¢. Used by auto-align.
function scoreAlignment(samples, sampleRate, chart, chartStartTime, wavDur, centsTolerance) {
    let matches = 0;
    for (const cn of chart) {
        const wavT = cn.chartT - chartStartTime;
        if (wavT < 0 || wavT >= wavDur) continue;
        const startSample = Math.floor((wavT + 0.05) * sampleRate);
        if (startSample + YIN_BUF > samples.length) continue;
        const level = rms(samples, startSample, YIN_BUF);
        if (level < SILENCE_LEVEL) continue;
        const frame = samples.slice(startSample, startSample + YIN_BUF);
        const r = core.yinDetect(frame, sampleRate);
        if (r.freq <= 0 || r.confidence < MIN_CONFIDENCE) continue;
        const fineCents = (69 + 12 * Math.log2(r.freq / 440) - cn.midi) * 100;
        const octCents = fineCents - 1200;
        const cents = Math.abs(octCents) < Math.abs(fineCents) ? octCents : fineCents;
        if (Math.abs(cents) <= centsTolerance) matches++;
    }
    return matches;
}

function autoAlign(samples, sampleRate, chart, wavDur, centsTolerance) {
    let bestOffset = 0;
    let bestScore = -1;
    console.log(`\nAuto-aligning: sweeping chartStartTime from ${AUTO_ALIGN_MIN}s to ${AUTO_ALIGN_MAX}s (step ${AUTO_ALIGN_STEP}s), cents≤${centsTolerance}…`);
    for (let off = AUTO_ALIGN_MIN; off <= AUTO_ALIGN_MAX; off += AUTO_ALIGN_STEP) {
        const score = scoreAlignment(samples, sampleRate, chart, off, wavDur, centsTolerance);
        if (score > bestScore) { bestScore = score; bestOffset = off; }
    }
    console.log(`  best chartStartTime=${bestOffset.toFixed(2)}s with ${bestScore} audio-chart matches`);
    return bestOffset;
}

function main() {
    const wav = readWav(WAV_PATH);
    const meta = readSidecar(WAV_PATH);
    const wavDur = wav.samples.length / wav.sampleRate;
    const hasDump = DUMP_PATH != null;

    // Chart source: dump when available (captures this session's actual
    // chart), fallback to stored JSON file. Override with --no-chart-from-dump.
    const useDumpChart = CHART_FROM_DUMP && DUMP_PATH;
    const chart = useDumpChart
        ? chartFromDump(DUMP_PATH)
        : JSON.parse(fs.readFileSync(CHART_PATH, 'utf8'));
    const chartSource = useDumpChart ? `dump (${DUMP_PATH})` : CHART_PATH;

    // Cents tolerance + window: prefer the dump's live settings so classifier
    // judges "audio has expected" with the SAME thresholds the pipeline
    // used to call HITs live. Falls back to defaults / explicit flags.
    let centsTolerance = DEFAULT_CENTS_TOLERANCE;
    if (hasDump) {
        try {
            const dump = JSON.parse(fs.readFileSync(DUMP_PATH, 'utf8'));
            if (dump.settings?.pitchTolerance) centsTolerance = dump.settings.pitchTolerance;
            if (dump.settings?.timingTolerance != null) {
                // Pipeline uses early=timingTolerance, late=2*timingTolerance.
                // Override only if user didn't explicitly set --window-*.
                if (!args.includes('--window-before-ms')) WINDOW_BEFORE_MS = dump.settings.timingTolerance * 1000;
                if (!args.includes('--window-after-ms'))  WINDOW_AFTER_MS = dump.settings.timingTolerance * 2 * 1000;
            }
        } catch { /* ignore */ }
    }

    // chartStartTime: auto-align when the sidecar's value is 0 (common when
    // the recording was made before song playback started and no chart-advance
    // gate captured the offset), or when --auto-align is explicit. --no-auto-align
    // suppresses even when sidecar=0.
    const shouldAutoAlign = !AUTO_ALIGN_DISABLE &&
        (AUTO_ALIGN_FORCE_ON || meta.chartStartTime === 0);
    const chartStart = shouldAutoAlign
        ? autoAlign(wav.samples, wav.sampleRate, chart, wavDur, centsTolerance)
        : meta.chartStartTime;

    const inWindow = chart.filter(n => n.chartT >= chartStart && n.chartT <= chartStart + wavDur);

    const verdicts = loadPipelineVerdicts(DUMP_PATH);

    console.log(`WAV:          ${WAV_PATH}  (${wavDur.toFixed(1)}s at ${wav.sampleRate}Hz)`);
    console.log(`Chart source: ${chartSource}  (${chart.length} total, ${inWindow.length} in window)`);
    console.log(`chartStartTime: ${chartStart.toFixed(3)}s  ${shouldAutoAlign ? '(auto-aligned)' : '(from sidecar)'}`);
    console.log(`Dump:         ${hasDump ? DUMP_PATH : '(none — audio-truth mode; pipeline verdict assumed MISS)'}`);
    console.log(`Cents tol:    ±${centsTolerance}¢  ${hasDump ? '(from dump settings.pitchTolerance)' : '(default)'}`);
    console.log(`Params: yin=${YIN_BUF}, hop=${HOP_MS}ms, window=${-WINDOW_BEFORE_MS}..+${WINDOW_AFTER_MS}ms`);
    console.log();

    const classifications = [];
    const tolSweep = [25, 50, 75, 100, 150, 200];
    const tolWould = new Map(tolSweep.map(t => [t, 0]));

    for (const cn of inWindow) {
        const wavTchart = cn.chartT - chartStart;
        const audio = analyzeNoteWindow(wav.samples, wav.sampleRate, wavTchart, cn.midi);
        const verdictKey = Math.round(cn.chartT * 1000);
        const pipelineVerdict = verdicts.get(verdictKey) || 'MISS';
        const category = classifyNote(audio, pipelineVerdict, cn, centsTolerance);

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
    const order = ['PIPELINE_HIT', 'PIPELINE_MISSED_REAL_PLAY', 'PIPELINE_YIN_DISAGREES', 'USER_WRONG_PITCH', 'USER_SILENT'];

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

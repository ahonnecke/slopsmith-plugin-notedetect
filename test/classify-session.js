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
// Offset sweep: at each hypothesized input-latency Δ in [sweep-min..sweep-max],
// count how many chart notes have an expected-pitch audio frame inside the
// (offset-shifted) sweep window. This is the audio-truth *ceiling* — the best
// score a perfect detector could achieve at that latency compensation. It
// does NOT replay the live pipeline at Δ (that'd need a full onset-event log
// in the dump; currently only the last 30 events are persisted).
//
// The sweep uses a TIGHTER window than the live pipeline's hit window, so the
// curve actually differentiates across offsets. Example: if the pipeline runs
// at 300ms tolerance (window is 900ms wide), the pluck is "in window" at
// basically any Δ and the curve is flat at 100%. Using ±100ms asks the
// sharper question: "where does the audio for each pluck actually land?"
// If Δ=+200 peaks at 90% and Δ=0 sits at 60%, the mic→pipeline path is
// systematically 200ms late. If peak==Δ=0, there's no latency bias.
const OFFSET_SWEEP = args.includes('--offset-sweep');
const SWEEP_MIN_MS = parseFloat(getArg('sweep-min-ms', '-200'));
const SWEEP_MAX_MS = parseFloat(getArg('sweep-max-ms', '500'));
const SWEEP_STEP_MS = parseFloat(getArg('sweep-step-ms', '25'));
// Sweep window (symmetric half-width around Δ), independent of the pipeline's
// live hit-window. Default 100ms — narrow enough to resolve bias, wide enough
// to tolerate a bit of player jitter.
const SWEEP_WINDOW_MS = parseFloat(getArg('sweep-window-ms', '100'));

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

// 30–250 Hz band-pass pre-filter. The silent-bucket probe found that
// 33–75% of "USER_SILENT" notes recover when YIN sees a band-passed
// signal — raw YIN gets 0.00 confidence on heavily-mastered or
// distorted-band mixes because guitar/drum overtones overwhelm the
// bass fundamental. Band-passing isolates the bass band before YIN.
// Off by default so the harness can A/B against the un-filtered ceiling.
const BAND_PASS_ENABLED = args.includes('--band-pass');
const BAND_LOW_HZ = parseFloat(getArg('band-low-hz', '30'));
const BAND_HIGH_HZ = parseFloat(getArg('band-high-hz', '250'));
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

// 4th-order Butterworth band-pass via two cascaded RBJ biquads
// (highpass × 2, lowpass × 2). 24 dB/octave on each side.
function biquadCoefs(type, fc, sampleRate) {
    const w0 = 2 * Math.PI * fc / sampleRate;
    const cs = Math.cos(w0), sn = Math.sin(w0);
    const Q = Math.SQRT1_2;
    const alpha = sn / (2 * Q);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'highpass') {
        b0 = (1 + cs) / 2;  b1 = -(1 + cs);  b2 = (1 + cs) / 2;
        a0 = 1 + alpha;     a1 = -2 * cs;    a2 = 1 - alpha;
    } else {
        b0 = (1 - cs) / 2;  b1 = 1 - cs;     b2 = (1 - cs) / 2;
        a0 = 1 + alpha;     a1 = -2 * cs;    a2 = 1 - alpha;
    }
    return [b0/a0, b1/a0, b2/a0, a1/a0, a2/a0];
}

function applyBiquad(input, [b0, b1, b2, a1, a2]) {
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

function applyBandPass(samples, sampleRate, lowHz, highHz) {
    const hp = biquadCoefs('highpass', lowHz, sampleRate);
    const lp = biquadCoefs('lowpass', highHz, sampleRate);
    let s = samples;
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
    return Math.sqrt(s / (end - start)) * 5;
}

// Scan a "super-window" around a chart note — wide enough to cover the hit
// window AT ALL swept offsets, so the sweep can reuse the same YIN output.
// Returns {frames, summary} where frames is a list of every pitched frame
// (tRelMs relative to chartT, cents to expected, matchesExpected) and
// summary is the analyzeNoteWindow output filtered to the base hit window.
function scanNoteSuperWindow(samples, sampleRate, wavTchart, expectedMidi, superBeforeMs, superAfterMs) {
    const startSample = Math.max(0, Math.floor((wavTchart - superBeforeMs / 1000) * sampleRate));
    const endSample = Math.min(samples.length, Math.floor((wavTchart + superAfterMs / 1000) * sampleRate));
    const hop = Math.floor(sampleRate * HOP_MS / 1000);
    const frames = [];
    let totalFrames = 0;

    for (let s = startSample; s + YIN_BUF <= endSample; s += hop) {
        totalFrames++;
        const level = rms(samples, s, YIN_BUF);
        if (level < SILENCE_LEVEL) continue;
        const frame = samples.slice(s, s + YIN_BUF);
        const r = core.yinDetect(frame, sampleRate);
        if (r.freq <= 0 || r.confidence < MIN_CONFIDENCE) continue;
        const detMidi = Math.round(69 + 12 * Math.log2(r.freq / 440));
        const fineCents = (69 + 12 * Math.log2(r.freq / 440) - expectedMidi) * 100;
        const octCents = fineCents - 1200;
        const cents = Math.abs(octCents) < Math.abs(fineCents) ? octCents : fineCents;
        const tRelMs = ((s + YIN_BUF / 2) / sampleRate - wavTchart) * 1000;
        frames.push({ tRelMs, detMidi, cents });
    }

    return { frames, totalFrames };
}

// Summarize frames within the base hit window [-WINDOW_BEFORE, +WINDOW_AFTER]
// for the classifier. Takes the pre-scanned frame list and filters it in-range.
function summarizeFrames(frames, totalFrames, expectedMidi, centsTolerance) {
    const midiCounts = new Map();
    let expectedFrames = 0;
    let pitchedFrames = 0;
    let bestCentsErr = Infinity;

    for (const fr of frames) {
        if (fr.tRelMs < -WINDOW_BEFORE_MS || fr.tRelMs > WINDOW_AFTER_MS) continue;
        pitchedFrames++;
        midiCounts.set(fr.detMidi, (midiCounts.get(fr.detMidi) || 0) + 1);
        if (Math.abs(fr.cents) < Math.abs(bestCentsErr)) bestCentsErr = fr.cents;
        if (fr.detMidi === expectedMidi) expectedFrames++;
    }

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
    if (BAND_PASS_ENABLED) {
        wav.samples = applyBandPass(wav.samples, wav.sampleRate, BAND_LOW_HZ, BAND_HIGH_HZ);
    }

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
    console.log(`Params: yin=${YIN_BUF}, hop=${HOP_MS}ms, window=${-WINDOW_BEFORE_MS}..+${WINDOW_AFTER_MS}ms${BAND_PASS_ENABLED ? `, band-pass=${BAND_LOW_HZ}-${BAND_HIGH_HZ}Hz` : ''}`);
    console.log();

    const classifications = [];
    const tolSweep = [25, 50, 75, 100, 150, 200];
    const tolWould = new Map(tolSweep.map(t => [t, 0]));

    // Super-window width: must cover base hit window AND sweep window across
    // its full range. When the sweep is off, this equals the base hit window.
    const superBeforeMs = OFFSET_SWEEP
        ? Math.max(WINDOW_BEFORE_MS, SWEEP_WINDOW_MS - SWEEP_MIN_MS)
        : WINDOW_BEFORE_MS;
    const superAfterMs = OFFSET_SWEEP
        ? Math.max(WINDOW_AFTER_MS, SWEEP_WINDOW_MS + SWEEP_MAX_MS)
        : WINDOW_AFTER_MS;

    if (OFFSET_SWEEP) {
        console.log(`Offset sweep: Δ in [${SWEEP_MIN_MS}..${SWEEP_MAX_MS}ms step ${SWEEP_STEP_MS}], window ±${SWEEP_WINDOW_MS}ms around Δ, ±${centsTolerance}¢`);
    }

    for (const cn of inWindow) {
        const wavTchart = cn.chartT - chartStart;
        const { frames, totalFrames } = scanNoteSuperWindow(
            wav.samples, wav.sampleRate, wavTchart, cn.midi, superBeforeMs, superAfterMs);
        const audio = summarizeFrames(frames, totalFrames, cn.midi, centsTolerance);
        const verdictKey = Math.round(cn.chartT * 1000);
        const pipelineVerdict = verdicts.get(verdictKey) || 'MISS';
        const category = classifyNote(audio, pipelineVerdict, cn, centsTolerance);

        // Keep the raw frame list only when the sweep needs it. Otherwise the
        // classification.json would grow by ~KB per note for no gain.
        classifications.push({
            cn, audio, pipelineVerdict, category,
            frames: OFFSET_SWEEP ? frames : null,
        });

        // Tolerance sweep: at each cents tolerance, would the BEST frame
        // have matched? Uses the (already-octave-aware) bestCents.
        if (audio.bestCents != null) {
            for (const t of tolSweep) {
                if (Math.abs(audio.bestCents) <= t) tolWould.set(t, tolWould.get(t) + 1);
            }
        }
    }

    // Offset sweep — at each virtual input-latency Δ, count notes whose
    // expected pitch is audible in a ±SWEEP_WINDOW_MS band around Δ.
    // "Expected-pitch" = cents within centsTolerance AND rounded MIDI matches
    // (same rules the classifier uses for `audioHasExpected`).
    // NOT a live-pipeline replay — this is the audio-truth ceiling at each Δ
    // given the chosen sweep window. Use a tighter window to resolve timing
    // bias; the pipeline's live hit window is usually too wide to differentiate.
    let offsetSweepResult = null;
    if (OFFSET_SWEEP) {
        const curve = [];
        for (let offset = SWEEP_MIN_MS; offset <= SWEEP_MAX_MS + 1e-6; offset += SWEEP_STEP_MS) {
            const wStart = -SWEEP_WINDOW_MS + offset;
            const wEnd = SWEEP_WINDOW_MS + offset;
            let ceiling = 0;
            for (const c of classifications) {
                if (!c.frames) continue;
                const has = c.frames.some(fr =>
                    fr.tRelMs >= wStart && fr.tRelMs <= wEnd && Math.abs(fr.cents) <= centsTolerance);
                if (has) ceiling++;
            }
            curve.push({ offsetMs: Math.round(offset), ceiling });
        }
        const peak = curve.reduce((a, b) => b.ceiling > a.ceiling ? b : a, curve[0]);
        const atZero = curve.find(p => p.offsetMs === 0) ?? curve.reduce((a, b) =>
            Math.abs(b.offsetMs) < Math.abs(a.offsetMs) ? b : a, curve[0]);
        offsetSweepResult = {
            curve, peak, atZero,
            sweepWindowMs: SWEEP_WINDOW_MS,
            centsTolerance, totalNotes: inWindow.length,
        };
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

    if (offsetSweepResult) {
        const { curve, peak, atZero, centsTolerance, totalNotes, sweepWindowMs } = offsetSweepResult;
        console.log();
        console.log('=== Offset sweep (audio-truth ceiling) ===');
        console.log(`  For each virtual input-latency Δ, count chart notes whose expected pitch`);
        console.log(`  is audible within ±${sweepWindowMs}ms of Δ. Peak = where the audio for plucks`);
        console.log(`  actually lands relative to chartT (i.e. the effective mic→pipeline latency).`);
        console.log(`  NOT a replay of the live pipeline. Pitch match within ±${centsTolerance}¢.`);
        console.log();
        const maxCeil = Math.max(...curve.map(p => p.ceiling), 1);
        for (const p of curve) {
            const bar = '█'.repeat(Math.round(p.ceiling / maxCeil * 40));
            const pct = (p.ceiling / totalNotes * 100).toFixed(1);
            const marks = [];
            if (p === peak) marks.push('← peak');
            if (p === atZero) marks.push('← 0ms (no comp)');
            console.log(`  Δ=${String(p.offsetMs).padStart(5)}ms  ${String(p.ceiling).padStart(4)}/${totalNotes}  ${pct.padStart(5)}%  ${bar} ${marks.join(' ')}`);
        }
        const delta = peak.ceiling - atZero.ceiling;
        const pctPts = (delta / totalNotes * 100).toFixed(1);
        console.log();
        console.log(`  Peak: Δ=${peak.offsetMs}ms → ${peak.ceiling}/${totalNotes} (${(peak.ceiling / totalNotes * 100).toFixed(1)}%)`);
        console.log(`  Current (Δ=0): ${atZero.ceiling}/${totalNotes} (${(atZero.ceiling / totalNotes * 100).toFixed(1)}%)`);
        console.log(`  Ceiling gain from shifting to peak: +${delta} notes (+${pctPts}pp)`);
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
        offsetSweep: offsetSweepResult,
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

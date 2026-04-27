#!/usr/bin/env node
/**
 * Onset-bucket root-cause probe.
 *
 * `classify-session.js` puts a chart note in PIPELINE_MISSED_REAL_PLAY when
 * the audio HAS the expected pitch in the window but the live pipeline
 * said MISSED_NO_DETECTION (no onset fired, no detection attempted). With
 * the band-pass shipped, this bucket is now the dominant remaining gap
 * between user-live score and the audio-truth ceiling.
 *
 * Live onset has two triggers (see screen.js _ndProcessAudioChunk):
 *
 *   Trigger 1 (silence→playing): rms > _ND_ONSET_LEVEL (0.04)
 *                                 AND !_ndInNote
 *                                 AND refractoryOk (>=200 ms since last onset)
 *
 *   Trigger 2 (sustain re-attack): _ndInNote
 *                                  AND refractoryOk
 *                                  AND _ndReattackArmed (rms dipped <0.02 since last onset)
 *                                  AND rms > _ND_REATTACK_MIN_LEVEL (0.04)
 *                                  AND rms > recentMin × 2.0
 *
 * Each blockable gate is a distinct failure mode with a distinct fix:
 *
 *   soft-attack      — max RMS in the chart-note window never reached 0.04.
 *                      The pluck was below the level threshold.
 *                      Fix: lower _ND_ONSET_LEVEL (and re-validate that we
 *                      don't pick up sustain-noise as new onsets).
 *
 *   no-rearm         — rms didn't dip below 0.02 between previous note and
 *                      this one. _ndReattackArmed stays false, blocking
 *                      Trigger 2 even with a clean attack spike. Common in
 *                      dense passages where sustain bleeds note-to-note.
 *                      Fix: track release on the band-passed envelope (less
 *                      sustain bleed than raw), or lower the rearm level.
 *
 *   low-ratio        — peak / pre-attack-min < 2.0. The bass attack didn't
 *                      stand far enough above sustain. Common on legato or
 *                      hammer-on style plucks.
 *                      Fix: lower _ND_REATTACK_RATIO, or use a derivative
 *                      of the rms envelope rather than ratio-of-min.
 *
 *   refractory-blocked — another chart note's onset was <200 ms before. The
 *                        live pipeline's refractory blocked this one.
 *                        Fix: shrink the refractory or make it conditional
 *                        on chart-note density.
 *
 *   should-have-fired — peak >= 0.04, ratio >= 2.0, refractory ok, rearm
 *                       saw a release. The gate logic SHOULD have fired but
 *                       didn't. Possible causes: the chart-note timestamp
 *                       is wrong (drift), the onset_t was captured before
 *                       chart advanced past it, or there's a real bug.
 *
 * Usage:
 *   node test/onset-probe.js --classification <path>
 *   node test/onset-probe.js --stem <stem>          # uses a song-ceiling fixture
 *   node test/onset-probe.js --session <name>       # uses a per-session classification
 *
 * Reads from test/fixtures/<name>.classification.json (session) or
 * test/fixtures/song-ceiling/<stem>.classification.json (ceiling).
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function getArg(n, d) { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; }

const CEIL_DIR = path.join(__dirname, 'fixtures', 'song-ceiling');
const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const STEM = getArg('stem', null);
const SESSION = getArg('session', null);
const CLS_PATH = getArg('classification',
    STEM ? path.join(CEIL_DIR, `${STEM}.classification.json`)
    : SESSION ? path.join(FIXTURE_DIR, `${SESSION}.classification.json`)
    : null);
if (!CLS_PATH) {
    console.error('usage: --classification <path>  OR  --stem <ceiling-stem>  OR  --session <session-name>');
    process.exit(1);
}

// Mirror live screen.js constants.
const FRAME_SAMPLES = 2048;            // _ndFrameSize — ScriptProcessor chunk size
const ONSET_LEVEL = 0.04;              // _ND_ONSET_LEVEL
const ONSET_EXIT_LEVEL = 0.02;         // _ND_ONSET_EXIT_LEVEL (also rearm level)
const REATTACK_RATIO = 2.0;            // _ND_REATTACK_RATIO
const REATTACK_MIN_LEVEL = 0.04;       // _ND_REATTACK_MIN_LEVEL
const REATTACK_REFRACTORY_SEC = 0.200; // _ND_REATTACK_REFRACTORY_SEC
const REATTACK_WINDOW = 4;             // _ND_REATTACK_WINDOW

// Window around chart_t to evaluate onset gates. Covers a generous attack
// region (early/late) plus the prior 300 ms so we can see the rearm history
// and pre-attack envelope.
const ATTACK_BEFORE_MS = 50;
const ATTACK_AFTER_MS = 200;
const PREATTACK_BEFORE_MS = 300;
const PREATTACK_AFTER_MS = 0;

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

// Live-pipeline-equivalent RMS over a chunk of FRAME_SAMPLES. Constants in
// screen.js compare against this raw RMS (no normalisation factor).
function rmsAt(samples, startSample, n) {
    let s = 0;
    const end = Math.min(samples.length, startSample + n);
    if (end - startSample < 64) return 0;
    for (let i = startSample; i < end; i++) s += samples[i] * samples[i];
    return Math.sqrt(s / (end - startSample));
}

// Compute per-frame RMS at the live pipeline's chunk granularity, stepping
// FRAME_SAMPLES at a time, around a chart-time anchor. Returns frames within
// [-beforeMs, +afterMs].
function frameRmsWindow(samples, sampleRate, wavTchart, beforeMs, afterMs) {
    const startSample = Math.max(0, Math.floor((wavTchart - beforeMs / 1000) * sampleRate));
    const endSample = Math.min(samples.length, Math.floor((wavTchart + afterMs / 1000) * sampleRate));
    const frames = [];
    for (let s = startSample; s + FRAME_SAMPLES <= endSample; s += FRAME_SAMPLES) {
        const tRelMs = ((s + FRAME_SAMPLES / 2) / sampleRate - wavTchart) * 1000;
        frames.push({ tRelMs, rms: rmsAt(samples, s, FRAME_SAMPLES) });
    }
    return frames;
}

function classifyMiss(diag) {
    const { peakRms, preAttackMin, sawReleaseInPrior, refractoryBlocked } = diag;
    if (refractoryBlocked) return 'refractory-blocked';
    if (peakRms < ONSET_LEVEL) return 'soft-attack';
    // Trigger 2 path — typical case for in-the-flow notes.
    // No-rearm: prior frames stayed above the rearm level → _ndReattackArmed=false.
    if (!sawReleaseInPrior) return 'no-rearm';
    // Low-ratio: peak / preAttackMin < REATTACK_RATIO would block Trigger 2.
    if (preAttackMin > 0 && peakRms / preAttackMin < REATTACK_RATIO) return 'low-ratio';
    return 'should-have-fired';
}

function median(a) {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

(function main() {
    const cls = JSON.parse(fs.readFileSync(CLS_PATH, 'utf8'));
    const wavPath = cls.wav;
    if (!fs.existsSync(wavPath)) throw new Error(`missing wav: ${wavPath}`);
    console.log(`Loading ${path.basename(wavPath)}…`);
    const { samples, sampleRate } = readWav(wavPath);
    console.log(`  ${samples.length} samples @ ${sampleRate}Hz (${(samples.length / sampleRate).toFixed(1)}s)`);

    const chartStartTime = cls.chartStartTime || 0;
    const allNotes = (cls.notes || []).slice().sort((a, b) => a.chartT - b.chartT);
    const missed = allNotes.filter(n => n.category === 'PIPELINE_MISSED_REAL_PLAY');
    console.log(`PIPELINE_MISSED_REAL_PLAY: ${missed.length}/${cls.totalNotes}`);
    if (!missed.length) { console.log('nothing to probe'); return; }

    // Index chart notes by chartT for refractory lookup against the prior note.
    const chartTimes = allNotes.map(n => n.chartT);

    const causes = { 'soft-attack': [], 'no-rearm': [], 'low-ratio': [], 'refractory-blocked': [], 'should-have-fired': [] };

    for (let i = 0; i < missed.length; i++) {
        const n = missed[i];
        const wavT = n.chartT - chartStartTime;

        const attack = frameRmsWindow(samples, sampleRate, wavT, ATTACK_BEFORE_MS, ATTACK_AFTER_MS);
        const preAttack = frameRmsWindow(samples, sampleRate, wavT, PREATTACK_BEFORE_MS, PREATTACK_AFTER_MS);

        const peakRms = Math.max(0, ...attack.map(f => f.rms));
        const preAttackMin = preAttack.length
            ? Math.min(...preAttack.map(f => f.rms)) : 0;
        const sawReleaseInPrior = preAttack.some(f => f.rms < ONSET_EXIT_LEVEL);

        // Refractory: was there ANY chart note within REATTACK_REFRACTORY before this one?
        const idxInChart = chartTimes.indexOf(n.chartT);
        const prevChartT = idxInChart > 0 ? chartTimes[idxInChart - 1] : -Infinity;
        const refractoryBlocked = (n.chartT - prevChartT) < REATTACK_REFRACTORY_SEC;

        const diag = { peakRms, preAttackMin, sawReleaseInPrior, refractoryBlocked,
                       chartT: n.chartT, expectedMidi: n.expectedMidi };
        const cause = classifyMiss(diag);
        causes[cause].push(diag);
    }

    console.log('\n═══ Onset-bucket root-cause split ═══');
    const order = ['soft-attack', 'no-rearm', 'low-ratio', 'refractory-blocked', 'should-have-fired'];
    for (const k of order) {
        const bucket = causes[k];
        const pct = (bucket.length / missed.length * 100).toFixed(1).padStart(5);
        console.log(`  ${k.padEnd(22)} ${String(bucket.length).padStart(4)}/${missed.length}  ${pct}%`);
    }

    console.log('\n═══ Per-cause envelope stats ═══');
    for (const k of order) {
        const bucket = causes[k];
        if (!bucket.length) continue;
        const peaks = bucket.map(b => b.peakRms);
        const mins = bucket.map(b => b.preAttackMin);
        const ratios = bucket.map(b => b.preAttackMin > 0 ? b.peakRms / b.preAttackMin : NaN).filter(x => isFinite(x));
        console.log(`\n  ${k} (${bucket.length} notes):`);
        console.log(`    peak rms       median=${median(peaks).toFixed(3)}  (gate=${ONSET_LEVEL})`);
        console.log(`    pre-attack min median=${median(mins).toFixed(3)}  (rearm=${ONSET_EXIT_LEVEL})`);
        if (ratios.length) console.log(`    peak/min ratio median=${median(ratios).toFixed(2)}  (gate=${REATTACK_RATIO})`);
    }

    // What-if sweep: how many of the no-rearm misses would recover if we
    // raised the rearm threshold from 0.02 toward the actual sustain floor?
    // A note recovers when its pre-attack-min < new-rearm AND its existing
    // gates (peak >= 0.04, ratio >= 2.0) already pass. Notes that originally
    // failed due to peak/ratio aren't helped by raising rearm.
    const allDiagsForSweep = [...causes['no-rearm'], ...causes['should-have-fired']];
    const sweepLevels = [0.02, 0.025, 0.03, 0.035, 0.04, 0.05];
    console.log('\n═══ Rearm threshold sweep ═══');
    console.log('  rearm   recovers (of all missed)');
    for (const lvl of sweepLevels) {
        const recovered = allDiagsForSweep.filter(d =>
            d.preAttackMin < lvl                                // would now rearm
            && d.peakRms >= ONSET_LEVEL                         // still passes peak gate
            && d.preAttackMin > 0
            && d.peakRms / d.preAttackMin >= REATTACK_RATIO     // still passes ratio gate
        ).length;
        const pct = (recovered / missed.length * 100).toFixed(1).padStart(5);
        console.log(`  ${lvl.toFixed(3)}   ${String(recovered).padStart(3)}/${missed.length}  +${pct}pp`);
    }

    console.log('\n═══ Interpretation ═══');
    const top = order
        .map(k => ({ k, n: causes[k].length }))
        .filter(x => x.n > 0)
        .sort((a, b) => b.n - a.n)[0];
    if (!top) { console.log('  no missed-real-play notes'); return; }
    const pct = (top.n / missed.length * 100).toFixed(1);
    const advice = {
        'soft-attack': `Lower _ND_ONSET_LEVEL (currently ${ONSET_LEVEL}). Re-validate with the silent-probe to ensure background noise doesn't pick up false onsets.`,
        'no-rearm': `Sustain bleed is keeping rms above ${ONSET_EXIT_LEVEL} between notes. Try computing the rearm gate on the band-passed envelope, OR lower _ND_REATTACK_REARM_LEVEL.`,
        'low-ratio': `Bass attacks aren't 2× louder than sustain (legato / hammer-on). Try _ND_REATTACK_RATIO=1.5 or replace ratio-of-min with a rms-derivative threshold.`,
        'refractory-blocked': `Chart notes <200ms apart can only fire once per refractory window. Shrink _ND_REATTACK_REFRACTORY_SEC or make it conditional on chart-note density.`,
        'should-have-fired': `Onset gates SHOULD have allowed this. Most likely a chart-time/audio-time alignment issue, or a real bug in the gate. Inspect each note manually.`,
    };
    console.log(`  Dominant failure: ${top.k} (${top.n}/${missed.length} = ${pct}%)`);
    console.log(`  → ${advice[top.k]}`);

    const outPath = CLS_PATH.replace(/\.classification\.json$/, '.onset-probe.json');
    fs.writeFileSync(outPath, JSON.stringify({
        classification: path.basename(CLS_PATH),
        wav: wavPath,
        constants: { ONSET_LEVEL, ONSET_EXIT_LEVEL, REATTACK_RATIO, REATTACK_MIN_LEVEL,
                     REATTACK_REFRACTORY_SEC, REATTACK_WINDOW, FRAME_SAMPLES },
        missedTotal: missed.length,
        causeCounts: Object.fromEntries(order.map(k => [k, causes[k].length])),
        causes,
        measuredAt: new Date().toISOString(),
    }, null, 2));
    console.log(`\nwritten: ${path.relative(process.cwd(), outPath)}`);
})();

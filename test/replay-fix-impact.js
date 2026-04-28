#!/usr/bin/env node
/**
 * replay-fix-impact — offline metric harness for the post-snapshot
 * analytics layer.
 *
 * Goal: stop iterating in the dark. Each session ships features that
 * touch residual computation, prescription generation, and the AV-offset
 * calibrator; without offline metrics we can't tell whether the latest
 * commit actually moved the needle vs the previous one.
 *
 * Inputs: per-play snapshot JSONs (the same artifacts /tmp/nd_plays/
 * accumulates from the live plugin). Either a directory of them, a
 * specific song subdir, or auto-pulled from the running container.
 *
 * Outputs: a small structured report covering:
 *
 *   - Raw vs residual timing median across all snapshots
 *     ("did the residual switch matter? by how much?")
 *
 *   - Top 3 prescription frequency before/after the residual switch
 *     ("how often does the timing-bias prescription fire incorrectly?")
 *
 *   - AV calibrator simulation: replay each snapshot's HITs through the
 *     calibrator's math, show what avOffset it would have converged to
 *     ("if the live calibrator runs and doesn't change avOffset, was that
 *      the right behavior or a bug?")
 *
 *   - SIBLING_CLAIMED counts per snapshot
 *     ("baseline number to diff against post-chart-aware-refractory plays")
 *
 * Usage:
 *   node test/replay-fix-impact.js --song Level_New__Bass
 *   node test/replay-fix-impact.js --dir /tmp/nd_plays --limit 5
 *   node test/replay-fix-impact.js --pull            # docker-pulls snapshots first
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { loadDetectionCore } = require('./_loader');

const core = loadDetectionCore();

// ── CLI ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const getFlag = (n) => args.includes(`--${n}`);
const SONG_ARG = getArg('song', '');
const DIR_ARG = getArg('dir', path.join(__dirname, 'fixtures', 'nd_plays'));
const LIMIT = parseInt(getArg('limit', '10'), 10);
const PULL = getFlag('pull');
const VERBOSE = getFlag('verbose');
const CONTAINER = getArg('container', 'slopsmith-web-1');
const MIC_LATENCY_MS = parseFloat(getArg('mic-latency', '0'));

// ── Snapshot loading ────────────────────────────────────────────────────
function pullFromContainer() {
    const localBase = path.join(__dirname, 'fixtures', 'nd_plays');
    if (!fs.existsSync(localBase)) fs.mkdirSync(localBase, { recursive: true });
    try {
        execSync(`docker cp ${CONTAINER}:/tmp/nd_plays/. ${localBase}/`,
                 { stdio: ['ignore', 'pipe', 'inherit'] });
        console.log(`[replay] Pulled snapshots from ${CONTAINER}:/tmp/nd_plays → ${localBase}`);
    } catch (e) {
        console.error(`[replay] docker cp failed: ${e.message}`);
        process.exit(2);
    }
    return localBase;
}

function findSnapshots(rootDir, song, limit) {
    const dirs = song
        ? [path.join(rootDir, song)]
        : fs.readdirSync(rootDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => path.join(rootDir, d.name));
    const records = [];
    for (const d of dirs) {
        if (!fs.existsSync(d)) continue;
        const files = fs.readdirSync(d).filter(f => f.endsWith('.json'));
        for (const f of files) {
            const fp = path.join(d, f);
            const stat = fs.statSync(fp);
            records.push({ path: fp, mtime: stat.mtimeMs, song: path.basename(d) });
        }
    }
    records.sort((a, b) => b.mtime - a.mtime);
    return records.slice(0, limit);
}

// ── Metrics ─────────────────────────────────────────────────────────────
function median(values) {
    if (values.length === 0) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * 0.5)];
}

function summarizeTimings(snapshots, micLatencyMs = 0) {
    const rawTimings = [];
    const correctedTimings = [];
    let hitCount = 0, dirtyCount = 0;
    for (const s of snapshots) {
        for (const r of s.data.noteResults || []) {
            if ((r.primary === 'HIT' || r.primary === 'DIRTY_HIT')
                    && typeof r.timingError === 'number' && isFinite(r.timingError)) {
                rawTimings.push(r.timingError);
                correctedTimings.push(r.timingError - micLatencyMs);
                if (r.primary === 'HIT') hitCount++; else dirtyCount++;
            }
        }
    }
    return {
        n: rawTimings.length,
        rawMedian: median(rawTimings),
        correctedMedian: median(correctedTimings),
        hitCount, dirtyCount,
    };
}

function classifySnapshotPrimaries(snapshots) {
    const counts = {};
    let total = 0;
    for (const s of snapshots) {
        for (const r of s.data.noteResults || []) {
            const k = r.primary || 'UNKNOWN';
            counts[k] = (counts[k] || 0) + 1;
            if (r.siblingClaimed) counts.SIBLING_CLAIMED = (counts.SIBLING_CLAIMED || 0) + 1;
            total++;
        }
    }
    return { counts, total };
}

// AV calibrator simulation — mirrors the new math in screen.js. chartTime
// is set to (audio.currentTime + avOffsetSec), so increasing avOffset by Δ
// shifts future timingError up by Δ. To drive median(timing) → 0, we
// SUBTRACT the current median from avOffset each round.
//
// Note about modeling: the simulator uses the recorded timings as-is. In
// real usage, each round's avOffset change shifts ALL future raw timings
// by the same Δ, so the next round's median would also shift. We model
// this by tracking the cumulative avOffset delta and applying it to the
// observed timings before computing the new median — this is what the
// live calibrator's feed loop actually sees.
function simulateAvCalibrator(snapshots, startAvOffset) {
    const SAMPLES_PER_ROUND = 30;
    const MAX_ROUNDS = 3;
    const CONVERGED_MS = 10;
    const orderedRaw = [];
    for (const s of snapshots) {
        for (const r of s.data.noteResults || []) {
            if ((r.primary === 'HIT' || r.primary === 'DIRTY_HIT')
                    && typeof r.timingError === 'number' && isFinite(r.timingError)) {
                orderedRaw.push({ chartT: r.chartT || 0, raw: r.timingError });
            }
        }
    }
    orderedRaw.sort((a, b) => a.chartT - b.chartT);

    const trace = [];
    let avOffset = startAvOffset;
    let cursor = 0;
    for (let round = 1; round <= MAX_ROUNDS; round++) {
        if (cursor + SAMPLES_PER_ROUND > orderedRaw.length) {
            trace.push({ round, status: 'INSUFFICIENT_DATA',
                         needed: SAMPLES_PER_ROUND, available: orderedRaw.length - cursor });
            break;
        }
        // Apply cumulative avOffset shift to the observed timings: real
        // future timing = recorded_raw + (avOffset - startAvOffset).
        const shift = avOffset - startAvOffset;
        const slice = orderedRaw.slice(cursor, cursor + SAMPLES_PER_ROUND);
        const observed = slice.map(s => s.raw + shift);
        const med = median(observed);
        cursor += SAMPLES_PER_ROUND;
        if (Math.abs(med) < CONVERGED_MS) {
            trace.push({ round, avOffsetBefore: avOffset, medianTiming: med,
                         avOffsetAfter: avOffset, status: 'CONVERGED' });
            return { trace, finalAvOffset: avOffset, samplesUsed: cursor };
        }
        const next = Math.max(-1000, Math.min(1000,
            avOffset - Math.round(med)));
        trace.push({ round, avOffsetBefore: avOffset, medianTiming: med,
                     avOffsetAfter: next, status: 'ADJUST' });
        avOffset = next;
    }
    return { trace, finalAvOffset: avOffset, samplesUsed: cursor, status: 'MAX_ROUNDS' };
}

// Frequency at which the timing-bias prescription fires across snapshots.
function prescriptionFireRate(snapshots, micLatencyMs) {
    let fired = 0;
    for (const s of snapshots) {
        const top3 = core.computeTop3Prescriptions([s.data], 'unknown.psarc', 0, micLatencyMs);
        if (top3.some(t => t.signal === 'timing_bias')) fired++;
    }
    return fired;
}

// ── Main ────────────────────────────────────────────────────────────────
function fetchAvOffsetFromSettings() {
    // Try to read the user's current av_offset_ms from slopsmith /api/settings.
    // Best-effort; falls back to 0 if the server isn't reachable.
    try {
        const out = execSync('curl -sf http://localhost:8088/api/settings',
                             { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
        const data = JSON.parse(out);
        return Number(data.av_offset_ms) || 0;
    } catch (e) {
        return 0;
    }
}

function main() {
    const dir = PULL ? pullFromContainer() : DIR_ARG;
    if (!fs.existsSync(dir)) {
        console.error(`[replay] Snapshot dir not found: ${dir}\n`
            + `         Run with --pull to copy from container, or --dir <path>.`);
        process.exit(2);
    }
    const records = findSnapshots(dir, SONG_ARG, LIMIT);
    if (records.length === 0) {
        console.error(`[replay] No snapshots found under ${dir}${SONG_ARG ? '/' + SONG_ARG : ''}`);
        process.exit(2);
    }
    const snapshots = records.map(r => ({
        ...r,
        data: JSON.parse(fs.readFileSync(r.path, 'utf8')),
    }));
    const avOffsetMs = fetchAvOffsetFromSettings();
    const songs = [...new Set(snapshots.map(s => s.song))];

    // ── Output ──────────────────────────────────────────────────────────
    console.log('═══ replay-fix-impact ═══');
    console.log(`Snapshots: ${snapshots.length} from ${songs.length} song(s) ${songs.join(', ')}`);
    console.log(`Current avOffset (slopsmith /api/settings): ${avOffsetMs} ms`);
    console.log();

    // Timing summary
    const timing = summarizeTimings(snapshots, MIC_LATENCY_MS);
    console.log('── HIT timing ──');
    console.log(`  HITs analyzed:         ${timing.n} (${timing.hitCount} clean + ${timing.dirtyCount} dirty)`);
    console.log(`  Raw median:            ${timing.rawMedian != null ? timing.rawMedian.toFixed(0) : '—'} ms (matcher's stored timingError)`);
    console.log(`  Mic latency arg:       ${MIC_LATENCY_MS} ms ${MIC_LATENCY_MS === 0 ? '(--mic-latency=N to inspect post-calibration)' : ''}`);
    console.log(`  Player offset (p50):   ${timing.correctedMedian != null ? `${timing.correctedMedian > 0 ? '+' : ''}${Math.round(timing.correctedMedian)}` : '—'} ms`);
    console.log();

    // Prescription frequency
    const fired = prescriptionFireRate(snapshots, MIC_LATENCY_MS);
    console.log('── Top 3 timing_bias prescription ──');
    console.log(`  Fires in:              ${fired} of ${snapshots.length} plays`);
    if (timing.correctedMedian != null && Math.abs(timing.correctedMedian) > 30) {
        console.log(`  Player offset ${Math.round(timing.correctedMedian)} ms is above the 30 ms threshold — fires correctly.`);
    } else if (timing.correctedMedian != null) {
        console.log(`  Player offset ${Math.round(timing.correctedMedian)} ms is within tolerance — should not fire.`);
    }
    console.log();

    // AV calibrator simulation (corrected math)
    console.log('── AV calibrator replay (corrected math: new = old − median) ──');
    const calib = simulateAvCalibrator(snapshots, avOffsetMs);
    console.log(`  Starting avOffset:     ${avOffsetMs} ms`);
    for (const t of calib.trace) {
        if (t.status === 'INSUFFICIENT_DATA') {
            console.log(`  Round ${t.round}: ${t.status} (need ${t.needed} HITs, have ${t.available})`);
        } else {
            console.log(`  Round ${t.round}: avOffset ${t.avOffsetBefore} → ${t.avOffsetAfter} (observed median ${Math.round(t.medianTiming)} ms) — ${t.status}`);
        }
    }
    console.log(`  Final avOffset:        ${calib.finalAvOffset} ms`);
    console.log(`  Samples consumed:      ${calib.samplesUsed}`);
    if (Math.abs(calib.finalAvOffset - avOffsetMs) < 10) {
        console.log(`  → Calibrator would NOT meaningfully change avOffset on this data.`);
        console.log(`     Either current avOffset is already calibrated, or there aren't enough HITs.`);
    } else {
        console.log(`  → Calibrator SHOULD shift avOffset by ${calib.finalAvOffset - avOffsetMs} ms.`);
        console.log(`     Live calibrator wiring debug checks (if click didn't apply):`);
        console.log(`       1. Was Detect ON? (no hits → no samples)`);
        console.log(`       2. Did ≥30 HITs flow during the calibration window?`);
        console.log(`       3. Status string updated past "Calibrating: 0/30"?`);
        console.log(`       (POST /api/settings persist verified working via curl probe.)`);
    }
    console.log();

    // Failure-mode breakdown (esp. SIBLING_CLAIMED for the chart-aware refractory diff)
    const cls = classifySnapshotPrimaries(snapshots);
    console.log('── Note classification distribution ──');
    const sortedKeys = Object.keys(cls.counts).sort((a, b) => cls.counts[b] - cls.counts[a]);
    for (const k of sortedKeys) {
        const pct = ((cls.counts[k] / cls.total) * 100).toFixed(1);
        console.log(`  ${k.padEnd(28)} ${String(cls.counts[k]).padStart(5)}  (${pct}%)`);
    }
    console.log();
    if (cls.counts.SIBLING_CLAIMED) {
        console.log(`  Note: SIBLING_CLAIMED = ${cls.counts.SIBLING_CLAIMED} on these snapshots.`);
        console.log(`        Chart-aware refractory (commit 9db7ee1) operates at audio time.`);
        console.log(`        Already-recorded snapshots reflect the pre-fix matcher; only`);
        console.log(`        snapshots taken after the deploy should show the reduction.`);
    }

    // Per-snapshot detail (only if --verbose)
    if (VERBOSE) {
        console.log();
        console.log('── Per-snapshot detail ──');
        for (const s of snapshots) {
            const t = summarizeTimings([s], MIC_LATENCY_MS);
            const stamp = new Date(s.mtime).toISOString().slice(0, 19);
            console.log(`  ${stamp}  ${s.song.padEnd(28)} hits=${String(t.n).padStart(4)}  raw=${t.rawMedian != null ? t.rawMedian.toFixed(0).padStart(5) : '   —'}ms  player=${t.correctedMedian != null ? t.correctedMedian.toFixed(0).padStart(5) : '   —'}ms`);
        }
    }
}

main();

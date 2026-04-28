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

function summarizeTimings(snapshots, avOffsetMs) {
    const rawTimings = [];
    const residualTimings = [];
    let hitCount = 0, dirtyCount = 0;
    for (const s of snapshots) {
        for (const r of s.data.noteResults || []) {
            if ((r.primary === 'HIT' || r.primary === 'DIRTY_HIT')
                    && typeof r.timingError === 'number' && isFinite(r.timingError)) {
                rawTimings.push(r.timingError);
                residualTimings.push(core.residualMs(r.timingError, avOffsetMs));
                if (r.primary === 'HIT') hitCount++; else dirtyCount++;
            }
        }
    }
    return {
        n: rawTimings.length,
        rawMedian: median(rawTimings),
        residualMedian: median(residualTimings),
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

// AV calibrator simulation — mirrors the math in screen.js: per round of 30
// HITs, take median(raw), compute residual, adjust avOffset by the median
// residual. Stop on |residual| < 10 ms or 3 rounds elapsed.
function simulateAvCalibrator(snapshots, startAvOffset) {
    const SAMPLES_PER_ROUND = 30;
    const MAX_ROUNDS = 3;
    const CONVERGED_MS = 10;
    // Walk all HITs in chart-time order across all snapshots so the
    // simulation reflects what a continuous play session would feed.
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
        const slice = orderedRaw.slice(cursor, cursor + SAMPLES_PER_ROUND);
        const med = median(slice.map(s => s.raw));
        const residual = core.residualMs(med, avOffset);
        cursor += SAMPLES_PER_ROUND;
        if (Math.abs(residual) < CONVERGED_MS) {
            trace.push({ round, avOffsetBefore: avOffset, medianRaw: med,
                         residual, avOffsetAfter: avOffset, status: 'CONVERGED' });
            return { trace, finalAvOffset: avOffset, samplesUsed: cursor };
        }
        const next = Math.max(-1000, Math.min(1000,
            avOffset + Math.round(residual)));
        trace.push({ round, avOffsetBefore: avOffset, medianRaw: med,
                     residual, avOffsetAfter: next, status: 'ADJUST' });
        avOffset = next;
    }
    return { trace, finalAvOffset: avOffset, samplesUsed: cursor, status: 'MAX_ROUNDS' };
}

// Compare prescription output: would the timing-bias prescription have
// fired before vs after the residual switch?
function comparePrescriptionImpact(snapshots, avOffsetMs) {
    const playsOldStyle = snapshots.map(s => ({
        ...s.data,
        // Pretend avOffset = 0 — what raw-based prescription would have seen
    }));
    const playsNewStyle = snapshots.map(s => s.data);
    const out = { firedBefore: 0, firedAfter: 0, songFilename: 'unknown.psarc' };
    for (const p of playsOldStyle) {
        const top3 = core.computeTop3Prescriptions([p], out.songFilename, 0);
        if (top3.some(t => t.signal === 'timing_bias')) out.firedBefore++;
    }
    for (const p of playsNewStyle) {
        const top3 = core.computeTop3Prescriptions([p], out.songFilename, avOffsetMs);
        if (top3.some(t => t.signal === 'timing_bias')) out.firedAfter++;
    }
    return out;
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

    // Timing residual delta
    const timing = summarizeTimings(snapshots, avOffsetMs);
    console.log('── Timing residual (residual switch, commit b68cd75) ──');
    console.log(`  HITs analyzed:         ${timing.n} (${timing.hitCount} clean + ${timing.dirtyCount} dirty)`);
    console.log(`  Raw timing median:     ${timing.rawMedian != null ? timing.rawMedian.toFixed(0) : '—'} ms (what the highway label used to show)`);
    console.log(`  Residual median:       ${timing.residualMedian != null ? timing.residualMedian.toFixed(0) : '—'} ms (what it shows now)`);
    if (timing.rawMedian != null && timing.residualMedian != null) {
        const delta = Math.abs(timing.rawMedian) - Math.abs(timing.residualMedian);
        console.log(`  |raw| − |residual|:    ${delta.toFixed(0)} ms ${delta > 0 ? '(player no longer charged for pipeline latency)' : '(no change — avOffset is 0 or onset comp dominates)'}`);
    }
    console.log();

    // Prescription frequency
    const presc = comparePrescriptionImpact(snapshots, avOffsetMs);
    console.log('── Top 3 prescription firing rate (timing_bias signal) ──');
    console.log(`  Before residual switch: ${presc.firedBefore} of ${snapshots.length} plays`);
    console.log(`  After residual switch:  ${presc.firedAfter} of ${snapshots.length} plays`);
    if (presc.firedBefore > presc.firedAfter) {
        const pct = ((presc.firedBefore - presc.firedAfter) / presc.firedBefore * 100).toFixed(0);
        console.log(`  → ${pct}% fewer false-positive timing prescriptions`);
    }
    console.log();

    // AV calibrator simulation
    console.log('── AV calibrator replay (commit 8cb64cf) ──');
    const calib = simulateAvCalibrator(snapshots, avOffsetMs);
    console.log(`  Starting avOffset:     ${avOffsetMs} ms`);
    for (const t of calib.trace) {
        if (t.status === 'INSUFFICIENT_DATA') {
            console.log(`  Round ${t.round}: ${t.status} (need ${t.needed} HITs, have ${t.available})`);
        } else {
            console.log(`  Round ${t.round}: avOffset ${t.avOffsetBefore} → ${t.avOffsetAfter} (median raw ${Math.round(t.medianRaw)} ms, residual ${Math.round(t.residual)} ms) — ${t.status}`);
        }
    }
    console.log(`  Final avOffset:        ${calib.finalAvOffset} ms`);
    console.log(`  Samples consumed:      ${calib.samplesUsed}`);
    if (Math.abs(calib.finalAvOffset - avOffsetMs) < 10) {
        console.log(`  → Calibrator would NOT meaningfully change avOffset on this data.`);
        console.log(`     Either current avOffset is already calibrated, or there aren't enough HITs.`);
    } else {
        console.log(`  → Calibrator SHOULD shift avOffset by ${calib.finalAvOffset - avOffsetMs} ms.`);
        console.log(`     If the live calibrator didn't change anything, check:`);
        console.log(`       1. Was Detect ON when "Auto-calibrate AV offset" was clicked?`);
        console.log(`       2. Did at least 30 HITs flow during the calibration window?`);
        console.log(`       3. Did POST /api/settings succeed? (browser console for warnings)`);
        console.log(`       4. Did slopsmith pick up the new avOffset? (reload may be needed)`);
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
            const t = summarizeTimings([s], avOffsetMs);
            const stamp = new Date(s.mtime).toISOString().slice(0, 19);
            console.log(`  ${stamp}  ${s.song.padEnd(28)} hits=${String(t.n).padStart(4)}  raw=${t.rawMedian != null ? t.rawMedian.toFixed(0).padStart(5) : '   —'}ms  resid=${t.residualMedian != null ? t.residualMedian.toFixed(0).padStart(5) : '   —'}ms`);
        }
    }
}

main();

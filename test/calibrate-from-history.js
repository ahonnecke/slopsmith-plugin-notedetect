#!/usr/bin/env node
/**
 * Validate mic-latency calibration against existing play snapshots.
 *
 * The wizard measures pluck-relative-to-stimulus latency in an artificial
 * setup (scheduled clicks, isolated cycles). The actual scoring pipeline
 * runs through chart matching with potentially different code paths and
 * different timing pressure. This harness drives off real data: every
 * loop iteration the user has played is recorded under
 * /tmp/nd_plays/<songId>/*.json with timingError per HIT note. Aggregating
 * across many hits gives the calibration's actual behavior in the context
 * of use.
 *
 * Output:
 *   - Per-song breakdown (median, stddev, count, SE)
 *   - Aggregate across all songs
 *   - Verdict: insufficient | at-floor | biased
 *   - Suggested nudge if biased
 *
 * Usage:
 *   node test/calibrate-from-history.js
 *   node test/calibrate-from-history.js --root /tmp/nd_plays
 *   node test/calibrate-from-history.js --mic-latency 67
 *
 * The mic-latency value defaults to 0 (raw view). Pass the current value
 * from the plugin's localStorage to see the post-calibration distribution.
 */

const fs = require('fs');
const path = require('path');
const { loadDetectionCore } = require('./_loader');

function parseArgs() {
    const args = process.argv.slice(2);
    const out = { root: null, micLatency: 0, verbose: false, latestOnly: 0 };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--root') out.root = args[++i];
        else if (args[i] === '--mic-latency') out.micLatency = Number(args[++i]) || 0;
        else if (args[i] === '--latest-only') out.latestOnly = Number(args[++i]) || 1;
        else if (args[i] === '--verbose' || args[i] === '-v') out.verbose = true;
        else if (args[i] === '--help' || args[i] === '-h') {
            console.log(`Usage: node test/calibrate-from-history.js [OPTS]

  --root DIR              Snapshot root (default /tmp/nd_plays, fallback test/fixtures/nd_plays)
  --mic-latency MS        Current mic latency to subtract (default 0)
  --latest-only N         Only use the N most recent snapshot files across all songs.
                          Use 1 to validate a single new loop in isolation.
  -v                      Verbose
`);
            process.exit(0);
        }
    }
    return out;
}

function findSnapshotRoot(explicit) {
    if (explicit) return explicit;
    const candidates = [
        '/tmp/nd_plays',
        path.join(__dirname, 'fixtures', 'nd_plays'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
    }
    return null;
}

function loadSnapshots(root, latestOnly) {
    // Collect every snapshot file with its mtime so we can apply
    // --latest-only across songs, not within each song.
    const allFiles = [];
    const songDirs = fs.readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory());
    for (const d of songDirs) {
        const songDir = path.join(root, d.name);
        const files = fs.readdirSync(songDir).filter(f => f.endsWith('.json'));
        for (const f of files) {
            const fullPath = path.join(songDir, f);
            try {
                const mtime = fs.statSync(fullPath).mtimeMs;
                allFiles.push({ song: d.name, path: fullPath, mtime });
            } catch (e) { /* skip */ }
        }
    }
    // Sort newest-first.
    allFiles.sort((a, b) => b.mtime - a.mtime);
    const selected = latestOnly > 0 ? allFiles.slice(0, latestOnly) : allFiles;

    const bySong = new Map();
    for (const f of selected) {
        try {
            const data = JSON.parse(fs.readFileSync(f.path, 'utf8'));
            if (!bySong.has(f.song)) bySong.set(f.song, []);
            bySong.get(f.song).push(data);
        } catch (e) { /* skip */ }
    }
    return { bySong, totalFilesAvailable: allFiles.length, filesUsed: selected.length };
}

function fmt(n, width = 7) {
    if (n === null || n === undefined) return '—'.padStart(width);
    const s = (n >= 0 ? '+' : '') + Number(n).toFixed(1) + ' ms';
    return s.padStart(width);
}

function main() {
    const opts = parseArgs();
    const root = findSnapshotRoot(opts.root);
    if (!root) {
        console.error('No snapshot root found. Tried /tmp/nd_plays and test/fixtures/nd_plays.');
        process.exit(2);
    }
    console.log(`Reading snapshots from ${root}`);
    console.log(`Current mic latency: ${opts.micLatency} ms`);

    const core = loadDetectionCore();
    const { bySong, totalFilesAvailable, filesUsed } = loadSnapshots(root, opts.latestOnly);
    if (bySong.size === 0) {
        console.error('No play snapshots found.');
        process.exit(1);
    }
    if (opts.latestOnly > 0) {
        console.log(`Using ${filesUsed} most recent snapshot file(s) of ${totalFilesAvailable} available.`);
    }
    console.log();

    // Per-song breakdown
    console.log('Song'.padEnd(35) + 'N'.padStart(5) + 'rawMed'.padStart(10)
        + 'postCal'.padStart(10) + 'stddev'.padStart(10) + 'SE'.padStart(8)
        + '   res'.padStart(8) + '  verdict');
    console.log('-'.repeat(98));

    const allPlays = [];
    for (const [song, plays] of bySong) {
        const result = core.calibFromHistory(plays, opts.micLatency);
        for (const p of plays) allPlays.push(p);
        if (result.count === 0) continue;
        console.log(
            song.padEnd(35).slice(0, 35) +
            String(result.count).padStart(5) +
            fmt(result.rawMedian, 10) +
            fmt(result.postCalibMedian, 10) +
            fmt(result.stddev, 10) +
            fmt(result.se, 8) +
            fmt(result.resolutionMs, 8) +
            '  ' + result.verdict
        );
    }
    console.log('-'.repeat(98));

    // Aggregate
    const agg = core.calibFromHistory(allPlays, opts.micLatency);
    console.log(
        'ALL'.padEnd(35) +
        String(agg.count).padStart(5) +
        fmt(agg.rawMedian, 10) +
        fmt(agg.postCalibMedian, 10) +
        fmt(agg.stddev, 10) +
        fmt(agg.se, 8) +
        fmt(agg.resolutionMs, 8) +
        '  ' + agg.verdict
    );

    console.log();
    if (agg.verdict === 'insufficient') {
        console.log(`INSUFFICIENT — ${agg.count} hits, need ${agg.minHits}. Play one more loop with more notes.`);
        process.exit(2);
    } else if (agg.verdict === 'biased') {
        const sign = agg.suggestedNudge >= 0 ? '+' : '';
        console.log(`BIASED — post-cal median ${fmt(agg.postCalibMedian).trim()}, beyond resolution of ±${agg.resolutionMs} ms (N=${agg.count}, SE=${agg.se} ms).`);
        console.log(`  Recommended mic latency: ${opts.micLatency} ${sign}${agg.suggestedNudge} = ${agg.recommendedMicLatencyMs} ms.`);
        if (agg.recommendedMicLatencyMs === 0 && agg.suggestedNudge < 0) {
            console.log(`  Note: nudge would push mic latency below 0 — clamped to 0. avOffset may be misconfigured.`);
        }
        process.exit(1);
    } else {
        console.log(`AT-FLOOR — post-cal median ${fmt(agg.postCalibMedian).trim()} within resolution of ±${agg.resolutionMs} ms (N=${agg.count}, SE=${agg.se} ms).`);
        console.log(`  No bias detectable at this resolution. Playing variance σ=${fmt(agg.stddev).trim()} is your floor.`);
        console.log(`  More hits would tighten resolution: at N=100 it'd drop to ±${Math.max(5, Math.round(2 * agg.stddev / 10) / 1).toFixed(0)} ms.`);
        process.exit(0);
    }
}

main();

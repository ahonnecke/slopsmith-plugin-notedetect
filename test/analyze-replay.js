#!/usr/bin/env node
/**
 * Analyze replay-results JSON files. Default: print a summary of the
 * latest run. With --diff <prev>: diff two runs and surface fixtures
 * that changed.
 *
 * Usage:
 *   node test/analyze-replay.js
 *   node test/analyze-replay.js path/to/results.json
 *   node test/analyze-replay.js --diff old.json new.json
 *   node test/analyze-replay.js --notes path/to/results.json   # per-note breakdown
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const RESULTS_DIR = path.join(__dirname, 'replay-results');

function latestResultsFile() {
    if (!fs.existsSync(RESULTS_DIR)) return null;
    const files = fs.readdirSync(RESULTS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => ({ name: f, path: path.join(RESULTS_DIR, f), mtime: fs.statSync(path.join(RESULTS_DIR, f)).mtime }))
        .sort((a, b) => b.mtime - a.mtime);
    return files.length ? files[0].path : null;
}

function loadRun(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function fmtPct(n) {
    if (n == null || !Number.isFinite(n)) return '   —';
    return `${(n * 100).toFixed(1)}%`.padStart(6);
}

function summarize(run, label) {
    console.log(`\n=== ${label} ===`);
    console.log(`(${run.timestamp})  ${run.rows.length} fixture(s), glob=${run.glob}`);
    console.log();
    console.log('  hits  miss total    igns   detect   prec   onsets   drift  fixture');
    let totH = 0, totM = 0, totN = 0, totI = 0, totO = 0;
    for (const r of run.rows) {
        if (!r.ok) {
            console.log(`     —    —    —      —       —      —       —       —  ${r.name}  (${r.error})`);
            continue;
        }
        const s = r.summary;
        const ignored = (r.noteResults || []).filter(n => n.ignoredAsDetectorFailure).length;
        totH += s.hits; totM += s.misses; totN += s.total; totI += ignored; totO += s.onsetCount || 0;
        const drift = (s.driftEstimateMs ?? 0).toFixed(0).padStart(6);
        console.log(`  ${String(s.hits).padStart(4)} ${String(s.misses).padStart(4)} ${String(s.total).padStart(4)}  ${String(ignored).padStart(4)}  ${fmtPct(s.detection)}  ${fmtPct(s.precision)}  ${String(s.onsetCount || 0).padStart(4)}  ${drift}  ${r.name}`);
    }
    const overall = totN > 0 ? totH / totN : null;
    console.log('  ----  ---- -----   ----   ------  ------  ------  ------');
    console.log(`  ${String(totH).padStart(4)} ${String(totM).padStart(4)} ${String(totN).padStart(4)}  ${String(totI).padStart(4)}  ${fmtPct(overall)}      —  ${String(totO).padStart(4)}      —  TOTAL`);
}

function diff(oldRun, newRun) {
    const oldByName = new Map(oldRun.rows.map(r => [r.name, r]));
    console.log('\n=== Diff ===');
    console.log(`old: ${oldRun.timestamp}`);
    console.log(`new: ${newRun.timestamp}`);
    console.log();
    console.log('  Δhits  Δigns  Δdetect   fixture');
    let totDH = 0, totDI = 0;
    for (const nR of newRun.rows) {
        if (!nR.ok) continue;
        const oR = oldByName.get(nR.name);
        if (!oR || !oR.ok) {
            console.log(`     —      —       —    ${nR.name} (no prior)`);
            continue;
        }
        const oI = (oR.noteResults || []).filter(n => n.ignoredAsDetectorFailure).length;
        const nI = (nR.noteResults || []).filter(n => n.ignoredAsDetectorFailure).length;
        const dh = nR.summary.hits - oR.summary.hits;
        const di = nI - oI;
        const dd = nR.summary.detection - oR.summary.detection;
        const sign = (n) => n >= 0 ? '+' : '';
        const flag = Math.abs(dh) >= 1 ? ' ⚡' : '';
        totDH += dh; totDI += di;
        console.log(`  ${(sign(dh) + dh).padStart(5)}  ${(sign(di) + di).padStart(5)}  ${(sign(dd) + (dd * 100).toFixed(1)).padStart(7)}%   ${nR.name}${flag}`);
    }
    console.log('  ----- ------  -------');
    const sign = (n) => n >= 0 ? '+' : '';
    console.log(`  ${(sign(totDH) + totDH).padStart(5)}  ${(sign(totDI) + totDI).padStart(5)}      —    TOTAL`);
}

function notesBreakdown(run) {
    for (const r of run.rows) {
        if (!r.ok) continue;
        console.log(`\n=== ${r.name} (${r.summary.hits}/${r.summary.total}) ===`);
        const nr = r.noteResults || [];
        const byKind = { hit: 0, miss: 0, ignored: 0 };
        for (const n of nr) {
            if (n.ignoredAsDetectorFailure) byKind.ignored++;
            else if (n.hit) byKind.hit++;
            else byKind.miss++;
        }
        console.log(`  ${byKind.hit} HIT  ${byKind.miss} miss  ${byKind.ignored} ignored`);
    }
}

if (args[0] === '--diff') {
    const oldRun = loadRun(args[1]);
    const newRun = loadRun(args[2]);
    summarize(oldRun, 'OLD');
    summarize(newRun, 'NEW');
    diff(oldRun, newRun);
} else if (args[0] === '--notes') {
    const file = args[1] || latestResultsFile();
    notesBreakdown(loadRun(file));
} else {
    const file = args[0] || latestResultsFile();
    if (!file) { console.error('No results file found'); process.exit(1); }
    summarize(loadRun(file), 'Latest');
}

#!/usr/bin/env node
/**
 * Session report — reads a classification.json and emits a readable
 * feedback document showing where the player struggled and where the
 * pipeline struggled. Consumes the output of test/classify-session.js.
 *
 * Without arguments, picks the newest classification.json in test/fixtures/.
 * Use --session <substring> to pick a specific one.
 *
 * Outputs:
 *   - Terminal summary (quick glance)
 *   - Markdown file next to the classification.json (for sharing / re-reading)
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function getArg(n, d) { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; }

const FIXTURES = path.join(__dirname, 'fixtures');
const SESSION = getArg('session', '');
const DUMP_ONLY = getArg('dump', null);

function findClassification() {
    const files = fs.readdirSync(FIXTURES)
        .filter(f => f.endsWith('.classification.json'))
        .filter(f => SESSION === '' || f.includes(SESSION))
        .map(f => ({ f, path: path.join(FIXTURES, f), mtime: fs.statSync(path.join(FIXTURES, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return null;
    return files[0].path;
}

// Build a synthetic "classification" structure from just a dump file.
// Used when the user played without recording, so no WAV/audio-truth is
// available — we still have every pipeline judgement and can produce
// timing/pitch/per-string stats. audio-dependent buckets (e.g.
// PIPELINE_MISSED_REAL_PLAY, PIPELINE_YIN_DISAGREES) aren't derivable
// without the WAV; everything's categorised by pipeline verdict directly.
function classificationFromDump(dumpPath) {
    const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
    const notes = [];
    for (const r of dump.noteResults || []) {
        const m = /^([\d.]+)_(\d+)_(\d+)$/.exec(r.key);
        if (!m) continue;
        const category = r.primary === 'HIT'
            ? 'PIPELINE_HIT'
            : (r.primary === 'MISSED_NO_DETECTION' ? 'MISS_NO_DETECTION' : 'MISS_WRONG_PITCH');
        notes.push({
            chartT: parseFloat(m[1]),
            expectedMidi: r.expectedMidi,
            stringFret: `s${m[2]}/f${m[3]}`,
            audio: { dominantMidi: r.detectedMidi, bestCents: null, pitchedFrames: null },
            pipelineVerdict: {
                primary: r.primary || 'HIT',
                detectedMidi: r.detectedMidi,
                pitchError: r.pitchError,
                timingError: r.timingError,
                expectedMidi: r.expectedMidi,
                labels: r.labels || [],
            },
            category,
        });
    }
    return {
        wav: '(no recording — dump-only mode)',
        dump: dumpPath,
        totalNotes: notes.length,
        notes,
        dumpTimestamp: dump.timestamp,
        scoring: dump.scoring,
        settings: dump.settings,
    };
}

// ASCII histogram renderer. `bins` is a Map label → count.
function renderHist(bins, maxBarLen = 40) {
    const vals = [...bins.values()];
    const max = Math.max(1, ...vals);
    const lines = [];
    for (const [label, count] of bins) {
        const bar = '█'.repeat(Math.round(count / max * maxBarLen));
        lines.push(`    ${String(label).padStart(8)}  ${String(count).padStart(4)}  ${bar}`);
    }
    return lines.join('\n');
}

// Bucket a list of numbers into integer-labelled bins of `binSize`.
function bucketize(values, binSize) {
    const bins = new Map();
    for (const v of values) {
        const b = Math.round(v / binSize) * binSize;
        bins.set(b, (bins.get(b) || 0) + 1);
    }
    // Fill gaps so the histogram reads continuously.
    if (bins.size === 0) return bins;
    const keys = [...bins.keys()].sort((a, b) => a - b);
    const filled = new Map();
    for (let k = keys[0]; k <= keys[keys.length - 1]; k += binSize) {
        filled.set(k, bins.get(k) || 0);
    }
    return filled;
}

// Per-chart-string summary — hit rate + miss-bucket breakdown.
function perStringStats(notes) {
    const byString = new Map();
    for (const n of notes) {
        const s = /s(\d+)/.exec(n.stringFret)?.[1];
        if (s === undefined) continue;
        const key = `s${s}`;
        if (!byString.has(key)) byString.set(key, { total: 0, hit: 0, userWrong: 0, yinDisagree: 0, realMiss: 0, silent: 0 });
        const row = byString.get(key);
        row.total++;
        if (n.category === 'PIPELINE_HIT') row.hit++;
        else if (n.category === 'USER_WRONG_PITCH') row.userWrong++;
        else if (n.category === 'PIPELINE_YIN_DISAGREES') row.yinDisagree++;
        else if (n.category === 'PIPELINE_MISSED_REAL_PLAY') row.realMiss++;
        else if (n.category === 'USER_SILENT') row.silent++;
    }
    return byString;
}

// Notes where the user repeatedly missed — same (string, fret) position
// showing up multiple times in the miss buckets.
function repeatOffenders(notes) {
    const counts = new Map();
    for (const n of notes) {
        if (n.category === 'PIPELINE_HIT' || n.category === 'PIPELINE_MISSED_REAL_PLAY') continue;
        const key = `${n.stringFret} (MIDI ${n.expectedMidi})`;
        if (!counts.has(key)) counts.set(key, { count: 0, category: n.category, detections: [] });
        const row = counts.get(key);
        row.count++;
        row.detections.push(n.audio?.dominantMidi);
    }
    const list = [...counts.entries()]
        .filter(([_, v]) => v.count >= 2)
        .sort((a, b) => b[1].count - a[1].count);
    return list;
}

function main() {
    let data, stem, outBase;
    if (DUMP_ONLY) {
        data = classificationFromDump(DUMP_ONLY);
        stem = path.basename(DUMP_ONLY).replace(/\.dump\.json$/, '').replace(/\.json$/, '');
        outBase = DUMP_ONLY.replace(/\.dump\.json$/, '').replace(/\.json$/, '');
    } else {
        const classPath = findClassification();
        if (!classPath) {
            console.error(`no *.classification.json found${SESSION ? ` matching '${SESSION}'` : ''} in ${FIXTURES}`);
            console.error(`pass --dump <path> to report on a bare dump instead.`);
            process.exit(1);
        }
        data = JSON.parse(fs.readFileSync(classPath, 'utf8'));
        stem = path.basename(classPath).replace(/\.classification\.json$/, '');
        outBase = classPath.replace(/\.classification\.json$/, '');
    }
    const notes = data.notes || [];

    // Pull timing and pitch errors from HIT entries (pipeline recorded them
    // in the dump, which the classifier forwards via pipelineVerdict).
    const hits = notes.filter(n => n.category === 'PIPELINE_HIT');
    const timings = hits.map(n => n.pipelineVerdict?.timingError).filter(v => typeof v === 'number');
    const pitches = hits.map(n => n.pipelineVerdict?.pitchError).filter(v => typeof v === 'number');

    // Terminal summary
    console.log(`\n═══ Session report: ${stem} ═══`);
    console.log(`  ${notes.length} chart notes analysed`);
    console.log(`  WAV: ${data.wav}`);
    console.log(`  Dump: ${data.dump || '(none — audio-truth mode)'}`);
    console.log();

    console.log(`── Score summary ──`);
    const buckets = new Map();
    for (const n of notes) buckets.set(n.category, (buckets.get(n.category) || 0) + 1);
    for (const [cat, n] of buckets) {
        console.log(`  ${cat.padEnd(28)} ${String(n).padStart(4)}  (${(n / notes.length * 100).toFixed(1)}%)`);
    }
    console.log();

    if (timings.length > 0) {
        console.log(`── Timing: when you hit, how early/late? (n=${timings.length}) ──`);
        const tBins = bucketize(timings, 50);  // 50 ms bins
        console.log(renderHist(tBins));
        const sortedT = [...timings].sort((a, b) => a - b);
        const p = q => sortedT[Math.floor((sortedT.length - 1) * q)];
        console.log(`    p25=${p(0.25).toFixed(0)}ms   p50=${p(0.5).toFixed(0)}ms   p75=${p(0.75).toFixed(0)}ms   (positive = you hit late)`);
        console.log();
    }

    if (pitches.length > 0) {
        console.log(`── Pitch: when you hit, how sharp/flat? (n=${pitches.length}) ──`);
        const pBins = bucketize(pitches, 10);  // 10-cent bins
        console.log(renderHist(pBins));
        const sortedP = [...pitches].sort((a, b) => a - b);
        const p = q => sortedP[Math.floor((sortedP.length - 1) * q)];
        console.log(`    p25=${p(0.25).toFixed(0)}¢   p50=${p(0.5).toFixed(0)}¢   p75=${p(0.75).toFixed(0)}¢   (positive = sharp)`);
        console.log();
    }

    const strings = perStringStats(notes);
    if (strings.size > 1) {
        console.log(`── Per-string hit rate ──`);
        console.log(`    string  total  hit   user-wrong  yin-disagree  missed  silent`);
        for (const [s, row] of strings) {
            const rate = row.total > 0 ? (row.hit / row.total * 100).toFixed(0) : '—';
            console.log(`    ${s.padEnd(7)} ${String(row.total).padStart(5)}  ${String(row.hit).padStart(3)} (${rate.padStart(3)}%) ${String(row.userWrong).padStart(9)} ${String(row.yinDisagree).padStart(12)} ${String(row.realMiss).padStart(6)} ${String(row.silent).padStart(6)}`);
        }
        console.log();
    }

    const offenders = repeatOffenders(notes);
    if (offenders.length > 0) {
        console.log(`── Notes you keep missing ──`);
        for (const [k, v] of offenders.slice(0, 10)) {
            const det = v.detections.filter(x => x != null);
            const detStr = det.length ? ` → usually played as MIDI ${[...new Set(det)].join(',')}` : '';
            console.log(`    ${k.padEnd(24)} ${v.count}× ${v.category}${detStr}`);
        }
        console.log();
    }

    if (data.offsetSweep) {
        printOffsetSweep(data.offsetSweep);
    }

    // Emit markdown for sharing.
    const md = renderMarkdown(stem, notes, timings, pitches, strings, offenders, buckets, data);
    const mdPath = `${outBase}.report.md`;
    fs.writeFileSync(mdPath, md);
    console.log(`  markdown: ${path.relative(process.cwd(), mdPath)}`);
}

function renderMarkdown(stem, notes, timings, pitches, strings, offenders, buckets, data) {
    const lines = [];
    lines.push(`# Session report: ${stem}\n`);
    lines.push(`- ${notes.length} chart notes analysed`);
    lines.push(`- WAV: \`${data.wav}\``);
    lines.push(`- Dump: ${data.dump ? `\`${data.dump}\`` : '_(none — audio-truth mode)_'}`);
    lines.push('');

    lines.push(`## Score summary\n`);
    lines.push(`| Bucket | Count | % |`);
    lines.push(`|---|---|---|`);
    for (const [cat, n] of buckets) lines.push(`| ${cat} | ${n} | ${(n / notes.length * 100).toFixed(1)}% |`);
    lines.push('');

    if (timings.length > 0) {
        lines.push(`## Timing errors (on hits)\n`);
        lines.push('```');
        lines.push(renderHist(bucketize(timings, 50)));
        lines.push('```');
        const s = [...timings].sort((a, b) => a - b);
        const p = q => s[Math.floor((s.length - 1) * q)];
        lines.push(`\np25=${p(0.25).toFixed(0)}ms, p50=${p(0.5).toFixed(0)}ms, p75=${p(0.75).toFixed(0)}ms (positive = late)\n`);
    }

    if (pitches.length > 0) {
        lines.push(`## Pitch errors (on hits)\n`);
        lines.push('```');
        lines.push(renderHist(bucketize(pitches, 10)));
        lines.push('```');
        const s = [...pitches].sort((a, b) => a - b);
        const p = q => s[Math.floor((s.length - 1) * q)];
        lines.push(`\np25=${p(0.25).toFixed(0)}¢, p50=${p(0.5).toFixed(0)}¢, p75=${p(0.75).toFixed(0)}¢ (positive = sharp)\n`);
    }

    if (strings.size > 1) {
        lines.push(`## Per-string hit rate\n`);
        lines.push(`| string | total | hit | user-wrong | yin-disagree | missed | silent |`);
        lines.push(`|---|---|---|---|---|---|---|`);
        for (const [s, row] of strings) {
            const rate = row.total > 0 ? (row.hit / row.total * 100).toFixed(0) : '—';
            lines.push(`| ${s} | ${row.total} | ${row.hit} (${rate}%) | ${row.userWrong} | ${row.yinDisagree} | ${row.realMiss} | ${row.silent} |`);
        }
        lines.push('');
    }

    if (offenders.length > 0) {
        lines.push(`## Notes you keep missing (top 10)\n`);
        lines.push(`| position | count | category | usually heard as |`);
        lines.push(`|---|---|---|---|`);
        for (const [k, v] of offenders.slice(0, 10)) {
            const det = v.detections.filter(x => x != null);
            const detStr = det.length ? `MIDI ${[...new Set(det)].join(',')}` : '—';
            lines.push(`| ${k} | ${v.count} | ${v.category} | ${detStr} |`);
        }
        lines.push('');
    }

    if (data.offsetSweep) {
        lines.push(renderOffsetSweepMd(data.offsetSweep));
    }
    return lines.join('\n');
}

function printOffsetSweep(sweep) {
    const { curve, peak, atZero, totalNotes, sweepWindowMs, centsTolerance } = sweep;
    console.log(`── Offset sweep (audio-truth ceiling) ──`);
    console.log(`  For each virtual input-latency Δ, count chart notes whose expected pitch`);
    console.log(`  is audible within ±${sweepWindowMs}ms of Δ. Peak = where the audio for plucks`);
    console.log(`  actually lands relative to chartT (i.e. effective mic→pipeline latency).`);
    console.log(`  NOT a live-pipeline replay. Pitch within ±${centsTolerance}¢.`);
    console.log();
    const maxCeil = Math.max(...curve.map(p => p.ceiling), 1);
    for (const p of curve) {
        const bar = '█'.repeat(Math.round(p.ceiling / maxCeil * 40));
        const pct = (p.ceiling / totalNotes * 100).toFixed(1);
        const marks = [];
        if (p.offsetMs === peak.offsetMs) marks.push('← peak');
        if (p.offsetMs === atZero.offsetMs) marks.push('← 0ms (no comp)');
        console.log(`    Δ=${String(p.offsetMs).padStart(5)}ms  ${String(p.ceiling).padStart(4)}/${totalNotes}  ${pct.padStart(5)}%  ${bar} ${marks.join(' ')}`);
    }
    const gain = peak.ceiling - atZero.ceiling;
    const gainPp = (gain / totalNotes * 100).toFixed(1);
    console.log();
    console.log(`  Peak Δ=${peak.offsetMs}ms → ${(peak.ceiling / totalNotes * 100).toFixed(1)}%   current Δ=0 → ${(atZero.ceiling / totalNotes * 100).toFixed(1)}%   ceiling gain: +${gain} notes (+${gainPp}pp)`);
    console.log();
}

function renderOffsetSweepMd(sweep) {
    const { curve, peak, atZero, totalNotes, sweepWindowMs, centsTolerance } = sweep;
    const lines = [];
    lines.push(`## Offset sweep (audio-truth ceiling)\n`);
    lines.push(`For each virtual input-latency Δ, count chart notes whose expected pitch is audible within ±${sweepWindowMs}ms of Δ.`);
    lines.push(`Peak = where the audio for plucks actually lands relative to chartT (effective mic→pipeline latency).`);
    lines.push(`NOT a replay of the live pipeline. Pitch within ±${centsTolerance}¢.\n`);
    lines.push('```');
    const maxCeil = Math.max(...curve.map(p => p.ceiling), 1);
    for (const p of curve) {
        const bar = '█'.repeat(Math.round(p.ceiling / maxCeil * 40));
        const pct = (p.ceiling / totalNotes * 100).toFixed(1);
        const marks = [];
        if (p.offsetMs === peak.offsetMs) marks.push('← peak');
        if (p.offsetMs === atZero.offsetMs) marks.push('← 0ms (no comp)');
        lines.push(`Δ=${String(p.offsetMs).padStart(5)}ms  ${String(p.ceiling).padStart(4)}/${totalNotes}  ${pct.padStart(5)}%  ${bar} ${marks.join(' ')}`);
    }
    lines.push('```');
    const gain = peak.ceiling - atZero.ceiling;
    const gainPp = (gain / totalNotes * 100).toFixed(1);
    lines.push(`\nPeak Δ=**${peak.offsetMs}ms** → ${(peak.ceiling / totalNotes * 100).toFixed(1)}%   current Δ=0 → ${(atZero.ceiling / totalNotes * 100).toFixed(1)}%   ceiling gain: **+${gain} notes (+${gainPp}pp)**\n`);
    return lines.join('\n');
}

main();

#!/usr/bin/env node
/**
 * Loop-attempt aggregator — joins per-play snapshots from
 * /tmp/nd_plays/<songId>/*.json into a per-note attempt matrix and
 * surfaces the notes the player consistently misses across N attempts.
 *
 * Each play snapshot is one pass of the chart (or one loop iteration in
 * a slopsmith A/B loop session). The plugin posts one snapshot per
 * loop_restart to /api/plugins/note_detect/plays; the server stores them
 * under /tmp/nd_plays/<songId>/<playId>.json. This script pulls all
 * plays for a song and produces a best-of-N / consistency report.
 *
 * IMPORTANT — known data limitation: the live `_ndNoteResults` map is
 * populated only for chart notes the pipeline ACTUALLY MATCHED (HIT or
 * MISSED_WRONG_PITCH after the miss deadline elapses). MISSED_NO_DETECTION
 * entries can be missing from a snapshot when the loop wraps before the
 * miss-deadline grace period has elapsed for the tail notes. This script
 * therefore can't reliably tell "did the pipeline see no detection" apart
 * from "did the snapshot fire too early to record the miss." It surfaces
 * what was captured and lets you read the absent-from-N-of-M signal as
 * "inconsistently hit" rather than "definitely missed."
 *
 * Usage:
 *   node test/aggregate-plays.js [--song <songId>] [--from <dir>]
 *                                [--last <N>]
 *
 *   --song   substring match against songId (default: most recent song)
 *   --from   local directory of play JSONs (default: pull from container)
 *   --last   limit to the last N plays for the song (default: all)
 *
 * Output:
 *   Terminal summary + markdown report at
 *   test/fixtures/<songId>.aggregate.md
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
function getArg(n, d) { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; }

const SONG = getArg('song', '');
const FROM_DIR = getArg('from', null);
const LAST_N = parseInt(getArg('last', '0'), 10) || null;
const CONTAINER = getArg('container', 'slopsmith-web-1');
const FIXTURES = path.join(__dirname, 'fixtures');

// ── Load plays ──────────────────────────────────────────────────────────────

function listSongsInContainer() {
    try {
        const out = execSync(`docker exec ${CONTAINER} sh -c 'ls -td /tmp/nd_plays/*/ 2>/dev/null'`, { encoding: 'utf8' });
        return out.trim().split('\n').filter(Boolean).map(p => path.basename(p.replace(/\/$/, '')));
    } catch {
        return [];
    }
}

function pullSongFromContainer(songId) {
    const stage = path.join(FIXTURES, 'plays', songId);
    fs.mkdirSync(stage, { recursive: true });
    try {
        execSync(`docker cp ${CONTAINER}:/tmp/nd_plays/${songId}/. ${stage}/`, { stdio: 'pipe' });
    } catch (e) {
        throw new Error(`failed to pull plays for ${songId}: ${e.message}`);
    }
    return stage;
}

function loadPlaysFromDir(dir) {
    const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => path.join(dir, f))
        .sort();  // playId is an ISO timestamp → lexical sort = chronological
    return files.map(f => ({ path: f, ...JSON.parse(fs.readFileSync(f, 'utf8')) }));
}

// ── Aggregation ─────────────────────────────────────────────────────────────

// For each chart note key seen across plays, record what each play said.
// Result: { key, chartT, expectedMidi, stringFret, attempts: [{playIdx, verdict}] }
function aggregate(plays) {
    // Each play's chartT range (used to decide whether an absent key was
    // out-of-scope vs. genuinely not captured).
    const playMeta = plays.map((p, i) => {
        const ts = (p.noteResults || []).map(r => r.chartT).filter(Number.isFinite);
        return {
            idx: i,
            playId: p.playId,
            startedAt: p.startedAt,
            reason: p.reason,
            chartTMin: ts.length ? Math.min(...ts) : null,
            chartTMax: ts.length ? Math.max(...ts) : null,
            count: (p.noteResults || []).length,
        };
    });

    // Union of all keys.
    const noteIndex = new Map(); // key → { chartT, expectedMidi, stringFret, attempts: Map<playIdx, result> }
    for (let i = 0; i < plays.length; i++) {
        for (const r of plays[i].noteResults || []) {
            if (!noteIndex.has(r.key)) {
                noteIndex.set(r.key, {
                    key: r.key,
                    chartT: r.chartT,
                    expectedMidi: r.expectedMidi,
                    stringFret: `s${r.s}/f${r.f}`,
                    attempts: new Map(),
                });
            }
            noteIndex.get(r.key).attempts.set(i, {
                primary: r.primary,
                labels: r.labels,
                timingError: r.timingError,
                pitchError: r.pitchError,
                detectedMidi: r.detectedMidi,
            });
        }
    }

    // Materialize per-note rows with normalized verdicts across all plays.
    // A play "covered" a note's chartT if chartT is between the play's
    // chartTMin and chartTMax (inclusive). If covered but no entry exists,
    // mark as ABSENT (caveat in the docstring — could be NO_DETECTION OR
    // a snapshot timing artifact).
    const rows = [];
    for (const note of noteIndex.values()) {
        const verdicts = [];
        for (const meta of playMeta) {
            const a = note.attempts.get(meta.idx);
            if (a) {
                verdicts.push({ kind: a.primary, labels: a.labels, timingError: a.timingError, pitchError: a.pitchError, detectedMidi: a.detectedMidi });
            } else if (meta.chartTMin != null && note.chartT >= meta.chartTMin && note.chartT <= meta.chartTMax) {
                verdicts.push({ kind: 'ABSENT' });
            } else {
                verdicts.push({ kind: 'OUT_OF_SCOPE' });
            }
        }
        rows.push({ ...note, verdicts });
    }

    rows.sort((a, b) => a.chartT - b.chartT);
    return { playMeta, rows };
}

// ── Reporting ───────────────────────────────────────────────────────────────

function statsForRow(row) {
    const inScope = row.verdicts.filter(v => v.kind !== 'OUT_OF_SCOPE');
    const hits = inScope.filter(v => v.kind === 'HIT').length;
    const wrongPitch = inScope.filter(v => v.kind === 'MISSED_WRONG_PITCH').length;
    const noDetection = inScope.filter(v => v.kind === 'MISSED_NO_DETECTION').length;
    const absent = inScope.filter(v => v.kind === 'ABSENT').length;
    return {
        nAttempts: inScope.length,
        hits, wrongPitch, noDetection, absent,
        hitRate: inScope.length ? hits / inScope.length : 0,
    };
}

function verdictGlyph(v) {
    if (v.kind === 'HIT') return '✓';
    if (v.kind === 'MISSED_WRONG_PITCH') return '✗';  // wrong pitch detected
    if (v.kind === 'MISSED_NO_DETECTION') return '∅'; // no detection
    if (v.kind === 'ABSENT') return '·';              // not in snapshot
    if (v.kind === 'OUT_OF_SCOPE') return ' ';
    return '?';
}

function summarize(playMeta, rows) {
    const N = playMeta.length;
    const totalNotes = rows.length;
    let bestOfN = 0;          // notes hit on ≥1 attempt
    let perfectAcrossN = 0;   // notes hit on EVERY attempt
    let neverHit = 0;         // notes hit on 0 attempts
    const consistencyBins = new Map(); // hitRate (rounded to 0.1) → count
    for (const row of rows) {
        const s = statsForRow(row);
        if (s.hits > 0) bestOfN++;
        if (s.hits === s.nAttempts && s.nAttempts === N) perfectAcrossN++;
        if (s.hits === 0) neverHit++;
        const bin = Math.round(s.hitRate * 10) / 10;
        consistencyBins.set(bin, (consistencyBins.get(bin) || 0) + 1);
    }
    return { N, totalNotes, bestOfN, perfectAcrossN, neverHit, consistencyBins };
}

function renderTerminal(playMeta, rows) {
    const { N, totalNotes, bestOfN, perfectAcrossN, neverHit, consistencyBins } = summarize(playMeta, rows);
    console.log();
    console.log(`═══ Loop aggregate: ${playMeta.length} attempts, ${totalNotes} unique chart notes ═══`);
    for (const m of playMeta) {
        const span = m.chartTMin != null ? `${m.chartTMin.toFixed(1)}–${m.chartTMax.toFixed(1)}s` : '(empty)';
        console.log(`  attempt ${m.idx + 1}: ${m.playId}  (${span}, ${m.count} notes captured, reason=${m.reason})`);
    }
    console.log();
    console.log(`── Score across attempts ──`);
    console.log(`  Best-of-${N}:        ${bestOfN}/${totalNotes} (${(bestOfN / totalNotes * 100).toFixed(1)}%) hit at least once`);
    console.log(`  Perfect-across-${N}: ${perfectAcrossN}/${totalNotes} (${(perfectAcrossN / totalNotes * 100).toFixed(1)}%) hit on every attempt`);
    console.log(`  Never-hit:        ${neverHit}/${totalNotes} (${(neverHit / totalNotes * 100).toFixed(1)}%) missed on every attempt`);
    console.log();
    console.log(`── Consistency histogram (notes by hit-rate) ──`);
    const sortedBins = [...consistencyBins.entries()].sort((a, b) => a[0] - b[0]);
    const max = Math.max(...sortedBins.map(([, c]) => c), 1);
    for (const [rate, count] of sortedBins) {
        const bar = '█'.repeat(Math.round(count / max * 40));
        console.log(`  ${(rate * 100).toFixed(0).padStart(4)}%  ${String(count).padStart(4)}  ${bar}`);
    }
    console.log();

    console.log(`── Per-note attempt matrix (chronological by chartT) ──`);
    const header = '  '.repeat(0) + '   chartT  exp  s/f   ' + Array.from({ length: N }, (_, i) => String(i + 1)).join('') + '   hits   notes';
    console.log(header);
    for (const row of rows) {
        const s = statsForRow(row);
        const glyphs = row.verdicts.map(verdictGlyph).join('');
        const tag = s.hits === s.nAttempts ? '✓ all' :
            s.hits === 0 ? '✗ none' :
                `${s.hits}/${s.nAttempts}`;
        console.log(`  ${row.chartT.toFixed(2).padStart(7)}s  ${String(row.expectedMidi).padStart(3)}  ${row.stringFret.padEnd(5)} ${glyphs}   ${tag}`);
    }
    console.log();
    console.log('  ✓ HIT  ✗ wrong pitch  ∅ no detection  · absent (snapshot may have closed early)  ⎵ out of scope');
    console.log();

    const offenders = rows
        .map(r => ({ ...r, ...statsForRow(r) }))
        .filter(r => r.hits < r.nAttempts && r.nAttempts >= 2)
        .sort((a, b) => a.hitRate - b.hitRate || b.nAttempts - a.nAttempts);
    if (offenders.length > 0) {
        console.log(`── Practice these (top 10 by miss rate, ≥2 attempts) ──`);
        for (const r of offenders.slice(0, 10)) {
            const pctMiss = ((1 - r.hitRate) * 100).toFixed(0);
            console.log(`  ${r.chartT.toFixed(2).padStart(7)}s  MIDI ${String(r.expectedMidi).padStart(3)}  ${r.stringFret.padEnd(6)} missed ${r.nAttempts - r.hits}/${r.nAttempts} (${pctMiss}%)`);
        }
        console.log();
    }
}

function renderMarkdown(songId, playMeta, rows) {
    const { N, totalNotes, bestOfN, perfectAcrossN, neverHit, consistencyBins } = summarize(playMeta, rows);
    const lines = [];
    lines.push(`# Loop aggregate: ${songId}\n`);
    lines.push(`- ${playMeta.length} attempts`);
    lines.push(`- ${totalNotes} unique chart notes seen across all attempts`);
    lines.push('');

    lines.push(`## Attempts\n`);
    lines.push(`| # | playId | chartT range | notes captured | reason |`);
    lines.push(`|---|---|---|---|---|`);
    for (const m of playMeta) {
        const span = m.chartTMin != null ? `${m.chartTMin.toFixed(1)}–${m.chartTMax.toFixed(1)}s` : '(empty)';
        lines.push(`| ${m.idx + 1} | \`${m.playId}\` | ${span} | ${m.count} | ${m.reason} |`);
    }
    lines.push('');

    lines.push(`## Score across attempts\n`);
    lines.push(`| Metric | Count | % |`);
    lines.push(`|---|---|---|`);
    lines.push(`| Best-of-${N} (hit at least once) | ${bestOfN}/${totalNotes} | ${(bestOfN / totalNotes * 100).toFixed(1)}% |`);
    lines.push(`| Perfect-across-${N} (hit every time) | ${perfectAcrossN}/${totalNotes} | ${(perfectAcrossN / totalNotes * 100).toFixed(1)}% |`);
    lines.push(`| Never-hit (missed every time) | ${neverHit}/${totalNotes} | ${(neverHit / totalNotes * 100).toFixed(1)}% |`);
    lines.push('');

    lines.push(`## Consistency (notes binned by hit-rate)\n`);
    lines.push('```');
    const sortedBins = [...consistencyBins.entries()].sort((a, b) => a[0] - b[0]);
    const max = Math.max(...sortedBins.map(([, c]) => c), 1);
    for (const [rate, count] of sortedBins) {
        const bar = '█'.repeat(Math.round(count / max * 40));
        lines.push(`${(rate * 100).toFixed(0).padStart(4)}%  ${String(count).padStart(4)}  ${bar}`);
    }
    lines.push('```');
    lines.push('');

    lines.push(`## Per-note attempt matrix\n`);
    lines.push(`Glyphs: \`✓\` HIT, \`✗\` wrong pitch, \`∅\` no detection, \`·\` absent (snapshot may have closed early), \`⎵\` out of scope.\n`);
    lines.push('```');
    lines.push('  chartT  exp  s/f    ' + Array.from({ length: N }, (_, i) => String(i + 1)).join('') + '   hits');
    for (const row of rows) {
        const s = statsForRow(row);
        const glyphs = row.verdicts.map(verdictGlyph).join('');
        const tag = s.hits === s.nAttempts ? 'all' :
            s.hits === 0 ? 'none' :
                `${s.hits}/${s.nAttempts}`;
        lines.push(`${row.chartT.toFixed(2).padStart(7)}s  ${String(row.expectedMidi).padStart(3)}  ${row.stringFret.padEnd(5)} ${glyphs}   ${tag}`);
    }
    lines.push('```');
    lines.push('');

    const offenders = rows
        .map(r => ({ ...r, ...statsForRow(r) }))
        .filter(r => r.hits < r.nAttempts && r.nAttempts >= 2)
        .sort((a, b) => a.hitRate - b.hitRate || b.nAttempts - a.nAttempts);
    if (offenders.length > 0) {
        lines.push(`## Practice these\n`);
        lines.push(`| chartT | MIDI | string/fret | missed | attempts | miss rate |`);
        lines.push(`|---|---|---|---|---|---|`);
        for (const r of offenders.slice(0, 20)) {
            lines.push(`| ${r.chartT.toFixed(2)}s | ${r.expectedMidi} | ${r.stringFret} | ${r.nAttempts - r.hits} | ${r.nAttempts} | ${((1 - r.hitRate) * 100).toFixed(0)}% |`);
        }
        lines.push('');
    }
    return lines.join('\n');
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
    let songId, dir;
    if (FROM_DIR) {
        dir = FROM_DIR;
        songId = path.basename(FROM_DIR.replace(/\/$/, ''));
    } else {
        const songs = listSongsInContainer();
        if (songs.length === 0) {
            console.error(`no songs found in ${CONTAINER}:/tmp/nd_plays/. Has the plugin recorded any plays yet?`);
            process.exit(1);
        }
        const matches = SONG ? songs.filter(s => s.toLowerCase().includes(SONG.toLowerCase())) : songs;
        if (matches.length === 0) {
            console.error(`no songs match '${SONG}'. available:\n  ${songs.join('\n  ')}`);
            process.exit(1);
        }
        songId = matches[0];
        console.log(`song: ${songId}`);
        dir = pullSongFromContainer(songId);
    }

    let plays = loadPlaysFromDir(dir);
    if (plays.length === 0) {
        console.error(`no plays found in ${dir}`);
        process.exit(1);
    }
    if (LAST_N && plays.length > LAST_N) {
        plays = plays.slice(plays.length - LAST_N);
        console.log(`limiting to last ${LAST_N} plays`);
    }
    console.log(`loaded ${plays.length} play snapshots from ${path.relative(process.cwd(), dir)}`);

    const { playMeta, rows } = aggregate(plays);
    renderTerminal(playMeta, rows);

    const md = renderMarkdown(songId, playMeta, rows);
    const outPath = path.join(FIXTURES, `${songId}.aggregate.md`);
    fs.writeFileSync(outPath, md);
    console.log(`  markdown: ${path.relative(process.cwd(), outPath)}`);
}

main();

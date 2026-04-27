#!/usr/bin/env node
/**
 * Run the song-pipeline ceiling test across a curated roster of songs and
 * print a comparison table. Each entry in the roster is chosen to stress a
 * different part of the detection pipeline so a code change can be regressed
 * against multiple chart shapes at once (a fix that lifts Stand by Me but
 * tanks Mexico is not a fix).
 *
 * See docs/SONG_PIPELINE_CEILING.md for the rationale per song.
 *
 * Usage:
 *   node test/song-ceiling-roster.js                        # default roster
 *   node test/song-ceiling-roster.js --extended             # + the bench list
 *   node test/song-ceiling-roster.js --songs "Mexico,Schism"
 *   node test/song-ceiling-roster.js --force                # re-run all
 *   node test/song-ceiling-roster.js --reuse                # accept any cached result
 *
 * Reuse policy (default): use cached ceiling JSON if it was measured at the
 * current pipeline commit, else re-run. --reuse accepts any cached result;
 * --force re-runs everything regardless.
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

// Default roster — picked to span the pipeline's stress vectors.
const DEFAULT_ROSTER = [
    // Cleanest fixture — band-pass ceiling 99.7%. Use as the primary
    // user-vs-pipeline reference: any user-side score on Gasoline reflects
    // playing accuracy almost directly because the ceiling is essentially
    // perfect. Two-Door specifically (the search returns Audioslave first;
    // pass --filename-hint or use the full title to disambiguate).
    { query: 'Gasoline',               filenameHint: 'Two-Door', stresses: 'modern indie pop with prominent clean DI bass — band-pass ceiling 99.7%, cleanest fixture' },
    { query: 'Mexico',                 stresses: 'wide pitch range, moderate density (Cake — moderate-difficulty reference)' },
    { query: 'Stand by Me',            stresses: 'low-frequency dominant (E2/F#2), sustain bleed — but chart pitches are authored half-step low, so user score is suppressed by ~17% chart-bug noise' },
    { query: 'Bulls on Parade',        stresses: 'heavily-mastered mid-frequency, dense syncopation, polyphonic extraction (RATM, Eb)' },
    { query: 'All About That Bass',    stresses: 'sparse pop bass, generous rests — should sit near monophonic ceiling (Trainor)' },
    { query: 'Another One Bites',      stresses: 'iconic single-note motif, clear mute gaps, A2/E2/G2 (Queen — sparse-clean reference)' },
    { query: 'a-ha',                   stresses: 'a-ha "Take On Me" — drum-machine + synth bass, zero rubato — chart-vs-audio alignment baseline' },
    { query: 'Billie Jean',            stresses: 'LinnDrum-locked tempo, sparse F#2 motif, zero rubato — second drum-machine reference' },
];

// Optional add-on roster — `--extended` to include.
const EXTENDED_ROSTER = [
    { query: 'Around The World',       stresses: 'fast same-pitch sibling-repeat stress (RHCP/Flea, sixteenth-note runs)' },
    { query: 'Hysteria',               stresses: 'distorted/effected bass, heavy harmonics, polyphonic muddle (Muse)' },
    { query: 'Schism',                 stresses: 'Drop D + sustained dense passages, sustain bleed in heavy context (Tool)' },
    { query: 'Killing in the Name',    stresses: 'Drop D + heavy mix, busy-band YIN extraction (RATM)' },
];

const args = process.argv.slice(2);
function getArg(n, d) { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; }
function getFlag(n) { return args.includes(`--${n}`); }

const FORCE = getFlag('force');
const REUSE = getFlag('reuse');
const EXT = getFlag('extended');
const BAND_PASS = getFlag('band-pass');
const SONGS_ARG = getArg('songs', null);
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'song-ceiling');
// Band-pass variant lives in <stem>.bp.ceiling.json so a roster run with
// --band-pass doesn't overwrite the unfiltered baseline.
const VARIANT_SUFFIX = BAND_PASS ? '.bp' : '';

const roster = SONGS_ARG
    ? SONGS_ARG.split(',').map(q => ({ query: q.trim(), stresses: '(custom)' }))
    : (EXT ? [...DEFAULT_ROSTER, ...EXTENDED_ROSTER] : DEFAULT_ROSTER);

const currentCommit = (() => {
    try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); }
    catch { return null; }
})();

const indexPath = path.join(FIXTURE_DIR, '_query_index.json');

function loadIndex() {
    if (!fs.existsSync(indexPath)) return {};
    try { return JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch { return {}; }
}

function saveIndex(idx) {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    fs.writeFileSync(indexPath, JSON.stringify(idx, null, 2));
}

function indexQuery(query, stem) {
    const idx = loadIndex();
    idx[query.toLowerCase()] = stem;
    saveIndex(idx);
}

function readCeilingJson(stem) {
    const f = path.join(FIXTURE_DIR, `${stem}${VARIANT_SUFFIX}.ceiling.json`);
    if (!fs.existsSync(f)) return null;
    try { return { stem, ...JSON.parse(fs.readFileSync(f, 'utf8')) }; }
    catch { return null; }
}

function findCachedFor(query) {
    const idx = loadIndex();
    const stem = idx[query.toLowerCase()];
    if (stem) {
        const r = readCeilingJson(stem);
        if (r) return r;
    }
    // Fallback: fuzzy slug containment (works for Mexico, Stand by Me, etc.
    // — fails for "Bulls on Parade" → "ragebulls_m", which is why we maintain
    //   the index above for subsequent runs).
    if (!fs.existsSync(FIXTURE_DIR)) return null;
    const slug = query.toLowerCase().replace(/[^a-z0-9]/g, '');
    const wantSuffix = `${VARIANT_SUFFIX}.ceiling.json`;
    for (const f of fs.readdirSync(FIXTURE_DIR)) {
        if (!f.endsWith(wantSuffix)) continue;
        // Skip baseline files when looking for band-pass variants and vice
        // versa. A bare ".ceiling.json" matches both endsWith checks.
        if (!BAND_PASS && f.endsWith('.bp.ceiling.json')) continue;
        const s = f.replace(new RegExp(`${VARIANT_SUFFIX.replace('.', '\\.')}\\.ceiling\\.json$`), '');
        if (s.toLowerCase().replace(/[^a-z0-9]/g, '').includes(slug)) {
            const r = readCeilingJson(s);
            if (r) return r;
        }
    }
    return null;
}

function shouldReuse(cached) {
    if (!cached) return false;
    if (FORCE) return false;
    if (REUSE) return true;
    return cached.pipelineCommit === currentCommit;
}

function runSongCeiling(query, filenameHint) {
    const cmd = [path.join(__dirname, 'song-ceiling.js'), '--song', query];
    if (filenameHint) cmd.push('--filename-hint', filenameHint);
    if (BAND_PASS) cmd.push('--band-pass');
    const r = spawnSync('node', cmd, { encoding: 'utf8' });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    if (r.status !== 0) throw new Error(`song-ceiling.js exited ${r.status}`);
    const m = /written:\s+(\S+\.ceiling\.json)/.exec(r.stdout || '');
    if (!m) throw new Error('no ceiling JSON path in song-ceiling.js output');
    const full = path.resolve(process.cwd(), m[1]);
    const data = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (data.stem) indexQuery(query, data.stem);
    return { stem: data.stem, ...data };
}

function rateLabel(p) {
    if (p >= 90) return 'friendly';
    if (p >= 75) return 'moderate';
    if (p >= 60) return 'hard';
    return 'arch-limit';
}

function pad(s, w) { s = String(s); return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length); }
function padR(s, w) { s = String(s); return s.length >= w ? s.slice(0, w) : ' '.repeat(w - s.length) + s; }
function fmtPct(n) { return `${n.toFixed(1)}%`; }

(async () => {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    const rows = [];
    for (let i = 0; i < roster.length; i++) {
        const { query, stresses, filenameHint } = roster[i];
        console.log(`\n[${i + 1}/${roster.length}] ${query}`);
        console.log(`  stress: ${stresses}`);
        const cached = findCachedFor(query);
        let result;
        if (shouldReuse(cached)) {
            console.log(`  reuse: ${cached.stem} @ ${cached.pipelineCommit} (${cached.measuredAt})`);
            result = cached;
        } else {
            try { result = runSongCeiling(query, filenameHint); }
            catch (e) {
                console.error(`  FAILED: ${e.message}`);
                rows.push({ query, stresses, error: e.message });
                continue;
            }
        }
        rows.push({ query, stresses, ...result });
    }

    const ok = rows.filter(r => !r.error);
    const sorted = [...ok].sort((a, b) => b.ceilingPct - a.ceilingPct);

    console.log('\n═══ Pipeline ceiling roster ═══');
    console.log(`Pipeline @ ${currentCommit || '(unknown)'}, ${new Date().toISOString()}` +
                (BAND_PASS ? '  [BAND-PASS 30-250 Hz]' : '  [baseline]') + '\n');

    const widths = { stem: 38, ceil: 8, hits: 9, wp: 8, sl: 8, sha: 9, rate: 11 };
    console.log(
        pad('Song', widths.stem) +
        padR('Ceiling', widths.ceil) +
        padR('Hits', widths.hits) +
        padR('WrongP', widths.wp) +
        padR('Silent', widths.sl) +
        padR('SHA', widths.sha) +
        '  ' + pad('Rating', widths.rate)
    );
    console.log('-'.repeat(widths.stem + widths.ceil + widths.hits + widths.wp + widths.sl + widths.sha + 2 + widths.rate));
    for (const r of sorted) {
        const t = r.total || 1;
        const wp = r.buckets?.USER_WRONG_PITCH?.count || 0;
        const sl = r.buckets?.USER_SILENT?.count || 0;
        const stale = r.pipelineCommit !== currentCommit ? '*' : '';
        console.log(
            pad(r.stem || r.query, widths.stem) +
            padR(fmtPct(r.ceilingPct), widths.ceil) +
            padR(`${r.score}/${r.total}`, widths.hits) +
            padR(fmtPct((wp / t) * 100), widths.wp) +
            padR(fmtPct((sl / t) * 100), widths.sl) +
            padR((r.pipelineCommit || '?') + stale, widths.sha) +
            '  ' + pad(rateLabel(r.ceilingPct), widths.rate)
        );
    }
    if (sorted.some(r => r.pipelineCommit !== currentCommit)) {
        console.log(`\n* = measured at a different pipeline commit — re-run with --force to refresh`);
    }
    const failed = rows.filter(r => r.error);
    if (failed.length) {
        console.log(`\nFailed (${failed.length}):`);
        for (const r of failed) console.log(`  ${r.query}: ${r.error}`);
    }

    if (sorted.length >= 2) {
        const top = sorted[0], bot = sorted[sorted.length - 1];
        console.log(
            `\nSpread: ${top.stem || top.query} ${fmtPct(top.ceilingPct)} → ` +
            `${bot.stem || bot.query} ${fmtPct(bot.ceilingPct)} ` +
            `(${(top.ceilingPct - bot.ceilingPct).toFixed(1)}pp gap)`
        );
    }

    const rosterPath = path.join(FIXTURE_DIR, `_roster${VARIANT_SUFFIX}.json`);
    fs.writeFileSync(rosterPath, JSON.stringify({
        variant: BAND_PASS ? 'band-pass-30-250' : 'baseline',
        measuredAt: new Date().toISOString(),
        pipelineCommit: currentCommit,
        rows: sorted.map(r => ({
            query: r.query,
            stresses: r.stresses,
            stem: r.stem,
            score: r.score,
            total: r.total,
            ceilingPct: r.ceilingPct,
            durationSec: r.durationSec,
            chartNoteCount: r.chartNoteCount,
            pipelineCommit: r.pipelineCommit,
            measuredAt: r.measuredAt,
            buckets: r.buckets,
        })),
        failed: failed.map(r => ({ query: r.query, error: r.error })),
    }, null, 2));
    console.log(`\nwritten: ${path.relative(process.cwd(), rosterPath)}`);
})().catch(e => { console.error(e); process.exit(1); });

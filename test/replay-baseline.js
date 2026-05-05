#!/usr/bin/env node
/**
 * Replay baseline harness — runs recorded WAV fixtures through the
 * detection pipeline via puppeteer (headless Chrome) and reports
 * per-fixture hit rates.
 *
 * The host slopsmith server must be running (port 8088 by default)
 * and serving the note_detect plugin from this checkout. Fixtures
 * are discovered via `/api/plugins/note_detect/fixtures` (the route
 * added in routes.py) and replayed via `window.noteDetect.testInjectWav`
 * (added in screen.js Unit H1).
 *
 * Usage:
 *   node test/replay-baseline.js
 *   node test/replay-baseline.js --fixture-glob 'gasoline*'
 *   node test/replay-baseline.js --headed
 *   node test/replay-baseline.js --url http://localhost:8088
 *
 * Output:
 *   Console table of per-fixture hit/miss/detection/precision.
 *   Combined totals at the bottom.
 *   JSON dump under test/replay-results/<timestamp>.json so a
 *   subsequent run can diff against it.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const args = process.argv.slice(2);
function getArg(name, defaultVal) {
    const idx = args.indexOf(`--${name}`);
    if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
    return defaultVal;
}
const SLOPSMITH_URL = getArg('url', process.env.SLOPSMITH_URL || 'http://localhost:8088');
const FIXTURE_GLOB = getArg('fixture-glob', '*');
const HEADED = args.includes('--headed');
// Fixtures the server flagged as `excluded: true` (tuning mismatch
// etc.) are skipped by default. --include-excluded opts in.
const INCLUDE_EXCLUDED = args.includes('--include-excluded');
// Per-replay timeout. Fixtures are full-song recordings (2-4 minutes
// at 1× playback) and testInjectWav waits playback + drain + miss
// sweep, so the puppeteer protocol call routinely exceeds the
// default 180s. 10 minutes covers the longest expected fixture
// with headroom.
const TIMEOUT_MS = 600_000;

function globToRegex(pattern) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
}

async function discoverFixtures() {
    const res = await fetch(`${SLOPSMITH_URL}/api/plugins/note_detect/fixtures`);
    if (!res.ok) {
        throw new Error(`fixture discovery failed: HTTP ${res.status}`);
    }
    const data = await res.json();
    const re = globToRegex(FIXTURE_GLOB);
    let all = (data.fixtures || []).filter(f => re.test(f.name));
    if (!INCLUDE_EXCLUDED) {
        const before = all.length;
        all = all.filter(f => !f.excluded);
        const skipped = before - all.length;
        if (skipped > 0) {
            console.log(`(skipped ${skipped} tuning-mismatched fixture${skipped === 1 ? '' : 's'} — pass --include-excluded to run them anyway)`);
        }
    }
    return all;
}

// Load chart notes from the fixture's dump.json sidecar. The dump
// captured the original recording's matched chart notes, which is
// the ground truth we want the matcher to score against. Returns
// an array of { s, f, t } the harness passes to testInjectWav so
// the matcher has something to match against — slopsmith doesn't
// auto-load songs in headless replay.
function loadFixtureContext(fixturePath) {
    const dumpPath = fixturePath.replace(/\.wav$/, '.dump.json');
    if (!fs.existsSync(dumpPath)) return null;
    let dump;
    try {
        dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
    } catch (e) {
        return null;
    }
    const noteResults = Array.isArray(dump.noteResults) ? dump.noteResults : [];
    if (noteResults.length === 0) return null;
    const seen = new Set();
    const notes = [];
    for (const r of noteResults) {
        if (!r || typeof r.chartT !== 'number') continue;
        if (typeof r.s !== 'number' || typeof r.f !== 'number') continue;
        const key = `${r.s}|${r.f}|${r.chartT.toFixed(3)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        notes.push({ s: r.s, f: r.f, t: r.chartT });
    }
    notes.sort((a, b) => a.t - b.t);
    const settings = dump.settings || {};
    return {
        chartNotes: notes,
        arrangement: settings.arrangement || null,
        tuning: Array.isArray(settings.tuning) ? settings.tuning : null,
        capo: Number.isFinite(settings.capo) ? settings.capo : 0,
    };
}

async function runOne(page, fixture) {
    const wavUrl = `/api/plugins/note_detect/fixtures/${encodeURIComponent(fixture.name)}`;
    const fixturePath = path.join(__dirname, 'fixtures', fixture.name);
    const ctx = loadFixtureContext(fixturePath);
    if (!ctx || !ctx.chartNotes || ctx.chartNotes.length === 0) {
        throw new Error(`no chart notes — dump.json sidecar missing or empty for ${fixture.name}`);
    }
    // For bass fixtures, default to HPS — YIN's octave-down bias on
    // low-frequency bass strings produces near-octave 199¢ hits that
    // the wide threshold barely passes. HPS scores harmonic stacks
    // and doesn't share that bias. Override via REPLAY_METHOD env.
    const method = process.env.REPLAY_METHOD
        || (ctx.arrangement === 'bass' ? 'hps' : 'yin');
    return await page.evaluate(async (url, chartStart, notes, arrangement, tuning, capo, m) => {
        if (!window.noteDetect || typeof window.noteDetect.testInjectWav !== 'function') {
            throw new Error('window.noteDetect.testInjectWav unavailable — plugin not loaded?');
        }
        if (window.noteDetect.isEnabled()) {
            window.noteDetect.disable({ silent: true });
            await new Promise(r => setTimeout(r, 100));
        }
        return await window.noteDetect.testInjectWav(url, {
            chartStartTimeSec: chartStart,
            chartNotes: notes,
            arrangement,
            tuning,
            capo,
            method: m,
        });
    }, wavUrl, fixture.chartStartTime || 0, ctx.chartNotes, ctx.arrangement, ctx.tuning, ctx.capo, method);
}

function fmtPct(n) {
    if (n == null || !Number.isFinite(n)) return '   —';
    return `${(n * 100).toFixed(1)}%`.padStart(6);
}

function fmtCount(n) {
    return String(n).padStart(4);
}

(async () => {
    const fixtures = await discoverFixtures();
    if (fixtures.length === 0) {
        console.error(`No fixtures matched ${FIXTURE_GLOB} at ${SLOPSMITH_URL}/api/plugins/note_detect/fixtures`);
        process.exit(1);
    }
    console.log(`Discovered ${fixtures.length} fixture(s) at ${SLOPSMITH_URL}`);
    fixtures.forEach(f => console.log(`  ${f.name}  chartStart=${(f.chartStartTime || 0).toFixed(2)}s`));
    console.log();

    const browser = await puppeteer.launch({
        headless: HEADED ? false : 'new',
        // protocolTimeout is the upper bound on a single CDP call.
        // page.evaluate(testInjectWav) is one CDP call that runs for
        // the entire WAV's duration, so this MUST exceed the longest
        // fixture's playback time + drain + sweep tail.
        protocolTimeout: TIMEOUT_MS,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required'],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);

    // Surface in-browser errors to the host console so harness
    // failures aren't silent.
    page.on('console', (msg) => {
        const t = msg.type();
        if (t === 'error' || t === 'warning') {
            console.warn(`[browser:${t}]`, msg.text());
        }
    });
    page.on('pageerror', (err) => console.error('[browser:pageerror]', err.message));

    await page.goto(SLOPSMITH_URL, { waitUntil: 'networkidle2', timeout: TIMEOUT_MS });
    // Give plugins a moment to register on the page.
    await page.waitForFunction(
        () => !!(window.noteDetect && window.noteDetect.testInjectWav),
        { timeout: 30_000 },
    ).catch(() => {
        throw new Error('window.noteDetect.testInjectWav never appeared — plugin failed to load');
    });

    const rows = [];
    for (const fixture of fixtures) {
        process.stdout.write(`Replaying ${fixture.name} ... `);
        try {
            const t0 = Date.now();
            const result = await runOne(page, fixture);
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            const { summary, noteResults } = result;
            rows.push({
                name: fixture.name, ok: true,
                summary, noteResults, elapsed,
            });
            process.stdout.write(`${summary.hits}/${summary.total} (${(summary.detection * 100).toFixed(1)}%) in ${elapsed}s\n`);
        } catch (e) {
            rows.push({ name: fixture.name, ok: false, error: String(e) });
            process.stdout.write(`FAILED: ${e.message}\n`);
        }
    }

    await browser.close();

    // Summary table
    console.log();
    console.log('=== Replay results ===');
    console.log('  hits  miss total   detect    prec   onsets   drift  fixture');
    let totalHits = 0, totalMisses = 0, totalNotes = 0, totalOnsets = 0;
    for (const r of rows) {
        if (!r.ok) {
            console.log(`     —    —    —      —      —       —       —  ${r.name}  (${r.error})`);
            continue;
        }
        const s = r.summary;
        totalHits += s.hits;
        totalMisses += s.misses;
        totalNotes += s.total;
        totalOnsets += s.onsetCount || 0;
        const drift = (s.driftEstimateMs ?? 0).toFixed(0).padStart(6);
        console.log(`  ${fmtCount(s.hits)} ${fmtCount(s.misses)} ${fmtCount(s.total)}  ${fmtPct(s.detection)}  ${fmtPct(s.precision)}  ${fmtCount(s.onsetCount || 0)}  ${drift}  ${r.name}`);
    }
    console.log('  ----  ---- -----  ------  ------  ------  ------');
    const overallDetection = totalNotes > 0 ? totalHits / totalNotes : null;
    console.log(`  ${fmtCount(totalHits)} ${fmtCount(totalMisses)} ${fmtCount(totalNotes)}  ${fmtPct(overallDetection)}      —  ${fmtCount(totalOnsets)}      —  TOTAL`);

    // Persist results so subsequent runs can diff.
    const outDir = path.join(__dirname, 'replay-results');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outFile = path.join(outDir, `${stamp}.json`);
    fs.writeFileSync(outFile, JSON.stringify({
        url: SLOPSMITH_URL,
        timestamp: stamp,
        glob: FIXTURE_GLOB,
        rows,
        totals: {
            hits: totalHits,
            misses: totalMisses,
            total: totalNotes,
            detection: overallDetection,
            onsetCount: totalOnsets,
        },
    }, null, 2));
    console.log(`\nResults written to ${outFile}`);

    process.exit(0);
})().catch((err) => {
    console.error('Harness error:', err);
    process.exit(1);
});

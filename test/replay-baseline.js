#!/usr/bin/env node
/**
 * Multi-take WAV replay baseline.
 *
 * Discovers `test/fixtures/*.wav`, reads each's `.json` sidecar for
 * `chartStartTime`, loads slopsmith once in headless Chrome, and replays each
 * WAV through the detection pipeline in a single browser session. Reports per-
 * take hit rates and a combined total so a single bad physical take doesn't
 * poison the baseline.
 *
 * Usage:
 *   node test/replay-baseline.js
 *   node test/replay-baseline.js --song "Mexico" --arrangement 3
 *   node test/replay-baseline.js --fixture-glob "mexico-bass-take*.wav"
 *   node test/replay-baseline.js --headed
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const SLOPSMITH_URL = process.env.SLOPSMITH_URL || 'http://localhost:8088';
const DEFAULT_FIXTURES_DIR = path.join(__dirname, 'fixtures');
const TIMEOUT_MS = 120_000;

const args = process.argv.slice(2);
function getArg(name, defaultVal) {
    const idx = args.indexOf(`--${name}`);
    if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
    return defaultVal;
}
const SONG_QUERY = getArg('song', 'Mexico');
const ARRANGEMENT = getArg('arrangement', null);
const FIXTURE_GLOB = getArg('fixture-glob', 'mexico-bass-take*.wav');
const FIXTURES_DIR = getArg('fixture-dir', DEFAULT_FIXTURES_DIR);
const HEADLESS = !args.includes('--headed');

function discoverFixtures() {
    const pattern = FIXTURE_GLOB.replace(/\./g, '\\.').replace(/\*/g, '.*');
    const re = new RegExp(`^${pattern}$`);
    const files = fs.readdirSync(FIXTURES_DIR)
        .filter(f => re.test(f) && f.endsWith('.wav'))
        .sort();
    return files.map(f => {
        const wavPath = path.join(FIXTURES_DIR, f);
        const jsonPath = wavPath.replace(/\.wav$/, '.json');
        let chartStartTime = 0;
        if (fs.existsSync(jsonPath)) {
            try {
                chartStartTime = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).chartStartTime ?? 0;
            } catch (e) { /* ignore */ }
        }
        return { name: f, path: wavPath, chartStartTime };
    });
}

async function uploadWav(page, wavPath) {
    const data = fs.readFileSync(wavPath);
    const name = path.basename(wavPath);
    await page.evaluate(async (n, b64) => {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'audio/wav' });
        const form = new FormData();
        form.append('file', blob, n);
        await fetch('/api/plugins/note_detect/recording', { method: 'POST', body: form });
    }, name, data.toString('base64'));
    return name;
}

async function runReplay(page, serverName, chartStartTime) {
    return page.evaluate(async (name, wavChartStart) => {
        const realGetTime = highway.getTime.bind(highway);
        const realGetAvOffset = highway.getAvOffset ? highway.getAvOffset.bind(highway) : () => 0;
        window._ndTestWavPlaybackStartAudio = undefined;
        highway.getTime = () => {
            const anchor = window._ndTestWavPlaybackStartAudio;
            if (anchor === undefined) return realGetTime();
            const elapsed = _ndAudioCtx.currentTime - anchor;
            return wavChartStart + elapsed;
        };
        highway.getAvOffset = () => 0;

        _ndResetScoring();
        _ndEnabled = true;
        window._ndCaptureAllEvents = true;
        window._ndAllEvents = [];
        // Clear frame log so we only see detections from this replay.
        if (typeof _ndFrameLog !== 'undefined') _ndFrameLog.length = 0;

        const wavUrl = `/api/plugins/note_detect/recording/${name}`;
        const summary = await _ndInjectTestWav(wavUrl);

        highway.getTime = realGetTime;
        highway.getAvOffset = realGetAvOffset;
        const events = window._ndAllEvents || [];
        window._ndCaptureAllEvents = false;

        // Stable detections — every YIN-stable frame, regardless of matching
        // window. This is what lets us see residuals >300ms that _ndAllEvents
        // misses (because _ndMatchNotes filters to candidateNotes in-window).
        const stableFrames = (typeof _ndFrameLog !== 'undefined' ? _ndFrameLog : [])
            .filter(f => f.type === 'stable')
            .map(f => ({
                scoreT: parseFloat(f.scoreT),
                midi: f.midi,
                level: parseFloat(f.level),
            }));
        const chartNotes = (highway.getNotes() || []).map(n => ({
            t: n.t,
            s: n.s,
            f: n.f,
            midi: _ndMidiFromStringFret(n.s, n.f) + (_ndPitchOffset || 0),
        }));
        return { summary, events, stableFrames, chartNotes, wavChartStart };
    }, serverName, chartStartTime);
}

// Wide-window residual analysis — for every stable YIN detection, find the
// nearest same-pitch chart note within searchMs and record the residual. Unlike
// analyzeResiduals (which is constrained to candidateNotes in-window), this
// surfaces the full dispersion, including detections that landed far outside
// the matching window.
function analyzeStableResiduals(stableFrames, chartNotes, centsTolerance, searchMs, wavChartStart, wavDurSec) {
    if (!stableFrames.length || !chartNotes.length) return null;

    // Only consider chart notes that fall within the WAV's time window,
    // otherwise denominators are wrong for "miss" bookkeeping.
    const wavEnd = wavChartStart + (wavDurSec || 60);
    const inWindowNotes = chartNotes.filter(n => n.t >= wavChartStart && n.t <= wavEnd);

    const centsPerSemitone = 100;
    const searchSec = searchMs / 1000;

    const residuals = [];
    for (const sf of stableFrames) {
        let best = null;
        let bestAbsDt = Infinity;
        for (const cn of chartNotes) {
            if (Math.abs(cn.t - sf.scoreT) > searchSec) continue;
            const centsErr = (sf.midi - cn.midi) * centsPerSemitone;
            if (Math.abs(centsErr) > centsTolerance) continue;
            const dt = sf.scoreT - cn.t;
            if (Math.abs(dt) < bestAbsDt) {
                best = cn;
                bestAbsDt = Math.abs(dt);
                sf._matchDt = dt;
                sf._matchChartT = cn.t;
                sf._centsErr = centsErr;
            }
        }
        if (best) residuals.push({
            scoreT: sf.scoreT, chartT: best.t, dtMs: (sf.scoreT - best.t) * 1000,
            midi: sf.midi, centsErr: sf._centsErr,
        });
    }

    if (!residuals.length) return { total: stableFrames.length, matched: 0, inWindowNotes: inWindowNotes.length };

    const dts = residuals.map(r => r.dtMs).sort((a, b) => a - b);
    const pct = p => dts[Math.floor((dts.length - 1) * p)];
    const median = pct(0.5);
    const mean = dts.reduce((a, b) => a + b, 0) / dts.length;

    // Histogram — 100ms bins from -1000 to +1000
    const bins = new Map();
    for (const dt of dts) {
        const bin = Math.floor(dt / 100) * 100;
        bins.set(bin, (bins.get(bin) || 0) + 1);
    }
    const sortedBins = [...bins.entries()].sort((a, b) => a[0] - b[0]);

    return {
        total: stableFrames.length,
        matched: residuals.length,
        unmatched: stableFrames.length - residuals.length,
        inWindowNotes: inWindowNotes.length,
        dtP05: pct(0.05), dtP10: pct(0.10), dtP25: pct(0.25),
        dtP50: median,
        dtP75: pct(0.75), dtP90: pct(0.90), dtP95: pct(0.95),
        dtMean: mean,
        histogram: sortedBins,
    };
}

// Offline residual analysis — given closest-chart-note dtMs per detection
// event, find the shift (constant offset) that maximizes "within-window"
// events, and surface drift by bucketing events by chart time.
function analyzeResiduals(events, earlyWindowMs, lateWindowMs, centsTolerance) {
    if (events.length === 0) return null;

    // Only include events where the detected pitch is plausibly correct
    // (within the cents tolerance). Timing-only misses.
    const pitchOk = events.filter(e => Math.abs(e.centsErr) <= centsTolerance);

    // Sweep constant offset from -500ms to +500ms in 5ms steps.
    // "shifted" dt = e.dtMs - offset; hit requires shifted in [-early, +late].
    let bestOffset = 0, bestHits = 0;
    for (let offset = -500; offset <= 500; offset += 5) {
        let hits = 0;
        for (const e of pitchOk) {
            const shifted = e.dtMs - offset;
            if (shifted >= -earlyWindowMs && shifted <= lateWindowMs) hits++;
        }
        if (hits > bestHits) { bestHits = hits; bestOffset = offset; }
    }

    // Raw dtMs distribution (before any shift)
    const dts = pitchOk.map(e => e.dtMs).sort((a, b) => a - b);
    const pct = p => dts.length ? dts[Math.floor((dts.length - 1) * p)] : NaN;

    // Drift: split pitch-correct events into 4 quartile buckets by chartT,
    // compute median dtMs for each. If it slides monotonically, that's drift.
    const byChart = [...pitchOk].sort((a, b) => a.chartT - b.chartT);
    const quart = [];
    const n = byChart.length;
    for (let q = 0; q < 4; q++) {
        const lo = Math.floor(n * q / 4);
        const hi = Math.floor(n * (q + 1) / 4);
        const slice = byChart.slice(lo, hi).map(e => e.dtMs).sort((a, b) => a - b);
        const med = slice.length ? slice[Math.floor(slice.length / 2)] : NaN;
        const chartLo = byChart[lo]?.chartT ?? NaN;
        const chartHi = byChart[Math.max(lo, hi - 1)]?.chartT ?? NaN;
        quart.push({ q: q + 1, n: slice.length, medDt: med, chartLo, chartHi });
    }

    return {
        total: events.length,
        pitchOk: pitchOk.length,
        dtP10: pct(0.10), dtP50: pct(0.50), dtP90: pct(0.90),
        bestOffset, bestHits,
        bestHitRate: pitchOk.length > 0 ? bestHits / pitchOk.length : 0,
        drift: quart,
    };
}

function formatRow(label, hits, total) {
    const pct = total > 0 ? (hits / total * 100).toFixed(1) : '0.0';
    return `  ${label.padEnd(30)} ${String(hits).padStart(4)}/${String(total).padStart(4)}  (${pct.padStart(5)}%)`;
}

async function main() {
    const fixtures = discoverFixtures();
    if (fixtures.length === 0) {
        console.error(`No fixtures matched ${FIXTURE_GLOB} in ${FIXTURES_DIR}`);
        process.exit(1);
    }

    console.log('=== Multi-Take WAV Replay Baseline ===');
    console.log(`URL: ${SLOPSMITH_URL}`);
    console.log(`Song query: ${SONG_QUERY}`);
    console.log(`Fixtures (${fixtures.length}):`);
    for (const f of fixtures) {
        console.log(`  ${f.name}  (chartStartTime=${f.chartStartTime.toFixed(3)}s)`);
    }

    const browser = await puppeteer.launch({
        headless: HEADLESS ? 'new' : false,
        protocolTimeout: 600_000,
        args: [
            '--autoplay-policy=no-user-gesture-required',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--no-sandbox',
        ],
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);
    page.on('console', msg => {
        const t = msg.text();
        if (t.includes('[nd-test]') || t.includes('[note_detect]')) console.log(`  [browser] ${t}`);
    });
    page.on('pageerror', err => console.error('  [page error]', err.message));

    const results = [];

    try {
        console.log('\n1. Loading slopsmith...');
        await page.goto(SLOPSMITH_URL, { waitUntil: 'networkidle2' });
        await page.waitForFunction(() => window.slopsmith, { timeout: 10_000 });

        console.log('\n2. Finding song...');
        const library = await page.evaluate(async q => {
            const r = await fetch(`/api/library?q=${encodeURIComponent(q)}&page=0&size=10&sort=`);
            return r.json();
        }, SONG_QUERY);
        if (!library.songs?.length) throw new Error(`No songs match "${SONG_QUERY}"`);

        const song = library.songs[0];
        let arrIdx = ARRANGEMENT !== null ? parseInt(ARRANGEMENT, 10) : null;
        if (arrIdx === null) {
            const bassArr = song.arrangements.find(a => /bass/i.test(a.name));
            arrIdx = bassArr ? bassArr.index : 0;
        }
        const arrName = song.arrangements.find(a => a.index === arrIdx)?.name || `index ${arrIdx}`;
        console.log(`   "${song.title}" — ${arrName}`);

        console.log('\n3. Loading song into highway...');
        await page.evaluate(async (filename, arr) => { await playSong(filename, arr); }, song.filename, arrIdx);
        await page.waitForFunction(() => window.highway?.getNotes?.()?.length > 0, { timeout: 30_000 });
        const noteCount = await page.evaluate(() => highway.getNotes().length);
        console.log(`   ${noteCount} notes`);

        await page.evaluate(() => {
            const audio = document.getElementById('audio');
            if (audio) { audio.pause(); audio.volume = 0; }
        });

        console.log('\n4. Enabling note detection...');
        await page.evaluate(() => {
            _ndEnabled = true;
            _ndPitchOffset = 0;
            _ndDetectionLatencySec = 0.350;
            const info = highway.getSongInfo();
            if (info && info.arrangement) _ndSetArrangement(info.arrangement);
            if (info && Array.isArray(info.tuning)) _ndTuningOffsets = info.tuning;
            if (info && info.capo !== undefined) _ndCapo = info.capo;
        });

        // Matching tolerances — read once from the runtime so the offline
        // analyzer uses the same thresholds as live scoring.
        const tols = await page.evaluate(() => ({
            earlyMs: (_ndTimingTolerance ?? 0.150) * 1000,
            lateMs: (_ndTimingTolerance ?? 0.150) * 2 * 1000,
            cents: _ndPitchTolerance ?? 50,
        }));

        for (let i = 0; i < fixtures.length; i++) {
            const f = fixtures[i];
            console.log(`\n5.${i + 1} Replay: ${f.name}`);
            const serverName = await uploadWav(page, f.path);
            const { summary, events, stableFrames, chartNotes, wavChartStart } = await runReplay(page, serverName, f.chartStartTime);
            if (!summary) {
                console.log('   (no summary — possibly zero chart notes in window)');
                results.push({ fixture: f.name, hits: 0, total: 0, pitchMisses: 0, timingMisses: 0, events: [], stableFrames: [], chartNotes: [], wavChartStart: f.chartStartTime });
                continue;
            }
            console.log(`   ${summary.hits}/${summary.total} (${summary.hitRate}%)  pitchMiss=${summary.pitchMisses} timingMiss=${summary.timingMisses}  events=${events.length} stable=${stableFrames.length}`);
            results.push({
                fixture: f.name,
                hits: summary.hits,
                total: summary.total,
                pitchMisses: summary.pitchMisses,
                timingMisses: summary.timingMisses,
                events,
                stableFrames,
                chartNotes,
                wavChartStart,
            });
        }

        console.log('\n=== Per-take ===');
        let totalHits = 0, totalNotes = 0, totalPitchMiss = 0, totalTimingMiss = 0;
        for (const r of results) {
            console.log(formatRow(r.fixture, r.hits, r.total));
            totalHits += r.hits;
            totalNotes += r.total;
            totalPitchMiss += r.pitchMisses;
            totalTimingMiss += r.timingMisses;
        }

        console.log('\n=== Combined ===');
        console.log(formatRow('ALL TAKES', totalHits, totalNotes));
        console.log(`  pitch misses:  ${totalPitchMiss}`);
        console.log(`  timing misses: ${totalTimingMiss}`);

        if (results.length > 1) {
            const rates = results.filter(r => r.total > 0).map(r => r.hits / r.total * 100);
            if (rates.length > 0) {
                const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
                const variance = rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length;
                const stddev = Math.sqrt(variance);
                console.log(`\n  per-take hit rate: mean=${mean.toFixed(1)}%  stddev=${stddev.toFixed(1)}pp  n=${rates.length}`);
            }
        }

        // Offline residual analysis — find the single constant offset that
        // would maximize hits across all events. If one offset recovers most
        // of the timing misses, the fix is a replay-specific latency tuning.
        // If the best offset is roughly zero or recovers few hits, the issue
        // isn't a constant shift (likely drift or non-detection).
        console.log(`\n=== Residual analysis  (early=${tols.earlyMs}ms late=${tols.lateMs}ms cents=${tols.cents}) ===`);
        const allEvents = results.flatMap(r => r.events);
        const analysis = analyzeResiduals(allEvents, tols.earlyMs, tols.lateMs, tols.cents);
        if (!analysis) {
            console.log('  (no events captured)');
        } else {
            console.log(`  events captured: ${analysis.total}`);
            console.log(`  pitch-ok events: ${analysis.pitchOk}  (would-hit if timing alone were right)`);
            console.log(`  raw dtMs p10/p50/p90: ${analysis.dtP10?.toFixed(0)} / ${analysis.dtP50?.toFixed(0)} / ${analysis.dtP90?.toFixed(0)} ms`);
            console.log(`  best constant offset: ${analysis.bestOffset} ms -> ${analysis.bestHits}/${analysis.pitchOk} (${(analysis.bestHitRate * 100).toFixed(1)}%)`);
            console.log(`  drift (median dtMs per chart-time quartile):`);
            for (const q of analysis.drift) {
                const lo = isFinite(q.chartLo) ? q.chartLo.toFixed(1) : '—';
                const hi = isFinite(q.chartHi) ? q.chartHi.toFixed(1) : '—';
                console.log(`    Q${q.q} [${lo}s..${hi}s]  n=${q.n}  medDt=${isFinite(q.medDt) ? q.medDt.toFixed(0) + 'ms' : '—'}`);
            }
            const first = analysis.drift[0]?.medDt;
            const last = analysis.drift[3]?.medDt;
            if (isFinite(first) && isFinite(last)) {
                console.log(`  drift Q1->Q4: ${(last - first).toFixed(0)} ms`);
            }
        }

        // Wide-window residual analysis — every stable YIN detection vs the
        // nearest same-pitch chart note within ±2s. Surfaces detections that
        // fall completely outside the matching window (which analyzeResiduals
        // above cannot see, since _ndAllEvents only captures in-window events).
        console.log(`\n=== Wide-window residuals (±2000ms search, cents=${tols.cents}) ===`);
        for (const r of results) {
            if (!r.stableFrames?.length) { console.log(`  ${r.fixture}: no stable detections`); continue; }
            const wide = analyzeStableResiduals(r.stableFrames, r.chartNotes, tols.cents, 2000, r.wavChartStart, 60);
            if (!wide) { console.log(`  ${r.fixture}: no chart notes in window`); continue; }
            console.log(`  ${r.fixture}:`);
            console.log(`    stable detections: ${wide.total}   matched-to-chart-note: ${wide.matched}   unmatched: ${wide.unmatched}`);
            console.log(`    chart notes in WAV window: ${wide.inWindowNotes}`);
            if (wide.matched > 0) {
                console.log(`    dtMs p05/p10/p25/p50/p75/p90/p95: ${wide.dtP05.toFixed(0)} / ${wide.dtP10.toFixed(0)} / ${wide.dtP25.toFixed(0)} / ${wide.dtP50.toFixed(0)} / ${wide.dtP75.toFixed(0)} / ${wide.dtP90.toFixed(0)} / ${wide.dtP95.toFixed(0)}`);
                console.log(`    dtMs mean: ${wide.dtMean.toFixed(0)}`);
                console.log(`    histogram (100ms bins):`);
                const maxCount = Math.max(...wide.histogram.map(([, c]) => c));
                for (const [bin, count] of wide.histogram) {
                    const bar = '█'.repeat(Math.round(40 * count / maxCount));
                    console.log(`      ${String(bin).padStart(6)}ms  ${String(count).padStart(4)}  ${bar}`);
                }
            }
        }

        // Dump events to disk for further offline analysis.
        const outPath = path.join(__dirname, 'fixtures', 'baseline-events.json');
        fs.writeFileSync(outPath, JSON.stringify({
            generated: new Date().toISOString(),
            tolerances: tols,
            takes: results.map(r => ({
                fixture: r.fixture, hits: r.hits, total: r.total,
                pitchMisses: r.pitchMisses, timingMisses: r.timingMisses,
                events: r.events,
            })),
        }, null, 2));
        console.log(`\n  events written to ${path.relative(process.cwd(), outPath)}`);

        process.exitCode = totalNotes > 0 && (totalHits / totalNotes) >= 0.5 ? 0 : 1;
    } catch (err) {
        console.error('\nERROR:', err.message);
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
}

main().catch(err => { console.error('Fatal:', err); process.exitCode = 1; });

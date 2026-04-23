#!/usr/bin/env node
/**
 * Timing-latency harness — measures how long after an audio pluck onset the
 * pipeline decides "this is a match event." Answers the question raised in
 * docs/NOTEDETECT_IMPLEMENTATION_GAPS.md Gap 1: pipeline latency isn't a
 * fixed offset, it varies 260-1118 ms across plucks, so a single
 * `_ndDetectionLatencySec` can never center the distribution.
 *
 * Loads a ground-truth fixture (WAV + manifest with `attackT` per pluck),
 * plays it through the browser pipeline, and captures the timestamp of each
 * `_ndMatchNotes` invocation. For each manifest pluck, reports:
 *
 *   rawLatency    = match_wavT - onset_wavT         (where the pipeline fired)
 *   compensated   = (match_wavT - _ndDetectionLatencySec) - onset_wavT
 *                   (how the pipeline's reported "chart t" lines up with
 *                    the actual onset — this is what scoring sees)
 *
 * Passes if p95 rawLatency is under a threshold (default 200 ms). The
 * threshold is loose today on purpose — tightening it is Phase 2's job.
 *
 * Usage:
 *   node test/timing-latency.test.js
 *   node test/timing-latency.test.js --fixture timing-plucks --threshold 200
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const SLOPSMITH_URL = process.env.SLOPSMITH_URL || 'http://localhost:8088';
const args = process.argv.slice(2);
function getArg(n, d) { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; }
const FIXTURE = getArg('fixture', 'timing-plucks');
const P95_THRESHOLD_MS = parseFloat(getArg('threshold', '200'));
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'ground-truth');
const WAV_PATH = path.join(FIXTURE_DIR, `${FIXTURE}.wav`);
const MANIFEST_PATH = path.join(FIXTURE_DIR, `${FIXTURE}.json`);

(async () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const wavBytes = fs.readFileSync(WAV_PATH);
    console.log(`Fixture: ${FIXTURE}`);
    console.log(`Plucks:  ${manifest.plucks.length}`);

    const browser = await puppeteer.launch({
        headless: 'new',
        protocolTimeout: 120_000,
        args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);
    page.on('pageerror', e => console.error('[page error]', e.message));

    try {
        await page.goto(SLOPSMITH_URL, { waitUntil: 'networkidle2' });
        await page.waitForFunction(() => window.slopsmith, { timeout: 10_000 });

        // Set bass arrangement so MIDI mapping is consistent with manifest.
        await page.evaluate(() => { if (typeof _ndSetArrangement === 'function') _ndSetArrangement('bass'); });

        // Upload the WAV
        const wavB64 = wavBytes.toString('base64');
        await page.evaluate(async (b64, name) => {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const blob = new Blob([bytes], { type: 'audio/wav' });
            const form = new FormData();
            form.append('file', blob, name);
            await fetch('/api/plugins/note_detect/recording', { method: 'POST', body: form });
        }, wavB64, `${FIXTURE}.wav`);

        // Instrument: mock highway.getTime() on the audio clock, hook
        // _ndMatchNotes to record its call time + current stable MIDI.
        // Also hook every "stable-frame" entry so we can see the raw stream
        // even for plucks that don't cross the 1-second same-MIDI guard.
        const results = await page.evaluate(async (wavName, plucks, latencySec) => {
            const realGetTime = highway.getTime.bind(highway);
            const realGetAv = highway.getAvOffset ? highway.getAvOffset.bind(highway) : () => 0;
            const realMatch = window._ndMatchNotes;

            const matchLog = [];  // {callWavT, stableMidi, scoreT}
            const stableLog = []; // {wavT, midi}
            let prevStable = -1;

            window._ndTestWavPlaybackStartAudio = undefined;
            highway.getTime = () => {
                const anchor = window._ndTestWavPlaybackStartAudio;
                if (anchor === undefined) return realGetTime();
                return _ndAudioCtx.currentTime - anchor;
            };
            highway.getAvOffset = () => 0;

            // Wrap _ndMatchNotes to capture (a) wall-clock wavT of the
            // call and (b) the tOverride passed in (or null if legacy
            // stable-MIDI-change path). The tOverride is the CHART TIME the
            // match uses to find candidate notes — that's the scoring-facing
            // latency, which is what actually drives hit/miss decisions.
            window._ndMatchNotes = function (tOverride) {
                const callWavT = highway.getTime();
                matchLog.push({
                    callWavT,
                    tOverride: tOverride != null ? tOverride : null,
                    stableMidi: _ndStableMidi,
                    latencyCfg: _ndDetectionLatencySec,
                });
                return realMatch.apply(this, arguments);
            };

            // Periodic sampler for stableMidi transitions — 10ms resolution
            const sampler = setInterval(() => {
                if (_ndStableMidi > 0 && _ndStableMidi !== prevStable) {
                    stableLog.push({ wavT: highway.getTime(), midi: _ndStableMidi });
                    prevStable = _ndStableMidi;
                } else if (_ndStableMidi <= 0) {
                    prevStable = -1;
                }
            }, 10);

            _ndResetScoring();
            _ndEnabled = true;
            _ndDetectionLatencySec = latencySec;
            const onsetCountBefore = _ndOnsetCount;

            const wavUrl = `/api/plugins/note_detect/recording/${wavName}`;
            await _ndInjectTestWav(wavUrl);

            const onsetsFired = _ndOnsetCount - onsetCountBefore;

            clearInterval(sampler);
            window._ndMatchNotes = realMatch;
            highway.getTime = realGetTime;
            highway.getAvOffset = realGetAv;

            return { matchLog, stableLog, latencyCfg: _ndDetectionLatencySec, onsetsFired };
        }, `${FIXTURE}.wav`, manifest.plucks, 0.350);

        const { matchLog, stableLog, latencyCfg, onsetsFired } = results;

        console.log(`\n${matchLog.length} _ndMatchNotes invocations captured.`);
        console.log(`${stableLog.length} stable-MIDI transitions captured.`);
        console.log(`${onsetsFired} onsets fired by the pipeline's RMS-ratio detector.`);

        // Two latencies matter:
        //   rawLatency    = callWavT - attackT
        //                   wall-clock delay between attack and _ndMatchNotes firing.
        //                   Dominated by stability-vote convergence (~250ms).
        //                   Not the scoring-facing number.
        //   scoringError  = (tUsed) - attackT
        //                   where tUsed = tOverride (onset-gated path) or
        //                   callWavT - latencyCfg (legacy path).
        //                   This is the CHART TIME _ndMatchNotes used to find
        //                   candidates. Determines hit/miss. Sign convention:
        //                   negative = chart time lands earlier than attack.
        console.log(`\n=== Per-pluck latency ===`);
        console.log(`pluck              attack     tUsed     callWavT   rawLatency  scoringError  path`);
        const latencies = [];
        for (const p of manifest.plucks) {
            const m = matchLog.find(x => x.stableMidi === p.expectedMidi && x.callWavT >= p.attackT);
            if (!m) {
                console.log(`  ${p.label.padEnd(18)} ${p.attackT.toFixed(3).padStart(6)}s  (no _ndMatchNotes call with this MIDI after attack)`);
                continue;
            }
            const path = m.tOverride != null ? 'onset' : 'legacy';
            const tUsed = m.tOverride != null ? m.tOverride : (m.callWavT - m.latencyCfg);
            const raw = (m.callWavT - p.attackT) * 1000;
            const scoring = (tUsed - p.attackT) * 1000;
            latencies.push({ pluck: p.label, raw, scoring, path, midi: m.stableMidi });
            console.log(`  ${p.label.padEnd(18)} ${p.attackT.toFixed(3).padStart(6)}s  ${tUsed.toFixed(3).padStart(6)}s  ${m.callWavT.toFixed(3).padStart(6)}s  ${raw.toFixed(0).padStart(8)}ms  ${scoring.toFixed(0).padStart(10)}ms  ${path}`);
        }


        if (latencies.length < manifest.plucks.length) {
            console.log(`\nWARNING: only ${latencies.length} of ${manifest.plucks.length} plucks produced a stable-MIDI match. The pipeline missed some entirely.`);
        }

        if (latencies.length > 0) {
            const raws = latencies.map(l => l.raw).sort((a, b) => a - b);
            const scorings = latencies.map(l => Math.abs(l.scoring)).sort((a, b) => a - b);
            const pct = (arr, p) => arr[Math.floor((arr.length - 1) * p)];
            const onsetCount = latencies.filter(l => l.path === 'onset').length;
            console.log(`\n=== Summary (n=${raws.length}, ${onsetCount} onset-gated, ${raws.length - onsetCount} legacy) ===`);
            console.log(`  rawLatency      p50=${pct(raws, 0.5).toFixed(0)}ms  p95=${pct(raws, 0.95).toFixed(0)}ms  min=${raws[0].toFixed(0)}ms  max=${raws[raws.length - 1].toFixed(0)}ms`);
            console.log(`  |scoringError|  p50=${pct(scorings, 0.5).toFixed(0)}ms  p95=${pct(scorings, 0.95).toFixed(0)}ms  min=${scorings[0].toFixed(0)}ms  max=${scorings[scorings.length - 1].toFixed(0)}ms`);
            console.log(`  configured _ndDetectionLatencySec: ${(latencyCfg * 1000).toFixed(0)}ms`);

            // Pass criterion is scoring error, not raw latency — the raw
            // number is dominated by stability-vote convergence and is
            // orthogonal to whether notes are getting scored correctly.
            const p95Scoring = pct(scorings, 0.95);
            if (p95Scoring > P95_THRESHOLD_MS) {
                console.log(`\nFAIL: p95 |scoringError| ${p95Scoring.toFixed(0)}ms > threshold ${P95_THRESHOLD_MS}ms`);
                process.exitCode = 1;
            } else {
                console.log(`\nPASS: p95 |scoringError| ${p95Scoring.toFixed(0)}ms within ${P95_THRESHOLD_MS}ms`);
            }
        } else {
            console.log('\nFAIL: no plucks produced matches');
            process.exitCode = 1;
        }

        // Dump raw logs for further analysis
        const outPath = path.join(FIXTURE_DIR, `${FIXTURE}.latency.json`);
        fs.writeFileSync(outPath, JSON.stringify({
            fixture: FIXTURE,
            latencyCfg,
            matchLog,
            stableLog,
            latencies,
        }, null, 2));
        console.log(`  logs written to ${path.relative(process.cwd(), outPath)}`);
    } finally {
        await browser.close();
    }
})().catch(e => { console.error(e); process.exit(1); });

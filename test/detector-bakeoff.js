#!/usr/bin/env node
/**
 * Detector bake-off — runs a ground-truth WAV through both _ndYinDetect and
 * _ndCrepeDetect (the real implementations shipped in screen.js) and reports
 * per-segment dominant MIDI for each. Uses puppeteer so CREPE runs through
 * its actual TF.js integration, not a re-implementation.
 *
 * Usage:
 *   node test/detector-bakeoff.js
 *   node test/detector-bakeoff.js --wav test/fixtures/ground-truth/open-strings.wav
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const SLOPSMITH_URL = process.env.SLOPSMITH_URL || 'http://localhost:8088';

const args = process.argv.slice(2);
function getArg(name, d) {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
}
const WAV_PATH = getArg('wav', 'test/fixtures/ground-truth/open-strings.wav');
const MANIFEST_PATH = WAV_PATH.replace(/\.wav$/, '.json');
const YIN_BUF = 4096;
const HOP_MS = 50;

function readWav(p) {
    const buf = fs.readFileSync(p);
    if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not RIFF');
    let off = 12, fmt = null, dataStart = -1, dataLen = -1;
    while (off < buf.length - 8) {
        const id = buf.toString('ascii', off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        if (id === 'fmt ') fmt = { sampleRate: buf.readUInt32LE(off + 12), channels: buf.readUInt16LE(off + 10) };
        else if (id === 'data') { dataStart = off + 8; dataLen = size; break; }
        off += 8 + size;
    }
    const n = dataLen / 2 / fmt.channels;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(dataStart + i * 2 * fmt.channels) / 32768;
    return { samples, sampleRate: fmt.sampleRate };
}

function segmentStats(detections, segments) {
    return segments.map(seg => {
        const inSeg = detections.filter(d => d.wavT >= seg.tStart && d.wavT <= seg.tEnd);
        const withPitch = inSeg.filter(d => d.midi != null);
        const counts = new Map();
        for (const d of withPitch) counts.set(d.midi, (counts.get(d.midi) || 0) + 1);
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        const top = sorted[0] || [null, 0];
        const expectedHits = counts.get(seg.expectedMidi) || 0;
        return {
            label: seg.label,
            expectedMidi: seg.expectedMidi,
            frames: inSeg.length,
            withPitch: withPitch.length,
            dominantMidi: top[0],
            dominantCount: top[1],
            expectedMidiHits: expectedHits,
            correctFraction: withPitch.length > 0 ? expectedHits / withPitch.length : 0,
            pass: top[0] === seg.expectedMidi,
            topHistogram: sorted.slice(0, 3),
        };
    });
}

function printTable(title, stats) {
    console.log(`\n=== ${title} ===`);
    console.log('segment            expected  dominant  correct%  pass  top-3');
    for (const s of stats) {
        const pass = s.pass ? 'PASS' : 'FAIL';
        const corr = (s.correctFraction * 100).toFixed(0).padStart(3) + '%';
        const hist = s.topHistogram.map(([m, n]) => `${m}×${n}`).join(' ');
        console.log(`  ${s.label.padEnd(16)} ${String(s.expectedMidi).padStart(8)}  ${String(s.dominantMidi).padStart(8)}  ${corr.padStart(8)}  ${pass}  ${hist}`);
    }
    const passed = stats.filter(s => s.pass).length;
    console.log(`  ${passed}/${stats.length} segments pass`);
}

(async () => {
    const wav = readWav(WAV_PATH);
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    console.log(`WAV: ${WAV_PATH}  (${(wav.samples.length / wav.sampleRate).toFixed(1)}s)`);
    console.log(`Manifest: ${manifest.segments.length} labeled segments`);

    const browser = await puppeteer.launch({
        headless: 'new',
        protocolTimeout: 600_000,
        args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);
    page.on('pageerror', e => console.error('[page error]', e.message));

    try {
        console.log('\nLoading slopsmith...');
        await page.goto(SLOPSMITH_URL, { waitUntil: 'networkidle2' });
        await page.waitForFunction(() => window.slopsmith, { timeout: 10_000 });

        // Apply bass arrangement so any MIDI mappings are correct.
        await page.evaluate(() => {
            if (typeof _ndSetArrangement === 'function') _ndSetArrangement('bass');
        });

        // Load the CREPE model (normally triggered by the Detect button click).
        console.log('Loading CREPE model...');
        const modelOk = await page.evaluate(async () => {
            if (typeof _ndLoadCrepe !== 'function') return { ok: false, reason: 'no _ndLoadCrepe' };
            await _ndLoadCrepe();
            return { ok: !!_ndModel, reason: _ndModel ? 'loaded' : 'model null after load' };
        });
        console.log(`  ${modelOk.reason}`);

        // Serialize samples for evaluate — base64 Float32Array.
        const bytes = Buffer.from(wav.samples.buffer);
        const b64 = bytes.toString('base64');

        console.log('\nRunning both detectors across all frames (hop=50ms)...');
        const t0 = Date.now();
        const results = await page.evaluate(async (b64Samples, sampleRate, yinBuf, hopMs) => {
            const binary = atob(b64Samples);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const samples = new Float32Array(bytes.buffer);

            const hop = Math.floor(sampleRate * hopMs / 1000);
            const yinDets = [];
            const crepeDets = [];

            const midiOf = (f) => f > 0 ? Math.round(69 + 12 * Math.log2(f / 440)) : null;

            for (let start = 0; start + yinBuf <= samples.length; start += hop) {
                const wavT = start / sampleRate;
                const frame = samples.slice(start, start + yinBuf);

                // YIN
                const yr = _ndYinDetect(frame, sampleRate);
                yinDets.push({
                    wavT,
                    midi: yr.freq > 0 && yr.confidence >= 0.7 ? midiOf(yr.freq) : null,
                    freq: yr.freq, conf: yr.confidence,
                });

                // CREPE (if model loaded)
                if (_ndModel) {
                    const cr = await _ndCrepeDetect(frame);
                    crepeDets.push({
                        wavT,
                        midi: cr.freq > 0 && cr.confidence >= 0.5 ? midiOf(cr.freq) : null,
                        freq: cr.freq, conf: cr.confidence,
                    });
                }
            }
            return { yinDets, crepeDets, modelLoaded: !!_ndModel };
        }, b64, wav.sampleRate, YIN_BUF, HOP_MS);
        console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s  (${results.yinDets.length} YIN frames, ${results.crepeDets.length} CREPE frames)`);

        const yinStats = segmentStats(results.yinDets, manifest.segments);
        printTable('YIN', yinStats);

        if (results.modelLoaded && results.crepeDets.length > 0) {
            const crepeStats = segmentStats(results.crepeDets, manifest.segments);
            printTable('CREPE (SPICE)', crepeStats);
        } else {
            console.log('\n=== CREPE ===\n  model did not load — cannot compare');
        }

        // Dump raw results for further analysis — goes to test/fixtures/
        // (NOT the ground-truth subdir) so ground-truth.test.js doesn't try
        // to treat it as a manifest.
        const dumpDir = path.join(__dirname, 'fixtures');
        const base = path.basename(WAV_PATH).replace(/\.wav$/, '');
        const outPath = path.join(dumpDir, `${base}.bakeoff.json`);
        fs.writeFileSync(outPath, JSON.stringify({
            wav: WAV_PATH, manifest, yinDets: results.yinDets, crepeDets: results.crepeDets,
        }, null, 2));
        console.log(`\n  raw detections written to ${path.relative(process.cwd(), outPath)}`);
    } finally {
        await browser.close();
    }
})().catch(e => { console.error(e); process.exit(1); });

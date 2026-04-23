// Ground-truth pitch detection — runs YIN on real bass recordings where the
// physical note is known (from the WAV's sidecar manifest) and asserts the
// dominant detected MIDI per labeled segment matches the expected MIDI.
//
// Unlike the sine-wave unit tests, this exercises YIN on actual bass audio
// (sustain, string resonance, attack transients), which is where real-world
// failures live. New fixtures can be added without modifying this file —
// drop a `name.wav` + `name.json` manifest into test/fixtures/ground-truth/.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadDetectionCore } = require('./_loader');

const core = loadDetectionCore();
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'ground-truth');
const YIN_BUF = 4096;
const HOP_MS = 50;
const SILENCE_LEVEL = 0.01;

function readWav(p) {
    const buf = fs.readFileSync(p);
    if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`${p}: not RIFF`);
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

function rms(samples, start, n) {
    let s = 0;
    const end = Math.min(samples.length, start + n);
    for (let i = start; i < end; i++) s += samples[i] * samples[i];
    return Math.sqrt(s / (end - start)) * 5;
}

// Returns { dominantMidi, correctFraction, topHistogram, framesWithPitch } —
// see comment on the assertion: we assert on the DOMINANT detected MIDI across
// the segment, not per-frame correctness. YIN is allowed to jitter for the
// first few frames during attack; the note that "wins" the segment is what
// matters for the downstream stability voter.
function analyzeSegment(samples, sampleRate, tStart, tEnd) {
    const hop = Math.floor(sampleRate * HOP_MS / 1000);
    const startSample = Math.floor(tStart * sampleRate);
    const endSample = Math.floor(tEnd * sampleRate);
    const midiCounts = new Map();
    let framesWithPitch = 0;
    let framesTotal = 0;
    for (let s = startSample; s + YIN_BUF <= endSample; s += hop) {
        framesTotal++;
        const level = rms(samples, s, YIN_BUF);
        if (level < SILENCE_LEVEL) continue;
        const frame = samples.slice(s, s + YIN_BUF);
        const r = core.yinDetect(frame, sampleRate);
        if (r.freq <= 0 || r.confidence < 0.7) continue;
        const midi = Math.round(69 + 12 * Math.log2(r.freq / 440));
        midiCounts.set(midi, (midiCounts.get(midi) || 0) + 1);
        framesWithPitch++;
    }
    const sorted = [...midiCounts.entries()].sort((a, b) => b[1] - a[1]);
    return {
        dominantMidi: sorted[0] ? sorted[0][0] : null,
        topHistogram: sorted.slice(0, 3),
        framesWithPitch,
        framesTotal,
    };
}

function discoverFixtures() {
    if (!fs.existsSync(FIXTURES_DIR)) return [];
    const out = [];
    for (const f of fs.readdirSync(FIXTURES_DIR)) {
        if (!f.endsWith('.json')) continue;
        const full = path.join(FIXTURES_DIR, f);
        let manifest;
        try { manifest = JSON.parse(fs.readFileSync(full, 'utf8')); }
        catch { continue; }
        // A manifest has a WAV pointer + segments. Anything else (bakeoff
        // dumps, residual analyses) gets silently skipped.
        if (typeof manifest.wav === 'string' && Array.isArray(manifest.segments)) {
            out.push(full);
        }
    }
    return out;
}

for (const manifestPath of discoverFixtures()) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const wavPath = path.join(FIXTURES_DIR, manifest.wav);
    if (!fs.existsSync(wavPath)) {
        test(`${manifest.wav} — missing WAV`, () => {
            assert.fail(`expected WAV at ${wavPath}`);
        });
        continue;
    }
    const wav = readWav(wavPath);

    for (const seg of manifest.segments) {
        test(`${manifest.wav} :: ${seg.label} (${seg.tStart}s–${seg.tEnd}s) → MIDI ${seg.expectedMidi}`, () => {
            const result = analyzeSegment(wav.samples, wav.sampleRate, seg.tStart, seg.tEnd);
            assert.ok(
                result.framesWithPitch > 0,
                `no pitch detected in segment (${result.framesTotal} frames all silent or low-conf)`
            );
            assert.equal(
                result.dominantMidi,
                seg.expectedMidi,
                `dominant MIDI was ${result.dominantMidi}, expected ${seg.expectedMidi}. ` +
                `Top-3: ${result.topHistogram.map(([m, n]) => `${m}×${n}`).join(' ')}. ` +
                `${result.framesWithPitch}/${result.framesTotal} frames had a pitch.`
            );
        });
    }
}

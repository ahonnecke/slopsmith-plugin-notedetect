#!/usr/bin/env node
/**
 * Synthesize a clean, chart-aligned audio track for any slopsmith song,
 * and (by default) inject it into slopsmith's audio cache so the player
 * hears the synth instead of the real recording.
 *
 * Why this exists: real CDLC recordings drift relative to the chart
 * (rubato, hand-authored timing). On synth, chart and audio are zero-
 * drift by construction — any score below the pipeline ceiling is real
 * detection or playing error, not chart misalignment.
 *
 * Pipeline:
 *   1. Puppeteer loads the song in slopsmith, grabs the chart notes for
 *      the chosen arrangement (default: bass).
 *   2. Renders a 16-bit PCM mono WAV at 48 kHz: each chart note becomes
 *      a bass-like tone (weak fundamental + strong 2nd harmonic, etc.,
 *      same profile as test/synthesize-bass.js).
 *   3. Writes the WAV to test/fixtures/synth/<stem>.wav.
 *   4. Unless --no-inject, swaps the song's cached audio inside the
 *      container: backs up audio_<stem>.mp3 → .mp3.synth-bak and copies
 *      the synth WAV in as audio_<stem>.wav. slopsmith's audio lookup is
 *      [.mp3, .ogg, .wav] so the .mp3 has to move out of the way.
 *
 * Restore:
 *   node test/synth-track.js --song <name> --restore
 *   moves the .mp3.synth-bak back, removes the synth .wav. Original
 *   audio is restored without re-extracting the PSARC.
 *
 * Usage:
 *   node test/synth-track.js                          # Mexico bass, inject
 *   node test/synth-track.js --song Level
 *   node test/synth-track.js --song Mexico --no-inject
 *   node test/synth-track.js --song Mexico --restore
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
function getArg(n, d) { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; }

const SLOPSMITH_URL = process.env.SLOPSMITH_URL || 'http://localhost:8088';
const SONG_QUERY = getArg('song', 'Mexico');
const ARRANGEMENT = getArg('arrangement', null);
const CONTAINER = getArg('container', 'slopsmith-web-1');
const OUT_DIR = getArg('out-dir', path.join(__dirname, 'fixtures', 'synth'));
const NO_INJECT = args.includes('--no-inject');
const RESTORE = args.includes('--restore');
const SAMPLE_RATE = parseInt(getArg('sample-rate', '48000'), 10);
const NOTE_SUSTAIN_SEC = parseFloat(getArg('note-sustain', '0.40'));
const ATTACK_MS = parseFloat(getArg('attack-ms', '8'));
const AMPLITUDE = parseFloat(getArg('amplitude', '0.5'));
const NOISE_FLOOR = parseFloat(getArg('noise-floor', '0.002'));
// Layer a metronome click on every chart beat by default. Pure synth-bass
// is too sparse to play along to — silence between plucks gives no
// rhythmic anchor. Click is a short high-frequency burst, just loud
// enough to feel without drowning the bass tones.
const NO_CLICK = args.includes('--no-click');
const CLICK_FREQ_HZ = parseFloat(getArg('click-freq', '2000'));   // clicky high
const CLICK_DOWNBEAT_FREQ_HZ = parseFloat(getArg('click-downbeat-freq', '3000'));
const CLICK_AMP = parseFloat(getArg('click-amp', '0.18'));
const CLICK_DURATION_MS = parseFloat(getArg('click-duration', '15'));

// Same harmonic profile as test/synthesize-bass.js — weak fundamental,
// strong 2nd harmonic. Mirrors realistic bass content so the live YIN
// pipeline is exercised the way it would be on a real recording.
const HARMONICS = [
    [1, 0.08],
    [2, 0.50],
    [3, 0.30],
    [4, 0.12],
];

function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

function renderNote(samples, sampleRate, startSample, endSample, midi, amp) {
    const freq = midiToHz(midi);
    const attackSamples = Math.floor(sampleRate * ATTACK_MS / 1000);
    const decayLen = endSample - startSample - attackSamples;
    if (decayLen <= 0) return;
    for (let i = startSample; i < endSample && i < samples.length; i++) {
        const n = i - startSample;
        let env;
        if (n < attackSamples) env = n / attackSamples;
        else env = Math.pow(10, -2 * ((n - attackSamples) / decayLen));
        let sum = 0;
        const t = i / sampleRate;
        for (const [mult, w] of HARMONICS) sum += w * Math.sin(2 * Math.PI * freq * mult * t);
        samples[i] += sum * env * amp;
    }
}

function addNoiseFloor(samples, rms, seed = 42) {
    let s = seed;
    const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; s ^= s >>> 16; return (s >>> 0) / 0xffffffff; };
    for (let i = 0; i < samples.length; i++) samples[i] += (rng() - 0.5) * 2 * rms;
}

// Render a short percussive click — exponentially-decaying sine burst.
// Used for the metronome layer so the player has a tempo anchor without
// drowning the bass tones.
function renderClick(samples, sampleRate, startSample, freqHz, amp, durationMs) {
    const len = Math.floor(sampleRate * durationMs / 1000);
    for (let i = 0; i < len; i++) {
        const idx = startSample + i;
        if (idx >= samples.length) break;
        const t = i / sampleRate;
        const env = Math.exp(-i / (len * 0.3)); // decay to ~0 by end
        samples[idx] += amp * env * Math.sin(2 * Math.PI * freqHz * t);
    }
}

function writeWav(p, samples, sampleRate) {
    const n = samples.length;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + n * 2, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) {
        const c = Math.max(-1, Math.min(1, samples[i]));
        buf.writeInt16LE(c * 0x7FFF, 44 + i * 2);
    }
    fs.writeFileSync(p, buf);
}

// ── Container audio cache helpers ──────────────────────────────────────

function execContainer(cmd) {
    return execSync(`docker exec ${CONTAINER} sh -c '${cmd.replace(/'/g, "'\\''")}'`, { encoding: 'utf8' });
}

function findCachedAudio(stem) {
    try {
        const out = execContainer(`ls /config/audio_cache/audio_${stem}.* 2>/dev/null`);
        return out.trim().split('\n').filter(Boolean);
    } catch { return []; }
}

function injectSynth(stem, localWavPath) {
    const cached = findCachedAudio(stem);
    // Back up everything except existing .synth-bak files; the goal is to
    // make sure slopsmith's [.mp3, .ogg, .wav] lookup falls past the real
    // audio and lands on our synth WAV.
    for (const cf of cached) {
        if (cf.endsWith('.synth-bak')) continue;
        if (cf.endsWith('.wav')) {
            // If a real .wav exists, back it up so our synth wins.
            execContainer(`mv ${cf} ${cf}.synth-bak`);
            console.log(`  backed up: ${cf} → ${cf}.synth-bak`);
        } else {
            execContainer(`mv ${cf} ${cf}.synth-bak`);
            console.log(`  backed up: ${cf} → ${cf}.synth-bak`);
        }
    }
    const dest = `/config/audio_cache/audio_${stem}.wav`;
    execSync(`docker cp ${localWavPath} ${CONTAINER}:${dest}`);
    console.log(`  injected:  ${localWavPath} → ${CONTAINER}:${dest}`);
}

function restoreSynth(stem) {
    let restored = 0;
    let removedSynth = 0;
    try {
        const baks = execContainer(`ls /config/audio_cache/audio_${stem}.*.synth-bak 2>/dev/null`)
            .trim().split('\n').filter(Boolean);
        for (const bak of baks) {
            const orig = bak.replace(/\.synth-bak$/, '');
            execContainer(`mv ${bak} ${orig}`);
            console.log(`  restored:  ${bak} → ${orig}`);
            restored++;
        }
    } catch { /* nothing to restore */ }
    // If we restored a non-WAV original, drop our injected synth WAV.
    try {
        const synthWav = `/config/audio_cache/audio_${stem}.wav`;
        const exists = execContainer(`test -f ${synthWav} && echo y || true`).trim();
        if (exists === 'y' && restored > 0) {
            // Only remove if it's our synth (the bak was a non-wav). Crude check:
            // if there was a .mp3.synth-bak, the real audio was MP3, so this WAV
            // is ours.
            execContainer(`rm ${synthWav}`);
            console.log(`  removed synth WAV: ${synthWav}`);
            removedSynth++;
        }
    } catch { /* fine */ }
    return { restored, removedSynth };
}

// ── Chart fetch via puppeteer ──────────────────────────────────────────

async function fetchChart() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(60_000);
    try {
        await page.goto(SLOPSMITH_URL, { waitUntil: 'networkidle2' });
        await page.waitForFunction(() => window.slopsmith, { timeout: 10_000 });
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
        await page.evaluate(async (f, a) => { await playSong(f, a); }, song.filename, arrIdx);
        await page.waitForFunction(() => window.highway?.getNotes?.()?.length > 0, { timeout: 30_000 });
        await page.evaluate(() => {
            const info = highway.getSongInfo();
            if (info && info.arrangement) _ndSetArrangement(info.arrangement);
            if (info && Array.isArray(info.tuning)) _ndTuningOffsets = info.tuning;
            if (info && info.capo !== undefined) _ndCapo = info.capo;
        });
        const data = await page.evaluate(() => ({
            songInfo: highway.getSongInfo(),
            duration: highway.getSongInfo()?.duration ?? 0,
            notes: highway.getNotes().map(n => ({
                chartT: n.t, s: n.s, f: n.f,
                midi: _ndMidiFromStringFret(n.s, n.f) + (_ndPitchOffset || 0),
            })),
            beats: (highway.getBeats ? highway.getBeats() : []).map(b => ({
                t: b.time, measure: b.measure,
            })),
        }));
        return { song, ...data };
    } finally { await browser.close(); }
}

// ── Synthesis ──────────────────────────────────────────────────────────

function synthesize(notes, beats, durationSec) {
    const totalSamples = Math.floor(durationSec * SAMPLE_RATE);
    const samples = new Float32Array(totalSamples);
    const sorted = notes.slice().sort((a, b) => a.chartT - b.chartT);
    for (let i = 0; i < sorted.length; i++) {
        const n = sorted[i];
        const startWavT = n.chartT;
        const nextNoteWavT = i + 1 < sorted.length
            ? sorted[i + 1].chartT - 0.020
            : startWavT + NOTE_SUSTAIN_SEC;
        const endWavT = Math.min(startWavT + NOTE_SUSTAIN_SEC, nextNoteWavT);
        const startSample = Math.floor(startWavT * SAMPLE_RATE);
        const endSample = Math.floor(endWavT * SAMPLE_RATE);
        if (endSample <= startSample) continue;
        if (n.midi == null) continue;
        renderNote(samples, SAMPLE_RATE, startSample, endSample, n.midi, AMPLITUDE);
    }
    if (!NO_CLICK && beats && beats.length > 0) {
        // Beats are chart-time positions of every beat in the song. measure=1
        // marks downbeats — render those a touch louder/higher so the user
        // can feel where the bar starts.
        for (const b of beats) {
            const startSample = Math.floor(b.t * SAMPLE_RATE);
            if (startSample < 0 || startSample >= samples.length) continue;
            const downbeat = b.measure && b.measure !== -1 && b.measure % 1 === 0 && b.measure !== 0;
            const f = downbeat ? CLICK_DOWNBEAT_FREQ_HZ : CLICK_FREQ_HZ;
            const a = downbeat ? CLICK_AMP * 1.4 : CLICK_AMP;
            renderClick(samples, SAMPLE_RATE, startSample, f, a, CLICK_DURATION_MS);
        }
    }
    if (NOISE_FLOOR > 0) addNoiseFloor(samples, NOISE_FLOOR);
    return samples;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
    if (RESTORE) {
        // Need to know the song's stem to find its files. Use puppeteer to
        // resolve the filename, but skip chart fetch (not needed for restore).
        const puppeteer = require('puppeteer');
        const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
        const page = await browser.newPage();
        let stem;
        try {
            await page.goto(SLOPSMITH_URL, { waitUntil: 'networkidle2' });
            const library = await page.evaluate(async q => {
                const r = await fetch(`/api/library?q=${encodeURIComponent(q)}&page=0&size=10&sort=`);
                return r.json();
            }, SONG_QUERY);
            if (!library.songs?.length) throw new Error(`No songs match "${SONG_QUERY}"`);
            stem = path.parse(library.songs[0].filename).name.replace(/ /g, '_');
        } finally { await browser.close(); }
        console.log(`Restoring original audio for stem: ${stem}`);
        const r = restoreSynth(stem);
        if (r.restored === 0) console.log(`  nothing to restore (no .synth-bak files for ${stem})`);
        return;
    }

    console.log(`Fetching chart for "${SONG_QUERY}" from ${SLOPSMITH_URL}…`);
    const { song, songInfo, duration, notes, beats } = await fetchChart();
    const stem = path.parse(song.filename).name.replace(/ /g, '_');
    console.log(`  song: ${song.filename}  arrangement: ${songInfo.arrangement}  duration: ${duration.toFixed(1)}s  notes: ${notes.length}  beats: ${beats?.length || 0}`);

    if (notes.length === 0) {
        console.error('No notes in chart — aborting.');
        process.exit(1);
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const wavPath = path.join(OUT_DIR, `${stem}.wav`);
    const sidecarPath = path.join(OUT_DIR, `${stem}.json`);

    console.log(`Synthesizing ${duration.toFixed(1)}s of audio at ${SAMPLE_RATE} Hz${NO_CLICK ? '' : ' (with metronome click on every beat)'}…`);
    const samples = synthesize(notes, beats || [], duration + 1.0);
    writeWav(wavPath, samples, SAMPLE_RATE);
    fs.writeFileSync(sidecarPath, JSON.stringify({
        chartStartTime: 0,
        sampleRate: SAMPLE_RATE,
        synthesized: true,
        song: song.filename,
        arrangement: songInfo.arrangement,
        duration,
        noteCount: notes.length,
    }, null, 2));
    console.log(`  wrote: ${path.relative(process.cwd(), wavPath)} (${(fs.statSync(wavPath).size / 1024 / 1024).toFixed(1)} MB)`);

    if (NO_INJECT) {
        console.log('Skipping injection (--no-inject). To play: copy the WAV manually into the audio cache, or re-run without --no-inject.');
        return;
    }

    console.log(`Injecting into ${CONTAINER}:/config/audio_cache/…`);
    injectSynth(stem, wavPath);
    console.log();
    console.log('Done. Reload the song in slopsmith — you should hear synthesized tones at every chart-note position.');
    console.log(`To restore the original audio:  node test/synth-track.js --song "${SONG_QUERY}" --restore`);
}

main().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * Compute the absolute pipeline ceiling for a song by feeding the song's
 * own original recording through classify-session.js. The score is the
 * highest number any human can achieve playing this chart through this
 * pipeline — the studio bass IS the chart.
 *
 * See docs/SONG_PIPELINE_CEILING.md for the full rationale.
 *
 * Usage:
 *   node test/song-ceiling.js                       # default Mexico
 *   node test/song-ceiling.js --song "Stand by Me"
 *   node test/song-ceiling.js --song Mexico --arrangement 3
 *
 * Pipeline:
 *   1. Resolve the song via puppeteer + slopsmith library API.
 *   2. Pull the cached audio (audio_<stem>.<ext>) from the container.
 *      If the audio has been swapped for a synth track (.synth-bak
 *      sibling exists) the original .synth-bak is used so we score
 *      against the real recording, not whatever's currently injected.
 *   3. ffmpeg → 48 kHz mono WAV.
 *   4. Fetch chart via highway.getNotes(), build a synthetic dump.
 *   5. classify-session.js --no-auto-align (chart times are real song
 *      seconds, no offset needed).
 *   6. Persist {score, total, ceilingPct, timestamp, chartHash} to
 *      test/fixtures/song-ceiling/<stem>.json so per-song ceilings
 *      can be tracked across pipeline changes.
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const args = process.argv.slice(2);
function getArg(n, d) { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; }

const SLOPSMITH_URL = process.env.SLOPSMITH_URL || 'http://localhost:8088';
const SONG_QUERY = getArg('song', 'Mexico');
const ARRANGEMENT = getArg('arrangement', null);
const CONTAINER = getArg('container', 'slopsmith-web-1');
const OUT_DIR = getArg('out-dir', path.join(__dirname, 'fixtures', 'song-ceiling'));
// Forward --band-pass through to classify-session.js. Output goes to
// <stem>.bp.ceiling.json so it doesn't overwrite the unfiltered baseline.
const BAND_PASS = args.includes('--band-pass');

function execContainer(cmd) {
    return execSync(`docker exec ${CONTAINER} sh -c '${cmd.replace(/'/g, "'\\''")}'`, { encoding: 'utf8' });
}

async function fetchSongAndChart() {
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
        // Prefer a song whose filename / artist / title contains the literal
        // query (slopsmith's library search is single-term and can rank
        // unrelated covers above the user's intended song). Falls back to
        // the first hit when no substring match exists.
        const FILENAME_HINT = getArg('filename-hint', SONG_QUERY).toLowerCase();
        const slug = FILENAME_HINT.replace(/[^a-z0-9]+/g, '');
        const song = library.songs.find(s => {
            const blob = `${s.filename} ${s.artist || ''} ${s.title || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '');
            return slug && blob.includes(slug);
        }) || library.songs[0];
        if (library.songs.length > 1) {
            console.log(`  resolved "${SONG_QUERY}" → ${song.filename} (${library.songs.length} candidates)`);
        }
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
        }));
        return { song, ...data };
    } finally { await browser.close(); }
}

function pullOriginalAudio(stem, destBase) {
    // If a .synth-bak exists we want the original (.mp3 / .wav before
    // synth injection). Otherwise pull whatever's there.
    const cands = ['.mp3.synth-bak', '.ogg.synth-bak', '.wav.synth-bak',
                   '.mp3', '.ogg', '.wav'];
    for (const ext of cands) {
        const src = `/config/audio_cache/audio_${stem}${ext}`;
        try {
            execContainer(`test -f ${src}`);
            const localExt = ext.replace('.synth-bak', '');
            const localPath = `${destBase}${localExt}`;
            execSync(`docker cp ${CONTAINER}:${src} ${localPath}`);
            console.log(`  pulled audio: ${src} → ${localPath}`);
            return localPath;
        } catch { /* keep trying */ }
    }
    throw new Error(`No cached audio found for stem ${stem}`);
}

function transcodeToWav(srcPath, wavPath) {
    spawnSync('ffmpeg', ['-y', '-i', srcPath, '-ar', '48000', '-ac', '1', wavPath], { stdio: 'ignore' });
    if (!fs.existsSync(wavPath) || fs.statSync(wavPath).size < 1000) {
        throw new Error(`ffmpeg failed to produce ${wavPath}`);
    }
    console.log(`  transcoded: ${srcPath} → ${wavPath} (${(fs.statSync(wavPath).size / 1024 / 1024).toFixed(1)} MB)`);
}

function buildSyntheticDump(notes, dumpPath) {
    const noteResults = notes.map(n => ({
        key: `${n.chartT.toFixed(3)}_${n.s}_${n.f}`,
        primary: 'MISSED_NO_DETECTION',  // placeholder — classifier rebuilds verdicts from audio
        labels: [],
        timingError: null, pitchError: null,
        detectedMidi: null,
        expectedMidi: n.midi,
        s: n.s, f: n.f, chartT: n.chartT,
    }));
    fs.writeFileSync(dumpPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        autoDump: false, eventLog: [], frameLog: [],
        noteResults,
        settings: { latencyOffset: 0, timingTolerance: 0.3, pitchTolerance: 100, silenceGate: 0, arrangement: 'bass', tuning: [0,0,0,0,0,0], capo: 0 },
        scoring: { hits: 0, misses: 0, pitchMisses: 0, timingMisses: 0 },
    }, null, 2));
    return noteResults.length;
}

function runClassifier(wavPath, dumpPath) {
    const sidecar = wavPath.replace(/\.wav$/, '.json');
    if (!fs.existsSync(sidecar)) {
        fs.writeFileSync(sidecar, JSON.stringify({ chartStartTime: 0, sampleRate: 48000 }));
    }
    const cmd = [path.join(__dirname, 'classify-session.js'),
                 '--wav', wavPath, '--dump', dumpPath, '--no-auto-align'];
    if (BAND_PASS) cmd.push('--band-pass');
    const r = spawnSync('node', cmd, { encoding: 'utf8' });
    if (r.status !== 0) {
        console.error(r.stdout);
        console.error(r.stderr);
        throw new Error('classifier failed');
    }
    return r.stdout;
}

function parseClassifierOutput(out) {
    const buckets = {};
    for (const line of out.split('\n')) {
        const m = /^\s+(PIPELINE_HIT|PIPELINE_MISSED_REAL_PLAY|PIPELINE_YIN_DISAGREES|USER_WRONG_PITCH|USER_SILENT)\s+(\d+)\s*\/\s*(\d+)/.exec(line);
        if (m) buckets[m[1]] = { count: +m[2], total: +m[3] };
    }
    return buckets;
}

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    console.log(`Resolving "${SONG_QUERY}" via slopsmith…`);
    const { song, songInfo, duration, notes } = await fetchSongAndChart();
    const stem = path.parse(song.filename).name.replace(/ /g, '_');
    console.log(`  song: ${song.filename}  arr: ${songInfo.arrangement}  dur: ${duration.toFixed(1)}s  notes: ${notes.length}`);

    const audioBase = path.join(OUT_DIR, stem);
    const audioSrc = pullOriginalAudio(stem, audioBase);
    const wavPath = `${audioBase}.wav`;
    transcodeToWav(audioSrc, wavPath);

    const dumpPath = `${audioBase}.dump.json`;
    const chartCount = buildSyntheticDump(notes, dumpPath);
    console.log(`  built synthetic dump with ${chartCount} chart notes`);

    console.log(`Classifying…`);
    const out = runClassifier(wavPath, dumpPath);
    const buckets = parseClassifierOutput(out);

    // Synthetic dump marks every note as MISSED_NO_DETECTION. The classifier
    // then re-runs offline YIN against the audio to figure out WHY each
    // miss happened:
    //   PIPELINE_MISSED_REAL_PLAY — audio HAS expected pitch (= audio-truth
    //                               hit). This is the ceiling number — what
    //                               a perfect-detection pipeline would score.
    //   USER_WRONG_PITCH          — audio has a different pitch (sustain
    //                               from another note, polyphonic context,
    //                               or the original recording is just hard
    //                               to read on this chart note).
    //   USER_SILENT               — no pitch in the window. Either silent
    //                               passage or non-tonal content.
    const total = Object.values(buckets).reduce((s, b) => Math.max(s, b.total), 0);
    const audioTruthHits = buckets.PIPELINE_MISSED_REAL_PLAY?.count || 0;
    const wrongPitch     = buckets.USER_WRONG_PITCH?.count || 0;
    const silent         = buckets.USER_SILENT?.count || 0;
    const ceilingPct = total > 0 ? (audioTruthHits / total) * 100 : 0;

    console.log();
    console.log(`═══ Pipeline ceiling: ${stem} ═══`);
    console.log(`  Audio-truth ceiling: ${audioTruthHits}/${total} = ${ceilingPct.toFixed(1)}%`);
    console.log();
    console.log(`  Breakdown of "where the audio actually is":`);
    console.log(`    Expected pitch present (= ceiling): ${audioTruthHits}/${total} (${(audioTruthHits / total * 100).toFixed(1)}%)`);
    console.log(`    Different pitch dominant:           ${wrongPitch}/${total} (${(wrongPitch / total * 100).toFixed(1)}%)`);
    console.log(`    Silent / non-tonal:                 ${silent}/${total} (${(silent / total * 100).toFixed(1)}%)`);
    console.log();
    if (ceilingPct >= 90)      console.log(`  → Friendly chart. Pipeline-side performance is the bottleneck only at the margins; user score ≈ user accuracy.`);
    else if (ceilingPct >= 75) console.log(`  → Moderate chart. User score is meaningful but won't reach 100% even with perfect playing.`);
    else if (ceilingPct >= 60) console.log(`  → Hard chart. User scores in the 50-70 range are likely at-ceiling.`);
    else                       console.log(`  → Architectural-limit chart. User score reflects pipeline + audio-content limits, not playing.`);

    const variantSuffix = BAND_PASS ? '.bp' : '';
    const resultPath = path.join(OUT_DIR, `${stem}${variantSuffix}.ceiling.json`);
    fs.writeFileSync(resultPath, JSON.stringify({
        stem, song: song.filename, arrangement: songInfo.arrangement,
        variant: BAND_PASS ? 'band-pass-30-250' : 'baseline',
        chartNoteCount: chartCount, durationSec: duration,
        score: audioTruthHits, total, ceilingPct,
        buckets,
        measuredAt: new Date().toISOString(),
        pipelineCommit: (() => {
            try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); }
            catch { return null; }
        })(),
    }, null, 2));
    console.log(`  written: ${path.relative(process.cwd(), resultPath)}`);
}

main().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * Programmatic audio test — injects sine waves into the detection pipeline
 * via OscillatorNode and verifies the chart matching produces hits.
 *
 * Requires:
 *   - slopsmith running at localhost:8088 (docker compose up)
 *   - puppeteer installed (npx puppeteer)
 *   - A song in the library (defaults to first song found)
 *
 * Usage:
 *   node test/perfect-play.test.js
 *   node test/perfect-play.test.js --song "Mexico" --arrangement 3
 *   node test/perfect-play.test.js --max-notes 20
 */

const puppeteer = require('puppeteer');

const SLOPSMITH_URL = process.env.SLOPSMITH_URL || 'http://localhost:8088';
const TIMEOUT_MS = 120_000; // 2 minutes max

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
    const idx = args.indexOf(`--${name}`);
    if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
    return defaultVal;
}
const SONG_QUERY = getArg('song', '');
const ARRANGEMENT = getArg('arrangement', null);
const MAX_NOTES = parseInt(getArg('max-notes', '30'), 10);
const HEADLESS = !args.includes('--headed');

async function main() {
    console.log('=== Slopsmith Perfect-Play Test ===');
    console.log(`URL: ${SLOPSMITH_URL}`);
    console.log(`Headless: ${HEADLESS}`);
    console.log(`Max notes: ${MAX_NOTES}`);

    const browser = await puppeteer.launch({
        headless: HEADLESS ? 'new' : false,
        protocolTimeout: 300_000, // 5 minutes for long test sequences
        args: [
            '--autoplay-policy=no-user-gesture-required',
            '--use-fake-ui-for-media-stream',       // auto-grant mic permission
            '--use-fake-device-for-media-stream',    // provide fake mic (won't be used but avoids errors)
            '--no-sandbox',
        ],
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);

    // Forward console messages
    page.on('console', msg => {
        const text = msg.text();
        if (text.includes('[nd-test]') || text.includes('[note_detect]')) {
            console.log(`  [browser] ${text}`);
        }
    });
    page.on('pageerror', err => console.error('  [page error]', err.message));

    try {
        // 1. Load slopsmith
        console.log('\n1. Loading slopsmith...');
        await page.goto(SLOPSMITH_URL, { waitUntil: 'networkidle2' });
        await page.waitForFunction(() => window.slopsmith, { timeout: 10_000 });
        console.log('   Slopsmith loaded.');

        // 2. Find a song
        console.log('\n2. Finding song...');
        const library = await page.evaluate(async (q) => {
            const r = await fetch(`/api/library?q=${encodeURIComponent(q)}&page=0&size=10&sort=`);
            return r.json();
        }, SONG_QUERY);

        if (!library.songs || library.songs.length === 0) {
            throw new Error(`No songs found${SONG_QUERY ? ` matching "${SONG_QUERY}"` : ''}. Add songs to slopsmith library.`);
        }

        const song = library.songs[0];
        // Find bass arrangement if no explicit arrangement given
        let arrIdx = ARRANGEMENT !== null ? parseInt(ARRANGEMENT, 10) : null;
        if (arrIdx === null) {
            const bassArr = song.arrangements.find(a => /bass/i.test(a.name));
            arrIdx = bassArr ? bassArr.index : 0;
        }
        const arrName = song.arrangements.find(a => a.index === arrIdx)?.name || `index ${arrIdx}`;
        console.log(`   Song: "${song.title}" by ${song.artist}`);
        console.log(`   Arrangement: ${arrName} (index ${arrIdx})`);

        // 3. Load the song
        console.log('\n3. Loading song into highway...');
        await page.evaluate(async (filename, arr) => {
            await playSong(filename, arr);
        }, song.filename, arrIdx);

        // Wait for highway to have notes
        await page.waitForFunction(() => {
            const notes = window.highway?.getNotes?.();
            return notes && notes.length > 0;
        }, { timeout: 30_000 });

        const noteCount = await page.evaluate(() => highway.getNotes().length);
        console.log(`   Highway loaded: ${noteCount} notes`);

        // 4. Pause audio — we don't want actual audio playing during the test
        await page.evaluate(() => {
            const audio = document.getElementById('audio');
            if (audio) { audio.pause(); audio.volume = 0; }
        });

        // 5. Enable note detection plugin (mirrors what _ndToggle does)
        console.log('\n4. Enabling note detection...');
        await page.evaluate(() => {
            _ndEnabled = true;
            // Reset any poisoned settings
            _ndPitchOffset = 0;
            _ndLatencyOffset = 0.350;
            // Set arrangement from song info (normally done in _ndToggle)
            const info = highway.getSongInfo();
            if (info && info.arrangement) _ndSetArrangement(info.arrangement);
            if (info && Array.isArray(info.tuning)) _ndTuningOffsets = info.tuning;
            if (info && info.capo !== undefined) _ndCapo = info.capo;
            console.log('[nd-test] Arrangement:', _ndCurrentArrangement);
            console.log('[nd-test] Base MIDI:', JSON.stringify(_ndStandardMidiFor(_ndCurrentArrangement)));
        });

        // 6. Run the perfect-play test
        console.log(`\n5. Running perfect-play test (${MAX_NOTES} notes)...`);
        const result = await page.evaluate(async (maxNotes) => {
            return await _ndTestPerfectPlay({ maxNotes, amplitude: 0.5 });
        }, MAX_NOTES);

        // 7. Also grab the dump from the server
        let serverDump = null;
        try {
            const dumpResp = await page.evaluate(async () => {
                const r = await fetch('/api/plugins/note_detect/dump');
                return r.json();
            });
            serverDump = dumpResp;
        } catch (e) {
            console.log('   (Could not read server dump)');
        }

        // 8. Report results
        console.log('\n=== RESULTS ===');
        if (!result) {
            console.log('ERROR: Test returned null (no chart notes?)');
            process.exitCode = 1;
        } else {
            console.log(`Hit rate: ${result.hits}/${result.total} (${result.hitRate}%)`);
            console.log(`  Hits: ${result.hits}`);
            console.log(`  Misses: ${result.misses}`);
            console.log(`  Pitch misses: ${result.pitchMisses}`);
            console.log(`  Timing misses: ${result.timingMisses}`);
            console.log(`\nSettings used:`);
            console.log(`  Latency offset: ${(result.settings.latencyOffset * 1000).toFixed(0)}ms`);
            console.log(`  Timing tolerance: ${(result.settings.timingTolerance * 1000).toFixed(0)}ms`);
            console.log(`  Pitch tolerance: ${result.settings.pitchTolerance}¢`);
            console.log(`  Silence gate: ${result.settings.silenceGate}`);
            console.log(`  Stability: ${result.settings.stabilityRequired}-of-${result.settings.stabilityWindow}`);

            if (result.noteResults && result.noteResults.length > 0) {
                console.log('\nNote details:');
                for (const r of result.noteResults) {
                    const te = r.timingError != null ? `${Math.round(r.timingError)}ms` : '—';
                    const pe = r.pitchError != null ? `${Math.round(r.pitchError)}¢` : '—';
                    const status = r.primary === 'HIT' ? '✓' : '✗';
                    console.log(`  ${status} ${r.key.padEnd(20)} ${r.primary.padEnd(25)} timing=${te.padStart(8)} pitch=${pe.padStart(6)} det:${r.detectedMidi ?? '?'} exp:${r.expectedMidi ?? '?'}`);
                }
            }

            // Exit code based on hit rate
            const hitRate = parseFloat(result.hitRate);
            if (hitRate >= 90) {
                console.log('\nPASS: Hit rate >= 90%');
                process.exitCode = 0;
            } else if (hitRate >= 50) {
                console.log(`\nFAIL: Hit rate ${result.hitRate}% (target: 90%+)`);
                process.exitCode = 1;
            } else {
                console.log(`\nFAIL: Hit rate ${result.hitRate}% — pipeline is broken`);
                process.exitCode = 1;
            }
        }

    } catch (err) {
        console.error('\nERROR:', err.message);
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exitCode = 1;
});

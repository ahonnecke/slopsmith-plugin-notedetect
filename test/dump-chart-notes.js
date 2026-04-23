#!/usr/bin/env node
/**
 * One-shot — load a song in slopsmith, grab its chart notes, write to disk.
 * Feeds test/yin-offline.js so it can compare YIN output against the chart
 * without needing a running slopsmith.
 *
 * Usage:
 *   node test/dump-chart-notes.js            # Mexico bass, writes mexico-bass-notes.json
 *   node test/dump-chart-notes.js --song "Foo" --out foo-bass-notes.json
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
const SONG_QUERY = getArg('song', 'Mexico');
const OUT = getArg('out', 'mexico-bass-notes.json');
const ARRANGEMENT = getArg('arrangement', null);

(async () => {
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
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

        // Apply song's arrangement + tuning so _ndMidiFromStringFret uses the
        // correct base (bass vs guitar). Without this, _ndCurrentArrangement
        // defaults to guitar and a bass chart gets MIDI values an octave too high.
        await page.evaluate(() => {
            const info = highway.getSongInfo();
            if (info && info.arrangement) _ndSetArrangement(info.arrangement);
            if (info && Array.isArray(info.tuning)) _ndTuningOffsets = info.tuning;
            if (info && info.capo !== undefined) _ndCapo = info.capo;
        });

        const notes = await page.evaluate(() => {
            return highway.getNotes().map(n => ({
                chartT: n.t,
                s: n.s,
                f: n.f,
                midi: _ndMidiFromStringFret(n.s, n.f) + (_ndPitchOffset || 0),
            }));
        });
        const outPath = path.join(__dirname, 'fixtures', OUT);
        fs.writeFileSync(outPath, JSON.stringify(notes, null, 2));
        console.log(`wrote ${notes.length} chart notes to ${path.relative(process.cwd(), outPath)}`);
    } finally {
        await browser.close();
    }
})().catch(e => { console.error(e); process.exit(1); });

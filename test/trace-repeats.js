const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const SLOPSMITH_URL = 'http://localhost:8088';
(async () => {
    const manifest = JSON.parse(fs.readFileSync('test/fixtures/ground-truth/same-pitch-repeats.json', 'utf8'));
    const wavBytes = fs.readFileSync('test/fixtures/ground-truth/same-pitch-repeats.wav');
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage();
    page.on('pageerror', e => console.error('[page error]', e.message));
    try {
        await page.goto(SLOPSMITH_URL, { waitUntil: 'networkidle2' });
        await page.waitForFunction(() => window.slopsmith);
        await page.evaluate(() => _ndSetArrangement('bass'));
        const wavB64 = wavBytes.toString('base64');
        await page.evaluate(async (b64, name) => {
            const bin = atob(b64); const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const blob = new Blob([bytes], { type: 'audio/wav' });
            const form = new FormData(); form.append('file', blob, name);
            await fetch('/api/plugins/note_detect/recording', { method: 'POST', body: form });
        }, wavB64, 'same-pitch-repeats.wav');
        const result = await page.evaluate(async () => {
            const realGetTime = highway.getTime.bind(highway);
            const realGetAv = highway.getAvOffset ? highway.getAvOffset.bind(highway) : () => 0;
            const realMatch = window._ndMatchNotes;
            const events = []; // {t, type, ...}
            window._ndTestWavPlaybackStartAudio = undefined;
            highway.getTime = () => {
                const anchor = window._ndTestWavPlaybackStartAudio;
                if (anchor === undefined) return realGetTime();
                return _ndAudioCtx.currentTime - anchor;
            };
            highway.getAvOffset = () => 0;
            window._ndMatchNotes = function(tOverride) {
                events.push({ t: highway.getTime(), type: 'match', tOverride: tOverride ?? null, stableMidi: _ndStableMidi });
                return realMatch.apply(this, arguments);
            };
            const sampler = setInterval(() => {
                events.push({ t: highway.getTime(), type: 'poll', stableMidi: _ndStableMidi, pendingOnset: _ndPendingOnsetChartT, onsetCount: _ndOnsetCount, inNote: _ndInNote, lastMatchMidi: _ndLastMatchMidi, lastMatchTime: _ndLastMatchTime });
            }, 100);
            _ndResetScoring();
            _ndEnabled = true;
            _ndDetectionLatencySec = 0.05; // match our new onset-comp; neutralize old 500ms
            _ndTimingTolerance = 0.3;
            _ndPitchTolerance = 100;
            _ndSilenceGate = 0;
            await _ndInjectTestWav('/api/plugins/note_detect/recording/same-pitch-repeats.wav');
            clearInterval(sampler);
            window._ndMatchNotes = realMatch;
            highway.getTime = realGetTime;
            highway.getAvOffset = realGetAv;
            return events;
        });
        console.log('pluck times:', manifest.plucks.map(p => p.chartT.toFixed(3)).join(', '));
        console.log();
        const matches = result.filter(e => e.type === 'match');
        console.log('_ndMatchNotes calls:');
        for (const m of matches) console.log('  t=' + m.t.toFixed(3) + '  tOverride=' + (m.tOverride ? m.tOverride.toFixed(3) : 'null') + '  stableMidi=' + m.stableMidi);
        console.log();
        const polls = result.filter(e => e.type === 'poll');
        let lastOnset = 0;
        console.log('onset count changes (pluck attempts):');
        for (const p of polls) {
            if (p.onsetCount > lastOnset) { console.log('  onset #' + p.onsetCount + ' at t=' + p.t.toFixed(3) + ' pendingOnsetChartT=' + (p.pendingOnset?.toFixed(3) ?? 'null')); lastOnset = p.onsetCount; }
        }
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * Settings → Calibrate latency wiring probe.
 *
 * Validates that the system-settings entry to the calibration wizard
 * actually works without a song loaded. Headless Chrome with a fake mic
 * device. Reports each milestone as it happens so a failure points to
 * the broken stage.
 *
 * Usage: node test/probe-settings-wizard.js
 */

const puppeteer = require('puppeteer');

const URL = process.env.SLOPSMITH_URL || 'http://localhost:8088';

async function main() {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--use-fake-ui-for-media-stream',
               '--use-fake-device-for-media-stream',
               '--autoplay-policy=no-user-gesture-required'],
    });
    const page = await browser.newPage();
    const consoleLines = [];
    page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', err => console.error('[pageerror]', err.message));

    console.log(`opening ${URL} ...`);
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Plugins load asynchronously after DOMContentLoaded
    await new Promise(r => setTimeout(r, 1500));

    // Step 1: settings card present in DOM?
    const cardPresent = await page.evaluate(() => {
        const c = document.getElementById('plugin-settings-note_detect');
        return c && c.innerText.includes('Note Detection') ? c.innerText.slice(0, 80) : null;
    });
    console.log(cardPresent
        ? `[ok] settings card injected: "${cardPresent.replace(/\s+/g, ' ')}..."`
        : '[FAIL] settings card not in DOM');
    if (!cardPresent) { await browser.close(); process.exit(2); }

    // Step 2: navigate to settings + check readout state
    await page.evaluate(() => showScreen('settings'));
    await new Promise(r => setTimeout(r, 300));
    const readout = await page.evaluate(() => {
        const el = document.getElementById('nd-settings-mic-latency-readout');
        return el ? el.textContent.trim() : null;
    });
    console.log(`[ok] mic latency readout: "${readout}"`);

    // Step 3: click Calibrate latency
    const clicked = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('#plugin-settings-note_detect button')]
            .find(b => /calibrate/i.test(b.textContent));
        if (!btn) return false;
        btn.click();
        return true;
    });
    if (!clicked) { console.log('[FAIL] Calibrate button not found'); await browser.close(); process.exit(2); }
    console.log('[ok] Calibrate latency button clicked');

    // Step 4: wait briefly + check wizard modal appears + mic context boot
    await new Promise(r => setTimeout(r, 1500));
    const modalUp = await page.evaluate(() => {
        const m = document.getElementById('nd-wizard-modal');
        return m ? m.innerText.slice(0, 100) : null;
    });
    console.log(modalUp
        ? `[ok] wizard modal opened: "${modalUp.replace(/\s+/g, ' ')}..."`
        : '[FAIL] wizard modal did not open within 1.5s');

    // Step 5: confirm mic pipeline started
    const audioState = await page.evaluate(() => ({
        enabled: typeof _ndEnabled !== 'undefined' ? _ndEnabled : '?',
        ctxState: typeof _ndAudioCtx !== 'undefined' && _ndAudioCtx ? _ndAudioCtx.state : 'null',
        wizardOwnsMic: typeof _ndWizardOwnsMic !== 'undefined' ? _ndWizardOwnsMic : '?',
        sampleRate: typeof _ndAudioCtx !== 'undefined' && _ndAudioCtx ? _ndAudioCtx.sampleRate : null,
    }));
    console.log(`[ok] audio pipeline: enabled=${audioState.enabled} ctxState=${audioState.ctxState} wizardOwnsMic=${audioState.wizardOwnsMic} sampleRate=${audioState.sampleRate}`);
    const micUp = audioState.ctxState === 'running'
        && audioState.wizardOwnsMic === true
        && audioState.enabled === true;
    if (!micUp) {
        console.log('[FAIL] mic pipeline did not boot from settings entry (need enabled=true ctxState=running wizardOwnsMic=true)');
    } else {
        console.log('[ok] mic enabled, owned by wizard, ready for calibration');
    }

    // Step 5b: simulate the keyboard reaction-time pre-tests for BOTH
    // stimuli. We dispatch synthetic Space keydown events 215 ms after
    // each stimulus event — result should round-trip a personal RT
    // close to (215 - 5) = 210 ms for each.
    async function simulateKeyboardRun(stim, expectedMs) {
        console.log(`[step] simulating ${stim} keyboard reaction-time test...`);
        const result = await page.evaluate(async (stimulus) => {
            _ndWizStartKeyboardRun(stimulus);
            const expected = _ND_WIZ_KEYBOARD_CLICKS;
            const stepKey = `running-keyboard-${stimulus}`;
            const dispatched = new Set();
            const startedAt = performance.now();
            while (_ndWizStep === stepKey && performance.now() - startedAt < 30000) {
                const now = performance.now();
                for (let i = 0; i < _ndWizKeyboardClicks.length; i++) {
                    if (dispatched.has(i)) continue;
                    if (_ndWizKeyboardClicks[i] <= now - 30) {
                        setTimeout(() => {
                            document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
                        }, 215 - 30);
                        dispatched.add(i);
                    }
                }
                await new Promise(r => setTimeout(r, 20));
            }
            const last = stimulus === 'visual'
                ? _ndWizKeyboardLastResultVisual
                : _ndWizKeyboardLastResult;
            return {
                step: _ndWizStep,
                personalRtMs: stimulus === 'visual' ? _ndUserReactionVisualMs : _ndUserReactionAuditoryMs,
                lastResult: last ? {
                    medianMs: last.medianMs,
                    rawMedianMs: last.rawMedianMs,
                    dropped: last.dropped,
                    lowQuality: last.lowQuality,
                } : null,
                clicksScheduled: _ndWizKeyboardClicks.length,
                keysCaptured: _ndWizKeyboardKeys.length,
                expectedClicks: expected,
            };
        }, stim);
        console.log(`[info] ${stim} kbd: clicks=${result.clicksScheduled}/${result.expectedClicks} keys=${result.keysCaptured} step=${result.step}`);
        if (result.lastResult) {
            const r = result.lastResult;
            console.log(`[ok] ${stim} keyboard run: median=${r.medianMs}ms (raw ${r.rawMedianMs}, ${r.dropped} dropped, lowQ=${r.lowQuality})`);
            console.log(`[ok] personal ${stim} RT persisted = ${result.personalRtMs} ms`);
        } else {
            console.log(`[FAIL] ${stim} keyboard run did not finish`);
        }
        const ok = result.lastResult
            && result.lastResult.medianMs !== null
            && Math.abs(result.personalRtMs - expectedMs) <= 40
            && !result.lastResult.lowQuality;
        if (!ok) {
            console.log(`[FAIL] expected ${stim} personal RT near ${expectedMs} ms, got ${result.personalRtMs}`);
        } else {
            console.log(`[ok] ${stim} reaction-time round-trip within ±40 ms tolerance`);
        }
        return ok;
    }

    const kbdAudioOk = await simulateKeyboardRun('audio', 210);
    const kbdVisualOk = await simulateKeyboardRun('visual', 210);
    const kbdOk = kbdAudioOk && kbdVisualOk;

    // Step 6: simulate a full visual run with synthetic detections firing on
    // every GO beat, then confirm finishRun produces a non-null medianDt.
    // The fake mic device emits silence, so we bypass YIN and call
    // _ndWizOnDetection directly — this validates the click→run→finish→
    // result pipeline end-to-end without needing real bass input.
    console.log('[step] simulating visual run with synthetic on-beat detections...');
    const runResult = await page.evaluate(async () => {
        // Speed: kick off a visual run, then in parallel push a synthetic
        // detection 30ms after each scheduled GO beat fires. We hook into
        // _ndWizFireBeat by polling _ndWizBeats.length growing.
        _ndWizStartRun('visual');
        const expected = (typeof _ND_METRO_CYCLES !== 'undefined') ? _ND_METRO_CYCLES : 6;
        const intervalMs = 60000 / ((typeof _ND_METRO_BPM !== 'undefined') ? _ND_METRO_BPM : 75);
        let lastSeen = 0;
        // Wait until either the run completes (step → 'intro') or 60s timeout.
        const startedAt = performance.now();
        while (_ndWizStep === 'running-visual' && performance.now() - startedAt < 60000) {
            const n = _ndWizBeats.length;
            if (n > lastSeen) {
                // A new GO beat just fired — push a synthetic detection 30ms
                // later to simulate an on-time pluck.
                const beatT = _ndWizBeats[n - 1];
                setTimeout(() => {
                    _ndWizDetections.push({ time: beatT + 30, midi: 28 });
                }, 30);
                lastSeen = n;
            }
            await new Promise(r => setTimeout(r, 20));
        }
        return {
            step: _ndWizStep,
            visualRun: _ndWizVisualRun ? {
                medianDt: _ndWizVisualRun.medianDt,
                usedCount: _ndWizVisualRun.usedCount,
                droppedHardCap: _ndWizVisualRun.droppedHardCap,
                droppedNoDetection: _ndWizVisualRun.droppedNoDetection,
                lowQuality: _ndWizVisualRun.lowQuality,
            } : null,
            beatsCollected: _ndWizBeats.length,
            detectionsCollected: _ndWizDetections.length,
            expectedBeats: expected,
        };
    });
    console.log(`[info] beats=${runResult.beatsCollected}/${runResult.expectedBeats} detections=${runResult.detectionsCollected} step=${runResult.step}`);
    if (runResult.visualRun) {
        const r = runResult.visualRun;
        console.log(`[ok] visual run finished: medianDt=${r.medianDt}ms used=${r.usedCount} hardCap=${r.droppedHardCap} noDet=${r.droppedNoDetection} lowQ=${r.lowQuality}`);
    } else {
        console.log('[FAIL] visual run did not finish — _ndWizVisualRun is null');
    }
    const runOk = runResult.visualRun
        && runResult.visualRun.medianDt !== null
        && runResult.visualRun.usedCount > 0;
    if (!runOk) {
        console.log('[FAIL] visual run completed but produced no usable median');
    } else {
        console.log(`[ok] button label would now read: "✓ ${Math.round(runResult.visualRun.medianDt)} ms"`);
    }

    // Step 7: relevant console output
    const ndLines = consoleLines.filter(l => /note_detect/i.test(l));
    if (ndLines.length) {
        console.log('--- plugin console output ---');
        for (const l of ndLines.slice(0, 12)) console.log('  ' + l);
    }

    await browser.close();
    process.exit(micUp && cardPresent && modalUp && runOk && kbdOk ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });

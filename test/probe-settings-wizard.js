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
    const micUp = audioState.ctxState === 'running' && audioState.wizardOwnsMic === true;
    if (!micUp) {
        console.log('[FAIL] mic pipeline did not boot from settings entry');
    } else {
        console.log('[ok] mic owned by wizard, ready for calibration');
    }

    // Step 6: relevant console output
    const ndLines = consoleLines.filter(l => /note_detect/i.test(l));
    if (ndLines.length) {
        console.log('--- plugin console output ---');
        for (const l of ndLines.slice(0, 12)) console.log('  ' + l);
    }

    await browser.close();
    process.exit(micUp && cardPresent && modalUp ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });

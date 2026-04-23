const puppeteer = require('puppeteer');
(async () => {
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    page.on('console', m => console.log('[browser]', m.text()));
    page.on('pageerror', e => console.error('[pageerror]', e.message));
    await page.goto('http://localhost:8088', { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.slopsmith, { timeout: 10_000 });
    await page.evaluate(async () => { await _ndLoadCrepe(); console.log('model=', _ndModel ? _ndModel.constructor.name : 'null'); });

    // Probe the model directly with a known A1 tone
    const result = await page.evaluate(async () => {
        if (!_ndModel) return { err: 'no model' };
        // Generate a 4096-sample 55 Hz sine wave at 48kHz
        const buf = new Float32Array(4096);
        for (let i = 0; i < 4096; i++) buf[i] = 0.3 * Math.sin(2 * Math.PI * 55 * i / 48000);
        try {
            const input = tf.tensor1d(buf);  // SPICE wants 1-D [-1]
            let outputs;
            if (_ndModel.execute) {
                outputs = _ndModel.execute(input);
                console.log('called execute()');
            } else {
                outputs = _ndModel.predict(input);
                console.log('called predict()');
            }
            const isArray = Array.isArray(outputs);
            console.log('outputs isArray=', isArray);
            const summaries = [];
            if (isArray) {
                for (let i = 0; i < outputs.length; i++) {
                    const d = await outputs[i].data();
                    summaries.push({ idx: i, shape: outputs[i].shape, dtype: outputs[i].dtype, length: d.length, first10: Array.from(d.slice(0, 10)) });
                }
                outputs.forEach(t => t.dispose());
            } else {
                const d = await outputs.data();
                summaries.push({ shape: outputs.shape, dtype: outputs.dtype, length: d.length, first20: Array.from(d.slice(0, 20)) });
                outputs.dispose();
            }
            input.dispose();
            return { ok: true, summaries };
        } catch (e) {
            return { err: e.message, stack: e.stack };
        }
    });
    console.log('result=', JSON.stringify(result, null, 2));
    await browser.close();
})();

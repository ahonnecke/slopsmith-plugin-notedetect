#!/usr/bin/env node
/* BASS_DETECTION.md DSP probe — find a pitch-verify that fixes open-string
 * BLEED (the band's single peak lands on the loud open string, not the fretted
 * note) WITHOUT hallucinating on misaligned/bombed audio.
 *
 * A good verifier maximises the GAP:  clean-aligned recall  high,
 *                                     misaligned recall      low.
 * We score each candidate on the SAME chart at the true offset and at a
 * deliberately wrong (+2500ms) offset.
 *
 *   node tools/probe-bleed.js --audio take.wav --chart chart.json --off 120
 */
'use strict';
const fs = require('fs');
const { parseArgs } = require('node:util');
const { loadDetectionCore } = require('../test/_loader');
const core = loadDetectionCore();

const { values: v } = parseArgs({ options: {
    audio: { type: 'string' }, chart: { type: 'string' },
    off: { type: 'string', default: '120' }, win: { type: 'string', default: '16384' },
    misoff: { type: 'string', default: '2500' }, perpitch: { type: 'boolean' },
} });
const WIN = Number(v.win);
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const nm = (m) => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

function readWavMono(path) {
    const b = fs.readFileSync(path);
    let off = 12, fmt = null, dataOff = -1, dataLen = 0;
    while (off + 8 <= b.length) {
        const id = b.toString('ascii', off, off + 4);
        const sz = b.readUInt32LE(off + 4);
        if (id === 'fmt ') fmt = { ch: b.readUInt16LE(off + 10), sr: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
        else if (id === 'data') { dataOff = off + 8; dataLen = sz; }
        off += 8 + sz + (sz & 1);
    }
    const { ch, bits } = fmt, bytes = bits / 8, n = Math.floor(dataLen / bytes / ch);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const p = dataOff + i * ch * bytes;
        out[i] = bits === 16 ? b.readInt16LE(p) / 32768 : b.readFloatLE(p);
    }
    return { samples: out, sr: fmt.sr };
}

const peakInRange = (mag, binHz, loHz, hiHz) => {
    const lo = Math.max(1, Math.floor(loHz / binHz)), hi = Math.min(mag.length - 1, Math.ceil(hiHz / binHz));
    let bb = lo, bv = -1;
    for (let b = lo; b <= hi; b++) if (mag[b] > bv) { bv = mag[b]; bb = b; }
    return { bin: bb, mag: bv, hz: bb * binHz };
};
const bandMaxMag = (mag, binHz, loHz, hiHz) => peakInRange(mag, binHz, loHz, hiHz).mag;
function comb(mag, binHz, f0, K, halfCents) {
    const r = Math.pow(2, halfCents / 1200); let s = 0;
    for (let k = 1; k <= K; k++) {
        const lo = Math.floor((k * f0 / r) / binHz), hi = Math.ceil((k * f0 * r) / binHz);
        let best = 0; for (let b = lo; b <= hi && b < mag.length; b++) if (mag[b] > best) best = mag[b];
        s += best * best;
    }
    return s;
}

// ── Candidate verifiers ─────────────────────────────────────────────────
// Each: (ctx) -> bool. ctx has mag, binHz, expHz, openHz, loHz, hiHz, band, bandPk.
const SEMI = (c) => Math.pow(2, c / 1200);
const VARIANTS = {
    'v0_singlepeak': (x) => { // current production behaviour
        const pk = peakInRange(x.mag, x.binHz, x.loHz, x.hiHz);
        const cents = Math.abs(foldOct(1200 * Math.log2(pk.hz / x.expHz)));
        return cents <= 60;
    },
    'v1_fund0.25': (x) => fundPeak(x, 100, 0.25),
    'v1_fund0.40': (x) => fundPeak(x, 100, 0.40),
    'v1_fund0.55': (x) => fundPeak(x, 100, 0.55),
    'v3_localmax0.40': (x) => fundLocalMax(x, 100, 0.40),
    // Harmonic coherence on the WELL-RESOLVED upper harmonics. A real note has
    // ratio-locked peaks at 2f0,3f0,4f0(,5f0); a coincidental fundamental
    // collision (bleed/cross-song) rarely reproduces the whole series.
    'h_up2of234@.25': (x) => harmCount(x, [2, 3, 4], 60, 0.25) >= 2,
    'h_up2of234@.35': (x) => harmCount(x, [2, 3, 4], 60, 0.35) >= 2,
    'h_up3of2345@.25': (x) => harmCount(x, [2, 3, 4, 5], 60, 0.25) >= 3,
    // Unified harmonic count over k=1..5 (fundamental included), local-max peaks.
    'hc_1of5@.40>=2': (x) => harmCount(x, [1, 2, 3, 4, 5], 80, 0.40) >= 2,
    'hc_1of5@.40>=3': (x) => harmCount(x, [1, 2, 3, 4, 5], 80, 0.40) >= 3,
    'hc_1of5@.30>=3': (x) => harmCount(x, [1, 2, 3, 4, 5], 80, 0.30) >= 3,
    // Union: bleed-robust fundamental OR upper-harmonic coherence — catch the
    // low-fundamental notes AND the bleed-masked-fundamental notes.
    'U_fund.40||up2.35': (x) => fundLocalMax(x, 100, 0.40) || harmCount(x, [2, 3, 4], 60, 0.35) >= 2,
    'U_fund.55||up2.30': (x) => fundLocalMax(x, 100, 0.55) || harmCount(x, [2, 3, 4], 60, 0.30) >= 2,
    // ADDITIVE (production-shaped): current cents check, OR for low fundamentals
    // (<140Hz) a harmonic-coherence fallback. Can only ADD hits to v0.
    'ADD_v0||lo.up2.35': (x) => VARIANTS.v0_singlepeak(x) || (x.expHz < 140 && harmCount(x, [2, 3, 4], 60, 0.35) >= 2),
    'ADD_v0||lo.up2.30': (x) => VARIANTS.v0_singlepeak(x) || (x.expHz < 140 && harmCount(x, [2, 3, 4], 60, 0.30) >= 2),
    'ADD_v0||lo.1of5.40>=3': (x) => VARIANTS.v0_singlepeak(x) || (x.expHz < 140 && harmCount(x, [1, 2, 3, 4, 5], 80, 0.40) >= 3),
};
// How many of the given harmonics k*f0 appear as a LOCAL-MAX peak whose
// magnitude is >= frac of the band peak, within ±halfCents of the ideal ratio.
function harmCount(x, ks, halfCents, frac) {
    let n = 0;
    for (const k of ks) {
        const f = x.expHz * k;
        const pk = peakInRange(x.mag, x.binHz, f / SEMI(halfCents), f * SEMI(halfCents));
        const b = pk.bin;
        const localMax = b > 0 && b < x.mag.length - 1 && x.mag[b] >= x.mag[b - 1] && x.mag[b] >= x.mag[b + 1];
        if (pk.mag >= frac * x.bandPk && localMax) n++;
    }
    return n;
}
function foldOct(c) { while (c > 600) c -= 1200; while (c < -600) c += 1200; return c; }
// Peak inside ±half-step of the expected fundamental must be >= frac of the band peak.
function fundPeak(x, halfCents, frac) {
    const pk = peakInRange(x.mag, x.binHz, x.expHz / SEMI(halfCents), x.expHz * SEMI(halfCents));
    return pk.mag >= frac * x.bandPk;
}
// Same, but the in-window peak must also be a local maximum (real component, not a shoulder).
function fundLocalMax(x, halfCents, frac) {
    const pk = peakInRange(x.mag, x.binHz, x.expHz / SEMI(halfCents), x.expHz * SEMI(halfCents));
    if (pk.mag < frac * x.bandPk) return false;
    const b = pk.bin;
    return b > 0 && b < x.mag.length - 1 && x.mag[b] >= x.mag[b - 1] && x.mag[b] >= x.mag[b + 1];
}

const { samples, sr } = readWavMono(v.audio);
const notes = JSON.parse(fs.readFileSync(v.chart)).notes.filter((n) => !n.mt);

function evalAt(offMs) {
    const off = offMs / 1000;
    const res = {}; for (const k of Object.keys(VARIANTS)) res[k] = 0;
    const pp = {};
    for (const nt of notes) {
        const c = Math.round((nt.t + off) * sr), lo = Math.max(0, c - (WIN >> 1));
        const buf = samples.subarray(lo, lo + WIN);
        if (buf.length < WIN) continue;
        const { magnitudes: mag, binHz } = core.fftMagnitude(buf, sr);
        const expMidi = core.midiFromStringFret(nt.s, nt.f, 'bass', 4);
        const expHz = 440 * Math.pow(2, (expMidi - 69) / 12);
        const openMidi = core.midiFromStringFret(nt.s, 0, 'bass', 4);
        const openHz = 440 * Math.pow(2, (openMidi - 69) / 12);
        const [loHz, hiHz] = core.stringBandHz(nt.s, 'bass', 4, [0, 0, 0, 0], 0);
        const band = core.bandEnergy(mag, binHz, loHz, hiHz);
        const bandPk = bandMaxMag(mag, binHz, loHz, hiHz);
        const x = { mag, binHz, expHz, openHz, loHz, hiHz, band, bandPk };
        const gate = band >= 0.015;
        for (const [k, fn] of Object.entries(VARIANTS)) {
            const hit = gate && fn(x);
            if (hit) res[k]++;
            (pp[expMidi] = pp[expMidi] || {})[k] = ((pp[expMidi] || {})[k] || 0) + (hit ? 1 : 0);
            pp[expMidi]._t = (pp[expMidi]._t || 0) + 1;
        }
    }
    return { res, pp };
}

const N = notes.length;
const clean = evalAt(Number(v.off));
const mis = evalAt(Number(v.misoff));
console.log(`win=${WIN}  notes=${N}  clean@${v.off}ms  misalign@${v.misoff}ms`);
console.log('variant'.padEnd(20), 'clean'.padEnd(12), 'misalign'.padEnd(12), 'gap');
for (const k of Object.keys(VARIANTS)) {
    const cl = clean.res[k], ms = mis.res[k];
    console.log(k.padEnd(20),
        `${cl}/${N} ${Math.round(100 * cl / N)}%`.padEnd(12),
        `${ms}/${N} ${Math.round(100 * ms / N)}%`.padEnd(12),
        `${Math.round(100 * (cl - ms) / N)}`);
}
if (v.perpitch) {
    console.log('\nper-pitch (clean):');
    for (const m of Object.keys(clean.pp).map(Number).sort((a, b) => a - b)) {
        const g = clean.pp[m];
        console.log(`  ${nm(m)} ${Math.round(440 * 2 ** ((m - 69) / 12))}Hz t=${g._t}  ` +
            Object.keys(VARIANTS).map((k) => `${k.split('_')[0]}:${g[k] || 0}`).join(' '));
    }
}

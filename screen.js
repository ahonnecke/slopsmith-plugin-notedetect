// Note Detection plugin
//
// Factory pattern — `createNoteDetector(options)` returns an independent
// detector instance with its own audio pipeline, scoring, HUD, timers,
// draw hook, and DOM subtree. A default singleton (`window.noteDetect`)
// is created on load for the standard single-panel case; additional
// instances can be constructed via `window.createNoteDetector(...)` by
// plugins like splitscreen that need per-panel detection.
//
// Originally proposed by topkoa in PR #2 on this repo; this takeover
// re-applies the factory design on top of 5-string-bass (#14),
// per-note hit/miss events (#12), CI (#13), and HPS (#15) which all
// landed after his branch diverged. Co-Authored-By: topkoa.
//
// ── What this revision adds and why ───────────────────────────────────────
//
// BACKGROUND: WHY CHORD DETECTION NEEDED A DIFFERENT APPROACH
//
// YIN, HPS, and CREPE are all monophonic pitch detectors — they return one
// frequency from the full mixed signal. That works well for single notes, but
// a guitar chord produces 2–6 simultaneous fundamentals plus their harmonics
// all overlapping in the spectrum. The detectors lock onto whichever string
// is loudest (usually the lowest) and score the whole chord against that one
// pitch, silently missing every other note. This revision adds a parallel
// detection path for chords that avoids the problem entirely.
//
// The core insight (from a design brief accompanying this change): instead of
// asking "what pitch is playing?" — which is hard for chords — ask "is there
// energy near the frequency I *expect* on string S right now?" That is a much
// simpler question. Because the arrangement XML already tells us exactly which
// string plays which fret at every moment, we can compute the expected
// frequency per string and check for it independently in that string's
// frequency band. This turns one hard polyphonic detection problem into N easy
// monophonic band-energy checks, one per string.
//
// The existing YIN/HPS/CREPE path is left completely intact for single notes,
// where it already works well. The constraint path is additive: it activates
// only when the chart has ≥2 simultaneous notes in the timing window.
//
// ── CHANGE 1: 8-string guitar tuning ─────────────────────────────────────
//
// _ND_TUNING_GUITAR_8 added: [30, 35, 40, 45, 50, 55, 59, 64]
// That is F#1 B1 E2 A2 D3 G3 B3 E4 — standard Ibanez/Schecter 8-string
// tuning, a perfect fourth below the 7-string low B.
//
// _ndStandardMidiFor() now branches on stringCount === 8 before the existing
// 7-string check. Every downstream function — MIDI mapping, display labels,
// and the new constraint band calculator — derives from this table, so no
// other callsites required changes.
//
// ── CHANGE 2: Dynamic string-count sizing (prerequisite for changes 1 & 3) ─
//
// Previously, `tuningOffsets` was initialised as a hardcoded 6-element array
// and never resized. Every call that passed `tuningOffsets.length` as the
// stringCount argument to mapping helpers was therefore always passing 6,
// regardless of what instrument was actually loaded. This silently produced
// wrong frequency bands for 5-string bass, 7-string guitar, and would have
// been completely broken for 8-string guitar.
//
// Fix: a new `currentStringCount` variable is set at enable() time from
// `hw.getSongInfo().tuning.length` — the authoritative source. All three
// call sites that were passing `tuningOffsets.length` into mapping helpers
// now use `currentStringCount` instead. This was a prerequisite for both
// 8-string support and for the constraint checker computing correct frequency
// bands on non-6-string instruments.
//
// ── CHANGE 3: Constraint-based chord detection ────────────────────────────
//
// Three new module-level functions (after _ndHpsDetect, before _ndLoadCrepe):
//
//   _ndStringBandHz(stringIdx, arrangement, stringCount, offsets, capo)
//     Returns [loHz, hiHz] for a given string covering frets 0–24, with ±10%
//     headroom for tuning offsets, capo, and bent notes. Derived from the
//     tuning tables rather than hardcoded, so all instrument types are covered.
//
//   _ndBandEnergy(magnitudes, binHz, loHz, hiHz)
//     Measures the fraction of total spectrum energy (0..1) that falls in a
//     frequency band, operating on the magnitude spectrum from _ndFftMagnitude.
//     NOTE: reuses the module-level FFT scratch buffers (_ndFftInterleavedScratch,
//     _ndFftMagnitudesScratch). This is safe because the FFT is synchronous and
//     JS is single-threaded — see the existing comment on those buffers. If this
//     code is ever moved to an AudioWorklet or Web Worker, per-call scratch
//     buffers would be needed instead.
//
//   _ndConstraintCheckString(buffer, sampleRate, stringIdx, fret, ...)
//     The core per-string check. Calls _ndFftMagnitude once (which reuses the
//     scratch), measures band energy for this string's frequency range, and
//     optionally verifies that the dominant bin in the band is within
//     pitchCheckCents of the expected frequency. Returns { hit, bandEnergy,
//     centsDiff }. energyThreshold and pitchCheckCents are caller-adjustable
//     to support technique-specific loosening (see change 4).
//
//   _ndScoreChord(buffer, sampleRate, chordNotes, ..., minHitRatio)
//     Runs _ndConstraintCheckString for each note in a chord group, applies
//     per-technique threshold adjustments (see change 4), and returns
//     { score, hitStrings, totalStrings, results, isHit } where isHit is
//     true if score >= minHitRatio.
//
// ROUTING IN matchNotes():
//   Candidate notes (from the chart's timing window) are now bucketed by
//   timestamp. A bucket with 1 note goes through the existing MIDI comparison
//   against the YIN/HPS/CREPE result, unchanged. A bucket with ≥2 notes goes
//   through _ndScoreChord using `pendingBuffer` — the same accumulated audio
//   buffer that was handed to processFrame on the current tick. Each string's
//   individual result is stored in noteResults so the draw overlay can colour
//   fret gems per-note. The chord hit/miss is counted as a single judgment
//   and fires a notedetect:hit event with { chord: true, hitStrings,
//   totalStrings, score } instead of the usual { note, expectedMidi }.
//
// ── CHANGE 4: Technique-aware thresholds ─────────────────────────────────
//
// The arrangement XML includes technique flags on individual notes. _ndScoreChord
// reads these from the chord note objects and adjusts thresholds before calling
// _ndConstraintCheckString:
//
//   ho / po (hammer-on / pull-off)
//     No fresh pick attack, so string energy will be lower than a picked note.
//     energyThreshold is halved from 0.03 to 0.015.
//
//   b / sl (bend / slide)
//     Pitch is moving continuously during the note. pitchCheckCents is widened
//     to at least 100 cents (a semitone) so a note mid-bend still registers.
//
//   hm (harmonic)
//     The fundamental is suppressed; the audible pitch is at 2x or 1.5x the
//     fret frequency. Pitch checking against the fundamental is unreliable, so
//     pitchCheckCents is set to 0 (energy-only check). A proper harmonic
//     frequency check (checking at 2x/1.5x) is a known TODO — see the comment
//     inside _ndScoreChord.
//
// ── CHANGE 5: chordHitRatio setting ──────────────────────────────────────
//
// The fraction of a chord's strings that must register energy to count as a
// hit. Default 0.6 (60% — e.g. 4 of 6 strings for a full barre chord). Lower
// values suit beginners or players using lighter touches on inner strings;
// higher values enforce stricter accuracy.
//
// Exposed in the settings panel as "Chord Leniency" (slider: 25–100%).
// Persisted in localStorage under the existing _ND_STORAGE_KEY alongside all
// other settings. Loaded and clamped to [0.25, 1] on construction so a stale
// persisted value can't put scoring in a state the slider can't represent.
//
// ── CHANGE 6: HUD chord display ──────────────────────────────────────────
//
// The cyan detected-note line in the HUD (`.nd-hud-detected`) previously only
// showed output when a confident single-note detection existed. It now also
// shows the most recent chord constraint result when no single note is detected,
// e.g. "chord 4/6 (66%)". This gives the player real-time visibility into
// whether the constraint scorer is seeing their strings ring, which is useful
// for diagnosing audio input issues and tuning the Chord Leniency setting.
// lastChordScore / lastChordHit / lastChordTotal are reset with the rest of
// scoring state in resetScoring().

// ── Module-level shared state ──────────────────────────────────────────────

// Shared state anchored on `window` so multiple evaluations of this
// file (HMR, accidental double <script> load) all see the same
// registry and model-load state. A bare module-scoped Set would let
// the second evaluation register its detectors into a fresh set
// while the first evaluation's live playSong wrapper iterates the
// old set — breaking song-switch disable/reset on any detector
// created by the second eval.
//
// `_ndShared` is initialised once; subsequent evaluations reuse the
// existing object. All mutable shared state (CREPE model, loading
// flag, instance registry, playSong-hook retry counter) lives on it
// so reassignments land on the canonical object, not on a fresh
// module-scope copy.
const _ndShared = (window.__ndShared = window.__ndShared || {
    model: null,          // CREPE/SPICE model (single ~20 MB load)
    modelLoading: false,
    instances: new Set(), // live detector APIs — iterated by playSong hook
    playSongRetries: 0,   // bounded-retry counter for _ndInstallPlaySongHook
});
// Local aliases — kept for readability of the rest of the file, but
// they're the same objects as `window.__ndShared.*`.
const _ndInstances = _ndShared.instances;

// (The playSong wrapper's idempotency guard lives on the wrapper
// function object itself — see `_ndInstallPlaySongHook()` below —
// so it persists across HMR / double-<script>-load where a
// module-level flag would be reset.)

const _ND_STORAGE_KEY = 'slopsmith_notedetect';
// Separate localStorage key for "have we ever seeded avOffset from
// AudioContext.outputLatency for this user?" Once set, never seed
// again — the user's avOffset is theirs to manage from that point on.
// Reset by clearing localStorage or via the gear panel "Reset" button.
const _ND_AVOFFSET_SEEDED_KEY = 'slopsmith_notedetect_avoffset_seeded';

// Pure: compute the seed value for avOffset from AudioContext output
// latency. Returns ms (negative — chart needs to fire earlier to
// compensate for output delay reaching the user). Returns null when
// the input is unusable (no context, missing prop, zero latency).
function _ndAvOffsetSeed(audioCtxLike) {
    if (!audioCtxLike) return null;
    const outputLatency = audioCtxLike.outputLatency;
    if (typeof outputLatency !== 'number' || !Number.isFinite(outputLatency)) return null;
    if (outputLatency <= 0) return null;
    // seconds → ms, negate for compensation
    return -Math.round(outputLatency * 1000);
}

function _ndSeedAvOffsetIfFresh(audioCtxLike) {
    let seeded = false;
    try { seeded = localStorage.getItem(_ND_AVOFFSET_SEEDED_KEY) === '1'; } catch (e) {}
    if (seeded) return null;
    const seedMs = _ndAvOffsetSeed(audioCtxLike);
    if (seedMs == null) return null;
    if (typeof window !== 'undefined' && typeof window.setAvOffsetMs === 'function') {
        window.setAvOffsetMs(seedMs);
    } else {
        return null;  // no slopsmith setter — bail (sandbox/tests)
    }
    try { localStorage.setItem(_ND_AVOFFSET_SEEDED_KEY, '1'); } catch (e) {}
    console.log(`[note_detect] avOffset seeded from AudioContext.outputLatency: ${seedMs}ms`);
    return seedMs;
}

// ── Two-axis scoring thresholds ────────────────────────────────────────────
//
// Score is two independent numbers — Detection ("did you play it") and
// Precision ("how tight"). Detection uses wide thresholds; Precision uses
// tight thresholds. The strictness-preset abstraction the pre-port code
// used (rocksmith / easy / default / strict) is retired: it conflated
// "did the player play the right note" (binary) with "how tightly did
// they play it" (continuous). On bass-via-mic, strict-mode 25¢ pitch
// tolerance produced ~50% scores on clean plays because mic-captured
// bass has natural pitch wobble — a HIT and a 30¢-off HIT became
// identical (both MISS), even though the failure modes are different.
const _ND_DETECTION_PITCH_CENTS = 200;
const _ND_DETECTION_TIMING_SEC  = 0.300;
const _ND_PRECISION_PITCH_CENTS = 25;
const _ND_PRECISION_TIMING_MS   = 50;
// Dirty-hit threshold (fraction of off-target YIN frames in the hit
// window). HITs above this downgrade to DIRTY_HIT — represents
// "the right note sometimes, but with audible contamination."
const _ND_DIRTY_HIT_MAX_OFF_RATIO = 0.5;

// Audio processing constants
const _ND_MIN_YIN_SAMPLES = 4096;  // enough for low E at 48kHz (need tau=585, halfLen=2048)
const _ND_FRAME_SIZE = 2048;       // ScriptProcessor buffer size

// Tuning tables — standard-tuning MIDI base per (arrangement, stringCount).
//
// Bass ascends in perfect fourths end-to-end; guitar is fourths except
// the major third between G3→B3 (the standard irregularity). Low B on
// 5-string bass and 7-string guitar both add a perfect fourth below
// the standard low-E string. 8-string guitar adds a further low F#1
// below that (a perfect fourth below B1), matching the most common
// Ibanez/Schecter 8-string standard tuning.
const _ND_TUNING_BASS_4 = [28, 33, 38, 43];                   // E1 A1 D2 G2
const _ND_TUNING_BASS_5 = [23, 28, 33, 38, 43];               // B0 E1 A1 D2 G2
const _ND_TUNING_GUITAR_6 = [40, 45, 50, 55, 59, 64];         // E2 A2 D3 G3 B3 E4
const _ND_TUNING_GUITAR_7 = [35, 40, 45, 50, 55, 59, 64];     // B1 E2 A2 D3 G3 B3 E4
const _ND_TUNING_GUITAR_8 = [30, 35, 40, 45, 50, 55, 59, 64]; // F#1 B1 E2 A2 D3 G3 B3 E4

function _ndArrangementKindFromName(name) {
    return /bass/i.test(String(name || '')) ? 'bass' : 'guitar';
}

function _ndStandardMidiFor(arrangement, stringCount) {
    if (arrangement === 'bass') {
        return stringCount === 5 ? _ND_TUNING_BASS_5 : _ND_TUNING_BASS_4;
    }
    if (stringCount === 8) return _ND_TUNING_GUITAR_8;
    if (stringCount === 7) return _ND_TUNING_GUITAR_7;
    return _ND_TUNING_GUITAR_6;
}

// ── Pure mapping helpers ───────────────────────────────────────────────────
// All take state (arrangement, stringCount, offsets, capo) as explicit args
// so they remain safe to call across multiple instances with different
// tunings. No module-level mutable fallbacks — the factory closure passes
// its own state in.

function _ndFreqToMidi(freq) {
    return 12 * Math.log2(freq / 440) + 69;
}

// MIDI → scientific pitch name (e.g. 40 → "E2"). Rounds to the nearest
// semitone. Used by the HUD so the "detected note" label is correct
// regardless of arrangement, tuning offsets, or capo — the previous
// implementation hardcoded `['E2','A2','D3','G3','B3','E4']` indexed
// by string, which mislabelled every bass / 7-string / retuned note.
const _ND_PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function _ndMidiToName(midi) {
    const rounded = Math.round(midi);
    const pc = ((rounded % 12) + 12) % 12;
    const octave = Math.floor(rounded / 12) - 1;
    return _ND_PITCH_NAMES[pc] + octave;
}

function _ndMidiFromStringFret(string, fret, arrangement, stringCount, offsets, capo) {
    const base = _ndStandardMidiFor(arrangement, stringCount);
    const offset = offsets && offsets[string] !== undefined ? offsets[string] : 0;
    return base[string] + offset + (capo || 0) + fret;
}

function _ndClassifyTiming(timingErrorMs, timingThresholdMs) {
    if (!Number.isFinite(timingErrorMs)) return null;
    return Math.abs(timingErrorMs) <= timingThresholdMs
        ? 'OK'
        : (timingErrorMs < 0 ? 'EARLY' : 'LATE');
}

function _ndClassifyPitch(pitchErrorCents, pitchThresholdCents) {
    if (!Number.isFinite(pitchErrorCents)) return null;
    return Math.abs(pitchErrorCents) <= pitchThresholdCents
        ? 'OK'
        : (pitchErrorCents > 0 ? 'SHARP' : 'FLAT');
}

function _ndMakeJudgment(opts) {
    const o = opts || {};
    const matched = !!o.matched;
    const timingError = matched && Number.isFinite(o.judgedAt) && Number.isFinite(o.noteTime)
        ? Math.round((o.judgedAt - o.noteTime) * 1000)
        : null;
    const pitchError = matched && Number.isFinite(o.pitchError)
        ? Math.round(o.pitchError)
        : null;
    // Two-axis judgment thresholds (Unit 1's promise, finally honored
    // here): the WIDE threshold drives hit-vs-miss (Detection score),
    // the TIGHT threshold drives the LATE/EARLY/SHARP/FLAT labels
    // (Precision score). A loose-but-on-target hit (e.g. 80ms late
    // with 200ms wide threshold) becomes "HIT with LATE label", not
    // MISS. Earlier port of _ndMakeJudgment used a single
    // timingThresholdMs collapsed to the precision value, which marked
    // anything outside ±50ms as missed and produced the detection
    // regression the user reported.
    //
    // Backwards-compat: callers passing only timingThresholdMs /
    // pitchThresholdCents fall back to the old single-threshold
    // behavior (treats both hit and label thresholds as that value).
    const timingHitThresholdMs = Number.isFinite(o.timingHitThresholdMs)
        ? o.timingHitThresholdMs
        : (Number.isFinite(o.timingThresholdMs) ? o.timingThresholdMs : 100);
    const pitchHitThresholdCents = Number.isFinite(o.pitchHitThresholdCents)
        ? o.pitchHitThresholdCents
        : (Number.isFinite(o.pitchThresholdCents) ? o.pitchThresholdCents : 20);
    const timingPrecisionMs = Number.isFinite(o.timingPrecisionMs)
        ? o.timingPrecisionMs
        : timingHitThresholdMs;
    const pitchPrecisionCents = Number.isFinite(o.pitchPrecisionCents)
        ? o.pitchPrecisionCents
        : pitchHitThresholdCents;
    // Hit decision uses the WIDE thresholds (Detection score path).
    const timingHit = matched ? _ndClassifyTiming(timingError, timingHitThresholdMs) : null;
    const pitchHit = matched ? _ndClassifyPitch(pitchError, pitchHitThresholdCents) : null;
    // Label classification uses the TIGHT thresholds (Precision score
    // path) — fires LATE/EARLY/SHARP/FLAT for a hit that passed the
    // wide gate but fell outside the precision zone.
    const timingState = matched ? _ndClassifyTiming(timingError, timingPrecisionMs) : null;
    const pitchState = matched ? _ndClassifyPitch(pitchError, pitchPrecisionCents) : null;
    // pitchState === null means pitch was not measured (e.g. energy-only chord
    // check or harmonic flag).  Treat unmeasured pitch as non-blocking so a
    // chord that passes the scorer is not incorrectly counted as a miss.
    const hit = timingHit === 'OK' && (pitchHit === 'OK' || pitchHit === null);
    return {
        chartNote: o.chartNote || o.note || null,
        note: o.note || null,
        notes: o.notes || null,
        chord: !!o.chord,
        hit,
        timingState,
        timingError,
        pitchState,
        pitchError,
        detectedFreq: Number.isFinite(o.detectedFreq) ? o.detectedFreq : null,
        expectedFreq: Number.isFinite(o.expectedFreq) ? o.expectedFreq : null,
        detectedAt: matched && Number.isFinite(o.judgedAt) ? o.judgedAt : null,
        time: Number.isFinite(o.judgedAt) ? o.judgedAt : null,
        noteTime: Number.isFinite(o.noteTime) ? o.noteTime : null,
        expectedMidi: Number.isFinite(o.expectedMidi) ? o.expectedMidi : null,
        detectedMidi: Number.isFinite(o.detectedMidi) ? o.detectedMidi : null,
        confidence: Number.isFinite(o.confidence) ? o.confidence : 0,
        hitStrings: Number.isFinite(o.hitStrings) ? o.hitStrings : undefined,
        totalStrings: Number.isFinite(o.totalStrings) ? o.totalStrings : undefined,
        score: Number.isFinite(o.score) ? o.score : undefined,
        monophonicDetected: o.monophonicDetected,
    };
}

function _ndMidiToStringFret(midiNote, arrangement, stringCount, offsets, capo) {
    // Pure geometric fallback: walk strings 0..N and return the first position
    // that matches the pitch. Used when there is no chart context available
    // (player noodling between chart notes). When a chart note is in play,
    // _ndResolveDisplayFingering picks the chart's (s, f) instead — see the
    // research notes in mapping-bass.test.js.
    const base = _ndStandardMidiFor(arrangement, stringCount);
    let bestDist = Infinity;
    let bestString = -1;
    let bestFret = -1;
    for (let s = 0; s < base.length; s++) {
        const offset = offsets && offsets[s] !== undefined ? offsets[s] : 0;
        const openMidi = base[s] + offset + (capo || 0);
        const fret = Math.round(midiNote - openMidi);
        if (fret < 0 || fret > 24) continue;
        const dist = Math.abs(midiNote - (openMidi + fret));
        if (dist < bestDist) {
            bestDist = dist;
            bestString = s;
            bestFret = fret;
        }
    }
    return { string: bestString, fret: bestFret };
}

function _ndFoldOctaveCents(cents) {
    if (!Number.isFinite(cents)) return Infinity;
    return cents - (Math.round(cents / 1200) * 1200);
}

function _ndNearestOctaveCents(detectedMidi, expectedMidi) {
    if (!Number.isFinite(detectedMidi) || !Number.isFinite(expectedMidi)) return Infinity;
    return _ndFoldOctaveCents((detectedMidi - expectedMidi) * 100);
}

// Chart-context-aware fingering resolver. If any candidate chart note's
// expected pitch is within the pitch tolerance of the detected MIDI (allowing
// whole-octave detector mistakes), return that note's (string, fret) — the
// player is hitting the charted fingering. Otherwise fall back to the
// geometric first-match on the arrangement's tuning. This mirrors what
// score-follower apps (e.g. Rocksmith) do: trust the chart for display when
// the player is on-pitch, only guess when they aren't.
function _ndResolveDisplayFingering(detectedMidi, candidateNotes, arrangement, stringCount, offsets, capo, pitchToleranceCents) {
    if (candidateNotes && candidateNotes.length > 0) {
        for (const cn of candidateNotes) {
            const expected = _ndMidiFromStringFret(cn.s, cn.f, arrangement, stringCount, offsets, capo);
            if (Math.abs(_ndNearestOctaveCents(detectedMidi, expected)) <= pitchToleranceCents) {
                return { string: cn.s, fret: cn.f, displayMidi: expected };
            }
        }
    }
    const fallback = _ndMidiToStringFret(detectedMidi, arrangement, stringCount, offsets, capo);
    return { string: fallback.string, fret: fallback.fret, displayMidi: detectedMidi };
}

// ── Pitch Detection: YIN ───────────────────────────────────────────────────
// Lightweight monophonic pitch detector — works instantly, no model to load.

// Lowest frequency we claim to detect. Below this and YIN's autocorrelation
// window needs to be longer than the input — at 48 kHz a 30 Hz period is
// ~1600 samples, so halfLen must exceed that, i.e. buffer must exceed ~3200.
const _ND_MIN_DETECTABLE_HZ = 30;

function _ndYinDetect(buffer, sampleRate, minFreqHz = _ND_MIN_DETECTABLE_HZ) {
    const threshold = 0.15;
    const halfLen = Math.floor(buffer.length / 2);
    const yinBuffer = new Float32Array(halfLen);

    // Surface "too-small buffer" as a distinct state from "no note detected"
    // so callers (and tests) can tell the two apart. Without this, a broken
    // accumulation path silently drops every bass note.
    const minHalfLenForFreq = Math.ceil(sampleRate / minFreqHz);
    const underBuffered = halfLen < minHalfLenForFreq;

    // Difference function
    let runningSum = 0;
    yinBuffer[0] = 1;
    for (let tau = 1; tau < halfLen; tau++) {
        let sum = 0;
        for (let i = 0; i < halfLen; i++) {
            const delta = buffer[i] - buffer[i + tau];
            sum += delta * delta;
        }
        yinBuffer[tau] = sum;
        runningSum += sum;
        yinBuffer[tau] *= tau / runningSum; // cumulative mean normalized
    }

    // Absolute threshold
    let tau = 2;
    while (tau < halfLen) {
        if (yinBuffer[tau] < threshold) {
            while (tau + 1 < halfLen && yinBuffer[tau + 1] < yinBuffer[tau]) tau++;
            break;
        }
        tau++;
    }
    if (tau === halfLen) return { freq: -1, confidence: 0, underBuffered };

    // Parabolic interpolation
    const s0 = tau > 0 ? yinBuffer[tau - 1] : yinBuffer[tau];
    const s1 = yinBuffer[tau];
    const s2 = tau + 1 < halfLen ? yinBuffer[tau + 1] : yinBuffer[tau];
    const betterTau = tau + (s0 - s2) / (2 * (s0 - 2 * s1 + s2));

    const freq = sampleRate / betterTau;
    const confidence = 1 - yinBuffer[tau];
    return { freq, confidence: Math.max(0, confidence), underBuffered };
}

// ── Pitch Detection: Shared FFT helper ─────────────────────────────────────
// Real-valued FFT via Cooley-Tukey radix-2, in-place on interleaved
// complex arrays. Currently used by HPS; factored out as a helper so
// future frequency-domain detectors (e.g. cepstrum) can reuse it.
// ~80 lines of dependency-free JS to preserve notedetect's zero-deps
// principle.

// Next power-of-two ≥ n. FFT sizes must be powers of two; the input
// buffer is zero-padded up to this length before transforming.
function _ndNextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}

// In-place radix-2 Cooley-Tukey on interleaved {re, im} pairs.
// `data` has length 2*N (N real/imag pairs). `direction` is +1 for
// forward (standard DFT sign: exp(-i·2π·k·n/N)) and -1 for inverse. No
// normalization here; callers divide by N themselves when they want
// the inverse to be an average.
function _ndFftInPlace(data, direction) {
    const nPairs = data.length >> 1;
    // Bit-reversal permutation — puts inputs in the order the butterfly
    // stages expect.
    for (let i = 1, j = 0; i < nPairs; i++) {
        let bit = nPairs >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            const ir = 2 * i, jr = 2 * j;
            let tmp = data[ir];     data[ir] = data[jr];     data[jr] = tmp;
            tmp = data[ir + 1]; data[ir + 1] = data[jr + 1]; data[jr + 1] = tmp;
        }
    }
    // Butterfly stages. Negate the angle for direction=+1 so the
    // twiddle exp(i·angle) carries the standard forward-DFT negative
    // sign; direction=-1 yields the positive sign for inverse use.
    for (let len = 2; len <= nPairs; len <<= 1) {
        const halfLen = len >> 1;
        const angle = -direction * 2 * Math.PI / len;
        const wRe = Math.cos(angle);
        const wIm = Math.sin(angle);
        for (let i = 0; i < nPairs; i += len) {
            let twRe = 1, twIm = 0;
            for (let k = 0; k < halfLen; k++) {
                const evenIdx = 2 * (i + k);
                const oddIdx = 2 * (i + k + halfLen);
                const oRe = data[oddIdx] * twRe - data[oddIdx + 1] * twIm;
                const oIm = data[oddIdx] * twIm + data[oddIdx + 1] * twRe;
                data[oddIdx]     = data[evenIdx]     - oRe;
                data[oddIdx + 1] = data[evenIdx + 1] - oIm;
                data[evenIdx]     = data[evenIdx]     + oRe;
                data[evenIdx + 1] = data[evenIdx + 1] + oIm;
                const nextTwRe = twRe * wRe - twIm * wIm;
                twIm = twRe * wIm + twIm * wRe;
                twRe = nextTwRe;
            }
        }
    }
}

// Hann window + zero-pad + forward FFT → magnitude spectrum.
// Returns `{ magnitudes, binHz, fftSize }` so callers can map bin → Hz
// directly. Magnitude length is fftSize/2 + 1 (Nyquist-inclusive).
//
// Reuses scratch buffers across calls — at ~20 fps a per-frame pair of
// Float32Array allocations (32 kB interleaved + 32 kB magnitudes at
// 48 kHz / 16384 fftSize) becomes real GC pressure. We re-allocate
// only when fftSize changes. These module-level scratch buffers are
// shared by every detector instance, which is safe only because
// FFT work here is fully synchronous and JS runs on one thread — the
// scratch is written and read to completion before any other instance
// (or any async continuation) can enter. Each factory instance has
// its own `processingFrame` in-flight guard that serializes its own
// calls; concurrent calls from *different* instances never interleave
// inside `_ndFftMagnitude` because there are no awaits inside it.
// An async/parallel future (Web Workers, AudioWorklet with real
// re-entrancy) would need per-instance or per-call scratch instead.
let _ndFftInterleavedScratch = null;
let _ndFftMagnitudesScratch = null;
let _ndFftScratchSize = 0;

// HPS scratch — reallocated only when highBin changes. Same GC-pressure
// rationale as the FFT buffers above.
let _ndHpsScratch = null;
let _ndHpsScratchSize = 0;

function _ndFftMagnitude(buffer, sampleRate) {
    // Target ~3 Hz bin width regardless of device sample rate. A fixed
    // floor (e.g. 16384) would degrade to ~5.86 Hz/bin at 96 kHz and
    // reintroduce the low-B binning problem (30.87 Hz ≈ bin 5.27 with
    // ~90 cents of drift even after parabolic interpolation). Deriving
    // the floor from sampleRate keeps the fundamental resolvable on
    // 5-string bass across any rate a modern audio interface serves.
    const TARGET_BIN_HZ = 3;
    const resolutionFloor = _ndNextPow2(Math.ceil(sampleRate / TARGET_BIN_HZ));
    const fftSize = Math.max(_ndNextPow2(buffer.length), resolutionFloor);
    const halfBins = (fftSize >> 1) + 1;

    if (_ndFftScratchSize !== fftSize) {
        _ndFftInterleavedScratch = new Float32Array(2 * fftSize);
        _ndFftMagnitudesScratch = new Float32Array(halfBins);
        _ndFftScratchSize = fftSize;
    }
    const interleaved = _ndFftInterleavedScratch;
    const magnitudes = _ndFftMagnitudesScratch;
    // Zero the scratch — windowed buffer fills only the first 2*buffer.length
    // slots, but the FFT reads the whole array.
    interleaved.fill(0);

    // Hann-window the real part, leave imag as zero. Windowing reduces
    // spectral leakage from a finite-length buffer.
    for (let i = 0; i < buffer.length; i++) {
        const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (buffer.length - 1)));
        interleaved[2 * i] = buffer[i] * w;
    }
    _ndFftInPlace(interleaved, 1);
    for (let k = 0; k < halfBins; k++) {
        const re = interleaved[2 * k];
        const im = interleaved[2 * k + 1];
        magnitudes[k] = Math.sqrt(re * re + im * im);
    }
    return { magnitudes, binHz: sampleRate / fftSize, fftSize };
}

// Parabolic interpolation over a 3-sample peak — returns a sub-sample
// offset `delta` in [-1, 1] that refines the peak location. Clamps to
// ±1 so a near-zero denom can't produce a runaway offset that lands the
// corrected peak in a neighboring bin.
function _ndParabolicOffset(yPrev, yPeak, yNext) {
    const denom = yPrev - 2 * yPeak + yNext;
    if (Math.abs(denom) < 1e-12) return 0;
    const delta = 0.5 * (yPrev - yNext) / denom;
    if (delta > 1) return 1;
    if (delta < -1) return -1;
    return delta;
}

// ── Pitch Detection: HPS (Harmonic Product Spectrum) ───────────────────────
// Frequency-domain detector designed for bass signals with a suppressed
// fundamental — amp-sim DIs, small-speaker playback, heavily compressed
// tones all commonly roll off below ~60 Hz. YIN's time-domain
// autocorrelation locks onto the 2nd harmonic in that case and reports
// the pitch one octave high; HPS multiplies together downsampled copies
// of the magnitude spectrum so the bins at the fundamental reinforce
// even when that fundamental is weak.
function _ndHpsDetect(buffer, sampleRate, minFreqHz = _ND_MIN_DETECTABLE_HZ) {
    const halfLen = Math.floor(buffer.length / 2);
    const minHalfLenForFreq = Math.ceil(sampleRate / minFreqHz);
    const underBuffered = halfLen < minHalfLenForFreq;
    if (underBuffered) return { freq: -1, confidence: 0, underBuffered };

    const { magnitudes, binHz } = _ndFftMagnitude(buffer, sampleRate);
    const nBins = magnitudes.length;
    const harmonics = 3;
    const maxFreqHz = 2000;
    const lowBin = Math.max(1, Math.floor(minFreqHz / binHz));
    const highBin = Math.min(Math.floor((nBins - 1) / harmonics),
                             Math.floor(maxFreqHz / binHz));
    if (highBin <= lowBin) return { freq: -1, confidence: 0, underBuffered: false };

    let maxMag = 0;
    for (let k = 0; k < nBins; k++) if (magnitudes[k] > maxMag) maxMag = magnitudes[k];
    const floor = maxMag * 1e-3; // -60 dB relative to peak

    if (_ndHpsScratchSize <= highBin) {
        _ndHpsScratch = new Float32Array(highBin + 1);
        _ndHpsScratchSize = highBin + 1;
    }
    const hps = _ndHpsScratch;
    let peakBin = lowBin;
    let peakVal = -Infinity;
    let sum = 0;
    for (let k = lowBin; k <= highBin; k++) {
        let logSum = 0;
        for (let h = 1; h <= harmonics; h++) {
            logSum += Math.log(Math.max(magnitudes[k * h], floor));
        }
        hps[k] = logSum;
        sum += logSum;
        if (logSum > peakVal) { peakVal = logSum; peakBin = k; }
    }
    if (!isFinite(peakVal)) return { freq: -1, confidence: 0, underBuffered: false };

    // Subharmonic correction — the classic HPS failure mode is picking
    // k = k_true / 2 on near-pure sines. A real fundamental has both
    // 2nd AND 3rd harmonics with comparable magnitude; a subharmonic
    // error doesn't — spec[3*peakBin] is pure leakage, tiny next to
    // spec[2*peakBin].
    if (peakBin * 3 < nBins) {
        const m1 = magnitudes[peakBin];
        const m2 = magnitudes[peakBin * 2];
        const m3 = magnitudes[peakBin * 3];
        const dominantSecond = m2 > 2 * m1;
        const weakThird = m3 < 0.1 * m2;
        if (dominantSecond && weakThird && peakBin * 2 <= highBin) {
            peakBin *= 2;
            peakVal = hps[peakBin];
        }
    }

    const delta = (peakBin > lowBin && peakBin < highBin)
        ? _ndParabolicOffset(hps[peakBin - 1], hps[peakBin], hps[peakBin + 1])
        : 0;
    const freq = (peakBin + delta) * binHz;

    const mean = sum / (highBin - lowBin + 1);
    const spread = peakVal - mean;
    const confidence = Math.min(1, Math.max(0, spread / (harmonics * Math.log(10))));

    return { freq, confidence, underBuffered: false };
}

// ── Constraint-Based Per-String Band Analysis ──────────────────────────────
//
// This is the core of the brief's proposal: instead of asking "what pitch is
// playing?" (hard for chords), ask "is there energy near frequency F on string
// S right now?" — a much simpler question that standard FFT can answer reliably.
//
// Used exclusively for chord scoring. Single notes continue to use YIN/HPS/CREPE
// via processFrame unchanged; the two paths are additive, not competing.

// Frequency bounds for each string covering frets 0–24 at standard tuning,
// with ±10% headroom for non-standard tunings, capo, and tuning offsets.
// Computed dynamically from MIDI tuning tables rather than hardcoded so
// 5-string bass, 7-string and 8-string guitar all derive correct ranges
// automatically.
//
// Returns [loHz, hiHz] for the given string/arrangement/stringCount/offsets/capo.
function _ndStringBandHz(stringIdx, arrangement, stringCount, offsets, capo) {
    const openMidi = _ndMidiFromStringFret(stringIdx, 0, arrangement, stringCount, offsets, capo);
    const fret24Midi = openMidi + 24;
    // MIDI → Hz: 440 * 2^((midi-69)/12)
    const loHz = 440 * Math.pow(2, (openMidi - 69) / 12) * 0.90; // -10% margin
    const hiHz = 440 * Math.pow(2, (fret24Midi - 69) / 12) * 1.10; // +10% margin
    return [loHz, hiHz];
}

// Measure the energy fraction in a frequency band [loHz, hiHz] relative to
// total spectrum energy, using the magnitude spectrum already computed by
// _ndFftMagnitude. Returns a value in [0, 1].
//
// Reuses the existing FFT scratch buffers — this is a read-only pass over
// magnitudes that were produced by _ndFftMagnitude in the same synchronous
// call chain, so no re-entrancy or buffer corruption risk.
function _ndBandEnergy(magnitudes, binHz, loHz, hiHz, totalEnergy = null) {
    const nBins = magnitudes.length;
    const loBin = Math.max(0, Math.floor(loHz / binHz));
    const hiBin = Math.min(nBins - 1, Math.ceil(hiHz / binHz));
    // hiBin === loBin (a band that covers exactly one FFT bin) is still a
    // valid case — include the bin's energy. Only bail when the band is
    // empty (hi strictly below lo, e.g. hi clamped below 0).
    if (hiBin < loBin) return 0;

    let bandEnergy = 0;
    for (let k = loBin; k <= hiBin; k++) {
        bandEnergy += magnitudes[k] * magnitudes[k];
    }

    // Caller can pre-compute total energy once per frame and pass it in
    // — saves N full-spectrum scans during chord scoring (one per
    // string). When omitted (e.g. single-string callers), compute here.
    if (totalEnergy === null) {
        totalEnergy = 0;
        for (let k = 0; k < nBins; k++) {
            totalEnergy += magnitudes[k] * magnitudes[k];
        }
    }
    if (totalEnergy < 1e-12) return 0;
    return bandEnergy / totalEnergy;
}

// Sum of squared magnitudes across the full spectrum. Pulled out so
// `_ndScoreChord` can compute it once per FFT frame and reuse it across
// every per-string `_ndBandEnergy` call.
function _ndTotalEnergy(magnitudes) {
    let total = 0;
    for (let k = 0; k < magnitudes.length; k++) {
        total += magnitudes[k] * magnitudes[k];
    }
    return total;
}

// Check whether a specific string+fret is audible in the current audio frame.
//
// Returns { hit: bool, bandEnergy: float, centsDiff: float|null, centsError: float|null }
//   centsDiff  — absolute pitch deviation in cents (null when pitch check is skipped)
//   centsError — signed pitch deviation in cents, positive = sharp (present only when
//                pitchCheckCents > 0 and band energy passes threshold; null otherwise)
//
// energyThreshold  — minimum band energy fraction to count as "string is
//                    ringing" (default 0.03, i.e. at least 3% of total
//                    spectrum energy). Lower this for hammer-ons and pull-offs
//                    where the pick attack is absent.
// pitchCheckCents  — if > 0, also verify the dominant frequency in the band
//                    is within this many cents of the expected pitch. Pass 0
//                    to skip the pitch check and use energy-only (faster,
//                    adequate for most chord hits on clean signals).
function _ndConstraintCheckString(
    buffer, sampleRate,
    stringIdx, fret, arrangement, stringCount, offsets, capo,
    pitchCheckCents = 0,
    energyThreshold = 0.03,
    precomputedSpectrum = null,
    precomputedTotalEnergy = null
) {
    // Optional precomputed spectrum + total energy let _ndScoreChord run
    // one FFT and one full-spectrum sum for the whole chord and reuse
    // both across per-string checks. The scratch buffer returned by
    // _ndFftMagnitude is module-level, so callers must keep this
    // synchronous and not interleave other FFT-using detectors.
    const { magnitudes, binHz } = precomputedSpectrum || _ndFftMagnitude(buffer, sampleRate);
    const [loHz, hiHz] = _ndStringBandHz(stringIdx, arrangement, stringCount, offsets, capo);

    const bandEnergy = _ndBandEnergy(magnitudes, binHz, loHz, hiHz, precomputedTotalEnergy);
    if (bandEnergy < energyThreshold) {
        return { hit: false, bandEnergy, centsDiff: null, centsError: null };
    }

    if (pitchCheckCents <= 0) {
        return { hit: true, bandEnergy, centsDiff: null, centsError: null };
    }

    // Find dominant bin in the band and refine with parabolic interpolation.
    const nBins = magnitudes.length;
    const loBin = Math.max(0, Math.floor(loHz / binHz));
    const hiBin = Math.min(nBins - 1, Math.ceil(hiHz / binHz));
    let peakBin = loBin;
    let peakVal = -Infinity;
    for (let k = loBin; k <= hiBin; k++) {
        if (magnitudes[k] > peakVal) { peakVal = magnitudes[k]; peakBin = k; }
    }
    const delta = (peakBin > loBin && peakBin < hiBin)
        ? _ndParabolicOffset(magnitudes[peakBin - 1], magnitudes[peakBin], magnitudes[peakBin + 1])
        : 0;
    const detectedHz = (peakBin + delta) * binHz;

    const expectedMidi = _ndMidiFromStringFret(stringIdx, fret, arrangement, stringCount, offsets, capo);
    const expectedHz = 440 * Math.pow(2, (expectedMidi - 69) / 12);
    const rawCentsError = 1200 * Math.log2(detectedHz / expectedHz);
    const centsError = _ndFoldOctaveCents(rawCentsError);
    const centsDiff = Math.abs(centsError);

    return { hit: centsDiff <= pitchCheckCents, bandEnergy, centsDiff, centsError };
}

// Score a chord by checking each of its constituent notes against their
// respective string frequency bands. Returns { score, hitStrings, totalStrings }.
//
// score = hitStrings / totalStrings (0..1)
// minHitRatio — fraction of strings that must ring for the chord to count as a hit.
//
// Each `chordNotes` entry may carry abbreviated technique flags from the chart
// note data (`cn.ho`, `cn.po`, `cn.b`, `cn.sl`, `cn.hm`), used to adjust
// per-string thresholds:
//   - ho/po (hammer-on / pull-off): lower energyThreshold (no fresh pick attack)
//   - b/sl (bend / slide): widen pitchCheckCents (pitch is in motion)
//   - hm (harmonic): energy-only check (pitch check at fundamental is unreliable)
//     — a future pass could check at 2x / 1.5x fundamental for stricter NYI
//     classification.
function _ndScoreChord(buffer, sampleRate, chordNotes, arrangement, stringCount, offsets, capo, pitchCheckCents, minHitRatio = 0.6) {
    let hitStrings = 0;
    const results = [];

    // Run one FFT for the whole chord and reuse the magnitude spectrum
    // across every per-string check. Without this a 6-string chord ran
    // 6 FFTs per detection tick — measurable CPU on slower devices.
    // Pre-compute total energy too — it's per-frame, not per-string,
    // and was the inner loop's dominant cost on a single 4096-point
    // spectrum.
    const spectrum = _ndFftMagnitude(buffer, sampleRate);
    const totalEnergy = _ndTotalEnergy(spectrum.magnitudes);

    for (const cn of chordNotes) {
        // Per-technique threshold adjustments (brief §"Handling Techniques")
        let energyThreshold = 0.03;
        let cents = pitchCheckCents;

        if (cn.ho || cn.po) {
            // Hammer-on / pull-off: no pick attack, energy will be lower
            energyThreshold = 0.015;
        }
        if (cn.b || cn.sl) {
            // Bend / slide: pitch is moving, widen the pitch window
            cents = Math.max(cents, 100);
        }
        if (cn.hm) {
            // Harmonic: energy-only check (pitch check at fundamental is unreliable)
            cents = 0;
        }

        const check = _ndConstraintCheckString(
            buffer, sampleRate,
            cn.s, cn.f, arrangement, stringCount, offsets, capo,
            cents, energyThreshold, spectrum, totalEnergy
        );
        results.push({ s: cn.s, f: cn.f, ...check });
        if (check.hit) hitStrings++;
    }

    const totalStrings = chordNotes.length;
    const score = totalStrings > 0 ? hitStrings / totalStrings : 0;
    return { score, hitStrings, totalStrings, results, isHit: score >= minHitRatio };
}

// ── Pitch Detection: CREPE (shared model) ──────────────────────────────────

async function _ndLoadCrepe() {
    if (_ndShared.model || _ndShared.modelLoading) return;
    _ndShared.modelLoading = true;
    // Refresh every instance's button so any detector on 'crepe' shows
    // "loading model..." while the ~20 MB download is in flight.
    // Without this, the UI stays idle for the multi-second download
    // window and users get no feedback.
    for (const inst of _ndInstances) inst._updateButton();

    try {
        if (!window.tf) {
            await _ndLoadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.17.0/dist/tf.min.js');
        }
        _ndShared.model = await tf.loadGraphModel(
            'https://tfhub.dev/google/tfjs-model/spice/2/default/1',
            { fromTFHub: true }
        );
        console.log('CREPE/SPICE model loaded');
    } catch (e1) {
        console.warn('SPICE TFHub load failed, trying CREPE backup:', e1);
        try {
            _ndShared.model = await tf.loadLayersModel(
                'https://cdn.jsdelivr.net/gh/nicksherron/crepe-js@master/model/model.json'
            );
            console.log('CREPE model loaded (fallback)');
        } catch (e2) {
            console.warn('All model loads failed, using YIN for this session:', e2);
            _ndShared.model = null;
        }
    }
    _ndShared.modelLoading = false;
    // Update every instance's button — any of them might be on crepe.
    for (const inst of _ndInstances) inst._updateButton();
}

function _ndLoadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

// Score → CSS color ramp. Used by HUDs and modal tiles to give the
// player a glance-readable color for any 0..1 score. null/undefined
// returns neutral gray (no data).
function _ndScoreColor(pct) {
    if (pct == null) return '#4b5563';
    if (pct >= 0.90) return '#10b981';   // green
    if (pct >= 0.70) return '#eab308';   // yellow
    if (pct >= 0.40) return '#f97316';   // orange
    return '#dc2626';                    // red
}

// Encode Float32 PCM as 16-bit mono WAV. Pure — no DOM, no fetch.
// Used by the recording path to materialize captured samples for
// server upload or local download.
function _ndRecordToWavBlob(pcm, sampleRate) {
    const numSamples = pcm.length;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);
    const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, numSamples * 2, true);
    for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, pcm[i]));
        view.setInt16(44 + i * 2, s * 0x7FFF, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
}

// "M:SS" formatter for chart-time labels. Used by drill HUD and
// loop-naming so saved drills are scannable in the saved-loops dropdown.
function _ndFmtMmSs(t) {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

// Pure: status-line message for the "Apply latency from recent
// hits" button. Tested in test/cal-message.test.js so accidental
// off-by-one / boundary errors get caught by the harness instead
// of by the user staring at a panel saying "Need 0 more hits".
//
// Inputs:
//   samples:    driftBuffer.length (0..N)
//   driftMs:    rolling-median timing error (rounded to int)
//   avOffsetMs: current avOffset (rounded to int)
//   minSamples: _ND_DRIFT_MIN_SAMPLES (default 4)
// Returns: { text, applyEnabled }
function _ndCalRefreshMessage(samples, driftMs, avOffsetMs, minSamples) {
    const min = Number.isFinite(minSamples) ? minSamples : 4;
    if (samples < min) {
        const need = min - samples;
        return {
            text: `Need ${need} more hit${need === 1 ? '' : 's'} before calibration. Current avOffset: ${avOffsetMs}ms.`,
            applyEnabled: false,
        };
    }
    const direction = driftMs > 0 ? 'late' : driftMs < 0 ? 'early' : 'on the beat';
    const sign = driftMs > 0 ? '+' : '';
    return {
        text: `Median bias across ${samples} hit${samples === 1 ? '' : 's'}: ${sign}${driftMs}ms (${direction}). Current avOffset: ${avOffsetMs}ms. Click Apply to set avOffset → ${avOffsetMs - driftMs}ms.`,
        applyEnabled: true,
    };
}

// Pure: compute the deltas between captured onset times and
// expected click times, separating valid plucks from likely
// click-bleed (near-zero delta = the click itself echoing
// through speakers → bass body → DI). Returns the full
// post-match analysis the cal needs to decide success/failure.
//
// Inputs:
//   captures:    array of audioCtx.currentTime values when onsets fired
//   expectedTimes: array of audioCtx.currentTime values at scheduled clicks
//   beatSec:     1.0 at 60bpm
//   matchFraction: how much of the beat counts as "near a click"
//                  (0.6 means ±600ms at 60bpm)
//   bleedThresholdSec: |delta| below this treated as click-bleed
//                       (0 = disabled; 0.05 = the prior 50ms filter)
// Returns: { deltas: [seconds...], clickThroughDeltas: [ms...] }
function _ndMatchCalCaptures(captures, expectedTimes, beatSec, matchFraction, bleedThresholdSec) {
    const halfBeat = beatSec * matchFraction;
    const bleedSec = bleedThresholdSec || 0;
    const deltas = [];
    const clickThroughDeltas = [];
    for (const cap of captures) {
        let nearest = null;
        for (const exp of expectedTimes) {
            const d = cap - exp;
            if (Math.abs(d) < halfBeat) {
                if (nearest == null || Math.abs(d) < Math.abs(nearest)) nearest = d;
            }
        }
        if (nearest == null) continue;
        if (bleedSec > 0 && Math.abs(nearest) < bleedSec) {
            clickThroughDeltas.push(Math.round(nearest * 1000));
            continue;
        }
        deltas.push(nearest);
    }
    return { deltas, clickThroughDeltas };
}

// Pure onset-detector state machine. Same logic as inside
// processFrame but extractable so the click-track-specific override
// (reattackArmed forced true during calibration) can be tested
// without booting the audio pipeline. The live processFrame remains
// the canonical caller; this function exists so test suites can
// assert that calibration-mode behavior actually fires for
// realistic bass-sustain RMS patterns.
//
// state: {
//   inNote, lastOnsetPerfSec, reattackArmed, rmsBuf, onsetCount
// }
// thresholds: {
//   onsetLevel, exitLevel, rearmLevel,
//   reattackMinLevel, reattackRatio, refractorySec, rmsBufWindow
// }
// opts: { isCalibrating: bool }
//
// Returns: { fireOnset: bool, state: {...new state...} }
function _ndStepOnset(rms, nowSec, state, thresholds, opts) {
    const t = thresholds;
    const isCal = !!(opts && opts.isCalibrating);
    // Copy state so callers see immutable transition.
    const out = {
        inNote: state.inNote,
        lastOnsetPerfSec: state.lastOnsetPerfSec,
        reattackArmed: state.reattackArmed,
        rmsBuf: state.rmsBuf.slice(),
        onsetCount: state.onsetCount || 0,
    };
    out.rmsBuf.push(rms);
    if (out.rmsBuf.length > t.rmsBufWindow) out.rmsBuf.shift();

    const refractoryOk = (nowSec - out.lastOnsetPerfSec) > t.refractorySec;
    if (rms < t.rearmLevel || isCal) out.reattackArmed = true;

    let fireOnset = false;
    if (rms > t.onsetLevel && !out.inNote && refractoryOk) {
        out.inNote = true;
        fireOnset = true;
    } else if (out.inNote && refractoryOk && out.reattackArmed
               && rms > t.reattackMinLevel
               && out.rmsBuf.length >= 3) {
        const recentMin = Math.min(...out.rmsBuf.slice(0, -1));
        if (rms > recentMin * t.reattackRatio) fireOnset = true;
    } else if (rms < t.exitLevel) {
        out.inNote = false;
    }

    if (fireOnset) {
        out.lastOnsetPerfSec = nowSec;
        out.reattackArmed = false;
        out.onsetCount += 1;
    }

    return { fireOnset, state: out };
}

// Pure: trimmed mean of an array. trimFraction=0.25 drops the
// bottom 25% AND top 25% of values, then averages the middle 50%.
// Robust against outliers (sustain-bleed phantoms producing huge
// timingError, warm-up hits before the player settles, brief
// disturbances that pull the median off-center).
//
// Returns null when the input doesn't have enough samples to keep
// at least one value after trimming. With trimFraction=0.25, that's
// minimum 3 elements (drops 0 from each end with floor(0.25*3)=0,
// keeps all 3). For 4+ elements, drops 1 from each end.
function _ndTrimmedMean(arr, trimFraction) {
    if (!arr || arr.length === 0) return null;
    const trim = Math.floor(arr.length * (trimFraction || 0));
    if (trim * 2 >= arr.length) return null;  // would trim everything
    const sorted = [...arr].sort((a, b) => a - b);
    const middle = sorted.slice(trim, sorted.length - trim);
    if (middle.length === 0) return null;
    const sum = middle.reduce((s, v) => s + v, 0);
    return sum / middle.length;
}

// Pure: best single-number drift estimate. Uses trimmed mean (drops
// outliers) when the buffer is big enough, falls back to median for
// small samples. Used by both the calibration apply path AND the
// rolling estimator that drives proactive coaching.
function _ndDriftFromBuffer(buf, calMinSamples) {
    if (!buf || buf.length === 0) return 0;
    const calMin = calMinSamples || 16;
    if (buf.length >= calMin) {
        // Stable trimmed mean of middle 50%.
        const t = _ndTrimmedMean(buf, 0.25);
        return t == null ? 0 : t;
    }
    // Small-sample regime: median is more robust than mean against
    // single outliers when n < 16.
    const m = _ndMedian(buf);
    return m == null ? 0 : m;
}

// Pure: median of an array of numbers. Returns null on empty.
function _ndMedian(arr) {
    if (!arr || arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

// Stable-ish key for grouping plays of "the same song" — filename
// alone collides across arrangements (lead vs bass), so we
// concatenate filename+arrangement. Falls back to title when
// filename is missing (e.g. fixtures without a song_audio path).
function _ndCurrentSongId(songInfo) {
    if (!songInfo) return null;
    const file = songInfo.filename || songInfo.title || null;
    const arr = songInfo.arrangement || 'default';
    return file ? `${file}__${arr}` : null;
}

// Pure: does a (start, end) loop range duplicate any in `existingLoops`
// within `tolSec` on both endpoints? Used by drill auto-save to avoid
// piling identical loops into the user's saved-loops list each time
// they re-drill the same trouble spot.
function _ndIsDuplicateLoop(start, end, existingLoops, tolSec = 2.0) {
    if (!existingLoops || !existingLoops.length) return false;
    return existingLoops.some(l =>
        typeof l.start === 'number' && typeof l.end === 'number'
        && Math.abs(l.start - start) <= tolSec
        && Math.abs(l.end - end) <= tolSec
    );
}

// ── Drill mode ─────────────────────────────────────────────────────────────
//
// A drill loops a short cluster of trouble notes so the player can grind
// through it. Three knobs:
//
//   _ND_DRILL_LEAD_IN_SEC — how far before the cluster the audio loop
//       starts. The pre-roll is for context (you hear the song lead you
//       into the trouble spot); judgments don't fire until judgeStart.
//   _ND_DRILL_FIRST_NOTE_RUNWAY_SEC — minimum gap between judgment
//       activation and the first chart note inside the cluster. Without
//       this, clusters whose first note sits at the cluster boundary
//       give the player ~0ms to react every loop iteration.
//       startDrillRange shifts judgeStart back when the cluster's first
//       note is too close to the requested boundary.
//   _ND_DRILL_SLOW_SPEED — suggested slowdown for the "drill this slowly"
//       recommendation. 0.95× gives a beat more reaction time without the
//       dramatic motor-pattern shift of 0.75×.
const _ND_DRILL_LEAD_IN_SEC = 5;
const _ND_DRILL_FIRST_NOTE_RUNWAY_SEC = 1.5;
const _ND_DRILL_SLOW_SPEED = 0.95;
// Loop-restart detection. When chartTime jumps backward by more than
// MIN_BACKWARD_SEC, that's a loop wrap (slopsmith's audio engine
// re-seeking to loopA). Refractory window suppresses duplicate fires
// from audio-engine seek bouncing.
const _ND_LOOP_RESTART_MIN_BACKWARD_SEC = 1.0;
const _ND_LOOP_RESTART_REFRACTORY_SEC = 1.5;

// Drift compensation. Track the rolling median of recent HIT timing
// errors and shift the matcher's search center backward by that
// amount. Self-corrects for residual A/V offset drift the user's
// calibration didn't catch — e.g., output-latency drift across
// pause/resume, or per-song processing latency. Median is robust:
// a single outlier doesn't move the estimate. Window of 8 picks up
// tempo wobble within ~10 s without locking onto a single bad hit.
const _ND_DRIFT_WINDOW = 32;
// Smallest buffer size that yields a meaningful single-number drift
// estimate. Used by the proactive coaching hint and the HUD's
// drift-status line — surfaces "you've been ~80ms late" after 4+ hits.
const _ND_DRIFT_MIN_SAMPLES = 4;
// Calibration apply threshold. Larger than the coaching threshold so
// "Calibrate from this play" reflects a stable, high-confidence
// median across many hits — not 4 noisy initial reads. Trimmed mean
// of middle 50% kicks in at this size for outlier rejection.
const _ND_CAL_MIN_SAMPLES = 16;
// Drift-significance threshold. Used by the HUD to color the live
// drift line amber (above) vs green (within), and by the proactive
// coaching hint (half-threshold) to decide when to surface "play X
// ms earlier" hints near upcoming notes. 50ms = the precision-zone
// boundary; below that the player perceives "good timing" and we
// don't pester them.
const _ND_DRIFT_SIGNIFICANT_MS = 50;

// Stability voting. YIN's first ~100ms after a fresh pluck is
// transient-jittery — a bass D2 might bounce D1 → D2 → A1 → D2
// across consecutive 50ms frames before settling. Without voting,
// the matcher's first-pass detection on each chart note can lock
// onto a transient octave-down read. Voting requires N-of-M recent
// rounded-MIDI frames to agree before a "stable" detection is
// surfaced for matching. Raw detectedMidi still goes to the HUD
// readout so the diagnostic layer sees what YIN is actually doing.
const _ND_STABILITY_WINDOW = 3;       // frames considered
const _ND_STABILITY_REQUIRED = 2;     // N-of-M for "stable"

// Onset detection + buffer flush. Without this, YIN's 4096-sample
// window (~85ms at 48kHz) is always contaminated by the previous
// note's sustain — on bass this means YIN locks on the previous
// pitch when a new pluck arrives, the matcher records detectedMidi
// for the wrong note, and the chart note becomes a miss. Onset
// detection fires when RMS crosses a threshold from below; on
// onset we flush the accumulator so the next YIN window is built
// entirely from post-onset chunks. Re-attack detection fires on
// in-note RMS spikes so rapid same-pitch passes (where sustain
// keeps inNote=true) still get fresh detections.
// Thresholds tuned for the post-routing-fix audio path: bass guitar via
// the pw-loopback systemd service (Audio/Source guitar_capture). That
// path delivers peak ~0.32 to Firefox vs ~1.0 from a direct mic grab,
// so RMS during plucks lands around 0.015-0.10. Pre-port defaults
// (0.04 onset, 0.02 exit) were calibrated for the direct path and
// produced onsetCount=0 on this user's system — the threshold sat
// above their actual playing RMS, so no onset ever fired and the
// buffer-flush logic never engaged. Lower defaults make the trigger
// sensitive enough for the routed path while staying above typical
// 0.005 noise floor.
// Buffer-comp offset applied to onset chart-time. The onset trigger
// fires on a chunk that's half pre-attack (previous note's tail) and
// half post-attack — compensating chart-time backwards by ~half the
// chunk duration centers the onset on the actual attack. 20ms ≈ half
// of a 2048-sample chunk at 48kHz.
const _ND_ONSET_BUFFER_COMP_SEC = 0.020;
const _ND_ONSET_LEVEL = 0.015;           // RMS above → entering a note
const _ND_ONSET_EXIT_LEVEL = 0.008;      // RMS below → note ended
const _ND_REATTACK_REFRACTORY_SEC = 0.20; // refractory after onset
const _ND_REATTACK_MIN_LEVEL = 0.015;    // re-attack must reach this RMS
const _ND_REATTACK_REARM_LEVEL = 0.008;  // dip below this re-arms re-attack gate
const _ND_REATTACK_RATIO = 1.5;          // RMS spike must be N× recent min
const _ND_REATTACK_WINDOW = 8;           // recent-min window (chunks)

// Bass open strings: MIDIs 28 (E1), 33 (A1), 38 (D2), 43 (G2). When
// YIN/HPS detects one of these but the chart expected a different
// MIDI, the most likely cause is sympathetic resonance — the open
// string is ringing alongside the played note. The detector picks the
// (louder) open-string fundamental rather than the played note's
// fundamental, octave-folding then makes the wrong detection "barely
// pass" the 200¢ wide tolerance. That's not a player hit; it's the
// detector failing to suppress sympathetic energy.
const _ND_BASS_OPEN_STRING_MIDIS = new Set([28, 33, 38, 43]);
// Octave above each open string. YIN on a 4096-sample buffer at low
// bass frequencies (E1=41Hz, A1=55Hz) can lock onto the 2nd harmonic
// rather than the weak fundamental, so an unmuted ringing open A1
// reads as A2 (MIDI 45). Detecting either pattern as open-string
// contamination matches the underlying physics — same muting issue,
// different YIN output.
const _ND_BASS_OPEN_STRING_OCTAVE_MIDIS = new Set([40, 45, 50, 55]);

// Detector-failure demotion. The score should reflect playing
// quality, not detector limitations. Misses caused by sustain bleed
// or onset-detector refractory (rather than the player's error) get
// flagged ignoredAsDetectorFailure and excluded from the score by
// _ndScoresFromNotes. The flag is preserved on the judgment so
// downstream analytics still see the underlying miss reason.
//
// Tight gap: rapid re-attack regime where the onset detector
// physically can't fire again — refractory window + previous sustain
// dominates the RMS measurement. The "sustain bleed wall."
const _ND_DETECTOR_FAST_REPEAT_GAP_SEC = 0.4;
// Wider gap: chain-failure regime. Even with a longer gap, if the
// PREVIOUS chart note also missed, the detector is in a bad state
// (accumulated sustain bleed across multiple unhit notes) and the
// next note's NO_DETECTION is also a detector limitation. Validated
// on user data: 29 of 56 wide-gap misses followed another miss.
const _ND_DETECTOR_CHAIN_FAILURE_GAP_SEC = 1.0;

// ── Two-axis scoring ───────────────────────────────────────────────────────
//
// Single source of truth for play-level scoring math. Takes an iterable
// of judgment objects (Map values OR Array — same shape) produced by
// recordJudgment / makeMissJudgment, and returns the bundle the UI
// cares about plus raw counts. The review modal calls this against
// play.noteResults from the persisted plays endpoint; the live HUD
// calls it against the in-flight noteResults Map; the snapshot summary
// that gets persisted calls it too. All three paths use the same
// function so displayed score, persisted score, and heatmap-derived
// per-section scores can never drift.
//
// Returned fields:
//   detection      — HIT/total at the wide thresholds (200¢ / 300ms).
//                    Headline number on the HUD and report.
//   precision      — fraction of HITs that landed inside the precision
//                    zone (timingState='OK' AND pitchState in {OK,null}).
//                    Independent number — answers "how tight."
//   combined       — alias for detection (back-compat for callers not
//                    yet migrated to read .detection).
//   pitchPct       — of attempts where pitch was measurable, fraction
//                    correct. Null when no pitch attempts.
//   coverage       — fraction of notes that produced any detection
//                    (HIT + wrong-pitch). Null when no notes.
//   timingMedianMs — median timing error across HITs (signed: + = late).
//   timingStdMs    — standard deviation of HIT timings.
//   total / hits / misses / perfect — raw counts.
function _ndScoresFromNotes(notes) {
    let total = 0;
    let hitCount = 0;
    let wrongPitchCount = 0;
    let detectedCount = 0;
    let perfectCount = 0;
    const hitTimings = [];

    const iter = notes && typeof notes[Symbol.iterator] === 'function' ? notes : (notes ? Object.values(notes) : []);
    for (const r of iter) {
        if (!r) continue;
        // Detector-failure misses don't count against the score —
        // they're sustain-bleed / refractory artifacts, not playing
        // errors. Same flag the live counter (recordJudgment) honors.
        if (r.ignoredAsDetectorFailure) continue;
        total++;
        if (r.hit) {
            hitCount++;
            detectedCount++;
            if (typeof r.timingError === 'number') hitTimings.push(r.timingError);
            // Precision = HITs that landed inside the perfect zone:
            // timing inside _ND_PRECISION_TIMING_MS AND pitch inside
            // _ND_PRECISION_PITCH_CENTS (or pitch unmeasured for chord
            // events). _ndClassifyTiming/_ndClassifyPitch encode this
            // as the 'OK' state when the makeJudgment thresholds were
            // the precision values.
            const timingOk = r.timingState === 'OK' || r.timingState == null;
            const pitchOk = r.pitchState === 'OK' || r.pitchState == null;
            if (timingOk && pitchOk) perfectCount++;
        } else if (typeof r.detectedMidi === 'number' && r.detectedMidi >= 0
                   && r.pitchState && r.pitchState !== 'OK') {
            // A miss where YIN had something but pitch was wrong —
            // counts as detected for coverage, drives the
            // pitch-correctness denominator separately from "no input".
            wrongPitchCount++;
            detectedCount++;
        }
    }

    const detection = total === 0 ? 0 : hitCount / total;
    const precision = hitCount === 0 ? null : perfectCount / hitCount;
    const combined = detection;
    const pitchDenom = hitCount + wrongPitchCount;
    const pitchPct = pitchDenom === 0 ? null : hitCount / pitchDenom;
    const coverage = total === 0 ? null : detectedCount / total;

    let timingMedianMs = null;
    let timingStdMs = null;
    if (hitTimings.length > 0) {
        const sorted = [...hitTimings].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        timingMedianMs = sorted.length % 2 === 0
            ? (sorted[mid - 1] + sorted[mid]) / 2
            : sorted[mid];
        const mean = hitTimings.reduce((s, v) => s + v, 0) / hitTimings.length;
        const variance = hitTimings.reduce((s, v) => s + (v - mean) ** 2, 0) / hitTimings.length;
        timingStdMs = Math.sqrt(variance);
    }

    return {
        detection, precision, combined,
        pitchPct, coverage, timingMedianMs, timingStdMs,
        total, hits: hitCount, misses: total - hitCount, perfect: perfectCount,
    };
}

// Compute deltas between current play's scores and a prior play's.
// Pure, testable. Returns per-axis signed numbers — null per-field
// when either side is missing data.
//   detection / precision / pitchPct / coverage: signed fractional delta
//                                                 (+0.08 = "8 percentage
//                                                 points better")
//   timingMedianMs:                              signed ms delta (raw
//                                                 difference; renderer
//                                                 interprets tighter=better)
function _ndComputeScoreDeltas(current, prior) {
    if (!current || !prior) return null;
    const sub = (a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : null;
    return {
        detection:      sub(current.detection,      prior.detection),
        precision:      sub(current.precision,      prior.precision),
        combined:       sub(current.combined,       prior.combined),
        pitchPct:       sub(current.pitchPct,       prior.pitchPct),
        coverage:       sub(current.coverage,       prior.coverage),
        timingMedianMs: sub(current.timingMedianMs, prior.timingMedianMs),
    };
}

// Sliding-window cluster finder for a single play's noteResults. Picks
// dense pockets of OFF-TARGET notes — anything that isn't a clean HIT
// (so timing-sloppy plays cluster too even though they're hits). A
// user with 100% pitch but consistently late timing should see
// clusters; a miss-only algorithm reports "no trouble clusters" on
// those plays, which is wrong because there's clearly something to
// drill.
//
// `cluster.misses` keeps the legacy field name — semantically it now
// means "off-target note count" (HIT-with-non-OK label + true MISS).
//
// Each note must carry `noteTime` (chart time) and a hit/timingState/
// pitchState shape — the same shape recordJudgment/makeMissJudgment
// produce.
function _ndFindMissClusters(noteResults, opts = {}) {
    const {
        windowSec = 6,
        slideSec = 0.5,
        minOffTarget = 2,
        maxClusters = 8,
        padHeadSec = 0.5,
        padTailSec = 1.0,
        minGapSec = 1.0,
    } = opts;
    const notes = (noteResults || []).filter(r => r);
    if (!notes.length) return [];

    const isOffTarget = (r) => {
        if (r.hit) {
            // HIT with timing or pitch outside the precision zone is
            // "off-target" for cluster purposes — answers the question
            // "is there something here to drill?"
            const timingOff = r.timingState && r.timingState !== 'OK';
            const pitchOff  = r.pitchState  && r.pitchState  !== 'OK';
            return timingOff || pitchOff;
        }
        return true;  // any kind of MISS
    };

    let minT = Infinity, maxT = -Infinity;
    for (const r of notes) {
        const t = typeof r.noteTime === 'number' ? r.noteTime : r.chartT;
        if (t < minT) minT = t;
        if (t > maxT) maxT = t;
    }
    if (!Number.isFinite(minT) || !Number.isFinite(maxT)) return [];

    const tOf = (r) => typeof r.noteTime === 'number' ? r.noteTime : r.chartT;
    const candidates = [];
    for (let start = minT; start <= maxT; start += slideSec) {
        const end = start + windowSec;
        const inWin = notes.filter(r => tOf(r) >= start && tOf(r) < end);
        const offTarget = inWin.filter(isOffTarget).length;
        if (offTarget >= minOffTarget) {
            candidates.push({ start, end, offTarget, total: inWin.length, notes: inWin });
        }
    }
    if (!candidates.length) return [];
    candidates.sort((a, b) => b.offTarget - a.offTarget || a.start - b.start);

    const selected = [];
    for (const c of candidates) {
        if (selected.length >= maxClusters) break;
        const padA = c.start - padHeadSec;
        const padB = c.end + padTailSec;
        // Reject overlapping windows (with a minGapSec margin) so the
        // top-N clusters are spatially distinct rather than near-
        // duplicates of the same densest 6-second region.
        if (selected.some(s =>
            (padA - minGapSec) < s.endSecRaw && (padB + minGapSec) > s.startSecRaw)) continue;
        selected.push({
            startSecRaw: c.start, endSecRaw: c.end,
            startSec: Math.max(0, padA),
            endSec: padB,
            misses: c.offTarget,
            total: c.total,
            notes: c.notes,
        });
    }
    selected.sort((a, b) => a.startSec - b.startSec);
    return selected;
}

// Find the prior cluster whose time range overlaps a given current
// cluster the most. Used by per-cluster delta badges: when the user
// drills the same trouble spot they had last attempt, surface whether
// they got better at it. Returns null when no prior cluster overlaps.
function _ndFindOverlappingPriorCluster(current, priorClusters) {
    if (!current || !priorClusters || !priorClusters.length) return null;
    let best = null, bestOverlap = 0;
    for (const prior of priorClusters) {
        const start = Math.max(current.startSec, prior.startSec);
        const end = Math.min(current.endSec, prior.endSec);
        const overlap = end - start;
        if (overlap > bestOverlap) { bestOverlap = overlap; best = prior; }
    }
    return bestOverlap > 0 ? best : null;
}

// Time-binned heatmap. Independent of chart section structure (CDLCs
// often have sparse sections; fixed-width bins give consistent
// granularity regardless of how the chart was annotated).
//
// Each bin gets the combined score over notes whose time falls in
// [startSec, endSec). Uses _ndScoresFromNotes so heatmap colors agree
// with everything else by construction. Empty bins (no notes) carry a
// null score and render as neutral background.
function _ndComputeTimeHeatmap(noteResults, totalDuration, binSec = 5) {
    if (totalDuration <= 0 || binSec <= 0) return [];
    const notes = (noteResults || []).filter(r => r);
    const tOf = (r) => typeof r.noteTime === 'number' ? r.noteTime : r.chartT;
    const numBins = Math.ceil(totalDuration / binSec);
    const bins = [];
    for (let i = 0; i < numBins; i++) {
        const startSec = i * binSec;
        const endSec = Math.min(startSec + binSec, totalDuration);
        const inBin = notes.filter(r => {
            const t = tOf(r);
            return typeof t === 'number' && t >= startSec && t < endSec;
        });
        if (inBin.length === 0) {
            bins.push({ startSec, endSec, totalNotes: 0, score: null, hits: 0, misses: 0 });
            continue;
        }
        const scores = _ndScoresFromNotes(inBin);
        bins.push({
            startSec, endSec,
            totalNotes: inBin.length,
            score: scores.combined,
            hits: scores.hits,
            misses: scores.misses,
        });
    }
    return bins;
}

// Per-section aggregation. Returns Map<sectionName, {hits, misses,
// total, accuracy, timingErrors[]}>. Pre-creates rows for every chart
// section (even sections with no notes) so the heatmap renderer shows
// consistent cells rather than collapsing empties. Section assignment
// uses the chart's section boundaries — a note's `sectionName` field
// when present, else looked up by chart-time falling inside the
// section's range.
function _ndAggregateBySection(noteResults, sections) {
    const byName = new Map();
    const ensure = (name) => {
        let row = byName.get(name);
        if (!row) {
            row = { hits: 0, misses: 0, total: 0, timingErrors: [] };
            byName.set(name, row);
        }
        return row;
    };
    for (const sec of sections || []) ensure(sec.name);

    const sectionForTime = (t) => {
        if (!sections || !sections.length) return null;
        // Sections are sorted by startTime ascending; binary search if
        // this becomes hot. For typical N≤30 sections per song, linear
        // scan is fine.
        for (let i = 0; i < sections.length; i++) {
            const sec = sections[i];
            const next = sections[i + 1];
            const start = sec.startTime ?? sec.start ?? 0;
            const end = next ? (next.startTime ?? next.start) : Infinity;
            if (t >= start && t < end) return sec.name;
        }
        return null;
    };

    for (const r of noteResults || []) {
        if (!r) continue;
        const t = typeof r.noteTime === 'number' ? r.noteTime : r.chartT;
        const name = r.sectionName
            || (typeof t === 'number' ? sectionForTime(t) : null)
            || '(unsectioned)';
        const row = ensure(name);
        row.total++;
        if (r.hit) {
            row.hits++;
            if (typeof r.timingError === 'number') row.timingErrors.push(r.timingError);
        } else {
            row.misses++;
        }
    }
    // Attach derived accuracy for renderer convenience.
    for (const row of byName.values()) {
        row.accuracy = row.total > 0 ? row.hits / row.total : null;
    }
    return byName;
}

// ── Coaching analysis bundle (single source of truth) ─────────────────────
//
// Pure function. The modal renderer (Unit 3c) and any test harness that
// wants the full post-play picture call this once and read all the
// derived numbers off the result. Internal-only consumers (the live
// HUD, the iteration banner) use individual analysis functions
// directly — this entry point exists for the modal which needs all
// the pieces at once with a stable shape.
//
// Input:
//   play         — { noteResults: [...] } from the persisted plays
//                  endpoint, or built live from the in-flight Map.
//   opts         — { sections, totalDuration, heatmapBinSec }.
//
// Output: { derived, clusters, perSection, timeHeatmap, topFix,
//           sections, totalDuration }.
//
// `topFix` is the single most actionable suggestion the modal should
// surface above the fold. Cluster-based topFix (pick the densest
// cluster and read its dominant failure mode) is deferred to Unit 3c
// — it needs the failure-mode classifier. Axis-level fallback is
// implemented here: when no clusters are found, look at the weakest
// sub-score (pitch / coverage / timing skew) and surface global
// coaching advice.
// Unit 3i: per-(string, fret) miss-rate grid. Pure — takes a flat
// noteResults array (port shape: hit:bool, ignoredAsDetectorFailure
// for sustain-bleed exclusion) and returns a 2D grid of
// {hits, miss, total, missRate}. The renderer turns this into a
// compact SVG fretboard with miss-rate-colored cells.
//
// stringCount: 4 for bass, 6 for guitar; default 6.
// maxFret: cap fret-axis size; default 24 (the highest sane fret).
//
// We exclude `ignoredAsDetectorFailure` notes (sustain-bleed
// artifacts) from BOTH numerator and denominator — same rule
// _ndScoresFromNotes uses, so the heatmap can't show "you miss
// every E2" when those misses were really detector failures.
function _ndComputeFretboardHeatmap(noteResults, opts = {}) {
    const stringCount = opts.stringCount || 6;
    const maxFret = opts.maxFret || 24;
    const grid = [];
    for (let s = 0; s < stringCount; s++) {
        grid[s] = [];
        for (let f = 0; f <= maxFret; f++) {
            grid[s][f] = { hits: 0, miss: 0, total: 0, missRate: null };
        }
    }
    for (const r of (noteResults || [])) {
        if (!r || r.ignoredAsDetectorFailure) continue;
        // The note's source string/fret lives on .chartNote (matched)
        // or .note (fallback). Both expose s/f when the chart had
        // them. Chord notes have neither; skip — they'd map to
        // multiple cells and we'd need per-note splitting.
        const sf = r.chartNote || r.note || null;
        if (!sf) continue;
        if (typeof sf.s !== 'number' || sf.s < 0 || sf.s >= stringCount) continue;
        if (typeof sf.f !== 'number' || sf.f < 0 || sf.f > maxFret) continue;
        const cell = grid[sf.s][sf.f];
        cell.total++;
        if (r.hit) cell.hits++;
        else cell.miss++;
    }
    for (let s = 0; s < stringCount; s++) {
        for (let f = 0; f <= maxFret; f++) {
            const c = grid[s][f];
            c.missRate = c.total > 0 ? c.miss / c.total : null;
        }
    }
    return grid;
}

// Render the heatmap as a CSS grid block (cells = colored divs)
// suitable for embedding in the coaching modal. Returns a string;
// caller drops it into innerHTML. Cells with no data render as a
// faint backdrop; cells with data shade red→green by miss rate.
// Frequency markers ('●' for ≥10 attempts, '·' for ≥3) prevent the
// reader from over-weighting a single-attempt outlier cell.
function _ndRenderFretboardHeatmapSvg(grid, stringCount, maxFret) {
    let any = false;
    for (let s = 0; s < stringCount && !any; s++) {
        for (let f = 0; f <= maxFret; f++) {
            if (grid[s][f].total > 0) { any = true; break; }
        }
    }
    if (!any) {
        return '<div class="text-gray-500 text-xs italic">No fretboard data — note results lacked string/fret info.</div>';
    }
    const cellPx = 14;
    const labelCol = 18;
    let body = `<div style="display:grid;grid-template-columns:${labelCol}px repeat(${maxFret + 1}, ${cellPx}px);gap:1px;font-size:8px">`;
    body += '<div></div>';
    for (let f = 0; f <= maxFret; f++) {
        // Standard fretmarker positions; matches what most fretboard
        // diagrams highlight so the user can locate frets at a glance.
        const marker = f === 0 || f === 3 || f === 5 || f === 7
            || f === 9 || f === 12 || f === 15 || f === 17
            || f === 19 || f === 24;
        body += `<div class="text-gray-600 text-center" style="line-height:${cellPx}px">${marker ? f : ''}</div>`;
    }
    for (let s = 0; s < stringCount; s++) {
        body += `<div class="text-gray-500 text-right pr-1" style="line-height:${cellPx}px">s${s}</div>`;
        for (let f = 0; f <= maxFret; f++) {
            const c = grid[s][f];
            let bg, content = '';
            if (c.missRate === null) {
                bg = 'rgba(60,60,70,0.3)';
            } else {
                const r = Math.round(c.missRate * 240);
                const g = Math.round((1 - c.missRate) * 200);
                bg = `rgba(${r}, ${g}, 60, 0.85)`;
                if (c.total >= 3) content = c.total >= 10 ? '●' : '·';
            }
            const tip = c.total > 0
                ? `s${s}/f${f}: ${c.miss}/${c.total} miss`
                : `s${s}/f${f}: no data`;
            body += `<div title="${tip}" style="background:${bg};text-align:center;color:#fff;line-height:${cellPx}px;font-size:8px">${content}</div>`;
        }
    }
    body += '</div>';
    return body;
}

// Unit 3g: top-3 prescriptions. Reduces a single play's noteResults
// into 3 ranked, actionable suggestions. The reference branch
// aggregated across plays + ran a failure-mode classifier — that's
// a much larger port. This single-play version uses three signals:
//
//   A. Top trouble cluster — the densest miss zone in the song
//      (already computed by _ndFindMissClusters; we just package it
//      with chart-time labels so the user can locate it).
//   B. Systematic timing bias — median timingError on hits. If the
//      player is consistently early/late by more than a threshold,
//      surface a "anticipate the click" / "hold one extra moment"
//      coaching cue.
//   C. Weakest string — string with miss rate ≥ 1.5× overall AND
//      ≥40% absolute. One per-string prescription max.
//
// Each candidate has {text, detail, score, signal}. We sort by
// score desc and return the top 3. Empty array → "not enough data
// yet" placeholder is the renderer's responsibility.
function _ndComputePrescriptions(noteResults, opts = {}) {
    const candidates = [];
    if (!noteResults || noteResults.length === 0) return candidates;

    const arrangement = opts.arrangement || 'guitar';
    const timingThresholdMs = opts.timingThresholdMs || 50;

    // ── Signal A: top trouble cluster ────────────────────────────
    const clusters = _ndFindMissClusters(noteResults);
    if (clusters.length > 0) {
        const top = clusters[0];
        const mm = Math.floor(top.startSec / 60);
        const ss = Math.floor(top.startSec % 60).toString().padStart(2, '0');
        const endMm = Math.floor(top.endSec / 60);
        const endSs = Math.floor(top.endSec % 60).toString().padStart(2, '0');
        const missCount = top.notes.filter(n => n && !n.hit && !n.ignoredAsDetectorFailure).length;
        candidates.push({
            text: `Drill ${mm}:${ss}–${endMm}:${endSs} — ${missCount} miss${missCount === 1 ? '' : 'es'} clustered here.`,
            detail: `Densest trouble zone in the song`,
            score: missCount * (top.endSec - top.startSec + 1),
            signal: 'cluster',
        });
    }

    // ── Signal B: systematic timing bias ──────────────────────────
    const timingErrors = [];
    for (const r of noteResults) {
        if (!r || r.ignoredAsDetectorFailure) continue;
        if (r.hit && typeof r.timingError === 'number' && Number.isFinite(r.timingError)) {
            timingErrors.push(r.timingError);
        }
    }
    // Need a meaningful sample before scolding — single-play noise
    // shouldn't fire a "you're consistently late" cue. 30 hits ≈ a
    // verse of bass; that's our floor.
    if (timingErrors.length >= 30) {
        timingErrors.sort((a, b) => a - b);
        const median = timingErrors[Math.floor((timingErrors.length - 1) * 0.5)];
        const absMedian = Math.abs(median);
        if (absMedian > timingThresholdMs) {
            const direction = median > 0 ? 'late' : 'early';
            const action = median > 0
                ? "You're consistently behind the beat. Anticipate the click instead of waiting for the visual cue."
                : "You're consistently ahead of the beat. Hold the upbeat for one extra moment before plucking.";
            candidates.push({
                text: `You're ${Math.round(absMedian)}ms ${direction} on hits. ${action}`,
                detail: `Median across ${timingErrors.length} hits · threshold ${timingThresholdMs}ms`,
                score: absMedian * Math.min(timingErrors.length, 50) / 100,
                signal: 'timing_bias',
            });
        }
    }

    // ── Signal C: weakest string ──────────────────────────────────
    const stringStats = new Map();
    for (const r of noteResults) {
        if (!r || r.ignoredAsDetectorFailure) continue;
        const sf = r.chartNote || r.note;
        if (!sf || typeof sf.s !== 'number') continue;
        const stat = stringStats.get(sf.s) || { attempts: 0, misses: 0 };
        stat.attempts++;
        if (!r.hit) stat.misses++;
        stringStats.set(sf.s, stat);
    }
    let totalAttempts = 0, totalMisses = 0;
    for (const stat of stringStats.values()) {
        totalAttempts += stat.attempts;
        totalMisses += stat.misses;
    }
    const overallMissRate = totalAttempts > 0 ? totalMisses / totalAttempts : 0;
    if (totalAttempts >= 10) {
        // String index → display label. Slopsmith uses string 0 = lowest
        // pitch (matching tab convention) — bass goes E A D G, guitar
        // E A D G B E. Picked the string with the worst rate that
        // exceeds both an absolute floor (40%) and a relative one
        // (1.5× overall) so we don't flag a clean string as weak just
        // because it had one bad attempt.
        const isBass = String(arrangement).toLowerCase() === 'bass';
        const stringNames = isBass
            ? ['E (low)', 'A', 'D', 'G (high)']
            : ['E (low)', 'A', 'D', 'G', 'B', 'E (high)'];
        let worst = null;
        for (const [s, stat] of stringStats) {
            if (stat.attempts < 5) continue;
            const rate = stat.misses / stat.attempts;
            if (rate >= 0.4 && rate >= overallMissRate * 1.5) {
                if (!worst || rate > worst.rate) {
                    worst = { s, rate, attempts: stat.attempts, misses: stat.misses };
                }
            }
        }
        if (worst) {
            const stringLabel = stringNames[worst.s] || `string ${worst.s + 1}`;
            candidates.push({
                text: `${stringLabel} string is your weak point — ${Math.round(worst.rate * 100)}% miss rate vs ${Math.round(overallMissRate * 100)}% overall.`,
                detail: `${worst.misses} of ${worst.attempts} attempts on this string failed`,
                score: (worst.rate - overallMissRate) * worst.attempts,
                signal: 'per_string',
            });
        }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, 3);
}

// Render the top-3 prescriptions as a colored panel. Empty list
// surfaces a "not enough data yet" placeholder. Tier numbers (1/2/3)
// pick up colored severity ramp matching the rest of the modal:
// red → orange → yellow.
function _ndRenderPrescriptionsBlock(top3) {
    if (!top3 || top3.length === 0) {
        return `<div class="bg-dark-800 border border-gray-700 rounded p-3 mb-3">
            <div class="text-gray-400 text-xs">Not enough data yet for actionable advice. Play through the full song or loop a section.</div>
        </div>`;
    }
    const tierColor = ['#f87171', '#fb923c', '#facc15'];
    const rows = top3.map((p, i) => `
        <div class="flex items-start gap-2 mb-2 last:mb-0">
            <span class="text-base font-bold mt-0.5" style="color:${tierColor[i] || '#facc15'}">${i + 1}.</span>
            <div class="flex-1 min-w-0">
                <div class="text-gray-100 text-sm">${p.text}</div>
                ${p.detail ? `<div class="text-gray-500 text-[10px] font-mono">${p.detail}</div>` : ''}
            </div>
        </div>
    `).join('');
    return `<div class="bg-dark-800 border border-orange-700/40 rounded p-3 mb-3">
        <div class="text-orange-400 text-xs font-semibold mb-2 uppercase tracking-wide">Top 3 things to fix</div>
        ${rows}
    </div>`;
}

function _ndExportCoachingAnalysis(play, opts = {}) {
    const { sections = [], totalDuration = 0, heatmapBinSec = 5 } = opts;
    const noteResults = (play && play.noteResults) || [];

    const derived = _ndScoresFromNotes(noteResults);
    const perSection = _ndAggregateBySection(noteResults, sections);
    const clusters = _ndFindMissClusters(noteResults);
    const timeHeatmap = _ndComputeTimeHeatmap(noteResults, totalDuration, heatmapBinSec);

    // Axis-level fallback for `topFix`. Cluster-based selection (which
    // requires reading dominant failure mode per cluster) is deferred
    // to Unit 3c. For now: when scoring identifies a clear weakest
    // axis, surface global coaching for it; otherwise topFix stays null
    // and the modal renders without a top-of-fold callout.
    let topFix = null;
    const pitch = derived.pitchPct;
    const cov = derived.coverage;
    const timing = derived.timingMedianMs;
    const candidates = [];
    if (pitch != null && pitch < 0.95) {
        candidates.push({
            axis: 'Pitch', severity: 1 - pitch,
            focus: `Pitch was off on ${Math.round((1 - pitch) * 100)}% of detected notes`,
            advice: 'Practice the fingering pattern silently first. Common causes: catching adjacent open strings, octave confusion on bass, or fret-buzz on heavily distorted signals.',
        });
    }
    if (cov != null && cov < 0.95) {
        candidates.push({
            axis: 'Coverage', severity: 1 - cov,
            focus: `${Math.round((1 - cov) * 100)}% of notes produced no detection`,
            advice: 'Pluck harder, or check your input gain. If the chart is dense (chords, fast runs), the detector may need more attack energy to fire onsets between sustains.',
        });
    }
    if (timing != null && Math.abs(timing) >= 30) {
        const dir = timing > 0 ? 'late' : 'early';
        candidates.push({
            axis: 'Timing',
            severity: Math.min(1, Math.abs(timing) / 100),
            focus: `Consistently ${dir} by ~${Math.abs(Math.round(timing))}ms across the song`,
            advice: timing > 0
                ? `Late skew is usually one of two things: either the A/V offset is uncalibrated (use [/] keys to nudge), or you are reacting to notes instead of anticipating them. Drill at ${Math.round(_ND_DRILL_SLOW_SPEED * 100)}% speed to give yourself a beat more reaction time.`
                : 'Early skew is usually A/V offset uncalibrated (use [/] keys to nudge). If it persists after calibration, you are anticipating ahead of the beat — drill with the click track on to lock the timing.',
        });
    }
    if (candidates.length) {
        candidates.sort((a, b) => b.severity - a.severity);
        const c = candidates[0];
        topFix = {
            kind: 'axis',
            axis: c.axis,
            focus: c.focus,
            advice: c.advice,
            color: '#60a5fa',
        };
    }

    // Serialize the perSection Map as a plain object so tests/JSON
    // round-trips don't have to learn about the Map shape.
    const perSectionObj = {};
    for (const [name, row] of perSection) {
        perSectionObj[name] = {
            hits: row.hits,
            misses: row.misses,
            total: row.total,
            accuracy: row.accuracy,
        };
    }

    return {
        derived,
        clusters,
        perSection: perSectionObj,
        timeHeatmap,
        topFix,
        sections,        // pass-through for renderers that need section order
        totalDuration,
    };
}

// ── Coaching review modal ─────────────────────────────────────────────────
//
// Pops at session boundaries (song end, restart, loop-clear, detect-off)
// to show the player how the just-finished play went. The modal is the
// primary post-play surface — distinct from drilling (live, intra-loop)
// or the cross-song history view (Unit 3e — separate fetch).
//
// Routing: drill buttons call `window.noteDetect.startDrillRange(...)`,
// which means the default singleton owns the drill session. Splitscreen
// per-panel review modals are deferred until a more complex routing
// scheme is needed.
//
// Modal MVP (this unit, Unit 3c):
//   - Header: song title + Detection/Precision score tiles + close X
//   - Top-fix banner (axis-level only; cluster-kind needs Unit 3c
//     follow-on with the failure-mode classifier)
//   - Sub-score tiles (Pitch / Timing / Coverage)
//   - Trouble-spot cluster list with Drill buttons (full speed only;
//     slow-speed recommendation needs cluster.analysis from a
//     follow-on unit)
//   - Close on X / outside-click / Escape
//
// Deferred to follow-on units:
//   3d  Time heatmap SVG
//   3e  History toggle (line chart of past plays)
//   3f  Improvement deltas (delta slot ids are already in the markup
//       so 3f only needs to populate them)
//   3c+ cluster.analysis enrichment (focus sentence, recommendedSpeed)
const _ND_REVIEW_SOURCE_LABELS = {
    song_end:   'Song complete',
    restart:    'Restarted',
    loop_clear: 'Loop ended',
    detect_off: 'Detect off',
};

function _ndRenderSubScoreTile(label, valueText, color, deltaSlotId) {
    // deltaSlotId is the id of an empty span Unit 3f will patch into.
    // Render the slot empty initially so the modal opens immediately;
    // the delta badge appears when the prior-play fetch resolves.
    const deltaHtml = deltaSlotId
        ? `<div id="${deltaSlotId}" class="text-[10px] mt-0.5 text-gray-500">&nbsp;</div>`
        : '';
    return `
        <div class="bg-dark-700 border border-gray-700 rounded-lg px-4 py-3 text-center">
            <div class="text-gray-500 text-[11px] uppercase tracking-wide">${label}</div>
            <div class="text-2xl font-bold mt-1" style="color:${color}">${valueText}</div>
            ${deltaHtml}
        </div>
    `;
}

// Render the time-binned heatmap as a single SVG row. Each bin is one
// colored rect; empty bins (no notes) get a neutral dark color so the
// player can see "no chart notes here" vs "missed every note here."
// Section boundaries overlay as faint vertical ticks with labels.
//
// Section field name compatibility: upstream's getSections() emits
// `sec.time`; the older annotation shape used `sec.startTime`. Read
// both so the renderer works against either.
function _ndRenderTimeHeatmapSvg(timeHeatmap, totalDuration, sections) {
    const width = 800, barH = 32, labelBand = 14;
    if (!timeHeatmap || timeHeatmap.length === 0 || totalDuration <= 0) {
        return `<svg width="100%" height="${labelBand + barH}" viewBox="0 0 ${width} ${labelBand + barH}"></svg>`;
    }
    let cells = '';
    for (const bin of timeHeatmap) {
        const x = (bin.startSec / totalDuration) * width;
        const w = Math.max(1, ((bin.endSec - bin.startSec) / totalDuration) * width);
        const color = bin.score == null ? '#1f2937' : _ndScoreColor(bin.score);
        const title = bin.score == null
            ? `${_ndFmtMmSs(bin.startSec)}–${_ndFmtMmSs(bin.endSec)}: no notes`
            : `${_ndFmtMmSs(bin.startSec)}–${_ndFmtMmSs(bin.endSec)}: ${Math.round(bin.score * 100)}% (${bin.hits}/${bin.totalNotes})`;
        cells += `<rect x="${x.toFixed(1)}" y="${labelBand}" width="${w.toFixed(1)}" height="${barH}" fill="${color}" stroke="#0a0a0a" stroke-width="0.3"><title>${title}</title></rect>`;
    }
    let secLayer = '';
    if (sections && sections.length) {
        for (const sec of sections) {
            const t = sec.time ?? sec.startTime ?? sec.start ?? 0;
            if (t > totalDuration) continue;
            const x = (t / totalDuration) * width;
            secLayer += `<line x1="${x.toFixed(1)}" y1="${labelBand}" x2="${x.toFixed(1)}" y2="${labelBand + barH}" stroke="#9ca3af" stroke-width="0.6" opacity="0.6"/>`;
            secLayer += `<text x="${(x + 2).toFixed(1)}" y="${labelBand - 3}" fill="#9ca3af" font-size="9" opacity="0.85">${sec.name || ''}</text>`;
        }
    }
    return `<svg width="100%" viewBox="0 0 ${width} ${labelBand + barH}" preserveAspectRatio="none">${secLayer}${cells}</svg>`;
}

// Render per-section accuracy as a single SVG row. Each section is one
// colored rect, width-proportional to its duration. Sparse charts (CDLCs
// with 2 sections covering 4 minutes) make this strip less informative
// than the time-binned heatmap above, but it's still useful when section
// boundaries are meaningful musical structure.
//
// Accepts perSection as either a Map (Unit 3a output) or a plain object
// (Unit 3b's serialized form). Both paths produce the same SVG.
function _ndRenderSectionHeatmapSvg(perSection, sections, totalDuration) {
    const width = 800, height = 32;
    if (!sections || !sections.length || totalDuration <= 0) {
        return `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}"></svg>`;
    }
    const lookup = (name) => {
        if (!perSection) return null;
        if (typeof perSection.get === 'function') return perSection.get(name);
        return perSection[name];
    };
    let cells = '';
    for (let i = 0; i < sections.length; i++) {
        const sec = sections[i];
        const next = sections[i + 1];
        const start = sec.time ?? sec.startTime ?? sec.start ?? 0;
        const end = next
            ? (next.time ?? next.startTime ?? next.start ?? totalDuration)
            : totalDuration;
        const x = (start / totalDuration) * width;
        const w = Math.max(1, ((end - start) / totalDuration) * width);
        const row = lookup(sec.name);
        const accuracy = row && typeof row.accuracy === 'number' ? row.accuracy : null;
        const color = _ndScoreColor(accuracy);
        const title = row && row.total > 0
            ? `${sec.name}: ${Math.round((accuracy || 0) * 100)}% (${row.hits}/${row.total})`
            : `${sec.name || ''}: no notes`;
        cells += `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${height}" fill="${color}" stroke="#1f2937" stroke-width="0.5"><title>${title}</title></rect>`;
    }
    return `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${cells}</svg>`;
}

function _ndRenderClusterRow(cluster, idx) {
    // Cluster accuracy uses the SAME _ndScoresFromNotes the headline
    // does, so a 79% headline can't coexist with cluster rows showing
    // 92% and confuse the user about which number is real.
    const clusterScores = _ndScoresFromNotes(cluster.notes);
    const accuracy = clusterScores.combined;
    const accColor = _ndScoreColor(accuracy);
    const span = `${_ndFmtMmSs(cluster.startSec)}–${_ndFmtMmSs(cluster.endSec)}`;
    const dur = (cluster.endSec - cluster.startSec).toFixed(1);
    // Focus sentence is a placeholder until cluster.analysis lands —
    // surface the raw counts so the row is informative regardless.
    return `
        <div class="bg-dark-700 border border-gray-700 rounded-lg px-3 py-2">
            <div class="flex items-center gap-3">
                <div class="font-mono text-xl font-bold w-20 text-center" style="color:${accColor}">${span}</div>
                <div class="flex-1 min-w-0">
                    <div class="text-gray-200 text-sm font-medium">
                        ${cluster.misses} off-target in ${dur}s
                        <span id="nd-cluster-delta-${idx}" class="ml-2 text-[11px]">&nbsp;</span>
                    </div>
                    <div class="text-[11px] text-gray-500">
                        ${cluster.total} note${cluster.total === 1 ? '' : 's'} in window
                    </div>
                </div>
                <div class="flex flex-col gap-1 shrink-0">
                    <button data-drill-cluster="${idx}" data-drill-speed="1.0"
                            class="px-3 py-1.5 bg-blue-900/70 hover:bg-blue-800 rounded text-xs text-blue-100 font-semibold whitespace-nowrap">
                        Drill this
                    </button>
                    <button data-drill-cluster="${idx}" data-drill-speed="${_ND_DRILL_SLOW_SPEED}"
                            class="px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded text-[11px] text-gray-300 whitespace-nowrap">
                        @ ${Math.round(_ND_DRILL_SLOW_SPEED * 100)}%
                    </button>
                </div>
            </div>
        </div>
    `;
}

async function _ndShowCoachingReview({ playId, source }) {
    document.getElementById('nd-review-modal')?.remove();
    let play;
    try {
        const r = await fetch(`/api/plugins/note_detect/play/${playId}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        play = await r.json();
    } catch (e) {
        console.warn('[note_detect] review fetch failed:', e);
        return;
    }
    const hw = window.highway;
    const sections = (hw && hw.getSections && hw.getSections()) || [];
    const songInfo = hw && hw.getSongInfo && hw.getSongInfo();
    const totalDuration = (songInfo && songInfo.duration) || 0;

    // SINGLE SOURCE OF TRUTH for the modal's numbers. Unit 3b's
    // exportCoachingAnalysis is the same function the test harness calls,
    // so a coaching change can never produce different results in
    // production vs tests.
    const analysis = _ndExportCoachingAnalysis(play, { sections, totalDuration });
    const { derived, clusters, topFix, timeHeatmap, perSection } = analysis;

    const pitchPctText = derived.pitchPct != null
        ? `${Math.round(derived.pitchPct * 100)}%` : '—';
    const coverageText = derived.coverage != null
        ? `${Math.round(derived.coverage * 100)}%` : '—';
    const timingText = derived.timingMedianMs != null
        ? `${Math.round(derived.timingMedianMs)} ±${Math.round(derived.timingStdMs || 0)}ms`
        : '—';
    const combinedColor = _ndScoreColor(derived.combined);
    const precisionColor = derived.precision != null ? _ndScoreColor(derived.precision) : '#4b5563';
    const precisionText = derived.precision != null
        ? Math.round(derived.precision * 100) + '%' : '—';

    const modal = document.createElement('div');
    modal.id = 'nd-review-modal';
    modal.className = 'fixed inset-0 z-[300] flex items-center justify-center bg-black/70 backdrop-blur-sm';

    // Top-fix banner — axis-level (cluster-kind requires the failure-
    // mode classifier and is therefore null until that lands).
    const topFixHtml = topFix && topFix.kind === 'axis' ? `
        <div class="px-5 py-3 bg-gradient-to-r from-blue-900/30 to-transparent border-b border-blue-800/40">
            <div class="flex items-start gap-3">
                <div class="text-2xl leading-none mt-0.5">🎯</div>
                <div class="flex-1 min-w-0">
                    <div class="text-blue-200 text-xs uppercase tracking-wide font-semibold">Top fix · ${topFix.axis}</div>
                    <div class="text-gray-100 text-sm font-medium mt-0.5">${topFix.focus}</div>
                    ${topFix.advice ? `
                    <div class="text-gray-400 text-[12px] mt-1 leading-snug">${topFix.advice}</div>` : ''}
                </div>
            </div>
        </div>
    ` : '';

    modal.innerHTML = `
        <div class="bg-dark-800 border border-gray-700 rounded-xl shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-auto m-4">
            <div class="sticky top-0 bg-dark-800 border-b border-gray-700 px-5 py-3 flex items-center justify-between z-10">
                <div class="min-w-0 flex-1">
                    <div class="text-gray-200 font-semibold truncate">${(songInfo && songInfo.title) || play.songId || 'Song'}</div>
                    <div class="text-gray-500 text-xs">
                        ${_ND_REVIEW_SOURCE_LABELS[source] || source || 'Review'}
                        · ${play.playedAt ? new Date(play.playedAt).toLocaleString() : ''}
                        · ${(play.noteResults || []).length} notes
                    </div>
                </div>
                <div class="flex items-center gap-3 ml-4">
                    <div class="text-right">
                        <div class="text-[10px] text-gray-500 uppercase tracking-wide">Detection</div>
                        <div class="text-2xl font-bold leading-none" style="color:${combinedColor}">${
                            derived.total > 0 ? Math.round(derived.combined * 100) + '%' : '—'
                        }</div>
                        <div id="nd-delta-combined" class="text-[10px] mt-0.5 text-gray-500">&nbsp;</div>
                    </div>
                    <div class="text-right">
                        <div class="text-[10px] text-gray-500 uppercase tracking-wide">Precision</div>
                        <div class="text-2xl font-bold leading-none" style="color:${precisionColor}">${precisionText}</div>
                        <div class="text-[10px] mt-0.5 text-gray-500">of ${derived.hits} hits</div>
                    </div>
                    <button id="nd-review-close" class="text-gray-500 hover:text-gray-200 text-3xl leading-none px-2">×</button>
                </div>
            </div>

            ${topFixHtml}

            <div id="nd-prescriptions-slot" class="mx-5 mt-4">
                ${_ndRenderPrescriptionsBlock(_ndComputePrescriptions(play.noteResults || [], {
                    arrangement: (play.settings && play.settings.arrangement) || (songInfo && songInfo.arrangement) || 'guitar',
                })).replace('class="bg-dark-800 border border-orange-700/40 rounded p-3 mb-3"', 'class="bg-dark-800 border border-orange-700/40 rounded p-3"')}
            </div>

            <div class="grid grid-cols-3 gap-3 px-5 py-4 border-b border-gray-700">
                ${_ndRenderSubScoreTile('Pitch', pitchPctText, _ndScoreColor(derived.pitchPct), 'nd-delta-pitch')}
                ${_ndRenderSubScoreTile('Timing', timingText, _ndScoreColor(
                    derived.timingMedianMs != null ? Math.max(0, 1 - Math.abs(derived.timingMedianMs) / 100) : null
                ), 'nd-delta-timing')}
                ${_ndRenderSubScoreTile('Coverage', coverageText, _ndScoreColor(derived.coverage), 'nd-delta-coverage')}
            </div>

            ${timeHeatmap && timeHeatmap.length ? `
            <div class="px-5 py-4 border-b border-gray-700">
                <div class="text-gray-400 text-xs mb-2 flex justify-between">
                    <span>Heatmap — ${Math.round(timeHeatmap[0].endSec - timeHeatmap[0].startSec)}s bins</span>
                    <span class="text-gray-600">hover for breakdown</span>
                </div>
                <div class="rounded overflow-hidden border border-gray-700">
                    ${_ndRenderTimeHeatmapSvg(timeHeatmap, totalDuration, sections)}
                </div>
            </div>` : ''}

            ${sections && sections.length ? `
            <div class="px-5 py-4 border-b border-gray-700">
                <div class="text-gray-400 text-xs mb-2">Per-section accuracy</div>
                <div class="rounded overflow-hidden border border-gray-700">
                    ${_ndRenderSectionHeatmapSvg(perSection, sections, totalDuration)}
                </div>
            </div>` : ''}

            <div class="px-5 py-4 border-b border-gray-700">
                <div class="text-gray-400 text-xs mb-2">Trouble spots — densest miss clusters</div>
                <div class="space-y-1.5">
                    ${clusters.length === 0
                        ? '<div class="text-gray-500 text-xs italic">No trouble clusters — clean play.</div>'
                        : clusters.map((c, i) => _ndRenderClusterRow(c, i)).join('')
                    }
                </div>
            </div>

            <div class="px-5 py-4">
                <button id="nd-review-history-toggle"
                        class="text-gray-400 hover:text-gray-200 text-xs flex items-center gap-1">
                    <span class="nd-history-arrow">▸</span> History — improvement over time
                </button>
                <div id="nd-review-history" class="hidden mt-3"></div>
            </div>

            <div class="px-5 py-4 border-t border-gray-800">
                <button id="nd-review-heatmap-toggle"
                        class="text-gray-400 hover:text-gray-200 text-xs flex items-center gap-1">
                    <span class="nd-heatmap-arrow">▸</span> Fretboard heatmap — where you missed
                </button>
                <div id="nd-review-heatmap" class="hidden mt-3">
                    <div class="flex items-center gap-2 mb-2 text-xs">
                        <button id="nd-heatmap-mode-this" class="px-2 py-0.5 bg-blue-700 text-white rounded">This play</button>
                        <button id="nd-heatmap-mode-all" class="px-2 py-0.5 bg-dark-600 hover:bg-dark-500 text-gray-300 rounded">Last 10 plays</button>
                    </div>
                    <div id="nd-heatmap-grid" class="bg-dark-700 border border-gray-700 rounded p-2"></div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // Dismissal: X button, click outside, Escape.
    const close = () => {
        modal.remove();
        document.removeEventListener('keydown', escHandler);
    };
    const escHandler = (e) => { if (e.key === 'Escape') close(); };
    modal.querySelector('#nd-review-close').onclick = close;
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', escHandler);

    // Cluster Drill buttons — route to the default singleton.
    // Splitscreen per-panel routing is deferred; the default singleton
    // is what the post-play modal speaks to in the standard
    // single-panel use case.
    modal.querySelectorAll('[data-drill-cluster]').forEach(btn => {
        btn.onclick = () => {
            const idx = parseInt(btn.getAttribute('data-drill-cluster'), 10);
            const speedAttr = btn.getAttribute('data-drill-speed');
            const speedMul = speedAttr ? parseFloat(speedAttr) : 1.0;
            const cluster = clusters[idx];
            if (!cluster) {
                console.warn('[note_detect] cluster idx not found:', idx);
                return;
            }
            const detector = window.noteDetect;
            if (!detector || typeof detector.startDrillRange !== 'function') {
                console.warn('[note_detect] no default detector to drill on');
                return;
            }
            close();
            detector.startDrillRange(
                cluster.startSec, cluster.endSec,
                `cluster ${idx + 1}`,
                { speedMul }
            );
        };
    });

    // Unit 3e: lazy-load the history line chart on first expand.
    // Subsequent expands toggle visibility without re-fetching.
    const historyToggle = modal.querySelector('#nd-review-history-toggle');
    const historyEl = modal.querySelector('#nd-review-history');
    let historyLoaded = false;
    historyToggle.onclick = () => {
        const arrow = historyToggle.querySelector('.nd-history-arrow');
        if (historyEl.classList.contains('hidden')) {
            historyEl.classList.remove('hidden');
            arrow.textContent = '▾';
            if (!historyLoaded && play && play.songId) {
                historyLoaded = true;
                historyEl.innerHTML = '<div class="text-gray-500 text-xs italic">Loading history...</div>';
                _ndRenderReviewHistory(historyEl, play.songId).catch(() => {
                    historyEl.innerHTML = '<div class="text-red-400 text-xs">History fetch failed.</div>';
                });
            }
        } else {
            historyEl.classList.add('hidden');
            arrow.textContent = '▸';
        }
    };

    // Unit 3i: fretboard heatmap. Computed lazily on first expand —
    // the analysis is cheap (single noteResults walk) but rendering
    // the SVG is wasted work if the user never opens it. String
    // count derived from arrangement (bass=4, else 6).
    //
    // Unit 3i+: 'Last 10 plays' toggle aggregates noteResults across
    // recent plays of this song so chronic miss patterns surface
    // (single-play noise vs cross-play consistency). Cached per
    // mode so toggling doesn't re-fetch.
    const heatmapToggle = modal.querySelector('#nd-review-heatmap-toggle');
    const heatmapEl = modal.querySelector('#nd-review-heatmap');
    const heatmapGrid = modal.querySelector('#nd-heatmap-grid');
    const heatmapBtnThis = modal.querySelector('#nd-heatmap-mode-this');
    const heatmapBtnAll = modal.querySelector('#nd-heatmap-mode-all');
    const arrangement = (play.settings && play.settings.arrangement)
        || (songInfo && songInfo.arrangement) || 'guitar';
    const stringCount = String(arrangement).toLowerCase() === 'bass' ? 4 : 6;
    // Cap maxFret on the higher of (this play's max fret, 12) so an
    // open-position song doesn't render 24 columns of empty cells.
    let modalMaxFret = 0;
    for (const r of (play.noteResults || [])) {
        const sf = r && (r.chartNote || r.note);
        if (sf && typeof sf.f === 'number' && sf.f > modalMaxFret) modalMaxFret = sf.f;
    }
    modalMaxFret = Math.min(24, Math.max(12, modalMaxFret));

    let heatmapThisRendered = false;
    let heatmapAllRendered = null;  // null=not loaded, ''=loading, html=ready
    const setMode = (mode) => {
        if (mode === 'this') {
            heatmapBtnThis.className = 'px-2 py-0.5 bg-blue-700 text-white rounded';
            heatmapBtnAll.className = 'px-2 py-0.5 bg-dark-600 hover:bg-dark-500 text-gray-300 rounded';
            if (!heatmapThisRendered) {
                heatmapThisRendered = true;
                const grid = _ndComputeFretboardHeatmap(play.noteResults || [], { stringCount, maxFret: modalMaxFret });
                // Stash the rendered HTML so a re-toggle doesn't recompute.
                heatmapGrid._htmlThis = _ndRenderFretboardHeatmapSvg(grid, stringCount, modalMaxFret);
            }
            heatmapGrid.innerHTML = heatmapGrid._htmlThis;
        } else {
            heatmapBtnAll.className = 'px-2 py-0.5 bg-blue-700 text-white rounded';
            heatmapBtnThis.className = 'px-2 py-0.5 bg-dark-600 hover:bg-dark-500 text-gray-300 rounded';
            if (heatmapAllRendered === null && play.songId) {
                heatmapAllRendered = '';
                heatmapGrid.innerHTML = '<div class="text-gray-500 text-xs italic p-2">Loading aggregate...</div>';
                fetch(`/api/plugins/note_detect/plays?songId=${encodeURIComponent(play.songId)}&limit=10`)
                    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
                    .then(data => {
                        const allNotes = [];
                        let aggMaxFret = modalMaxFret;
                        for (const p of (data.plays || [])) {
                            for (const r of (p.noteResults || [])) {
                                allNotes.push(r);
                                const sf = r && (r.chartNote || r.note);
                                if (sf && typeof sf.f === 'number' && sf.f > aggMaxFret) aggMaxFret = sf.f;
                            }
                        }
                        aggMaxFret = Math.min(24, Math.max(12, aggMaxFret));
                        if (allNotes.length === 0) {
                            heatmapAllRendered = '<div class="text-gray-500 text-xs italic p-2">No prior plays for this song yet.</div>';
                        } else {
                            const grid = _ndComputeFretboardHeatmap(allNotes, { stringCount, maxFret: aggMaxFret });
                            heatmapAllRendered = _ndRenderFretboardHeatmapSvg(grid, stringCount, aggMaxFret);
                        }
                        // Only paint if user is still viewing the all-plays mode.
                        if (heatmapBtnAll.className.includes('bg-blue-700')) {
                            heatmapGrid.innerHTML = heatmapAllRendered;
                        }
                    })
                    .catch(() => {
                        heatmapAllRendered = '<div class="text-red-400 text-xs p-2">Aggregate fetch failed.</div>';
                        if (heatmapBtnAll.className.includes('bg-blue-700')) {
                            heatmapGrid.innerHTML = heatmapAllRendered;
                        }
                    });
            } else if (heatmapAllRendered) {
                heatmapGrid.innerHTML = heatmapAllRendered;
            }
        }
    };
    heatmapBtnThis.onclick = () => setMode('this');
    heatmapBtnAll.onclick = () => setMode('all');

    let heatmapLoaded = false;
    heatmapToggle.onclick = () => {
        const arrow = heatmapToggle.querySelector('.nd-heatmap-arrow');
        if (heatmapEl.classList.contains('hidden')) {
            heatmapEl.classList.remove('hidden');
            arrow.textContent = '▾';
            if (!heatmapLoaded) {
                heatmapLoaded = true;
                setMode('this');
            }
        } else {
            heatmapEl.classList.add('hidden');
            arrow.textContent = '▸';
        }
    };

    // Unit 3f: patch improvement-delta badges by fetching the most-recent
    // comparable prior play and computing per-axis deltas. Async so the
    // modal renders immediately and the badges fill in when the fetch
    // resolves. Failures are silent — first plays + network errors just
    // leave the slots empty.
    _ndPatchImprovementDeltas(modal, play, derived, clusters).catch(() => {});
}

// Pure: format a delta as a colored badge with arrow + text.
//   axis='timing' — delta is signed |current| - |prior| in ms;
//                   negative = tighter to chart = better.
//   axis='pct'    — delta is signed fraction (current - prior);
//                   positive = better.
function _ndFmtDeltaBadge(delta, axis) {
    if (delta == null) return '<span class="text-gray-600">—</span>';
    if (Math.abs(delta) < 0.0001 && axis !== 'timing') {
        return '<span class="text-gray-500">no change</span>';
    }
    let text, better;
    if (axis === 'timing') {
        const sign = delta > 0 ? '+' : '';
        text = `${sign}${Math.round(delta)}ms`;
        better = delta < 0;  // less |timing| = tighter = better
    } else {
        const pp = Math.round(delta * 100);
        if (pp === 0) return '<span class="text-gray-500">no change</span>';
        const sign = pp > 0 ? '+' : '';
        text = `${sign}${pp}pp`;
        better = pp > 0;
    }
    const color = better ? '#10b981' : '#f97316';
    const arrow = better ? '↑' : '↓';
    return `<span style="color:${color}">${arrow} ${text}</span> vs last`;
}

async function _ndPatchImprovementDeltas(modal, currentPlay, currentDerived, currentClusters) {
    if (!currentPlay || !currentPlay.songId) return;
    let plays = [];
    let prior = null;
    try {
        const r = await fetch(
            `/api/plugins/note_detect/plays?songId=${encodeURIComponent(currentPlay.songId)}&limit=10`
        );
        if (!r.ok) return;
        const data = await r.json();
        plays = (data && data.plays) || [];
        prior = plays.find(p =>
            p && p.id !== currentPlay.id && !p.isDrill
        );
    } catch {
        return;
    }

    const setHtml = (id, html) => {
        const el = modal.querySelector('#' + id);
        if (el) el.innerHTML = html;
    };

    // Unit 3g+: cross-play prescriptions. With ≥2 plays in history,
    // aggregate noteResults across them and re-render the
    // prescriptions panel from the combined set. Single-play
    // signals (timing bias, weak string) get much more reliable on
    // 5+ plays of data; chronic miss patterns surface where they'd
    // be hidden by single-play noise. Skipped silently if there's
    // only one play (the synchronously-rendered single-play panel
    // is already accurate).
    if (plays.length >= 2) {
        const allNotes = [];
        for (const p of plays) {
            for (const r of (p.noteResults || [])) allNotes.push(r);
        }
        const arrangement = (currentPlay.settings && currentPlay.settings.arrangement) || 'guitar';
        const top3 = _ndComputePrescriptions(allNotes, { arrangement });
        const slot = modal.querySelector('#nd-prescriptions-slot');
        if (slot && top3.length > 0) {
            const html = _ndRenderPrescriptionsBlock(top3)
                .replace('class="bg-dark-800 border border-orange-700/40 rounded p-3 mb-3"',
                         'class="bg-dark-800 border border-orange-700/40 rounded p-3"')
                .replace('Top 3 things to fix',
                         `Top 3 things to fix · across ${plays.length} plays`);
            slot.innerHTML = html;
        }
    }

    if (!prior) return;  // first attempt — leave slots empty
    const priorScores = _ndScoresFromNotes(prior.noteResults || []);
    const deltas = _ndComputeScoreDeltas(currentDerived, priorScores);
    if (!deltas) return;

    const set = setHtml;
    // Headline (Detection): rendered at the top right of the modal as
    // #nd-delta-combined. Use detection delta (scoresFromNotes returns
    // both combined as alias and detection itself; either matches).
    set('nd-delta-combined',
        deltas.detection != null
            ? _ndFmtDeltaBadge(deltas.detection, 'pct')
            : '<span class="text-gray-600">first attempt</span>');
    set('nd-delta-pitch',
        deltas.pitchPct != null ? _ndFmtDeltaBadge(deltas.pitchPct, 'pct') : '');
    set('nd-delta-coverage',
        deltas.coverage != null ? _ndFmtDeltaBadge(deltas.coverage, 'pct') : '');
    // Timing delta: tighter is better regardless of sign. Pass the
    // SIGNED |abs| delta so _ndFmtDeltaBadge's "less is better"
    // interpretation is correct.
    if (typeof currentDerived.timingMedianMs === 'number'
            && typeof priorScores.timingMedianMs === 'number') {
        const tightenDelta = Math.abs(currentDerived.timingMedianMs)
                           - Math.abs(priorScores.timingMedianMs);
        set('nd-delta-timing', _ndFmtDeltaBadge(tightenDelta, 'timing'));
    }

    // Per-cluster deltas: for each current cluster, find the most-
    // overlapping prior cluster and surface "↑ +Xpp" next to its focus
    // line if the user got better at the same trouble spot. Silent
    // when no overlap (the trouble spot is new) or sub-1pp (noise).
    if (currentClusters && currentClusters.length) {
        const priorClusters = _ndFindMissClusters(prior.noteResults || []);
        for (let i = 0; i < currentClusters.length; i++) {
            const cur = currentClusters[i];
            const match = _ndFindOverlappingPriorCluster(cur, priorClusters);
            if (!match) continue;
            const curScore = _ndScoresFromNotes(cur.notes).detection;
            const priorClusterScore = _ndScoresFromNotes(match.notes).detection;
            const delta = curScore - priorClusterScore;
            if (Math.abs(delta) < 0.005) continue;
            set(`nd-cluster-delta-${i}`, _ndFmtDeltaBadge(delta, 'pct'));
        }
    }
}

// Unit 3e: lazy-loaded history view inside the coaching review modal.
// Fetches the last N plays for this song from the storage backend
// and renders a small line chart of detection-% trend, with reference
// lines at 50/70/90 so the player can see goal-zone progression.
// Drill plays render as smaller stroked dots so iteration noise
// doesn't visually dominate the full-song trend.
async function _ndRenderReviewHistory(container, songId) {
    let plays = [];
    try {
        const r = await fetch(
            `/api/plugins/note_detect/plays?songId=${encodeURIComponent(songId)}&limit=10`
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        plays = (data && data.plays) || [];
    } catch (e) {
        container.innerHTML = `<div class="text-red-400 text-xs">History fetch failed: ${e.message}</div>`;
        return;
    }
    if (plays.length < 2) {
        container.innerHTML = '<div class="text-gray-500 text-xs italic">Need at least 2 plays for a trend.</div>';
        return;
    }
    // Server returns newest-first; reverse for left-to-right
    // chronological display so the rightmost dot is "now."
    const ordered = [...plays].reverse();
    const lineChart = _ndRenderHistoryLineChart(ordered);
    container.innerHTML = `
        <div class="text-gray-400 text-xs mb-1">Detection across last ${ordered.length} play${ordered.length === 1 ? '' : 's'}</div>
        <div class="bg-dark-700 border border-gray-700 rounded p-2">${lineChart}</div>
    `;
}

function _ndRenderHistoryLineChart(plays) {
    const W = 600, H = 100, M = 8;
    // Pull detection from each play's summary. Plays from the v1
    // schema have it; older rows might be null which we filter out.
    const pts = plays.map(p => {
        const v = p && p.summary && p.summary.detection;
        return v == null ? null : Math.max(0, Math.min(1, v));
    });
    if (pts.every(v => v == null)) {
        return '<div class="text-gray-500 text-xs italic">No score data yet (older plays predate scoring fields).</div>';
    }
    const xStep = pts.length > 1 ? (W - 2 * M) / (pts.length - 1) : 0;
    const y = (v) => M + (1 - v) * (H - 2 * M);
    let path = '';
    let dotMarkup = '';
    pts.forEach((v, i) => {
        if (v == null) return;
        const cx = M + i * xStep;
        const cy = y(v);
        path += (path === '' ? `M ${cx} ${cy}` : ` L ${cx} ${cy}`);
        const playId = plays[i].id;
        const isDrill = plays[i].isDrill;
        // Drill plays get a smaller dot with a blue ring so the
        // visual weight matches their context (iteration noise vs
        // full-song attempts).
        dotMarkup += `<circle cx="${cx}" cy="${cy}" r="${isDrill ? 3 : 4}" `
            + `fill="${_ndScoreColor(v)}" `
            + `stroke="${isDrill ? '#60a5fa' : 'transparent'}" `
            + `stroke-width="${isDrill ? 1.5 : 0}">`
            + `<title>play ${playId}: ${Math.round(v * 100)}%${isDrill ? ' (drill)' : ''}</title>`
            + `</circle>`;
    });
    // 50/70/90% reference lines so the user sees goal-zone trends.
    const ref = (v, color, label) => `
        <line x1="${M}" x2="${W - M}" y1="${y(v)}" y2="${y(v)}" stroke="${color}" stroke-width="0.5" stroke-dasharray="2,2"/>
        <text x="${W - M + 2}" y="${y(v) + 3}" fill="${color}" font-size="9">${label}</text>
    `;
    return `
        <svg width="100%" viewBox="0 0 ${W + 28} ${H}" preserveAspectRatio="none">
            ${ref(0.9, '#10b981', '90')}
            ${ref(0.7, '#eab308', '70')}
            ${ref(0.5, '#f97316', '50')}
            <path d="${path}" stroke="#9ca3af" stroke-width="1.5" fill="none"/>
            ${dotMarkup}
        </svg>
    `;
}

// Unit 3h: mid-session iteration banner. Fires after each drill loop
// iteration with a quick "X/Y clean" toast so the user sees impact
// without opening the full modal. Stacks consecutive iterations
// briefly, auto-dismisses after 4s. Translates port-shape judgments
// (hit + timingState + pitchState + ignoredAsDetectorFailure) into
// the four pre-port primary buckets the toast renders.
let _ndIterationBannerCount = 0;
function _ndShowIterationBanner(noteResults) {
    const arr = noteResults instanceof Map
        ? [...noteResults.values()]
        : (Array.isArray(noteResults) ? noteResults : []);
    let clean = 0, dirty = 0, missWrong = 0, missNone = 0;
    for (const r of arr) {
        if (!r || r.ignoredAsDetectorFailure) continue;
        if (r.hit) {
            const timingOk = r.timingState === 'OK' || r.timingState == null;
            const pitchOk = r.pitchState === 'OK' || r.pitchState == null;
            if (timingOk && pitchOk) clean++;
            else dirty++;
        } else if (typeof r.detectedMidi === 'number' && r.detectedMidi >= 0
                   && r.pitchState && r.pitchState !== 'OK') {
            // Detector saw something but pitch was off — wrong-pitch miss.
            missWrong++;
        } else {
            missNone++;
        }
    }
    const total = clean + dirty + missWrong + missNone;
    if (total === 0) return;
    _ndIterationBannerCount++;
    const id = `nd-iteration-toast-${_ndIterationBannerCount}`;

    // Stack: shift older toasts down so consecutive iterations are
    // visible briefly before the previous fades.
    document.querySelectorAll('.nd-iteration-toast').forEach((el, i) => {
        el.style.top = `${20 + (i + 1) * 70}px`;
    });

    const toast = document.createElement('div');
    toast.id = id;
    toast.className = 'nd-iteration-toast fixed right-4 z-[200] bg-dark-800 border border-gray-600 rounded-lg px-4 py-2 text-sm shadow-2xl';
    toast.style.top = '20px';
    toast.style.transition = 'opacity 0.3s, transform 0.3s';
    const cleanPct = total > 0 ? ((clean / total) * 100).toFixed(0) : '0';
    toast.innerHTML = `
        <div class="text-gray-400 text-[10px] mb-0.5">Iteration ${_ndIterationBannerCount} — ${total} notes, ${cleanPct}% clean</div>
        <div class="flex gap-3 items-center">
            <span class="text-green-400">✓ ${clean}</span>
            ${dirty > 0     ? `<span class="text-yellow-400">⚠ ${dirty}</span>`     : ''}
            ${missWrong > 0 ? `<span class="text-orange-400">✗ ${missWrong}</span>` : ''}
            ${missNone > 0  ? `<span class="text-red-400">∅ ${missNone}</span>`     : ''}
        </div>
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(20px)';
        setTimeout(() => toast.remove(), 350);
    }, 4000);
}

async function _ndCrepeDetect(buffer) {
    if (!_ndShared.model) return { freq: -1, confidence: 0 };
    try {
        const input = tf.tensor(buffer, [1, buffer.length]);
        let outputs;
        if (_ndShared.model.execute) {
            outputs = _ndShared.model.execute(input);
        } else {
            outputs = _ndShared.model.predict(input);
        }

        let freq = -1, confidence = 0;
        if (Array.isArray(outputs)) {
            const pitchData = await outputs[0].data();
            const uncData = outputs.length > 1 ? await outputs[1].data() : null;
            const raw = pitchData[0];
            if (raw > 0 && raw < 1) {
                freq = Math.pow(2, 5.661 * raw + 4.0);
            } else if (raw > 20) {
                freq = raw;
            }
            confidence = uncData ? Math.max(0, 1 - uncData[0]) : 0.8;
            outputs.forEach(t => t.dispose());
        } else {
            const pitchData = await outputs.data();
            const raw = pitchData[0];
            if (raw > 0 && raw < 1) {
                freq = Math.pow(2, 5.661 * raw + 4.0);
            } else if (raw > 20) {
                freq = raw;
            }
            confidence = pitchData.length > 1 ? Math.max(0, 1 - pitchData[1]) : 0.8;
            outputs.dispose();
        }
        input.dispose();

        if (freq < 20 || freq > 5000) return { freq: -1, confidence: 0 };
        return { freq, confidence };
    } catch (e) {
        return { freq: -1, confidence: 0 };
    }
}

// ── Factory: createNoteDetector ────────────────────────────────────────────
//
// Returns an independent detector instance. Each instance owns its
// own audio pipeline, scoring, HUD, timers, and DOM subtree. Shared
// resources (CREPE model, tuning tables, FFT scratch) stay at module
// scope to avoid duplication.
//
// Audio lifecycle — important for multi-instance use:
//   - If `audioStream` and `audioCtx` are passed in `options`, this
//     instance is a BORROWER. disable() disconnects its own nodes
//     but does NOT stop the stream or close the context; the parent
//     owns those.
//   - If neither is passed, the instance OWNS an AudioContext and
//     MediaStream that it creates on enable() and tears down on
//     disable(). The default singleton operates this way.
//   - No reference counting — shared lifecycle is the parent's
//     responsibility.
//
// Options:
//   highway      — highway instance (default: window.highway)
//   container    — DOM parent for the instance's HUD/panels
//                  (default: document.getElementById('player'))
//   channel      — -1 (mono mix, default), 0 (left), 1 (right)
//   audioStream  — optional shared MediaStream (borrowing mode)
//   audioCtx     — optional shared AudioContext (borrowing mode)
//   isDefault    — true for the singleton; only the default instance
//                  persists settings changes to localStorage
//
// Returns an API object with:
//   enable()         — async; start audio + detection
//   disable()        — stop audio + detection + show summary
//   destroy()        — disable() + remove DOM + unregister instance
//   isEnabled()      — current toggle state
//   getStats()       — {hits, misses, streak, bestStreak, accuracy, sectionStats}
//   setChannel(idx)  — -1=mono, 0=left, 1=right (restarts audio if enabled)
//   injectButton(bar)— insert detect + gear buttons into a control bar
//   showSummary()    — force-show the end-of-song summary modal
function createNoteDetector(options = {}) {
    const opts = options || {};
    // Highway is resolved lazily. A caller can pass `highway` in
    // options for explicit binding (splitscreen per-panel use);
    // otherwise we fall back to `window.highway`, re-checking on
    // every access so late initialization (plugin loads before
    // slopsmith-core defines highway) is picked up automatically.
    let hw = opts.highway || window.highway || null;
    function resolveHw() {
        if (hw) return hw;
        hw = opts.highway || window.highway || null;
        return hw;
    }
    const isDefault = !!opts.isDefault;

    // Audio ownership: if caller passed stream/ctx in, they own the
    // lifecycle. We flag the "borrower" vs "owner" state here and
    // consult it in stopAudio().
    const externalStream = opts.audioStream || null;
    const externalAudioCtx = opts.audioCtx || null;
    // Track ownership of each resource independently — a caller can
    // pass just a stream (we create the context) or just a context
    // (we open getUserMedia for the stream). Basing teardown on
    // `!externalStream` alone would leak a context in the former case.
    const ownsStream = !externalStream;
    const ownsAudioCtx = !externalAudioCtx;

    // ── Per-instance state ────────────────────────────────────────────
    let enabled = false;
    // Session generation — incremented on every disable(). A frame
    // that captures the value at the start of processing and re-checks
    // after an `await _ndCrepeDetect(...)` can drop its result rather
    // than apply stale hits to a disabled (or re-enabled) session.
    let sessionGen = 0;
    let audioCtx = null;
    let stream = null;
    // Full audio-node chain — stored so stopAudio can disconnect
    // every node, not just the ScriptProcessor. Matters particularly
    // in borrower mode (external audioCtx): without tearing these
    // down the caller's context graph grows by N nodes per
    // enable/disable cycle.
    let sourceNode = null;
    let gainNode = null;
    let splitterNode = null;
    let mergerNode = null;
    let worklet = null;
    let levelAnalyser = null;

    // Settings — seed from localStorage defaults (shared with singleton),
    // then override from options where provided. Only the default
    // singleton writes back to localStorage; non-default instances keep
    // mutations local.
    let detectionMethod = 'yin';
    // Whether the user has explicitly picked a method via the gear
    // panel. False means we're on the default and free to auto-switch
    // based on arrangement (bass → HPS for suppressed-fundamental
    // recovery). True means respect the user's choice.
    let methodExplicit = false;
    // Detection (wide) and Precision (tight) thresholds are now fixed
    // module constants — see _ND_DETECTION_* / _ND_PRECISION_*. Kept as
    // const aliases here so the matcher / labeler code below reads
    // naturally without per-call constant references. Anything that
    // tries to mutate these in localStorage-load is a leftover from
    // the strictness UI and is now a silent no-op.
    const timingTolerance = _ND_DETECTION_TIMING_SEC;
    const pitchTolerance = _ND_DETECTION_PITCH_CENTS;
    const timingHitThreshold = _ND_PRECISION_TIMING_MS / 1000;
    const pitchHitThreshold = _ND_PRECISION_PITCH_CENTS;
    let showTimingErrors = true;
    let showPitchErrors = true;
    let missMarkerDuration = 2.0;
    let hitGlowDuration = 0.5;
    let inputGain = 1.0;
    let selectedDeviceId = '';
    let selectedChannel = 'mono';
    let latencyOffset = 0.080;
    // Fraction of a chord's strings that must register energy for the chord
    // to count as a hit (0.0–1.0). 0.6 = 60%, matching the brief's default.
    // Lower this for beginners or dense chords; raise it for stricter scoring.
    let chordHitRatio = 0.6;

    try {
        const raw = localStorage.getItem(_ND_STORAGE_KEY);
        if (raw) {
            const s = JSON.parse(raw);
            if (s.deviceId !== undefined) selectedDeviceId = s.deviceId;
            // Allowlist channel — a manually-edited or future-version
            // storage value would otherwise fall through `startAudio`'s
            // `selectedChannel === 'left' ? 0 : 1` check and silently
            // default to the right channel. Same defensive shape as
            // the method allowlist below.
            if (['mono', 'left', 'right'].includes(s.channel)) selectedChannel = s.channel;
            if (s.method && ['yin', 'hps', 'crepe'].includes(s.method)) detectionMethod = s.method;
            if (s.methodExplicit !== undefined) methodExplicit = !!s.methodExplicit;
            // Tolerance/hit-threshold settings used to be persisted from
            // the strictness UI. Now they're fixed two-axis constants
            // (see _ND_DETECTION_* / _ND_PRECISION_* at module scope).
            // Older saves that include these keys are silently ignored
            // — the constants take precedence.
            if (s.showTimingErrors !== undefined) showTimingErrors = !!s.showTimingErrors;
            if (s.showPitchErrors !== undefined) showPitchErrors = !!s.showPitchErrors;
            if (s.missMarkerDuration !== undefined) missMarkerDuration = Math.max(0.5, Math.min(5, s.missMarkerDuration));
            if (s.hitGlowDuration !== undefined) hitGlowDuration = Math.max(0.1, Math.min(2, s.hitGlowDuration));
            if (s.inputGain !== undefined) inputGain = s.inputGain;
            if (s.latencyOffset !== undefined) latencyOffset = s.latencyOffset;
            // Clamp to the slider's range so a stale persisted value
            // (older build, manual edit) can't put scoring in a state the
            // UI can't represent.
            if (s.chordHitRatio !== undefined) chordHitRatio = Math.max(0.25, Math.min(1, s.chordHitRatio));
        }
    } catch (e) { /* localStorage unavailable */ }

    // opts.channel overrides the persisted channel for this instance
    // (used by splitscreen to force left/right per panel).
    if (opts.channel !== undefined && opts.channel !== null) {
        if (opts.channel === 0) selectedChannel = 'left';
        else if (opts.channel === 1) selectedChannel = 'right';
        else if (opts.channel === -1) selectedChannel = 'mono';
    }

    // Audio metering
    let inputLevel = 0;
    let inputPeak = 0;
    let peakDecay = 0;

    // Drill mode — per-instance. Drill is a loop over a short cluster
    // with judgment gated to the [judgeStart, judgeEnd) window so the
    // pre-loop lead-in is audible warm-up without scoring. The lead-in
    // window itself is implied by setActiveLoop's start vs judgeStart.
    let drillActive = false;
    let drillJudgeStart = null;
    let drillJudgeEnd = null;
    let drillLabel = null;
    let drillSavedSpeed = null;
    let drillSpeedMul = 1.0;
    // Iteration tracking — per-loop scoring across the drill session.
    let drillFocus = null;          // string shown in the HUD ("Late by 30ms" etc.)
    let drillGoal = null;           // 0..1 target score
    let drillIterScores = [];       // detection score (0..1) per loop iteration
    let drillBestScore = 0;
    let drillGoalReached = false;   // sticky once user crosses the goal
    // Unit S.2: most-recent snapshotPlay() id, populated when the
    // POST resolves. Modal triggers read this to call /play/{id}
    // without re-fetching the list. null until first session boundary.
    let lastSnapshotPlayId = null;
    // Loop-restart detection (chartTime backward jump > 1s). Refractory
    // suppresses audio-engine seek bouncing from firing 4-6× per real
    // restart.
    let lastSeenChartTime = 0;
    let lastLoopRestartPerf = 0;
    // Drift compensation: rolling median of recent HIT timing errors,
    // applied as a shift in the matcher search center. Self-corrects
    // residual A/V drift the user's static calibration didn't catch.
    let driftBuffer = [];
    let driftEstimateMs = 0;
    // Auto-calibration: was a one-shot latch. That latch was wrong —
    // a player whose drift accumulates mid-song (e.g. tempo speeds up
    // or the player gets tired and lags) couldn't re-calibrate. Now
    // auto-cal can fire repeatedly; the natural cooldown is the
    // buffer reset (needs 4 more hits to trigger again) plus the
    // 50ms threshold (small offsets don't oscillate). Removed
    // autoCalApplied entirely.
    // Onset state. inNote tracks the RMS-envelope hysteresis;
    // reattackRmsBuf is the rolling RMS history used by the re-attack
    // trigger to detect a fresh pluck during sustain.
    let inNote = false;
    let lastOnsetPerfSec = 0;
    let reattackArmed = false;
    let reattackRmsBuf = [];
    let onsetCount = 0;
    // Track recent-peak RMS so getStats can surface "what level is
    // your input ACTUALLY hitting" — useful for verifying the onset
    // threshold matches the audio path's gain.
    let recentRmsPeak = 0;
    // Stability voting state: rolling history of rounded-MIDI values
    // from the last N YIN/HPS frames. The matcher reads stableMidi
    // (the N-of-M voted winner) instead of the raw detectedMidi to
    // suppress single-frame octave-down anomalies on bass.
    let rawMidiHistory = [];
    let stableMidi = -1;
    // Onset-gated matching state. The pre-port matcher only ran
    // matchNotes when an onset had recently fired — without this gate,
    // sustain-bleed frames (where YIN locks on the previous note's
    // sustain) would attempt to match chart notes that aren't really
    // being plucked. pendingOnsetChartT is set when an onset fires
    // (audio thread); the match consumes and clears it.
    let pendingOnsetChartT = null;
    let lastMatchMidi = -1;
    let lastMatchTime = 0;

    // Scoring
    let hits = 0;
    let misses = 0;
    let streak = 0;
    let bestStreak = 0;
    let sectionStats = [];   // [{name, hits, misses}]
    let currentSection = null;
    const noteResults = new Map(); // key -> judgment object

    // Detection state
    let detectedMidi = -1;
    let detectedConfidence = 0;
    let detectedString = -1;
    let detectedFret = -1;
    let detectedDisplayMidi = -1;
    let underBufferWarned = false;
    // Last chord constraint result — shown in HUD when no single note is detected.
    // Reset on song change via resetScoring(). `lastChordTime` is the
    // chart timestamp of the chord that produced these readings; the HUD
    // uses it to age the display out so a stale chord readout doesn't
    // linger past the chord's timing window during silence/noise.
    let lastChordScore = null;
    let lastChordHit = 0;
    let lastChordTotal = 0;
    let lastChordTime = -Infinity;

    // Tuning — per-instance so panels can be on different songs.
    // tuningOffsets is resized to match the actual string count on enable();
    // the initial 6-element array is a safe default for 6-string guitar
    // and is overwritten from hw.getSongInfo() before any detection runs.
    let currentArrangement = 'guitar';
    let tuningOffsets = [0, 0, 0, 0, 0, 0];
    let capo = 0;
    let currentStringCount = 6; // kept in sync with tuningOffsets.length

    // Audio buffers
    let accumBuffer = new Float32Array(0);
    let pendingBuffer = null;
    let processingFrame = false;

    // Timers
    let detectInterval = null;
    let levelRaf = null;
    let hudInterval = null;
    let missCheckInterval = null;
    let gcInterval = null;
    let diagnosticsInterval = null;
    let flashTimeouts = [];

    // ── Recording (Unit 4a) ─────────────────────────────────────────
    // Raw audio capture into a Float32 buffer, time-anchored to chart
    // time. WAV t=0 is captured inside the SP callback on the first
    // sample observed AFTER the chart clock advances past
    // recordArmedChartTime — anchoring at recordStart() time would peg
    // t=0 to a paused-chart position and break offline replay alignment.
    let recording = false;
    let recordChunks = [];
    let recordTotalSamples = 0;
    let recordMaxSamples = 0;
    let recordSampleRate = 48000;
    let recordChartStartTime = 0;
    let recordAnchored = false;
    let recordArmedChartTime = 0;
    let recordFilename = 'auto-recording.wav';

    // Visual-feedback tracking
    let lastHitCount = 0;
    let lastMissCount = 0;
    // HUD recent-results ring: last 8 judgments rendered as an
    // emoji-tier strip so the user can see what just happened
    // without watching the highway. Each entry is one of:
    //   '✓' clean hit, '⚠' dirty hit, '✗' wrong-pitch miss,
    //   '∅' no-detection miss, '·' detector-failure (ignored)
    // Cause line shows the last non-OK judgment in plain text:
    //   "late 80ms on s1/f5", "wrong pitch (heard E1, want D2)",
    //   "no signal".
    const _ND_HUD_RECENT_MAX = 8;
    let hudRecent = [];        // array of {kind, label} max length _ND_HUD_RECENT_MAX
    let hudLastCause = null;   // string or null
    let hudLastJudgmentSeen = 0;  // sentinel for "is there a new judgment to surface?"

    // DOM refs
    const container = opts.container || document.getElementById('player');
    const instanceRoot = document.createElement('div');
    instanceRoot.className = 'nd-instance-root';
    instanceRoot.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    let detectBtn = null;
    let gearBtn = null;
    let restartBtn = null;
    let skipBtn = null;

    // Draw hook — registered once per instance; removed in destroy().
    // The hook itself early-returns when !enabled, so the cost is
    // minimal for a disabled instance. Stored so removeDrawHook() can
    // find the same reference. If `hw` isn't resolved at construction
    // time (plugin loaded before highway), ensureDrawHook retries on
    // first enable.
    const drawHookFn = (ctx, W, H) => drawOverlay(ctx, W, H);
    let drawHookRegistered = false;
    function ensureDrawHook() {
        if (drawHookRegistered) return;
        const h = resolveHw();
        if (h && h.addDrawHook) {
            h.addDrawHook(drawHookFn);
            drawHookRegistered = true;
        }
    }

    // ── Settings persistence (only the default singleton writes) ──────
    // Tolerance/hit-threshold are no longer written: those are now fixed
    // two-axis constants (see _ND_DETECTION_* / _ND_PRECISION_*). Older
    // saves that contain those keys are silently ignored on load.
    function saveSettings() {
        if (!isDefault) return;
        try {
            localStorage.setItem(_ND_STORAGE_KEY, JSON.stringify({
                deviceId: selectedDeviceId,
                channel: selectedChannel,
                method: detectionMethod,
                methodExplicit,
                showTimingErrors,
                showPitchErrors,
                missMarkerDuration,
                hitGlowDuration,
                inputGain,
                latencyOffset,
                chordHitRatio,
            }));
        } catch (e) { /* unavailable */ }
    }

    // ── Audio pipeline ────────────────────────────────────────────────
    async function startAudio() {
        try {
            // Acquire the stream — use the supplied one or open
            // getUserMedia for our own.
            if (externalStream) {
                stream = externalStream;
            } else {
                const constraints = {
                    audio: {
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false,
                        channelCount: 2,
                    }
                };
                if (selectedDeviceId) {
                    constraints.audio.deviceId = { exact: selectedDeviceId };
                }

                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                    const isHttp = location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
                    const msg = isHttp
                        ? 'Microphone access requires HTTPS. You are accessing Slopsmith over HTTP from a non-localhost address. Either:\n\n1. Use a reverse proxy with HTTPS (recommended)\n2. Access via localhost\n3. Add a self-signed certificate to the server'
                        : 'Microphone access is not available in this browser. Use Chrome or Edge.';
                    throw new Error(msg);
                }
                stream = await navigator.mediaDevices.getUserMedia(constraints);
            }

            // Acquire the context independently — a caller can supply
            // just one of {stream, context} and we create the other.
            audioCtx = externalAudioCtx || new (window.AudioContext || window.webkitAudioContext)();

            // First-load avOffset seed from AudioContext.outputLatency.
            // Browser-reported audio output delay (seconds) → avOffset
            // in ms with negative sign for compensation. Only fires
            // ONCE per browser session-key (localStorage flag) so
            // subsequent enables / song switches don't re-seed over
            // the user's manual tuning. Bypasses entirely if the user
            // has explicitly touched avOffset before (avOffsetExplicit
            // flag set by the cal Apply button or [/]+key handler if
            // that becomes pluggable).
            try { _ndSeedAvOffsetIfFresh(audioCtx); } catch (e) { /* non-fatal */ }

            sourceNode = audioCtx.createMediaStreamSource(stream);
            const streamChannels = sourceNode.channelCount;

            gainNode = audioCtx.createGain();
            gainNode.gain.value = inputGain;

            if (streamChannels >= 2 && selectedChannel !== 'mono') {
                splitterNode = audioCtx.createChannelSplitter(2);
                sourceNode.connect(splitterNode);
                mergerNode = audioCtx.createChannelMerger(1);
                const chIdx = selectedChannel === 'left' ? 0 : 1;
                splitterNode.connect(mergerNode, chIdx, 0);
                mergerNode.connect(gainNode);
            } else {
                sourceNode.connect(gainNode);
            }

            levelAnalyser = audioCtx.createAnalyser();
            levelAnalyser.fftSize = 512;
            levelAnalyser.smoothingTimeConstant = 0.8;
            gainNode.connect(levelAnalyser);

            const processor = audioCtx.createScriptProcessor(_ND_FRAME_SIZE, 1, 1);
            worklet = processor;
            accumBuffer = new Float32Array(0);
            pendingBuffer = null;

            processor.onaudioprocess = (e) => {
                if (!enabled) return;
                const input = e.inputBuffer.getChannelData(0);

                // Recording (Unit 4a): copy raw input into recordChunks.
                // Anchor chart-time on the first sample where the chart
                // has advanced past the armed value — anchoring at
                // recordStart() time would peg WAV t=0 to a paused chart.
                if (recording && recordTotalSamples < recordMaxSamples) {
                    if (!recordAnchored) {
                        const _hwRec = resolveHw();
                        const chartNow = _hwRec && _hwRec.getTime ? _hwRec.getTime() : 0;
                        if (chartNow > recordArmedChartTime + 0.001) {
                            recordChartStartTime = chartNow;
                            recordAnchored = true;
                            console.log(`[note_detect] Recording anchor set: WAV t=0 = chart ${chartNow.toFixed(3)}s`);
                            recordChunks.push(new Float32Array(input));
                            recordTotalSamples += input.length;
                        }
                    } else {
                        recordChunks.push(new Float32Array(input));
                        recordTotalSamples += input.length;
                        if (recordTotalSamples >= recordMaxSamples) {
                            console.log('[note_detect] Recording max duration reached, auto-stopping');
                            recordSave(recordFilename);
                        }
                    }
                }

                // RMS for onset detection.
                let sumSq = 0;
                for (let j = 0; j < input.length; j++) sumSq += input[j] * input[j];
                const rms = Math.sqrt(sumSq / input.length);
                // Track the running peak RMS with slow decay so
                // getStats reports a sensible "what was your loudest
                // recent pluck" number for threshold tuning.
                if (rms > recentRmsPeak) recentRmsPeak = rms;
                else recentRmsPeak *= 0.998;

                // Maintain rolling RMS history for the re-attack trigger.
                reattackRmsBuf.push(rms);
                if (reattackRmsBuf.length > _ND_REATTACK_WINDOW) reattackRmsBuf.shift();

                const nowSec = performance.now() / 1000;
                const refractoryOk = (nowSec - lastOnsetPerfSec) > _ND_REATTACK_REFRACTORY_SEC;

                // Re-arm the re-attack gate when the envelope dips
                // below rearm level — confirms previous sustain has
                // genuinely released so a subsequent spike is a fresh
                // pluck rather than body-peak resonance from the
                // ongoing note.
                //
                if (rms < _ND_REATTACK_REARM_LEVEL) reattackArmed = true;

                let fireOnset = false;
                // Trigger 1: silence → playing (fresh note after rest).
                if (rms > _ND_ONSET_LEVEL && !inNote && refractoryOk) {
                    inNote = true;
                    fireOnset = true;
                }
                // Trigger 2: in-note re-attack — RMS spike above recent
                // running min, gated by prior release. Catches rapid
                // same-pitch plucks where sustain keeps inNote=true
                // between attacks.
                else if (inNote && refractoryOk && reattackArmed
                         && rms > _ND_REATTACK_MIN_LEVEL
                         && reattackRmsBuf.length >= 3) {
                    const recentMin = Math.min(...reattackRmsBuf.slice(0, -1));
                    if (rms > recentMin * _ND_REATTACK_RATIO) fireOnset = true;
                }
                // Exit hysteresis — wait for clearly-below to reset
                // inNote so sustain noise doesn't toggle Trigger 1.
                else if (rms < _ND_ONSET_EXIT_LEVEL) {
                    inNote = false;
                }

                if (fireOnset) {
                    // Flush the YIN buffer AND drop this trigger chunk.
                    // The trigger chunk is half pre-attack (previous
                    // sustain) and half post-attack — when previous
                    // sustain is louder than the new attack (soft
                    // pluck after a held note), keeping it lets YIN
                    // lock onto the stale pitch. Returning here drops
                    // the trigger chunk so the next 4096-sample YIN
                    // buffer is built entirely from post-onset chunks.
                    // Costs one extra ScriptProcessor chunk (~43ms) of
                    // latency but is the dominant fix for bass-on-mic
                    // sustain bleed.
                    lastOnsetPerfSec = nowSec;
                    reattackArmed = false;
                    onsetCount++;
                    // Stamp the onset's chart-time so processFrame
                    // can gate matchNotes on it (the post-port
                    // architectural fix). Compensate backwards by
                    // half the chunk duration — the trigger chunk
                    // straddles pre-attack and post-attack so the
                    // actual attack landed ~halfway through the chunk.
                    if (hw && hw.getTime) {
                        pendingOnsetChartT = hw.getTime() - _ND_ONSET_BUFFER_COMP_SEC;
                    }
                    // Flush stability history too — voted MIDI from
                    // the previous note's sustain shouldn't survive
                    // into the new note's matching window.
                    rawMidiHistory = [];
                    stableMidi = -1;
                    accumBuffer = new Float32Array(0);
                    pendingBuffer = null;
                    return;
                }

                const prev = accumBuffer;
                const combined = new Float32Array(prev.length + input.length);
                combined.set(prev);
                combined.set(input, prev.length);
                if (combined.length >= _ND_MIN_YIN_SAMPLES) {
                    const start = combined.length - _ND_MIN_YIN_SAMPLES;
                    pendingBuffer = combined.slice(start, start + _ND_MIN_YIN_SAMPLES);
                    accumBuffer = new Float32Array(0);
                } else {
                    accumBuffer = combined;
                }
            };

            // Detection runs on a timer, not in the audio callback. The
            // in-flight guard matters when CREPE inference takes longer
            // than the 50 ms tick — without it, multiple processFrame
            // promises can be alive at once and resolve out of order,
            // letting a stale detection overwrite a newer one.
            detectInterval = setInterval(() => {
                if (processingFrame || !pendingBuffer) return;
                const buf = pendingBuffer;
                pendingBuffer = null;
                processingFrame = true;
                processFrame(buf).finally(() => { processingFrame = false; });
            }, 50);

            gainNode.connect(processor);
            processor.connect(audioCtx.destination);

            startLevelMeter();
            populateDevices();

            return true;
        } catch (e) {
            console.error('Note detect: mic access denied or failed:', e);
            // Suppress the user-facing alert if the instance is no
            // longer enabled — the enable/restart was superseded by a
            // concurrent disable (e.g. song switch while the mic
            // permission prompt was open). Surfacing an error the
            // user never asked to see in that case is just noise.
            // The console.error still goes to devtools for
            // diagnostics.
            if (enabled) {
                alert('Note Detection: Could not access audio input.\n\n' + e.message);
            }
            // Partial-init cleanup — if we got as far as acquiring the
            // stream or creating any AudioNodes before the throw, we
            // own the teardown. stopAudio is null-safe for every
            // resource and respects ownsStream / ownsAudioCtx, so it
            // handles partial state regardless of where we failed.
            stopAudio();
            return false;
        }
    }

    function stopAudio() {
        stopLevelMeter();
        if (detectInterval) { clearInterval(detectInterval); detectInterval = null; }
        pendingBuffer = null;
        // Disconnect the full node chain in reverse-connect order.
        // Critical in borrower mode (external audioCtx): we leave the
        // caller's context open, and any node we don't disconnect
        // stays live in its graph across enable/disable cycles.
        if (worklet) {
            worklet.onaudioprocess = null;
            try { worklet.disconnect(); } catch (e) { /* already disconnected */ }
            worklet = null;
        }
        if (levelAnalyser) {
            try { levelAnalyser.disconnect(); } catch (e) {}
            levelAnalyser = null;
        }
        if (gainNode) {
            try { gainNode.disconnect(); } catch (e) {}
            gainNode = null;
        }
        if (mergerNode) {
            try { mergerNode.disconnect(); } catch (e) {}
            mergerNode = null;
        }
        if (splitterNode) {
            try { splitterNode.disconnect(); } catch (e) {}
            splitterNode = null;
        }
        if (sourceNode) {
            try { sourceNode.disconnect(); } catch (e) {}
            sourceNode = null;
        }
        // Tear down each resource only if we own it. Ownership is
        // tracked per-resource (see ownsStream / ownsAudioCtx at the
        // top of the factory) so a caller can pass just a stream or
        // just a context without leaking the other.
        if (stream && ownsStream) {
            stream.getTracks().forEach(t => t.stop());
        }
        stream = null;
        if (audioCtx && ownsAudioCtx) {
            try { audioCtx.close(); } catch (e) { /* may already be closed */ }
        }
        audioCtx = null;
        inputLevel = 0;
        inputPeak = 0;
        accumBuffer = new Float32Array(0);
    }

    // Per-instance promise chain that serializes ALL audio-lifecycle
    // operations that await startAudio — both restartAudio and the
    // startAudio call from enable. A generation-only check isn't
    // enough on its own because startAudio() writes to shared
    // instance vars (stream, audioCtx, sourceNode, gainNode, ...)
    // BEFORE the post-await gen check fires. If two operations
    // overlap on getUserMedia, the second's resolved write clobbers
    // the first's refs, and the first's gen-check stopAudio then
    // disconnects the SECOND one's graph. Chaining start/stop onto a
    // single promise prevents overlap entirely.
    let audioOpChain = Promise.resolve();
    function queueAudioOp(fn) {
        const queued = audioOpChain.then(fn);
        // .catch on the chain itself so one rejected op doesn't
        // poison every subsequent call. The caller still sees the
        // unswallowed promise.
        audioOpChain = queued.catch(() => {});
        return queued;
    }

    function restartAudio() {
        return queueAudioOp(async () => {
            sessionGen++;
            const gen = sessionGen;
            stopAudio();
            if (!enabled) return;
            const ok = await startAudio();
            // Treat a restart failure (e.g. mic permission revoked,
            // device unplugged, selected deviceId no longer exists)
            // as a hard disable. Without this, the instance would
            // stay `enabled=true` with HUD + miss-check intervals
            // still running, racking up misses against no audio and
            // showing the Detect button as active. Only fire the
            // disable if we're still the winning operation —
            // otherwise a newer restart or a concurrent disable
            // already owns the teardown.
            if (!ok) {
                if (gen === sessionGen && enabled) {
                    disable({ silent: true });
                }
                return;
            }
            // Even within the chain, disable() can still bump
            // sessionGen and set !enabled between our stop/start
            // and our return. Tear down what startAudio just
            // acquired in that case.
            if (gen !== sessionGen || !enabled) {
                stopAudio();
            }
        });
    }

    // ── Level meter ───────────────────────────────────────────────────
    function startLevelMeter() {
        stopLevelMeter();
        // Cache the analyser read buffer across rAF ticks. At 60 fps
        // with fftSize=512 this was allocating ~120 kB/s per enabled
        // instance; reusing a single Float32Array (re-allocating only
        // if fftSize changes) keeps the meter out of the GC path.
        let levelBuf = null;
        let levelBufSize = 0;
        const tick = () => {
            if (!levelAnalyser) return;
            const fftSize = levelAnalyser.fftSize;
            if (!levelBuf || levelBufSize !== fftSize) {
                levelBuf = new Float32Array(fftSize);
                levelBufSize = fftSize;
            }
            levelAnalyser.getFloatTimeDomainData(levelBuf);
            let sum = 0;
            for (let i = 0; i < levelBuf.length; i++) sum += levelBuf[i] * levelBuf[i];
            const rms = Math.sqrt(sum / levelBuf.length);
            inputLevel = Math.min(1, rms * 5);
            if (inputLevel > inputPeak) {
                inputPeak = inputLevel;
                peakDecay = 30;
            } else if (peakDecay > 0) {
                peakDecay--;
            } else {
                inputPeak *= 0.95;
            }
            drawSettingsVU();
            levelRaf = requestAnimationFrame(tick);
        };
        levelRaf = requestAnimationFrame(tick);
    }

    function stopLevelMeter() {
        if (levelRaf) {
            cancelAnimationFrame(levelRaf);
            levelRaf = null;
        }
    }

    function drawSettingsVU() {
        const bar = instanceRoot.querySelector('.nd-vu-bar');
        const peak = instanceRoot.querySelector('.nd-vu-peak');
        if (!bar) return;
        const pct = Math.round(inputLevel * 100);
        bar.style.width = pct + '%';
        bar.className = pct > 85 ? 'nd-vu-bar h-full rounded transition-all duration-75 bg-red-500'
            : pct > 60 ? 'nd-vu-bar h-full rounded transition-all duration-75 bg-yellow-500'
            : 'nd-vu-bar h-full rounded transition-all duration-75 bg-green-500';
        if (peak) {
            const peakPct = Math.round(inputPeak * 100);
            peak.style.left = Math.min(peakPct, 100) + '%';
        }
    }

    // ── Frame processing ──────────────────────────────────────────────
    async function processFrame(buffer) {
        let result;
        let detectorUsed;
        // Capture the session generation at frame start. disable()
        // increments sessionGen, so any frame that was already running
        // past an `await` sees a changed generation and bails rather
        // than apply stale hits / fire stale events. Without this
        // guard a CREPE inference in flight during song switch would
        // score against the old session's chart.
        const gen = sessionGen;
        const sr = audioCtx ? audioCtx.sampleRate : 48000;
        switch (detectionMethod) {
            case 'crepe':
                if (_ndShared.model) {
                    result = await _ndCrepeDetect(buffer);
                    detectorUsed = 'crepe';
                    if (result.freq <= 0 || result.confidence < 0.3) {
                        result = _ndYinDetect(buffer, sr);
                        detectorUsed = 'yin';
                    }
                    break;
                }
                result = _ndYinDetect(buffer, sr);
                detectorUsed = 'yin';
                break;
            case 'hps':
                result = _ndHpsDetect(buffer, sr);
                detectorUsed = 'hps';
                break;
            case 'yin':
            default:
                result = _ndYinDetect(buffer, sr);
                detectorUsed = 'yin';
        }

        // If the instance was disabled (or re-enabled into a new
        // session) while CREPE was awaiting, drop this result on the
        // floor — don't touch detection state or fire events.
        if (!enabled || gen !== sessionGen) return;

        if (result.freq <= 0 || result.confidence < 0.3) {
            if (result.underBuffered && !underBufferWarned) {
                console.warn(`[note_detect] ${detectorUsed} received an undersized buffer — low-frequency (bass) notes will drop silently. Check the frame accumulation path.`);
                underBufferWarned = true;
            }
            detectedMidi = -1;
            detectedConfidence = 0;
            detectedString = -1;
            detectedFret = -1;
            detectedDisplayMidi = -1;
            // Flush stability history on silence so stale votes from a
            // previous note don't produce false stable detections when
            // signal briefly returns.
            if (rawMidiHistory.length > 0) {
                rawMidiHistory = [];
                stableMidi = -1;
            }
            // Fall through to matchNotes — the chord path doesn't need a
            // single confident pitch (it scores per-string energy bands),
            // and chord audio is the case where YIN/HPS most often
            // returns low confidence. Single-note matching inside
            // matchNotes() is gated on detectedMidi >= 0, so it skips
            // itself; only chord groups get evaluated here.
        } else {
            detectedMidi = _ndFreqToMidi(result.freq);
            detectedConfidence = result.confidence;
            // Stability voting: roll the latest rounded-MIDI into a
            // short history and derive stableMidi only when N of M
            // recent raw detections agree. Suppresses YIN's
            // attack-transient jitter (e.g. D1 → D2 → A1 → D2 in the
            // first 100ms of a bass pluck). Raw detectedMidi stays
            // unchanged for the HUD/diagnostic layer; only the
            // matcher reads stableMidi.
            const roundedMidi = Math.round(detectedMidi);
            rawMidiHistory.push(roundedMidi);
            if (rawMidiHistory.length > _ND_STABILITY_WINDOW) rawMidiHistory.shift();
            const voteCounts = new Map();
            for (const m of rawMidiHistory) {
                voteCounts.set(m, (voteCounts.get(m) || 0) + 1);
            }
            let winnerMidi = -1, winnerCount = 0;
            for (const [m, c] of voteCounts) {
                if (c > winnerCount) { winnerMidi = m; winnerCount = c; }
            }
            stableMidi = (winnerCount >= _ND_STABILITY_REQUIRED) ? winnerMidi : -1;
        }

        // Pass the current frame's buffer through to matchNotes so the
        // chord scorer can run on the same audio that was just analysed
        // for pitch. The shared `pendingBuffer` is cleared by the timer
        // (see detectInterval) before processFrame is called, so reading
        // it later from matchNotes would either skip (null) or pick up a
        // newer buffer captured mid-processing.
        //
        // Onset anchoring (the actual fix the harness surfaced): when
        // an onset has recently fired, anchor the matcher's search
        // window on the onset's chart-time rather than the current
        // chart-time. Pitch resolution lags 50-85ms past the onset,
        // so by the time matchNotes runs with a confident stableMidi,
        // tRaw has drifted past the actual pluck. Without anchoring,
        // sustain-frame matches end up at tRaw - 250ms = false-early
        // (the regression the harness showed). Anchoring on the
        // onset's chart-time fixes attribution.
        //
        // We do NOT gate matching itself on the onset state — gating
        // too tightly means re-attack onsets that reset stability
        // mid-converge produce zero hits (verified — dropped from
        // 4/6 to 1/4). The anchor stays valid for ~300ms post-onset
        // so subsequent frames with a converged stableMidi still
        // benefit. After 300ms, anchor expires and we fall back to
        // the tRaw search center.
        let matchAnchorChartT = null;
        if (pendingOnsetChartT != null && hw && hw.getTime) {
            const sinceOnset = hw.getTime() - pendingOnsetChartT;
            if (sinceOnset >= 0 && sinceOnset < 0.300) {
                matchAnchorChartT = pendingOnsetChartT;
            } else {
                pendingOnsetChartT = null;  // expired
            }
        }
        matchNotes(buffer, { matchAnchorChartT, gateSingleNote: false });
    }

    // ── Note matching ─────────────────────────────────────────────────
    function noteKey(note, time) {
        return `${time.toFixed(3)}_${note.s}_${note.f}`;
    }

    function bsearch(arr, target) {
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid].t < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    function dispatchInstanceEvent(type, detail) {
        // Global dispatch preserves back-compat (practice journal and
        // other consumers listen on `window`). Per-instance dispatch
        // on `instanceRoot` lets splitscreen and other multi-panel
        // consumers attach listeners scoped to a single detector.
        const init = { detail, bubbles: true };
        try { window.dispatchEvent(new CustomEvent(type, init)); } catch (e) {}
        try { instanceRoot.dispatchEvent(new CustomEvent(type, init)); } catch (e) {}
    }

    function emitSlopsmithJudgment(judgment) {
        if (!window.slopsmith || typeof window.slopsmith.emit !== 'function') return;
        try {
            window.slopsmith.emit(judgment.hit ? 'note:hit' : 'note:miss', judgment);
        } catch (e) {}
    }

    function dispatchJudgment(judgment) {
        dispatchInstanceEvent(judgment.hit ? 'notedetect:hit' : 'notedetect:miss', judgment);
        emitSlopsmithJudgment(judgment);
    }

    function makeMatchedJudgment(cn, noteTime, t, expectedMidi, detectedMidiForJudgment, confidence, extra = {}) {
        const hasExplicitPitchError = Object.prototype.hasOwnProperty.call(extra, 'pitchError');
        const pitchError = hasExplicitPitchError
            ? extra.pitchError
            : (Number.isFinite(detectedMidiForJudgment) ? (detectedMidiForJudgment - expectedMidi) * 100 : null);
        const expectedFreq = 440 * Math.pow(2, (expectedMidi - 69) / 12);
        const detectedFreq = Number.isFinite(detectedMidiForJudgment)
            ? 440 * Math.pow(2, (detectedMidiForJudgment - 69) / 12)
            : null;
        return _ndMakeJudgment({
            matched: true,
            note: extra.note || { s: cn.s, f: cn.f },
            notes: extra.notes || null,
            chord: !!extra.chord,
            chartNote: extra.chartNote || cn,
            noteTime,
            judgedAt: t,
            expectedMidi,
            detectedMidi: detectedMidiForJudgment,
            confidence,
            pitchError,
            expectedFreq,
            detectedFreq,
            // Wide thresholds drive hit/miss; tight drives the
            // LATE/EARLY/SHARP/FLAT precision labels. timingTolerance
            // and pitchTolerance are the wide values (Detection
            // 200¢/300ms); timingHitThreshold and pitchHitThreshold
            // are the tight ones (Precision 25¢/50ms).
            timingHitThresholdMs: timingTolerance * 1000,
            pitchHitThresholdCents: pitchTolerance,
            timingPrecisionMs: timingHitThreshold * 1000,
            pitchPrecisionCents: pitchHitThreshold,
            hitStrings: extra.hitStrings,
            totalStrings: extra.totalStrings,
            score: extra.score,
            monophonicDetected: extra.monophonicDetected,
        });
    }

    function makeMissJudgment(cn, noteTime, t, expectedMidi, extra = {}) {
        return _ndMakeJudgment({
            matched: false,
            note: extra.note || { s: cn.s, f: cn.f },
            notes: extra.notes || null,
            chord: !!extra.chord,
            chartNote: extra.chartNote || cn,
            noteTime,
            judgedAt: t,
            expectedMidi,
            timingHitThresholdMs: timingTolerance * 1000,
            pitchHitThresholdCents: pitchTolerance,
            timingPrecisionMs: timingHitThreshold * 1000,
            pitchPrecisionCents: pitchHitThreshold,
            hitStrings: extra.hitStrings,
            totalStrings: extra.totalStrings,
            score: extra.score,
        });
    }

    // Update the rolling-median timing-error estimator from a new HIT.
    // Median over a sliding window of the most recent N hits — robust
    // to outliers (a single late note doesn't move the estimate).
    // Below MIN_SAMPLES the estimate stays at 0 so the first few hits
    // aren't influenced by a tiny sample.
    function updateDriftEstimate(timingErrorMs) {
        if (typeof timingErrorMs !== 'number' || !Number.isFinite(timingErrorMs)) return;
        driftBuffer.push(timingErrorMs);
        if (driftBuffer.length > _ND_DRIFT_WINDOW) driftBuffer.shift();
        if (driftBuffer.length >= _ND_DRIFT_MIN_SAMPLES) {
            // Trimmed mean of middle 50% when buffer ≥ _ND_CAL_MIN_SAMPLES;
            // median for small samples (more robust at low n).
            driftEstimateMs = _ndDriftFromBuffer(driftBuffer, _ND_CAL_MIN_SAMPLES);
        }
        // Auto-cal disabled — was running away to ±900ms in live play.
        //
        // Root cause: the matcher already has drift compensation in its
        // search (tForSearch = tRaw - driftSec). That correctly finds
        // the chart note the player is aiming at, even when raw timing
        // is +200ms off. The recorded timingError is RAW (tRaw - cn.t),
        // which is what the wide-threshold check sees.
        //
        // My auto-cal pushed driftEstimate INTO avOffset, intending to
        // make the raw timingError read as ~0 going forward. Math:
        //   pre:  tRaw = audio + avOffset - latency
        //         search = tRaw - drift   ← player's intended note
        //   post: avOffset += drift; drift reset to 0
        //         tRaw' = audio + (avOffset+drift) - latency = tRaw + drift
        //         search = tRaw' - 0 = tRaw + drift   ← 2×drift past
        //                                                 player's intent
        //
        // Search center moves AWAY from where the player aims. New hits
        // look more late, drift re-fires in same direction, runaway.
        //
        // Confirmed live: user reached avOffset = -900ms by song end,
        // hitting the slopsmith ±1000 clamp.
        //
        // Harness sweep showed +23pp improvement (58.2 → 81.2%) only
        // because fixtures are short — 1-2 cal fires landed before
        // accumulation turned vicious. In a full song the math goes
        // wrong fast.
        //
        // The proper fix is drift-compensating the recorded timingError
        // (subtract drift from raw error so the wide-threshold check
        // sees the centered value). That keeps the matcher's search
        // working AND lets calibrated hits land within threshold.
        // Tracked separately; reverted here for safety.
        //
        // Effect: live play falls back to per-session drift compensation
        // only. The harness baseline post-Fix-C (58.2%) is what we
        // ship. User's manual [/] tuning still works.
    }

    // Fix C — slot-claim leak prevention. A chart slot is "claimed
    // for real" only if its noteResults entry is NOT a detector-
    // failure demotion (sustain bleed / open-string contamination).
    // Ignored entries are placeholders left by Unit 6i's demotion
    // path: the detector heard SOMETHING but flagged it as a
    // detector limitation, not a real player attempt. The chart
    // slot should remain available for subsequent real detections
    // to score against — otherwise the player's actual attempt at
    // a note gets eaten by a phantom claim.
    //
    // Used in matchNotes' "already judged?" gates. Was just
    // noteResults.has(key) which blocked re-judgment unconditionally.
    function _slotIsClaimed(key) {
        const existing = noteResults.get(key);
        if (!existing) return false;
        // hit=true && ignored: phantom claim, allow overwrite
        // hit=true && !ignored: real hit, leave alone
        // hit=false: real miss recorded, leave alone (don't undo a miss)
        return !existing.ignoredAsDetectorFailure;
    }

    // ── Score-update bookkeeping for re-judgment paths ────────────
    // When a phantom (ignored) entry is replaced by a real judgment,
    // the score counters need to update. Currently recordJudgment
    // just bumps hits/misses on the new judgment; if the previous
    // phantom didn't bump anything (it was ignored), the new real
    // judgment correctly bumps. So no special bookkeeping needed —
    // just call recordJudgment again.

    function recordJudgment(key, judgment, { count = true, emit = true } = {}) {
        noteResults.set(key, judgment);
        if (count) {
            if (judgment.ignoredAsDetectorFailure) {
                // Demoted miss — score should reflect playing quality,
                // not detector limitations. Don't bump misses/streak;
                // the judgment is preserved on noteResults so analytics
                // and the modal can still surface "this happened" via
                // the ignoredAsDetectorFailure flag.
            } else if (judgment.hit) {
                hits++;
                streak++;
                if (streak > bestStreak) bestStreak = streak;
                updateSectionStat('hit');
                // Feed the drift estimator with the raw observed
                // timing so future matches benefit from the rolling
                // median. Done here rather than at the matchNotes
                // call site so chord HITs (which path through a
                // different branch) feed the estimator too.
                if (typeof judgment.timingError === 'number') {
                    updateDriftEstimate(judgment.timingError);
                }
            } else {
                misses++;
                streak = 0;
                updateSectionStat('miss');
            }
        }
        // Live HUD signal: track the last few judgments so the user
        // sees WHY the % moved, not just that it did. The strip
        // shows recent results at a glance; the cause line spells
        // out the most recent non-OK judgment in plain text.
        _hudPushJudgment(judgment);
        if (emit) dispatchJudgment(judgment);
    }

    function _hudPushJudgment(j) {
        if (!j) return;
        let kind = '·';
        if (j.ignoredAsDetectorFailure) {
            kind = '·';  // sustain bleed / detector failure — gray dot
        } else if (j.hit) {
            const tOk = j.timingState === 'OK' || j.timingState == null;
            const pOk = j.pitchState === 'OK' || j.pitchState == null;
            kind = (tOk && pOk) ? '✓' : '⚠';
        } else if (typeof j.detectedMidi === 'number' && j.detectedMidi >= 0
                   && j.pitchState && j.pitchState !== 'OK') {
            kind = '✗';  // wrong-pitch miss — detector saw something off-target
        } else {
            kind = '∅';  // no detection at all
        }
        hudRecent.push(kind);
        if (hudRecent.length > _ND_HUD_RECENT_MAX) hudRecent.shift();

        // Cause line: only update on non-OK judgments so a clean run
        // doesn't keep flashing a stale cause.
        if (j.ignoredAsDetectorFailure) {
            // Surface sustain-bleed explicitly — this is the user's
            // "perfect until first low E, then flaky" experience.
            const expected = Number.isFinite(j.expectedMidi) ? _ndMidiToName(j.expectedMidi) : '?';
            const detected = Number.isFinite(j.detectedMidi) && j.detectedMidi >= 0 ? _ndMidiToName(j.detectedMidi) : '?';
            hudLastCause = `sustain bleed: ${detected} ringing through ${expected}`;
        } else if (j.hit && (j.timingState && j.timingState !== 'OK')) {
            const sf = j.chartNote || j.note || {};
            const stringFret = (typeof sf.s === 'number' && typeof sf.f === 'number')
                ? ` on s${sf.s}/f${sf.f}` : '';
            const dir = j.timingError > 0 ? 'late' : 'early';
            hudLastCause = `${dir} ${Math.abs(Math.round(j.timingError))}ms${stringFret}`;
        } else if (j.hit && (j.pitchState && j.pitchState !== 'OK')) {
            const cents = typeof j.pitchError === 'number' ? Math.round(j.pitchError) : '?';
            const dir = j.pitchState === 'SHARP' ? '♯' : '♭';
            hudLastCause = `pitch off ${dir}${Math.abs(cents)}¢`;
        } else if (!j.hit) {
            const expected = Number.isFinite(j.expectedMidi) ? _ndMidiToName(j.expectedMidi) : '?';
            if (typeof j.detectedMidi === 'number' && j.detectedMidi >= 0) {
                const detected = _ndMidiToName(j.detectedMidi);
                hudLastCause = `wrong pitch: heard ${detected}, want ${expected}`;
            } else {
                hudLastCause = `no signal for ${expected}`;
            }
        }
        hudLastJudgmentSeen++;
    }

    function matchNotes(frameBuffer, gateOpts) {
        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        // Three clocks now:
        //   tRaw    — the player's actual "now" relative to chart time.
        //             Used as judgedAt so timingError on the judgment
        //             reflects RAW player timing. Coaching reads
        //             judgment.timingError to surface "consistently
        //             late" feedback; if we passed the drift-shifted
        //             clock here, drift comp would mask the player's
        //             skew and coaching would lie about it.
        //   t       — drift-shifted "now". Used for the candidate
        //             search window and selection sort. Self-corrects
        //             residual A/V offset so the matcher finds the
        //             right chart note even when the player's static
        //             calibration is off by ~50-200ms.
        //   anchor  — the onset's chart-time when matching is
        //             onset-gated. Pitch resolution lags 50-85ms past
        //             the onset, so by the time matchNotes runs,
        //             tRaw has drifted into the future relative to
        //             the actual pluck. Anchoring on the onset's
        //             chart-time fixes the attribution so a chart
        //             note at onset_chartT + 30ms gets matched even
        //             though tRaw is 100ms past the onset.
        const driftSec = driftEstimateMs / 1000;
        const tRaw = hw.getTime() + avOffsetSec - latencyOffset;
        const onsetAnchor = gateOpts && Number.isFinite(gateOpts.matchAnchorChartT)
            ? gateOpts.matchAnchorChartT
            : null;
        const gateSingleNote = !!(gateOpts && gateOpts.gateSingleNote);
        const tForSearch = onsetAnchor != null ? onsetAnchor : (tRaw - driftSec);
        const t = tForSearch;
        // Don't bail on detectedMidi < 0 here — chord scoring uses the
        // raw audio buffer and doesn't need a confident monophonic pitch.
        // The single-note path below is gated on detectedMidi >= 0 and
        // skips itself when detection wasn't confident.

        const notes = hw.getNotes();
        const chords = hw.getChords();
        const tolerance = timingTolerance;
        const centsTolerance = pitchTolerance;

        const candidateNotes = [];

        if (notes && notes.length > 0) {
            const start = bsearch(notes, t - tolerance);
            for (let i = start; i < notes.length; i++) {
                const n = notes[i];
                if (n.t > t + tolerance) break;
                if (n.mt) continue;
                // Drill gate: notes outside the judge window are warm-up
                // (lead-in audio); they show up on the highway and play
                // through audio but don't score.
                if (!isInDrillJudgment(n.t)) continue;
                // Spread the chart note so technique flags (ho/po/b/sl/hm)
                // travel with the candidate. _ndScoreChord reads these to
                // adjust per-string thresholds, so dropping them here would
                // make hammer-on/bend/harmonic adjustments dead code in
                // actual gameplay.
                candidateNotes.push({ ...n });
            }
        }
        if (chords && chords.length > 0) {
            const start = bsearch(chords, t - tolerance);
            for (let i = start; i < chords.length; i++) {
                const c = chords[i];
                if (c.t > t + tolerance) break;
                if (!isInDrillJudgment(c.t)) continue;
                for (const cn of (c.notes || [])) {
                    if (cn.mt) continue;
                    // Chord constituent notes don't carry their own time —
                    // the chord's `c.t` is the timestamp.
                    candidateNotes.push({ ...cn, t: c.t });
                }
            }
        }

        // Display fingering is only meaningful when we have a confident
        // monophonic pitch to map back to a (string, fret). With no pitch
        // (chord-heavy frames) leave the HUD's last detected position
        // alone — the per-string chord HUD takes over from there.
        if (detectedMidi >= 0) {
            const disp = _ndResolveDisplayFingering(
                detectedMidi, candidateNotes, currentArrangement,
                currentStringCount, tuningOffsets, capo, centsTolerance
            );
            detectedString = disp.string;
            detectedFret = disp.fret;
            detectedDisplayMidi = Number.isFinite(disp.displayMidi) ? disp.displayMidi : detectedMidi;
        }

        // ── Single-note path (existing YIN/HPS/CREPE result) ──────────
        // Group candidate notes by chord time so we can route chord events
        // to the constraint scorer and single notes to the MIDI comparator.
        // A chord is any group of ≥2 simultaneous candidates sharing a time.
        const byTime = new Map();
        for (const cn of candidateNotes) {
            const tk = cn.t.toFixed(3);
            if (!byTime.has(tk)) byTime.set(tk, []);
            byTime.get(tk).push(cn);
        }

        // ── Single-note pool: collect ALL pitch-passing candidates,
        // then apply tier-2 selection (exact-pitch beats boundary-
        // pitch; among ties pick nearest in time, drift-adjusted).
        // Without this, when multiple chart notes share the matcher's
        // candidate window, byTime iteration order picks an arbitrary
        // one — frequently the boundary-pitch candidate over the
        // exact one. That's the subtle quality regression the
        // pre-port matcher fixed.
        // Route through stableMidi (Unit 6g): the matcher uses the
        // N-of-M voted MIDI rather than each frame's raw YIN result.
        // Suppresses single-frame octave-down anomalies that
        // otherwise sneak through as 199¢ "hits" on bass.
        const matcherMidi = stableMidi >= 0 ? stableMidi : -1;
        const pitchPassing = [];
        // Single-note path is gated when there's no pending onset
        // anchor — sustain frames don't get to claim chart notes
        // (the post-port architectural fix). Chord path below runs
        // unconditionally (it doesn't depend on a confident pitch).
        const skipSingleNote = gateSingleNote;
        for (const [, group] of byTime) {
            if (skipSingleNote) break;
            if (group.length !== 1) continue;
            if (matcherMidi < 0) continue;
            const cn = group[0];
            const key = noteKey(cn, cn.t);
            // Fix C: was noteResults.has(key). Allow re-judgment when
            // the existing entry is a sustain-bleed phantom so a real
            // attempt at this chart note can still score.
            if (_slotIsClaimed(key)) continue;
            const expectedMidi = _ndMidiFromStringFret(
                cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
            );
            const detectedCents = _ndNearestOctaveCents(matcherMidi, expectedMidi);
            if (Math.abs(detectedCents) > centsTolerance) continue;
            // Raw timing distance — used both for selection sort
            // (drift-adjusted) and for the recorded judgment (raw).
            const rawTimingErrorMs = (tRaw - cn.t) * 1000;
            pitchPassing.push({
                cn, key, expectedMidi,
                pitchError: detectedCents,
                timingError: rawTimingErrorMs,
            });
        }

        if (pitchPassing.length > 0) {
            const EXACT_PITCH_CENTS = _ND_PRECISION_PITCH_CENTS;
            // Prefer the precision-zone subset; fall back to all
            // pitch-passing if none are in the precision zone.
            const exactPitch = pitchPassing.filter(p => Math.abs(p.pitchError) < EXACT_PITCH_CENTS);
            const pool = exactPitch.length > 0 ? exactPitch : pitchPassing;
            // Sort by drift-adjusted timing distance: the chart note
            // closest to where the player actually landed (not closest
            // to the un-compensated chart-time clock) wins. We compare
            // raw timing minus the rolling median, which equals
            // drift-adjusted distance algebraically.
            pool.sort((a, b) =>
                Math.abs(a.timingError - driftEstimateMs)
                - Math.abs(b.timingError - driftEstimateMs));
            const winner = pool[0];
            // Pass tRaw (NOT t) as judgedAt so the recorded
            // timingError reflects raw player timing, not the drift-
            // shifted matcher clock. Coaching reads this to surface
            // "consistently late" — it must see the player's actual
            // skew, not the drift-comp-cancelled value.
            // Record the stable midi (what the matcher used) on the
            // judgment, not the raw frame midi — keeps downstream
            // analytics consistent with what produced the hit.
            const judgment = makeMatchedJudgment(
                winner.cn, winner.cn.t, tRaw, winner.expectedMidi,
                matcherMidi, detectedConfidence,
                { pitchError: winner.pitchError }
            );
            // Open-string contamination handling (Unit 6i refined).
            //
            // When YIN locks on an open bass-string MIDI (because of
            // sympathetic resonance from an unmuted string) instead
            // of the played note, octave-folding can make it "barely
            // pass" the wide pitch tolerance as a 200¢ pseudo-hit.
            //
            // Whether to credit this as a hit depends on whether the
            // player ACTUALLY plucked:
            //   - With an onset anchor (gateOpts.matchAnchorChartT
            //     set): an onset just fired → player plucked → credit
            //     the hit even though pitch reading is contaminated.
            //     The chart note becomes a hit; coaching can later
            //     surface "you have open-string contamination" via
            //     the noteResults entry without inflating the score.
            //   - Without an onset anchor: this is sustain-bleed
            //     attribution (no recent pluck) → mark
            //     ignoredAsDetectorFailure so the score doesn't
            //     credit a chart note the player never plucked.
            const detRound = Math.round(matcherMidi);
            const detIsOpen = _ND_BASS_OPEN_STRING_MIDIS.has(detRound)
                || _ND_BASS_OPEN_STRING_OCTAVE_MIDIS.has(detRound);
            const detMatchesExpected = detRound === winner.expectedMidi;
            const pitchAtBoundary = Math.abs(winner.pitchError) >= 150;
            if (detIsOpen && !detMatchesExpected && pitchAtBoundary) {
                judgment.ignoredAsDetectorFailure = true;
            }
            recordJudgment(winner.key, judgment);
        }

        // Chord path: walks byTime independently. Tier-2 selection
        // doesn't apply here — chord matching is per-time-group via
        // _ndScoreChord, not detection-pool selection.
        for (const [, group] of byTime) {
            if (group.length === 1) {
                continue;  // single-note path handled above
            } else {
                // ── Chord path: constraint-based per-string band analysis ──
                // Skip if no audio buffer was passed in (e.g. instance
                // restart while a stale processFrame is unwinding).
                if (!frameBuffer) continue;

                // Chord-level resolved key. checkMisses() honours this so a
                // failed chord becomes one miss event (not one per string).
                const chordKey = `${group[0].t.toFixed(3)}_chord`;
                // Fix C: same logic as single-note path — let
                // sustain-bleed phantoms be replaced by real chord
                // attempts.
                if (_slotIsClaimed(chordKey)) continue;

                const sr = audioCtx ? audioCtx.sampleRate : 48000;
                const chordResult = _ndScoreChord(
                    frameBuffer, sr,
                    group, currentArrangement, currentStringCount,
                    tuningOffsets, capo,
                    centsTolerance,   // pitch check per string
                    chordHitRatio     // min fraction of strings required
                );

                // Update HUD chord display (latest reading, hit-or-miss)
                lastChordScore = chordResult.score;
                lastChordHit = chordResult.hitStrings;
                lastChordTotal = chordResult.totalStrings;
                lastChordTime = group[0].t;

                const lead = group[0];
                const expectedMidi = _ndMidiFromStringFret(
                    lead.s, lead.f, currentArrangement, currentStringCount, tuningOffsets, capo
                );
                // Derive pitch error from the first string that actually has a
                // finite centsError measurement. Fall back to the monophonic
                // detector if available; leave null if no pitch data exists
                // (e.g. energy-only checks or lead string failed the pitch check).
                const firstFiniteCentsError = chordResult.results
                    ?.find(r => Number.isFinite(r?.centsError))?.centsError;
                const chordPitchError = firstFiniteCentsError !== undefined
                    ? firstFiniteCentsError
                    : (detectedMidi >= 0 ? _ndFoldOctaveCents((detectedMidi - expectedMidi) * 100) : null);
                const chordDetectedMidi = detectedMidi >= 0
                    ? detectedMidi
                    : (Number.isFinite(chordPitchError)
                        ? expectedMidi + chordPitchError / 100
                        : null);
                const chordJudgment = makeMatchedJudgment(
                    lead, lead.t, t, expectedMidi,
                    chordDetectedMidi,
                    detectedConfidence,
                    {
                        notes: group.map(cn => ({ s: cn.s, f: cn.f })),
                        chord: true,
                        hitStrings: chordResult.hitStrings,
                        totalStrings: chordResult.totalStrings,
                        score: chordResult.score,
                        pitchError: chordPitchError,
                        monophonicDetected: detectedMidi >= 0,
                    }
                );

                if (!chordResult.isHit) {
                    // Do not lock in a miss while the chord is still within
                    // its timing window. Chords can enter candidateNotes as
                    // early as (chordTime - timingTolerance), so an early
                    // non-hit frame may still be followed by a valid strum on
                    // a later frame. Let checkMisses() finalize the miss only
                    // after the window has fully elapsed.
                    continue;
                }

                // Chord cleared. Mark the chord-level key 'hit' so the
                // miss aggregator in checkMisses() treats it as a single
                // resolved unit and skips per-string miss accounting.
                // Per-string keys still record each string's actual
                // outcome from `chordResult.results` so the draw overlay
                // can colour gems individually (green / red per fret) on
                // lenient chord hits where some strings rang and some
                // didn't.
                recordJudgment(chordKey, chordJudgment, { count: true, emit: true });
                for (let i = 0; i < group.length; i++) {
                    const cn = group[i];
                    const key = noteKey(cn, cn.t);
                    // Fix C: per-string slot inside a chord — phantom
                    // hits should yield to real attempts here too.
                    if (_slotIsClaimed(key)) continue;
                    if (!chordJudgment.hit) {
                        // Chord passed energy/ratio threshold but missed the clean-hit
                        // threshold. Use makeMissJudgment so each per-string entry is
                        // internally consistent (no post-mutation of hit after _ndMakeJudgment
                        // has already computed it from timingState/pitchState).
                        const stringExpectedMidi = _ndMidiFromStringFret(
                            cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                        );
                        noteResults.set(key, makeMissJudgment(cn, cn.t, t, stringExpectedMidi));
                        continue;
                    }
                    const stringRes = chordResult.results[i];
                    const stringHit = stringRes && stringRes.hit;
                    const stringExpectedMidi = _ndMidiFromStringFret(
                        cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                    );
                    const stringJudgment = stringHit
                        ? makeMatchedJudgment(
                            cn, cn.t, t, stringExpectedMidi,
                            Number.isFinite(stringRes?.centsError)
                                ? stringExpectedMidi + stringRes.centsError / 100
                                : null,
                            detectedConfidence,
                            { pitchError: Number.isFinite(stringRes?.centsError) ? stringRes.centsError : null }
                        )
                        : makeMissJudgment(cn, cn.t, t, stringExpectedMidi);
                    noteResults.set(key, stringJudgment);
                }
            }
        }
    }

    function checkMisses() {
        if (!enabled) return;
        // Loop-restart detection runs alongside miss-checking on the
        // same 10Hz tick. Slopsmith's audio engine handles the wrap
        // but doesn't emit a `loop:restart` event — we infer it from
        // chartTime jumping backward and use it to capture per-iter
        // scores during drill mode.
        detectLoopRestart();
        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        // Apply the same drift compensation as matchNotes — without
        // this, a chart note whose actual hit lands inside the
        // drift-shifted matcher window would be marked missed by
        // checkMisses before the matcher saw it.
        const driftSec = driftEstimateMs / 1000;
        const t = hw.getTime() + avOffsetSec - latencyOffset - driftSec;
        const tolerance = timingTolerance;
        const missDeadline = t - tolerance * 2;
        const notes = hw.getNotes();
        const chords = hw.getChords();

        // Decide whether a fresh NO_DETECTION miss is a player error
        // or a detector limitation. Patterns that demote:
        //   1. Tight gap (<0.4s) since the previous chart note —
        //      onset detector can't physically fire again while sustain
        //      is dominant.
        //   2. Wider gap (<1.0s) AND previous chart note also missed —
        //      sustain bleed accumulating across multiple unhit notes.
        // Same heuristics as the offline _ndLikelyDetectorFailures
        // filter so live and post-hoc analysis agree on what's "really"
        // a miss vs a detector limitation.
        const isDetectorFailure = (noteTime) => {
            let prevChartT = -Infinity;
            let prevWasMiss = false;
            for (const v of noteResults.values()) {
                const vt = typeof v.noteTime === 'number' ? v.noteTime : v.chartT;
                if (typeof vt !== 'number') continue;
                if (vt < noteTime && vt > prevChartT) {
                    prevChartT = vt;
                    prevWasMiss = !v.hit;
                }
            }
            if (prevChartT === -Infinity) return false;
            const gap = noteTime - prevChartT;
            if (gap < _ND_DETECTOR_FAST_REPEAT_GAP_SEC) return true;
            if (gap < _ND_DETECTOR_CHAIN_FAILURE_GAP_SEC && prevWasMiss) return true;
            return false;
        };

        const checkNote = (s, f, noteTime) => {
            if (noteTime > missDeadline) return;
            // Drill gate: notes outside the judge window get neither
            // HIT nor MISS — they're warm-up audio.
            if (!isInDrillJudgment(noteTime)) return;
            const key = noteKey({ s, f }, noteTime);
            if (!noteResults.has(key)) {
                const expectedMidi = _ndMidiFromStringFret(
                    s, f, currentArrangement, currentStringCount, tuningOffsets, capo
                );
                const judgment = makeMissJudgment({ s, f }, noteTime, t, expectedMidi);
                if (isDetectorFailure(noteTime)) {
                    judgment.ignoredAsDetectorFailure = true;
                }
                recordJudgment(key, judgment);
            }
        };

        if (notes && notes.length > 0) {
            const start = bsearch(notes, missDeadline - 1);
            for (let i = start; i < notes.length; i++) {
                const n = notes[i];
                if (n.t > missDeadline) break;
                if (n.mt) continue;
                checkNote(n.s, n.f, n.t);
            }
        }
        if (chords && chords.length > 0) {
            const start = bsearch(chords, missDeadline - 1);
            for (let i = start; i < chords.length; i++) {
                const c = chords[i];
                if (c.t > missDeadline) break;
                const liveNotes = (c.notes || []).filter(cn => !cn.mt);
                if (liveNotes.length === 0) continue;
                if (liveNotes.length === 1) {
                    // Degenerate "chord" of one — treat as a single note.
                    checkNote(liveNotes[0].s, liveNotes[0].f, c.t);
                    continue;
                }
                // Multi-note chord: judge as a single unit. matchNotes()
                // stores a judgment object at `<t>_chord` when the chord
                // cleared the ratio threshold; if that key is present, the
                // chord is already resolved and we leave the per-string keys alone.
                const chordKey = `${c.t.toFixed(3)}_chord`;
                if (noteResults.has(chordKey)) continue;
                const expectedMidi = _ndMidiFromStringFret(
                    liveNotes[0].s, liveNotes[0].f,
                    currentArrangement, currentStringCount, tuningOffsets, capo
                );
                const chordJudgment = makeMissJudgment(liveNotes[0], c.t, t, expectedMidi, {
                    notes: liveNotes.map(cn => ({ s: cn.s, f: cn.f })),
                    chord: true,
                });
                recordJudgment(chordKey, chordJudgment);
                for (const cn of liveNotes) {
                    const key = noteKey({ s: cn.s, f: cn.f }, c.t);
                    if (!noteResults.has(key)) noteResults.set(key, makeMissJudgment(cn, c.t, t, _ndMidiFromStringFret(
                        cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                    )));
                }
            }
        }

        const sections = hw.getSections ? hw.getSections() : null;
        if (sections) {
            let current = null;
            for (const sec of sections) {
                if (sec.time <= t) current = sec.name;
                else break;
            }
            if (current && current !== currentSection) {
                currentSection = current;
                if (!sectionStats.find(s => s.name === current)) {
                    sectionStats.push({ name: current, hits: 0, misses: 0 });
                }
            }
        }
    }

    function updateSectionStat(type) {
        if (!currentSection) return;
        let sec = sectionStats.find(s => s.name === currentSection);
        if (!sec) {
            sec = { name: currentSection, hits: 0, misses: 0 };
            sectionStats.push(sec);
        }
        if (type === 'hit') sec.hits++;
        else sec.misses++;
    }

    // ── Settings panel ────────────────────────────────────────────────
    function showSettings() {
        let panel = instanceRoot.querySelector('.nd-settings-panel');
        if (panel) { panel.remove(); return; }

        panel = document.createElement('div');
        panel.className = 'nd-settings-panel';
        // Core ships PREBUILT Tailwind (Principle II, no Play CDN JIT), so this
        // external plugin's arbitrary classes (z-[150], w-80, top-16) produce
        // no CSS — the popover rendered with z-index:auto behind the highway
        // and looked unclickable. Pin layout + chrome inline so it doesn't
        // depend on classes core never compiled.
        panel.style.cssText = [
            'position:fixed', 'top:4rem', 'right:1rem', 'width:20rem',
            'max-width:calc(100vw - 2rem)', 'max-height:calc(100vh - 5rem)',
            'overflow-y:auto', 'z-index:2147483000', 'pointer-events:auto',
            'background:#1a2230', 'border:1px solid #4b5563',
            'border-radius:0.75rem', 'padding:1rem',
            'box-shadow:0 10px 40px rgba(0,0,0,0.6)',
            'color:#d1d5db', 'font-size:0.875rem',
        ].join(';');
        panel.innerHTML = `
            <div class="flex justify-between items-center mb-3">
                <span class="text-gray-200 font-semibold">Note Detection Settings</span>
                <button class="nd-settings-close text-gray-500 hover:text-white">&times;</button>
            </div>

            <label class="block text-gray-400 text-xs mb-1">Audio Input Device</label>
            <select class="nd-device-select w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-2">
                <option value="">Default</option>
            </select>

            <label class="block text-gray-400 text-xs mb-1">Input Channel</label>
            <select class="nd-channel-select w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-2">
                <option value="mono" ${selectedChannel === 'mono' ? 'selected' : ''}>Mono (mix both channels)</option>
                <option value="left" ${selectedChannel === 'left' ? 'selected' : ''}>Left (Ch 1) — typically dry/DI</option>
                <option value="right" ${selectedChannel === 'right' ? 'selected' : ''}>Right (Ch 2) — typically wet/FX</option>
            </select>

            <label class="block text-gray-400 text-xs mb-1">Input Level</label>
            <div class="relative h-3 bg-dark-600 rounded overflow-hidden mb-1">
                <div class="nd-vu-bar h-full rounded transition-all duration-75 bg-green-500" style="width:0%"></div>
                <div class="nd-vu-peak absolute top-0 w-0.5 h-full bg-white/70" style="left:0%"></div>
            </div>
            <div class="flex justify-between text-[9px] text-gray-600 mb-3">
                <span>-inf</span><span>-18dB</span><span>-6dB</span><span>0dB</span>
            </div>

            <label class="block text-gray-400 text-xs mb-1">Detection Method</label>
            <select class="nd-method-select w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-1">
                <option value="yin" ${detectionMethod === 'yin' ? 'selected' : ''}>YIN (lightweight, clean signals)</option>
                <option value="hps" ${detectionMethod === 'hps' ? 'selected' : ''}>HPS (bass with weak fundamental, no model)</option>
                <option value="crepe" ${detectionMethod === 'crepe' ? 'selected' : ''}>CREPE/SPICE (robust, ~20MB model)</option>
            </select>
            ${(() => {
                const _hw = resolveHw();
                const arrangement = (_hw && _hw.getSongInfo && _hw.getSongInfo() || {}).arrangement;
                const isBass = arrangement && String(arrangement).toLowerCase().includes('bass');
                if (isBass && detectionMethod === 'yin') {
                    return '<div class="text-amber-400 text-[10px] mb-3 leading-snug">⚠ This song is bass — HPS handles low-string fundamental loss better than YIN.</div>';
                }
                return '<div class="mb-3"></div>';
            })()}

            <label class="block text-gray-400 text-xs mb-1">Audio Latency Offset: <span class="nd-latency-val">${Math.round(latencyOffset * 1000)}</span>ms</label>
            <input type="range" min="0" max="250" value="${Math.round(latencyOffset * 1000)}"
                   class="nd-latency-slider w-full accent-green-400 mb-2">
            <div class="text-[10px] text-gray-600 mb-2 leading-tight">
                Compensates for USB/audio interface delay. Increase if notes register late.
            </div>

            <div class="bg-dark-800 border border-blue-700/40 rounded p-2 mb-3 text-[11px]">
                <div class="font-semibold text-blue-300 mb-1">A/V Calibration</div>
                <div class="text-[10px] text-gray-500 mb-1.5 leading-snug">
                    Trimmed mean of middle 50% across recent in-song hits.
                    Visual sync cal is separate (below).
                </div>
                <div id="nd-cal-status" class="text-gray-400 text-[10px] mb-1.5 leading-snug">
                    Play through the chart — 16+ hits builds a stable bias estimate.
                </div>
                <div class="flex gap-1.5 mb-2">
                    <button class="nd-cal-apply flex-1 px-2 py-1 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed rounded text-[11px] text-white">
                        Calibrate from this play
                    </button>
                    <button class="nd-cal-reset px-2 py-1 bg-dark-600 hover:bg-dark-500 rounded text-[11px] text-gray-300" title="Reset avOffset to 0">
                        Reset
                    </button>
                </div>
                <div class="border-t border-gray-700 pt-2 mt-1">
                    <div class="text-[10px] text-gray-500 mb-1.5 leading-snug">
                        Visual sync: align the audible click with the visual flash.
                        Use ± buttons until they feel simultaneous.
                    </div>
                    <button class="nd-visual-cal w-full px-2 py-1 bg-purple-700 hover:bg-purple-600 rounded text-[11px] text-white">
                        Open visual sync calibration
                    </button>
                </div>
                <div class="border-t border-gray-700 pt-2 mt-2 text-[10px] font-mono text-gray-500">
                    <div class="text-gray-400 text-[10px] font-sans mb-1">Diagnostics</div>
                    <div id="nd-cal-diag" class="leading-relaxed"></div>
                </div>
            </div>

            <div class="bg-dark-700 border border-gray-700 rounded p-2 mb-3 text-[11px] text-gray-300 leading-snug">
                <div class="font-semibold text-gray-200 mb-1">Scoring thresholds</div>
                <div>Detection: <span class="text-gray-100 font-mono">${_ND_DETECTION_PITCH_CENTS}¢ / ${Math.round(_ND_DETECTION_TIMING_SEC * 1000)}ms</span> — did you play it?</div>
                <div>Precision: <span class="text-gray-100 font-mono">${_ND_PRECISION_PITCH_CENTS}¢ / ${_ND_PRECISION_TIMING_MS}ms</span> — how tight?</div>
                <div class="text-[10px] text-gray-500 mt-1">Fixed thresholds; the strictness preset abstraction was retired in favor of two independent score axes.</div>
            </div>

            <label class="flex items-center gap-2 text-gray-400 text-xs mb-2">
                <input type="checkbox" class="nd-show-timing accent-green-400" ${showTimingErrors ? 'checked' : ''}>
                Show early/late labels
            </label>
            <label class="flex items-center gap-2 text-gray-400 text-xs mb-3">
                <input type="checkbox" class="nd-show-pitch accent-green-400" ${showPitchErrors ? 'checked' : ''}>
                Show sharp/flat labels
            </label>

            <label class="block text-gray-400 text-xs mb-1">Miss Marker Duration: <span class="nd-miss-duration-val">${missMarkerDuration.toFixed(1)}</span>s</label>
            <input type="range" min="5" max="50" value="${Math.round(missMarkerDuration * 10)}"
                   class="nd-miss-duration-slider w-full accent-red-400 mb-3">

            <label class="block text-gray-400 text-xs mb-1">Input Gain: <span class="nd-gain-val">${inputGain.toFixed(1)}</span>x</label>
            <input type="range" min="1" max="50" value="${Math.round(inputGain * 10)}"
                   class="nd-gain-slider w-full accent-green-400 mb-3">

            <label class="block text-gray-400 text-xs mb-1">Chord Leniency: <span class="nd-chord-ratio-val">${Math.round(chordHitRatio * 100)}</span>% of strings</label>
            <input type="range" min="25" max="100" value="${Math.round(chordHitRatio * 100)}"
                   class="nd-chord-ratio-slider w-full accent-green-400 mb-1">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Chord detection uses per-string band analysis. This sets how many strings must ring to count as a hit (e.g. 60% = 4 of 6). Lower for beginners or dense voicings.
            </div>

            <div class="border-t border-gray-700 mt-3 pt-3">
                <label class="block text-gray-400 text-xs mb-1">Diagnostic Recording</label>
                <div class="flex items-center gap-2 mb-1">
                    <select class="nd-record-secs bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200">
                        <option value="15">15s</option>
                        <option value="30">30s</option>
                        <option value="60">60s</option>
                        <option value="120">120s</option>
                        <option value="300" selected>5 min</option>
                        <option value="600">10 min</option>
                    </select>
                    <button class="nd-record-btn px-3 py-1 bg-red-900 hover:bg-red-800 rounded text-xs text-red-200 font-semibold">
                        ● Record
                    </button>
                </div>
                <div class="nd-record-status text-[10px] text-gray-600 leading-tight">
                    Click once — the song starts playing and recording arms atomically. WAV t=0 anchors to the first sample after the chart advances. Stop saves a WAV + judgment sidecar under <code>/config/note_detect/recordings/</code>; <code>make pull-recording</code> stages it for the replay harness.
                </div>
            </div>

            <div class="text-[10px] text-gray-600 mt-3 leading-tight">
                Tip: For multi-effects pedals with USB audio (e.g. Valeton GP-5), select <b>Left (Ch 1)</b> for the dry/DI signal — it gives the most accurate pitch detection.
                See the <b>Pitch Detection Methods</b> section of the plugin README for guidance on choosing between YIN, HPS, and CREPE.
            </div>
        `;

        instanceRoot.appendChild(panel);

        // Wire up controls
        panel.querySelector('.nd-settings-close').onclick = () => panel.remove();
        panel.querySelector('.nd-device-select').onchange = (e) => onDeviceChange(e.target.value);
        panel.querySelector('.nd-channel-select').onchange = (e) => onChannelChange(e.target.value);
        panel.querySelector('.nd-method-select').onchange = (e) => setMethod(e.target.value);
        panel.querySelector('.nd-latency-slider').oninput = (e) => {
            latencyOffset = e.target.value / 1000;
            panel.querySelector('.nd-latency-val').textContent = e.target.value;
            saveSettings();
        };

        // A/V Calibration: read driftEstimateMs from recent hits and
        // apply it to avOffset as a one-shot calibration. Drift
        // estimator is the rolling-median timingError across the
        // last 4-8 non-ignored hits — i.e. the player's actual bias
        // relative to the chart. Subtract from avOffset (correct
        // sign: chart-time bigger means tRaw bigger means timingError
        // bigger; if player is +200ms late, tRaw needs to read 200ms
        // smaller for the same audio time → avOffset -= 200).
        // Persists via window.setAvOffsetMs (slopsmith POSTs to
        // /api/settings); also clears the drift buffer so subsequent
        // hits measure post-cal alignment.
        const calStatus = panel.querySelector('#nd-cal-status');
        const calApply = panel.querySelector('.nd-cal-apply');
        const calReset = panel.querySelector('.nd-cal-reset');
        // Refresh status text every 500ms so the user sees the live
        // drift estimate change as they play.
        const refreshCalStatus = () => {
            if (!panel.isConnected) {
                clearInterval(calStatusTimer);
                return;
            }
            const samples = driftBuffer.length;
            const drift = Math.round(driftEstimateMs);
            const _hwLocal = resolveHw();
            const av = Math.round((_hwLocal && _hwLocal.getAvOffset ? _hwLocal.getAvOffset() : 0) || 0);
            const msg = _ndCalRefreshMessage(samples, drift, av, _ND_CAL_MIN_SAMPLES);
            calStatus.textContent = msg.text;
            calApply.disabled = !msg.applyEnabled;

            // Diagnostic readout: browser-reported audio latency,
            // current drift, calibration source-of-truth values.
            const diagEl = panel.querySelector('#nd-cal-diag');
            if (diagEl) {
                const baseLat = audioCtx && Number.isFinite(audioCtx.baseLatency)
                    ? Math.round(audioCtx.baseLatency * 1000) : '—';
                const outLat = audioCtx && Number.isFinite(audioCtx.outputLatency)
                    ? Math.round(audioCtx.outputLatency * 1000) : '—';
                const sr = audioCtx && Number.isFinite(audioCtx.sampleRate)
                    ? audioCtx.sampleRate : '—';
                diagEl.innerHTML =
                    `audioCtx.baseLatency: ${baseLat}ms · outputLatency: ${outLat}ms<br>` +
                    `sampleRate: ${sr}Hz · drift samples: ${samples} / ${_ND_DRIFT_WINDOW}<br>` +
                    `current drift: ${drift > 0 ? '+' : ''}${drift}ms · avOffset: ${av}ms · method: ${detectionMethod}`;
            }
        };
        const calStatusTimer = setInterval(refreshCalStatus, 500);
        refreshCalStatus();

        calApply.onclick = () => {
            if (driftBuffer.length < _ND_CAL_MIN_SAMPLES) return;
            const drift = driftEstimateMs;
            const _hw = resolveHw();
            const prev = (_hw && _hw.getAvOffset) ? (_hw.getAvOffset() || 0) : 0;
            const next = prev - drift;
            if (typeof window !== 'undefined' && typeof window.setAvOffsetMs === 'function') {
                window.setAvOffsetMs(next);
            } else if (_hw && typeof _hw.setAvOffset === 'function') {
                _hw.setAvOffset(next);
            }
            driftBuffer = [];
            driftEstimateMs = 0;
            console.log(`[note_detect] manual cal: drift=${Math.round(drift)}ms; avOffset ${Math.round(prev)}→${Math.round(next)}ms`);
            refreshCalStatus();
        };
        const visualCalBtn = panel.querySelector('.nd-visual-cal');
        if (visualCalBtn) visualCalBtn.onclick = () => openVisualCalModal();

        calReset.onclick = () => {
            if (typeof window !== 'undefined' && typeof window.setAvOffsetMs === 'function') {
                window.setAvOffsetMs(0);
            } else {
                const _hw = resolveHw();
                if (_hw && _hw.setAvOffset) _hw.setAvOffset(0);
            }
            // Clear the auto-seed flag so the next audio-context
            // creation seeds avOffset fresh from the current
            // outputLatency. Useful if the user wants to recalibrate
            // a different audio device.
            try { localStorage.removeItem(_ND_AVOFFSET_SEEDED_KEY); } catch (e) {}
            console.log('[note_detect] avOffset reset to 0; auto-seed flag cleared');
            refreshCalStatus();
        };

        // Tolerance/hit-threshold sliders are gone — those four values
        // are now the fixed _ND_DETECTION_* / _ND_PRECISION_* constants
        // displayed read-only above. The strictness preset abstraction
        // they fed into has been retired in favor of two-axis scoring.
        panel.querySelector('.nd-show-timing').onchange = (e) => {
            showTimingErrors = !!e.target.checked;
            saveSettings();
        };
        panel.querySelector('.nd-show-pitch').onchange = (e) => {
            showPitchErrors = !!e.target.checked;
            saveSettings();
        };
        panel.querySelector('.nd-miss-duration-slider').oninput = (e) => {
            missMarkerDuration = e.target.value / 10;
            panel.querySelector('.nd-miss-duration-val').textContent = missMarkerDuration.toFixed(1);
            saveSettings();
        };
        panel.querySelector('.nd-gain-slider').oninput = (e) => {
            inputGain = e.target.value / 10;
            panel.querySelector('.nd-gain-val').textContent = inputGain.toFixed(1);
            // Live-apply so the slider takes effect immediately without
            // requiring a Detect off/on cycle. Without this the value
            // is only picked up on the next gainNode = createGain() in
            // startAudio, which makes "find the right gain" painful
            // — common on attenuated input paths where you need to
            // sweep the value while watching the input meter.
            if (gainNode) gainNode.gain.value = inputGain;
            saveSettings();
        };
        panel.querySelector('.nd-chord-ratio-slider').oninput = (e) => {
            chordHitRatio = e.target.value / 100;
            panel.querySelector('.nd-chord-ratio-val').textContent = e.target.value;
            saveSettings();
        };

        // Unit 4d — Diagnostic Recording. Click toggles arm/stop; while
        // armed, a 200ms tick polls recordStatus to surface anchor +
        // captured-seconds progress without flooding the console.
        const recordBtn = panel.querySelector('.nd-record-btn');
        const recordStatusEl = panel.querySelector('.nd-record-status');
        const recordSecsSel = panel.querySelector('.nd-record-secs');
        const renderRecordIdle = () => {
            recordBtn.textContent = '● Record';
            recordBtn.className = 'nd-record-btn px-3 py-1 bg-red-900 hover:bg-red-800 rounded text-xs text-red-200 font-semibold';
        };
        const renderRecordActive = () => {
            recordBtn.textContent = '■ Stop';
            recordBtn.className = 'nd-record-btn px-3 py-1 bg-yellow-900 hover:bg-yellow-800 rounded text-xs text-yellow-200 font-semibold';
        };
        // Reflect existing recording state when re-opening the panel
        // (e.g. user closed gear mid-recording, then re-opened).
        if (recording) renderRecordActive();
        const recordPollT0 = { value: 0 };
        const tickRecordStatus = () => {
            if (!panel.isConnected) return;
            const s = recordStatus();
            if (!s.active) {
                recordStatusEl.textContent = `Saved ${s.filename || 'recording.wav'} (anchor chart ${s.anchorChartTime.toFixed(3)}s, ${s.capturedSec.toFixed(1)}s captured).`;
                renderRecordIdle();
                return;
            }
            if (!s.anchored) {
                const waited = ((performance.now() - recordPollT0.value) / 1000).toFixed(1);
                recordStatusEl.textContent = `Armed (chart ${s.armedChartTime.toFixed(3)}s). Waiting ${waited}s for chart to advance — if this persists, playback didn't start.`;
            } else {
                const remaining = Math.max(0, s.maxSec - s.capturedSec);
                recordStatusEl.textContent = `Recording — anchor chart ${s.anchorChartTime.toFixed(3)}s, ${s.capturedSec.toFixed(1)}/${s.maxSec.toFixed(0)}s (${remaining.toFixed(1)}s left).`;
            }
            setTimeout(tickRecordStatus, 200);
        };
        recordBtn.onclick = async () => {
            if (recording) {
                // User-driven stop: write WAV + dump sidecar (same shape
                // as the auto-finalize at session boundaries) so the
                // recording is fixture-promotable without a separate path.
                await recordAutoFinalize('manual');
                renderRecordIdle();
                return;
            }
            const secs = parseInt(recordSecsSel.value || '60', 10);
            recordBtn.disabled = true;
            const filename = await recordSessionStart(secs);
            recordBtn.disabled = false;
            if (!filename) return;
            renderRecordActive();
            recordPollT0.value = performance.now();
            tickRecordStatus();
        };

        populateDevices();
    }

    function onDeviceChange(deviceId) {
        selectedDeviceId = deviceId;
        saveSettings();
        restartAudio();
    }

    function onChannelChange(channel) {
        selectedChannel = channel;
        saveSettings();
        restartAudio();
    }

    async function populateDevices() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const sel = instanceRoot.querySelector('.nd-device-select');
            if (!sel) return;
            sel.innerHTML = '<option value="">Default</option>';
            for (const d of devices) {
                if (d.kind !== 'audioinput') continue;
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Input ${d.deviceId.slice(0, 8)}`;
                if (d.deviceId === selectedDeviceId) opt.selected = true;
                sel.appendChild(opt);
            }
        } catch (e) { /* permission not yet granted */ }
    }

    function setMethod(method) {
        detectionMethod = method;
        // User explicitly chose — disable auto-switch on bass.
        methodExplicit = true;
        saveSettings();
        if (method === 'crepe') _ndLoadCrepe();
    }

    // Accepts only the documented channel indices (-1 mono, 0 left,
    // 1 right). Returns `false` and leaves the channel unchanged for
    // anything else so upstream bugs (stringified input, out-of-range
    // index) surface instead of silently coercing to mono.
    function setChannel(idx) {
        let next;
        if (idx === -1) next = 'mono';
        else if (idx === 0) next = 'left';
        else if (idx === 1) next = 'right';
        else {
            console.warn(`[note_detect] setChannel: invalid channel ${idx}; expected -1 (mono), 0 (left), or 1 (right).`);
            return false;
        }
        selectedChannel = next;
        saveSettings();
        restartAudio();
        return true;
    }

    // ── HUD ───────────────────────────────────────────────────────────
    function createHUD() {
        if (instanceRoot.querySelector('.nd-hud')) return;
        const hud = document.createElement('div');
        hud.className = 'nd-hud absolute top-3 right-16 z-[20] pointer-events-none text-right';
        hud.innerHTML = `
            <div class="nd-hud-accuracy text-xl font-bold" style="text-shadow:0 0 8px currentColor"></div>
            <div class="nd-hud-streak text-xs text-gray-400 mt-0.5"></div>
            <div class="nd-hud-counts text-[10px] text-gray-600 mt-0.5"></div>
            <div class="nd-hud-recent text-[10px] mt-1 font-mono tracking-wider"></div>
            <div class="nd-hud-timing text-[10px] mt-0.5 font-mono"></div>
            <div class="nd-hud-cause text-[10px] mt-0.5 text-amber-400 font-mono max-w-[240px]"></div>
            <div class="nd-hud-detected text-[10px] text-cyan-400 mt-1 font-mono"></div>
        `;
        instanceRoot.appendChild(hud);
    }

    function removeHUD() {
        const hud = instanceRoot.querySelector('.nd-hud');
        if (hud) hud.remove();
        const flash = instanceRoot.querySelector('.nd-flash-overlay');
        if (flash) flash.remove();
    }

    function createFlashOverlay() {
        if (instanceRoot.querySelector('.nd-flash-overlay')) return;
        const flash = document.createElement('div');
        flash.className = 'nd-flash-overlay';
        flash.style.cssText = 'position:absolute;inset:0;z-index:20;pointer-events:none;border:4px solid transparent;transition:border-color 0.05s;';
        instanceRoot.appendChild(flash);
    }

    function startHUD() {
        createHUD();
        createFlashOverlay();
        lastHitCount = 0;
        lastMissCount = 0;
        if (hudInterval) clearInterval(hudInterval);
        hudInterval = setInterval(updateHUD, 33);
    }

    function stopHUD() {
        if (hudInterval) { clearInterval(hudInterval); hudInterval = null; }
        removeHUD();
    }

    function updateHUD() {
        if (!enabled) return;

        const total = hits + misses;
        const accEl = instanceRoot.querySelector('.nd-hud-accuracy');
        const streakEl = instanceRoot.querySelector('.nd-hud-streak');
        const countsEl = instanceRoot.querySelector('.nd-hud-counts');
        const detectedEl = instanceRoot.querySelector('.nd-hud-detected');
        const flashEl = instanceRoot.querySelector('.nd-flash-overlay');
        const recentEl = instanceRoot.querySelector('.nd-hud-recent');
        const timingEl = instanceRoot.querySelector('.nd-hud-timing');
        const causeEl = instanceRoot.querySelector('.nd-hud-cause');

        // Recent strip: ✓⚠✗∅· tier of the last 8 judgments. Colored
        // per-character so the user can see "I was clean, then 3
        // sustain-bleeds, then 1 wrong-pitch" at a glance.
        if (recentEl) {
            const colorOf = (k) => ({
                '✓': '#10b981',
                '⚠': '#f59e0b',
                '✗': '#fb923c',
                '∅': '#ef4444',
                '·': '#6b7280',
            }[k] || '#6b7280');
            recentEl.innerHTML = hudRecent
                .map(k => `<span style="color:${colorOf(k)}">${k}</span>`)
                .join('');
        }

        // Timing/drift status: live drift estimate, color-coded.
        // Above threshold = amber + 'open ⚙ to calibrate'; within
        // threshold = green. Auto-cal was reverted (runaway path);
        // the gear panel's "Apply latency from recent hits" button
        // is the manual calibration replacement.
        if (timingEl) {
            if (driftBuffer.length < _ND_DRIFT_MIN_SAMPLES) {
                timingEl.textContent = '';
            } else {
                const d = Math.round(driftEstimateMs);
                const direction = d > 0 ? 'LATE' : d < 0 ? 'EARLY' : 'OK';
                const aboveThreshold = Math.abs(d) > _ND_DRIFT_SIGNIFICANT_MS;
                const color = aboveThreshold ? '#f59e0b' : '#10b981';
                const cal = aboveThreshold ? ' · open ⚙ to calibrate' : '';
                timingEl.innerHTML = `<span style="color:${color}">${direction} ${d > 0 ? '+' : ''}${d}ms${cal}</span>`;
            }
        }

        // Cause line: most recent non-OK judgment in plain text.
        if (causeEl) {
            causeEl.textContent = hudLastCause || '';
        }

        if (accEl && total > 0) {
            const accuracy = Math.round((hits / total) * 100);
            const color = accuracy >= 90 ? '#00ff88' : accuracy >= 70 ? '#ffcc00' : '#ff4444';
            accEl.textContent = accuracy + '%';
            accEl.style.color = color;
        } else if (accEl) {
            accEl.textContent = '';
        }

        if (streakEl) {
            let text = streak > 0 ? `${streak} streak` : '';
            if (bestStreak > 0) text += `  best: ${bestStreak}`;
            streakEl.textContent = text;
        }

        if (countsEl && total > 0) {
            countsEl.textContent = `${hits} / ${total}`;
        } else if (countsEl) {
            // Clear on zero-total so a reset/new-song enable doesn't
            // show the previous session's `X / Y` until the first
            // judgment lands. Mirrors the accuracy label's else-branch.
            countsEl.textContent = '';
        }

        if (detectedEl) {
            if (detectedString >= 0 && detectedConfidence > 0.3) {
                // Use the chart-corrected display MIDI when available;
                // otherwise use the raw detected MIDI. Bass, 7-string guitar,
                // non-standard tuning, and capo all still route through the
                // same MIDI-name formatter instead of string-index lookups.
                const displayMidi = Number.isFinite(detectedDisplayMidi) ? detectedDisplayMidi : detectedMidi;
                detectedEl.textContent = `${_ndMidiToName(displayMidi)} · s${detectedString} f${detectedFret}`;
            } else if (lastChordScore !== null) {
                // No confident single-note detected this frame, but we
                // have a recent chord score from the constraint path —
                // show it for a short TTL after the chord's chart time
                // so the readout doesn't linger forever through silence
                // / noise between notes.
                const songTime = (hw.getTime ? hw.getTime() : 0) - latencyOffset
                    + (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
                const CHORD_HUD_TTL_SEC = 1.5;
                if (songTime - lastChordTime <= CHORD_HUD_TTL_SEC) {
                    const pct = Math.round(lastChordScore * 100);
                    detectedEl.textContent = `chord ${lastChordHit}/${lastChordTotal} (${pct}%)`;
                } else {
                    detectedEl.textContent = '';
                }
            } else {
                detectedEl.textContent = '';
            }
        }

        if (flashEl) {
            // Track pending flash timeouts so destroy()/disable() can
            // clear them. Each timeout self-splices from the list on
            // fire so the array doesn't grow unbounded across a long
            // session (~60 min of play at ~20 hits/min was previously
            // accumulating ~1200 stale entries before disable ran).
            const spawnFlash = (color) => {
                flashEl.style.borderColor = color;
                const tid = setTimeout(() => {
                    if (flashEl) flashEl.style.borderColor = 'transparent';
                    const idx = flashTimeouts.indexOf(tid);
                    if (idx !== -1) flashTimeouts.splice(idx, 1);
                }, 80);
                flashTimeouts.push(tid);
            };
            if (hits > lastHitCount) {
                spawnFlash('rgba(0, 255, 136, 0.6)');
            } else if (misses > lastMissCount) {
                spawnFlash('rgba(255, 50, 68, 0.4)');
            }
            lastHitCount = hits;
            lastMissCount = misses;
        }
    }

    // ── Draw hook overlay on the highway canvas ───────────────────────
    function drawOverlay(ctx, W, H) {
        // Drill judgment-window floor highlight runs BEFORE the !enabled
        // gate so the user sees the score-on transition reliably during
        // a drill, even on the first iteration (when enabled may have
        // briefly been false during getUserMedia setup). Visible band
        // (~40% of the highway height) with a sharp top border so the
        // user can't miss the visual cue at exactly judgeStart.
        if (drillActive && drillJudgeStart != null && drillJudgeEnd != null) {
            const t = hw.getTime ? hw.getTime() : 0;
            if (t >= drillJudgeStart && t < drillJudgeEnd) {
                const top = H * 0.6;
                ctx.save();
                const grad = ctx.createLinearGradient(0, top, 0, H);
                grad.addColorStop(0, 'rgba(96, 165, 250, 0)');
                grad.addColorStop(0.5, 'rgba(96, 165, 250, 0.18)');
                grad.addColorStop(1, 'rgba(96, 165, 250, 0.50)');
                ctx.fillStyle = grad;
                ctx.fillRect(0, top, W, H - top);
                // Bright top border so the start of the judgment window
                // is unmistakable when the audio crosses judgeStart.
                ctx.fillStyle = 'rgba(96, 165, 250, 0.85)';
                ctx.fillRect(0, top, W, 2);
                ctx.restore();
            }
        }

        if (!enabled) return;
        if (!hw.project || !hw.fretX) return;

        const t = hw.getTime();
        const renderT = t + (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const notes = hw.getNotes();
        const chords = hw.getChords();

        const drawTextReadable = (text, x, y) => {
            if (hw.fillTextUnmirrored) hw.fillTextUnmirrored(text, x, y);
            else ctx.fillText(text, x, y);
        };

        const nowPoint = hw.project(0);

        const drawIndicator = (s, f, noteTime, judgment) => {
            const tOff = noteTime - renderT;
            if (!nowPoint) return;

            const age = Math.max(0, renderT - noteTime);
            let scale = nowPoint.scale || 1;
            let x;
            let y;
            if (judgment.hit || tOff >= -0.05) {
                const p = hw.project(tOff);
                if (!p) return;
                scale = p.scale || scale;
                x = hw.fretX(f, scale, W);
                y = p.y * H;
            } else {
                const nowY = nowPoint.y * H;
                const pastArea = Math.max(40, H - nowY - 18);
                const progress = Math.min(1, age / Math.max(0.1, missMarkerDuration));
                x = hw.fretX(f, scale, W);
                y = nowY + Math.min(pastArea, 28 + progress * pastArea);
            }

            if (judgment.hit) {
                const fade = Math.max(0, 1 - age / Math.max(0.1, hitGlowDuration)) * scale;
                if (fade <= 0) return;
                ctx.save();
                ctx.globalAlpha = fade * 0.7;
                ctx.globalCompositeOperation = 'lighter';
                ctx.shadowColor = '#00ff88';
                ctx.shadowBlur = 20 * scale;
                ctx.strokeStyle = '#00ff88';
                ctx.lineWidth = 3 * scale;
                ctx.beginPath();
                ctx.arc(x, y, 14 * scale, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
            } else {
                const fade = Math.max(0, 1 - age / Math.max(0.1, missMarkerDuration)) * scale;
                if (fade <= 0) return;
                ctx.save();
                ctx.globalAlpha = fade * 0.85;
                ctx.shadowColor = '#ff3344';
                ctx.shadowBlur = 12 * scale;
                ctx.strokeStyle = '#ff3344';
                ctx.lineWidth = 2.5 * scale;
                const sz = 8 * scale;
                ctx.beginPath();
                ctx.moveTo(x - sz, y - sz);
                ctx.lineTo(x + sz, y + sz);
                ctx.moveTo(x + sz, y - sz);
                ctx.lineTo(x - sz, y + sz);
                ctx.stroke();

                const pulse = Math.max(0, 1 - age / 0.2);
                if (pulse > 0) {
                    const nowY = nowPoint.y * H;
                    ctx.globalAlpha = pulse * 0.5;
                    ctx.strokeStyle = '#ff3344';
                    ctx.lineWidth = 5 * scale;
                    ctx.beginPath();
                    ctx.moveTo(Math.max(0, x - 18 * scale), nowY + 4);
                    ctx.lineTo(Math.min(W, x + 18 * scale), nowY + 4);
                    ctx.stroke();
                }

                // Removed the after-the-fact "↑ -300ms" / "♭ +200¢"
                // labels on miss markers. User feedback: 'the "you
                // missed" markers ... -300ms idk if that's what it
                // thinks I did or what it is expecting, but it's not
                // helpful'. The labels appeared AFTER the note had
                // passed and were ambiguously-signed (negative meant
                // EARLY but the visual arrow flipped, confusing the
                // direction). The cause line in the HUD now surfaces
                // the same info in plain text on the most recent miss
                // ('late 80ms on s1/f5'), where it's actually readable
                // mid-play. Proactive pre-note coaching (drift hint
                // near approaching notes) ships next.
                ctx.restore();
            }
        };

        // Proactive coaching hint: when the drift estimator has
        // stabilized AND the user is consistently off-target, paint
        // a small chevron/text on each upcoming chart note saying
        // which way to nudge their timing. The signal is the SAME
        // driftEstimateMs the auto-cal latch reads — once auto-cal
        // fires, drift resets to 0 and the hint goes silent
        // (calibration absorbed the bias). Only fires for notes in
        // the lookahead window (next ~2.5s) so the user has time
        // to read and act.
        const driftHintMs = (driftBuffer.length >= _ND_DRIFT_MIN_SAMPLES
                              && Math.abs(driftEstimateMs) > _ND_DRIFT_SIGNIFICANT_MS / 2)
            ? driftEstimateMs : 0;

        if (notes) {
            for (const n of notes) {
                if (n.t < renderT - missMarkerDuration - 0.2) continue;
                if (n.t > renderT + 3) break;
                if (n.mt) continue;
                const key = noteKey(n, n.t);
                const result = noteResults.get(key);
                if (result) {
                    drawIndicator(n.s, n.f, n.t, result);
                } else if (driftHintMs !== 0 && n.t > renderT && n.t < renderT + 2.5) {
                    // Unjudged + upcoming: show the drift hint.
                    const p = hw.project(n.t - renderT);
                    if (p) {
                        const hintX = hw.fretX(n.f, p.scale || 1, W);
                        const hintY = p.y * H;
                        ctx.save();
                        ctx.globalAlpha = 0.55;
                        ctx.font = `${Math.max(9, 10 * (p.scale || 1))}px sans-serif`;
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'top';
                        const text = driftHintMs > 0
                            ? `↑ ${Math.round(driftHintMs)}ms earlier`
                            : `↓ ${Math.round(-driftHintMs)}ms later`;
                        ctx.lineWidth = 2;
                        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
                        ctx.strokeText(text, hintX, hintY + 18 * (p.scale || 1));
                        ctx.fillStyle = '#fbbf24';
                        drawTextReadable(text, hintX, hintY + 18 * (p.scale || 1));
                        ctx.restore();
                    }
                }
            }
        }
        if (chords) {
            for (const c of chords) {
                if (c.t < renderT - missMarkerDuration - 0.2) continue;
                if (c.t > renderT + 3) break;
                for (const cn of (c.notes || [])) {
                    if (cn.mt) continue;
                    const key = noteKey(cn, c.t);
                    const result = noteResults.get(key);
                    if (result) drawIndicator(cn.s, cn.f, c.t, result);
                }
            }
        }

        if (detectedString >= 0 && detectedConfidence > 0.3) {
            if (nowPoint) {
                const x = hw.fretX(detectedFret, nowPoint.scale, W);
                const y = nowPoint.y * H;
                ctx.save();
                ctx.globalAlpha = Math.min(1, detectedConfidence);
                ctx.fillStyle = '#44ddff';
                ctx.shadowColor = '#44ddff';
                ctx.shadowBlur = 12;
                ctx.beginPath();
                ctx.arc(x, y, 6, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#000';
                ctx.font = 'bold 7px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(detectedFret, x, y);
                ctx.restore();
            }
        }
    }

    // ── Button injection ──────────────────────────────────────────────
    // Attach instanceRoot into the DOM. Called from `injectButton()`
    // and from `enable()` so programmatic `createNoteDetector({container}).enable()`
    // usage (no button injection) still gets HUD/settings/summary
    // rendered. Idempotent — re-attaching an already-appended element
    // is a no-op via the `contains()` guard.
    function attachInstanceRoot() {
        const target = container || document.getElementById('player');
        if (target && !target.contains(instanceRoot)) {
            target.appendChild(instanceRoot);
        }
    }

    function injectButton(bar) {
        const controls = bar || document.getElementById('player-controls');
        if (!controls) return;
        if (detectBtn && controls.contains(detectBtn)) return;

        const closeBtn = controls.querySelector('button:last-child');

        detectBtn = document.createElement('button');
        detectBtn.className = 'nd-detect-btn px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
        detectBtn.textContent = 'Detect';
        detectBtn.title = 'Toggle real-time note detection & scoring';
        detectBtn.onclick = toggle;
        if (closeBtn) controls.insertBefore(detectBtn, closeBtn);
        else controls.appendChild(detectBtn);

        // Unit UX-restart: restart the current song from t=0 with a
        // clean slate. The user reported needing this when they mess
        // up the start of a song \u2014 re-picking from the playlist is
        // too many clicks. Hidden until detect is enabled (no point
        // restarting if you weren't being scored).
        restartBtn = document.createElement('button');
        restartBtn.className = 'nd-restart-btn px-2 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition hidden';
        restartBtn.textContent = '\u21ba';  // ANTICLOCKWISE OPEN CIRCLE ARROW
        restartBtn.title = 'Restart song \u2014 seek to start, reset scoring';
        restartBtn.onclick = restartSong;
        if (closeBtn) controls.insertBefore(restartBtn, closeBtn);
        else controls.appendChild(restartBtn);

        // Unit UX-skip-intro: jump audio to 5s before the first chart
        // note. Songs that open with silence or non-instrument intros
        // waste the player's time at every restart; this is "skip the
        // boring part" for charts. Five seconds is the runway \u2014 long
        // enough for the player to settle and reach the first
        // detection-window, short enough that they don't get bored
        // again.
        skipBtn = document.createElement('button');
        skipBtn.className = 'nd-skip-btn px-2 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition hidden';
        skipBtn.textContent = '\u23ed';  // BLACK RIGHT-POINTING DOUBLE TRIANGLE WITH VERTICAL BAR
        skipBtn.title = 'Skip to 5s before first chart note';
        skipBtn.onclick = skipToFirstNote;
        if (closeBtn) controls.insertBefore(skipBtn, closeBtn);
        else controls.appendChild(skipBtn);

        gearBtn = document.createElement('button');
        gearBtn.className = 'nd-gear-btn px-2 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition hidden';
        gearBtn.textContent = '\u2699';
        gearBtn.title = 'Note detection settings';
        gearBtn.onclick = showSettings;
        if (closeBtn) controls.insertBefore(gearBtn, closeBtn);
        else controls.appendChild(gearBtn);

        attachInstanceRoot();
        // Sync button class/text with current state. If the instance
        // was already enabled (or CREPE is mid-load) when the button is
        // injected, the default 'Detect' text would be out of date.
        updateButton();
    }

    function updateButton() {
        if (!detectBtn) return;
        const loading = detectionMethod === 'crepe' && _ndShared.modelLoading;
        if (loading) {
            detectBtn.textContent = 'Detect (loading model...)';
            detectBtn.className = 'nd-detect-btn px-3 py-1.5 bg-dark-600 rounded-lg text-xs text-gray-400 transition';
        } else if (enabled) {
            detectBtn.className = 'nd-detect-btn px-3 py-1.5 bg-green-900/50 rounded-lg text-xs text-green-300 transition';
            detectBtn.textContent = 'Detect \u2713';
        } else {
            detectBtn.className = 'nd-detect-btn px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
            detectBtn.textContent = 'Detect';
        }
        if (gearBtn) gearBtn.classList.toggle('hidden', !enabled);
        if (restartBtn) restartBtn.classList.toggle('hidden', !enabled);
        if (skipBtn) skipBtn.classList.toggle('hidden', !enabled);
    }

    // Unit UX-restart: seek audio to 0 and clear scoring.
    //
    // Original design: did NOT snapshot the abandoned attempt under
    // the theory that restart is for "I messed up the start" and
    // saving half-finished plays would clutter history. User pushback
    // (2026-05-05): "playing, and then restarting the song makes the
    // recording not work in the report I see 30 seconds of play".
    // The current behavior throws away pre-restart play data even
    // when there's substantial signal (e.g. a 2-minute attempt the
    // player wants to abandon mid-bridge). Worse: it silently makes
    // the just-played session DISAPPEAR from history.
    //
    // New design: snapshot the play before resetting if there's any
    // judged data at all. snapshotPlay's empty-noteResults check
    // already filters trivial restarts (right after another
    // restart, before any judgments accumulated). Threshold: at
    // least one judgment in noteResults — let the user decide what
    // counts as "worth saving" rather than imposing a minimum.
    function restartSong() {
        if (drillActive) endDrill();
        const audio = document.getElementById('audio');
        if (!audio) {
            console.warn('[note_detect] restartSong: no <audio id="audio"> element');
            return;
        }
        // Snapshot the current attempt so it persists before reset.
        // Fire-and-forget (no await) — the seek + reset shouldn't
        // wait for the network round-trip to start the fresh attempt.
        // snapshotPlay returns null when noteResults is empty, so
        // restart-then-restart doesn't double-snapshot.
        snapshotPlay('restart').catch(() => {});
        try { audio.currentTime = 0; } catch (e) {
            console.warn('[note_detect] restartSong: seek failed:', e);
            return;
        }
        resetScoring();
        // Resume playback so the user doesn't have to also click
        // play. If detection is enabled and the user just seeked,
        // they want to start playing immediately — pause-after-
        // restart is the wrong default.
        try { audio.play().catch(() => {}); } catch (e) {}
        // Visual feedback: brief flash on the restart button so the
        // user sees the action registered. Detection state itself
        // doesn't change (still enabled, just zeroed).
        if (restartBtn) {
            restartBtn.classList.add('bg-blue-700');
            setTimeout(() => {
                if (restartBtn) restartBtn.classList.remove('bg-blue-700');
            }, 200);
        }
    }

    // Unit UX-skip-intro: seek audio forward to 5s before the first
    // chart note. Useful for songs with silent intros / non-bass
    // intros where waiting through the lead-in every restart wastes
    // the player's time. No scoring reset — intros typically have
    // no chart notes (that's why we're skipping), so checkMisses
    // doesn't see any "missed" notes in the skipped region.
    function skipToFirstNote() {
        const audio = document.getElementById('audio');
        if (!audio) {
            console.warn('[note_detect] skipToFirstNote: no <audio id="audio"> element');
            return;
        }
        const _hw = resolveHw();
        const notes = (_hw && _hw.getNotes && _hw.getNotes()) || [];
        // First note's chart time. Notes are sorted by t in slopsmith
        // (highway invariant) so [0] is the earliest. If the chart
        // has no notes the button is meaningless — bail with a
        // console hint rather than silently doing nothing.
        if (!notes.length) {
            console.warn('[note_detect] skipToFirstNote: no chart notes loaded');
            return;
        }
        const firstNoteT = notes[0].t;
        // 5-second runway. Clamp to 0 so songs whose first note is
        // at t<5 don't seek to a negative time. avOffset is in the
        // ±30ms range — well within the 5s buffer, so no need to
        // explicitly translate chart-time to audio-time.
        const targetT = Math.max(0, firstNoteT - 5);
        try { audio.currentTime = targetT; } catch (e) {
            console.warn('[note_detect] skipToFirstNote: seek failed:', e);
            return;
        }
        try { audio.play().catch(() => {}); } catch (e) {}
        if (skipBtn) {
            skipBtn.classList.add('bg-blue-700');
            setTimeout(() => {
                if (skipBtn) skipBtn.classList.remove('bg-blue-700');
            }, 200);
        }
    }

    // ── Visual sync calibration modal ─────────────────────────────────
    // User adjusts avOffset until they perceive an audible click and
    // a visual flash as simultaneous on their setup. avOffset shifts
    // the visual flash relative to the click; the user dials it in.
    //
    // Discrete buttons (-50/-5/+5/+50) instead of slider per user
    // request — keystroke / +1ms granularity is too fine to feel a
    // difference, slider drag overshoots.
    //
    // Loop: every 2 seconds, schedule a click at ctxT and a flash at
    // (ctxT + avOffsetSec) on the wall clock. User adjusts avOffset
    // → flash timing shifts relative to click → they tune to taste.
    function openVisualCalModal() {
        if (!audioCtx) {
            console.warn('[note_detect] visual cal: no AudioContext yet — enable Detect first');
            return;
        }
        const overlay = document.createElement('div');
        overlay.id = 'nd-vcal-modal';
        overlay.className = 'fixed inset-0 z-[300] bg-black/85 flex items-center justify-center';
        overlay.innerHTML = `
            <div class="bg-dark-800 border border-purple-700 rounded-2xl p-6 w-[400px] max-w-[90vw]">
                <div class="text-purple-300 font-semibold text-lg mb-2">Visual Sync Calibration</div>
                <div class="text-gray-400 text-xs mb-4 leading-snug">
                    A click plays with a flash every 2 seconds. Adjust avOffset
                    until the click and flash feel simultaneous. The same
                    avOffset is used for chart-time matching during play.
                </div>
                <div class="flex justify-center mb-5 h-32 items-center">
                    <div class="nd-vcal-flash w-28 h-28 rounded-full bg-gray-700 transition-colors duration-75"
                         style="box-shadow: 0 0 20px rgba(168, 85, 247, 0.0);"></div>
                </div>
                <div class="text-center mb-3">
                    <div class="text-gray-300 text-xs">avOffset</div>
                    <div class="nd-vcal-value font-mono text-2xl text-purple-300">0ms</div>
                    <div class="text-gray-600 text-[10px] mt-1">
                        negative = chart visual leads audio (compensates output delay)
                    </div>
                </div>
                <div class="grid grid-cols-4 gap-2 mb-3">
                    <button class="nd-vcal-btn px-2 py-2 bg-dark-600 hover:bg-dark-500 rounded text-xs font-mono" data-delta="-50">−50ms</button>
                    <button class="nd-vcal-btn px-2 py-2 bg-dark-600 hover:bg-dark-500 rounded text-xs font-mono" data-delta="-5">−5ms</button>
                    <button class="nd-vcal-btn px-2 py-2 bg-dark-600 hover:bg-dark-500 rounded text-xs font-mono" data-delta="5">+5ms</button>
                    <button class="nd-vcal-btn px-2 py-2 bg-dark-600 hover:bg-dark-500 rounded text-xs font-mono" data-delta="50">+50ms</button>
                </div>
                <button class="nd-vcal-close w-full px-2 py-2 bg-purple-700 hover:bg-purple-600 rounded text-sm text-white">
                    Done
                </button>
            </div>
        `;
        document.body.appendChild(overlay);

        const flashEl = overlay.querySelector('.nd-vcal-flash');
        const valueEl = overlay.querySelector('.nd-vcal-value');

        const readAv = () => {
            const _hw = resolveHw();
            return (_hw && _hw.getAvOffset) ? Math.round(_hw.getAvOffset() || 0) : 0;
        };
        const refreshValue = () => {
            const av = readAv();
            valueEl.textContent = (av > 0 ? '+' : '') + av + 'ms';
        };
        refreshValue();

        overlay.querySelectorAll('.nd-vcal-btn').forEach(btn => {
            btn.onclick = () => {
                const delta = parseInt(btn.dataset.delta, 10);
                const next = readAv() + delta;
                if (typeof window !== 'undefined' && typeof window.setAvOffsetMs === 'function') {
                    window.setAvOffsetMs(next);
                } else {
                    const _hw = resolveHw();
                    if (_hw && _hw.setAvOffset) _hw.setAvOffset(next);
                }
                refreshValue();
            };
        });

        let stopped = false;
        const stop = () => {
            stopped = true;
            overlay.remove();
        };
        overlay.querySelector('.nd-vcal-close').onclick = stop;
        overlay.addEventListener('click', (e) => { if (e.target === overlay) stop(); });

        // Tight click/flash sync. Clicks scheduled in audioCtx time
        // (sample-accurate). Flashes driven by requestAnimationFrame +
        // audioCtx.getOutputTimestamp() so flash render is within one
        // frame (~16ms) of click playback regardless of JS event loop
        // jitter. Was using setTimeout — produced 5-20ms variance per
        // iteration and the user noticed iteration drift.
        //
        // Pre-schedule N click events into the audio graph; track an
        // array of upcoming flash ctxTimes for the rAF loop to fire
        // visually. avOffset can change mid-loop without scheduling
        // damage — we compute "should I flash now?" against the
        // current avOffset on each frame.
        const beatSec = 2.0;
        const N_CLICKS = 60;  // ~120s of cal time before user has to reopen
        const startCtxT = audioCtx.currentTime + 0.5;
        const upcomingFlashes = [];  // array of click ctxTimes
        const clickGainShared = audioCtx.createGain();
        clickGainShared.gain.value = 0;
        clickGainShared.connect(audioCtx.destination);
        for (let i = 0; i < N_CLICKS; i++) {
            const ctxT = startCtxT + i * beatSec;
            // Schedule click via Web Audio (each gets its own
            // oscillator since AudioBufferSource/Oscillator are
            // one-shot in Web Audio).
            const osc = audioCtx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = 880;
            osc.connect(clickGainShared);
            clickGainShared.gain.setValueAtTime(0, ctxT);
            clickGainShared.gain.linearRampToValueAtTime(0.3, ctxT + 0.005);
            clickGainShared.gain.linearRampToValueAtTime(0, ctxT + 0.06);
            osc.start(ctxT);
            osc.stop(ctxT + 0.07);
            upcomingFlashes.push(ctxT);
        }

        // rAF loop: on each animation frame, check if any upcoming
        // click ctxTime + avOffset has been reached relative to NOW
        // in audioCtx time. If so, fire flash and pop from queue.
        const doFlash = () => {
            flashEl.classList.add('bg-purple-400');
            flashEl.style.boxShadow = '0 0 30px rgba(168, 85, 247, 0.9)';
            setTimeout(() => {
                flashEl.classList.remove('bg-purple-400');
                flashEl.style.boxShadow = '0 0 20px rgba(168, 85, 247, 0.0)';
            }, 80);
        };
        const tick = () => {
            if (stopped) {
                // Stop scheduled clicks too — disconnect the shared
                // gain so nothing further plays. Already-scheduled
                // start()s before disconnect WILL still play; modal
                // close + audio stop is approximate, not surgical.
                try { clickGainShared.disconnect(); } catch (e) {}
                return;
            }
            const nowCtx = audioCtx.currentTime;
            const avOffsetSec = readAv() / 1000;
            // Flash should fire when click is audible (ctxT) + offset.
            // Pop all flashes whose target time has passed.
            while (upcomingFlashes.length > 0
                   && (upcomingFlashes[0] + avOffsetSec) <= nowCtx) {
                upcomingFlashes.shift();
                doFlash();
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    // ── Reset / enable / disable / destroy ────────────────────────────
    function resetScoring() {
        hits = 0;
        misses = 0;
        streak = 0;
        bestStreak = 0;
        noteResults.clear();
        sectionStats = [];
        currentSection = null;
        detectedMidi = -1;
        detectedConfidence = 0;
        detectedString = -1;
        detectedFret = -1;
        detectedDisplayMidi = -1;
        lastChordScore = null;
        lastChordHit = 0;
        lastChordTotal = 0;
        lastChordTime = -Infinity;
        // Drift estimator restarts per session so a song's per-track
        // latency doesn't leak into the next track's calibration.
        driftBuffer = [];
        driftEstimateMs = 0;
        // Live HUD state — same per-session reset so the strip doesn't
        // carry the previous song's judgments.
        hudRecent = [];
        hudLastCause = null;
        // Onset state — same reasoning. Don't carry inNote=true into
        // the next session or the first note will be missed by the
        // refractory check.
        inNote = false;
        lastOnsetPerfSec = 0;
        reattackArmed = false;
        reattackRmsBuf = [];
        onsetCount = 0;
        // Stability voting state.
        rawMidiHistory = [];
        stableMidi = -1;
        // Onset-gated matching state.
        pendingOnsetChartT = null;
        lastMatchMidi = -1;
        lastMatchTime = 0;
    }

    // Tracks an in-flight enable() promise. A second enable() call
    // while the first is still awaiting startAudio returns the
    // SAME promise rather than short-circuiting on the already-set
    // `enabled` flag — otherwise the second caller would see
    // `return true` while audio isn't actually started yet, and if
    // startAudio ultimately failed, the first call's cleanup would
    // flip `enabled` back to false after the second had already
    // reported success.
    let enableInFlight = null;
    function enable() {
        if (enableInFlight) return enableInFlight;
        if (enabled) return Promise.resolve(true);
        enableInFlight = (async () => {
            try {
                return await enableImpl();
            } finally {
                enableInFlight = null;
            }
        })();
        return enableInFlight;
    }

    async function enableImpl() {
        // Resolve the highway lazily — supports plugin load orders
        // where highway isn't defined at factory construction. If
        // it's still missing, there's nothing to hook into, so bail
        // cleanly rather than throw from `hw.getSongInfo()` below.
        if (!resolveHw()) {
            console.warn('[note_detect] enable() called but `highway` is not available yet — plugin may have loaded before slopsmith core.');
            return false;
        }
        ensureDrawHook();
        enabled = true;
        // Make sure the instanceRoot is in the DOM before HUD/summary
        // rendering kicks in — `createNoteDetector({container}).enable()`
        // without a prior `injectButton()` call would otherwise render
        // to a detached subtree.
        attachInstanceRoot();
        updateButton();

        const info = hw.getSongInfo ? hw.getSongInfo() : null;
        if (info && info.tuning) {
            tuningOffsets = info.tuning;
            // Slopsmith core exposes the arrangement string count directly.
            // Prefer it over tuning.length because RS XML pads bass tunings
            // to six entries; fall back to tuning length for older cores.
            const stringCount = hw.getStringCount ? hw.getStringCount() : undefined;
            currentStringCount = Number.isFinite(stringCount)
                ? stringCount
                : tuningOffsets.length;
        } else {
            // No tuning info — reset to 6-string zero-offset default.
            // Reassign to a fresh array rather than mutate in place: the
            // current `tuningOffsets` reference may point at the previous
            // song's `info.tuning` (assigned in the `if` branch above), so
            // `.length = 6 / .fill(0)` would clobber the highway's data.
            currentStringCount = 6;
            tuningOffsets = [0, 0, 0, 0, 0, 0];
        }
        if (info && info.capo !== undefined) capo = info.capo;
        if (info && info.arrangement) currentArrangement = _ndArrangementKindFromName(info.arrangement);

        // Auto-switch detection method based on arrangement IF the
        // user hasn't explicitly chosen one. HPS is the bass-friendly
        // default (handles low-string suppressed-fundamental cases
        // that YIN locks the wrong octave on); YIN is the lightweight
        // default for guitar. Only fires on the default singleton —
        // non-default instances keep whatever they were constructed
        // with. Triggers a saveSettings so the auto-pick persists
        // (without setting methodExplicit, so a future arrangement
        // switch can re-evaluate).
        if (isDefault && !methodExplicit) {
            const isBass = currentArrangement === 'bass';
            const wantMethod = isBass ? 'hps' : 'yin';
            if (detectionMethod !== wantMethod) {
                console.log(`[note_detect] auto-switch detection method: ${detectionMethod} → ${wantMethod} (arrangement=${currentArrangement})`);
                detectionMethod = wantMethod;
                saveSettings();
                if (wantMethod === 'crepe') _ndLoadCrepe();
            }
        }

        resetScoring();

        // Queue the audio acquisition through the shared chain so
        // enable cannot overlap with a concurrent restartAudio
        // (settings slider) or another enable. Without this,
        // startAudio from enable and startAudio from a settings-
        // triggered restart could both race to write `stream` /
        // `audioCtx` / node refs.
        const result = await queueAudioOp(async () => {
            // Early bail before startAudio: disable()/destroy() may
            // have run after enable() queued this op but before it
            // got its turn on the chain. Calling startAudio in that
            // case would prompt for mic permission and create nodes
            // purely to tear them down on the next line.
            if (!enabled) return { ok: false, superseded: true };
            // New session — bump the generation counter and snapshot
            // it so we can detect a disable() that fires while
            // startAudio is still awaited.
            sessionGen++;
            const gen = sessionGen;
            const ok = await startAudio();
            if (gen !== sessionGen || !enabled) {
                // Superseded by disable() during the await. Tear down
                // the audio that just came up.
                if (ok) stopAudio();
                return { ok: false, superseded: true };
            }
            return { ok, superseded: false };
        });

        if (result.superseded) {
            // disable() ran during the await and already set
            // enabled=false / updated the button. Just report the
            // aborted enable back to the caller.
            return false;
        }
        if (!result.ok) {
            enabled = false;
            updateButton();
            return false;
        }

        missCheckInterval = setInterval(checkMisses, 100);
        startHUD();

        // Per-instance GC of noteResults — previously a module-level
        // setInterval; moving it into the closure lets each instance
        // prune its own Map.
        gcInterval = setInterval(() => {
            if (!enabled || noteResults.size < 500) return;
            const t = hw.getTime();
            for (const [key] of noteResults) {
                const noteTime = parseFloat(key.split('_')[0]);
                if (noteTime < t - 5) noteResults.delete(key);
            }
        }, 5000);

        // Auto-dump diagnostics every 30s to /tmp/nd_diagnostics so
        // the user doesn't have to paste console output during port
        // debugging — the dumps land on the slopsmith host's disk and
        // can be read directly. Default singleton only; non-default
        // instances would step on each other's filenames.
        if (isDefault) {
            diagnosticsInterval = setInterval(() => {
                if (!enabled) return;
                postDiagnosticsDump('periodic').catch(() => {});
            }, 30000);
        }

        if (detectionMethod === 'crepe') _ndLoadCrepe();
        return true;
    }

    // `disableOptions.silent: true` suppresses the end-of-song summary
    // modal. The playSong hook uses this when a new song loads so the
    // user doesn't see a summary pop every song switch; the original
    // pre-factory behaviour was to silently reset here. Parameter is
    // named distinctly from the factory's outer `opts` to avoid the
    // lexical shadow.
    // Snapshot stats + post to the server-side diagnostics endpoint.
    // Auto-collect path so the user doesn't paste console output —
    // dumps land in /tmp/nd_diagnostics/ on the slopsmith host. Only
    // the default singleton fires these; non-default instances would
    // step on each other's filenames.
    async function postDiagnosticsDump(reason) {
        if (!isDefault) return;
        const _hw = resolveHw();
        const songInfo = (_hw && _hw.getSongInfo && _hw.getSongInfo()) || {};
        const stats = api.getStats();
        // Serialize the full noteResults Map so the diagnostic dump
        // carries per-note timing/pitch detail — not just a count.
        // Without this I can't investigate detection regressions
        // without asking the user to ceremoniously click detect-off
        // to trigger the snapshotPlay path. The diagnostic dump fires
        // every 30s automatically, so the latest dump always has
        // enough data to sanity-check the matcher's behavior.
        const noteResultsArr = [];
        for (const v of noteResults.values()) noteResultsArr.push(v);

        const payload = {
            reason,
            timestamp: new Date().toISOString(),
            songId: songInfo.songId || songInfo.title || 'unknown',
            songTitle: songInfo.title,
            arrangement: songInfo.arrangement,
            tuning: songInfo.tuning,
            stats,
            // Drift + onset thresholds + note-result count give the
            // full picture of "what's the matcher doing right now."
            noteResultsCount: noteResults.size,
            // Full per-note judgments — what was expected, what was
            // detected, hit/miss, timing/pitch error, ignored flag.
            // Same shape S.2 persists, just under a different route
            // because the diagnostics dump fires periodically without
            // user action.
            noteResults: noteResultsArr,
            avOffsetMs: _hw && _hw.getAvOffset ? _hw.getAvOffset() : null,
            inputGain,
            latencyOffset,
            // Detection method: tells me whether the user is on YIN
            // (lightweight, default) vs HPS (bass-friendly,
            // suppressed-fundamental recovery) vs CREPE (heavy, ML).
            // Without this I can't tell if a low-detection report is
            // because of the wrong method choice.
            detectionMethod,
        };
        try {
            await fetch('/api/plugins/note_detect/diagnostics', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        } catch (e) {
            // Network failures are non-fatal — diagnostics is a
            // debug aid, not a critical path.
        }
    }

    // Unit S.2: snapshot the current session's noteResults to the
    // server so the modal/history/heatmap have something to read on
    // a future visit. Returns the new play_id (or null on no-op /
    // failure). Fire-and-forget at session boundaries; deliberately
    // independent of the modal trigger so silent disables (drill
    // teardown) still persist.
    async function snapshotPlay(reason) {
        if (!isDefault) return null;  // non-default instances would step on each other
        if (noteResults.size === 0) return null;
        const _hw = resolveHw();
        const songInfo = (_hw && _hw.getSongInfo && _hw.getSongInfo()) || {};
        const songId = _ndCurrentSongId(songInfo);
        if (!songId) return null;
        const arr = [];
        for (const v of noteResults.values()) arr.push(v);
        const scores = _ndScoresFromNotes(arr);
        const payload = {
            songId,
            playId: new Date().toISOString().replace(/[:.]/g, '-'),
            playedAt: new Date().toISOString(),
            reason,
            isDrill: !!drillActive,
            drillSectionName: drillFocus || null,
            startedAt: Date.now(),
            summary: {
                hits: scores.hits,
                misses: scores.misses,
                total: scores.total,
                detection: scores.detection,
                precision: scores.precision,
                pitchPct: scores.pitchPct,
                coverage: scores.coverage,
                timingMedianMs: scores.timingMedianMs,
                timingStdMs: scores.timingStdMs,
                combinedWeightedScore: scores.combined,
            },
            settings: {
                arrangement: songInfo.arrangement || null,
                tuning: songInfo.tuning || null,
                avOffsetMs: _hw && _hw.getAvOffset ? _hw.getAvOffset() : null,
            },
            noteResults: arr,
        };
        try {
            const r = await fetch('/api/plugins/note_detect/plays', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!r.ok) return null;
            const data = await r.json();
            const id = (data && data.id) || null;
            if (id != null) lastSnapshotPlayId = id;
            return id;
        } catch (e) {
            return null;
        }
    }

    function disable(disableOptions) {
        if (!enabled) return;
        enabled = false;
        // Unit 4b: persist any active recording before tear-down. The
        // dump.json sidecar uses noteResults as they stand at this
        // boundary — fire-and-forget so disable() returns immediately,
        // matching the snapshotPlay/diagnostics pattern.
        if (recording) recordAutoFinalize('disable').catch(() => {});
        // Unit S.2: snapshot the play before tear-down so the
        // session's noteResults persist. Fire-and-forget — disable
        // returns quickly to keep the UI responsive. The "Coaching
        // review" button on showSummary's overlay reads
        // lastSnapshotPlayId once this resolves; we don't auto-open
        // the modal because the legacy showSummary overlay is still
        // a useful at-a-glance view, and stacking two modals on
        // disable was confusing.
        snapshotPlay('disable').catch(() => {});
        // One last diagnostics dump on the way out so the final
        // session state lands on disk before we tear everything
        // down. Fire-and-forget; we don't await it because disable
        // needs to return quickly to keep the UI responsive.
        postDiagnosticsDump('disable').catch(() => {});
        // Invalidate any CREPE inference currently awaited in
        // processFrame — it captured the previous sessionGen and will
        // bail on mismatch rather than apply post-disable detections.
        sessionGen++;
        // End any active drill before tearing down audio so the saved
        // playback rate is restored on the still-live audio element.
        endDrill();
        stopAudio();
        stopHUD();
        if (missCheckInterval) { clearInterval(missCheckInterval); missCheckInterval = null; }
        if (gcInterval) { clearInterval(gcInterval); gcInterval = null; }
        if (diagnosticsInterval) { clearInterval(diagnosticsInterval); diagnosticsInterval = null; }
        for (const tid of flashTimeouts) clearTimeout(tid);
        flashTimeouts = [];

        if (!disableOptions || !disableOptions.silent) showSummary();

        const panel = instanceRoot.querySelector('.nd-settings-panel');
        if (panel) panel.remove();

        updateButton();
    }

    function destroy() {
        // Silent disable on teardown: calling plain disable() would
        // fire showSummary() (publishing `notedetect:session` and
        // building the summary overlay) for any instance with ≥5
        // judgments, but then we immediately remove `instanceRoot`
        // so the overlay flashes and vanishes. Unexpected for
        // callers like splitscreen that unmount a panel without
        // meaning to end-of-song the session.
        disable({ silent: true });
        // Remove draw hook (may not exist on older highway versions;
        // swallow the error rather than crash on teardown).
        try { if (hw && hw.removeDrawHook) hw.removeDrawHook(drawHookFn); } catch (e) {}
        if (detectBtn) { detectBtn.remove(); detectBtn = null; }
        if (gearBtn) { gearBtn.remove(); gearBtn = null; }
        if (restartBtn) { restartBtn.remove(); restartBtn = null; }
        if (skipBtn) { skipBtn.remove(); skipBtn = null; }
        if (instanceRoot.parentNode) instanceRoot.remove();
        _ndInstances.delete(api);
    }

    async function toggle() {
        if (enabled) disable();
        else await enable();
    }

    // ── Drill mode ────────────────────────────────────────────────────
    //
    // Drill loops a short cluster of trouble notes. Judgment is gated to
    // [judgeStart, judgeEnd) so the lead-in is audible warm-up without
    // scoring. Loop boundaries extend earlier than the judge window via
    // setActiveLoop so the user hears the song lead them in.
    //
    // Pre-existing bug fixed here: the pre-port code only called
    // window.setActiveLoop, which seeks audio.currentTime but does NOT
    // call audio.play(). When drilling started from the post-game review
    // modal (audio paused at song-end), the lead-in was silent until the
    // user manually pressed play. Now we explicitly resume playback so
    // the lead-in is always audible — that's what makes the runway
    // useful for hitting the first beat.
    function isInDrillJudgment(chartT) {
        if (!drillActive) return true;
        if (drillJudgeStart == null || drillJudgeEnd == null) return true;
        return chartT >= drillJudgeStart && chartT < drillJudgeEnd;
    }

    async function startDrillRange(startSec, endSec, label, drillOpts = {}) {
        const { speedMul = 1.0, focus = null, goal = null } = drillOpts;
        const audio = document.getElementById('audio');
        if (!audio) {
            console.warn('[note_detect] startDrillRange: no <audio id="audio"> element');
            return false;
        }
        const _hw = resolveHw();
        const songInfo = (_hw && _hw.getSongInfo && _hw.getSongInfo()) || {};
        const totalDuration = songInfo.duration
            || (Number.isFinite(audio.duration) ? audio.duration : null);
        if (!totalDuration) {
            console.warn('[note_detect] startDrillRange: no duration available');
            return false;
        }
        const requestedStart = Math.max(0, startSec);
        const end = Math.min(totalDuration - 0.05, endSec);
        if (end - requestedStart < 0.5) {
            console.warn(`[note_detect] startDrillRange: range too short (${(end - requestedStart).toFixed(2)}s)`);
            return false;
        }

        // First-note runway: ensure judgeStart sits at least
        // _ND_DRILL_FIRST_NOTE_RUNWAY_SEC before the cluster's first
        // chart note, so the player has reaction time on every loop
        // iteration even when the cluster boundary lands right on the
        // first scoreable note.
        const allNotes = (_hw && _hw.getNotes && _hw.getNotes()) || [];
        const firstNoteInCluster = allNotes.find(n => n.t >= requestedStart && n.t <= end);
        const start = firstNoteInCluster
            ? Math.min(requestedStart, firstNoteInCluster.t - _ND_DRILL_FIRST_NOTE_RUNWAY_SEC)
            : requestedStart;

        drillActive = true;
        // Window-level flag so slopsmith's loop-wrap handler can skip
        // its 4-beat count-in during drill iterations. Drill has its
        // own audible 5s lead-in; the count-in adds silent click-only
        // time on top (user-reported "10 seconds of silence between
        // iterations" at low BPMs). Bypassed in slopsmith app.js's
        // loop-trigger if this flag is set.
        window._ndAnyDrillActive = true;
        drillJudgeStart = start;
        drillJudgeEnd = end;
        drillLabel = label || `${start.toFixed(1)}-${end.toFixed(1)}s`;
        drillFocus = focus;
        drillGoal = goal;
        drillIterScores = [];
        drillBestScore = 0;
        drillGoalReached = false;
        // Reset chart-time tracking so the first detected restart is a
        // real one, not a residual jump from before the drill started.
        lastSeenChartTime = 0;
        lastLoopRestartPerf = 0;

        // Speed scaffolding: drilling slightly slower buys reaction time.
        drillSavedSpeed = audio.playbackRate;
        if (speedMul && speedMul !== drillSavedSpeed) {
            audio.playbackRate = speedMul;
        }
        drillSpeedMul = speedMul;

        // Audio loop = lead-in + judge window. setActiveLoop seeks audio
        // to loopStart but doesn't auto-play; we follow with audio.play()
        // so the lead-in is actually audible. Without the explicit play,
        // a drill kicked off from the post-game review modal (audio
        // paused) would land on a silent pre-roll.
        const loopStart = Math.max(0, start - _ND_DRILL_LEAD_IN_SEC);
        const loopEnd = end;
        if (typeof window.setActiveLoop === 'function') {
            window.setActiveLoop(loopStart, loopEnd);
        } else {
            console.warn('[note_detect] startDrillRange: window.setActiveLoop missing');
        }
        try { await audio.play(); } catch (e) {
            console.warn('[note_detect] startDrillRange: audio.play() rejected:', e);
        }

        if (!enabled) await enable();

        showDrillHud();
        // Fire-and-forget — network failures shouldn't block drill startup.
        autoSaveDrillLoop(loopStart, loopEnd).catch(() => {});

        console.log(`[note_detect] Drill "${drillLabel}" loop=${loopStart.toFixed(1)}–${loopEnd.toFixed(1)}s judge=${start.toFixed(1)}–${end.toFixed(1)}s @ ${speedMul}× (lead-in ${(start - loopStart).toFixed(1)}s)`);
        return true;
    }

    function endDrill() {
        if (!drillActive) return;
        const audio = document.getElementById('audio');
        if (audio && drillSavedSpeed != null
                && Number.isFinite(drillSavedSpeed)
                && audio.playbackRate !== drillSavedSpeed) {
            audio.playbackRate = drillSavedSpeed;
        }
        hideDrillHud();
        drillActive = false;
        // Clear the window-level flag so slopsmith's count-in resumes
        // for non-drill A-B loops the user sets manually.
        window._ndAnyDrillActive = false;
        drillJudgeStart = null;
        drillJudgeEnd = null;
        drillLabel = null;
        drillSavedSpeed = null;
        drillSpeedMul = 1.0;
        drillFocus = null;
        drillGoal = null;
        drillIterScores = [];
        drillBestScore = 0;
        drillGoalReached = false;
    }

    // Detect a loop wrap by watching chartTime for a backward jump >1s.
    // Slopsmith's audio engine doesn't emit a `loop:restart` event;
    // we infer it from the chart clock. Refractory window (1.5s)
    // suppresses audio-engine seek bouncing from firing duplicate
    // captures per real iteration. Called from the missCheck tick (10Hz).
    function detectLoopRestart() {
        const _hw = resolveHw();
        if (!_hw || !_hw.getTime) return;
        const chartT = _hw.getTime();
        const nowSec = performance.now() / 1000;
        const sinceLastRestart = nowSec - lastLoopRestartPerf;
        const jumpedBack = lastSeenChartTime > 0
            && chartT >= 0
            && chartT < lastSeenChartTime - _ND_LOOP_RESTART_MIN_BACKWARD_SEC;
        if (jumpedBack && sinceLastRestart > _ND_LOOP_RESTART_REFRACTORY_SEC) {
            lastLoopRestartPerf = nowSec;
            if (drillActive) drillCaptureIterationScore();
        }
        lastSeenChartTime = chartT;
    }

    // On each loop iteration end, push the just-finished iteration's
    // detection score into drillIterScores, update best-so-far, and
    // mark the goal reached if the player crossed the threshold.
    function drillCaptureIterationScore() {
        if (!drillActive) return;
        // Build a noteResults array snapshot for the pure scorer.
        const arr = [];
        for (const v of noteResults.values()) arr.push(v);
        const scores = _ndScoresFromNotes(arr);
        const score = scores.detection || 0;
        drillIterScores.push(score);
        if (score > drillBestScore) drillBestScore = score;
        if (drillGoal != null && score >= drillGoal && !drillGoalReached) {
            drillGoalReached = true;
        }
        updateDrillHud();
        // Unit 3h: surface a toast banner for this iteration so the
        // player sees impact without opening the modal. Pass the array
        // before clear() — the banner reads judgments to bucket them.
        _ndShowIterationBanner(arr);
        // Unit 4b: drill iteration end is a session boundary — finalize
        // the recording so the WAV captures one iteration and the next
        // starts fresh (if the user re-arms). Fire-and-forget; the dump
        // sidecar reads noteResults BEFORE the clear() below.
        if (recording) recordAutoFinalize('loop_restart').catch(() => {});
        // The iteration is over — clear noteResults so the next
        // iteration re-judges from scratch instead of carrying stale
        // hits forward.
        noteResults.clear();
    }

    // ── Drill HUD ─────────────────────────────────────────────────────
    // Floating overlay showing the drill's focus, goal, current
    // iteration score, and best-so-far. Lives on document.body so it's
    // visible regardless of which instance container the player has.
    function showDrillHud() {
        let hud = document.getElementById('nd-drill-hud');
        if (!hud) {
            hud = document.createElement('div');
            hud.id = 'nd-drill-hud';
            hud.className = 'fixed top-3 left-1/2 -translate-x-1/2 z-[210] bg-dark-800 border-2 border-blue-700 rounded-xl shadow-2xl px-4 py-2 text-sm';
            document.body.appendChild(hud);
        }
        updateDrillHud();
    }

    function updateDrillHud() {
        const hud = document.getElementById('nd-drill-hud');
        if (!hud) return;
        const goalPct = Math.round((drillGoal || 0) * 100);
        const lastScore = drillIterScores.length
            ? drillIterScores[drillIterScores.length - 1] : null;
        const lastPct = lastScore != null ? Math.round(lastScore * 100) : null;
        const bestPct = Math.round(drillBestScore * 100);
        const iter = drillIterScores.length;
        const focusLine = drillFocus
            ? `<div class="text-blue-200 text-xs mt-0.5">${drillFocus}</div>` : '';
        const speedTag = drillSpeedMul !== 1.0
            ? `<span class="text-yellow-300 text-[11px] ml-2">@ ${Math.round(drillSpeedMul * 100)}%</span>` : '';
        const goalLine = drillGoalReached
            ? `<div class="text-green-300 font-bold text-xs mt-1">🎯 Goal hit! ${bestPct}% (target ${goalPct}%)</div>`
            : (lastPct != null
                ? `<div class="text-gray-300 text-xs mt-1">
                     Iter ${iter}: <span class="font-bold" style="color:${_ndScoreColor(lastScore)}">${lastPct}%</span>
                     · best ${bestPct}%${drillGoal != null ? ` · goal <span class="text-blue-300">${goalPct}%</span>` : ''}
                   </div>`
                : `<div class="text-gray-500 text-xs mt-1">Play through the loop — score updates each iteration</div>`);
        hud.innerHTML = `
            <div class="flex items-center justify-between gap-3">
                <div>
                    <div class="text-blue-300 text-[10px] uppercase tracking-wide font-semibold">
                        🎯 Drilling${speedTag}
                    </div>
                    ${focusLine}
                    ${goalLine}
                </div>
                <button id="nd-drill-end" class="text-gray-500 hover:text-gray-200 text-xl leading-none px-2"
                        title="End drill">×</button>
            </div>
        `;
        const endBtn = hud.querySelector('#nd-drill-end');
        if (endBtn) endBtn.onclick = () => {
            // End drill = clear loop. Slopsmith's clear-loop handler
            // nulls loopA/loopB; we then call endDrill to tear down the
            // HUD and restore playbackRate.
            const clearBtn = document.getElementById('btn-loop-clear');
            if (clearBtn) clearBtn.click();
            endDrill();
        };
    }

    function hideDrillHud() {
        const hud = document.getElementById('nd-drill-hud');
        if (hud) hud.remove();
    }

    // Save the drill's loop range to slopsmith's saved-loops list so
    // the user can return to the same trouble spot via the dropdown.
    // Dedupes within 0.5s on both endpoints — re-drilling the same
    // cluster won't pile copies. Fire-and-forget; failures don't
    // block drill startup.
    async function autoSaveDrillLoop(loopStart, loopEnd) {
        const filename = window.currentFilename;
        if (!filename) return;
        const decoded = decodeURIComponent(filename);
        let existing = [];
        try {
            const r = await fetch(`/api/loops?filename=${encodeURIComponent(decoded)}`);
            if (r.ok) existing = await r.json();
        } catch {
            // Continue without dedup — better to risk a duplicate than
            // skip the save entirely on a transient network error.
        }
        if (_ndIsDuplicateLoop(loopStart, loopEnd, existing)) return;
        const name = `Drill: ${_ndFmtMmSs(loopStart)}–${_ndFmtMmSs(loopEnd)}`;
        try {
            await fetch('/api/loops', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: decoded, name, start: loopStart, end: loopEnd }),
            });
            if (typeof window.loadSavedLoops === 'function') {
                try { await window.loadSavedLoops(); } catch {}
            }
        } catch {
            // Network failure is non-fatal — the user can still drill,
            // just won't see the loop in the saved-list dropdown.
        }
    }

    function showSummary() {
        const total = hits + misses;
        if (total < 5) return;

        const existing = instanceRoot.querySelector('.nd-summary-overlay');
        if (existing) existing.remove();

        const accuracy = Math.round((hits / total) * 100);

        let sectionHtml = '';
        if (sectionStats.length > 0) {
            sectionHtml = '<div class="mt-3 text-xs"><div class="text-gray-400 mb-1">Per Section:</div>';
            for (const sec of sectionStats) {
                const secTotal = sec.hits + sec.misses;
                const secAcc = secTotal > 0 ? Math.round((sec.hits / secTotal) * 100) : 0;
                const barColor = secAcc >= 90 ? 'bg-green-500' : secAcc >= 70 ? 'bg-yellow-500' : 'bg-red-500';
                sectionHtml += `
                    <div class="flex items-center gap-2 mb-1">
                        <span class="w-24 truncate text-gray-300">${sec.name}</span>
                        <div class="flex-1 h-2 bg-dark-600 rounded overflow-hidden">
                            <div class="${barColor} h-full rounded" style="width:${secAcc}%"></div>
                        </div>
                        <span class="w-10 text-right text-gray-400">${secAcc}%</span>
                    </div>
                `;
            }
            sectionHtml += '</div>';
        }

        const overlay = document.createElement('div');
        overlay.className = 'nd-summary-overlay fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm';
        overlay.style.pointerEvents = 'auto';
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
        overlay.innerHTML = `
            <div class="bg-dark-700 border border-gray-600 rounded-2xl p-6 w-80 shadow-2xl">
                <div class="text-center mb-4">
                    <div class="text-3xl font-bold ${accuracy >= 90 ? 'text-green-400' : accuracy >= 70 ? 'text-yellow-400' : 'text-red-400'}">${accuracy}%</div>
                    <div class="text-gray-400 text-sm">Accuracy</div>
                </div>
                <div class="grid grid-cols-3 gap-3 text-center text-sm mb-3">
                    <div>
                        <div class="text-green-400 font-bold">${hits}</div>
                        <div class="text-gray-500 text-xs">Hits</div>
                    </div>
                    <div>
                        <div class="text-red-400 font-bold">${misses}</div>
                        <div class="text-gray-500 text-xs">Misses</div>
                    </div>
                    <div>
                        <div class="text-blue-400 font-bold">${bestStreak}</div>
                        <div class="text-gray-500 text-xs">Best Streak</div>
                    </div>
                </div>
                ${sectionHtml}
                <button class="nd-summary-coach mt-4 w-full py-2 bg-blue-700 hover:bg-blue-600 rounded-lg text-sm text-white transition disabled:opacity-50 disabled:cursor-wait" disabled>
                    Loading coaching review...
                </button>
                <button class="nd-summary-close mt-2 w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-sm text-gray-300 transition">
                    Close
                </button>
            </div>
        `;
        overlay.querySelector('.nd-summary-close').onclick = () => overlay.remove();
        instanceRoot.appendChild(overlay);

        // Wire the coaching-review button. snapshotPlay was kicked
        // off in disable(); we poll lastSnapshotPlayId so the button
        // enables as soon as the POST resolves. If snapshotPlay
        // returned null (no songId) the button stays disabled with
        // an explanatory label rather than crashing on click.
        const coachBtn = overlay.querySelector('.nd-summary-coach');
        if (coachBtn) {
            const enableBtn = (playId) => {
                coachBtn.disabled = false;
                coachBtn.textContent = 'Coaching review →';
                coachBtn.onclick = () => {
                    overlay.remove();
                    if (typeof _ndShowCoachingReview === 'function') {
                        _ndShowCoachingReview({ playId, source: 'summary' })
                            .catch(() => {});
                    }
                };
            };
            const disableBtn = (label) => {
                coachBtn.disabled = true;
                coachBtn.textContent = label;
            };
            if (lastSnapshotPlayId != null) {
                enableBtn(lastSnapshotPlayId);
            } else {
                // Poll for the in-flight snapshotPlay POST. Caps at 5s
                // — beyond that, the POST has likely failed (server
                // down, no songId derivable) and the button stays in
                // its "unavailable" state.
                let waited = 0;
                const tick = setInterval(() => {
                    if (lastSnapshotPlayId != null) {
                        clearInterval(tick);
                        enableBtn(lastSnapshotPlayId);
                    } else if ((waited += 200) >= 5000) {
                        clearInterval(tick);
                        disableBtn('Coaching review unavailable');
                    }
                }, 200);
            }
        }

        publishToJournal(accuracy);
    }

    function publishToJournal(accuracy) {
        // Use resolveHw() so showSummary() can be called on an
        // instance whose highway wasn't available at construction
        // but has since been defined. `hw` is a `let`, so a direct
        // deref would throw in the pre-resolution case.
        const currentHw = resolveHw();
        const info = currentHw && currentHw.getSongInfo ? currentHw.getSongInfo() : null;
        if (!info) return;
        dispatchInstanceEvent('notedetect:session', {
            title: info.title,
            artist: info.artist,
            arrangement: info.arrangement,
            accuracy,
            hits,
            misses,
            bestStreak,
            sections: sectionStats.map(s => ({
                name: s.name,
                accuracy: (s.hits + s.misses) > 0 ? Math.round(s.hits / (s.hits + s.misses) * 100) : 0,
            })),
            timestamp: new Date().toISOString(),
        });
    }

    // ── Public API ────────────────────────────────────────────────────
    // ── Test-injection: replay a WAV through the detection pipeline ──
    //
    // Bypasses getUserMedia (which doesn't work cleanly in headless
    // browsers / fixture replay). Builds the same audio graph as
    // enable() — gain → analyser → processor — but drives it with an
    // AudioBufferSource decoded from the WAV instead of a MediaStream.
    // Mocks hw.getTime() so the matcher's chart clock advances in
    // lockstep with WAV playback, then sweeps checkMisses post-playback
    // to finalize miss markers for chart notes the player didn't
    // produce. Returns a summary derived from _ndScoresFromNotes so
    // the same scoring math the live HUD uses is what the harness
    // reports.
    //
    // Designed for `test/replay-baseline.js` (Unit H2) but exposed
    // on the public API so any consumer can drive a fixture through
    // the matcher offline.
    //
    // Caveats:
    // - The instance must NOT already be enabled (live mic + WAV
    //   would race on the same audio graph). Caller should call this
    //   on a fresh detector or after disable().
    // - `chartStartTimeSec` is the chart time corresponding to WAV
    //   t=0; required because the user's recorded WAVs aren't
    //   necessarily anchored to chart-time 0.
    // - The function is async and resolves only after playback +
    //   pipeline drain + miss sweep complete, so callers can await
    //   the summary directly.
    async function testInjectWav(wavUrl, opts = {}) {
        if (enabled) {
            throw new Error('testInjectWav: instance already enabled; call disable() first');
        }
        // Reset all matcher state so per-fixture replays start clean.
        // Without this, noteResults from the previous fixture persist
        // into the next (because we exit with enabled=false, and the
        // outer disable() the harness calls early-returns on
        // !enabled). The 5th gasoline fixture in the original sweep
        // showed total=156 on a 6-note fixture — 150 leftover entries
        // from fixture 4. resetScoring clears noteResults, drift,
        // onset, and stability state in one call.
        resetScoring();
        const chartStartTimeSec = Number.isFinite(opts.chartStartTimeSec)
            ? opts.chartStartTimeSec
            : 0;
        // Optional override: caller-supplied chart notes that the matcher
        // should match against. Used by the replay-baseline harness when
        // the host slopsmith hasn't loaded a real song — the dump.json
        // sidecars carry the chart notes from the original recording.
        // Each entry: { s, f, t } (string, fret, time).
        const chartNotesOverride = Array.isArray(opts.chartNotes)
            ? opts.chartNotes
            : null;
        // Arrangement override — necessary because _ndMidiFromStringFret
        // uses currentArrangement/currentStringCount/tuningOffsets to
        // compute expectedMidi from (s, f). Without this set correctly
        // a bass-recording fixture replayed with the default 'guitar'
        // arrangement produces ~1 semitone-per-string offset on
        // expectedMidi, which then cascades into 200¢-pitch-error hits.
        if (typeof opts.arrangement === 'string') {
            currentArrangement = opts.arrangement;
        }
        if (Number.isFinite(opts.stringCount)) {
            currentStringCount = opts.stringCount;
            // Resize tuningOffsets to match — same invariant the
            // live arrangement-set path maintains.
            if (tuningOffsets.length !== opts.stringCount) {
                tuningOffsets = new Array(opts.stringCount).fill(0);
            }
        }
        if (Array.isArray(opts.tuning)) {
            tuningOffsets = opts.tuning.slice();
            currentStringCount = opts.tuning.length;
        }
        if (Number.isFinite(opts.capo)) {
            capo = opts.capo;
        }
        // Detector method override. The harness defaults to HPS for
        // bass fixtures (override via opts.method). YIN's octave-down
        // bias on bass produced the 199¢ "hits" the harness surfaced;
        // HPS scores harmonic stacks rather than picking a single
        // fundamental, which fixes the bass-octave-down case.
        if (typeof opts.method === 'string'
            && ['yin', 'hps', 'crepe'].includes(opts.method)) {
            detectionMethod = opts.method;
        }

        // Build audio graph manually — bypasses startAudio's
        // getUserMedia path. Reuses module-scoped audio constants.
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') await audioCtx.resume();

        const processor = audioCtx.createScriptProcessor(_ND_FRAME_SIZE, 1, 1);
        worklet = processor;
        accumBuffer = new Float32Array(0);
        pendingBuffer = null;
        // Reset onset state so each fixture replay starts clean
        // (same isolation that resetScoring provides on disable()).
        inNote = false;
        lastOnsetPerfSec = 0;
        reattackArmed = false;
        reattackRmsBuf = [];
        onsetCount = 0;
        recentRmsPeak = 0;
        driftBuffer = [];
        driftEstimateMs = 0;

        gainNode = audioCtx.createGain();
        gainNode.gain.value = 1.0;

        levelAnalyser = audioCtx.createAnalyser();
        levelAnalyser.fftSize = 512;
        levelAnalyser.smoothingTimeConstant = 0.8;
        gainNode.connect(levelAnalyser);

        // Same onset-aware audio chunk path as the live processor.
        // Inlined here so the live and test paths can't drift.
        processor.onaudioprocess = (e) => {
            const input = e.inputBuffer.getChannelData(0);
            let sumSq = 0;
            for (let j = 0; j < input.length; j++) sumSq += input[j] * input[j];
            const rms = Math.sqrt(sumSq / input.length);
            if (rms > recentRmsPeak) recentRmsPeak = rms;
            else recentRmsPeak *= 0.998;

            reattackRmsBuf.push(rms);
            if (reattackRmsBuf.length > _ND_REATTACK_WINDOW) reattackRmsBuf.shift();

            const nowSec = performance.now() / 1000;
            const refractoryOk = (nowSec - lastOnsetPerfSec) > _ND_REATTACK_REFRACTORY_SEC;

            if (rms < _ND_REATTACK_REARM_LEVEL) reattackArmed = true;

            let fireOnset = false;
            if (rms > _ND_ONSET_LEVEL && !inNote && refractoryOk) {
                inNote = true;
                fireOnset = true;
            } else if (inNote && refractoryOk && reattackArmed
                       && rms > _ND_REATTACK_MIN_LEVEL
                       && reattackRmsBuf.length >= 3) {
                const recentMin = Math.min(...reattackRmsBuf.slice(0, -1));
                if (rms > recentMin * _ND_REATTACK_RATIO) fireOnset = true;
            } else if (rms < _ND_ONSET_EXIT_LEVEL) {
                inNote = false;
            }

            if (fireOnset) {
                lastOnsetPerfSec = nowSec;
                reattackArmed = false;
                onsetCount++;
                if (hw && hw.getTime) {
                    pendingOnsetChartT = hw.getTime() - _ND_ONSET_BUFFER_COMP_SEC;
                }
                rawMidiHistory = [];
                stableMidi = -1;
                accumBuffer = new Float32Array(0);
                pendingBuffer = null;
                return;
            }

            const prev = accumBuffer;
            const combined = new Float32Array(prev.length + input.length);
            combined.set(prev);
            combined.set(input, prev.length);
            if (combined.length >= _ND_MIN_YIN_SAMPLES) {
                const start = combined.length - _ND_MIN_YIN_SAMPLES;
                pendingBuffer = combined.slice(start, start + _ND_MIN_YIN_SAMPLES);
                accumBuffer = new Float32Array(0);
            } else {
                accumBuffer = combined;
            }
        };

        gainNode.connect(processor);
        processor.connect(audioCtx.destination);

        // Detection runs on a 50ms timer — same as live path. Match
        // that interval here so post-flush latency behaves identically.
        let processingFrame = false;
        const detectTimer = setInterval(() => {
            if (processingFrame || !pendingBuffer) return;
            const buf = pendingBuffer;
            pendingBuffer = null;
            processingFrame = true;
            processFrame(buf).finally(() => { processingFrame = false; });
        }, 50);

        missCheckInterval = setInterval(checkMisses, 100);

        // Mock hw.getTime so the matcher sees chart time advance in
        // lockstep with WAV playback. AudioContext.currentTime is the
        // master clock — incrementing relative to wavStartCtxT.
        // Also optionally mock hw.getNotes / hw.getChords if the
        // caller passed a chartNotesOverride (replay harness path).
        // Also override hw.getAvOffset to 0 — the live slopsmith may
        // have a per-user calibration offset stored, but for fixture
        // replay we want raw chart-time alignment so the harness's
        // reported timingError reflects only what's in the recording,
        // not the host's calibration.
        let _hw = resolveHw();
        // If no highway is available at all (headless harness with
        // slopsmith stubbed), build a minimal stub object the
        // matcher can read. createNoteDetector resolves window.highway
        // lazily; if it's null we install a stub on window.
        if (!_hw && chartNotesOverride) {
            window.highway = {
                _stub: true,
                getNotes: () => chartNotesOverride,
                getChords: () => [],
                getSections: () => [],
                getSongInfo: () => ({}),
                getTime: () => 0,
                getAvOffset: () => 0,
                setLefty: () => {},
                getLefty: () => false,
            };
            _hw = window.highway;
            hw = _hw;  // bind closure-local ref so subsequent calls use the stub
        }
        const realGetTime = _hw && _hw.getTime ? _hw.getTime.bind(_hw) : null;
        const realGetNotes = _hw && _hw.getNotes ? _hw.getNotes.bind(_hw) : null;
        const realGetChords = _hw && _hw.getChords ? _hw.getChords.bind(_hw) : null;
        const realGetAvOffset = _hw && _hw.getAvOffset ? _hw.getAvOffset.bind(_hw) : null;
        const wavStartCtxT = audioCtx.currentTime + 0.05;  // small lookahead

        if (_hw && realGetTime) {
            _hw.getTime = () => {
                const elapsed = audioCtx.currentTime - wavStartCtxT;
                return chartStartTimeSec + Math.max(0, elapsed);
            };
        }
        if (_hw && chartNotesOverride) {
            _hw.getNotes = () => chartNotesOverride;
            _hw.getChords = () => [];
        }
        // Force avOffset to 0 during replay. The live slopsmith
        // may have the user's per-machine calibration set, which
        // would shift recorded timingError by that amount and make
        // harness numbers non-portable. Replay timing is "raw player
        // vs raw chart"; calibration belongs to live play.
        if (_hw) _hw.getAvOffset = () => 0;

        enabled = true;
        sessionGen++;

        // Decode the WAV and start playback on the audio clock.
        const response = await fetch(wavUrl);
        if (!response.ok) {
            throw new Error(`testInjectWav: HTTP ${response.status} fetching ${wavUrl}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(gainNode);
        source.start(wavStartCtxT);

        const dur = audioBuffer.duration;

        // Wait playback + drain + miss-sweep tail.
        await new Promise(r => setTimeout(r, (0.05 + dur + 1.5) * 1000));

        // Sweep checkMisses across every chart note in the WAV's
        // window. checkMisses is designed for per-frame use and only
        // scans ~1s behind the deadline per call; manual time
        // advancement covers the whole playback span.
        if (_hw) {
            const notes = (_hw.getNotes && _hw.getNotes()) || [];
            const inWavWindow = notes.filter(n =>
                typeof n.t === 'number'
                && n.t >= chartStartTimeSec
                && n.t <= chartStartTimeSec + dur + 1
            );
            if (inWavWindow.length > 0) {
                const lastNoteT = inWavWindow[inWavWindow.length - 1].t;
                for (let sweepT = chartStartTimeSec;
                     sweepT <= lastNoteT + 2;
                     sweepT += 0.5) {
                    _hw.getTime = () => sweepT;
                    checkMisses();
                }
            }
        }

        // Restore real getTime / getNotes / getChords / getAvOffset
        // so subsequent live use isn't broken.
        if (_hw && realGetTime) _hw.getTime = realGetTime;
        if (_hw && realGetNotes) _hw.getNotes = realGetNotes;
        if (_hw && realGetChords) _hw.getChords = realGetChords;
        if (_hw && realGetAvOffset) _hw.getAvOffset = realGetAvOffset;

        // Build summary using the SAME _ndScoresFromNotes the live HUD
        // and modal use, so the harness number can never drift from
        // production scoring.
        const noteList = [];
        for (const v of noteResults.values()) noteList.push(v);
        const scores = _ndScoresFromNotes(noteList);

        // Tear down the test-mode audio graph.
        clearInterval(detectTimer);
        if (missCheckInterval) { clearInterval(missCheckInterval); missCheckInterval = null; }
        try { source.disconnect(); } catch (e) {}
        try { processor.disconnect(); } catch (e) {}
        try { gainNode.disconnect(); } catch (e) {}
        try { levelAnalyser.disconnect(); } catch (e) {}
        worklet = null;
        gainNode = null;
        levelAnalyser = null;
        enabled = false;

        return {
            summary: {
                hits: scores.hits,
                misses: scores.misses,
                total: scores.total,
                detection: scores.detection,
                precision: scores.precision,
                onsetCount,
                driftEstimateMs,
                driftSamples: driftBuffer.length,
                durationSec: dur,
            },
            noteResults: noteList.map(v => ({ ...v })),
        };
    }

    // ── Recording control (Unit 4a) ─────────────────────────────────
    function recordStart(maxSeconds = 60, filename) {
        recordChunks = [];
        recordTotalSamples = 0;
        recordSampleRate = audioCtx ? audioCtx.sampleRate : 48000;
        recordMaxSamples = Math.floor(maxSeconds * recordSampleRate);
        recordAnchored = false;
        recordChartStartTime = 0;
        const _hwArm = resolveHw();
        recordArmedChartTime = _hwArm && _hwArm.getTime ? _hwArm.getTime() : 0;
        recordFilename = filename || 'auto-recording.wav';
        recording = true;
        console.log(`[note_detect] Recording armed (max ${maxSeconds}s at ${recordSampleRate}Hz, chart ${recordArmedChartTime.toFixed(3)}s — waiting for playback to advance)`);
    }

    // Anchors immediately; for diagnostic captures (open strings, scales)
    // where no song is playing and the chart-advance gate would never trip.
    function recordStartRaw(maxSeconds = 30, filename) {
        recordChunks = [];
        recordTotalSamples = 0;
        recordSampleRate = audioCtx ? audioCtx.sampleRate : 48000;
        recordMaxSamples = Math.floor(maxSeconds * recordSampleRate);
        recordChartStartTime = 0;
        recordArmedChartTime = 0;
        recordAnchored = true;
        recordFilename = filename || 'raw-recording.wav';
        recording = true;
        if (!enabled) {
            console.warn('[note_detect] enabled is false — click Detect first or nothing will record.');
        }
        console.log(`[note_detect] Raw recording armed (max ${maxSeconds}s at ${recordSampleRate}Hz, no chart gate, file=${recordFilename})`);
    }

    function recordStatus() {
        return {
            active: recording,
            anchored: recordAnchored,
            armedChartTime: recordArmedChartTime,
            anchorChartTime: recordChartStartTime,
            capturedSec: recordTotalSamples / (recordSampleRate || 48000),
            maxSec: recordMaxSamples / (recordSampleRate || 48000),
            filename: recordFilename,
        };
    }

    function recordFlushPcm() {
        recording = false;
        if (recordChunks.length === 0) {
            console.log('[note_detect] No audio recorded');
            return null;
        }
        const totalLen = recordChunks.reduce((s, c) => s + c.length, 0);
        const pcm = new Float32Array(totalLen);
        let offset = 0;
        for (const chunk of recordChunks) {
            pcm.set(chunk, offset);
            offset += chunk.length;
        }
        console.log(`[note_detect] Recording stopped: ${(totalLen / recordSampleRate).toFixed(1)}s, ${totalLen} samples`);
        recordChunks = [];
        return pcm;
    }

    async function persistRecording(pcm, filename, opts = {}) {
        const blob = _ndRecordToWavBlob(pcm, recordSampleRate);
        const formData = new FormData();
        formData.append('file', blob, filename);
        if (opts.dump) formData.append('dump', JSON.stringify(opts.dump));
        const params = new URLSearchParams({
            chartStartTime: recordChartStartTime.toFixed(3),
            sampleRate: String(recordSampleRate),
        });
        if (opts.songId) params.set('songId', opts.songId);
        if (opts.playId) params.set('playId', String(opts.playId));
        if (opts.reason) params.set('reason', opts.reason);
        try {
            const resp = await fetch(`/api/plugins/note_detect/recording?${params.toString()}`, {
                method: 'POST',
                body: formData,
            });
            const result = await resp.json();
            console.log(`[note_detect] Recording saved to server: ${result.path} (${(blob.size / 1024).toFixed(0)} KB, chart start ${recordChartStartTime.toFixed(3)}s)`);
            return result;
        } catch (e) {
            console.warn('[note_detect] Server save failed, downloading locally:', e);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename; a.click();
            URL.revokeObjectURL(url);
            return null;
        }
    }

    // Build a replay-baseline-compatible dump.json payload. Flattens the
    // factory's nested chartNote into top-level s/f/chartT so test/
    // replay-baseline.js can consume the sidecar without changes.
    function buildRecordingDumpPayload(reason) {
        const _hw = resolveHw();
        const songInfo = (_hw && _hw.getSongInfo && _hw.getSongInfo()) || {};
        const noteResultsFlat = [];
        for (const [key, v] of noteResults.entries()) {
            const cn = v.chartNote || v.note || {};
            const chartT = typeof cn.t === 'number'
                ? cn.t
                : (typeof v.noteTime === 'number' ? v.noteTime : null);
            noteResultsFlat.push({
                ...v,
                key,
                s: typeof cn.s === 'number' ? cn.s : null,
                f: typeof cn.f === 'number' ? cn.f : null,
                chartT,
            });
        }
        const scores = _ndScoresFromNotes(noteResultsFlat);
        return {
            timestamp: new Date().toISOString(),
            reason,
            autoDump: true,
            noteResults: noteResultsFlat,
            settings: {
                arrangement: songInfo.arrangement || currentArrangement,
                tuning: Array.isArray(songInfo.tuning) ? songInfo.tuning : tuningOffsets,
                capo: typeof songInfo.capo === 'number' ? songInfo.capo : capo,
                avOffsetMs: _hw && _hw.getAvOffset ? _hw.getAvOffset() : null,
                timingTolerance,
                pitchTolerance,
            },
            scoring: {
                hits: scores.hits,
                misses: scores.misses,
                total: scores.total,
                detection: scores.detection,
                precision: scores.precision,
            },
        };
    }

    // Unit 4d — UI-driven aligned start. Derives a songSlug-timestamp
    // filename, arms recording, and kicks playback so the user gets a
    // single click instead of "arm then click play". The chart-advance
    // gate inside the SP callback handles the timing race — anchor
    // doesn't fire until the chart actually advances past the armed
    // value (~one SP buffer / 42ms after audio.play() resolves).
    async function recordSessionStart(seconds) {
        if (recording) return null;
        const _hw = resolveHw();
        const songInfo = (_hw && _hw.getSongInfo && _hw.getSongInfo()) || {};
        const songId = _ndCurrentSongId(songInfo);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const slug = (songId || 'take').replace(/[^A-Za-z0-9_-]+/g, '_').toLowerCase();
        const filename = `${slug}-${stamp}.wav`;
        recordStart(seconds, filename);
        const audio = document.getElementById('audio');
        if (audio && audio.paused) {
            try { await audio.play(); }
            catch (e) { /* autoplay refusal — user can press play manually */ }
        }
        return filename;
    }

    // Auto-finalize the active recording at a session boundary
    // (disable, drill iteration end, restart). Builds a dump.json
    // sidecar from the current judgments BEFORE clearing/flushing so
    // the WAV is paired with the noteResults that were captured during
    // its lifetime. No-op when recording isn't active.
    async function recordAutoFinalize(reason) {
        if (!recording || recordChunks.length === 0) return null;
        const dump = buildRecordingDumpPayload(reason);
        const _hw = resolveHw();
        const songInfo = (_hw && _hw.getSongInfo && _hw.getSongInfo()) || {};
        const songId = _ndCurrentSongId(songInfo);
        // If the user didn't pick a filename, derive one from songId +
        // timestamp so each session boundary writes a distinct file.
        if (!recordFilename || recordFilename === 'auto-recording.wav') {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const slug = (songId || 'take').replace(/[^A-Za-z0-9_-]+/g, '_').toLowerCase();
            recordFilename = `${slug}-${stamp}.wav`;
        }
        const filename = recordFilename;
        const pcm = recordFlushPcm();
        if (!pcm) return null;
        return persistRecording(pcm, filename, { dump, songId, reason });
    }

    // User-facing stop. Always saves to the filename set at arming time
    // — avoids the footgun of "stop returned PCM but didn't persist".
    function recordStop() {
        const pcm = recordFlushPcm();
        if (!pcm) return null;
        persistRecording(pcm, recordFilename || 'recording.wav');
        return pcm;
    }

    // Internal — used by the SP-callback auto-stop on max-samples.
    async function recordSave(filename) {
        const pcm = recordFlushPcm();
        if (!pcm) return;
        await persistRecording(pcm, filename || recordFilename || 'recording.wav');
    }

    const api = {
        enable,
        disable,
        destroy,
        isEnabled: () => enabled,
        getStats: () => ({
            hits, misses, streak, bestStreak,
            accuracy: (hits + misses) > 0 ? Math.round(hits / (hits + misses) * 100) : 0,
            sectionStats: sectionStats.map(s => ({ name: s.name, hits: s.hits, misses: s.misses })),
            driftEstimateMs,
            driftSamples: driftBuffer.length,
            onsetCount,
            inNote,
            recentRmsPeak: Number(recentRmsPeak.toFixed(4)),
            onsetThreshold: _ND_ONSET_LEVEL,
        }),
        setChannel,
        injectButton,
        showSummary,
        // Drill mode — start a tight loop on a cluster range, with the
        // lead-in audible (audio.play() is called explicitly) and
        // judgment gated to [start, end).
        startDrillRange,
        endDrill,
        isDrilling: () => drillActive,
        // Test-injection — replay a WAV through the detection
        // pipeline. Used by test/replay-baseline.js (Unit H2) to run
        // the user's recorded fixtures offline.
        testInjectWav,
        // Unit 4a — raw audio recording. recordStart gates anchor on
        // chart-advance (song mode); recordStartRaw anchors immediately
        // (diagnostic captures). recordStop persists via POST with
        // local-download fallback. recordStatus snapshots state for UI.
        recordStart,
        recordStartRaw,
        recordStop,
        recordStatus,
        // Unit S.2 — manual snapshot trigger. Useful for callers that
        // want to persist the current session at a point other than
        // disable() (e.g. mid-song save). Returns the new play_id or null.
        snapshotPlay,
        getLastSnapshotPlayId: () => lastSnapshotPlayId,
        // Unit UX-restart — exposed so keyboard shortcuts or other
        // plugins can trigger restart programmatically.
        restartSong,
        // Unit UX-skip-intro — same rationale; programmatic skip-to-
        // first-note for callers that bypass the button.
        skipToFirstNote,
        // Internal — clear hits / misses / streak / noteResults /
        // sectionStats / detection state back to zeros. Used by the
        // playSong hook so both ENABLED and DISABLED instances drop
        // stale stats on a song switch — matches the pre-factory
        // behaviour where the module-level `_ndResetScoring()` ran on
        // every playSong regardless of whether detection was on.
        // Safe to call at any time (doesn't touch audio/UI/timers,
        // just data). Prefixed with `_` to mark it as non-public.
        _resetScoring: resetScoring,
        // Internal — updateButton is called by _ndLoadCrepe() when the
        // shared model finishes loading to refresh every instance's
        // button text. Prefixed with `_` to mark it as non-public.
        _updateButton: updateButton,
    };

    // Register the draw hook once per instance. The hook early-returns
    // on !enabled so disabled instances cost essentially nothing.
    // If highway isn't ready at construction time, ensureDrawHook()
    // (called from enable()) re-tries after resolving `hw` lazily.
    ensureDrawHook();

    _ndInstances.add(api);
    return api;
}

// ── playSong wrapper (idempotent) ──────────────────────────────────────────
// On a new song, disable every live instance so scoring doesn't carry over,
// then let the original playSong load the chart, then re-inject the default
// singleton's button.
//
// The idempotency guard lives on the wrapper function itself
// (`wrapper._ndWrapped = true`) rather than on a module-level flag.
// Module scope resets on every evaluation, so HMR or a double
// <script> load would see a false module flag, wrap the already-
// wrapped `window.playSong`, and produce a nested wrapper that
// disables instances twice per song switch. Marking the function
// itself persists across re-evaluations because `window.playSong`
// keeps the reference.
const _ND_PLAY_SONG_MAX_RETRIES = 20;
function _ndInstallPlaySongHook() {
    const origPlaySong = window.playSong;
    if (typeof origPlaySong !== 'function') {
        // playSong may not exist yet. Common on HMR or unusual load
        // orders where the plugin runs before slopsmith's app.js
        // defines it. Retry a bounded number of times on the next
        // task — cap prevents an infinite loop in host environments
        // that never define playSong (e.g. the node:test vm harness).
        // Retry counter lives on `_ndShared` so a second evaluation
        // doesn't get a fresh 20-attempt budget on top of the first.
        if (_ndShared.playSongRetries++ < _ND_PLAY_SONG_MAX_RETRIES) {
            setTimeout(_ndInstallPlaySongHook, 50);
        }
        return;
    }
    // If this file was evaluated before, `window.playSong` already
    // points at our wrapper. Bail rather than wrap it again.
    if (origPlaySong._ndWrapped) return;
    const wrapper = async function (...args) {
        // For each live instance: silent-disable if currently enabled
        // (stop audio + timers without popping a summary modal), then
        // reset scoring unconditionally. Enabled-only disable misses
        // the case of a DISABLED instance that still holds stale
        // stats from the previous song — getStats() / showSummary()
        // on that instance would report yesterday's numbers until
        // the user clicked Detect again. Pre-factory code had a
        // single module-level `_ndResetScoring()` that always ran
        // here; the explicit `resetScoring()` on every instance
        // preserves that behaviour.
        for (const inst of _ndInstances) {
            if (inst.isEnabled()) inst.disable({ silent: true });
            if (typeof inst._resetScoring === 'function') inst._resetScoring();
        }
        const ret = await origPlaySong.apply(this, args);
        // Re-inject the default singleton's Detect button in case the
        // loader recreated the player-controls row. Tuning/capo/
        // arrangement are re-read later inside enable() from
        // hw.getSongInfo(); no need to refresh them eagerly here.
        if (window.noteDetect) {
            window.noteDetect.injectButton();
        }
        return ret;
    };
    wrapper._ndWrapped = true;
    window.playSong = wrapper;
}

// ── Singleton + bootstrap ──────────────────────────────────────────────────
// Reuse an existing default instance if the file has been evaluated
// before (HMR, accidental double <script> load). Without this, each
// evaluation would call `createNoteDetector({isDefault:true})` afresh
// — and since `_ndShared.instances` is anchored on window, the old
// default would still be in the registry, producing duplicate Detect
// buttons and per-instance DOM on every reload. Pair this with the
// playSong-wrapper idempotency guard already in place; both together
// keep double-load end-to-end idempotent.
const _ndExistingDefault = (window.noteDetect && typeof window.noteDetect.injectButton === 'function')
    ? window.noteDetect
    : null;
const _ndDefaultInstance = _ndExistingDefault || createNoteDetector({ isDefault: true });
window.noteDetect = _ndDefaultInstance;
window.createNoteDetector = createNoteDetector;

_ndInstallPlaySongHook();
// Only inject on first evaluation — re-injecting on a subsequent load
// would duplicate the button, since the old one is still in the DOM.
if (!_ndExistingDefault) _ndDefaultInstance.injectButton();

// ── Global audio-element hooks ────────────────────────────────────────────
// 1. song-end → disable the default detector so the post-play summary
//    modal pops automatically. User reported "the post play coaching
//    report does not ever appear" — that was because nothing fired
//    disable() at song-end; the summary only ran on explicit Detect-off.
// 2. pause/play → reflect playback state in the drill HUD so the user
//    can see at a glance that they're paused mid-drill (no Iter score
//    is going to advance until they resume).
// All hooks are dataset-guarded so duplicate <script> evaluations don't
// double-register listeners.
function _ndInstallAudioElementHooks() {
    const audio = document.getElementById('audio');
    if (!audio) {
        // Audio element may not exist yet at module-init time. Retry
        // briefly via the same retry budget the playSong hook uses.
        if (_ndShared.playSongRetries < _ND_PLAY_SONG_MAX_RETRIES) {
            setTimeout(_ndInstallAudioElementHooks, 100);
        }
        return;
    }
    if (audio.dataset._ndAudioHooked === '1') return;
    audio.dataset._ndAudioHooked = '1';
    audio.addEventListener('ended', () => {
        const det = window.noteDetect;
        if (det && typeof det.isEnabled === 'function' && det.isEnabled()) {
            // disable() snapshots the play and pops the summary modal,
            // which itself wires the "Coaching review →" button.
            det.disable();
        }
    });
    audio.addEventListener('pause', () => {
        const hud = document.getElementById('nd-drill-hud');
        if (!hud) return;
        hud.dataset.paused = '1';
        // Tint the HUD border yellow + add a "PAUSED" tag in place of
        // the focus line so the visual change is unmistakable.
        hud.style.borderColor = '#eab308';
        let tag = hud.querySelector('.nd-drill-paused-tag');
        if (!tag) {
            tag = document.createElement('div');
            tag.className = 'nd-drill-paused-tag text-yellow-300 font-bold text-xs mt-1';
            tag.textContent = '⏸ Paused — press play to resume';
            hud.firstElementChild?.firstElementChild?.appendChild(tag);
        }
    });
    audio.addEventListener('play', () => {
        const hud = document.getElementById('nd-drill-hud');
        if (!hud) return;
        delete hud.dataset.paused;
        hud.style.borderColor = '';  // back to default (CSS class blue)
        const tag = hud.querySelector('.nd-drill-paused-tag');
        if (tag) tag.remove();
    });
}
_ndInstallAudioElementHooks();

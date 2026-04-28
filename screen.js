// Note Detection plugin
// Captures guitar audio, detects pitch via CREPE or YIN, scores against highway notes.
//
// Also publishes window.slopsmith.notes — a shared detection bus that other
// plugins (flashcard, mute-trainer, scales, …) subscribe to instead of opening
// their own mic. See the NotesBus IIFE immediately below; the legacy scoring
// pipeline that follows runs independently and is unchanged.

// ── window.slopsmith.notes — shared detection bus ──────────────────────────
//
// Public API (attached on plugin script load, before any consumer needs it):
//
//   await window.slopsmith.notes.start({ deviceId? })   // refcounted
//   window.slopsmith.notes.stop()                       // refcounted
//   window.slopsmith.notes.isActive() → bool
//   window.slopsmith.notes.current() → { stableMidi, level, lastSilenceAt, lastTransientAt }
//   const unsub = window.slopsmith.notes.on(eventName, cb)   // returns unsubscribe
//
// Events:
//   'frame'     ~50ms cadence: { midi, conf, level, timeMs } (midi = -1 if not locked)
//   'note'      stable-MIDI change: { midi, name, octave, conf, cents, timeMs, string, fret }
//   'silence'   RMS < gate sustained ≥ 80 ms: { durationMs, timeMs }
//   'transient' RMS attack from silence with no fundamental: { peakLevel, timeMs }
//
// Constants below match notedetect's production-calibrated defaults
// (3-of-3 stability, 0.005 silence gate). See calibration history at
// docs/ROCKSMITH_TIMING_MODEL.md.
(function _slopsmithNotesBus() {
    'use strict';
    if (typeof window === 'undefined') return;
    if (window.slopsmith && window.slopsmith.notes) return;
    if (!window.slopsmith) {
        // Host app.js initializes window.slopsmith before plugins load. If this
        // plugin somehow runs first (or in a test harness), give consumers a
        // place to attach without crashing — host's later EventTarget mixin
        // will overwrite this stub but keep the .notes property by reference.
        window.slopsmith = {};
    }

    const NB_FRAME_SIZE = 2048;
    const NB_MIN_YIN_SAMPLES = 4096;
    const NB_CONFIDENCE_THRESHOLD = 0.7;
    const NB_SILENCE_GATE = 0.005;     // matches notedetect production
    const NB_SILENCE_HOLD_MS = 80;
    const NB_STABILITY_WINDOW = 3;     // matches notedetect production
    const NB_STABILITY_REQUIRED = 2;
    const NB_YIN_THRESHOLD = 0.15;
    const NB_MIN_FREQ = 30;
    const NB_MAX_FREQ = 1500;
    const NB_TRANSIENT_GATE = 0.05;
    const NB_TRANSIENT_DEBOUNCE_MS = 100;
    const NB_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const NB_GUITAR_OPEN = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4
    const NB_BASS_OPEN = [28, 33, 38, 43];           // E1 A1 D2 G2

    // Audio + detection state
    let nbAudioCtx = null;
    let nbStream = null;
    let nbProcessor = null;
    let nbAnalyser = null;
    let nbAccumBuffer = new Float32Array(0);
    let nbPendingBuffer = null;
    let nbDetectInterval = null;
    let nbLevelRaf = null;
    let nbInputLevel = 0;
    let nbPrevLevel = 0;
    let nbRawMidiHistory = [];
    let nbStableMidi = -1;
    let nbPrevStableMidi = -1;
    let nbInSilence = false;
    let nbSilenceStartT = 0;
    let nbLastSilenceAt = 0;
    let nbLastTransientAt = 0;
    let nbStarters = 0; // refcount across consumers

    const nbTarget = new EventTarget();
    function nbEmit(name, detail) {
        nbTarget.dispatchEvent(new CustomEvent(name, { detail }));
    }

    function nbFreqToMidi(f) {
        return 12 * Math.log2(f / 440) + 69;
    }

    function nbMidiToName(m) {
        return NB_NOTE_NAMES[((m % 12) + 12) % 12];
    }

    // YIN — same algorithm as flashcard/notedetect; kept self-contained so the
    // bus has zero coupling to the legacy notedetect pipeline below.
    function nbYinDetect(buffer, sampleRate) {
        const halfLen = Math.floor(buffer.length / 2);
        const yinBuffer = new Float32Array(halfLen);
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
            yinBuffer[tau] *= tau / runningSum;
        }
        let tau = 2;
        while (tau < halfLen) {
            if (yinBuffer[tau] < NB_YIN_THRESHOLD) {
                while (tau + 1 < halfLen && yinBuffer[tau + 1] < yinBuffer[tau]) tau++;
                break;
            }
            tau++;
        }
        if (tau === halfLen) return { freq: -1, confidence: 0 };
        const s0 = tau > 0 ? yinBuffer[tau - 1] : yinBuffer[tau];
        const s1 = yinBuffer[tau];
        const s2 = tau + 1 < halfLen ? yinBuffer[tau + 1] : yinBuffer[tau];
        const betterTau = tau + (s0 - s2) / (2 * (s0 - 2 * s1 + s2));
        return {
            freq: sampleRate / betterTau,
            confidence: Math.max(0, 1 - yinBuffer[tau]),
        };
    }

    // Tuning lookup from highway. Falls back to bass standard since this
    // hardware is bass-primary (per calibration_reference). When highway has
    // no song loaded, string/fret will be derived against bass tuning — still
    // useful for free-play games like flashcard.
    function nbTuningOpenMidis() {
        try {
            const info = window.highway && typeof window.highway.getSongInfo === 'function'
                ? window.highway.getSongInfo()
                : null;
            if (info && Array.isArray(info.tuning)) {
                const offsets = info.tuning;
                const capo = info.capo || 0;
                const arrName = (info.arrangement || '').toLowerCase();
                const isBass = arrName.includes('bass') || offsets.length === 4;
                const base = isBass ? NB_BASS_OPEN : NB_GUITAR_OPEN;
                return base.map((m, i) => m + (offsets[i] || 0) + capo);
            }
        } catch (e) { /* fall through */ }
        return NB_BASS_OPEN;
    }

    function nbMidiToFretboard(midi) {
        const tuning = nbTuningOpenMidis();
        const positions = [];
        for (let s = 0; s < tuning.length; s++) {
            const fret = midi - tuning[s];
            if (fret >= 0 && fret <= 24) positions.push({ string: s, fret });
        }
        positions.sort((a, b) => a.fret - b.fret);
        return positions[0] || { string: -1, fret: -1 };
    }

    async function nbStartAudio(opts) {
        if (nbAudioCtx) return;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error('Microphone access not available (use Chrome/Edge with HTTPS or localhost).');
        }
        const constraints = {
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
            },
        };
        if (opts && opts.deviceId) {
            constraints.audio.deviceId = { exact: opts.deviceId };
        } else {
            // Reuse notedetect's persisted device choice if present, so the bus
            // and notedetect's own scoring screen pick the same instrument
            // input rather than landing on the default mic.
            try {
                const raw = localStorage.getItem('slopsmith_notedetect');
                if (raw) {
                    const s = JSON.parse(raw);
                    if (s && s.deviceId) constraints.audio.deviceId = { exact: s.deviceId };
                }
            } catch (e) { /* malformed settings — fall through to default device */ }
        }

        nbStream = await navigator.mediaDevices.getUserMedia(constraints);
        nbAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = nbAudioCtx.createMediaStreamSource(nbStream);

        nbAnalyser = nbAudioCtx.createAnalyser();
        nbAnalyser.fftSize = 512;
        nbAnalyser.smoothingTimeConstant = 0.8;
        source.connect(nbAnalyser);

        nbProcessor = nbAudioCtx.createScriptProcessor(NB_FRAME_SIZE, 1, 1);
        nbAccumBuffer = new Float32Array(0);
        nbPendingBuffer = null;
        nbProcessor.onaudioprocess = (e) => {
            const input = e.inputBuffer.getChannelData(0);
            const prev = nbAccumBuffer;
            const combined = new Float32Array(prev.length + input.length);
            combined.set(prev);
            combined.set(input, prev.length);
            if (combined.length >= NB_MIN_YIN_SAMPLES) {
                const start = combined.length - NB_MIN_YIN_SAMPLES;
                nbPendingBuffer = combined.slice(start, start + NB_MIN_YIN_SAMPLES);
                nbAccumBuffer = new Float32Array(0);
            } else {
                nbAccumBuffer = combined;
            }
        };
        source.connect(nbProcessor);
        nbProcessor.connect(nbAudioCtx.destination);

        nbDetectInterval = setInterval(() => {
            if (nbPendingBuffer) {
                const buf = nbPendingBuffer;
                nbPendingBuffer = null;
                nbProcessFrame(buf);
            }
        }, 50);

        const tickLevel = () => {
            if (!nbAnalyser) return;
            const buf = new Float32Array(nbAnalyser.fftSize);
            nbAnalyser.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            nbPrevLevel = nbInputLevel;
            nbInputLevel = Math.min(1, Math.sqrt(sum / buf.length) * 5);
            nbLevelRaf = requestAnimationFrame(tickLevel);
        };
        nbLevelRaf = requestAnimationFrame(tickLevel);
    }

    function nbStopAudio() {
        if (nbDetectInterval) { clearInterval(nbDetectInterval); nbDetectInterval = null; }
        if (nbLevelRaf) { cancelAnimationFrame(nbLevelRaf); nbLevelRaf = null; }
        nbPendingBuffer = null;
        if (nbProcessor) {
            try { nbProcessor.disconnect(); } catch (e) {}
            nbProcessor = null;
        }
        nbAnalyser = null;
        if (nbStream) {
            nbStream.getTracks().forEach((t) => t.stop());
            nbStream = null;
        }
        if (nbAudioCtx) {
            try { nbAudioCtx.close(); } catch (e) {}
            nbAudioCtx = null;
        }
        nbInputLevel = 0;
        nbPrevLevel = 0;
        nbAccumBuffer = new Float32Array(0);
        nbRawMidiHistory = [];
        nbStableMidi = -1;
        nbPrevStableMidi = -1;
        nbInSilence = false;
    }

    function nbProcessFrame(buffer) {
        const sr = nbAudioCtx ? nbAudioCtx.sampleRate : 48000;
        const result = nbYinDetect(buffer, sr);
        const now = performance.now();
        const level = nbInputLevel;

        // Silence handling — emit once per silence span (after hold), reset
        // stability so old votes don't reignite when sound returns.
        if (level < NB_SILENCE_GATE) {
            if (!nbInSilence) {
                nbSilenceStartT = now;
                nbInSilence = true;
            }
            const dur = now - nbSilenceStartT;
            if (dur >= NB_SILENCE_HOLD_MS && nbLastSilenceAt < nbSilenceStartT) {
                nbLastSilenceAt = now;
                nbEmit('silence', { durationMs: dur, timeMs: now });
            }
            if (nbRawMidiHistory.length) { nbRawMidiHistory = []; nbStableMidi = -1; }
            // Frame event with no detection
            nbEmit('frame', { midi: -1, conf: 0, level, timeMs: now });
            return;
        }
        if (nbInSilence) nbInSilence = false;

        // Transient: spike from sub-gate to TRANSIENT_GATE with no fundamental
        const noFund = result.freq <= 0
            || result.confidence < NB_CONFIDENCE_THRESHOLD
            || result.freq < NB_MIN_FREQ
            || result.freq > NB_MAX_FREQ;
        if (nbPrevLevel < NB_SILENCE_GATE
            && level > NB_TRANSIENT_GATE
            && noFund
            && (now - nbLastTransientAt) > NB_TRANSIENT_DEBOUNCE_MS) {
            nbLastTransientAt = now;
            nbEmit('transient', { peakLevel: level, timeMs: now });
        }

        const detectedMidi = noFund ? -1 : nbFreqToMidi(result.freq);

        // Stability voting
        if (detectedMidi >= 0) {
            const rounded = Math.round(detectedMidi);
            nbRawMidiHistory.push(rounded);
            if (nbRawMidiHistory.length > NB_STABILITY_WINDOW) nbRawMidiHistory.shift();
            const votes = new Map();
            for (const m of nbRawMidiHistory) votes.set(m, (votes.get(m) || 0) + 1);
            let winner = -1;
            let winnerCount = 0;
            for (const [m, c] of votes) {
                if (c > winnerCount) { winner = m; winnerCount = c; }
            }
            nbStableMidi = winnerCount >= NB_STABILITY_REQUIRED ? winner : -1;
        } else {
            nbStableMidi = -1;
        }

        nbEmit('frame', {
            midi: detectedMidi >= 0 ? Math.round(detectedMidi) : -1,
            conf: result.confidence,
            level,
            timeMs: now,
        });

        if (nbStableMidi >= 0 && nbStableMidi !== nbPrevStableMidi) {
            const pos = nbMidiToFretboard(nbStableMidi);
            const expectedFreq = 440 * Math.pow(2, (nbStableMidi - 69) / 12);
            const cents = result.freq > 0 ? 1200 * Math.log2(result.freq / expectedFreq) : 0;
            nbEmit('note', {
                midi: nbStableMidi,
                name: nbMidiToName(nbStableMidi),
                octave: Math.floor(nbStableMidi / 12) - 1,
                conf: result.confidence,
                cents,
                timeMs: now,
                string: pos.string,
                fret: pos.fret,
            });
            nbPrevStableMidi = nbStableMidi;
        } else if (nbStableMidi < 0) {
            nbPrevStableMidi = -1;
        }
    }

    const api = {
        async start(opts) {
            nbStarters++;
            if (nbStarters === 1) {
                try {
                    await nbStartAudio(opts || {});
                } catch (e) {
                    nbStarters = 0;
                    throw e;
                }
            }
        },
        stop() {
            if (nbStarters === 0) return;
            nbStarters--;
            if (nbStarters === 0) nbStopAudio();
        },
        isActive() { return nbStarters > 0 && !!nbAudioCtx; },
        current() {
            return {
                stableMidi: nbStableMidi,
                level: nbInputLevel,
                lastSilenceAt: nbLastSilenceAt,
                lastTransientAt: nbLastTransientAt,
            };
        },
        on(eventName, cb) {
            const handler = (e) => cb(e.detail);
            nbTarget.addEventListener(eventName, handler);
            return () => nbTarget.removeEventListener(eventName, handler);
        },
    };

    window.slopsmith.notes = api;
})();

// ── Module-level shared state ──────────────────────────────────────────────

// Settings
let _ndTimingTolerance = 0.150;  // seconds (wider default for real-world play)
let _ndPitchTolerance = 50;      // cents
// Strictness: a single dial that bundles (pitchTol, timingTol, dirty-hit
// policy) into three named presets. Off-target-frame ratio = fraction of
// YIN frames in the hit window whose pitch didn't match expected. When
// it crosses the dirty threshold, the HIT is downgraded to DIRTY_HIT
// (e.g., open string ringing alongside the intended note). easy mode
// disables the dirty check; strict mode trips on minor leakage.
let _ndStrictness = 'default';     // 'easy' | 'default' | 'strict'
let _ndDirtyHitMaxOffRatio = 0.5;  // off-target frames > this → DIRTY_HIT (default preset)
let _ndInputGain = 1.0;
let _ndSelectedDeviceId = '';
let _ndSelectedChannel = 'mono'; // 'mono' | 'left' | 'right'
// Detection pipeline latency (audio input buffer + YIN window + stability voting).
// Rocksmith-equivalent: "Audio Lag Correction" / input offset. See
// docs/ROCKSMITH_TIMING_MODEL.md. Distinct from avOffsetMs (chart-vs-audio display
// offset): subtract this from chart time when translating a detection *event* back
// to "when the string was actually struck."
// 0.600 matches the calibrated value from CREPE.log working session
// (598.7 ms) on this hardware. 0.350 (prior default) leaves detections
// landing ~250 ms past every chart note, producing near-zero hits out of box.
// Legacy. Kept for save/load compat but always 0 at runtime — see load logic.
let _ndDetectionLatencySec = 0;
// Gate must sit below typical bass RMS (p95 ~0.005 on observed hardware).
// 0.020 (prior default) killed 59% of frames before pitch detection ran;
// 0.005 still rejects the idle noise floor (~0.001–0.003) but lets quiet
// bass notes through.
let _ndSilenceGate = 0.005;
let _ndPitchOffset = 0;          // semitones — calibrated or manual; compensates for chart CentOffset / tuning errors
// NOTE: localStorage may have a stale -1 from a bad calibration run. The
// Quick Calibrate proved G/D/A all match at 0 offset for Mexico by Cake.
// If localStorage has a non-zero value, it'll be loaded — use Quick Calibrate
// or the settings slider to reset.
let _ndAutoDetectOnPlay = true;  // when host <audio> emits 'play', auto-enable Detect

// Mic capture latency — measured once via the calibration wizard's audio run
// (user plays in time with metronome; median dt = round-trip from speaker to
// onset detection). Subtracted from highway timing labels and prescription
// timing-bias signal so what surfaces is the player's actual offset, not the
// hardware's audio stack delay. Synth replay measures only ~7ms post-capture
// processing; the rest of the typical 100-200ms structural latency lives in
// mic capture (USB ADC, OS audio stack, browser MediaStream) and varies per
// setup. No way to derive offline — has to be measured for each user's rig.
let _ndMicLatencyMs = 0;
// Off by default — recording produces files (POSTed to the server, then to
// /tmp/nd_recordings/). Opt in from the settings panel when you want a WAV
// alongside the per-iteration play snapshots, e.g. for offline classifier
// runs to disambiguate "you fretted wrong" from "detector misread clean audio".
let _ndAutoRecordOnPlay = false;
const _ND_AUTO_RECORD_MAX_SEC = 900; // 15 min — long enough for full songs and loop sessions, auto-stop is the safety

// Click-track-only playback. Mutes the song's <audio> element and
// schedules WebAudio clicks at every chart beat so the player can
// practice anticipating note positions from rhythm alone — no bass
// tones, no harmonic context. Forces musical / rhythmic reading
// instead of visual reaction; the +300 ms HIT-timing residual we see
// with audio + click should drop substantially when the player has to
// READ the chart and feel the bar instead of REACTING to a cue.
let _ndClickTrackOnly = false;
let _ndClickTrackInterval = null;
let _ndClickTrackScheduled = new Set();   // chart-time keys of beats already scheduled
const _ND_CLICK_LOOKAHEAD_SEC = 0.4;

// Audio level metering
let _ndInputLevel = 0;       // current RMS level 0-1
let _ndInputPeak = 0;        // peak hold level
let _ndPeakDecay = 0;        // decay timer for peak hold
let _ndLevelAnalyser = null;  // AnalyserNode for VU meter

// Scoring
let _ndHits = 0;
let _ndMisses = 0;
let _ndPitchMisses = 0;      // detection in timing window but wrong cents
let _ndTimingMisses = 0;     // chart note passed with NO detection in window
let _ndDirtyHits = 0;        // hits downgraded to DIRTY_HIT due to off-target frame ratio
let _ndStreak = 0;
let _ndBestStreak = 0;
let _ndSectionStats = [];    // [{name, hits, misses}]
let _ndCurrentSection = null;

// Compound judgment counters (docs/NOTE_FAILURE_SPEC.md). A HIT can still
// have timing/pitch labels if the detection was within tolerance but not
// perfectly aligned. These counters tally label occurrences, not unique
// notes — one hit with "LATE + FLAT" increments both.
let _ndEarly = 0, _ndLate = 0, _ndSharp = 0, _ndFlat = 0;

// Sub-tolerance "perfect" thresholds: beyond these we attach a label even
// if the note still counts as a hit within the user's tolerance sliders.
// Values from the spec.
// Perfect-window thresholds — used for LATE/EARLY/SHARP/FLAT label decisions
// (HIT remains a HIT in either case; labels just signal precision). These
// are tracked as `let` rather than const so the strictness preset can rebind
// them — a 50 ms perfect window inside a 300 ms Easy hit window meant
// almost every clean hit got tagged LATE, even when comfortably in window.
// Set initially to default-preset values; _ndApplyStrictness rebinds them.
let _ndPerfectTimingMs  = 50;
let _ndPerfectPitchCent = 20;

// Adaptive drift estimate. Real-world recordings (especially CDLC and
// charts of live human performances) have rubato — the audio's note
// timing wanders relative to the chart's BPM-derived note positions.
// Without compensation, a +230 ms drift makes every clean hit look LATE
// in the live HUD and pushes some hits outside the timing window
// entirely.
//
// We maintain a rolling median of recent HIT timingError values. The
// median is treated as the current chart-vs-audio offset and added to
// each chart note's chartT before window/label checks — equivalent to
// shifting the hit window center forward by the drift amount. Median is
// robust to a few outliers (a single late note doesn't move the
// estimate much). Window size of 8 picks up tempo wobble within ~10 s
// without locking onto a single bad hit.
let _ndDriftBuffer = [];          // last N HIT timingError values (ms)
let _ndDriftEstimateMs = 0;       // current rolling median
const _ND_DRIFT_WINDOW = 8;       // sample count
const _ND_DRIFT_MIN_SAMPLES = 4;  // need this many before estimate becomes non-zero

function _ndUpdateDriftEstimate(timingError) {
    _ndDriftBuffer.push(timingError);
    if (_ndDriftBuffer.length > _ND_DRIFT_WINDOW) _ndDriftBuffer.shift();
    if (_ndDriftBuffer.length >= _ND_DRIFT_MIN_SAMPLES) {
        const sorted = _ndDriftBuffer.slice().sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        _ndDriftEstimateMs = sorted.length % 2 === 0
            ? (sorted[mid - 1] + sorted[mid]) / 2
            : sorted[mid];
    }
}

// Rolling diagnostic stats — each entry is the closest-chart-note-match for a
// detection event. Used for the HUD readout.
//   dtMs:   plugin_now - chart_note_time (ms). Positive = detection late.
//   centsErr: detected pitch - expected pitch, in cents.
//   hit:    whether it was within both tolerances (pass for scoring).
const _ND_EVENT_WINDOW = 30;
let _ndEventLog = [];
// Diagnostic capture — when window._ndCaptureAllEvents is truthy, every match
// attempt is pushed to window._ndAllEvents without the ring-buffer cap. Used
// by test/replay-baseline.js for offline residual analysis across full songs.
// Off by default so production keeps its bounded memory.

// Transient rejection — lightweight filter that adds zero latency.
// If MIDI jumps > threshold from previous detection within the debounce
// window, skip it (likely attack transient jitter from YIN).
let _ndLastMatchMidi = -1;
let _ndLastMatchTime = 0;
const _ND_TRANSIENT_JUMP = 3;      // semitones — skip if MIDI jumps more than this
const _ND_TRANSIENT_WINDOW = 0.15; // seconds — only filter within this window of last detection

// Note tracking
let _ndNoteResults = new Map(); // key -> 'hit'|'pitch_miss'|'timing_miss'

// Severity scoring (0..1, higher = worse). Drives the post-session
// "practice these" ranking: miss_count × avg_severity surfaces notes that
// are missed often AND missed badly.
function _ndSeverity(primary, timingError, pitchError) {
    if (primary === 'MISSED_NO_DETECTION') return 1.0;
    if (primary === 'MISSED_WRONG_PITCH') {
        const cents = pitchError == null ? 200 : Math.abs(pitchError);
        return Math.min(0.7 + cents / 200 * 0.3, 1.0);
    }
    // HIT — severity is how *imperfect* the hit was.
    const tFrac = timingError == null ? 0 : Math.min(Math.abs(timingError) / 300, 1);
    const pFrac = pitchError  == null ? 0 : Math.min(Math.abs(pitchError)  / 100, 1);
    return Math.max(tFrac, pFrac);
}
// Per-chart-note: best pitch attempt (min |cents|) seen while note was in
// timing window. If a note gets marked miss, we use this to distinguish
// "detection fired but wrong pitch" vs "nothing fired at all."
let _ndNotePitchAttempts = new Map(); // key -> bestCentsErr

// Per-chart-note hygiene ledger: counts on-target vs off-target YIN frames
// observed while the note's hit window was active, plus a histogram of the
// off-target detected MIDIs. Used to classify a HIT as CLEAN or DIRTY:
// even when the dominant pitch matched, if a high fraction of frames
// during the window read a different pitch (e.g., open E ringing
// alongside the intended note), the note's hygiene is bad. Mirrors
// Pass 2 of test/string-hygiene.js but runs live, frame by frame.
let _ndNoteHygiene = new Map(); // key -> { onTargetFrames, offTargetFrames, contaminantMidis: Map<midi,count> }

// Stability voting — suppresses YIN's attack-transient pitch jitter by
// requiring N of the last M raw detections to agree on a rounded MIDI value
// before the plugin treats it as a "stable" detection for scoring purposes.
// Downstream: scoring uses _ndStableMidi; HUD's raw "detected" readout still
// uses _ndDetectedMidi so users see live YIN output.
const _ND_STABILITY_WINDOW = 3;      // raw samples considered (was 5 — too slow for 400ms note spacing)
const _ND_STABILITY_REQUIRED = 2;    // N-of-M for "stable" (was 3 — halves convergence time)
let _ndRawMidiHistory = [];          // last N raw midi values (rounded)
let _ndStableMidi = -1;              // most recent stable midi, or -1 if unsettled
let _ndDetectedMidi = -1;
let _ndDetectedConfidence = 0;
let _ndDetectedString = -1;
let _ndDetectedFret = -1;

// Tuning — standard tuning MIDI base per string, adjusted by arrangement offsets.
// Guitar: 6 strings, low E2 to high E4. Bass: 4 strings, low E1 to high G2
// (one octave below guitar low-4 minus the top two). Arrangement type is
// derived from song_info.arrangement name; see _ndSetArrangement.
const _ndStandardMidiGuitar = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4
const _ndStandardMidiBass = [28, 33, 38, 43];           // E1 A1 D2 G2
let _ndCurrentArrangement = 'guitar';                   // 'guitar' | 'bass'
let _ndTuningOffsets = [0, 0, 0, 0, 0, 0];
let _ndCapo = 0;
let _ndUnderBufferWarned = false;

// Frame-level diagnostic log — records EVERY detection frame including
// rejections, so we can see exactly what YIN reports and when.
// Toggle with _ndFrameLogEnabled = true in console (off by default to
// avoid spamming). Ring buffer, max 200 entries.
let _ndFrameLogEnabled = true;
let _ndFrameLog = [];
const _ND_FRAME_LOG_MAX = 2000;
let _ndOnsetCount = 0; // count onset flushes for diagnostics

// ── Audio Recording ──────────────────────────────────────────────────────
// Records raw audio from the ScriptProcessor (exactly what YIN sees).
// Start with _ndRecordStart(maxSeconds), stop with _ndRecordStop().
// Downloads as WAV or POSTs to the server.
let _ndRecording = false;
let _ndRecordChunks = [];  // Float32Array chunks
let _ndRecordMaxSamples = 0;
let _ndRecordTotalSamples = 0;
let _ndRecordSampleRate = 48000;

let _ndRecordChartStartTime = 0; // chart time of the first captured sample (set inside SP callback, not at _ndRecordStart call)
let _ndRecordAnchored = false;   // true once the SP callback has captured the real first-sample chart time
let _ndRecordArmedChartTime = 0; // chart time at the moment of arming — used to detect play-has-started (chart advancing)
let _ndRecordFilename = 'auto-recording.wav'; // filename used by the auto-save when max samples reached

function _ndRecordStart(maxSeconds = 60, filename) {
    _ndRecordChunks = [];
    _ndRecordTotalSamples = 0;
    _ndRecordSampleRate = _ndAudioCtx ? _ndAudioCtx.sampleRate : 48000;
    _ndRecordMaxSamples = maxSeconds * _ndRecordSampleRate;
    // Do NOT capture chart start time here — highway.getTime() returns the
    // paused chart position if the song hasn't been played yet, which does
    // not correspond to WAV t=0 once playback starts. Instead, anchor inside
    // the ScriptProcessor callback on the first sample captured AFTER the
    // chart clock begins advancing.
    _ndRecordAnchored = false;
    _ndRecordChartStartTime = 0;
    _ndRecordArmedChartTime = highway.getTime ? highway.getTime() : 0;
    _ndRecordFilename = filename || 'auto-recording.wav';
    _ndRecording = true;
    console.log(`[note_detect] Recording armed (max ${maxSeconds}s at ${_ndRecordSampleRate}Hz, chart ${_ndRecordArmedChartTime.toFixed(3)}s — waiting for playback to advance)`);
}

// Record raw audio without the chart-clock gate. Used for controlled diagnostic
// recordings (open strings, chromatic scales) where no song is playing.
// Unlike _ndRecordStart, this anchors immediately on the next SP callback.
function _ndRecordStartRaw(maxSeconds = 30, filename) {
    _ndRecordChunks = [];
    _ndRecordTotalSamples = 0;
    _ndRecordSampleRate = _ndAudioCtx ? _ndAudioCtx.sampleRate : 48000;
    _ndRecordMaxSamples = maxSeconds * _ndRecordSampleRate;
    _ndRecordChartStartTime = 0;
    _ndRecordArmedChartTime = 0;
    _ndRecordAnchored = true; // skip the chart-advance gate
    _ndRecordFilename = filename || 'raw-recording.wav';
    _ndRecording = true;
    if (!_ndEnabled) {
        console.warn('[note_detect] _ndEnabled is false — click Detect first or nothing will record.');
    }
    console.log(`[note_detect] Raw recording armed (max ${maxSeconds}s at ${_ndRecordSampleRate}Hz, no chart gate, file=${_ndRecordFilename})`);
}

// Returns a snapshot of the recording state for UI polling.
function _ndRecordStatus() {
    return {
        active: _ndRecording,
        anchored: _ndRecordAnchored,
        armedChartTime: _ndRecordArmedChartTime,
        anchorChartTime: _ndRecordChartStartTime,
        capturedSec: _ndRecordTotalSamples / (_ndRecordSampleRate || 48000),
        maxSec: _ndRecordMaxSamples / (_ndRecordSampleRate || 48000),
        filename: _ndRecordFilename,
    };
}

// Internal — drain _ndRecordChunks into a single PCM Float32Array and reset state.
function _ndRecordFlushPcm() {
    _ndRecording = false;
    if (_ndRecordChunks.length === 0) {
        console.log('[note_detect] No audio recorded');
        return null;
    }
    const totalLen = _ndRecordChunks.reduce((s, c) => s + c.length, 0);
    const pcm = new Float32Array(totalLen);
    let offset = 0;
    for (const chunk of _ndRecordChunks) {
        pcm.set(chunk, offset);
        offset += chunk.length;
    }
    console.log(`[note_detect] Recording stopped: ${(totalLen / _ndRecordSampleRate).toFixed(1)}s, ${totalLen} samples`);
    _ndRecordChunks = [];
    return pcm;
}

// User-facing stop — always saves to the filename set at arming time.
// Avoids the footgun of "stop returned PCM but didn't persist anything."
function _ndRecordStop() {
    const pcm = _ndRecordFlushPcm();
    if (!pcm) return null;
    // Fire-and-forget save; returning the PCM so console users still see the
    // recording they captured.
    _ndPersistRecording(pcm, _ndRecordFilename || 'recording.wav');
    return pcm;
}

// Internal — encode PCM to WAV + POST to the server, with local download fallback.
async function _ndPersistRecording(pcm, filename) {
    const blob = _ndRecordToWavBlob(pcm, _ndRecordSampleRate);
    const formData = new FormData();
    formData.append('file', blob, filename);
    try {
        const resp = await fetch(`/api/plugins/note_detect/recording?chartStartTime=${_ndRecordChartStartTime.toFixed(3)}`, {
            method: 'POST',
            body: formData,
        });
        const result = await resp.json();
        console.log(`[note_detect] Recording saved to server: ${result.path} (${(blob.size / 1024).toFixed(0)} KB, chart start ${_ndRecordChartStartTime.toFixed(3)}s)`);
    } catch (e) {
        console.warn('[note_detect] Server save failed, downloading locally:', e);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.click();
        URL.revokeObjectURL(url);
    }
}

function _ndRecordToWavBlob(pcm, sampleRate) {
    // Encode Float32 PCM as 16-bit WAV
    const numSamples = pcm.length;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);
    const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);       // chunk size
    view.setUint16(20, 1, true);        // PCM
    view.setUint16(22, 1, true);        // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);        // block align
    view.setUint16(34, 16, true);       // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, numSamples * 2, true);
    for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, pcm[i]));
        view.setInt16(44 + i * 2, s * 0x7FFF, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
}

async function _ndRecordSave(filename) {
    const pcm = _ndRecordFlushPcm();
    if (!pcm) return;
    await _ndPersistRecording(pcm, filename || _ndRecordFilename || 'recording.wav');
}

// UI-driven aligned recording. Arms recording AND starts playback atomically
// so there is no "human interval" between the two. The SP callback captures
// the anchor on the first sample where the chart has advanced past the armed
// value, which happens within one SP buffer (~42 ms) of audio.play().
async function _ndRecordAlignedStart(seconds = 60) {
    if (_ndRecording) {
        console.log('[note_detect] Recording already active; stop first');
        return null;
    }
    const info = highway.getSongInfo && highway.getSongInfo();
    const slugSource = info?.filename || info?.title || '';
    const songSlug = slugSource
        ? slugSource.replace(/\.\w+$/, '').replace(/[^a-z0-9-]/gi, '_').toLowerCase()
        : 'take';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `${songSlug}-${stamp}.wav`;
    _ndRecordStart(seconds, filename);

    // Start playback if the song audio is paused. If it's already playing,
    // leave it alone. If there's no audio element, the user can start it
    // manually and the anchor will be captured whenever playback advances.
    const audio = document.getElementById('audio');
    if (audio) {
        if (audio.paused) {
            try {
                await audio.play();
                console.log(`[note_detect] Playback started from chart ${(highway.getTime ? highway.getTime() : 0).toFixed(3)}s`);
            } catch (e) {
                console.warn('[note_detect] audio.play() rejected:', e?.message || e);
            }
        } else {
            console.log('[note_detect] Audio already playing — recording armed without triggering play');
        }
    } else {
        console.log('[note_detect] No <audio id="audio"> found; press play manually to begin');
    }
    return filename;
}

// Auto-dump: POST diagnostic data to server automatically so the user never
// has to click a button while holding a guitar. Fires on loop restart (time
// jumps backward) and periodically every 30s while playing.
let _ndLastDumpTime = 0;           // performance.now() of last auto-dump
let _ndLastSeenScoreTime = -1;     // track score time to detect loop restarts
let _ndLastLoopRestart = 0;        // performance.now() of the last loop_restart snapshot
const _ND_AUTO_DUMP_INTERVAL = 30; // seconds between periodic dumps
const _ND_AUTO_DUMP_MIN_EVENTS = 3; // need at least this many events to be worth dumping
// Refractory window after a loop_restart snapshot: ignore subsequent backward
// chart-time jumps within this period. Audio engine seek can produce several
// frames of stutter on loop wrap (chart time briefly oscillating), each of
// which the raw "scoreT < prevScoreT - 1s" check would treat as a new
// iteration — producing 4-6 spurious tiny snapshots per real iteration.
// 1.5s is comfortably longer than observed stutter (~250ms) and shorter than
// any reasonable looped passage.
const _ND_LOOP_RESTART_REFRACTORY_SEC = 1.5;

function _ndAutoDumpPost() {
    const dumpData = {
        timestamp: new Date().toISOString(),
        autoDump: true,
        eventLog: _ndEventLog,
        frameLog: _ndFrameLog,
        noteResults: [],
        settings: {
            latencyOffset: _ndDetectionLatencySec,
            timingTolerance: _ndTimingTolerance,
            pitchTolerance: _ndPitchTolerance,
            silenceGate: _ndSilenceGate,
            arrangement: _ndCurrentArrangement,
            tuning: _ndTuningOffsets,
            capo: _ndCapo,
        },
        scoring: { hits: _ndHits, misses: _ndMisses, pitchMisses: _ndPitchMisses, timingMisses: _ndTimingMisses },
    };
    _ndNoteResults.forEach((v, k) => dumpData.noteResults.push({ key: k, ...v }));
    fetch('/api/plugins/note_detect/dump', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dumpData),
    }).then(() => console.log('[note_detect] Auto-dump saved'))
      .catch(e => console.warn('[note_detect] Auto-dump failed:', e));
    _ndLastDumpTime = performance.now() / 1000;
}

// ── Per-play history (for cross-play "practice these" report) ─────────────
// A "play" snapshot = one pass of the chart (or one loop iteration). Each
// snapshot serializes the current _ndNoteResults Map and POSTs to
// /api/plugins/note_detect/plays. After serialization, the Map is cleared
// so the next iteration re-judges from scratch — but the running session
// counters (_ndHits etc.) are preserved so the live HUD score still
// accumulates across loops.

let _ndPlaysCache = null;          // last fetched [{songId, playId, noteResults: [...]}, ...] for current song
let _ndPlaysCacheSongId = null;

function _ndCurrentSongId() {
    const info = highway.getSongInfo && highway.getSongInfo();
    if (!info) return null;
    const fn = info.filename || info.title || 'unknown';
    const ar = info.arrangement || 'default';
    return `${fn}__${ar}`;
}

function _ndSnapshotPlay(reason) {
    if (_ndNoteResults.size === 0) return Promise.resolve();
    const songId = _ndCurrentSongId();
    if (!songId) return Promise.resolve();
    const playId = new Date().toISOString().replace(/[:.]/g, '-');
    const noteResults = [];
    _ndNoteResults.forEach((v, k) => noteResults.push({ key: k, ...v }));
    const snapshot = {
        songId,
        playId,
        reason,
        startedAt: Date.now(),
        noteResults,
    };
    // Build the trouble map from this just-completed play BEFORE clearing
    // so the next loop iteration starts with up-to-date pre-arrival glow.
    _ndTroubleNotes = _ndBuildTroubleMap(noteResults);
    // Per-iteration banner — quick in-page summary of just-finished pass so
    // the user gets immediate feedback without running `make loop-report`.
    if (reason === 'loop_restart') _ndShowIterationBanner(noteResults);
    _ndNoteResults.clear();
    _ndNotePitchAttempts.clear();
    _ndNoteHygiene.clear();
    _ndPlaysCacheSongId = null; // invalidate cache; next report fetch reloads
    return fetch('/api/plugins/note_detect/plays', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot),
    }).then(() => console.log(`[note_detect] Play snapshot saved (${reason}, ${noteResults.length} notes)`))
      .catch(e => console.warn('[note_detect] Play snapshot failed:', e));
}

// Pull the most-recent play snapshot off disk and seed the trouble map.
// Used at detect-on so the player gets pre-arrival glow on the very first
// note of a new session — without this they'd have to complete a full loop
// before any glow appears.
async function _ndLoadTroubleFromDisk() {
    const songId = _ndCurrentSongId();
    if (!songId) {
        console.warn('[note_detect] Trouble map: songId is null at detect-on, retrying in 1s');
        setTimeout(() => _ndLoadTroubleFromDisk(), 1000);
        return;
    }
    try {
        console.log(`[note_detect] Trouble map fetching for songId="${songId}"`);
        const plays = await _ndFetchPlays(songId);
        console.log(`[note_detect] Trouble map fetch returned ${plays.length} play(s)`);
        if (!plays.length) {
            _ndTroubleNotes = new Map();
            console.log(`[note_detect] Trouble map empty — no prior plays for songId="${songId}".`);
            return;
        }
        // plays[0] is newest by mtime
        const newest = plays[0];
        _ndTroubleNotes = _ndBuildTroubleMap(newest.noteResults || []);
        console.log(`[note_detect] Trouble map loaded: ${_ndTroubleNotes.size} notes from playId=${newest.playId} (${(newest.noteResults || []).length} total entries)`);
        // Sample a few keys so a key-mismatch bug is visible in console
        const sampleKeys = [];
        for (const k of _ndTroubleNotes.keys()) {
            sampleKeys.push(k);
            if (sampleKeys.length >= 5) break;
        }
        console.log(`[note_detect] Trouble keys sample: ${JSON.stringify(sampleKeys)}`);
        // Dump the first few CHART keys we'll be matching against, so a
        // mismatch with trouble keys above is obvious. Captured at first
        // draw frame; logs once.
        _ndTroubleDebugDumpPending = true;
    } catch (e) {
        console.warn('[note_detect] Trouble map load failed:', e);
        _ndTroubleNotes = new Map();
    }
}

// One-shot flag: dump first few chart-note keys at the next draw frame so
// the console shows what we're attempting to MATCH the trouble map against.
let _ndTroubleDebugDumpPending = false;

async function _ndFetchPlays(songId) {
    if (_ndPlaysCacheSongId === songId && _ndPlaysCache) return _ndPlaysCache;
    try {
        const r = await fetch(`/api/plugins/note_detect/plays?songId=${encodeURIComponent(songId)}&limit=10`);
        const data = await r.json();
        _ndPlaysCache = data.plays || [];
        _ndPlaysCacheSongId = songId;
        return _ndPlaysCache;
    } catch (e) {
        console.warn('[note_detect] Plays fetch failed:', e);
        return [];
    }
}

// ── In-page Practice Report (browser port of test/aggregate-plays.js) ────
// Mirrors the Node aggregator's algorithm so the user gets the same shape
// of report inside the page — the offline `make loop-report` is now for
// cross-session debugging, not the practice flow.

function _ndAggregatePlays(plays) {
    // Per-play metadata + per-note attempt verdicts joined across plays.
    // Sort newest-first so the user sees the latest attempt as column 1
    // in the matrix without scrolling to the right edge of the row. The
    // attempt label is "Most recent" for index 0 and walks back from there.
    plays = (plays || []).slice().sort((a, b) => {
        const ax = a.startedAt || 0, bx = b.startedAt || 0;
        return bx - ax;
    });
    const playMeta = plays.map((p, i) => {
        const ts = (p.noteResults || []).map(r => r.chartT).filter(t => Number.isFinite(t));
        return {
            idx: i, playId: p.playId, startedAt: p.startedAt, reason: p.reason,
            chartTMin: ts.length ? Math.min(...ts) : null,
            chartTMax: ts.length ? Math.max(...ts) : null,
            count: (p.noteResults || []).length,
        };
    });
    const noteIndex = new Map();
    for (let i = 0; i < plays.length; i++) {
        for (const r of plays[i].noteResults || []) {
            if (!noteIndex.has(r.key)) {
                noteIndex.set(r.key, {
                    key: r.key, chartT: r.chartT, expectedMidi: r.expectedMidi,
                    stringFret: `s${r.s}/f${r.f}`, attempts: new Map(),
                });
            }
            noteIndex.get(r.key).attempts.set(i, { primary: r.primary });
        }
    }
    const rows = [];
    for (const note of noteIndex.values()) {
        const verdicts = [];
        for (const meta of playMeta) {
            const a = note.attempts.get(meta.idx);
            if (a) verdicts.push({ kind: a.primary });
            else if (meta.chartTMin != null && note.chartT >= meta.chartTMin && note.chartT <= meta.chartTMax) {
                verdicts.push({ kind: 'ABSENT' });
            } else verdicts.push({ kind: 'OUT_OF_SCOPE' });
        }
        rows.push({ ...note, verdicts });
    }
    rows.sort((a, b) => a.chartT - b.chartT);
    return { playMeta, rows };
}

function _ndStatsForRow(row) {
    const inScope = row.verdicts.filter(v => v.kind !== 'OUT_OF_SCOPE');
    const cleanHits = inScope.filter(v => v.kind === 'HIT').length;
    const dirtyHits = inScope.filter(v => v.kind === 'DIRTY_HIT').length;
    const hits = cleanHits + dirtyHits;
    const wrongPitch = inScope.filter(v => v.kind === 'MISSED_WRONG_PITCH').length;
    const noDetection = inScope.filter(v => v.kind === 'MISSED_NO_DETECTION').length;
    return {
        nAttempts: inScope.length,
        hits, cleanHits, dirtyHits, wrongPitch, noDetection,
        hitRate: inScope.length ? hits / inScope.length : 0,
    };
}

function _ndSuggestLoops(rows, opts = {}) {
    // Sliding-window hotspot finder — same as test/aggregate-plays.js.
    const { windowSec = 5, slideSec = 0.5, minMissesPerSec = 0.5,
            minTroubleNotes = 2, maxLoops = 5, padHeadSec = 0.5, padTailSec = 1.0 } = opts;
    const noteList = rows.map(r => ({ ...r, ...(_ndStatsForRow(r)) })).filter(r => r.nAttempts >= 2);
    if (noteList.length === 0) return [];
    const minT = Math.min(...noteList.map(n => n.chartT));
    const maxT = Math.max(...noteList.map(n => n.chartT));
    const candidates = [];
    for (let start = minT - windowSec / 2; start <= maxT + windowSec / 2; start += slideSec) {
        const end = start + windowSec;
        let misses = 0, attempts = 0;
        const inside = [];
        for (const n of noteList) {
            if (n.chartT >= start && n.chartT <= end) {
                inside.push(n);
                misses += n.nAttempts - n.hits;
                attempts += n.nAttempts;
            }
        }
        const trouble = inside.filter(n => n.hits < n.nAttempts).length;
        const density = misses / windowSec;
        if (density >= minMissesPerSec && trouble >= minTroubleNotes) {
            candidates.push({ start, end, density, misses, attempts, trouble, notes: inside });
        }
    }
    candidates.sort((a, b) => b.density - a.density);
    const selected = [];
    for (const c of candidates) {
        if (selected.length >= maxLoops) break;
        if (selected.some(s => s.start < c.end && s.end > c.start)) continue;
        selected.push(c);
    }
    selected.sort((a, b) => a.start - b.start);
    return selected.map((c, i) => {
        const a = Math.max(0, c.start - padHeadSec);
        const b = c.end + padTailSec;
        const trouble = c.notes.filter(n => n.hits < n.nAttempts);
        return {
            id: i + 1, startSec: a, endSec: b, durationSec: b - a,
            noteCount: trouble.length,
            avgMissRate: trouble.length
                ? trouble.reduce((s, n) => s + (1 - n.hitRate), 0) / trouble.length : 0,
            positions: [...new Set(trouble.map(n => n.stringFret))].slice(0, 4).join(','),
            notes: trouble,
        };
    });
}

// ── Top-3 actionable prescriptions ────────────────────────────────────────
// Distill plays[] into 3 short, ranked "do this next" instructions. Score
// each candidate signal by impact (occurrences × severity-equivalent), keep
// the best 3. The headline tile in the report renders these; the tip card
// after each loop shows the top one. Goal: the user can read it once and
// know what to change without reading the full report.
//
// Each prescription:
//   { text: short single sentence,
//     detail: optional secondary line (specifics),
//     action: { label, kind, payload? } | null,
//     score: number }
//
// action.kind values:
//   'save_loop'    payload = { start, end }   — POST to /api/loops via _ndSaveSuggestedLoop
//   'open_report'  scroll to a section anchor
//   'open_tuner'   open the standalone tuner
//   null           no actionable button
function _ndComputeTop3Prescriptions(plays, songFilename, avOffsetMs = 0, micLatencyMs = 0) {
    const candidates = [];
    if (!plays || plays.length === 0) return [];

    const { rows } = _ndAggregatePlays(plays);

    // ── Signal A: dominant failure mode (uses existing classifier) ───────
    const failureCounts = new Map();
    let totalEvaluated = 0;
    let totalSeverityFromFailures = 0;
    for (const p of plays) {
        for (const r of p.noteResults || []) {
            const { mode, severity } = _ndClassifyFailureMode(r);
            if (mode === 'CLEAN') { totalEvaluated++; continue; }
            const prev = failureCounts.get(mode) || { count: 0, sevSum: 0 };
            prev.count++;
            prev.sevSum += severity;
            failureCounts.set(mode, prev);
            totalEvaluated++;
            totalSeverityFromFailures += severity;
        }
    }
    if (failureCounts.size > 0) {
        const sorted = [...failureCounts.entries()].sort((a, b) => b[1].count - a[1].count);
        const [mode, stats] = sorted[0];
        const info = _ND_FAILURE_MODE_INFO[mode] || { label: mode, advice: '' };
        if (info.advice && stats.count >= 2) {
            candidates.push({
                text: `${info.advice}`,
                detail: `${info.label}: ${stats.count} of ${totalEvaluated} notes`,
                action: { kind: 'open_report', label: 'Open report', payload: { anchor: 'top-issues' } },
                score: stats.count * (stats.sevSum / stats.count),
                signal: 'failure_mode',
            });
        }
    }

    // ── Signal B: systematic timing offset ────────────────────────────────
    // Subtract mic capture latency (measured via the calibration wizard's
    // audio run) before computing the median. timingError = real player
    // offset + mic_capture_latency; without this subtraction, prescriptions
    // fire on hardware delay the player can't act on.
    const timingErrors = [];
    for (const p of plays) {
        for (const r of p.noteResults || []) {
            if ((r.primary === 'HIT' || r.primary === 'DIRTY_HIT')
                    && typeof r.timingError === 'number' && isFinite(r.timingError)) {
                timingErrors.push(r.timingError - micLatencyMs);
            }
        }
    }
    if (timingErrors.length >= 5) {
        timingErrors.sort((a, b) => a - b);
        const median = timingErrors[Math.floor((timingErrors.length - 1) * 0.5)];
        const absMedian = Math.abs(median);
        if (absMedian > 30) {
            const direction = median > 0 ? 'late' : 'early';
            const action = median > 0
                ? 'You\'re consistently behind the beat. Anticipate the click instead of waiting for the visual cue.'
                : 'You\'re consistently ahead of the beat. Hold the upbeat for one extra moment before plucking.';
            candidates.push({
                text: `You\'re ${Math.round(absMedian)}ms ${direction} on hits. ${action}`,
                detail: micLatencyMs > 0
                    ? `Median across ${timingErrors.length} hits (mic latency ${Math.round(micLatencyMs)}ms subtracted)`
                    : `Median across ${timingErrors.length} hits — calibrate mic latency for cleaner reading`,
                action: { kind: 'open_report', label: 'Open report', payload: { anchor: 'latency-stack' } },
                score: absMedian * Math.min(timingErrors.length, 50) / 100,
                signal: 'timing_bias',
            });
        }
    }

    // ── Signal C: per-string weakness ─────────────────────────────────────
    const stringStats = new Map(); // s → { attempts, misses }
    for (const p of plays) {
        for (const r of p.noteResults || []) {
            if (typeof r.s !== 'number') continue;
            const stat = stringStats.get(r.s) || { attempts: 0, misses: 0 };
            stat.attempts++;
            if (r.primary && r.primary.startsWith('MISSED')) stat.misses++;
            stringStats.set(r.s, stat);
        }
    }
    let totalAttempts = 0, totalMisses = 0;
    for (const stat of stringStats.values()) {
        totalAttempts += stat.attempts;
        totalMisses += stat.misses;
    }
    const overallMissRate = totalAttempts > 0 ? totalMisses / totalAttempts : 0;
    if (totalAttempts >= 10) {
        for (const [s, stat] of stringStats) {
            if (stat.attempts < 5) continue;
            const rate = stat.misses / stat.attempts;
            if (rate >= 0.4 && rate >= overallMissRate * 1.5) {
                const stringNames = _ndCurrentArrangement === 'bass'
                    ? ['E (low)', 'A', 'D', 'G (high)', '', '']
                    : ['E (low)', 'A', 'D', 'G', 'B', 'E (high)'];
                const stringLabel = stringNames[s] || `string ${s + 1}`;
                candidates.push({
                    text: `${stringLabel} string is your weak point — ${Math.round(rate * 100)}% miss rate vs ${Math.round(overallMissRate * 100)}% overall.`,
                    detail: `${stat.misses} of ${stat.attempts} attempts on this string failed`,
                    action: null,
                    score: (rate - overallMissRate) * stat.attempts,
                    signal: 'per_string',
                });
                break; // one per-string prescription per report
            }
        }
    }

    // ── Signal D: hotspot loop suggestion ─────────────────────────────────
    // Reuses _ndSuggestLoops which is already wired into the report's
    // Suggested Loops section. We surface the densest one as a prescription.
    const loops = _ndSuggestLoops(rows);
    if (loops.length > 0 && songFilename) {
        const top = loops[0];
        const startMmSs = `${Math.floor(top.startSec / 60)}:${Math.floor(top.startSec % 60).toString().padStart(2, '0')}`;
        const endMmSs   = `${Math.floor(top.endSec   / 60)}:${Math.floor(top.endSec   % 60).toString().padStart(2, '0')}`;
        candidates.push({
            text: `Loop ${startMmSs}–${endMmSs} — ${top.noteCount} trouble notes (${Math.round(top.avgMissRate * 100)}% avg miss).`,
            detail: top.positions ? `Positions: ${top.positions}` : '',
            action: {
                kind: 'save_loop',
                label: 'Save this loop',
                payload: { filename: songFilename, start: top.startSec, end: top.endSec },
            },
            score: top.avgMissRate * top.noteCount * top.durationSec,
            signal: 'loop_hotspot',
        });
    }

    // ── Signal E: chronic single note (missed across multiple plays) ─────
    let chronic = null;
    let chronicScore = 0;
    for (const row of rows) {
        const stats = _ndStatsForRow(row);
        if (stats.nAttempts < 3) continue;
        const missCount = stats.nAttempts - stats.hits;
        if (missCount < 3) continue;
        const sc = missCount * (1 - stats.hitRate);
        if (sc > chronicScore) {
            chronicScore = sc;
            chronic = { row, stats };
        }
    }
    if (chronic) {
        const { row, stats } = chronic;
        const mm = Math.floor(row.chartT / 60);
        const ss = Math.floor(row.chartT % 60).toString().padStart(2, '0');
        candidates.push({
            text: `Note at ${mm}:${ss} (${row.stringFret}) failed ${stats.nAttempts - stats.hits} of ${stats.nAttempts} plays. Slow this transition.`,
            detail: '',
            action: null,
            score: chronicScore * 5, // emphasize chronic-single-note signal
            signal: 'chronic_note',
        });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, 3);
}

// Render the top-3 prescriptions as the headline of the report. Action buttons
// route into existing flows: Save loop reuses _ndSaveSuggestedLoop, open_report
// just scrolls to an anchor inside the same panel.
function _ndRenderPrescriptionsBlock(top3) {
    if (!top3 || top3.length === 0) {
        return `<div class="bg-dark-800 border border-gray-700 rounded p-3 mb-3">
            <div class="text-gray-400 text-xs">Not enough data yet for actionable advice. Play through once or loop a section.</div>
        </div>`;
    }
    const rows = top3.map((p, i) => {
        let actionHtml = '';
        if (p.action) {
            if (p.action.kind === 'save_loop') {
                const { filename, start, end } = p.action.payload;
                const safeFn = (filename || '').replace(/'/g, "\\'");
                actionHtml = `<button onclick="_ndSaveSuggestedLoop('${safeFn}', ${start.toFixed(2)}, ${end.toFixed(2)}, this)"
                    class="px-2 py-0.5 bg-blue-900/40 hover:bg-blue-900/70 rounded text-blue-200 text-[11px] flex-shrink-0">${p.action.label}</button>`;
            } else if (p.action.kind === 'open_report' && p.action.payload?.anchor) {
                actionHtml = `<button onclick="document.getElementById('nd-anchor-${p.action.payload.anchor}')?.scrollIntoView({behavior:'smooth'})"
                    class="px-2 py-0.5 bg-dark-600 hover:bg-dark-500 rounded text-gray-200 text-[11px] flex-shrink-0">${p.action.label}</button>`;
            }
        }
        const tier = ['#f87171', '#fb923c', '#facc15'][i] || '#facc15';
        return `<div class="flex items-start gap-2 mb-2 last:mb-0">
            <span class="text-base font-bold mt-0.5" style="color:${tier}">${i + 1}.</span>
            <div class="flex-1 min-w-0">
                <div class="text-gray-100 text-sm">${p.text}</div>
                ${p.detail ? `<div class="text-gray-500 text-[10px] font-mono">${p.detail}</div>` : ''}
            </div>
            ${actionHtml}
        </div>`;
    }).join('');
    return `<div class="bg-dark-800 border border-orange-700/40 rounded p-3 mb-3">
        <div class="text-orange-400 text-xs font-semibold mb-2 uppercase tracking-wide">Top 3 things to fix</div>
        ${rows}
    </div>`;
}

// Tip card: top-left, slides in, auto-dismisses, click-to-expand. Throttled
// so a tight loop doesn't spam the user — only one card every 30s, and only
// if the top prescription scores above a quality threshold.
let _ndLastTipShownAt = 0;
const _ND_TIP_MIN_INTERVAL_MS = 30_000;
const _ND_TIP_MIN_SCORE = 5; // score below this = noise, don't bother
const _ND_TIP_DISPLAY_MS = 8_000;

function _ndShowTipCard(prescription) {
    if (!prescription || prescription.score < _ND_TIP_MIN_SCORE) return;
    const now = performance.now();
    if (now - _ndLastTipShownAt < _ND_TIP_MIN_INTERVAL_MS) return;
    _ndLastTipShownAt = now;

    let card = document.getElementById('nd-tip-card');
    if (card) card.remove();
    card = document.createElement('div');
    card.id = 'nd-tip-card';
    // Top-LEFT placement (top-right is occupied by HUD/other overlays).
    card.style.cssText = 'position:fixed;top:80px;left:16px;z-index:160;max-width:380px;'
        + 'background:rgba(20,20,28,0.95);border:1px solid rgba(251,146,60,0.5);'
        + 'border-radius:8px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,0.4);'
        + 'cursor:pointer;transition:opacity 0.3s;font-size:13px;color:#f3f4f6;';
    card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
            <div style="flex:1;min-width:0">
                <div style="color:#fb923c;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">Next thing to fix</div>
                <div style="line-height:1.35">${prescription.text}</div>
            </div>
            <button id="nd-tip-close" style="background:none;border:none;color:#9ca3af;cursor:pointer;font-size:18px;line-height:1;padding:0;flex-shrink:0">&times;</button>
        </div>
    `;
    card.onclick = (e) => {
        if (e.target && e.target.id === 'nd-tip-close') {
            card.remove();
            return;
        }
        card.remove();
        _ndShowReport();
    };
    document.body.appendChild(card);

    // Auto-dismiss with fade
    setTimeout(() => {
        if (!card.parentElement) return;
        card.style.opacity = '0';
        setTimeout(() => card.remove(), 320);
    }, _ND_TIP_DISPLAY_MS);
}

function _ndVerdictGlyph(kind) {
    if (kind === 'HIT') return { glyph: '✓', color: '#4ade80' };           // green
    if (kind === 'DIRTY_HIT') return { glyph: '⚠', color: '#facc15' };     // yellow
    if (kind === 'MISSED_WRONG_PITCH') return { glyph: '✗', color: '#fb923c' };  // orange
    if (kind === 'MISSED_NO_DETECTION') return { glyph: '∅', color: '#f87171' }; // red
    if (kind === 'ABSENT') return { glyph: '·', color: '#6b7280' };
    return { glyph: '', color: '#6b7280' };
}

// ── Failure-mode classifier ──────────────────────────────────────────────
// Each note in a play snapshot resolves to ONE primary failure mode (or
// CLEAN for perfect hits). The Practice Report's Top Issues tile
// aggregates these so the user knows what specifically to fix instead of
// staring at a matrix and guessing.
//
// The buckets are deliberately fingering-actionable: "WRONG_FRET" maps to
// a +/-1-3 semitone error (likely off-by-a-fret), "OPEN_STRING" surfaces
// the open-string-ringing pattern documented in test/string-hygiene.js,
// "WRONG_OCTAVE" catches the YIN octave-down failure mode that keeps
// showing up in real bass audio, etc.
const _ND_BASS_OPEN_STRING_MIDIS = new Set([28, 33, 38, 43]);
// Octave above each open string. YIN on a 4096-sample buffer at low bass
// frequencies (E1=41 Hz, A1=55 Hz) often locks onto the 2nd harmonic
// rather than the weak fundamental, so an unmuted ringing open A
// reads as A2 (MIDI 45) rather than A1. Detecting either pattern as
// OPEN_STRING contamination matches the underlying physics — same
// muting issue, different YIN output.
const _ND_BASS_OPEN_STRING_OCTAVE_MIDIS = new Set([40, 45, 50, 55]);

function _ndClassifyFailureMode(note) {
    const { primary, labels = [], pitchError, detectedMidi, expectedMidi } = note;

    if (primary === 'HIT') {
        if (labels.includes('LATE'))  return { mode: 'TIMING_LATE',  severity: 0.3 };
        if (labels.includes('EARLY')) return { mode: 'TIMING_EARLY', severity: 0.3 };
        if (labels.includes('SHARP')) return { mode: 'PITCH_SHARP',  severity: 0.3 };
        if (labels.includes('FLAT'))  return { mode: 'PITCH_FLAT',   severity: 0.3 };
        return { mode: 'CLEAN', severity: 0 };
    }
    if (primary === 'DIRTY_HIT') {
        return { mode: 'STRING_BLEED', severity: 0.6 };
    }
    if (primary === 'MISSED_NO_DETECTION') {
        if (note.siblingClaimed) {
            // Demotion case: the user plucked, but a same-pitch sibling
            // chart note nearby got the credit. Not a soft-attack issue —
            // a pacing / matcher accounting issue on rapid same-pitch
            // passages.
            return { mode: 'SIBLING_CLAIMED', severity: 0.7 };
        }
        return { mode: 'NO_PLUCK_OR_ONSET', severity: 1.0 };
    }
    if (primary === 'MISSED_WRONG_PITCH') {
        // Reconstruct what live YIN saw if detectedMidi is null on misses.
        const liveMidi = detectedMidi != null
            ? detectedMidi
            : (expectedMidi != null && pitchError != null
                ? Math.round(expectedMidi + pitchError / 100)
                : null);
        const semiOff = pitchError != null ? Math.round(pitchError / 100) : null;
        if (semiOff != null && Math.abs(semiOff) === 12) {
            return { mode: 'WRONG_OCTAVE', severity: 0.9 };
        }
        const liveIsOpen = liveMidi != null && _ND_BASS_OPEN_STRING_MIDIS.has(liveMidi);
        const liveIsOpenOctave = liveMidi != null && _ND_BASS_OPEN_STRING_OCTAVE_MIDIS.has(liveMidi);
        const expectedIsOpen = _ND_BASS_OPEN_STRING_MIDIS.has(expectedMidi)
            || _ND_BASS_OPEN_STRING_OCTAVE_MIDIS.has(expectedMidi);
        if ((liveIsOpen || liveIsOpenOctave) && !expectedIsOpen) {
            // Detected an open-string MIDI (or its 2nd harmonic via YIN
            // octave-up) when the chart expected a fretted note.
            return { mode: 'OPEN_STRING', severity: 1.0 };
        }
        if (semiOff != null && Math.abs(semiOff) <= 3) {
            return { mode: 'WRONG_FRET', severity: 0.9 };
        }
        return { mode: 'WRONG_PITCH', severity: 0.9 };
    }
    return { mode: 'UNKNOWN', severity: 0.5 };
}

// Human-readable description + suggested action for each failure mode.
// These show up in the Top Issues tile so the user knows what to do, not
// just what went wrong.
const _ND_FAILURE_MODE_INFO = {
    CLEAN:             { color: '#4ade80', label: 'Clean hits', advice: 'Perfect.' },
    TIMING_LATE:       { color: '#facc15', label: 'Late hits', advice: 'Try anticipating from the chart instead of waiting for visual cues.' },
    TIMING_EARLY:      { color: '#60a5fa', label: 'Early hits', advice: 'You\'re leading the beat. Hold on the upbeat for one extra moment before plucking.' },
    PITCH_SHARP:       { color: '#fb923c', label: 'Sharp hits', advice: 'Pitch reads above target. Check intonation / fret pressure.' },
    PITCH_FLAT:        { color: '#a78bfa', label: 'Flat hits', advice: 'Pitch reads below target. Press behind the fret, not on top.' },
    STRING_BLEED:      { color: '#facc15', label: 'String-hygiene leaks', advice: 'You hit the right note but another string was ringing. Right-hand mute the lower strings.' },
    OPEN_STRING:       { color: '#f87171', label: 'Open-string contamination', advice: 'Detection captured an open string (or its octave via YIN harmonic) when a fretted note was expected. Right-hand mute the lower strings — the unmuted string is ringing alongside your fretted note and dominating the audio.' },
    WRONG_FRET:        { color: '#fb923c', label: 'Wrong fret (1-3 semitones off)', advice: 'Hand position drifted by a fret or two. Slow the passage and check your fret-hand landing.' },
    WRONG_OCTAVE:      { color: '#fb923c', label: 'Octave error', advice: 'Detector or playing produced an octave displacement. If consistent, check for open-string ringing or YIN octave confusion.' },
    WRONG_PITCH:       { color: '#fb923c', label: 'Other wrong pitch', advice: 'Detection captured a pitch that doesn\'t match expected by more than 3 semitones.' },
    NO_PLUCK_OR_ONSET: { color: '#f87171', label: 'No detection', advice: 'No onset fired in the timing window. Either you didn\'t pluck or the attack was too soft to register.' },
    SIBLING_CLAIMED:   { color: '#fbbf24', label: 'Sibling-claimed (rapid same-pitch)', advice: 'You plucked, but the matcher gave the onset to a same-pitch chart note next to this one. Common in rapid same-pitch passages — not a playing error. Pipeline tradeoff: one onset, one chart note. Practice plays through it, the score lags.' },
    UNKNOWN:           { color: '#6b7280', label: 'Other', advice: '' },
};

// Slopsmith stores window.currentFilename URL-encoded but decodes before
// hitting /api/loops (app.js:958, 998). We have to match that or saved
// loops orphan in the DB and never appear in slopsmith's dropdown.
function _ndDecodedSongFilename() {
    const songInfo = highway.getSongInfo && highway.getSongInfo();
    const raw = (typeof window !== 'undefined' && window.currentFilename)
        || songInfo?.filename || '';
    try { return decodeURIComponent(raw); } catch (e) { return raw; }
}

// POST a suggested loop into slopsmith's persisted loops table so it shows
// up in the saved-loops dropdown next page-load. Slopsmith's /api/loops
// endpoint expects { filename, name, start, end }; auto-names if name
// is empty. Inline button click handler — `btn` is the button itself
// so we can flip it to "Saved" without a re-render.
async function _ndSaveSuggestedLoop(filename, start, end, btn) {
    if (!filename) {
        if (btn) { btn.textContent = 'No song'; btn.disabled = true; }
        return;
    }
    try {
        const r = await fetch('/api/loops', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, name: '', start, end }),
        });
        const data = await r.json();
        if (data.ok) {
            if (btn) {
                btn.textContent = `Saved: ${data.name}`;
                btn.disabled = true;
                btn.className = 'px-2 py-0.5 bg-green-900/40 rounded text-green-200 text-[11px]';
            }
        } else {
            if (btn) { btn.textContent = data.error || 'Failed'; }
        }
    } catch (e) {
        console.warn('[note_detect] Save loop failed:', e);
        if (btn) btn.textContent = 'Failed';
    }
}

async function _ndShowReport() {
    let panel = document.getElementById('nd-report-panel');
    if (panel) { panel.remove(); return; }

    const songId = _ndCurrentSongId();
    if (!songId) { alert('No song loaded'); return; }
    const plays = await _ndFetchPlays(songId);

    panel = document.createElement('div');
    panel.id = 'nd-report-panel';
    panel.className = 'fixed top-16 right-4 z-[150] bg-dark-700 border border-gray-600 rounded-xl p-4 shadow-2xl text-sm overflow-auto';
    panel.style.width = '720px';
    panel.style.maxHeight = '80vh';

    if (plays.length === 0) {
        panel.innerHTML = `
            <div class="flex justify-between items-center mb-2">
                <span class="text-gray-200 font-semibold">Practice Report — ${songId}</span>
                <button onclick="document.getElementById('nd-report-panel').remove()" class="text-gray-500 hover:text-white">&times;</button>
            </div>
            <p class="text-gray-400 text-xs">No plays recorded yet for this song. Play through the chart (or set an A/B loop and play several iterations) to populate the report.</p>
        `;
        document.body.appendChild(panel);
        return;
    }

    const { playMeta, rows } = _ndAggregatePlays(plays);
    const N = playMeta.length;
    let bestOfN = 0, perfectAcrossN = 0, cleanAcrossN = 0, neverHit = 0, dirtyTotal = 0;
    for (const row of rows) {
        const s = _ndStatsForRow(row);
        if (s.hits > 0) bestOfN++;
        if (s.hits === s.nAttempts && s.nAttempts === N) perfectAcrossN++;
        if (s.cleanHits === s.nAttempts && s.nAttempts === N) cleanAcrossN++;
        if (s.hits === 0) neverHit++;
        dirtyTotal += s.dirtyHits;
    }
    const total = rows.length;
    const loops = _ndSuggestLoops(rows);

    // Timing summary: just the median HIT timing. chartTime is already
    // avOffset-compensated upstream (highway.js setTime: chartTime =
    // audio.currentTime + avOffsetSec), so timingError directly reflects
    // the player's offset relative to the calibrated chart clock. We used
    // to compute a "Reaction residual = raw - avOffset + onsetComp" but
    // that subtraction was circular: increasing avOffset shifts raw by
    // the same amount, so the two cancel. The previous formula gave a
    // calibration-drift indicator, not a player-feedback metric.
    const hitTimings = [];
    for (const p of plays) {
        for (const r of p.noteResults || []) {
            if ((r.primary === 'HIT' || r.primary === 'DIRTY_HIT')
                    && typeof r.timingError === 'number') {
                hitTimings.push(r.timingError);
            }
        }
    }
    hitTimings.sort((a, b) => a - b);
    const p50Timing = hitTimings.length
        ? hitTimings[Math.floor((hitTimings.length - 1) * 0.5)]
        : null;
    const avOffsetMs = highway.getAvOffset ? highway.getAvOffset() : 0;

    // Label distribution across HITs: LATE / EARLY / SHARP / FLAT and the
    // residue (perfect-zone hits with no labels). Surfaces "how precisely
    // did I hit my hits?" — the existing matrix only shows hit-vs-miss.
    let nLate = 0, nEarly = 0, nSharp = 0, nFlat = 0, nClean = 0, nLabeledHits = 0;
    for (const p of plays) {
        for (const r of p.noteResults || []) {
            if (r.primary !== 'HIT' && r.primary !== 'DIRTY_HIT') continue;
            nLabeledHits++;
            const labels = r.labels || [];
            if (labels.includes('LATE')) nLate++;
            if (labels.includes('EARLY')) nEarly++;
            if (labels.includes('SHARP')) nSharp++;
            if (labels.includes('FLAT')) nFlat++;
            if (labels.length === 0) nClean++;
        }
    }
    const labelPct = (n) => nLabeledHits ? `${(n / nLabeledHits * 100).toFixed(0)}%` : '—';

    // Failure-mode aggregation across every note in the loaded plays.
    // Each note resolves to one mode; counts are sorted descending and
    // the top 5 surface in the Top Issues tile with concrete advice.
    const failureCounts = new Map();
    const failureExamples = new Map();   // mode → [{chartT, stringFret, expectedMidi, detected}, ...]
    let totalNotesEval = 0;
    for (const p of plays) {
        for (const r of p.noteResults || []) {
            const { mode } = _ndClassifyFailureMode(r);
            failureCounts.set(mode, (failureCounts.get(mode) || 0) + 1);
            if (!failureExamples.has(mode)) failureExamples.set(mode, []);
            const ex = failureExamples.get(mode);
            if (ex.length < 4) {
                const live = r.detectedMidi != null
                    ? r.detectedMidi
                    : (r.expectedMidi != null && r.pitchError != null
                        ? Math.round(r.expectedMidi + r.pitchError / 100)
                        : null);
                ex.push({
                    chartT: r.chartT,
                    sf: `s${r.s}/f${r.f}`,
                    expected: r.expectedMidi,
                    live,
                });
            }
            totalNotesEval++;
        }
    }
    const sortedFailures = [...failureCounts.entries()]
        .filter(([m]) => m !== 'CLEAN')
        .sort((a, b) => b[1] - a[1]);

    // Build the matrix HTML row by row.
    const matrixRows = rows.map(row => {
        const s = _ndStatsForRow(row);
        const cells = row.verdicts.map(v => {
            const g = _ndVerdictGlyph(v.kind);
            return `<span style="color:${g.color}; display:inline-block; width:14px; text-align:center; font-family:monospace;">${g.glyph}</span>`;
        }).join('');
        const tag = s.hits === s.nAttempts ? 'all'
            : s.hits === 0 ? 'none' : `${s.hits}/${s.nAttempts}`;
        return `
            <tr class="border-b border-gray-700/50 hover:bg-dark-600">
                <td class="text-gray-400 px-2 py-0.5 font-mono text-[11px]">${row.chartT.toFixed(2)}s</td>
                <td class="text-gray-300 px-1 py-0.5 font-mono text-[11px]">${row.expectedMidi}</td>
                <td class="text-gray-400 px-1 py-0.5 font-mono text-[11px]">${row.stringFret}</td>
                <td class="px-2 py-0.5">${cells}</td>
                <td class="text-gray-400 px-2 py-0.5 font-mono text-[11px]">${tag}</td>
            </tr>
        `;
    }).join('');

    // Suggested loops with embedded Save buttons. slopsmith's /api/loops
    // keys off `window.currentFilename` (the global JS var its own loop UI
    // uses) — `highway.getSongInfo().filename` is sometimes empty or shaped
    // differently. Prefer the global; fall back to song info; if both empty
    // the Save button reports "No song" and disables itself.
    const songFilename = _ndDecodedSongFilename();
    const loopsHtml = loops.length === 0
        ? '<p class="text-gray-500 text-xs">No suggested loops — no clusters of ≥2 trouble notes found.</p>'
        : loops.map(lp => {
            const noteListHtml = lp.notes.slice(0, 5).map(n => {
                const pct = ((1 - n.hitRate) * 100).toFixed(0);
                return `<li class="text-[11px] text-gray-400 font-mono">${n.chartT.toFixed(2)}s &nbsp;MIDI ${n.expectedMidi} &nbsp;${n.stringFret} &nbsp;${n.nAttempts - n.hits}/${n.nAttempts} (${pct}%)</li>`;
            }).join('');
            const safeFn = (songFilename || '').replace(/'/g, "\\'");
            return `
                <div class="bg-dark-800 border border-gray-700 rounded p-2 mb-2">
                    <div class="flex justify-between items-center mb-1">
                        <span class="text-gray-200 text-xs font-semibold">Loop ${lp.id}: ${lp.startSec.toFixed(1)}s–${lp.endSec.toFixed(1)}s
                            <span class="text-gray-500 font-normal">(${lp.durationSec.toFixed(1)}s, ${lp.noteCount} trouble notes, ${(lp.avgMissRate * 100).toFixed(0)}% avg miss)</span></span>
                        <button onclick="_ndSaveSuggestedLoop('${safeFn}', ${lp.startSec.toFixed(2)}, ${lp.endSec.toFixed(2)}, this)"
                            class="px-2 py-0.5 bg-blue-900/40 hover:bg-blue-900/70 rounded text-blue-200 text-[11px]">
                            Save loop
                        </button>
                    </div>
                    <div class="text-[11px] text-gray-500 mb-1">positions: ${lp.positions || '—'}</div>
                    <ul class="ml-4 list-disc">${noteListHtml}</ul>
                </div>
            `;
        }).join('');

    const top3 = _ndComputeTop3Prescriptions(plays, songFilename, avOffsetMs, _ndMicLatencyMs);
    const prescriptionsHtml = _ndRenderPrescriptionsBlock(top3);

    panel.innerHTML = `
        <div class="flex justify-between items-center mb-3">
            <span class="text-gray-200 font-semibold">Practice Report — ${songId}</span>
            <button onclick="document.getElementById('nd-report-panel').remove()" class="text-gray-500 hover:text-white">&times;</button>
        </div>
        ${prescriptionsHtml}
        <div class="text-xs text-gray-400 mb-3">${playMeta.length} attempts · ${rows.length} unique notes · matrix shows newest attempt first (left → right)</div>
        <div class="grid grid-cols-4 gap-2 mb-3 text-xs">
            <div class="bg-dark-800 rounded p-2"><div class="text-gray-500">Best-of-${N}</div><div class="text-green-400 font-semibold">${bestOfN}/${total} (${total ? (bestOfN/total*100).toFixed(0) : '0'}%)</div></div>
            <div class="bg-dark-800 rounded p-2"><div class="text-gray-500">Perfect</div><div class="text-blue-300 font-semibold">${perfectAcrossN}/${total} (${total ? (perfectAcrossN/total*100).toFixed(0) : '0'}%)</div></div>
            <div class="bg-dark-800 rounded p-2"><div class="text-gray-500">Clean every time</div><div class="text-emerald-300 font-semibold">${cleanAcrossN}/${total} (${total ? (cleanAcrossN/total*100).toFixed(0) : '0'}%)</div></div>
            <div class="bg-dark-800 rounded p-2"><div class="text-gray-500">Dirty hits</div><div class="text-yellow-300 font-semibold">${dirtyTotal}</div></div>
        </div>

        ${p50Timing != null ? (() => {
            const playerOffsetMs = Math.round(p50Timing - _ndMicLatencyMs);
            return `
        <div class="bg-dark-800 rounded p-3 mb-3 text-xs">
            <div id="nd-anchor-latency-stack" class="text-gray-400 mb-2">Timing breakdown</div>
            <div class="grid grid-cols-4 gap-2">
                <div>
                    <div class="text-gray-500 text-[10px]">Raw HIT timing (p50)</div>
                    <div class="text-gray-200 font-mono">${p50Timing > 0 ? '+' : ''}${Math.round(p50Timing)} ms</div>
                </div>
                <div>
                    <div class="text-gray-500 text-[10px]">Mic latency (calibrated)</div>
                    <div class="text-gray-300 font-mono">${_ndMicLatencyMs ? `${Math.round(_ndMicLatencyMs)} ms` : 'not run'}</div>
                </div>
                <div>
                    <div class="text-gray-500 text-[10px]">Player offset</div>
                    <div class="font-mono ${Math.abs(playerOffsetMs) > 75 ? 'text-orange-300' : Math.abs(playerOffsetMs) > 30 ? 'text-yellow-300' : 'text-green-400'}">${playerOffsetMs > 0 ? '+' : ''}${playerOffsetMs} ms</div>
                </div>
                <div>
                    <div class="text-gray-500 text-[10px]">Rolling drift</div>
                    <div class="text-purple-300 font-mono">${_ndDriftEstimateMs > 0 ? '+' : ''}${Math.round(_ndDriftEstimateMs)} ms</div>
                </div>
            </div>
            <div class="text-gray-500 text-[10px] mt-2 leading-tight">
                Player offset = raw HIT timing minus measured mic latency. ${_ndMicLatencyMs ? '' : 'Mic latency is 0 (not calibrated yet) — run <strong>Calibrate latency</strong> in the settings panel for a meaningful player-offset reading.'} Drift is a rolling-median compensation the matcher applies internally to keep the hit window aligned mid-session.
                ${Math.abs(_ndDriftEstimateMs) > 150
                    ? '<span class="text-purple-300"> Large drift — chart-vs-audio sync is significant.</span>'
                    : ''}
            </div>
        </div>
        `;})() : ''}

        ${nLabeledHits > 0 ? `
        <div class="bg-dark-800 rounded p-3 mb-3 text-xs">
            <div class="flex justify-between items-baseline mb-2">
                <span class="text-gray-400">Hit precision (label breakdown across ${nLabeledHits} hits)</span>
                <span class="text-gray-500 text-[10px]">a HIT can carry timing AND pitch labels</span>
            </div>
            <div class="grid grid-cols-5 gap-2">
                <div class="bg-dark-700 rounded p-2">
                    <div class="text-gray-500 text-[10px]">Clean (no label)</div>
                    <div class="text-emerald-300 font-mono">${nClean} (${labelPct(nClean)})</div>
                </div>
                <div class="bg-dark-700 rounded p-2">
                    <div class="text-gray-500 text-[10px]">LATE</div>
                    <div class="text-yellow-300 font-mono">${nLate} (${labelPct(nLate)})</div>
                </div>
                <div class="bg-dark-700 rounded p-2">
                    <div class="text-gray-500 text-[10px]">EARLY</div>
                    <div class="text-blue-300 font-mono">${nEarly} (${labelPct(nEarly)})</div>
                </div>
                <div class="bg-dark-700 rounded p-2">
                    <div class="text-gray-500 text-[10px]">SHARP</div>
                    <div class="text-orange-300 font-mono">${nSharp} (${labelPct(nSharp)})</div>
                </div>
                <div class="bg-dark-700 rounded p-2">
                    <div class="text-gray-500 text-[10px]">FLAT</div>
                    <div class="text-purple-300 font-mono">${nFlat} (${labelPct(nFlat)})</div>
                </div>
            </div>
            <div class="text-gray-500 text-[10px] mt-2 leading-tight">
                Labels fire when timing or pitch is outside the strictness preset's "perfect" zone (currently ±${_ndPerfectTimingMs}ms / ±${_ndPerfectPitchCent}¢). All five buckets above counted as HITs in the score; this tile shows precision, not pass/fail.
            </div>
        </div>
        ` : ''}

        ${sortedFailures.length > 0 ? `
        <div class="bg-dark-800 rounded p-3 mb-3 text-xs">
            <div id="nd-anchor-top-issues" class="text-gray-400 mb-2">Top issues this session — what to fix next</div>
            <div class="space-y-2">
                ${sortedFailures.slice(0, 5).map(([mode, count]) => {
                    const info = _ND_FAILURE_MODE_INFO[mode] || _ND_FAILURE_MODE_INFO.UNKNOWN;
                    const pct = totalNotesEval ? (count / totalNotesEval * 100).toFixed(0) : '0';
                    const exs = failureExamples.get(mode) || [];
                    const exampleStr = exs.slice(0, 3).map(e =>
                        `${e.chartT.toFixed(1)}s ${e.sf}${e.live != null ? ` (heard MIDI ${e.live})` : ''}`
                    ).join('  ·  ');
                    return `
                    <div class="bg-dark-700 rounded p-2">
                        <div class="flex justify-between items-baseline">
                            <span style="color:${info.color}" class="font-semibold">${info.label}</span>
                            <span class="text-gray-400 font-mono">${count} notes (${pct}%)</span>
                        </div>
                        ${info.advice ? `<div class="text-gray-300 text-[11px] mt-1">${info.advice}</div>` : ''}
                        ${exs.length > 0 ? `<div class="text-gray-500 text-[10px] mt-1 font-mono">examples: ${exampleStr}</div>` : ''}
                    </div>
                    `;
                }).join('')}
            </div>
            <div class="text-gray-500 text-[10px] mt-2 leading-tight">
                Each note resolves to one failure mode. CLEAN hits aren't shown here; this lists what's costing you points.
            </div>
        </div>
        ` : ''}

        <div class="text-gray-400 text-xs mb-1">Per-note attempt matrix (newest → oldest)</div>
        <div class="bg-dark-800 rounded p-1 mb-3 max-h-72 overflow-auto">
            <table class="w-full text-[11px]">
                <thead><tr class="text-gray-500 border-b border-gray-700">
                    <th class="text-left px-2 py-0.5">chartT</th>
                    <th class="text-left px-1 py-0.5">midi</th>
                    <th class="text-left px-1 py-0.5">s/f</th>
                    <th class="text-left px-2 py-0.5">attempts (newest → oldest)</th>
                    <th class="text-left px-2 py-0.5">hits</th>
                </tr></thead>
                <tbody>${matrixRows}</tbody>
            </table>
        </div>
        <div class="text-[10px] text-gray-500 mb-3">
            <span style="color:#4ade80">✓</span> clean HIT &nbsp;
            <span style="color:#facc15">⚠</span> dirty HIT &nbsp;
            <span style="color:#fb923c">✗</span> wrong pitch &nbsp;
            <span style="color:#f87171">∅</span> no detection &nbsp;
            <span style="color:#6b7280">·</span> absent
        </div>

        <div class="text-gray-400 text-xs mb-1">Suggested practice loops (densest miss clusters)</div>
        ${loopsHtml}
    `;
    document.body.appendChild(panel);
}

function _ndCheckAutoDump() {
    const now = performance.now() / 1000;
    const scoreT = highway.getTime ? highway.getTime() : -1;

    // Detect loop restart: score time jumped backward by >1s. Gated behind
    // a refractory so loop-wrap stutter (audio engine seek bouncing chart
    // time) doesn't fire 4-6 snapshots per real iteration.
    const sinceLastRestart = now - _ndLastLoopRestart;
    if (_ndLastSeenScoreTime > 0 && scoreT >= 0 && scoreT < _ndLastSeenScoreTime - 1
            && sinceLastRestart > _ND_LOOP_RESTART_REFRACTORY_SEC) {
        if (_ndEventLog.length >= _ND_AUTO_DUMP_MIN_EVENTS) {
            console.log('[note_detect] Loop restart detected, auto-dumping');
            _ndAutoDumpPost();
        }
        // Per-play snapshot: each loop iteration is a discrete "play" for
        // the cross-play heatmap. Clears _ndNoteResults so the next iteration
        // re-judges from scratch (without this, the existing
        // _ndNoteResults.has(key) guard at the matching site would make the
        // first iteration's result stick across all subsequent loops).
        // After the snapshot lands, surface the top prescription as a tip
        // card so the user gets actionable feedback per iteration without
        // having to open the full report.
        _ndSnapshotPlay('loop_restart').then(() => {
            const songId = _ndCurrentSongId();
            if (!songId) return;
            return _ndFetchPlays(songId).then(plays => {
                const songFilename = _ndDecodedSongFilename();
                const avOffsetMs = highway.getAvOffset ? highway.getAvOffset() : 0;
                const top3 = _ndComputeTop3Prescriptions(plays, songFilename, avOffsetMs, _ndMicLatencyMs);
                if (top3.length > 0) _ndShowTipCard(top3[0]);
            });
        }).catch(() => { /* swallow — tip is optional */ });
        _ndLastLoopRestart = now;
    }
    _ndLastSeenScoreTime = scoreT;

    // Periodic dump every 30s if there's data
    if (now - _ndLastDumpTime > _ND_AUTO_DUMP_INTERVAL && _ndEventLog.length >= _ND_AUTO_DUMP_MIN_EVENTS) {
        _ndAutoDumpPost();
    }
}

function _ndArrangementKindFromName(name) {
    return /bass/i.test(String(name || '')) ? 'bass' : 'guitar';
}

function _ndSetArrangement(name) {
    _ndCurrentArrangement = _ndArrangementKindFromName(name);
}

function _ndStandardMidiFor(arrangement) {
    return arrangement === 'bass' ? _ndStandardMidiBass : _ndStandardMidiGuitar;
}

// Audio processing — use native sample rate, accumulate samples for YIN
let _ndAccumBuffer = new Float32Array(0);  // accumulates samples across frames
const _ndMinYinSamples = 4096;  // enough for low E at 48kHz (need tau=585, halfLen=2048)
const _ndFrameSize = 2048;  // ScriptProcessor buffer size

// 30–250 Hz band-pass before YIN. Offline test/song-ceiling-roster.js
// found this lifts the audio-truth ceiling 26–58pp on every fixture
// (Stand by Me 57→94, Take On Me 23→80, Bulls on Parade 32→71). Raw
// YIN gets ~0 confidence on heavily-mastered or distorted-band mixes
// because guitar/drum overtones overwhelm the bass fundamental;
// band-passing isolates the bass band before YIN. See
// docs/SONG_PIPELINE_CEILING.md "Band-pass pre-filter".
//
// Applied incrementally per audio chunk with persistent filter state
// (cascading two 2nd-order Butterworth biquads each direction = 24 dB/oct
// rolloff). State must NOT reset across chunks — discontinuities ring at
// 30 Hz and YIN locks onto the filter transient. Only reset on audio
// context restart.
//
// Onset detection, silence gate, and recording all consume the RAW input.
// Only the YIN accumulator gets the filtered version.
const _ND_BP_LOW_HZ = 30;
const _ND_BP_HIGH_HZ = 250;
let _ndBpEnabled = true;
let _ndBpCoefsHp = null;
let _ndBpCoefsLp = null;
const _ndBpHp1 = { x1: 0, x2: 0, y1: 0, y2: 0 };
const _ndBpHp2 = { x1: 0, x2: 0, y1: 0, y2: 0 };
const _ndBpLp1 = { x1: 0, x2: 0, y1: 0, y2: 0 };
const _ndBpLp2 = { x1: 0, x2: 0, y1: 0, y2: 0 };

function _ndBiquadCoefs(type, fc, sampleRate) {
    const w0 = 2 * Math.PI * fc / sampleRate;
    const cs = Math.cos(w0), sn = Math.sin(w0);
    const Q = Math.SQRT1_2;
    const alpha = sn / (2 * Q);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'highpass') {
        b0 = (1 + cs) / 2;  b1 = -(1 + cs);  b2 = (1 + cs) / 2;
        a0 = 1 + alpha;     a1 = -2 * cs;    a2 = 1 - alpha;
    } else {
        b0 = (1 - cs) / 2;  b1 = 1 - cs;     b2 = (1 - cs) / 2;
        a0 = 1 + alpha;     a1 = -2 * cs;    a2 = 1 - alpha;
    }
    return [b0/a0, b1/a0, b2/a0, a1/a0, a2/a0];
}

function _ndApplyBiquadSample(state, coefs, x) {
    const [b0, b1, b2, a1, a2] = coefs;
    const y = b0*x + b1*state.x1 + b2*state.x2 - a1*state.y1 - a2*state.y2;
    state.x2 = state.x1; state.x1 = x;
    state.y2 = state.y1; state.y1 = y;
    return y;
}

function _ndResetBpFilter(sampleRate) {
    _ndBpCoefsHp = _ndBiquadCoefs('highpass', _ND_BP_LOW_HZ, sampleRate);
    _ndBpCoefsLp = _ndBiquadCoefs('lowpass', _ND_BP_HIGH_HZ, sampleRate);
    for (const s of [_ndBpHp1, _ndBpHp2, _ndBpLp1, _ndBpLp2]) {
        s.x1 = 0; s.x2 = 0; s.y1 = 0; s.y2 = 0;
    }
    if (_ndBpEnabled) {
        console.log(`[note_detect] YIN pre-filter: ${_ND_BP_LOW_HZ}-${_ND_BP_HIGH_HZ} Hz band-pass @ ${sampleRate} Hz (4th-order Butterworth)`);
    }
}

function _ndApplyBpToChunk(input) {
    if (!_ndBpEnabled || !_ndBpCoefsHp) return input;
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
        let y = _ndApplyBiquadSample(_ndBpHp1, _ndBpCoefsHp, input[i]);
        y = _ndApplyBiquadSample(_ndBpHp2, _ndBpCoefsHp, y);
        y = _ndApplyBiquadSample(_ndBpLp1, _ndBpCoefsLp, y);
        y = _ndApplyBiquadSample(_ndBpLp2, _ndBpCoefsLp, y);
        out[i] = y;
    }
    return out;
}

// Onset detection — flush buffer when a new pluck is detected
// Without this, the 4096-sample buffer contains ~85ms of audio. On sustained
// bass notes, when you pluck a new note the buffer is still 90%+ old sustain
// and YIN reports the PREVIOUS note's pitch.
// Threshold-crossing with hysteresis. The previous ratio-against-history
// detector had a warm-up bug: it needed N frames of history before it could
// evaluate a ratio, so fresh attacks after silence never fired (history was
// empty or sparse). Threshold-crossing handles silence→attack cleanly.
// Verified behaviour is logged in docs/NOTEDETECT_IMPLEMENTATION_GAPS.md.
const _ND_ONSET_LEVEL = 0.04;         // RMS above this = entering a note (silence→playing transition)
const _ND_ONSET_EXIT_LEVEL = 0.02;    // below this = note ended (hysteresis gap prevents re-fire on sustain noise)
const _ND_ONSET_BUFFER_COMP_SEC = 0.020; // half of ScriptProcessor 2048-sample buffer at 48 kHz — compensates for callback lag

// DEPRECATED — left in place for the offline harness's "what would the
// pre-cleanup display have shown" comparison. Don't call from live code.
//
// The earlier display layer subtracted avOffset back out of timingError
// to expose a "player residual." That was circular: chartTime in the
// matcher is already avOffset-shifted (highway.js setTime), so timingError
// already accounts for the calibration. Changing avOffset shifts raw
// timing by the same amount this formula subtracts; the two cancel and
// the result is a calibration-drift indicator (≈ output_latency - 20ms),
// not a player metric. Live display now uses timingError directly.
function _ndResidualMs(rawMs, avOffsetMs) {
    if (typeof rawMs !== 'number' || !isFinite(rawMs)) return rawMs;
    const onsetCompMs = _ND_ONSET_BUFFER_COMP_SEC * 1000;
    return rawMs - (avOffsetMs || 0) + onsetCompMs;
}

// ── AV-offset auto-calibrator ────────────────────────────────────────────
// Watches HIT timing errors, computes the residual median, and nudges
// slopsmith's avOffset until the player's pipeline-corrected offset
// converges near zero. Multi-round so a single noisy sample doesn't
// over-shoot. Persists via /api/settings + slopsmith's setAvOffsetMs so
// the value survives reload.
//
// Convergence: 3 rounds × 30 hits, or stop early when |median residual|
// drops below 10ms. Each round adjusts avOffset by the round's median
// residual, so the next round's residual centers nearer zero.
let _ndCalibrating = false;
let _ndCalibBuffer = [];
let _ndCalibRound = 0;
let _ndCalibStartAvOffset = 0;
const _ND_CALIB_SAMPLES_PER_ROUND = 30;
const _ND_CALIB_MAX_ROUNDS = 3;
const _ND_CALIB_CONVERGED_MS = 10;

function _ndStartAvCalibration() {
    if (_ndCalibrating) {
        console.log('[note_detect] Calibration already in progress');
        return;
    }
    if (!_ndEnabled) {
        alert('Turn on Detect first, then start calibrating.');
        return;
    }
    _ndCalibrating = true;
    _ndCalibBuffer = [];
    _ndCalibRound = 1;
    _ndCalibStartAvOffset = highway.getAvOffset ? highway.getAvOffset() : 0;
    console.log(`[note_detect] AV calibration started — ${_ND_CALIB_SAMPLES_PER_ROUND} hits/round, max ${_ND_CALIB_MAX_ROUNDS} rounds. Starting avOffset: ${_ndCalibStartAvOffset}ms`);
    _ndUpdateCalibStatus(`Calibrating: 0/${_ND_CALIB_SAMPLES_PER_ROUND} (round 1)`);
}

function _ndStopAvCalibration(reason) {
    if (!_ndCalibrating) return;
    _ndCalibrating = false;
    _ndCalibBuffer = [];
    console.log(`[note_detect] AV calibration stopped: ${reason}`);
    _ndUpdateCalibStatus(reason);
}

// Called from the HIT path on every successful match while calibrating.
// rawMs is timingError before residual subtraction so the running
// adjustment of avOffset is already reflected in subsequent samples.
function _ndCalibrationFeedHit(rawMs) {
    if (!_ndCalibrating) return;
    if (typeof rawMs !== 'number' || !isFinite(rawMs)) return;
    _ndCalibBuffer.push(rawMs);
    _ndUpdateCalibStatus(`Calibrating: ${_ndCalibBuffer.length}/${_ND_CALIB_SAMPLES_PER_ROUND} (round ${_ndCalibRound})`);
    if (_ndCalibBuffer.length < _ND_CALIB_SAMPLES_PER_ROUND) return;
    _ndCalibrationFinishRound();
}

function _ndCalibrationFinishRound() {
    const sorted = _ndCalibBuffer.slice().sort((a, b) => a - b);
    const medianRaw = sorted[Math.floor((sorted.length - 1) * 0.5)];
    const currentAvOffset = highway.getAvOffset ? highway.getAvOffset() : 0;
    console.log(`[note_detect] Calibration round ${_ndCalibRound}: median timing=${Math.round(medianRaw)}ms (avOffset=${currentAvOffset}ms)`);

    if (Math.abs(medianRaw) < _ND_CALIB_CONVERGED_MS) {
        _ndStopAvCalibration(`Converged: median timing ${Math.round(medianRaw)}ms (avOffset ${currentAvOffset}ms)`);
        _ndPersistAvOffset(currentAvOffset);
        return;
    }
    if (_ndCalibRound >= _ND_CALIB_MAX_ROUNDS) {
        _ndStopAvCalibration(`Max rounds reached: median timing ${Math.round(medianRaw)}ms (avOffset ${currentAvOffset}ms)`);
        _ndPersistAvOffset(currentAvOffset);
        return;
    }

    // Closed-loop calibration: chartTime = audio.currentTime + avOffsetSec
    // (slopsmith app.js:506). Increasing avOffset by Δ shifts chart-time
    // forward by Δ, which makes future timingError = onsetChartT - chartNote.t
    // INCREASE by Δ. To drive median(timingError) toward 0, *subtract* the
    // current median from avOffset. (The earlier `+= residual` math was
    // circular — residual = raw - avOffset, so adding it to avOffset
    // changed raw by the same amount and never converged in real usage.)
    const newAvOffset = Math.max(-1000, Math.min(1000, currentAvOffset - Math.round(medianRaw)));
    _ndApplyAvOffset(newAvOffset);
    console.log(`[note_detect] Calibration round ${_ndCalibRound}: avOffset ${currentAvOffset} → ${newAvOffset}ms`);

    _ndCalibBuffer = [];
    _ndCalibRound++;
}

function _ndApplyAvOffset(ms) {
    if (typeof setAvOffsetMs === 'function') {
        setAvOffsetMs(ms);
    } else if (highway.setAvOffset) {
        highway.setAvOffset(ms);
    }
}

async function _ndPersistAvOffset(ms) {
    try {
        await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ av_offset_ms: ms }),
        });
        console.log(`[note_detect] AV offset persisted: ${ms}ms`);
    } catch (e) {
        console.warn('[note_detect] AV offset persist failed:', e);
    }
}

function _ndUpdateCalibStatus(text) {
    const el = document.getElementById('nd-calib-status');
    if (el) el.textContent = text || '';
}
// Sustain re-attack detection — fires a new onset when RMS spikes above the
// recent running minimum during an in-progress note. Needed for repeated
// plucks (Mexico bass is dense same-pitch E-string repeats) where sustain
// keeps _ndInNote true between plucks, blocking the silence→playing trigger.
// Validated via test/classify-session.js: 24 MISSED_NO_DETECTION notes in a
// full Mexico play all had pre-attack RMS above the hysteresis exit level,
// which is exactly the regime this handles.
// Tuning: a bass attack envelope has a primary transient at ~20 ms, a
// settling period of ~100 ms, then a secondary body-resonance peak that
// can rebound by 1.5-1.8× above the local trough. Refractory has to cover
// the whole envelope (~200 ms) to avoid the detector firing a spurious
// second onset during that rebound. Ratio 2.0 provides headroom: a real
// re-pluck during sustain produces ≥3× spike above the decaying tail.
// Bass repeats at 16th notes / 120 BPM = 125 ms apart — too fast for this
// refractory, but Mexico's gaps are 200+ ms so 200 ms works here.
const _ND_REATTACK_RATIO = 2.0;
const _ND_REATTACK_REFRACTORY_SEC = 0.200;
// Tightened refractory used when the chart has another note coming up
// within _ND_FAST_REPEAT_LOOKAHEAD_SEC. Bass repeats at 16th notes / 120 BPM
// are 125 ms apart — too fast for the 200 ms baseline. Chart-aware
// loosening lets rapid same-pitch passages (Gasoline's bridge line is full
// of MIDI-38 repeats at ~350 ms; faster songs go below 200 ms) register
// every pluck instead of dropping every other one to refractory.
const _ND_REATTACK_REFRACTORY_FAST_SEC = 0.080;
const _ND_FAST_REPEAT_LOOKAHEAD_SEC    = 0.250;
const _ND_REATTACK_MIN_LEVEL = 0.04;
const _ND_REATTACK_WINDOW = 4;
// Release-before-retrigger: after any onset fires, another re-attack can't
// fire until RMS has dipped below _ND_REATTACK_REARM_LEVEL at least once.
// Prevents the cascade where a noisy body-peak during sustain fires a
// spurious re-attack, its 200 ms refractory keeps the real next-pluck's
// onset blocked. The Level session showed 5 clean plucks (peak RMS 0.19-0.25,
// attack-vs-preattack ratio 50-250×) that the pipeline missed — hypothesis
// is chained spurious body-peak retriggers blocked them via refractory.
// Re-arm threshold matches the exit level (0.02). A bump to 0.03 was
// briefly tried based on test/onset-probe.js, but follow-up simulation
// (test/onset-sim.js) showed the probe was misclassifying: at 43 ms
// chunk granularity the prior note's sustain envelopes the next pluck
// so the ratio collapses to ~1.0 and trigger 2 fails regardless of
// rearm level. No fixed rearm threshold separates "released" from
// "in-flight pluck" reliably during dense passages — fixing it cleanly
// needs spectral-flux onset detection or a chart-time-guided onset hint.
// Reverting to 0.02 to keep the simpler heuristic and avoid false fires.
const _ND_REATTACK_REARM_LEVEL = 0.02;
let _ndReattackArmed = true;          // true when a release has been seen since last onset
// Fallback-path stability-vote compensation. The onset path uses the onset's
// chart time directly; fallback only triggers when no onset fired, and at
// that point we estimate the pluck happened just before stability converged.
// A small fixed lag (~50 ms) matches real pipeline behaviour. NOT the same
// as _ndDetectionLatencySec, which was the legacy calibration-wizard value
// that shifted scoring 500 ms into the past and forced users to play late.
const _ND_FALLBACK_STABILITY_LAG_SEC = 0.05;
let _ndInNote = false;                // are we currently inside a detected note?
let _ndPendingOnsetChartT = null;     // chart time of the most recent onset, cleared when consumed by _ndMatchNotes
let _ndLastOnsetPerfNow = 0;          // performance.now()/1000 of the last onset (for refractory)
let _ndReattackRmsBuf = [];           // running RMS window for the re-attack detector

// ── localStorage Persistence ──────────────────────────────────────────────

const _ndStorageKey = 'slopsmith_notedetect';

function _ndSaveSettings() {
    try {
        localStorage.setItem(_ndStorageKey, JSON.stringify({
            deviceId: _ndSelectedDeviceId,
            channel: _ndSelectedChannel,
            method: _ndDetectionMethod,
            timingTolerance: _ndTimingTolerance,
            pitchTolerance: _ndPitchTolerance,
            inputGain: _ndInputGain,
            latencyOffset: _ndDetectionLatencySec,
            silenceGate: _ndSilenceGate,
            pitchOffset: _ndPitchOffset,
            autoDetectOnPlay: _ndAutoDetectOnPlay,
            autoRecordOnPlay: _ndAutoRecordOnPlay,
            strictness: _ndStrictness,
            dirtyHitMaxOffRatio: _ndDirtyHitMaxOffRatio,
            clickTrackOnly: _ndClickTrackOnly,
            micLatencyMs: _ndMicLatencyMs,
        }));
    } catch (e) { /* localStorage unavailable */ }
}

function _ndLoadSettings() {
    try {
        const raw = localStorage.getItem(_ndStorageKey);
        if (!raw) return;
        const s = JSON.parse(raw);
        if (s.deviceId !== undefined) _ndSelectedDeviceId = s.deviceId;
        if (s.channel) _ndSelectedChannel = s.channel;
        if (s.method) _ndDetectionMethod = s.method;
        if (s.timingTolerance !== undefined) _ndTimingTolerance = s.timingTolerance;
        if (s.pitchTolerance !== undefined) _ndPitchTolerance = s.pitchTolerance;
        if (s.inputGain !== undefined) _ndInputGain = s.inputGain;
        if (s.latencyOffset !== undefined) {
            // Legacy field. The old calibration-wizard flow set this to ~500-
            // 600 ms and the score code subtracted it from chart-time when
            // matching. With slopsmith's chart-clock now applying avOffset
            // (fix/loop-count-in-bpm @ 8d8c299) and the plugin's drift-
            // compensation (rolling-median timing) handling residual offsets
            // adaptively, the legacy value just stacks on top and corrupts
            // scoring. Force-zero on load — saved value is read but ignored.
            _ndDetectionLatencySec = 0;
        }
        if (s.silenceGate !== undefined) _ndSilenceGate = s.silenceGate;
        if (s.pitchOffset !== undefined) {
            // Reject saved offsets > ±1 — they're from the feedback loop bug
            _ndPitchOffset = Math.abs(s.pitchOffset) <= 1 ? s.pitchOffset : 0;
        }
        if (s.autoDetectOnPlay !== undefined) _ndAutoDetectOnPlay = !!s.autoDetectOnPlay;
        if (s.autoRecordOnPlay !== undefined) _ndAutoRecordOnPlay = !!s.autoRecordOnPlay;
        if (s.strictness !== undefined) _ndStrictness = s.strictness;
        if (s.dirtyHitMaxOffRatio !== undefined) _ndDirtyHitMaxOffRatio = s.dirtyHitMaxOffRatio;
        if (s.micLatencyMs !== undefined && isFinite(Number(s.micLatencyMs))) {
            _ndMicLatencyMs = Number(s.micLatencyMs);
        }
        // clickTrackOnly intentionally NOT loaded — it's a per-session
        // training toggle, not a persistent default. Reload starts with
        // song audio enabled.
    } catch (e) { /* ignore */ }
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

function _ndClassifyTiming(timingErrorMs, timingThresholdMs, lateGraceMs) {
    if (!Number.isFinite(timingErrorMs)) return null;
    const grace = Number.isFinite(lateGraceMs) && lateGraceMs > 0 ? lateGraceMs : 0;
    // Asymmetric for sus-marked notes (caller passes grace > 0): the
    // EARLY side stays strict — playing before the note is always
    // wrong — but late detection within the sustain envelope is still
    // a hit, because the note is *audibly* the right one. Without this,
    // a player who plucks a few hundred ms after the chart time on a
    // half-note (which YIN may take ~100 ms to confidently lock) gets
    // a LATE miss even though they're hearing themselves play the
    // correct note over the strike-line ring.
    if (timingErrorMs < 0) {
        return Math.abs(timingErrorMs) <= timingThresholdMs ? 'OK' : 'EARLY';
    }
    return timingErrorMs <= timingThresholdMs + grace ? 'OK' : 'LATE';
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
    const timingThresholdMs = Number.isFinite(o.timingThresholdMs) ? o.timingThresholdMs : 100;
    const pitchThresholdCents = Number.isFinite(o.pitchThresholdCents) ? o.pitchThresholdCents : 20;
    // Derive late-side grace from the chart note's sustain. Capped at
    // 1 s so a 4-second held note doesn't accept detections nearly 4
    // seconds late as "on time" — at some point the player has clearly
    // missed the strike and is just holding the previous note's ring.
    //
    // For chord judgments, the caller passes an explicit `lateGraceMs`
    // computed from the MAX sus across chord constituents (matching
    // matchNotes' candidate-inclusion + checkMisses' retire-extension
    // grace). Without that override, this falls back to the chart
    // note's own sus, which for chords is just the first constituent
    // (`liveNotes[0]`) — and a chord whose lead has a shorter sus than
    // its longest constituent would get classified LATE here even
    // though it was still inside the chord's matching window.
    const chartNote = o.chartNote || o.note || null;
    const susSec = chartNote && Number.isFinite(chartNote.sus) ? chartNote.sus : 0;
    const lateGraceMs = Number.isFinite(o.lateGraceMs)
        ? Math.max(0, o.lateGraceMs)
        : (susSec > 0 ? Math.min(susSec * 1000, 1000) : 0);
    const timingState = matched ? _ndClassifyTiming(timingError, timingThresholdMs, lateGraceMs) : null;
    const pitchState = matched ? _ndClassifyPitch(pitchError, pitchThresholdCents) : null;
    // pitchState === null means pitch was not measured (e.g. energy-only chord
    // check or harmonic flag).  Treat unmeasured pitch as non-blocking so a
    // chord that passes the scorer is not incorrectly counted as a miss.
    //
    // For CHORDS specifically: the chord scorer (_ndScoreChord) already
    // ran per-string pitch + energy checks before this judgment was
    // constructed. matchNotes only takes the chord-hit path when the
    // scorer returned isHit (score ≥ chordHitRatio). If we *also* gate
    // the overall hit on the monophonic pitchState computed from a
    // SINGLE string's pitchError (the first one with a finite cents
    // measurement), we throw away clean chord hits whenever the lead
    // string happens to be a bit sharp/flat — even when every string
    // rang and the chord scorer said yes. Trust the chord scorer's
    // verdict here. For single notes the original timing+pitch rule
    // still applies.
    const isChord = !!o.chord;
    const hit = isChord
        ? (matched && timingState === 'OK')
        : (timingState === 'OK' && (pitchState === 'OK' || pitchState === null));
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

// Strictness presets. Each level pins pitch + timing tolerance and the
// dirty-hit threshold (max fraction of off-target frames before a hit
// downgrades to DIRTY_HIT).
//
//   rocksmith — almost any in-window pluck counts. Pitch tolerance is
//               2400¢ (2 octaves) so even YIN's octave-down errors pass.
//               Empirically lifts a Level session from 69% → ~90%
//               by absorbing the ~13% PIPELINE_YIN_DISAGREES bucket
//               without changing what the player did. Use when the
//               pipeline is misreading clean playing.
//   easy     — Rocksmith-ish but with real pitch matching at 100¢.
//              Catches gross fretting errors (>1 semitone), accepts
//              YIN minor-third confusion.
//   default  — 50¢ pitch / 150ms timing, dirty trips at 50% off-target.
//   strict   — 25¢ / 100ms, dirty trips at 30% off-target. Mastery
//              validation, surfaces every hygiene leak.
// Each preset also pins the LATE/EARLY/SHARP/FLAT label thresholds so the
// "perfect" zone scales with how lenient the hit window is. Otherwise the
// hard-coded 50 ms perfect threshold fires LATE on hits comfortably inside a
// 300 ms Easy window, making the highway feel angry even when the score is
// fine. perfectTimingMs is roughly window/3 — the "core" of each window.
const _ND_STRICTNESS_PRESETS = {
    rocksmith: { pitchTolerance: 2400, timingTolerance: 0.400, dirtyHitMaxOffRatio: 1.0, perfectTimingMs: 200, perfectPitchCent: 100 },
    easy:      { pitchTolerance:  100, timingTolerance: 0.300, dirtyHitMaxOffRatio: 1.0, perfectTimingMs: 100, perfectPitchCent:  50 },
    default:   { pitchTolerance:   50, timingTolerance: 0.150, dirtyHitMaxOffRatio: 0.5, perfectTimingMs:  50, perfectPitchCent:  20 },
    strict:    { pitchTolerance:   25, timingTolerance: 0.100, dirtyHitMaxOffRatio: 0.3, perfectTimingMs:  25, perfectPitchCent:  10 },
};

function _ndApplyStrictness(level) {
    const preset = _ND_STRICTNESS_PRESETS[level];
    if (!preset) return;
    _ndStrictness = level;
    _ndPitchTolerance = preset.pitchTolerance;
    _ndTimingTolerance = preset.timingTolerance;
    _ndDirtyHitMaxOffRatio = preset.dirtyHitMaxOffRatio;
    _ndPerfectTimingMs = preset.perfectTimingMs;
    _ndPerfectPitchCent = preset.perfectPitchCent;
    _ndSaveSettings();
    // Re-render the settings panel so the tolerance fields show the new values.
    const panel = document.getElementById('nd-settings-panel');
    if (panel) { panel.remove(); _ndShowSettings(); }
}

// Initial sync — load may have set _ndStrictness; apply that preset's perfect
// thresholds so the labels match it from the start.
(function () {
    const preset = _ND_STRICTNESS_PRESETS[_ndStrictness];
    if (preset) {
        _ndPerfectTimingMs = preset.perfectTimingMs;
        _ndPerfectPitchCent = preset.perfectPitchCent;
    }
})();

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

    // Octave-down validation — on a sustained bass note, the 2nd harmonic can
    // exceed the fundamental in amplitude within ~500 ms of pluck attack. Stock
    // YIN picks the smallest tau crossing the threshold, which matches the
    // harmonic and reports one octave up (e.g. E1 41 Hz → E2 82 Hz).
    //
    // Diagnostic data on test/fixtures/ground-truth/open-strings.wav (E1
    // sustain) vs a bass-harmonic 82 Hz test signal with weak fundamental:
    //   E1 sustain:  yinBuffer[582] = 0.149, yinBuffer[1169] = 0.0007 (200× deeper)
    //   E2 harmonic: yinBuffer[582] = 0.042, yinBuffer[1164] = 0.041 (1.02× deeper)
    // Both cases have a deeper dip at 2×tau, but only E1's is dramatically
    // deeper. The ratio is the signal. Only accept the longer period when it
    // is *significantly* deeper than the first pick — that's a clear
    // "harmonic vs fundamental" indicator rather than "signal is still
    // periodic at 2 × true period" (which applies to any periodic signal).
    //
    // OCTAVE_DIP_RATIO tightened to 0.1 (was 0.5) after a sustain-to-new-pluck
    // transition in Mexico produced MIDI 26 (subharmonic of 38) where the
    // audio contained clean MIDI 38. Analysis of the failure:
    //   E1 sustain (switch desired): fund dip 0.0007, harmonic dip 0.149 → ratio 0.005
    //   E2 bass-harmonic (skip desired): ratio 0.976
    //   MIDI 38+36 mixed (skip desired): fund dip 0.08, 2×tau dip 0.03 → ratio 0.375
    // The old 0.5 threshold let the mixed-sustain case through. 0.1 requires
    // the 2×tau dip to be a full 10× deeper, which happens on a true harmonic
    // alias but not on coincidental LCM alignments between two different
    // sustained periods in the buffer. Clean E1 still passes by 20× margin.
    const OCTAVE_DIP_RATIO = 0.1;
    const baselineDip = yinBuffer[tau];
    for (const multiplier of [2, 3]) {
        const candidate = tau * multiplier;
        if (candidate >= halfLen) break;
        // Local-minimum refinement within ±10% of the candidate. Catches
        // cases where the octave-down minimum is slightly off an integer
        // multiple (detuning, parabolic interpolation shift on the first pick).
        const lo = Math.max(tau + 1, Math.floor(candidate * 0.9));
        const hi = Math.min(halfLen - 1, Math.ceil(candidate * 1.1));
        let localTau = -1;
        let localDip = Infinity;
        for (let k = lo; k <= hi; k++) {
            if (yinBuffer[k] < localDip) { localDip = yinBuffer[k]; localTau = k; }
        }
        if (localTau < 0) continue;
        if (localDip < threshold && localDip < baselineDip * OCTAVE_DIP_RATIO) {
            tau = localTau;
            break; // prefer the nearest octave-down we find (2× before 3×)
        }
    }

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

    // ── Voicing-reduction credit ─────────────────────────────────────
    // The strict score-ratio path counts "how much of the chart's full
    // voicing rang". For a chart that says "E major, all 6 strings", a
    // player who plays the same chord as a 2-string power voicing
    // (E + B = root + fifth on strings 0 and 1) scores 2/6 = 0.33 and
    // misses at the default cr=0.40. That's musically wrong for huge
    // categories of real playing — punk / pop-rock / country rhythm
    // guitar IS root + fifth voicings on full-chord charts. Real-song
    // data (American Jesus, Bad Religion rhythm, 1033 chord events)
    // showed ~50% of misses landing in exactly this 1-2-of-N regime,
    // while having clean timing and ringing the root every time.
    //
    // Add a parallel hit path: the chord ALSO counts as a hit if at
    // least 2 of the chord's strings rang at their expected pitches
    // (pitch-verified, not energy-only). This rewards reduced
    // voicings without rewarding random-string noise:
    //   • Single string alone → still a miss
    //   • Any ≥2 pitch-verified chord strings (in any combination) → hit
    //   • Full voicing → hit via ratio (the original path)
    //
    // Strict players who want "all strings must ring" can dial cr up
    // to 1.0. The pitch-verified gate (vs. raw energy) keeps incidental
    // noise from tripping the rescue path.
    //
    // Surface `voicingHit` separately from `isHit` so analytics /
    // diagnostics can see WHY a chord was credited.
    // Voicing-reduction = "at least 2 of the chord's strings rang at
    // their correct expected pitches". This is the bar for "the player
    // played a reduced voicing of this chord", as distinct from "random
    // string noise" — which fails to match any chord string's expected
    // pitch and so doesn't contribute to the count.
    //
    // An earlier formulation required the chart's LOWEST string (the
    // bass note) to be one of the rung strings, reasoning that a real
    // chord must include its root. Real-song data caught the issue:
    // players often strum the middle/high strings of a chord shape
    // without sounding the lowest note (string skipping, fast strumming,
    // open-chord shapes where the bass is muted by hand position). Those
    // are valid 2-note interpretations of the chord too. The pitch-
    // verified gate is the real protection against energy-only false
    // positives — once 2 chord strings are confirmed at their correct
    // pitches, it doesn't matter which 2 they are.
    let voicingHit = false;
    if (results.length >= 2) {
        let pitchVerifiedHits = 0;
        for (const r of results) {
            // `hit && finite centsDiff` means the per-string check ran
            // a real pitch comparison and accepted. Energy-only "hit"s
            // (centsDiff null, from the pitchCheckCents <= 0 path used
            // by harmonics) intentionally don't count here — see the
            // "energy-only mode gates off voicing-reduction" test.
            if (r.hit && Number.isFinite(r.centsDiff)) pitchVerifiedHits++;
            if (pitchVerifiedHits >= 2) break;
        }
        if (pitchVerifiedHits >= 2) voicingHit = true;
    }

    // `isHit` reflects ONLY the strict ratio path — that's what
    // matchNotes uses to decide whether to commit a hit on the
    // current frame. The `voicingHit` flag is informational: it
    // means "if matchNotes never finds a strict-ratio frame for
    // this chord, checkMisses should rescue it as a hit at retire
    // time instead of recording a miss." This deferred-commit
    // approach lets strict-ratio frames (which tend to have better
    // timing because they fire later in the chord's audio decay)
    // win out, and voicing-reduction only kicks in as a fallback —
    // avoiding the timing-eager-commit regression where a sub-
    // threshold early frame locked in a hit with bad timing.
    const isHit = score >= minHitRatio;
    return { score, hitStrings, totalStrings, results, isHit, voicingHit };
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

// Encode an Array<Float32Array> of mono samples (any chunk size) as a
// 16-bit PCM mono RIFF/WAVE blob. Used by the in-app reference-recording
// capture so the headless harness can read back exactly the audio the
// detector saw. Soft-clips to int16 range; no dithering — fine for the
// detector's downstream analysis but don't ship this as a master.
function _ndEncodeWavPcm16(chunks, sampleRate) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const buf = new ArrayBuffer(44 + total * 2);
    const v = new DataView(buf);
    let off = 0;
    const w4  = (s) => { for (let i = 0; i < 4; i++) v.setUint8(off++, s.charCodeAt(i)); };
    const w16 = (n) => { v.setUint16(off, n, true); off += 2; };
    const w32 = (n) => { v.setUint32(off, n, true); off += 4; };
    w4('RIFF');  w32(36 + total * 2);  w4('WAVE');
    w4('fmt ');  w32(16);
    w16(1);                                          // PCM
    w16(1);                                          // mono
    w32(sampleRate);
    w32(sampleRate * 2);                             // byte rate
    w16(2);                                          // block align
    w16(16);                                         // bits per sample
    w4('data');  w32(total * 2);
    for (const c of chunks) {
        for (let i = 0; i < c.length; i++) {
            let s = c[i];
            if (s > 1)  s =  1;
            else if (s < -1) s = -1;
            v.setInt16(off, (s * 32767) | 0, true);
            off += 2;
        }
    }
    return buf;
}

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
    // User preference for whether detection should be running. Default
    // is true (Detect on out of the box) — overridden by localStorage
    // when the user has explicitly toggled. Distinct from `enabled`
    // because the audio pipeline can't be claimed during construction
    // (highway may not be ready, mic permissions may not be cached),
    // so this is the *intent* and `enabled` is the *current run state*.
    // The plugin auto-calls enable() on next tick if this is true.
    let detectPreference = true;
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
    let timingTolerance = 0.150;
    let pitchTolerance = 50;
    let timingHitThreshold = 0.100;
    // Chord-specific timing-OK window. Wider than the single-note
    // threshold because a chord strum spans 5–10 ms across strings and
    // the per-string FFT analysis window itself smears chord-strike
    // timing by another 50–100 ms — so the inherent jitter on a chord
    // event is closer to ±150 ms than the single-note ±100 ms. Fast
    // punk / pop-rock rhythm players also anticipate the beat by 80–
    // 120 ms (issue #38 — "Bad Habit", "American Jesus"), and the strict
    // 100 ms window cuts off most of that bias even when the chord was
    // scored as a strict-ratio hit. Default 150 ms; clamped >=
    // timingHitThreshold at load so chord scoring is never stricter
    // than single notes.
    let chordTimingHitThreshold = 0.150;
    let pitchHitThreshold = 20;
    let showTimingErrors = true;
    let showPitchErrors = true;
    // slopsmith#254 — the full-screen green/red edge flash on hit/miss.
    // Off by default now that the highway renderer lights the note gem
    // itself (and sizzles it); users who want the peripheral cue back can
    // re-enable it in the gear popover.
    let edgeFlashEnabled = false;
    // Tuning mode — opt-in switch for everything the detector exposes
    // for development / tuning / benchmarking (the Reference Recording
    // panel, the Diagnostic JSON export / Reset, the miss-category
    // breakdown on the end-of-song summary). Off by default — these
    // surfaces are noise for normal play. Gated by a single checkbox
    // in the gear popover. Persisted in localStorage alongside the
    // other settings.
    let tuningMode = false;
    let missMarkerDuration = 2.0;
    let hitGlowDuration = 0.5;
    let inputGain = 1.0;
    let selectedDeviceId = '';
    let selectedChannel = 'mono';
    // Detector pipeline latency compensation. 0.080 is the historical
    // default; the right value is heavily audio-chain-dependent (USB
    // interfaces, ScriptProcessor buffering, OS audio path all vary).
    // Users typically dial this via the gear-popover slider; the A/V
    // auto-calibrate panel suggests a value derived from their own
    // recently-detected note timings. We tried bumping the default to
    // match one heavy-user's empirical value, but it over-corrected
    // for users with shorter chains (caused their on-time playing to
    // register as "early" misses). Keeping the conservative default
    // and pointing users at the calibrate workflow is the right
    // trade-off.
    let latencyOffset = 0.080;
    // Fraction of a chord's strings that must register energy for the
    // chord to count as a hit (0.0–1.0). Was 0.6 historically, but
    // harness measurements against real-guitar recordings showed
    // chord scoring near 0/16 at that gate even for clean
    // playing. Dropping to 0.40 lets typical open/power-chord
    // voicings score multi-string hits without rewarding single-
    // string strums. Users who want stricter scoring can raise via
    // the slider.
    let chordHitRatio = 0.40;
    // Minimum YIN/HPS/CREPE confidence to accept a detection. Below
    // this, the per-frame result is discarded and the note retires
    // as a "pure" miss. Previously hardcoded to 0.30 at every gate
    // (6 sites in this file: two YIN/HPS result gates, three
    // detectedMidi-on-confidence gates, and the desktop-bridge pitch
    // detection gate); real-rig diagnostics on a healthy
    // signal showed ~47% of frames falling below that floor on CREPE
    // — most of the "pure" miss bucket. Default lowered to 0.20 +
    // exposed as a UI slider (gear popover) so users with quieter
    // / noisier signals can tune. Range 0.05–0.50 clamped on load.
    let detectionConfidenceMin = 0.20;

// Per-chunk audio processing — shared between the live-mic ScriptProcessor
// (in _ndStartAudio) and the test-WAV ScriptProcessor (in _ndInjectTestWav).
// Previously each path had its own copy of this logic; the WAV path's copy
// was missing the onset detector, which meant every test running against
// WAV replay exercised only the accumulator path and silently reported zero
// onsets. Any change to recording, onset, or accumulator behavior now lands
// in one place.
function _ndProcessAudioChunk(input) {
    if (!_ndEnabled) return;
    // Watchdog timestamp: last time we saw audio data flow. The HUD reads
    // this to decide whether to surface an "audio stalled" banner. Without
    // it the (d) silent-stop failure has no visible signal.
    _ndLastAudioFrameAt = performance.now();

    // Record raw audio if recording is active. Chart-time anchor is captured
    // inside this callback (not at _ndRecordStart) so WAV t=0 corresponds to
    // a sample taken while the chart clock was advancing.
    if (_ndRecording && _ndRecordTotalSamples < _ndRecordMaxSamples) {
        if (!_ndRecordAnchored) {
            const chartNow = highway.getTime ? highway.getTime() : 0;
            // 1 ms epsilon tolerates float noise on the chart-advance check.
            if (chartNow > _ndRecordArmedChartTime + 0.001) {
                _ndRecordChartStartTime = chartNow;
                _ndRecordAnchored = true;
                console.log(`[note_detect] Recording anchor set: WAV t=0 = chart ${chartNow.toFixed(3)}s`);
                _ndRecordChunks.push(new Float32Array(input));
                _ndRecordTotalSamples += input.length;
            }
            // else: chart paused; skip this sample batch until play starts.
        } else {
            _ndRecordChunks.push(new Float32Array(input));
            _ndRecordTotalSamples += input.length;
            if (_ndRecordTotalSamples >= _ndRecordMaxSamples) {
                console.log('[note_detect] Recording max duration reached, auto-stopping');
                _ndRecordSave(_ndRecordFilename);
            }
        }
    }

    // Onset detection — two triggers, each sets _ndPendingOnsetChartT for
    // the stability-voting stage to consume as the match-event timestamp.
    // See docs/NOTEDETECT_IMPLEMENTATION_GAPS.md Gap 1 for the primary
    // trigger story; the re-attack trigger is a follow-on to recover
    // repeated-note plucks during bass sustain.
    let rms = 0;
    for (let j = 0; j < input.length; j++) rms += input[j] * input[j];
    rms = Math.sqrt(rms / input.length);

    _ndReattackRmsBuf.push(rms);
    if (_ndReattackRmsBuf.length > _ND_REATTACK_WINDOW) _ndReattackRmsBuf.shift();

    const nowPerfSec = performance.now() / 1000;
    // Chart-aware refractory: when the chart says a note is coming up within
    // 250 ms, the 200 ms baseline is too long — the second pluck of a fast
    // repeat would land inside the refractory window and never register.
    // Tighten to 80 ms locally and bypass the rearm-gate too (sustain doesn't
    // dip below rearm-level fast enough between rapid plucks). The rest of
    // the time, keep the conservative defaults that suppress body-peak
    // retriggers on slow notes.
    const fastRepeatExpected = _ndChartHasNoteWithin(_ND_FAST_REPEAT_LOOKAHEAD_SEC);
    const effRefractorySec = fastRepeatExpected
        ? _ND_REATTACK_REFRACTORY_FAST_SEC
        : _ND_REATTACK_REFRACTORY_SEC;
    const refractoryOk = (nowPerfSec - _ndLastOnsetPerfNow) > effRefractorySec;

    // Re-arm the re-attack gate as soon as we observe a release — a frame
    // whose RMS is below the rearm level. Done OUTSIDE the onset-decision
    // branch so it tracks the envelope independently of whether an onset
    // fires. If the envelope dips low between attacks, we know the previous
    // note's sustain has genuinely released, and a subsequent spike is a
    // fresh pluck rather than body-peak noise from the ongoing note.
    if (rms < _ND_REATTACK_REARM_LEVEL) _ndReattackArmed = true;

    let fireOnset = false;
    // Trigger 1: silence → playing (fresh note after a rest).
    if (rms > _ND_ONSET_LEVEL && !_ndInNote && refractoryOk) {
        _ndInNote = true;
        fireOnset = true;
    }
    // Trigger 2: sustain re-attack — RMS spike above recent running min
    // AND armed by a prior release. Catches repeated plucks where sustain
    // keeps _ndInNote true between plucks (blocking Trigger 1), without
    // cascading spurious fires on a single note's body-peak resonance.
    // The arm-gate is bypassed when fastRepeatExpected, since rapid plucks
    // don't give sustain enough time to dip below the rearm threshold.
    else if (_ndInNote && refractoryOk && (_ndReattackArmed || fastRepeatExpected)
             && rms > _ND_REATTACK_MIN_LEVEL && _ndReattackRmsBuf.length >= 3) {
        const recentMin = Math.min(..._ndReattackRmsBuf.slice(0, -1));
        if (rms > recentMin * _ND_REATTACK_RATIO) fireOnset = true;
    }
    // Exit — hysteresis gap prevents re-fire on sustain noise.
    else if (rms < _ND_ONSET_EXIT_LEVEL) {
        _ndInNote = false;
    }

    if (fireOnset) {
        // highway.getTime() now returns chartTime with avOffset already applied
        // (slopsmith fix/loop-count-in-bpm @ 8d8c299 onwards). Adding avOffset
        // here would double-apply it. Onset chart-time = current chart-time
        // minus the half-buffer compensation.
        _ndPendingOnsetChartT = highway.getTime() - _ND_ONSET_BUFFER_COMP_SEC;
        _ndRawMidiHistory = [];
        _ndStableMidi = -1;
        _ndLastOnsetPerfNow = nowPerfSec;
        _ndReattackArmed = false; // disarm until next release
        _ndOnsetCount++;
        // Flush the YIN buffers AND drop this trigger chunk. The trigger
        // chunk itself is half pre-attack (previous note's sustain) and half
        // post-attack — when previous sustain is louder than the new attack
        // (soft pluck after a held note), keeping it in the accumulator lets
        // YIN lock onto the stale pitch. Post-flush Level run still saw 8/16
        // YIN_DISAGREES returning the preceding pitch when only buffers were
        // cleared. Returning here drops the trigger chunk so the next 4096-
        // sample YIN buffer is built entirely from post-onset chunks. Costs
        // one extra ScriptProcessor chunk (~43 ms) of latency.
        _ndAccumBuffer = new Float32Array(0);
        _ndPendingBuffer = null;
        return;
    }

    // Band-pass the chunk (persistent filter state) for YIN's accumulator.
    // Onset, RMS, and recording above this point all see the RAW input —
    // band-pass attenuates transient energy that onset detection relies on.
    const filteredInput = _ndApplyBpToChunk(input);

    // Sliding 4096-sample window: shift left by input.length, append the new
    // chunk, and publish a pending buffer every chunk (~43 ms hop) instead of
    // every two chunks (~85 ms hop). Halves the YIN poll interval, so the
    // 2-of-3 stability voter sees twice as many post-onset frames per chart
    // note. Per docs/SUSTAIN_BLEED_WALL.md phase 1: probe sweep across 9
    // fixtures (test/probe-interventions.js) shows 0 regressions and 4
    // sustain-bleed notes flip from fail → win on Level recordings.
    if (_ndAccumBuffer.length < _ndMinYinSamples) {
        // Warmup: grow buffer until we have a full YIN window.
        const combined = new Float32Array(_ndAccumBuffer.length + filteredInput.length);
        combined.set(_ndAccumBuffer);
        combined.set(filteredInput, _ndAccumBuffer.length);
        _ndAccumBuffer = combined.length >= _ndMinYinSamples
            ? combined.slice(combined.length - _ndMinYinSamples)
            : combined;
    } else {
        _ndAccumBuffer.copyWithin(0, filteredInput.length, _ndMinYinSamples);
        _ndAccumBuffer.set(filteredInput, _ndMinYinSamples - filteredInput.length);
    }
    if (_ndAccumBuffer.length >= _ndMinYinSamples) {
        // Hand the detector its own copy so subsequent slides don't mutate
        // the buffer YIN is still reading.
        _ndPendingBuffer = _ndAccumBuffer.slice();
    }
}

async function _ndStartAudio() {
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
            // Clamp tolerances to the UI slider ranges (30–300ms, 10–100c)
            // before deriving hit thresholds so a stale or manually-edited
            // stored value can't produce an invalid range input or a hit
            // threshold that exceeds the tolerance ceiling.
            if (s.timingTolerance !== undefined) timingTolerance = Math.max(0.03, Math.min(0.3, s.timingTolerance));
            if (s.pitchTolerance !== undefined) pitchTolerance = Math.max(10, Math.min(100, s.pitchTolerance));
            if (s.timingHitThreshold !== undefined) timingHitThreshold = Math.max(0.03, Math.min(timingTolerance, s.timingHitThreshold));
            // Chord threshold clamp: at least the single-note strict threshold
            // (chords shouldn't be stricter than single notes), at most the
            // outer timing tolerance (we're widening within the existing
            // candidate window, not pushing past it).
            if (s.chordTimingHitThreshold !== undefined) chordTimingHitThreshold = Math.max(timingHitThreshold, Math.min(timingTolerance, s.chordTimingHitThreshold));
            if (s.pitchHitThreshold !== undefined) pitchHitThreshold = Math.max(5, Math.min(pitchTolerance, s.pitchHitThreshold));
            if (s.showTimingErrors !== undefined) showTimingErrors = !!s.showTimingErrors;
            if (s.showPitchErrors !== undefined) showPitchErrors = !!s.showPitchErrors;
            if (s.edgeFlash !== undefined) edgeFlashEnabled = !!s.edgeFlash;
            if (s.tuningMode !== undefined) tuningMode = !!s.tuningMode;
            // Persisted on/off preference. Absence keeps the default
            // (true), so fresh installs get Detect on out of the box.
            if (s.detectEnabled !== undefined) detectPreference = !!s.detectEnabled;
            if (s.missMarkerDuration !== undefined) missMarkerDuration = Math.max(0.5, Math.min(5, s.missMarkerDuration));
            if (s.hitGlowDuration !== undefined) hitGlowDuration = Math.max(0.1, Math.min(2, s.hitGlowDuration));
            if (s.inputGain !== undefined) inputGain = s.inputGain;
            if (s.latencyOffset !== undefined) latencyOffset = s.latencyOffset;
            // Clamp to the slider's range so a stale persisted value
            // (older build, manual edit) can't put scoring in a state the
            // UI can't represent.
            if (s.chordHitRatio !== undefined) chordHitRatio = Math.max(0.25, Math.min(1, s.chordHitRatio));
            // Detection confidence floor — clamp to a sensible range.
            // Below 0.05, even pure noise becomes a "detection"; above
            // 0.50, even confident YIN/CREPE frames get rejected on
            // typical guitar signals.
            if (s.detectionConfidenceMin !== undefined) {
                detectionConfidenceMin = Math.max(0.05, Math.min(0.50, s.detectionConfidenceMin));
            }
        }
    } catch (e) { /* localStorage unavailable */ }
    // Chord window invariant — single-note strict can't exceed chord
    // (a stored chord value smaller than the loaded strict threshold
    // would invert the relationship); and chord can't exceed the outer
    // tolerance (we're widening within the candidate window, not past
    // it). The latter trips when a user has a stored timingTolerance
    // below the chord default and no chordTimingHitThreshold yet.
    if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
    if (chordTimingHitThreshold > timingTolerance)    chordTimingHitThreshold = timingTolerance;

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

    // Scoring
    let hits = 0;
    let misses = 0;
    let streak = 0;
    let bestStreak = 0;
    let sectionStats = [];   // [{name, hits, misses}]
    let currentSection = null;
    const noteResults = new Map(); // key -> judgment object

    // ── Miss-category diagnostic (#254 follow-up) ─────────────────────
    // Counts WHY a judgment missed so a session report can isolate the
    // dominant failure mode — pure misses → mic/audio chain; chord-partial
    // → leniency too tight; timing → window too narrow; pitch → tolerance
    // too narrow. Each miss falls into exactly one primary bin (chord
    // events into chordPartial regardless of axis); per-string + signed-
    // error arrays let us see which strings the player is losing on and
    // whether they trend sharp/flat or early/late. Reset alongside
    // hits/misses in resetScoring(); refs stay stable across reset.
    const _diagBreakdown = {
        pure: 0,           // miss, no pitch detected within the timing window
        chordPartial: 0,   // chord event below the chord-leniency threshold
        early: 0,
        late: 0,
        sharp: 0,
        flat: 0,
    };
    const _diagSingles = { hits: 0, misses: 0 };
    const _diagChords  = { hits: 0, misses: 0 };
    // Per-string. 8 covers 4/5/6/7/8-string arrangements without resizing.
    const _diagPerString = Array.from({ length: 8 }, () => ({ hits: 0, misses: 0 }));
    // Signed errors for matched judgments (excludes pure misses where no
    // measurement exists). Capped to keep memory bounded across long
    // sessions; percentiles in the summary run on the raw array.
    const _DIAG_ERROR_CAP = 2000;
    const _diagTimingErrors = [];   // milliseconds, sign = positive late / negative early — all matched judgments
    // Hit-only timing samples. The all-matched array above includes
    // judgments where the matcher snapped to a *neighbouring* chart note
    // (closest-by-time wins, even if the user's actual playing skew is
    // big), so its median is pinned by the matching window instead of
    // tracking real audio↔chart drift. Restricting to actual hits gives
    // a signal that responds linearly to A/V offset, which is what the
    // auto-calibrate button keys off of.
    const _diagTimingErrorsHits = [];
    const _diagPitchErrors  = [];   // cents,        sign = positive sharp / negative flat
    // Per-judgment event capture for the downloadable JSON. Capped at a
    // size that keeps the JSON small enough to share via copy-paste.
    const _DIAG_EVENT_CAP = 2000;
    const _diagEvents = [];

    // Live-streaming state. When tuning mode is on, every judgment is
    // also POSTed to /api/plugins/note_detect/live-judgment so an
    // off-device reader (the host iterating against this code) can
    // watch a session unfold in real time. The session id changes on
    // every `song:play` so each take produces its own JSONL file; the
    // value is used directly as a filename slug server-side, so it
    // sticks to filesystem-safe characters. Off (null) until the first
    // song:play fires with tuning mode on.
    let _liveSessionId = null;
    // Last minted session id, kept after song:ended (unlike
    // _liveSessionId which _liveOnEnded clears) so the training-bundle
    // upload can still locate the take's live_<id>.jsonl detect-stream.
    let _liveLastSessionId = null;
    function _buildSessionHeader() {
        // Snapshot the user's live settings + song context at song:play
        // time. Lands as the first JSONL line of the session file so
        // any offline reader (host-side regression runner, future
        // default-suggestion tooling, a maintainer looking at a shared
        // session) knows what knobs produced the judgments below.
        // Keep field names consistent with the `settings` block in the
        // diagnostic export — same vocabulary across the two formats.
        const info = (hw && hw.getSongInfo) ? hw.getSongInfo() : {};
        const avOffsetMs = (hw && hw.getAvOffset) ? hw.getAvOffset() : 0;
        return {
            type: 'session_start',
            schema: 'note_detect.live.session_start.v1',
            ts: new Date().toISOString(),
            plugin_version: _ND_VERSION,
            song: {
                title: info.title || null,
                artist: info.artist || null,
                arrangement: info.arrangement || null,
                arrangement_index: (info.arrangement_index != null) ? info.arrangement_index : null,
                tuning: info.tuning || null,
                capo: info.capo != null ? info.capo : 0,
                duration: info.duration != null ? info.duration : null,
            },
            settings: {
                method: detectionMethod,
                timing_tolerance_s: timingTolerance,
                timing_hit_threshold_s: timingHitThreshold,
                chord_timing_hit_threshold_s: chordTimingHitThreshold,
                pitch_tolerance_cents: pitchTolerance,
                pitch_hit_threshold_cents: pitchHitThreshold,
                chord_hit_ratio: chordHitRatio,
                detection_confidence_min: detectionConfidenceMin,
                latency_offset_s: latencyOffset,
                input_gain: inputGain,
                channel: selectedChannel,
                av_offset_ms: avOffsetMs,
            },
        };
    }
    function _streamLiveJudgment(eventObj) {
        // Fire-and-forget — the network round-trip MUST NOT block the
        // detection hot path. We don't await it here: any failure
        // (server down, file capped, etc.) is silently swallowed so the
        // in-memory diagnostic stays the source of truth and detection
        // keeps running. The promise IS tracked in _livePending, though,
        // so _flushLiveJudgments() can drain it before a training bundle
        // is zipped server-side (otherwise the last judgments / the
        // session header could miss the JSONL).
        try {
            const p = fetch(
                '/api/plugins/note_detect/live-judgment?session='
                    + encodeURIComponent(_liveSessionId),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(eventObj),
                    keepalive: true,   // survives page nav / song-end teardown
                },
            ).catch(() => {});
            _livePending.add(p);
            p.finally(() => _livePending.delete(p));
        } catch (e) { /* swallow — see comment above */ }
    }

    // In-flight /live-judgment POSTs. Drained by _flushLiveJudgments()
    // before a training bundle is requested.
    const _livePending = new Set();
    async function _flushLiveJudgments() {
        // Snapshot: only the POSTs already issued belong to the take
        // that just ended.
        try { await Promise.allSettled([..._livePending]); } catch (_) {}
    }

    // ── Reference-recording capture (#254 follow-up) ──────────────────
    // Captures the SAME Float32 audio frames the detector is running its
    // analysis on, while a song is playing, so the headless harness has
    // a known-aligned WAV to feed it — no DAW / Audacity needed. Auto-
    // starts on song:play once armed, auto-saves on song:ended. The WAV
    // lands under `static/note_detect_recordings/` via the routes.py POST
    // endpoint; that dir is bind-mounted in the dev container so the
    // harness on the host can read it back without a copy step.
    let _recArmed = false;            // user clicked Arm; waiting for / actively recording
    let _recArmedForTraining = false; // set alongside _recArmed when the user clicked Arm (training);
                                      // triggers the post-save POST to /training-bundle that
                                      // zips WAV+JSONL+manifest and uploads to pCloud
    let _recSongPlaying = false;      // tracks song:play / song:pause / song:ended
    let _recChunks = [];              // Array<Float32Array>; concatenated only on save
    let _recSampleRate = 44100;       // captured from audioCtx when the first frame lands
    let _recLastSavePath = null;      // host-visible relative path of the most recent save
    let _recLastSaveError = null;     // surfaced in the UI when a save fails
    let _recSaveInFlight = false;     // de-dupe rapid saves
    let _recCappedAt = null;          // seconds into the take where the client-side cap kicked in (null = no cap hit)
    let _recTotalSamples = 0;         // running sum of _recChunks lengths — avoids O(n²) reduce on the detection hot path
    // Training-upload tracking — surfaced in the gear popover so the
    // user knows whether the bundle made it to the curated dataset.
    let _recTrainingUploadInFlight = false;
    let _recTrainingUploadResult = null; // { ok, bundle_filename, pcloud_result } | { ok:false, error, local_bundle }
    // When a training take is armed, the consent modal opens on
    // song:ended — the same event that fires the score summary. Defer
    // the summary so the two modals don't stack; _runDeferredSummary()
    // shows it once the consent flow closes.
    let _summaryDeferred = false;
    // Parallel getUserMedia capture for training takes when the desktop
    // bridge is active. The bridge intentionally does NOT open a JS-side
    // audio chain (the native JUCE engine owns the device), so the
    // existing _recChunks push site inside processFrame() never runs
    // and the WAV would always be empty. This capture is orthogonal:
    // its own MediaStream / AudioContext / ScriptProcessor solely to
    // copy Float32 frames into _recChunks. Closed on disarm / discard /
    // save-completion / destroy. Null when not in use.
    let _trainingCapture = null;
    // slopsmith#254 — per-sustained-hit-note "still being held on-pitch"
    // grace timestamps: key -> performance.now() ms before which the
    // sustain still counts as actively held. Smooths the gap between
    // ~30 fps pitch frames and 60 fps highway render so the lit-gem glow
    // doesn't flicker. Pruned alongside noteResults; cleared on reset.
    const _susActiveUntil = new Map();

    // Drill mode (slopsmith plugin-API: loop:restart event from #198).
    // Activates whenever slopsmith has an A-B loop set; each loop wrap
    // snapshots the just-finished iteration's per-iteration scoring
    // into drillIterations so the user sees iteration-by-iteration
    // accuracy on a repeated passage. Per-iteration counters live
    // alongside (not in place of) the global session counters above —
    // session totals stay correct even while drilling.
    let drillEnabled = false;       // mirrors slopsmith.getLoop() having both bounds
    let drillIterations = [];       // captured snapshots, oldest first
    let drillIterStartT = null;     // chartTime at the current iteration's start (loopA)
    let drillIterHits = 0;
    let drillIterMisses = 0;
    let drillIterStreak = 0;
    let drillIterBestStreak = 0;
    let drillSubscribed = false;    // gate the slopsmith.on / .off pair
    // Bound handler refs so destroy() can call slopsmith.off with
    // identity that matches the original .on registration.
    let drillOnLoopRestartFn = null;
    let drillOnSongChangedFn = null;
    // End-of-song summary subscription. Bound from enableImpl() so the
    // drill-mode listener count test (which calls _bindDrillEvents()
    // directly without going through enable) keeps seeing exactly the
    // drill listener it expects. The handler runs only when `enabled`
    // is still true at song:ended, gated to the default singleton so a
    // splitscreen with N detecting panels doesn't pop N modals.
    let endOfSongSubscribed = false;
    let endOfSongOnEndedFn = null;
    // Bounds at iteration start; if slopsmith.getLoop() returns
    // different bounds mid-drill (user picked another saved loop or
    // edited A/B) we clear iterations because they're no longer
    // comparing the same passage.
    let drillActiveLoopA = null;
    let drillActiveLoopB = null;
    // Monotonic counter for iteration `idx` — survives the
    // splice-from-front truncation. Using `drillIterations.length + 1`
    // would reuse `#51` indefinitely once truncation started.
    let drillNextIdx = 1;
    const DRILL_MAX_ITERATIONS = 50;  // bound the array so a long drill session doesn't grow without limit
    // Render uses innerHTML which parses HTML — avoid re-parsing on
    // every 33 ms HUD tick when nothing changed. Set by any mutation
    // of drill state (iteration push, live counter tick, activation
    // change); _drillRender clears it after redrawing.
    let drillDirty = true;

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
    // Per-chord-key cache of the most recent _ndScoreChord result so
    // checkMisses() can attach hs/tt/sc to a chord miss judgment. Keyed
    // by the same `<time>_chord` string the rest of the chord plumbing
    // uses. Cleared on resetScoring (song change / detect toggle) so a
    // stale per-chord result from one take can't leak into a later one.
    const _chordLastResult = new Map();
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
    let bridgeLevelTimer = null;  // setInterval for the desktop-bridge level meter
    let hudInterval = null;
    let missCheckInterval = null;
    let gcInterval = null;
    let flashTimeouts = [];

    // Set to true when startAudio() routed through the slopsmith-desktop
    // (Electron) audio bridge instead of opening its own getUserMedia
    // stream. Used by the bridge poll/level-meter timers to bail out
    // after their `await` resolves on a since-disabled instance — the
    // existing Web-Audio teardown in stopAudio() is null-checked, so it
    // doesn't need its own branch on this flag.
    let usingDesktopBridge = false;
    // Cached engine sample rate for the bridge path. There's no
    // audioCtx on this branch so any code that needs a sampleRate
    // reads it from here instead. Note that chord scoring on the
    // bridge does NOT consult this value — audio.scoreChord runs
    // inside the engine and reads the rate natively. The cache is
    // kept around for the monophonic detection helpers and any
    // future bridge-side consumer that still needs the renderer
    // view of the rate. Browser path uses audioCtx.sampleRate
    // directly. The engine rate is fixed for a session; if the user
    // changes audio device the detector restarts via the
    // restartAudio chain and refreshes this value.
    let bridgeSampleRate = 48000;
    // Cached `window.slopsmithDesktop` reference captured at
    // startAudio() when the bridge path is active, so matchNotes()'s
    // chord branch can dispatch `audio.scoreChord(ctx)` without
    // re-resolving from window on every tick. Cleared by stopAudio().
    let bridgeDesktop = null;
    // Whether the desktop engine's polyphonic ML detector (Basic Pitch) is
    // actually active this session — queried once at bridge startup via
    // `audio.isMlNoteDetection()`. false on a downlevel addon or when the ML
    // model failed to load (the engine then runs the YIN fallback). Stamped
    // into the diagnostic export so a session can be tied to its detector.
    let bridgeMlActive = false;
    // Detector identity captured DURING detection (not read at diagnostic-
    // export time, when usingDesktopBridge has already been reset by a Detect
    // toggle — that mislabelled bridge sessions as web). Set each tick by
    // whichever path actually ran.
    let _diagDetector = null;
    // Onset-event state for the desktop ML bridge — used to gate CHORD timing.
    // Each detectNotes note carries a per-pitch `onsetSeq` counter; when it
    // increases, that pitch was struck anew. A chord commits a hit only on a
    // poll where one of its pitches has a fresh onset, so the chord's pitches
    // ringing on through the riff don't drag the match early.
    //   bridgeOnsetSeqSeen — last consumed onsetSeq per MIDI pitch
    //   bridgeNewOnsets    — onsets first seen on the current poll:
    //                        midi -> { ageMs, conf }
    //   bridgeOnsetPrimed  — false until the first poll has recorded a seq
    //                        baseline (so pre-existing onsets aren't replayed)
    let bridgeOnsetSeqSeen = new Map();
    let bridgeNewOnsets = new Map();
    let bridgeOnsetPrimed = false;

    // Visual-feedback tracking
    let lastHitCount = 0;
    let lastMissCount = 0;

    // DOM refs
    const container = opts.container || document.getElementById('player');
    const instanceRoot = document.createElement('div');
    instanceRoot.className = 'nd-instance-root';
    instanceRoot.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    let detectBtn = null;
    let gearBtn = null;

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
        // slopsmith#254 — publish per-note judgments so the active
        // renderer lights up the gem itself (and keeps a held sustain
        // glowing) instead of us drawing an overlay ring near it. The
        // provider returns null while disabled, so registering it once
        // and leaving it across enable/disable cycles is harmless; it's
        // only cleared in destroy(). Per-instance hw (splitscreen panels
        // each have their own createHighway()), so no cross-panel clash.
        // The core API is last-wins; we still avoid stomping a provider
        // some other plugin registered first (we'd be re-registering our
        // own `noteStateFor` across a disable→enable, which is a no-op).
        if (h && h.setNoteStateProvider) {
            const existing = (typeof h.getNoteStateProvider === 'function') ? h.getNoteStateProvider() : null;
            if (existing == null || existing === noteStateFor) h.setNoteStateProvider(noteStateFor);
        }
        _ndStream = await navigator.mediaDevices.getUserMedia(constraints);
        // Use native sample rate — browsers often ignore non-standard rates,
        // and we need reliable timing for pitch detection
        _ndAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        _ndResetBpFilter(_ndAudioCtx.sampleRate);

        // ── Silent-stop recovery ──────────────────────────────────────────
        // Three known causes of "Detect stays green-checked but no input
        // pickup": AudioContext auto-suspends (Chrome hides idle/backgrounded
        // tabs), MediaStreamTrack ends (USB unplug, BT drop, device steal),
        // or the ScriptProcessor stops firing without throwing. The first
        // two emit events; the third needs a watchdog. Without recovery
        // hooks, frames just stop flowing and the user has no signal that
        // anything went wrong — the (d) "works for a while then silently
        // stops" failure mode reported during play sessions.
        _ndAudioCtx.addEventListener('statechange', async () => {
            console.log(`[note_detect] AudioContext state → ${_ndAudioCtx?.state}`);
            if (_ndAudioCtx && _ndAudioCtx.state === 'suspended' && _ndEnabled) {
                try {
                    await _ndAudioCtx.resume();
                    console.log('[note_detect] AudioContext auto-resumed');
                } catch (e) {
                    console.warn('[note_detect] AudioContext resume failed:', e);
                }
            }
        });
        for (const tr of _ndStream.getAudioTracks()) {
            tr.addEventListener('ended', () => {
                console.warn(`[note_detect] Audio track ended: "${tr.label}". Attempting restart...`);
                if (_ndEnabled) {
                    _ndStopAudio();
                    setTimeout(() => _ndStartAudio(), 500);
                }
            });
        }
        // Prime the stall watchdog so the HUD stall badge doesn't false-fire
        // during the brief gap before the first audio chunk arrives.
        _ndLastAudioFrameAt = performance.now();

        const source = _ndAudioCtx.createMediaStreamSource(_ndStream);
        const streamChannels = source.channelCount;

    // ── Audio pipeline ────────────────────────────────────────────────
    async function startAudio() {
        try {
            // Desktop (Electron) bridge path. When the slopsmith-desktop
            // shell is hosting us, the native JUCE engine already owns
            // the audio device — see src/main/audio-bridge.ts in
            // slopsmith-desktop. Drive monophonic detection from its
            // `audio:getPitchDetection` IPC and polyphonic chord
            // scoring from its `audio:scoreChord` IPC (native
            // ChordScorer + lock-free input ring), instead of opening
            // a parallel getUserMedia/Web-Audio chain. That parallel
            // path fails on Linux Electron builds (Chromium denies
            // `media` for the localhost-served renderer with no
            // permission handler set) and duplicates work the engine
            // is already doing every frame.
            //
            // The bridge feature-detects each IPC method separately,
            // so an older slopsmith-desktop without scoreChord still
            // gets the monophonic path; chord scoring is skipped
            // (the chord branch in matchNotes() short-circuits when
            // the IPC is missing, same as the pre-bridge browser
            // path's no-buffer guard).
            //
            // Borrower mode (caller supplied a stream or AudioContext)
            // skips this branch — those callers own the lifecycle and
            // expect a real Web-Audio graph, e.g. for tap-tempo or
            // visualisation taps.
            const desktop = (typeof window !== 'undefined') ? window.slopsmithDesktop : null;
            const canUseDesktopBridge = !externalStream && !externalAudioCtx
                && desktop && desktop.isDesktop
                && desktop.audio
                && typeof desktop.audio.getPitchDetection === 'function'
                && typeof desktop.audio.isAvailable === 'function';
            if (canUseDesktopBridge) {
                let bridgeReady = false;
                try {
                    bridgeReady = await desktop.audio.isAvailable();
                } catch (_) { /* treat as unavailable */ }
                if (bridgeReady) {
                    // Start the engine if the Audio Plugins panel hasn't
                    // already done so — without it getPitchDetection
                    // returns sentinel values (frequency: -1) forever.
                    try {
                        const running = typeof desktop.audio.isAudioRunning === 'function'
                            ? await desktop.audio.isAudioRunning()
                            : false;
                        if (!running && typeof desktop.audio.startAudio === 'function') {
                            await desktop.audio.startAudio();
                        }
                    } catch (_) { /* engine surfaces its own errors */ }

                    usingDesktopBridge = true;
                    bridgeDesktop = desktop;
                    accumBuffer = new Float32Array(0);

                    // Record whether the engine's polyphonic ML detector
                    // (Basic Pitch) is actually active — stamped into the
                    // diagnostic export so a session is unambiguously tied to
                    // ML vs the YIN fallback. typeof-guarded for downlevel
                    // addons that predate the query.
                    bridgeMlActive = false;
                    if (typeof desktop.audio.isMlNoteDetection === 'function') {
                        try {
                            bridgeMlActive = (await desktop.audio.isMlNoteDetection()) === true;
                        } catch (_) { /* leave false */ }
                    }
                    console.log(`[note_detect] desktop bridge active — ML detection: ${bridgeMlActive ? 'ON' : 'OFF (YIN fallback)'}`);

                    // Cache the engine sample rate for any consumer
                    // that needs the bridge-side rate (the chord
                    // branch in matchNotes() doesn't — it dispatches
                    // through audio:scoreChord which reads the rate
                    // inside the engine). Reset to the 48000 default
                    // first so a transient throw or stale cached
                    // rate from a previous session can't leak in
                    // after a device-change-driven restart.
                    bridgeSampleRate = 48000;
                    if (typeof desktop.audio.getSampleRate === 'function') {
                        try {
                            const sr = await desktop.audio.getSampleRate();
                            if (Number.isFinite(sr) && sr > 0) bridgeSampleRate = sr;
                        } catch (_) { /* keep the 48000 default */ }
                    }

                    // Whether this desktop build exposes the raw polyphonic
                    // transcription API. Captured once — the addon's method
                    // set is fixed for the session.
                    const hasDetectNotes = typeof desktop.audio.detectNotes === 'function';

        processor.onaudioprocess = (e) => {
            _ndProcessAudioChunk(e.inputBuffer.getChannelData(0));
        };

        // Detection runs on a timer, not in the audio callback. Poll period
        // must be ≤ chunk period (~43 ms at 48 kHz / 2048-frame buffer) so
        // every sliding-window pending buffer gets consumed; 50 ms dropped
        // ~3 frames/sec, blunting the bleed-fix benefit.
        _ndDetectInterval = setInterval(() => {
            if (_ndPendingBuffer) {
                const buf = _ndPendingBuffer;
                _ndPendingBuffer = null;
                _ndProcessFrame(buf);
            }
        }, 25);

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

let _ndDetectInterval = null;
let _ndPendingBuffer = null;
let _ndLastAudioFrameAt = 0;     // performance.now() of most recent audio chunk
const _ND_AUDIO_STALL_THRESHOLD_MS = 3000;  // HUD turns red after 3s of no chunks

function _ndStopAudio() {
    _ndStopLevelMeter();
    if (_ndDetectInterval) { clearInterval(_ndDetectInterval); _ndDetectInterval = null; }
    _ndPendingBuffer = null;
    if (_ndWorklet) {
        _ndWorklet.disconnect();
        _ndWorklet = null;
    }
    _ndLevelAnalyser = null;
    if (_ndStream) {
        _ndStream.getTracks().forEach(t => t.stop());
        _ndStream = null;
    }
    if (_ndAudioCtx) {
        _ndAudioCtx.close();
        _ndAudioCtx = null;
    }
    _ndInputLevel = 0;
    _ndInputPeak = 0;
    _ndAccumBuffer = new Float32Array(0);
    _ndOnsetRmsHistory = [];
    _ndLastAudioFrameAt = 0;
}

// ── Input Level Metering ──────────────────────────────────────────────────

let _ndLevelRaf = null;

function _ndStartLevelMeter() {
    _ndStopLevelMeter();
    const tick = () => {
        if (!_ndLevelAnalyser) return;
        const buf = new Float32Array(_ndLevelAnalyser.fftSize);
        _ndLevelAnalyser.getFloatTimeDomainData(buf);

        // RMS level
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        _ndInputLevel = Math.min(1, rms * 5); // scale up for visibility

        // Peak hold with decay
        if (_ndInputLevel > _ndInputPeak) {
            _ndInputPeak = _ndInputLevel;
            _ndPeakDecay = 30; // hold for ~30 frames
        } else if (_ndPeakDecay > 0) {
            _ndPeakDecay--;
        } else {
            _ndInputPeak *= 0.95;
        }

        // Update VU meter in settings panel if visible
        _ndDrawSettingsVU();

        _ndLevelRaf = requestAnimationFrame(tick);
    };
    _ndLevelRaf = requestAnimationFrame(tick);
}

function _ndStopLevelMeter() {
    if (_ndLevelRaf) {
        cancelAnimationFrame(_ndLevelRaf);
        _ndLevelRaf = null;
    }
}

function _ndDrawSettingsVU() {
    const bar = document.getElementById('nd-vu-bar');
    const peak = document.getElementById('nd-vu-peak');
    if (!bar) return;
    const pct = Math.round(_ndInputLevel * 100);
    bar.style.width = pct + '%';
    // Color: green < 60%, yellow 60-85%, red > 85%
    bar.className = pct > 85 ? 'h-full rounded transition-all duration-75 bg-red-500'
        : pct > 60 ? 'h-full rounded transition-all duration-75 bg-yellow-500'
        : 'h-full rounded transition-all duration-75 bg-green-500';
    if (peak) {
        const peakPct = Math.round(_ndInputPeak * 100);
        peak.style.left = Math.min(peakPct, 100) + '%';
    }
}

// ── Frame Processing ───────────────────────────────────────────────────────

async function _ndProcessFrame(buffer) {
    let result;
    const sr = _ndAudioCtx ? _ndAudioCtx.sampleRate : 48000;
    if (_ndDetectionMethod === 'crepe' && _ndModel) {
        result = await _ndCrepeDetect(buffer);
        // Fall back to YIN if CREPE returned nothing useful
        if (result.freq <= 0 || result.confidence < 0.7) {
            result = _ndYinDetect(buffer, sr);
        }
    } else {
        result = _ndYinDetect(buffer, sr);
    }

    if (result.freq <= 0 || result.confidence < 0.7) {
        if (result.underBuffered && !_ndUnderBufferWarned) {
            console.warn('[note_detect] YIN received an undersized buffer — low-frequency (bass) notes will drop silently. Check the frame accumulation path.');
            _ndUnderBufferWarned = true;
        }
        if (_ndFrameLogEnabled) {
            _ndFrameLog.push({
                t: performance.now() / 1000,
                type: 'reject_conf',
                freq: result.freq.toFixed(1),
                conf: result.confidence.toFixed(2),
                level: _ndInputLevel.toFixed(4),
            });
            if (_ndFrameLog.length > _ND_FRAME_LOG_MAX) _ndFrameLog.shift();
        }
        _ndDetectedMidi = -1;
        _ndDetectedConfidence = 0;
        _ndDetectedString = -1;
        _ndDetectedFret = -1;
        return;
    }

    // ── Silence gate ─────────────────────────────────────────────────────
    // YIN returns high confidence on electrical hum / noise floor.
    // Reject detections when the raw RMS input level is below the gate.
    // _ndInputLevel is already scaled (rms * 5), so 0.01 ≈ raw RMS 0.002.
    // Typical quiet guitar hum: 0.001-0.003. Soft pluck: 0.02+.
    if (_ndInputLevel < _ndSilenceGate) {
        if (_ndFrameLogEnabled) {
            _ndFrameLog.push({
                t: performance.now() / 1000,
                type: 'reject_gate',
                freq: result.freq.toFixed(1),
                conf: result.confidence.toFixed(2),
                level: _ndInputLevel.toFixed(4),
                midi: _ndFreqToMidi(result.freq).toFixed(1),
            });
            if (_ndFrameLog.length > _ND_FRAME_LOG_MAX) _ndFrameLog.shift();
        }
        // Flush stability history on silence — stale votes from the previous
        // note would otherwise produce false stable detections when signal
        // briefly returns. Proven in flashcard plugin testing.
        if (_ndRawMidiHistory.length > 0) {
            _ndRawMidiHistory = [];
            _ndStableMidi = -1;
            _ndLastMatchMidi = -1;  // allow same note to re-match after silence
        }
        _ndDetectedMidi = -1;
        _ndDetectedConfidence = 0;
        _ndDetectedString = -1;
        _ndDetectedFret = -1;
        return;
    }

    _ndDetectedMidi = _ndFreqToMidi(result.freq);
    _ndDetectedConfidence = result.confidence;

    // Stability voting: roll the latest rounded-MIDI into a short history
    // and derive a "stable" value only when N of M recent raw detections
    // agree. This suppresses YIN's attack-transient jitter (e.g. bouncing
    // E1→D1→E2→E1 during the first 100 ms of a pluck) without slowing
    // down the raw HUD readout, which still uses _ndDetectedMidi.
    const roundedMidi = Math.round(_ndDetectedMidi);
    _ndRawMidiHistory.push(roundedMidi);
    if (_ndRawMidiHistory.length > _ND_STABILITY_WINDOW) _ndRawMidiHistory.shift();
    const voteCounts = new Map();
    for (const m of _ndRawMidiHistory) voteCounts.set(m, (voteCounts.get(m) || 0) + 1);
    let winnerMidi = -1, winnerCount = 0;
    for (const [m, c] of voteCounts) {
        if (c > winnerCount) { winnerMidi = m; winnerCount = c; }
    }
    _ndStableMidi = (winnerCount >= _ND_STABILITY_REQUIRED) ? winnerMidi : -1;

    // Per-frame hygiene update: for each chart note whose hit window
    // currently contains the playhead, count this frame as on-target or
    // off-target relative to the expected pitch. Driven by raw _ndDetectedMidi
    // (not stable) so we capture brief contaminating pitches that don't
    // last long enough to satisfy the stability voter — the same signal the
    // offline string-hygiene scanner uses.
    if (highway.getTime) {
        const playT = highway.getTime();
        if (playT >= 0) _ndUpdateNoteHygiene(playT);
    }

    // If the Calibration Wizard is armed on the mic step, this detection is
    // the response to the on-screen flash — record the sample and unarm.
    // Wizard uses the RAW detection timestamp so its latency measurement
    // doesn't include stability-voting delay.
    if (typeof _ndWizOnDetection === 'function') _ndWizOnDetection();

    // If the tuner modal is open, route the detection through the tuner's
    // string-assignment logic instead of chart matching. Tuner also uses
    // raw pitch since it shows live tuning and already has its own 1.5s
    // display-stale window.
    if (_ndTunerOpen) {
        if (typeof _ndTunerOnDetection === 'function') _ndTunerOnDetection(result.freq);
        return;
    }

    // ── Event-driven chart matching ─────────────────────────────────────
    // Only match when stable pitch CHANGES, not every frame. Continuous
    // matching caused sustained note N to poison match attempts against
    // chart note N+1. The flashcard plugin proved event-driven matching
    // works — same approach here.
    //
    // Stability voting is now the gate: we wait for 3-of-5 agreement,
    // then match once. No transient filter needed (was blocking real
    // transitions like E→A = 5 semitones).
    const now = performance.now() / 1000;

    if (_ndStableMidi < 0) {
        // Not stable yet — don't match. Log for diagnostics.
        if (_ndFrameLogEnabled) {
            _ndFrameLog.push({
                t: now, type: 'unstable',
                midi: _ndDetectedMidi.toFixed(1),
                conf: _ndDetectedConfidence.toFixed(2),
                level: _ndInputLevel.toFixed(3),
            });
            if (_ndFrameLog.length > _ND_FRAME_LOG_MAX) _ndFrameLog.shift();
        }
        return;
    }

    // Log every stable frame
    if (_ndFrameLogEnabled) {
        const scoreT = highway.getTime();
        _ndFrameLog.push({
            t: now, type: 'stable',
            midi: _ndStableMidi,
            conf: _ndDetectedConfidence.toFixed(2),
            scoreT: scoreT.toFixed(3),
            chartT: highway.getTime().toFixed(3),
            level: _ndInputLevel.toFixed(3),
        });
        if (_ndFrameLog.length > _ND_FRAME_LOG_MAX) _ndFrameLog.shift();
    }

    // Match trigger (docs/NOTEDETECT_IMPLEMENTATION_GAPS.md Gap 1):
    //
    //   1. Onset-gated (primary). When the audio-processor RMS-threshold
    //      detector sets _ndPendingOnsetChartT, it captured the onset's chart
    //      time at the ACOUSTIC ATTACK. By the time stability voting produces
    //      a valid _ndStableMidi, we have both the when (onset) and the what
    //      (stable MIDI) for a single note event. Fire match at the onset's
    //      chart time — latency is bounded by buffer+stability-vote delay
    //      and is applied by the caller via tOverride, not by global
    //      _ndDetectionLatencySec compensation.
    //
    //   2. Stable-MIDI-change (fallback). Soft plucks, slurs, and
    //      instruments without a clean attack transient produce no RMS
    //      spike. In those cases we fall back to the legacy trigger: match
    //      when stable MIDI changes, with a 1-second same-MIDI guard to
    //      suppress sustain re-detections. See the note below.
    if (_ndPendingOnsetChartT != null) {
        const onsetT = _ndPendingOnsetChartT;
        _ndPendingOnsetChartT = null;
        _ndLastMatchMidi = _ndStableMidi;
        _ndLastMatchTime = now;
        _ndMatchNotes(onsetT);
        return;
    }

    // Fallback: stable-MIDI-change with 1-second same-MIDI guard.
    // Without this, F1→(3.7s gap)→F1 is silently dropped because
    // _ndLastMatchMidi never cleared (silence gate might not fire if bass
    // sustain stays above the gate threshold). With onset-gated matching
    // available this is only exercised when the onset detector misses the
    // attack (soft plucks, slurs).
    if (_ndStableMidi === _ndLastMatchMidi && (now - _ndLastMatchTime) < 1.0) return;
    _ndLastMatchMidi = _ndStableMidi;
    _ndLastMatchTime = now;
    _ndMatchNotes();
}

// ── Frequency / MIDI Conversion ────────────────────────────────────────────

function _ndFreqToMidi(freq) {
    return 12 * Math.log2(freq / 440) + 69;
}

function _ndMidiFromStringFret(string, fret, arrangement = _ndCurrentArrangement) {
    const base = _ndStandardMidiFor(arrangement);
    return base[string] + _ndTuningOffsets[string] + _ndCapo + fret;
}

function _ndMidiToStringFret(midiNote, arrangement = _ndCurrentArrangement) {
    // Pure geometric fallback: find the string/fret combination with the
    // lowest fret number (prefer open strings and low positions over high
    // frets on lower strings). When tied on fret, prefer higher string
    // index (thinner string). This gives musically sensible assignments:
    // MIDI 43 on bass → s3/f0 (open G), not s0/f15.
    const base = _ndStandardMidiFor(arrangement);
    let bestString = -1;
    let bestFret = 25; // start worse than any valid fret
    for (let s = 0; s < base.length; s++) {
        const openMidi = base[s] + _ndTuningOffsets[s] + _ndCapo;
        const fret = Math.round(midiNote - openMidi);
        if (fret < 0 || fret > 24) continue;
        // Prefer lowest fret; on tie prefer highest string index
        if (fret < bestFret || (fret === bestFret && s > bestString)) {
            bestString = s;
            bestFret = fret;
        }
    }
    if (bestString < 0) return { string: -1, fret: -1 };
    return { string: bestString, fret: bestFret };
}

// Chart-context-aware fingering resolver. If any candidate chart note's
// expected pitch is within the pitch tolerance of the detected MIDI, return
// that note's (string, fret) — the player is hitting the charted fingering.
// Otherwise fall back to the geometric first-match on the arrangement's
// tuning. This mirrors what score-follower apps (e.g. Rocksmith) do: trust
// the chart for display when the player is on-pitch, only guess when they
// aren't.
function _ndResolveDisplayFingering(detectedMidi, candidateNotes, arrangement = _ndCurrentArrangement, pitchToleranceCents = _ndPitchTolerance) {
    if (candidateNotes && candidateNotes.length > 0) {
        for (const cn of candidateNotes) {
            const expected = _ndMidiFromStringFret(cn.s, cn.f, arrangement);
            if (Math.abs(detectedMidi - expected) * 100 <= pitchToleranceCents) {
                return { string: cn.s, fret: cn.f };
            }
        }
    }
    return _ndMidiToStringFret(detectedMidi, arrangement);
}

// ── Note Matching ──────────────────────────────────────────────────────────

function _ndNoteKey(note, time) {
    // Unique key for a note event
    return `${time.toFixed(3)}_${note.s}_${note.f}`;
}

// Per-frame hygiene tracking. For each chart note whose [chartT - early,
// chartT + late] window contains `t`, record whether the current YIN frame
// (raw _ndDetectedMidi) matches the expected pitch within tolerance. The
// tally is consumed at HIT or miss-deadline time to label the result as
// CLEAN or DIRTY based on the strictness threshold.
function _ndUpdateNoteHygiene(t) {
    if (_ndDetectedMidi <= 0 || _ndDetectedConfidence < 0.7) return;
    const earlyWindowSec = _ndTimingTolerance;
    const lateWindowSec = _ndTimingTolerance * 2;
    const lookback = t - lateWindowSec;
    const lookahead = t + earlyWindowSec;
    const visit = (note, midiBase) => {
        if (note.t < lookback) return false;
        if (note.t > lookahead) return true; // sorted; signal stop
        const key = _ndNoteKey(note, note.t);
        const expectedMidi = midiBase + _ndPitchOffset;
        const rawCents = (_ndDetectedMidi - expectedMidi) * 100;
        const octCents = rawCents - 1200;
        const cents = Math.abs(octCents) < Math.abs(rawCents) ? octCents : rawCents;
        const onTarget = Math.abs(cents) <= _ndPitchTolerance;
        let h = _ndNoteHygiene.get(key);
        if (!h) {
            h = { onTargetFrames: 0, offTargetFrames: 0, contaminantMidis: new Map() };
            _ndNoteHygiene.set(key, h);
        }
        if (onTarget) h.onTargetFrames++;
        else {
            h.offTargetFrames++;
            const detected = Math.round(_ndDetectedMidi);
            h.contaminantMidis.set(detected, (h.contaminantMidis.get(detected) || 0) + 1);
        }
        return false;
    };
    const notes = highway.getNotes ? highway.getNotes() : [];
    const chords = highway.getChords ? highway.getChords() : [];
    // Walk forward from a binary-searched start so we don't pay for the full
    // chart on every YIN frame. Notes are sorted by t.
    const noteStart = _ndBsearch(notes, lookback);
    for (let i = noteStart; i < notes.length; i++) {
        const n = notes[i];
        if (visit(n, _ndMidiFromStringFret(n.s, n.f))) break;
    }
    const chordStart = _ndBsearch(chords, lookback);
    for (let i = chordStart; i < chords.length; i++) {
        const c = chords[i];
        if (c.t > lookahead) break;
        for (const cn of c.notes || []) {
            if (visit({ s: cn.s, f: cn.f, t: c.t }, _ndMidiFromStringFret(cn.s, cn.f))) {
                i = chords.length; break;
            }
        }
    }
}

function _ndComputeHygieneSummary(key) {
    const h = _ndNoteHygiene.get(key);
    if (!h) return null;
    const total = h.onTargetFrames + h.offTargetFrames;
    if (total === 0) return null;
    const onTargetRatio = h.onTargetFrames / total;
    const contaminants = [...h.contaminantMidis.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([midi, count]) => ({ midi, count }));
    return {
        onTargetFrames: h.onTargetFrames,
        offTargetFrames: h.offTargetFrames,
        onTargetRatio,
        contaminants,
    };
}

// Binary search: find index of first element with .t >= target
function _ndBsearch(arr, target) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].t < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// Chart-density probe: does the chart have any unmuted note (or chord
// containing one) starting within `lookaheadSec` of the current chart time?
// Used by the onset detector to know when to relax the refractory + rearm
// gates for rapid repeat passages. Cheap: bsearch + at most a few node
// peeks. Returns false if highway data isn't ready.
function _ndChartHasNoteWithin(lookaheadSec) {
    if (!highway || !highway.getTime) return false;
    const t = highway.getTime();
    const notes = highway.getNotes ? highway.getNotes() : null;
    const chords = highway.getChords ? highway.getChords() : null;
    const tEnd = t + lookaheadSec;

    if (notes && notes.length > 0) {
        const start = _ndBsearch(notes, t);
        for (let i = start; i < notes.length; i++) {
            const n = notes[i];
            if (n.t > tEnd) break;
            if (!n.mt) return true;
        }
    }
    if (chords && chords.length > 0) {
        const start = _ndBsearch(chords, t);
        for (let i = start; i < chords.length; i++) {
            const c = chords[i];
            if (c.t > tEnd) break;
            for (const cn of (c.notes || [])) {
                if (!cn.mt) return true;
            }
        }
    }
    return false;
}

// tOverride: optional pre-computed chart time. When provided (from an
// onset-gated match trigger), the onset already captured the attack's chart
// time, so no _ndDetectionLatencySec compensation is applied — the onset IS
// the timing event. When omitted (fallback stable-MIDI-change trigger), the
// legacy compensation path runs.
function _ndMatchNotes(tOverride) {
    const scoreMidi = _ndStableMidi;
    if (scoreMidi < 0) return;
    let t;
    if (tOverride != null) {
        t = tOverride;
    } else {
        // Fallback path — no onset fired, match is triggered by stable-MIDI
        // change. Use a small fixed stability-vote lag instead of the legacy
        // _ndDetectionLatencySec value, which was historically set by the
        // calibration wizard to ~500 ms for the stable-MIDI-change trigger.
        // That 500 ms shift forced users to play LATE (200+ ms) for hits to
        // register here — the fingerprint was HITs in the dump labelled LATE
        // with +200 to +600 ms timing errors. See classify-session analysis
        // of mexico_full_play_apr24.wav for the evidence.
        t = highway.getTime() - _ND_FALLBACK_STABILITY_LAG_SEC;
    }

    const notes = highway.getNotes();
    const chords = highway.getChords();
    // Asymmetric hit window per docs/ROCKSMITH_TIMING_MODEL.md.
    // _ndDetectionLatencySec compensates the pipeline bias; late bound is
    // 2× early to absorb residual detection-pipeline jitter. If hits land
    // with dtMs consistently negative, the latency offset is over-calibrated
    // — fix the latency, don't widen the window.
    const earlyWindowSec = _ndTimingTolerance;
    const lateWindowSec = _ndTimingTolerance * 2;
    const centsTolerance = _ndPitchTolerance;
    // Shift the search center forward by the rolling drift estimate.
    // Equivalent to shifting each chart note's effective .t backward
    // by the same amount — i.e., "the chart says this note is at C,
    // but the audio is consistently arriving D ms later, so search as
    // if the chart said C+D".
    const driftSec = _ndDriftEstimateMs / 1000;
    const tCenter = t - driftSec;

    const candidateNotes = [];

    // Candidate notes sit within [tCenter - lateWindow, tCenter + earlyWindow]
    // around the detection-adjusted, drift-compensated chart time.
    if (notes && notes.length > 0) {
        const start = _ndBsearch(notes, tCenter - lateWindowSec);
        for (let i = start; i < notes.length; i++) {
            const n = notes[i];
            if (n.t > tCenter + earlyWindowSec) break;
            if (n.mt) continue; // skip muted notes
            candidateNotes.push({ s: n.s, f: n.f, t: n.t });
        }
    }
    if (chords && chords.length > 0) {
        const start = _ndBsearch(chords, tCenter - lateWindowSec);
        for (let i = start; i < chords.length; i++) {
            const c = chords[i];
            if (c.t > tCenter + earlyWindowSec) break;
            for (const cn of (c.notes || [])) {
                if (cn.mt) continue;
                candidateNotes.push({ s: cn.s, f: cn.f, t: c.t });
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

    // Resolve HUD/overlay fingering — prefer the chart's (s, f) when the
    // player is hitting a candidate pitch, otherwise fall back to the
    // geometric first-match on the arrangement's tuning.
    const disp = _ndResolveDisplayFingering(scoreMidi, candidateNotes, _ndCurrentArrangement, centsTolerance);
    _ndDetectedString = disp.string;
    _ndDetectedFret = disp.fret;

    // Diagnostic: find the closest-in-time candidate and record how far off
    // detection was (timing + pitch). Even if the note doesn't pass tolerance,
    // the readout shows why so the user can calibrate.
    let closest = null;
    let closestDt = Infinity;
    for (const cn of candidateNotes) {
        const dt = (t - cn.t) * 1000; // ms; positive = detection is late
        if (Math.abs(dt) < Math.abs(closestDt)) {
            closest = cn;
            closestDt = dt;
        }
    }
    if (closest) {
        const expectedMidi = _ndMidiFromStringFret(closest.s, closest.f) + _ndPitchOffset;
        const centsErr = (scoreMidi - expectedMidi) * 100;
        const hit = closestDt >= -earlyWindowSec * 1000
                 && closestDt <= lateWindowSec * 1000
                 && Math.abs(centsErr) <= centsTolerance;
        const evt = {
            dtMs: closestDt, centsErr, hit, time: t,
            detectedMidi: scoreMidi,
            expectedMidi,
            chartNote: `s${closest.s}/f${closest.f}`,
            chartT: closest.t,
        };
        _ndEventLog.push(evt);
        if (_ndEventLog.length > _ND_EVENT_WINDOW) _ndEventLog.shift();
        if (window._ndCaptureAllEvents) {
            if (!window._ndAllEvents) window._ndAllEvents = [];
            window._ndAllEvents.push(evt);
        }
    }

    // Pass 1: compute per-candidate pitch/timing errors, update the
    // diagnostic pitch-attempt tracker for every candidate, and collect the
    // subset that passes pitch tolerance and isn't already judged.
    //
    // Pass 2 picks exactly one of those candidates (nearest-in-time) to mark
    // HIT. The old all-against-all loop would mark every same-pitch candidate
    // HIT on a single detection — causing repeated-note passages to score
    // 2/2 on the first pluck and 0/2 on the second. See
    // docs/NOTEDETECT_IMPLEMENTATION_GAPS.md Gap 2.
    const pitchPassing = [];
    for (const cn of candidateNotes) {
        const key = _ndNoteKey(cn, cn.t);

        const expectedMidi = _ndMidiFromStringFret(cn.s, cn.f) + _ndPitchOffset;
        const rawCents = (scoreMidi - expectedMidi) * 100;
        // Octave-up harmonic tolerance: a detection one octave above expected
        // counts as a match when that's the closer interval. Still
        // chart-context-aware — only applied when it explains a match.
        const octCents = (scoreMidi - 12 - expectedMidi) * 100;
        const pitchError = Math.abs(octCents) < Math.abs(rawCents) ? octCents : rawCents;
        const timingError = (t - cn.t) * 1000;

        const prev = _ndNotePitchAttempts.get(key);
        if (prev === undefined || Math.abs(pitchError) < Math.abs(prev)) {
            _ndNotePitchAttempts.set(key, pitchError);
        }

        if (_ndNoteResults.has(key)) continue;
        if (Math.abs(pitchError) <= centsTolerance) {
            pitchPassing.push({ cn, key, expectedMidi, pitchError, timingError });
        }
    }

    if (pitchPassing.length === 0) return;

    // Two-tier selection: prefer exact-pitch candidates over boundary-pitch
    // ones regardless of timing, then pick nearest-in-time within the tier.
    //
    // Without this, a single detection can get pulled to a neighbour chart
    // note whose expected pitch is right at the tolerance boundary (e.g.
    // MIDI 30 accepting a MIDI 31 detection at +100¢) instead of a
    // same-pitch chart note slightly further away in time. Observed on the
    // Level session: chart 129.360 (MIDI 31, exact match) was stolen by
    // chart 129.764 (MIDI 30, +100¢ boundary match) because the latter was
    // 60 ms timing-closer. Tiering fixes this cleanly without widening or
    // narrowing any tolerance.
    const EXACT_PITCH_CENTS = 25;
    const exactPitch = pitchPassing.filter(p => Math.abs(p.pitchError) < EXACT_PITCH_CENTS);
    const pool = exactPitch.length > 0 ? exactPitch : pitchPassing;
    // Pool sort uses drift-adjusted timing error so the nearest-in-time
    // selection picks the chart note that the player actually targeted,
    // not the one closest to the un-compensated chart-time clock.
    pool.sort((a, b) =>
        Math.abs(a.timingError - _ndDriftEstimateMs) - Math.abs(b.timingError - _ndDriftEstimateMs));
    const winner = pool[0];
    const { cn, key, expectedMidi, pitchError, timingError } = winner;
    // Adjust timing for LATE/EARLY labels: if the song is drifting +200 ms,
    // a HIT at +200 ms is "on time" within the drift, not LATE. Raw
    // timingError still goes into the snapshot so analytics show the
    // actual chart-vs-audio offset.
    const adjustedTimingError = timingError - _ndDriftEstimateMs;

    const labels = [];
    if (adjustedTimingError > _ndPerfectTimingMs)       { labels.push('LATE');  _ndLate++; }
    else if (adjustedTimingError < -_ndPerfectTimingMs) { labels.push('EARLY'); _ndEarly++; }
    if (pitchError > _ndPerfectPitchCent)       { labels.push('SHARP'); _ndSharp++; }
    else if (pitchError < -_ndPerfectPitchCent) { labels.push('FLAT');  _ndFlat++; }
    // Feed the drift estimator with the raw observed timing so future
    // matches benefit from the rolling-median.
    _ndUpdateDriftEstimate(timingError);
    // Feed the AV-offset calibrator if it's running. No-op when not.
    _ndCalibrationFeedHit(timingError);

    _ndNoteResults.set(key, {
        primary: 'HIT',
        labels,
        timingError,
        pitchError,
        detectedMidi: scoreMidi,
        expectedMidi,
        severity: _ndSeverity('HIT', timingError, pitchError),
        s: cn.s,
        f: cn.f,
        chartT: cn.t,
    });
    _ndHits++;
    _ndStreak++;
    if (_ndStreak > _ndBestStreak) _ndBestStreak = _ndStreak;
    _ndUpdateSectionStat('hit');
    _ndRecordNowlineJudgment(cn.s, cn.f, _ndNoteResults.get(key));
}

// Aggregate stats over the rolling event log. Returns null if not enough data.
function _ndStats() {
    if (_ndEventLog.length < 3) return null;
    const dts = _ndEventLog.map(e => e.dtMs);
    const cs = _ndEventLog.map(e => e.centsErr);
    const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
    const std = (a, m) => Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length);
    const dtMean = mean(dts);
    const cMean = mean(cs);
    return {
        dtMean, dtStd: std(dts, dtMean),
        cMean, cStd: std(cs, cMean),
        n: _ndEventLog.length,
    };
}

// ── Calibration Wizard (metronome) ─────────────────────────────────────────
// Plays a metronome at 75 BPM; user plays bass in time with each beat
// (anticipated, not reactive — that's the whole point). For each measured
// beat, we find the closest detection event and record the time offset.
// Median across 8 measured beats gives the real, user-independent system
// latency:
//
//   Visual run: flash only. dt = detection_time − flash_time. This isolates
//   MIC INPUT LAG (plus a tiny render delay, ~16 ms).
//
//   Audio run: click (1 kHz burst) + flash. dt = detection_time − click_emit.
//   This is MIC LAG + AUDIO OUTPUT LAG (user plays when they HEAR the click,
//   and the click has to go through the audio output pipeline before being
//   audible).
//
//   audio_run − visual_run ≈ audio output lag alone.
//
// Reaction-time subtraction isn't needed because the user is anticipating
// each beat (that's the difference from a flash-then-react design).
//
// Applies to:
//   _ndDetectionLatencySec  ← audio_run (total round-trip; correct for scoring)
//   core av_offset_ms ← audio_run − visual_run (audio output lag; correct
//                       for shifting the highway so visuals match what you
//                       hear)

const _ND_METRO_BPM = 75;
const _ND_METRO_BEATS_TOTAL = 18;
const _ND_METRO_COUNTIN = 2;
const _ND_METRO_BEAT_WINDOW_MS = 400;   // detection must land within ±this of a beat

let _ndWizStep = 'closed';        // 'closed' | 'intro' | 'running-visual' | 'running-audio' | 'review'
let _ndWizBeats = [];             // wall times (performance.now) of measured beats
let _ndWizDetections = [];        // [{time, midi}] of detection events during a run
let _ndWizVisualRun = null;       // {perBeat, medianDt, droppedOutliers, dropped}
let _ndWizAudioRun = null;
let _ndWizTimers = [];
let _ndWizAudioCtx = null;
let _ndWizBallRaf = null;
let _ndWizBallOrigin = 0;        // performance.now() at which ball == center for first beat

// Back-compat accessors so callers that still read the old variables work.
Object.defineProperty(globalThis, '_ndWizVisualOffsetMs', { get: () => _ndWizVisualRun ? _ndWizVisualRun.medianDt : null, configurable: true });
Object.defineProperty(globalThis, '_ndWizAudioOffsetMs',  { get: () => _ndWizAudioRun  ? _ndWizAudioRun.medianDt  : null, configurable: true });

function _ndOpenWizard() {
    _ndWizStep = 'intro';
    _ndWizVisualRun = null;
    _ndWizAudioRun = null;
    _ndWizRender();
}

function _ndCloseWizard() {
    _ndWizCancelTimers();
    _ndWizStopBall();
    _ndWizStep = 'closed';
    const m = document.getElementById('nd-wizard-modal');
    if (m) m.remove();
}

function _ndWizCancelTimers() {
    for (const t of _ndWizTimers) clearTimeout(t);
    _ndWizTimers = [];
}

// Bouncing-ball metronome animation. Ball crosses the centre line on EVERY
// beat and reaches the edges at the halfway point between beats, so the
// trajectory gives the user anticipation — they can see the ball approaching
// centre and play exactly when it arrives, rather than trying to react to a
// point-in-time cue (flash/click) they can't anticipate.
function _ndWizStartBall() {
    _ndWizStopBall();
    const intervalMs = 60000 / _ND_METRO_BPM;
    const tick = () => {
        if (_ndWizStep !== 'running-visual' && _ndWizStep !== 'running-audio') {
            _ndWizBallRaf = null;
            return;
        }
        const ball = document.getElementById('nd-wiz-ball');
        const flash = document.getElementById('nd-wiz-metro-flash');
        if (ball && _ndWizBallOrigin > 0) {
            // Linear (triangle-wave) motion at constant velocity. Period =
            // 2 beats: centre on every beat, ±edge on every half-beat. The
            // earlier sine-wave variant accelerated through the centre,
            // making the exact line-crossing moment hard to time — high
            // variance in tap timing because the ball is moving fastest
            // exactly when the user needs to read the position.
            const elapsedBeats = (performance.now() - _ndWizBallOrigin) / intervalMs;
            const p2 = ((elapsedBeats % 2) + 2) % 2;  // [0, 2)
            // Triangle wave: 0 → +1 (peak at p2=0.5) → 0 (at p2=1) → −1
            // (trough at p2=1.5) → 0 (at p2=2). Constant slope between
            // breakpoints.
            let v;
            if (p2 < 0.5)      v = 2 * p2;
            else if (p2 < 1.5) v = 2 - 2 * p2;
            else               v = -4 + 2 * p2;
            const x = 0.5 + 0.5 * v;
            // 12% ball width → calc offset = 6% so centre tracks x exactly
            ball.style.left = `calc(${(x * 100).toFixed(2)}% - 24px)`;

            // Centre-line pulse: bright flash on the beat moment so the
            // user gets a redundant "tap NOW" cue alongside the ball
            // position. Decays over 150ms.
            if (flash) {
                const beatProximity = Math.min(p2 % 1, 1 - (p2 % 1));
                const beatMs = beatProximity * intervalMs;
                if (beatMs < 150) {
                    const intensity = 1 - beatMs / 150;
                    flash.style.background = `rgba(140, 220, 255, ${(0.3 + 0.6 * intensity).toFixed(2)})`;
                    flash.style.boxShadow = `0 0 ${(8 + 14 * intensity).toFixed(0)}px rgba(140, 220, 255, ${(0.4 * intensity).toFixed(2)})`;
                } else {
                    flash.style.background = 'rgba(120, 120, 120, 0.5)';
                    flash.style.boxShadow = 'none';
                }
            }
        }
        _ndWizBallRaf = requestAnimationFrame(tick);
    };
    _ndWizBallRaf = requestAnimationFrame(tick);
}

function _ndWizStopBall() {
    if (_ndWizBallRaf) {
        cancelAnimationFrame(_ndWizBallRaf);
        _ndWizBallRaf = null;
    }
}

function _ndWizStartRun(mode) {
    _ndWizStep = 'running-' + mode;
    _ndWizBeats = [];
    _ndWizDetections = [];
    _ndWizCancelTimers();

    const intervalMs = 60000 / _ND_METRO_BPM;
    const startDelay = 1200;
    const origin = performance.now() + startDelay;
    // Ball reaches centre on every beat; the first beat anchors it.
    _ndWizBallOrigin = origin;

    for (let i = 0; i < _ND_METRO_BEATS_TOTAL; i++) {
        const when = origin + i * intervalMs;
        const isCountIn = i < _ND_METRO_COUNTIN;
        const delay = Math.max(0, when - performance.now());
        _ndWizTimers.push(setTimeout(() => _ndWizFireBeat(isCountIn, mode), delay));
    }
    const finishDelay = startDelay + _ND_METRO_BEATS_TOTAL * intervalMs + 500;
    _ndWizTimers.push(setTimeout(() => _ndWizFinishRun(mode), finishDelay));

    _ndWizRender();
    // Only animate the ball for the visual run. Audio run is deliberately
    // visual-free so the user can only lock onto the audible click.
    if (mode === 'visual') _ndWizStartBall();
}

function _ndWizFireBeat(isCountIn, mode) {
    const now = performance.now();

    // Flash the centre line briefly when a beat fires. Confirms alignment
    // between "ball at centre" and the actual beat time without turning
    // the metronome back into a point-in-time-only cue.
    const line = document.getElementById('nd-wiz-metro-flash');
    if (line) {
        const color = isCountIn ? '#888' : '#00ff88';
        line.style.backgroundColor = color;
        line.style.boxShadow = isCountIn ? 'none' : '0 0 18px 4px #00ff88';
        setTimeout(() => {
            if (document.getElementById('nd-wiz-metro-flash') === line) {
                line.style.backgroundColor = '#6b7280';
                line.style.boxShadow = 'none';
            }
        }, 180);
    }

    if (mode === 'audio') {
        if (!_ndWizAudioCtx) _ndWizAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const ctx = _ndWizAudioCtx;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = isCountIn ? 700 : 1000;
        osc.type = 'square';
        osc.connect(gain).connect(ctx.destination);
        const t0 = ctx.currentTime;
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(0.3, t0 + 0.002);
        gain.gain.linearRampToValueAtTime(0, t0 + 0.06);
        osc.start(t0);
        osc.stop(t0 + 0.08);
    }

    if (!isCountIn) _ndWizBeats.push(now);

    // Update ONLY the counter — don't re-render the modal, that would
    // replace the flash element while its fade-off timer is still running
    // (which is why the flash was previously invisible).
    const counter = document.getElementById('nd-wiz-counter');
    if (counter) {
        const beatsExpected = _ND_METRO_BEATS_TOTAL - _ND_METRO_COUNTIN;
        counter.textContent = `${_ndWizBeats.length} / ${beatsExpected}`;
    }
}

function _ndWizFinishRun(mode) {
    // Pre-filter detections to "fresh" ones — the first detection after a
    // silence gap. Using gap-only (not pitch-change) because YIN's pitch
    // jitters during the attack transient of each pluck: a single pluck can
    // briefly report 5-6 different midi values in the first 100 ms before
    // settling. Counting each jitter as a "fresh pluck" adds spurious events
    // that pollute the beat-to-pluck assignment.
    //
    // Trade-off: if the user plays sustained notes with no gap between
    // plucks (e.g. long-sustain open-string bass at 75 BPM), gap filtering
    // misses re-plucks of the same note. Instructions on the running panel
    // tell the user to play short / palm-muted notes so there's an audible
    // silence between plucks for the gap filter to catch.
    const _ND_FRESH_GAP_MS = 120;
    const fresh = [];
    let lastTime = -Infinity;
    for (const det of _ndWizDetections) {
        if (det.time - lastTime > _ND_FRESH_GAP_MS) {
            fresh.push(det);
        }
        lastTime = det.time;
    }

    // Assignment: for each beat, find the fresh detection within the beat
    // window closest in time. "Closest-by-abs-dt" is correct now because
    // sustain detections are already filtered out — each remaining detection
    // is an attack event, so the one closest to the beat is "this beat's
    // pluck."
    const perBeat = _ndWizBeats.map(beatT => {
        let picked = null;
        let pickedDt = null;
        for (const det of fresh) {
            const dt = det.time - beatT;
            if (Math.abs(dt) > _ND_METRO_BEAT_WINDOW_MS) continue;
            if (picked === null || Math.abs(dt) < Math.abs(pickedDt)) {
                picked = det;
                pickedDt = dt;
            }
        }
        return { beatT, dt: pickedDt, detection: picked };
    });

    // Outlier rejection: drop values more than 2σ from the mean. With a
    // musician who occasionally misses a beat or plays one wildly off, a
    // single bad sample pulls the naïve median around. σ-trimming is a
    // decent compromise — we keep reporting the raw per-beat numbers so the
    // user can see which were dropped.
    const dts = perBeat.filter(b => b.dt !== null).map(b => b.dt);
    let droppedOutliers = 0;
    let used = dts;
    if (dts.length >= 4) {
        const mean = dts.reduce((s, x) => s + x, 0) / dts.length;
        const variance = dts.reduce((s, x) => s + (x - mean) * (x - mean), 0) / dts.length;
        const std = Math.sqrt(variance);
        used = dts.filter(x => Math.abs(x - mean) <= 2 * std);
        droppedOutliers = dts.length - used.length;
    }
    const sorted = used.slice().sort((a, b) => a - b);
    const medianDt = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;

    const runResult = {
        perBeat, medianDt, droppedOutliers,
        droppedNoDetection: perBeat.length - dts.length,
        usedCount: used.length,
    };
    if (mode === 'visual') _ndWizVisualRun = runResult;
    else if (mode === 'audio') _ndWizAudioRun = runResult;

    _ndWizStep = 'intro';
    _ndWizRender();
}

// Hook called from _ndProcessFrame on every detection event. Captures the
// detected MIDI value alongside the timestamp so the review screen can show
// per-beat pitch info (helpful for diagnosing why a beat was skipped — YIN
// locked on a harmonic, fingered a different note, etc.).
function _ndWizOnDetection() {
    if (_ndWizStep === 'running-visual' || _ndWizStep === 'running-audio') {
        _ndWizDetections.push({
            time: performance.now(),
            midi: _ndDetectedMidi,
        });
    }
}

async function _ndWizApplyMetro() {
    const visualMs = _ndWizVisualOffsetMs !== null ? Math.round(_ndWizVisualOffsetMs) : null;
    const audioMs  = _ndWizAudioOffsetMs  !== null ? Math.round(_ndWizAudioOffsetMs)  : null;

    // Mic capture latency = audio run median dt (time from metronome click
    // to onset detection). This IS the structural lateness baked into
    // every live timingError — the gap between speaker output and the
    // moment the mic chunk reaches the onset detector. Subtracted from
    // highway labels and the prescription engine so the player sees
    // their actual offset, not the hardware-stack delay.
    if (audioMs !== null) {
        const applied = Math.max(0, audioMs);
        _ndMicLatencyMs = applied;
        _ndSaveSettings();
        console.log(`[note_detect] Mic latency calibrated: ${applied} ms (audio run median)`);
    }

    // Slopsmith core A/V sync offset = (visual run − audio run). The
    // direction: if dt_visual > dt_audio, your visual feedback is arriving
    // later than your audio feedback, so visuals need to shift FORWARD —
    // positive avOffset. If dt_audio > dt_visual, opposite (negative).
    if (audioMs !== null && visualMs !== null) {
        const raw = visualMs - audioMs;
        const avMs = Math.max(-1000, Math.min(1000, raw));
        try {
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ av_offset_ms: avMs }),
            });
            if (typeof setAvOffsetMs === 'function') setAvOffsetMs(avMs);
        } catch (e) { console.warn('A/V offset save failed:', e); }
    }

    _ndResetScoring();
    _ndCloseWizard();
}

function _ndWizRender() {
    let modal = document.getElementById('nd-wizard-modal');
    if (_ndWizStep === 'closed') {
        if (modal) modal.remove();
        return;
    }
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'nd-wizard-modal';
        modal.className = 'fixed inset-0 z-[300] flex items-center justify-center bg-black/70 backdrop-blur-sm';
        document.body.appendChild(modal);
    }

    const beatsDone = _ndWizBeats.length;
    const beatsExpected = _ND_METRO_BEATS_TOTAL - _ND_METRO_COUNTIN;
    const wrap = (inner) => `
        <div class="bg-dark-700 border border-gray-700 rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl text-gray-200">
            <div class="flex items-center justify-between mb-4">
                <h3 class="text-lg font-bold">Calibration Wizard</h3>
                <button onclick="_ndCloseWizard()" class="text-gray-400 hover:text-white">✕</button>
            </div>
            ${inner}
        </div>`;

    if (_ndWizStep === 'intro') {
        const vDone = _ndWizVisualOffsetMs !== null;
        const aDone = _ndWizAudioOffsetMs !== null;
        modal.innerHTML = wrap(`
            <p class="text-sm text-gray-300 mb-2">Plays a metronome at <strong>${_ND_METRO_BPM} BPM</strong>. Play your bass <strong>in time with each beat</strong> — anticipate, don't react.</p>
            <p class="text-[11px] text-gray-500 mb-4 leading-tight">First ${_ND_METRO_COUNTIN} beats are a count-in (dim). We measure the next ${beatsExpected}. Playing <em>with</em> the beat (not after it) means there's no human reaction time in the measurement.</p>
            <div class="space-y-2 mb-4">
                <button onclick="_ndWizStartRun('visual')" class="w-full flex items-center justify-between px-4 py-2 ${vDone ? 'bg-green-900/30 hover:bg-green-900/40' : 'bg-dark-600 hover:bg-dark-500'} rounded-xl text-sm">
                    <span><strong>1. Visual</strong> — flash only. Measures mic input lag.</span>
                    <span class="text-xs text-gray-400">${vDone ? `✓ ${Math.round(_ndWizVisualOffsetMs)} ms` : 'Start →'}</span>
                </button>
                <button onclick="_ndWizStartRun('audio')" class="w-full flex items-center justify-between px-4 py-2 ${aDone ? 'bg-green-900/30 hover:bg-green-900/40' : 'bg-dark-600 hover:bg-dark-500'} rounded-xl text-sm">
                    <span><strong>2. Audio</strong> — click + flash. Measures total round-trip.</span>
                    <span class="text-xs text-gray-400">${aDone ? `✓ ${Math.round(_ndWizAudioOffsetMs)} ms` : 'Start →'}</span>
                </button>
            </div>
            <div class="flex gap-3 justify-end">
                <button onclick="_ndCloseWizard()" class="px-4 py-2 bg-dark-600 hover:bg-dark-500 rounded-xl text-sm text-gray-300">Cancel</button>
                <button onclick="_ndWizStep='review'; _ndWizRender()" ${(vDone && aDone) ? '' : 'disabled'} class="px-4 py-2 bg-accent hover:bg-accent-light rounded-xl text-sm font-semibold text-white disabled:opacity-50">Review</button>
            </div>
        `);
    } else if (_ndWizStep === 'running-visual' || _ndWizStep === 'running-audio') {
        const mode = _ndWizStep.slice('running-'.length);
        // Deliberately: the visual cue (ball) appears only on the visual run.
        // The audio run shows a static "ears only" area and nothing moving,
        // so the user locks onto the audible click as their only cue. If we
        // also showed the ball on audio mode, the user could hit the pluck
        // at whichever cue arrived first, and we'd measure a blend of visual
        // and audio latency instead of audio alone.
        const runArea = mode === 'visual'
            ? `<div class="relative h-20 bg-dark-800 rounded-xl mb-3 overflow-hidden border border-gray-800">
                   <div id="nd-wiz-metro-flash" class="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-[6px]" style="background:rgba(120,120,120,0.5)"></div>
                   <div id="nd-wiz-ball" class="absolute top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-green-400" style="left:calc(50% - 24px); box-shadow:0 0 22px 6px rgba(0,255,136,0.6);"></div>
               </div>`
            : `<div class="flex items-center justify-center h-20 bg-dark-800 rounded-xl mb-3 border border-gray-800 text-gray-400 text-sm">
                   <span>🎧 Ears only</span>
               </div>`;
        const instr = mode === 'visual'
            ? 'Watch the ball. Play each time it crosses the <strong>centre line</strong>. Ball moves at constant speed (linear, no acceleration); the line flashes blue at each beat — use both cues to anticipate.'
            : 'Close your eyes or look away. Play each time you hear a <strong>click</strong>. No visual — we deliberately hide the ball here so you can only lock onto the audio cue.';
        modal.innerHTML = wrap(`
            <p class="text-sm text-gray-300 mb-3">${instr}</p>
            ${runArea}
            <div class="text-center text-lg font-mono text-gray-300 mb-3">
                <span id="nd-wiz-counter">${beatsDone} / ${beatsExpected}</span>
            </div>
            <div class="flex gap-3 justify-end">
                <button onclick="_ndWizCancelTimers();_ndWizStopBall();_ndWizStep='intro';_ndWizRender()"
                    class="px-4 py-2 bg-dark-600 hover:bg-dark-500 rounded-xl text-sm text-gray-300">Cancel run</button>
            </div>
        `);
    } else if (_ndWizStep === 'review') {
        const vRun = _ndWizVisualRun;
        const aRun = _ndWizAudioRun;
        const v = vRun ? vRun.medianDt : null;
        const a = aRun ? aRun.medianDt : null;
        const avRaw = (a !== null && v !== null) ? Math.round(v - a) : 0;
        const avApplied = Math.max(-1000, Math.min(1000, avRaw));
        const latRaw = a !== null ? Math.round(a) : 0;
        const latApplied = Math.max(0, latRaw);

        const warnings = [];
        if (v !== null && v < -40) warnings.push(`Visual run median is ${Math.round(v)} ms — detection landed before the flash on most beats. You're likely anticipating the beat rather than playing on it.`);
        if (a !== null && a < -40) warnings.push(`Audio run median is ${Math.round(a)} ms — same pattern.`);
        if (latRaw < 0) warnings.push(`Plugin Audio Latency clamped from ${latRaw} to <strong>${latApplied}</strong> (physical latency can't be negative).`);
        if (avRaw !== avApplied) warnings.push(`A/V Sync Offset clamped from ${avRaw} to <strong>${avApplied}</strong> (out of ±1000 ms range).`);

        const noteName = (m) => {
            if (m < 0 || !isFinite(m)) return '—';
            const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
            const r = Math.round(m);
            return `${names[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
        };

        const perBeatTable = (run, label) => {
            if (!run) return '';
            const rows = run.perBeat.map((b, i) => {
                const dtTxt = b.dt === null ? '<span class="text-gray-600">no detection</span>'
                    : `<span class="text-gray-200 font-mono">${b.dt >= 0 ? '+' : ''}${Math.round(b.dt)} ms</span>`;
                const note = b.detection ? noteName(b.detection.midi) : '—';
                // Flag outliers: used set = |dt − mean| ≤ 2σ of raw (same check
                // we did in finishRun); regenerate quickly so we can mark them.
                const dts = run.perBeat.filter(x => x.dt !== null).map(x => x.dt);
                let outlier = false;
                if (b.dt !== null && dts.length >= 4) {
                    const mean = dts.reduce((s, x) => s + x, 0) / dts.length;
                    const std = Math.sqrt(dts.reduce((s, x) => s + (x - mean) * (x - mean), 0) / dts.length);
                    outlier = Math.abs(b.dt - mean) > 2 * std;
                }
                return `
                    <tr class="${outlier ? 'text-yellow-400' : ''}">
                        <td class="py-0.5 pr-2 text-gray-500">${i + 1}</td>
                        <td class="py-0.5 pr-2">${dtTxt}</td>
                        <td class="py-0.5 pr-2 font-mono text-gray-500">${note}</td>
                        <td class="py-0.5 text-[10px] text-yellow-500">${outlier ? 'outlier' : ''}</td>
                    </tr>`;
            }).join('');
            return `
                <details class="mb-3 bg-dark-800 rounded-xl p-3 text-xs">
                    <summary class="cursor-pointer text-gray-300 font-semibold">${label} · per-beat data (${run.usedCount} of ${run.perBeat.length} used)</summary>
                    <table class="mt-2 w-full text-xs">
                        <thead class="text-gray-500 text-left">
                            <tr><th class="pr-2">#</th><th class="pr-2">dt</th><th class="pr-2">detected</th><th></th></tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                    <p class="text-[10px] text-gray-600 mt-2 leading-tight">
                        ${run.droppedNoDetection} beats had no detection within ±${_ND_METRO_BEAT_WINDOW_MS} ms · ${run.droppedOutliers} dropped as outliers · median of remaining used as the run's value.
                    </p>
                </details>`;
        };

        modal.innerHTML = wrap(`
            <div class="bg-dark-800 rounded-xl p-3 mb-3 space-y-2 text-sm">
                <div class="flex justify-between"><span class="text-gray-400">Visual run (dt_v, n=${vRun ? vRun.usedCount : 0})</span><span class="text-gray-200 font-mono">${v !== null ? (v >= 0 ? '+' : '') + Math.round(v) + ' ms' : '—'}</span></div>
                <div class="flex justify-between"><span class="text-gray-400">Audio run (dt_a, n=${aRun ? aRun.usedCount : 0})</span><span class="text-gray-200 font-mono">${a !== null ? (a >= 0 ? '+' : '') + Math.round(a) + ' ms' : '—'}</span></div>
                <hr class="border-gray-700">
                <div class="flex justify-between"><span class="text-gray-300">A/V Sync Offset (= V − A)</span><span class="text-gray-200 font-mono font-semibold">${avRaw >= 0 ? '+' : ''}${avRaw} ms</span></div>
                <div class="flex justify-between"><span class="text-gray-300">Plugin Audio Latency</span><span class="text-gray-200 font-mono font-semibold">${latApplied} ms</span></div>
            </div>
            ${perBeatTable(vRun, 'Visual')}
            ${perBeatTable(aRun, 'Audio')}
            ${warnings.length ? `
                <div class="bg-yellow-900/30 border border-yellow-800/50 rounded-xl p-3 mb-3 text-[11px] text-yellow-200 leading-tight space-y-1">
                    ${warnings.map(w => `<div>${w}</div>`).join('')}
                </div>` : ''}
            <p class="text-[11px] text-gray-500 mb-3 leading-tight">Yellow rows = outliers (&gt;2σ from mean). They're dropped from the median. Fine-tune on the player with <code>[</code> / <code>]</code> after Apply if the number still feels off.</p>
            <div class="flex gap-3 justify-end">
                <button onclick="_ndCloseWizard()" class="px-4 py-2 bg-dark-600 hover:bg-dark-500 rounded-xl text-sm text-gray-300">Discard</button>
                <button onclick="_ndWizStep='intro'; _ndWizRender()" class="px-4 py-2 bg-dark-600 hover:bg-dark-500 rounded-xl text-sm text-gray-300">Re-run</button>
                <button onclick="_ndWizApplyMetro()" class="px-4 py-2 bg-accent hover:bg-accent-light rounded-xl text-sm font-semibold text-white">Apply</button>
            </div>
        `);
    }
}

// ── Tuner ──────────────────────────────────────────────────────────────────
// Standalone per-string tuning mode. User plays each open string; plugin
// assigns it to the nearest expected open-string pitch in the active
// arrangement's tuning table and shows cents offset. Decoupled from chart
// matching — only cares about pitch vs. expected open-string pitch.
//
// Lifecycle:
//   _ndOpenTuner()  — starts audio if not already running (remembers prior
//                     state so closing restores it), renders the modal,
//                     kicks off a ~15fps display refresh interval.
//   _ndCloseTuner() — tears all that down, restores detection's prior state.
//
// Detection feed:
//   _ndTunerOnDetection(freq) is called from _ndProcessFrame whenever the
//   tuner is open. We compute the nearest open-string fingering (via MIDI
//   proximity, threshold 1.5 semitones so fretted notes are ignored) and
//   record the latest reading for that string. Readings older than 1500 ms
//   display as "silent" so the meter returns to rest when the player stops.

const _ND_TUNER_WINDOW_MS  = 1500;        // reading is "stale" after this
const _ND_TUNER_STRING_TOL = 1.5;         // semitones; outside → not an open string
let _ndTunerOpen = false;
let _ndTunerPriorEnabled = false;         // was detection on before we opened?
let _ndTunerReadings = new Map();         // string idx -> {freq, cents, expectedHz, timestamp}
let _ndTunerRefreshInterval = null;

async function _ndOpenTuner() {
    _ndTunerPriorEnabled = _ndEnabled;
    _ndTunerReadings = new Map();
    _ndTunerOpen = true;

    // Make sure audio + YIN are running. If detection wasn't already on,
    // start the audio pipeline but without scoring/HUD — tuner runs in a
    // detection-only mode.
    if (!_ndEnabled) {
        const ok = await _ndStartAudio();
        if (!ok) {
            _ndTunerOpen = false;
            return;
        }
        // Pull the current song's tuning info so the tuner's expected pitches
        // reflect Drop D / Eb / etc. rather than always being Standard.
        const info = highway.getSongInfo && highway.getSongInfo();
        if (info && info.tuning) _ndTuningOffsets = info.tuning;
        if (info && info.arrangement) _ndSetArrangement(info.arrangement);
    }

    _ndTunerRender();
    if (_ndTunerRefreshInterval) clearInterval(_ndTunerRefreshInterval);
    _ndTunerRefreshInterval = setInterval(_ndTunerUpdateReadings, 66); // ~15 fps
}

function _ndCloseTuner() {
    _ndTunerOpen = false;
    if (_ndTunerRefreshInterval) { clearInterval(_ndTunerRefreshInterval); _ndTunerRefreshInterval = null; }
    const m = document.getElementById('nd-tuner-modal');
    if (m) m.remove();
    // Restore detection's prior state. If it wasn't on, shut audio down again.
    if (!_ndTunerPriorEnabled && _ndAudioCtx) {
        _ndStopAudio();
    }
}

function _ndTunerOnDetection(freq) {
    if (freq <= 0) return;
    const detectedMidi = _ndFreqToMidi(freq);
    const base = _ndStandardMidiFor(_ndCurrentArrangement);
    let bestS = -1, bestDist = Infinity;
    for (let s = 0; s < base.length; s++) {
        const openMidi = base[s] + (_ndTuningOffsets[s] || 0);
        const dist = Math.abs(detectedMidi - openMidi);
        if (dist < bestDist) { bestS = s; bestDist = dist; }
    }
    if (bestS < 0 || bestDist > _ND_TUNER_STRING_TOL) return;
    const openMidi = base[bestS] + (_ndTuningOffsets[bestS] || 0);
    const expectedHz = 440 * Math.pow(2, (openMidi - 69) / 12);
    const cents = 1200 * Math.log2(freq / expectedHz);
    _ndTunerReadings.set(bestS, {
        freq, cents, expectedHz, timestamp: performance.now(),
    });
}

function _ndTunerUpdateReadings() {
    // Sweep the DOM rows to reflect current readings vs "silent" (stale).
    const now = performance.now();
    const base = _ndStandardMidiFor(_ndCurrentArrangement);
    for (let s = 0; s < base.length; s++) {
        const row = document.getElementById(`nd-tuner-row-${s}`);
        if (!row) continue;
        const reading = _ndTunerReadings.get(s);
        const fresh = reading && (now - reading.timestamp) < _ND_TUNER_WINDOW_MS;

        const freqEl = row.querySelector('[data-field=freq]');
        const centsEl = row.querySelector('[data-field=cents]');
        const meterFill = row.querySelector('[data-field=meter-fill]');
        const statusEl = row.querySelector('[data-field=status]');

        if (!fresh) {
            if (freqEl) freqEl.textContent = '—';
            if (centsEl) { centsEl.textContent = ''; centsEl.style.color = '#888'; }
            if (meterFill) meterFill.style.transform = 'translateX(-50%) scaleX(0)';
            if (statusEl) statusEl.textContent = '';
            continue;
        }
        if (freqEl) freqEl.textContent = `${reading.freq.toFixed(2)} Hz`;
        if (centsEl) {
            const sign = reading.cents >= 0 ? '+' : '';
            centsEl.textContent = `${sign}${Math.round(reading.cents)}¢`;
            const absC = Math.abs(reading.cents);
            centsEl.style.color = absC < 5 ? '#00ff88' : absC < 20 ? '#ffcc00' : '#ff6b6b';
        }
        if (meterFill) {
            // Meter range ±50¢. Half-width bar moves from left (flat) to right (sharp).
            const clamped = Math.max(-50, Math.min(50, reading.cents));
            const frac = clamped / 50; // -1 to 1
            meterFill.style.transform = `translateX(${frac * 50}%) scaleX(${Math.max(0.05, Math.abs(frac))})`;
            meterFill.style.backgroundColor = Math.abs(reading.cents) < 5 ? '#00ff88'
                : Math.abs(reading.cents) < 20 ? '#ffcc00' : '#ff6b6b';
        }
        if (statusEl) statusEl.textContent = Math.abs(reading.cents) < 5 ? '✓' : '';
    }
}

function _ndTunerRender() {
    let modal = document.getElementById('nd-tuner-modal');
    if (!_ndTunerOpen) { if (modal) modal.remove(); return; }
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'nd-tuner-modal';
        modal.className = 'fixed inset-0 z-[300] flex items-center justify-center bg-black/70 backdrop-blur-sm';
        document.body.appendChild(modal);
    }

    const base = _ndStandardMidiFor(_ndCurrentArrangement);
    const noteNames = _ndCurrentArrangement === 'bass'
        ? ['E1', 'A1', 'D2', 'G2', '', '']
        : ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'];

    // Build expected-pitch label for each string including any tuning offsets
    const rows = base.map((openStd, s) => {
        const openMidi = openStd + (_ndTuningOffsets[s] || 0);
        const expectedHz = 440 * Math.pow(2, (openMidi - 69) / 12);
        const label = noteNames[s] || '';
        const offsetTag = (_ndTuningOffsets[s] || 0) !== 0 ? ` (${_ndTuningOffsets[s] > 0 ? '+' : ''}${_ndTuningOffsets[s]}st)` : '';
        return `
            <div id="nd-tuner-row-${s}" class="grid grid-cols-12 gap-2 items-center py-1.5 border-b border-gray-800 last:border-0 text-xs">
                <div class="col-span-2 font-mono text-gray-200 font-semibold">${label}${offsetTag}</div>
                <div class="col-span-2 text-[10px] text-gray-500 font-mono">${expectedHz.toFixed(1)} Hz</div>
                <div class="col-span-5 relative h-3 bg-dark-800 rounded overflow-hidden">
                    <div class="absolute top-0 bottom-0 left-1/2 w-[1px] bg-gray-500"></div>
                    <div data-field="meter-fill" class="absolute top-0 bottom-0 left-1/2 w-1/2 origin-left transition-all duration-75"
                         style="transform:translateX(-50%) scaleX(0);background-color:#888;"></div>
                </div>
                <div class="col-span-2 font-mono text-right" data-field="cents"></div>
                <div class="col-span-1 text-right" data-field="status"></div>
                <div class="col-span-12 text-[10px] text-gray-600 font-mono -mt-0.5" data-field="freq">—</div>
            </div>`;
    }).join('');

    const arrLabel = _ndCurrentArrangement === 'bass' ? 'Bass (4-string)' : 'Guitar (6-string)';
    const nonStandard = _ndTuningOffsets.some(o => o !== 0);
    const tuningNote = nonStandard
        ? `<p class="text-[11px] text-yellow-500 mb-3 leading-tight">This song expects non-standard tuning (offsets: ${_ndTuningOffsets.slice(0, base.length).join(', ')} semitones). Tune each string to the Hz value above.</p>`
        : `<p class="text-[11px] text-gray-500 mb-3 leading-tight">Standard tuning.</p>`;

    modal.innerHTML = `
        <div class="bg-dark-700 border border-gray-700 rounded-2xl p-6 max-w-lg w-full mx-4 shadow-2xl text-gray-200">
            <div class="flex items-center justify-between mb-3">
                <h3 class="text-lg font-bold">Tuner · ${arrLabel}</h3>
                <button onclick="_ndCloseTuner()" class="text-gray-400 hover:text-white">✕</button>
            </div>
            ${tuningNote}
            <div class="bg-dark-800 rounded-xl px-4 py-2">
                ${rows}
            </div>
            <p class="text-[10px] text-gray-600 mt-3 leading-tight">Play each open string. Green = in tune (&lt;5¢). Yellow = close (&lt;20¢). Red = off. The meter fills left for flat, right for sharp.</p>
            <div class="flex gap-3 justify-end mt-4">
                <button onclick="_ndCloseTuner()" class="px-4 py-2 bg-accent hover:bg-accent-light rounded-xl text-sm font-semibold text-white">Done</button>
            </div>
        </div>`;
}

// Mark missed notes that have passed the timing window
function _ndCheckMisses() {
    if (!_ndEnabled) return;
    // Mirror _ndMatchNotes's time derivation so hit/miss are measured on the
    // same clock. highway.getTime() is the audio-aligned chart-time with
    // avOffset already applied (slopsmith fix/loop-count-in-bpm @ 8d8c299).
    const t = highway.getTime();
    // A note is missed once it has passed the late bound of the hit window.
    // Matches _ndMatchNotes's window; see docs/ROCKSMITH_TIMING_MODEL.md.
    // Grace period absorbs detections arriving at the edge.
    const lateWindowSec = _ndTimingTolerance * 2;
    const missGraceSec = 0.050;
    const missDeadline = t - lateWindowSec - missGraceSec;
    const notes = highway.getNotes();
    const chords = highway.getChords();

    const checkNote = (s, f, noteTime) => {
        if (noteTime > missDeadline) return; // not yet past window
        const key = _ndNoteKey({ s, f }, noteTime);
        if (!_ndNoteResults.has(key)) {
            // Distinguish "pitch miss" (detection fired in window but pitch
            // outside tolerance) from "timing miss" (no detection at all).
            // The pitch-attempts map was populated in _ndMatchNotes for any
            // detection that landed in the window — its presence tells us
            // which category this note falls into.
            const bestPitchErr = _ndNotePitchAttempts.get(key);
            const hadDetection = bestPitchErr !== undefined;
            const expectedMidi = _ndMidiFromStringFret(s, f) + _ndPitchOffset;
            // Sibling-loser demotion: if a NEARBY chart note with the SAME
            // expected MIDI was already matched to a HIT, the pitch attempt
            // recorded here came from the sibling's pluck — the user only
            // plucked once for the pair. Mark as NO_DETECTION so the report
            // doesn't double-count the same pluck as both a HIT and a
            // wrong-pitch miss.
            let siblingClaimed = false;
            if (hadDetection) {
                const siblingWindow = _ndTimingTolerance * 2;
                for (const v of _ndNoteResults.values()) {
                    if (v.primary !== 'HIT' && v.primary !== 'DIRTY_HIT') continue;
                    if (v.expectedMidi !== expectedMidi) continue;
                    if (Math.abs(v.chartT - noteTime) > siblingWindow) continue;
                    siblingClaimed = true; break;
                }
            }
            const primary = hadDetection && !siblingClaimed
                ? 'MISSED_WRONG_PITCH' : 'MISSED_NO_DETECTION';
            const pitchErrForResult = (primary === 'MISSED_WRONG_PITCH') ? bestPitchErr : null;
            _ndNoteResults.set(key, {
                primary,
                labels: [],
                timingError: null,              // no meaningful timing for full miss
                pitchError: pitchErrForResult,
                detectedMidi: null,
                expectedMidi,
                severity: _ndSeverity(primary, null, pitchErrForResult),
                s,
                f,
                chartT: noteTime,
                // Flag distinguishes "user didn't pluck / onset didn't fire"
                // from "user plucked, but the matcher gave the onset to a
                // same-pitch sibling chart note instead of this one." The
                // failure-mode classifier reads this to surface
                // SIBLING_CLAIMED separately from NO_PLUCK_OR_ONSET so the
                // user gets accurate "what to fix" advice.
                siblingClaimed,
            });
            _ndMisses++;
            if (primary === 'MISSED_WRONG_PITCH') _ndPitchMisses++;
            else _ndTimingMisses++;
            _ndStreak = 0;
            _ndUpdateSectionStat('miss');
            _ndRecordNowlineJudgment(s, f, _ndNoteResults.get(key));
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
        }
    }

    // Hygiene finalization: any chart note whose hit window has fully closed
    // and whose result hasn't been hygiene-graded yet — read its frame ledger
    // and attach the on-target ratio + top contaminants. If a HIT shows
    // off-target frames over the dirty threshold, downgrade it to DIRTY_HIT.
    // We do this here (not at HIT time) so the ratio reflects the entire
    // window, not just the moment of detection.
    for (const [key, result] of _ndNoteResults) {
        if (result._hygieneFinalized) continue;
        if (result.chartT == null) { result._hygieneFinalized = true; continue; }
        if (result.chartT > missDeadline) continue; // window not closed
        const summary = _ndComputeHygieneSummary(key);
        if (summary) {
            result.hygiene = summary;
            if (result.primary === 'HIT'
                    && (1 - summary.onTargetRatio) > _ndDirtyHitMaxOffRatio) {
                result.primary = 'DIRTY_HIT';
                _ndDirtyHits = (_ndDirtyHits || 0) + 1;
            }
        }
        result._hygieneFinalized = true;
        // Free per-note ledger entries — we've captured what we needed.
        _ndNoteHygiene.delete(key);
    }

    // Track current section
    const sections = highway.getSections();
    if (sections) {
        let current = null;
        for (const sec of sections) {
            if (sec.time <= t) current = sec.name;
            else break;
        }
        if (current && current !== _ndCurrentSection) {
            _ndCurrentSection = current;
            // Ensure section stats entry exists
            if (!_ndSectionStats.find(s => s.name === current)) {
                _ndSectionStats.push({ name: current, hits: 0, misses: 0 });
            }
        }
    }
}

function _ndUpdateSectionStat(type) {
    if (!_ndCurrentSection) return;
    let sec = _ndSectionStats.find(s => s.name === _ndCurrentSection);
    if (!sec) {
        sec = { name: _ndCurrentSection, hits: 0, misses: 0 };
        _ndSectionStats.push(sec);
    }
    if (type === 'hit') sec.hits++;
    else sec.misses++;
}

// ── Settings Panel ─────────────────────────────────────────────────────────

function _ndShowSettings() {
    let panel = document.getElementById('nd-settings-panel');
    if (panel) { panel.remove(); return; }

    const channelLabels = { mono: 'Mono (mix)', left: 'Left (Ch 1 — dry/DI)', right: 'Right (Ch 2 — wet)' };

    panel = document.createElement('div');
    panel.id = 'nd-settings-panel';
    panel.className = 'fixed top-16 right-4 z-[150] bg-dark-700 border border-gray-600 rounded-xl p-4 w-80 shadow-2xl text-sm';
    panel.innerHTML = `
        <div class="flex justify-between items-center mb-3">
            <span class="text-gray-200 font-semibold">Note Detection Settings</span>
            <button onclick="document.getElementById('nd-settings-panel').remove()" class="text-gray-500 hover:text-white">&times;</button>
        </div>

        <label class="flex items-center gap-2 text-gray-300 text-xs mb-2 cursor-pointer">
            <input type="checkbox" id="nd-auto-detect-on-play" ${_ndAutoDetectOnPlay ? 'checked' : ''}
                   onchange="_ndAutoDetectOnPlay=this.checked;_ndSaveSettings()">
            <span>Auto-enable Detect when Play is pressed</span>
        </label>

        <label class="flex items-center gap-2 text-gray-300 text-xs mb-3 cursor-pointer">
            <input type="checkbox" id="nd-auto-record-on-play" ${_ndAutoRecordOnPlay ? 'checked' : ''}
                   onchange="_ndAutoRecordOnPlay=this.checked;_ndSaveSettings()">
            <span>Also arm recording on Play (for offline analysis)</span>
        </label>

        <label class="block text-gray-400 text-xs mb-1">Strictness</label>
        <div class="flex gap-1 mb-1">
            <button onclick="_ndApplyStrictness('rocksmith')"
                class="flex-1 px-2 py-1 text-xs rounded ${_ndStrictness === 'rocksmith' ? 'bg-purple-900/60 text-purple-200' : 'bg-dark-600 text-gray-400 hover:bg-dark-500'}">
                Rocksmith
            </button>
            <button onclick="_ndApplyStrictness('easy')"
                class="flex-1 px-2 py-1 text-xs rounded ${_ndStrictness === 'easy' ? 'bg-green-900/60 text-green-200' : 'bg-dark-600 text-gray-400 hover:bg-dark-500'}">
                Easy
            </button>
            <button onclick="_ndApplyStrictness('default')"
                class="flex-1 px-2 py-1 text-xs rounded ${_ndStrictness === 'default' ? 'bg-blue-900/60 text-blue-200' : 'bg-dark-600 text-gray-400 hover:bg-dark-500'}">
                Default
            </button>
            <button onclick="_ndApplyStrictness('strict')"
                class="flex-1 px-2 py-1 text-xs rounded ${_ndStrictness === 'strict' ? 'bg-red-900/60 text-red-200' : 'bg-dark-600 text-gray-400 hover:bg-dark-500'}">
                Strict
            </button>
        </div>
        <p class="text-gray-500 text-[10px] mb-3 leading-tight">
            Rocksmith: any in-window pluck (2400¢/400ms) — masks YIN misreads.
            Easy: 100¢/300ms, ignores hygiene.
            Default: 50¢/150ms, flags &gt;50% off-pitch hits as dirty.
            Strict: 25¢/100ms, dirty at &gt;30%.
        </p>

        <label class="flex items-center gap-2 text-gray-300 text-xs mb-3 cursor-pointer">
            <input type="checkbox" id="nd-click-track-only" ${_ndClickTrackOnly ? 'checked' : ''}
                   onchange="_ndApplyClickTrackOnly(this.checked); _ndSaveSettings();">
            <span>Click track only — mute song, click on every beat (training mode)</span>
        </label>

        <label class="block text-gray-400 text-xs mb-1">Audio Input Device</label>
        <select id="nd-device-select" class="w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-2"
                onchange="_ndOnDeviceChange(this.value)">
            <option value="">Default</option>
        </select>

        <label class="block text-gray-400 text-xs mb-1">Input Channel</label>
        <select id="nd-channel-select" class="w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-2"
                onchange="_ndOnChannelChange(this.value)">
            <option value="mono" ${_ndSelectedChannel === 'mono' ? 'selected' : ''}>Mono (mix both channels)</option>
            <option value="left" ${_ndSelectedChannel === 'left' ? 'selected' : ''}>Left (Ch 1) — typically dry/DI</option>
            <option value="right" ${_ndSelectedChannel === 'right' ? 'selected' : ''}>Right (Ch 2) — typically wet/FX</option>
        </select>

        <label class="block text-gray-400 text-xs mb-1">Input Level</label>
        <div class="relative h-3 bg-dark-600 rounded overflow-hidden mb-1">
            <div id="nd-vu-bar" class="h-full rounded transition-all duration-75 bg-green-500" style="width:0%"></div>
            <div id="nd-vu-peak" class="absolute top-0 w-0.5 h-full bg-white/70" style="left:0%"></div>
        </div>
        <div class="flex justify-between text-[9px] text-gray-600 mb-3">
            <span>-inf</span><span>-18dB</span><span>-6dB</span><span>0dB</span>
        </div>

        <label class="block text-gray-400 text-xs mb-1">Detection Method</label>
        <select id="nd-method-select" class="w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-3"
                onchange="_ndSetMethod(this.value)">
            <option value="yin" ${_ndDetectionMethod === 'yin' ? 'selected' : ''}>YIN (lightweight, clean signals)</option>
            <option value="crepe" ${_ndDetectionMethod === 'crepe' ? 'selected' : ''}>CREPE/SPICE (robust, ~20MB model)</option>
        </select>

        <label class="block text-gray-400 text-xs mb-1">Silence Gate: <span id="nd-gate-val">${Math.round(_ndSilenceGate * 100)}</span>%</label>
        <input type="range" min="0" max="20" value="${Math.round(_ndSilenceGate * 100)}"
               class="w-full accent-yellow-400 mb-3"
               oninput="_ndSilenceGate=this.value/100;document.getElementById('nd-gate-val').textContent=this.value;_ndSaveSettings()"
               title="Reject detections when input level is below this threshold. Raise to suppress noise/hum.">
        <label class="block text-gray-500 text-xs mb-1" style="opacity:0.5">Audio Latency Offset: <span id="nd-latency-val">${Math.round(_ndDetectionLatencySec * 1000)}</span>ms <span class="text-[10px] text-gray-600">(disabled — onset-gated matching doesn't use this)</span></label>
        <input type="range" min="0" max="1000" value="${Math.round(_ndDetectionLatencySec * 1000)}"
               class="w-full accent-gray-500 mb-2" disabled
               style="opacity:0.35;pointer-events:none">
        <div class="flex items-center gap-2 mb-2 flex-wrap">
            <button onclick="_ndOpenWizard()"
                class="px-3 py-1 bg-blue-900/40 hover:bg-blue-900/70 rounded text-xs text-blue-200"
                title="Two-phase metronome calibration. Tap SPACE in time with the bouncing ball (visual run), then play a note in time with audible clicks (audio run). The audio run measures the round-trip from speaker to onset detection — your mic capture latency. Saved as _ndMicLatencyMs and subtracted from highway timing labels so what you see is your actual offset, not the hardware delay.">Calibrate latency</button>
            <span class="text-[10px] text-gray-400 self-center" id="nd-mic-latency-readout">${_ndMicLatencyMs ? `mic: ${Math.round(_ndMicLatencyMs)}ms` : 'mic: not calibrated'}</span>
            <button onclick="_ndOpenTuner()"
                class="px-3 py-1 bg-dark-600 hover:bg-dark-500 rounded text-xs text-gray-200"
                title="Standalone tuner — play each open string, see cents offset per string, verify the instrument matches the song's tuning before scoring.">Tune</button>
            <button onclick="_ndResetScoring()"
                class="px-3 py-1 bg-dark-600 hover:bg-dark-500 rounded text-xs text-gray-300"
                title="Clear hit/miss counters and rolling stats so you can measure before/after cleanly">Reset stats</button>
            <button onclick="_ndOpenReport()"
                class="px-3 py-1 bg-dark-600 hover:bg-dark-500 rounded text-xs text-gray-200"
                title="Show the post-session report: most-missed notes ranked across the last 10 plays of this song.">View Report</button>
        </div>
        <div class="text-[10px] text-gray-600 mb-3 leading-tight">
            <strong>Note:</strong> after the onset-gated matching change, the pipeline scores at the acoustic attack transient, not at the stable-MIDI vote. Latency-slider and Calibration Wizard are dead weight on that path — disabled until the dials are re-scoped. Pitch/timing tolerance sliders below still do what they always did.
        </div>

        <label class="block text-gray-400 text-xs mb-1">Timing Tolerance: <span id="nd-timing-val">${Math.round(_ndTimingTolerance * 1000)}</span>ms</label>
        <input type="range" min="30" max="300" value="${Math.round(_ndTimingTolerance * 1000)}"
               class="w-full accent-green-400 mb-3"
               oninput="_ndTimingTolerance=this.value/1000;document.getElementById('nd-timing-val').textContent=this.value;_ndSaveSettings()">

        <label class="block text-gray-400 text-xs mb-1">Pitch Tolerance: <span id="nd-pitch-val">${_ndPitchTolerance}</span> cents</label>
        <input type="range" min="10" max="100" value="${_ndPitchTolerance}"
               class="w-full accent-green-400 mb-3"
               oninput="_ndPitchTolerance=+this.value;document.getElementById('nd-pitch-val').textContent=this.value;_ndSaveSettings()">

        <label class="block text-gray-400 text-xs mb-1">Pitch Offset: <span id="nd-poffset-val">${_ndPitchOffset >= 0 ? '+' : ''}${_ndPitchOffset}</span> semitones</label>
        <input type="range" min="-5" max="5" value="${_ndPitchOffset}"
               class="w-full accent-blue-400 mb-1"
               oninput="_ndPitchOffset=+this.value;document.getElementById('nd-poffset-val').textContent=(_ndPitchOffset>=0?'+':'')+_ndPitchOffset;_ndSaveSettings()">
        <div class="text-[10px] text-gray-600 mb-3 leading-tight">
            Compensates for chart CentOffset or tuning metadata errors. Auto-calibrates from your play data — if detections are systematically off by N semitones, this adjusts automatically. Set to 0 to reset.
        </div>

        <label class="block text-gray-400 text-xs mb-1">Input Gain: <span id="nd-gain-val">${_ndInputGain.toFixed(1)}</span>x</label>
        <input type="range" min="1" max="50" value="${Math.round(_ndInputGain * 10)}"
               class="w-full accent-green-400 mb-3"
               oninput="_ndInputGain=this.value/10;document.getElementById('nd-gain-val').textContent=_ndInputGain.toFixed(1);_ndSaveSettings()">

        <div class="text-[10px] text-gray-600 mt-1 leading-tight">
            Tip: For multi-effects pedals with USB audio (e.g. Valeton GP-5), select <b>Left (Ch 1)</b> for the dry/DI signal — it gives the most accurate pitch detection.
        </div>

        <div class="border-t border-gray-700 mt-3 pt-3">
            <label class="block text-gray-400 text-xs mb-1">Diagnostic Recording</label>
            <div class="flex items-center gap-2 mb-1">
                <select id="nd-record-secs" class="bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200">
                    <option value="15">15s</option>
                    <option value="30">30s</option>
                    <option value="60">60s</option>
                    <option value="120">120s</option>
                    <option value="300" selected>5 min</option>
                    <option value="600">10 min</option>
                </select>
                <button id="nd-record-btn" onclick="_ndOnRecordClick()"
                    class="px-3 py-1 bg-red-900 hover:bg-red-800 rounded text-xs text-red-200 font-semibold">
                    ● Record
                </button>
            </div>
            <div id="nd-record-status" class="text-[10px] text-gray-600 leading-tight">
                Click once — the song starts playing and recording arms atomically. WAV t=0 anchors to the first sample captured after the chart advances, so the fixture is free of the "armed-then-play" interval bug.
            </div>
        </div>
    `;

    document.body.appendChild(panel);
    _ndPopulateDevices();
}

// Click handler for the Record button in the settings panel. Arms recording
// and starts playback atomically (see _ndRecordAlignedStart), then polls the
// recording status so the user sees progress without opening the console.
async function _ndOnRecordClick() {
    const btn = document.getElementById('nd-record-btn');
    const status = document.getElementById('nd-record-status');
    if (!btn || !status) return;
    if (_ndRecording) {
        _ndRecordSave(_ndRecordFilename);
        return;
    }
    const secs = parseInt(document.getElementById('nd-record-secs')?.value || '60', 10);
    btn.disabled = true;
    const filename = await _ndRecordAlignedStart(secs);
    btn.disabled = false;
    if (!filename) return;
    btn.textContent = '■ Stop';
    btn.className = 'px-3 py-1 bg-yellow-900 hover:bg-yellow-800 rounded text-xs text-yellow-200 font-semibold';
    const t0 = performance.now();
    const tick = () => {
        const s = _ndRecordStatus();
        if (!s.active) {
            status.textContent = `Saved ${filename} (anchor chart ${s.anchorChartTime.toFixed(3)}s, ${s.capturedSec.toFixed(1)}s captured).`;
            btn.textContent = '● Record';
            btn.className = 'px-3 py-1 bg-red-900 hover:bg-red-800 rounded text-xs text-red-200 font-semibold';
            return;
        }
        if (!s.anchored) {
            const waited = ((performance.now() - t0) / 1000).toFixed(1);
            status.textContent = `Armed (chart ${s.armedChartTime.toFixed(3)}s). Waiting ${waited}s for chart to advance — if this persists, playback didn't start.`;
        } else {
            const remaining = Math.max(0, s.maxSec - s.capturedSec);
            status.textContent = `Recording — anchor chart ${s.anchorChartTime.toFixed(3)}s, ${s.capturedSec.toFixed(1)}/${s.maxSec.toFixed(0)}s (${remaining.toFixed(1)}s left).`;
        }
        setTimeout(tick, 200);
    };
    tick();
}

function _ndOnDeviceChange(deviceId) {
    _ndSelectedDeviceId = deviceId;
    _ndSaveSettings();
    _ndRestartAudio();
}

function _ndOnChannelChange(channel) {
    _ndSelectedChannel = channel;
    _ndSaveSettings();
    _ndRestartAudio();
}

async function _ndPopulateDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const sel = document.getElementById('nd-device-select');
        if (!sel) return;
        sel.innerHTML = '<option value="">Default</option>';
        for (const d of devices) {
            if (d.kind !== 'audioinput') continue;
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `Input ${d.deviceId.slice(0, 8)}`;
            if (d.deviceId === _ndSelectedDeviceId) opt.selected = true;
            sel.appendChild(opt);
        }
    } catch (e) { /* permission not yet granted */ }
}

async function _ndRestartAudio() {
    _ndStopAudio();
    if (_ndEnabled) await _ndStartAudio();
}

function _ndSetMethod(method) {
    _ndDetectionMethod = method;
    _ndSaveSettings();
    if (method === 'crepe') _ndLoadCrepe();
}

// ── Visual Feedback ────────────────────────────────────────────────────────
// Uses a DOM overlay HUD (works with both 2D and 3D highway) plus
// draw hook indicators on the 2D highway when project()/fretX() are available.

let _ndHitFlash = 0;   // green flash alpha
let _ndMissFlash = 0;  // red flash alpha
let _ndLastHitCount = 0;
let _ndLastMissCount = 0;

// DOM HUD overlay — positioned over the player, works with any renderer
function _ndCreateHUD() {
    if (document.getElementById('nd-hud')) {
        console.debug('[note_detect] HUD already present; not re-creating');
        return;
    }
    // Prefer #player so the HUD sits inside the highway area and layers with
    // the canvas. Fall back to body so the HUD is still visible in any screen
    // layout (e.g. if a plugin replaces #player, or if it's not currently
    // active). Without the fallback, the plugin was silently skipping HUD
    // creation and the user saw "detection on but no HUD at all."
    const player = document.getElementById('player');
    const host = player || document.body;
    const hud = document.createElement('div');
    hud.id = 'nd-hud';
    // If hosting in body, use fixed positioning so the HUD follows the
    // viewport regardless of scroll.
    hud.className = (player ? 'absolute' : 'fixed') + ' top-3 right-16 z-[200] pointer-events-none text-right';
    hud.innerHTML = `
        <div id="nd-hud-accuracy" class="text-xl font-bold" style="text-shadow:0 0 8px currentColor"></div>
        <div id="nd-hud-streak" class="text-xs text-gray-400 mt-0.5"></div>
        <div id="nd-hud-counts" class="text-[10px] text-gray-600 mt-0.5"></div>
        <div id="nd-hud-detected" class="text-[10px] text-cyan-400 mt-1 font-mono"></div>
        <div id="nd-hud-stats" class="text-[10px] text-gray-500 mt-1 font-mono"></div>
    `;
    host.appendChild(hud);
    console.debug('[note_detect] HUD created in', player ? '#player' : 'document.body');
}

function _ndRemoveHUD() {
    const hud = document.getElementById('nd-hud');
    if (hud) hud.remove();
    const flash = document.getElementById('nd-flash-overlay');
    if (flash) flash.remove();
}

function _ndCreateFlashOverlay() {
    if (document.getElementById('nd-flash-overlay')) return;
    const player = document.getElementById('player');
    if (!player) return;
    const flash = document.createElement('div');
    flash.id = 'nd-flash-overlay';
    flash.style.cssText = 'position:absolute;inset:0;z-index:20;pointer-events:none;border:4px solid transparent;transition:border-color 0.05s;';
    player.appendChild(flash);
}

// Update DOM HUD at 30fps (lighter than rAF)
let _ndHudInterval = null;

function _ndStartHUD() {
    _ndCreateHUD();
    _ndCreateFlashOverlay();
    _ndLastHitCount = 0;
    _ndLastMissCount = 0;
    if (_ndHudInterval) clearInterval(_ndHudInterval);
    _ndHudInterval = setInterval(_ndUpdateHUD, 33);
}

function _ndStopHUD() {
    if (_ndHudInterval) { clearInterval(_ndHudInterval); _ndHudInterval = null; }
    _ndRemoveHUD();
}

function _ndUpdateHUD() {
    if (!_ndEnabled) return;

    const total = _ndHits + _ndMisses;
    const accEl = document.getElementById('nd-hud-accuracy');
    const streakEl = document.getElementById('nd-hud-streak');
    const countsEl = document.getElementById('nd-hud-counts');
    const detectedEl = document.getElementById('nd-hud-detected');
    const flashEl = document.getElementById('nd-flash-overlay');

    if (accEl && total > 0) {
        const accuracy = Math.round((_ndHits / total) * 100);
        const color = accuracy >= 90 ? '#00ff88' : accuracy >= 70 ? '#ffcc00' : '#ff4444';
        accEl.textContent = accuracy + '%';
        accEl.style.color = color;
    } else if (accEl) {
        accEl.textContent = '';
    }

    // ── Level meter ───────────────────────────────────────────────────

    if (countsEl && total > 0) {
        // Breakdown line 1: hits vs the two miss categories (pitch / timing).
        // Breakdown line 2: among the hits, how many were off-axis on each
        //   side (early/late, sharp/flat). Lets the user see "most of my hits
        //   are late and sharp — I need to work on dragging and tuning up."
        const offAxis = (_ndEarly + _ndLate + _ndSharp + _ndFlat) > 0
            ? `  ↑${_ndEarly} ↓${_ndLate} ♯${_ndSharp} ♭${_ndFlat}`
            : '';
        countsEl.innerHTML =
            `${_ndHits} / ${total}` +
            (_ndPitchMisses || _ndTimingMisses ? `  (p:${_ndPitchMisses} t:${_ndTimingMisses})` : '') +
            (offAxis ? `<br><span class="text-[9px] text-gray-500">${offAxis}</span>` : '');
    }

    if (detectedEl) {
        if (_ndDetectedString >= 0 && _ndDetectedConfidence > 0.3) {
            const names = _ndCurrentArrangement === 'bass'
                ? ['E1','A1','D2','G2','','']
                : ['E2','A2','D3','G3','B3','E4'];
            detectedEl.textContent = `${names[_ndDetectedString] || '?'} fret ${_ndDetectedFret}`;
        } else {
            detectedEl.textContent = '';
        }
    }

    const statsEl = document.getElementById('nd-hud-stats');
    if (statsEl) {
        // Stall indicator: if no audio chunk has flowed in 3s while detect
        // is on, the audio path is silently dead (suspended context, ended
        // track, or worklet death). Surface this prominently — without it
        // the user has no visible cue, just "Detect green-checked but no
        // notes scoring." Red badge so it can't be mistaken for normal stats.
        const sinceFrame = _ndLastAudioFrameAt > 0
            ? performance.now() - _ndLastAudioFrameAt
            : Infinity;
        const stalled = _ndEnabled && sinceFrame > _ND_AUDIO_STALL_THRESHOLD_MS;
        const ctxState = _ndAudioCtx?.state || 'closed';
        const stallBadge = stalled
            ? ` <span style="color:#ff4444;font-weight:bold">⚠ AUDIO STALLED (${(sinceFrame/1000).toFixed(0)}s, ctx:${ctxState})</span>`
            : '';

        const s = _ndStats();
        if (s) {
            const tolMs = _ndTimingTolerance * 1000;
            const dtColor = Math.abs(s.dtMean) < 20 ? '#6edf8f'
                          : Math.abs(s.dtMean) < tolMs ? '#ffcc00' : '#ff6b6b';
            const dtSign = s.dtMean >= 0 ? '+' : '';
            const cSign  = s.cMean  >= 0 ? '+' : '';
            statsEl.innerHTML =
                `<span style="color:${dtColor}">Δt ${dtSign}${Math.round(s.dtMean)} ±${Math.round(s.dtStd)} ms</span> ` +
                `<span class="text-gray-500">· ${cSign}${Math.round(s.cMean)} ±${Math.round(s.cStd)} ¢ · n=${s.n}</span>` +
                `<span class="text-gray-500"> · trouble:${_ndTroubleNotes.size}</span>` +
                stallBadge;
        } else {
            statsEl.innerHTML = `<span class="text-gray-500">trouble:${_ndTroubleNotes.size}</span>` + stallBadge;
        }
    }

    // Edge flash on hit/miss
    if (flashEl) {
        if (_ndHits > _ndLastHitCount) {
            flashEl.style.borderColor = 'rgba(0, 255, 136, 0.6)';
            setTimeout(() => { if (flashEl) flashEl.style.borderColor = 'transparent'; }, 80);
        } else if (_ndMisses > _ndLastMissCount) {
            flashEl.style.borderColor = 'rgba(255, 50, 68, 0.4)';
            setTimeout(() => { if (flashEl) flashEl.style.borderColor = 'transparent'; }, 80);
        }
        _ndLastHitCount = _ndHits;
        _ndLastMissCount = _ndMisses;
    }
}

// ── Display tuning ───────────────────────────────────────────────────────
const _ND_HIT_DISPLAY_SEC  = 4.0;   // green glow persists
const _ND_MISS_DISPLAY_SEC = 15.0;  // miss markers persist long enough to actually see
const _ND_MISS_LOOKBACK    = 15.0;  // seconds to look back for missed notes
const _ND_DIAG_FONT_PX     = 18;    // diagnostic label base font size — must be readable

// ── Trouble notes (pre-arrival glow from last play) ──────────────────────
// Map of (s, f, chartT-rounded-to-5ms) → { severity, primary } from the most
// recent completed play snapshot. Drives the upcoming-note glow so the player
// can brace for notes they failed last loop iteration. Rebuilt on each
// _ndSnapshotPlay (right before clearing _ndNoteResults) and on detect-on
// (loaded from disk via _ndFetchPlays).
let _ndTroubleNotes = new Map();

function _ndTroubleKey(s, f, chartT) {
    const binned = Math.round((chartT || 0) * 200) / 200;
    return `${s}|${f}|${binned}`;
}

// Build a trouble map from one play's noteResults. Filters to entries with
// non-zero severity (clean hits don't count as trouble). Returns a fresh Map
// so callers can swap atomically without mid-render flicker.
function _ndBuildTroubleMap(noteResults) {
    const m = new Map();
    if (!noteResults) return m;
    for (const r of noteResults) {
        if (!r || typeof r.severity !== 'number' || r.severity <= 0) continue;
        const key = _ndTroubleKey(r.s, r.f, r.chartT);
        m.set(key, { severity: r.severity, primary: r.primary });
    }
    return m;
}

// Per-iteration banner toast — fixed-position summary that fades after a
// few seconds. Replaces (or supplements) the post-play `make loop-report`
// step for the basic per-iteration feedback case. Counts the four primary
// states from the just-completed iteration's noteResults so the player
// knows immediately whether a pass got cleaner or worse.
let _ndIterationBannerCount = 0;
function _ndShowIterationBanner(noteResults) {
    let clean = 0, dirty = 0, missWrong = 0, missNone = 0;
    for (const r of noteResults || []) {
        if (r.primary === 'HIT') clean++;
        else if (r.primary === 'DIRTY_HIT') dirty++;
        else if (r.primary === 'MISSED_WRONG_PITCH') missWrong++;
        else if (r.primary === 'MISSED_NO_DETECTION') missNone++;
    }
    const total = clean + dirty + missWrong + missNone;
    if (total === 0) return;
    _ndIterationBannerCount++;
    const id = `nd-iteration-toast-${_ndIterationBannerCount}`;

    const existing = document.querySelectorAll('.nd-iteration-toast');
    // Stack: shift older toasts down so consecutive iterations are visible briefly.
    existing.forEach((el, i) => { el.style.top = `${20 + (i + 1) * 70}px`; });

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
            ${dirty > 0    ? `<span class="text-yellow-400">⚠ ${dirty}</span>`     : ''}
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

// ── Now-line judgment queue ──────────────────────────────────────────────
// Renders at project(0) which is KNOWN to work (the detection dot is there).
// This is the primary visual feedback — the past-note markers are secondary.
const _ND_NOWLINE_DISPLAY_SEC = 3.0;  // how long a judgment shows at the now-line
let _ndNowlineJudgments = [];  // [{string, fret, time, judgment}]

function _ndRecordNowlineJudgment(s, f, judgment) {
    _ndNowlineJudgments.push({
        string: s, fret: f,
        time: performance.now() / 1000,
        judgment,
    });
    // Cap at 20 entries
    if (_ndNowlineJudgments.length > 20) _ndNowlineJudgments.shift();
}

// 2D highway draw hook — uses project()/fretX() for accurate positioning.
highway.addDrawHook(function(ctx, W, H) {
    if (!_ndEnabled) return;
    if (!highway.project || !highway.fretX) return;

    _ndCheckAutoDump();

    const t = highway.getTime();
    const notes = highway.getNotes();
    const chords = highway.getChords();

    // ── Draw a single judgment ───────────────────────────────────────────
    const drawJudgment = (s, f, noteTime, judgment) => {
        const tOff = noteTime - t;
        // For past notes: clamp projection so they sit just below the now-line
        // instead of flying off-screen. project() rejects tOff < -0.05.
        const p = highway.project(Math.max(tOff, -0.12));
        if (!p) return;
        const x = highway.fretX(f, p.scale, W);
        const y = p.y * H;
        const age = t - noteTime; // positive = past

        const primary = (judgment && typeof judgment === 'object') ? judgment.primary
                      : (judgment === 'hit') ? 'HIT'
                      : (judgment === 'pitch_miss') ? 'MISSED_WRONG_PITCH'
                      : (judgment === 'timing_miss' || judgment === 'miss') ? 'MISSED_NO_DETECTION'
                      : null;
        if (!primary) return;

        if (primary === 'HIT') {
            // ── HIT: green glow ring + optional timing/pitch labels ──────
            // Full opacity for most of the duration, fade only in last 1s
            if (age > _ND_HIT_DISPLAY_SEC) return;
            const fadeStart = _ND_HIT_DISPLAY_SEC - 1;
            const fade = age < fadeStart ? 1.0 : Math.max(0, 1 - (age - fadeStart));
            const sz = Math.max(24, 32 * p.scale);

            ctx.save();
            ctx.globalAlpha = fade;
            ctx.globalCompositeOperation = 'lighter';
            ctx.shadowColor = '#00ff88';
            ctx.shadowBlur = 36 * p.scale;
            // Filled green disc behind the note
            ctx.fillStyle = 'rgba(0, 255, 136, 0.3)';
            ctx.beginPath();
            ctx.arc(x, y, sz, 0, Math.PI * 2);
            ctx.fill();
            // Thick ring
            ctx.strokeStyle = '#00ff88';
            ctx.lineWidth = Math.max(4, 5 * p.scale);
            ctx.beginPath();
            ctx.arc(x, y, sz, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();

            // Show diagnostic labels on imperfect hits
            const labels = judgment && judgment.labels ? judgment.labels : [];
            if (labels.length && fade > 0.2) {
                _ndDrawDiagLabels(ctx, x, y, p.scale, judgment, fade);
            }
        } else {
            // ── MISS: massive persistent marker + diagnostic labels ──────
            if (age < 0) return; // don't mark future notes
            // Full opacity for most of duration, fade only in last 2s
            const rawFade = Math.max(0, 1 - age / _ND_MISS_DISPLAY_SEC);
            if (rawFade <= 0) return;
            const fadeStart = _ND_MISS_DISPLAY_SEC - 2;
            const fade = age < fadeStart ? 1.0 : Math.max(0, 1 - (age - fadeStart) / 2);

            const isTiming = primary === 'MISSED_NO_DETECTION';
            const colour = isTiming ? '#ff2244' : '#ff6644';
            const sz = Math.max(20, 28 * p.scale);

            ctx.save();
            ctx.globalAlpha = fade;

            // Filled background circle so the X sits on a dark disc
            ctx.fillStyle = 'rgba(40, 0, 0, 0.7)';
            ctx.beginPath();
            ctx.arc(x, y, sz + 4, 0, Math.PI * 2);
            ctx.fill();

            // Big bold X — thick lines, heavy glow
            ctx.shadowColor = colour;
            ctx.shadowBlur = 24 * p.scale;
            ctx.strokeStyle = colour;
            ctx.lineWidth = Math.max(4, 6 * p.scale);
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(x - sz, y - sz);
            ctx.lineTo(x + sz, y + sz);
            ctx.moveTo(x + sz, y - sz);
            ctx.lineTo(x - sz, y + sz);
            ctx.stroke();

            // Outer ring — always visible, pulsing
            const pulse = 0.6 + 0.4 * Math.sin(age * 4);
            ctx.globalAlpha = fade * pulse;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(x, y, sz + 10, 0, Math.PI * 2);
            ctx.stroke();

            ctx.restore();

            // Diagnostic: WHY was it missed?
            _ndDrawDiagLabels(ctx, x, y, p.scale, judgment, fade);
        }
    };

    // ── Diagnostic labels drawn above the note ───────────────────────────
    function _ndDrawDiagLabels(ctx, x, y, scale, judgment, fade) {
        const fontSize = Math.max(16, _ND_DIAG_FONT_PX * scale) | 0;
        const lineH = fontSize + 8;
        let labelY = y - Math.max(24, 34 * scale) - 4;
        const primary = (typeof judgment === 'object') ? judgment.primary : judgment;

        ctx.save();
        ctx.globalAlpha = Math.min(fade, 1.0);
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        // Black outline so text is readable against any background
        ctx.shadowColor = '#000';
        ctx.shadowBlur = 6;
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#000';

        if (primary === 'MISSED_NO_DETECTION') {
            ctx.fillStyle = '#ff2244';
            highway.fillTextUnmirrored('NO INPUT', x, labelY);
            // Double-draw for outline effect
            ctx.globalCompositeOperation = 'destination-over';
            ctx.strokeText('NO INPUT', x, labelY);
            ctx.globalCompositeOperation = 'source-over';
            labelY -= lineH;
        } else if (primary === 'MISSED_WRONG_PITCH') {
            ctx.fillStyle = '#ff6644';
            const cErr = judgment.pitchError;
            const label = (cErr !== null && cErr !== undefined)
                ? (cErr > 0 ? `+${Math.round(cErr)}\u00a2` : `${Math.round(cErr)}\u00a2`)
                : 'WRONG PITCH';
            highway.fillTextUnmirrored(label, x, labelY);
            labelY -= lineH;
        }

        // Timing error: subtract mic capture latency (measured once via the
        // calibration wizard) so the displayed number is the player's actual
        // offset, not the hardware-stack delay. If the wizard hasn't run,
        // _ndMicLatencyMs is 0 and we display raw timingError.
        if (judgment.timingError !== null && judgment.timingError !== undefined) {
            const ms = Math.round(judgment.timingError - _ndMicLatencyMs);
            if (Math.abs(ms) > _ndPerfectTimingMs) {
                ctx.fillStyle = '#ffaa33';
                const arrow = ms > 0 ? '\u2193' : '\u2191';
                const sign = ms > 0 ? '+' : '';
                highway.fillTextUnmirrored(`${arrow} ${sign}${ms}ms`, x, labelY);
                labelY -= lineH;
            }
        }

        // Pitch error on imperfect hits
        if (primary === 'HIT' && judgment.pitchError !== null && judgment.pitchError !== undefined) {
            const cents = Math.round(judgment.pitchError);
            if (Math.abs(cents) > _ndPerfectPitchCent) {
                ctx.fillStyle = '#44aaff';
                const sym = cents > 0 ? '\u266f' : '\u266d';
                const sign = cents > 0 ? '+' : '';
                highway.fillTextUnmirrored(`${sym} ${sign}${cents}\u00a2`, x, labelY);
            }
        }

        ctx.restore();
    }

    // ── Trouble-note glow (upcoming notes the player failed last play) ───
    // Renders BEFORE drawJudgment so the standard hit/miss marker overlays it
    // once the player reaches the note (judgment registers and trouble glow
    // is naturally superseded — same draw call, later timestamp wins).
    const drawTroubleGlow = (s, f, noteTime, trouble) => {
        const tOff = noteTime - t;
        if (tOff < -0.05) return;
        const p = highway.project(tOff);
        if (!p) return;
        const x = highway.fretX(f, p.scale, W);
        const y = p.y * H;
        const sev = trouble.severity || 0.5;

        // Visibility-first: lock high base intensity even far from the now-line
        // so the player notices the warning when the note FIRST appears, not
        // 0.5s before it lands. Pulse adds urgency near the line; proximity
        // boost is additive on top of an already-visible base.
        const proximity = Math.max(0, 1 - tOff / 3.0);
        const baseAlpha = 0.55 + 0.4 * sev;          // 0.55..0.95
        const proxBoost = 0.0 + 0.3 * proximity * sev;
        const alpha = Math.min(1.0, baseAlpha + proxBoost);

        const nowSec = performance.now() / 1000;
        const pulseRate = 2 + 4 * proximity;
        const pulse = 0.75 + 0.25 * Math.sin(nowSec * pulseRate);

        // Color: bright orange → red as severity climbs. r=255 always; g
        // drops with severity so a chronic miss reads as bright red.
        const r = 255;
        const g = Math.round(190 - 150 * sev);
        const b = 40;
        const ringColour = `rgba(${r},${g},${b},${(alpha * pulse).toFixed(3)})`;
        const fillColour = `rgba(${r},${g},${b},${(alpha * 0.28).toFixed(3)})`;

        const sz = Math.max(26, 36 * p.scale);
        ctx.save();
        // Filled translucent disc — the eye-catching base layer
        ctx.fillStyle = fillColour;
        ctx.shadowColor = ringColour;
        ctx.shadowBlur = 22 * p.scale;
        ctx.beginPath();
        ctx.arc(x, y, sz, 0, Math.PI * 2);
        ctx.fill();
        // Heavy outlined ring on top
        ctx.strokeStyle = ringColour;
        ctx.lineWidth = Math.max(3, 4 * p.scale);
        ctx.beginPath();
        ctx.arc(x, y, sz, 0, Math.PI * 2);
        ctx.stroke();
        // "!" badge above the note — the unambiguous heads-up. Drawn even
        // far away so the player can scan ahead and prepare.
        const badgeY = y - sz - Math.max(10, 14 * p.scale);
        const fontPx = Math.max(20, 28 * p.scale) | 0;
        ctx.font = `bold ${fontPx}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
        ctx.shadowColor = ringColour;
        ctx.shadowBlur = 12 * p.scale;
        // Black outline so the "!" survives against any chart-bar color
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#000';
        highway.fillTextUnmirrored
            ? highway.fillTextUnmirrored('!', x, badgeY)
            : ctx.fillText('!', x, badgeY);
        ctx.restore();
    };

    if (_ndTroubleNotes.size > 0) {
        // One-shot diagnostic: dump the first few chart-note keys we're
        // about to match against the trouble keys, so a key-mismatch bug
        // is obvious in console (e.g. trouble has "1|3|2.5" but chart
        // produces "1|3|2.49998" due to round-trip jitter).
        if (_ndTroubleDebugDumpPending) {
            _ndTroubleDebugDumpPending = false;
            const chartKeys = [];
            if (notes) {
                for (let i = 0; i < Math.min(5, notes.length); i++) {
                    const n = notes[i];
                    if (n.mt) continue;
                    chartKeys.push(_ndTroubleKey(n.s, n.f, n.t));
                }
            }
            if (chords) {
                for (let i = 0; i < Math.min(3, chords.length); i++) {
                    const c = chords[i];
                    for (const cn of (c.notes || [])) {
                        if (cn.mt) continue;
                        chartKeys.push(_ndTroubleKey(cn.s, cn.f, c.t));
                    }
                }
            }
            console.log(`[note_detect] Chart keys sample (first frame): ${JSON.stringify(chartKeys.slice(0, 8))}`);
            // How many chart-key matches exist anywhere in the upcoming window?
            let matchCount = 0;
            if (notes) {
                for (const n of notes) {
                    if (n.mt) continue;
                    if (_ndTroubleNotes.has(_ndTroubleKey(n.s, n.f, n.t))) matchCount++;
                }
            }
            if (chords) {
                for (const c of chords) {
                    for (const cn of (c.notes || [])) {
                        if (cn.mt) continue;
                        if (_ndTroubleNotes.has(_ndTroubleKey(cn.s, cn.f, c.t))) matchCount++;
                    }
                }
            }
            console.log(`[note_detect] Chart keys matching trouble map: ${matchCount} of ${_ndTroubleNotes.size} trouble entries`);
        }
        if (notes) {
            const start = _ndBsearch(notes, t - 0.1);
            for (let i = start; i < notes.length; i++) {
                const n = notes[i];
                if (n.t > t + 3) break;
                if (n.mt) continue;
                const tk = _ndTroubleKey(n.s, n.f, n.t);
                const trouble = _ndTroubleNotes.get(tk);
                if (!trouble) continue;
                // Skip if a current judgment already exists — the live marker
                // takes precedence.
                if (_ndNoteResults.has(_ndNoteKey(n, n.t))) continue;
                drawTroubleGlow(n.s, n.f, n.t, trouble);
            }
        }
        if (chords) {
            const start = _ndBsearch(chords, t - 0.1);
            for (let i = start; i < chords.length; i++) {
                const c = chords[i];
                if (c.t > t + 3) break;
                for (const cn of (c.notes || [])) {
                    if (cn.mt) continue;
                    const tk = _ndTroubleKey(cn.s, cn.f, c.t);
                    const trouble = _ndTroubleNotes.get(tk);
                    if (!trouble) continue;
                    if (_ndNoteResults.has(_ndNoteKey(cn, c.t))) continue;
                    drawTroubleGlow(cn.s, cn.f, c.t, trouble);
                }
            }
        }
    }

    // ── Iterate chart notes — look back far enough for persistent markers ─
    if (notes) {
        const start = _ndBsearch(notes, t - _ND_MISS_LOOKBACK);
        for (let i = start; i < notes.length; i++) {
            const n = notes[i];
            if (n.t > t + 3) break;
            if (n.mt) continue;
            const key = _ndNoteKey(n, n.t);
            const judgment = _ndNoteResults.get(key);
            if (judgment) drawJudgment(n.s, n.f, n.t, judgment);
        }
    }
    if (chords) {
        const start = _ndBsearch(chords, t - _ND_MISS_LOOKBACK);
        for (let i = start; i < chords.length; i++) {
            const c = chords[i];
            if (c.t > t + 3) break;
            for (const cn of (c.notes || [])) {
                if (cn.mt) continue;
                const key = _ndNoteKey(cn, c.t);
                const judgment = _ndNoteResults.get(key);
                if (judgment) drawJudgment(cn.s, cn.f, c.t, judgment);
            }
        }
    }

    // ── Now-line judgment markers ──────────────────────────────────────────
    // Primary visual feedback. Renders at project(0) which WORKS (the detection
    // dot proves it). Shows hit/miss at the now-line at the correct fret position.
    {
        const p0 = highway.project(0);
        if (p0) {
            const nowSec = performance.now() / 1000;
            for (const j of _ndNowlineJudgments) {
                const age = nowSec - j.time;
                if (age > _ND_NOWLINE_DISPLAY_SEC) continue;
                // Full opacity, fade only in last 0.5s
                const fade = age < (_ND_NOWLINE_DISPLAY_SEC - 0.5)
                    ? 1.0 : Math.max(0, 1 - (age - (_ND_NOWLINE_DISPLAY_SEC - 0.5)) / 0.5);
                if (fade <= 0) continue;

                const x = highway.fretX(j.fret, p0.scale, W);
                // Offset below the now-line so it doesn't overlap incoming notes.
                // Each judgment stacks down slightly based on age.
                const yBase = p0.y * H;
                const yOff = 30 + age * 25; // drift downward over time
                const y = yBase + yOff;
                if (y > H) continue; // off-screen

                const primary = j.judgment?.primary || '';
                const sz = Math.max(18, 24 * p0.scale);
                const fontSize = Math.max(14, 18 * p0.scale) | 0;

                ctx.save();
                ctx.globalAlpha = fade;

                if (primary === 'HIT' || primary === 'DIRTY_HIT') {
                    const dirty = primary === 'DIRTY_HIT';
                    // Yellow for dirty hits (right note, but string-hygiene
                    // contamination over the threshold), green for clean.
                    const ringColor = dirty ? '#ffcc33' : '#00ff88';
                    const fillColor = dirty ? 'rgba(60, 50, 0, 0.7)' : 'rgba(0, 60, 20, 0.7)';
                    ctx.fillStyle = fillColor;
                    ctx.beginPath();
                    ctx.arc(x, y, sz, 0, Math.PI * 2);
                    ctx.fill();

                    ctx.strokeStyle = ringColor;
                    ctx.shadowColor = ringColor;
                    ctx.shadowBlur = 16;
                    ctx.lineWidth = Math.max(4, 5 * p0.scale);
                    ctx.lineCap = 'round';
                    ctx.beginPath();
                    // Check mark shape
                    ctx.moveTo(x - sz * 0.5, y);
                    ctx.lineTo(x - sz * 0.1, y + sz * 0.4);
                    ctx.lineTo(x + sz * 0.5, y - sz * 0.4);
                    ctx.stroke();

                    // Show labels for imperfect hits — append MUTE for dirty
                    // hits so the player knows it was string-hygiene that
                    // downgraded an otherwise-correct pluck.
                    const labels = (j.judgment?.labels || []).slice();
                    if (dirty) labels.push('MUTE');
                    if (labels.length > 0) {
                        ctx.shadowBlur = 0;
                        ctx.font = `bold ${fontSize}px sans-serif`;
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'top';
                        ctx.fillStyle = dirty ? '#ffcc33' : '#ffaa33';
                        ctx.strokeStyle = '#000';
                        ctx.lineWidth = 3;
                        const labelText = labels.join(' ');
                        ctx.strokeText(labelText, x, y + sz + 4);
                        ctx.fillText(labelText, x, y + sz + 4);
                    }
                } else if (primary === 'MISSED_NO_DETECTION' || primary === 'MISSED_WRONG_PITCH') {
                    const isTiming = primary === 'MISSED_NO_DETECTION';
                    const colour = isTiming ? '#ff2244' : '#ff6644';

                    // Dark disc background
                    ctx.fillStyle = 'rgba(60, 0, 0, 0.8)';
                    ctx.beginPath();
                    ctx.arc(x, y, sz, 0, Math.PI * 2);
                    ctx.fill();

                    // Big X
                    ctx.strokeStyle = colour;
                    ctx.shadowColor = colour;
                    ctx.shadowBlur = 18;
                    ctx.lineWidth = Math.max(4, 5 * p0.scale);
                    ctx.lineCap = 'round';
                    ctx.beginPath();
                    ctx.moveTo(x - sz * 0.6, y - sz * 0.6);
                    ctx.lineTo(x + sz * 0.6, y + sz * 0.6);
                    ctx.moveTo(x + sz * 0.6, y - sz * 0.6);
                    ctx.lineTo(x - sz * 0.6, y + sz * 0.6);
                    ctx.stroke();

                    // Label: "NO INPUT" or pitch error
                    ctx.shadowBlur = 0;
                    ctx.font = `bold ${fontSize}px sans-serif`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'top';
                    ctx.strokeStyle = '#000';
                    ctx.lineWidth = 3;
                    let label = isTiming ? 'MISS' : '';
                    if (!isTiming && j.judgment?.pitchError != null) {
                        const c = Math.round(j.judgment.pitchError);
                        label = `${c > 0 ? '+' : ''}${c}\u00a2`;
                    }
                    if (label) {
                        ctx.fillStyle = colour;
                        ctx.strokeText(label, x, y + sz + 4);
                        ctx.fillText(label, x, y + sz + 4);
                    }
                }

                ctx.restore();
            }

            // Prune old entries
            _ndNowlineJudgments = _ndNowlineJudgments.filter(
                j => (nowSec - j.time) < _ND_NOWLINE_DISPLAY_SEC
            );
        }
    }

    // ── Detected-note indicator at the now line ──────────────────────────
    // Larger and brighter so it's actually visible.
    if (_ndDetectedString >= 0 && _ndDetectedConfidence > 0.3) {
        const p = highway.project(0);
        if (p) {
            const x = highway.fretX(_ndDetectedFret, p.scale, W);
            const y = p.y * H;
            const dotR = Math.max(12, 16 * p.scale);

            ctx.save();
            ctx.globalAlpha = Math.min(1, _ndDetectedConfidence * 1.3);
            ctx.shadowColor = '#44ddff';
            ctx.shadowBlur = 22;
            // Outer ring
            ctx.strokeStyle = '#44ddff';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(x, y, dotR, 0, Math.PI * 2);
            ctx.stroke();
            // Solid center
            ctx.fillStyle = '#44ddff';
            ctx.beginPath();
            ctx.arc(x, y, dotR * 0.45, 0, Math.PI * 2);
            ctx.fill();
            // Fret number
            ctx.fillStyle = '#000';
            ctx.font = `bold ${Math.max(10, 12 * p.scale) | 0}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(_ndDetectedFret, x, y);
            ctx.restore();
        }
    }
});

// ── Toggle Button ──────────────────────────────────────────────────────────

function _ndInjectButton() {
    const controls = document.getElementById('player-controls');
    if (!controls || document.getElementById('btn-notedetect')) return;

    const closeBtn = controls.querySelector('button:last-child');

    const btn = document.createElement('button');
    btn.id = 'btn-notedetect';
    btn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
    btn.textContent = 'Detect';
    btn.title = 'Toggle real-time note detection & scoring';
    btn.onclick = _ndToggle;
    controls.insertBefore(btn, closeBtn);

    // Settings gear button
    const gear = document.createElement('button');
    gear.id = 'btn-notedetect-settings';
    gear.className = 'px-2 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition hidden';
    gear.textContent = '\u2699';
    gear.title = 'Note detection settings';
    gear.onclick = _ndShowSettings;
    controls.insertBefore(gear, closeBtn);

    // Diag button
    const diag = document.createElement('button');
    diag.id = 'btn-notedetect-diag';
    diag.className = 'px-2 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition hidden';
    diag.textContent = '\u2261';
    diag.title = 'Detection diagnostics';
    diag.onclick = _ndToggleDiag;
    controls.insertBefore(diag, closeBtn);

    // Report button \u2014 opens the in-page Practice Report panel (per-attempt
    // matrix + suggested loops). Replaces `make loop-report` for the
    // common practice flow; offline tooling stays for cross-session debug.
    const report = document.createElement('button');
    report.id = 'btn-notedetect-report';
    report.className = 'px-2 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition hidden';
    report.textContent = '\u2630'; // \u2630 \u2014 list/menu glyph
    report.title = 'Practice report (last N loop attempts)';
    report.onclick = _ndShowReport;
    controls.insertBefore(report, closeBtn);
}

// Auto-Detect-on-Play: hook the host's <audio id="audio"> 'play' event so
// pressing Play in the host UI also flips Detect on. Idempotent — uses a
// dataset flag so re-injection (multi-song sessions) doesn't stack listeners.
//
// Optionally also auto-arms recording (gated by _ndAutoRecordOnPlay) so a
// looping session captures both per-iteration play snapshots AND a single
// continuous WAV. The WAV is needed downstream to split player-error from
// detector-error per attempt — pipeline-only verdicts can't tell those
// apart. Filename uses the same song-slug+timestamp pattern as
// _ndRecordAlignedStart so existing tooling (`make pull-session` etc.)
// finds it without changes.
function _ndAttachAutoDetectListener() {
    const audio = document.getElementById('audio');
    if (!audio || audio.dataset.ndAutoDetect === '1') return;
    audio.dataset.ndAutoDetect = '1';
    audio.addEventListener('play', () => {
        if (_ndAutoDetectOnPlay && !_ndEnabled) {
            console.log('[note_detect] Auto-enabling Detect on play');
            _ndToggle();
        }
        if (_ndAutoRecordOnPlay && !_ndRecording) {
            const info = highway.getSongInfo && highway.getSongInfo();
            const slugSource = info?.filename || info?.title || '';
            const songSlug = slugSource
                ? slugSource.replace(/\.\w+$/, '').replace(/[^a-z0-9-]/gi, '_').toLowerCase()
                : 'autorec';
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const filename = `${songSlug}-${stamp}.wav`;
            console.log(`[note_detect] Auto-arming recording on play (${filename}, max ${_ND_AUTO_RECORD_MAX_SEC}s)`);
            _ndRecordStart(_ND_AUTO_RECORD_MAX_SEC, filename);
        }
    });
    // Seek / pause invalidates scheduled clicks: they're already queued in
    // the WebAudio graph at fixed times. Easiest fix is just to clear the
    // "already scheduled" set so any rescheduling can recover after the seek
    // finishes. The few seconds of stale clicks already in flight will play
    // out on the old timeline but the schedule will heal within a beat.
    audio.addEventListener('seeking', () => { _ndClickTrackScheduled.clear(); });
    audio.addEventListener('pause', ()    => { _ndClickTrackScheduled.clear(); });
}

// ── Click-track-only playback ────────────────────────────────────────────
// A wood-block click on every chart beat, scheduled into the existing
// audio context. Uses the beats array already exposed by highway.

function _ndScheduleClick(audioCtx, atCtxTime, freqHz = 1500, amp = 0.25, durationSec = 0.06) {
    // Two-frequency mix for percussive bite — same character as the
    // pre-rendered synth-track click, just scheduled live instead of
    // baked into a WAV.
    const gain = audioCtx.createGain();
    gain.connect(audioCtx.destination);
    gain.gain.setValueAtTime(0, atCtxTime);
    gain.gain.linearRampToValueAtTime(amp, atCtxTime + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.001, atCtxTime + durationSec);
    for (const [f, w] of [[freqHz, 0.7], [freqHz * 2.5, 0.3]]) {
        const osc = audioCtx.createOscillator();
        osc.frequency.value = f;
        const oscGain = audioCtx.createGain();
        oscGain.gain.value = w;
        osc.connect(oscGain);
        oscGain.connect(gain);
        osc.start(atCtxTime);
        osc.stop(atCtxTime + durationSec);
    }
}

function _ndScheduleUpcomingClicks() {
    if (!_ndClickTrackOnly || !_ndAudioCtx) return;
    const audio = document.getElementById('audio');
    if (!audio || audio.paused) return;
    const audioT = audio.currentTime;
    const ctxT = _ndAudioCtx.currentTime;
    const beats = (highway.getBeats && highway.getBeats()) || [];
    for (const b of beats) {
        const dt = b.time - audioT;
        if (dt < 0 || dt > _ND_CLICK_LOOKAHEAD_SEC) continue;
        const key = b.time.toFixed(4);
        if (_ndClickTrackScheduled.has(key)) continue;
        const downbeat = b.measure != null && b.measure !== -1;
        _ndScheduleClick(_ndAudioCtx, ctxT + dt,
            downbeat ? 2200 : 1500, downbeat ? 0.35 : 0.25);
        _ndClickTrackScheduled.add(key);
    }
}

function _ndApplyClickTrackOnly(enabled) {
    _ndClickTrackOnly = !!enabled;
    const audio = document.getElementById('audio');
    if (audio) audio.muted = _ndClickTrackOnly;
    if (_ndClickTrackInterval) { clearInterval(_ndClickTrackInterval); _ndClickTrackInterval = null; }
    _ndClickTrackScheduled.clear();
    if (_ndClickTrackOnly) {
        // Poll faster than the lookahead so every beat gets scheduled in time.
        _ndClickTrackInterval = setInterval(_ndScheduleUpcomingClicks, 100);
        console.log('[note_detect] Click-track-only mode ON (song muted, clicks on every beat)');
    } else {
        console.log('[note_detect] Click-track-only mode OFF (song audio restored)');
    }
}

function _ndUpdateButton() {
    const btn = document.getElementById('btn-notedetect');
    if (!btn) return;
    if (_ndEnabled) {
        btn.className = 'px-3 py-1.5 bg-green-900/50 rounded-lg text-xs text-green-300 transition';
        btn.textContent = 'Detect \u2713';
    } else {
        btn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
        btn.textContent = 'Detect';
    }
    const gear = document.getElementById('btn-notedetect-settings');
    if (gear) gear.classList.toggle('hidden', !_ndEnabled);
    const diag = document.getElementById('btn-notedetect-diag');
    if (diag) diag.classList.toggle('hidden', !_ndEnabled);
    const report = document.getElementById('btn-notedetect-report');
    if (report) report.classList.toggle('hidden', !_ndEnabled);
}

async function _ndToggle() {
    _ndEnabled = !_ndEnabled;
    _ndUpdateButton();

    if (_ndEnabled) {
        // Read tuning from song info
        const info = highway.getSongInfo();
        console.log('[note_detect] Song info:', JSON.stringify({
            title: info?.title, arrangement: info?.arrangement,
            tuning: info?.tuning, tuningType: typeof info?.tuning,
            capo: info?.capo,
        }));
        if (info && Array.isArray(info.tuning)) {
            _ndTuningOffsets = info.tuning;
        } else if (info && info.tuning) {
            console.warn('[note_detect] info.tuning is not an array:', info.tuning);
            // Leave _ndTuningOffsets at default [0,...] — don't set to a string
        }
        if (info && info.capo !== undefined) {
            _ndCapo = info.capo;
        }
        if (info && info.arrangement) {
            _ndSetArrangement(info.arrangement);
        }

        // Reset scoring
        _ndResetScoring();

        const ok = await _ndStartAudio();
        if (!ok) {
            _ndEnabled = false;
            _ndUpdateButton();
            return;
        }

        // Start miss-check polling and HUD
        _ndMissCheckInterval = setInterval(_ndCheckMisses, 100);
        _ndStartHUD();

        if (_ndDetectionMethod === 'crepe') _ndLoadCrepe();

        // Seed the trouble map from the most recent prior play so notes the
        // player missed last time glow as they approach. Fire-and-forget;
        // glow renders only after the fetch resolves.
        _ndLoadTroubleFromDisk();
    } else {
        _ndStopAudio();
        _ndStopHUD();
        if (_ndMissCheckInterval) { clearInterval(_ndMissCheckInterval); _ndMissCheckInterval = null; }

        // Snapshot the final play before the report reads from history —
        // await so the latest play is on disk by the time _ndShowReport's
        // GET /plays request hits the server.
        await _ndSnapshotPlay('detect_off');

        // Auto-open the rich Practice Report (replaces the old _ndShowSummary
        // modal — the report includes Top 3 prescriptions + Top Issues with
        // advice + Suggested Loops, all driven by the same per-play history).
        // _ndShowReport is a toggle: if it's already open, calling it removes
        // the panel. Guard so detect-off-after-having-it-open doesn't dismiss.
        if (!document.getElementById('nd-report-panel')) {
            _ndShowReport();
        }

        // Close settings panel
        const panel = document.getElementById('nd-settings-panel');
        if (panel) panel.remove();
    }

    function stopBridgeLevelMeter() {
        if (bridgeLevelTimer) {
            clearInterval(bridgeLevelTimer);
            bridgeLevelTimer = null;
        }
    }

function _ndResetScoring() {
    _ndHits = 0;
    _ndMisses = 0;
    _ndPitchMisses = 0;
    _ndTimingMisses = 0;
    _ndEarly = _ndLate = _ndSharp = _ndFlat = 0;
    _ndStreak = 0;
    _ndBestStreak = 0;
    _ndNoteResults.clear();
    _ndSectionStats = [];
    _ndCurrentSection = null;
    _ndDetectedMidi = -1;
    _ndDetectedConfidence = 0;
    _ndDetectedString = -1;
    _ndDetectedFret = -1;
    _ndEventLog = [];
    _ndNotePitchAttempts.clear();
    _ndNoteHygiene.clear();
    _ndRawMidiHistory = [];
    _ndStableMidi = -1;
    _ndDriftBuffer = [];
    _ndDriftEstimateMs = 0;
}

// ── End-of-song Summary ────────────────────────────────────────────────────

// Aggregate the last N play snapshots into a ranked "practice these" list.
// Score = occurrence_count × avg_severity, surfacing notes that the user
// misses often AND misses badly. Returns top `topN` entries.
function _ndRankPracticeNotes(plays, topN = 10) {
    const buckets = new Map(); // key -> { s, f, chartT, expectedMidi, count, sevSum, samples: [] }
    for (const play of plays) {
        for (const r of (play.noteResults || [])) {
            if (!r || r.severity === undefined || r.severity === 0) continue;
            // Round chartT to nearest 5ms — same chart note across loops/plays
            // collapses into one bucket regardless of micro-jitter.
            const chartTBin = Math.round((r.chartT || 0) * 200) / 200;
            const k = `${r.s}|${r.f}|${chartTBin}`;
            let b = buckets.get(k);
            if (!b) {
                b = { s: r.s, f: r.f, chartT: chartTBin, expectedMidi: r.expectedMidi,
                      count: 0, sevSum: 0, samples: [] };
                buckets.set(k, b);
            }
            b.count++;
            b.sevSum += r.severity;
            b.samples.push({
                primary: r.primary,
                timingError: r.timingError,
                pitchError: r.pitchError,
            });
        }
    }
    const rows = [];
    buckets.forEach(b => {
        const avgSev = b.sevSum / b.count;
        rows.push({ ...b, avgSev, score: b.count * avgSev });
    });
    rows.sort((a, b) => b.score - a.score);
    return rows.slice(0, topN);
}

function _ndDescribeFailureMode(samples) {
    // Pick the most common primary outcome and report a representative magnitude.
    const counts = { HIT: 0, MISSED_WRONG_PITCH: 0, MISSED_NO_DETECTION: 0 };
    let pitchErrSum = 0, pitchErrN = 0, timingErrSum = 0, timingErrN = 0;
    for (const s of samples) {
        counts[s.primary] = (counts[s.primary] || 0) + 1;
        if (s.pitchError != null)  { pitchErrSum  += s.pitchError;  pitchErrN++;  }
        if (s.timingError != null) { timingErrSum += s.timingError; timingErrN++; }
    }
    const dominant = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    if (dominant === 'MISSED_NO_DETECTION') return 'no input detected';
    if (dominant === 'MISSED_WRONG_PITCH') {
        if (pitchErrN === 0) return 'wrong pitch';
        const avg = Math.round(pitchErrSum / pitchErrN);
        return `wrong pitch (avg ${avg > 0 ? '+' : ''}${avg}¢)`;
    }
    // Imperfect hit — describe whichever error is bigger
    const tAvg = timingErrN ? timingErrSum / timingErrN : 0;
    const pAvg = pitchErrN  ? pitchErrSum  / pitchErrN  : 0;
    const tFrac = Math.abs(tAvg) / 300;
    const pFrac = Math.abs(pAvg) / 100;
    if (tFrac > pFrac && timingErrN > 0) {
        const ms = Math.round(tAvg);
        return `${ms > 0 ? 'late' : 'early'} (avg ${ms > 0 ? '+' : ''}${ms}ms)`;
    }
    if (pitchErrN > 0) {
        const c = Math.round(pAvg);
        return `${c > 0 ? 'sharp' : 'flat'} (avg ${c > 0 ? '+' : ''}${c}¢)`;
    }
    return 'imperfect';
}

function _ndFormatChartTime(t) {
    const mm = Math.floor(t / 60);
    const ss = Math.floor(t % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
}

// Pull every signed timing/pitch error from the last-N plays.
//   - timing: HIT records only (NO_DETECTION + WRONG_PITCH have null timing)
//   - pitch: HIT + WRONG_PITCH (NO_DETECTION has null pitch)
// Returns plain Number[] arrays so the binning helper can chew through them.
function _ndAggregatePlayErrors(plays) {
    const timing = [];
    const pitch = [];
    for (const play of plays) {
        for (const r of (play.noteResults || [])) {
            if (!r) continue;
            // typeof NaN === 'number', so an isFinite gate is required to
            // keep accidental NaNs out of downstream binning.
            if (typeof r.timingError === 'number' && isFinite(r.timingError)) timing.push(r.timingError);
            if (typeof r.pitchError  === 'number' && isFinite(r.pitchError))  pitch.push(r.pitchError);
        }
    }
    return { timing, pitch };
}

// Equal-width binning with edge clamping. Out-of-range values land in the
// nearest edge bin so outliers stay visible instead of being dropped silently.
// Returns { bins: number[], binWidth, lo, hi } where bins[i] covers
// [lo + i*binWidth, lo + (i+1)*binWidth).
function _ndBinErrors(values, binWidth, lo, hi) {
    const numBins = Math.max(1, Math.ceil((hi - lo) / binWidth));
    const bins = new Array(numBins).fill(0);
    for (const v of values) {
        if (typeof v !== 'number' || !isFinite(v)) continue;
        const clamped = Math.max(lo, Math.min(hi - 1e-9, v));
        const idx = Math.max(0, Math.min(numBins - 1, Math.floor((clamped - lo) / binWidth)));
        bins[idx]++;
    }
    return { bins, binWidth, lo, hi };
}

// Inline-SVG histogram. Returns an HTML string suitable for innerHTML.
// Bars are colored by distance from zero (green at center, red at edges) so
// the eye can spot tail-heavy distributions. Zero-line marker drawn as a
// vertical white tick.
function _ndRenderHistogram(title, values, opts) {
    const { binWidth, lo, hi, unit, ticks } = opts;
    if (!values.length) {
        return `<div class="text-[10px] text-gray-600 italic mb-2">${title}: no data</div>`;
    }
    const { bins } = _ndBinErrors(values, binWidth, lo, hi);
    const maxCount = Math.max(1, ...bins);
    const W = 432, H = 80;                    // matches modal w-[480px] minus padding
    const PAD_L = 8, PAD_R = 8, PAD_T = 6, PAD_B = 18;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;
    const barW = plotW / bins.length;
    const range = hi - lo;
    const xForVal = (v) => PAD_L + ((v - lo) / range) * plotW;

    let bars = '';
    for (let i = 0; i < bins.length; i++) {
        const c = bins[i];
        if (c === 0) continue;
        const h = (c / maxCount) * plotH;
        const x = PAD_L + i * barW;
        const y = PAD_T + (plotH - h);
        // Color: distance-from-zero fraction → green (0) to red (1)
        const binCenter = lo + (i + 0.5) * binWidth;
        const distFrac = Math.min(1, Math.abs(binCenter) / Math.max(Math.abs(lo), Math.abs(hi)));
        const r = Math.round(80 + 175 * distFrac);
        const g = Math.round(200 - 150 * distFrac);
        bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW - 0.5).toFixed(1)}" height="${h.toFixed(1)}" fill="rgb(${r},${g},80)"/>`;
    }

    // Zero-line marker
    const zeroX = xForVal(0);
    const zeroLine = `<line x1="${zeroX.toFixed(1)}" y1="${PAD_T}" x2="${zeroX.toFixed(1)}" y2="${PAD_T + plotH}" stroke="white" stroke-width="1" stroke-dasharray="2,2" opacity="0.6"/>`;

    // Axis labels
    let axis = '';
    for (const tickVal of ticks) {
        const tx = xForVal(tickVal);
        const sign = tickVal > 0 ? '+' : '';
        axis += `<text x="${tx.toFixed(1)}" y="${H - 4}" fill="#888" font-size="9" font-family="monospace" text-anchor="middle">${sign}${tickVal}${unit}</text>`;
        axis += `<line x1="${tx.toFixed(1)}" y1="${PAD_T + plotH}" x2="${tx.toFixed(1)}" y2="${PAD_T + plotH + 2}" stroke="#666"/>`;
    }

    return `
        <div class="mt-2">
            <div class="flex justify-between items-center text-[10px] text-gray-500 mb-1">
                <span>${title}</span>
                <span>${values.length} sample${values.length === 1 ? '' : 's'}</span>
            </div>
            <svg viewBox="0 0 ${W} ${H}" class="w-full" style="background:#1a1a1a;border-radius:4px;">
                ${bars}
                ${zeroLine}
                ${axis}
            </svg>
        </div>
    `;
}

function _ndRenderPracticeList(plays) {
    const ranked = _ndRankPracticeNotes(plays, 10);
    if (!ranked.length) {
        return `<div class="text-gray-500 text-xs italic">No imperfect notes across the last ${plays.length} play(s) — clean run.</div>`;
    }
    let html = `<div class="text-gray-400 text-xs mb-1">Practice these (last ${plays.length} play${plays.length === 1 ? '' : 's'}):</div>`;
    for (const r of ranked) {
        const noteName = _fcMidiToNoteName(r.expectedMidi);
        const stringLabel = `s${(r.s ?? 0) + 1} f${r.f ?? 0}`;
        const failureDesc = _ndDescribeFailureMode(r.samples);
        const sevPct = Math.round(r.avgSev * 100);
        const barColor = r.avgSev >= 0.7 ? 'bg-red-500' : r.avgSev >= 0.4 ? 'bg-yellow-500' : 'bg-blue-500';
        html += `
            <div class="flex items-center gap-2 mb-1 text-xs">
                <span class="w-12 text-gray-300 font-mono">${_ndFormatChartTime(r.chartT)}</span>
                <span class="w-10 text-gray-200 font-semibold">${noteName}</span>
                <span class="w-12 text-gray-500 font-mono text-[10px]">${stringLabel}</span>
                <div class="flex-1 h-2 bg-dark-600 rounded overflow-hidden">
                    <div class="${barColor} h-full rounded" style="width:${sevPct}%"></div>
                </div>
                <span class="w-8 text-right text-gray-400 font-mono">${r.count}×</span>
                <span class="flex-shrink-0 w-32 text-right text-gray-500 text-[10px] truncate" title="${failureDesc}">${failureDesc}</span>
            </div>
        `;
    }
    return html;
}

async function _ndPopulateReport() {
    const practiceSlot = document.getElementById('nd-practice-slot');
    const histSlot     = document.getElementById('nd-hist-slot');
    if (!practiceSlot && !histSlot) return;

    const songId = _ndCurrentSongId();
    if (!songId) {
        if (practiceSlot) practiceSlot.innerHTML = '<div class="text-gray-500 text-xs italic">No song loaded.</div>';
        if (histSlot) histSlot.innerHTML = '';
        return;
    }
    const plays = await _ndFetchPlays(songId);
    if (!plays.length) {
        if (practiceSlot) practiceSlot.innerHTML = '<div class="text-gray-500 text-xs italic">No play history yet — play through once to start collecting data.</div>';
        if (histSlot) histSlot.innerHTML = '';
        return;
    }
    if (practiceSlot) practiceSlot.innerHTML = _ndRenderPracticeList(plays);
    if (histSlot) {
        const { timing, pitch } = _ndAggregatePlayErrors(plays);
        histSlot.innerHTML =
            _ndRenderHistogram('Timing error', timing, {
                binWidth: 25, lo: -300, hi: 300, unit: 'ms',
                ticks: [-300, -150, 0, 150, 300],
            }) +
            _ndRenderHistogram('Pitch error', pitch, {
                binWidth: 10, lo: -200, hi: 200, unit: '¢',
                ticks: [-200, -100, 0, 100, 200],
            });
    }
}

function _ndOpenReport() {
    _ndShowSummary(true);
}

function _ndShowSummary(manual = false) {
    const total = _ndHits + _ndMisses;
    if (!manual && total < 5) return; // not enough data for the auto-on-stop case

    let overlay = document.getElementById('nd-summary-overlay');
    if (overlay) overlay.remove();

    const accuracy = Math.round((_ndHits / total) * 100);

    let sectionHtml = '';
    if (_ndSectionStats.length > 0) {
        sectionHtml = '<div class="mt-3 text-xs"><div class="text-gray-400 mb-1">Per Section:</div>';
        for (const sec of _ndSectionStats) {
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
    }

    overlay = document.createElement('div');
    overlay.id = 'nd-summary-overlay';
    overlay.className = 'fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
        <div class="bg-dark-700 border border-gray-600 rounded-2xl p-6 w-[480px] max-h-[85vh] overflow-y-auto shadow-2xl">
            <div class="text-center mb-4">
                <div class="text-3xl font-bold ${accuracy >= 90 ? 'text-green-400' : accuracy >= 70 ? 'text-yellow-400' : 'text-red-400'}">${accuracy}%</div>
                <div class="text-gray-400 text-sm">Accuracy</div>
            </div>
            <div class="grid grid-cols-3 gap-3 text-center text-sm mb-3">
                <div>
                    <div class="text-green-400 font-bold">${_ndHits}</div>
                    <div class="text-gray-500 text-xs">Hits</div>
                </div>
                <div>
                    <div class="text-red-400 font-bold">${_ndMisses}</div>
                    <div class="text-gray-500 text-xs">Misses</div>
                </div>
                <div>
                    <div class="text-blue-400 font-bold">${_ndBestStreak}</div>
                    <div class="text-gray-500 text-xs">Best Streak</div>
                </div>
            </div>
            ${sectionHtml}
            <div id="nd-practice-slot" class="mt-3 border-t border-gray-700 pt-3">
                <div class="text-gray-500 text-xs italic">Loading practice list…</div>
            </div>
            <div id="nd-hist-slot" class="mt-3 border-t border-gray-700 pt-3"></div>
            <button onclick="this.parentElement.parentElement.remove()"
                    class="mt-4 w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-sm text-gray-300 transition">
                Close
            </button>
        </div>
    `;
    document.body.appendChild(overlay);

    // Async-fill the practice list and histograms from the per-play history
    _ndPopulateReport();

    // Publish to Practice Journal if installed
    _ndPublishToJournal(accuracy);
}

        // If the instance was disabled (or re-enabled into a new
        // session) while CREPE was awaiting, drop this result on the
        // floor — don't touch detection state or fire events.
        if (!enabled || gen !== sessionGen) return;

        if (result.freq <= 0 || result.confidence < detectionConfidenceMin) {
            if (result.underBuffered && !underBufferWarned) {
                console.warn(`[note_detect] ${detectorUsed} received an undersized buffer — low-frequency (bass) notes will drop silently. Check the frame accumulation path.`);
                underBufferWarned = true;
            }
            detectedMidi = -1;
            detectedConfidence = 0;
            detectedString = -1;
            detectedFret = -1;
            detectedDisplayMidi = -1;
            // Fall through to matchNotes — the chord path doesn't need a
            // single confident pitch (it scores per-string energy bands),
            // and chord audio is the case where YIN/HPS most often
            // returns low confidence. Single-note matching inside
            // matchNotes() is gated on detectedMidi >= 0, so it skips
            // itself; only chord groups get evaluated here.
        } else {
            detectedMidi = _ndFreqToMidi(result.freq);
            detectedConfidence = result.confidence;
        }

        // Stamp the detector identity for the diagnostic — web JS-DSP path.
        _diagDetector = { desktop_bridge: false, ml: false, path: 'web-' + detectionMethod };

        // Pass the current frame's buffer through to matchNotes so the
        // chord scorer can run on the same audio that was just analysed
        // for pitch. The shared `pendingBuffer` is cleared by the timer
        // (see detectInterval) before processFrame is called, so reading
        // it later from matchNotes would either skip (null) or pick up a
        // newer buffer captured mid-processing.
        await matchNotes(buffer);

        // Reference-recording capture: tap the same audio the detector
        // just analysed. Gated on (a) the user having armed a take and
        // (b) the song actually playing — we don't want to fill the
        // buffer with silence from someone leaving Detect running on
        // the home screen.
        if (_recArmed && _recSongPlaying) {
            _recSampleRate = audioCtx ? audioCtx.sampleRate : (bridgeSampleRate || _recSampleRate);
            // Client-side cap mirrors the routes.py 32 MB ceiling so a
            // runaway arm (user walks away with Detect still capturing)
            // can't balloon the page's heap before the server-side cap
            // rejects the upload. 32 MB / 4 bytes per Float32 ≈ 8M
            // samples ≈ 190 s at 44.1 kHz (~3.2 min) — well past a
            // single benchmark take. When we hit it, the buffer stays
            // at the cap and `_recCappedAt` is set so the save path
            // can surface a "truncated" note on the resulting WAV.
            //
            // Track the running sample count in `_recTotalSamples`
            // rather than `_recChunks.reduce(...)` per frame. The
            // reduce was O(n) per frame and O(n²) over a take — a
            // measurable hit on the detection hot path on long
            // recordings.
            const maxSamples = Math.floor((32 * 1024 * 1024) / 4);
            if (_recTotalSamples >= maxSamples) {
                if (!_recCappedAt) _recCappedAt = _recTotalSamples / (_recSampleRate || 44100);
                // Silently drop further frames — the cap is the upper bound
                // and we'd rather keep the first N minutes than truncate the
                // tail of a long take.
            } else {
                // slice() because the analyser may overwrite the buffer the
                // next time processFrame fires.
                const copy = buffer.slice();
                _recChunks.push(copy);
                _recTotalSamples += copy.length;
            }
        }
    }

    // ── Note matching ─────────────────────────────────────────────────
    function noteKey(note, time) {
        return `${time.toFixed(3)}_${note.s}_${note.f}`;
    }

    // ── Renderer note-state provider (slopsmith#254) ──────────────────
    // How long (s) a missed note's gem stays red-washed on the highway.
    // Short on purpose — the slide-down miss marker (drawOverlay) carries
    // the longer-lived feedback; the gem wash is just an instant cue.
    const NOTE_MISS_GEM_TTL = 0.6;
    // Grace (ms) after an on-pitch detection during which a sustained
    // note still counts as actively held — smooths render-vs-pitch frame
    // rate mismatch (see _susActiveUntil).
    const NOTE_SUS_GRACE_MS = 250;

    // Registered via highway.setNoteStateProvider(). The active renderer
    // calls this per visible chart note / chord-note. Returns null (render
    // normally), or { state, alpha } where state ∈ {'active','hit','miss'}:
    //   'active' — sustained note still ringing AND currently on-pitch (full glow)
    //   'hit'    — recently struck cleanly (glow fading over hitGlowDuration)
    //   'miss'   — recently judged a miss (brief red wash)
    // `note` is the chart note object; for chord notes `chartTime` is the
    // chord's time (matches how noteResults keys chord notes). Must stay
    // cheap: called per note per renderer per frame.
    function noteStateFor(note, chartTime) {
        if (!enabled || !note || !Number.isFinite(chartTime)) return null;
        const key = noteKey(note, chartTime);
        const j = noteResults.get(key);
        if (!j) return null;  // not judged yet — render normally

        // Renderer clock for the visual age / TTL math — `getTime() +
        // avOffset` is the same basis `drawOverlay()` uses for its slide-
        // down miss markers and matches when the user *sees* the note
        // cross the strike line. The `-latencyOffset` correction is for
        // *audio* timing (correlating mic input to chart notes in
        // matchNotes/checkMisses); applying it here would start the
        // post-hit fade ~latencyOffset (default 80 ms) before the gem
        // visually arrived, shortening the visible glow window.
        const songT = ((hw && hw.getTime) ? hw.getTime() : 0)
            + ((hw && hw.getAvOffset) ? hw.getAvOffset() / 1000 : 0);

        if (j.hit) {
            const sus = +note.sus || 0;
            // Sustained note still inside its ring window AND currently
            // being played on-pitch → hold it at full glow.
            if (sus > 0.05 && songT < chartTime + sus + 0.05 && _sustainStillHeld(key, note)) {
                return { state: 'active', alpha: 1 };
            }
            // Otherwise: brief post-strike glow that fades out over
            // hitGlowDuration.
            const age = songT - chartTime;
            if (age < 0) return { state: 'hit', alpha: 1 };  // struck a hair early
            const glowDur = Math.max(0.1, hitGlowDuration);
            if (age >= glowDur) return null;
            return { state: 'hit', alpha: 1 - age / glowDur };
        }
        // Missed (timing window expired, or matched-but-not-clean).
        const age = songT - chartTime;
        if (age < 0 || age >= NOTE_MISS_GEM_TTL) return null;
        return { state: 'miss', alpha: 1 - age / NOTE_MISS_GEM_TTL };
    }

    // Is the live monophonic detection on target for `note`? Maintains a
    // short grace window in _susActiveUntil so a held note doesn't flicker
    // between audio frames. Chord notes don't get a per-frame polyphonic
    // re-score today — for a sustained chord this returns false once the
    // monophonic detector loses the pitch, so the chord falls through to
    // the post-strike glow fade in noteStateFor.
    // TODO(slopsmith#254 follow-up): re-run the constraint chord scorer
    // per audio frame for sustained-and-hit chords so held chords glow
    // the same way held single notes do.
    function _sustainStillHeld(key, note) {
        const nowMs = (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
        if (detectedMidi >= 0 && detectedConfidence > detectionConfidenceMin) {
            const expectedMidi = _ndMidiFromStringFret(
                note.s, note.f, currentArrangement, currentStringCount, tuningOffsets, capo
            );
            if (Number.isFinite(expectedMidi)
                && Math.abs(_ndNearestOctaveCents(detectedMidi, expectedMidi)) <= pitchTolerance) {
                _susActiveUntil.set(key, nowMs + NOTE_SUS_GRACE_MS);
                return true;
            }
        }
        const until = _susActiveUntil.get(key);
        return Number.isFinite(until) && until > nowMs;
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

    // The `extra.chord ? chordTimingHitThreshold : timingHitThreshold`
    // selector below is the chord-vs-single-note threshold split for
    // issue #38. _ndMakeJudgment is threshold-agnostic — it honours
    // whatever `timingThresholdMs` we pass — so the entire chord-window
    // policy lives at THIS call site (and its sibling `makeMissJudgment`
    // below). End-to-end coverage of the selector lives in
    // tools/regression-fixtures.json (Bad Habit): if this ternary ever
    // inverts or drops chord-judgment widening, the fixture score
    // collapses by ~10pp on a fixed input. Unit-level coverage of
    // _ndMakeJudgment's threshold handling itself is in
    // test/judgment.test.js.
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
            timingThresholdMs: (extra.chord ? chordTimingHitThreshold : timingHitThreshold) * 1000,
            pitchThresholdCents: pitchHitThreshold,
            hitStrings: extra.hitStrings,
            totalStrings: extra.totalStrings,
            score: extra.score,
            monophonicDetected: extra.monophonicDetected,
            lateGraceMs: extra.lateGraceMs,
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
            timingThresholdMs: (extra.chord ? chordTimingHitThreshold : timingHitThreshold) * 1000,
            pitchThresholdCents: pitchHitThreshold,
            hitStrings: extra.hitStrings,
            totalStrings: extra.totalStrings,
            score: extra.score,
            lateGraceMs: extra.lateGraceMs,
        });
    }

    // Update per-string diagnostic counters for a chord constituent
    // judgment WITHOUT updating any other diagnostic counter. Chord
    // constituent judgments are stashed straight into noteResults
    // (bypassing recordJudgment) because totals/event-log are
    // already accounted for at the chord-level entry — but the
    // per-string panel still needs to see each string's outcome,
    // otherwise it overrepresents whatever string happens to be
    // `liveNotes[0]` and is blind to the rest.
    function _recordPerStringForChord(judgment) {
        const n = judgment.chartNote || judgment.note;
        if (n && Number.isInteger(n.s) && n.s >= 0 && n.s < _diagPerString.length) {
            const slot = _diagPerString[n.s];
            if (judgment.hit) slot.hits++; else slot.misses++;
        }
    }

    // Bin one judgment into the diagnostic counters. Called from inside
    // recordJudgment under the same `count` gate so this never double-
    // counts (chord events fire one chord-level judgment plus per-string
    // ones; only the chord-level passes count=true). One miss → exactly
    // one primary-cause bin (chord events into chordPartial regardless
    // of axis; non-chord misses chosen as pure → timing → pitch in that
    // priority, so a single bar height adds up to total misses).
    //
    // NOTE: per-string counters here only see the chord-level chartNote
    // (lead constituent). Chord constituents go through
    // _recordPerStringForChord at their stash sites so per-string
    // stats reflect each string's actual outcome.
    function _recordDiagnostic(judgment) {
        const isChord = !!judgment.chord;
        if (judgment.hit) {
            (isChord ? _diagChords : _diagSingles).hits++;
        } else {
            (isChord ? _diagChords : _diagSingles).misses++;
            if (isChord) {
                _diagBreakdown.chordPartial++;
            } else if (judgment.detectedMidi == null) {
                _diagBreakdown.pure++;
            } else if (judgment.timingState === 'EARLY') {
                _diagBreakdown.early++;
            } else if (judgment.timingState === 'LATE') {
                _diagBreakdown.late++;
            } else if (judgment.pitchState === 'SHARP') {
                _diagBreakdown.sharp++;
            } else if (judgment.pitchState === 'FLAT') {
                _diagBreakdown.flat++;
            } else {
                // Defensive fallback — keep totals balanced if a future
                // judgment shape doesn't trip any axis (shouldn't happen
                // today). Land it in pure so the bin sums still match.
                _diagBreakdown.pure++;
            }
        }
        // Per-string counters: only update for non-chord judgments here.
        // For chord-level judgments, judgment.chartNote is the chord's
        // lead constituent (`liveNotes[0]`), which doesn't represent any
        // single string's outcome — counting it here would overrepresent
        // whichever string happened to be the lead and miss the other
        // constituents. Per-string credit for chord constituents flows
        // through _recordPerStringForChord at the constituent stash sites.
        if (!isChord) {
            const n = judgment.chartNote || judgment.note;
            if (n && Number.isInteger(n.s) && n.s >= 0 && n.s < _diagPerString.length) {
                const slot = _diagPerString[n.s];
                if (judgment.hit) slot.hits++; else slot.misses++;
            }
        }
        if (Number.isFinite(judgment.timingError) && _diagTimingErrors.length < _DIAG_ERROR_CAP) {
            _diagTimingErrors.push(judgment.timingError);
            if (judgment.hit && _diagTimingErrorsHits.length < _DIAG_ERROR_CAP) {
                _diagTimingErrorsHits.push(judgment.timingError);
            }
        }
        if (Number.isFinite(judgment.pitchError) && _diagPitchErrors.length < _DIAG_ERROR_CAP) {
            _diagPitchErrors.push(judgment.pitchError);
        }
        // Build the event object once; push to in-memory log (capped)
        // AND stream to the backend live-judgment endpoint when tuning
        // mode is on. The streaming path is fire-and-forget — failures
        // are swallowed since they shouldn't disrupt detection or
        // bookkeeping.
        const nn = judgment.chartNote || judgment.note || {};
        const eventObj = {
            t:   Number.isFinite(judgment.noteTime) ? +judgment.noteTime.toFixed(3) : null,
            at:  Number.isFinite(judgment.time)     ? +judgment.time.toFixed(3)     : null,
            s:   Number.isInteger(nn.s) ? nn.s : null,
            f:   Number.isInteger(nn.f) ? nn.f : null,
            sus: Number.isFinite(nn.sus) ? +(+nn.sus).toFixed(3) : 0,
            hit:   !!judgment.hit,
            chord: !!judgment.chord,
            ts:  judgment.timingState || null,
            ps:  judgment.pitchState  || null,
            te:  Number.isFinite(judgment.timingError) ? judgment.timingError : null,
            pe:  Number.isFinite(judgment.pitchError)  ? judgment.pitchError  : null,
            ex:  Number.isFinite(judgment.expectedMidi) ? judgment.expectedMidi : null,
            dx:  Number.isFinite(judgment.detectedMidi) ? judgment.detectedMidi : null,
            cnf: Number.isFinite(judgment.confidence) ? +judgment.confidence.toFixed(3) : 0,
            hs:  Number.isFinite(judgment.hitStrings)   ? judgment.hitStrings   : undefined,
            tt:  Number.isFinite(judgment.totalStrings) ? judgment.totalStrings : undefined,
            sc:  Number.isFinite(judgment.score) ? +judgment.score.toFixed(3) : undefined,
            tf:  _diagTechFlags(nn),
        };
        if (_diagEvents.length < _DIAG_EVENT_CAP) {
            _diagEvents.push(eventObj);
        }
        if ((tuningMode || _recArmedForTraining) && _liveSessionId) {
            _streamLiveJudgment(eventObj);
        }
    }

    function _diagTechFlags(n) {
        if (!n) return null;
        const flags = [];
        if (n.bn)               flags.push('B');    // bend
        if (n.sl != null && n.sl >= 0) flags.push('S');    // slide
        if (n.hm || n.hp)       flags.push('H');    // harmonic / pinch
        if (n.ho)               flags.push('h');    // hammer-on
        if (n.po)               flags.push('p');    // pull-off
        if (n.tp)               flags.push('t');    // tap
        if (n.pm)               flags.push('PM');   // palm mute
        if (n.mt)               flags.push('M');    // muted
        if (n.tr)               flags.push('TR');   // tremolo
        if (n.ac)               flags.push('A');    // accent
        if ((+n.sus || 0) > 0)  flags.push('SUS');
        return flags.length ? flags.join(',') : null;
    }

    function _diagPercentile(arr, p) {
        if (!arr || !arr.length) return null;
        const sorted = arr.slice().sort((a, b) => a - b);
        return _diagPercentileFromSorted(sorted, p);
    }
    // Same nearest-rank math as _diagPercentile but takes an already-
    // sorted array. Used by the bulk helper below to avoid sorting the
    // same array three times when computing p10/median/p90 for one
    // distribution.
    function _diagPercentileFromSorted(sorted, p) {
        if (!sorted || !sorted.length) return null;
        const rank = (p / 100) * (sorted.length - 1);
        const idx = Math.max(0, Math.min(sorted.length - 1, Math.round(rank)));
        return sorted[idx];
    }
    // Sort once, compute count + p10/median/p90 once. _buildDiagnosticPayload
    // calls this three times per export (timing, timing-hits, pitch); the
    // previous code did three .slice().sort() per call there → 9 sorts per
    // payload. The Settings-page A/V auto-calibrate panel polls every 1.5 s
    // while open, so this hit was real.
    function _diagDistribution(arr) {
        if (!arr || !arr.length) return { count: 0, p10: null, median: null, p90: null };
        const sorted = arr.slice().sort((a, b) => a - b);
        return {
            count: sorted.length,
            p10:    _diagPercentileFromSorted(sorted, 10),
            median: _diagPercentileFromSorted(sorted, 50),
            p90:    _diagPercentileFromSorted(sorted, 90),
        };
    }

    function _diagResetCounters() {
        for (const k of Object.keys(_diagBreakdown)) _diagBreakdown[k] = 0;
        _diagSingles.hits = 0; _diagSingles.misses = 0;
        _diagChords.hits  = 0; _diagChords.misses  = 0;
        for (const slot of _diagPerString) { slot.hits = 0; slot.misses = 0; }
        _diagTimingErrors.length = 0;
        _diagTimingErrorsHits.length = 0;
        _diagPitchErrors.length  = 0;
        _diagEvents.length       = 0;
    }

    function recordJudgment(key, judgment, { count = true, emit = true } = {}) {
        noteResults.set(key, judgment);
        if (count) {
            _recordDiagnostic(judgment);
            // No per-judgment sync — the host getLoop() poll would land
            // on the scoring hot path. Instead we sync at enable()
            // (closes the post-enable gap) and rely on updateHUD's
            // 33 ms tick for ongoing tracking. Mid-drill bounds changes
            // lag by at most one frame, which the user can't perceive.
            if (judgment.hit) {
                hits++;
                streak++;
                if (streak > bestStreak) bestStreak = streak;
                updateSectionStat('hit');
            } else {
                misses++;
                streak = 0;
                updateSectionStat('miss');
            }
            // Mirror to drill counters. Independent state — global
            // session score is unaffected by iteration boundaries.
            if (drillEnabled) {
                if (judgment.hit) {
                    drillIterHits++;
                    drillIterStreak++;
                    if (drillIterStreak > drillIterBestStreak) drillIterBestStreak = drillIterStreak;
                } else {
                    drillIterMisses++;
                    drillIterStreak = 0;
                }
                drillDirty = true;
            }
        }
        if (emit) dispatchJudgment(judgment);
    }

    async function matchNotes(frameBuffer) {
        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const t = hw.getTime() + avOffsetSec - latencyOffset;
        // Don't bail on detectedMidi < 0 here — chord scoring uses the
        // raw audio buffer and doesn't need a confident monophonic pitch.
        // The single-note path below is gated on detectedMidi >= 0 and
        // skips itself when detection wasn't confident.

        const notes = hw.getNotes();
        const chords = hw.getChords();
        const tolerance = timingTolerance;
        const centsTolerance = pitchTolerance;

        const candidateNotes = [];

        // For sus-marked chart notes, allow late detection — the note is
        // still audibly ringing past its nominal `t + tolerance`, and
        // YIN may need ~80–100 ms of accumulated buffer to confidently
        // lock on (longer for low E). Without this, players who pluck
        // slightly late on a half- or whole-note get no judgment recorded
        // at all (pure miss) instead of a hit-while-ringing. Cap the
        // grace at MAX_SUS_LATE_GRACE so a 4-second sustain doesn't
        // accept detections seconds after the strike.
        const MAX_SUS_LATE_GRACE = 1.0;  // seconds
        if (notes && notes.length > 0) {
            // Bsearch from `t - tolerance - MAX_SUS_LATE_GRACE` so the
            // scan picks up sus-marked notes whose nominal window has
            // already closed but whose sustain envelope hasn't. The
            // per-note filter below ensures non-sus notes still age out
            // at the strict ±tolerance boundary.
            const start = bsearch(notes, t - tolerance - MAX_SUS_LATE_GRACE);
            for (let i = start; i < notes.length; i++) {
                const n = notes[i];
                if (n.t > t + tolerance) break;
                if (n.mt) continue;
                // Non-sus notes use the strict past edge; sus notes get
                // a grace bounded by both the chart's declared sustain
                // and the global cap.
                const susSec = Number.isFinite(n.sus) && n.sus > 0 ? n.sus : 0;
                const lateGrace = susSec > 0 ? Math.min(susSec, MAX_SUS_LATE_GRACE) : 0;
                if (n.t < t - tolerance - lateGrace) continue;
                // Spread the chart note so technique flags (ho/po/b/sl/hm)
                // travel with the candidate. _ndScoreChord reads these to
                // adjust per-string thresholds, so dropping them here would
                // make hammer-on/bend/harmonic adjustments dead code in
                // actual gameplay.
                candidateNotes.push({ ...n });
            }
        }
        if (chords && chords.length > 0) {
            // Chord candidate window extends past the strict upper edge
            // the same way single notes do: a chord that says "ring for
            // 1.5 s" is still audibly the right chord 800 ms after the
            // chart strike, and a player strumming late should still be
            // matched against it. The chord scorer (_ndScoreChord) does
            // its own per-string pitch + energy check on whatever audio
            // buffer is current, so an extended candidate window just
            // gives matchNotes more frames in which to attempt scoring
            // — it doesn't loosen the per-string check itself.
            //
            // Take the max sus across chord constituents so a chord with
            // mixed sustains doesn't drop out the moment its shortest
            // string would have decayed.
            const start = bsearch(chords, t - tolerance - MAX_SUS_LATE_GRACE);
            for (let i = start; i < chords.length; i++) {
                const c = chords[i];
                if (c.t > t + tolerance) break;
                let chordSus = 0;
                for (const cn of (c.notes || [])) {
                    if (cn.mt) continue;
                    if (Number.isFinite(cn.sus) && cn.sus > chordSus) chordSus = cn.sus;
                }
                const lateGrace = chordSus > 0 ? Math.min(chordSus, MAX_SUS_LATE_GRACE) : 0;
                if (c.t < t - tolerance - lateGrace) continue;
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

        // ── ML bridge: onset-driven single-note matching ──────────────────
        // Each fresh onset claims the ONE nearest unmatched single-note chart
        // note of its pitch. Previously every same-pitch candidate checked the
        // onset set independently, so a single onset matched 2-4 same-pitch
        // notes at once on dense passages — recording the extras as early
        // misses. That one-onset-to-many bug was the dominant accuracy loss.
        if (usingDesktopBridge && bridgeOnsetPrimed && bridgeNewOnsets.size > 0) {
            const singles = [];
            for (const [, group] of byTime) {
                if (group.length !== 1) continue;
                const cn = group[0];
                const key = noteKey(cn, cn.t);
                if (noteResults.has(key)) continue;
                singles.push({
                    cn, key, claimed: false,
                    em: _ndMidiFromStringFret(cn.s, cn.f, currentArrangement,
                        currentStringCount, tuningOffsets, capo),
                });
            }
            for (const [midi, onset] of bridgeNewOnsets) {
                let best = null, bestDist = Infinity;
                for (const s of singles) {
                    if (s.claimed) continue;
                    let ok = (s.em === midi);
                    if (!ok && (s.cn.b || s.cn.sl)) ok = Math.abs(s.em - midi) <= 2;
                    if (!ok && s.cn.hm) ok = (midi === s.em + 12 || midi === s.em + 19);
                    if (!ok) continue;
                    const dist = Math.abs(s.cn.t - t);  // nearest to the playhead
                    if (dist < bestDist) { bestDist = dist; best = s; }
                }
                if (best) {
                    best.claimed = true;
                    recordJudgment(best.key, makeMatchedJudgment(
                        best.cn, best.cn.t, t, best.em, best.em, onset.conf,
                        { pitchError: 0 }));
                }
            }
        }

        for (const [, group] of byTime) {
            if (group.length === 1) {
                // ML bridge single notes are matched by the onset-driven pass
                // above; here, only the web / downlevel monophonic path.
                if (usingDesktopBridge && bridgeOnsetPrimed) continue;
                if (detectedMidi < 0) continue;
                const cn = group[0];
                const key = noteKey(cn, cn.t);
                if (noteResults.has(key)) continue;

                const expectedMidi = _ndMidiFromStringFret(
                    cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                );
                const detectedCents = _ndNearestOctaveCents(detectedMidi, expectedMidi);
                if (Math.abs(detectedCents) <= centsTolerance) {
                    const judgment = makeMatchedJudgment(
                        cn, cn.t, t, expectedMidi, detectedMidi, detectedConfidence,
                        { pitchError: detectedCents }
                    );
                    recordJudgment(key, judgment);
                }
            } else {
                // ── Chord path: constraint-based per-string band analysis ──
                // Chord-level resolved key. checkMisses() honours this so a
                // failed chord becomes one miss event (not one per string).
                const chordKey = `${group[0].t.toFixed(3)}_chord`;
                if (noteResults.has(chordKey)) continue;

                // Two paths:
                //  - Browser: call _ndScoreChord against the FFT
                //    frame the ScriptProcessor just delivered.
                //  - Desktop bridge: dispatch audio:scoreChord IPC —
                //    the native ChordScorer reads from the engine's
                //    own input ring, so no audio buffer crosses IPC.
                //    Older slopsmith-desktop builds without the IPC
                //    skip the chord-scoring step entirely (same as
                //    the previous frameless guard).
                let chordResult;
                if (usingDesktopBridge) {
                    // Dispatch the scoreChord IPC. The native scorer is
                    // ML-backed when a model is loaded (judging each chart
                    // note against the ML detector's active pitch set), else
                    // the constraint scorer — and it times chords correctly,
                    // which a renderer-side detectNotes scorer did not.
                    if (!bridgeDesktop || !bridgeDesktop.audio
                        || typeof bridgeDesktop.audio.scoreChord !== 'function') {
                        continue;
                    }
                    const ctx = {
                        arrangement: currentArrangement,
                        stringCount: currentStringCount,
                        offsets: tuningOffsets.slice(0, currentStringCount),
                        capo,
                        pitchCheckCents: centsTolerance,
                        minHitRatio: chordHitRatio,
                        notes: group.map(cn => ({
                            s: cn.s, f: cn.f,
                            ho: !!cn.ho, po: !!cn.po,
                            b: !!cn.b, sl: !!cn.sl, hm: !!cn.hm,
                        })),
                    };
                    const gen = sessionGen;
                    try {
                        chordResult = await bridgeDesktop.audio.scoreChord(ctx);
                    } catch (e) {
                        console.warn('[note_detect] scoreChord IPC failed:', e && e.message ? e.message : e);
                        continue;
                    }
                    if (!chordResult) continue; // downlevel addon returned null
                    // Re-validate after the await. The IPC round-trip
                    // yields the event loop, so checkMisses() can fire
                    // on its own interval and record a miss for this
                    // chordKey while we're waiting on the scorer.
                    // (checkMisses always books the <t>_chord key
                    // first and short-circuits per-string for chord
                    // groups, so only the chord-level key needs
                    // checking here.) Without this guard a late-
                    // arriving hit would double-count against a miss
                    // already booked for the same chord timing.
                    // Bail out of the whole matchNotes() pass — not
                    // just this group — when the instance was disabled
                    // or session-bumped mid-await (settings change /
                    // device restart), so we don't fire more
                    // scoreChord IPCs for subsequent groups against
                    // an invalid session. Per-chord doublebook just
                    // skips this group; later groups are still valid.
                    if (!enabled || gen !== sessionGen) return;
                    if (noteResults.has(chordKey)) continue;
                } else if (!usingDesktopBridge) {
                    // Browser path needs the just-analysed buffer.
                    // Skip if no audio buffer was passed in (e.g.
                    // instance restart while a stale processFrame is
                    // unwinding).
                    if (!frameBuffer) continue;
                    const sr = audioCtx ? audioCtx.sampleRate : bridgeSampleRate;
                    chordResult = _ndScoreChord(
                        frameBuffer, sr,
                        group, currentArrangement, currentStringCount,
                        tuningOffsets, capo,
                        centsTolerance,   // pitch check per string
                        chordHitRatio     // min fraction of strings required
                    );
                }

                // Update HUD chord display (latest reading, hit-or-miss)
                lastChordScore = chordResult.score;
                lastChordHit = chordResult.hitStrings;
                lastChordTotal = chordResult.totalStrings;
                lastChordTime = group[0].t;

                const lead = group[0];
                const expectedMidi = _ndMidiFromStringFret(
                    lead.s, lead.f, currentArrangement, currentStringCount, tuningOffsets, capo
                );
                // Chord-level late-grace must come from the MAX sus
                // across constituents — not just `lead.sus` — so that
                // _ndMakeJudgment's timing classification matches the
                // candidate-inclusion and retire-extension grace logic
                // in matchNotes/checkMisses. Capped at MAX_SUS_LATE_GRACE
                // (mirrors matchNotes; see the constant below).
                let chordSusForGrace = 0;
                for (const cn of group) {
                    if (Number.isFinite(cn.sus) && cn.sus > chordSusForGrace) chordSusForGrace = cn.sus;
                }
                const chordLateGraceMs = chordSusForGrace > 0
                    ? Math.min(chordSusForGrace * 1000, 1000)
                    : 0;
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
                // Onset gate (desktop ML bridge): a chord only commits a hit
                // on a poll where one of its pitches was actually struck — a
                // fresh onset in bridgeNewOnsets. Otherwise the chord's
                // pitches ringing on through the surrounding riff drag the
                // match progressively earlier. chordFreshOnsetAge is the
                // freshest such onset (ms), used to back-date the judgment.
                let chordFreshOnsetAge = null;
                if (bridgeOnsetPrimed && bridgeNewOnsets.size > 0) {
                    for (const cn of group) {
                        const m = _ndMidiFromStringFret(
                            cn.s, cn.f, currentArrangement, currentStringCount,
                            tuningOffsets, capo
                        );
                        const o = bridgeNewOnsets.get(m);
                        if (o && (chordFreshOnsetAge === null || o.ageMs < chordFreshOnsetAge)) {
                            chordFreshOnsetAge = o.ageMs;
                        }
                    }
                }
                const tChord = (chordFreshOnsetAge != null)
                    ? hw.getTime() + avOffsetSec - (chordFreshOnsetAge / 1000)
                    : t;

                const chordJudgment = makeMatchedJudgment(
                    lead, lead.t, tChord, expectedMidi,
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
                        lateGraceMs: chordLateGraceMs,
                    }
                );

                // Commit a chord hit only when it scored AND (on the ML
                // bridge) a chord pitch was freshly struck this poll. An
                // isHit frame with no fresh onset is just the chord's pitches
                // still ringing — cache its diagnostics and wait for the
                // strum poll (or checkMisses' voicing rescue).
                if (!chordResult.isHit
                    || (bridgeOnsetPrimed && chordFreshOnsetAge == null)) {
                    // Stash the chordResult before bailing so that when
                    // checkMisses() retires this chord as a miss, the
                    // miss judgment can carry the scorer's per-string
                    // diagnostic data (hitStrings / totalStrings / score).
                    // Without this we were blind on missed chords — the
                    // live JSONL + diagnostic event log just showed
                    // hs/tt/sc=undefined, which made "the scorer saw 2 of
                    // 5 strings — was that just the user's playing, or is
                    // the energy threshold too strict?" impossible to
                    // answer from data alone. The map is keyed by chord
                    // key and the snapshot lands the BEST-SCORE frame
                    // seen during the chord's match window (see the
                    // `useNewSnapshot` predicate below) — gives the
                    // reader "best the scorer got at any point in the
                    // window" rather than an arbitrary final frame which
                    // may be tail-end decay.
                    // Cache for checkMisses to consume on retire.
                    //
                    // Two pieces tracked separately:
                    //
                    //   • voicingHit — STICKY. Once ANY frame in this
                    //     chord's window registered as voicing-eligible
                    //     (≥2 chord strings rang at their expected
                    //     pitches), remember it forever for this chord.
                    //     A subsequent frame where some of those strings
                    //     momentarily failed pitch (decay below threshold
                    //     while the rest still rang, audio bleed shifted
                    //     things, etc.) MUST NOT retroactively cancel a
                    //     previously-eligible voicing. Earlier logic
                    //     here had a "higher score wins" rule that
                    //     accidentally demoted voicingHit:true frames
                    //     when a later !voicingHit but slightly higher
                    //     score frame arrived — which on real-song
                    //     data wiped out the rescue path entirely.
                    //
                    //   • score / hitStrings / totalStrings — best
                    //     frame's diagnostic snapshot, regardless of
                    //     voicingHit. Used by the live JSONL and the
                    //     event log so a reader can see "best the
                    //     scorer got" on this chord.
                    const prev = _chordLastResult.get(chordKey);
                    const voicingEver = !!((prev && prev.voicingHit) || chordResult.voicingHit);
                    const useNewSnapshot = !prev || chordResult.score > (prev.score || 0);
                    // Capture the frame time of the FIRST voicing-eligible
                    // frame for this chord. checkMisses uses this as the
                    // judgment's `judgedAt` so the resulting timingError
                    // reflects when voicing was actually satisfied — not
                    // the retire-tick time (which is by definition past
                    // the chord's match window and would classify the
                    // rescued judgment as LATE, defeating the rescue).
                    const voicingT = (prev && prev.voicingT)
                        ? prev.voicingT
                        : (chordResult.voicingHit ? t : null);
                    _chordLastResult.set(chordKey, {
                        score:        useNewSnapshot ? chordResult.score        : prev.score,
                        hitStrings:   useNewSnapshot ? chordResult.hitStrings   : prev.hitStrings,
                        totalStrings: useNewSnapshot ? chordResult.totalStrings : prev.totalStrings,
                        voicingHit:   voicingEver,
                        voicingT,
                    });
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
                // Hit path doesn't need any cached miss-diagnostic for
                // this chord — drop the entry so the map only holds
                // truly-pending chords. Without this, the cache could
                // grow over a session as chords flicker through the
                // "scored low, then scored above threshold" pattern.
                _chordLastResult.delete(chordKey);
                // Build an (s,f)-keyed lookup so we don't rely on
                // `chordResult.results[i]` being positionally aligned
                // with `group[i]`. The browser `_ndScoreChord`
                // preserves that ordering by construction, and the
                // native ChordScorer does too — but treating the
                // result as a positional-only array makes
                // per-string gem colouring silently wrong if any
                // future IPC implementation reorders entries. The
                // lookup is O(N) per chord (N ≤ 8), so the
                // defensiveness is essentially free.
                const stringResByKey = new Map();
                if (Array.isArray(chordResult.results)) {
                    for (const r of chordResult.results) {
                        if (r && typeof r.s === 'number' && typeof r.f === 'number') {
                            stringResByKey.set(`${r.s}_${r.f}`, r);
                        }
                    }
                }
                for (let i = 0; i < group.length; i++) {
                    const cn = group[i];
                    const key = noteKey(cn, cn.t);
                    if (noteResults.has(key)) continue;
                    if (!chordJudgment.hit) {
                        // Chord passed energy/ratio threshold but missed the clean-hit
                        // threshold. Use makeMissJudgment so each per-string entry is
                        // internally consistent (no post-mutation of hit after _ndMakeJudgment
                        // has already computed it from timingState/pitchState).
                        const stringExpectedMidi = _ndMidiFromStringFret(
                            cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                        );
                        // Per-string constituent stays as a single-note
                        // judgment (no chord:true flag): _ndMakeJudgment
                        // treats `chord: true` as timing-only for the
                        // hit calc, which would flip per-string SHARP /
                        // FLAT pitch misses into spurious hits. The
                        // chord-level judgment (which owns the wider
                        // timing window) is already recorded separately
                        // above — this entry only feeds per-string
                        // diagnostics, where pitch correctness matters.
                        const stringMiss = makeMissJudgment(cn, cn.t, t, stringExpectedMidi);
                        noteResults.set(key, stringMiss);
                        _recordPerStringForChord(stringMiss);
                        continue;
                    }
                    const stringRes = stringResByKey.get(`${cn.s}_${cn.f}`);
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
                    _recordPerStringForChord(stringJudgment);
                }
            }
        }
    }

    function checkMisses() {
        if (!enabled) return;
        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const t = hw.getTime() + avOffsetSec - latencyOffset;
        const tolerance = timingTolerance;
        const missDeadline = t - tolerance * 2;
        // Mirror matchNotes' sus-late-grace policy. Without this, a sus
        // note whose match window matchNotes is willing to extend gets
        // retired here as a miss before that extended window has even
        // closed — matchNotes never gets a chance to record the late
        // hit. Cap matches matchNotes (kept loosely in sync via the
        // same constant pattern so both paths shift together).
        const MAX_SUS_LATE_GRACE = 1.0;
        const notes = hw.getNotes();
        const chords = hw.getChords();

        // Pass the full chart-note object (not just {s, f}) so the miss
        // judgment carries `sus` and technique flags through to the
        // diagnostic event log. Stripping to {s, f} here made every pure
        // miss look like a staccato note (sus=0) regardless of whether
        // the chart said it was sustained, which corrupts any
        // sus-conditioned analysis downstream.
        const checkNote = (chartNote, noteTime) => {
            const susSec = Number.isFinite(chartNote.sus) && chartNote.sus > 0 ? chartNote.sus : 0;
            const lateGrace = susSec > 0 ? Math.min(susSec, MAX_SUS_LATE_GRACE) : 0;
            // Effective retire threshold: a sus note isn't retired
            // until its sustain envelope has clearly elapsed, giving
            // matchNotes the same grace period to lock on.
            if (noteTime > missDeadline - lateGrace) return;
            const key = noteKey(chartNote, noteTime);
            if (!noteResults.has(key)) {
                const expectedMidi = _ndMidiFromStringFret(
                    chartNote.s, chartNote.f, currentArrangement, currentStringCount, tuningOffsets, capo
                );
                recordJudgment(
                    key,
                    makeMissJudgment(chartNote, noteTime, t, expectedMidi)
                );
            }
        };

        // Look back far enough that sus-marked notes whose grace just
        // expired are still visited by this scan. Without this, the
        // bsearch start moves forward each tick and overruns notes that
        // were intentionally held past their normal retire window — they
        // never get retired at all. The `+ 1` is the existing lookback
        // slack; `MAX_SUS_LATE_GRACE` is the per-note extension we added.
        const scanStartT = missDeadline - 1 - MAX_SUS_LATE_GRACE;
        if (notes && notes.length > 0) {
            const start = bsearch(notes, scanStartT);
            for (let i = start; i < notes.length; i++) {
                const n = notes[i];
                if (n.t > missDeadline) break;
                if (n.mt) continue;
                checkNote(n, n.t);
            }
        }
        if (chords && chords.length > 0) {
            const start = bsearch(chords, scanStartT);
            for (let i = start; i < chords.length; i++) {
                const c = chords[i];
                if (c.t > missDeadline) break;
                const liveNotes = (c.notes || []).filter(cn => !cn.mt);
                if (liveNotes.length === 0) continue;
                if (liveNotes.length === 1) {
                    // Degenerate "chord" of one — treat as a single note.
                    checkNote(liveNotes[0], c.t);
                    continue;
                }
                // Mirror the matchNotes-side chord candidate grace: a
                // chord with sus-marked constituents isn't retired until
                // its sustain envelope has clearly elapsed, so a late
                // strummer gets the same window to score that a single-
                // note late-detect-gets-credited late-player gets. Take
                // the max sus across constituents.
                let chordSus = 0;
                for (const cn of liveNotes) {
                    if (Number.isFinite(cn.sus) && cn.sus > chordSus) chordSus = cn.sus;
                }
                const chordLateGrace = chordSus > 0 ? Math.min(chordSus, MAX_SUS_LATE_GRACE) : 0;
                // Mirror the seconds-vs-milliseconds split: _ndMakeJudgment
                // wants late-grace in ms, but the retire-window comparisons
                // above use seconds.
                const chordLateGraceMs = chordLateGrace * 1000;
                if (c.t > missDeadline - chordLateGrace) continue;
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
                // Pull the latest chord-scorer result (if any) so the
                // miss judgment carries hs/tt/sc. matchNotes stashes
                // this on every non-hit frame; the most recent stash
                // is "what the scorer last saw on this chord". If the
                // chord scorer never fired in window (no audio buffer,
                // monophonic detection failure path, etc.) the cache
                // is empty and we fall back to undefined-as-before.
                const cachedChord = _chordLastResult.get(chordKey);
                // Voicing-reduction rescue: if matchNotes never found a
                // strict-ratio frame but the chord was voicing-eligible
                // at some point (≥2 chord strings rang at their expected
                // pitches), record this retire as a HIT instead of a miss.
                // This is the "punk-rock power-chord interpretation of a
                // full-chord chart" path — see _ndScoreChord for the
                // detailed rationale and the trade-off vs eager-commit
                // in matchNotes (which we explicitly avoid to keep
                // strict-ratio frames' timing winning when they exist).
                const voicingRescue = !!(cachedChord && cachedChord.voicingHit);
                // Pass the cached voicing-eligible frame time as the
                // judgment's `judgedAt`, not the current retire-tick
                // time. The retire tick fires AFTER the chord window
                // has closed by 2 × timingTolerance + lateGrace, so
                // using `t` here would produce a timingError of
                // hundreds of milliseconds, the timingState would be
                // LATE, and the chord-branch hit calc
                // (`matched && timingState === 'OK'`) would flip the
                // rescue back to a miss — defeating the entire path.
                // The cached voicingT is the actual moment voicing
                // was first satisfied, which is by definition inside
                // the chord's match window.
                const judgedAtForRescue = (voicingRescue && Number.isFinite(cachedChord.voicingT))
                    ? cachedChord.voicingT
                    : t;
                const chordJudgment = voicingRescue
                    ? makeMatchedJudgment(
                        liveNotes[0], c.t, judgedAtForRescue, expectedMidi,
                        null,    // no monophonic detection at retire time
                        0,       // no pitch confidence to claim
                        {
                            chord: true,
                            notes: liveNotes.map(cn => ({ s: cn.s, f: cn.f })),
                            hitStrings:   cachedChord.hitStrings,
                            totalStrings: cachedChord.totalStrings,
                            score:        cachedChord.score,
                            // No pitch error to report — voicing-reduction is
                            // an aggregate per-string verdict, not a monophonic
                            // pitch measurement. The pitchState ends up null,
                            // and _ndMakeJudgment's chord-branch hit calc
                            // (`matched && timingState === 'OK'`) lets it
                            // through.
                            pitchError: null,
                            lateGraceMs: chordLateGraceMs,
                        },
                    )
                    : makeMissJudgment(liveNotes[0], c.t, t, expectedMidi, {
                        notes: liveNotes.map(cn => ({ s: cn.s, f: cn.f })),
                        chord: true,
                        hitStrings:   cachedChord ? cachedChord.hitStrings   : undefined,
                        totalStrings: cachedChord ? cachedChord.totalStrings : undefined,
                        score:        cachedChord ? cachedChord.score        : undefined,
                        lateGraceMs: chordLateGraceMs,
                    });
                recordJudgment(chordKey, chordJudgment);
                // Free the cache entry — we've consumed it, no further
                // matchNotes frames will fire for this chord (it just
                // got finalized as a miss or voicing-rescue hit).
                _chordLastResult.delete(chordKey);
                for (const cn of liveNotes) {
                    const key = noteKey({ s: cn.s, f: cn.f }, c.t);
                    if (noteResults.has(key)) continue;
                    const stringMiss = makeMissJudgment(cn, c.t, t, _ndMidiFromStringFret(
                        cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                    ));
                    noteResults.set(key, stringMiss);
                    // Bin per-string only when the chord retired as a
                    // miss. On voicing-rescue (chord-level hit) no
                    // per-string outcomes were measured — we'd be
                    // forcing miss-by-default fallbacks into the
                    // per-string panel and overstating misses on
                    // strings that may have rung fine.
                    if (!voicingRescue) _recordPerStringForChord(stringMiss);
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
        // Bound panel height to available viewport space below `top-16`
        // (with a small bottom gap) and let the panel scroll internally.
        panel.className = 'nd-settings-panel fixed top-16 right-4 z-[150] bg-dark-700 border border-gray-600 rounded-xl p-4 w-80 max-h-[calc(100vh-4rem-1rem)] overflow-y-auto shadow-2xl text-sm';
        panel.style.pointerEvents = 'auto';
        panel.innerHTML = `
            <div class="flex justify-between items-center mb-3">
                <span class="text-gray-200 font-semibold">Note Detection Settings</span>
                <button class="nd-settings-close text-gray-500 hover:text-white">&times;</button>
            </div>

            ${tuningMode ? `
            <div class="nd-rec-block bg-dark-600/40 border border-gray-700 rounded-lg p-3 mb-3">
                <div class="flex justify-between items-center mb-2">
                    <span class="text-gray-200 text-xs font-semibold uppercase tracking-wider">Reference Recording</span>
                    <span class="nd-rec-state text-[10px] uppercase tracking-wider text-gray-500">idle</span>
                </div>
                <div class="nd-rec-info text-[11px] text-gray-400 leading-snug mb-2">Click Arm, then press Play on the song.</div>
                <div class="flex gap-1.5">
                    <button class="nd-rec-arm flex-1 bg-accent hover:bg-accent-light disabled:bg-dark-600 disabled:cursor-not-allowed disabled:text-gray-600 px-2 py-1.5 rounded text-xs font-semibold text-white transition">
                        Arm
                    </button>
                    <button class="nd-rec-arm-training flex-1 bg-purple-600 hover:bg-purple-500 disabled:bg-dark-600 disabled:cursor-not-allowed disabled:text-gray-600 px-2 py-1.5 rounded text-xs font-semibold text-white transition" title="Capture this take and upload it to the curated training dataset (WAV + detect-stream + manifest, zipped, sent to pCloud)">
                        Arm (training)
                    </button>
                    <button class="nd-rec-save px-3 py-1.5 bg-dark-500 hover:bg-dark-400 rounded text-xs text-gray-300 transition disabled:opacity-40 disabled:cursor-not-allowed" title="Save what's captured so far">
                        Save
                    </button>
                    <button class="nd-rec-discard px-3 py-1.5 bg-dark-500 hover:bg-dark-400 rounded text-xs text-gray-300 transition disabled:opacity-40 disabled:cursor-not-allowed" title="Throw out the in-flight buffer">
                        Discard
                    </button>
                </div>
                <div class="nd-rec-saved text-[10px] text-gray-500 mt-2 break-all"></div>
                <div class="nd-rec-upload text-[10px] mt-1 break-all"></div>
            </div>
            ` : ''}

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
            <select class="nd-method-select w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-3">
                <option value="yin" ${detectionMethod === 'yin' ? 'selected' : ''}>YIN (lightweight, clean signals)</option>
                <option value="hps" ${detectionMethod === 'hps' ? 'selected' : ''}>HPS (bass with weak fundamental, no model)</option>
                <option value="crepe" ${detectionMethod === 'crepe' ? 'selected' : ''}>CREPE/SPICE (robust, ~20MB model)</option>
            </select>

            <label class="block text-gray-400 text-xs mb-1">Audio Latency Offset: <span class="nd-latency-val">${Math.round(latencyOffset * 1000)}</span>ms</label>
            <input type="range" min="0" max="250" value="${Math.round(latencyOffset * 1000)}"
                   class="nd-latency-slider w-full accent-green-400 mb-2">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Compensates for USB/audio interface delay. Increase if notes register late.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Timing Tolerance: <span class="nd-timing-val">${Math.round(timingTolerance * 1000)}</span>ms</label>
            <input type="range" min="30" max="300" value="${Math.round(timingTolerance * 1000)}"
                   class="nd-timing-slider w-full accent-green-400 mb-2">
            <div class="text-[10px] text-gray-600 mb-2 leading-tight">
                Outer match window. Detections outside this range are ignored.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Pitch Tolerance: <span class="nd-pitch-val">${pitchTolerance}</span> cents</label>
            <input type="range" min="10" max="100" value="${pitchTolerance}"
                   class="nd-pitch-slider w-full accent-green-400 mb-2">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Outer pitch match window. Wider values correlate more attempts.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Clean Timing: <span class="nd-timing-hit-val">${Math.round(timingHitThreshold * 1000)}</span>ms</label>
            <input type="range" min="30" max="${Math.round(timingTolerance * 1000)}" value="${Math.round(timingHitThreshold * 1000)}"
                   class="nd-timing-hit-slider w-full accent-blue-400 mb-2">

            <label class="block text-gray-400 text-xs mb-1">Chord Timing Window: <span class="nd-chord-timing-val">${Math.round(chordTimingHitThreshold * 1000)}</span>ms</label>
            <input type="range" min="${Math.round(timingHitThreshold * 1000)}" max="${Math.round(timingTolerance * 1000)}" value="${Math.round(chordTimingHitThreshold * 1000)}"
                   class="nd-chord-timing-slider w-full accent-blue-400 mb-1">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Chord strums have more inherent timing jitter than single notes (multi-string strike spread + analysis-window smearing). Fast power-chord punk also anticipates the beat. Wider than Clean Timing; pinned >= it.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Clean Pitch: <span class="nd-pitch-hit-val">${pitchHitThreshold}</span> cents</label>
            <input type="range" min="5" max="${pitchTolerance}" value="${pitchHitThreshold}"
                   class="nd-pitch-hit-slider w-full accent-blue-400 mb-3">

            <label class="block text-gray-400 text-xs mb-1">Detection Confidence: <span class="nd-conf-val">${Math.round(detectionConfidenceMin * 100)}</span>%</label>
            <input type="range" min="5" max="50" value="${Math.round(detectionConfidenceMin * 100)}"
                   class="nd-conf-slider w-full accent-purple-400 mb-2">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Minimum confidence to accept a YIN/HPS/CREPE frame. Lower this if too many notes register as "pure miss" with no detection — at the cost of more false positives on quiet/noisy signals.
            </div>

            <label class="flex items-center gap-2 text-gray-400 text-xs mb-2">
                <input type="checkbox" class="nd-show-timing accent-green-400" ${showTimingErrors ? 'checked' : ''}>
                Show early/late labels
            </label>
            <label class="flex items-center gap-2 text-gray-400 text-xs mb-2">
                <input type="checkbox" class="nd-show-pitch accent-green-400" ${showPitchErrors ? 'checked' : ''}>
                Show sharp/flat labels
            </label>
            <label class="flex items-center gap-2 text-gray-400 text-xs mb-1">
                <input type="checkbox" class="nd-edge-flash accent-green-400" ${edgeFlashEnabled ? 'checked' : ''}>
                Screen-edge flash on hit/miss
            </label>
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Off by default — the highway now lights up the note itself on a hit. Turn on for the old full-screen green/red edge flash.
            </div>

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

            <div class="text-[10px] text-gray-600 mt-1 leading-tight">
                Tip: For multi-effects pedals with USB audio (e.g. Valeton GP-5), select <b>Left (Ch 1)</b> for the dry/DI signal — it gives the most accurate pitch detection.
                See the <b>Pitch Detection Methods</b> section of the plugin README for guidance on choosing between YIN, HPS, and CREPE.
            </div>
        `;

        instanceRoot.appendChild(panel);

        // Wire up controls
        panel.querySelector('.nd-settings-close').onclick = () => panel.remove();

        // Reference-recording controls — present only when tuningMode is
        // on (the .nd-rec-block element is conditional in the template
        // above). Status updates on a self-cancelling 1s interval so the
        // duration tick + "Saved to ..." path appear in real time while
        // the popover is open.
        const recBlock = panel.querySelector('.nd-rec-block');
        if (recBlock) {
            const armBtn  = recBlock.querySelector('.nd-rec-arm');
            const armTrnBtn = recBlock.querySelector('.nd-rec-arm-training');
            const saveBtn = recBlock.querySelector('.nd-rec-save');
            const discBtn = recBlock.querySelector('.nd-rec-discard');
            const stateEl = recBlock.querySelector('.nd-rec-state');
            const infoEl  = recBlock.querySelector('.nd-rec-info');
            const savedEl = recBlock.querySelector('.nd-rec-saved');
            const uploadEl = recBlock.querySelector('.nd-rec-upload');
            // Declared up-front (vs. `const` after setInterval below) so
            // the bail-out branch in renderRec can call clearInterval
            // even if it fires on the very first synchronous call before
            // the interval has been installed — e.g., when instanceRoot
            // isn't attached to document.body in some host/test context.
            // Without this, the early bail-out would hit the temporal
            // dead zone and ReferenceError-out instead of cleaning up.
            let tick = null;

            function renderRec() {
                if (!document.body.contains(panel)) { if (tick != null) clearInterval(tick); return; }
                const r = getRecordingState();
                const hasBuffer = r.samples > 0;
                const trainTag = r.armedForTraining ? ' (training)' : '';
                let label, info;
                if (r.saveInFlight) { label = 'saving…'; info = 'Encoding + uploading the WAV…'; }
                else if (r.trainingUploadInFlight) { label = 'uploading…'; info = 'Bundling WAV + detect-stream + manifest and shipping to pCloud…'; }
                else if (r.lastError) { label = 'error'; info = 'Last attempt failed: ' + r.lastError; }
                else if (r.armed && r.songPlaying) { label = 'recording' + trainTag; info = `Capturing… ${r.durationS.toFixed(1)} s (${r.samples} samples @ ${r.sampleRate} Hz). Auto-saves on song end${r.armedForTraining ? ' and uploads to the training dataset' : ''}.`; }
                else if (r.armed && !r.detectEnabled) { label = 'armed (Detect off)' + trainTag; info = 'Armed, but Detect isn\'t on — no audio is flowing.'; }
                else if (r.armed) { label = 'armed' + trainTag; info = 'Armed. Press Play to start capturing.'; }
                else if (hasBuffer) { label = 'paused'; info = `${r.durationS.toFixed(1)} s captured; Save to keep it or Discard to throw it out.`; }
                else if (r.lastSavePath) { label = 'idle'; info = 'Ready. Click Arm for the next take.'; }
                else { label = 'idle'; info = 'Click Arm, then press Play.'; }
                if (stateEl) stateEl.textContent = label;
                if (infoEl)  {
                    infoEl.textContent = info;
                    infoEl.className = 'nd-rec-info text-[11px] leading-snug mb-2 ' + (r.lastError ? 'text-red-400' : 'text-gray-400');
                }
                // Build the "<label> <code>filename</code>" line with
                // textContent, never innerHTML — the path / bundle name
                // can contain server-side filesystem strings (the retry
                // endpoint accepts any training_*.zip), so interpolating
                // them into innerHTML would be an injection surface.
                const _setCodeLine = (el, label, codeText) => {
                    el.textContent = label;
                    const c = document.createElement('code');
                    c.className = 'text-gray-300';
                    c.textContent = codeText;
                    el.appendChild(c);
                };
                if (savedEl) {
                    if (r.lastSavePath && !r.armed && !r.lastError) {
                        _setCodeLine(savedEl, 'Saved: ', r.lastSavePath);
                    } else {
                        savedEl.textContent = '';
                    }
                }
                if (uploadEl) {
                    const tr = r.trainingUploadResult;
                    if (tr && tr.ok) {
                        uploadEl.className = 'nd-rec-upload text-[10px] text-green-400 mt-1 break-all';
                        _setCodeLine(uploadEl, 'Uploaded to training dataset: ', tr.bundle_filename || '(unknown)');
                    } else if (tr && !tr.ok) {
                        uploadEl.className = 'nd-rec-upload text-[10px] text-red-400 mt-1 break-all';
                        uploadEl.textContent = 'Upload failed: ' + (tr.error || 'unknown error') + (tr.local_bundle ? ' (bundle retained at ' + tr.local_bundle + ')' : '');
                    } else {
                        uploadEl.textContent = '';
                    }
                }
                // Disable the alternate arm path while one is active or
                // an upload is in flight — switching modes mid-take would
                // leave _recArmedForTraining ambiguous.
                if (armBtn)  { armBtn.textContent = (r.armed && !r.armedForTraining) ? 'Disarm' : 'Arm'; armBtn.disabled = r.saveInFlight || r.trainingUploadInFlight || (r.armed && r.armedForTraining); }
                if (armTrnBtn) { armTrnBtn.textContent = (r.armed && r.armedForTraining) ? 'Disarm' : 'Arm (training)'; armTrnBtn.disabled = r.saveInFlight || r.trainingUploadInFlight || (r.armed && !r.armedForTraining); }
                // Save is disabled during a training arm — a training
                // take auto-saves + uploads on song:ended; a manual
                // mid-take save would only orphan _recArmedForTraining /
                // the live stream / the parallel capture.
                if (saveBtn) saveBtn.disabled = !hasBuffer || r.saveInFlight || r.trainingUploadInFlight || r.armedForTraining;
                if (discBtn) discBtn.disabled = !(r.armed || hasBuffer) || r.saveInFlight || r.trainingUploadInFlight;
            }
            if (armBtn) armBtn.onclick = () => {
                const r = getRecordingState();
                if (r.armed && !r.armedForTraining) disarmRecording();
                else if (!r.armed) armRecording();
                renderRec();
            };
            if (armTrnBtn) armTrnBtn.onclick = async () => {
                const r = getRecordingState();
                if (r.armed && r.armedForTraining) {
                    disarmRecording();
                } else if (!r.armed) {
                    // armRecordingForTraining awaits getUserMedia when
                    // the desktop bridge is active. Surface a permission /
                    // device failure through _recLastSaveError (rendered
                    // below) rather than as an uncaught promise rejection.
                    try { await armRecordingForTraining(); } catch (_) { /* lastSaveError set inside */ }
                }
                renderRec();
            };
            if (saveBtn) saveBtn.onclick = async () => {
                await saveRecordingNow();
                renderRec();
            };
            if (discBtn) discBtn.onclick = () => { discardRecording(); renderRec(); };
            renderRec();
            tick = setInterval(renderRec, 1000);
        }
        panel.querySelector('.nd-device-select').onchange = (e) => onDeviceChange(e.target.value);
        panel.querySelector('.nd-channel-select').onchange = (e) => onChannelChange(e.target.value);
        panel.querySelector('.nd-method-select').onchange = (e) => setMethod(e.target.value);
        panel.querySelector('.nd-latency-slider').oninput = (e) => {
            latencyOffset = e.target.value / 1000;
            panel.querySelector('.nd-latency-val').textContent = e.target.value;
            saveSettings();
        };
        panel.querySelector('.nd-timing-slider').oninput = (e) => {
            timingTolerance = e.target.value / 1000;
            timingHitThreshold = Math.min(timingHitThreshold, timingTolerance);
            chordTimingHitThreshold = Math.min(chordTimingHitThreshold, timingTolerance);
            if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
            panel.querySelector('.nd-timing-val').textContent = e.target.value;
            const hitSlider = panel.querySelector('.nd-timing-hit-slider');
            if (hitSlider) {
                hitSlider.max = e.target.value;
                hitSlider.value = Math.round(timingHitThreshold * 1000);
                panel.querySelector('.nd-timing-hit-val').textContent = hitSlider.value;
            }
            const chordSlider = panel.querySelector('.nd-chord-timing-slider');
            if (chordSlider) {
                chordSlider.max = e.target.value;
                chordSlider.min = Math.round(timingHitThreshold * 1000);
                chordSlider.value = Math.round(chordTimingHitThreshold * 1000);
                panel.querySelector('.nd-chord-timing-val').textContent = chordSlider.value;
            }
            saveSettings();
        };
        panel.querySelector('.nd-pitch-slider').oninput = (e) => {
            pitchTolerance = +e.target.value;
            pitchHitThreshold = Math.min(pitchHitThreshold, pitchTolerance);
            panel.querySelector('.nd-pitch-val').textContent = e.target.value;
            const hitSlider = panel.querySelector('.nd-pitch-hit-slider');
            if (hitSlider) {
                hitSlider.max = e.target.value;
                hitSlider.value = pitchHitThreshold;
                panel.querySelector('.nd-pitch-hit-val').textContent = hitSlider.value;
            }
            saveSettings();
        };
        panel.querySelector('.nd-timing-hit-slider').oninput = (e) => {
            timingHitThreshold = e.target.value / 1000;
            panel.querySelector('.nd-timing-hit-val').textContent = e.target.value;
            // Keep the chord-timing slider's lower bound + value in sync —
            // chord threshold can never be stricter than single-note.
            if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
            const chordSlider = panel.querySelector('.nd-chord-timing-slider');
            if (chordSlider) {
                chordSlider.min = e.target.value;
                chordSlider.value = Math.round(chordTimingHitThreshold * 1000);
                panel.querySelector('.nd-chord-timing-val').textContent = chordSlider.value;
            }
            saveSettings();
        };
        panel.querySelector('.nd-chord-timing-slider').oninput = (e) => {
            chordTimingHitThreshold = e.target.value / 1000;
            // Enforce the invariant on direct edits too — slider min should
            // already prevent inversion, but a stale DOM state during fast
            // drag can momentarily produce values below the current
            // single-note threshold. Clamp here to be safe.
            const clamped = chordTimingHitThreshold < timingHitThreshold;
            if (clamped) chordTimingHitThreshold = timingHitThreshold;
            // When we clamped up, the variable + persisted setting have
            // moved past the slider's current `value` — sync the slider's
            // value back to the clamped position so the thumb doesn't
            // sit below the actual setting.
            if (clamped) e.target.value = Math.round(chordTimingHitThreshold * 1000);
            panel.querySelector('.nd-chord-timing-val').textContent = Math.round(chordTimingHitThreshold * 1000);
            saveSettings();
        };
        panel.querySelector('.nd-pitch-hit-slider').oninput = (e) => {
            pitchHitThreshold = +e.target.value;
            panel.querySelector('.nd-pitch-hit-val').textContent = e.target.value;
            saveSettings();
        };
        panel.querySelector('.nd-conf-slider').oninput = (e) => {
            // Slider is in percent (5-50); state is the 0.05-0.50 fraction.
            detectionConfidenceMin = (+e.target.value) / 100;
            panel.querySelector('.nd-conf-val').textContent = e.target.value;
            saveSettings();
        };
        panel.querySelector('.nd-show-timing').onchange = (e) => {
            showTimingErrors = !!e.target.checked;
            saveSettings();
        };
        panel.querySelector('.nd-show-pitch').onchange = (e) => {
            showPitchErrors = !!e.target.checked;
            saveSettings();
        };
        panel.querySelector('.nd-edge-flash').onchange = (e) => {
            edgeFlashEnabled = !!e.target.checked;
            if (!edgeFlashEnabled) {
                // Clear any flash that's mid-fade so it doesn't linger.
                const fe = instanceRoot.querySelector('.nd-flash-overlay');
                if (fe) fe.style.borderColor = 'transparent';
            }
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
            saveSettings();
        };
        panel.querySelector('.nd-chord-ratio-slider').oninput = (e) => {
            chordHitRatio = e.target.value / 100;
            panel.querySelector('.nd-chord-ratio-val').textContent = e.target.value;
            saveSettings();
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
            <div class="nd-hud-detected text-[10px] text-cyan-400 mt-1 font-mono"></div>
            <div class="nd-drill mt-2 hidden text-right">
                <div class="nd-drill-header text-[10px] text-amber-300 font-mono"></div>
                <div class="nd-drill-list text-[10px] text-gray-500 font-mono leading-tight mt-0.5"></div>
            </div>
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

        // Bridge slopsmith's loop state into our drill flag once per
        // tick. Cheap (one getLoop read); avoids a separate poll.
        _drillSyncFromLoopState();
        _drillRender();

        const total = hits + misses;
        const accEl = instanceRoot.querySelector('.nd-hud-accuracy');
        const streakEl = instanceRoot.querySelector('.nd-hud-streak');
        const countsEl = instanceRoot.querySelector('.nd-hud-counts');
        const detectedEl = instanceRoot.querySelector('.nd-hud-detected');
        const flashEl = instanceRoot.querySelector('.nd-flash-overlay');

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
            if (detectedString >= 0 && detectedConfidence > detectionConfidenceMin) {
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
                // slopsmith#254 — off by default now that the highway
                // renderer lights the note itself; opt back in via the
                // "Screen-edge flash on hit/miss" toggle.
                if (!edgeFlashEnabled) return;
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
        if (!enabled) return;
        if (!hw.project || !hw.fretX) return;
        // This overlay positions everything with the 2D highway's
        // projection (hw.project / hw.fretX). A custom renderer (3D
        // highway, piano, …) draws its own scene with different
        // geometry — and fires our draw hook on its 2D overlay layer —
        // so these markers would land in meaningless places (the stray
        // red miss X's complaint, slopsmith#254). Bail when a non-default
        // renderer is active; that renderer owns the per-note feedback
        // (the 3D highway lights the note mesh on hit/active and red-
        // outlines + labels misses, via the bundle.getNoteState path).
        // Our HUD / screen-flash are DOM, not canvas, so they're
        // unaffected. Older cores without isDefaultRenderer → assume 2D.
        if (hw.isDefaultRenderer && !hw.isDefaultRenderer()) return;

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
                // slopsmith#254 — when *our* provider is the one driving
                // the gem lighting, the green overlay ring is redundant;
                // skip it. But if the core supports the hook yet some
                // other plugin owns the provider (we declined to stomp it
                // in ensureDrawHook), the gem isn't lit by us — fall
                // through to the ring so there's still on-highway hit
                // feedback. Older cores (no getter) also keep the ring.
                if (hw && hw.getNoteStateProvider && hw.getNoteStateProvider() === noteStateFor) return;
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

                const labels = [];
                if (showTimingErrors && judgment.timingState && judgment.timingState !== 'OK') {
                    labels.push({
                        color: '#ffb347',
                        text: `${judgment.timingState === 'EARLY' ? '↑' : '↓'} ${judgment.timingError > 0 ? '+' : ''}${judgment.timingError}ms`,
                    });
                }
                if (showPitchErrors && judgment.pitchState && judgment.pitchState !== 'OK') {
                    labels.push({
                        color: '#66c7ff',
                        text: `${judgment.pitchState === 'SHARP' ? '♯' : '♭'} ${judgment.pitchError > 0 ? '+' : ''}${judgment.pitchError}¢`,
                    });
                }
                if (labels.length > 0) {
                    ctx.font = `bold ${Math.max(10, 11 * scale)}px sans-serif`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    for (let i = 0; i < labels.length; i++) {
                        const yy = y + (i - (labels.length - 1) / 2) * 16 * scale - 18 * scale;
                        ctx.lineWidth = 3;
                        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
                        ctx.strokeText(labels[i].text, x, yy);
                        ctx.fillStyle = labels[i].color;
                        drawTextReadable(labels[i].text, x, yy);
                    }
                }
                ctx.restore();
            }
        };

        if (notes) {
            for (const n of notes) {
                if (n.t < renderT - missMarkerDuration - 0.2) continue;
                if (n.t > renderT + 3) break;
                if (n.mt) continue;
                const key = noteKey(n, n.t);
                const result = noteResults.get(key);
                if (result) drawIndicator(n.s, n.f, n.t, result);
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

        if (detectedString >= 0 && detectedConfidence > detectionConfidenceMin) {
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
    }

    // ── Reset / enable / disable / destroy ────────────────────────────
    function resetScoring() {
        hits = 0;
        misses = 0;
        streak = 0;
        bestStreak = 0;
        noteResults.clear();
        _susActiveUntil.clear();
        _chordLastResult.clear();
        _diagResetCounters();
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
    }

    // Narrower reset used by the A/V auto-calibrate Apply button.
    // Calling resetScoring() there blew away the user's hit/miss
    // counters + streak + section history + event log — surprising
    // for what's framed as a calibration tweak. This clears ONLY the
    // timing-error samples that feed the next calibration suggestion,
    // so the next median reflects the new offset but everything else
    // the user can see on Settings (accuracy, breakdown, per-section)
    // stays intact.
    function _resetCalibrationSamples() {
        _diagTimingErrors.length = 0;
        _diagTimingErrorsHits.length = 0;
    }

    // ── Drill mode (slopsmith loop:restart) ───────────────────────────
    function _drillCurrentLoop() {
        const fallback = { loopA: null, loopB: null };
        if (!window.slopsmith || typeof window.slopsmith.getLoop !== 'function') {
            return fallback;
        }
        // Guard the host call — a misbehaving slopsmith bus shouldn't
        // take down updateHUD / recordJudgment scoring with it.
        let result;
        try {
            result = window.slopsmith.getLoop();
        } catch (e) {
            return fallback;
        }
        // Require an actual object so destructuring `{ loopA, loopB }`
        // gets meaningful values. A truthy non-object (e.g. `true`,
        // `''`, `42`) would destructure to undefined and let
        // _drillSyncFromLoopState read a malformed shape — better to
        // return the inactive fallback so drill stays off.
        if (!result || typeof result !== 'object') return fallback;
        return result;
    }

    function _drillResetIteration(startT) {
        drillIterHits = 0;
        drillIterMisses = 0;
        drillIterStreak = 0;
        drillIterBestStreak = 0;
        // Reject NaN / Infinity — typeof===number is true for both and
        // they'd leak through into getDrillStats().current.startT and
        // poison any downstream arithmetic.
        drillIterStartT = Number.isFinite(startT) ? startT : null;
    }

    function _drillSnapshotIteration() {
        const total = drillIterHits + drillIterMisses;
        // Skip zero-judgment iterations so an idle loop wrap doesn't
        // pollute the scoreboard with empty rows.
        if (total === 0) return;
        const accuracy = Math.round((drillIterHits / total) * 100);
        // Iteration duration = loopB - loopA (the loop's length).
        // The wrap event's `detail.time` is loopA (the new
        // iteration's start), not the just-finished iteration's
        // endpoint — so we can't derive duration from event timing.
        // Using the cached active bounds is correct: the iteration
        // we're snapshotting played from loopA through loopB.
        const durationSec = (Number.isFinite(drillActiveLoopA) && Number.isFinite(drillActiveLoopB))
            ? Math.max(0, drillActiveLoopB - drillActiveLoopA)
            : null;
        drillIterations.push({
            idx: drillNextIdx++,
            hits: drillIterHits,
            misses: drillIterMisses,
            accuracy,
            bestStreak: drillIterBestStreak,
            durationSec,
            ts: Date.now(),
        });
        // Bound the array to the most recent N — long sessions
        // shouldn't grow memory unboundedly.
        if (drillIterations.length > DRILL_MAX_ITERATIONS) {
            drillIterations.splice(0, drillIterations.length - DRILL_MAX_ITERATIONS);
        }
        drillDirty = true;
    }

    function _drillOnLoopRestart(e) {
        const rawTime = (e && e.detail) ? e.detail.time : undefined;
        const wrapTime = Number.isFinite(rawTime) ? rawTime : null;
        // Snapshot the iteration that just ended (duration is derived
        // from the cached loop bounds, not the event payload — the
        // event's `time` is loopA, the new iteration's start).
        _drillSnapshotIteration();
        // Re-anchor at the new iteration's start (= loopA).
        _drillResetIteration(wrapTime);
    }

    function _drillOnSongChanged() {
        // New song = different passage; stale iterations don't apply.
        // Also drop drillEnabled so getDrillStats() doesn't report
        // active=true between this event and the next HUD sync (which
        // may not happen at all if detection is disabled).
        drillIterations = [];
        _drillResetIteration(null);
        drillActiveLoopA = null;
        drillActiveLoopB = null;
        drillNextIdx = 1;
        drillEnabled = false;
        drillDirty = true;
    }

    function _drillBindEvents() {
        if (drillSubscribed) return;
        // Require both .on and .off so we never bind handlers we
        // can't tear down later — a host with on-only would leak
        // listeners across destroy() / re-mount.
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        // Register all three first; only set drillSubscribed after the
        // .on calls succeed. If any throws mid-registration we tear
        // down what landed so a retry on the next call is clean.
        const onLoopRestart = _drillOnLoopRestart;
        const onSongChanged = _drillOnSongChanged;
        try {
            window.slopsmith.on('loop:restart', onLoopRestart);
            window.slopsmith.on('song:loaded', onSongChanged);
            window.slopsmith.on('song:ended', onSongChanged);
        } catch (e) {
            // Partial registration — unwind so we don't leak handlers.
            if (typeof window.slopsmith.off === 'function') {
                try { window.slopsmith.off('loop:restart', onLoopRestart); } catch (_) {}
                try { window.slopsmith.off('song:loaded', onSongChanged); } catch (_) {}
                try { window.slopsmith.off('song:ended', onSongChanged); } catch (_) {}
            }
            return;
        }
        drillOnLoopRestartFn = onLoopRestart;
        drillOnSongChangedFn = onSongChanged;
        drillSubscribed = true;
    }

    // ── Chart state sync ─────────────────────────────────────────────
    //
    // `currentArrangement` / `currentStringCount` / `tuningOffsets` /
    // `capo` are read on every match/miss frame to map (string, fret)
    // → MIDI. They live in the factory closure and used to be set ONLY
    // inside enable(), inline, with conditional assignments — each
    // field only updated if the corresponding `info.*` was present.
    //
    // That left a stale-state hole: if a previous song (e.g. a bass
    // arrangement) had set currentArrangement='bass', and a new song
    // loaded with `info.arrangement` briefly falsy / null at enable
    // time, the `if (info && info.arrangement)` line wouldn't fire
    // and the bass arrangement carried over into a guitar chart. The
    // smoking-gun symptom in real-session diagnostics: strings 4-5 of
    // a 6-string guitar chart show 0/N hits with `expectedMidi: null`
    // (because the 4-string bass MIDI base array has no entries at
    // [4] / [5]), and strings 0-3 score wildly off-pitch because
    // they're being compared against bass-octave MIDI values.
    //
    // Fixes here:
    //   1) Reset to a known-good 6-string-guitar default BEFORE
    //      reading info, so a partial / missing payload can't leave
    //      stale fields in place.
    //   2) Wire `song:loaded` + `arrangement:changed` listeners so
    //      mid-session song or arrangement switches re-sync state
    //      instead of waiting for the next enable() (which may never
    //      come if Detect was left on).
    function _syncChartStateFromHw() {
        currentArrangement = 'guitar';
        currentStringCount = 6;
        tuningOffsets = [0, 0, 0, 0, 0, 0];
        capo = 0;
        const info = (hw && hw.getSongInfo) ? hw.getSongInfo() : null;
        if (!info) return;
        if (info.arrangement) currentArrangement = _ndArrangementKindFromName(info.arrangement);
        if (Array.isArray(info.tuning)) tuningOffsets = info.tuning;
        if (Number.isFinite(info.capo)) capo = info.capo;

        // String-count resolution, in precedence order:
        //   1. hw.getStringCount() — host's authoritative count. Asked
        //      independently of info.tuning because the host may know
        //      the count even when no tuning array shipped, and because
        //      RS XML pads bass tunings to six entries so tuning.length
        //      alone can't distinguish bass-4 from a real 6-string.
        //   2. tuning.length when it's consistent with the arrangement
        //      — bass-4/5 or guitar-6/7/8. This preserves the older-host
        //      path for 7/8-string guitars and 5-string basses, while
        //      rejecting the RS-XML bass-padded-to-6 shape (which
        //      falls through to (3) below for the correct bass-4).
        //   3. Per-arrangement default — 4 for bass, 6 for guitar.
        //      Closes the regression a bass chart hit when it had no
        //      tuning array AND no host count: currentStringCount used
        //      to stay at 6, then _ndStandardMidiFor('bass', 6) returned
        //      the 4-entry _ND_TUNING_BASS_4 and strings 4/5 retired
        //      with expectedMidi: null.
        //   4. tuning.length — last-resort fallback when no arrangement
        //      is known.
        const hostStringCount = (hw && hw.getStringCount) ? hw.getStringCount() : undefined;
        if (Number.isFinite(hostStringCount)) {
            currentStringCount = hostStringCount;
        } else if (info.arrangement) {
            const tuneLen = Array.isArray(info.tuning) ? info.tuning.length : null;
            const consistent = currentArrangement === 'bass'
                ? (tuneLen === 4 || tuneLen === 5)
                : (tuneLen === 6 || tuneLen === 7 || tuneLen === 8);
            if (consistent) {
                currentStringCount = tuneLen;
            } else {
                currentStringCount = currentArrangement === 'bass' ? 4 : 6;
            }
        } else if (Array.isArray(info.tuning)) {
            currentStringCount = info.tuning.length;
        }
    }

    let _chartStateSubscribed = false;
    let _chartStateOnChange = null;
    function _chartStateBindEvents() {
        if (_chartStateSubscribed) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        const onChange = () => { _syncChartStateFromHw(); };
        try {
            window.slopsmith.on('song:loaded',          onChange);
            window.slopsmith.on('arrangement:changed',  onChange);
        } catch (e) {
            if (typeof window.slopsmith.off === 'function') {
                try { window.slopsmith.off('song:loaded',         onChange); } catch (_) {}
                try { window.slopsmith.off('arrangement:changed', onChange); } catch (_) {}
            }
            return;
        }
        _chartStateOnChange = onChange;
        _chartStateSubscribed = true;
    }
    function _chartStateUnbindEvents() {
        if (!_chartStateSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function' && _chartStateOnChange) {
            try { window.slopsmith.off('song:loaded',         _chartStateOnChange); } catch (_) {}
            try { window.slopsmith.off('arrangement:changed', _chartStateOnChange); } catch (_) {}
        }
        _chartStateOnChange = null;
        _chartStateSubscribed = false;
    }

    function _drillUnbindEvents() {
        if (!drillSubscribed) return;
        // destroy() calls this on teardown — a misbehaving host
        // throwing from .off() would otherwise crash destroy and
        // leave the instance partially torn down. Guard each call
        // independently so one bad listener doesn't block the rest.
        if (window.slopsmith && typeof window.slopsmith.off === 'function') {
            if (drillOnLoopRestartFn) {
                try { window.slopsmith.off('loop:restart', drillOnLoopRestartFn); } catch (e) {}
            }
            if (drillOnSongChangedFn) {
                try { window.slopsmith.off('song:loaded', drillOnSongChangedFn); } catch (e) {}
                try { window.slopsmith.off('song:ended', drillOnSongChangedFn); } catch (e) {}
            }
        }
        drillSubscribed = false;
        drillOnLoopRestartFn = null;
        drillOnSongChangedFn = null;
    }

    // End-of-song summary. Fire showSummary() when the audio reaches
    // its natural end with detection still on. The playSong wrapper
    // silent-disables on song-switch so this only runs for genuine
    // end-of-track 'ended' events (the wrapper's silent disable
    // happens via stopAudio() which doesn't emit song:ended). Default
    // singleton only — splitscreen panels each have their own
    // instance and a per-panel modal would be visually noisy.
    //
    // After surfacing the summary we silent-disable: detection has
    // nothing to listen to with the song stopped, and leaving it on
    // would mean a follow-up manual Detect-toggle-off pops a second
    // summary (showSummary publishes notedetect:session, so a duplicate
    // also doubles the journal event). The user re-enables for the
    // next track the same way they already do today — the playSong
    // wrapper silent-disables on song-switch regardless.
    function _endOfSongOnEnded() {
        if (!isDefault) return;
        if (!enabled) return;
        // showSummary() has its own `total < 5` guard, so a song that
        // ended before the user played anything meaningful is silently
        // skipped. When a training take is armed, _recOnEnded opens the
        // consent modal on this same event — so BUILD the summary now
        // (capturing this song's stats into the overlay DOM) but start
        // it hidden, and reveal it once the consent flow closes. Build-
        // now matters: a new song's playSong hook resets hits/misses, so
        // a deferred *re-render* would describe the wrong song.
        try {
            const built = showSummary(_recArmedForTraining ? { startHidden: true } : undefined);
            // Only mark deferred when an overlay was actually built and
            // hidden — a <5-judgment take builds nothing, so there'd be
            // nothing for _runDeferredSummary() to reveal.
            if (_recArmedForTraining && built) _summaryDeferred = true;
        } catch (e) {
            console.warn('[note_detect] end-of-song summary failed:', e && e.message ? e.message : e);
        }
        try { disable({ silent: true }); } catch (e) {}
    }

    // Reveal a summary overlay that was built hidden because a training
    // consent modal was occupying the screen. Idempotent — clears the
    // flag so it runs at most once per deferral.
    function _runDeferredSummary() {
        if (!_summaryDeferred) return;
        _summaryDeferred = false;
        if (!isDefault) return;
        const overlay = instanceRoot.querySelector('.nd-summary-overlay');
        if (overlay) overlay.style.display = '';
    }

    function _endOfSongBindEvents() {
        if (endOfSongSubscribed) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        const fn = _endOfSongOnEnded;
        try {
            window.slopsmith.on('song:ended', fn);
        } catch (e) {
            return;
        }
        endOfSongOnEndedFn = fn;
        endOfSongSubscribed = true;
    }

    function _endOfSongUnbindEvents() {
        if (!endOfSongSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function' && endOfSongOnEndedFn) {
            try { window.slopsmith.off('song:ended', endOfSongOnEndedFn); } catch (e) {}
        }
        endOfSongSubscribed = false;
        endOfSongOnEndedFn = null;
    }

    // Render the drill HUD panel — current iteration header (live
    // counter + accuracy) plus the last 5 completed iterations with
    // best/worst highlighting. Hides itself entirely when drill is
    // neither active nor has history. UI only; no state mutation.
    // Gated on drillDirty so we don't re-parse innerHTML on every
    // 33 ms HUD tick when nothing changed.
    function _drillRender() {
        if (!drillDirty) return;
        drillDirty = false;
        const panel = instanceRoot.querySelector('.nd-drill');
        if (!panel) return;
        // Hide entirely when neither active nor populated — keeps the
        // HUD compact in non-drill use.
        const hasHistory = drillIterations.length > 0;
        if (!drillEnabled && !hasHistory) {
            panel.classList.add('hidden');
            return;
        }
        panel.classList.remove('hidden');
        const headerEl = panel.querySelector('.nd-drill-header');
        const listEl = panel.querySelector('.nd-drill-list');
        if (headerEl) {
            if (drillEnabled) {
                const liveTotal = drillIterHits + drillIterMisses;
                const liveAcc = liveTotal > 0 ? Math.round((drillIterHits / liveTotal) * 100) : null;
                // Use the monotonic counter, NOT iterations.length + 1
                // — the array splices from the front at the truncation
                // cap, so `length + 1` would freeze at #51 forever.
                const num = drillNextIdx;
                headerEl.textContent = liveAcc !== null
                    ? `Drill #${num}: ${drillIterHits}/${liveTotal} (${liveAcc}%)`
                    : `Drill #${num}`;
            } else {
                // Drill stopped (loop cleared), but history is still
                // visible — label it so the user knows.
                headerEl.textContent = `Drill (last loop)`;
            }
        }
        if (listEl) {
            if (!hasHistory) {
                listEl.textContent = '';
            } else {
                // Show the last 5 iterations, oldest -> newest. Find
                // best/worst within the visible window for highlighting.
                const recent = drillIterations.slice(-5);
                let best = recent[0], worst = recent[0];
                for (const it of recent) {
                    if (it.accuracy > best.accuracy) best = it;
                    if (it.accuracy < worst.accuracy) worst = it;
                }
                const parts = recent.map((it) => {
                    const tag = it === best && recent.length > 1
                        ? ' <span style="color:#00ff88">★</span>'
                        : it === worst && recent.length > 1
                            ? ' <span style="color:#ff4444">·</span>'
                            : '';
                    return `#${it.idx} ${it.hits}/${it.hits + it.misses} ${it.accuracy}%${tag}`;
                });
                listEl.innerHTML = parts.join('<br>');
            }
        }
    }

    // Bridge slopsmith loop state into our drillEnabled flag and
    // detect mid-drill loop bounds changes (user picked a different
    // saved loop). Called from updateHUD every 33 ms and from
    // enable() once at activation. Cheap — one getLoop read + a
    // boolean compare.
    function _drillSyncFromLoopState() {
        const { loopA, loopB } = _drillCurrentLoop();
        // Require finite numbers, not just non-null. A malformed return
        // (e.g. {}, undefined fields) would otherwise activate drill
        // mode and start mutating per-iteration counters against bogus
        // bounds.
        const nowEnabled = Number.isFinite(loopA) && Number.isFinite(loopB);
        if (nowEnabled && !drillEnabled) {
            // Drill just (re)started. Treat re-activation after a
            // previously-cleared loop the same way as a mid-drill
            // bounds change: if the new bounds DIFFER from the last
            // active bounds (drillActiveLoopA/B kept across the
            // deactivation), the iteration history is from a
            // different passage and must be cleared. If they match
            // exactly, the user just reopened the same loop and the
            // history is comparable.
            const sameBounds = (loopA === drillActiveLoopA && loopB === drillActiveLoopB);
            if (!sameBounds) {
                drillIterations = [];
                drillNextIdx = 1;
            }
            drillActiveLoopA = loopA;
            drillActiveLoopB = loopB;
            // Anchor at loopA (the iteration's true start) rather
            // than hw.getTime(): the user might enable detection
            // mid-iteration, but the iteration we're starting to
            // track conceptually begins at A.
            _drillResetIteration(loopA);
            drillDirty = true;
        } else if (nowEnabled && drillEnabled) {
            // Loop bounds changed mid-drill — different passage.
            // Clear history so the iteration list isn't comparing
            // apples to oranges.
            if (loopA !== drillActiveLoopA || loopB !== drillActiveLoopB) {
                drillIterations = [];
                drillNextIdx = 1;
                drillActiveLoopA = loopA;
                drillActiveLoopB = loopB;
                _drillResetIteration(loopA);
                drillDirty = true;
            }
        } else if (!nowEnabled && drillEnabled) {
            // Loop cleared. Keep the iteration history visible for
            // the user to review; just stop counting.
            _drillResetIteration(null);
            drillDirty = true;
        }
        drillEnabled = nowEnabled;
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
        // Subscribe to slopsmith loop / song events for drill mode.
        // Idempotent — _drillBindEvents bails when already subscribed,
        // so re-enabling after a disable doesn't double-bind. Listeners
        // survive disable() (so re-enable resumes the same drill state)
        // and only get torn down by destroy().
        _drillBindEvents();
        // Subscribe to song:ended so a finished song with detection on
        // surfaces the end-of-song summary modal. Idempotent and
        // self-gated (handler bails when not enabled / not default).
        _endOfSongBindEvents();
        // Sync drill state once at enable so a user enabling detection
        // while a loop is already active starts counting iterations
        // from the very next judgment, not after the first HUD tick.
        _drillSyncFromLoopState();
        enabled = true;
        // Make sure the instanceRoot is in the DOM before HUD/summary
        // rendering kicks in — `createNoteDetector({container}).enable()`
        // without a prior `injectButton()` call would otherwise render
        // to a detached subtree.
        attachInstanceRoot();
        updateButton();

        _syncChartStateFromHw();
        _chartStateBindEvents();

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
                if (noteTime < t - 5) { noteResults.delete(key); _susActiveUntil.delete(key); }
            }
        }, 5000);

        if (detectionMethod === 'crepe') _ndLoadCrepe();
        return true;
    }

    // `disableOptions.silent: true` suppresses the end-of-song summary
    // modal. The playSong hook uses this when a new song loads so the
    // user doesn't see a summary pop every song switch; the original
    // pre-factory behaviour was to silently reset here. Parameter is
    // named distinctly from the factory's outer `opts` to avoid the
    // lexical shadow.
    function disable(disableOptions) {
        if (!enabled) return;
        enabled = false;
        // Invalidate any CREPE inference currently awaited in
        // processFrame — it captured the previous sessionGen and will
        // bail on mismatch rather than apply post-disable detections.
        sessionGen++;
        stopAudio();
        stopHUD();
        if (missCheckInterval) { clearInterval(missCheckInterval); missCheckInterval = null; }
        if (gcInterval) { clearInterval(gcInterval); gcInterval = null; }
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
        // Unbind slopsmith drill listeners so multiple createNoteDetector()
        // instances (splitscreen) don't accumulate handlers across mount/
        // unmount cycles. disable() leaves them alone (resumes drill state
        // on re-enable); destroy is the right teardown point.
        _drillUnbindEvents();
        _endOfSongUnbindEvents();
        _chartStateUnbindEvents();
        _recUnbindEvents();
        _liveUnbindEvents();
        // Discard any unsaved recording state — destroying the instance
        // shouldn't write a half-captured WAV (or fire off an upload).
        _recArmed = false;
        _recArmedForTraining = false;
        _recChunks = [];
        _recTotalSamples = 0;
        _recTrainingUploadResult = null;
        _stopParallelTrainingCapture();
        // Remove draw hook (may not exist on older highway versions;
        // swallow the error rather than crash on teardown).
        try { if (hw && hw.removeDrawHook) hw.removeDrawHook(drawHookFn); } catch (e) {}
        // Clear our note-state provider — but only when we can positively
        // verify it's still ours (don't stomp a provider some other plugin
        // registered later, and don't clear blindly if the core lacks the
        // getter to confirm ownership).
        try {
            if (hw && hw.setNoteStateProvider
                && typeof hw.getNoteStateProvider === 'function'
                && hw.getNoteStateProvider() === noteStateFor) {
                hw.setNoteStateProvider(null);
            }
        } catch (e) {}
        if (detectBtn) { detectBtn.remove(); detectBtn = null; }
        if (gearBtn) { gearBtn.remove(); gearBtn = null; }
        if (instanceRoot.parentNode) instanceRoot.remove();
        _ndInstances.delete(api);
    }

    async function toggle() {
        if (enabled) {
            disable();
            detectPreference = false;
            saveSettings();
        } else {
            await enable();
            detectPreference = true;
            saveSettings();
        }
    }

    // Builds a self-contained snapshot of the current session — counters,
    // miss-category breakdown, per-string hit rate, signed error
    // percentiles, the song/arrangement/tuning, the detector settings,
    // and a capped per-judgment event log. Schema is versioned so future
    // tooling can dispatch. `benchmark_hint` carries the song's title/
    // artist/arrangement triple verbatim so reports against the official
    // benchmark sloppak can be filtered without needing a strict match.
    function _buildDiagnosticPayload() {
        const currentHw = resolveHw();
        const info = (currentHw && currentHw.getSongInfo) ? currentHw.getSongInfo() : {};
        const total = hits + misses;
        const sumAcc = total > 0 ? +(hits / total).toFixed(3) : 0;
        const sAcc = (_diagSingles.hits + _diagSingles.misses) > 0
            ? +(_diagSingles.hits / (_diagSingles.hits + _diagSingles.misses)).toFixed(3) : 0;
        const cAcc = (_diagChords.hits + _diagChords.misses) > 0
            ? +(_diagChords.hits / (_diagChords.hits + _diagChords.misses)).toFixed(3) : 0;
        return {
            schema: 'note_detect.diagnostic.v1',
            timestamp: new Date().toISOString(),
            plugin_version: _ND_VERSION,
            // Which detector actually produced this session — captured by the
            // detection tick itself (see _diagDetector), so it stays correct
            // even when the diagnostic is exported after Detect is toggled
            // off. null only if detection never ran this session.
            detector: _diagDetector || {
                desktop_bridge: false, ml: false, path: 'none',
            },
            benchmark_hint: {
                title: info.title || null,
                artist: info.artist || null,
                arrangement: info.arrangement || null,
                arrangement_index: (info.arrangement_index != null) ? info.arrangement_index : null,
            },
            song: {
                tuning: info.tuning || null,
                capo: (info.capo != null) ? info.capo : 0,
                duration: (info.duration != null) ? info.duration : null,
                format: info.format || null,
            },
            settings: {
                method: detectionMethod,
                timing_tolerance_s: timingTolerance,
                timing_hit_threshold_s: timingHitThreshold,
                chord_timing_hit_threshold_s: chordTimingHitThreshold,
                pitch_tolerance_cents: pitchTolerance,
                pitch_hit_threshold_cents: pitchHitThreshold,
                chord_hit_ratio: chordHitRatio,
                detection_confidence_min: detectionConfidenceMin,
                latency_offset_s: latencyOffset,
                input_gain: inputGain,
                channel: selectedChannel,
            },
            summary: {
                hits, misses, total,
                accuracy: sumAcc,
                best_streak: bestStreak,
                singles: { hits: _diagSingles.hits, misses: _diagSingles.misses, accuracy: sAcc },
                chords:  { hits: _diagChords.hits,  misses: _diagChords.misses,  accuracy: cAcc },
            },
            miss_breakdown: { ..._diagBreakdown },
            per_string: _diagPerString.map((slot, s) => ({
                s,
                hits: slot.hits,
                misses: slot.misses,
                total: slot.hits + slot.misses,
                accuracy: (slot.hits + slot.misses) > 0
                    ? +(slot.hits / (slot.hits + slot.misses)).toFixed(3) : null,
            })),
            timing_error_ms: _diagDistribution(_diagTimingErrors),
            // Hit-only timing distribution — the responsive signal for
            // A/V auto-calibration. See _diagTimingErrorsHits comment.
            timing_error_ms_hits: _diagDistribution(_diagTimingErrorsHits),
            pitch_error_cents:    _diagDistribution(_diagPitchErrors),
            sections: sectionStats.map(s => ({
                name: s.name,
                hits: s.hits,
                misses: s.misses,
                accuracy: (s.hits + s.misses) > 0
                    ? +(s.hits / (s.hits + s.misses)).toFixed(3) : 0,
            })),
            events: _diagEvents,
        };
    }

    function _downloadDiagnostic() {
        try {
            const payload = _buildDiagnosticPayload();
            const json = JSON.stringify(payload, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const slug = (payload.benchmark_hint.title || 'song')
                .replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
            const ts = payload.timestamp.replace(/[:.]/g, '-').slice(0, 19);
            const a = document.createElement('a');
            a.href = url;
            a.download = `note_detect_diag_${slug}_${ts}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 500);
            return true;
        } catch (e) {
            console.warn('[note_detect] diagnostic download failed:', e);
            return false;
        }
    }

    // ── Reference-recording capture ───────────────────────────────────
    // Arms the next song-play to record the detector's input audio. On
    // song:ended, auto-saves a WAV to `static/note_detect_recordings/`
    // via the plugin's POST endpoint — that dir is bind-mounted in the
    // dev container, so the headless harness on the host can read the
    // same file back without a copy step. Detect must be enabled for
    // audio to actually flow; armed-without-Detect is a no-op.
    function armRecording() {
        _recArmed = true;
        _recArmedForTraining = false;
        _recChunks = [];
        _recTotalSamples = 0;
        _recLastSaveError = null;
        _recCappedAt = null;
        _recTrainingUploadResult = null;
        // Bind song-event listeners lazily so an idle plugin instance
        // doesn't sit on the slopsmith bus. Unbind in disarm / save /
        // destroy. Idempotent.
        _recBindEvents();
    }
    async function _startParallelTrainingCapture() {
        if (_trainingCapture) return;
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
            throw new Error('getUserMedia is not available in this context');
        }
        const constraints = { audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            // Request stereo so the channel-select below can pick the
            // user's instrument channel — same as the main capture path.
            channelCount: 2,
        }};
        if (selectedDeviceId) {
            constraints.audio.deviceId = { exact: selectedDeviceId };
        }
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (e) {
            throw new Error('mic permission denied or device unavailable: ' + (e && e.message || e));
        }
        // The getUserMedia await above can take seconds (permission
        // prompt, device open). If the take was disarmed or the song
        // ended meanwhile, bail and release the mic now — otherwise we'd
        // attach a live capture graph to a cancelled take and leave the
        // device open until some later teardown.
        if (!_recArmed || !_recArmedForTraining) {
            try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
            return;
        }
        // Build the context + graph inside a try: getUserMedia already
        // handed us a live stream, so if any node creation throws we
        // must stop that stream (and close a half-built context) here —
        // _trainingCapture isn't assigned yet, so _stopParallelTraining-
        // Capture() couldn't otherwise reach the open mic.
        let ctx = null;
        try {
            ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
            const source = ctx.createMediaStreamSource(stream);
            // ScriptProcessor is deprecated but matches the rest of the
            // plugin's audio paths (AudioWorklet would need a separate
            // worklet file shipped with the plugin). Power-of-two buffer
            // size in {256, 512, 1024, 2048, 4096, 8192, 16384}; 4096 is a
            // ~93ms cadence at 44.1kHz, plenty for capture (we're not doing
            // any latency-sensitive analysis in this path — that's the
            // engine's job).
            const processor = ctx.createScriptProcessor(4096, 1, 1);
            // Push to the same _recChunks as the legacy processFrame path
            // so saveRecordingNow() doesn't need to know which capture path
            // produced the buffer. Gating mirrors the legacy push at
            // line 2316: only push while armed AND the song is playing,
            // so we don't fill the buffer with silence pre-Play.
            processor.onaudioprocess = (e) => {
                if (!_recArmed || !_recSongPlaying) return;
                const input = e.inputBuffer.getChannelData(0);
                const maxSamples = Math.floor((32 * 1024 * 1024) / 4);
                if (_recTotalSamples >= maxSamples) {
                    if (!_recCappedAt) _recCappedAt = _recTotalSamples / (ctx.sampleRate || 44100);
                    return;
                }
                _recSampleRate = ctx.sampleRate || _recSampleRate;
                // slice() — the underlying buffer is reused next callback.
                const copy = input.slice();
                _recChunks.push(copy);
                _recTotalSamples += copy.length;
            };
            // Mirror the main capture graph (see ~line 1942): channel-select
            // + input gain ahead of the processor, so the training WAV is
            // the SAME signal the detector judged and matches the `channel`
            // / `input_gain` recorded in the manifest. Reading channel 0 of
            // the raw source instead would upload the wrong channel for a
            // right-channel-DI user and skip the user's input gain.
            const gain = ctx.createGain();
            gain.gain.value = inputGain;
            let splitter = null, merger = null;
            if (source.channelCount >= 2 && selectedChannel !== 'mono') {
                splitter = ctx.createChannelSplitter(2);
                merger = ctx.createChannelMerger(1);
                const chIdx = selectedChannel === 'left' ? 0 : 1;
                source.connect(splitter);
                splitter.connect(merger, chIdx, 0);
                merger.connect(gain);
            } else {
                source.connect(gain);
            }
            gain.connect(processor);
            // A ScriptProcessor only fires its onaudioprocess callback if
            // it's connected to the destination graph. Route through a
            // muted GainNode so the captured audio doesn't loop back to
            // speakers (would be a feedback hazard with the JUCE engine
            // also driving output).
            const mute = ctx.createGain();
            mute.gain.value = 0;
            processor.connect(mute);
            mute.connect(ctx.destination);
            _trainingCapture = { stream, ctx, source, splitter, merger, gain, processor, mute };
        } catch (e) {
            try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
            try { if (ctx) ctx.close(); } catch (_) {}
            throw new Error('training capture graph setup failed: ' + (e && e.message || e));
        }
    }
    function _stopParallelTrainingCapture() {
        if (!_trainingCapture) return;
        const cap = _trainingCapture;
        _trainingCapture = null;
        try { cap.source.disconnect(); } catch (_) {}
        try { if (cap.splitter) cap.splitter.disconnect(); } catch (_) {}
        try { if (cap.merger) cap.merger.disconnect(); } catch (_) {}
        try { if (cap.gain) cap.gain.disconnect(); } catch (_) {}
        try { cap.processor.disconnect(); } catch (_) {}
        try { cap.mute.disconnect(); } catch (_) {}
        try { cap.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
        try { cap.ctx.close(); } catch (_) {}
    }
    async function armRecordingForTraining() {
        // Same capture-buffer state reset as armRecording, plus a flag
        // that triggers the bundle-and-upload step on song:ended. Also
        // force-binds the live-judgment stream regardless of tuningMode
        // (the training bundle needs both the WAV and the JSONL).
        _recArmed = true;
        _recArmedForTraining = true;
        _recChunks = [];
        _recTotalSamples = 0;
        _recLastSaveError = null;
        _recCappedAt = null;
        _recTrainingUploadResult = null;
        // Clear the carried-over session id so _recOnEnded's
        // `_liveSessionId || _liveLastSessionId` fallback can only ever
        // resolve to a session minted DURING this take — never a stale
        // one from a previous take. If this take mints no session at
        // all, the bundle simply ships without a JSONL (soft-skip).
        _liveLastSessionId = null;
        _recBindEvents();
        _liveBindEvents();
        // If the user armed AFTER pressing Play, song:play has already
        // fired and won't fire again: _recSongPlaying never flipped true
        // (so the capture gate at processFrame / _startParallelTraining-
        // Capture would stay idle) and _liveOnPlay never minted a live
        // session (so the JSONL take would carry no session_start
        // header). Detect *active playback* here and replay both effects.
        // A nonzero playhead alone is not enough — a paused or seeked
        // song also has one — so sample the renderer clock twice: only
        // real playback advances it. A genuinely paused song is left
        // alone; its song:play will drive both effects when it resumes.
        const _t1 = (hw && hw.getTime) ? hw.getTime() : 0;
        await new Promise((r) => setTimeout(r, 150));
        // The await above is a yield point — if the user disarmed during
        // it, bail rather than minting a session / flipping capture
        // state for a take that no longer exists.
        if (!_recArmed || !_recArmedForTraining) return;
        const _t2 = (hw && hw.getTime) ? hw.getTime() : 0;
        if (_t2 > _t1 + 0.02) {
            _recSongPlaying = true;
            // Mint a FRESH session unconditionally — even if tuning mode
            // already had one running. That older session started at
            // song:play and holds pre-arm judgments; reusing it would
            // misalign the detect-stream with a WAV that starts at arm
            // time. A fresh session begins here, aligned with the take.
            _startLiveSession();
        }
        // When the desktop bridge is active, the JS-side processFrame()
        // never runs (native engine owns the device), so its
        // _recChunks.push() at line ~2316 never fires and the WAV
        // would always be empty. Open a parallel getUserMedia chain
        // dedicated to capture — orthogonal to whatever the bridge is
        // doing for detection. In non-bridge mode the legacy
        // processFrame path is already pushing, so a parallel capture
        // would double-push; skip it.
        if (usingDesktopBridge) {
            try {
                await _startParallelTrainingCapture();
            } catch (e) {
                // Roll back the arm so the user isn't left thinking a
                // take is being recorded when it isn't.
                _recArmed = false;
                _recArmedForTraining = false;
                _recLastSaveError = String(e && e.message || e);
                _recUnbindEvents();
                if (!tuningMode) _liveUnbindEvents();
                console.warn('[note_detect] arm-for-training getUserMedia failed:', e);
                throw e;
            }
        }
    }
    function disarmRecording() {
        // Soft stop: turn capture off but keep the buffer so the user
        // can still Save (or Discard) what they captured. Clearing the
        // buffer here would silently throw away the user's take, which
        // is what they were complaining about. Use discardRecording()
        // when you actually want to wipe.
        _recArmed = false;
        _recArmedForTraining = false;
        _recUnbindEvents();
        // Drop the live stream subscription too, unless tuningMode is
        // independently keeping it on. Mirrors the gate in setTuningMode.
        if (!tuningMode) _liveUnbindEvents();
        // Release the mic. If the user disarmed mid-take the captured
        // buffer is retained for a manual Save.
        _stopParallelTrainingCapture();
    }
    function discardRecording() {
        _recArmed = false;
        _recArmedForTraining = false;
        _recChunks = [];
        _recTotalSamples = 0;
        _recLastSaveError = null;
        _recCappedAt = null;
        _recTrainingUploadResult = null;
        _recUnbindEvents();
        if (!tuningMode) _liveUnbindEvents();
        _stopParallelTrainingCapture();
    }
    async function saveRecordingNow() {
        if (_recSaveInFlight) return null;
        if (_recChunks.length === 0) {
            _recLastSaveError = 'no audio captured (Detect off, or song never played)';
            return null;
        }
        // Snapshot the buffer (alias, not copy) and disarm so any
        // song:ended fired mid-upload doesn't re-enter this path. We
        // intentionally DO NOT clear _recChunks here — if the POST
        // fails the user keeps their take and can retry via the Save
        // button. Earlier behaviour cleared synchronously, which meant
        // a network error or 413 from the server-side cap silently
        // destroyed a recorded session with no way to recover.
        const chunks = _recChunks;
        const sr = _recSampleRate;
        _recArmed = false;
        _recSaveInFlight = true;
        try {
            const wav = _ndEncodeWavPcm16(chunks, sr);
            const info = (hw && hw.getSongInfo) ? hw.getSongInfo() : {};
            const slug = ((info.title || 'recording') + '')
                .replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || 'recording';
            const resp = await fetch(
                '/api/plugins/note_detect/recording?slug=' + encodeURIComponent(slug),
                { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav }
            );
            if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()).slice(0, 200));
            const data = await resp.json();
            _recLastSavePath = data && data.relative_path || null;
            _recLastSaveError = null;
            // SUCCESS — only NOW clear the buffer, so a failed upload
            // doesn't lose the user's audio. _recCappedAt also resets
            // since the take that was capped has shipped.
            _recChunks = [];
            _recTotalSamples = 0;
            _recCappedAt = null;
            return data;
        } catch (e) {
            _recLastSaveError = String(e && e.message || e);
            console.warn('[note_detect] saveRecording failed:', e);
            // Buffer intentionally left in _recChunks so the user can
            // retry via the Save button after fixing the underlying
            // issue (server restart, larger cap, etc.).
            return null;
        } finally {
            _recSaveInFlight = false;
            // Done with this take — release the song-event listeners.
            _recUnbindEvents();
        }
    }
    function getRecordingState() {
        // Use the cached running total instead of reducing the array —
        // the UI's auto-refresh poll calls this every 1500 ms, and on a
        // long take the reduce was O(n) per call. The cache is
        // maintained in lockstep with `_recChunks` (incremented on
        // push, zeroed on arm/discard/successful-save/destroy).
        const samples = _recTotalSamples;
        return {
            armed:        _recArmed,
            armedForTraining: _recArmedForTraining,
            songPlaying:  _recSongPlaying,
            chunks:       _recChunks.length,
            samples,
            sampleRate:   _recSampleRate,
            durationS:    samples / Math.max(1, _recSampleRate),
            saveInFlight: _recSaveInFlight,
            lastSavePath: _recLastSavePath,
            lastError:    _recLastSaveError,
            // null = no cap hit; otherwise the second-mark where the client-
            // side 32 MB cap kicked in. UI can surface "your take was
            // truncated at X s".
            cappedAtS:    _recCappedAt,
            // Recording requires the audio pipeline to be live — surface
            // it here so the UI can prompt the user to enable Detect.
            detectEnabled: enabled,
            // Training-bundle upload status. inFlight while the bundle
            // POST is round-tripping; result is the last server response
            // ({ok:true, bundle_filename, pcloud_result, ...} or
            // {ok:false, error, local_bundle, ...}). Null between
            // takes — the UI shows nothing in that state.
            trainingUploadInFlight: _recTrainingUploadInFlight,
            trainingUploadResult:   _recTrainingUploadResult,
        };
    }
    // Contributor + per-instrument prefs persisted in localStorage so
    // the upload dialog auto-fills on subsequent takes. Song-specific
    // fields (title, cdlc filename, tuning) always come from songInfo,
    // so they're NOT persisted — last song's title would be wrong for
    // the next.
    const _TRAINING_PREFS_KEY = 'nd_training_prefs_v1';
    function _loadTrainingPrefs() {
        try {
            const raw = localStorage.getItem(_TRAINING_PREFS_KEY);
            if (!raw) return { name: '', discord: '', instrument: '', notes: '' };
            const p = JSON.parse(raw) || {};
            return {
                name:       typeof p.name       === 'string' ? p.name       : '',
                discord:    typeof p.discord    === 'string' ? p.discord    : '',
                instrument: typeof p.instrument === 'string' ? p.instrument : '',
                notes:      typeof p.notes      === 'string' ? p.notes      : '',
            };
        } catch (_) {
            return { name: '', discord: '', instrument: '', notes: '' };
        }
    }
    function _saveTrainingPrefs(prefs) {
        try {
            localStorage.setItem(_TRAINING_PREFS_KEY, JSON.stringify({
                name:       prefs.name       || '',
                discord:    prefs.discord    || '',
                instrument: prefs.instrument || '',
                notes:      prefs.notes      || '',
            }));
        } catch (_) { /* ignore quota / privacy mode */ }
    }
    // Modal that gates the upload — surfaces auto-detected song fields
    // for review/edit, captures contributor metadata, and requires an
    // explicit consent checkbox before enabling Upload. Stays open
    // during the upload itself so the user sees an inline progress +
    // success / failure status instead of guessing whether the bundle
    // made it. The `doUpload(formData) → Promise<result>` callback is
    // invoked on submit; the modal flips into "uploading" mode while
    // the promise is pending and then shows a result panel with a
    // Close button. Resolves with the final result (or null on cancel)
    // once the user dismisses the modal. Single-shot: no second
    // instance can mount concurrently.
    let _trainingModalActive = false;
    // doUpload(formData) bundles + uploads a fresh take; doRetry(localBundle)
    // re-uploads an already-bundled zip (shown as a Retry button when the
    // first upload fails). doRetry is optional — omit it to disable retry.
    function _showTrainingConsentModal(prefill, doUpload, doRetry) {
        if (_trainingModalActive) return Promise.resolve(null);
        _trainingModalActive = true;
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'nd-train-modal fixed inset-0 z-[99999] flex items-center justify-center bg-black/70 p-4 overflow-y-auto';
            // Dialog semantics so screen readers announce the modal and
            // treat background content as inert. aria-labelledby points
            // at the <h3> title id set below.
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.setAttribute('aria-labelledby', 'nd-tr-title');
            // Restore focus to whatever was focused before the modal
            // opened, once it closes.
            const _prevFocus = document.activeElement;
            // Plain-text inputs only — no HTML interpolation of user-
            // controllable strings to avoid an XSS surface from
            // chart-provided song info or localStorage tampering.
            modal.innerHTML = `
                <div class="bg-dark-700 border border-gray-600 rounded-lg max-w-md w-full p-5 shadow-2xl my-4">
                    <h3 id="nd-tr-title" class="nd-tr-title text-base font-semibold text-gray-100 mb-1">Submit Training Take</h3>
                    <p class="nd-tr-intro text-[11px] text-gray-400 mb-4 leading-snug">
                        Review the details below, then check the consent box to upload your take
                        (audio + detection events + this form) to the training dataset. All fields
                        marked optional can be left blank.
                    </p>

                    <div class="nd-tr-form">
                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Song Name</label>
                        <input class="nd-tr-song w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">CDLC File Name</label>
                        <input class="nd-tr-cdlc w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Instrument</label>
                        <select class="nd-tr-instr w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">
                            <option value="guitar">Guitar</option>
                            <option value="bass">Bass</option>
                        </select>

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Tuning</label>
                        <input class="nd-tr-tuning w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Your Name <span class="text-gray-500 normal-case">(optional)</span></label>
                        <input class="nd-tr-name w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Discord Handle <span class="text-gray-500 normal-case">(optional)</span></label>
                        <input class="nd-tr-discord w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Extra Notes <span class="text-gray-500 normal-case">(optional)</span></label>
                        <textarea class="nd-tr-notes w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3" rows="3"></textarea>

                        <label class="flex items-start gap-2 mb-4 cursor-pointer">
                            <input type="checkbox" class="nd-tr-consent mt-0.5">
                            <span class="text-xs text-gray-300 leading-snug">
                                I give permission for this recording to be used for training purposes
                                of the note detection system.
                            </span>
                        </label>
                    </div>

                    <!-- Status line: hidden until the user clicks Upload.
                         Tailwind classes get swapped between info/ok/err
                         palettes by the submit handler below. -->
                    <div class="nd-tr-status hidden text-xs leading-snug mb-4 px-3 py-2 rounded border"></div>

                    <div class="flex gap-2">
                        <button class="nd-tr-cancel flex-1 px-3 py-2 bg-dark-500 hover:bg-dark-400 rounded text-xs text-gray-300">Cancel</button>
                        <button class="nd-tr-retry flex-1 px-3 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-dark-600 disabled:text-gray-600 disabled:cursor-not-allowed rounded text-xs font-semibold text-white" style="display:none">Retry upload</button>
                        <button class="nd-tr-submit flex-1 px-3 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-dark-600 disabled:text-gray-600 disabled:cursor-not-allowed rounded text-xs font-semibold text-white" disabled>Upload</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            const $ = (sel) => modal.querySelector(sel);
            // Set values via .value rather than innerHTML so user-
            // controllable strings can't break out into HTML.
            $('.nd-tr-song').value    = prefill.songName || '';
            $('.nd-tr-cdlc').value    = prefill.cdlcFilename || '';
            $('.nd-tr-instr').value   = (prefill.instrument === 'bass') ? 'bass' : 'guitar';
            $('.nd-tr-tuning').value  = prefill.tuning || '';
            $('.nd-tr-name').value    = prefill.name || '';
            $('.nd-tr-discord').value = prefill.discord || '';
            $('.nd-tr-notes').value   = prefill.notes || '';
            // Move focus into the dialog so keyboard / screen-reader
            // users land inside it rather than on background content.
            try { $('.nd-tr-song').focus(); } catch (_) {}

            const submitBtn  = $('.nd-tr-submit');
            const retryBtn   = $('.nd-tr-retry');
            const cancelBtn  = $('.nd-tr-cancel');
            const consentCb  = $('.nd-tr-consent');
            const statusEl   = $('.nd-tr-status');
            const formEl     = $('.nd-tr-form');
            consentCb.addEventListener('change', () => { submitBtn.disabled = !consentCb.checked; });

            let finalResult = null;
            // Promise of the upload currently in flight (doUpload or
            // doRetry), or null. Closing the modal removes it from view
            // immediately, but the modal Promise MUST NOT resolve until
            // this settles — _uploadTrainingBundle's finally (disarm +
            // live-stream unbind) runs on that resolution, and running
            // it mid-upload stops judgment streaming and lets the take
            // be re-armed while its request is still going.
            let _activeUpload = null;
            const cleanup = () => {
                modal.remove();
                _trainingModalActive = false;
                // Return focus to wherever it was before the modal opened.
                try { if (_prevFocus && _prevFocus.focus) _prevFocus.focus(); } catch (_) {}
                if (_activeUpload) {
                    _activeUpload.finally(() => resolve(finalResult));
                } else {
                    resolve(finalResult);
                }
            };
            const setStatus = (kind, text) => {
                statusEl.classList.remove('hidden');
                statusEl.className = 'nd-tr-status text-xs leading-snug mb-4 px-3 py-2 rounded border ' + ({
                    info: 'bg-blue-900/30 border-blue-700/50 text-blue-200',
                    ok:   'bg-green-900/30 border-green-700/50 text-green-200',
                    err:  'bg-red-900/30 border-red-700/50 text-red-200',
                }[kind] || '');
                statusEl.textContent = text;
            };

            // Render an upload outcome (from the initial Upload or a
            // Retry) into the modal. Success collapses the actions
            // behind a green Close; failure shows a red Close and — when
            // the server retained a local bundle and a retry path was
            // supplied — a Retry button so the user can re-ship without
            // recording the song again.
            const applyResult = (result) => {
                finalResult = result;
                _recTrainingUploadResult = result;
                if (result && result.ok) {
                    setStatus('ok', '✓ Uploaded to the training dataset: ' + (result.bundle_filename || '(file)') + '. Thanks for contributing!');
                    submitBtn.style.display = 'none';
                    retryBtn.style.display = 'none';
                    cancelBtn.textContent = 'Close';
                    cancelBtn.className = 'flex-1 px-3 py-2 bg-green-700 hover:bg-green-600 rounded text-xs font-semibold text-white';
                } else {
                    const errMsg = (result && result.error) ? result.error : 'unknown error';
                    const canRetry = !!(doRetry && result && result.local_bundle);
                    const retained = (result && result.local_bundle)
                        ? ('\nThe local bundle was retained at ' + result.local_bundle
                           + (canRetry ? ' — use Retry below.' : ' — you can retry from there.'))
                        : '';
                    setStatus('err', '✗ Upload failed: ' + errMsg + retained);
                    submitBtn.style.display = 'none';
                    cancelBtn.textContent = 'Close';
                    cancelBtn.className = 'flex-1 px-3 py-2 bg-red-700 hover:bg-red-600 rounded text-xs font-semibold text-white';
                    if (canRetry) {
                        retryBtn.style.display = '';
                        retryBtn.disabled = false;
                        retryBtn._localBundle = result.local_bundle;
                    }
                }
            };

            // Close resolves with whatever the last attempt produced —
            // null before any upload (a genuine cancel), or the success/
            // failure result afterwards so the caller records it.
            cancelBtn.onclick = () => { cleanup(); };
            retryBtn.onclick = async () => {
                const localBundle = retryBtn._localBundle;
                if (!localBundle || !doRetry) return;
                retryBtn.disabled = true;
                retryBtn.textContent = 'Retrying…';
                setStatus('info', 'Re-uploading the saved bundle to pCloud — no re-recording needed. Don’t close Slopsmith yet.');
                let result = null;
                const p = doRetry(localBundle);
                _activeUpload = p;
                try {
                    result = await p;
                } catch (e) {
                    result = { ok: false, error: String(e && e.message || e), local_bundle: localBundle };
                } finally {
                    if (_activeUpload === p) _activeUpload = null;
                }
                retryBtn.textContent = 'Retry upload';
                applyResult(result);
            };
            submitBtn.onclick = async () => {
                if (!consentCb.checked) return; // belt-and-braces
                const formData = {
                    songName:     $('.nd-tr-song').value.trim(),
                    cdlcFilename: $('.nd-tr-cdlc').value.trim(),
                    instrument:   $('.nd-tr-instr').value,
                    tuning:       $('.nd-tr-tuning').value.trim(),
                    name:         $('.nd-tr-name').value.trim(),
                    discord:      $('.nd-tr-discord').value.trim(),
                    notes:        $('.nd-tr-notes').value.trim(),
                    consent:      true,
                };
                // Lock the form, swap into uploading mode. The form stays
                // visually present (faded) so the user can still see
                // their entries while the network round-trip is in
                // flight; cancelling at this point doesn't abort the
                // upload but does dismiss the modal.
                formEl.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = true; });
                formEl.classList.add('opacity-50', 'pointer-events-none');
                submitBtn.disabled = true;
                submitBtn.textContent = 'Uploading…';
                cancelBtn.textContent = 'Hide';
                setStatus('info', 'Bundling the WAV, detect-stream, and manifest, then shipping to pCloud. Don’t close Slopsmith yet — this can take a few seconds on a slow uplink.');

                let result = null;
                const p = doUpload(formData);
                _activeUpload = p;
                try {
                    result = await p;
                } catch (e) {
                    result = { ok: false, error: String(e && e.message || e) };
                } finally {
                    if (_activeUpload === p) _activeUpload = null;
                }
                applyResult(result);
            };
            // Esc closes the modal. While uploading, Esc still works (the
            // upload promise resolves into _recTrainingUploadResult, so
            // the result is preserved even if the user dismisses).
            modal.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') { e.stopPropagation(); cleanup(); }
            });
        });
    }
    async function _uploadTrainingBundle(savedData, sessionId, songInfoSnapshot, chartSnapshot, audioStats, cdlcFilenameSnapshot) {
        // audioStats pins sample-rate / sample-count / cap at song:ended
        // because saveRecordingNow() zeroes the live counters before this
        // runs. Fall back to the (now-reset) live values defensively.
        audioStats = audioStats || {
            sampleRate: _recSampleRate, totalSamples: _recTotalSamples, cappedAtS: _recCappedAt,
        };
        if (_recTrainingUploadInFlight) return null;
        // Owned by this function: set once here, cleared in the finally
        // on every exit path. _showTrainingConsentModal won't resolve
        // until any in-flight upload settles, so the finally is reached
        // only after the real upload work is done.
        _recTrainingUploadInFlight = true;
        try {
            // Recover the slug from the server-returned filename. The
            // /recording endpoint stamps `note_detect_<slug>_<ts>_<ms>_<suf>.wav`,
            // so parsing once here is cheaper and more robust than
            // mirroring saveRecordingNow's slug derivation (which depends
            // on hw.getSongInfo() being identical at this later moment).
            const filename = (savedData && savedData.filename) || '';
            const m = /^note_detect_(.+?)_\d{8}_\d{6}_\d{3}_[0-9a-f]+\.wav$/.exec(filename);
            if (!m) {
                _recTrainingUploadResult = {
                    ok: false,
                    error: 'could not parse slug from saved filename: ' + filename,
                };
                return null;
            }
            const slug = m[1];

            // Prefer the snapshot pinned at song:ended (the caller in
            // _recOnEnded captures it synchronously). Fall back to a
            // fresh read for any other caller / a direct API invocation
            // where no snapshot was provided.
            const info = songInfoSnapshot
                || ((hw && hw.getSongInfo) ? hw.getSongInfo() : {});
            // CDLC filename: prefer the value pinned at song:ended by
            // the caller (cdlcFilenameSnapshot) — _ndShared.currentFilename
            // is a process-global another splitscreen panel can overwrite
            // before this async upload runs. The direct reads are only a
            // fallback for callers that pinned nothing.
            const cdlcFilename = cdlcFilenameSnapshot
                || info.filename || _ndShared.currentFilename || '';
            const tuningArr = Array.isArray(info.tuning) ? info.tuning.slice() : null;
            // Guess instrument from the arrangement label — covers
            // "Bass", "Lead", "Rhythm", "Combo", etc. The user can
            // override in the modal if the guess is wrong.
            const arrLower = String(info.arrangement || '').toLowerCase();
            const guessedInstrument = arrLower.includes('bass') ? 'bass' : 'guitar';
            const persisted = _loadTrainingPrefs();

            // The modal stays open during the network round-trip so the
            // user sees an inline progress + result panel. doUpload is
            // invoked once the consent box is checked and Upload is
            // clicked; it returns the parsed server response (or an
            // {ok:false, error, local_bundle} object on failure) which
            // the modal renders into its status line.
            const result = await _showTrainingConsentModal({
                songName:     info.title || '',
                cdlcFilename: cdlcFilename,
                tuning:       tuningArr ? tuningArr.join(', ') : '',
                // Persisted instrument wins over the arrangement guess
                // only if the user has actually set one before — that
                // way a fresh user gets the helpful guess, but a known
                // bassist isn't re-confronted with "Guitar" every time.
                instrument:   persisted.instrument || guessedInstrument,
                name:         persisted.name,
                discord:      persisted.discord,
                notes:        persisted.notes,
            }, async (formData) => {
                // Persist the contributor-level fields for next time.
                // Song fields are intentionally excluded — next song
                // will repopulate them from songInfo.
                _saveTrainingPrefs({
                    name:       formData.name,
                    discord:    formData.discord,
                    instrument: formData.instrument,
                    notes:      formData.notes,
                });

                _recTrainingUploadResult = null;

                const manifest = {
                    // schema, created_at, and resolved audio/detect_stream
                    // refs are filled server-side. Everything below is
                    // the client's contribution.
                    plugin: { id: 'note_detect' },
                    song: {
                        filename:    formData.cdlcFilename || cdlcFilename || null,
                        title:       formData.songName || info.title || null,
                        artist:      info.artist || null,
                        arrangement: info.arrangement || null,
                        arrangement_index: (info.arrangement_index != null) ? info.arrangement_index : null,
                        tuning:       tuningArr,                                // original machine-readable
                        tuning_label: formData.tuning || null,                  // user-editable string
                        instrument:   formData.instrument || guessedInstrument, // 'guitar' | 'bass'
                        capo:         (info.capo != null) ? info.capo : null,
                        format:       info.format || null,
                        duration_s:   (info.duration != null) ? info.duration : null,
                    },
                    settings: {
                        detection_method:        detectionMethod,
                        av_offset_ms:            Math.round(latencyOffset * 1000),
                        timing_tolerance_ms:     Math.round(timingTolerance * 1000),
                        timing_hit_threshold_ms: Math.round(timingHitThreshold * 1000),
                        pitch_tolerance_cents:   pitchTolerance,
                    },
                    audio: {
                        // Pinned at song:ended — saveRecordingNow() has
                        // since reset the live _rec* counters to 0.
                        sample_rate: audioStats.sampleRate,
                        channels:    1,
                        bit_depth:   16,
                        duration_s:  audioStats.totalSamples / Math.max(1, audioStats.sampleRate),
                        capped_at_s: audioStats.cappedAtS,
                    },
                    client: {
                        user_agent: navigator.userAgent,
                        platform:   navigator.platform || null,
                        timestamp_local: new Date().toISOString(),
                    },
                    contributor: {
                        name:    formData.name    || null,
                        discord: formData.discord || null,
                        consent: true,
                        consent_text: 'I give permission for this recording to be used for training purposes of the note detection system.',
                        consent_at:   new Date().toISOString(),
                    },
                    notes: formData.notes || null,
                };

                // Read the user-configurable upload URL from the
                // settings.html field's localStorage key. Empty / missing
                // leaves it null so the server falls back to its own
                // hardcoded default. Mirrors the storage key + semantics
                // in settings.html.
                let uploadUrl = null;
                try { uploadUrl = localStorage.getItem('nd_training_upload_url') || null; } catch (_) {}

                // Drain any in-flight /live-judgment POSTs first — the
                // server zips whatever live_<id>.jsonl is on disk when
                // /training-bundle runs, so unflushed judgments (or the
                // session header) would be missing from the bundle.
                await _flushLiveJudgments();

                try {
                    const resp = await fetch('/api/plugins/note_detect/training-bundle', {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({
                            slug,
                            // Exact WAV filename from the /recording save —
                            // lets the server bundle THIS take's WAV rather
                            // than glob the newest for the slug (wrong WAV
                            // under concurrent same-slug takes).
                            wav_filename: filename || null,
                            // Null (not 'default') when this take minted no
                            // live session — the server soft-skips the JSONL
                            // instead of attaching a stale live_default.jsonl.
                            session: sessionId || null,
                            manifest,
                            // Ground-truth note chart (hw.getNotes/getChords
                            // pinned at song:ended) — the server writes it
                            // into the bundle as arrangement.json. null when
                            // the host exposed no chart.
                            arrangement: chartSnapshot || null,
                            upload_url: uploadUrl,
                        }),
                    });
                    let data = null;
                    try { data = await resp.json(); } catch (_) { /* leave null; surfaced below */ }
                    if (!resp.ok) {
                        const errStr = (data && (data.detail || data.error)) || resp.statusText;
                        const out = { ok: false, error: `HTTP ${resp.status}: ${errStr}`, local_bundle: data && data.local_bundle || null };
                        _recTrainingUploadResult = out;
                        return out;
                    }
                    _recTrainingUploadResult = data;
                    return data;
                } catch (e) {
                    const out = { ok: false, error: String(e && e.message || e) };
                    _recTrainingUploadResult = out;
                    console.warn('[note_detect] training-bundle upload failed:', e);
                    return out;
                }
            }, async (localBundle) => {
                // Retry path: re-upload the zip already on disk (no
                // re-bundling). The server confines `local_bundle` to
                // the recordings directory, so passing the path back is
                // safe. Honours the same per-user upload-URL override.
                let uploadUrl = null;
                try { uploadUrl = localStorage.getItem('nd_training_upload_url') || null; } catch (_) {}
                try {
                    const resp = await fetch('/api/plugins/note_detect/training-bundle/retry', {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({ local_bundle: localBundle, upload_url: uploadUrl }),
                    });
                    let data = null;
                    try { data = await resp.json(); } catch (_) { /* leave null; surfaced below */ }
                    if (!resp.ok) {
                        const errStr = (data && (data.detail || data.error)) || resp.statusText;
                        const out = { ok: false, error: `HTTP ${resp.status}: ${errStr}`, local_bundle: (data && data.local_bundle) || localBundle };
                        _recTrainingUploadResult = out;
                        return out;
                    }
                    _recTrainingUploadResult = data;
                    return data;
                } catch (e) {
                    const out = { ok: false, error: String(e && e.message || e), local_bundle: localBundle };
                    _recTrainingUploadResult = out;
                    console.warn('[note_detect] training-bundle retry failed:', e);
                    return out;
                }
            });
            if (!result) {
                // User cancelled before submitting — no upload attempted.
                _recTrainingUploadResult = {
                    ok: false,
                    error: 'cancelled — bundle not uploaded',
                    local_bundle: null,
                };
            }
            return _recTrainingUploadResult;
        } catch (e) {
            _recTrainingUploadResult = { ok: false, error: String(e && e.message || e) };
            console.warn('[note_detect] training-bundle flow failed:', e);
            return null;
        } finally {
            // Clear the in-flight flag on EVERY exit path — including
            // the early returns above (e.g. slug-parse failure) that
            // never opened the modal. Safe to clear here because
            // _showTrainingConsentModal defers its resolution until any
            // in-flight upload settles (see _activeUpload), so this
            // finally never runs mid-upload.
            //
            // Training-arm teardown (_recArmedForTraining / live-stream
            // unbind) is NOT done here — _recOnEnded's own finally owns
            // it, so the teardown also runs when a failed WAV save means
            // this function was never called.
            _recTrainingUploadInFlight = false;
        }
    }

    // Wire song-play / song-end events on the slopsmith bus so an armed
    // recording auto-arms on Play and auto-saves on song-end. Mirrors
    // the drill-mode binding pattern: bind once at construct, tear down
    // in destroy(). The handlers are no-ops while `_recArmed` is false.
    let _recOnPlay = null, _recOnPause = null, _recOnEnded = null;
    let _recSubscribed = false;
    function _recBindEvents() {
        if (_recSubscribed) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        _recOnPlay  = () => { _recSongPlaying = true; };
        _recOnPause = () => { _recSongPlaying = false; };
        _recOnEnded = () => {
            _recSongPlaying = false;
            if (_recArmed && _recChunks.length > 0) {
                // Capture training intent + session id + songInfo
                // SYNCHRONOUSLY. _liveOnEnded (registered separately)
                // nulls _liveSessionId on the same event, and by the
                // time the async save+upload chain runs the user may
                // have navigated back to the library — at which point
                // hw.getSongInfo() returns {} and the upload modal
                // would show empty Song Name / CDLC filename / Tuning.
                // Pin all of it here.
                const shouldUpload = _recArmedForTraining;
                // _liveSessionId may already be null here: _liveOnEnded
                // (bound by tuning mode, often BEFORE _recBindEvents ran)
                // clears it on this same song:ended. _liveLastSessionId
                // survives song:ended, so it's the reliable handle for
                // locating this take's live_<id>.jsonl detect-stream.
                const sessionAtEnd = _liveSessionId || _liveLastSessionId;
                const songInfoAtEnd = (hw && hw.getSongInfo) ? hw.getSongInfo() : {};
                // Pin the CDLC filename HERE too. _ndShared.currentFilename
                // is a process-global the playSong wrapper overwrites, so
                // a splitscreen panel starting another song before this
                // take's async upload runs would otherwise leak the wrong
                // filename into this manifest. songInfo wins; the global
                // is only the fallback, and must be read now, not later.
                const cdlcFilenameAtEnd =
                    (songInfoAtEnd && songInfoAtEnd.filename)
                    || _ndShared.currentFilename || '';
                // Pin the ground-truth note chart too — the arrangement
                // the highway rendered. hw.getNotes()/getChords() return
                // {} once the user navigates away, same as getSongInfo().
                const chartAtEnd = {
                    notes:  (hw && hw.getNotes)  ? hw.getNotes()  : null,
                    chords: (hw && hw.getChords) ? hw.getChords() : null,
                };
                // Pin the audio counters too — saveRecordingNow() resets
                // _recTotalSamples / _recCappedAt once the WAV POST
                // succeeds, and that runs before _uploadTrainingBundle
                // builds the manifest, so reading them later yields
                // duration_s 0 and a lost cap marker.
                const audioStatsAtEnd = {
                    sampleRate:    _recSampleRate,
                    totalSamples:  _recTotalSamples,
                    cappedAtS:     _recCappedAt,
                };
                // Fire-and-forget — the UI polls getRecordingState() so
                // it'll surface the lastSavePath / lastError when it lands.
                saveRecordingNow().then((data) => {
                    // Save has the bytes; release the mic now even if
                    // an upload is still pending (which uses the bytes
                    // already in _recChunks / on disk).
                    _stopParallelTrainingCapture();
                    if (data && shouldUpload) {
                        return _uploadTrainingBundle(data, sessionAtEnd, songInfoAtEnd, chartAtEnd, audioStatsAtEnd, cdlcFilenameAtEnd);
                    }
                }).catch(() => { _stopParallelTrainingCapture(); }).finally(() => {
                    // The training take is over — drop ALL arm state
                    // HERE, on every path. saveRecordingNow() unbinds the
                    // song listeners in its own finally regardless of
                    // success, so leaving _recArmed true on a failed save
                    // would strand the UI "armed" with no song:play/ended
                    // handlers. A failed WAV save also skips
                    // _uploadTrainingBundle entirely, so relying on its
                    // finally would leave training mode stuck on.
                    _recArmed = false;
                    _recArmedForTraining = false;
                    if (!tuningMode) _liveUnbindEvents();
                    // Surface the score summary that _endOfSongOnEnded
                    // deferred — now that the consent modal (if any) has
                    // closed. No-op when nothing was deferred.
                    _runDeferredSummary();
                });
            } else if (_recArmed) {
                // Armed but never captured anything (Detect was off, or
                // song:play never fired). Disarm + release the bus
                // listeners so the next song doesn't start an unintended
                // recording and we don't keep flipping _recSongPlaying.
                _recArmed = false;
                _recArmedForTraining = false;
                _recLastSaveError = 'no audio captured before song:ended';
                _recUnbindEvents();
                // Also drop the training-only live-stream subscription
                // armRecordingForTraining() force-bound — otherwise, with
                // tuning mode off, later songs keep minting/posting live
                // sessions for a take that no longer exists.
                if (!tuningMode) _liveUnbindEvents();
                _stopParallelTrainingCapture();
                // No upload modal will open — release any deferred
                // summary immediately.
                _runDeferredSummary();
            }
        };
        try {
            window.slopsmith.on('song:play',  _recOnPlay);
            window.slopsmith.on('song:pause', _recOnPause);
            window.slopsmith.on('song:ended', _recOnEnded);
        } catch (e) {
            // Partial registration — unwind to avoid leaking handlers.
            try { window.slopsmith.off('song:play',  _recOnPlay); }  catch (_) {}
            try { window.slopsmith.off('song:pause', _recOnPause); } catch (_) {}
            try { window.slopsmith.off('song:ended', _recOnEnded); } catch (_) {}
            _recOnPlay = _recOnPause = _recOnEnded = null;
            return;
        }
        _recSubscribed = true;
    }
    function _recUnbindEvents() {
        if (!_recSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function') {
            if (_recOnPlay)  { try { window.slopsmith.off('song:play',  _recOnPlay); }  catch (e) {} }
            if (_recOnPause) { try { window.slopsmith.off('song:pause', _recOnPause); } catch (e) {} }
            if (_recOnEnded) { try { window.slopsmith.off('song:ended', _recOnEnded); } catch (e) {} }
        }
        _recOnPlay = _recOnPause = _recOnEnded = null;
        _recSubscribed = false;
    }

    // Live-streaming event bindings — only active while tuning mode is
    // on. Mints a fresh session id on song:play so every take produces
    // its own `live_<id>.jsonl` file server-side; clears it on song:end
    // so judgments fired after a song ends don't trickle into a stale
    // file. Independent of recording arm state — the user gets live
    // streaming even without arming a WAV capture.
    let _liveOnPlay = null, _liveOnEnded = null;
    let _liveSubscribed = false;

    // Mint a fresh live session id and stream the session-header record
    // as line 1 of the JSONL. Normally driven by song:play, but also
    // called from armRecordingForTraining() when the user arms AFTER
    // pressing Play — in that case song:play has already fired and won't
    // fire again, so without this the take would carry no header.
    function _startLiveSession() {
        // Match the recording route's filename convention so live
        // JSONL and recorded WAV pair up cleanly under
        // static/note_detect_recordings/.
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const ts = now.getFullYear()
            + pad(now.getMonth() + 1) + pad(now.getDate()) + '_'
            + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
        // Short random suffix avoids collisions when two panels
        // emit a song:play in the same second (splitscreen).
        const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
        _liveSessionId = `${ts}_${rand}`;
        // Mirror into a handle that is NOT cleared on song:ended, so the
        // training-bundle upload can still locate this take's JSONL even
        // though _liveOnEnded nulls _liveSessionId.
        _liveLastSessionId = _liveSessionId;
        // Stream a session-header record as line 1 of the JSONL so
        // an offline reader knows under which settings the
        // subsequent judgments were produced. Important for two
        // reasons: (1) any analysis that infers "what cr was the
        // user on?" from judgment data alone is fragile, (2) we
        // want to mine these for sensible-default suggestions
        // across users without each contributor having to attach
        // their settings every time. Distinct shape (type:
        // "session_start") so consumers can split header from
        // judgments. Includes song / arrangement context too —
        // useful for bucketing v1/v2/bass benchmark runs.
        _streamLiveJudgment(_buildSessionHeader());
    }

    function _liveBindEvents() {
        if (_liveSubscribed) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        _liveOnPlay = () => { _startLiveSession(); };
        _liveOnEnded = () => {
            _liveSessionId = null;
        };
        try {
            window.slopsmith.on('song:play',  _liveOnPlay);
            window.slopsmith.on('song:ended', _liveOnEnded);
        } catch (e) {
            try { window.slopsmith.off('song:play',  _liveOnPlay); }  catch (_) {}
            try { window.slopsmith.off('song:ended', _liveOnEnded); } catch (_) {}
            _liveOnPlay = _liveOnEnded = null;
            return;
        }
        _liveSubscribed = true;
    }
    function _liveUnbindEvents() {
        if (!_liveSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function') {
            if (_liveOnPlay)  { try { window.slopsmith.off('song:play',  _liveOnPlay); }  catch (e) {} }
            if (_liveOnEnded) { try { window.slopsmith.off('song:ended', _liveOnEnded); } catch (e) {} }
        }
        _liveOnPlay = _liveOnEnded = null;
        _liveSubscribed = false;
        _liveSessionId = null;
    }

    // Returns true if a summary overlay was created, false if it bailed
    // (fewer than 5 judgments) — callers deferring the summary use this
    // to know whether there is actually an overlay to reveal later.
    function showSummary(opts) {
        const total = hits + misses;
        if (total < 5) return false;

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

        // Miss-category breakdown (#254 follow-up) — bars sum to total misses
        // so the dominant failure mode is visible at a glance. Tuning mode
        // only — normal play sees just the original hits/misses/streak +
        // per-section bars.
        let breakdownHtml = '';
        if (tuningMode && misses > 0) {
            const labels = {
                pure:         ['Pure (no pitch)',    'bg-gray-500'],
                chordPartial: ['Chord — partial',    'bg-purple-500'],
                early:        ['Timing — early',     'bg-orange-500'],
                late:         ['Timing — late',      'bg-orange-500'],
                sharp:        ['Pitch — sharp',      'bg-cyan-500'],
                flat:         ['Pitch — flat',       'bg-cyan-500'],
            };
            breakdownHtml = '<div class="mt-3 text-xs"><div class="text-gray-400 mb-1">Miss Breakdown:</div>';
            for (const k of Object.keys(labels)) {
                const v = _diagBreakdown[k] || 0;
                if (v === 0) continue;
                const pct = Math.round((v / misses) * 100);
                breakdownHtml += `
                    <div class="flex items-center gap-2 mb-1">
                        <span class="w-24 text-gray-300">${labels[k][0]}</span>
                        <div class="flex-1 h-2 bg-dark-600 rounded overflow-hidden">
                            <div class="${labels[k][1]} h-full rounded" style="width:${pct}%"></div>
                        </div>
                        <span class="w-12 text-right text-gray-400">${v} <span class="text-gray-600">(${pct}%)</span></span>
                    </div>
                `;
            }
            const timingMed = _diagPercentile(_diagTimingErrors, 50);
            const pitchMed  = _diagPercentile(_diagPitchErrors, 50);
            if (timingMed != null || pitchMed != null) {
                breakdownHtml += '<div class="mt-2 text-[10px] text-gray-500">';
                if (timingMed != null) {
                    const tp10 = _diagPercentile(_diagTimingErrors, 10);
                    const tp90 = _diagPercentile(_diagTimingErrors, 90);
                    breakdownHtml += `Timing err (ms): median ${timingMed}, p10..p90 [${tp10}..${tp90}]<br>`;
                }
                if (pitchMed != null) {
                    const pp10 = _diagPercentile(_diagPitchErrors, 10);
                    const pp90 = _diagPercentile(_diagPitchErrors, 90);
                    breakdownHtml += `Pitch err (¢): median ${pitchMed}, p10..p90 [${pp10}..${pp90}]`;
                }
                breakdownHtml += '</div>';
            }
            breakdownHtml += '</div>';
        }

        const overlay = document.createElement('div');
        overlay.className = 'nd-summary-overlay fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm';
        overlay.style.pointerEvents = 'auto';
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
        overlay.innerHTML = `
            <div class="bg-dark-700 border border-gray-600 rounded-2xl p-6 w-96 max-h-[88vh] overflow-y-auto shadow-2xl">
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
                ${breakdownHtml}
                ${sectionHtml}
                <div class="mt-4 flex gap-2">
                    ${tuningMode ? `
                    <button class="nd-summary-download flex-1 py-2 bg-accent hover:bg-accent-light rounded-lg text-sm font-semibold text-white transition">
                        Download Diagnostic JSON
                    </button>` : ''}
                    <button class="nd-summary-close ${tuningMode ? 'px-4' : 'flex-1'} py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-sm text-gray-300 transition">
                        Close
                    </button>
                </div>
            </div>
        `;
        overlay.querySelector('.nd-summary-close').onclick = () => overlay.remove();
        const dlBtn = overlay.querySelector('.nd-summary-download');
        if (dlBtn) dlBtn.onclick = () => _downloadDiagnostic();
        // startHidden: built now (so the stats are this song's) but kept
        // out of view until _runDeferredSummary() reveals it — used when
        // a training consent modal is taking the screen on song:ended.
        if (opts && opts.startHidden) overlay.style.display = 'none';
        instanceRoot.appendChild(overlay);

        publishToJournal(accuracy);
        return true;
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
    const api = {
        enable,
        disable,
        destroy,
        isEnabled: () => enabled,
        getStats: () => ({
            hits, misses, streak, bestStreak,
            accuracy: (hits + misses) > 0 ? Math.round(hits / (hits + misses) * 100) : 0,
            sectionStats: sectionStats.map(s => ({ name: s.name, hits: s.hits, misses: s.misses })),
        }),
        // The user's most-recently-expressed preference: did they last
        // click Detect to turn it ON? Distinct from isEnabled(), which
        // is the live runtime state and goes false on every song-switch
        // (the playSong wrapper silent-disables to clear stale stats).
        // The wrapper itself reads this to decide whether to auto-
        // re-enable for the next song.
        wantsDetect: () => !!detectPreference,
        // Drill-mode read-only state. `current` reflects the
        // in-progress iteration (zeroed when no drill is active).
        // `iterations` is a snapshot copy of completed iterations so
        // callers can't mutate the internal array.
        getDrillStats: () => {
            // Sync inline so callers always see current loop state
            // even when detection is disabled (when updateHUD isn't
            // ticking) — otherwise `active` and `current.startT`
            // could lag behind a loop clear / bounds change until
            // the next enable() or HUD tick.
            _drillSyncFromLoopState();
            const liveTotal = drillIterHits + drillIterMisses;
            return {
                active: drillEnabled,
                current: {
                    hits: drillIterHits,
                    misses: drillIterMisses,
                    streak: drillIterStreak,
                    bestStreak: drillIterBestStreak,
                    accuracy: liveTotal > 0 ? Math.round((drillIterHits / liveTotal) * 100) : 0,
                    startT: drillIterStartT,
                },
                iterations: drillIterations.map((it) => ({ ...it })),
            };
        },
        setChannel,
        injectButton,
        showSummary,
        // Diagnostic export (#254 follow-up). `downloadDiagnostic()`
        // triggers a browser file save of the current session's
        // breakdown + capped event log; `getDiagnostic()` returns the
        // same payload for in-page display / programmatic use. Schema
        // is `note_detect.diagnostic.v1`. `resetDiagnostic()` zeroes
        // all the counters mid-session (without touching audio /
        // enabled / button state) so you can navigate to a specific
        // section, reset, and capture *only* that section's events.
        downloadDiagnostic: _downloadDiagnostic,
        getDiagnostic: _buildDiagnosticPayload,
        resetDiagnostic: resetScoring,
        // Public setter for the Auto-tune-from-session panel — applies
        // a partial settings object with the same clamps the storage
        // loader uses, then persists via saveSettings(). Each field is
        // optional; unknown / non-finite values are ignored so callers
        // can pass only the rows they want to apply. Returns the
        // post-clamp object so the caller can update the UI without a
        // separate get round-trip.
        applySettings: (partial) => {
            partial = partial || {};
            if (typeof partial.method === 'string' && ['yin', 'hps', 'crepe'].includes(partial.method)) {
                detectionMethod = partial.method;
            }
            if (Number.isFinite(partial.timingTolerance)) {
                timingTolerance = Math.max(0.03, Math.min(0.3, partial.timingTolerance));
            }
            if (Number.isFinite(partial.pitchTolerance)) {
                pitchTolerance = Math.max(10, Math.min(100, partial.pitchTolerance));
            }
            if (Number.isFinite(partial.timingHitThreshold)) {
                timingHitThreshold = Math.max(0.03, Math.min(timingTolerance, partial.timingHitThreshold));
            }
            if (Number.isFinite(partial.chordTimingHitThreshold)) {
                chordTimingHitThreshold = Math.max(timingHitThreshold, Math.min(timingTolerance, partial.chordTimingHitThreshold));
            }
            // Maintain the chord >= single-note invariant after either side moved.
            if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
            if (Number.isFinite(partial.pitchHitThreshold)) {
                pitchHitThreshold = Math.max(5, Math.min(pitchTolerance, partial.pitchHitThreshold));
            }
            if (Number.isFinite(partial.chordHitRatio)) {
                chordHitRatio = Math.max(0.25, Math.min(1, partial.chordHitRatio));
            }
            if (Number.isFinite(partial.detectionConfidenceMin)) {
                detectionConfidenceMin = Math.max(0.05, Math.min(0.50, partial.detectionConfidenceMin));
            }
            if (Number.isFinite(partial.latencyOffset)) {
                // Clamp to the same range as the gear-popover slider
                // (0–0.250 s). The storage loader doesn't clamp this
                // field on read, but the writer should — letting a
                // caller (auto-tune, DevTools experiment, stale code)
                // park latency at 5 s would render the matching
                // window unreachable until the user manually drags
                // the slider back into range.
                latencyOffset = Math.max(0, Math.min(0.25, partial.latencyOffset));
            }
            // Re-enforce timing-threshold invariants at the END of the
            // setter. A partial that lowers `timingTolerance` alone (and
            // doesn't supply new hit thresholds) would otherwise leave
            // `timingHitThreshold` and/or `chordTimingHitThreshold`
            // above the new tolerance ceiling — a state the UI sliders
            // can't represent and that drifts judgment classification
            // until the user touches another knob. Same pattern as the
            // storage-load invariant at the top of createNoteDetector.
            if (timingHitThreshold > timingTolerance) timingHitThreshold = timingTolerance;
            if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
            if (chordTimingHitThreshold > timingTolerance)    chordTimingHitThreshold = timingTolerance;
            saveSettings();
            return {
                method: detectionMethod,
                timingTolerance,
                pitchTolerance,
                timingHitThreshold,
                chordTimingHitThreshold,
                pitchHitThreshold,
                chordHitRatio,
                detectionConfidenceMin,
                latencyOffset,
            };
        },
        // Narrower reset for A/V calibrate — clears only the timing
        // samples that feed the next calibration suggestion, leaving
        // hits/misses/streak/sectionStats/eventLog intact. Use this
        // instead of `resetDiagnostic` when the goal is "stop using
        // stale samples from before my offset change", not "start a
        // brand-new session".
        resetCalibrationSamples: _resetCalibrationSamples,
        // Tuning-mode gate. Off by default; flipped on/off from the
        // Settings page (the developer surfaces it gates live there too,
        // so the toggle and the panels it reveals are in one place).
        // Other UI — the summary modal's breakdown / Download button —
        // polls this to decide whether to render the dev-only surfaces.
        isTuningMode: () => tuningMode,
        setTuningMode: (v) => {
            const next = !!v;
            if (next === tuningMode) return;
            tuningMode = next;
            // If the user disables tuning mid-recording, drop the
            // in-flight buffer + disarm — the UI for it is about to
            // disappear and we don't want a half-captured WAV trailing.
            if (!tuningMode && (_recArmed || _recChunks.length > 0)) {
                discardRecording();
            }
            // Live JSONL streaming binds/unbinds with tuning mode so
            // non-tuning users don't pollute the slopsmith event bus.
            // The drill-mode tests assert exactly one song:ended
            // listener after their own bind — adding an always-on
            // live-stream listener would break that contract.
            if (tuningMode) _liveBindEvents(); else _liveUnbindEvents();
            saveSettings();
        },
        // Reference-recording capture for the headless harness. Arms
        // the next song-play to capture the detector's input audio,
        // auto-saves on song:ended. POSTs the WAV to the plugin's
        // routes.py endpoint, which writes it under
        // static/note_detect_recordings/ — bind-mounted in the dev
        // container, so the harness on the host can read it back
        // without any copy step. See `getRecordingState()` for status
        // / lastSavePath / lastError fields the UI polls.
        armRecording,
        armRecordingForTraining,
        disarmRecording,
        discardRecording,
        saveRecordingNow,
        getRecordingState,
        // Diagnostic accessor — surfaces the AudioContext's own
        // latency self-report. Both fields describe the *output/render*
        // side of the graph, not the microphone-capture path:
        //   - `baseLatency` is the processing latency the AudioContext
        //     incurs while rendering audio (typically a render quantum
        //     or two of buffering on the output side). It is NOT a
        //     measured input-capture delay and does NOT include the
        //     ScriptProcessor frame buffering on top of it.
        //   - `outputLatency` is the total downstream latency from the
        //     destination node to actually-audible — also output-side.
        // For input-chain latency you have to combine these with the
        // ScriptProcessor frame size and the OS capture buffer (which
        // the browser does not expose). What this accessor IS good for:
        // verifying that the `latencyHint: 'interactive'` opt-in
        // produced a smaller `baseLatency` than the platform default
        // (a useful proxy for "the browser took the hint"). Returns
        // null when audio hasn't been started yet (enable() not yet
        // called or running in the desktop-bridge path that doesn't
        // own an AudioContext).
        getAudioLatencyInfo: () => {
            if (!audioCtx) return null;
            return {
                baseLatency:   Number.isFinite(audioCtx.baseLatency)   ? audioCtx.baseLatency   : null,
                outputLatency: Number.isFinite(audioCtx.outputLatency) ? audioCtx.outputLatency : null,
                sampleRate:    audioCtx.sampleRate,
                frameSize:     _ND_FRAME_SIZE,
                yinBufferSize: _ND_MIN_YIN_SAMPLES,
                state:         audioCtx.state,
            };
        },
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
        // Internal — drill-mode test hooks. The audio pipeline
        // (getUserMedia, AudioContext) is unavailable in the vm test
        // sandbox, so tests need a way to bind listeners + inject
        // judgments + drive the loop-state poll without going through
        // enable(). Prefixed with `_` to mark them as non-public.
        _bindDrillEvents: _drillBindEvents,
        _unbindDrillEvents: _drillUnbindEvents,
        _drillSyncFromLoopState: _drillSyncFromLoopState,
        _recordJudgment: recordJudgment,
        // End-of-song summary hooks. Exposed alongside the drill hooks
        // so tests can pin the song:ended listener-count contract
        // (drill alone = 1; drill + end-of-song = 2) without going
        // through enable(). Production code never calls these — they
        // bind from enableImpl() and unbind from destroy().
        _bindEndOfSongEvents: _endOfSongBindEvents,
        _unbindEndOfSongEvents: _endOfSongUnbindEvents,
        // Chart-state sync test hooks — same rationale as the drill
        // hooks. _getChartState lets tests assert the closure-private
        // currentArrangement/currentStringCount/tuningOffsets/capo
        // fields after a synthetic song:loaded.
        _bindChartStateEvents: _chartStateBindEvents,
        _unbindChartStateEvents: _chartStateUnbindEvents,
        _syncChartStateFromHw: _syncChartStateFromHw,
        _getChartState: () => ({
            arrangement: currentArrangement,
            stringCount: currentStringCount,
            tuningOffsets: tuningOffsets.slice(),
            capo,
        }),

        // Internal — headless-harness hooks. Lets a Node CLI tool
        // (plugins/note_detect/tools/harness.js) drive the exact same
        // processFrame / matchNotes / checkMisses pipeline the browser
        // uses, without going through getUserMedia / AudioContext.
        // Required because the matching + judgment logic is closure-
        // internal and 300+ lines of nuance we don't want to
        // reimplement out-of-process. Each entry is a no-arg / small-
        // arg method; the harness composes them. Production code
        // never touches `_harness`.
        _harness: {
            feedFrame: async (buffer, sampleRate) => {
                if (Number.isFinite(sampleRate)) bridgeSampleRate = sampleRate;
                await processFrame(buffer);
            },
            tick: () => { checkMisses(); },
            setEnabled: (v) => { enabled = !!v; },
            setContext: (ctx) => {
                ctx = ctx || {};
                if (typeof ctx.arrangement === 'string') currentArrangement = ctx.arrangement;
                if (Number.isFinite(ctx.stringCount))   currentStringCount = ctx.stringCount;
                if (Array.isArray(ctx.tuningOffsets))   tuningOffsets = ctx.tuningOffsets.slice();
                if (Number.isFinite(ctx.capo))          capo = ctx.capo;
            },
            setSettings: (s) => {
                s = s || {};
                // _harness is a Node-only entrypoint and CREPE's
                // TensorFlow.js model isn't wired in this path (see the
                // file header on tools/harness.js). Accepting 'crepe'
                // here would let a programmatic caller drive a value
                // that the harness CLI explicitly rejects — and the
                // detector would silently fall back to YIN at runtime.
                // Keep the internal API aligned with the CLI's whitelist.
                if (typeof s.method === 'string' && ['yin', 'hps'].includes(s.method))
                    detectionMethod = s.method;
                if (Number.isFinite(s.pitchTolerance))      pitchTolerance      = s.pitchTolerance;
                if (Number.isFinite(s.pitchHitThreshold))   pitchHitThreshold   = s.pitchHitThreshold;
                if (Number.isFinite(s.timingTolerance))     timingTolerance     = s.timingTolerance;
                if (Number.isFinite(s.timingHitThreshold))  timingHitThreshold  = s.timingHitThreshold;
                if (Number.isFinite(s.chordTimingHitThreshold)) {
                    // Clamp here too — _harness is a Node-only entrypoint
                    // (harness.js + regression.js drive scoring through it)
                    // and a regression sweep can legitimately pass a chord
                    // threshold outside [timingHitThreshold, timingTolerance]
                    // (e.g. when sweeping timing alone without re-clamping
                    // the chord value). Clamp instead of accepting blindly
                    // so headless scoring matches in-app behavior.
                    chordTimingHitThreshold = Math.max(timingHitThreshold, Math.min(timingTolerance, s.chordTimingHitThreshold));
                }
                if (Number.isFinite(s.chordHitRatio))       chordHitRatio       = s.chordHitRatio;
                if (Number.isFinite(s.latencyOffset))       latencyOffset       = s.latencyOffset;
                if (Number.isFinite(s.inputGain))           inputGain           = s.inputGain;
                // Re-enforce timing-threshold invariants at the END of the
                // setter. A harness caller can legitimately update only
                // `timingHitThreshold` or `timingTolerance` between scoring
                // runs; without this re-clamp the chord threshold can
                // become stricter than single-note OR exceed the outer
                // tolerance, both of which diverge from in-app behavior.
                if (timingHitThreshold > timingTolerance) timingHitThreshold = timingTolerance;
                if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
                if (chordTimingHitThreshold > timingTolerance)    chordTimingHitThreshold = timingTolerance;
            },
        },
    };

    // Register the draw hook once per instance. The hook early-returns
    // on !enabled so disabled instances cost essentially nothing.
    // If highway isn't ready at construction time, ensureDrawHook()
    // (called from enable()) re-tries after resolving `hw` lazily.
    ensureDrawHook();

    // Recording listeners are NOT bound at construct — drill tests assert
    // a clean per-instance listener count, and we shouldn't be on the
    // slopsmith event bus when no recording is armed anyway. We bind
    // on armRecording(), unbind on disarm / save / destroy.

    // Live-stream listeners follow the same rule but key off tuning
    // mode: if the user already has tuning mode on from localStorage,
    // bind so song:play mints a session id without requiring a
    // setTuningMode toggle. setTuningMode handles the dynamic case.
    if (tuningMode) _liveBindEvents();

    // Auto-enable detection on construct when the persisted preference
    // says so. Default singletons only — splitscreen panels mount /
    // unmount on demand and shouldn't claim the audio device the
    // moment they're constructed. Deferred to next tick so plugin
    // construction returns first; enableImpl() bails cleanly if the
    // highway isn't resolvable yet (it'll keep showing the off-state
    // button until the user clicks).
    //
    // Gated on `window.AudioContext` (or the webkit-prefixed alias) so
    // the vm test sandbox — which stubs the highway but has no audio
    // — doesn't trigger a phantom enable() that binds drill listeners
    // before the test gets to make its assertions.
    const _hasAudio = typeof window !== 'undefined'
        && (typeof window.AudioContext === 'function'
            || typeof window.webkitAudioContext === 'function');
    if (isDefault && detectPreference && _hasAudio) {
        setTimeout(() => {
            // Re-check BOTH enabled and detectPreference. A fast user
            // click could have already enabled us (`enabled`), and
            // another surface (settings sync, headless toggle) could
            // have flipped detectPreference to false during the
            // timeout — in that case we'd be honouring a stale-by-now
            // preference and enabling against the user's wishes.
            if (!enabled && detectPreference) enable().catch((e) => {
                console.warn('[note_detect] auto-enable failed:', e && e.message ? e.message : e);
            });
        }, 0);
    }

    _ndInstances.add(api);
    return api;
}

// ── Garbage Collection ─────────────────────────────────────────────────────
// Prune old note results to prevent unbounded memory growth

setInterval(() => {
    if (!_ndEnabled || _ndNoteResults.size < 500) return;
    const t = highway.getTime();
    for (const [key, _] of _ndNoteResults) {
        const noteTime = parseFloat(key.split('_')[0]);
        if (noteTime < t - 20) _ndNoteResults.delete(key);
    }
}, 5000);

// ── Hook into playSong ─────────────────────────────────────────────────────

(function() {
    const origPlaySong = window.playSong;
    window.playSong = async function(filename, arrangement) {
        // Snapshot the in-flight play (if any) BEFORE resetting — songId is
        // still the previous song's at this point, which is what we want.
        _ndSnapshotPlay('song_change');
        // Reset state on new song
        if (_ndEnabled) {
            _ndStopAudio();
            _ndStopHUD();
            if (_ndMissCheckInterval) { clearInterval(_ndMissCheckInterval); _ndMissCheckInterval = null; }
            _ndEnabled = false;
        }
        _ndResetScoring();
        await origPlaySong(filename, arrangement);
        _ndInjectButton();
        _ndAttachAutoDetectListener();

        // Read tuning from newly loaded song
        const info = highway.getSongInfo();
        if (info && info.tuning) {
            _ndTuningOffsets = info.tuning;
        }
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
        if (info && info.arrangement) {
            _ndSetArrangement(info.arrangement);
        }
    };
})();

// ── Built-in Diagnostic Panel ─────────────────────────────────────────────
// Bottom-docked, doesn't obscure the highway. Toggle via ≡ button.

let _ndDiagOpen = false;
let _ndDiagInterval = null;
let _ndDiagProfileLog = [];
let _ndDiagPaused = false;

function _ndToggleDiag() {
    _ndDiagOpen = !_ndDiagOpen;
    if (_ndDiagOpen) _ndOpenDiag();
    else _ndCloseDiag();
}

function _ndCloseDiag() {
    _ndDiagOpen = false;
    if (_ndDiagInterval) { clearInterval(_ndDiagInterval); _ndDiagInterval = null; }
    const el = document.getElementById('nd-diag-panel');
    if (el) el.remove();
}

function _ndOpenDiag() {
    _ndCloseDiag();
    _ndDiagOpen = true;

    const panel = document.createElement('div');
    panel.id = 'nd-diag-panel';
    panel.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:9999;background:#0d0d18;border-top:2px solid #336;font:11px/1.5 monospace;color:#ccc;max-height:35vh;overflow-y:auto;padding:6px 12px;';
    document.body.appendChild(panel);

    _ndDiagProfileLog = [];
    _ndDiagPaused = false;
    _ndDiagRender(panel);

    // Auto-refresh at 4fps — skip when paused so text is selectable
    _ndDiagInterval = setInterval(() => {
        if (!_ndDiagPaused) _ndDiagRender(panel);
    }, 250);
}

function _ndDiagTogglePause() {
    _ndDiagPaused = !_ndDiagPaused;
    const btn = document.getElementById('nd-diag-pause-btn');
    if (btn) {
        btn.textContent = _ndDiagPaused ? 'PAUSED (resume)' : 'Pause';
        btn.style.background = _ndDiagPaused ? '#642' : '#333';
        btn.style.color = _ndDiagPaused ? '#fa4' : '#aaa';
    }
}

function _ndDiagDumpToConsole() {
    console.log('=== NOTE DETECTION DIAGNOSTIC DUMP ===');
    console.log('Arrangement:', _ndCurrentArrangement);
    console.log('Tuning offsets:', _ndTuningOffsets.slice(0, _ndStandardMidiFor(_ndCurrentArrangement).length));
    console.log('Capo:', _ndCapo);
    console.log('Latency offset:', _ndDetectionLatencySec * 1000, 'ms');
    console.log('AV offset:', highway.getAvOffset ? highway.getAvOffset() : 0, 'ms');
    console.log('Timing tolerance:', _ndTimingTolerance * 1000, 'ms');
    console.log('Pitch tolerance:', _ndPitchTolerance, 'cents');
    console.log('Silence gate:', _ndSilenceGate);
    console.log('Scoring:', _ndHits, 'hits,', _ndMisses, 'misses');
    console.log('');
    console.log('--- Event Log (last', _ndEventLog.length, 'match attempts) ---');
    for (const e of _ndEventLog) {
        const midiName = (m) => {
            if (!m || m < 0) return '?';
            const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
            const r = Math.round(m);
            return `${names[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
        };
        const dt = `${e.dtMs > 0 ? '+' : ''}${Math.round(e.dtMs)}ms`;
        const cents = `${e.centsErr > 0 ? '+' : ''}${Math.round(e.centsErr)}¢`;
        const det = e.detectedMidi ? `detected:${midiName(e.detectedMidi)}(MIDI ${e.detectedMidi.toFixed(1)})` : 'detected:?';
        const exp = e.expectedMidi ? `expected:${midiName(e.expectedMidi)}(MIDI ${e.expectedMidi})` : 'expected:?';
        console.log(`  ${e.hit ? 'HIT ' : 'MISS'} ${e.chartNote || '?'} dt=${dt} pitch=${cents} ${det} ${exp}`);
    }
    console.log('');
    console.log('--- Note Results (last 20) ---');
    const entries = [];
    _ndNoteResults.forEach((v, k) => entries.push({ key: k, ...v }));
    for (const r of entries.slice(-20)) {
        const te = r.timingError != null ? `${Math.round(r.timingError)}ms` : '—';
        const pe = r.pitchError != null ? `${Math.round(r.pitchError)}¢` : '—';
        console.log(`  ${r.key} → ${r.primary} timing=${te} pitch=${pe} det:${r.detectedMidi} exp:${r.expectedMidi}`);
    }
    console.log('=== END DUMP ===');
    console.log('');
    if (_ndFrameLog.length > 0) {
        // Only show stable/unstable/gate frames, skip the noisy LOW_CONF
        const interesting = _ndFrameLog.filter(f =>
            f.type === 'stable' || f.type === 'unstable' || f.type === 'reject_gate'
        );
        console.log(`--- Frame Log (${interesting.length} interesting of ${_ndFrameLog.length} total) ---`);
        for (const f of interesting) {
            if (f.type === 'stable') {
                console.log(`  [STABLE] midi=${f.midi} conf=${f.conf} scoreT=${f.scoreT} chartT=${f.chartT} level=${f.level}`);
            } else if (f.type === 'unstable') {
                console.log(`  [UNSTABLE] midi=${f.midi} conf=${f.conf} level=${f.level}`);
            } else if (f.type === 'reject_gate') {
                console.log(`  [GATED] midi=${f.midi} level=${f.level}`);
            }
        }
        console.log('--- End Frame Log ---');
    }
    // Also fire the auto-dump POST
    _ndAutoDumpPost();
}

// ── Quick Calibrate ────────────────────────────────────────────────────────
// Time-independent pitch calibration. Does NOT require the song to be playing
// or notes to be at the strum bar. Compares detected pitch against ALL unique
// pitches in the chart to find the systematic offset.
// ── Flashcard Test (Phase 1) ──────────────────────────────────────────────
// Console-callable: _fcTest('B1') — play the note, see if detection gets it.
// No timing, no chart. Proves pitch detection works in isolation.

const _FC_NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

function _fcMidiToNoteName(midi) {
    const r = Math.round(midi);
    return `${_FC_NOTE_NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
}

function _fcNoteNameToMidi(name) {
    const m = name.match(/^([A-G]#?)(\d+)$/i);
    if (!m) return -1;
    const note = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    const octave = parseInt(m[2]);
    const idx = _FC_NOTE_NAMES.indexOf(note);
    if (idx < 0) return -1;
    return (octave + 1) * 12 + idx;
}

function _fcTest(targetNoteName, timeoutSec = 10) {
    const targetMidi = _fcNoteNameToMidi(targetNoteName);
    if (targetMidi < 0) {
        console.error(`[fcTest] Invalid note name: "${targetNoteName}". Use format like B1, E2, G#3`);
        return;
    }
    if (!_ndEnabled) {
        console.error('[fcTest] Note detection is not enabled. Toggle it on first.');
        return;
    }
    console.log(`[fcTest] Target: ${targetNoteName} (MIDI ${targetMidi}). Play the note...`);

    const startTime = performance.now();
    let lastStable = -1;
    const tolerance = 50; // cents

    const iv = setInterval(() => {
        const elapsed = (performance.now() - startTime) / 1000;

        // Wait for stable MIDI that differs from the last reported one
        if (_ndStableMidi >= 0 && _ndStableMidi !== lastStable) {
            lastStable = _ndStableMidi;
            const detectedName = _fcMidiToNoteName(_ndStableMidi);
            const centsOff = (_ndStableMidi - targetMidi) * 100;
            const hit = Math.abs(centsOff) <= tolerance;

            if (hit) {
                console.log(`[fcTest] ✓ CORRECT  Target: ${targetNoteName}  Detected: ${detectedName} (MIDI ${_ndStableMidi})  ${centsOff > 0 ? '+' : ''}${Math.round(centsOff)}¢  ${elapsed.toFixed(1)}s`);
            } else {
                console.log(`[fcTest] ✗ WRONG    Target: ${targetNoteName}  Detected: ${detectedName} (MIDI ${_ndStableMidi})  ${centsOff > 0 ? '+' : ''}${Math.round(centsOff)}¢  ${elapsed.toFixed(1)}s`);
            }
            clearInterval(iv);
            return;
        }

        if (elapsed > timeoutSec) {
            console.log(`[fcTest] ✗ TIMEOUT  No stable detection in ${timeoutSec}s. Level: ${_ndInputLevel.toFixed(3)}`);
            clearInterval(iv);
        }
    }, 100);
}

// Batch test: _fcTestAll(['E1','A1','D2','G2']) — plays each in sequence
function _fcTestAll(notes) {
    if (!notes || notes.length === 0) {
        notes = ['E1', 'A1', 'D2', 'G2']; // open bass strings
    }
    console.log(`[fcTest] === Batch test: ${notes.join(', ')} ===`);
    console.log(`[fcTest] Play each note when prompted. 10s timeout per note.`);
    let i = 0;
    const results = [];
    function next() {
        if (i >= notes.length) {
            const correct = results.filter(r => r.hit).length;
            console.log(`[fcTest] === Results: ${correct}/${results.length} correct ===`);
            for (const r of results) {
                console.log(`  ${r.hit ? '✓' : '✗'} ${r.target} → ${r.detected || 'timeout'} (${r.cents != null ? (r.cents > 0 ? '+' : '') + Math.round(r.cents) + '¢' : 'n/a'})`);
            }
            return;
        }
        const target = notes[i];
        const targetMidi = _fcNoteNameToMidi(target);
        console.log(`[fcTest] [${i+1}/${notes.length}] Play: ${target}`);

        const startTime = performance.now();
        let lastStable = _ndStableMidi; // ignore current stable
        const iv = setInterval(() => {
            const elapsed = (performance.now() - startTime) / 1000;
            if (_ndStableMidi >= 0 && _ndStableMidi !== lastStable) {
                lastStable = _ndStableMidi;
                const detectedName = _fcMidiToNoteName(_ndStableMidi);
                const cents = (_ndStableMidi - targetMidi) * 100;
                const hit = Math.abs(cents) <= 50;
                results.push({ target, detected: detectedName, cents, hit });
                console.log(`  ${hit ? '✓' : '✗'} ${detectedName} (${cents > 0 ? '+' : ''}${Math.round(cents)}¢) in ${elapsed.toFixed(1)}s`);
                clearInterval(iv);
                i++;
                setTimeout(next, 500); // brief pause between notes
                return;
            }
            if (elapsed > 10) {
                results.push({ target, detected: null, cents: null, hit: false });
                console.log(`  ✗ TIMEOUT`);
                clearInterval(iv);
                i++;
                setTimeout(next, 500);
            }
        }, 100);
    }
    next();
}

let _ndQuickCalActive = false;
let _ndQuickCalSamples = [];
let _ndQuickCalChartMidis = null; // cached unique expected MIDIs from the chart

function _ndQuickCalibrate() {
    // Build the set of unique expected MIDIs from the chart
    const notes = highway.getNotes() || [];
    const chords = highway.getChords() || [];
    const midiSet = new Set();
    for (const n of notes) {
        if (n.mt) continue;
        midiSet.add(_ndMidiFromStringFret(n.s, n.f));
    }
    for (const c of chords) {
        for (const cn of (c.notes || [])) {
            if (cn.mt) continue;
            midiSet.add(_ndMidiFromStringFret(cn.s, cn.f));
        }
    }
    _ndQuickCalChartMidis = [...midiSet].sort((a, b) => a - b);

    if (_ndQuickCalChartMidis.length === 0) {
        console.log('[quick-cal] No chart notes found. Load a song first.');
        return;
    }

    _ndPitchOffset = 0;
    _ndResetScoring();
    _ndQuickCalSamples = [];
    _ndQuickCalActive = true;

    const midiName = (m) => {
        const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
        const r = Math.round(m);
        return `${names[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
    };

    console.log('=== QUICK PITCH CALIBRATE ===');
    console.log(`Chart has ${_ndQuickCalChartMidis.length} unique pitches: ${_ndQuickCalChartMidis.map(m => midiName(m)).join(', ')}`);
    console.log('Play 5 notes (any notes — song does NOT need to be playing). Listening...');

    let lastStableMidi = -1;
    const check = setInterval(() => {
        if (!_ndQuickCalActive) { clearInterval(check); return; }

        // Use stable MIDI (not raw, to avoid transient jitter)
        const midi = _ndStableMidi;
        if (midi < 0 || midi === lastStableMidi) return;
        if (_ndInputLevel < _ndSilenceGate) return;
        lastStableMidi = midi;

        // Reject octave harmonics — if detected MIDI is more than 14 semitones
        // above the highest chart pitch, YIN probably locked onto a harmonic
        const maxChart = _ndQuickCalChartMidis[_ndQuickCalChartMidis.length - 1];
        if (midi > maxChart + 14) {
            console.log(`[quick-cal] skip: ${midiName(midi)}(${midi}) — likely harmonic (chart max is ${midiName(maxChart)})`);
            return;
        }

        // Find the closest chart MIDI to this detection.
        // Check at offset 0, +1, +2, +3 to detect systematic shifts.
        // Only accept if the closest match is within 0.5 semitones of a
        // whole-number offset — otherwise the note isn't in the chart.
        let bestChart = null, bestOffset = null, bestDist = Infinity;
        for (const tryOffset of [0, 1, 2, -1, -2, 3, -3]) {
            const adjusted = midi - tryOffset;
            for (const cm of _ndQuickCalChartMidis) {
                const d = Math.abs(adjusted - cm);
                if (d < bestDist) {
                    bestDist = d;
                    bestChart = cm;
                    bestOffset = tryOffset;
                }
            }
        }

        // Reject if closest match is more than 0.5 semitones away
        // (the played note isn't near any chart pitch at any reasonable offset)
        if (bestDist > 0.5) {
            console.log(`[quick-cal] skip: played ${midiName(midi)}(${midi}) — not near any chart pitch (closest ${midiName(bestChart)}(${bestChart}), dist ${bestDist.toFixed(1)})`);
            return;
        }

        const offset = midi - bestChart;
        _ndQuickCalSamples.push({ detected: midi, closest: bestChart, offset: Math.round(offset) });

        console.log(`[quick-cal] ${_ndQuickCalSamples.length}/5: played ${midiName(midi)}(${midi}) → chart ${midiName(bestChart)}(${bestChart}) → offset ${offset > 0 ? '+' : ''}${Math.round(offset)} semitones`);

        if (_ndQuickCalSamples.length >= 5) {
            clearInterval(check);
            _ndQuickCalActive = false;

            // Compute mode of rounded offsets
            const offsets = _ndQuickCalSamples.map(s => Math.round(s.offset));
            const votes = new Map();
            for (const o of offsets) votes.set(o, (votes.get(o) || 0) + 1);
            let bestOffset = 0, bestCount = 0;
            for (const [o, c] of votes) {
                if (c > bestCount) { bestOffset = o; bestCount = c; }
            }

            const agreement = bestCount / offsets.length;
            console.log('');
            console.log('=== RESULTS ===');
            console.log(`Offsets: [${offsets.map(o => (o > 0 ? '+' : '') + o).join(', ')}]`);
            console.log(`Mode: ${bestOffset > 0 ? '+' : ''}${bestOffset} semitones (${(agreement * 100).toFixed(0)}% agreement)`);

            if (bestOffset !== 0 && agreement >= 0.6) {
                _ndPitchOffset = bestOffset;
                _ndSaveSettings();
                _ndResetScoring();
                console.log(`APPLIED: pitch offset = ${bestOffset > 0 ? '+' : ''}${bestOffset} semitones`);
                console.log('Play normally — hits should register now.');
            } else if (bestOffset === 0) {
                console.log('No offset needed — chart pitch matches detection.');
                console.log('If still getting misses, the issue is timing, not pitch.');
            } else {
                console.log(`Low agreement — not auto-applying. Set manually in settings if desired.`);
            }
            console.log('=== END QUICK CALIBRATE ===');
        }
    }, 100);

    // Timeout after 30 seconds
    setTimeout(() => {
        if (_ndQuickCalActive) {
            clearInterval(check);
            _ndQuickCalActive = false;
            console.log(`[quick-cal] Timed out with ${_ndQuickCalSamples.length}/5 samples.`);
            if (_ndQuickCalSamples.length > 0) {
                console.log('Partial results:', _ndQuickCalSamples.map(s =>
                    `played ${s.detected} closest ${s.closest} offset ${s.offset > 0 ? '+' : ''}${s.offset}`
                ).join(', '));
            } else {
                console.log('No detections at all. Check: is detection enabled? Is input level above the silence gate?');
            }
        }
    }, 30000);
}

function _ndDiagRender(panel) {
    const t = highway.getTime();
    const notes = highway.getNotes() || [];
    const chords = highway.getChords() || [];
    const info = highway.getSongInfo ? highway.getSongInfo() : {};
    const total = _ndHits + _ndMisses;
    const acc = total > 0 ? Math.round((_ndHits / total) * 100) : 0;
    const P = (c, t) => `<span style="color:${c}">${t}</span>`;

    // Count result types
    let rHits = 0, rPitchMiss = 0, rTimingMiss = 0;
    const recentResults = [];
    _ndNoteResults.forEach((v, k) => {
        if (typeof v === 'object') {
            if (v.primary === 'HIT') rHits++;
            else if (v.primary === 'MISSED_WRONG_PITCH') rPitchMiss++;
            else if (v.primary === 'MISSED_NO_DETECTION') rTimingMiss++;
        }
        recentResults.push({ key: k, judgment: v });
    });

    // Last 8 event log entries — show expected vs detected MIDI for debugging
    const midiName = (m) => {
        if (m < 0 || !isFinite(m)) return '?';
        const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
        const r = Math.round(m);
        return `${names[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
    };
    const lastEvents = _ndEventLog.slice(-8).map(e => {
        const dt = `${e.dtMs > 0 ? '+' : ''}${Math.round(e.dtMs)}ms`;
        const cents = `${e.centsErr > 0 ? '+' : ''}${Math.round(e.centsErr)}\u00a2`;
        const det = e.detectedMidi ? `det:${midiName(e.detectedMidi)}(${e.detectedMidi.toFixed(0)})` : '';
        const exp = e.expectedMidi ? `exp:${midiName(e.expectedMidi)}(${e.expectedMidi})` : '';
        const note = e.chartNote || '';
        return e.hit
            ? P('#0f8', `HIT  ${note} ${dt} ${cents} ${det} ${exp}`)
            : P('#f44', `MISS ${note} ${dt} ${cents} ${det} ${exp}`);
    }).join('<br>');

    // Nearby chart notes with their judgment status
    const nearby = [];
    for (const n of notes) {
        if (n.mt) continue;
        if (n.t < t - 4 || n.t > t + 4) continue;
        const key = _ndNoteKey(n, n.t);
        const j = _ndNoteResults.get(key);
        const dt = ((n.t - t) * 1000).toFixed(0);
        let status = P('#555', 'PENDING');
        if (j) {
            const p = typeof j === 'object' ? j.primary : j;
            if (p === 'HIT') status = P('#0f8', 'HIT');
            else if (p === 'MISSED_WRONG_PITCH') status = P('#f64', 'PITCH\u2717');
            else if (p === 'MISSED_NO_DETECTION') status = P('#f24', 'NO DET');
            else status = P('#fc0', String(p));
        }
        nearby.push(`s${n.s}/f${n.f} ${dt}ms ${status}`);
        if (nearby.length >= 12) break;
    }

    // Detection state
    const detMidi = _ndDetectedMidi > 0 ? _ndDetectedMidi.toFixed(1) : '—';
    const detConf = _ndDetectedConfidence.toFixed(2);
    const detStr = _ndDetectedString >= 0 ? `s${_ndDetectedString}/f${_ndDetectedFret}` : '—';
    const level = _ndInputLevel.toFixed(3);
    const gateOk = _ndInputLevel >= _ndSilenceGate;

    const avOff = (highway.getAvOffset ? highway.getAvOffset() : 0);
    const matchT = t + avOff / 1000 - _ndDetectionLatencySec;

    panel.innerHTML = `
<div style="display:flex;gap:24px;flex-wrap:wrap;align-items:start">
  <div style="min-width:180px">
    <b>Detection</b><br>
    MIDI: ${detMidi}  conf: ${detConf}  ${detStr}<br>
    Level: ${gateOk ? P('#0f8', level) : P('#f44', level + ' &lt; gate')}  Gate: ${(_ndSilenceGate * 100).toFixed(0)}%<br>
    Method: ${_ndDetectionMethod}  Stable: ${_ndStableMidi >= 0 ? _ndStableMidi : '—'}
  </div>
  <div style="min-width:180px">
    <b>Scoring</b><br>
    ${acc}% (${_ndHits}/${total})  streak: ${_ndStreak}  best: ${_ndBestStreak}<br>
    ${P('#0f8', `hit:${rHits}`)}  ${P('#f64', `pitch\u2717:${rPitchMiss}`)}  ${P('#f24', `no-det:${rTimingMiss}`)}<br>
    early:${_ndEarly} late:${_ndLate} sharp:${_ndSharp} flat:${_ndFlat}
  </div>
  <div style="min-width:200px">
    <b>Timing</b><br>
    chart: ${t.toFixed(2)}s  match: ${matchT.toFixed(2)}s  \u0394=${((matchT - t) * 1000).toFixed(0)}ms<br>
    AV: ${avOff.toFixed(0)}ms  latency: ${(_ndDetectionLatencySec * 1000).toFixed(0)}ms<br>
    tol: ${(_ndTimingTolerance * 1000).toFixed(0)}ms / ${_ndPitchTolerance}\u00a2<br>
    pitch offset: ${_ndPitchOffset >= 0 ? '+' : ''}${_ndPitchOffset} semitones
  </div>
  <div style="min-width:120px">
    <b>Actions</b><br>
    <button onclick="_ndQuickCalibrate()" style="cursor:pointer;background:#436;color:#c8f;border:2px solid #658;padding:4px 12px;border-radius:3px;font:12px monospace;margin:1px;font-weight:bold">Quick Calibrate</button><br>
    <button id="nd-diag-pause-btn" onclick="_ndDiagTogglePause()" style="cursor:pointer;background:#553;color:#fc4;border:1px solid #774;padding:2px 8px;border-radius:3px;font:11px monospace;margin:1px;font-weight:bold">Pause</button>
    <button onclick="_ndDiagDumpToConsole()" style="cursor:pointer;background:#335;color:#8cf;border:1px solid #558;padding:2px 8px;border-radius:3px;font:11px monospace;margin:1px">Dump</button><br>
    <button onclick="_ndDiagInjectMisses()" style="cursor:pointer;background:#422;color:#f88;border:1px solid #644;padding:2px 8px;border-radius:3px;font:11px monospace;margin:1px">Force misses</button>
    <button onclick="_ndDiagInjectHits()" style="cursor:pointer;background:#242;color:#8f8;border:1px solid #464;padding:2px 8px;border-radius:3px;font:11px monospace;margin:1px">Force hits</button><br>
    <button onclick="_ndResetScoring()" style="cursor:pointer;background:#333;color:#aaa;border:1px solid #555;padding:2px 8px;border-radius:3px;font:11px monospace;margin:1px">Reset</button>
    <button onclick="_ndCloseDiag()" style="cursor:pointer;background:#222;color:#666;border:1px solid #444;padding:2px 8px;border-radius:3px;font:11px monospace;margin:1px">Close</button>
  </div>
</div>
<div style="margin-top:4px;border-top:1px solid #222;padding-top:4px">
  <b>Match log</b> (detected → expected):<br>
  ${lastEvents || P('#555', '(no attempts)')}<br>
  <b>Nearby notes:</b> ${nearby.join('  ') || P('#555', '(none in \u00b14s)')}<br>
  <b>Arrangement:</b> ${_ndCurrentArrangement}  <b>Tuning:</b> [${_ndTuningOffsets.slice(0, _ndStandardMidiFor(_ndCurrentArrangement).length).join(',')}]  <b>Capo:</b> ${_ndCapo}
</div>`;
}

function _ndDiagInjectMisses() {
    const t = highway.getTime();
    const notes = highway.getNotes() || [];
    let count = 0;
    // Search backwards from current time — 15s lookback for sparse charts
    for (let i = notes.length - 1; i >= 0; i--) {
        const n = notes[i];
        if (n.mt) continue;
        if (n.t > t - 0.1) continue;   // skip future / just-now notes
        if (n.t < t - 15) break;       // 15s lookback
        const key = _ndNoteKey(n, n.t);
        _ndNoteResults.set(key, {
            primary: count % 2 === 0 ? 'MISSED_NO_DETECTION' : 'MISSED_WRONG_PITCH',
            labels: [],
            timingError: count % 2 === 0 ? null : 120,
            pitchError: count % 2 === 0 ? null : 35,
            detectedMidi: null,
            expectedMidi: _ndMidiFromStringFret(n.s, n.f),
        });
        count++;
        if (count >= 10) break;
    }
    console.log(`[nd-diag] Injected ${count} fake misses across ${notes.length} total notes. t=${t.toFixed(1)}s`);
}

function _ndDiagInjectHits() {
    const t = highway.getTime();
    const notes = highway.getNotes() || [];
    let count = 0;
    for (let i = notes.length - 1; i >= 0; i--) {
        const n = notes[i];
        if (n.mt) continue;
        if (n.t > t - 0.1) continue;
        if (n.t < t - 15) break;      // 15s lookback
        const key = _ndNoteKey(n, n.t);
        const expectedMidi = _ndMidiFromStringFret(n.s, n.f);
        _ndNoteResults.set(key, {
            primary: 'HIT',
            labels: count % 3 === 0 ? ['LATE'] : [],
            timingError: count % 3 === 0 ? 85 : 10,
            pitchError: count % 2 === 0 ? 15 : -8,
            detectedMidi: expectedMidi,
            expectedMidi,
        });
        count++;
        if (count >= 10) break;
    }
    console.log(`[nd-diag] Injected ${count} fake hits across ${notes.length} total notes. t=${t.toFixed(1)}s`);
}

// ── Programmatic Audio Test Harness ───────────────────────────────────────
// Injects synthetic sine-wave audio into the detection pipeline via
// OscillatorNode → same gain/analyser/processor chain as the mic.
// No guitar, no human, no browser interaction needed.

let _ndTestOscillators = [];
let _ndTestGainNode = null;

function _ndMidiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Inject a sequence of synthetic notes into the detection pipeline.
 * @param {Array<{midi: number, startTime: number, duration: number}>} noteSequence
 * @param {object} [options]
 * @param {number} [options.amplitude=0.3] - oscillator amplitude (0-1)
 * @param {string} [options.waveform='sine'] - oscillator waveform
 * @returns {Promise<{hits: number, misses: number, total: number, noteResults: Array}>}
 */
async function _ndInjectTestAudio(noteSequence, options = {}) {
    const amplitude = options.amplitude ?? 0.3;
    const waveform = options.waveform ?? 'sine';

    // Stop any existing test oscillators
    _ndTestCleanup();

    // Create AudioContext if not already running
    if (!_ndAudioCtx) {
        _ndAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        _ndResetBpFilter(_ndAudioCtx.sampleRate);
    }
    if (_ndAudioCtx.state === 'suspended') {
        await _ndAudioCtx.resume();
    }

    // Build processing chain if not already set up (mirrors _ndStartAudio but
    // without getUserMedia). If the mic chain is already running, tap into it.
    let processorNode = _ndWorklet;
    if (!processorNode) {
        const processor = _ndAudioCtx.createScriptProcessor(_ndFrameSize, 1, 1);
        _ndWorklet = processor;
        _ndAccumBuffer = new Float32Array(0);
        _ndPendingBuffer = null;

        processor.onaudioprocess = (e) => {
            _ndProcessAudioChunk(e.inputBuffer.getChannelData(0));
        };

        processor.connect(_ndAudioCtx.destination);
        processorNode = processor;

        // Start detection timer if not running
        if (!_ndDetectInterval) {
            _ndDetectInterval = setInterval(() => {
                if (_ndPendingBuffer) {
                    const buf = _ndPendingBuffer;
                    _ndPendingBuffer = null;
                    _ndProcessFrame(buf);
                }
            }, 25);
        }

        // Start level meter for silence gate
        if (!_ndLevelAnalyser) {
            _ndLevelAnalyser = _ndAudioCtx.createAnalyser();
            _ndLevelAnalyser.fftSize = 512;
            _ndLevelAnalyser.smoothingTimeConstant = 0.8;
        }
        _ndStartLevelMeter();
    }

    // Gain node for test oscillators
    _ndTestGainNode = _ndAudioCtx.createGain();
    _ndTestGainNode.gain.value = amplitude;

    // Connect test gain → analyser → processor (same chain as mic)
    if (_ndLevelAnalyser) {
        _ndTestGainNode.connect(_ndLevelAnalyser);
        _ndLevelAnalyser.connect(processorNode);
    } else {
        _ndTestGainNode.connect(processorNode);
    }

    // Reset scoring
    _ndResetScoring();
    _ndEnabled = true;

    // Schedule oscillators
    const baseTime = _ndAudioCtx.currentTime + 0.1; // small buffer
    const lastNote = noteSequence[noteSequence.length - 1];
    const totalDuration = lastNote.startTime + lastNote.duration + 0.5; // +0.5s padding

    // Harmonics mode: generate fundamental + overtones matching a real bass string
    // Bass strings have strong 2nd harmonic (octave), weaker 3rd, 4th.
    const harmonics = options.harmonics ?? false;  // true = add overtones
    const harmonicAmplitudes = options.harmonicAmplitudes ?? [1.0, 0.5, 0.25, 0.12]; // fund, 2nd, 3rd, 4th

    // Sustain overlap: extend note duration to bleed into the next note
    const sustainOverlapSec = options.sustainOverlap ?? 0; // seconds of overlap

    // Attack noise: add broadband burst at note onset
    const attackNoiseSec = options.attackNoise ?? 0; // seconds of noise burst

    // Amplitude envelope: simulate real string (sharp attack, exponential decay)
    // When enabled, the onset detector can see energy spikes between notes.
    const useEnvelope = options.envelope ?? (sustainOverlapSec > 0); // auto-enable with overlap

    for (let i = 0; i < noteSequence.length; i++) {
        const note = noteSequence[i];
        const freq = _ndMidiToFreq(note.midi);
        let dur = note.duration;
        if (sustainOverlapSec > 0 && i < noteSequence.length - 1) {
            const gap = noteSequence[i + 1].startTime - note.startTime;
            dur = gap + sustainOverlapSec; // extend into next note
        }

        // Create envelope gain node for this note (attack + exponential decay)
        let noteGain = _ndTestGainNode; // default: flat amplitude
        if (useEnvelope) {
            noteGain = _ndAudioCtx.createGain();
            noteGain.connect(_ndTestGainNode);
            const t0 = baseTime + note.startTime;
            noteGain.gain.setValueAtTime(0, t0);
            noteGain.gain.linearRampToValueAtTime(1.0, t0 + 0.005); // 5ms attack
            noteGain.gain.exponentialRampToValueAtTime(0.15, t0 + dur); // decay to 15%
        }

        if (harmonics) {
            for (let h = 0; h < harmonicAmplitudes.length; h++) {
                const hFreq = freq * (h + 1);
                if (hFreq > 20000) break;
                const hGain = _ndAudioCtx.createGain();
                hGain.gain.value = harmonicAmplitudes[h];
                hGain.connect(noteGain);
                const osc = _ndAudioCtx.createOscillator();
                osc.type = 'sine';
                osc.frequency.value = hFreq;
                osc.connect(hGain);
                osc.start(baseTime + note.startTime);
                osc.stop(baseTime + note.startTime + dur);
                _ndTestOscillators.push(osc);
            }
        } else {
            const osc = _ndAudioCtx.createOscillator();
            osc.type = waveform;
            osc.frequency.value = freq;
            osc.connect(noteGain);
            osc.start(baseTime + note.startTime);
            osc.stop(baseTime + note.startTime + dur);
            _ndTestOscillators.push(osc);
        }

        // Attack noise burst at note onset
        if (attackNoiseSec > 0) {
            const noiseLen = Math.ceil(_ndAudioCtx.sampleRate * attackNoiseSec);
            const noiseBuf = _ndAudioCtx.createBuffer(1, noiseLen, _ndAudioCtx.sampleRate);
            const noiseData = noiseBuf.getChannelData(0);
            for (let j = 0; j < noiseLen; j++) noiseData[j] = (Math.random() * 2 - 1) * 0.3;
            const noiseSrc = _ndAudioCtx.createBufferSource();
            noiseSrc.buffer = noiseBuf;
            noiseSrc.connect(_ndTestGainNode);
            noiseSrc.start(baseTime + note.startTime);
            _ndTestOscillators.push(noiseSrc);
        }
    }

    console.log(`[nd-test] Injecting ${noteSequence.length} notes over ${totalDuration.toFixed(1)}s`);

    // Wait for all oscillators to finish + detection pipeline to drain
    await new Promise(resolve => setTimeout(resolve, (totalDuration + 1) * 1000));

    // Collect results
    const results = [];
    _ndNoteResults.forEach((v, k) => results.push({ key: k, ...v }));

    const summary = {
        hits: _ndHits,
        misses: _ndMisses,
        pitchMisses: _ndPitchMisses,
        timingMisses: _ndTimingMisses,
        total: _ndHits + _ndMisses,
        hitRate: _ndHits + _ndMisses > 0 ? (_ndHits / (_ndHits + _ndMisses) * 100).toFixed(1) : '0.0',
        noteResults: results,
        settings: {
            latencyOffset: _ndDetectionLatencySec,
            timingTolerance: _ndTimingTolerance,
            pitchTolerance: _ndPitchTolerance,
            silenceGate: _ndSilenceGate,
            stabilityWindow: _ND_STABILITY_WINDOW,
            stabilityRequired: _ND_STABILITY_REQUIRED,
        },
    };

    // Auto-dump to server
    _ndAutoDumpPost();

    console.log(`[nd-test] Done: ${summary.hits}/${summary.total} hits (${summary.hitRate}%)`);
    _ndTestCleanup();
    return summary;
}

function _ndTestCleanup() {
    for (const osc of _ndTestOscillators) {
        try { osc.stop(); osc.disconnect(); } catch (e) { /* already stopped */ }
    }
    _ndTestOscillators = [];
    if (_ndTestGainNode) {
        try { _ndTestGainNode.disconnect(); } catch (e) {}
        _ndTestGainNode = null;
    }
}

/**
 * Replay a recorded WAV file through the detection pipeline.
 * Routes the audio through the same gain → analyser → processor chain.
 * @param {string} wavUrl - URL of the WAV file (can be a blob URL or server path)
 * @param {number} [durationSec] - override duration (auto-detected from buffer if omitted)
 * @returns {Promise<{hits, misses, total, hitRate, noteResults}>}
 */
async function _ndInjectTestWav(wavUrl, durationSec) {
    _ndTestCleanup();

    if (!_ndAudioCtx) {
        _ndAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        _ndResetBpFilter(_ndAudioCtx.sampleRate);
    }
    if (_ndAudioCtx.state === 'suspended') await _ndAudioCtx.resume();

    // Reuse _ndInjectTestAudio's setup for processing chain
    // (call with empty sequence to set up, then inject our own source)
    // Actually, just set up the chain manually:
    let processorNode = _ndWorklet;
    if (!processorNode) {
        const processor = _ndAudioCtx.createScriptProcessor(_ndFrameSize, 1, 1);
        _ndWorklet = processor;
        _ndAccumBuffer = new Float32Array(0);
        _ndPendingBuffer = null;
        processor.onaudioprocess = (e) => {
            _ndProcessAudioChunk(e.inputBuffer.getChannelData(0));
        };
        processor.connect(_ndAudioCtx.destination);
        processorNode = processor;
        if (!_ndDetectInterval) {
            _ndDetectInterval = setInterval(() => {
                if (_ndPendingBuffer) {
                    const buf = _ndPendingBuffer;
                    _ndPendingBuffer = null;
                    _ndProcessFrame(buf);
                }
            }, 25);
        }
        if (!_ndLevelAnalyser) {
            _ndLevelAnalyser = _ndAudioCtx.createAnalyser();
            _ndLevelAnalyser.fftSize = 512;
            _ndLevelAnalyser.smoothingTimeConstant = 0.8;
        }
        _ndStartLevelMeter();
    }

    _ndTestGainNode = _ndAudioCtx.createGain();
    _ndTestGainNode.gain.value = 1.0;
    if (_ndLevelAnalyser) {
        _ndTestGainNode.connect(_ndLevelAnalyser);
        _ndLevelAnalyser.connect(processorNode);
    } else {
        _ndTestGainNode.connect(processorNode);
    }

    _ndResetScoring();
    _ndEnabled = true;

    // Fetch and decode the WAV
    console.log(`[nd-test] Loading WAV: ${wavUrl}`);
    const response = await fetch(wavUrl);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await _ndAudioCtx.decodeAudioData(arrayBuffer);
    const dur = durationSec ?? audioBuffer.duration;
    console.log(`[nd-test] WAV loaded: ${audioBuffer.duration.toFixed(1)}s, ${audioBuffer.sampleRate}Hz, ${audioBuffer.numberOfChannels}ch`);

    const source = _ndAudioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(_ndTestGainNode);
    // Schedule on the audio clock with a small lookahead so the graph has
    // time to flush. The anchor is the scheduled audio-clock time, not
    // performance.now() — the two drift independently. See
    // docs/WAV_ALIGNMENT_ISSUE.md items #2 and #3.
    const wavPlaybackLookaheadSec = 0.05;
    const wavPlaybackStartAudio = _ndAudioCtx.currentTime + wavPlaybackLookaheadSec;
    source.start(wavPlaybackStartAudio);
    window._ndTestWavPlaybackStartAudio = wavPlaybackStartAudio;
    _ndTestOscillators.push(source);

    // Wait for lookahead + playback + pipeline drain
    await new Promise(r => setTimeout(r, (wavPlaybackLookaheadSec + dur + 1.5) * 1000));

    // Force miss checking — the draw hook (which normally calls _ndCheckMisses)
    // may not be running in headless mode. The miss checker only scans 1s behind
    // the deadline per call (designed for per-frame use), so sweep through the
    // entire chart by advancing the mock time and calling repeatedly.
    if (typeof _ndCheckMisses === 'function') {
        const notes = highway.getNotes() || [];
        if (notes.length > 0) {
            const lastNoteTime = notes[notes.length - 1].t;
            // Temporarily advance highway time past all notes
            const savedGetTime = highway.getTime;
            const sweepEnd = lastNoteTime + 2; // 2s past last note
            for (let sweepT = 0; sweepT <= sweepEnd; sweepT += 0.5) {
                highway.getTime = () => sweepT + _ndDetectionLatencySec;
                _ndCheckMisses();
            }
            highway.getTime = savedGetTime;
        }
    }

    const results = [];
    _ndNoteResults.forEach((v, k) => results.push({ key: k, ...v }));

    const summary = {
        hits: _ndHits,
        misses: _ndMisses,
        pitchMisses: _ndPitchMisses,
        timingMisses: _ndTimingMisses,
        total: _ndHits + _ndMisses,
        hitRate: _ndHits + _ndMisses > 0 ? (_ndHits / (_ndHits + _ndMisses) * 100).toFixed(1) : '0.0',
        noteResults: results,
        settings: {
            latencyOffset: _ndDetectionLatencySec,
            timingTolerance: _ndTimingTolerance,
            pitchTolerance: _ndPitchTolerance,
            silenceGate: _ndSilenceGate,
            stabilityWindow: _ND_STABILITY_WINDOW,
            stabilityRequired: _ND_STABILITY_REQUIRED,
        },
    };

    _ndAutoDumpPost();
    console.log(`[nd-test] WAV done: ${summary.hits}/${summary.total} hits (${summary.hitRate}%)`);
    _ndTestCleanup();
    return summary;
}

/**
 * Generate a test sequence from the current chart. Plays every note
 * as a perfect sine wave at the exact chart time.
 * @param {object} [options]
 * @param {number} [options.maxNotes=50] - limit notes to test
 * @param {number} [options.noteDuration=0.3] - duration of each sine burst (seconds)
 * @returns {Array<{midi, startTime, duration, chartNote}>}
 */
function _ndTestBuildChartSequence(options = {}) {
    const maxNotes = options.maxNotes ?? 50;
    const noteDuration = options.noteDuration ?? 0.3;

    const notes = highway.getNotes() || [];
    const chords = highway.getChords() || [];

    // Collect all notes with their chart times
    const allNotes = [];
    for (const n of notes) {
        if (n.mt) continue; // skip muted
        const midi = _ndMidiFromStringFret(n.s, n.f);
        allNotes.push({ midi, t: n.t, s: n.s, f: n.f });
    }
    for (const c of chords) {
        for (const cn of (c.notes || [])) {
            if (cn.mt) continue;
            const midi = _ndMidiFromStringFret(cn.s, cn.f);
            allNotes.push({ midi, t: c.t, s: cn.s, f: cn.f });
        }
    }

    // Sort by time
    allNotes.sort((a, b) => a.t - b.t);

    // Take first maxNotes
    const selected = allNotes.slice(0, maxNotes);
    if (selected.length === 0) {
        console.error('[nd-test] No chart notes found. Load a song first.');
        return [];
    }

    // Offset so the first note starts at t=0
    const baseTime = selected[0].t;
    const sequence = selected.map(n => ({
        midi: n.midi,
        startTime: n.t - baseTime,
        duration: Math.min(noteDuration, // cap at noteDuration
            // but don't overlap the next note
            selected.indexOf(n) < selected.length - 1
                ? Math.max(0.05, (selected[selected.indexOf(n) + 1].t - n.t) * 0.8)
                : noteDuration),
        chartNote: `s${n.s}/f${n.f}`,
    }));

    console.log(`[nd-test] Built sequence: ${sequence.length} notes from chart time ${baseTime.toFixed(3)}s to ${(selected[selected.length - 1].t).toFixed(3)}s`);
    return sequence;
}

/**
 * Run a perfect-play test against the current chart.
 * Generates sine waves matching every chart note and verifies detection.
 *
 * IMPORTANT: This tests the detection pipeline only (YIN + stability + matching).
 * It does NOT test mic input, real instrument harmonics, or browser audio latency.
 * The highway must be playing (or have notes loaded) for chart matching to work.
 *
 * @returns {Promise<{hits, misses, total, hitRate, noteResults}>}
 */
async function _ndTestPerfectPlay(options = {}) {
    const sequence = _ndTestBuildChartSequence(options);
    if (sequence.length === 0) return null;

    // The test needs to sync with the highway's time. Since we can't control
    // the highway clock, we use a different approach: inject audio while the
    // highway is NOT playing, and mock highway.getTime() to advance in sync
    // with our oscillator schedule.
    //
    // Save the real getTime and replace it with one that tracks our test timeline.
    const realGetTime = highway.getTime.bind(highway);
    const realGetAvOffset = highway.getAvOffset ? highway.getAvOffset.bind(highway) : () => 0;
    const baseChartTime = (highway.getNotes() || [])[0]?.t ?? 0;

    let testStartPerf = 0;

    highway.getTime = () => {
        if (testStartPerf === 0) return realGetTime();
        // Map wall-clock elapsed time to chart time. The pipeline's natural
        // detection delay (~400ms) is the latency that _ndDetectionLatencySec
        // compensates in scoreT. Don't add it here — that would double-count.
        const elapsed = (performance.now() - testStartPerf) / 1000;
        return baseChartTime + elapsed;
    };
    // Zero out AV offset during test — we're injecting directly, no audio output lag
    highway.getAvOffset = () => 0;

    console.log(`[nd-test] Starting perfect-play test: ${sequence.length} notes, base chart time ${baseChartTime.toFixed(3)}s`);
    console.log(`[nd-test] Latency offset: ${(_ndDetectionLatencySec * 1000).toFixed(0)}ms`);

    testStartPerf = performance.now();

    const result = await _ndInjectTestAudio(sequence, options);

    // Restore real highway functions
    highway.getTime = realGetTime;
    highway.getAvOffset = realGetAvOffset;

    // Log detailed results
    console.log('[nd-test] === RESULTS ===');
    console.log(`[nd-test] Hit rate: ${result.hits}/${result.total} (${result.hitRate}%)`);
    if (result.noteResults.length > 0) {
        console.log('[nd-test] Note details:');
        for (const r of result.noteResults) {
            const te = r.timingError != null ? `${Math.round(r.timingError)}ms` : '—';
            console.log(`[nd-test]   ${r.key} → ${r.primary} timing=${te} det:${r.detectedMidi} exp:${r.expectedMidi}`);
        }
    }

    // Expose for Puppeteer
    window._ndTestResult = result;
    return result;
}

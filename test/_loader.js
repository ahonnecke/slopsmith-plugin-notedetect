// Load screen.js into a Node vm context with minimal DOM/browser stubs
// so pure detection functions can be exercised by tests without a browser.
//
// Rationale: screen.js is shipped as a single browser script (no module exports).
// Copy-pasting its functions into a test module would drift. This loader runs
// the real script against stubs and pulls the named top-level function
// declarations off the sandbox.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT_PATH = path.join(__dirname, '..', 'screen.js');

function makeSandbox() {
    const noop = () => {};
    const elementStub = new Proxy({}, {
        get: (_, prop) => {
            if (prop === 'style') return {};
            if (prop === 'classList') return { add: noop, remove: noop, toggle: noop };
            if (prop === 'addEventListener' || prop === 'removeEventListener') return noop;
            if (prop === 'appendChild' || prop === 'removeChild') return noop;
            if (prop === 'querySelector' || prop === 'querySelectorAll') return () => null;
            return '';
        },
        set: () => true,
    });

    const documentStub = {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => elementStub,
        head: elementStub,
        body: elementStub,
        addEventListener: noop,
    };

    const localStorageStub = {
        getItem: () => null,
        setItem: noop,
        removeItem: noop,
    };

    const navigatorStub = {
        mediaDevices: {
            getUserMedia: () => Promise.reject(new Error('not available in vm')),
            enumerateDevices: () => Promise.resolve([]),
        },
    };

    return {
        document: documentStub,
        localStorage: localStorageStub,
        navigator: navigatorStub,
        window: {},
        location: { protocol: 'http:', host: 'localhost' },
        console,
        setTimeout, clearTimeout,
        setInterval: () => 0,
        clearInterval: noop,
        requestAnimationFrame: () => 0,
        cancelAnimationFrame: noop,
        Float32Array, Int16Array, Uint8Array, Array, Map, Set, Date, Math, JSON, Error,
        Promise,
        // EventTarget / CustomEvent are needed by the NotesBus IIFE at the top
        // of screen.js; vm contexts don't inherit these globals. Without them
        // the script aborts at line ~76 and downstream let/const declarations
        // stay in the TDZ, breaking every test that touches them.
        EventTarget, CustomEvent,
        // fetch is called by the auto-dump and play-snapshot paths; the IIFEs
        // don't invoke it at top level, but defensive stubbing avoids surprises.
        fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
        // Highway API stub — plugin's IIFE at bottom reads window.playSong
        highway: { getTime: () => 0, getNotes: () => [], getSongInfo: () => ({}) },
    };
}

function loadDetectionCore() {
    const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    const sandbox = makeSandbox();
    vm.createContext(sandbox);
    // Script may throw while executing setup code that touches DOM edge cases —
    // function declarations at top level still get hoisted onto the sandbox
    // before any thrown error, so we swallow the throw and grab what we need.
    try {
        vm.runInContext(src, sandbox, { filename: 'screen.js' });
    } catch (err) {
        if (process.env.TEST_DEBUG) console.error('[loader] screen.js threw:', err.message);
    }

    const required = [
        '_ndYinDetect', '_ndFreqToMidi',
        '_ndMidiFromStringFret', '_ndMidiToStringFret',
        '_ndResolveDisplayFingering',
        '_ndSeverity', '_ndRankPracticeNotes', '_ndDescribeFailureMode',
        '_ndAggregatePlayErrors', '_ndBinErrors',
        '_ndBuildTroubleMap', '_ndTroubleKey',
        '_ndComputeTop3Prescriptions',
        '_ndChartHasNoteWithin',
        '_ndCalibFromHistory',
        '_ndApplyStrictness',
    ];
    const missing = required.filter(name => typeof sandbox[name] !== 'function');
    if (missing.length) {
        throw new Error(`Could not extract functions from screen.js: ${missing.join(', ')}`);
    }

    // Objects created inside the vm sandbox have the sandbox's Object.prototype,
    // so node:assert's deepEqual sees them as structurally-equal-but-not-reference-equal.
    // Rewrap returned {string, fret} objects as plain main-realm literals.
    const rewrapSf = (fn) => (...args) => {
        const r = fn(...args);
        return { string: r.string, fret: r.fret };
    };
    const rewrapYin = (fn) => (...args) => {
        const r = fn(...args);
        return { freq: r.freq, confidence: r.confidence, underBuffered: r.underBuffered };
    };

    return {
        yinDetect: rewrapYin(sandbox._ndYinDetect),
        freqToMidi: sandbox._ndFreqToMidi,
        midiFromStringFret: sandbox._ndMidiFromStringFret,
        midiToStringFret: rewrapSf(sandbox._ndMidiToStringFret),
        resolveDisplayFingering: rewrapSf(sandbox._ndResolveDisplayFingering),
        severity: sandbox._ndSeverity,
        rankPracticeNotes: sandbox._ndRankPracticeNotes,
        describeFailureMode: sandbox._ndDescribeFailureMode,
        aggregatePlayErrors: sandbox._ndAggregatePlayErrors,
        binErrors: sandbox._ndBinErrors,
        buildTroubleMap: sandbox._ndBuildTroubleMap,
        troubleKey: sandbox._ndTroubleKey,
        computeTop3Prescriptions: sandbox._ndComputeTop3Prescriptions,
        chartHasNoteWithin: sandbox._ndChartHasNoteWithin,
        calibFromHistory: sandbox._ndCalibFromHistory,
        applyStrictness: sandbox._ndApplyStrictness,
        aggregateTroubleAcrossPlays: sandbox._ndAggregateTroubleAcrossPlays,
        perNoteCoaching: sandbox._ndPerNoteCoaching,
        computeTimelineBins: sandbox._ndComputeTimelineBins,
        computeFretboardHeatmap: sandbox._ndComputeFretboardHeatmap,
        likelyDetectorFailures: sandbox._ndLikelyDetectorFailures,
        filterDetectorFailures: sandbox._ndFilterDetectorFailures,
        detectTuningMismatch: sandbox._ndDetectTuningMismatch,
        // Coaching review pure functions — exposed so the test harness
        // can drive them with synthetic / real noteResults fixtures and
        // assert the output without a browser or live performance.
        scoresFromNotes: sandbox._ndScoresFromNotes,
        findMissClusters: sandbox._ndFindMissClusters,
        analyzeCluster: sandbox._ndAnalyzeCluster,
        aggregateBySection: sandbox._ndAggregateBySection,
        computeTimeHeatmap: sandbox._ndComputeTimeHeatmap,
        computeScoreDeltas: sandbox._ndComputeScoreDeltas,
        findOverlappingPriorCluster: sandbox._ndFindOverlappingPriorCluster,
        isInDrillJudgment: sandbox._ndIsInDrillJudgment,
        checkJudgmentRange: sandbox._ndCheckJudgmentRange,
        isDuplicateLoop: sandbox._ndIsDuplicateLoop,
        exportCoachingAnalysis: sandbox._ndExportCoachingAnalysis,
        classifyFailureMode: sandbox._ndClassifyFailureMode,
        // Expose the sandbox so tests can mock highway data + reach into
        // wizard module state (_ndWizBeats, _ndWizDetections, etc).
        _sandbox: sandbox,
    };
}

module.exports = { loadDetectionCore };

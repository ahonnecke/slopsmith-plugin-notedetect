// Scoring-watchdog tests — the fail-fast alarm for "the user is playing a
// song with Detect wanted on, but nothing is being scored." This is the
// failure that burned a full playthrough: a session_start logged, then zero
// judgments (not even misses), with no on-screen signal until the end-of-song
// summary. The watchdog keys on intent (detectPreference + isPlaying) rather
// than on startAudio succeeding, so it catches BOTH a detector that never came
// up AND a mid-play input drop.
//
// The audio graph and DOM aren't available in the vm sandbox, so we drive a
// single _scoringWatchdogTick() under controlled timing via the _wdProbe hook
// and read _isScoringStalled(). The banner/updateButton calls are DOM no-ops
// in the loader stub.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

// Fresh instance defaults: detectPreference = true, enabled = false.
function freshDetector() {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    return { core, det };
}

test('watchdog: playing + detect wanted + not scoring → stalls (the burned-playthrough case)', () => {
    const { core, det } = freshDetector();
    core.slopsmith.isPlaying = true;                 // song is playing
    const now = Date.now();
    // Play started 5s ago and no audio callback for 5s (detector never came up
    // or its input died). Past the 2.5s grace. Recovery throttled out so the
    // tick doesn't reach into enable()/getUserMedia.
    det._wdProbe({ playStartT: now - 5000, lastCbT: now - 5000, lastRecover: now });
    assert.equal(det._isScoringStalled(), false, 'not stalled before the tick');
    det._scoringWatchdogTick();
    assert.equal(det._isScoringStalled(), true, 'stall surfaced — detect on but nothing scoring');
    det.destroy();
});

test('watchdog: within the post-Play grace window it does NOT false-alarm', () => {
    const { core, det } = freshDetector();
    core.slopsmith.isPlaying = true;
    const now = Date.now();
    // Play just started (100ms ago) — enable()/startAudio hasn't had time to
    // come up yet. No alarm during the grace window.
    det._wdProbe({ playStartT: now - 100, lastCbT: now - 100, lastRecover: now });
    det._scoringWatchdogTick();
    assert.equal(det._isScoringStalled(), false, 'no alarm inside the grace window');
    det.destroy();
});

test('watchdog: a stall clears the moment the song stops playing', () => {
    const { core, det } = freshDetector();
    core.slopsmith.isPlaying = true;
    const now = Date.now();
    det._wdProbe({ playStartT: now - 5000, lastCbT: now - 5000, lastRecover: now });
    det._scoringWatchdogTick();
    assert.equal(det._isScoringStalled(), true, 'stalled while playing');
    // Transport stops → not a failure anymore.
    core.slopsmith.isPlaying = false;
    det._scoringWatchdogTick();
    assert.equal(det._isScoringStalled(), false, 'cleared once playback stops');
    det.destroy();
});

test('watchdog: silent when the user has Detect turned off (detectPreference false)', () => {
    const { core, det } = freshDetector();
    core.slopsmith.isPlaying = true;
    const now = Date.now();
    // Deliberate Detect-off (the button toggle sets detectPreference false).
    det._wdProbe({ detectPref: false, playStartT: now - 5000, lastCbT: now - 5000, lastRecover: now });
    det._scoringWatchdogTick();
    assert.equal(det._isScoringStalled(), false, 'no alarm when the user does not want detection');
    det.destroy();
});

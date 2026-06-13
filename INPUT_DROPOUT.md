# Project: Input Dropout — rig or program?

## The question

Mid-play the audio input goes dead: detection logs a `session_start` and then
scores **zero** judgments (not even misses), or it drops out partway through.
The user reports this is **new** — it wasn't happening before. We need to settle
one fork before fixing anything:

- **Rig/OS** — the Scarlett (USB audio interface) or the OS/browser stops
  delivering audio (USB power management, driver/firmware, sample-rate re-clock,
  audio-focus loss, tab backgrounding). → the fix is on the user's machine.
- **Program** — slopsmith/note_detect stalls its own capture (the deprecated
  main-thread `ScriptProcessor` underruns under load, the `AudioContext` is left
  suspended, a teardown race disconnects the graph). → the fix is in this repo.

Guessing wrong wastes the user's time. So step 1 is **measurement, not a fix.**

## Evidence so far

- `static/note_detect_recordings/live_20260612_145003_*.jsonl` — a full
  "One For The Road" take with ONLY a `session_start` row and zero judgments.
  Every judgment in this app is produced by the audio callback, so zero-of-
  anything = the capture loop was dead for the whole play.
- A known *program-side* sibling already lives at `screen.js` ~2541: a
  `getUserMedia` race makes `startAudio()` return false and silently turns
  Detect off ("~1/3 of sessions died this way"). The 3× retry mitigates it but
  doesn't prove it's the only cause.
- The existing `_inputLost` watch (PR #78) only trips on the MediaStreamTrack
  firing `mute`/`ended`. A Scarlett dropout where the track stays `live` but
  stops delivering audio does NOT fire those — so it went unseen until the
  end-of-song summary.

## Prime hypothesis (program-side — now corroborated by the user)

**The user reports the dropouts began when DSP work started, on an unchanged
device set.** That's a direct correlation with the `proj/bass-detection` rollout
(~2026-06-12): the bigger bass FFT window, the per-string band-energy scorer,
the rolling raw-audio **rescue buffer** (32768 samples), and the always-on
**parallel WAV capture** all add per-frame work to the **deprecated
`createScriptProcessor`** path (`screen.js:2583`), which runs on the **main
thread**. When `processFrame` (the 50 ms detect tick) runs long, the audio
callback can't be serviced in time, `onaudioprocess` stalls, and the capture
goes dead — a NEW failure because the load is new.

**Smoking-gun signal:** `max_cb_gap_ms` in the `input_dropout` record — the
worst gap between audio callbacks this play. Expected ≈ `frameSize/sampleRate`
(~46 ms at 2048/44100). A value in the hundreds–thousands of ms, with
`audio_ctx_state: "running"` and `track_ready: "live"`, **confirms main-thread
starvation** — the device and OS are fine; our DSP is blocking the audio thread.

If confirmed, the fix is to get detection off the main thread (an `AudioWorklet`
for capture and/or a `Worker` for the FFT/scoring), or to shed per-frame cost
(smaller/again-shorter windows, throttle the scorer). The device-drift and
bus-contention leads below drop in priority unless the telemetry points back to
`track_ready: "ended"`.

## Telemetry (shipped — read this to discriminate)

The scoring watchdog now emits an `input_dropout` record the instant scoring
goes dead (console + the session's live JSONL — schema
`note_detect.live.input_dropout.v1`, written by `_logInputDropout` in
`screen.js`). Read it like this:

| Field | Value | Verdict |
|---|---|---|
| `audio_ctx_state` | `suspended` / `interrupted` | **Rig/OS** — the OS or browser parked the AudioContext (backgrounded tab, OS power management, audio-focus loss). |
| `audio_ctx_state` | `running` + `track_ready: "ended"` or `track_muted: true` | **Rig** — the device stopped delivering (USB/driver/Scarlett). The track died under us. |
| `audio_ctx_state` | `running` + `track_ready: "live"` + `track_muted: false` | **Program** — graph alive, device alive, but `onaudioprocess` stopped → main-thread starvation of the ScriptProcessor. Cross-check `processing_frame: true` / high `heap_mb` / `rec_armed: true` (parallel WAV encode) as the load source. |
| `since_last_cb_ms` | large + the above | how long the callback had been dead — sanity-checks the watchdog timing. |

One real occurrence with this record settles the fork.

## Plan

- [x] **Fail-fast + auto-recover** — watchdog surfaces the dead input in ~2s and
      retries (re-enable / re-acquire), throttled. (commit `4d460ca`)
- [x] **Dropout telemetry** — `input_dropout` record with the discriminating
      state (this doc + `_logInputDropout`).
- [ ] **Collect 2–3 occurrences** — user plays normally; each dropout now writes
      a record. Read `audio_ctx_state` + `track_ready` to land the verdict.
- [ ] **If program:** bisect the load — does the dropout stop if the rescue
      buffer / parallel WAV capture / long bass window is disabled? Then migrate
      capture from `ScriptProcessor` → `AudioWorklet` (off the main thread).
- [ ] **If rig:** confirm with the rig checklist below, then the fix is on the
      user's machine — but we keep the watchdog + auto-recover so it degrades
      gracefully instead of silently.

- **2026-06-13 ~05:30 UTC — no repro under full load.** Four complete plays
  (One For The Road ×2, Why'd You Only Call, Creep) all scored (307–374
  judgments each) with **auto-record ON** (WAVs written per play) — i.e. the
  full DSP + parallel-capture load. Zero dropouts, zero `input_dropout` records.
  → The failure is **intermittent**, not every-play. The 14:50 zero-note session
  did not recur this session. Mechanism still UNCONFIRMED — watchdog + telemetry
  are armed; we need the bug to recur to capture `max_cb_gap_ms` / `audio_ctx_
  state`. (Caveat: can't confirm from logs alone that the browser was running
  the telemetry build — `plugin_version` unchanged at 1.24.0. A hard reload
  ensures the next drop is captured.)

- **2026-06-13 ~08:55 — a zero-note play was Detect-OFF, not a dropout.** The
  `08:55` "One For The Road" session logged a `session_start` then ZERO
  judgments AND wrote NO WAV (auto-record only arms when Detect is armed) —
  while `08:48` scored 279 and `08:53` recorded a WAV. So Detect was simply not
  running for that play (`detectPreference` off, or it didn't come up), not a
  mid-play USB dropout. The watchdog didn't fire because we couldn't confirm the
  served build (`plugin_version` was frozen at 1.24.0). Fixed two ways:
  bumped to **1.25.0** (logs now self-identify the build) and added
  `detect_preference` + `enabled` to the `session_start` header (a zero-note
  play is now unambiguous: off vs wanted-but-failed). Also de-duped the
  end-of-play "no notes scored" double-alarm in the coaching panel.
- **2026-06-13 — A/V offset drives BOTH visuals AND detection matching.** User
  re-synced A/V to fix the visual highway and detection accuracy improved
  unexpectedly. Expected, in hindsight: the same `av_offset` maps detected-note
  time → chart time for matching, so a miscalibrated offset (the log showed
  `av_offset_ms: -343`) mismatches real hits into misses/no_detection. Lesson:
  visual A/V calibration *is* detection calibration — keep them coupled. (This
  is a matching-quality effect, separate from the zero-note dropout above:
  a bad offset still produces judgments, just wrong ones; a dropout produces
  none.)

## NEXT

Play a couple of songs on the current build. When a dropout happens (the red
banner appears), grab the `input_dropout` line — from the browser console, or
from the session's `static/note_detect_recordings/live_*.jsonl`. Its
`audio_ctx_state` + `track_ready` decide rig-vs-program in one shot.

## Iterate WITHOUT playing — replay recorded takes (2026-06-13)

Playing a full song to test a change costs ~5 min of human time. We don't need
it: a take is a `(WAV, live_<id>.jsonl)` pair, and the log records every charted
note (`t`/`s`/`f`/`sus`). So:

- `tools/chart-from-log.js <live_*.jsonl>` reconstructs the sloppak-wire chart
  the take played against (no need to locate the original sloppak).
- `tools/replay-take.sh [<wav> <log>]` reconstructs the chart, then sweeps the
  WAV through `tools/harness.js` (the SAME processFrame/matchNotes/checkMisses
  pipeline) across A/V offsets, printing hits + recall per offset. Auto-pairs
  the newest WAV with the newest same-song log if args omitted.

**Open caveat — replay underscores vs live.** On `One For The Road` 085553 the
LIVE take scored 80% (298/372) but headless replay peaks well below that at the
live's av-offset (≈39% at 0–100 ms). The pipeline is identical, so the gap is in
the *conditions*: candidate causes to bisect WITH this loop — (a) the A/V offset
that aligns in replay differs from live (no real-time input latency), so the
sweep must find replay's own peak; (b) analysis-window / frame-size differs
(bass needs a long window — confirm the harness applies `_ndMinAnalysisSamples`);
(c) continuous live AudioContext vs discrete frame feed. Relative iteration
(does change X raise hits?) works today; absolute fidelity is the next target —
and closing it is itself done via this loop, not by playing.

## Rig-side checklist (cheap tests the user can run)

These isolate the device from slopsmith. Each has a clear pass/fail:

1. **Does the Scarlett drop in another app?** Open a DAW / Audacity / OS sound
   input meter, play for a few minutes. *If the level freezes/drops there too →
   it's the rig, not slopsmith.* If it's rock-solid everywhere but slopsmith →
   points back at the program.
2. **USB path.** Plug the Scarlett directly into a rear/motherboard USB port (no
   hub, no front-panel port). *If the dropouts stop → it was the hub/port.*
3. **USB power management (Linux).** Some kernels autosuspend USB audio. Check:
   `cat /sys/bus/usb/devices/*/power/control` — any `auto` on the Scarlett's
   node is a suspect; `echo on | sudo tee <node>/power/control` disables it for
   the session. *If dropouts stop → it was USB autosuspend.*
4. **Sample-rate match.** Make sure the OS/Scarlett output rate matches what the
   browser opens (usually 48000). A mismatch forces a re-clock that can glitch.
5. **Recent change?** New Scarlett firmware, a kernel/OS update, or a new
   USB device sharing the bus since "it was working" — any of these is a rig
   lead worth noting here.

Record findings below as they come in.

## Findings

- **2026-06-12 — USB autosuspend RULED OUT.** The Scarlett Solo USB is node
  `1-2` (vendor `1235`, product `8211`) and its `power/control` is **`on`**, not
  `auto` — the kernel is not autosuspending it. (Consistent with the prior:
  autosuspend drops at idle, not mid-stream.) The `auto` nodes in the bare list
  are other devices. → Rig power-management is not the cause; the remaining
  forks are OS audio-focus/context-suspend, a device-level drop, or our own
  main-thread stall — all of which the `input_dropout` record distinguishes.

- **2026-06-12 — NEW LEAD: four USB audio inputs on the bus.** `arecord -l`
  shows `card 4 Blue Snowball`, `card 5 USB Audio`, `card 6 Rocksmith USB Guitar
  Adapter`, `card 7 Scarlett Solo USB`. A **Rocksmith Real Tone adapter is
  co-present with the Scarlett.** Two implications worth testing:
  1. **Browser device-selection drift** — with several `getUserMedia` inputs,
     the default device (or the device the browser holds) can change on any
     device event, dropping the held stream mid-play. The `track_ready: "ended"`
     field in `input_dropout` is the tell for this.
  2. **USB bus contention** — multiple active USB-audio endpoints can starve a
     shared controller. Lower-probability, but it's a *new* variable that could
     explain "it wasn't happening before."
  - The Scarlett opens natively at **44100** under ALSA (`arecord` negotiated
    44100); the browser AudioContext usually requests **48000** — capture the
    actual `sample_rate` in the dropout record to check for a re-clock glitch.
  - ALSA capture confirmed the Scarlett *delivers* audio (meter moved), but the
    test was aborted at ~6% so it does NOT yet rule the device in or out — needs
    a full ~2–3 min run while playing, watching for `overrun`.

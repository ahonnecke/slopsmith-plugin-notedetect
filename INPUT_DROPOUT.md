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

## Prime hypothesis (program-side, testable)

The dropouts are **new**, which correlates with the `proj/bass-detection`
rollout (~2026-06-12): the rolling raw-audio **rescue buffer** (32768 samples),
**longer bass analysis windows**, and the always-on **parallel WAV capture**
all add main-thread work around the **deprecated `createScriptProcessor`** path
(`screen.js:2583`) — which runs on the main thread and is notorious for
underrunning (and silently stopping `onaudioprocess`) when the main thread is
busy. If true, this is ours to fix (move capture to an `AudioWorklet`, or shed
main-thread load), and it would be NEW because the load is new.

This is a hypothesis, not a conclusion. The telemetry below will confirm or
kill it.

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

## NEXT

Play a couple of songs on the current build. When a dropout happens (the red
banner appears), grab the `input_dropout` line — from the browser console, or
from the session's `static/note_detect_recordings/live_*.jsonl`. Its
`audio_ctx_state` + `track_ready` decide rig-vs-program in one shot.

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

_(none yet — awaiting the first captured `input_dropout` record)_

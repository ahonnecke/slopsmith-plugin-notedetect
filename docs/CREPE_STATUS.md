# CREPE/SPICE integration status: broken since introduction

## TL;DR

`_ndCrepeDetect` in `screen.js` has never produced a valid detection. Every
frame returns `{freq: -1, confidence: 0}`. The `CREPE/SPICE model loaded`
console message is real — the model weights load — but the inference path
throws on every call and the exception is swallowed by a bare try/catch.
Production has been running on YIN the entire time, regardless of which
detection method the user selected.

Verified 2026-04-23 via `test/detector-bakeoff.js` (open-strings.wav
ground-truth fixture): 0/310 frames produced any detection; 100% of frames
returned `freq = -1`.

## Two stacked bugs

### Bug 1 — input tensor shape (fails immediately, silently)

Current code (`screen.js` around the `_ndCrepeDetect` wrapper):

```js
const input = tf.tensor(buffer, [1, buffer.length]);  // shape [1, 4096]
outputs = _ndModel.execute(input);
```

SPICE (the `tfjs-model/spice/2/default/1` TFHub model actually being loaded)
demands a 1-D tensor of shape `[-1]`. Any other shape throws synchronously
with:

> `The shape of dict['input_audio_samples'] provided in model.execute(dict)
> must be [-1], but was [1,4096]`

The surrounding `try { ... } catch (e) { return { freq: -1, confidence: 0 }; }`
catches every call and returns the "no detection" sentinel, making the failure
indistinguishable from silence. No console warning, no error surfaced. Fix is
a one-line change to `tf.tensor1d(buffer)`.

### Bug 2 — sample-rate mismatch (would fail quietly even with shape fixed)

SPICE was trained on 16 kHz audio. The plugin feeds the raw 48 kHz
AudioContext buffer with no resampling. SPICE still produces numbers, but its
internal pitch estimates correspond to 3× the true frequency — a 55 Hz (A1)
input looks like ~165 Hz to SPICE. The `_ndCrepeDetect` log-scale decode
formula (`freq_hz = 2^(5.661 * raw + 4.0)`) is then applied to these wrong
values, yielding garbage.

Fixing this requires either:

- Resampling the 4096-sample 48 kHz buffer to a 16 kHz buffer before
  `_ndCrepeDetect` — can be done with TF.js op chains or a plain linear
  decimator. Output would be ~1365 samples; need to confirm SPICE's minimum
  input length.
- Loading a different pitch-detection model that accepts 48 kHz natively.
  None of the TFHub models the current code tries (SPICE, the
  `nicksherron/crepe-js` fallback) do.

### Bug 3 (minor) — output parsing assumes one value

Even once inference runs, SPICE returns two tensors of shape `[9]` for a
4096-sample input (one pitch estimate per ~455-sample stride). The current
code does `pitchData[0]` — taking a single value from the beginning. A
useful integration would aggregate across the nine strides (median, or
confidence-weighted) and emit one pitch per call.

## Evidence

`test/detector-bakeoff.js` — puppeteer harness that runs a known WAV through
both detectors in the real browser pipeline and reports per-segment dominant
MIDI. Results on `test/fixtures/ground-truth/open-strings.wav` (open E, A, D,
G each held ~3s):

```
=== YIN ===
  open E1      exp=28  dominant=40  FAIL (sustain octave-flip)
  open A1      exp=33  dominant=33  PASS
  open D2      exp=38  dominant=38  PASS
  open G2      exp=43  dominant=43  PASS
  3/4 segments pass

=== CREPE (SPICE) ===
  open E1  exp=28  dominant=null  FAIL
  open A1  exp=33  dominant=null  FAIL
  open D2  exp=38  dominant=null  FAIL
  open G2  exp=43  dominant=null  FAIL
  0/4 segments pass  (310/310 frames returned freq=-1)
```

`test/crepe-probe.js` — directly invokes the TF model with known inputs
and logs the thrown exception verbatim.

## Implications for the bass-detection branch

`_ndDetectionMethod === 'crepe'` has never been a real choice — it silently
falls back to YIN's output for scoring because `_ndCrepeDetect` returns a
sentinel that `_ndProcessFrame` treats as "no detection." Any previous
reasoning that used "CREPE handles low notes better than YIN" as a premise
was unsupported. All pitch quality on this branch comes from YIN.

## What to do about it

Short-term: leave CREPE disabled. The YIN octave-flip on low E is
well-characterized and fixable in-place. Working on CREPE instead means
(a) fixing three bugs, (b) adding a resampler to a hot path, and
(c) replacing a working 3/4-string detector with an unverified one.

Long-term: if deep-learning pitch detection is worth the maintenance cost,
consider a model trained at 48 kHz natively, or hide the resampler behind a
well-tested `_ndResampleTo16k` utility with its own unit test.

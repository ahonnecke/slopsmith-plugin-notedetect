# Song-specific pipeline ceiling

A score below 100% doesn't mean the player failed — different charts
have different ceilings on our YIN-based pipeline. This document
captures the finding and how to measure it.

## The experiment

Take the song's **own original recording** (the audio the chart was
authored from) and feed it through `classify-session.js` against the
chart. Whatever score the pipeline produces is the **absolute ceiling**
for that song. No human can play it more cleanly than the studio bass
itself; if we score the studio bass at 55%, that's what 100% effort
on the chart looks like to our detector.

## Two ceilings exist

The "ceiling" depends on what's in the audio. The pipeline behaves very
differently on a polyphonic full-band mix vs. a monophonic clean bass:

- **Polyphonic ceiling** — score against the song's own original
  recording (drums + bass + vocals + everything). YIN tries to extract
  the bass from a busy spectrum. This is what `make song-ceiling`
  measures.
- **Monophonic ceiling** — score against a clean synth-bass version of
  the chart (`make synth-track` + offline classifier). YIN handles a
  pure bass spectrum cleanly.

A clean DI'd bass should score CLOSER to the monophonic ceiling than
the polyphonic one. If it's near the polyphonic, the input is being
contaminated — sympathetic open-string ringing, amp speaker bleed,
room ambience picked up by a mic.

## Initial measurements

| Song | Polyphonic ceiling | Monophonic ceiling | User's live score |
| --- | --- | --- | --- |
| Mexico (Cake) | **62%** | ~92% (synth) | 89% (synth) |
| Stand by Me (Ben E. King) | **57%** | (not measured) | 53% |

**Stand by Me's polyphonic ceiling is 57%.** The user scored 53% live —
within 4pp of the polyphonic limit. That's noteworthy: their DI'd bass
is reading at *polyphonic-mix quality*, suggesting contamination
(open-string ringing being the most documented cause). Either:

- Get the input cleaner (palm muting, amp feedback, mic position) so
  the user's effective ceiling is closer to monophonic.
- Improve the pipeline so the polyphonic ceiling rises.

For Mexico's monophonic ceiling we have hard data (89% live on synth).
For Stand by Me we should measure it — `make synth-track SONG="Stand"`
+ classifier — to know if the chart is genuinely architectural-limit
or just hard-but-fixable.

## Why charts have different ceilings

Properties that lower the ceiling (Stand by Me cluster):
- **Low-frequency density**: lots of E2 / F#2 / G#2 notes (~80–100 Hz
  fundamentals). YIN's 4096-sample buffer at 48 kHz fits ~4 cycles of
  41 Hz — barely enough for stable pitch estimation.
- **Same-pitch sibling repeats**: `s2/f7 s2/f7 s2/f7` patterns. The
  matcher claims one onset per chart note, so on rapid same-pitch
  passages the second/third notes get demoted to MISSED.
- **Sustain bleed risk**: dense passages with insufficient mute time
  between notes leave residual ringing inside the next note's analysis
  window.

Properties that raise the ceiling (Mexico cluster):
- Wide pitch range with clear transitions
- Sparser note density
- Fewer same-pitch repeats

## Implications

1. **Score is per-chart, not per-pipeline.** "I got 53% on this song"
   without the song's ceiling means nothing. We should always report
   `score / ceiling` so the user knows whether they're under-performing
   or at the limit.
2. **Practice songs near their ceiling don't have headroom.** Getting
   "better" on Stand by Me past ~55% is impossible without changing
   the pipeline. Time better spent on songs where the ceiling-to-score
   gap is meaningful.
3. **Architectural work targets the ceiling, not the user.** If we
   want Stand by Me-class songs to score well, the wins come from
   pipeline changes (sustain bleed, low-freq YIN, multi-frame stability)
   — not from feedback or strictness adjustments.

## Methodology

`make song-ceiling SONG=<query>` (added by `test/song-ceiling.js`):

1. Resolves the song via the slopsmith library (puppeteer).
2. Pulls the cached audio (`audio_<stem>.<ext>`) from the container.
3. Converts to WAV at 48 kHz mono via ffmpeg.
4. Fetches the chart via `highway.getNotes()`.
5. Builds a synthetic dump and runs `classify-session.js --no-auto-align`.
6. Reports the score and persists it to
   `test/fixtures/song-ceiling/<stem>.json` for later comparison.

Re-run when the chart changes (re-extracted PSARC, re-tuned arrangement)
or when pipeline detection logic changes — the ceiling shifts with both.

## The fixture roster

`make song-ceiling-roster` (added by `test/song-ceiling-roster.js`) runs
the ceiling test across a curated list and prints a comparison table.
Reuse policy: results are cached per stem; if a cached result is at the
current pipeline commit, it's reused. `FORCE=1` re-runs everything,
`SONGS="a,b"` overrides the list, `EXTENDED=1` adds the bench list.

The default roster is picked to cover non-overlapping stress vectors so
a code change can be regressed against multiple chart shapes at once. A
fix that lifts Stand by Me from 57% → 70% while dragging Mexico from
62% → 50% is not a fix.

| Song | Tuning | Stresses |
| --- | --- | --- |
| Mexico (Cake) | E | Wide pitch range, moderate density — moderate-difficulty reference |
| Stand by Me (Ben E. King) | E | Low-frequency dominant (E2/F#2), sustain bleed, same-pitch repeats — architectural-limit reference |
| Bulls on Parade (RATM) | Eb | Heavily-mastered mid-frequency, dense syncopation, polyphonic extraction stress |
| All About That Bass (Trainor) | E | Sparse pop bass, generous rests — should sit near monophonic ceiling |
| Another One Bites the Dust (Queen) | E | Iconic single-note motif, clear mute gaps — sparse-clean reference |
| Billie Jean (Michael Jackson) | E | LinnDrum-locked tempo, sparse F#2 motif — zero-rubato chart-vs-audio alignment baseline |
| Take On Me (a-ha) | E | Programmed-drums + sawtooth synth bass — overtone-rich spectrum stress |

`EXTENDED=1` adds songs that stress narrower failure modes:

| Song | Tuning | Stresses |
| --- | --- | --- |
| Around the World (RHCP) | E | Fast same-pitch sibling-repeat stress (sixteenth-note runs) |
| Hysteria (Muse) | E | Distorted/effected bass, heavy harmonics, polyphonic muddle |
| Schism (Tool) | Drop D | Sustained dense passages, sustain bleed in heavy context |
| Killing in the Name (RATM) | Drop D | Heavy mix, busy-band YIN extraction |

**Drop-D / Eb-tuned songs are still useful as pipeline fixtures** even
if the user doesn't physically play them — the audio-truth ceiling is a
property of the recording + chart + pipeline, not the player.

### Why these songs (and not others)

The pipeline has known stress points; the roster maps one song per point:

- **Low-frequency YIN stability** → Stand by Me. 4096-sample window at
  48 kHz is ~4 cycles at 41 Hz. Charts with E2/F#2 fundamentals expose
  the limit.
- **Sustain bleed across rapid passages** → Stand by Me, Schism. Notes
  arriving before the previous one decays leave residual ringing in the
  next analysis window.
- **Same-pitch sibling repeats** → Around the World, Stand by Me. The
  matcher claims one onset per chart note, demoting subsequent same-pitch
  hits to MISSED on rapid passages.
- **Polyphonic mix extraction** → Bulls on Parade, Hysteria, Killing in
  the Name. Drums + distorted guitar + vocals overlap the bass spectrum.
- **Sparse-clean baseline** → All About That Bass, Another One Bites.
  Should score near monophonic ceiling. If they don't, something is
  broken at the basics.
- **Zero-rubato baseline** → Take On Me. Chart-vs-audio drift is the
  hidden failure mode for live-recorded songs; a drum-machine track
  removes that variable so the residual is pure detection error.
- **Drop-tuning generalisation** → Schism, Killing in the Name, Bulls
  on Parade. Frets refer to different absolute frequencies; the chart
  expresses MIDI directly so the detector should not care, but stress
  tests confirm.

## Band-pass pre-filter — the silent-bucket fix

The `USER_SILENT` bucket dominated the worst songs (57.6% on Bulls on
Parade, 65% on Take On Me) and was treated as an audio-content limit.
It isn't. `test/silent-probe.js` runs each silent note through a
30–250 Hz band-pass and asks whether YIN can find the bass when guitar
and percussion overtones are suppressed. Across all six fixture songs:

- **0% rms-gated** — the silence gate is fine; the bass-band signal is present.
- **33–75% recover under band-pass** — raw YIN gets ~0.00 confidence
  but band-passed YIN finds the bass at ~0.95 confidence. These notes
  are *fully recoverable* with a pre-filter, no matter what the live
  pipeline detector decides downstream.
- **0–20% truly spectrum-missing** — even after band-pass, no clear
  pitch in the bass band. This is the actual mix-quality ceiling.

A re-run of the full classifier with `--band-pass` (4th-order
Butterworth, 30 Hz HP × 2, 250 Hz LP × 2 cascaded) lifts every song:

| Song | Baseline | Band-pass | Δ |
| --- | --- | --- | --- |
| Stand by Me | 57.3% | **94.0%** | +36.7pp |
| Mexico | 62.2% | **93.7%** | +31.5pp |
| Another One Bites the Dust | 53.2% | **89.2%** | +36.0pp |
| All About That Bass | 47.9% | **84.4%** | +36.5pp |
| Take On Me (a-ha) | 22.6% | **80.3%** | +57.7pp |
| Bulls on Parade | 32.5% | **70.9%** | +38.4pp |
| Billie Jean | 43.2% | **69.2%** | +26.0pp |

This invalidates the original "Stand by Me is at the architectural
wall at 57%" reading. The wall was a YIN-confusion artifact, not an
audio-content limit. With the band-pass in place, Stand by Me is a
"friendly" chart at 94% ceiling — meaning the user's 53% live score
has ~40pp of real headroom.

**Status**: enabled in the offline classifier
(`classify-session.js --band-pass`) and in the roster runner
(`make song-ceiling-roster BANDPASS=1`). The live pipeline in
`screen.js` does not yet apply the filter; porting it is the next
load-bearing pipeline change.

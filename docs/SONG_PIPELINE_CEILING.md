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

## Songs to add to the test set

Architectural work on the pipeline needs more than one failing fixture
to avoid over-fitting. Candidates with diverse chart shapes:

- **Stand by Me** (current — easy melodic bass, low frequencies)
- **Bulls on Parade** (Rage Against the Machine — heavily mastered, dense
  syncopation, mid-frequency bass content)
- **All About That Bass** (sparse pop bass, room for the pipeline to
  resolve cleanly between notes)
- A drum-machine track (no rubato, maximum chart-vs-audio alignment)

Each of these stresses a different part of the pipeline. A change that
moves Stand by Me from 55% → 70% but breaks Mexico down to 80% isn't a
win. The fixture set lets us regress against multiple chart shapes at
once.

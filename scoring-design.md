# Scoring: Collapse to a Single Number

## The proposal

Two windows per note, already defined:

- **Detection**: 200¢ / 300ms — did you play it?
- **Precision**: 25¢ / 50ms — how tight?

Per-note score:

```
per_note =
  0                              if outside detection
  0.3                            if detected, outside precision
  0.3 + 0.7 × tightness          if inside precision

tightness = min(1 - |cents|/25, 1 - |ms|/50)   clamped to [0, 1]
```

Song score = **mean of per_note across the chart.** A number in [0, 1] that reads as "what fraction of perfection you delivered."

That's the whole thing. The rest of this doc is why each piece is the right call.

> **Context.** Pedagogy lives in a separate post-play coach evaluator, not in the score. The score's only job is to be an honest measurement of what happened on this run. That assumption shapes several of the calls below — particularly the floor value.

---

## Why piecewise instead of one continuous curve

A continuous curve from 0¢ to 200¢ sounds elegant but lies about the underlying physics. There are genuinely two regimes here:

1. **Did the note happen at all?** Binary. Either the pitch detector locked onto something close enough to count, or it didn't.
2. **How well was it executed?** Continuous. Once we know it happened, we can talk gradients.

Smashing those into one curve forces a single slope to do two jobs and ends up doing both badly — either the "did you play it" zone is too generous (notes you basically missed score 0.4) or the "how tight" zone is too punishing (a 10¢ error tanks you). The piecewise function lets each window have its own job.

## Why min, not product or average, for combining pitch and time

Three candidates for combining the two axes inside the precision window:

| Method | What it says |
|---|---|
| **min** | Your score is whichever axis you butchered worse. |
| **product** | Errors compound multiplicatively. |
| **avg** | One good axis can rescue a bad one. |

**Min wins because music is unforgiving on each axis independently.** A perfectly-timed flat note is still wrong. An in-tune late note is still late. A listener doesn't average those; they hear the worse one. Min matches perception.

Product is too harsh — two small errors (say 0.9 × 0.9 = 0.81) get punished more than either deserves on its own. That's not what the player did wrong.

Average is the worst of the three for a tuning game. It tells the player they can coast on pitch if their timing is sharp, or vice versa. That's a lie, and they'll feel the lie when they try to play with a band and discover their "90% score" sounds bad.

## Why 0.3 is the right floor for "detected but not precise"

This is a design knob, and it encodes a value judgment. Three plausible settings:

- **0.2** — "Showing up barely counts." Aggressive push toward precision.
- **0.3** — "Showing up gets you a third of the way." Precision is clearly the point, but detection still earns something.
- **0.5+** — "Showing up is half the battle." Makes the precision window feel optional rather than the goal.

The floor was tempting to set high (0.5) when the score had to double as a learner-protection mechanism — punishing a struggling beginner with a 0.1 score for notes they technically hit feels cruel. **But pedagogy is not the score's job here.** A post-play coach catches struggling players, identifies what they need to work on, and adjusts guidance accordingly. The score is freed up to do its actual job: measure execution honestly.

With that constraint lifted, **0.3 is right.** Reasoning: detection alone is the minimum bar for "you played guitar at this moment." Precision is what the game is actually measuring. A 70/30 split between "the precision part of the score" and "the showing-up part" reflects that hierarchy. A player who lands every note in the detection window but never in precision deserves to see ~0.3, because that's an accurate description of their playing — they're hitting notes but not playing them tightly. The coach can soften that delivery; the score shouldn't lie about it.

Rocksmith landed at roughly this number for the same reason — they had dynamic difficulty doing learner-protection in parallel. Functionally similar setup.

## Why the asymmetric ratios (8× pitch, 6× time) are fine

Detection is 200¢ / 300ms; precision is 25¢ / 50ms. That's an 8× ratio on pitch and 6× on timing — pitch has a wider "trying" zone than timing.

This is correct, not a bug. Pitch error on guitar has more legitimate sources than timing error: string bends, fret pressure, intonation drift, the guitar going slightly out of tune mid-song. Timing error has basically one source — you strummed at the wrong moment. The wider pitch tolerance reflects real-world variance in what a "correct" note sounds like.

If precision ever feels mushy on pitch in playtesting, tighten the inner window from 25¢ to 15-20¢ before touching the outer one.

## Why mean (and the unresolved question of streaks)

Mean across all notes gives a clean, interpretable score. 0.87 means "you delivered 87% of perfect." A player can compare two runs and know what the number means.

The thing mean doesn't capture: **streaks.** Rocksmith multiplies — consecutive hits build a combo that scales score. This is a real choice worth making explicitly:

- **If scoring is a measurement of skill** → don't multiply. Streaks amplify variance and let one lucky run dominate the leaderboard.
- **If scoring is a game-feel reward loop** → multiply. Combos make flow states feel rewarded and give players something to chase mid-song.

These are not equally compatible with mean-based scoring. **Decide this before shipping.** Retrofitting combo multipliers onto an averaged base score is painful — every existing score becomes incomparable, and players notice.

My lean: keep the base score clean (mean of per_note) as the "skill number," and if you want combo feel, layer it as a **separate visible multiplier** during play that doesn't touch the underlying score. Player sees both. Leaderboards rank by the clean number. Best of both worlds.

## Emit per-note data, not just the aggregate

The coach evaluator is going to need more than a single number to do its job. It needs to know *which* notes were missed, where timing drift accumulated, whether pitch errors cluster on bends vs. sustains, whether the player falls apart in fast sections, whether they always rush the last beat of a measure. None of that is recoverable from a 0–1 song score.

**Design the scoring pipeline to emit two outputs from the same pass:**

1. **Song score** (single 0–1 float) — for the player UI, leaderboards, progress tracking.
2. **Per-note record** (structured array) — for the coach. Each entry minimally contains:
   - note index / timestamp in the chart
   - target pitch and target time
   - detected pitch and detected time (or null if missed)
   - cents error and ms error (signed — direction matters; "always flat" is a different problem from "always sharp")
   - per_note score
   - bucket: `missed` | `detected_only` | `precise`

This is cheap to emit during the same pass that computes the score, and it's the substrate the coach needs. Retrofitting it later means re-running scoring against stored audio, which is expensive and lossy. Build it in from day one.

Signed errors are the one detail worth flagging — unsigned cents/ms is enough for scoring (you're folding both directions into the same penalty) but useless for diagnosis. The coach wants to tell the player "you're consistently 30ms late" or "your bends overshoot," and that requires direction.

---

## TL;DR

Piecewise per-note, min across axes, **0.3 floor**, mean across the song. Keep streaks out of the base score; if you want combo feel, layer it on top. Emit per-note records alongside the aggregate so the coach has something to chew on.

# Session report: latest

- 193 chart notes analysed
- WAV: `(no recording — dump-only mode)`
- Dump: `test/fixtures/latest.dump.json`

## Score summary

| Bucket | Count | % |
|---|---|---|
| PIPELINE_HIT | 142 | 73.6% |
| MISS_WRONG_PITCH | 39 | 20.2% |
| MISS_NO_DETECTION | 12 | 6.2% |

## Timing errors (on hits)

```
        -300     1  █
        -250     0  
        -200     1  █
        -150     6  ██████
        -100     1  █
         -50     5  █████
           0     7  ███████
          50     1  █
         100     5  █████
         150     9  █████████
         200    41  ████████████████████████████████████████
         250    33  ████████████████████████████████
         300    15  ███████████████
         350     6  ██████
         400     5  █████
         450     4  ████
         500     0  
         550     0  
         600     2  ██
```

p25=173ms, p50=220ms, p75=268ms (positive = late)

## Pitch errors (on hits)

```
        -100    14  █████
         -90     0  
         -80     0  
         -70     0  
         -60     0  
         -50     0  
         -40     0  
         -30     0  
         -20     0  
         -10     0  
           0   117  ████████████████████████████████████████
          10     0  
          20     0  
          30     0  
          40     0  
          50     0  
          60     0  
          70     0  
          80     0  
          90     0  
         100    11  ████
```

p25=0¢, p50=0¢, p75=0¢ (positive = sharp)

## Notes you keep missing (top 10)

| position | count | category | usually heard as |
|---|---|---|---|
| s0/f0 (MIDI 28) | 25 | MISS_WRONG_PITCH | — |
| s0/f3 (MIDI 31) | 14 | MISS_NO_DETECTION | — |
| s0/f1 (MIDI 29) | 7 | MISS_WRONG_PITCH | — |
| s0/f2 (MIDI 30) | 5 | MISS_WRONG_PITCH | — |

// Paste this entire block into the browser console on the Slopsmith player page.
// It adds a floating diagnostic panel. Run each test by clicking buttons.
// Each test isolates one layer: detection → matching → rendering.

(function() {
'use strict';

if (document.getElementById('nd-diag')) { document.getElementById('nd-diag').remove(); return; }

const panel = document.createElement('div');
panel.id = 'nd-diag';
panel.style.cssText = 'position:fixed;top:10px;right:10px;width:520px;max-height:90vh;overflow-y:auto;background:#111;border:2px solid #336;border-radius:8px;padding:12px;z-index:9999;font:12px/1.5 monospace;color:#ddd;';

const P = (c, t) => `<span style="color:${c}">${t}</span>`;
const OK = t => P('#0f8', t);
const FAIL = t => P('#f44', t);
const WARN = t => P('#fc0', t);
const INFO = t => P('#8cf', t);

function render() {
panel.innerHTML = `
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
  <b style="font-size:14px">Note Detection Diagnostic</b>
  <span onclick="document.getElementById('nd-diag').remove()" style="cursor:pointer;font-size:18px">&times;</span>
</div>
<div id="nd-diag-out" style="background:#0a0a14;padding:8px;border-radius:4px;white-space:pre-wrap;max-height:70vh;overflow-y:auto"></div>
<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px">
  <button onclick="ndDiag(1)" style="background:#336;color:#eee;border:1px solid #558;padding:4px 10px;border-radius:3px;cursor:pointer;font:11px monospace">1: Plugin?</button>
  <button onclick="ndDiag(2)" style="background:#336;color:#eee;border:1px solid #558;padding:4px 10px;border-radius:3px;cursor:pointer;font:11px monospace">2: Active?</button>
  <button onclick="ndDiag(3)" style="background:#336;color:#eee;border:1px solid #558;padding:4px 10px;border-radius:3px;cursor:pointer;font:11px monospace">3: Detections?</button>
  <button onclick="ndDiag(4)" style="background:#336;color:#eee;border:1px solid #558;padding:4px 10px;border-radius:3px;cursor:pointer;font:11px monospace">4: Chart?</button>
  <button onclick="ndDiag(5)" style="background:#336;color:#eee;border:1px solid #558;padding:4px 10px;border-radius:3px;cursor:pointer;font:11px monospace">5: Results?</button>
  <button onclick="ndDiag(6)" style="background:#336;color:#eee;border:1px solid #558;padding:4px 10px;border-radius:3px;cursor:pointer;font:11px monospace">6: Misses?</button>
  <button onclick="ndDiag(7)" style="background:#336;color:#eee;border:1px solid #558;padding:4px 10px;border-radius:3px;cursor:pointer;font:11px monospace">7: Force miss</button>
  <button onclick="ndDiag(8)" style="background:#336;color:#eee;border:1px solid #558;padding:4px 10px;border-radius:3px;cursor:pointer;font:11px monospace">8: Timing?</button>
  <button onclick="ndDiag(9)" style="background:#336;color:#eee;border:1px solid #558;padding:4px 10px;border-radius:3px;cursor:pointer;font:11px monospace">9: ALL</button>
</div>`;
}
render();
document.body.appendChild(panel);

const out = () => document.getElementById('nd-diag-out');
const log = (html) => { out().innerHTML += html + '\n'; };
const clear = () => { out().innerHTML = ''; };

window.ndDiag = function(n) {
    if (n === 9) {
        clear();
        for (let i = 1; i <= 8; i++) { window.ndDiag(i); log('\n' + '─'.repeat(50) + '\n'); }
        return;
    }
    if (n !== 3) clear(); // test 3 is async, keep previous

    if (n === 1) {
        log('<b>TEST 1: Plugin loaded?</b>');
        const checks = [
            ['_ndEnabled', typeof _ndEnabled !== 'undefined'],
            ['_ndNoteResults', typeof _ndNoteResults !== 'undefined'],
            ['_ndCheckMisses', typeof _ndCheckMisses !== 'undefined'],
            ['_ndMatchNotes', typeof _ndMatchNotes !== 'undefined'],
            ['highway', typeof highway !== 'undefined'],
            ['highway.getNotes', typeof highway?.getNotes === 'function'],
            ['highway.project', typeof highway?.project === 'function'],
            ['highway.fretX', typeof highway?.fretX === 'function'],
            ['highway.fillTextUnmirrored', typeof highway?.fillTextUnmirrored === 'function'],
        ];
        for (const [name, ok] of checks) log((ok ? OK('OK  ') : FAIL('MISS')) + ' ' + name);
    }

    if (n === 2) {
        log('<b>TEST 2: Detection active?</b>');
        log((_ndEnabled ? OK('ON') : FAIL('OFF')) + '  _ndEnabled');
        log(INFO(`AudioCtx: ${_ndAudioCtx?.state || 'null'}`));
        log(INFO(`Method: ${_ndDetectionMethod}`));
        log(INFO(`Timing tol: ${(_ndTimingTolerance*1000).toFixed(0)}ms`));
        log(INFO(`Pitch tol: ${_ndPitchTolerance}¢`));
        log(INFO(`Latency offset: ${(_ndDetectionLatencySec*1000).toFixed(0)}ms`));
        log(INFO(`Input level: ${_ndInputLevel.toFixed(4)}`));
        log(INFO(`Arrangement: ${_ndCurrentArrangement}`));
        log(INFO(`Tuning: [${_ndTuningOffsets.join(',')}]  Capo: ${_ndCapo}`));
        if (_ndInputLevel < 0.001) log(WARN('Input level is near zero — is the device working?'));
    }

    if (n === 3) {
        clear();
        log('<b>TEST 3: Detections arriving? (5s — PLAY A NOTE)</b>');
        const seen = [];
        const t0 = Date.now();
        const iv = setInterval(() => {
            if (_ndDetectedMidi > 0) {
                seen.push({ms: Date.now()-t0, midi: _ndDetectedMidi, conf: _ndDetectedConfidence.toFixed(2),
                           s: _ndDetectedString, f: _ndDetectedFret, lvl: _ndInputLevel.toFixed(4)});
            }
            if (Date.now() - t0 > 5000) {
                clearInterval(iv);
                if (seen.length === 0) {
                    log(FAIL('NO DETECTIONS in 5 seconds.'));
                    log(WARN('→ Is detection enabled? Is input level > 0?'));
                } else {
                    log(OK(`${seen.length} detections.`));
                    for (const d of seen.slice(0, 8)) {
                        log(INFO(`  ${d.ms}ms  midi=${d.midi}  conf=${d.conf}  s${d.s}/f${d.f}  level=${d.lvl}`));
                    }
                    const uniq = [...new Set(seen.map(d => d.midi))];
                    log(INFO(`Unique MIDI: [${uniq.map(m=>m.toFixed(1)).join(', ')}]`));
                }
            }
        }, 50);
    }

    if (n === 4) {
        log('<b>TEST 4: Chart notes available?</b>');
        const notes = highway.getNotes();
        const chords = highway.getChords();
        const t = highway.getTime();
        const info = highway.getSongInfo ? highway.getSongInfo() : {};
        log((notes?.length > 0 ? OK('OK') : FAIL('EMPTY')) + `  Notes: ${notes?.length || 0}`);
        log((chords?.length > 0 ? OK('OK') : WARN('EMPTY')) + `  Chords: ${chords?.length || 0}`);
        log(INFO(`Time: ${t.toFixed(3)}s  Song: ${info.title || '?'} — ${info.artist || '?'}`));

        if (notes?.length > 0) {
            const nearby = notes.filter(n => Math.abs(n.t - t) < 3).slice(0, 6);
            log(INFO(`\nNearby notes (±3s):`));
            for (const n of nearby) {
                const dt = ((n.t - t)*1000).toFixed(0);
                log(INFO(`  t=${n.t.toFixed(3)}  s${n.s}/f${n.f}  ${dt}ms  key=${_ndNoteKey(n, n.t)}`));
            }
        }
    }

    if (n === 5) {
        log('<b>TEST 5: _ndNoteResults contents</b>');
        const sz = _ndNoteResults.size;
        log((sz > 0 ? OK(`${sz} entries`) : WARN('EMPTY')));
        log(INFO(`Score: ${_ndHits} hits, ${_ndMisses} misses (pitch:${_ndPitchMisses} timing:${_ndTimingMisses})`));

        let hits=0, pm=0, tm=0, old=0;
        const entries = [];
        _ndNoteResults.forEach((v,k) => {
            if (typeof v === 'object') {
                if (v.primary === 'HIT') hits++;
                else if (v.primary === 'MISSED_WRONG_PITCH') pm++;
                else if (v.primary === 'MISSED_NO_DETECTION') tm++;
                entries.push({key:k, ...v});
            } else {
                old++;
                entries.push({key:k, legacy:v});
            }
        });

        log(INFO(`By type: HIT=${hits}  PITCH_MISS=${pm}  TIMING_MISS=${tm}  old_format=${old}`));
        if (old > 0) log(FAIL(`${old} entries in OLD STRING FORMAT — draw hook won't render these`));

        const last = entries.slice(-10);
        if (last.length) {
            log(INFO(`\nLast ${last.length}:`));
            for (const r of last) {
                if (r.legacy) {
                    log(FAIL(`  ${r.key} → "${r.legacy}" OLD FORMAT`));
                } else {
                    const te = r.timingError!=null ? `${r.timingError>0?'+':''}${Math.round(r.timingError)}ms` : '—';
                    const pe = r.pitchError!=null ? `${r.pitchError>0?'+':''}${Math.round(r.pitchError)}¢` : '—';
                    log((r.primary==='HIT'?OK:FAIL)(`  ${r.key} → ${r.primary}  t=${te}  p=${pe}  ${(r.labels||[]).join(',')}`));
                }
            }
        }
    }

    if (n === 6) {
        log('<b>TEST 6: _ndCheckMisses running?</b>');
        const avOff = (highway.getAvOffset ? highway.getAvOffset() : 0) / 1000;
        const chartT = highway.getTime();
        const scoreT = chartT + avOff - _ndDetectionLatencySec;
        const tol = _ndTimingTolerance;
        const deadline = scoreT - tol * 2;

        log(INFO(`Chart time:     ${chartT.toFixed(3)}s`));
        log(INFO(`AV offset:      ${(avOff*1000).toFixed(0)}ms`));
        log(INFO(`Latency offset: ${(_ndDetectionLatencySec*1000).toFixed(0)}ms`));
        log(INFO(`Score time:     ${scoreT.toFixed(3)}s`));
        log(INFO(`Miss deadline:  ${deadline.toFixed(3)}s`));
        log(INFO(`Tolerance:      ${(tol*1000).toFixed(0)}ms`));

        const notes = highway.getNotes();
        if (notes) {
            let unjudged = 0, total = 0;
            for (let i = Math.max(0, notes.length - 200); i < notes.length; i++) {
                const n = notes[i];
                if (n.t > deadline) break;
                if (n.t < deadline - 5) continue;
                if (n.mt) continue;
                total++;
                if (!_ndNoteResults.has(_ndNoteKey(n, n.t))) unjudged++;
            }
            log((unjudged === 0 ? OK : FAIL)(`Past-deadline notes (last 5s): ${total} total, ${unjudged} UNJUDGED`));
            if (unjudged > 0) {
                log(FAIL('^^^ These should be misses. _ndCheckMisses may not be running.'));
            }
        }
    }

    if (n === 7) {
        log('<b>TEST 7: Force-inject miss markers</b>');
        const notes = highway.getNotes();
        const t = highway.getTime();
        if (!notes || notes.length === 0) { log(FAIL('No chart notes. Load a song.')); return; }

        let injected = 0;
        for (const n of notes) {
            if (n.mt) continue;
            if (n.t > t - 3.0 && n.t < t - 0.1) {
                const key = _ndNoteKey(n, n.t);
                _ndNoteResults.set(key, {
                    primary: injected % 2 === 0 ? 'MISSED_NO_DETECTION' : 'MISSED_WRONG_PITCH',
                    labels: [],
                    timingError: injected % 2 === 0 ? null : 120,
                    pitchError: injected % 2 === 0 ? null : 35,
                    detectedMidi: null,
                    expectedMidi: 0,
                });
                log(OK(`Injected ${injected % 2 === 0 ? 'MISSED_NO_DETECTION' : 'MISSED_WRONG_PITCH (+35¢, +120ms)'} at t=${n.t.toFixed(3)} s${n.s}/f${n.f}`));
                injected++;
                if (injected >= 4) break;
            }
        }
        if (injected === 0) {
            log(WARN('No recent past notes found. Let the song play a bit then try again.'));
        } else {
            log(INFO(`\nLook at the highway NOW — you should see ${injected} red/orange X markers.`));
            log(INFO('If you see NOTHING, the draw hook is broken.'));
            log(INFO(`Markers persist for ${typeof _ND_MISS_DISPLAY_SEC !== 'undefined' ? _ND_MISS_DISPLAY_SEC : '???'}s`));
        }
    }

    if (n === 8) {
        log('<b>TEST 8: Timing alignment</b>');
        const chartT = highway.getTime();
        const avOff = (highway.getAvOffset ? highway.getAvOffset() : 0);
        const matchT = chartT + avOff/1000 - _ndDetectionLatencySec;
        const delta = (matchT - chartT) * 1000;

        log(INFO(`highway.getTime()  = ${chartT.toFixed(4)}s`));
        log(INFO(`AV offset          = ${avOff.toFixed(1)}ms`));
        log(INFO(`Latency offset     = ${(_ndDetectionLatencySec*1000).toFixed(1)}ms`));
        log(INFO(`→ match time       = ${matchT.toFixed(4)}s`));
        log(INFO(`→ delta from chart = ${delta.toFixed(1)}ms`));

        if (Math.abs(delta) > 200) {
            log(FAIL('Match time is >200ms from chart. Detections may never land in window.'));
        } else {
            log(OK('Timing alignment is reasonable.'));
        }

        if (_ndEventLog.length > 0) {
            log(INFO(`\nLast 5 match attempts:`));
            for (const e of _ndEventLog.slice(-5)) {
                log((e.hit?OK:FAIL)(`  dt=${e.dtMs>0?'+':''}${Math.round(e.dtMs)}ms  cents=${e.centsErr>0?'+':''}${Math.round(e.centsErr)}¢  ${e.hit?'HIT':'MISS'}`));
            }
            // Check for systematic bias
            const dts = _ndEventLog.map(e => e.dtMs);
            const mean = dts.reduce((s,x) => s+x, 0) / dts.length;
            if (Math.abs(mean) > 50) {
                log(WARN(`\nSystematic timing bias: avg dt = ${mean>0?'+':''}${Math.round(mean)}ms`));
                log(WARN(mean > 0
                    ? 'Detections are consistently LATE. Increase _ndDetectionLatencySec.'
                    : 'Detections are consistently EARLY. Decrease _ndDetectionLatencySec.'));
            }
        } else {
            log(WARN('_ndEventLog is empty — no match attempts yet.'));
        }
    }
};

})();

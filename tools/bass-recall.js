#!/usr/bin/env node
/* Bass-detection recall analyzer (BASS_DETECTION.md project).
 *
 * Measures per-note PITCH-VERIFY recall (the constraintCheckString gate the
 * detector uses) on a reference take, sweeping the analysis-window length and
 * the global A/V offset. Reports overall + per-pitch recall and, for missed
 * notes, the band energy (to tell a weak-signal drop from a pitch-read drop).
 *
 *   node tools/bass-recall.js --audio ref.wav --chart bass.json [--win 4096,8192,16384]
 *
 * Chart = sloppak wire format (or reconstruct from a live_*.jsonl: one
 * {t,s,f} per scored event). Ground truth = the chart, so use a near-clean
 * take. Drives the production DSP via test/_loader — improving those primitives
 * is the point.
 */
'use strict';
const { loadDetectionCore } = require('../test/_loader');
const fs = require('fs');
const { parseArgs } = require('node:util');
const core = loadDetectionCore();
const SR = 48000;
const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const nm = m => NAMES[((m%12)+12)%12] + (Math.floor(m/12)-1);

function readWavMono(p){
  const b = fs.readFileSync(p);
  let off=12, dataOff=-1, dataLen=0, sr=SR, ch=1, bps=16;
  while(off+8<=b.length){
    const id=b.toString('ascii',off,off+4), sz=b.readUInt32LE(off+4);
    if(id==='fmt '){sr=b.readUInt32LE(off+12);ch=b.readUInt16LE(off+10);bps=b.readUInt16LE(off+22);}
    else if(id==='data'){dataOff=off+8;dataLen=sz;break;}
    off+=8+sz+(sz&1);
  }
  const bytes=bps>>3, frames=(dataLen/(bytes*ch))|0, a=new Float32Array(frames);
  for(let i=0;i<frames;i++) a[i]=b.readInt16LE(dataOff+i*bytes*ch)/32768; // ch0
  return { samples:a, sr };
}

const { values:v } = parseArgs({ options:{
  audio:{type:'string'}, chart:{type:'string'},
  win:{type:'string', default:'4096,8192,16384'},
  'pitch-gate':{type:'string', default:'60'},
}});
if(!v.audio || !v.chart){ console.error('need --audio and --chart'); process.exit(2); }
const { samples, sr } = readWavMono(v.audio);
const notes = JSON.parse(fs.readFileSync(v.chart)).notes.filter(n=>!n.mt);
const gate = Number(v['pitch-gate']);
const wins = v.win.split(',').map(Number);

function run(WIN, offMs){
  const off=offMs/1000; let hits=0; const byp={};
  for(const nt of notes){
    const c=Math.round((nt.t+off)*sr), lo=Math.max(0,c-(WIN>>1));
    const buf=samples.subarray(lo, lo+WIN);
    if(buf.length<WIN) continue;
    const r=core.constraintCheckString(buf, sr, nt.s, nt.f, 'bass', 4, [0,0,0,0], 0, gate, 0.015);
    const m=core.midiFromStringFret(nt.s, nt.f, 'bass', 4);
    (byp[m]=byp[m]||{h:0,t:0}); byp[m].t++; if(r.hit){hits++;byp[m].h++;}
  }
  return { hits, byp };
}
for(const WIN of wins){
  let best={hits:-1};
  for(let o=-100;o<=500;o+=20){ const r=run(WIN,o); if(r.hits>best.hits) best={off:o,...r}; }
  const ms=Math.round(WIN/sr*1000);
  console.log(`WIN=${WIN} (${ms}ms) off=${best.off}ms  recall ${best.hits}/${notes.length} (${Math.round(100*best.hits/notes.length)}%)`);
  if(wins.length===1){
    for(const m of Object.keys(best.byp).map(Number).sort((a,b)=>a-b)){
      const g=best.byp[m];
      console.log(`   ${nm(m)}(${m}) ${Math.round(440*2**((m-69)/12))}Hz  ${g.h}/${g.t} (${Math.round(100*g.h/g.t)}%)`);
    }
  }
}

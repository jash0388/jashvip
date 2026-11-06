/**
 * WinGo BIG/SMALL engines + strategy pack (standalone, no deps)
 * Usage:
 *   const { predict, predictAll, engines, strategy } = require('./wingo-engines');
 *   // history = array of past results, oldest -> newest, each: 1 (BIG) or 0 (SMALL)
 *   // or pass draws as [{number:6},{number:2},...] and it will convert.
 *   predict('3-gram', [1,0,1,1,0,0,1]);          // -> 1 or 0
 *   predictAll([1,0,1,1,0,0,1]);                  // -> { votes, byEngine }
 *   strategy([1,0,1,1,0,0,1], { confirm: 3 });   // -> { signal, votes, confidence, reasons }
 */

const BIG = 1, SMALL = 0;

const toSeq = (input) => input.map(x =>
  typeof x === 'number' ? (x >= 5 ? BIG : SMALL) : (x.size ? (x.size === 'BIG' ? BIG : SMALL) : (x.number >= 5 ? BIG : SMALL))
);
const last = (h) => h[h.length - 1];
const flip = (v) => v === BIG ? SMALL : BIG;
const majority = (h, k) => { const w = h.slice(-k); const b = w.reduce((a,v)=>a+v,0); return b === w.length-b ? last(h) : (b > w.length-b ? BIG : SMALL); };
const streakLen = (h) => { const s = last(h); let n=1; for(let i=h.length-2;i>=0&&h[i]===s;i--) n++; return [s,n]; };
const isChop = (h) => { const t=h.slice(-4); return t.length===4 && t.every((v,i)=> i===0 || v!==t[i-1]); };

function ngram(h, k, smooth=0.5) {
  if (h.length < k+1) return last(h);
  const key = h.slice(-k).join('');
  const table = Object.create(null);
  for (let i=k; i<h.length; i++) {
    const ctx = h.slice(i-k,i).join(''); if (!table[ctx]) table[ctx]=[0,0]; table[ctx][h[i]]++;
  }
  const c = table[key]; if (!c) return majority(h, Math.min(9, h.length));
  return (c[BIG]+smooth) >= (c[SMALL]+smooth) ? BIG : SMALL;
}
function markov(h, order) {
  if (h.length < order+1) return last(h);
  const key = h.slice(-order).join('');
  const table = Object.create(null);
  for (let i=order; i<h.length; i++) {
    const ctx = h.slice(i-order,i).join(''); if (!table[ctx]) table[ctx]=[0,0]; table[ctx][h[i]]++;
  }
  const c = table[key]; if (!c) return last(h);
  return (c[BIG]+1) >= (c[SMALL]+1) ? BIG : SMALL;
}

const engines = [
  { name: "follow-last",       family: "streak",      min: 1,  fn: h => last(h) },
  { name: "flip-last",         family: "anti-streak", min: 1,  fn: h => flip(last(h)) },
  { name: "majority-5",        family: "frequency",   min: 5,  fn: h => majority(h,5) },
  { name: "minority-5",        family: "contrarian",  min: 5,  fn: h => flip(majority(h,5)) },
  { name: "majority-9",        family: "frequency",   min: 9,  fn: h => majority(h,9) },
  { name: "least-freq-20",     family: "fallacy",     min: 20, fn: h => { const w=h.slice(-20),b=w.reduce((a,v)=>a+v,0); return b>=10?SMALL:BIG; } },
  { name: "2-gram",            family: "ngram",       min: 4,  fn: h => ngram(h,2) },
  { name: "3-gram (PAT#072)",  family: "ngram",       min: 6,  fn: h => ngram(h,3) },
  { name: "5-gram",            family: "ngram",       min: 10, fn: h => ngram(h,5) },
  { name: "7-gram (PAT#113)",  family: "ngram",       min: 12, fn: h => ngram(h,7) },
  { name: "markov-1",          family: "markov",      min: 3,  fn: h => markov(h,1) },
  { name: "markov-2",          family: "markov",      min: 4,  fn: h => markov(h,2) },
  { name: "chop-detector",     family: "pattern",     min: 6,  fn: h => isChop(h) ? last(h) : majority(h,6) },
  { name: "streak-breaker",    family: "pattern",     min: 4,  fn: h => { const [s,n]=streakLen(h); return n>=3 ? flip(s) : last(h); } },
];

function predict(name, history) {
  const h = toSeq(history);
  const e = engines.find(x => x.name === name || x.name.includes(name));
  if (!e) throw new Error("unknown engine: "+name);
  if (h.length < e.min) return null;
  return e.fn(h);
}

function predictAll(history) {
  const h = toSeq(history);
  const byEngine = {};
  let big=0, small=0;
  for (const e of engines) {
    if (h.length < e.min) { byEngine[e.name] = null; continue; }
    const v = e.fn(h); byEngine[e.name] = v;
    v === BIG ? big++ : small++;
  }
  return { votes: { BIG: big, SMALL: small, total: big+small }, byEngine };
}

/**
 * Strategy: weighted vote with confirmation filters.
 * opts:
 *   weights  - { "3-gram (PAT#072)": 2, ... } extra weight per engine
 *   confirm  - min vote margin to emit a signal (default 0 = majority)
 *   skipChop - if true, returns null when last 4 are pure chop and no margin
 * Returns: { signal: 1|0|null, votes, margin, confidence, reasons, byEngine }
 */
function strategy(history, opts={}) {
  const h = toSeq(history);
  const weights = opts.weights || {};
  const confirm = opts.confirm ?? 0;
  const reasons = [];
  const byEngine = {};
  let big=0, small=0;

  for (const e of engines) {
    if (h.length < e.min) continue;
    const v = e.fn(h); const w = (weights[e.name] || 1);
    byEngine[e.name] = { signal: v, weight: w };
    v === BIG ? big += w : small += w;
  }
  const total = big + small;
  const margin = Math.abs(big - small);
  const signal = margin > confirm ? (big > small ? BIG : SMALL) : null;
  const confidence = total ? Math.max(big, small) / total : 0;

  if (opts.skipChop && isChop(h)) reasons.push("chop-detected");
  if (margin <= confirm) reasons.push("no-margin");
  if (h.length < 12) reasons.push("low-history");

  return { signal, signalLabel: signal===null ? "SKIP" : (signal===BIG?"BIG":"SMALL"),
           votes: {BIG:big, SMALL:small, total}, margin, confidence, reasons, byEngine };
}

function label(v){ return v===null||v===undefined ? "SKIP" : (v===BIG?"BIG":"SMALL"); }

const _exportObj = { BIG, SMALL, engines, toSeq, predict, predictAll, strategy, label };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = _exportObj;
}
if (typeof window !== 'undefined') {
  window.WingoEngines = _exportObj;
}

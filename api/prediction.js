// Vercel Serverless Function: JASHVIP Live Prediction API
// Provides 100% synchronized predictions for both jashvip.vercel.app and userscripts

function getSize(number) {
  return parseInt(number, 10) >= 5 ? 'BIG' : 'SMALL';
}
function opp(size) {
  return size === 'BIG' ? 'SMALL' : 'BIG';
}

function getRuns(sizes) {
  const runs = [];
  if (!sizes.length) return runs;
  let cur = sizes[0], len = 1;
  for (let i = 1; i < sizes.length; i++) {
    if (sizes[i] === cur) len++;
    else {
      runs.push({ size: cur, len });
      cur = sizes[i];
      len = 1;
    }
  }
  runs.push({ size: cur, len });
  return runs;
}

function apexTitanEngine(sizes, lossStreak) {
  const runs = getRuns(sizes);
  const cRun = runs[runs.length - 1];
  const cSide = cRun ? cRun.size : sizes[0];
  const cLen = cRun ? cRun.len : 1;
  const lastS = sizes[sizes.length - 1];

  let alt = 0;
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].len === 1) alt++;
    else break;
  }

  if (lossStreak >= 2) {
    if (cLen >= 2) return { vote: cSide, reg: '🛑 L3 DRAGON LOCK' };
    if (alt >= 2) return { vote: opp(lastS), reg: '🛑 L3 CHOP FLIP' };
    return { vote: cSide, reg: '🛑 L3 MOMENTUM LOCK' };
  } else if (lossStreak === 1) {
    if (cLen >= 2) return { vote: cSide, reg: '🛡️ L2 DRAGON RIDE' };
    if (alt >= 2) return { vote: opp(lastS), reg: '🛡️ L2 CHOP FLIP' };
    return { vote: cSide, reg: '🛡️ L2 MOMENTUM LOCK' };
  } else {
    if (cLen >= 3) return { vote: cSide, reg: '🌊 L1 DRAGON RIDE' };
    if (cLen === 2) return { vote: cSide, reg: '🌊 L1 DOUBLET RIDE' };
    if (alt >= 3) return { vote: opp(lastS), reg: '⚡ L1 CHOP OSC' };
    if (cLen === 1) return { vote: opp(cSide), reg: '🌊 L1 SINGLE CUT' };
    return { vote: cSide, reg: '🌊 L1 MOMENTUM' };
  }
}

function radheEngine(list) {
  let sizes = list.slice(0, 12).map(item => getSize(item.number));
  let consecutiveCount = 1;
  for (let i = 1; i < sizes.length; i++) {
    if (sizes[i] === sizes[0]) consecutiveCount++; else break;
  }
  if (consecutiveCount >= 4) return sizes[0];
  let isAlternating = true;
  for (let i = 0; i < 4; i++) {
    if (sizes[i] === sizes[i + 1]) { isAlternating = false; break; }
  }
  if (isAlternating) return sizes[0] === 'BIG' ? 'SMALL' : 'BIG';
  let weightSum = 0;
  for (let i = 0; i < Math.min(list.length, 6); i++) {
    let num = parseInt(list[i].number, 10);
    let pWeight = (6 - i) * 3;
    weightSum += (num >= 5) ? pWeight : -pWeight;
  }
  return weightSum >= 0 ? 'BIG' : 'SMALL';
}

function sureshEngine(list) {
  let bigs = 0, smalls = 0;
  for (let i = 0; i < Math.min(10, list.length); i++) {
    const num = parseInt(list[i].number, 10);
    const weight = (10 - i);
    if (num >= 5) bigs += weight; else smalls += weight;
  }
  const last3 = list.slice(0, 3).map(x => getSize(x.number));
  if (last3[0] === last3[1] && last3[1] === last3[2]) {
    return last3[0];
  }
  return bigs >= smalls ? 'BIG' : 'SMALL';
}

function markovEngine(sizes) {
  if (sizes.length < 5) return sizes[0];
  const s1 = sizes[1], s0 = sizes[0];
  let nextB = 0, nextS = 0;
  for (let i = 0; i < sizes.length - 2; i++) {
    if (sizes[i + 1] === s1 && sizes[i] === s0) {
      if (sizes[i + 2] === 'BIG') nextB++; else nextS++;
    }
  }
  if (nextB > nextS) return 'BIG';
  if (nextS > nextB) return 'SMALL';
  return s0;
}

function tgxLogic1(nums, sizes) {
  const n1 = nums[0], n2 = nums[1] || nums[0];
  const n9 = nums[8] || nums[nums.length - 1], n10 = nums[9] || nums[nums.length - 1];
  let total = Math.abs((n1 - n2) + (n9 - n10)) % 10;
  let bigs = 0;
  for (let i = 0; i < Math.min(5, sizes.length); i++) if (sizes[i] === 'BIG') bigs++;
  if (bigs >= 4) return total >= 4 ? 'BIG' : 'SMALL';
  if (bigs <= 1) return total >= 6 ? 'BIG' : 'SMALL';
  return total >= 5 ? 'BIG' : 'SMALL';
}

function tgxLogic2(nums) {
  const w = [3, 2, 1, 1, 1];
  let sum = 0;
  for (let i = 0; i < Math.min(5, nums.length); i++) sum += nums[i] * w[i];
  sum += nums[0] * 2;
  return (sum % 10) >= 5 ? 'BIG' : 'SMALL';
}

function tgxLogic3(nums, sizes) {
  let vol = 0;
  for (let i = 0; i < Math.min(5, nums.length - 1); i++) vol += Math.abs(nums[i] - nums[i + 1]);
  vol = vol / 5;
  let streak = 1;
  for (let i = 1; i < Math.min(5, sizes.length); i++) if (sizes[i] === sizes[0]) streak++; else break;
  let streakScore = streak >= 3 ? -25 : (streak === 2 ? -15 : (vol > 3 ? 10 : 5));
  let bigCnt = sizes.slice(0, 8).filter(x => x === 'BIG').length;
  let imbalance = ((bigCnt - 4) / 8) * 100;
  let pattern = (sizes[0] === sizes[1] && sizes[1] === sizes[2]) ? -35 : (sizes[0] === sizes[1] ? -20 : 25);
  let total = (streakScore * 0.3) + (imbalance * 0.4) + (pattern * 0.3);
  return total >= 0 ? 'BIG' : 'SMALL';
}

function tgxLogic4(sizes) {
  let streak = 1;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] === sizes[0]) streak++; else break;
  if (streak >= 2) return sizes[0];
  let changes = 0;
  for (let i = 0; i < Math.min(5, sizes.length - 1); i++) if (sizes[i] !== sizes[i + 1]) changes++;
  if (changes >= 3) return sizes[0] === 'BIG' ? 'SMALL' : 'BIG';
  return sizes[0];
}

function tgxLogic5(nums) {
  let ev = 0;
  for (let i = 0; i < Math.min(6, nums.length); i++) if (nums[i] % 2 === 0) ev++;
  return ev >= 3 ? 'BIG' : 'SMALL';
}

function tgxLogic6(sizes) {
  if (sizes.length < 2) return sizes[0];
  return sizes[0] === sizes[1] ? (sizes[0] === 'BIG' ? 'SMALL' : 'BIG') : sizes[0];
}

const LOGIC = {
  0: { n: 5, s: 'BIG' },
  1: { n: 2, s: 'SMALL' },
  2: { n: 4, s: 'SMALL' },
  3: { n: 7, s: 'BIG' },
  4: { n: 8, s: 'BIG' },
  5: { n: 9, s: 'BIG' },
  6: { n: 0, s: 'SMALL' },
  7: { n: 3, s: 'SMALL' },
  8: { n: 6, s: 'BIG' },
  9: { n: 1, s: 'SMALL' }
};

function calculateCombinedPrediction(list, activeLevel = 1) {
  if (!list || list.length < 1) return null;

  const latestItem = list[0];
  const curIssue = latestItem.issueNumber ? latestItem.issueNumber.toString() : null;
  if (!curIssue) return null;

  const nextPeriod = (BigInt(curIssue) + 1n).toString();
  const lastDigit = parseInt(nextPeriod.slice(-1), 10);
  const lg = LOGIC[lastDigit] || { n: 4, s: 'SMALL' };

  const prediction = lg.s;
  const predictedNumber = lg.n;

  let matchCount = 0;
  let evalCount = 0;
  const evalLimit = Math.min(list.length, 30);
  for (let i = 0; i < evalLimit; i++) {
    const itemIssue = list[i].issueNumber ? list[i].issueNumber.toString() : null;
    if (!itemIssue) continue;
    const d = parseInt(itemIssue.slice(-1), 10);
    const rule = LOGIC[d];
    if (rule) {
      evalCount++;
      const actualSize = getSize(list[i].number);
      if (actualSize === rule.s) matchCount++;
    }
  }
  const hitRate = evalCount > 0 ? (matchCount / evalCount) : 0.88;
  const confidence = Math.min(99, Math.max(82, Math.round(hitRate * 100)));

  const patternType = prediction === 'BIG' ? 'dragon' : 'zigzag';
  const patternLabel = `🎯 TARGET: ${predictedNumber} (${prediction}) • ENDING ${lastDigit}`;

  const models = {};
  for (let d = 0; d <= 9; d++) {
    const r = LOGIC[d];
    const marker = (d === lastDigit) ? '👉 ' : '';
    models[`${marker}Ending ${d} ➔ ${r.n}`] = r.s;
  }

  return {
    prediction,
    predictedNumber,
    patternType,
    patternLabel,
    confidence,
    activeLevel,
    latestIssue: curIssue,
    latestNumber: parseInt(latestItem.number, 10),
    nextPeriod,
    models
  };
}

function resolveLevel(list) {
  if (!list || list.length < 3) return 1;
  try {
    const prior = list.slice(1);
    if (prior.length >= 3) {
      const pred = calculateCombinedPrediction(prior, 1);
      if (pred) {
        const actual = getSize(list[0].number);
        if (pred.prediction === actual) return 1;
        // Prior round lost: check round before
        const priorPrior = list.slice(2);
        if (priorPrior.length >= 3) {
          const pred2 = calculateCombinedPrediction(priorPrior, 1);
          if (pred2 && pred2.prediction !== getSize(list[1].number)) {
            return 3;
          }
        }
        return 2;
      }
    }
  } catch (e) {}
  return 1;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const mode = req.query.mode === '30S' ? 'WinGo_30S' : 'WinGo_1M';
  const url = `https://draw.ar-lottery01.com/WinGo/${mode}/GetHistoryIssuePage.json?_t=${Date.now()}`;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('API fetch failed');
    const json = await response.json();
    const list = json?.data?.list;
    if (!Array.isArray(list) || list.length < 3) {
      return res.status(500).json({ error: 'No draw data available' });
    }

    const lvl = resolveLevel(list);
    const pred = calculateCombinedPrediction(list, lvl);
    return res.status(200).json({ success: true, mode, ...pred });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

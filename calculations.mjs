// Pure, offline calculations for the standalone design preview.
// They neither contact a service nor place, save or settle a bet.
export const MAX_AMOUNT_PAISE = 10_000_000_000; // ₹10,00,00,000.00
export const MIN_LEVELS = 1;
export const MAX_LEVELS = 20;

export class CalculationError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'CalculationError';
    this.code = code;
    this.details = details;
  }
}

export function parseRupees(value) {
  if (typeof value !== 'string') throw new CalculationError('INVALID_AMOUNT');
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new CalculationError('INVALID_AMOUNT');
  const paise = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(paise) || paise < 1 || paise > MAX_AMOUNT_PAISE) {
    throw new CalculationError('AMOUNT_OUT_OF_RANGE');
  }
  return paise;
}

// Divide the budget in the ratio 1:2:4:... using whole paise. Exact doubling
// and an exact total are not both possible when the budget is not divisible by
// the weight sum. Largest-remainder apportionment keeps every level within one
// paisa of its ideal share, without dumping a large remainder on the last level.
export function makeDoublingPlan(totalPaise, levels) {
  if (!Number.isSafeInteger(totalPaise) || totalPaise < 1 || totalPaise > MAX_AMOUNT_PAISE) {
    throw new CalculationError('AMOUNT_OUT_OF_RANGE');
  }
  if (!Number.isInteger(levels) || levels < MIN_LEVELS || levels > MAX_LEVELS) {
    throw new CalculationError('INVALID_LEVELS');
  }
  const totalWeight = 2 ** levels - 1;
  if (totalPaise < totalWeight) {
    throw new CalculationError('AMOUNT_TOO_SMALL', { minimumPaise: totalWeight, levels });
  }
  const denominator = BigInt(totalWeight);
  const shares = Array.from({ length: levels }, (_, index) => {
    const numerator = BigInt(totalPaise) * (1n << BigInt(index));
    return { index, paise: Number(numerator / denominator), fraction: numerator % denominator };
  });
  const sparePaise = totalPaise - shares.reduce((sum, share) => sum + share.paise, 0);
  const byFraction = [...shares].sort((a, b) => a.fraction === b.fraction ? a.index - b.index : a.fraction > b.fraction ? -1 : 1);
  for (let index = 0; index < sparePaise; index++) byFraction[index].paise++;
  return { totalPaise, levels, amountsPaise: shares.map((share) => share.paise) };
}

// Records are explicit predictions, not proof of wagers. A missing source is
// different from a connected, empty source. Reject duplicates instead of
// silently inflating counts; callers must resolve corrections upstream.
export function summarizePredictions(records, mode = 'all') {
  if (!['all', '30s', '1m'].includes(mode)) throw new CalculationError('INVALID_MODE');
  if (records == null) {
    return { available: false, total: null, wins: null, losses: null, pending: null, accuracyPercent: null };
  }
  if (!Array.isArray(records)) throw new CalculationError('INVALID_RECORDS');
  const seen = new Set();
  let total = 0, wins = 0, losses = 0, pending = 0;
  for (const record of records) {
    if (!record || typeof record !== 'object' || !['30s', '1m'].includes(record.mode)
      || typeof record.period !== 'string' || !/^\d{1,64}$/.test(record.period)) {
      throw new CalculationError('INVALID_RECORD');
    }
    const { prediction } = record;
    if (![null, 'BIG', 'SMALL', 'WAIT', 'NO EDGE'].includes(prediction)) {
      throw new CalculationError('INVALID_PREDICTION');
    }
    if (prediction === null || prediction === 'WAIT' || prediction === 'NO EDGE') continue;
    const outcome = record.outcome ?? null;
    if (![null, 'BIG', 'SMALL'].includes(outcome)) throw new CalculationError('INVALID_OUTCOME');
    const identity = `${record.mode}:${record.period}`;
    if (seen.has(identity)) throw new CalculationError('DUPLICATE_PREDICTION');
    seen.add(identity);
    if (mode !== 'all' && record.mode !== mode) continue;
    total++;
    if (outcome === null) pending++;
    else if (outcome === prediction) wins++;
    else losses++;
  }
  const settled = wins + losses;
  return { available: true, total, wins, losses, pending, accuracyPercent: settled ? (wins * 100) / settled : null };
}

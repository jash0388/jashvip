// KALI AI 4.0 — live client for the owner's existing Cloudflare Worker.
//
// Every request goes to the same origin (the Pages project), so the browser
// sends the `kali_device` and `kali_session` cookies automatically. Mutating
// endpoints additionally require a CSRF token plus an HMAC request signature,
// exactly as the deployed Worker verifies them:
//
//   sig = HMAC-SHA256(key = csrfToken,
//                     message = METHOD | path | ts | nonce | sha256hex(body))
//
// Nothing secret is stored in this file: the CSRF token is issued per device by
// the server and the signature is derived from it at call time.

const CLIENT_VERSION = '2026.10.28';
const CSRF_TTL_MS = 4 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12000;
const encoder = new TextEncoder();
let csrfCache = null;
let csrfFlight = null;

const hex = (buffer) => [...new Uint8Array(buffer)]
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');

async function sha256Hex(text) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

async function hmacHex(keyText, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(keyText),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function randomNonce() {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

async function csrfToken(force = false) {
  if (!force && csrfCache && Date.now() < csrfCache.expiresAt) return csrfCache.token;
  if (csrfFlight) return csrfFlight;
  csrfFlight = (async () => {
    const response = await fetch('/api/security/csrf', {
      credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', 'X-Client-Version': CLIENT_VERSION },
    });
    let data = null;
    try { data = await response.json(); } catch (_) { data = null; }
    if (!response.ok || typeof data?.token !== 'string') {
      throw new ApiError(response.status || 503, 'CSRF',
        data?.message || 'SECURITY CHECK UNAVAILABLE. TRY AGAIN.');
    }
    const expiresAt = Number(data.expiresAt);
    csrfCache = {
      token: data.token,
      expiresAt: Number.isFinite(expiresAt) && expiresAt > Date.now()
        ? Math.min(expiresAt, Date.now() + CSRF_TTL_MS) : Date.now() + CSRF_TTL_MS,
    };
    return csrfCache.token;
  })().finally(() => { csrfFlight = null; });
  return csrfFlight;
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || 'REQUEST FAILED');
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function send(path, method, body, retried = false) {
  const headers = { Accept: 'application/json', 'X-Client-Version': CLIENT_VERSION };
  const payload = body === null ? null : JSON.stringify(body);
  if (payload !== null) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    const token = await csrfToken(retried);
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = randomNonce();
    const bodyHash = await sha256Hex(payload ?? '');
    headers['X-Kali-Csrf'] = token;
    headers['X-Kali-Ts'] = ts;
    headers['X-Kali-Nonce'] = nonce;
    headers['X-Kali-Sig'] = await hmacHex(token, [method, path, ts, nonce, bodyHash].join('|'));
  }
  // Hard timeout: a stalled edge must never freeze the panel. The caller
  // treats the abort like any other network problem and keeps last-known data.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(path, {
      method, headers, body: payload, credentials: 'same-origin', cache: 'no-store',
      referrerPolicy: 'same-origin', signal: controller.signal,
    });
  } catch (problem) {
    throw new ApiError(0, 'NETWORK', 'NETWORK PROBLEM. CHECK YOUR CONNECTION AND TRY AGAIN.');
  } finally { clearTimeout(timer); }
  let data = null;
  try { data = await response.json(); } catch (_) { data = null; }
  if (response.status === 403 && method !== 'GET' && !retried
      && ['CSRF_REQUIRED', 'SIGNATURE_REQUIRED', 'SIGNATURE_EXPIRED', 'SIGNATURE_INVALID']
        .includes(data?.code)) {
    csrfCache = null;
    return send(path, method, body, true);
  }
  if (!response.ok) {
    throw new ApiError(response.status, data?.code || 'ERROR',
      data?.message || 'SERVICE IS NOT AVAILABLE RIGHT NOW.');
  }
  return data;
}

export const api = {
  get: (path) => send(path, 'GET', null),
  post: (path, body = {}) => send(path, 'POST', body),
};

// Fetch the CSRF token while the page is still painting. A mutating request
// then costs one round trip instead of two. Never awaited by the UI.
export function warm() {
  csrfToken().catch(() => {});
}

// --- licence / session -------------------------------------------------------
export const session = {
  async status() {
    try { return await api.get('/api/gate'); }
    catch (problem) {
      if (problem instanceof ApiError && (problem.status === 401 || problem.status === 403)) return null;
      throw problem;
    }
  },
  login(key, deviceHint) {
    return api.post('/api/licence/redeem', deviceHint ? { key, deviceHint } : { key });
  },
  async logout() {
    try { return await api.post('/api/licence/logout', {}); }
    catch (problem) {
      if (problem instanceof ApiError && problem.status < 500) return null;
      throw problem;
    }
  },
};

// --- catalogue / orders ------------------------------------------------------
export const catalogue = {
  setup: () => api.get('/api/setup-status'),
  createOrder: (plan, expectedAmountPaise) => api.post('/api/order/create',
    expectedAmountPaise === undefined ? { plan } : { plan, expectedAmountPaise }),
  claim: (utr) => api.post('/api/order/claim', { utr }),
  cancel: () => api.post('/api/order/cancel', {}),
  order: () => api.get('/api/order/status'),
};

// --- results / prediction ----------------------------------------------------
export const games = {
  results: (game) => api.get(`/api/results?game=${encodeURIComponent(game)}`),
  predict: (game) => api.post('/api/prediction', { game, mode: 'big-small' }),
};

// --- shared helpers ----------------------------------------------------------
export function sizeOf(digit) {
  const value = Number(digit);
  if (!Number.isInteger(value) || value < 0 || value > 9) return null;
  return value >= 5 ? 'BIG' : 'SMALL';
}

export function rememberName(name) {
  try { localStorage.setItem('kali4.name', String(name || '').slice(0, 40)); } catch (_) {}
}

export function savedName() {
  try { return localStorage.getItem('kali4.name') || ''; } catch (_) { return ''; }
}

export function forgetSession() {
  try { localStorage.removeItem('kali4.name'); } catch (_) {}
}

export const money = (amount) => new Intl.NumberFormat('en-IN',
  { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(amount) || 0);

export const DAY_MS = 86400000;

// --- on-device call ledger ---------------------------------------------------
// The Worker stores every call it issues, but it does not expose a history
// endpoint to the browser. To show honest TOTAL / WINS / LOSSES the client
// keeps the calls it has actually received on this device and settles them
// against the result feed. Nothing is invented: an unsettled call is not a win.
const LEDGER_KEY = 'kali4.calls';
const LEDGER_MAX = 500;
// v2: every row records the exact period the call is FOR (`target`). Before
// v2 a row only knew the period it was issued after, so the WIN/LOSS could be
// settled against the wrong draw (9353 vs 9354) and the history showed losses
// that were never losses. Rows without a target are dropped instead of being
// guessed at.
const LEDGER_VER = 2;

function readLedger() {
  let rows;
  try {
    const raw = JSON.parse(localStorage.getItem(LEDGER_KEY) || '[]');
    rows = Array.isArray(raw) ? raw.filter((row) => row && typeof row === 'object') : [];
  } catch (_) {
    return [];
  }
  const current = rows.filter((row) => row.v === LEDGER_VER
    && typeof row.target === 'string' && /^\d{10,24}$/.test(row.target));
  if (current.length !== rows.length) writeLedger(current);
  return current;
}

function writeLedger(rows) {
  try { localStorage.setItem(LEDGER_KEY, JSON.stringify(rows.slice(-LEDGER_MAX))); } catch (_) {}
}

export function recordCall({ game, afterIssue, call, probability, target }) {
  if (!game || (call !== 'BIG' && call !== 'SMALL')) return;
  const period = String(target || afterIssue || '');
  if (!/^\d{10,24}$/.test(period)) return;
  const rows = readLedger();
  if (rows.some((row) => row.game === game && row.target === period)) return;
  rows.push({ v: LEDGER_VER, game, target: period, afterIssue: String(afterIssue || period),
    call, probability: Number(probability), at: Date.now() });
  writeLedger(rows);
}

export function savedCalls(game) {
  const rows = readLedger();
  return game ? rows.filter((row) => row.game === game) : rows;
}

export function clearCalls(game) {
  const rows = readLedger();
  const kept = game ? rows.filter((row) => row.game !== game) : [];
  writeLedger(kept);
  return rows.length - kept.length;
}

// Honest settlement: a call is WIN/LOSS only when the result for ITS OWN
// period is present. No nearest-number guessing, no double counting, and a
// call that has not been drawn yet stays PENDING.
export function settleCalls(game, resultRows) {
  const rows = readLedger();
  const digits = new Map();
  for (const row of resultRows || []) {
    const issue = String(row.issueNumber ?? row.periodId ?? '');
    const digit = Number(row.number ?? row.resultDigit);
    if (!/^\d+$/.test(issue) || !Number.isInteger(digit) || digit < 0 || digit > 9) continue;
    digits.set(issue, digit);
  }
  let changed = false;
  for (const call of rows) {
    if (call.game !== game) continue;
    const digit = digits.get(call.target);
    if (!Number.isInteger(digit)) continue;
    const size = sizeOf(digit);
    if (!size) continue;
    if (call.result !== size) { call.result = size; changed = true; }
    const win = size === call.call;
    if (call.win !== win) { call.win = win; changed = true; }
    if (!call.settledAt) { call.settledAt = call.target; changed = true; }
  }
  if (changed) writeLedger(rows);
  const mine = rows.filter((row) => row.game === game);
  const settled = mine.filter((row) => row.result);
  const wins = settled.filter((row) => row.win === true).length;
  const losses = settled.filter((row) => row.win === false).length;
  const withProbability = mine.filter((row) => Number.isFinite(row.probability));
  const confidence = withProbability.length
    ? withProbability.reduce((sum, row) => sum + Math.max(row.probability, 1 - row.probability), 0) / withProbability.length
    : null;
  // only real, settled rows count: pending calls are never a win or a loss
  return { total: mine.length, settled: settled.length, wins, losses, pending: mine.length - settled.length,
    confidence, rows: mine };
}

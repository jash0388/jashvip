// Vercel Serverless Function proxying KALI AI 4.0 backend
const REMOTE = "https://haodw83xgjs.pages.dev";
const RELAY = "https://r.jina.ai/";
const PERIOD_MS = { "30s": 30000, "1m": 60000 };
const CACHE_TTL_MS = 3000;
const CACHE = {};
const LAST = {};
const COOLDOWN = { until: 0, reason: "" };

function extractJson(text) {
  const i = text.indexOf("{");
  const j = text.lastIndexOf("}");
  if (i < 0 || j <= i) throw new Error("no json in relay body");
  return JSON.parse(text.slice(i, j + 1));
}

async function relayJson(path, timeout = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(RELAY + REMOTE + path, {
      signal: ctrl.signal,
      headers: {
        "Accept": "text/plain",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
      }
    });
    const text = await res.text();
    return extractJson(text);
  } finally {
    clearTimeout(timer);
  }
}

async function remoteJson(path, timeout = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(REMOTE + path, {
      signal: ctrl.signal,
      headers: {
        "Accept": "application/json",
        "X-Client-Version": "2026.10.28",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
      }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (err) {
    return await relayJson(path);
  } finally {
    clearTimeout(timer);
  }
}

function tickedIssue(key, now) {
  const last = LAST[key];
  if (!last) return null;
  const [issue, at] = last;
  try {
    return String(BigInt(issue) + BigInt(Math.floor((now - at) / PERIOD_MS[key])));
  } catch (e) {
    return issue;
  }
}

function softPayload(key, now, engineState, message = null) {
  const issue = tickedIssue(key, now);
  return {
    status: "OK",
    game: key,
    prediction: null,
    call: null,
    afterIssue: issue,
    currentIssue: issue,
    issue: issue,
    targetIssue: issue,
    probabilityBig: null,
    probability: null,
    confidence: message || "WAITING FOR ENGINE",
    edgePp: null,
    engine: engineState,
    release: null,
    measuredAt: null,
    openEnd: now + PERIOD_MS[key]
  };
}

async function enginePayload(game = "30s") {
  const key = game in PERIOD_MS ? game : "30s";
  const now = Date.now();
  const hit = CACHE[key];
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return { data: hit.payload, status: 200 };
  }
  if (now < COOLDOWN.until) {
    if (hit) {
      const p = { ...hit.payload, stale: true, cooldownMs: COOLDOWN.until - now };
      return { data: p, status: 200 };
    }
    return { data: softPayload(key, now, "COOLDOWN", "UPSTREAM RATE LIMIT - WAITING"), status: 200 };
  }

  let e;
  try {
    e = await remoteJson("/api/engine?game=" + key);
  } catch (err) {
    COOLDOWN.until = now + 60000;
    COOLDOWN.reason = String(err.message || err);
    if (hit) {
      const p = { ...hit.payload, stale: true, upstream: COOLDOWN.reason };
      return { data: p, status: 200 };
    }
    return { data: softPayload(key, now, "COOLDOWN", "UPSTREAM RATE LIMIT - WAITING"), status: 200 };
  }

  if (!e || e.status !== "OK") {
    if (hit) {
      const p = { ...hit.payload, stale: true, upstream: e?.message };
      return { data: p, status: 200 };
    }
    return { data: softPayload(key, now, "WAITING", e?.message || "UPSTREAM BUSY"), status: 200 };
  }

  const pb = e.probabilityBig;
  const prob = typeof pb === "number" ? Math.max(pb, 1 - pb) : null;
  const payload = {
    status: "OK",
    game: e.game || key,
    prediction: e.prediction,
    call: e.prediction,
    afterIssue: e.afterIssue,
    currentIssue: e.afterIssue,
    issue: e.afterIssue,
    targetIssue: e.afterIssue,
    probabilityBig: pb,
    probability: prob,
    confidence: e.confidence,
    edgePp: e.edgePp,
    engine: e.engine,
    historyAvailable: e.historyAvailable,
    historyRequired: e.historyRequired,
    release: e.release,
    measuredAt: e.measuredAt,
    openEnd: (e.measuredAt || now) + PERIOD_MS[key]
  };

  CACHE[key] = { at: now, payload };
  if (e.afterIssue) {
    LAST[key] = [e.afterIssue, e.measuredAt || now];
  }
  return { data: payload, status: 200 };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const url = new URL(req.url, `http://${req.headers['x-forwarded-host'] || req.headers.host || 'localhost'}`);
  let pathname = url.pathname;
  // Normalize if path rewrite passed query param or direct path
  if (!pathname.startsWith('/api')) {
    pathname = '/api/' + pathname.replace(/^\/+/, '');
  }

  let body = {};
  if (req.body) {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }

  const game = url.searchParams.get('game') || body.game || '30s';

  if (pathname === '/api/prediction' || pathname === '/api/engine') {
    const { data, status } = await enginePayload(game);
    return res.status(status).json(data);
  }

  if (pathname === '/api/gate') {
    return res.status(200).json({
      status: "OK",
      name: "KALI AI 4.0",
      plan: "LOCAL ENGINE",
      deviceLabel: "Local",
      expiresAt: Date.now() + 30 * 86400000
    });
  }

  if (pathname === '/api/security/csrf') {
    return res.status(200).json({
      status: "OK",
      token: "local-" + Math.floor(Date.now() / 1000),
      expiresAt: Date.now() + 240000
    });
  }

  if (pathname === '/api/results') {
    return res.status(200).json({ status: "OK", rows: [], currentIssue: null });
  }

  if (pathname === '/api/setup-status') {
    try {
      const data = await remoteJson("/api/setup-status");
      return res.status(200).json(data);
    } catch (e) {
      return res.status(200).json({ status: "OK", maintenance: false, payments: false, plans: [] });
    }
  }

  if (pathname === '/api/order/status') {
    return res.status(401).json({ status: "ORDER_NOT_FOUND", message: "NO ORDER ON THIS DEVICE" });
  }

  if (pathname === '/api/health') {
    return res.status(200).json({ status: "OK", name: "KALI AI 4.0", mode: "local engine proxy" });
  }

  if (pathname === '/api/licence/redeem') {
    const now = Date.now();
    return res.status(200).json({
      status: "OK",
      session: {
        keyHash: "local-demo",
        deviceId: "local-demo",
        durationLabel: "LOCAL DEMO",
        durationMs: 0,
        activatedAtMs: now,
        expiresAtMs: 0,
        status: "ACTIVE",
        sessionSig: "SIG_LOCAL_DEMO"
      }
    });
  }

  if (pathname === '/api/licence/logout') {
    return res.status(200).json({ status: "OK" });
  }

  if (pathname === '/api/order/create' || pathname === '/api/order/claim' || pathname === '/api/order/cancel') {
    return res.status(200).json({ status: "OK", order: null });
  }

  return res.status(404).json({ status: "NOT_FOUND", message: "UNKNOWN API ROUTE" });
};

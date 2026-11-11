// KALI AI 4.0 — screen wiring for the live Worker.
//
// The visual layer is untouched: this file only fills real values into the
// existing 4.0 markup and never invents a number. If the server cannot answer,
// the screen says so instead of showing a placeholder that looks like data.

import {
  ApiError, api, catalogue, games, money, recordCall, rememberName, savedName,
  clearCalls, forgetSession, savedCalls, session, settleCalls, sizeOf, DAY_MS,
} from './api.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = { page: document.body.dataset.page || '', game: '30s', gate: null, setup: null };

// The connection pill must mean something: it is "online" when the last
// request was answered (even with a server error), and "no link" only when the
// browser could not reach the Worker at all. "CHECKING" is a starting state,
// never a resting one — that is what made a perfectly good network look dead.
function markOnline() { connectStatus('online', 'ONLINE'); }
function markOffline() { connectStatus('offline', 'NO LINK'); }

const MODE_KEY = 'kali4.game';
function savedMode() {
  try { const v = localStorage.getItem(MODE_KEY); return v === '1m' ? '1m' : v === '30s' ? '30s' : null; } catch (_) { return null; }
}
function saveMode(game) {
  try { localStorage.setItem(MODE_KEY, game === '1m' ? '1m' : '30s'); } catch (_) {}
}
// Both pages read the same mode, so the panel and the history can never
// disagree about which game the calls belong to.
function syncModeButtons() {
  $$('[data-mode]').forEach((button) => {
    const mine = (button.dataset.mode === '1m' ? '1m' : '30s') === state.game;
    button.classList.toggle('selected', mine);
    button.setAttribute('aria-pressed', mine ? 'true' : 'false');
  });
  const label = $('#prediction-mode') || $('#history-mode');
  if (label) label.textContent = state.game === '1m' ? '1 MIN' : '30 SEC';
}

function connectStatus(kind, label) {
  $$('[data-conn]').forEach((node) => {
    node.classList.toggle('is-offline', kind === 'offline');
    const dot = node.querySelector('.status-dot');
    if (dot) dot.dataset.state = kind;
    const text = [...node.childNodes].reverse().find((n) => n.nodeType === 3 && n.textContent.trim());
    if (text) text.textContent = ` ${label}`;
    else node.append(document.createTextNode(` ${label}`));
    node.setAttribute('aria-live', 'polite');
  });
}

function say(node, message, tone = 'info') {
  if (!node) return;
  node.textContent = message;
  node.dataset.tone = tone;
  node.hidden = false;
}

function fail(node, problem) {
  if (problem instanceof ApiError) {
    if (problem.code === 'MAINTENANCE') return say(node, 'MAINTENANCE IS ON. PLEASE TRY AGAIN LATER.', 'warn');
    if (problem.status === 0) return say(node, 'CONNECTION IS BUSY. RETRYING AUTOMATICALLY…', 'warn');
    return say(node, problem.message, 'warn');
  }
  return say(node, 'NETWORK PROBLEM. CHECK YOUR CONNECTION AND TRY AGAIN.', 'warn');
}

function loginRedirect() {
  const next = location.pathname.split('/').pop() || 'overview.html';
  location.replace(`index.html?next=${encodeURIComponent(next)}`);
}

async function requireSession() {
  try {
    const gate = await session.status();
    state.gate = gate;
    markOnline();
    if (!gate) { loginRedirect(); return null; }
    return gate;
  } catch (problem) {
    // An answered server (even a 5xx) proves the link works; only a real
    // transport failure is "no link". The session is re-checked on the next
    // successful call, so the panel is never stuck on a stale state.
    if (problem instanceof ApiError && problem.status > 0) markOnline();
    else markOffline();
    return null;
  }
}

function lastFour(issue) {
  const text = String(issue ?? '').replace(/\D/g, '');
  return text.length >= 4 ? text.slice(-4) : (text || '—');
}

function daysLeft(expiresAt) {
  const left = Number(expiresAt) - Date.now();
  if (!Number.isFinite(left) || left <= 0) return '0';
  return String(Math.max(1, Math.ceil(left / DAY_MS)));
}

// Sign-out is available on every inside page (overview, prediction,
// history, analytics, fund) so a logged-in user can always leave.
// The server revokes the D1 session; the browser only clears its name.
function bindSignOut() {
  const out = $('#sign-out');
  if (!out || out.dataset.bound) return;
  out.dataset.bound = '1';
  out.addEventListener('click', async () => {
    out.disabled = true;
    try { await session.logout(); } catch (_) {}
    forgetSession();
    location.replace('index.html');
  });
}

// --------------------------------------------------------------------------
// LOGIN
// --------------------------------------------------------------------------
async function initLogin() {
  const form = $('#login-form') || $('.entry-card');
  const nameInput = $('#login-name');
  const keyInput = $('#login-key');
  const button = $('#login-submit');
  const note = $('#login-note');
  if (!form || !nameInput || !keyInput || !button) return;

  nameInput.value = savedName();
  connectStatus('checking', 'CHECKING');

  const pendingOrder = (() => {
    try { return localStorage.getItem('kali4.pendingKey') || ''; } catch (_) { return ''; }
  })();
  if (pendingOrder) {
    keyInput.value = pendingOrder;
    say(note, 'YOUR NEW KEY WAS FILLED IN. PRESS LOGIN.', 'ok');
  }

  try {
    const gate = await session.status();
    if (gate) { connectStatus('online', 'ONLINE'); location.replace('overview.html'); return; }
    connectStatus('online', 'READY');
  } catch (_) { connectStatus('offline', 'NO LINK'); }

  const submit = async (event) => {
    event?.preventDefault();
    const name = nameInput.value.trim();
    const key = keyInput.value.trim().toUpperCase();
    if (!name) { say(note, 'ENTER YOUR NAME.', 'warn'); nameInput.focus(); return; }
    if (!/^KALI-[A-F0-9]{32}$/.test(key)) { say(note, 'KEY LOOKS WRONG. IT IS KALI- FOLLOWED BY 32 CHARACTERS.', 'warn'); keyInput.focus(); return; }
    button.disabled = true;
    say(note, 'CHECKING YOUR KEY…');
    try {
      await session.login(key);
      rememberName(name);
      try { localStorage.removeItem('kali4.pendingKey'); } catch (_) {}
      say(note, 'KEY ACCEPTED. OPENING YOUR PANEL…', 'ok');
      const next = new URLSearchParams(location.search).get('next');
      location.replace(next && /^[a-z0-9-]+\.html$/.test(next) ? next : 'overview.html');
    } catch (problem) {
      button.disabled = false;
      fail(note, problem);
    }
  };
  form.addEventListener('submit', submit);
  button.addEventListener('click', submit);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); keyInput.focus(); } });
  keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(e); });
}

// --------------------------------------------------------------------------
// OVERVIEW
// --------------------------------------------------------------------------
async function initOverview() {
  connectStatus('checking', 'CHECKING');
  const gate = await requireSession();
  if (!gate) return;
  const name = savedName();
  const heading = $('#welcome-name');
  if (heading) heading.textContent = name ? name.toUpperCase() : 'KALI MEMBER';
  const plan = $('#welcome-sub');
  if (plan) plan.textContent = String(gate.name || gate.plan || 'KALI AI').toUpperCase();
  const planName = $('#plan-name');
  if (planName) planName.textContent = String(gate.name || gate.plan || 'KALI AI').toUpperCase();
  const days = $('#plan-days');
  if (days) days.textContent = `${daysLeft(gate.expiresAt)} DAY${daysLeft(gate.expiresAt) === '1' ? '' : 'S'} LEFT`;
  bindSignOut();
}

// --------------------------------------------------------------------------
// PROOF GALLERY (available without a session, like the 3.0 page)
// --------------------------------------------------------------------------
function initProofs() {
  const dialog = $('#proof-dialog');
  const image = $('#proof-image');
  if (!dialog || !image) return;
  $$('[data-proof]').forEach((card) => card.addEventListener('click', () => {
    image.src = card.dataset.proof;
    image.alt = card.querySelector('img')?.alt || 'User supplied result screenshot';
    if (!dialog.open) dialog.showModal();
  }));
  $('[data-close-proof]')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
}

// --------------------------------------------------------------------------
// BIG / SMALL
// --------------------------------------------------------------------------
// KALI AI 4.0 — prediction panel: instant paint, then live updates.
//
// Speed rules (owner: "startup par loading nahi joie, wingo badle etle turant"):
//  1. nothing is awaited before the cached panel is already on screen;
//  2. the last known call + results are painted from this device at once;
//  3. the network is asked in parallel, never in sequence;
//  4. the auto loop re-asks the moment a period turns over (scheduleNext),
//     not on a fixed 7s/12s timer;
//  5. a slow or dead feed can never freeze the panel: there is always a
//     request timeout, and the cached value stays on screen.
async function initPrediction() {
  connectStatus('checking', 'CHECKING');
  const restored = savedMode();
  if (restored) state.game = restored;
  syncModeButtons();

  const value = $('#prediction-value');
  const badge = $('#prediction-badge');
  const note = $('#prediction-note');
  const period = $('#prediction-period');
  const modeLabel = $('#prediction-mode');
  const confidence = $('#prediction-confidence');
  const resultsRow = $('#results-row');
  const resultsPill = $('#results-pill');
  const days = $('#plan-days');

  const paint = (call, issue, probability, tone) => {
    if (value) { value.textContent = call || '—'; value.dataset.call = call || ''; }
    if (period) period.textContent = issue ? lastFour(issue) : '—';
    if (modeLabel) modeLabel.textContent = state.game === '1m' ? '1 MIN' : '30 SEC';
    if (confidence) {
      const p = Number(probability);
      confidence.textContent = Number.isFinite(p)
        ? `${Math.round(Math.max(p, 1 - p) * 100)}%` : '—';
    }
    if (badge) { badge.textContent = tone; badge.dataset.state = call ? 'live' : 'ready'; }
  };

  // ---------------------------------------------------------------- cache --
  // The panel opens instantly with what this device already knew. The server
  // answer replaces it a moment later; nothing is invented locally.
  const cacheAll = (() => {
    try { return JSON.parse(localStorage.getItem('kali4.panel') || 'null') || {}; } catch (_) { return {}; }
  })();
  const readCache = (game) => (cacheAll && typeof cacheAll[game] === 'object' ? cacheAll[game] : null);
  const writeCache = (game, patch) => {
    try {
      cacheAll[game] = { ...(cacheAll[game] || {}), ...patch, at: Date.now() };
      localStorage.setItem('kali4.panel', JSON.stringify(cacheAll));
    } catch (_) {}
  };

  const cached = readCache(state.game);
  if (cached) {
    paint(cached.call, cached.issue, cached.probability, 'LAST CALL');
    if (cached.rows?.length) drawResults(cached.rows);
  }

  // -------------------------------------------------------------- results --
  function drawResults(rows) {
    if (!resultsRow) return;
    if (!rows.length) {
      resultsRow.replaceChildren(Object.assign(document.createElement('p'),
        { className: 'result-empty', textContent: 'NO ROUNDS YET' }));
      if (resultsPill) resultsPill.textContent = 'NO DATA';
      return;
    }
    resultsRow.replaceChildren(...rows.map((row) => {
      const chip = document.createElement('div');
      chip.className = 'result-chip';
      const digit = document.createElement('b');
      digit.textContent = String(row.number ?? row.resultDigit ?? '—');
      const side = sizeOf(row.number ?? row.resultDigit);
      digit.dataset.call = side || '';
      const small = document.createElement('small');
      small.textContent = lastFour(row.issueNumber ?? row.periodId);
      const tag = document.createElement('span');
      tag.textContent = side || '—';
      tag.dataset.call = side || '';
      chip.append(digit, small, tag);
      return chip;
    }));
    if (resultsPill) resultsPill.textContent = `LAST ${rows.length}`;
  }

  // One results request at a time; a duplicate call (mode switch + auto poll)
  // rides on the request already in flight instead of queueing another.
  let resultsInflight = null;
  function loadResults() {
    if (!resultsRow) return Promise.resolve();
    if (resultsInflight) return resultsInflight;
    resultsInflight = (async () => {
      try {
        const data = await games.results(state.game);
        markOnline();
        const rows = Array.isArray(data.rows) ? data.rows.slice(0, 10) : [];
        drawResults(rows);
        if (rows.length) writeCache(state.game, { rows });
        if (resultsPill && rows.length && data.currentIssue) {
          resultsPill.textContent = `LAST ${rows.length}`;
        }
      } catch (problem) {
        if (problem instanceof ApiError && problem.status === 0) markOffline(); else markOnline();
        if (!resultsRow.querySelector('.result-chip') && resultsPill) resultsPill.textContent = 'UNAVAILABLE';
        if (!resultsRow.querySelector('.result-chip')) {
          resultsRow.replaceChildren(Object.assign(document.createElement('p'),
            { className: 'result-empty', textContent: 'RESULTS ARE PAUSED BY THE OWNER RIGHT NOW.' }));
        }
      } finally { resultsInflight = null; }
    })();
    return resultsInflight;
  }

  // ----------------------------------------------------------------- modes --
  $$('[data-mode]').forEach((button) => button.addEventListener('click', () => {
    const next = button.dataset.mode === '1m' ? '1m' : '30s';
    if (next === state.game && button.getAttribute('aria-pressed') === 'true') return;
    state.game = next;
    saveMode(next);
    syncModeButtons();
    lastIssue = '';
    const again = readCache(state.game);
    if (again) paint(again.call, again.issue, again.probability, 'LAST CALL');
    else paint(null, null, null, 'READY');
    if (resultsRow) resultsRow.replaceChildren();
    if (resultsPill) resultsPill.textContent = 'LOADING';
    loadResults();
    autoCall(true);
  }));

  // The newest settled period that is actually on screen. A call is only
  // settled by a real result, never by an assumed one, so the same rows feed
  // the history WIN/LOSS and the panel label.
  const shownTop = () => {
    let top = '';
    for (const chip of (resultsRow?.querySelectorAll('.result-chip') || [])) {
      const text = chip.querySelector('small')?.textContent?.replace(/\D/g, '') || '';
      if (text.length === 4 && (!top || text > top)) top = text;
    }
    return top;
  };

  // 9353 -> 9354: one period ahead of the newest settled draw. The server
  // sends a full issue number; if it is the settled one, bump it by one so the
  // label can never repeat the last result.
  const liveIssue = (raw, top) => {
    const issue = String(raw || '').replace(/\D/g, '');
    if (!issue) return '';
    if (!top || issue.slice(-4) !== top) return issue;
    const bumped = String(BigInt(issue) + 1n);
    return bumped;
  };

  // ------------------------------------------------------------------ poll --
  // A period is 30s or 60s. We ask just after the open period should have
  // turned over, so a new call appears within ~1s of the new period instead
  // of waiting out a fixed timer. A slow request never stacks up.
  let attempting = false;
  let timer = null;
  let lastIssue = cached?.issue || '';
  let lastDay = cached?.days || '';

  const nextDelay = (openEnd) => {
    const periodMs = state.game === '1m' ? 60000 : 30000;
    const at = Number(openEnd);
    if (!Number.isFinite(at) || at <= 0) return 2000;
    return Math.min(periodMs, Math.max(700, at - Date.now() + 800));
  };

  const autoCall = async (force = false) => {
    if (attempting) return;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    attempting = true;
    try {
      const data = await games.predict(state.game);
      markOnline();
      const call = data.prediction === 'BIG' || data.prediction === 'SMALL' ? data.prediction : null;
      // The label is ALWAYS one period ahead of the newest settled draw that
      // the panel is showing (9353 settled -> 9354 running). If the answer
      // carries the period that is already in the results strip, the call is
      // stale and is not painted.
      const issue = liveIssue(data.currentIssue || data.afterIssue, shownTop());
      if (!issue) {
        timer = setTimeout(() => autoCall(), 1200);
        return;
      }
      paint(call, issue, data.probabilityBig, call ? 'AUTO CALL' : 'NO CALL');
      if (note) { note.hidden = true; note.textContent = ''; }
      writeCache(state.game, { call, issue, probability: data.probabilityBig, openEnd: data.openEnd });
      if (issue && (force || issue !== lastIssue)) {
        recordCall({ game: state.game, afterIssue: issue, target: issue, call, probability: data.probabilityBig });
        lastIssue = issue;
      }
      loadResults();
      timer = setTimeout(() => autoCall(), nextDelay(data.openEnd));
    } catch (problem) {
      // A closed period is the normal race at the boundary: retry at once
      // instead of showing a failure the customer cannot act on.
      if (problem instanceof ApiError && problem.code === 'PERIOD_CLOSED') {
        timer = setTimeout(() => autoCall(), 900);
        return;
      }
      if (problem instanceof ApiError && problem.code === 'PREDICTION_PAUSED') {
        if (note) { note.hidden = false; note.textContent = problem.message || ''; }
        if (badge) { badge.textContent = 'PAUSED'; badge.dataset.state = 'warn'; }
        timer = setTimeout(() => autoCall(), 15000);
        return;
      }
      if (problem instanceof ApiError && problem.status === 503) {
        timer = setTimeout(() => autoCall(), 2000);
        return;
      }
      if (problem instanceof ApiError && problem.status === 0) markOffline(); else markOnline();
      if (badge && !cached) { badge.textContent = 'NO CALL'; badge.dataset.state = 'warn'; }
      fail(note, problem);
      timer = setTimeout(() => autoCall(), 5000);
    } finally {
      attempting = false;
    }
  };

  // Coming back to the tab, or restoring from the back/forward cache, must
  // refresh immediately — the panel is never stale on screen.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) autoCall(); });
  window.addEventListener('pageshow', () => autoCall());
  window.addEventListener('online', () => autoCall());

  // Access check runs in parallel with the first call, so a slow gate never
  // delays the panel. A rejection still costs nothing: the server refuses the
  // data anyway and the redirect happens the moment the gate answers.
  requireSession().then((gate) => {
    if (!gate) return;
    bindSignOut();
    // expiry label: always refreshed from the last gate answer, and paused
    // time is shown as paused (maintenance freezes the countdown)
    if (days) {
      const left = daysLeft(gate.expiresAt);
      const paused = gate.maintenancePaused === true;
      days.textContent = `${paused ? 'PAUSED · ' : ''}${left} DAY${left === '1' ? '' : 'S'} LEFT`;
      lastDay = days.textContent;
    }
  });

  // Start everything at once.
  loadResults();
  autoCall();
}

// --------------------------------------------------------------------------
// HISTORY
// --------------------------------------------------------------------------
function tableShell(message) {
  const tbody = $('#history-body');
  if (!tbody) return null;
  tbody.replaceChildren();
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = 4;
  const box = document.createElement('div');
  box.className = 'history-empty';
  const strong = document.createElement('strong');
  strong.textContent = message;
  box.append(strong);
  td.append(box);
  tr.append(td);
  tbody.append(tr);
  return tbody;
}

// History = the user's own prediction calls, settled WIN/LOSS per period.
// It never shows raw last-10 results as if they were the user's history.
async function loadHistory() {
  const pill = $('#history-pill');
  if (pill) pill.textContent = 'LOADING';
  try {
    const data = await games.results(state.game);
    markOnline();
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const tbody = $('#history-body');
    if (!tbody) return;
    const summary = settleCalls(state.game, rows);
    const mine = (summary.rows || []).slice().reverse();
    const countNode = $('#history-count');
    const settled = summary.settled;
    const wins = summary.wins;
    const losses = summary.losses;
    if (countNode) countNode.textContent = mine.length
      ? `${mine.length} CALLS · ${wins} WIN · ${losses} LOSS · ${summary.pending} PENDING`
      : 'SAVED ON THIS DEVICE';
    if (!mine.length) {
      tableShell('NO CALLS YET.');
      if (pill) pill.textContent = 'NO CALLS';
      return;
    }
    tbody.replaceChildren(...mine.map((call) => {
      const tr = document.createElement('tr');
      const issue = document.createElement('td');
      issue.textContent = lastFour(call.target || call.afterIssue);
      const callTd = document.createElement('td');
      callTd.textContent = call.call || '—';
      callTd.dataset.call = call.call || '';
      const result = document.createElement('td');
      result.textContent = call.result || '—';
      result.dataset.call = call.result || '';
      const winLoss = document.createElement('td');
      if (!call.result) { winLoss.textContent = 'PENDING'; winLoss.dataset.result = 'PENDING'; }
      else if (call.win) { winLoss.textContent = 'WIN'; winLoss.dataset.result = 'WIN'; }
      else { winLoss.textContent = 'LOSS'; winLoss.dataset.result = 'LOSS'; }
      tr.append(issue, callTd, result, winLoss);
      return tr;
    }));
    if (pill) pill.textContent = summary.settled
      ? `${summary.wins}W · ${summary.losses}L`
      : `${summary.total} CALLS`;
  } catch (problem) {
    if (problem instanceof ApiError && problem.status === 0) markOffline(); else markOnline();
    tableShell('HISTORY IS NOT AVAILABLE');
    if (pill) pill.textContent = 'NO DATA';
    fail($('#history-note'), problem);
  }
}

async function initHistory() {
  connectStatus('checking', 'CHECKING');
  const restored = savedMode();
  if (restored) state.game = restored;
  syncModeButtons();
  const gate = await requireSession();
  if (!gate) return;
  bindSignOut();
  // CLEAR HISTORY: removes only this device's saved calls (the Worker keeps
  // the real records). It never touches licences, payments or results.
  const clearButton = $('#clear-history');
  if (clearButton) clearButton.addEventListener('click', async () => {
    const count = savedCalls(state.game).length;
    const note = $('#clear-history-note');
    if (!count) { if (note) { note.hidden = false; note.textContent = 'NOTHING TO CLEAR ON THIS DEVICE.'; } return; }
    if (!confirm('CLEAR ' + count + ' SAVED CALL' + (count === 1 ? '' : 'S') + ' FROM THIS DEVICE?')) return;
    clearButton.disabled = true;
    try {
      clearCalls(state.game);
      if (note) { note.hidden = true; note.textContent = ''; }
      await loadHistory();
    } finally { clearButton.disabled = false; }
  });
  if ($('#history-mode')) $('#history-mode').textContent = '30 SEC';
  $$('[data-mode]').forEach((button) => button.addEventListener('click', () => {
    state.game = button.dataset.mode === '1m' ? '1m' : '30s';
    saveMode(state.game);
    syncModeButtons();
    loadHistory();
  }));
  await loadHistory();
}

// --------------------------------------------------------------------------
// ANALYTICS
// --------------------------------------------------------------------------
async function initAnalytics() {
  connectStatus('checking', 'CHECKING');
  const gate = await requireSession();
  if (!gate) return;
  bindSignOut();
  const set = (key, text, description) => {
    const node = $(`[data-prediction-stat="${key}"]`);
    if (node) node.textContent = text;
    const note = node?.parentElement?.querySelector('[data-stat-description]');
    if (note && description) note.textContent = description;
  };
  try {
    const data = await games.results(state.game);
    markOnline();
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const summary = settleCalls(state.game, rows);
    set('total', String(summary.total), `${summary.total} CALLS`);
    set('wins', String(summary.wins), `${summary.wins} SETTLED`);
    set('losses', String(summary.losses), `${summary.losses} SETTLED`);
    const pill = $('#analytics-pill');
    if (pill) pill.textContent = summary.settled ? `${summary.settled} SETTLED` : 'NO SETTLED';
    const accuracy = $('#accuracy-value');
    if (accuracy) accuracy.textContent = summary.settled
      ? `${Math.round((summary.wins / summary.settled) * 100)}%` : '—';
    const confidence = $('#confidence-value');
    if (confidence) confidence.textContent = Number.isFinite(summary.confidence)
      ? `${Math.round(summary.confidence * 100)}%` : '—';
    const note = $('#analytics-note');
    if (note) say(note, summary.total
      ? `${summary.total} CALLS RECORDED ON THIS DEVICE, ${summary.settled} SETTLED. ACCURACY IS MEASURED ONLY ON SETTLED CALLS AND IS NOT A PROMISE OF FUTURE RESULTS.`
      : 'NO CALLS YET.', 'info');
  } catch (problem) {
    set('total', '—'); set('wins', '—'); set('losses', '—');
    fail($('#analytics-note'), problem);
  }
}

// --------------------------------------------------------------------------
// FUND (inside the panel: session required, sign-out available)
// --------------------------------------------------------------------------
async function initFund() {
  connectStatus('checking', 'CHECKING');
  const gate = await requireSession();
  if (!gate) return;
  bindSignOut();
}

// --------------------------------------------------------------------------
// PLANS + CHECKOUT
// --------------------------------------------------------------------------
const PLAN_ORDER = ['TRITROL', 'V2', 'STAGE', 'GAMMA'];

function orderPanel() {
  let panel = $('#checkout');
  if (panel) return panel;
  const dialog = $('#plan-dialog');
  if (!dialog) return null;
  panel = document.createElement('div');
  panel.id = 'checkout';
  panel.className = 'checkout-panel';
  panel.hidden = true;
  const close = $('[data-close-plan]', dialog);
  dialog.insertBefore(panel, close ?? null);
  return panel;
}

async function startOrder(code, amountPaise) {
  const panel = orderPanel();
  if (!panel) return;
  panel.hidden = false;
  panel.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = 'CREATING YOUR ORDER…';
  panel.append(title);
  try {
    const order = await catalogue.createOrder(code, amountPaise);
    panel.replaceChildren();
    const head = document.createElement('strong');
    head.textContent = `PAY ${money(order.amount)} ON UPI`;
    const amountNote = document.createElement('small');
    amountNote.textContent = `ORDER ${order.orderId} · ${order.name || code}`;
    const link = document.createElement('a');
    link.className = 'entry-button';
    link.href = order.upiUrl || '#';
    link.rel = 'noopener';
    link.textContent = 'OPEN UPI APP';
    const label = document.createElement('label');
    label.textContent = 'UTR / REFERENCE NUMBER';
    const input = document.createElement('input');
    input.inputMode = 'numeric';
    input.autocomplete = 'one-time-code';
    input.placeholder = '12 DIGITS';
    input.maxLength = 12;
    label.append(input);
    const claim = document.createElement('button');
    claim.type = 'button';
    claim.className = 'plan-select';
    claim.textContent = 'I HAVE PAID';
    const note = document.createElement('p');
    note.className = 'checkout-note';
    note.textContent = 'PAY THE EXACT AMOUNT, THEN ENTER THE 12-DIGIT UTR. A KEY IS ISSUED ONLY AFTER THE PAYMENT IS MATCHED.';
    panel.append(head, amountNote, link, label, claim, note);

    claim.addEventListener('click', async () => {
      const utr = input.value.replace(/\D/g, '');
      if (utr.length !== 12) { note.textContent = 'ENTER THE 12-DIGIT UTR FROM YOUR UPI APP.'; return; }
      claim.disabled = true;
      note.textContent = 'CHECKING YOUR PAYMENT…';
      try {
        let view = await catalogue.claim(utr);
        let tries = 0;
        while (view.status !== 'PAID' && tries < 8) {
          await new Promise((resolve) => setTimeout(resolve, 4000));
          view = await catalogue.order();
          tries += 1;
        }
        if (view.status === 'PAID' && view.licenceKey) {
          const key = document.createElement('strong');
          key.textContent = `YOUR KEY: ${view.licenceKey}`;
          const copy = document.createElement('button');
          copy.type = 'button';
          copy.className = 'plan-select';
          copy.textContent = 'COPY KEY';
          copy.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(view.licenceKey); copy.textContent = 'COPIED'; }
            catch (_) { copy.textContent = 'COPY FAILED'; }
          });
          const go = document.createElement('a');
          go.className = 'entry-button';
          go.href = 'index.html';
          go.textContent = 'GO TO LOGIN';
          try { localStorage.setItem('kali4.pendingKey', view.licenceKey); } catch (_) {}
          panel.replaceChildren(key, copy, go);
          return;
        }
        note.textContent = view.status === 'CLAIMED'
          ? 'UTR RECEIVED. THE OWNER MUST MATCH IT BEFORE A KEY IS ISSUED — THIS CAN TAKE A FEW MINUTES.'
          : `ORDER STATE: ${view.status}. CONTACT SUPPORT IF YOU ALREADY PAID.`;
      } catch (problem) {
        fail(note, problem);
      } finally {
        claim.disabled = false;
      }
    });
  } catch (problem) {
    panel.replaceChildren();
    const note = document.createElement('p');
    note.className = 'checkout-note';
    panel.append(note);
    fail(note, problem);
  }
}

async function initPlans() {
  connectStatus('checking', 'CHECKING');
  // Until a licence is active the panel must not be reachable: no menu button,
  // no bottom navigation, nothing that opens an inside page.
  try {
    const gate = await session.status();
    if (!gate) document.body.classList.add('is-guest');
  } catch (_) { document.body.classList.add('is-guest'); }
  let setup = null;
  try { setup = await catalogue.setup(); state.setup = setup; connectStatus('online', 'ONLINE'); }
  catch (_) { connectStatus('offline', 'NO LINK'); }

  const notice = $('#plans-notice');
  if (setup) {
    const byDays = new Map((setup.plans || []).map((plan) => [Number(plan.days), plan]));
    const cards = $$('.access-plan');
    const codes = [];
    cards.forEach((card, index) => {
      const daysText = $('.plan-duration', card)?.textContent || '';
      const days = Number((daysText.match(/\d+/) || [])[0]);
      const plan = byDays.get(days) || (setup.plans || [])[index];
      if (!plan) return;
      codes[index] = plan.code;
      card.dataset.planCode = plan.code;
      card.dataset.amountPaise = String(Math.round(plan.amount * 100));
      const price = $('.plan-price strong', card);
      if (price) price.textContent = money(plan.amount).replace('.00', '');
      const select = $('.plan-select', card);
      if (select) {
        select.dataset.planName = plan.name;
        select.dataset.planDays = `${plan.days} DAYS`;
        select.dataset.planPrice = money(plan.amount).replace('.00', '');
      }
    });
    if (notice) {
      // no maintenance / "closed" banner: the plans page only shows live prices
      notice.hidden = true;
      notice.textContent = '';
    }
  }

  const dialog = $('#plan-dialog');
  if (!dialog) return;
  const buy = $('.checkout-disabled', dialog);
  const note = $('#plan-dialog-note');
  if (buy) {
    const enabled = Boolean(state.setup?.payments);
    buy.disabled = !enabled;
    buy.classList.toggle('is-disabled', !enabled);
    buy.textContent = '';
    buy.append(document.createTextNode(enabled ? 'BUY NOW ' : 'CHECKOUT CLOSED '));
    buy.addEventListener('click', () => {
      if (buy.disabled) return;
      const code = dialog.dataset.planCode;
      if (!code) return;
      location.href = `pay4.html?plan=${encodeURIComponent(code)}`;
    });
  }
  if (note) {
    note.textContent = state.setup?.payments
      ? 'THE SERVER SETS THE PRICE. YOUR KEY APPEARS HERE AFTER THE PAYMENT IS MATCHED.'
      : 'CHECKOUT IS CLOSED RIGHT NOW. NOTHING IS CHARGED AND NO ORDER IS CREATED.';
  }
  $$('.plan-select[data-plan-name]').forEach((button) => button.addEventListener('click', () => {
    const card = button.closest('.access-plan');
    if (card) {
      dialog.dataset.planCode = card.dataset.planCode || '';
      dialog.dataset.amountPaise = card.dataset.amountPaise || '';
    }
    const panel = $('#checkout');
    if (panel) { panel.hidden = true; panel.replaceChildren(); }
    if (note) note.textContent = state.setup?.payments
      ? 'THE SERVER SETS THE PRICE. YOUR KEY APPEARS HERE AFTER THE PAYMENT IS MATCHED.'
      : 'CHECKOUT IS CLOSED RIGHT NOW. NOTHING IS CHARGED AND NO ORDER IS CREATED.';
  }));
}

// --------------------------------------------------------------------------
const PAGES = {
  login: initLogin,
  overview: initOverview,
  prediction: initPrediction,
  history: initHistory,
  analytics: initAnalytics,
  fund: initFund,
  plans: initPlans,
};

(function boot() {
  const run = PAGES[state.page];
  initProofs();
  if (!run) return;
  const start = () => { run().catch(() => connectStatus('offline', 'NO LINK')); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();

export { state, PLAN_ORDER };

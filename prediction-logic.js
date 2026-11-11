// KALI AI 4.0 — client-side prediction logic extracted from wired.js
// NOTE: the real engine runs server-side (POST /api/prediction).
// This file is what the browser actually does: render the call, record it, settle it.
// Extracted blocks: initPrediction, initOverview, lastFour, requireSession

// ================= initPrediction =================
function initPrediction() {
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
    if (document.hidden) return;
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

// ================= initOverview =================
function initOverview() {
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

// ================= lastFour =================
function lastFour(issue) {
  const text = String(issue ?? '').replace(/\D/g, '');
  return text.length >= 4 ? text.slice(-4) : (text || '—');
}

// ================= requireSession =================
function requireSession() {
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


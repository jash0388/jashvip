// Cache the shared pure calculations with the same content-derived version as
// this entry module. The local preview server also sends no-store responses.
const coreUrl = new URL('./calculations.mjs', import.meta.url);
coreUrl.search = new URL(import.meta.url).search;
const { CalculationError, parseRupees, makeDoublingPlan, summarizePredictions } = await import(coreUrl.href);

(() => {
  'use strict';
  // Standalone visual review: no account, prediction engine, result feed, payment,
  // external service, storage writes or client-side URL-writing router.
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const menu = $('#mobile-menu');

  $('[data-skip]')?.addEventListener('click', (event) => {
    event.preventDefault();
    const target = $('#main-content');
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start' });
  });
  if (menu) {
    $('.menu-trigger')?.addEventListener('click', () => { if (!menu.open) menu.showModal(); });
    $$('[data-close-menu]').forEach((button) => button.addEventListener('click', () => menu.close()));
    menu.addEventListener('click', (event) => {
      if (event.target !== menu) return;
      const box = menu.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) menu.close();
    });
  }

  // Plan cards are reference-only visual choices; no order, price lookup or
  // checkout request is made, and nothing is stored or sent.
  const planDialog = $('#plan-dialog');
  if (planDialog) {
    $$('[data-plan-name]').forEach((button) => button.addEventListener('click', () => {
      $('#plan-dialog-title').textContent = button.dataset.planName;
      $('#plan-dialog-days').textContent = button.dataset.planDays;
      $('#plan-dialog-price').textContent = button.dataset.planPrice;
      if (!planDialog.open) planDialog.showModal();
    }));
    $$('[data-close-plan]', planDialog).forEach((button) => button.addEventListener('click', () => planDialog.close()));
    planDialog.addEventListener('click', (event) => {
      if (event.target !== planDialog) return;
      const box = planDialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) planDialog.close();
    });
  }

  $$('[data-mode]').forEach((button) => button.addEventListener('click', () => {
    const selectedMode = button.dataset.mode;
    $$('[data-mode]').forEach((item) => {
      const selected = item.dataset.mode === selectedMode;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    const label = selectedMode === '30s' ? '30 SEC' : '1 MIN';
    $$('[data-mode-label]').forEach((item) => { item.textContent = label; });
    const announcement = $('[data-mode-announcement]');
    if (announcement) announcement.textContent = `${label} MODE SELECTED.`;
  }));

  // No prediction or outcome source is connected here. An absent source must
  // remain unavailable, not be displayed as a fabricated zero or record.
  if ($('#analytics-summary')) {
    const snapshot = summarizePredictions(null);
    $$('[data-prediction-stat]').forEach((value) => {
      const count = snapshot[value.dataset.predictionStat];
      value.textContent = snapshot.available ? String(count) : '—';
      value.parentElement.querySelector('[data-stat-description]').textContent = snapshot.available ? String(count) : 'UNAVAILABLE';
    });
  }

  const form = $('#fund-form');
  if (!form) return;
  const amount = $('#fund-amount');
  const levels = $('#fund-levels');
  const error = $('#fund-error');
  const output = $('#fund-output');
  const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const currency = (paise) => money.format(paise / 100);

  function clearError() {
    error.hidden = true;
    error.textContent = '';
    amount.removeAttribute('aria-invalid');
    levels.removeAttribute('aria-invalid');
  }
  function emptyFund() {
    output.classList.remove('has-values');
    const mark = document.createElement('span');
    mark.className = 'output-icon';
    mark.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-spark');
    svg.append(use);
    mark.append(svg);
    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = 'YOUR PLAN WILL APPEAR HERE';
    const small = document.createElement('small');
    small.textContent = 'ENTER AN AMOUNT TO SEE YOUR LEVELS.';
    text.append(strong, small);
    output.replaceChildren(mark, text);
  }
  function showError(message, target = amount) {
    error.textContent = message;
    error.hidden = false;
    target.setAttribute('aria-invalid', 'true');
    emptyFund();
    target.focus();
  }
  amount.addEventListener('input', () => { clearError(); emptyFund(); });
  levels.addEventListener('change', () => { clearError(); emptyFund(); });
  form.addEventListener('reset', () => { clearError(); emptyFund(); });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    clearError();
    let plan;
    try {
      plan = makeDoublingPlan(parseRupees(amount.value), Number(levels.value));
    } catch (problem) {
      if (!(problem instanceof CalculationError)) throw problem;
      if (problem.code === 'INVALID_AMOUNT') return showError('ENTER AN AMOUNT USING DIGITS AND UP TO TWO DECIMAL PLACES.');
      if (problem.code === 'AMOUNT_OUT_OF_RANGE') return showError('ENTER AN AMOUNT BETWEEN ₹0.01 AND ₹10,00,00,000.00.');
      if (problem.code === 'INVALID_LEVELS') return showError('CHOOSE BETWEEN 1 AND 20 LEVELS.', levels);
      if (problem.code === 'AMOUNT_TOO_SMALL') return showError(`FOR ${problem.details.levels} LEVELS, ENTER AT LEAST ${currency(problem.details.minimumPaise)}.`);
      throw problem;
    }
    const heading = document.createElement('strong');
    heading.textContent = `${currency(plan.totalPaise)} · ${plan.levels} ${plan.levels === 1 ? 'LEVEL' : 'LEVELS'}`;
    const note = document.createElement('small');
    note.textContent = plan.levels === 1 ? 'ONE LEVEL USES THE FULL BUDGET.'
      : 'LEVELS FOLLOW 1×, 2×, 4× AND SO ON. ROUNDED TO PAISE TO MATCH THE TOTAL.';
    const list = document.createElement('div');
    list.className = 'level-list';
    plan.amountsPaise.forEach((paise, index) => {
      const item = document.createElement('div');
      item.className = 'level-item';
      const label = document.createElement('span');
      label.textContent = `LEVEL ${index + 1}`;
      const value = document.createElement('b');
      value.textContent = currency(paise);
      item.append(label, value);
      list.append(item);
    });
    const total = document.createElement('p');
    total.className = 'level-total';
    total.textContent = `TOTAL: ${currency(plan.totalPaise)}`;
    output.classList.add('has-values');
    output.replaceChildren(heading, note, list, total);
  });
})();

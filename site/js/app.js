/*
 * bigtechcalc.com — UI controller
 *
 * All calculation lives in engine.js. This file only reads inputs,
 * calls the engine, and paints the result. It never does arithmetic on
 * compensation figures itself.
 */

import {
  blankOffer, defaultScenarios, projectOffer, projectAllScenarios,
  validateSchedule, VEST_PRESETS, alignSeries, crossovers, leaderByPeriod,
  applyAppreciationCap, encodeState, decodeState, r2,
} from './engine.js';

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const MAX_OFFERS = 6;

// Offer line colours, drawn from the PEFG family. Burgundy is reserved
// for errors and warnings and is deliberately not in this list.
const SERIES_COLORS = ['#0D1F3C', '#7FA8CC', '#8A6410', '#4A7A9B', '#1A3A5C', '#B08D3F'];

const COMPONENT_COLORS = {
  baseSalary:    '#0D1F3C',
  bonus:         '#4A7A9B',
  signOn:        '#7FA8CC',
  initialVest:   '#8A6410',
  refresherVest: '#C9A961',
};

const state = {
  offers: [],
  scenarios: defaultScenarios(),
  horizon: 10,
  alignment: 'tenure',
  baselineId: null,
  displayScenario: 'medium',
  activeTab: null,
  cap: { enabled: true, value: 0.20 },
  results: null,
};

const fmt0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtSh = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const money  = (v) => fmt0.format(v || 0);
const money2 = (v) => fmt2.format(v || 0);
const pct    = (v) => (v * 100).toFixed(2).replace(/\.00$/, '') + '%';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.appendChild(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Seed                                                                */
/* ------------------------------------------------------------------ */

function seed() {
  const y = new Date().getFullYear();
  const base = blankOffer({
    company: 'Current employer', ticker: '', isBaseline: true,
    startYear: y, baseSalary: 275000, meritPct: 0.03,
    bonusTargetPct: 0.20, bonusInYear1: true,
    signOnTotal: 0, signOnSchedule: [1],
    grantPrice: 100, initialGrantValue: 0,
    refresherValue: 180000, refresherFirstYear: y,
    refresherGrowthPct: 0.03,
  });
  const a = blankOffer({
    company: 'Offer A', ticker: '',
    startYear: y, baseSalary: 300000, meritPct: 0.03,
    bonusTargetPct: 0.20, bonusInYear1: false,
    signOnTotal: 100000, signOnSchedule: [0.5, 0.5],
    grantPrice: 150, initialGrantValue: 600000,
    initialSchedule: JSON.parse(JSON.stringify(VEST_PRESETS.frontLoaded4)),
    refresherValue: 200000, refresherFirstYear: y + 1,
    refresherGrowthPct: 0.03,
  });
  const b = blankOffer({
    company: 'Offer B', ticker: '',
    startYear: y, baseSalary: 275000, meritPct: 0.04,
    bonusTargetPct: 0.15, bonusInYear1: false,
    signOnTotal: 50000, signOnSchedule: [1],
    grantPrice: 400, initialGrantValue: 900000,
    refresherValue: 250000, refresherFirstYear: y + 1,
    refresherGrowthPct: 0.05,
  });
  state.offers = [base, a, b];
  state.baselineId = base.id;
  state.activeTab = a.id;
}

/* ------------------------------------------------------------------ */
/* Offer form                                                          */
/* ------------------------------------------------------------------ */

function numField(label, value, onChange, opts = {}) {
  const input = el('input', {
    type: 'number', value: value, step: opts.step || 'any',
    min: opts.min !== undefined ? opts.min : null,
    onInput: (e) => onChange(e.target.value === '' ? 0 : parseFloat(e.target.value)),
  });
  return el('div', { class: 'field' },
    el('label', {}, label), input,
    opts.hint ? el('span', { class: 'hint' }, opts.hint) : null);
}

function pctField(label, value, onChange, opts = {}) {
  const input = el('input', {
    type: 'number', value: r2(value * 100), step: opts.step || '0.1',
    onInput: (e) => onChange((parseFloat(e.target.value) || 0) / 100),
  });
  return el('div', { class: 'field' },
    el('label', {}, label + ' (%)'), input,
    opts.hint ? el('span', { class: 'hint' }, opts.hint) : null);
}

function textField(label, value, onChange, opts = {}) {
  return el('div', { class: 'field' },
    el('label', {}, label),
    el('input', { type: 'text', value: value || '', placeholder: opts.placeholder || '',
      onInput: (e) => onChange(e.target.value) }),
    opts.hint ? el('span', { class: 'hint' }, opts.hint) : null);
}

function selectField(label, value, options, onChange, opts = {}) {
  const sel = el('select', { onChange: (e) => onChange(e.target.value) });
  for (const [v, t] of options) {
    sel.appendChild(el('option', { value: v, selected: String(v) === String(value) }, t));
  }
  return el('div', { class: 'field' },
    el('label', {}, label), sel,
    opts.hint ? el('span', { class: 'hint' }, opts.hint) : null);
}

/** Vesting schedule editor with presets and a live 100% check. */
function vestEditor(title, schedule, onChange) {
  const box = el('div', { class: 'vest-editor' });
  const presetOpts = [['', 'Load a template…'], ...Object.entries(VEST_PRESETS).map(([k, v]) => [k, v.label])];

  const presetSel = el('select', {
    onChange: (e) => {
      if (!e.target.value) return;
      onChange(JSON.parse(JSON.stringify(VEST_PRESETS[e.target.value])));
      render();
    },
  });
  for (const [v, t] of presetOpts) presetSel.appendChild(el('option', { value: v }, t));

  const granSel = el('select', {
    onChange: (e) => {
      const g = e.target.value;
      const next = JSON.parse(JSON.stringify(schedule));
      next.granularity = g;
      onChange(next);
      render();
    },
  });
  for (const [v, t] of [['annual', 'Annual'], ['quarterly', 'Quarterly'], ['monthly', 'Monthly']]) {
    granSel.appendChild(el('option', { value: v, selected: schedule.granularity === v }, t));
  }

  const head = el('div', { style: 'display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:12px' },
    el('div', { class: 'field', style: 'flex:1;min-width:200px;margin:0' },
      el('label', {}, title + ' — template'), presetSel),
    el('div', { class: 'field', style: 'width:130px;margin:0' },
      el('label', {}, 'Granularity'), granSel));

  const v = validateSchedule(schedule);
  const rowLabel = schedule.granularity === 'annual' ? 'Yr'
    : schedule.granularity === 'quarterly' ? 'Q' : 'M';

  const totalEl = el('span', { class: 'vest-total' });
  const errEl = el('ul', { class: 'errors', style: 'margin-top:10px' });

  // Updated in place on every keystroke. A full re-render would move
  // focus out of the field the user is typing in.
  function refreshTotal() {
    const c = validateSchedule(schedule);
    totalEl.className = 'vest-total ' + (c.ok ? 'ok' : 'bad');
    totalEl.textContent =
      `Total ${(c.sum * 100).toFixed(2)}%` + (c.ok ? ' ✓' : ' — must be 100%');
    errEl.innerHTML = '';
    if (!c.ok) for (const e of c.errors) errEl.appendChild(el('li', {}, e));
    errEl.style.display = c.ok ? 'none' : '';
  }

  const grid = el('div', { class: 'vest-row' });
  const shown = schedule.events.slice(0, schedule.granularity === 'annual' ? 8 : 24);
  for (const ev of shown) {
    grid.appendChild(el('div', { class: 'vest-cell' },
      el('label', {}, rowLabel + ev.periodIndex),
      el('input', {
        type: 'number', value: r2(ev.percent * 100), step: '0.01',
        onInput: (e) => {
          ev.percent = (parseFloat(e.target.value) || 0) / 100;
          onChange(schedule);
          refreshTotal();
          scheduleRecalc();
        },
      })));
  }
  if (schedule.events.length > shown.length) {
    grid.appendChild(el('div', { class: 'small', style: 'align-self:center;padding-left:8px' },
      `+${schedule.events.length - shown.length} more periods (edit via a template)`));
  }

  refreshTotal();

  box.append(head, grid,
    el('div', { style: 'display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap' },
      totalEl,
      el('button', { class: 'ghost', onClick: () => {
        const next = JSON.parse(JSON.stringify(schedule));
        const n = next.events.length;
        const step = next.granularity === 'annual' ? 1
          : next.granularity === 'quarterly' ? 1 : 1;
        next.events.push({ periodIndex: (next.events[n - 1]?.periodIndex || 0) + step, percent: 0 });
        onChange(next); render();
      } }, '+ period'),
      schedule.events.length > 1 ? el('button', { class: 'ghost', onClick: () => {
        const next = JSON.parse(JSON.stringify(schedule));
        next.events.pop();
        onChange(next); render();
      } }, '− period') : null));

  box.appendChild(errEl);
  return box;
}

function offerPane(o) {
  const pane = el('div', { class: 'offer-pane', role: 'tabpanel', id: 'pane-' + o.id });
  const set = (k) => (v) => { o[k] = v; scheduleRecalc(); };
  const setRe = (k) => (v) => { o[k] = v; render(); };

  // --- Company ---
  const tickerRow = el('div', { class: 'grid-4' },
    textField('Company name', o.company, setRe('company')),
    textField('Ticker', o.ticker, set('ticker'), { placeholder: 'e.g. MSFT' }),
    numField('Start calendar year', o.startYear, (v) => { o.startYear = Math.round(v); scheduleRecalc(); }, { step: '1' }),
    el('div', { class: 'field' },
      el('label', {}, 'Market data'),
      el('div', { class: 'inline', style: 'min-height:36px' },
        el('button', {
          class: 'ghost', style: 'padding:6px 10px',
          disabled: o.isPrivate ? '' : null,
          onClick: () => fetchTicker(o),
        }, 'Look up'),
        el('span', { class: 'small', id: 'tick-' + o.id }, o._tickerNote || ''))));

  const privacyRow = el('div', { class: 'inline', style: 'margin-bottom:14px' },
    el('input', {
      type: 'checkbox', id: 'priv-' + o.id, checked: o.isPrivate ? '' : null,
      onChange: (e) => { o.isPrivate = e.target.checked; render(); },
    }),
    el('label', { for: 'priv-' + o.id }, 'Private company — no public share price'),
    el('span', { style: 'width:22px' }),
    el('input', {
      type: 'radio', name: 'baseline', id: 'base-' + o.id,
      checked: state.baselineId === o.id ? '' : null,
      onChange: () => { state.baselineId = o.id; render(); },
    }),
    el('label', { for: 'base-' + o.id }, 'This is my current compensation (baseline)'));

  // --- Cash ---
  const cash = el('fieldset', {}, el('legend', {}, 'Cash'),
    el('div', { class: 'grid-3' },
      numField('Base salary at start', o.baseSalary, set('baseSalary'), { min: 0, step: '1000' }),
      pctField('Merit increase per year', o.meritPct, set('meritPct'),
        { hint: 'Scenario multipliers apply on top of this.' }),
      pctField('Bonus target, % of base', o.bonusTargetPct, set('bonusTargetPct'))),
    el('div', { class: 'grid-3' },
      selectField('Bonus basis', o.bonusBasis,
        [['current', 'Current-year base'], ['prior', 'Prior-year base']], set('bonusBasis'),
        { hint: 'Keep this the same across offers or the comparison is not like-for-like.' }),
      selectField('Bonus paid in year 1?', o.bonusInYear1 ? 'yes' : 'no',
        [['no', 'No'], ['yes', 'Yes']], (v) => { o.bonusInYear1 = v === 'yes'; scheduleRecalc(); },
        { hint: 'Usually No for a new offer, Yes for your current job.' }),
      el('div')));

  // --- Sign-on ---
  const signOnCells = el('div', { class: 'vest-row' });
  const soTotalEl = el('span', {
    class: 'vest-total', style: 'margin-top:8px;align-self:flex-start',
  });
  function refreshSignOn() {
    const sum = o.signOnSchedule.reduce((a, b) => a + b, 0);
    const good = o.signOnTotal === 0 || Math.abs(sum - 1) < 1e-6;
    soTotalEl.className = 'vest-total ' + (good ? 'ok' : 'bad');
    soTotalEl.style.cssText = 'margin-top:8px;align-self:flex-start';
    soTotalEl.textContent =
      `Total ${(sum * 100).toFixed(0)}%` + (good ? ' ✓' : ' — must be 100%');
  }

  const maxInstall = Math.max(3, o.signOnSchedule.length);
  for (let i = 0; i < maxInstall; i++) {
    signOnCells.appendChild(el('div', { class: 'vest-cell' },
      el('label', {}, 'Yr' + (i + 1)),
      el('input', {
        type: 'number', step: '1',
        value: r2((o.signOnSchedule[i] || 0) * 100),
        onInput: (e) => {
          o.signOnSchedule[i] = (parseFloat(e.target.value) || 0) / 100;
          refreshSignOn();
          scheduleRecalc();
        },
      })));
  }
  refreshSignOn();

  const signon = el('fieldset', {}, el('legend', {}, 'Sign-on bonus'),
    el('div', { class: 'grid-2' },
      numField('Sign-on total', o.signOnTotal, (v) => {
        o.signOnTotal = v; refreshSignOn(); scheduleRecalc();
      }, { min: 0, step: '1000' }),
      el('div', { class: 'field' },
        el('label', {}, 'Payout schedule, % per year'),
        signOnCells, soTotalEl)));

  // --- Equity ---
  const equity = el('fieldset', {}, el('legend', {}, 'Equity'),
    el('div', { class: 'grid-3' },
      numField('Grant-date share price', o.grantPrice, set('grantPrice'), {
        min: 0.01, step: '0.01',
        hint: o.isPrivate ? 'Private: enter your 409A or preferred price per share.' : 'Price on your grant date, not today.',
      }),
      numField('Initial grant value ($)', o.initialGrantValue, set('initialGrantValue'), { min: 0, step: '1000' }),
      selectField('First vest timing', String(o.firstVestOffsetYears),
        [['1', 'Year after the grant'], ['0', 'In the grant year']],
        (v) => { o.firstVestOffsetYears = parseInt(v, 10); scheduleRecalc(); },
        { hint: 'Annual schedules only. Check your offer letter — this moves the numbers.' })),
    el('div', { style: 'margin-bottom:14px' },
      vestEditor('Initial grant vesting', o.initialSchedule, (s) => { o.initialSchedule = s; scheduleRecalc(); })),
    el('div', { class: 'grid-4' },
      numField('Refresher value, first grant ($)', o.refresherValue, set('refresherValue'), { min: 0, step: '1000' }),
      numField('First refresher year', o.refresherFirstYear, (v) => { o.refresherFirstYear = Math.round(v); scheduleRecalc(); }, { step: '1' }),
      pctField('Refresher grant growth per year', o.refresherGrowthPct, set('refresherGrowthPct'),
        { hint: 'Grant SIZE growth. Not share price.' }),
      numField('Refresher slots', o.refresherSlots, (v) => { o.refresherSlots = Math.round(v); scheduleRecalc(); }, { min: 0, step: '1' })),
    el('div', {},
      vestEditor('Refresher vesting', o.refresherSchedule, (s) => { o.refresherSchedule = s; scheduleRecalc(); })));

  pane.append(tickerRow, privacyRow, cash, signon, equity);

  if (state.offers.length > 1) {
    pane.appendChild(el('div', { class: 'btn-row', style: 'margin-top:16px' },
      el('button', { class: 'danger', onClick: () => removeOffer(o.id) }, 'Remove this offer')));
  }
  return pane;
}

/* ------------------------------------------------------------------ */
/* Market data                                                         */
/* ------------------------------------------------------------------ */

async function fetchTicker(o) {
  const note = $('#tick-' + o.id);
  if (!o.ticker) { if (note) note.textContent = 'Enter a ticker first.'; return; }
  if (note) note.textContent = 'Looking up…';
  try {
    const r = await fetch(`/.netlify/functions/market-data?ticker=${encodeURIComponent(o.ticker)}`);
    if (!r.ok) throw new Error('lookup failed');
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    o._market = d;
    o.grantPrice = d.price || o.grantPrice;
    o._tickerNote = `${d.symbol} $${r2(d.price)}`;
    render();
  } catch (e) {
    // Every path degrades to manual entry. The tool stays fully usable.
    o._tickerNote = 'Unavailable — enter price manually';
    if (note) note.textContent = o._tickerNote;
  }
}

function marketContextNote() {
  const withData = state.offers.filter((o) => o._market && o._market.cagr5 !== null && o._market.cagr5 !== undefined);
  if (!withData.length) return null;
  return el('div', { class: 'notice' },
    el('strong', {}, 'Trailing performance, context only. '),
    'Past performance does not indicate future results, and these figures are not applied to the projection automatically. ',
    ...withData.map((o) => el('div', { class: 'mono small', style: 'margin-top:6px' },
      `${o._market.symbol}: 1-yr ${o._market.return1y !== null ? pct(o._market.return1y) : 'n/a'} · ` +
      `5-yr CAGR ${o._market.cagr5 !== null ? pct(o._market.cagr5) : 'n/a'}` +
      (o._market.asOf ? ` · as of ${o._market.asOf}` : ''))));
}

/* ------------------------------------------------------------------ */
/* Compute                                                             */
/* ------------------------------------------------------------------ */

function effectiveScenarios() {
  const s = JSON.parse(JSON.stringify(state.scenarios));
  for (const k of Object.keys(s)) {
    const c = applyAppreciationCap(s[k].priceAppreciation, state.cap.value, state.cap.enabled);
    s[k].priceAppreciation = c.applied;
    s[k]._uncapped = c.uncapped;
    s[k]._wasCapped = c.wasCapped;
  }
  return s;
}

function compute() {
  const scen = effectiveScenarios();
  const byScenario = { conservative: [], medium: [], aggressive: [] };
  const errors = [];

  for (const o of state.offers) {
    for (const k of ['conservative', 'medium', 'aggressive']) {
      const res = projectOffer(o, scen[k], state.horizon);
      if (!res.valid) {
        for (const e of res.errors) {
          const msg = `${o.company}: ${e}`;
          if (!errors.includes(msg)) errors.push(msg);
        }
      } else {
        byScenario[k].push(res);
      }
    }
  }
  state.results = { byScenario, errors, scen };
  return state.results;
}

let recalcTimer = null;
function scheduleRecalc() {
  clearTimeout(recalcTimer);
  recalcTimer = setTimeout(() => { compute(); renderResults(); }, 140);
}

/* ------------------------------------------------------------------ */
/* Charts — hand-rolled SVG, no chart library                          */
/* ------------------------------------------------------------------ */

const NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) n.setAttribute(k, v);
  return n;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * mag;
}

function abbrev(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return '$' + (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e3) return '$' + Math.round(v / 1e3) + 'k';
  return '$' + Math.round(v);
}

function drawCumulativeChart(container, legendEl) {
  container.innerHTML = '';
  legendEl.innerHTML = '';
  const R = state.results;
  if (!R || !R.byScenario.medium.length) return;

  const W = 880, H = 340;
  const M = { t: 14, r: 18, b: 38, l: 66 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;

  const disp = state.displayScenario;
  const series = alignSeries(R.byScenario[disp], state.alignment, state.horizon);
  const lo = alignSeries(R.byScenario.conservative, state.alignment, state.horizon);
  const hi = alignSeries(R.byScenario.aggressive, state.alignment, state.horizon);

  const xs = series[0].points.map((p) => p.x);
  let maxY = 0;
  for (const s of hi) for (const p of s.points) maxY = Math.max(maxY, p.cumulative);
  for (const s of series) for (const p of s.points) maxY = Math.max(maxY, p.cumulative);
  maxY = niceMax(maxY * 1.05);

  const X = (i) => M.l + (xs.length === 1 ? iw / 2 : (i / (xs.length - 1)) * iw);
  const Y = (v) => M.t + ih - (v / maxY) * ih;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': `Cumulative gross compensation by ${state.alignment === 'tenure' ? 'tenure year' : 'calendar year'} for each offer under the ${disp} scenario.`,
  });

  // Gridlines + y axis
  for (let g = 0; g <= 4; g++) {
    const v = (maxY / 4) * g;
    const y = Y(v);
    svg.appendChild(svgEl('line', { x1: M.l, x2: W - M.r, y1: y, y2: y, stroke: '#0D1F3C', 'stroke-opacity': g === 0 ? 0.3 : 0.1 }));
    const t = svgEl('text', { x: M.l - 9, y: y + 4, 'text-anchor': 'end', fill: '#6B7A90', 'font-size': 11, 'font-family': 'IBM Plex Mono, monospace' });
    t.textContent = abbrev(v);
    svg.appendChild(t);
  }
  // X axis
  xs.forEach((x, i) => {
    if (xs.length > 11 && i % 2 === 1) return;
    const t = svgEl('text', { x: X(i), y: H - 14, 'text-anchor': 'middle', fill: '#6B7A90', 'font-size': 11, 'font-family': 'IBM Plex Mono, monospace' });
    t.textContent = state.alignment === 'tenure' ? 'Y' + x : x;
    svg.appendChild(t);
  });

  // Band for the active offer only — one band, or the chart becomes mud.
  const activeIdx = Math.max(0, series.findIndex((s) => s.offerId === state.activeTab));
  if (lo[activeIdx] && hi[activeIdx]) {
    const up = hi[activeIdx].points.map((p, i) => `${X(i)},${Y(p.cumulative)}`);
    const dn = lo[activeIdx].points.map((p, i) => `${X(i)},${Y(p.cumulative)}`).reverse();
    svg.appendChild(svgEl('polygon', {
      points: [...up, ...dn].join(' '),
      fill: SERIES_COLORS[activeIdx % SERIES_COLORS.length], 'fill-opacity': 0.14,
    }));
  }

  // Lines
  series.forEach((s, k) => {
    const color = SERIES_COLORS[k % SERIES_COLORS.length];
    const isBase = s.offerId === state.baselineId;
    const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${X(i)},${Y(p.cumulative)}`).join(' ');
    svg.appendChild(svgEl('path', {
      d, fill: 'none', stroke: color,
      'stroke-width': s.offerId === state.activeTab ? 3 : 2,
      'stroke-dasharray': isBase ? '6 4' : null,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
    s.points.forEach((p, i) => {
      svg.appendChild(svgEl('circle', { cx: X(i), cy: Y(p.cumulative), r: 2.6, fill: color }));
    });
    legendEl.appendChild(el('span', {},
      el('i', { style: `background:${color};${isBase ? 'height:0;border-top:3px dashed ' + color : ''}` }),
      s.company + (isBase ? ' (baseline)' : '')));
  });

  legendEl.appendChild(el('span', { class: 'small' },
    el('i', { class: 'sw', style: `background:${SERIES_COLORS[activeIdx % SERIES_COLORS.length]};opacity:.2` }),
    'Conservative→aggressive band, selected offer'));

  container.appendChild(svg);
}

function drawCompositionChart(container, legendEl, offerId) {
  container.innerHTML = '';
  legendEl.innerHTML = '';
  const R = state.results;
  if (!R) return;
  const res = R.byScenario[state.displayScenario].find((r) => r.offerId === offerId)
           || R.byScenario[state.displayScenario][0];
  if (!res) return;

  const W = 880, H = 320;
  const M = { t: 14, r: 18, b: 38, l: 66 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const rows = res.rows;
  const maxY = niceMax(Math.max(...rows.map((r) => r.total)) * 1.05);

  const bw = Math.min(46, (iw / rows.length) * 0.66);
  const X = (i) => M.l + (i + 0.5) * (iw / rows.length) - bw / 2;
  const Y = (v) => M.t + ih - (v / maxY) * ih;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': `Annual gross compensation for ${res.company} broken into base salary, bonus, sign-on, initial grant vest and refresher vest.`,
  });

  for (let g = 0; g <= 4; g++) {
    const v = (maxY / 4) * g, y = Y(v);
    svg.appendChild(svgEl('line', { x1: M.l, x2: W - M.r, y1: y, y2: y, stroke: '#0D1F3C', 'stroke-opacity': g === 0 ? 0.3 : 0.1 }));
    const t = svgEl('text', { x: M.l - 9, y: y + 4, 'text-anchor': 'end', fill: '#6B7A90', 'font-size': 11, 'font-family': 'IBM Plex Mono, monospace' });
    t.textContent = abbrev(v);
    svg.appendChild(t);
  }

  const parts = [
    ['baseSalary', 'Base salary'],
    ['bonus', 'Bonus'],
    ['signOn', 'Sign-on'],
    ['initialVest', 'Initial grant vest'],
    ['refresherVest', 'Refresher vest'],
  ];

  rows.forEach((row, i) => {
    let acc = 0;
    for (const [key] of parts) {
      const v = row[key];
      if (v <= 0) continue;
      svg.appendChild(svgEl('rect', {
        x: X(i), y: Y(acc + v), width: bw, height: Math.max(0, Y(acc) - Y(acc + v)),
        fill: COMPONENT_COLORS[key],
      }));
      acc += v;
    }
    const t = svgEl('text', {
      x: X(i) + bw / 2, y: H - 14, 'text-anchor': 'middle',
      fill: '#6B7A90', 'font-size': 11, 'font-family': 'IBM Plex Mono, monospace',
    });
    t.textContent = 'Y' + row.yearIndex;
    svg.appendChild(t);
  });

  for (const [key, label] of parts) {
    legendEl.appendChild(el('span', {},
      el('i', { class: 'sw', style: `background:${COMPONENT_COLORS[key]}` }), label));
  }
  container.appendChild(svg);
}

/* ------------------------------------------------------------------ */
/* Result rendering                                                    */
/* ------------------------------------------------------------------ */

function renderStats() {
  const box = $('#statGrid');
  box.innerHTML = '';
  const R = state.results;
  if (!R) return;
  const disp = R.byScenario[state.displayScenario];
  const cons = R.byScenario.conservative;
  const aggr = R.byScenario.aggressive;
  const best = Math.max(...disp.map((r) => r.totalGross));

  for (const res of disp) {
    const c = cons.find((x) => x.offerId === res.offerId);
    const a = aggr.find((x) => x.offerId === res.offerId);
    const isLead = res.totalGross === best && disp.length > 1;
    box.appendChild(el('div', { class: 'stat' + (isLead ? ' lead' : '') },
      el('div', { class: 'co' }, res.company + (res.offerId === state.baselineId ? ' · baseline' : '')),
      el('div', { class: 'big' }, money(res.totalGross)),
      el('div', { class: 'band' }, `${abbrev(c ? c.totalGross : 0)} → ${abbrev(a ? a.totalGross : 0)}`),
      el('div', { class: 'band', style: 'color:var(--ink-3)' },
        `${state.horizon}-yr total · Y5 ${abbrev(res.cumulativeAt[5])}`)));
  }
}

function renderDetailTable() {
  const t = $('#detailTable');
  t.innerHTML = '';
  const R = state.results;
  if (!R) return;
  const id = $('#detailOffer').value;
  const res = R.byScenario[state.displayScenario].find((r) => r.offerId === id)
           || R.byScenario[state.displayScenario][0];
  if (!res) return;

  t.appendChild(el('caption', {},
    `${res.company} · ${res.scenarioName} scenario · gross, before tax`));

  const head = el('thead', {}, el('tr', {},
    el('th', {}, 'Year'), el('th', { class: 'num' }, 'Calendar'),
    el('th', { class: 'num' }, 'Share price'), el('th', { class: 'num' }, 'Base'),
    el('th', { class: 'num' }, 'Bonus'), el('th', { class: 'num' }, 'Sign-on'),
    el('th', { class: 'num' }, 'Initial vest'), el('th', { class: 'num' }, 'Refresher vest'),
    el('th', { class: 'num' }, 'Total'), el('th', { class: 'num' }, 'Cumulative'),
    el('th', { class: 'num' }, 'Grants vesting')));

  const body = el('tbody');
  for (const r of res.rows) {
    body.appendChild(el('tr', {},
      el('td', {}, 'Year ' + r.yearIndex),
      el('td', { class: 'num dim' }, r.calendarYear),
      el('td', { class: 'num dim' }, money2(r.sharePrice)),
      el('td', { class: 'num' }, money(r.baseSalary)),
      el('td', { class: 'num' }, money(r.bonus)),
      el('td', { class: 'num' }, money(r.signOn)),
      el('td', { class: 'num' }, money(r.initialVest)),
      el('td', { class: 'num' }, money(r.refresherVest)),
      el('td', { class: 'num', style: 'font-weight:600' }, money(r.total)),
      el('td', { class: 'num dim' }, money(r.cumulative)),
      el('td', { class: 'num dim' }, r.concurrentGrants)));
  }

  const sum = (k) => res.rows.reduce((a, r) => a + r[k], 0);
  const foot = el('tfoot', {}, el('tr', {},
    el('td', {}, `${state.horizon}-yr total`),
    el('td', {}), el('td', {}),
    el('td', { class: 'num' }, money(sum('baseSalary'))),
    el('td', { class: 'num' }, money(sum('bonus'))),
    el('td', { class: 'num' }, money(sum('signOn'))),
    el('td', { class: 'num' }, money(sum('initialVest'))),
    el('td', { class: 'num' }, money(sum('refresherVest'))),
    el('td', { class: 'num' }, money(res.totalGross)),
    el('td', {}), el('td', {})));

  t.append(head, body, foot);
}

function renderLedger() {
  const t = $('#ledgerTable');
  t.innerHTML = '';
  const R = state.results;
  if (!R) return;
  const id = $('#ledgerOffer').value;
  const res = R.byScenario[state.displayScenario].find((r) => r.offerId === id)
           || R.byScenario[state.displayScenario][0];
  if (!res) return;

  t.appendChild(el('caption', {}, `${res.company} · ${res.scenarioName} scenario`));
  t.appendChild(el('thead', {}, el('tr', {},
    el('th', {}, 'Source grant'), el('th', { class: 'num' }, 'Granted'),
    el('th', { class: 'num' }, 'Grant value'), el('th', { class: 'num' }, 'Grant price'),
    el('th', { class: 'num' }, 'Vest year'), el('th', { class: 'num' }, 'Vest %'),
    el('th', { class: 'num' }, 'Shares'), el('th', { class: 'num' }, 'Price at vest'),
    el('th', { class: 'num' }, 'Value'), el('th', {}, 'In horizon'))));

  const body = el('tbody');
  const sorted = [...res.ledger].sort((a, b) =>
    a.vestFractionalYear - b.vestFractionalYear || a.grantYear - b.grantYear);
  for (const x of sorted) {
    body.appendChild(el('tr', { style: x.withinHorizon ? '' : 'opacity:.5' },
      el('td', {}, x.grantLabel),
      el('td', { class: 'num dim' }, x.grantYear),
      el('td', { class: 'num dim' }, money(x.grantValue)),
      el('td', { class: 'num dim' }, money2(x.grantPrice)),
      el('td', { class: 'num' }, x.vestCalendarYear),
      el('td', { class: 'num dim' }, (x.vestPercent * 100).toFixed(2) + '%'),
      el('td', { class: 'num' }, fmtSh.format(x.shares)),
      el('td', { class: 'num' }, money2(x.priceUsed)),
      el('td', { class: 'num', style: 'font-weight:600' }, money2(x.value)),
      el('td', { class: 'dim' }, x.withinHorizon ? 'yes' : 'after horizon')));
  }
  t.appendChild(body);
}

function renderCrossover() {
  const box = $('#crossoverBox');
  box.innerHTML = '';
  const R = state.results;
  if (!R || R.byScenario.medium.length < 2) {
    box.appendChild(el('p', { class: 'panel-note mb0' },
      'Add a second offer to see crossover analysis.'));
    return;
  }

  const rows = crossovers(R.byScenario, state.alignment, state.horizon);
  const baseline = state.baselineId;
  const vsBaseline = rows.filter((r) => r.bId === baseline && r.aId !== baseline);
  const unit = state.alignment === 'tenure' ? 'year' : 'calendar year';

  if (vsBaseline.length) {
    box.appendChild(el('h3', { style: 'margin-bottom:10px' }, 'Against your current compensation'));
    const ul = el('ul', { style: 'margin:0 0 18px;padding-left:20px' });
    for (const r of vsBaseline) {
      const beats = r.finalA > r.finalB;
      let text;
      if (r.crossPeriod !== null && !r.leadsFromStart) {
        text = `${r.aCompany} overtakes ${r.bCompany} cumulatively in ${unit} ${r.crossPeriod}`;
      } else if (r.leadsFromStart) {
        text = `${r.aCompany} leads ${r.bCompany} from ${unit} 1 onward`;
      } else {
        text = `${r.aCompany} never overtakes ${r.bCompany} within the ${state.horizon}-year horizon`;
      }
      ul.appendChild(el('li', {},
        text,
        el('span', { class: 'small' },
          ` · ${state.horizon}-yr gap ${beats ? '+' : ''}${money(r.finalA - r.finalB)}`),
        el('span', { class: 'small', style: `color:${r.holdsInAllScenarios ? 'var(--ink-3)' : 'var(--burgundy)'}` },
          r.holdsInAllScenarios ? ' · holds in all three scenarios' : ' · ORDER REVERSES in another scenario')));
    }
    box.appendChild(ul);
  }

  const anyReverses = rows.some((r) => !r.holdsInAllScenarios);
  if (anyReverses) {
    box.appendChild(el('div', { class: 'notice warn' },
      el('strong', {}, 'The ranking is assumption-dependent. '),
      'At least one pair of offers changes order between the conservative and aggressive scenarios. ' +
      'Treat the medium-scenario ranking as one outcome, not the answer.'));
  }

  box.appendChild(el('h3', { style: 'margin:18px 0 10px' }, 'Leader by ' + unit));
  const leaders = leaderByPeriod(R.byScenario[state.displayScenario], state.alignment, state.horizon);
  const tbl = el('table');
  tbl.appendChild(el('thead', {}, el('tr', {},
    el('th', {}, unit === 'year' ? 'Tenure year' : 'Calendar year'),
    el('th', {}, 'Cumulative leader'),
    el('th', { class: 'num' }, 'Cumulative gross'))));
  const tb = el('tbody');
  for (const l of leaders) {
    tb.appendChild(el('tr', {},
      el('td', {}, unit === 'year' ? 'Year ' + l.x : l.x),
      el('td', {}, l.leaderCompany),
      el('td', { class: 'num' }, money(l.cumulative))));
  }
  tbl.appendChild(tb);
  box.appendChild(el('div', { class: 'table-scroll' }, tbl));
}

function renderUnvested() {
  const t = $('#unvestedTable');
  t.innerHTML = '';
  const R = state.results;
  if (!R) return;
  t.appendChild(el('thead', {}, el('tr', {},
    el('th', {}, 'Offer'),
    el('th', { class: 'num' }, 'Unvested shares'),
    el('th', { class: 'num' }, 'Price at horizon'),
    el('th', { class: 'num' }, 'Value at horizon'))));
  const tb = el('tbody');
  for (const res of R.byScenario[state.displayScenario]) {
    tb.appendChild(el('tr', {},
      el('td', {}, res.company),
      el('td', { class: 'num' }, fmtSh.format(res.unvestedShares)),
      el('td', { class: 'num dim' }, money2(res.horizonPrice)),
      el('td', { class: 'num', style: 'font-weight:600' }, money(res.unvestedValueAtHorizon))));
  }
  t.appendChild(tb);
}

function renderErrors() {
  const box = $('#errorBox');
  box.innerHTML = '';
  const R = state.results;
  if (!R || !R.errors.length) return;
  box.appendChild(el('div', { class: 'notice warn' },
    el('strong', {}, 'Calculation blocked. '),
    'Fix these before the results are meaningful:',
    el('ul', { class: 'errors', style: 'margin-top:8px' }, ...R.errors.map((e) => el('li', {}, e)))));
}

function renderCapNotice() {
  const R = state.results;
  const host = $('#scenEditor');
  const existing = $('#capNotice');
  if (existing) existing.remove();
  if (!R) return;
  const capped = Object.values(R.scen).filter((s) => s._wasCapped);
  if (!capped.length) return;
  host.parentNode.insertBefore(el('div', { class: 'notice', id: 'capNotice' },
    el('strong', {}, 'Appreciation cap applied. '),
    capped.map((s) => `${s.name}: entered ${pct(s._uncapped)}/yr, modelled at ${pct(s.priceAppreciation)}/yr.`).join(' '),
    ' Uncapped compounding over a long horizon produces figures that are arithmetically valid and practically meaningless.',
  ), host.nextSibling);
}

function syncOfferSelects() {
  for (const sel of ['#compositionOffer', '#detailOffer', '#ledgerOffer', '#baselineSel']) {
    const s = $(sel);
    const prev = s.value;
    s.innerHTML = '';
    for (const o of state.offers) {
      s.appendChild(el('option', { value: o.id, selected: o.id === prev }, o.company));
    }
    if (sel === '#baselineSel') {
      s.value = state.baselineId || state.offers[0]?.id;
    } else if (!s.value && state.offers.length) {
      s.value = state.activeTab && state.offers.some((o) => o.id === state.activeTab)
        ? state.activeTab : state.offers[0].id;
    }
  }
}

function renderResults() {
  if (!state.results) compute();
  renderErrors();
  renderCapNotice();
  if (!state.results.byScenario.medium.length) return;
  $('#summaryScen').textContent =
    state.scenarios[state.displayScenario].name + ' scenario';
  renderStats();
  drawCumulativeChart($('#chartCumulative'), $('#legendCumulative'));
  drawCompositionChart($('#chartComposition'), $('#legendComposition'), $('#compositionOffer').value);
  renderDetailTable();
  renderLedger();
  renderCrossover();
  renderUnvested();
}

/* ------------------------------------------------------------------ */
/* Scenario editor                                                     */
/* ------------------------------------------------------------------ */

const SCEN_LEVERS = [
  ['priceAppreciation', 'Share price appreciation %/yr', 'pct'],
  ['meritFactor', 'Merit increase factor (× your input)', 'num'],
  ['bonusMultiplier', 'Bonus performance multiplier', 'num'],
  ['refresherGrowthFactor', 'Refresher grant growth factor (× your input)', 'num'],
  ['refresherYears', 'Number of refresher grant years', 'int'],
];

function renderScenarioTable() {
  const tb = $('#scenTable tbody');
  tb.innerHTML = '';
  for (const [key, label, kind] of SCEN_LEVERS) {
    const tr = el('tr', {}, el('td', {}, label));
    for (const sk of ['conservative', 'medium', 'aggressive']) {
      const s = state.scenarios[sk];
      const val = kind === 'pct' ? r2(s[key] * 100) : s[key];
      tr.appendChild(el('td', { class: 'num' },
        el('input', {
          type: 'number', value: val,
          step: kind === 'int' ? '1' : kind === 'pct' ? '0.5' : '0.05',
          style: 'width:90px;text-align:right',
          onInput: (e) => {
            const raw = parseFloat(e.target.value) || 0;
            s[key] = kind === 'pct' ? raw / 100 : kind === 'int' ? Math.round(raw) : raw;
            scheduleRecalc();
          },
        })));
    }
    tb.appendChild(tr);
  }
}

/* ------------------------------------------------------------------ */
/* Offer management                                                    */
/* ------------------------------------------------------------------ */

function addOffer() {
  if (state.offers.length >= MAX_OFFERS) return;
  const y = new Date().getFullYear();
  const o = blankOffer({
    company: 'Offer ' + String.fromCharCode(64 + state.offers.length),
    startYear: y, refresherFirstYear: y + 1,
  });
  state.offers.push(o);
  state.activeTab = o.id;
  render();
}

function removeOffer(id) {
  state.offers = state.offers.filter((o) => o.id !== id);
  if (state.baselineId === id) state.baselineId = state.offers[0]?.id || null;
  if (state.activeTab === id) state.activeTab = state.offers[0]?.id || null;
  render();
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

function render() {
  // Tabs
  const tabs = $('#offerTabs');
  tabs.innerHTML = '';
  for (const o of state.offers) {
    tabs.appendChild(el('button', {
      class: 'tab' + (o.id === state.baselineId ? ' baseline' : ''),
      role: 'tab', 'aria-selected': String(o.id === state.activeTab),
      onClick: () => { state.activeTab = o.id; render(); },
    }, o.company || 'Untitled'));
  }
  $('#addOffer').disabled = state.offers.length >= MAX_OFFERS;

  // Pane
  const panes = $('#offerPanes');
  panes.innerHTML = '';
  const active = state.offers.find((o) => o.id === state.activeTab) || state.offers[0];
  if (active) {
    state.activeTab = active.id;
    const ctx = marketContextNote();
    if (ctx) panes.appendChild(ctx);
    panes.appendChild(offerPane(active));
  }

  syncOfferSelects();
  compute();
  renderResults();
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

function exportPayload() {
  const R = state.results;
  return {
    generated: new Date().toISOString(),
    horizon: state.horizon,
    alignment: state.alignment,
    displayScenario: state.displayScenario,
    scenarios: R.scen,
    offers: state.offers,
    baselineId: state.baselineId,
    results: R.byScenario,
  };
}

async function loadScript(src) {
  return new Promise((res, rej) => {
    if ([...document.scripts].some((s) => s.src === src)) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

function setStatus(msg) { $('#exportStatus').textContent = msg || ''; }

async function downloadXlsx() {
  setStatus('Building Excel file…');
  try {
    await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
    const { buildWorkbook } = await import('./export.js');
    buildWorkbook(window.XLSX, exportPayload());
    setStatus('Excel file downloaded.');
  } catch (e) {
    setStatus('Excel export unavailable — check your connection, then try again. The CSV export works offline.');
  }
}

async function downloadPdf() {
  setStatus('Building PDF…');
  try {
    await loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
    await loadScript('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js');
    const { buildPdf } = await import('./export.js');
    buildPdf(window.jspdf, exportPayload());
    setStatus('PDF downloaded.');
  } catch (e) {
    setStatus('PDF export unavailable — check your connection, then try again. Your browser\'s Print to PDF also works.');
  }
}

async function downloadCsv() {
  const { buildCsv } = await import('./export.js');
  buildCsv(exportPayload());
  setStatus('Tranche ledger CSV downloaded.');
}

function shareLink() {
  try {
    const s = encodeState({
      o: state.offers, s: state.scenarios, h: state.horizon,
      a: state.alignment, b: state.baselineId, d: state.displayScenario,
      c: state.cap,
    });
    const url = location.origin + location.pathname + '#s=' + s;
    navigator.clipboard.writeText(url);
    setStatus('Link copied. Nothing was uploaded — the whole comparison is encoded in the URL.');
  } catch (e) {
    setStatus('Could not copy automatically. Your comparison is not saved anywhere on our side.');
  }
}

function loadFromHash() {
  if (!location.hash.startsWith('#s=')) return false;
  try {
    const d = decodeState(location.hash.slice(3));
    state.offers = d.o; state.scenarios = d.s; state.horizon = d.h;
    state.alignment = d.a; state.baselineId = d.b; state.displayScenario = d.d;
    if (d.c) state.cap = d.c;
    state.activeTab = state.offers[0]?.id;
    return true;
  } catch (e) { return false; }
}

/* ------------------------------------------------------------------ */
/* Wire up                                                             */
/* ------------------------------------------------------------------ */

function init() {
  if (!loadFromHash()) seed();

  $('#horizon').value = String(state.horizon);
  $('#alignment').value = state.alignment;
  $('#capOn').checked = state.cap.enabled;
  $('#capVal').value = r2(state.cap.value * 100);

  $('#horizon').addEventListener('change', (e) => { state.horizon = parseInt(e.target.value, 10); scheduleRecalc(); });
  $('#alignment').addEventListener('change', (e) => { state.alignment = e.target.value; scheduleRecalc(); });
  $('#baselineSel').addEventListener('change', (e) => { state.baselineId = e.target.value; render(); });
  $('#capOn').addEventListener('change', (e) => { state.cap.enabled = e.target.checked; scheduleRecalc(); });
  $('#capVal').addEventListener('input', (e) => { state.cap.value = (parseFloat(e.target.value) || 0) / 100; scheduleRecalc(); });

  for (const p of $$('.scen-pill')) {
    p.addEventListener('click', () => {
      state.displayScenario = p.dataset.scen;
      for (const q of $$('.scen-pill')) q.setAttribute('aria-pressed', String(q === p));
      renderResults();
    });
  }

  $('#addOffer').addEventListener('click', addOffer);
  $('#compositionOffer').addEventListener('change', () =>
    drawCompositionChart($('#chartComposition'), $('#legendComposition'), $('#compositionOffer').value));
  $('#detailOffer').addEventListener('change', renderDetailTable);
  $('#ledgerOffer').addEventListener('change', renderLedger);

  $('#btnXlsx').addEventListener('click', downloadXlsx);
  $('#btnPdf').addEventListener('click', downloadPdf);
  $('#btnCsv').addEventListener('click', downloadCsv);
  $('#btnShare').addEventListener('click', shareLink);

  renderScenarioTable();
  render();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

/*
 * bigtechcalc.com — RSU refresher calculator (scoped tool)
 *
 * A single-purpose front end over the same engine.js used by the full
 * multi-offer calculator. Models one refresher policy in isolation —
 * no cash comp, no offer comparison — to make the overlapping-tranche
 * mechanic legible on its own. Never duplicates engine math; every
 * number here comes from projectOffer().
 */
import { blankOffer, VEST_PRESETS, validateSchedule, projectOffer, r2 } from './engine.js';

const ANNUAL_PRESETS = [
  ['even4Annual', VEST_PRESETS.even4Annual],
  ['frontLoaded4', VEST_PRESETS.frontLoaded4],
  ['backLoaded4', VEST_PRESETS.backLoaded4],
  ['even5Annual', VEST_PRESETS.even5Annual],
  ['even3Annual', VEST_PRESETS.even3Annual],
];

const $ = (s, r = document) => r.querySelector(s);
const fmt0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtSh = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const money = (v) => fmt0.format(v || 0);
const money2 = (v) => fmt2.format(v || 0);

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
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
/* State — the golden fixture from comp-calculator-spec.md §4.1 as the */
/* worked example: $150k refresher, 3%/yr growth, even 4-yr vest,      */
/* 0% appreciation. Year 4 should read $156,886.01.                    */
/* ------------------------------------------------------------------ */

const state = {
  grantPrice: 100,
  appreciationPct: 0,
  refresherValue: 150000,
  refresherFirstYear: 1,
  refresherGrowthPct: 0.03,
  horizon: 10,
  schedule: JSON.parse(JSON.stringify(VEST_PRESETS.even4Annual)),
};

/* ------------------------------------------------------------------ */
/* Vesting schedule editor — annual only. Quarterly/monthly and cliffs */
/* live in the full multi-offer calculator, linked from here.          */
/* ------------------------------------------------------------------ */

function scheduleTotal() {
  return state.schedule.events.reduce((a, e) => a + e.percent, 0);
}

function renderScheduleEditor() {
  const host = $('#scheduleEditor');
  host.innerHTML = '';

  const templateSel = el('select', { id: 'templateSel' },
    el('option', { value: '' }, 'Load a template…'),
    ...ANNUAL_PRESETS.map(([key, p]) => el('option', { value: key }, p.label)));
  templateSel.addEventListener('change', (e) => {
    const found = ANNUAL_PRESETS.find(([key]) => key === e.target.value);
    if (found) {
      state.schedule = JSON.parse(JSON.stringify(found[1]));
      render();
    }
  });

  const grid = el('div', { class: 'vest-row' });
  state.schedule.events.forEach((ev, i) => {
    grid.appendChild(el('div', { class: 'vest-cell' },
      el('label', {}, 'Yr' + (i + 1)),
      el('input', {
        type: 'number', step: '1', value: r2(ev.percent * 100),
        onInput: (e) => {
          state.schedule.events[i].percent = (parseFloat(e.target.value) || 0) / 100;
          refreshTotal();
          recalc();
        },
      })));
  });

  const total = scheduleTotal();
  const ok = Math.abs(total - 1) < 1e-6;
  const totalEl = el('span', { class: 'vest-total ' + (ok ? 'ok' : 'bad') },
    `Total ${(total * 100).toFixed(2)}%` + (ok ? ' ✓' : ' — must total 100%'));

  const btnRow = el('div', { class: 'inline mt16' },
    el('button', {
      class: 'ghost', onClick: () => {
        state.schedule.events.push({ periodIndex: state.schedule.events.length + 1, percent: 0 });
        render();
      },
    }, '+ year'),
    state.schedule.events.length > 1 ? el('button', {
      class: 'ghost', onClick: () => { state.schedule.events.pop(); render(); },
    }, '− year') : null);

  host.append(
    el('div', { class: 'field' }, el('label', {}, 'Vesting schedule template'), templateSel),
    el('div', { class: 'mt16' }, grid, totalEl),
    btnRow,
    el('p', { class: 'hint mt16' },
      'Annual only. Quarterly/monthly schedules with cliffs, plus full multi-offer comparison, are in the ',
      el('a', { href: '/#calculator' }, 'main calculator'), '. See ',
      el('a', { href: '/equity-vesting-schedule-explained.html' }, 'how each shape pays out'), '.'));

  function refreshTotal() {
    const t = scheduleTotal();
    const good = Math.abs(t - 1) < 1e-6;
    totalEl.className = 'vest-total ' + (good ? 'ok' : 'bad');
    totalEl.textContent = `Total ${(t * 100).toFixed(2)}%` + (good ? ' ✓' : ' — must total 100%');
  }
}

/* ------------------------------------------------------------------ */
/* Compute                                                             */
/* ------------------------------------------------------------------ */

const CURRENT_YEAR = new Date().getFullYear();

function compute() {
  // blankOffer's startYear/refresherFirstYear are real calendar years, not
  // tenure-relative — anchor to the current year so the UI's "Year 1 = your
  // first year" input maps onto that correctly.
  const offer = blankOffer({
    baseSalary: 0, bonusTargetPct: 0, signOnTotal: 0,
    initialGrantValue: 0,
    startYear: CURRENT_YEAR,
    grantPrice: state.grantPrice,
    refresherValue: state.refresherValue,
    refresherFirstYear: CURRENT_YEAR + (state.refresherFirstYear - 1),
    refresherGrowthPct: state.refresherGrowthPct,
    refresherSchedule: state.schedule,
    refresherSlots: state.horizon,
  });
  const scenario = {
    key: 'custom', name: 'Custom',
    priceAppreciation: state.appreciationPct,
    meritFactor: 1, bonusMultiplier: 1, refresherGrowthFactor: 1,
    refresherYears: state.horizon,
  };
  return projectOffer(offer, scenario, state.horizon);
}

/* ------------------------------------------------------------------ */
/* Chart — same hand-rolled SVG approach as the main app, one series.  */
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

function drawChart(res, steadyYearIndex) {
  const container = $('#chartRefresher');
  container.innerHTML = '';
  const rows = res.rows;
  const W = 880, H = 300;
  const M = { t: 14, r: 18, b: 38, l: 66 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const maxY = niceMax(Math.max(...rows.map((r) => r.refresherVest)) * 1.08);
  const bw = Math.min(46, (iw / rows.length) * 0.6);
  const X = (i) => M.l + (i + 0.5) * (iw / rows.length) - bw / 2;
  const Y = (v) => M.t + ih - (v / maxY) * ih;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': 'Refresher vest dollars by year, showing income ramp to steady state.',
  });
  for (let g = 0; g <= 4; g++) {
    const v = (maxY / 4) * g, y = Y(v);
    svg.appendChild(svgEl('line', { x1: M.l, x2: W - M.r, y1: y, y2: y, stroke: '#0D1F3C', 'stroke-opacity': g === 0 ? 0.3 : 0.1 }));
    const t = svgEl('text', { x: M.l - 9, y: y + 4, 'text-anchor': 'end', fill: '#6B7A90', 'font-size': 11, 'font-family': 'IBM Plex Mono, monospace' });
    t.textContent = abbrev(v);
    svg.appendChild(t);
  }
  rows.forEach((row, i) => {
    const isSteady = i + 1 >= steadyYearIndex;
    svg.appendChild(svgEl('rect', {
      x: X(i), y: Y(row.refresherVest), width: bw, height: Math.max(0, Y(0) - Y(row.refresherVest)),
      fill: isSteady ? '#8A6410' : '#7FA8CC',
    }));
    const t = svgEl('text', { x: X(i) + bw / 2, y: H - 14, 'text-anchor': 'middle', fill: '#6B7A90', 'font-size': 11, 'font-family': 'IBM Plex Mono, monospace' });
    t.textContent = 'Y' + row.yearIndex;
    svg.appendChild(t);
  });
  container.appendChild(svg);
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

function render() {
  renderScheduleEditor();
  recalc();
}

function recalc() {
  const errBox = $('#errorBox');
  errBox.innerHTML = '';
  const res = compute();

  if (!res.valid) {
    errBox.appendChild(el('div', { class: 'notice warn' },
      el('strong', {}, 'Fix the vesting schedule above — '), res.errors.join(' ')));
    $('#statGrid').innerHTML = '';
    $('#chartRefresher').innerHTML = '';
    $('#yearTable').innerHTML = '';
    $('#ledgerTable').innerHTML = '';
    return;
  }

  const scheduleLen = state.schedule.events.filter((e) => e.percent > 0).length;
  const maxConcurrent = Math.max(...res.rows.map((r) => r.concurrentGrants));
  const steadyRow = res.rows.find((r) => r.concurrentGrants === maxConcurrent);
  const steadyYearIndex = steadyRow ? steadyRow.yearIndex : scheduleLen;

  // Stats
  const stats = $('#statGrid');
  stats.innerHTML = '';
  stats.append(
    el('div', { class: 'stat' },
      el('div', { class: 'co' }, `${state.horizon}-yr refresher income`),
      el('div', { class: 'big' }, money(res.totalGross))),
    el('div', { class: 'stat' },
      el('div', { class: 'co' }, 'Reaches steady state'),
      el('div', { class: 'big' }, `Year ${steadyYearIndex}`),
      el('div', { class: 'band' }, `${maxConcurrent} concurrent grants vesting`)),
    el('div', { class: 'stat' },
      el('div', { class: 'co' }, 'Unvested at horizon'),
      el('div', { class: 'big' }, money(res.unvestedValueAtHorizon)),
      el('div', { class: 'band' }, `${fmtSh.format(res.unvestedShares)} shares`)));

  drawChart(res, steadyYearIndex);

  // Year-by-year table
  const yt = $('#yearTable');
  yt.innerHTML = '';
  yt.appendChild(el('caption', {}, `Refresher vest by year · grant price ${money2(state.grantPrice)} · ${(state.appreciationPct * 100).toFixed(1)}%/yr appreciation`));
  yt.appendChild(el('thead', {}, el('tr', {},
    el('th', {}, 'Year'), el('th', { class: 'num' }, 'Share price'),
    el('th', { class: 'num' }, 'Refresher vest'), el('th', { class: 'num' }, 'Cumulative'),
    el('th', { class: 'num' }, 'Concurrent grants'))));
  const ytb = el('tbody');
  for (const r of res.rows) {
    ytb.appendChild(el('tr', {},
      el('td', {}, 'Year ' + r.yearIndex),
      el('td', { class: 'num dim' }, money2(r.sharePrice)),
      el('td', { class: 'num', style: 'font-weight:600' }, money(r.refresherVest)),
      el('td', { class: 'num dim' }, money(r.cumulative)),
      el('td', { class: 'num dim' }, r.concurrentGrants)));
  }
  yt.append(ytb, el('tfoot', {}, el('tr', {},
    el('td', {}, `${state.horizon}-yr total`), el('td', {}),
    el('td', { class: 'num' }, money(res.totalGross)), el('td', {}), el('td', {}))));

  // Tranche ledger
  const lt = $('#ledgerTable');
  lt.innerHTML = '';
  lt.appendChild(el('caption', {}, 'One row per vest event — the ledger a rolling-window formula can\'t show'));
  lt.appendChild(el('thead', {}, el('tr', {},
    el('th', {}, 'Refresher grant'), el('th', { class: 'num' }, 'Granted'),
    el('th', { class: 'num' }, 'Grant value'), el('th', { class: 'num' }, 'Vest year'),
    el('th', { class: 'num' }, 'Vest %'), el('th', { class: 'num' }, 'Value'), el('th', {}, 'In horizon'))));
  const ltb = el('tbody');
  const sorted = [...res.ledger].sort((a, b) => a.vestFractionalYear - b.vestFractionalYear || a.grantYear - b.grantYear);
  for (const x of sorted) {
    ltb.appendChild(el('tr', { style: x.withinHorizon ? '' : 'opacity:.5' },
      el('td', {}, x.grantLabel),
      el('td', { class: 'num dim' }, x.grantYear),
      el('td', { class: 'num dim' }, money(x.grantValue)),
      el('td', { class: 'num' }, x.vestCalendarYear),
      el('td', { class: 'num dim' }, (x.vestPercent * 100).toFixed(2) + '%'),
      el('td', { class: 'num', style: 'font-weight:600' }, money2(x.value)),
      el('td', { class: 'dim' }, x.withinHorizon ? 'yes' : 'after horizon')));
  }
  lt.appendChild(ltb);
}

/* ------------------------------------------------------------------ */
/* Wire up                                                             */
/* ------------------------------------------------------------------ */

function numField(id, onChange) {
  $(id).addEventListener('input', (e) => {
    onChange(e.target.value === '' ? 0 : parseFloat(e.target.value));
    recalc();
  });
}
function pctField(id, onChange) {
  $(id).addEventListener('input', (e) => {
    onChange((parseFloat(e.target.value) || 0) / 100);
    recalc();
  });
}

function init() {
  $('#grantPrice').value = state.grantPrice;
  $('#appreciationPct').value = r2(state.appreciationPct * 100);
  $('#refresherValue').value = state.refresherValue;
  $('#refresherFirstYear').value = state.refresherFirstYear;
  $('#refresherGrowthPct').value = r2(state.refresherGrowthPct * 100);
  $('#horizon').value = String(state.horizon);

  numField('#grantPrice', (v) => { state.grantPrice = v; });
  pctField('#appreciationPct', (v) => { state.appreciationPct = v; });
  numField('#refresherValue', (v) => { state.refresherValue = v; });
  numField('#refresherFirstYear', (v) => { state.refresherFirstYear = Math.round(v); });
  pctField('#refresherGrowthPct', (v) => { state.refresherGrowthPct = v; });
  $('#horizon').addEventListener('change', (e) => { state.horizon = parseInt(e.target.value, 10); recalc(); });

  render();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

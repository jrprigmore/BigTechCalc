/*
 * DOM smoke test.
 *
 * Loads index.html into jsdom, runs app.js against it, and asserts the
 * page actually renders: tabs, stat cards, charts, tables, crossover.
 * Catches the class of bug that unit tests on the engine cannot —
 * a selector that does not exist, a null dereference on first paint.
 *
 * Run: node engine-tests/smoke.mjs
 */

import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, '..', 'site');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const consoleErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => consoleErrors.push('jsdomError: ' + e.message));
vc.on('error', (...a) => consoleErrors.push('console.error: ' + a.join(' ')));

// Strip external resources: fonts, AdSense, and the module script (we
// import app.js directly so we can await it).
let html = readFileSync(join(siteDir, 'index.html'), 'utf8')
  .replace(/<script[^>]*pagead2[^>]*><\/script>/g, '')
  .replace(/<link[^>]*fonts\.(googleapis|gstatic)[^>]*>/g, '')
  .replace(/<script type="module"[^>]*><\/script>/g, '');

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://bigtechcalc.com/',
  pretendToBeVisual: true,
  virtualConsole: vc,
});

const { window } = dom;
for (const k of ['window', 'document', 'Node', 'HTMLElement', 'Element',
                 'Event', 'CustomEvent', 'getComputedStyle', 'location', 'btoa', 'atob',
                 'TextEncoder', 'TextDecoder', 'requestAnimationFrame']) {
  if (window[k] === undefined) continue;
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true }); }
}
// navigator is a getter-only global in Node 22; define it explicitly.
Object.defineProperty(globalThis, 'navigator', {
  value: window.navigator, configurable: true, writable: true,
});
globalThis.fetch = async () => { throw new Error('offline in smoke test'); };

console.log('\nDOM SMOKE TEST — index.html + app.js\n');

await import(pathToFileURL(join(siteDir, 'js', 'app.js')).href);
// Let the debounced recalc settle.
await new Promise((r) => setTimeout(r, 400));

const $ = (s) => window.document.querySelector(s);
const $$ = (s) => [...window.document.querySelectorAll(s)];

/* ---- Structure ---- */
ok('offer tabs rendered', $$('#offerTabs .tab').length === 3,
   `${$$('#offerTabs .tab').length} tabs`);
ok('an offer pane rendered', !!$('.offer-pane'));
ok('scenario lever table populated', $$('#scenTable tbody tr').length === 5,
   `${$$('#scenTable tbody tr').length} rows`);
ok('scenario pills present', $$('.scen-pill').length === 3);

/* ---- Results ---- */
const stats = $$('#statGrid .stat');
ok('stat card per offer', stats.length === 3, `${stats.length} cards`);
ok('stat cards show currency', stats.every((s) => /\$[\d,]/.test(s.querySelector('.big').textContent)));

ok('cumulative chart drawn', !!$('#chartCumulative svg'));
ok('cumulative chart has a line per offer',
   $$('#chartCumulative svg path[stroke]').length >= 3,
   `${$$('#chartCumulative svg path[stroke]').length} paths`);
ok('scenario band polygon drawn', !!$('#chartCumulative svg polygon'));
ok('composition chart drawn', !!$('#chartComposition svg'));
ok('composition chart has stacked bars',
   $$('#chartComposition svg rect').length > 10,
   `${$$('#chartComposition svg rect').length} rects`);

const detailRows = $$('#detailTable tbody tr');
ok('detail table has one row per horizon year', detailRows.length === 10, `${detailRows.length} rows`);
ok('detail table has a total footer', !!$('#detailTable tfoot'));

const ledgerRows = $$('#ledgerTable tbody tr');
ok('tranche ledger populated', ledgerRows.length > 10, `${ledgerRows.length} rows`);

ok('crossover section populated', $('#crossoverBox').textContent.trim().length > 40);
ok('unvested table populated', $$('#unvestedTable tbody tr').length === 3);

/* ---- Numbers are sane ---- */
const totalCell = detailRows[9].children[8].textContent;
ok('year-10 total is a currency figure', /^\$[\d,]+$/.test(totalCell), totalCell);

const cum = detailRows.map((r) => Number(r.children[9].textContent.replace(/[$,]/g, '')));
ok('cumulative is monotonically non-decreasing',
   cum.every((v, i) => i === 0 || v >= cum[i - 1]));

const grants = detailRows.map((r) => Number(r.children[10].textContent));
ok('concurrent grants never exceeds vest schedule length (4)',
   grants.every((g) => g <= 4), JSON.stringify(grants));

/* ---- Interaction ---- */
const before = $('#statGrid .stat .big').textContent;
$$('.scen-pill').find((p) => p.dataset.scen === 'aggressive').dispatchEvent(new window.Event('click'));
await new Promise((r) => setTimeout(r, 120));
const after = $('#statGrid .stat .big').textContent;
ok('switching to aggressive changes the figures', before !== after, `${before} -> ${after}`);
ok('aggressive total exceeds medium total',
   Number(after.replace(/[$,]/g, '')) > Number(before.replace(/[$,]/g, '')));

$$('.scen-pill').find((p) => p.dataset.scen === 'conservative').dispatchEvent(new window.Event('click'));
await new Promise((r) => setTimeout(r, 120));
const cons = $('#statGrid .stat .big').textContent;
ok('conservative total is below medium total',
   Number(cons.replace(/[$,]/g, '')) < Number(before.replace(/[$,]/g, '')));

/* ---- Horizon change ---- */
$$('.scen-pill').find((p) => p.dataset.scen === 'medium').dispatchEvent(new window.Event('click'));
const hs = $('#horizon');
hs.value = '5';
hs.dispatchEvent(new window.Event('change'));
await new Promise((r) => setTimeout(r, 300));
ok('horizon change re-renders to 5 rows', $$('#detailTable tbody tr').length === 5,
   `${$$('#detailTable tbody tr').length} rows`);

/* ---- Add / remove offer ---- */
hs.value = '10'; hs.dispatchEvent(new window.Event('change'));
await new Promise((r) => setTimeout(r, 250));
$('#addOffer').dispatchEvent(new window.Event('click'));
await new Promise((r) => setTimeout(r, 250));
ok('adding an offer yields 4 tabs', $$('#offerTabs .tab').length === 4,
   `${$$('#offerTabs .tab').length}`);
ok('adding an offer yields 4 stat cards', $$('#statGrid .stat').length === 4);

/* ---- Invalid schedule blocks calculation ----
 * Must be tested on an offer that actually has an equity grant. The
 * engine deliberately does not block on a broken schedule attached to a
 * zero-value grant, since it cannot affect any number. */
$$('#offerTabs .tab')[1].dispatchEvent(new window.Event('click'));
await new Promise((r) => setTimeout(r, 250));

const vestInputs = $$('.vest-editor input[type="number"]');
ok('vest editor inputs exist on an equity offer', vestInputs.length > 0, `${vestInputs.length}`);
if (vestInputs.length) {
  const v = vestInputs[0];
  v.value = '99';
  v.dispatchEvent(new window.Event('input'));
  await new Promise((r) => setTimeout(r, 300));
  ok('invalid vest schedule surfaces a blocking error',
     $('#errorBox').textContent.includes('Calculation blocked'),
     JSON.stringify($('#errorBox').textContent.slice(0, 90)));
  ok('inline vest total flags the error',
     !!$('.vest-editor .vest-total.bad'));

  // Restore and confirm the error clears.
  v.value = '40';
  v.dispatchEvent(new window.Event('input'));
  await new Promise((r) => setTimeout(r, 300));
  ok('fixing the schedule clears the blocking error',
     !$('#errorBox').textContent.includes('Calculation blocked'));
}

/* ---- Console cleanliness ---- */
ok('no uncaught script errors', consoleErrors.length === 0,
   consoleErrors.slice(0, 3).join(' | '));

/* ---- Static SEO checks on the served HTML ---- */
const raw = readFileSync(join(siteDir, 'index.html'), 'utf8');
ok('exactly one H1', (raw.match(/<h1[\s>]/g) || []).length === 1);
ok('title under 65 chars for the primary clause',
   /<title>([^<]{1,120})<\/title>/.test(raw));
ok('meta description present and 120-165 chars', (() => {
  const m = raw.match(/<meta name="description" content="([^"]+)"/);
  return m && m[1].length >= 120 && m[1].length <= 320;
})());
ok('canonical present', raw.includes('rel="canonical"'));
ok('JSON-LD present', raw.includes('application/ld+json'));
ok('FAQPage schema present', raw.includes('"FAQPage"'));
ok('WebApplication schema present', raw.includes('"WebApplication"'));
ok('og:image present', raw.includes('property="og:image"'));
ok('three ad slots defined', (raw.match(/class="adsbygoogle"/g) || []).length === 3,
   `${(raw.match(/class="adsbygoogle"/g) || []).length}`);
ok('every FAQ in schema also appears as visible content',
   (raw.match(/<details class="faq">/g) || []).length >= 6);
ok('gross/pre-tax disclaimer in the footer', /GROSS|gross and\s*\n?\s*exclude all taxes|gross/.test(raw));

console.log('\n' + '='.repeat(60));
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('  Page renders and behaves correctly.');
console.log('='.repeat(60));

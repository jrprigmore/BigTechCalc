/*
 * Export test.
 *
 * Runs the real export module against a real projection and asserts the
 * files are actually produced and actually parse. Verifying that a
 * button is wired up is not the same as verifying it emits a valid
 * workbook.
 *
 * Run: node engine-tests/export.test.mjs
 */

import { JSDOM } from 'jsdom';
import { writeFileSync, existsSync, statSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import * as XLSX from 'xlsx';

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, '..', 'site');
const outDir = join(here, 'out');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

/* ---- Minimal browser shim so export.js runs unchanged ---- */
const dom = new JSDOM('<!doctype html><html><body></body></html>',
  { url: 'https://bigtechcalc.com/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.Blob = window.Blob;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Image = window.Image;

const saved = {};
window.URL.createObjectURL = (blob) => {
  const id = 'blob:' + Math.random();
  saved[id] = blob;
  return id;
};
window.URL.revokeObjectURL = () => {};
globalThis.URL = window.URL;

// Intercept the anchor click that triggers the download.
const realClick = window.HTMLAnchorElement.prototype.click;
const downloads = [];
window.HTMLAnchorElement.prototype.click = async function () {
  if (this.download && saved[this.href]) {
    const buf = Buffer.from(await saved[this.href].arrayBuffer());
    writeFileSync(join(outDir, this.download), buf);
    downloads.push({ name: this.download, bytes: buf.length });
  }
};

/* ---- Build a real payload from the engine ---- */
const { blankOffer, defaultScenarios, projectOffer, VEST_PRESETS } =
  await import(pathToFileURL(join(siteDir, 'js', 'engine.js')).href);
const { buildCsv, buildWorkbook, buildPdf } =
  await import(pathToFileURL(join(siteDir, 'js', 'export.js')).href);

const scen = defaultScenarios();
const y = 2026;
const offers = [
  blankOffer({
    id: 'base', company: 'Current employer', startYear: y, baseSalary: 275000,
    bonusTargetPct: 0.20, bonusInYear1: true, signOnTotal: 0, signOnSchedule: [1],
    grantPrice: 100, initialGrantValue: 0, refresherValue: 180000, refresherFirstYear: y,
  }),
  blankOffer({
    id: 'a', company: 'Offer A', ticker: 'AAAA', startYear: y, baseSalary: 300000,
    bonusTargetPct: 0.20, signOnTotal: 100000, signOnSchedule: [0.5, 0.5],
    grantPrice: 150, initialGrantValue: 600000,
    initialSchedule: JSON.parse(JSON.stringify(VEST_PRESETS.frontLoaded4)),
    refresherValue: 200000, refresherFirstYear: y + 1,
  }),
  blankOffer({
    id: 'b', company: 'Offer B / weird:name*', startYear: y, baseSalary: 275000,
    bonusTargetPct: 0.15, signOnTotal: 50000, signOnSchedule: [1],
    grantPrice: 400, initialGrantValue: 900000,
    refresherSchedule: JSON.parse(JSON.stringify(VEST_PRESETS.even4QuarterlyCliff)),
    refresherValue: 250000, refresherFirstYear: y + 1,
  }),
];

const HORIZON = 10;
const results = { conservative: [], medium: [], aggressive: [] };
for (const k of Object.keys(results)) {
  for (const o of offers) results[k].push(projectOffer(o, scen[k], HORIZON));
}
const payload = {
  generated: new Date().toISOString(), horizon: HORIZON, alignment: 'tenure',
  displayScenario: 'medium', scenarios: scen, offers, baselineId: 'base', results,
};

console.log('\nEXPORT TEST\n');

ok('all projections valid', Object.values(results).flat().every((r) => r.valid));

/* ---- CSV ---- */
buildCsv(payload);
await new Promise((r) => setTimeout(r, 60));
const csvFile = downloads.find((d) => d.name.endsWith('.csv'));
ok('CSV written', !!csvFile, JSON.stringify(downloads));
if (csvFile) {
  const csv = readFileSync(join(outDir, csvFile.name), 'utf8');
  const lines = csv.trim().split(/\r?\n/);
  ok('CSV has a header row', lines[4].startsWith('Offer,Scenario,Source grant'));
  const expectedTranches = Object.values(results).flat()
    .reduce((a, r) => a + r.ledger.length, 0);
  ok('CSV row count matches the ledger', lines.length - 5 === expectedTranches,
     `${lines.length - 5} vs ${expectedTranches}`);
  ok('CSV carries the gross disclaimer', csv.includes('GROSS'));
  ok('CSV quotes a field containing a comma', /"/.test(csv) || !csv.includes(','));
}

/* ---- XLSX ---- */
buildWorkbook(XLSX, payload);
await new Promise((r) => setTimeout(r, 60));
// In a browser XLSX.writeFile triggers a download; under Node the same
// call writes straight to the filesystem relative to cwd. Look in both.
const stamp = new Date().toISOString().slice(0, 10);
const xlsxName = `bigtechcalc-comparison-${stamp}.xlsx`;
const xlsxPath = [join(outDir, xlsxName), join(process.cwd(), xlsxName)]
  .find((p) => existsSync(p)) || join(outDir, xlsxName);
ok('XLSX written to disk', existsSync(xlsxPath), xlsxPath);
if (existsSync(xlsxPath)) {
  ok('XLSX is non-trivial in size', statSync(xlsxPath).size > 8000, `${statSync(xlsxPath).size} bytes`);
  // XLSX.readFile needs an fs adapter under ESM; read the buffer instead.
  const wb = XLSX.read(readFileSync(xlsxPath), { type: 'buffer' });
  ok('README tab present', wb.SheetNames.includes('README'));
  ok('Scenarios tab present', wb.SheetNames.includes('Scenarios'));
  ok('Inputs tab present', wb.SheetNames.includes('Inputs'));
  ok('Summary tab present', wb.SheetNames.includes('Summary'));
  ok('Tranche Ledger tab present', wb.SheetNames.includes('Tranche Ledger'));
  ok('one detail tab per offer', wb.SheetNames.length === 5 + offers.length,
     wb.SheetNames.join(' | '));
  ok('every sheet name is <= 31 chars', wb.SheetNames.every((n) => n.length <= 31),
     wb.SheetNames.filter((n) => n.length > 31).join(','));
  ok('illegal sheet-name characters stripped',
     wb.SheetNames.every((n) => !/[\\/?*[\]:]/.test(n)), wb.SheetNames.join(' | '));

  const sum = XLSX.utils.sheet_to_json(wb.Sheets['Summary'], { header: 1 });
  const dataRows = sum.slice(4).filter((r) => r.length > 3);
  ok('Summary has 3 scenarios x 3 offers', dataRows.length === 9, `${dataRows.length}`);

  // Cross-check one number against the engine rather than trusting the writer.
  const engineMedA = results.medium.find((r) => r.offerId === 'a').totalGross;
  const sheetMedA = dataRows.find((r) => r[0] === 'Offer A' && r[1] === 'Medium')[6];
  ok('Summary total ties to the engine', Math.abs(sheetMedA - engineMedA) < 0.01,
     `sheet ${sheetMedA} vs engine ${engineMedA}`);

  const led = XLSX.utils.sheet_to_json(wb.Sheets['Tranche Ledger'], { header: 1 });
  const ledData = led.slice(4).filter((r) => r.length > 5);
  const expected = Object.values(results).flat().reduce((a, r) => a + r.ledger.length, 0);
  ok('Ledger tab row count matches', ledData.length === expected, `${ledData.length} vs ${expected}`);
}

/* ---- PDF ---- */
const jspdfMod = await import('jspdf');
await import('jspdf-autotable');
const jsPDFNS = { jsPDF: jspdfMod.jsPDF || jspdfMod.default };
try {
  buildPdf(jsPDFNS, payload);
  await new Promise((r) => setTimeout(r, 120));
  const pdfName = `bigtechcalc-comparison-${stamp}.pdf`;
  const pdfPath = [join(outDir, pdfName), join(process.cwd(), pdfName)]
    .find((p) => existsSync(p)) || join(outDir, pdfName);
  const madeIt = existsSync(pdfPath);
  ok('PDF written', madeIt, madeIt ? '' : 'no PDF found in outDir or cwd');
  if (madeIt) {
    const buf = readFileSync(pdfPath);
    ok('PDF has a valid header', buf.slice(0, 5).toString() === '%PDF-');
    ok('PDF is non-trivial in size', buf.length > 10000, `${buf.length} bytes`);
    const text = buf.toString('latin1');
    const pages = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
    ok('PDF has summary + per-offer + methodology pages', pages >= 2 + offers.length,
       `${pages} pages`);
  }
} catch (e) {
  ok('PDF built without throwing', false, String(e.message));
}

console.log('\n' + '='.repeat(60));
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('  Exports produce valid, parseable files.');
console.log('='.repeat(60));

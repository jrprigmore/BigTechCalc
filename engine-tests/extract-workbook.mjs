/*
 * Workbook extractor for the parity check.
 *
 * Dumps Comp_Comparison_Model_v2.xlsx into the JSON shape
 * workbook-parity.mjs compares the engine against: per-tab inputs,
 * vesting-schedule percents, and per-scenario year-by-year figures.
 *
 * This replaces a python/openpyxl extraction step — no Python
 * dependency needed. It reads the workbook's cached formula results
 * straight from the .xlsx via the `xlsx` package (already a
 * devDependency), the same way openpyxl's data_only=True would.
 *
 * Run:  node engine-tests/extract-workbook.mjs [output-path]
 *       defaults to engine-tests/out/wb.json
 */
import XLSX from 'xlsx';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'Comp_Comparison_Model_v2.xlsx');
const OUT = process.argv[2] || path.join(__dirname, 'out', 'wb.json');

const TABS = ['Offer_1', 'Offer_2', 'Offer_3', 'Current_Comp'];

const SCEN_LABEL_TO_KEY = {
  CONSERVATIVE: 'conservative',
  MEDIUM: 'medium',
  AGGRESSIVE: 'aggressive',
};

// The row labels workbook-parity.mjs's MAP looks up per scenario block.
const NEEDED = [
  'Share price ($)', 'Base salary', 'Annual bonus', 'Sign-on paid',
  'Initial grant vest ($)', 'Refresher vest ($)', 'Total equity vest ($)',
  'Concurrent grants vesting (count)', 'TOTAL GROSS COMPENSATION', 'Cumulative gross',
];

const wb = XLSX.readFile(SRC);
const out = {};

for (const tabName of TABS) {
  const sheet = wb.Sheets[tabName];
  if (!sheet) throw new Error(`Tab not found in workbook: ${tabName}`);
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });

  const inputs = {};
  let inInputs = false;
  let initialSched = [];
  let refresherSched = [];
  const scenarioHeaderRows = [];

  rows.forEach((r, idx) => {
    const a = r[0];

    if (a === 'INPUTS') { inInputs = true; return; }
    if (a === 'VESTING SCHEDULES — % of the grant that vests in each year AFTER the grant date') {
      inInputs = false;
      return;
    }
    if (inInputs && typeof a === 'string' && a.trim() && r[1] !== '' && r[1] !== undefined) {
      inputs[a] = r[1];
    }

    // The vesting-schedule row (percents, columns C-J) shares its label
    // with the grant-ledger row further down (dollar values) — only
    // take the first match, and sanity-check it looks like a percent.
    if (a === 'Initial grant' && initialSched.length === 0 && r[2] !== undefined) {
      const vals = r.slice(2, 10).map(Number);
      if (vals.every((v) => Math.abs(v) <= 1)) initialSched = vals;
    }
    if (a === 'Refresher grants' && refresherSched.length === 0) {
      refresherSched = r.slice(2, 10).map(Number);
    }

    if (typeof a === 'string' && a.startsWith('SCENARIO: ')) {
      const key = SCEN_LABEL_TO_KEY[a.replace('SCENARIO: ', '').trim()];
      scenarioHeaderRows.push({ key, start: idx });
    }
  });

  const scen = {};
  scenarioHeaderRows.forEach(({ key, start }, i) => {
    const end = scenarioHeaderRows[i + 1] ? scenarioHeaderRows[i + 1].start : rows.length;
    const block = {};
    for (let ri = start + 1; ri < end; ri++) {
      const r = rows[ri];
      const a = r[0];
      if (NEEDED.includes(a) && !block[a]) {
        // 15 year columns, C through Q.
        block[a] = r.slice(2, 17).map((v) => (v === '' ? null : Number(v)));
      }
    }
    scen[key] = block;
  });

  out[tabName] = { inputs, sched: { initial: initialSched, refresher: refresherSched }, scen };
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`Wrote ${OUT} (${TABS.length} tabs, ${TABS.map((t) => Object.keys(out[t].scen).length).reduce((a, b) => a + b, 0)} scenario blocks).`);

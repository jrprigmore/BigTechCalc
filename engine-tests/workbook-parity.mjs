/*
 * Workbook parity check.
 *
 * Reproduces all four tabs of Comp_Comparison_Model_v2.xlsx (Offer_1,
 * Offer_2, Offer_3, Current_Comp) across all three scenarios and
 * compares every modelled row against the workbook's own cached
 * calculated values.
 *
 * This is stronger than the spec fixtures: it checks the engine against
 * what the spreadsheet actually computes, not against what the spec
 * says it computes.
 *
 * Input: /tmp/wb.json (dumped from the workbook by the python extractor)
 * Run:   node engine-tests/workbook-parity.mjs <path-to-wb.json>
 */

import { readFileSync } from 'node:fs';
import { projectOffer, blankOffer, r2 } from '../site/js/engine.js';

const wbPath = process.argv[2] || '/tmp/wb.json';
const wb = JSON.parse(readFileSync(wbPath, 'utf8'));

// Scenario levers as they are set on the workbook's Scenarios tab.
const SCEN = {
  conservative: {
    key: 'conservative', name: 'Conservative',
    priceAppreciation: 0, meritFactor: 0.5, bonusMultiplier: 0.75,
    refresherGrowthFactor: 0, refresherYears: 4,
  },
  medium: {
    key: 'medium', name: 'Medium',
    priceAppreciation: 0.07, meritFactor: 1, bonusMultiplier: 1,
    refresherGrowthFactor: 1, refresherYears: 12,
  },
  aggressive: {
    key: 'aggressive', name: 'Aggressive',
    priceAppreciation: 0.15, meritFactor: 1.5, bonusMultiplier: 1.25,
    refresherGrowthFactor: 1, refresherYears: 12,
  },
};

function schedFrom(arr) {
  const events = [];
  arr.forEach((p, i) => {
    const v = Number(p) || 0;
    if (v > 0) events.push({ periodIndex: i + 1, percent: v });
  });
  if (!events.length) events.push({ periodIndex: 1, percent: 1 });
  return { granularity: 'annual', cliffPeriods: 0, events };
}

function offerFrom(tab) {
  const i = tab.inputs;
  const signOn = [
    Number(i['Sign-on % paid Year 1']) || 0,
    Number(i['Sign-on % paid Year 2']) || 0,
    Number(i['Sign-on % paid Year 3']) || 0,
  ];
  return blankOffer({
    company: i['Company name'],
    ticker: i['Ticker'],
    startYear: Number(i['Start calendar year']),
    baseSalary: Number(i['Base salary at start']),
    meritPct: Number(i['Merit increase %/yr']),
    bonusTargetPct: Number(i['Bonus target % of base']),
    bonusBasis: String(i['Bonus basis (Current or Prior)']).toLowerCase() === 'prior' ? 'prior' : 'current',
    bonusInYear1: String(i['Bonus paid in Year 1? (Yes/No)']).toLowerCase() === 'yes',
    signOnTotal: Number(i['Sign-on total']),
    signOnSchedule: Number(i['Sign-on total']) > 0 ? signOn : [1],
    grantPrice: Number(i['Grant-date share price']),
    initialGrantValue: Number(i['Initial grant value ($)']),
    initialSchedule: schedFrom(tab.sched.initial),
    refresherValue: Number(i['Refresher value, first grant ($)']),
    refresherFirstYear: Number(i['First refresher calendar year']),
    refresherGrowthPct: Number(i['Refresher grant growth %/yr']),
    refresherSchedule: schedFrom(tab.sched.refresher),
    refresherSlots: 12,
    firstVestOffsetYears: Number(i['First vest timing (0 = grant year, 1 = year after)']),
  });
}

const MAP = {
  'Share price ($)': 'sharePrice',
  'Base salary': 'baseSalary',
  'Annual bonus': 'bonus',
  'Sign-on paid': 'signOn',
  'Initial grant vest ($)': 'initialVest',
  'Refresher vest ($)': 'refresherVest',
  'Total equity vest ($)': 'equityVest',
  'Concurrent grants vesting (count)': 'concurrentGrants',
  'TOTAL GROSS COMPENSATION': 'total',
  'Cumulative gross': 'cumulative',
};

const HORIZON = 15;
let checks = 0, bad = 0;
const problems = [];

for (const [tabName, tab] of Object.entries(wb)) {
  const offer = offerFrom(tab);
  console.log(`\n${tabName}  (${offer.company})`);
  for (const [scenName, scen] of Object.entries(SCEN)) {
    const res = projectOffer(offer, scen, HORIZON);
    if (!res.valid) {
      console.log(`  ${scenName}: ENGINE REJECTED — ${res.errors.join('; ')}`);
      bad++;
      continue;
    }
    let worstAbs = 0, worstLabel = '';
    const expected = tab.scen[scenName];
    for (const [label, key] of Object.entries(MAP)) {
      const exp = expected[label];
      if (!exp) continue;
      for (let y = 0; y < HORIZON; y++) {
        const e = Number(exp[y]);
        if (!isFinite(e)) continue;
        const a = Number(res.rows[y][key]);
        checks++;
        // Workbook carries full float precision; engine rounds to cents.
        // Tolerance scales with magnitude to absorb cent rounding across
        // a 15-year cumulative.
        const tol = Math.max(0.02, Math.abs(e) * 1e-9 + 0.02 * (y + 1));
        const diff = Math.abs(a - e);
        if (diff > tol) {
          bad++;
          if (diff > worstAbs) { worstAbs = diff; worstLabel = `${label} y${y + 1}: engine ${r2(a)} vs wb ${r2(e)}`; }
          if (problems.length < 25) problems.push(`${tabName}/${scenName}/${label} y${y + 1}: engine ${r2(a)} vs workbook ${r2(e)}`);
        }
      }
    }
    const status = worstAbs === 0 ? 'MATCH' : `DIFF (worst ${r2(worstAbs)})`;
    console.log(`  ${scenName.padEnd(13)} ${status}${worstLabel ? ' — ' + worstLabel : ''}`);
  }
}

console.log('\n' + '='.repeat(64));
console.log(`  ${checks} cell comparisons, ${bad} outside tolerance`);
if (problems.length) {
  console.log('\n  First discrepancies:');
  for (const p of problems) console.log('   - ' + p);
  process.exit(1);
}
console.log('  Engine reproduces the workbook across all tabs and scenarios.');
console.log('='.repeat(64));

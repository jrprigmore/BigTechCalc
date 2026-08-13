/*
 * Engine regression tests — bigtechcalc.com
 *
 * Fixtures are taken from comp-calculator-spec.md §4.1 and from
 * Comp_Comparison_Model_v2.xlsx. The golden fixture ($156,886.01) ties
 * cell-for-cell to D8:L8 of the original workbook.
 *
 * Run: node engine-tests/engine.test.mjs
 */

import {
  projectOffer,
  blankOffer,
  defaultScenarios,
  validateSchedule,
  VEST_PRESETS,
  applyAppreciationCap,
  r2,
} from '../site/js/engine.js';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function eq(name, actual, expected, tol = 0.005) {
  ok(name, Math.abs(actual - expected) <= tol, `got ${actual}, expected ${expected}`);
}

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

const S = defaultScenarios();

/* ================================================================== *
 * TEST 1 — Golden fixture: refresher steady state
 *
 * Refresher $150,000 first granted in year 0, 3%/yr grant growth,
 * even 4-year annual vest, first vest one year after grant,
 * 0% price appreciation.
 * ================================================================== */
console.log('\nTEST 1 — Golden fixture: refresher steady state');
{
  const offer = blankOffer({
    startYear: 2026,
    baseSalary: 0,
    meritPct: 0,
    bonusTargetPct: 0,
    signOnTotal: 0,
    grantPrice: 150,
    initialGrantValue: 0,
    refresherValue: 150000,
    // Spec §4.1: "first granted in year 0 ... first vest one year after
    // grant", and the expected table is indexed from year 1. Year 0 is
    // therefore the year before the offer's year 1.
    refresherFirstYear: 2025,
    refresherGrowthPct: 0.03,
    refresherSchedule: clone(VEST_PRESETS.even4Annual),
    refresherSlots: 12,
    firstVestOffsetYears: 1,
  });

  // Scenario with 0% appreciation, full refresher growth, all slots.
  const sc = {
    key: 'fixture',
    name: 'Fixture',
    priceAppreciation: 0,
    meritFactor: 1,
    bonusMultiplier: 1,
    refresherGrowthFactor: 1,
    refresherYears: 12,
  };

  const res = projectOffer(offer, sc, 10);
  const expected = [
    37500.00, 76125.00, 115908.75, 156886.01,
    161592.59, 166440.37, 171433.58, 176576.59, 181873.89,
  ];

  ok('engine returns valid result', res.valid, JSON.stringify(res.errors));
  expected.forEach((exp, k) => {
    const yr = k + 1;
    eq(`  year ${yr} refresher vest`, res.rows[yr - 1].refresherVest, exp, 0.005);
  });

  // The headline reference figure, called out explicitly.
  eq('GOLDEN: year 4 = $156,886.01', res.rows[3].refresherVest, 156886.01, 0.005);
}

/* ================================================================== *
 * TEST 2 — Front-loaded initial grant, no appreciation
 * $400,000 at 40/28/20/12 -> 160,000 / 112,000 / 80,000 / 48,000
 * ================================================================== */
console.log('\nTEST 2 — Front-loaded initial grant (40/28/20/12), 0% appreciation');
{
  const offer = blankOffer({
    startYear: 2026,
    baseSalary: 0,
    meritPct: 0,
    bonusTargetPct: 0,
    signOnTotal: 0,
    grantPrice: 150,
    initialGrantValue: 400000,
    initialSchedule: clone(VEST_PRESETS.frontLoaded4),
    refresherValue: 0,
    firstVestOffsetYears: 1,
  });
  const sc = { ...S.conservative, refresherYears: 0 };
  const res = projectOffer(offer, sc, 10);

  eq('year 1 (offset=1, no vest yet)', res.rows[0].initialVest, 0);
  eq('year 2', res.rows[1].initialVest, 160000);
  eq('year 3', res.rows[2].initialVest, 112000);
  eq('year 4', res.rows[3].initialVest, 80000);
  eq('year 5', res.rows[4].initialVest, 48000);

  const sum = res.rows.reduce((a, r) => a + r.initialVest, 0);
  eq('total vested equals grant value', sum, 400000);
}

/* ================================================================== *
 * TEST 2b — Vest timing toggle
 * Same grant with offset 0 shifts the series one year earlier and
 * changes no dollar amounts.
 * ================================================================== */
console.log('\nTEST 2b — First-vest timing toggle (offset 0 vs 1)');
{
  const base = {
    startYear: 2026, baseSalary: 0, meritPct: 0, bonusTargetPct: 0,
    signOnTotal: 0, grantPrice: 150, initialGrantValue: 400000,
    initialSchedule: clone(VEST_PRESETS.frontLoaded4), refresherValue: 0,
  };
  const sc = { ...S.conservative, refresherYears: 0 };
  const a = projectOffer(blankOffer({ ...base, firstVestOffsetYears: 1 }), sc, 10);
  const b = projectOffer(blankOffer({ ...base, firstVestOffsetYears: 0 }), sc, 10);

  eq('offset 0 year 1', b.rows[0].initialVest, 160000);
  eq('offset 0 year 2', b.rows[1].initialVest, 112000);
  eq('offset 0 year 3', b.rows[2].initialVest, 80000);
  eq('offset 0 year 4', b.rows[3].initialVest, 48000);

  const shifted = a.rows.slice(1).map((r) => r2(r.initialVest));
  const direct = b.rows.slice(0, shifted.length).map((r) => r2(r.initialVest));
  ok('series is a pure one-year shift', JSON.stringify(shifted) === JSON.stringify(direct),
     `${JSON.stringify(shifted)} vs ${JSON.stringify(direct)}`);

  const sumA = a.rows.reduce((x, r) => x + r.initialVest, 0);
  const sumB = b.rows.reduce((x, r) => x + r.initialVest, 0);
  eq('dollar totals unchanged by the toggle', sumA, sumB);
}

/* ================================================================== *
 * TEST 3 — Vest schedule validation
 * A schedule summing to 97% or 103% must be rejected.
 * ================================================================== */
console.log('\nTEST 3 — Vest schedule validation');
{
  const bad97 = {
    granularity: 'annual', cliffPeriods: 0,
    events: [
      { periodIndex: 1, percent: 0.25 }, { periodIndex: 2, percent: 0.25 },
      { periodIndex: 3, percent: 0.25 }, { periodIndex: 4, percent: 0.22 },
    ],
  };
  const bad103 = clone(bad97);
  bad103.events[3].percent = 0.28;

  ok('97% schedule rejected', validateSchedule(bad97).ok === false);
  ok('103% schedule rejected', validateSchedule(bad103).ok === false);
  ok('100% schedule accepted', validateSchedule(VEST_PRESETS.even4Annual).ok === true);
  ok('quarterly preset accepted', validateSchedule(VEST_PRESETS.even4QuarterlyCliff).ok === true);
  ok('monthly preset accepted', validateSchedule(VEST_PRESETS.even4Monthly).ok === true);
  ok('5-year preset accepted', validateSchedule(VEST_PRESETS.even5Annual).ok === true);
  ok('3-year preset accepted', validateSchedule(VEST_PRESETS.even3Annual).ok === true);

  // Calculation must be blocked, not silently wrong.
  const offer = blankOffer({
    initialGrantValue: 400000, initialSchedule: bad97, refresherValue: 0,
  });
  const res = projectOffer(offer, S.medium, 10);
  ok('projection blocked on invalid schedule', res.valid === false);
}

/* ================================================================== *
 * TEST 4 — Appreciation
 * $400,000, 25/25/25/25, 10%/yr appreciation.
 * Tranche values must rise with the price path and total must exceed
 * the grant value. This is the §2.1 defect being fixed.
 * ================================================================== */
console.log('\nTEST 4 — Share price appreciation is applied');
{
  const offer = blankOffer({
    startYear: 2026, baseSalary: 0, meritPct: 0, bonusTargetPct: 0,
    signOnTotal: 0, grantPrice: 100, initialGrantValue: 400000,
    initialSchedule: clone(VEST_PRESETS.even4Annual),
    refresherValue: 0, firstVestOffsetYears: 1,
  });
  const sc = { ...S.medium, priceAppreciation: 0.10, refresherYears: 0 };
  const res = projectOffer(offer, sc, 10);

  // 4000 shares at $100. 1000 shares vest each year at 110/121/133.1/146.41
  eq('year 2 vest (1000 sh @ $110)', res.rows[1].initialVest, 110000);
  eq('year 3 vest (1000 sh @ $121)', res.rows[2].initialVest, 121000);
  eq('year 4 vest (1000 sh @ $133.10)', res.rows[3].initialVest, 133100);
  eq('year 5 vest (1000 sh @ $146.41)', res.rows[4].initialVest, 146410);

  const sum = res.rows.reduce((a, r) => a + r.initialVest, 0);
  ok('total exceeds grant value', sum > 400000, `sum=${r2(sum)}`);
  eq('total equals sum of appreciated tranches', sum, 510510);
}

/* ================================================================== *
 * TEST 5 — Overlap count
 * Annual refreshers on a 4-year schedule produce exactly 4 concurrent
 * grants in steady state. 5 is the Block 3 G34 regression.
 * ================================================================== */
console.log('\nTEST 5 — Concurrent grant overlap count');
{
  const offer = blankOffer({
    startYear: 2026, baseSalary: 0, meritPct: 0, bonusTargetPct: 0,
    signOnTotal: 0, grantPrice: 100, initialGrantValue: 0,
    refresherValue: 150000, refresherFirstYear: 2025,
    refresherGrowthPct: 0.03,
    refresherSchedule: clone(VEST_PRESETS.even4Annual),
    refresherSlots: 12, firstVestOffsetYears: 1,
  });
  const sc = { ...S.medium, priceAppreciation: 0, refresherYears: 12 };
  const res = projectOffer(offer, sc, 10);

  const counts = res.rows.map((r) => r.concurrentGrants);
  eq('year 1 concurrent', counts[0], 1);
  eq('year 2 concurrent', counts[1], 2);
  eq('year 3 concurrent', counts[2], 3);
  eq('year 4 concurrent (steady state)', counts[3], 4);
  eq('year 5 concurrent holds at 4', counts[4], 4);
  eq('year 8 concurrent holds at 4', counts[7], 4);
  ok('never reaches 5 (G34 regression)', counts.every((c) => c <= 4), JSON.stringify(counts));
}

/* ================================================================== *
 * TEST 6 — Cliff
 * A 1-year cliff quarterly schedule has zero vest value before the
 * cliff date.
 * ================================================================== */
console.log('\nTEST 6 — Quarterly schedule with a 1-year cliff');
{
  const offer = blankOffer({
    startYear: 2026, baseSalary: 0, meritPct: 0, bonusTargetPct: 0,
    signOnTotal: 0, grantPrice: 100, initialGrantValue: 400000,
    initialSchedule: clone(VEST_PRESETS.even4QuarterlyCliff),
    refresherValue: 0,
  });
  const sc = { ...S.conservative, refresherYears: 0 };
  const res = projectOffer(offer, sc, 10);

  eq('year 1 (pre-cliff) vests nothing', res.rows[0].initialVest, 0);
  // Cliff at period 4 = 1.0yr -> lands in year 2. Periods 4..7 -> yr 2.
  eq('year 2 vests 4 quarters', res.rows[1].initialVest, 100000);
  eq('year 3 vests 4 quarters', res.rows[2].initialVest, 100000);
  eq('year 4 vests 4 quarters', res.rows[3].initialVest, 100000);
  eq('year 5 vests 4 quarters', res.rows[4].initialVest, 100000);
  const sum = res.rows.reduce((a, r) => a + r.initialVest, 0);
  eq('total equals grant value at 0% appreciation', sum, 400000);

  const preCliff = res.ledger.filter((t) => t.vestFractionalYear < 1.0);
  ok('no tranche before the cliff', preCliff.length === 0, `found ${preCliff.length}`);
}

/* ================================================================== *
 * TEST 7 — Horizon
 * Tranches past the horizon are excluded from income and reported as
 * unvested.
 * ================================================================== */
console.log('\nTEST 7 — Horizon exclusion and unvested reporting');
{
  const offer = blankOffer({
    startYear: 2026, baseSalary: 0, meritPct: 0, bonusTargetPct: 0,
    signOnTotal: 0, grantPrice: 100, initialGrantValue: 0,
    refresherValue: 100000, refresherFirstYear: 2026,
    refresherGrowthPct: 0,
    refresherSchedule: clone(VEST_PRESETS.even4Annual),
    refresherSlots: 12, firstVestOffsetYears: 1,
  });
  const sc = { ...S.medium, priceAppreciation: 0, refresherYears: 12 };
  const res = projectOffer(offer, sc, 5);

  const beyond = res.ledger.filter((t) => !t.withinHorizon);
  ok('tranches beyond horizon exist', beyond.length > 0, `${beyond.length}`);
  ok('none of them are in the income rows',
     res.rows.every((r) => r.yearIndex <= 5));
  ok('unvested shares reported', res.unvestedShares > 0, `${res.unvestedShares}`);

  const inHorizonSum = res.ledger
    .filter((t) => t.withinHorizon)
    .reduce((a, t) => a + t.value, 0);
  const rowSum = res.rows.reduce((a, r) => a + r.equityVest, 0);
  eq('ledger in-horizon total ties to row totals', rowSum, inHorizonSum, 0.02);

  const beyondShares = beyond.reduce((a, t) => a + t.shares, 0);
  eq('unvested shares tie to the beyond-horizon tranches', res.unvestedShares, beyondShares, 1e-9);
}

/* ================================================================== *
 * TEST 8 — Bonus basis and first-year handling
 * ================================================================== */
console.log('\nTEST 8 — Bonus basis (current vs prior) and year-1 handling');
{
  const common = {
    startYear: 2026, baseSalary: 200000, meritPct: 0.03,
    bonusTargetPct: 0.20, signOnTotal: 0, grantPrice: 100,
    initialGrantValue: 0, refresherValue: 0,
  };
  const sc = { ...S.medium, meritFactor: 1, bonusMultiplier: 1, refresherYears: 0 };

  const cur = projectOffer(blankOffer({ ...common, bonusBasis: 'current', bonusInYear1: false }), sc, 5);
  eq('current basis, year 1 bonus suppressed', cur.rows[0].bonus, 0);
  eq('current basis, year 2 bonus', cur.rows[1].bonus, r2(200000 * 1.03 * 0.20));

  const curY1 = projectOffer(blankOffer({ ...common, bonusBasis: 'current', bonusInYear1: true }), sc, 5);
  eq('current basis, year 1 bonus paid', curY1.rows[0].bonus, 40000);

  const pri = projectOffer(blankOffer({ ...common, bonusBasis: 'prior', bonusInYear1: true }), sc, 5);
  eq('prior basis, year 1 bonus is zero (no prior year)', pri.rows[0].bonus, 0);
  eq('prior basis, year 2 bonus on year 1 salary', pri.rows[1].bonus, 40000);

  // Bonus multiplier
  const scAgg = { ...sc, bonusMultiplier: 1.25 };
  const agg = projectOffer(blankOffer({ ...common, bonusBasis: 'current', bonusInYear1: true }), scAgg, 5);
  eq('bonus multiplier 1.25 applied', agg.rows[0].bonus, 50000);
}

/* ================================================================== *
 * TEST 9 — Sign-on schedule
 * ================================================================== */
console.log('\nTEST 9 — Sign-on payout schedule');
{
  const offer = blankOffer({
    startYear: 2026, baseSalary: 0, meritPct: 0, bonusTargetPct: 0,
    signOnTotal: 100000, signOnSchedule: [0.5, 0.5],
    grantPrice: 100, initialGrantValue: 0, refresherValue: 0,
  });
  const sc = { ...S.medium, refresherYears: 0 };
  const res = projectOffer(offer, sc, 5);
  eq('year 1 sign-on', res.rows[0].signOn, 50000);
  eq('year 2 sign-on', res.rows[1].signOn, 50000);
  eq('year 3 sign-on', res.rows[2].signOn, 0);

  const bad = blankOffer({
    ...offer, id: 'x2', signOnSchedule: [0.5, 0.3],
  });
  ok('sign-on not totalling 100% is rejected', projectOffer(bad, sc, 5).valid === false);

  const three = blankOffer({
    ...offer, id: 'x3', signOnSchedule: [0.4, 0.35, 0.25],
  });
  const r3 = projectOffer(three, sc, 5);
  eq('3-installment sign-on year 3', r3.rows[2].signOn, 25000);
}

/* ================================================================== *
 * TEST 10 — Conservative scenario stops refreshers after 4 years
 * ================================================================== */
console.log('\nTEST 10 — Scenario refresher-year limit');
{
  const offer = blankOffer({
    startYear: 2026, baseSalary: 0, meritPct: 0, bonusTargetPct: 0,
    signOnTotal: 0, grantPrice: 100, initialGrantValue: 0,
    refresherValue: 100000, refresherFirstYear: 2026,
    refresherGrowthPct: 0.03,
    refresherSchedule: clone(VEST_PRESETS.even4Annual),
    refresherSlots: 12, firstVestOffsetYears: 1,
  });
  const cons = projectOffer(offer, S.conservative, 12);
  const med = projectOffer(offer, S.medium, 12);

  const consGrantYears = new Set(cons.ledger.map((t) => t.grantYear));
  eq('conservative grants 4 refreshers', consGrantYears.size, 4);
  eq('medium grants 12 refreshers', new Set(med.ledger.map((t) => t.grantYear)).size, 12);

  // Conservative: refresher growth factor is 0, so every grant is the same size.
  const vals = new Set(cons.ledger.map((t) => t.grantValue));
  eq('conservative refresher size does not grow', vals.size, 1);
}

/* ================================================================== *
 * TEST 11 — Appreciation cap is visible, not silent
 * ================================================================== */
console.log('\nTEST 11 — Appreciation cap');
{
  const c = applyAppreciationCap(0.34, 0.20, true);
  eq('capped rate', c.applied, 0.20);
  eq('uncapped rate preserved', c.uncapped, 0.34);
  ok('cap flag set', c.wasCapped === true);

  const u = applyAppreciationCap(0.12, 0.20, true);
  eq('below cap passes through', u.applied, 0.12);
  ok('cap flag clear', u.wasCapped === false);

  const off = applyAppreciationCap(0.34, 0.20, false);
  eq('cap disabled passes through', off.applied, 0.34);
}

/* ================================================================== *
 * TEST 12 — Cents accumulation does not drift
 * ================================================================== */
console.log('\nTEST 12 — Currency precision');
{
  const offer = blankOffer({
    startYear: 2026, baseSalary: 123456.78, meritPct: 0.0333,
    bonusTargetPct: 0.1717, bonusInYear1: true, signOnTotal: 0,
    grantPrice: 37.91, initialGrantValue: 333333.33,
    initialSchedule: clone(VEST_PRESETS.even3Annual),
    refresherValue: 77777.77, refresherFirstYear: 2027,
    refresherGrowthPct: 0.0271,
    refresherSchedule: clone(VEST_PRESETS.even4QuarterlyCliff),
    refresherSlots: 12,
  });
  const res = projectOffer(offer, S.aggressive, 10);
  ok('valid', res.valid, JSON.stringify(res.errors));

  const recomputed = res.rows.reduce(
    (a, r) => a + r.baseSalary + r.bonus + r.signOn + r.equityVest, 0);
  eq('cumulative ties to component sum', res.rows[9].cumulative, r2(recomputed), 0.01);

  const allCents = res.rows.every((r) =>
    Math.abs(r.total * 100 - Math.round(r.total * 100)) < 1e-6);
  ok('every total is an exact cent value', allCents);
}

/* ================================================================== */
console.log('\n' + '='.repeat(60));
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('  All engine fixtures reproduce the workbook.');
console.log('='.repeat(60));

/*
 * bigtechcalc.com — compensation projection engine
 * PEFG, PLLC
 *
 * Pure, dependency-free. No DOM, no network, no I/O.
 * Everything in this module is a deterministic function of its inputs.
 *
 * Source of truth for the math: Comp_Comparison_Model_v2.xlsx
 * Reference spec: comp-calculator-spec.md
 *
 * ALL FIGURES ARE GROSS. No tax calculation is performed anywhere in this file.
 */

/* ------------------------------------------------------------------ *
 * Money
 *
 * Currency is accumulated as integer cents. Individual tranche values
 * are rounded to cents at the point of creation, then summed as
 * integers, so no float error accumulates across a 15-year ledger.
 * ------------------------------------------------------------------ */

/** Round a float dollar amount to integer cents (half-up on the cent). */
export function toCents(dollars) {
  if (!isFinite(dollars)) return 0;
  return Math.round(dollars * 100);
}

/** Convert integer cents back to a dollar number. */
export function fromCents(cents) {
  return cents / 100;
}

/** Round a dollar float to 2dp. Display helper only. */
export function r2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/* ------------------------------------------------------------------ *
 * Vesting schedules
 * ------------------------------------------------------------------ */

export const PERIODS_PER_YEAR = {
  annual: 1,
  quarterly: 4,
  monthly: 12,
};

/**
 * Vesting schedule presets.
 *
 * These are USER-EDITABLE TEMPLATES, not a statement of any named
 * employer's current equity policy. Vesting policies change; the user
 * must enter what their own offer letter actually says.
 */
export const VEST_PRESETS = {
  even4Annual: {
    label: 'Even 4-year, annual (25/25/25/25)',
    granularity: 'annual',
    cliffPeriods: 0,
    events: [
      { periodIndex: 1, percent: 0.25 },
      { periodIndex: 2, percent: 0.25 },
      { periodIndex: 3, percent: 0.25 },
      { periodIndex: 4, percent: 0.25 },
    ],
  },
  frontLoaded4: {
    label: 'Front-loaded 4-year (40/28/20/12)',
    granularity: 'annual',
    cliffPeriods: 0,
    events: [
      { periodIndex: 1, percent: 0.40 },
      { periodIndex: 2, percent: 0.28 },
      { periodIndex: 3, percent: 0.20 },
      { periodIndex: 4, percent: 0.12 },
    ],
  },
  backLoaded4: {
    label: 'Back-loaded 4-year (5/15/40/40)',
    granularity: 'annual',
    cliffPeriods: 0,
    events: [
      { periodIndex: 1, percent: 0.05 },
      { periodIndex: 2, percent: 0.15 },
      { periodIndex: 3, percent: 0.40 },
      { periodIndex: 4, percent: 0.40 },
    ],
  },
  even5Annual: {
    label: 'Even 5-year, annual (20 x 5)',
    granularity: 'annual',
    cliffPeriods: 0,
    events: [1, 2, 3, 4, 5].map((i) => ({ periodIndex: i, percent: 0.20 })),
  },
  even3Annual: {
    label: 'Even 3-year, annual (33.34/33.33/33.33)',
    granularity: 'annual',
    cliffPeriods: 0,
    events: [
      { periodIndex: 1, percent: 0.3334 },
      { periodIndex: 2, percent: 0.3333 },
      { periodIndex: 3, percent: 0.3333 },
    ],
  },
  even4QuarterlyCliff: {
    label: 'Even 4-year, quarterly, 1-year cliff (6.25% x 16)',
    granularity: 'quarterly',
    cliffPeriods: 4,
    events: Array.from({ length: 16 }, (_, k) => ({
      periodIndex: k + 4,
      percent: 0.0625,
    })),
  },
  even4Monthly: {
    label: 'Even 4-year, monthly, 1-year cliff',
    granularity: 'monthly',
    cliffPeriods: 12,
    // 12-month cliff releases 25%, then 1/48 monthly for 36 months.
    events: [
      { periodIndex: 12, percent: 0.25 },
      ...Array.from({ length: 36 }, (_, k) => ({
        periodIndex: 13 + k,
        percent: 0.75 / 36,
      })),
    ],
  },
};

/**
 * Validate a vesting schedule.
 * Percentages must sum to 100.00%. Anything else blocks calculation.
 * Returns { ok, sum, errors[] }.
 */
export function validateSchedule(schedule) {
  const errors = [];
  if (!schedule || !Array.isArray(schedule.events)) {
    return { ok: false, sum: 0, errors: ['Schedule has no vest events.'] };
  }
  if (!PERIODS_PER_YEAR[schedule.granularity]) {
    errors.push(`Unknown granularity "${schedule.granularity}".`);
  }
  if (schedule.events.length === 0) {
    errors.push('Schedule has no vest events.');
  }
  let sum = 0;
  for (const ev of schedule.events) {
    if (!isFinite(ev.percent)) errors.push('A vest event has a non-numeric percent.');
    if (ev.percent < 0) errors.push('A vest event has a negative percent.');
    if (!isFinite(ev.periodIndex) || ev.periodIndex < 0) {
      errors.push('A vest event has an invalid period index.');
    }
    if (schedule.cliffPeriods > 0 && ev.periodIndex < schedule.cliffPeriods) {
      errors.push(
        `Vest event at period ${ev.periodIndex} falls before the ${schedule.cliffPeriods}-period cliff.`
      );
    }
    sum += ev.percent;
  }
  // Tolerance is 1e-6 on the fraction, i.e. one ten-thousandth of a percent.
  const ok = errors.length === 0 && Math.abs(sum - 1) < 1e-6;
  if (errors.length === 0 && !ok) {
    errors.push(
      `Vesting schedule totals ${(sum * 100).toFixed(4)}% — it must total exactly 100%.`
    );
  }
  return { ok, sum, errors };
}

/* ------------------------------------------------------------------ *
 * Scenarios
 * ------------------------------------------------------------------ */

/**
 * Seeded scenario defaults.
 *
 * Every value here is USER-EDITABLE. These are starting assumptions,
 * not forecasts.
 *
 * The 7%/yr medium share-price figure is a long-run broad-market
 * nominal assumption. It is not a forecast for any specific company.
 */
export function defaultScenarios() {
  return {
    conservative: {
      key: 'conservative',
      name: 'Conservative',
      priceAppreciation: 0.00,
      meritFactor: 0.5,
      bonusMultiplier: 0.75,
      refresherGrowthFactor: 0,
      refresherYears: 4,
    },
    medium: {
      key: 'medium',
      name: 'Medium',
      priceAppreciation: 0.07,
      meritFactor: 1.0,
      bonusMultiplier: 1.00,
      refresherGrowthFactor: 1,
      refresherYears: 12,
    },
    aggressive: {
      key: 'aggressive',
      name: 'Aggressive',
      priceAppreciation: 0.15,
      meritFactor: 1.5,
      bonusMultiplier: 1.25,
      refresherGrowthFactor: 1,
      refresherYears: 12,
    },
  };
}

/** Default ceiling on the aggressive appreciation assumption. */
export const APPRECIATION_CAP = 0.20;

/**
 * Apply the appreciation cap. Returns both figures so the UI can show
 * the uncapped value alongside the capped one — the cap must be
 * visible, never silent.
 */
export function applyAppreciationCap(rate, cap = APPRECIATION_CAP, enabled = true) {
  const uncapped = rate;
  const capped = enabled && rate > cap ? cap : rate;
  return { uncapped, applied: capped, wasCapped: capped !== uncapped };
}

/* ------------------------------------------------------------------ *
 * Offer defaults
 * ------------------------------------------------------------------ */

export function blankOffer(overrides = {}) {
  return {
    id: overrides.id || `offer-${Math.random().toString(36).slice(2, 9)}`,
    company: 'Company A',
    ticker: '',
    isPrivate: false,
    isBaseline: false,

    startYear: new Date().getFullYear(),

    // Cash
    baseSalary: 200000,
    meritPct: 0.03,
    bonusTargetPct: 0.15,
    bonusBasis: 'current', // 'current' | 'prior'
    bonusInYear1: false,

    // Sign-on
    signOnTotal: 0,
    signOnSchedule: [0.5, 0.5], // by year index, must sum to 1 when total > 0

    // Equity
    grantPrice: 100,
    initialGrantValue: 0,
    initialSchedule: structuredCloneSafe(VEST_PRESETS.even4Annual),

    refresherValue: 0,
    refresherFirstYear: new Date().getFullYear() + 1,
    refresherGrowthPct: 0.03,
    refresherSchedule: structuredCloneSafe(VEST_PRESETS.even4Annual),
    refresherSlots: 12,

    // Annual-granularity vest timing toggle.
    // 0 = first tranche vests in the grant year itself (the original
    //     workbook's convention)
    // 1 = first tranche vests the year after the grant (typical)
    // Ignored for quarterly/monthly schedules, where the cliff and the
    // period index already fix the timing.
    firstVestOffsetYears: 1,

    ...overrides,
  };
}

function structuredCloneSafe(o) {
  return JSON.parse(JSON.stringify(o));
}

/* ------------------------------------------------------------------ *
 * Core: the tranche engine
 * ------------------------------------------------------------------ */

/**
 * Time in years from the grant date to a vest event.
 *
 * Annual: periodIndex 1 with firstVestOffsetYears=1 lands one year
 * after the grant, matching the workbook's INDEX lookup at
 * (calendarYear - grantYear + 1 - offset).
 *
 * Sub-annual: the period index and cliff already express the timing,
 * so the annual offset toggle does not apply.
 */
function vestYearsFromGrant(schedule, event, firstVestOffsetYears) {
  if (schedule.granularity === 'annual') {
    return event.periodIndex - 1 + firstVestOffsetYears;
  }
  return event.periodIndex / PERIODS_PER_YEAR[schedule.granularity];
}

/** Constant-CAGR price path. t is years from the offer's start. */
function priceAt(grantPrice, appreciation, t) {
  return grantPrice * Math.pow(1 + appreciation, t);
}

/**
 * Build the full grant list for an offer under a scenario.
 * Returns [{ kind, label, grantYear, tOffset, value, price, shares }]
 */
export function buildGrants(offer, scenario) {
  const grants = [];
  const appr = scenario.priceAppreciation;

  if (offer.initialGrantValue > 0) {
    const price = priceAt(offer.grantPrice, appr, 0);
    grants.push({
      kind: 'initial',
      label: 'Initial grant',
      grantYear: offer.startYear,
      tOffset: 0,
      value: offer.initialGrantValue,
      price,
      shares: price > 0 ? offer.initialGrantValue / price : 0,
      schedule: offer.initialSchedule,
    });
  }

  const nRefreshers = Math.min(offer.refresherSlots, scenario.refresherYears);
  if (offer.refresherValue > 0 && nRefreshers > 0) {
    const growth = offer.refresherGrowthPct * scenario.refresherGrowthFactor;
    for (let n = 0; n < nRefreshers; n++) {
      const grantYear = offer.refresherFirstYear + n;
      const tOffset = grantYear - offer.startYear;
      const value = offer.refresherValue * Math.pow(1 + growth, n);
      const price = priceAt(offer.grantPrice, appr, tOffset);
      grants.push({
        kind: 'refresher',
        label: `Refresher ${n + 1} (${grantYear})`,
        grantYear,
        tOffset,
        value,
        price,
        shares: price > 0 ? value / price : 0,
        schedule: offer.refresherSchedule,
      });
    }
  }

  return grants;
}

/**
 * Project one offer under one scenario.
 *
 * Returns a full result object including the tranche ledger. Overlapping
 * tranches fall out of the ledger structure; nothing here computes a
 * rolling-window sum. This is the fix for the divisor bugs in the
 * source workbook.
 */
export function projectOffer(offer, scenario, horizonYears = 10) {
  const initVal = validateSchedule(offer.initialSchedule);
  const refVal = validateSchedule(offer.refresherSchedule);
  const errors = [];
  if (offer.initialGrantValue > 0 && !initVal.ok) {
    errors.push(...initVal.errors.map((e) => `Initial grant schedule: ${e}`));
  }
  if (offer.refresherValue > 0 && !refVal.ok) {
    errors.push(...refVal.errors.map((e) => `Refresher schedule: ${e}`));
  }
  if (offer.signOnTotal > 0) {
    const s = offer.signOnSchedule.reduce((a, b) => a + b, 0);
    if (Math.abs(s - 1) > 1e-6) {
      errors.push(
        `Sign-on payout schedule totals ${(s * 100).toFixed(2)}% — it must total 100%.`
      );
    }
  }
  if (errors.length) {
    return { offerId: offer.id, scenario: scenario.key, errors, valid: false };
  }

  const appr = scenario.priceAppreciation;
  const years = [];

  // ---- Cash components, per year index 1..horizon ----
  const salary = [];
  for (let i = 1; i <= horizonYears; i++) {
    salary[i] = offer.baseSalary * Math.pow(1 + offer.meritPct * scenario.meritFactor, i - 1);
  }

  for (let i = 1; i <= horizonYears; i++) {
    const calendarYear = offer.startYear + i - 1;

    const basisSalary =
      offer.bonusBasis === 'prior' ? (i === 1 ? 0 : salary[i - 1]) : salary[i];
    let bonus = basisSalary * offer.bonusTargetPct * scenario.bonusMultiplier;
    if (i === 1 && !offer.bonusInYear1) bonus = 0;

    const signOn =
      offer.signOnTotal * (offer.signOnSchedule[i - 1] !== undefined ? offer.signOnSchedule[i - 1] : 0);

    years[i] = {
      yearIndex: i,
      calendarYear,
      sharePrice: r2(priceAt(offer.grantPrice, appr, i - 1)),
      baseSalaryCents: toCents(salary[i]),
      bonusCents: toCents(bonus),
      signOnCents: toCents(signOn),
      initialVestCents: 0,
      refresherVestCents: 0,
      concurrentGrants: 0,
    };
  }

  // ---- Tranche ledger ----
  const grants = buildGrants(offer, scenario);
  const ledger = [];
  let unvestedShares = 0;
  let vestedShares = 0;

  const horizonEndT = horizonYears - 1; // t of the final modelled year

  for (const g of grants) {
    const sched = g.schedule;
    const contributes = new Set();
    for (const ev of sched.events) {
      const dt = vestYearsFromGrant(sched, ev, offer.firstVestOffsetYears);
      const tTotal = g.tOffset + dt;
      const vestCalendarYear = offer.startYear + Math.floor(tTotal);
      const yearIndex = Math.floor(tTotal) + 1;
      const shares = g.shares * ev.percent;
      const price = priceAt(offer.grantPrice, appr, tTotal);
      const valueCents = toCents(shares * price);

      const withinHorizon = yearIndex >= 1 && yearIndex <= horizonYears;

      ledger.push({
        grantKind: g.kind,
        grantLabel: g.label,
        grantYear: g.grantYear,
        grantValue: r2(g.value),
        grantPrice: r2(g.price),
        grantShares: g.shares,
        vestYearIndex: yearIndex,
        vestCalendarYear,
        vestFractionalYear: r2(tTotal),
        vestPercent: ev.percent,
        shares,
        priceUsed: r2(price),
        valueCents,
        value: fromCents(valueCents),
        withinHorizon,
      });

      if (withinHorizon) {
        vestedShares += shares;
        if (g.kind === 'initial') years[yearIndex].initialVestCents += valueCents;
        else years[yearIndex].refresherVestCents += valueCents;
        if (valueCents > 0) contributes.add(yearIndex);
      } else {
        unvestedShares += shares;
      }
    }
    for (const yi of contributes) years[yi].concurrentGrants += 1;
  }

  // ---- Totals ----
  let cumulative = 0;
  const rows = [];
  for (let i = 1; i <= horizonYears; i++) {
    const y = years[i];
    const equityCents = y.initialVestCents + y.refresherVestCents;
    const totalCents = y.baseSalaryCents + y.bonusCents + y.signOnCents + equityCents;
    cumulative += totalCents;
    rows.push({
      yearIndex: i,
      calendarYear: y.calendarYear,
      sharePrice: y.sharePrice,
      baseSalary: fromCents(y.baseSalaryCents),
      bonus: fromCents(y.bonusCents),
      signOn: fromCents(y.signOnCents),
      initialVest: fromCents(y.initialVestCents),
      refresherVest: fromCents(y.refresherVestCents),
      equityVest: fromCents(equityCents),
      total: fromCents(totalCents),
      cumulative: fromCents(cumulative),
      concurrentGrants: y.concurrentGrants,
    });
  }

  const horizonPrice = priceAt(offer.grantPrice, appr, horizonEndT);

  return {
    offerId: offer.id,
    company: offer.company,
    scenario: scenario.key,
    scenarioName: scenario.name,
    valid: true,
    errors: [],
    rows,
    ledger,
    unvestedShares,
    vestedShares,
    unvestedValueAtHorizon: r2(unvestedShares * horizonPrice),
    horizonPrice: r2(horizonPrice),
    cumulativeAt: {
      1: rows[0] ? rows[0].cumulative : 0,
      3: rows[2] ? rows[2].cumulative : 0,
      5: rows[4] ? rows[4].cumulative : 0,
      10: rows[9] ? rows[9].cumulative : 0,
    },
    totalGross: rows.length ? rows[rows.length - 1].cumulative : 0,
  };
}

/** Project one offer under all three scenarios. */
export function projectAllScenarios(offer, scenarios, horizonYears = 10) {
  return {
    conservative: projectOffer(offer, scenarios.conservative, horizonYears),
    medium: projectOffer(offer, scenarios.medium, horizonYears),
    aggressive: projectOffer(offer, scenarios.aggressive, horizonYears),
  };
}

/* ------------------------------------------------------------------ *
 * Comparison
 * ------------------------------------------------------------------ */

/**
 * Align a set of results either by calendar year or by tenure year.
 *
 * Calendar alignment is the honest view when offers start in different
 * years — but it compares a working year against a zero year, which is
 * exactly the defect in the source workbook. Tenure alignment
 * (Year 1 = each offer's own start) is the default.
 */
export function alignSeries(results, mode, horizonYears) {
  if (mode === 'tenure') {
    return results.map((r) => ({
      offerId: r.offerId,
      company: r.company,
      points: r.rows.map((row) => ({ x: row.yearIndex, total: row.total, cumulative: row.cumulative })),
    }));
  }
  // Calendar alignment: build a union of calendar years, zero-fill.
  const allYears = new Set();
  for (const r of results) for (const row of r.rows) allYears.add(row.calendarYear);
  const sorted = [...allYears].sort((a, b) => a - b);
  return results.map((r) => {
    const byYear = new Map(r.rows.map((row) => [row.calendarYear, row]));
    let cum = 0;
    return {
      offerId: r.offerId,
      company: r.company,
      points: sorted.map((y) => {
        const row = byYear.get(y);
        const total = row ? row.total : 0;
        cum += total;
        return { x: y, total, cumulative: r2(cum) };
      }),
    };
  });
}

/**
 * Crossover analysis.
 *
 * Replaces the broken row 41/42 logic in the source workbook, which
 * took LARGE() over a range containing component rows rather than the
 * offer totals.
 *
 * Returns, for each ordered pair (A, B), the first aligned period in
 * which A's cumulative gross exceeds B's — and whether that ordering
 * holds under all three scenarios.
 */
export function crossovers(resultsByScenario, alignment, horizonYears) {
  const scenKeys = ['conservative', 'medium', 'aggressive'];
  const medium = alignSeries(resultsByScenario.medium, alignment, horizonYears);
  const out = [];

  for (let a = 0; a < medium.length; a++) {
    for (let b = 0; b < medium.length; b++) {
      if (a === b) continue;
      const A = medium[a];
      const B = medium[b];

      let crossPeriod = null;
      let leadsFromStart = A.points[0].cumulative > B.points[0].cumulative;
      for (let i = 0; i < Math.min(A.points.length, B.points.length); i++) {
        if (A.points[i].cumulative > B.points[i].cumulative) {
          if (!leadsFromStart || i === 0) {
            crossPeriod = A.points[i].x;
          }
          break;
        }
      }

      // Does the final ordering hold in every scenario?
      let holdsInAll = true;
      for (const k of scenKeys) {
        const s = alignSeries(resultsByScenario[k], alignment, horizonYears);
        const sa = s[a].points[s[a].points.length - 1].cumulative;
        const sb = s[b].points[s[b].points.length - 1].cumulative;
        const finalA = A.points[A.points.length - 1].cumulative;
        const finalB = B.points[B.points.length - 1].cumulative;
        if (finalA > finalB && !(sa > sb)) holdsInAll = false;
        if (finalA < finalB && !(sa < sb)) holdsInAll = false;
      }

      out.push({
        aId: A.offerId,
        aCompany: A.company,
        bId: B.offerId,
        bCompany: B.company,
        crossPeriod,
        leadsFromStart,
        holdsInAllScenarios: holdsInAll,
        finalA: A.points[A.points.length - 1].cumulative,
        finalB: B.points[B.points.length - 1].cumulative,
      });
    }
  }
  return out;
}

/** Leader by aligned period under a given scenario. */
export function leaderByPeriod(results, alignment, horizonYears) {
  const series = alignSeries(results, alignment, horizonYears);
  if (!series.length) return [];
  const n = series[0].points.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    let best = series[0];
    for (const s of series) {
      if (s.points[i].cumulative > best.points[i].cumulative) best = s;
    }
    out.push({
      x: series[0].points[i].x,
      leaderId: best.offerId,
      leaderCompany: best.company,
      cumulative: best.points[i].cumulative,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Serialisation — offers to/from a URL-safe string
 * ------------------------------------------------------------------ */

export function encodeState(state) {
  const json = JSON.stringify(state);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeState(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

# Multi-Offer Compensation Projection Calculator — Build Spec

**Purpose:** Web app that projects 1–10 year gross compensation for multiple job offers
side by side, modeling base salary, annual bonus, sign-on, an initial RSU grant, and
recurring annual RSU refreshers with overlapping vesting tranches, under three
share-price growth scenarios.

**Source of truth for the math:** `Comp_Comparison_Model_v2.xlsx` — a corrected working
model that implements this spec at annual granularity. Build the engine to reproduce it.

**Historical reference:** `10_year_Comp_Comparison_Calc.xlsx`, tab `CompOffer Comparison`.
This is the original model the corrected workbook was derived from. It contains the
defects listed in §2 and must not be ported cell-for-cell. Its one clean refresher row is
preserved as a regression fixture (§4.1).

The corrected workbook's `Validation` tab reproduces that clean row exactly, cell for
cell, and reads TIE across all ten years. Any engine you build must do the same.

---

## 1. What the source spreadsheet actually does

Three offer blocks, each 13 rows, laid out across an `Initial` column plus 15 calendar
year columns (2021–2035):

| Row | Label | Mechanic in the sheet |
|---|---|---|
| Salary | base pay | `=prior * 1.03`, growth rate hardcoded in every formula |
| Sign on | signing bonus | `=$B$5/2` in each of the first two working years |
| Initial Stock Grant | one-time grant | dollar amount × hardcoded vest % per year. Block 1: 40/28/20/12. Block 2: 25/25/25/25. Block 3: 20 × 5 years |
| Annual Stock Refresher | size of each year's new grant | `=prior * 1.03` |
| Annual Stock Award per year | dollars vesting this year from refreshers | hand-typed rolling sum, e.g. `=D7/4+E7/4+F7/4+G7/4` |
| Total Stock | `Initial Stock Grant` + `Annual Stock Award per year` | |
| Annual Bonus | `= salary × bonus target %` (22% in all three blocks) | |
| Total | Salary + Total Stock + Sign on + Annual Bonus | |

Rows 41–42 attempt a "which offer is better / by how much" comparison.

**Verified reference figure (use as a regression test):** Block 1, refresher $150,000
starting 2022 growing 3%/yr, straight 4-year vest → 2025 refresher vesting =
$156,886.01. Independently recomputed and confirmed against cell `G8`.

---

## 2. Defects in the source model — the app must NOT reproduce these

These are the reason the spreadsheet cannot simply be ported cell-for-cell.

1. **No share-price appreciation exists anywhere in the model.** Grants are
   dollar-denominated and vest at their grant-date dollar value, so a $400,000 grant
   pays exactly $400,000 regardless of what the stock does. The 3% growth on the
   refresher row is *grant-size inflation*, not price appreciation. This is the single
   largest gap. The app must convert grant dollars → share count at grant-date price,
   then value each vesting tranche at the projected price on its vest date.

2. **Rolling-refresher formulas have divisor bugs.** Block 2 switches from a `/4`
   divisor to a `/5` divisor mid-row (`F21` vs `G21`). Block 3 (`G34`) sums five
   tranches while still dividing by 4, over-counting that year's refresher income by
   25%. The app replaces hand-typed rolling sums with a generated tranche ledger.

3. **Bonus timing is inconsistent between blocks.** Block 1 pays bonus on the
   *current* year's salary (`D9 = D3 × B13`); Blocks 2 and 3 pay on the *prior* year's
   salary (`G22 = F16 × B26`). The comparison is therefore not apples-to-apples. Make
   this a single explicit global setting.

4. **`How much better?` (row 42) is broken.** `=MAX(B11,B24,B37)-LARGE((B11:B37),2)`
   takes the second-largest value from a range that includes every intermediate
   component row — salary, refresher size, sign-on — not just the three offer totals.
   It returns a difference against an unrelated line item.

5. **Growth rates and vest percentages are hardcoded inside formulas**
   (`*1.03`, `*0.4`), so they cannot be varied as scenario levers.

6. **Bonus is always assumed paid at 100% of target.** No company/individual
   performance multiplier.

7. **Offers start in different calendar years**, so a column-aligned comparison
   compares a working year against a zero year. Comparison must be selectable between
   calendar-year alignment and tenure-year alignment (Year 1 = each offer's own start).

8. **No taxes, no vest-date price, no share-count tracking.**

9. **Vest timing convention is unstated and probably wrong.** The original vests the
   first tranche in the *grant year itself* (`C6 = B6*0.4` in the start year). A real
   new-hire grant normally has its first vest a year after the grant date, or at a
   quarterly cliff. Neither convention is universally right, so it must be an explicit
   input rather than an assumption baked into the formulas.

---

## 3. Required functional scope

### 3.1 Offers
- N offers (minimum 4 supported, UI comfortable to 6), each independently configured.
- One offer may be flagged **Current Compensation** (baseline). Baseline uses the same
  engine — it just typically has no initial grant.
- Offers may have different start dates.

### 3.2 Per-offer inputs

**Cash**
- Base salary at start
- Merit increase % per year (user input, per offer) — replaces the hardcoded 3%
- Optional: merit increase override table by year
- Bonus target % of base
- Bonus performance multiplier (default 1.00) — applied to target
- Bonus basis: current-year base or prior-year base (global setting, §2.3)
- Whether a bonus is paid in the first partial year (default: no)

**Sign-on**
- Total amount, and a payout schedule (default 50/50 over first two years, user-editable
  to any number of installments with percentages summing to 100%)

**Initial equity grant**
- Grant value in dollars **or** share count
- Grant date and grant-date share price (auto-filled from ticker if available, editable)
- **First vest timing** — offset from the grant date to the first vest event. This is a
  required explicit input, not an assumption (see §2.9). At annual granularity it is the
  `0 = vests in grant year / 1 = vests the year after` toggle used in the companion
  workbook; at sub-annual granularity it is the `cliffPeriods` value in §3.3.
- **User-defined vesting schedule** (see §3.3)

**Annual refresher grants**
- Refresher grant value for the first refresher year
- Refresher grant year 1 (which year the first refresher is granted)
- Refresher grant growth % per year (grant-size growth — keep distinct from price
  appreciation in the UI, and label it as such)
- **User-defined vesting schedule** for refreshers (may differ from the initial grant)
- Number of refresher years (default: every year through the projection horizon)

**Company**
- Ticker symbol (used for trailing-performance context and grant-date price)
- Private-company flag → disables market data, requires manual price entry, and disables
  the aggressive scenario's trailing-CAGR anchor

### 3.3 Vesting schedule input (core requirement)

The user must be able to define a vesting schedule explicitly. Model it as an ordered
list of vest events:

```
VestSchedule = {
  granularity: "monthly" | "quarterly" | "annual",
  cliffPeriods: number,          // periods before the first vest
  events: [{ periodIndex: number, percent: number }]
}
```

- Percentages must sum to 100.00% — hard validation, block calculation otherwise.
- Provide presets the user can load and then edit. Presets must be **labeled as user-
  editable templates, not as any named employer's current policy**, since these change:
  - Even 4-year annual: 25/25/25/25
  - Even 4-year quarterly: 6.25% × 16, 1-year cliff
  - Front-loaded 4-year: 40/28/20/12 *(matches Block 1 of the source sheet)*
  - Back-loaded 4-year: 5/15/40/40
  - Even 5-year annual: 20 × 5
  - Custom (blank grid)
- Each grant instance carries its own schedule copy, so refreshers granted in different
  years vest independently.

### 3.4 Tranche engine (this is the heart of the app)

```
for each offer:
  grants = [initialGrant] + [refresherGrant(y) for y in refresherYears]
  for each grant:
    shares = grantValue / grantDatePrice
    for each vestEvent in grant.schedule:
      vestDate   = grant.grantDate + offset(periodIndex, granularity)
      vestShares = shares * vestEvent.percent
      vestValue  = vestShares * projectedPrice(vestDate, scenario)
      → append to ledger
  bucket ledger by calendar year AND by tenure year
```

Requirements:
- **Overlapping tranches must fall out of the ledger naturally.** Do not compute a
  rolling-window sum. In steady state a 4-year schedule with annual refreshers produces
  4 concurrent grants vesting in the same year; the ledger must show each separately.
- Expose a **per-year tranche detail view**: grant year, source (initial / refresher
  year N), shares vesting, price used, dollar value. This is what makes the model
  auditable and is the main thing the spreadsheet cannot show.
- Vests occurring after the projection horizon are excluded from income but reported as
  "unvested equity remaining" per offer — a real decision factor when comparing.

### 3.5 Growth scenarios (conservative / medium / aggressive)

Every projection runs all three scenarios and the UI shows a band.

A scenario is a set of rate assumptions:

| Lever | Conservative | Medium | Aggressive |
|---|---|---|---|
| Share price appreciation %/yr | 0% | user default 7% | trailing 5-yr CAGR of ticker |
| Merit increase %/yr | offer input × 0.5 | offer input | offer input × 1.5 |
| Bonus multiplier | 0.75 | 1.00 | 1.25 |
| Refresher grant growth %/yr | 0% | offer input | offer input |
| Refresher continues? | stops after year 4 | continues | continues |

- **Every one of these values must be user-editable** in a scenario editor. The table
  above is only the seeded default.
- The 7% medium default is a long-run broad-market nominal assumption, not a forecast
  for any specific company. Label it that way in the UI.
- **Mandatory guardrail:** the app must not present trailing CAGR as a prediction.
  Display trailing 1-yr and 5-yr performance as *context*, adjacent to the input, with
  a persistent note that past performance does not indicate future results. Cap the
  aggressive default at a configurable ceiling (suggest 20%/yr) so a hot ticker's
  trailing CAGR does not produce a nonsense 10-year number, and show the uncapped
  figure alongside so the cap is visible rather than silent.
- Constant-CAGR price path by default. Optional stretch: log-normal Monte Carlo using
  trailing volatility, reported as p10/p50/p90 — clearly separated from the deterministic
  scenarios.

### 3.6 Market data

- Fetch on the server, never from the browser (API key protection).
- Needed: current price, price on grant date, trailing 1-yr and 5-yr total return / CAGR
  as of the submission date.
- Candidate providers, all key-based: Polygon.io, Nasdaq Data Link, Financial Modeling
  Prep, Alpha Vantage. Pick one, isolate it behind a `MarketDataProvider` interface so
  it is swappable.
- Cache per ticker per trading day.
- **Every path must degrade to manual entry.** No API key, rate limit hit, private
  company, or unknown ticker → user types the prices and the app still works fully.

### 3.7 Outputs

- Year-by-year table per offer: base, bonus, sign-on, initial-grant vest, refresher
  vest, total gross — for the selected scenario.
- Cumulative gross at years 1, 3, 5, 10.
- Comparison chart: cumulative gross by year, one line per offer, shaded
  conservative→aggressive band for the selected offer.
- **Crossover analysis:** the year each offer overtakes the baseline, and the year any
  offer overtakes any other. Replaces the broken row 41/42 logic. State it as
  "Offer A exceeds Offer B cumulatively in year N under the medium scenario," and
  report whether that ordering holds in all three scenarios.
- Alignment toggle: calendar year vs. tenure year.
- Unvested equity remaining at horizon, per offer.
- Export: CSV of the full tranche ledger, and PDF/print summary.

### 3.8 Explicit non-goals (v1)
- No tax calculation. All figures are **gross**. State this prominently: RSUs are
  ordinary income at vest, at the vest-date price, and the app's numbers are pre-tax.
- No cost-of-living or relocation adjustment.
- No 401(k) match, ESPP, or benefits valuation. (Note: the source workbook contains
  scratch commuting/healthcare cost math around rows 45–53 — out of scope for v1, but
  a "Benefits & Costs" module is a logical v2.)
- The app is a modeling tool, not financial advice. Include that disclaimer.

---

## 4. Suggested implementation

- **Stack:** Next.js (App Router) + TypeScript + Tailwind. Recharts for charts.
  Server route handlers for market data.
- **Money:** integer cents or `decimal.js` throughout. No float accumulation on
  currency.
- **Structure:** put the entire projection engine in a pure, dependency-free module
  (`/lib/engine`) taking a config object and returning a ledger. UI and market data must
  not be able to reach into it. This is what makes it testable.
- **State:** offers serializable to a URL-safe string / JSON import-export, so a
  comparison can be shared or saved.

### 4.1 Required tests

The engine ships with unit tests, including these fixtures from the source workbook:

1. **Refresher steady state — the golden fixture.** Refresher $150,000 first granted in
   year 0, 3%/yr grant growth, even 4-year annual vest, first vest one year after grant,
   0% price appreciation. Refresher vest by year must be:

   | Year | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
   |---|---|---|---|---|---|---|---|---|---|
   | Vest $ | 37,500.00 | 76,125.00 | 115,908.75 | **156,886.01** | 161,592.59 | 166,440.37 | 171,433.58 | 176,576.59 | 181,873.89 |

   This series ties cell-for-cell to `D8:L8` of the original workbook and is reproduced
   by the `Validation` tab of the corrected workbook. Verified independently.
2. **Front-loaded initial grant.** $400,000, 40/28/20/12, 0% appreciation →
   160,000 / 112,000 / 80,000 / 48,000; sum = $400,000.
2b. **Vest timing toggle.** Same grant with the first-vest offset set to "grant year"
   shifts the entire series one year earlier and changes no dollar amounts.
3. **Vest schedule validation.** A schedule summing to 97% or 103% is rejected.
4. **Appreciation.** $400,000 grant, 25/25/25/25, 10%/yr appreciation → tranche values
   rise with the price path; total exceeds $400,000. Confirms the §2.1 defect is fixed.
5. **Overlap count.** Annual refreshers on a 4-year schedule → exactly 4 concurrent
   grants contributing in steady-state years; 5 concurrent is a regression (the
   Block 3 `G34` bug).
6. **Cliff.** 1-year cliff quarterly schedule → zero vest value before the cliff date.
7. **Horizon.** Tranches past the horizon are excluded from income and reported as
   unvested.

### 4.2 Build order

1. Types + vesting schedule model + validation
2. Tranche engine + tests (fixtures above) — no UI yet
3. Scenario layer
4. Single-offer UI and year table
5. Multi-offer comparison, charts, crossover
6. Market data provider + manual-entry fallback
7. Export / share

---

## 5. Open items — provisional answers used in the companion workbook

The corrected workbook had to pick a default for each of these. They are seeded values,
not decisions; confirm or change them.

| Item | Provisional default in the workbook |
|---|---|
| Bonus basis | Current-year base, applied identically to every offer |
| Bonus paid in the first (partial) year | No for offers, Yes for the baseline |
| Baseline merit rate | Same as the offers |
| Projection horizon | 15 years modeled, summarized at years 1 / 3 / 5 / 10 |
| First vest timing | 1 = first vest the year after the grant |
| Refresher grant slots | 12 |
| Monte Carlo | Not included — deterministic three-scenario bands only |

Also unresolved and worth deciding before the build:

- Should the aggressive scenario's appreciation cap be enforced by the engine, or only
  warned about in the UI?
- Should sub-annual (quarterly / monthly) vesting be in v1, or does annual match how
  offers are actually compared in practice?

---

## 6. Companion workbook — structure

`Comp_Comparison_Model_v2.xlsx` implements everything above at annual granularity.

| Tab | Contents |
|---|---|
| `README` | Legend, defect list, limitations |
| `Scenarios` | The three scenarios; every lever editable; ticker-context cells |
| `Offer_1` / `Offer_2` / `Offer_3` | Inputs (rows 4–22), vesting schedules (rows 25–27), three full scenario engines (rows 31 / 76 / 121), scenario summary (row 160) |
| `Current_Comp` | Same template, used as the no-equity baseline |
| `Comparison` | Cumulative gross by scenario at years 1/3/5/10, year-by-year medium table, leader by year, crossover vs. baseline in tenure years |
| `Validation` | Reproduces the original workbook's clean refresher row; reads TIE |

Each offer tab's grant ledger is the tranche engine: one row per grant (initial + 12
refresher slots), with grant year, grant value, and share count in columns S–W, and the
dollar value vesting in each year across columns C–Q. The `Concurrent grants vesting`
diagnostic row counts how many grants contribute in each year — it should reach and hold
the vest-schedule length in steady state, and reaching one more than that is the Block 3
`G34` regression.

The workbook is the reference; the web app extends it with sub-annual vesting, market
data, charts, and export.

# bigtechcalc.com

Multi-offer big tech compensation projection calculator. PEFG, PLLC.

Static site plus one Netlify serverless function. No build step, no framework.

---

## Run it

Module scripts will not load over `file://`, so use a local server:

```bash
cd site && python3 -m http.server 8080
# http://localhost:8080
```

Or with the Netlify CLI, which also runs the market-data function:

```bash
npm i -g netlify-cli
netlify dev
```

## Test it

```bash
node engine-tests/engine.test.mjs        # 79 assertions — spec §4.1 fixtures
node engine-tests/workbook-parity.mjs    # 1,800 cells vs Comp_Comparison_Model_v2.xlsx
node engine-tests/smoke.mjs              # 41 assertions — DOM render + interaction
node engine-tests/export.test.mjs        # 23 assertions — PDF/XLSX/CSV actually parse
node engine-tests/snapshot.mjs           # writes engine-tests/out/snapshot.html
```

`workbook-parity.mjs` needs `/tmp/wb.json`, extracted from the workbook with openpyxl. The
extraction snippet is in the file header.

---

## Architecture

```
site/
  index.html                        calculator + SEO content, all schema markup
  privacy.html  terms.html          AdSense prerequisites — both need counsel review
  css/style.css                     PEFG brand system
  js/engine.js                      pure projection engine. No DOM, no network, no I/O.
  js/app.js                         UI only. Never does arithmetic on comp figures.
  js/export.js                      PDF / XLSX / CSV. Lazy-loaded on click.
  netlify/functions/market-data.js  server-side ticker lookup, key never exposed
  assets/                           12 logo SVGs (6 concepts × light/dark) + favicon
netlify.toml                        headers, caching, www→apex redirect
```

The engine is deliberately isolated. `app.js` reads inputs, calls `projectOffer()`, and paints
the result. That separation is what makes the 1,800-cell parity check against the source
workbook possible.

### What the engine fixes relative to the source workbook

Every defect in `comp-calculator-spec.md` §2 is addressed:

| Defect | Fix |
|---|---|
| No share price appreciation | Grant dollars → shares at grant-date price; each tranche valued at its vest-date price |
| Rolling-refresher divisor bugs (`/4` vs `/5`, `G34`) | Generated tranche ledger, one row per vest event. No rolling-window sums exist in the code |
| Inconsistent bonus timing between blocks | Single explicit `bonusBasis` input per offer |
| Broken `LARGE()` comparison in row 42 | `crossovers()` over offer totals, with a scenario-stability check |
| Hardcoded `*1.03` / `*0.4` | All rates and vest percentages are inputs |
| Bonus always at 100% of target | Scenario `bonusMultiplier` |
| Offers starting in different years | Selectable tenure vs calendar alignment |
| Unstated vest timing convention | `firstVestOffsetYears` is a required explicit input |

Currency is accumulated as integer cents throughout. The golden fixture
(`$156,886.01`) reproduces cell-for-cell.

---

## Deploy

1. Push to a git repo, connect it in Netlify. Publish directory is `site`. No build command.
2. Point `bigtechcalc.com` DNS at Netlify. The `www` → apex 301 is already in `netlify.toml`.
3. Set environment variables in the Netlify UI (never commit these):
   - `MARKET_DATA_PROVIDER` — `fmp` or `alphavantage`
   - `MARKET_DATA_KEY` — your API key
   If unset, the site runs in manual-entry mode and everything still works.
4. Replace `ca-pub-XXXXXXXXXXXXXXXX` in `index.html` with your AdSense publisher ID, and the
   three `data-ad-slot` placeholders with real slot IDs.
5. Generate `assets/og-card.png` (1200×630) and `assets/apple-touch-icon.png` (180×180).
   Both are referenced but not yet created.
6. Submit `sitemap.xml` in Google Search Console.

---

## Ad placement — three units, and why

| Slot | Position | Format | Rationale |
|---|---|---|---|
| A | Sticky right rail, desktop only | 300×600 | Highest RPM position on the page. Zero layout shift, never interrupts the calculator. Collapses to a 280px inline unit below 1080px. |
| B | Between the charts and the detail tables | Responsive auto | A natural reading break. The user has their answer and is deciding whether to go deeper. |
| C | End of the SEO content, before the footer | Responsive auto | Standard end-of-article unit. Anyone who reaches it has finished reading. |

**Deliberately not used:** no ad above the H1, none between input fields, none inside the results
tables, and no auto-ads. Ads above the fold push the tool down, raise CLS, and hurt the page
experience signals that feed rankings — the ad revenue does not cover the ranking cost.

Every slot has a reserved `min-height` in CSS so Cumulative Layout Shift stays near zero when the
AdSense script fills it. Do not remove those heights.

A fourth unit — the AdSense mobile anchor/sticky-bottom format — is worth testing later. It
typically carries the highest mobile RPM and does not consume content space, but it is intrusive
enough that it should be A/B'd against bounce rate rather than switched on blind.

**EEA/UK:** Google requires a certified consent management platform for ads served to those users.
Not included here. Add one before driving European traffic.

---

## SEO

**Implemented on the page**

- `WebApplication`, `Organization` and `FAQPage` JSON-LD. Every schema FAQ also appears as visible
  `<details>` content — schema that does not match visible content is a manual-action risk.
- Single H1, descriptive H2/H3 hierarchy, canonical, OG and Twitter cards.
- ~1,400 words of substantive content below the tool: mechanics, glossary, FAQ. A calculator with
  no content does not rank; the content is what earns the keyword.
- Fonts preconnected, ad script async, export libraries lazy-loaded on click. Nothing heavy blocks
  first paint.
- `robots.txt` and `sitemap.xml`. Shareable comparisons are fragment-encoded, so they never
  generate crawlable duplicate URLs.

**Keyword map for the next pages to build**

The homepage targets the head term. These are the cluster pages, roughly in build order — each one
should be a real page with its own content, not a thin doorway variant:

| Page | Primary target | Intent |
|---|---|---|
| `/rsu-vesting-calculator` | rsu vesting calculator | High volume, directly adjacent |
| `/rsu-refresher-calculator` | rsu refresher, equity refresh | Low competition, high intent, our actual differentiator |
| `/job-offer-comparison-calculator` | compare job offers salary equity | Broad top-of-funnel |
| `/total-compensation-calculator` | total compensation calculator | Head term, hardest |
| `/equity-vesting-schedule-explained` | 4 year vesting cliff, back-loaded vesting | Informational, strong internal-link hub |
| `/rsu-tax-calculator` | rsu tax withholding | Highest commercial intent of the set — but requires actually building tax logic, which v1 explicitly excludes. Do not publish this page until the feature exists. |

**Realistic expectations.** levels.fyi, Blind and Candor hold this SERP with domain authority in
the 70–80 range. Ranking for the head term is a 12–18 month effort. The refresher and
vesting-schedule long-tail is winnable much sooner because almost nobody models overlapping
tranches properly — that gap is the wedge, and it is worth writing the content around.

---

## Monetization — the case against charging

You asked to be challenged on paid downloads. Keep them free. Reasoning:

1. **Willingness to pay is near zero.** The identical numbers are already on screen. A PDF of
   something the user just read for free is not a product.
2. **A paywall inverts the model you described.** AdSense revenue is a function of pageviews.
   Gating the download suppresses the engagement signal, the shares, and the return visits that
   generate those pageviews.
3. **The competition is free.** levels.fyi, Candor and Rora all give tools away. A paywall is the
   fastest way to lose a comparison shopper who has three tabs open.
4. **The download is the conversion event, not the product.** Someone who exports a model is
   deep-funnel. That attention is worth more pointed somewhere else than sold for $9.

**Run the arithmetic before committing to ads as the plan.** Careers and finance content carries
roughly a $10–25 session RPM in the US. At $15 RPM, $1,000/month requires about 67,000 monthly
pageviews. That is a real SEO programme, not a side effect of launching. AdSense is the floor.

**Where the actual money is, in order of expected value:**

1. **Negotiation-service affiliate/referral.** Rora, Levels.fyi Negotiation and similar take a
   percentage of the compensation increase they win. A referral from a user who has just seen that
   Offer B is worth $1.5M more over ten years is the highest-intent lead in this category, by a
   wide margin. Commissions are three figures and up. Worth an outreach email before launch.
2. **Email capture on a genuinely useful asset** — an offer-negotiation checklist, not the
   calculator output. Keep the calculator ungated; gate something additional.
3. **AdSense.** The floor. Set it up, then stop thinking about it.
4. **PEFG funnel.** Weak fit. The audience here is tech employees, not litigators or utilities.
   Do not distort the site trying to force this connection.

If you want to test paid at some point, the only artifact with standalone value is the editable
Excel model with the full tranche ledger — someone who wants to keep modelling offline. Price it
at $9, ship the PDF free, and treat it as an experiment rather than a revenue line.

---

## Known gaps

- `assets/og-card.png` and `assets/apple-touch-icon.png` are referenced but not created.
- Privacy and terms pages are drafts with operator notes marked for removal. Both need review by
  counsel before launch — a disclaimer that has not been reviewed is worth less than one that has.
- No consent management platform. Required for EEA/UK ad serving.
- No analytics package installed. Section 5 of the privacy policy must be completed or deleted
  accordingly.
- Sub-annual vesting is implemented in the engine and exposed in the UI, but the
  `firstVestOffsetYears` toggle applies to annual schedules only, by design.
- No tax calculation anywhere, by design. Do not add one casually — the withholding-versus-marginal
  distinction is where most RSU tax tools go wrong.

## Open decisions from the spec §5

- **Appreciation cap enforcement.** Implemented as engine-enforced with the uncapped figure
  displayed alongside, and the cap itself user-editable and switchable off. This seemed better than
  a warning alone: a silent 10-year compound of a 45% trailing CAGR produces a number that is
  arithmetically valid and practically absurd.
- **Sub-annual vesting in v1.** Included. Quarterly-with-cliff is common enough that leaving it out
  would force users into an approximation on the single input that most affects year-one totals.

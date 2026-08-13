/*
 * bigtechcalc.com — market data endpoint
 *
 * Runs server-side so the API key is never exposed to the browser.
 *
 * Returns: current price, trailing 1-year total return, trailing 5-year
 * CAGR, and an as-of date.
 *
 * DESIGN RULE: every failure path must degrade to manual entry. No API
 * key, rate limit hit, unknown ticker, provider outage — the client
 * catches the error and the user types the price in. The calculator is
 * never blocked on this endpoint.
 *
 * The provider is isolated behind the MarketDataProvider shape below so
 * it can be swapped without touching the client.
 *
 * Environment variables (set in Netlify UI, never committed):
 *   MARKET_DATA_PROVIDER   'fmp' | 'alphavantage'   (default 'fmp')
 *   MARKET_DATA_KEY        your API key
 */

const CACHE_SECONDS = 60 * 60 * 12; // one trading day is plenty
const memCache = new Map();          // survives warm invocations only

/* ---------------------------------------------------------------- */

function cagr(startPrice, endPrice, years) {
  if (!(startPrice > 0) || !(endPrice > 0) || !(years > 0)) return null;
  return Math.pow(endPrice / startPrice, 1 / years) - 1;
}

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------- Provider: FMP -- */

async function fmpProvider(ticker, key) {
  const base = 'https://financialmodelingprep.com/api/v3';

  const quoteRes = await fetch(`${base}/quote/${ticker}?apikey=${key}`);
  if (!quoteRes.ok) throw new Error(`quote HTTP ${quoteRes.status}`);
  const quote = await quoteRes.json();
  if (!Array.isArray(quote) || !quote.length) throw new Error('unknown ticker');
  const price = Number(quote[0].price);
  if (!(price > 0)) throw new Error('no price');

  // Adjusted close series covers splits and dividends, so the CAGR is a
  // total-return figure rather than a price-only one.
  const from = isoDaysAgo(365 * 5 + 10);
  const histRes = await fetch(
    `${base}/historical-price-full/${ticker}?from=${from}&serietype=line&apikey=${key}`);
  let return1y = null, cagr5 = null, asOf = new Date().toISOString().slice(0, 10);

  if (histRes.ok) {
    const hist = await histRes.json();
    const series = (hist.historical || []).slice().reverse(); // oldest first
    if (series.length > 30) {
      const last = series[series.length - 1];
      asOf = last.date;
      const target1 = new Date(last.date); target1.setUTCFullYear(target1.getUTCFullYear() - 1);
      const target5 = new Date(last.date); target5.setUTCFullYear(target5.getUTCFullYear() - 5);
      const nearest = (t) => series.reduce((best, p) =>
        Math.abs(new Date(p.date) - t) < Math.abs(new Date(best.date) - t) ? p : best, series[0]);
      const p1 = nearest(target1), p5 = nearest(target5);
      if (p1 && p1.close > 0) return1y = last.close / p1.close - 1;
      // Only report a 5-year figure if the history actually spans ~5 years.
      const span5 = (new Date(last.date) - new Date(p5.date)) / (365.25 * 864e5);
      if (p5 && p5.close > 0 && span5 > 4.5) cagr5 = cagr(p5.close, last.close, span5);
    }
  }

  return {
    symbol: String(quote[0].symbol || ticker).toUpperCase(),
    name: quote[0].name || null,
    price, return1y, cagr5, asOf, provider: 'fmp',
  };
}

/* ------------------------------------------ Provider: Alpha Vantage */

async function alphaVantageProvider(ticker, key) {
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_MONTHLY_ADJUSTED&symbol=${encodeURIComponent(ticker)}&apikey=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.Note || data.Information) throw new Error('rate limited');
  const series = data['Monthly Adjusted Time Series'];
  if (!series) throw new Error('unknown ticker');

  const dates = Object.keys(series).sort();          // oldest first
  const close = (d) => Number(series[d]['5. adjusted close']);
  const last = dates[dates.length - 1];
  const price = close(last);
  if (!(price > 0)) throw new Error('no price');

  const at = (monthsBack) => {
    const i = dates.length - 1 - monthsBack;
    return i >= 0 ? dates[i] : null;
  };
  const d1 = at(12), d5 = at(60);

  return {
    symbol: String(ticker).toUpperCase(),
    name: null,
    price,
    return1y: d1 ? price / close(d1) - 1 : null,
    cagr5: d5 ? cagr(close(d5), price, 5) : null,
    asOf: last,
    provider: 'alphavantage',
  };
}

const PROVIDERS = { fmp: fmpProvider, alphavantage: alphaVantageProvider };

/* ---------------------------------------------------------------- */

export default async (req) => {
  const url = new URL(req.url);
  const raw = (url.searchParams.get('ticker') || '').trim().toUpperCase();

  // Ticker whitelist by shape. Keeps arbitrary strings out of the
  // upstream URL.
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(raw)) {
    return json({ error: 'invalid ticker' }, 400);
  }

  const key = process.env.MARKET_DATA_KEY;
  if (!key) {
    // Not an error condition — just means the site runs in manual-entry
    // mode. The client already handles this.
    return json({ error: 'market data not configured', manualEntry: true }, 200);
  }

  const cached = memCache.get(raw);
  if (cached && Date.now() - cached.t < CACHE_SECONDS * 1000) {
    return json({ ...cached.v, cached: true }, 200);
  }

  const providerName = (process.env.MARKET_DATA_PROVIDER || 'fmp').toLowerCase();
  const provider = PROVIDERS[providerName];
  if (!provider) return json({ error: 'provider not configured', manualEntry: true }, 200);

  try {
    const value = await provider(raw, key);
    memCache.set(raw, { t: Date.now(), v: value });
    return json(value, 200);
  } catch (e) {
    return json({ error: String(e.message || e), manualEntry: true }, 200);
  }
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // Cache at the CDN edge so repeat lookups of the same ticker cost
      // nothing against the API quota.
      'cache-control': `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`,
    },
  });
}

export const config = { path: '/.netlify/functions/market-data' };

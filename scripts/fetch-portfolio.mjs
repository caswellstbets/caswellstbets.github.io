// Pulls SPCX (stock) and BTC (crypto) price history since a fixed start date
// and writes portfolio.json at the repo root, for the "League Holdings" value
// chart. Runs entirely server-side and needs no API key/signup: Yahoo Finance
// blocks direct browser (CORS) requests but has no such restriction on
// server-to-server calls, and CoinGecko's public endpoints are free/keyless.
// Run by .github/workflows/update-portfolio.yml on a schedule (and by hand via
// "Run workflow" in the GitHub Actions tab).

import { writeFile } from 'node:fs/promises';

// ---- League holdings (edit here if positions change) ----
const SPCX_SHARES = 10.328119;
const BTC_AMOUNT = 0.01283641 + 0.00635733;
const CASH = 9.82;
const START_DATE = '2026-09-10';

const ET_DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
function etDateKey(ms) {
  return ET_DATE_FMT.format(new Date(ms));
}

async function fetchSpcxDaily() {
  const period1 = Math.floor(new Date(`${START_DATE}T00:00:00-04:00`).getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/SPCX?period1=${period1}&period2=${period2}&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; td-parlay-portfolio-bot/1.0)' } });
  if (!res.ok) throw new Error(`Yahoo Finance fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const result = data.chart?.result?.[0];
  if (!result) throw new Error('Yahoo Finance: no result in response');

  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const daily = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null) continue;
    daily.push({ date: etDateKey(timestamps[i] * 1000), close: closes[i], ms: timestamps[i] * 1000 });
  }
  return { daily, currentPrice: result.meta?.regularMarketPrice ?? daily.at(-1)?.close };
}

async function fetchBtcSeries() {
  const from = Math.floor(new Date(`${START_DATE}T00:00:00Z`).getTime() / 1000);
  const to = Math.floor(Date.now() / 1000);
  const url = `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range?vs_currency=usd&from=${from}&to=${to}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const prices = data.prices || []; // [ [ms, price], ... ]

  const currentRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
  const currentData = await currentRes.json();
  const currentPrice = currentData?.bitcoin?.usd ?? prices.at(-1)?.[1];

  return { prices, currentPrice };
}

// Finds the BTC price closest to targetMs (used to align BTC's 24/7 price
// series to SPCX's trading-day closes).
function nearestPrice(prices, targetMs) {
  let best = null;
  let bestDiff = Infinity;
  for (const [ms, price] of prices) {
    const diff = Math.abs(ms - targetMs);
    if (diff < bestDiff) { bestDiff = diff; best = price; }
  }
  return best;
}

async function main() {
  const [{ daily: spcxDaily, currentPrice: spcxCurrent }, { prices: btcPrices, currentPrice: btcCurrent }] =
    await Promise.all([fetchSpcxDaily(), fetchBtcSeries()]);

  if (spcxDaily.length === 0) {
    console.log('No SPCX trading days found; leaving portfolio.json untouched.');
    return;
  }

  const series = spcxDaily.map((day) => {
    // Align to that trading day's ~4pm ET close (20:00 UTC covers EDT; close
    // enough for a daily value chart even across the EST changeover).
    const closeMs = new Date(`${day.date}T20:00:00Z`).getTime();
    const btcPrice = nearestPrice(btcPrices, closeMs);
    const spcxValue = SPCX_SHARES * day.close;
    const btcValue = BTC_AMOUNT * btcPrice;
    return {
      date: day.date,
      spcxPrice: day.close,
      btcPrice,
      spcxValue,
      btcValue,
      total: spcxValue + btcValue + CASH,
    };
  });

  const out = {
    updatedAt: new Date().toISOString(),
    holdings: { spcxShares: SPCX_SHARES, btcAmount: BTC_AMOUNT, cash: CASH },
    current: {
      spcxPrice: spcxCurrent,
      btcPrice: btcCurrent,
      spcxValue: SPCX_SHARES * spcxCurrent,
      btcValue: BTC_AMOUNT * btcCurrent,
      cashValue: CASH,
      total: SPCX_SHARES * spcxCurrent + BTC_AMOUNT * btcCurrent + CASH,
    },
    series,
  };

  await writeFile('portfolio.json', JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote portfolio.json: ${series.length} trading days, total $${out.current.total.toFixed(2)}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

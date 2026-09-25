'use strict';
/* ============================================================================
 *  server/assets.js — traditional-market quotes for the reference panel
 *  (Yahoo Finance public chart endpoint, polled). Crypto assets are streamed
 *  by the exchange adapters.
 * ========================================================================== */
const { getJson } = require('./net');

const HOSTS = ['https://query2.finance.yahoo.com', 'https://query1.finance.yahoo.com'];

async function yahooQuote(symbol) {
  let lastErr;
  for (const h of HOSTS) {
    try {
      const url = `${h}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=7d`;
      const res = await getJson(url, { timeout: 15000 });
      const r = res.chart && res.chart.result && res.chart.result[0];
      if (!r || !r.meta) throw new Error('no result');
      const m = r.meta;
      const price = +m.regularMarketPrice;
      // previous session close = last close of a day before the day of the last market time
      const closes = (r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [];
      const ts = r.timestamp || [];
      const off = m.gmtoffset || 0;
      const day = (t) => Math.floor((t + off) / 86400);
      const mtDay = day(m.regularMarketTime || Date.now() / 1000);
      let prev = 0;
      for (let i = ts.length - 1; i >= 0; i--) { if (closes[i] != null && day(ts[i]) < mtDay) { prev = +closes[i]; break; } }
      if (!(prev > 0)) prev = +(m.previousClose || 0);
      const pct = prev > 0 ? (price / prev - 1) * 100 : null;
      return { price, pct, abs: prev > 0 ? price - prev : null, marketTime: m.regularMarketTime ? m.regularMarketTime * 1000 : null, source: 'yahoo' };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function startAssets(config, engine, log) {
  const list = (config.assets || []).filter(a => a.source === 'yahoo');
  if (!list.length) return { stop: () => {} };
  const timers = [];
  let backoffUntil = 0;
  list.forEach((a, i) => {
    const poll = async () => {
      if (Date.now() < backoffUntil) return;
      try {
        const q = await yahooQuote(a.symbol);
        engine.setAsset(a.label, q);
      } catch (e) {
        if (e.status === 429) { backoffUntil = Date.now() + 5 * 60000; log(`yahoo rate limited, pausing 5 min`); }
        else log(`yahoo ${a.symbol}: ${e.message.slice(0, 80)}`);
      }
    };
    setTimeout(() => { poll(); timers.push(setInterval(poll, 90000)); }, 1500 * i);
  });
  return { stop: () => timers.forEach(clearInterval) };
}

module.exports = { startAssets, yahooQuote };

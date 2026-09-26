'use strict';
/* ============================================================================
 *  server/history.js — bootstrap candle history from every enabled exchange
 * ========================================================================== */
const feeds = require('./feeds');
const LIMITS = { '1m': 1000, '3m': 1000, '5m': 1000, '15m': 1000, '1h': 1000, '4h': 1000, '1d': 400 };

/**
 * Returns { '1m': { ex: [candles] }, '3m': {...}, '5m': {...}, '15m': {...}, '1h': {...}, '4h': {...}, '1d': {...} }
 */
async function loadHistory(config, log) {
  const out = {}; for (const tf of Object.keys(LIMITS)) out[tf] = {};
  const jobs = [];
  for (const [id, exCfg] of Object.entries(config.exchanges || {})) {
    if (!exCfg || !exCfg.enabled || !feeds[id]) continue;
    // timeframes are fetched one after another per exchange (gentle on rate limits); exchanges run in parallel
    jobs.push((async () => {
      for (const tf of Object.keys(LIMITS)) {
        const t0 = Date.now();
        try {
          const rows = await feeds[id].history(exCfg.symbol, tf, LIMITS[tf]);
          if (rows && rows.length) { out[tf][id] = rows; log(`${id} ${tf}: ${rows.length} candles (${Date.now() - t0} ms)`); }
        } catch (e) {
          log(`${id} ${tf}: failed (${e.message.slice(0, 90)})`);
        }
      }
    })());
  }
  await Promise.all(jobs);
  return out;
}

module.exports = { loadHistory, LIMITS };

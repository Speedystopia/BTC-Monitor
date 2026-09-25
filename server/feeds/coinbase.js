'use strict';
/* ============================================================================
 *  Coinbase Exchange (spot BTC-USD): matches + full level2 book (batched),
 *  optional tickers for the assets panel, historical candles.
 * ========================================================================== */
const { ReconnectingWS, getJson } = require('../net');

const WS_URL = 'wss://ws-feed.exchange.coinbase.com';
const REST = 'https://api.exchange.coinbase.com';
const GRAN = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '1d': 86400 }; // no 3m / 4h on Coinbase

/** Parse a feed message. Exported for tests. */
function parse(msg) {
  const m = typeof msg === 'string' ? JSON.parse(msg) : msg;
  switch (m.type) {
    case 'match':
      // "side" is the MAKER side: a sell maker means the taker bought
      return { kind: 'trade', symbol: m.product_id, trade: { price: +m.price, qty: +m.size, side: m.side === 'sell' ? 'buy' : 'sell', ts: Date.parse(m.time) } };
    case 'snapshot':
      return { kind: 'snapshot', symbol: m.product_id, bids: m.bids, asks: m.asks };
    case 'l2update': {
      const bids = [], asks = [];
      for (const [side, p, q] of m.changes) (side === 'buy' ? bids : asks).push([p, q]);
      return { kind: 'delta', symbol: m.product_id, bids, asks };
    }
    case 'ticker':
      return { kind: 'ticker', symbol: m.product_id, price: +m.price, open24h: +m.open_24h };
    case 'error':
      return { kind: 'error', message: m.message + (m.reason ? ' ' + m.reason : '') };
    default: return null;
  }
}

function start(ctx) {
  const { engine, symbol, log } = ctx;
  const id = 'coinbase';
  engine.registerExchange(id, { quote: 'USD' });
  const assetIds = (ctx.assets || []).map(a => a.symbol);
  const conn = new ReconnectingWS({
    name: id, url: WS_URL, staleMs: 45000,
    onStatus: (s, d) => engine.setStatus(id, s === 'connected' ? 'ok' : s, d),
    onOpen: (ws) => {
      const channels = [{ name: 'matches', product_ids: [symbol] }, { name: 'level2_batch', product_ids: [symbol] }, { name: 'heartbeat', product_ids: [symbol] }];
      if (assetIds.length) channels.push({ name: 'ticker', product_ids: assetIds });
      ws.send(JSON.stringify({ type: 'subscribe', channels }));
    },
    onMessage: (raw) => {
      const p = parse(raw); if (!p) return;
      if (p.kind === 'trade' && p.symbol === symbol) engine.onTrade(id, p.trade);
      else if (p.kind === 'snapshot' && p.symbol === symbol) { engine.onBookSnapshot(id, p.bids, p.asks); log(`order book snapshot (${p.bids.length}/${p.asks.length})`); }
      else if (p.kind === 'delta' && p.symbol === symbol) engine.onBookDelta(id, p.bids, p.asks);
      else if (p.kind === 'ticker') {
        const a = (ctx.assets || []).find(x => x.symbol === p.symbol);
        if (a && p.open24h > 0) engine.setAsset(a.label, { price: p.price, pct: (p.price / p.open24h - 1) * 100, abs: p.price - p.open24h, source: 'coinbase' });
      } else if (p.kind === 'error') log('feed error: ' + p.message);
    },
  });
  return { stop: () => conn.close() };
}

/** Historical candles (paged, 300 per request). Oldest first. */
async function history(symbol, tf, limit) {
  const g = GRAN[tf]; if (!g) return [];
  const out = new Map();
  let end = Math.floor(Date.now() / 1000 / g) * g + g;
  const pages = Math.ceil(limit / 300);
  for (let i = 0; i < pages; i++) {
    const start = end - 300 * g;
    const url = `${REST}/products/${symbol}/candles?granularity=${g}&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
    const rows = await getJson(url);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) out.set(r[0] * 1000, { t: r[0] * 1000, o: +r[3], h: +r[2], l: +r[1], c: +r[4], v: +r[5], bv: 0 });
    end = start;
    if (rows.length < 250) break;
  }
  return Array.from(out.values()).sort((a, b) => a.t - b.t);
}

module.exports = { start, history, parse };

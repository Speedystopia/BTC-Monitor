'use strict';
/* ============================================================================
 *  Kraken (spot BTC/USD): WebSocket v2 trades + book, REST OHLC history,
 *  USDT/USD reference rate.
 * ========================================================================== */
const { ReconnectingWS, getJson } = require('../net');

const WS_URL = 'wss://ws.kraken.com/v2';
const REST = 'https://api.kraken.com/0/public';
const INTERVAL = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 }; // no 3m on Kraken
// Kraken sends no delete for a level pushed out of the subscribed depth: the engine truncates the book to it
const BOOK_DEPTH = 1000;

/** Parse a v2 message. Exported for tests. */
function parse(msg) {
  const m = typeof msg === 'string' ? JSON.parse(msg) : msg;
  if (m.channel === 'trade' && Array.isArray(m.data)) {
    return { kind: 'trades', trades: m.data.map(t => ({ symbol: t.symbol, price: +t.price, qty: +t.qty, side: t.side, ts: Date.parse(t.timestamp) })) };
  }
  if (m.channel === 'book' && Array.isArray(m.data)) {
    const d = m.data[0];
    const bids = (d.bids || []).map(x => [x.price, x.qty]), asks = (d.asks || []).map(x => [x.price, x.qty]);
    return { kind: m.type === 'snapshot' ? 'snapshot' : 'delta', symbol: d.symbol, bids, asks };
  }
  if (m.channel === 'ticker' && Array.isArray(m.data)) {
    const d = m.data[0];
    return { kind: 'ticker', symbol: d.symbol, price: +d.last, pct: +d.change_pct };
  }
  if (m.method === 'subscribe' && m.success === false) return { kind: 'error', message: m.error };
  return null;
}

function start(ctx) {
  const { engine, symbol, log } = ctx;
  const id = 'kraken';
  engine.registerExchange(id, { quote: 'USD', bookDepth: BOOK_DEPTH });
  const conn = new ReconnectingWS({
    name: id, url: WS_URL, staleMs: 45000, pingEvery: 25000, pingPayload: JSON.stringify({ method: 'ping' }),
    onStatus: (s, d) => engine.setStatus(id, s === 'connected' ? 'ok' : s, d),
    onOpen: (ws) => {
      ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'trade', symbol: [symbol], snapshot: false } }));
      ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'book', symbol: [symbol], depth: BOOK_DEPTH, snapshot: true } }));
    },
    onMessage: (raw) => {
      const p = parse(raw); if (!p) return;
      if (p.kind === 'trades') { for (const t of p.trades) if (t.symbol === symbol) engine.onTrade(id, t); }
      else if (p.kind === 'snapshot' && p.symbol === symbol) { engine.onBookSnapshot(id, p.bids, p.asks); log(`order book snapshot (${p.bids.length}/${p.asks.length})`); }
      else if (p.kind === 'delta' && p.symbol === symbol) engine.onBookDelta(id, p.bids, p.asks);
      else if (p.kind === 'error') log('subscribe error: ' + p.message);
    },
  });
  return { stop: () => conn.close() };
}

/** Historical OHLC (max 720 most recent candles). Oldest first. */
async function history(symbol, tf, limit) {
  const iv = INTERVAL[tf]; if (!iv) return [];
  const pair = symbol.replace('/', '').replace('BTC', 'XBT');
  const res = await getJson(`${REST}/OHLC?pair=${pair}&interval=${iv}`);
  if (res.error && res.error.length) throw new Error(res.error.join(','));
  const key = Object.keys(res.result).find(k => k !== 'last');
  const rows = res.result[key] || [];
  return rows.slice(-limit).map(r => ({ t: r[0] * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[6], bv: 0 }));
}

/** USDT/USD last price (used for optional USDT normalisation). */
async function usdtRate() {
  const res = await getJson(`${REST}/Ticker?pair=USDTUSD`);
  const key = Object.keys(res.result || {})[0];
  return key ? +res.result[key].c[0] : null;
}

module.exports = { start, history, usdtRate, parse };

'use strict';
/* ============================================================================
 *  Bybit v5 (spot BTCUSDT): public trades + orderbook.200, linear futures
 *  liquidations (allLiquidation), REST kline history.
 * ========================================================================== */
const { ReconnectingWS, getJson } = require('../net');

const WS_SPOT = 'wss://stream.bybit.com/v5/public/spot';
const WS_LINEAR = 'wss://stream.bybit.com/v5/public/linear';
const REST = 'https://api.bybit.com';
const INTERVAL = { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720', '1d': 'D' };

/** Parse a v5 public message. Exported for tests. */
function parse(msg) {
  const m = typeof msg === 'string' ? JSON.parse(msg) : msg;
  const topic = m.topic || '';
  if (topic.startsWith('publicTrade.')) {
    return { kind: 'trades', snapshot: m.type === 'snapshot', trades: (m.data || []).map(t => ({ symbol: t.s, price: +t.p, qty: +t.v, side: t.S === 'Buy' ? 'buy' : 'sell', ts: +t.T })) };
  }
  if (topic.startsWith('orderbook.')) {
    const d = m.data || {};
    return { kind: m.type === 'snapshot' ? 'snapshot' : 'delta', symbol: d.s, bids: d.b || [], asks: d.a || [], u: d.u, seq: d.seq };
  }
  if (topic.startsWith('allLiquidation.') || topic.startsWith('liquidation.')) {
    const arr = Array.isArray(m.data) ? m.data : [m.data];
    // S = position side: "Buy" means a long position was liquidated
    return { kind: 'liquidations', liqs: arr.map(d => ({ symbol: d.s, side: d.S === 'Buy' ? 'long' : 'short', price: +d.p, qty: +d.v, usd: +d.p * +d.v, ts: +d.T })) };
  }
  if (topic.startsWith('tickers.')) {
    const d = m.data || {};
    return { kind: 'ticker', symbol: d.symbol, price: +d.lastPrice, pct: d.price24hPcnt != null ? +d.price24hPcnt * 100 : null };
  }
  if (m.op === 'subscribe' && m.success === false) return { kind: 'error', message: m.ret_msg };
  return null;
}

function start(ctx) {
  const { engine, symbol, log } = ctx;
  const id = 'bybit';
  engine.registerExchange(id, { quote: symbol.endsWith('USDT') ? 'USDT' : 'USD' });
  let bookReady = false;
  const conn = new ReconnectingWS({
    name: id, url: WS_SPOT, staleMs: 45000, pingEvery: 20000, pingPayload: JSON.stringify({ op: 'ping' }),
    onStatus: (s, d) => { engine.setStatus(id, s === 'connected' ? 'ok' : s, d); if (s !== 'connected') bookReady = false; },
    onOpen: (ws) => ws.send(JSON.stringify({ op: 'subscribe', args: [`publicTrade.${symbol}`, `orderbook.200.${symbol}`] })),
    onMessage: (raw) => {
      const p = parse(raw); if (!p) return;
      if (p.kind === 'trades') { for (const t of p.trades) if (t.symbol === symbol) engine.onTrade(id, t); } // note: Bybit tags every trade push as "snapshot"
      else if (p.kind === 'snapshot' && p.symbol === symbol) { engine.onBookSnapshot(id, p.bids, p.asks); bookReady = true; }
      else if (p.kind === 'delta' && p.symbol === symbol) { if (bookReady) engine.onBookDelta(id, p.bids, p.asks); }
      else if (p.kind === 'error') log('subscribe error: ' + p.message);
    },
  });
  return { stop: () => conn.close() };
}

function startLiquidations(ctx) {
  const { engine, log } = ctx;
  const conn = new ReconnectingWS({
    name: 'bybit-linear', url: WS_LINEAR, staleMs: 15 * 60000, pingEvery: 20000, pingPayload: JSON.stringify({ op: 'ping' }),
    onStatus: (s, d) => { if (s === 'error') log(`liquidation stream ${s} ${d || ''}`); },
    onOpen: (ws) => ws.send(JSON.stringify({ op: 'subscribe', args: ['allLiquidation.BTCUSDT'] })),
    onMessage: (raw) => { const p = parse(raw); if (p && p.kind === 'liquidations') for (const l of p.liqs) engine.onLiquidation('bybit', l); },
  });
  return { stop: () => conn.close() };
}

/** Historical klines (max 1000). Oldest first. */
async function history(symbol, tf, limit) {
  const iv = INTERVAL[tf]; if (!iv) return [];
  const res = await getJson(`${REST}/v5/market/kline?category=spot&symbol=${symbol}&interval=${iv}&limit=${Math.min(limit, 1000)}`);
  if (res.retCode !== 0) throw new Error(res.retMsg);
  return (res.result.list || []).map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], bv: 0 })).sort((a, b) => a.t - b.t);
}

module.exports = { start, startLiquidations, history, parse };

'use strict';
/* ============================================================================
 *  OKX v5 (spot BTC-USDT): trades + books (400 levels), swap liquidation
 *  orders, REST candle history.
 * ========================================================================== */
const { ReconnectingWS, getJson } = require('../net');

const WS_URL = 'wss://ws.okx.com:8443/ws/v5/public';
const REST = 'https://www.okx.com';
// daily bars must be UTC aligned like the other exchanges (plain '1D' is UTC+8 on OKX)
const BAR = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6Hutc', '12h': '12Hutc', '1d': '1Dutc' };
// contract values of the BTC perpetual swaps
const CT_VAL = { 'BTC-USDT-SWAP': { btc: 0.01 }, 'BTC-USD-SWAP': { usd: 100 }, 'BTC-USDC-SWAP': { btc: 0.0001 } };

/** Parse a public channel message. Exported for tests. */
function parse(msg) {
  if (msg === 'pong') return null;
  const m = typeof msg === 'string' ? JSON.parse(msg) : msg;
  const ch = m.arg && m.arg.channel;
  if (m.event === 'error') return { kind: 'error', message: m.msg };
  if (!ch || !Array.isArray(m.data)) return null;
  if (ch === 'trades') return { kind: 'trades', trades: m.data.map(t => ({ symbol: t.instId, price: +t.px, qty: +t.sz, side: t.side, ts: +t.ts })) };
  if (ch === 'books' || ch === 'books5') {
    const d = m.data[0];
    const strip = (arr) => (arr || []).map(x => [x[0], x[1]]);
    return { kind: m.action === 'snapshot' || ch === 'books5' ? 'snapshot' : 'delta', symbol: m.arg.instId, bids: strip(d.bids), asks: strip(d.asks) };
  }
  if (ch === 'liquidation-orders') {
    const liqs = [];
    for (const d of m.data) {
      const cv = CT_VAL[d.instId]; if (!cv) continue;
      for (const x of d.details || []) {
        const price = +x.bkPx, sz = +x.sz; if (!(price > 0) || !(sz > 0)) continue;
        const usd = cv.usd ? sz * cv.usd : sz * cv.btc * price;
        let side;
        if (x.posSide === 'long' || x.posSide === 'short') side = x.posSide;
        else side = x.side === 'sell' ? 'long' : 'short'; // net mode: a sell liquidation closes a long
        liqs.push({ symbol: d.instId, side, price, qty: usd / price, usd, ts: +x.ts });
      }
    }
    return { kind: 'liquidations', liqs };
  }
  if (ch === 'tickers') { const d = m.data[0]; return { kind: 'ticker', symbol: d.instId, price: +d.last, pct: d.open24h > 0 ? (+d.last / +d.open24h - 1) * 100 : null }; }
  return null;
}

function start(ctx) {
  const { engine, symbol, log } = ctx;
  const id = 'okx';
  engine.registerExchange(id, { quote: symbol.endsWith('USDT') ? 'USDT' : 'USD' });
  let bookReady = false;
  const conn = new ReconnectingWS({
    name: id, url: WS_URL, staleMs: 45000, pingEvery: 25000, pingPayload: 'ping',
    onStatus: (s, d) => { engine.setStatus(id, s === 'connected' ? 'ok' : s, d); if (s !== 'connected') bookReady = false; },
    onOpen: (ws) => ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'trades', instId: symbol }, { channel: 'books', instId: symbol }] })),
    onMessage: (raw) => {
      const p = parse(raw); if (!p) return;
      if (p.kind === 'trades') { for (const t of p.trades) if (t.symbol === symbol) engine.onTrade(id, t); }
      else if (p.kind === 'snapshot' && p.symbol === symbol) { engine.onBookSnapshot(id, p.bids, p.asks); bookReady = true; }
      else if (p.kind === 'delta' && p.symbol === symbol) { if (bookReady) engine.onBookDelta(id, p.bids, p.asks); }
      else if (p.kind === 'error') log('feed error: ' + p.message);
    },
  });
  return { stop: () => conn.close() };
}

function startLiquidations(ctx) {
  const { engine, log } = ctx;
  const conn = new ReconnectingWS({
    name: 'okx-liq', url: WS_URL, staleMs: 15 * 60000, pingEvery: 25000, pingPayload: 'ping',
    onStatus: (s, d) => { if (s === 'error') log(`liquidation stream ${s} ${d || ''}`); },
    onOpen: (ws) => ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'liquidation-orders', instType: 'SWAP' }] })),
    onMessage: (raw) => { const p = parse(raw); if (p && p.kind === 'liquidations') for (const l of p.liqs) engine.onLiquidation('okx', l); },
  });
  return { stop: () => conn.close() };
}

/** Exchange clock (ms). */
async function serverTime() { const res = await getJson(`${REST}/api/v5/public/time`); if (res.code !== '0') throw new Error(res.msg); return +res.data[0].ts; }

/** Historical candles (max 300 per request). Oldest first. */
async function history(symbol, tf, limit) {
  const bar = BAR[tf]; if (!bar) return [];
  const res = await getJson(`${REST}/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=${Math.min(limit, 300)}`);
  if (res.code !== '0') throw new Error(res.msg);
  return (res.data || []).map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], bv: 0 })).sort((a, b) => a.t - b.t);
}

module.exports = { start, startLiquidations, history, serverTime, parse };

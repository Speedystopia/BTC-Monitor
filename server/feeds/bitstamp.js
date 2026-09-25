'use strict';
/* ============================================================================
 *  Bitstamp (spot btcusd): live trades + top-100 order book snapshots,
 *  REST OHLC history.
 * ========================================================================== */
const { ReconnectingWS, getJson } = require('../net');

const WS_URL = 'wss://ws.bitstamp.net';
const REST = 'https://www.bitstamp.net/api/v2';
const STEP = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '12h': 43200, '1d': 86400 };

/** Parse a message. Exported for tests. */
function parse(msg) {
  const m = typeof msg === 'string' ? JSON.parse(msg) : msg;
  const ch = m.channel || '';
  if (m.event === 'trade' && ch.startsWith('live_trades_')) {
    const d = m.data;
    return { kind: 'trade', symbol: ch.slice('live_trades_'.length), trade: { price: +d.price, qty: +d.amount, side: d.type === 0 ? 'buy' : 'sell', ts: +d.microtimestamp / 1000 } };
  }
  if (m.event === 'data' && ch.startsWith('order_book_')) {
    return { kind: 'snapshot', symbol: ch.slice('order_book_'.length), bids: m.data.bids, asks: m.data.asks };
  }
  if (m.event === 'bts:request_reconnect') return { kind: 'reconnect' };
  return null;
}

function start(ctx) {
  const { engine, symbol, log } = ctx;
  const id = 'bitstamp';
  engine.registerExchange(id, { quote: 'USD' });
  const conn = new ReconnectingWS({
    name: id, url: WS_URL, staleMs: 60000, pingEvery: 30000, pingPayload: JSON.stringify({ event: 'bts:heartbeat' }),
    onStatus: (s, d) => engine.setStatus(id, s === 'connected' ? 'ok' : s, d),
    onOpen: (ws) => {
      ws.send(JSON.stringify({ event: 'bts:subscribe', data: { channel: `live_trades_${symbol}` } }));
      ws.send(JSON.stringify({ event: 'bts:subscribe', data: { channel: `order_book_${symbol}` } }));
    },
    onMessage: (raw) => {
      const p = parse(raw); if (!p) return;
      if (p.kind === 'trade' && p.symbol === symbol) engine.onTrade(id, p.trade);
      else if (p.kind === 'snapshot' && p.symbol === symbol) engine.onBookSnapshot(id, p.bids, p.asks);
      else if (p.kind === 'reconnect') { log('server requested reconnect'); conn.reconnect(); }
    },
  });
  return { stop: () => conn.close() };
}

/** Historical OHLC (max 1000). Oldest first. */
async function history(symbol, tf, limit) {
  const step = STEP[tf]; if (!step) return [];
  const res = await getJson(`${REST}/ohlc/${symbol}/?step=${step}&limit=${Math.min(limit, 1000)}`);
  return ((res.data && res.data.ohlc) || []).map(r => ({ t: +r.timestamp * 1000, o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume, bv: 0 })).sort((a, b) => a.t - b.t);
}

module.exports = { start, history, parse };

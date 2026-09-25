'use strict';
/* ============================================================================
 *  Binance spot market data (trades, full order book) + assets tickers.
 *  Uses the "market data only" endpoints (data-stream.binance.vision /
 *  data-api.binance.vision) which are available worldwide, with a fallback to
 *  the main domain.
 * ========================================================================== */
const { ReconnectingWS, getJson } = require('../net');

const WS_HOSTS = ['wss://data-stream.binance.vision', 'wss://stream.binance.com:9443'];
const REST_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];

async function rest(path) {
  let lastErr;
  for (const h of REST_HOSTS) {
    try { return await getJson(h + path); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/** Parse messages of the combined stream. Exported for tests. */
function parse(msg) {
  const m = typeof msg === 'string' ? JSON.parse(msg) : msg;
  const d = m.data || m; const stream = m.stream || '';
  if (!d || !d.e) return null;
  if (d.e === 'trade') return { kind: 'trade', symbol: d.s, trade: { price: +d.p, qty: +d.q, side: d.m ? 'sell' : 'buy', ts: d.T } };
  if (d.e === 'depthUpdate') return { kind: 'depth', symbol: d.s, U: d.U, u: d.u, bids: d.b, asks: d.a };
  if (d.e === '24hrTicker') return { kind: 'ticker', symbol: d.s, price: +d.c, pct: +d.P, abs: +d.p };
  if (d.e === 'forceOrder') {
    const o = d.o; const qty = +(o.z || 0) > 0 ? +o.z : +o.q; const price = +(o.ap || o.p);
    return { kind: 'liquidation', symbol: o.s, liq: { side: o.S === 'SELL' ? 'long' : 'short', price, qty, usd: qty * price, ts: o.T, stream } };
  }
  return null;
}

function start(ctx) {
  const { engine, symbol, log } = ctx;
  const id = 'binance';
  const sym = symbol.toLowerCase();
  engine.registerExchange(id, { quote: symbol.endsWith('USDT') ? 'USDT' : 'USD' });
  const tickerSymbols = (ctx.assets || []).map(a => a.symbol.toLowerCase());
  const streams = [`${sym}@trade`, `${sym}@depth@100ms`].concat(tickerSymbols.map(s => `${s}@ticker`));

  // ---- order book synchronisation state
  let buffer = []; let lastU = null; let synced = false; let syncing = false; let hostIdx = 0;

  async function resync() {
    if (syncing) return; syncing = true; synced = false; buffer = [];
    try {
      const snap = await rest(`/api/v3/depth?symbol=${symbol}&limit=5000`);
      const lastUpdateId = snap.lastUpdateId;
      engine.onBookSnapshot(id, snap.bids, snap.asks);
      // apply buffered diffs
      let applied = false;
      for (const ev of buffer) {
        if (ev.u <= lastUpdateId) continue;
        if (!applied) { if (ev.U > lastUpdateId + 1) { log('depth buffer gap, resyncing later'); buffer = []; syncing = false; return setTimeout(resync, 2000); } applied = true; }
        engine.onBookDelta(id, ev.bids, ev.asks); lastU = ev.u;
      }
      if (!applied) lastU = lastUpdateId;
      synced = true; buffer = [];
      log(`order book synced (${snap.bids.length} bids / ${snap.asks.length} asks)`);
    } catch (e) {
      log('depth snapshot failed: ' + e.message);
      setTimeout(resync, 5000);
    } finally { syncing = false; }
  }

  const conn = new ReconnectingWS({
    name: id,
    url: `${WS_HOSTS[hostIdx]}/stream?streams=${streams.join('/')}`,
    staleMs: 30000,
    onStatus: (s, d) => { engine.setStatus(id, s === 'connected' ? 'ok' : s, d); if (s === 'connected') { lastU = null; resync(); } if (s === 'error' && /451|403/.test(d || '')) { hostIdx = (hostIdx + 1) % WS_HOSTS.length; conn.o.url = `${WS_HOSTS[hostIdx]}/stream?streams=${streams.join('/')}`; } },
    onMessage: (raw) => {
      const p = parse(raw); if (!p) return;
      if (p.kind === 'trade' && p.symbol === symbol) engine.onTrade(id, p.trade);
      else if (p.kind === 'depth' && p.symbol === symbol) {
        if (!synced) { buffer.push(p); if (buffer.length > 5000) buffer.shift(); return; }
        if (lastU != null && p.U !== lastU + 1) { log(`depth sequence gap (${lastU} -> ${p.U}), resyncing`); return resync(); }
        engine.onBookDelta(id, p.bids, p.asks); lastU = p.u;
      } else if (p.kind === 'ticker') {
        const a = (ctx.assets || []).find(x => x.symbol.toUpperCase() === p.symbol);
        if (a) engine.setAsset(a.label, { price: p.price, pct: p.pct, abs: p.abs, source: 'binance' });
      }
    },
  });
  return { stop: () => conn.close() };
}

/** Binance USDT-M + COIN-M futures force orders (liquidations). */
function startLiquidations(ctx) {
  const { engine, log } = ctx;
  const id = 'binance';
  const usdtm = new ReconnectingWS({
    name: 'binance-fut', url: 'wss://fstream.binance.com/stream?streams=btcusdt@forceOrder', staleMs: 15 * 60000,
    onStatus: (s, d) => { if (s === 'error' || s === 'disconnected') log(`futures stream ${s} ${d || ''}`); },
    onMessage: (raw) => { const p = parse(raw); if (p && p.kind === 'liquidation') engine.onLiquidation(id, p.liq); },
  });
  const coinm = new ReconnectingWS({
    name: 'binance-dapi', url: 'wss://dstream.binance.com/stream?streams=btcusd_perp@forceOrder', staleMs: 15 * 60000,
    onStatus: () => {},
    onMessage: (raw) => {
      const p = parse(raw); if (!p || p.kind !== 'liquidation') return;
      // COIN-M contracts: 1 contract = 100 USD
      const usd = p.liq.qty * 100; engine.onLiquidation(id, { side: p.liq.side, price: p.liq.price, qty: usd / p.liq.price, usd, ts: p.liq.ts });
    },
  });
  return { stop: () => { usdtm.close(); coinm.close(); } };
}

/** Exchange clock (ms), used to correct a computer clock that is off. */
async function serverTime() { return +(await rest('/api/v3/time')).serverTime; }

/** Historical klines: returns [{t,o,h,l,c,v,bv}] oldest first. */
async function history(symbol, tf, limit) {
  const rows = await rest(`/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${Math.min(limit, 1000)}`);
  return rows.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], bv: +r[9] }));
}

module.exports = { start, startLiquidations, history, serverTime, parse, tickers: true }; // tickers: can stream config.assets

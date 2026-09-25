/* ============================================================================
 *  core/sim.js — synthetic market generator (Node + browser).
 *  Drives an Engine with realistic-looking trades, books, liquidations,
 *  tickers and calendar events when no live feed is available.
 * ========================================================================== */
(function (root, factory) {
  const deps = (typeof module !== 'undefined' && module.exports)
    ? { C: require('./candles') } : { C: root.BTCM.candles };
  const mod = factory(deps.C);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else { root.BTCM = root.BTCM || {}; root.BTCM.sim = mod; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';

  // deterministic PRNG (mulberry32) so demo runs are reproducible
  function rng(seed) { let a = seed >>> 0; return function () { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  /** Generate a 1-minute price path ending near `endPrice` at `endTime`. */
  function generateMinutes(minutes, endPrice, endTime, seed) {
    const r = rng(seed || 42);
    const path = new Float64Array(minutes);
    let p = 1, vol = 0.0006, drift = 0;
    for (let i = 0; i < minutes; i++) {
      if (i % 720 === 0) { drift = (r() - 0.5) * 0.00012; vol = 0.0003 + r() * 0.0008; }
      if (r() < 0.002) p *= 1 + (r() - 0.5) * 0.02; // occasional shock
      p *= 1 + drift + vol * gauss(r);
      path[i] = p;
    }
    const scale = endPrice / path[minutes - 1];
    const startT = C.bucket(endTime, C.MIN) - (minutes - 1) * C.MIN;
    const candles = [];
    for (let i = 0; i < minutes; i++) {
      const c = path[i] * scale, o = i ? path[i - 1] * scale : c;
      const wick = Math.abs(c - o) * 0.6 + c * 0.00025 * r();
      const v = 4 + r() * 12 + (i > minutes - 200 ? 6 : 0);
      candles.push({ t: startT + i * C.MIN, o, h: Math.max(o, c) + wick * r(), l: Math.min(o, c) - wick * r(), c, v, bv: v * (0.4 + 0.2 * r()) });
    }
    return candles;
  }

  class Simulator {
    constructor(engine, opts) {
      this.engine = engine; this.o = Object.assign({ price: 78600, seed: 7, exchanges: ['binance', 'coinbase', 'kraken', 'bybit'], assets: [] }, opts || {});
      this.r = rng(this.o.seed + 1); this.timers = []; this.price = this.o.price; this.vol = 0.00025; this.drift = 0; this.books = {};
      engine.mode = 'sim';
    }
    seed() {
      const now = this.engine.now();
      const m1 = generateMinutes(400 * 1440, this.o.price, now, this.o.seed);
      const hist = { '1m': m1.slice(-1000) };
      for (const tf of ['3m', '5m', '15m', '1h', '4h']) hist[tf] = C.aggregate(m1, C.TIMEFRAMES[tf]).slice(-1000);
      hist['1d'] = C.aggregate(m1, C.TIMEFRAMES['1d']).slice(-400);
      this.price = m1[m1.length - 1].c;
      this.engine.seedHistory(hist);
    }
    start() {
      const E = this.engine, r = this.r;
      for (const id of this.o.exchanges) { E.registerExchange(id); E.setStatus(id, 'ok', 'simulated'); this.initBook(id); }
      // price process + trades, 10x per second
      this.timers.push(setInterval(() => {
        if (r() < 0.004) { this.drift = (r() - 0.5) * 0.000012; this.vol = 0.00002 + r() * 0.00003; }
        if (r() < 0.0008) this.price *= 1 + (r() - 0.5) * 0.004;
        this.price *= 1 + this.drift + this.vol * gauss(r);
        for (const id of this.o.exchanges) {
          const n = r() < 0.7 ? 1 : 2 + Math.floor(r() * 3);
          for (let i = 0; i < n; i++) {
            const px = this.price * (1 + (r() - 0.5) * 0.0002);
            let qty = Math.exp(gauss(r) * 1.2 - 5.5); // lognormal, median ~0.004 BTC
            if (r() < 0.004) qty = 0.7 + r() * 3;       // whale trade
            E.onTrade(id, { price: px, qty, side: r() < 0.5 + this.drift * 4000 ? 'buy' : 'sell', ts: E.now() });
          }
        }
      }, 100));
      // order books: drift levels with the price, add/remove walls
      this.timers.push(setInterval(() => { for (const id of this.o.exchanges) this.updateBook(id); }, 400));
      // liquidations
      this.timers.push(setInterval(() => {
        if (r() < 0.25 + Math.abs(this.drift) * 3000) {
          const usd = Math.exp(gauss(r) * 1.1 + 8.6); // median ~5.4k
          const side = (this.drift < 0 ? r() < 0.65 : r() < 0.35) ? 'long' : 'short';
          E.onLiquidation(this.o.exchanges[Math.floor(r() * this.o.exchanges.length)], { side, price: this.price, qty: usd / this.price, usd, ts: E.now() });
        }
      }, 1500));
      // assets
      const assets = { ETHUSD: [2520, 1.8], GOLD: [4301, -1.05], XRPUSD: [1.412, 5.3], SP500: [7644, -0.27], SOLUSD: [102.5, 2.7], DXY: [99.47, 0.39] };
      const labels = this.o.assets.length ? this.o.assets : Object.keys(assets);
      const state = {}; for (const l of labels) state[l] = assets[l] ? { price: assets[l][0], pct: assets[l][1] } : { price: 100, pct: 0 };
      const pushAssets = () => { for (const l of labels) { const s = state[l]; const ch = gauss(r) * 0.0004; s.price *= 1 + ch; s.pct += ch * 100; E.setAsset(l, { price: s.price, pct: s.pct, source: 'sim' }); } };
      pushAssets(); this.timers.push(setInterval(pushAssets, 3000));
      // calendar
      const now = E.now();
      E.setCalendar([
        { time: now + 8 * 3600000 + 25 * 60000, country: 'CNY', flag: '🇨🇳', title: 'Industrial Production y/y', impact: 'Medium', source: 'sim' },
        { time: now + 26 * 3600000, country: 'USD', flag: '🇺🇸', title: 'Retail Sales m/m', impact: 'High', source: 'sim' },
        { time: now + 50 * 3600000, country: 'EUR', flag: '🇪🇺', title: 'ECB Press Conference', impact: 'High', source: 'sim' },
        { time: now + 74 * 3600000, country: 'USD', flag: '🇺🇸', title: 'FOMC Statement', impact: 'High', source: 'sim' },
      ]);
    }
    initBook(id) {
      const r = this.r; const bids = [], asks = []; const p = this.price;
      for (let i = 1; i <= 400; i++) { bids.push([Math.round((p - i) * 10) / 10, 0.05 + r() * 1.2]); asks.push([Math.round((p + i) * 10) / 10, 0.05 + r() * 1.2]); }
      this.books[id] = { bids: new Map(bids), asks: new Map(asks), walls: [] };
      this.engine.onBookSnapshot(id, bids, asks);
    }
    updateBook(id) {
      const r = this.r, b = this.books[id], p = this.price; const dB = [], dA = [];
      // keep the book centered: drop crossed levels, add new far levels
      for (const [px] of b.bids) if (px >= p) { b.bids.delete(px); dB.push([px, 0]); }
      for (const [px] of b.asks) if (px <= p) { b.asks.delete(px); dA.push([px, 0]); }
      for (let i = 0; i < 12; i++) {
        const bp = Math.round((p - 1 - r() * 300) * 10) / 10, ap = Math.round((p + 1 + r() * 300) * 10) / 10;
        const bq = 0.05 + r() * 1.2, aq = 0.05 + r() * 1.2;
        b.bids.set(bp, bq); dB.push([bp, bq]); b.asks.set(ap, aq); dA.push([ap, aq]);
      }
      // walls: place (>= $100k) and pull later
      if (r() < 0.08) {
        const side = r() < 0.5 ? 'bid' : 'ask';
        const px = Math.round((side === 'bid' ? p - 15 - r() * 250 : p + 15 + r() * 250) * 10) / 10;
        const qty = (100000 + r() * 600000) / p;
        const m = side === 'bid' ? b.bids : b.asks; const q = (m.get(px) || 0) + qty; m.set(px, q); (side === 'bid' ? dB : dA).push([px, q]);
        b.walls.push({ side, px, qty, until: this.engine.now() + 20000 + r() * 240000 });
      }
      const now = this.engine.now();
      b.walls = b.walls.filter(w => { if (w.until > now) return true; const m = w.side === 'bid' ? b.bids : b.asks; const q = Math.max(0, (m.get(w.px) || 0) - w.qty); if (q > 0) m.set(w.px, q); else m.delete(w.px); (w.side === 'bid' ? dB : dA).push([w.px, q]); return false; });
      this.engine.onBookDelta(id, dB, dA);
    }
    stop() { this.timers.forEach(clearInterval); this.timers = []; }
  }

  return { Simulator, generateMinutes, rng };
});

/* ============================================================================
 *  core/candles.js — timeframes, candle series, composite (multi-exchange) merge
 * ========================================================================== */
module.exports = (function () {
  'use strict';

  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  /** All timeframes handled by the engine (scanner + chart). */
  const TIMEFRAMES = {
    '1m': MIN, '2m': 2 * MIN, '3m': 3 * MIN, '5m': 5 * MIN, '10m': 10 * MIN, '15m': 15 * MIN, '30m': 30 * MIN,
    '1h': HOUR, '2h': 2 * HOUR, '4h': 4 * HOUR, '6h': 6 * HOUR, '8h': 8 * HOUR, '12h': 12 * HOUR, '1d': DAY,
  };
  /** Timeframes fetched from the exchanges' REST history (largest first). */
  const BASE_TFS = ['1d', '4h', '1h', '15m', '5m', '3m', '1m'];
  /** Timeframes that can be opened as a chart page. */
  const CHART_TFS = ['1m', '3m', '5m', '15m', '1h', '4h', '8h', '12h', '1d'];
  const SCANNER_ORDER = ['1m', '2m', '3m', '5m', '10m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];

  /** Pick the deepest available base series that divides `tf` evenly (all bases are UTC aligned). */
  function baseFor(tf, available) {
    const ms = TIMEFRAMES[tf];
    for (const b of BASE_TFS) { if (available[b] && available[b].length && ms % TIMEFRAMES[b] === 0) return b; }
    return null;
  }

  function bucket(ts, tfMs) { return Math.floor(ts / tfMs) * tfMs; }

  /** Aggregate a sorted array of smaller candles into a larger timeframe. */
  function aggregate(candles, tfMs) {
    const out = [];
    let cur = null;
    for (const c of candles) {
      const t = bucket(c.t, tfMs);
      if (!cur || cur.t !== t) {
        if (cur) out.push(cur);
        cur = { t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0, bv: c.bv || 0 };
      } else {
        cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l); cur.c = c.c;
        cur.v += c.v || 0; cur.bv += c.bv || 0;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  /**
   * Merge per-exchange candle arrays (same timeframe) into one composite series.
   * OHLC are volume-weighted averages across the exchanges that have the candle;
   * volume is the sum. Input: { exchangeId: [candles] }.
   */
  function composite(byExchange) {
    const map = new Map();
    for (const ex of Object.keys(byExchange)) {
      const arr = byExchange[ex];
      if (!Array.isArray(arr)) continue;
      for (const c of arr) {
        if (!c || !isFinite(c.o) || !isFinite(c.c) || c.c <= 0) continue;
        let slot = map.get(c.t);
        if (!slot) { slot = { t: c.t, items: [] }; map.set(c.t, slot); }
        slot.items.push(c);
      }
    }
    const times = Array.from(map.keys()).sort((a, b) => a - b);
    const out = [];
    for (const t of times) {
      const items = map.get(t).items;
      let wsum = 0, o = 0, h = 0, l = 0, cl = 0, v = 0, bv = 0;
      const allZero = items.every(c => !(c.v > 0));
      for (const c of items) {
        const w = allZero ? 1 : (c.v > 0 ? c.v : 0);
        wsum += w; o += c.o * w; h += c.h * w; l += c.l * w; cl += c.c * w; v += c.v || 0; bv += c.bv || 0;
      }
      if (wsum <= 0) continue;
      out.push({ t, o: o / wsum, h: h / wsum, l: l / wsum, c: cl / wsum, v, bv, n: items.length });
    }
    return out;
  }

  /** Fill missing buckets with flat candles so series are contiguous. */
  function fillGaps(candles, tfMs) {
    if (candles.length < 2) return candles.slice();
    const out = [candles[0]];
    for (let i = 1; i < candles.length; i++) {
      let prev = out[out.length - 1];
      let expected = prev.t + tfMs;
      let guard = 0;
      while (candles[i].t > expected && guard++ < 5000) {
        out.push({ t: expected, o: prev.c, h: prev.c, l: prev.c, c: prev.c, v: 0, bv: 0, gap: true });
        prev = out[out.length - 1];
        expected = prev.t + tfMs;
      }
      out.push(candles[i]);
    }
    return out;
  }

  /**
   * A live candle series for one timeframe. Seeded from history, then updated by
   * index-price ticks and trade volume.
   */
  class CandleSeries {
    constructor(tf, maxLen) {
      this.tf = tf; this.tfMs = TIMEFRAMES[tf]; this.maxLen = maxLen || 1500;
      this.candles = [];
    }
    seed(candles) {
      const clean = candles.filter(c => c && isFinite(c.c)).sort((a, b) => a.t - b.t);
      // drop duplicates (keep last)
      const dedup = [];
      for (const c of clean) {
        if (dedup.length && dedup[dedup.length - 1].t === c.t) dedup[dedup.length - 1] = c; else dedup.push(c);
      }
      this.candles = fillGaps(dedup, this.tfMs).map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0, bv: c.bv || 0 }));
      this.trim();
    }
    trim() { if (this.candles.length > this.maxLen) this.candles.splice(0, this.candles.length - this.maxLen); }
    get last() { return this.candles[this.candles.length - 1] || null; }
    /** Roll the series forward to the bucket containing `now`; returns closed candles (usually 0 or 1). */
    roll(now, price) {
      const t = bucket(now, this.tfMs);
      const closed = [];
      let last = this.last;
      if (!last) {
        if (!(price > 0)) return closed;
        this.candles.push({ t, o: price, h: price, l: price, c: price, v: 0, bv: 0 });
        return closed;
      }
      let guard = 0;
      while (last.t < t && guard++ < 10000) {
        closed.push(last);
        const nt = last.t + this.tfMs;
        // skipped buckets (no tick at all) are flat at the previous close; the
        // current bucket opens at the first live price
        const p = (nt === t && price > 0) ? price : last.c;
        const fresh = { t: nt, o: p, h: p, l: p, c: p, v: 0, bv: 0 };
        this.candles.push(fresh);
        last = fresh;
      }
      this.trim();
      return closed;
    }
    /** Update the current candle with a new index price. */
    updatePrice(now, price) {
      if (!(price > 0)) return [];
      const closed = this.roll(now, price);
      const c = this.last;
      c.h = Math.max(c.h, price); c.l = Math.min(c.l, price); c.c = price;
      return closed;
    }
    /** Add traded volume to the current candle. */
    addVolume(now, qty, side) {
      const c = this.last;
      if (!c) return;
      if (bucket(now, this.tfMs) !== c.t) return; // late trade for a closed candle: ignore
      c.v += qty; if (side === 'buy') c.bv += qty;
    }
  }

  return { TIMEFRAMES, BASE_TFS, CHART_TFS, SCANNER_ORDER, MIN, HOUR, DAY, bucket, baseFor, aggregate, composite, fillGaps, CandleSeries };
})();

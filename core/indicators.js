/* ============================================================================
 *  core/indicators.js — pure indicator math (runs in Node and in the browser)
 * ========================================================================== */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else { root.BTCM = root.BTCM || {}; root.BTCM.indicators = mod; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Simple moving average (null until `len` values are available). */
  function sma(values, len) {
    const out = new Array(values.length).fill(null);
    let sum = 0, count = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) { out[i] = null; continue; }
      sum += v; count++;
      if (count > len) { sum -= values[i - len]; }
      if (count >= len) out[i] = sum / len;
    }
    return out;
  }

  /** Exponential moving average seeded with the SMA of the first `len` values. */
  function ema(values, len) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (len + 1);
    let seedSum = 0, seedCount = 0, prev = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) continue;
      if (prev == null) {
        seedSum += v; seedCount++;
        if (seedCount === len) { prev = seedSum / len; out[i] = prev; }
        continue;
      }
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  /** EMA that starts on the first value (useful for short series). */
  function emaFast(values, len) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (len + 1);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) continue;
      prev = prev == null ? v : v * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  /** Wilder's RSI. */
  function rsi(closes, len) {
    const out = new Array(closes.length).fill(null);
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i < closes.length; i++) {
      const ch = closes[i] - closes[i - 1];
      const gain = ch > 0 ? ch : 0, loss = ch < 0 ? -ch : 0;
      if (i <= len) {
        avgGain += gain / len; avgLoss += loss / len;
        if (i === len) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      } else {
        avgGain = (avgGain * (len - 1) + gain) / len;
        avgLoss = (avgLoss * (len - 1) + loss) / len;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    }
    return out;
  }

  /** Wilder's ATR on candle objects {h,l,c}. */
  function atr(candles, len) {
    const out = new Array(candles.length).fill(null);
    let prev = null, sum = 0;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const tr = i === 0 ? c.h - c.l
        : Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c));
      if (i < len) { sum += tr; if (i === len - 1) { prev = sum / len; out[i] = prev; } continue; }
      prev = (prev * (len - 1) + tr) / len;
      out[i] = prev;
    }
    return out;
  }

  /**
   * Momentum Wave oscillator (a scaled WaveTrend-style oscillator).
   * Returns { mw, sig } arrays. Typical range -250..+250; extremes beyond +/-120.
   */
  function momentumWave(candles, opt) {
    const chLen = (opt && opt.chLen) || 10, avgLen = (opt && opt.avgLen) || 21, sigLen = (opt && opt.sigLen) || 4;
    const hlc3 = candles.map(c => (c.h + c.l + c.c) / 3);
    const esa = emaFast(hlc3, chLen);
    const dev = emaFast(hlc3.map((v, i) => Math.abs(v - esa[i])), chLen);
    const ci = hlc3.map((v, i) => dev[i] > 0 ? (v - esa[i]) / (0.015 * dev[i]) : 0);
    const wt1 = emaFast(ci, avgLen);
    const mw = wt1.map(v => v == null ? null : v * 2);
    const sig = sma(mw, sigLen);
    return { mw, sig };
  }

  /** Swing highs / lows: index i is a pivot if it is the extreme of [i-s, i+s]. */
  function pivots(candles, strength) {
    const highs = [], lows = [];
    for (let i = strength; i < candles.length - strength; i++) {
      let isHigh = true, isLow = true;
      const h = candles[i].h, l = candles[i].l;
      for (let j = i - strength; j <= i + strength && (isHigh || isLow); j++) {
        if (j === i) continue;
        if (candles[j].h > h) isHigh = false;
        if (candles[j].l < l) isLow = false;
      }
      if (isHigh) highs.push(i);
      if (isLow) lows.push(i);
    }
    return { highs, lows };
  }

  /** Trend state of a series: bull = close above EMA, up = EMA rising. */
  function trendState(closes, emaLen) {
    if (!closes || closes.length < 3) return null;
    const e = closes.length >= emaLen ? ema(closes, emaLen) : emaFast(closes, emaLen);
    const i = closes.length - 1;
    const cur = e[i], prev = e[Math.max(0, i - 3)];
    if (cur == null) return null;
    return { bull: closes[i] >= cur, up: prev == null ? closes[i] >= cur : cur >= prev, ema: cur };
  }

  /** Percent change between the close `msAgo` before `now` and `price`. */
  function pctChange(candles, msAgo, now, price) {
    if (!candles || !candles.length) return null;
    const target = now - msAgo;
    // binary search for last candle with t <= target
    let lo = 0, hi = candles.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (candles[mid].t <= target) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx < 0) return null;
    const ref = candles[idx].c;
    if (!ref) return null;
    return (price / ref - 1) * 100;
  }

  return { sma, ema, emaFast, rsi, atr, momentumWave, pivots, trendState, pctChange };
});

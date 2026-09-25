/* ============================================================================
 *  core/analysis.js — market structure logic built on the indicators:
 *  supply/demand zones, possible reversal markers, market condition tracking,
 *  multi-timeframe scanner and percentage changes.
 * ========================================================================== */
(function (root, factory) {
  const deps = (typeof module !== 'undefined' && module.exports)
    ? { indicators: require('./indicators'), candles: require('./candles') }
    : { indicators: root.BTCM.indicators, candles: root.BTCM.candles };
  const mod = factory(deps.indicators, deps.candles);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else { root.BTCM = root.BTCM || {}; root.BTCM.analysis = mod; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (I, C) {
  'use strict';

  const DEFAULTS = {
    emaLength: 50, rsiLength: 14, rsiOverbought: 70, rsiOversold: 30, scannerEma: 21,
    zoneLookback: 288, pivotStrength: 6, waveOverbought: 120, waveOversold: -120,
    reversalWindow: 6, conditionConfirmBars: 2,
  };

  function maxIn(arr, from, to) { let m = -Infinity; for (let i = Math.max(0, from); i <= to; i++) if (arr[i] != null && arr[i] > m) m = arr[i]; return m; }
  function minIn(arr, from, to) { let m = Infinity; for (let i = Math.max(0, from); i <= to; i++) if (arr[i] != null && arr[i] < m) m = arr[i]; return m; }

  /**
   * Possible reversal detection.
   * A bearish reversal candidate forms when the Momentum Wave crosses below its
   * signal shortly after an overbought extreme (wave or RSI); the marker sits on
   * the highest high of the window. Bullish is symmetric. Bars before the last one
   * are "confirmed" (candle closed); the last bar yields a "pending" candidate.
   */
  function detectReversals(candles, mw, sig, rsi, cfg) {
    const W = cfg.reversalWindow, out = [];
    let pending = null;
    // a marker of one type re-arms only after the wave has come back through the
    // middle of its range, so an extended extreme yields a single marker
    let armedBear = true, armedBull = true;
    for (let i = 1; i < candles.length; i++) {
      if (mw[i] == null || sig[i] == null || mw[i - 1] == null || sig[i - 1] == null) continue;
      if (mw[i] < cfg.waveOverbought * 0.4) armedBear = true;
      if (mw[i] > cfg.waveOversold * 0.4) armedBull = true;
      const crossDown = mw[i] < sig[i] && mw[i - 1] >= sig[i - 1];
      const crossUp = mw[i] > sig[i] && mw[i - 1] <= sig[i - 1];
      const isLast = i === candles.length - 1;
      if (crossDown) {
        const hot = maxIn(mw, i - W, i) >= cfg.waveOverbought || maxIn(rsi, i - W, i) >= cfg.rsiOverbought;
        if (hot && armedBear) {
          let k = i; for (let j = Math.max(0, i - W); j <= i; j++) if (candles[j].h > candles[k].h) k = j;
          const m = { type: 'bear', t: candles[k].t, price: candles[k].h, at: candles[i].t, confirmed: !isLast };
          if (isLast) pending = m; else { out.push(m); armedBear = false; }
        }
      } else if (crossUp) {
        const cold = minIn(mw, i - W, i) <= cfg.waveOversold || minIn(rsi, i - W, i) <= cfg.rsiOversold;
        if (cold && armedBull) {
          let k = i; for (let j = Math.max(0, i - W); j <= i; j++) if (candles[j].l < candles[k].l) k = j;
          const m = { type: 'bull', t: candles[k].t, price: candles[k].l, at: candles[i].t, confirmed: !isLast };
          if (isLast) pending = m; else { out.push(m); armedBull = false; }
        }
      }
    }
    return { markers: out, pending };
  }

  /**
   * Supply / demand zones: the extreme of the closed candles in the lookback
   * window, thickened by the larger of that candle's range and one ATR.
   */
  function detectZones(candles, atr, cfg) {
    const n = candles.length;
    if (n < 3) return { supply: null, demand: null };
    const end = n - 2; // exclude the forming candle (candle confirmation rule)
    const start = Math.max(0, end - cfg.zoneLookback + 1);
    let hi = start, lo = start;
    for (let i = start; i <= end; i++) {
      if (candles[i].h > candles[hi].h) hi = i;
      if (candles[i].l < candles[lo].l) lo = i;
    }
    const a = (i) => atr[i] || atr[end] || (candles[end].h - candles[end].l) || 1;
    const thick = (i) => Math.max(candles[i].h - candles[i].l, a(i));
    return {
      supply: { top: candles[hi].h, bottom: candles[hi].h - thick(hi), fromT: candles[hi].t },
      demand: { bottom: candles[lo].l, top: candles[lo].l + thick(lo), fromT: candles[lo].t },
    };
  }

  /**
   * Market condition (BULLISH / BEARISH): close vs EMA, flipping only after
   * `conditionConfirmBars` consecutive closed candles on the other side.
   */
  function trackCondition(candles, ema, rsi, cfg) {
    const n = candles.length;
    let state = null, since = null, sinceIdx = -1, run = 0, runState = null;
    for (let i = 0; i < n - 1; i++) { // closed candles only
      if (ema[i] == null) continue;
      const s = candles[i].c >= ema[i] ? 'BULLISH' : 'BEARISH';
      if (state == null) { state = s; since = candles[i].t; sinceIdx = i; run = 0; runState = null; continue; }
      if (s !== state) {
        if (runState === s) run++; else { runState = s; run = 1; }
        if (run >= cfg.conditionConfirmBars) { state = s; since = candles[i].t; sinceIdx = i; run = 0; runState = null; }
      } else { run = 0; runState = null; }
    }
    if (state == null) return null;
    return { state, since, idx: sinceIdx, price: candles[sinceIdx].c, rsi: rsi[sinceIdx] };
  }

  /** Full analysis of the chart series. */
  function analyzeChart(candles, cfgIn) {
    const cfg = Object.assign({}, DEFAULTS, cfgIn || {});
    const closes = candles.map(c => c.c);
    const ema = I.ema(closes, cfg.emaLength);
    const rsi = I.rsi(closes, cfg.rsiLength);
    const atr = I.atr(candles, 14);
    const { mw, sig } = I.momentumWave(candles);
    const rev = detectReversals(candles, mw, sig, rsi, cfg);
    const zones = detectZones(candles, atr, cfg);
    const condition = trackCondition(candles, ema, rsi, cfg);
    return { ema, rsi, atr, mw, sig, markers: rev.markers, pending: rev.pending, zones, condition };
  }

  /** Multi-timeframe scanner: { tf: {bull, up} } */
  function scanTrends(seriesByTf, cfgIn) {
    const cfg = Object.assign({}, DEFAULTS, cfgIn || {});
    const out = [];
    for (const tf of C.SCANNER_ORDER) {
      const s = seriesByTf[tf];
      const closes = s ? s.candles.map(c => c.c) : [];
      const st = I.trendState(closes, cfg.scannerEma);
      out.push({ tf, label: tfLabel(tf), bull: st ? st.bull : null, up: st ? st.up : null, bars: closes.length });
    }
    return out;
  }
  function tfLabel(tf) { return tf.endsWith('m') ? tf.slice(0, -1) : tf.toUpperCase(); }

  /** Percentage changes over standard horizons. */
  function pctChanges(seriesByTf, price, now) {
    const s5 = seriesByTf['5m'] ? seriesByTf['5m'].candles : [];
    const s1h = seriesByTf['1h'] ? seriesByTf['1h'].candles : [];
    const s1d = seriesByTf['1d'] ? seriesByTf['1d'].candles : [];
    const H = C.HOUR, D = C.DAY;
    return [
      { label: '6H', value: I.pctChange(s5, 6 * H, now, price) },
      { label: '12H', value: I.pctChange(s5, 12 * H, now, price) },
      { label: '24H', value: I.pctChange(s5, 24 * H, now, price) },
      { label: '48H', value: I.pctChange(s5, 48 * H, now, price) },
      { label: '72H', value: I.pctChange(s5.length >= 800 ? s5 : s1h, 72 * H, now, price) },
      { label: '1W', value: I.pctChange(s1h, 7 * D, now, price) },
      { label: '1M', value: I.pctChange(s1d, 30 * D, now, price) },
    ];
  }

  return { DEFAULTS, analyzeChart, detectReversals, detectZones, trackCondition, scanTrends, pctChanges, tfLabel };
});

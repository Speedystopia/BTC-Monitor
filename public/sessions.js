/* ============================================================================
 *  public/sessions.js — market session boxes (Asia, Frankfurt, London,
 *  New York...): for each session of each day, the high / low of the chart
 *  candles that opened inside it. Hours are UTC. Also loaded by the tests.
 * ========================================================================== */
(function (root) {
  'use strict';
  const MIN = 60000, DAY = 86400000;

  /** 'HH:MM' -> minutes after midnight, or null. */
  function minutes(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
    if (!m || +m[1] > 24 || +m[2] > 59) return null;
    return (+m[1] * 60 + +m[2]) % 1440;
  }
  /** First index whose candle opens at or after `t` (candles sorted by time). */
  function lowerBound(candles, t) { let lo = 0, hi = candles.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (candles[mid].t < t) lo = mid + 1; else hi = mid; } return lo; }

  /**
   * Boxes of the sessions found in `candles`: [{ name, color, start, end, i0, i1, hi, lo }]
   * (i0..i1: candle indexes). sessions: [{ name, start: 'HH:MM', end: 'HH:MM', color }] in UTC;
   * a session that ends before it starts runs past midnight (Asia 23:00 -> 07:00).
   */
  function sessionBoxes(candles, sessions) {
    const out = [];
    if (!candles || !candles.length || !Array.isArray(sessions)) return out;
    const lastT = candles[candles.length - 1].t;
    for (let day = Math.floor(candles[0].t / DAY) * DAY - DAY; day <= lastT; day += DAY) {
      for (const s of sessions) {
        const a = minutes(s.start), b = minutes(s.end);
        if (a == null || b == null || a === b) continue;
        const start = day + a * MIN, end = day + (b > a ? b : b + 1440) * MIN;
        const i0 = lowerBound(candles, start), i1 = lowerBound(candles, end) - 1;
        if (i0 > i1) continue;
        let hi = -Infinity, lo = Infinity;
        for (let i = i0; i <= i1; i++) { if (candles[i].h > hi) hi = candles[i].h; if (candles[i].l < lo) lo = candles[i].l; }
        out.push({ name: String(s.name || ''), color: s.color || '#9e9e9e', start, end, i0, i1, hi, lo });
      }
    }
    return out;
  }

  const api = { sessionBoxes, minutes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.BTCM_SESSIONS = api;
})(typeof window !== 'undefined' ? window : globalThis);

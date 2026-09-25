/* ============================================================================
 *  public/sessions.js — market session boxes (Asia, Frankfurt, London,
 *  New York...): for each session of each day, the high / low of the chart
 *  candles that opened inside it. Hours are UTC, or local to the session's
 *  `tz` (IANA time zone, daylight saving time included). Also loaded by the
 *  tests.
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

  // ---- time zones through Intl (throws RangeError for an unknown zone)
  const FMT = Object.create(null);
  function wall(t, tz) { // wall-clock date / time of instant t in tz
    if (tz === 'UTC') { const d = new Date(t); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }; }
    const f = FMT[tz] || (FMT[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
    const p = {}; for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
    return { y: +p.year, m: +p.month - 1, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
  }
  /** Offset of tz at instant t (local wall time - UTC), ms. */
  function offset(t, tz) { if (tz === 'UTC') return 0; const w = wall(t, tz); return Date.UTC(w.y, w.m, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000; }
  /** UTC instant of the local time `mins` on date y-m-d in tz (second pass: right side of a DST change). */
  function zonedTime(y, m, d, mins, tz) { const guess = Date.UTC(y, m, d) + mins * MIN; const t = guess - offset(guess, tz); return guess - offset(t, tz); }
  const BOUNDS = new Map(); // `${tz}|${day}|${a}|${b}` -> [start, end]: Intl is too slow to redo on every frame
  function bounds(tz, day, a, b) {
    const key = tz + '|' + day + '|' + a + '|' + b;
    let v = BOUNDS.get(key);
    if (!v) {
      const dt = new Date(day), y = dt.getUTCFullYear(), m = dt.getUTCMonth(), d = dt.getUTCDate();
      v = [zonedTime(y, m, d, a, tz), zonedTime(y, m, b > a ? d : d + 1, b, tz)];
      if (BOUNDS.size > 5000) BOUNDS.clear();
      BOUNDS.set(key, v);
    }
    return v;
  }

  /**
   * Boxes of the sessions found in `candles`, oldest first: [{ name, color, start, end, i0, i1, hi, lo }]
   * (i0..i1: candle indexes). sessions: [{ name, start: 'HH:MM', end: 'HH:MM', tz?, color }]; a session that
   * ends before it starts runs past midnight (Asia 23:00 -> 07:00). Sessions with an unknown tz are skipped.
   */
  function sessionBoxes(candles, sessions) {
    const out = [];
    if (!candles || !candles.length || !Array.isArray(sessions)) return out;
    const firstT = candles[0].t, lastT = candles[candles.length - 1].t;
    for (const s of sessions) {
      const a = minutes(s.start), b = minutes(s.end), tz = s.tz || 'UTC';
      if (a == null || b == null || a === b) continue;
      let w; try { w = wall(firstT - DAY, tz); } catch (e) { continue; }
      for (let day = Date.UTC(w.y, w.m, w.d); ; day += DAY) {
        const [start, end] = bounds(tz, day, a, b);
        if (start > lastT) break;
        const i0 = lowerBound(candles, start), i1 = lowerBound(candles, end) - 1;
        if (i0 > i1) continue;
        let hi = -Infinity, lo = Infinity;
        for (let i = i0; i <= i1; i++) { if (candles[i].h > hi) hi = candles[i].h; if (candles[i].l < lo) lo = candles[i].l; }
        out.push({ name: String(s.name || ''), color: s.color || '#9e9e9e', start, end, i0, i1, hi, lo });
      }
    }
    return out.sort((x, y) => x.start - y.start);
  }

  const api = { sessionBoxes, minutes, zonedTime };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.BTCM_SESSIONS = api;
})(typeof window !== 'undefined' ? window : globalThis);

/* ============================================================================
 *  core/heatmap.js — order-book liquidity heatmap.
 *
 *  Every second the engine hands the aggregated books (resting USD per price
 *  bucket, bids + asks, all exchanges); the samples are averaged per minute
 *  into columns kept for `historyHours`. The column of a chart candle is the
 *  average of its minutes: walls that rest for long stand out, quote flicker
 *  fades. Columns travel as { t, b0 (first bucket index), s (max USD),
 *  d (base64 bytes) } with 8-bit square-root companding: usd = (q/255)^2 * s.
 * ========================================================================== */
module.exports = (function () {
  'use strict';
  const MIN = 60000;
  const DQ = new Float64Array(256); for (let q = 0; q < 256; q++) DQ[q] = (q / 255) * (q / 255);

  /** Float values -> { q: Uint8Array, s: max } (square root: small values keep some resolution). */
  function quantize(vals) {
    let s = 0; for (let i = 0; i < vals.length; i++) if (vals[i] > s) s = vals[i];
    const q = new Uint8Array(vals.length);
    if (s > 0) for (let i = 0; i < vals.length; i++) q[i] = Math.round(255 * Math.sqrt(vals[i] / s));
    return { q, s };
  }
  const toB64 = (q) => Buffer.from(q.buffer, q.byteOffset, q.length).toString('base64');
  /** Wire form of a column. */
  const encode = (c) => ({ t: c.t, b0: c.b0, s: Math.round(c.s), d: toB64(c.q) });

  class LiquidityHeatmap {
    constructor(opts) {
      const o = Object.assign({ step: 10, historyHours: 72 }, opts || {});
      this.step = o.step;
      this.keepMs = Math.max(1, o.historyHours) * 3600000;
      this.cols = [];          // finished minutes, oldest first: { t, b0, s, q }
      this.cur = null;         // minute being sampled: { t, sums: Map(bucket -> usd), n }
      this.version = 0;        // bumped when a minute is finished (store + cache)
      this._cache = new Map(); // tfMs -> finished part of the running candle { t, version, part }
    }

    /** One aggregated book sample at `now`: bins [[bucketPrice, bidUsd, askUsd], ...]. */
    sample(now, bins) {
      const t = Math.floor(now / MIN) * MIN;
      if (this.cur && t < this.cur.t) return; // clock went back: ignore
      if (this.cur && this.cur.t !== t) this._finish();
      if (!this.cur) this.cur = { t, sums: new Map(), n: 0 };
      const c = this.cur; c.n++;
      for (const [p, bid, ask] of bins) { const v = bid + ask; if (v > 0) { const k = Math.round(p / this.step); c.sums.set(k, (c.sums.get(k) || 0) + v); } }
    }
    _finish() {
      const c = this.cur; this.cur = null;
      if (!c || !c.n || !c.sums.size) return;
      const last = this.cols[this.cols.length - 1]; if (last && c.t <= last.t) return;
      let b0 = Infinity, b1 = -Infinity;
      for (const k of c.sums.keys()) { if (k < b0) b0 = k; if (k > b1) b1 = k; }
      const vals = new Float64Array(b1 - b0 + 1);
      for (const [k, v] of c.sums) vals[k - b0] = v / c.n;
      const { q, s } = quantize(vals);
      this.cols.push({ t: c.t, b0, s, q });
      const cut = c.t - this.keepMs; let i = 0; while (i < this.cols.length && this.cols[i].t <= cut) i++;
      if (i) this.cols.splice(0, i);
      this.version++;
    }

    /** Index of the first finished minute at or after `t`. */
    _lower(t) { let lo = 0, hi = this.cols.length; while (lo < hi) { const m = (lo + hi) >> 1; if (this.cols[m].t < t) lo = m + 1; else hi = m; } return lo; }
    /** Sum of the finished minutes of [t, end): { b0, vals, n } or null. */
    _sumFinished(t, end) {
      const i0 = this._lower(t); let b0 = Infinity, b1 = -Infinity, i = i0;
      for (; i < this.cols.length && this.cols[i].t < end; i++) { const c = this.cols[i]; if (c.b0 < b0) b0 = c.b0; if (c.b0 + c.q.length - 1 > b1) b1 = c.b0 + c.q.length - 1; }
      if (i === i0) return null;
      const vals = new Float64Array(b1 - b0 + 1);
      for (let j = i0; j < i; j++) { const c = this.cols[j], off = c.b0 - b0, q = c.q, s = c.s; for (let k = 0; k < q.length; k++) if (q[k]) vals[off + k] += DQ[q[k]] * s; }
      return { b0, vals, n: i - i0 };
    }
    /** Column of the candle [t, t + tfMs): average of its minutes, the running one included; null without data. */
    column(t, tfMs) {
      const end = t + tfMs;
      const cur = this.cur && this.cur.n && this.cur.t >= t && this.cur.t < end ? this.cur : null;
      let part;
      if (cur) { // running candle: its finished minutes are summed again only when a minute finishes
        const c = this._cache.get(tfMs);
        if (c && c.t === t && c.version === this.version) part = c.part;
        else { part = this._sumFinished(t, end); this._cache.set(tfMs, { t, version: this.version, part }); }
      } else part = this._sumFinished(t, end);
      let b0 = part ? part.b0 : Infinity, b1 = part ? part.b0 + part.vals.length - 1 : -Infinity;
      if (cur) for (const k of cur.sums.keys()) { if (k < b0) b0 = k; if (k > b1) b1 = k; }
      if (!(b1 >= b0)) return null;
      const n = (part ? part.n : 0) + (cur ? 1 : 0);
      const vals = new Float64Array(b1 - b0 + 1);
      if (part) { const off = part.b0 - b0; for (let k = 0; k < part.vals.length; k++) vals[off + k] = part.vals[k]; }
      if (cur) for (const [k, v] of cur.sums) vals[k - b0] += v / cur.n;
      for (let k = 0; k < vals.length; k++) vals[k] /= n;
      const { q, s } = quantize(vals);
      return { t, b0, s, q };
    }
    /** Start of the oldest minute recorded (null before the first sample). */
    firstTime() { return this.cols.length ? this.cols[0].t : this.cur ? this.cur.t : null; }
    /** Columns of the candles starting at `times` (candles without data are skipped). */
    columns(times, tfMs) {
      const first = this.firstTime(); if (first == null) return [];
      const out = [];
      for (const t of times) { if (t + tfMs <= first) continue; const c = this.column(t, tfMs); if (c) out.push(c); }
      return out;
    }

    /** Store form: { v: 1, step, cols: [[t, b0, maxUsd, base64], ...] } (the running minute is not kept). */
    export() { return { v: 1, step: this.step, cols: this.cols.map(c => [c.t, c.b0, Math.round(c.s), toB64(c.q)]) }; }
    /** Restore a store written with the same bucket size; returns the number of minutes loaded. */
    load(data, now) {
      if (!data || data.v !== 1 || data.step !== this.step || !Array.isArray(data.cols)) return 0;
      const cut = now - this.keepMs, cols = [];
      for (const r of data.cols) {
        if (!Array.isArray(r) || !(r[0] > cut) || !Number.isInteger(r[1]) || !(r[2] > 0) || typeof r[3] !== 'string') continue;
        const q = new Uint8Array(Buffer.from(r[3], 'base64'));
        if (q.length) cols.push({ t: r[0], b0: r[1], s: r[2], q });
      }
      cols.sort((a, b) => a.t - b.t);
      this.cols = cols; this.version++; this._cache.clear();
      return cols.length;
    }
  }

  return { LiquidityHeatmap, encode, quantize };
})();

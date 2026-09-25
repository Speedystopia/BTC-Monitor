/* ============================================================================
 *  public/util.js — formatting helpers
 * ========================================================================== */
window.BTCM_UTIL = (function () {
  'use strict';
  const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

  function fmtPrice(p, decimals) {
    if (p == null || !isFinite(p)) return '—';
    if (decimals != null) return p.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    if (Math.abs(p) >= 1000) return nf2.format(p);
    if (Math.abs(p) >= 10) return p.toFixed(2);
    if (Math.abs(p) >= 1) return p.toFixed(3);
    return p.toFixed(4);
  }
  function fmtUsd(v) {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 999.5e6) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (a >= 999.5e3) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (a >= 999.5) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + v.toFixed(0);
  }
  function fmtK(v) {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 999.5e6) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 999.5e3) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 999.5) return (v / 1e3).toFixed(1) + 'K';
    return nf0.format(v);
  }
  function fmtPct(v, digits) {
    if (v == null || !isFinite(v)) return '—';
    return (v > 0 ? '+' : '') + v.toFixed(digits == null ? 2 : digits) + '%';
  }
  function fmtSigned(v) { if (v == null || !isFinite(v)) return '—'; return (v > 0 ? '+' : '') + nf2.format(v); }
  function fmtAge(ms) {
    if (ms == null || ms < 0) return '';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h';
    return Math.floor(h / 24) + 'd';
  }
  function fmtMinAgo(ms) {
    if (ms == null) return '—';
    const m = Math.max(0, Math.round(ms / 60000));
    if (m < 600) return m + ' min ago';
    const h = Math.floor(m / 60);
    if (h < 48) return h + 'h ' + (m % 60) + 'm ago';
    return Math.floor(h / 24) + 'd ' + (h % 24) + 'h ago';
  }
  function fmtCountdown(ms) {
    if (ms == null) return '--:--:--:--';
    if (ms < 0) ms = 0;
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d)}:${p(h)}:${p(m)}:${p(sec)}`;
  }
  function fmtClock(ms) { const p = (n) => String(n).padStart(2, '0'); const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600); return h > 0 ? `${h}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`; }
  function fmtDate(t) { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getDate())}/${p(d.getMonth() + 1)}`; }
  function tfName(tf) {
    const m = { '1m': ['M1', '1 MINUTE TIME FRAME'], '3m': ['M3', '3 MINUTE TIME FRAME'], '5m': ['M5', '5 MINUTE TIME FRAME'], '15m': ['M15', '15 MINUTE TIME FRAME'], '30m': ['M30', '30 MINUTE TIME FRAME'],
      '1h': ['H1', '1 HOUR TIME FRAME'], '2h': ['H2', '2 HOUR TIME FRAME'], '4h': ['H4', '4 HOUR TIME FRAME'], '6h': ['H6', '6 HOUR TIME FRAME'], '8h': ['H8', '8 HOUR TIME FRAME'], '12h': ['H12', '12 HOUR TIME FRAME'], '1d': ['D1', 'DAILY TIME FRAME (24H)'] };
    return m[tf] || [tf.toUpperCase(), tf + ' TIME FRAME'];
  }
  /** Short chart label like TradingView: 5, 15, 1H, 4H, 1D */
  function tfShort(tf) { return tf.endsWith('m') ? tf.slice(0, -1) : tf.toUpperCase(); }
  /** Date/time label adapted to the timeframe */
  function fmtAxisTime(t, tfMs) { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); if (tfMs >= 86400000) return `${p(d.getDate())}/${p(d.getMonth() + 1)}`; if (tfMs >= 3600000) return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}h`; return `${p(d.getHours())}:${p(d.getMinutes())}`; }
  function niceStep(range, targetTicks) {
    const raw = range / Math.max(1, targetTicks);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 2.5, 5, 10]) { if (raw <= m * mag) return m * mag; }
    return 10 * mag;
  }
  function el(id) { return document.getElementById(id); }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  return { fmtPrice, fmtUsd, fmtK, fmtPct, fmtSigned, fmtAge, fmtMinAgo, fmtCountdown, fmtClock, fmtDate, tfName, tfShort, fmtAxisTime, niceStep, el, escapeHtml };
})();

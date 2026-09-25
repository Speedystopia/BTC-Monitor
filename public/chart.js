/* ============================================================================
 *  public/chart.js — canvas renderers: candlestick chart + Momentum Wave pane
 * ========================================================================== */
window.BTCM_CHART = (function () {
  'use strict';
  const U = window.BTCM_UTIL;
  const FONT = '"Barlow Condensed", "Roboto Condensed", "Arial Narrow", Arial, sans-serif';
  const COLORS = {
    up: '#22c55e', down: '#ef4444', upBright: '#2ee56b', downBright: '#ff5252', ema: '#b6ff3b',
    grid: 'rgba(255,255,255,0.06)', axisText: '#b5b5b5', supply: 'rgba(34,197,94,0.20)', supplyEdge: 'rgba(34,197,94,0.55)',
    demand: 'rgba(255,140,0,0.30)', demandEdge: 'rgba(255,140,0,0.7)', marker: '#1e40af', markerText: '#ffffff', markerTri: '#60a5fa',
    bidProfile: 'rgba(34,197,94,0.32)', askProfile: 'rgba(239,68,68,0.32)', watermark: 'rgba(255,255,255,0.05)',
  };

  /** Shared x layout: candle slot width & positions (chart and oscillator use the same). */
  function xLayout(width, axisWidth, len, visible, rightPad) {
    const plotLeft = 0, plotRight = width - axisWidth;
    const n = Math.min(visible, len);
    const slot = (plotRight - plotLeft) / (visible + rightPad);
    const start = Math.max(0, len - n);
    return { plotLeft, plotRight, axisX: plotRight, slot, start, n, x: (i) => plotLeft + (i - start + (visible - n)) * slot + slot / 2 };
  }

  function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(10, Math.floor(rect.width)), h = Math.max(10, Math.floor(rect.height));
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) { canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  // ==========================================================================
  class ChartRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.axisWidth = 118; this.visible = 300; this.rightPad = 9;
      this.candles = []; this.zones = null; this.markers = []; this.pending = null; this.condition = null;
      this.tick = null; this.book = null; this.tfMs = 300000; this.refLabel = 'CB';
      this.sessions = null; this.showSessions = true; // { maxTfMs, list } from the server
      this.layout = null; this.yRange = null;
    }
    setSeries(candles, zones, markers, pending, condition) { this.candles = candles; this.zones = zones; this.markers = markers || []; this.pending = pending; this.condition = condition; }
    priceToY(p) { const r = this.yRange; return r.top + (r.max - p) / (r.max - r.min) * r.height; }
    computeYRange(h, vis) {
      let min = Infinity, max = -Infinity;
      for (const c of vis) { if (c.l < min) min = c.l; if (c.h > max) max = c.h; if (c.ema != null) { if (c.ema < min) min = c.ema; if (c.ema > max) max = c.ema; } }
      if (this.tick && this.tick.p) { min = Math.min(min, this.tick.p); max = Math.max(max, this.tick.p); }
      if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
      const range = Math.max(max - min, max * 0.002);
      const z = this.zones;
      if (z) {
        for (const zone of [z.supply, z.demand]) {
          if (!zone) continue;
          if (zone.top > max && zone.top - max < range * 1.5) max = zone.top;
          if (zone.bottom < min && min - zone.bottom < range * 1.5) min = zone.bottom;
        }
      }
      const pad = (max - min) * 0.07;
      const top = 26, bottom = h - 24;
      this.yRange = { min: min - pad, max: max + pad, top, height: bottom - top, bottom };
    }
    render() {
      const { ctx, w, h } = setupCanvas(this.canvas);
      ctx.clearRect(0, 0, w, h);
      const candles = this.candles;
      if (!candles.length) return;
      const L = this.layout = xLayout(w, this.axisWidth, candles.length, this.visible, this.rightPad);
      const vis = candles.slice(L.start);
      this.computeYRange(h, vis);
      const Y = (p) => this.priceToY(p);

      // watermark
      ctx.save(); ctx.fillStyle = COLORS.watermark; ctx.font = `700 ${Math.min(h * 0.8, 520)}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('₿', L.plotRight / 2, h / 2 + 10); ctx.restore();

      this.drawGrid(ctx, w, h, L);
      this.drawSessions(ctx, L);
      this.drawProfile(ctx, L);
      this.drawZones(ctx, L, vis);
      this.drawCandles(ctx, L, vis);
      this.drawMarkers(ctx, L, candles);
      this.drawCondition(ctx, L, candles);
      this.drawLastPrice(ctx, L, h);
      this.drawTimeAxis(ctx, L, vis, h);
    }
    drawGrid(ctx, w, h, L) {
      const r = this.yRange; const step = U.niceStep(r.max - r.min, 9);
      ctx.save(); ctx.font = `600 13px ${FONT}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      for (let p = Math.ceil(r.min / step) * step; p <= r.max; p += step) {
        const y = Math.round(this.priceToY(p)) + 0.5;
        ctx.strokeStyle = COLORS.grid; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(L.axisX, y); ctx.stroke();
        ctx.fillStyle = COLORS.axisText; ctx.fillText(U.fmtPrice(p, 2), L.axisX + 8, y);
      }
      ctx.restore();
    }
    drawProfile(ctx, L) {
      const b = this.book; if (!b || !b.bins || !b.bins.length) return;
      const r = this.yRange; let max = 0;
      for (const [p, bid, ask] of b.bins) { if (p < r.min || p > r.max) continue; max = Math.max(max, bid, ask); }
      if (!max) return;
      const maxW = (L.plotRight - L.plotLeft) * 0.20;
      const hPx = Math.max(1, (b.bucket / (r.max - r.min)) * r.height);
      for (const [p, bid, ask] of b.bins) {
        if (p < r.min || p > r.max) continue;
        const y = this.priceToY(p + b.bucket);
        if (bid > 0) { ctx.fillStyle = COLORS.bidProfile; ctx.fillRect(L.plotLeft, y, Math.max(1, bid / max * maxW), hPx); }
        if (ask > 0) { ctx.fillStyle = COLORS.askProfile; ctx.fillRect(L.plotLeft, y, Math.max(1, ask / max * maxW), hPx); }
      }
    }
    /** Market sessions (like TradingView session indicators): a box from the session high to its low, name above. */
    drawSessions(ctx, L) {
      const S = window.BTCM_SESSIONS, cfg = this.sessions;
      if (!this.showSessions || !S || !cfg || !cfg.list || this.tfMs > cfg.maxTfMs) return;
      ctx.save(); ctx.font = `600 13px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.lineWidth = 1;
      for (const b of S.sessionBoxes(this.candles, cfg.list)) {
        if (b.i1 < L.start) continue;
        const x1 = Math.max(L.plotLeft, L.x(b.i0) - L.slot / 2), x2 = Math.min(L.axisX, L.x(b.i1) + L.slot / 2);
        if (x2 - x1 < 1) continue;
        const y1 = Math.round(this.priceToY(b.hi)) + 0.5, y2 = Math.round(this.priceToY(b.lo)) + 0.5;
        ctx.fillStyle = ctx.strokeStyle = b.color;
        ctx.globalAlpha = 0.1; ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
        ctx.globalAlpha = 0.65; ctx.strokeRect(Math.round(x1) + 0.5, y1, Math.round(x2 - x1), y2 - y1);
        ctx.globalAlpha = 0.95; ctx.fillText(b.name, (x1 + x2) / 2, y1 - 3);
      }
      ctx.restore();
    }
    xOfTime(t, L, vis) {
      // x position of a candle open time, or the left edge when it is off-screen
      if (!vis.length) return L.plotLeft;
      if (t <= vis[0].t) return L.plotLeft;
      const i = Math.floor((t - vis[0].t) / this.tfMs);
      return L.x(L.start + Math.min(i, vis.length - 1)) - L.slot / 2;
    }
    drawZones(ctx, L, vis) {
      const z = this.zones; if (!z) return;
      const r = this.yRange;
      const draw = (zone, fill, edge, label, color, labelBelow) => {
        if (!zone) return;
        if (zone.bottom > r.max || zone.top < r.min) return;
        const y1 = this.priceToY(Math.min(zone.top, r.max)), y2 = this.priceToY(Math.max(zone.bottom, r.min));
        const x1 = this.xOfTime(zone.fromT, L, vis);
        // faint band across the whole width, full band from the candle that formed it
        ctx.save(); ctx.globalAlpha = 0.45; ctx.fillStyle = fill; ctx.fillRect(L.plotLeft, y1, x1 - L.plotLeft, y2 - y1); ctx.restore();
        ctx.fillStyle = fill; ctx.fillRect(x1, y1, L.axisX - x1, y2 - y1);
        ctx.strokeStyle = edge; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(L.plotLeft, y1 + 0.5); ctx.lineTo(L.axisX, y1 + 0.5); ctx.moveTo(L.plotLeft, y2 + 0.5); ctx.lineTo(L.axisX, y2 + 0.5); ctx.stroke(); ctx.setLineDash([]);
        ctx.font = `700 22px ${FONT}`; ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = labelBelow ? 'top' : 'bottom';
        const ly = labelBelow ? y2 + 4 : y1 - 4;
        // keep the label clear of the trend-scanner panel (left side, around 42% of the height)
        const h = this.yRange.bottom + 24; const sc0 = h * 0.42 - 135, sc1 = h * 0.42 + 165;
        const lx = (ly > sc0 && ly < sc1) ? L.plotLeft + 232 : L.plotLeft + 10;
        ctx.fillText(label, lx, ly);
      };
      draw(z.supply, COLORS.supply, COLORS.supplyEdge, 'SUPPLY ZONE', '#3ddc84', true);
      draw(z.demand, COLORS.demand, COLORS.demandEdge, 'DEMAND ZONE', '#ffa726', true);
    }
    drawCandles(ctx, L, vis) {
      const bodyW = Math.max(1, Math.floor(L.slot * 0.62));
      // EMA first (behind candles? the reference draws it over) -> draw after candles
      for (let k = 0; k < vis.length; k++) {
        const c = vis[k]; const x = L.x(L.start + k);
        const up = c.c >= c.o;
        const col = up ? COLORS.up : COLORS.down;
        const yo = this.priceToY(c.o), yc = this.priceToY(c.c), yh = this.priceToY(c.h), yl = this.priceToY(c.l);
        ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, yh); ctx.lineTo(Math.round(x) + 0.5, yl); ctx.stroke();
        ctx.fillStyle = col;
        const top = Math.min(yo, yc), hh = Math.max(1, Math.abs(yc - yo));
        ctx.fillRect(Math.round(x - bodyW / 2), top, bodyW, hh);
      }
      ctx.strokeStyle = COLORS.ema; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.beginPath(); let started = false;
      for (let k = 0; k < vis.length; k++) { const c = vis[k]; if (c.ema == null) continue; const x = L.x(L.start + k), y = this.priceToY(c.ema); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); }
      ctx.stroke();
    }
    drawLabelBox(ctx, x, y, lines, above, alpha) {
      ctx.save(); ctx.globalAlpha = alpha == null ? 1 : alpha;
      ctx.font = `700 11px ${FONT}`; const lw = Math.max(...lines.map(l => ctx.measureText(l).width)) + 12; const lh = lines.length * 12 + 6;
      const tri = 7;
      const boxY = above ? y - tri - lh - 4 : y + tri + 4;
      ctx.fillStyle = COLORS.marker; roundRect(ctx, x - lw / 2, boxY, lw, lh, 3); ctx.fill();
      ctx.fillStyle = COLORS.markerTri; ctx.beginPath();
      if (above) { ctx.moveTo(x, y - 2); ctx.lineTo(x - 5, y - 2 - tri); ctx.lineTo(x + 5, y - 2 - tri); }
      else { ctx.moveTo(x, y + 2); ctx.lineTo(x - 5, y + 2 + tri); ctx.lineTo(x + 5, y + 2 + tri); }
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = COLORS.markerText; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      lines.forEach((l, i) => ctx.fillText(l, x, boxY + 3 + i * 12));
      ctx.restore();
    }
    drawMarkers(ctx, L, candles) {
      const all = this.markers.slice(); if (this.pending) all.push(this.pending);
      const firstT = candles[L.start].t;
      for (const m of all) {
        if (m.t < firstT) continue;
        const i = L.start + Math.round((m.t - firstT) / this.tfMs); if (i < L.start + 2 || i >= candles.length) continue;
        const x = L.x(i); const y = this.priceToY(m.price);
        this.drawLabelBox(ctx, x, y, ['POSSIBLE', 'REVERSAL'], m.type === 'bear', m.confirmed ? 1 : 0.45);
      }
    }
    drawCondition(ctx, L, candles) {
      const c = this.condition; if (!c || c.since == null || !candles.length) return;
      const idx = Math.round((c.since - candles[0].t) / this.tfMs);
      if (idx < L.start || idx >= candles.length || candles[idx].t !== c.since) return;
      const x = L.x(idx); const cd = candles[idx];
      const bull = c.state === 'BULLISH';
      const y = this.priceToY(bull ? cd.l : cd.h);
      ctx.save(); ctx.font = `700 11px ${FONT}`;
      const lines = [`${c.state} CONDITION`, c.rsi != null ? `RSI ${c.rsi.toFixed(2)}` : ''];
      const lw = Math.max(...lines.map(l => ctx.measureText(l).width)) + 12, lh = 30;
      const boxY = bull ? y + 8 : y - 8 - lh;
      ctx.fillStyle = bull ? 'rgba(22,101,52,0.95)' : 'rgba(153,27,27,0.95)'; roundRect(ctx, x - lw / 2, boxY, lw, lh, 3); ctx.fill();
      ctx.strokeStyle = bull ? COLORS.upBright : COLORS.downBright; ctx.lineWidth = 1; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, bull ? boxY : boxY + lh); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(lines[0], x, boxY + 3); ctx.fillText(lines[1], x, boxY + 16);
      ctx.restore();
    }
    drawLastPrice(ctx, L, h) {
      const t = this.tick; const last = this.candles[this.candles.length - 1]; if (!last) return;
      const p = t && t.p ? t.p : last.c; const up = last.c >= last.o;
      const y = this.priceToY(p);
      ctx.save();
      ctx.strokeStyle = up ? COLORS.up : COLORS.down; ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(L.plotLeft, Math.round(y) + 0.5); ctx.lineTo(L.axisX, Math.round(y) + 0.5); ctx.stroke(); ctx.setLineDash([]);
      // main label with countdown
      const bw = this.axisWidth - 6, bh = 40, bx = L.axisX + 3, by = Math.min(h - bh - 2, Math.max(2, y - bh / 2));
      ctx.fillStyle = up ? '#16a34a' : '#dc2626'; roundRect(ctx, bx, by, bw, bh, 3); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.font = `700 17px ${FONT}`; ctx.fillText(U.fmtPrice(p, 2), bx + 8, by + 12);
      ctx.font = `600 13px ${FONT}`; ctx.fillText(t ? U.fmtClock(t.closeIn) : '', bx + 8, by + 29);
      // reference exchange price
      if (t && t.ref) {
        const ry = this.priceToY(t.ref); const rh = 20; let rby = ry - rh / 2;
        if (Math.abs(rby - by) < bh + 2) rby = ry >= y ? by + bh + 2 : by - rh - 2;
        rby = Math.min(h - rh - 2, Math.max(2, rby));
        ctx.fillStyle = t.ref >= p ? '#15803d' : '#b91c1c'; roundRect(ctx, bx, rby, bw, rh, 3); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = `700 15px ${FONT}`; ctx.fillText(U.fmtPrice(t.ref, 2), bx + 8, rby + rh / 2);
        ctx.font = `600 9px ${FONT}`; ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fillText(this.refLabel, bx + bw - 4, rby + rh / 2);
      }
      ctx.restore();
    }
    drawTimeAxis(ctx, L, vis, h) {
      ctx.save(); ctx.font = `500 12px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      const tfMs = this.tfMs;
      const sample = U.fmtAxisTime(vis[0].t, tfMs);
      const labelW = ctx.measureText(sample).width + 22;
      const every = Math.max(1, Math.ceil(labelW / L.slot));
      // "major" boundaries: a new day on intraday charts, a new month on hourly+ charts
      const majorOf = (t) => { const d = new Date(t); return tfMs < 3600000 ? d.getDate() : d.getMonth(); };
      let lastMajor = null, lastLabel = -every;
      for (let k = 0; k < vis.length; k++) {
        const c = vis[k]; const mj = majorOf(c.t);
        const major = lastMajor != null && mj !== lastMajor; lastMajor = mj;
        const x = L.x(L.start + k);
        if (major) {
          ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, this.yRange.top); ctx.lineTo(Math.round(x) + 0.5, this.yRange.bottom); ctx.stroke();
          if (k - lastLabel < every * 0.6 || x < 24) continue;
          lastLabel = k; ctx.fillStyle = '#bbbbbb';
          const d = new Date(c.t);
          ctx.fillText(tfMs < 3600000 ? U.fmtDate(c.t) : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`, x, h - 6);
          continue;
        }
        if (k - lastLabel < every || x < 24) continue;
        lastLabel = k; ctx.fillStyle = '#7a7a7a';
        ctx.fillText(U.fmtAxisTime(c.t, tfMs), x, h - 6);
      }
      ctx.restore();
    }
  }

  // ==========================================================================
  class OscRenderer {
    constructor(canvas) { this.canvas = canvas; this.axisWidth = 118; this.visible = 300; this.rightPad = 9; this.candles = []; }
    render() {
      const { ctx, w, h } = setupCanvas(this.canvas);
      ctx.clearRect(0, 0, w, h);
      const candles = this.candles; if (!candles.length) return;
      const L = xLayout(w, this.axisWidth, candles.length, this.visible, this.rightPad);
      const vis = candles.slice(L.start);
      let min = -50, max = 50;
      for (const c of vis) { if (c.mw != null) { min = Math.min(min, c.mw); max = Math.max(max, c.mw); } if (c.sig != null) { min = Math.min(min, c.sig); max = Math.max(max, c.sig); } }
      const pad = (max - min) * 0.12; min -= pad; max += pad;
      const top = 10, bottom = h - 10, height = bottom - top;
      const Y = (v) => top + (max - v) / (max - min) * height;
      // grid
      ctx.save(); ctx.font = `600 13px ${FONT}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      const step = U.niceStep(max - min, 4);
      for (let v = Math.ceil(min / step) * step; v <= max; v += step) {
        const y = Math.round(Y(v)) + 0.5; ctx.strokeStyle = v === 0 ? 'rgba(255,255,255,0.35)' : COLORS.grid; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(L.axisX, y); ctx.stroke();
        ctx.fillStyle = COLORS.axisText; ctx.fillText(v.toFixed(2), L.axisX + 8, y);
      }
      // crossover bars
      const barW = Math.max(2, Math.floor(L.slot * 0.55));
      for (let k = 1; k < vis.length; k++) {
        const c = vis[k], pv = vis[k - 1]; if (c.mw == null || c.sig == null || pv.mw == null || pv.sig == null) continue;
        const nowUp = c.mw >= c.sig, wasUp = pv.mw >= pv.sig; if (nowUp === wasUp) continue;
        const x = L.x(L.start + k); ctx.fillStyle = nowUp ? COLORS.upBright : COLORS.downBright;
        const y0 = Y(0), y1 = Y(c.mw); ctx.fillRect(Math.round(x - barW / 2), Math.min(y0, y1), barW, Math.max(1, Math.abs(y1 - y0)));
      }
      // signal line
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1; ctx.beginPath(); let st = false;
      for (let k = 0; k < vis.length; k++) { const c = vis[k]; if (c.sig == null) continue; const x = L.x(L.start + k), y = Y(c.sig); if (!st) { ctx.moveTo(x, y); st = true; } else ctx.lineTo(x, y); }
      ctx.stroke();
      // momentum wave line, colored by regime
      ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (let k = 1; k < vis.length; k++) {
        const c = vis[k], pv = vis[k - 1]; if (c.mw == null || pv.mw == null) continue;
        ctx.strokeStyle = (c.sig != null && c.mw >= c.sig) ? COLORS.upBright : COLORS.downBright;
        ctx.beginPath(); ctx.moveTo(L.x(L.start + k - 1), Y(pv.mw)); ctx.lineTo(L.x(L.start + k), Y(c.mw)); ctx.stroke();
      }
      // value boxes
      const last = vis[vis.length - 1];
      if (last && last.mw != null) {
        const up = last.sig != null && last.mw >= last.sig;
        const bw = this.axisWidth - 6, bh = 20, bx = L.axisX + 3;
        const y1 = Math.min(h - bh - 2, Math.max(2, Y(last.mw) - bh / 2));
        ctx.fillStyle = up ? '#16a34a' : '#dc2626'; roundRect(ctx, bx, y1, bw, bh, 3); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = `700 15px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(last.mw.toFixed(2), bx + 8, y1 + bh / 2);
        if (last.sig != null) {
          let y2 = Y(last.sig) - bh / 2; if (Math.abs(y2 - y1) < bh + 2) y2 = last.sig < last.mw ? y1 + bh + 2 : y1 - bh - 2; y2 = Math.min(h - bh - 2, Math.max(2, y2));
          ctx.fillStyle = up ? '#15803d' : '#b91c1c'; roundRect(ctx, bx, y2, bw, bh, 3); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.fillText(last.sig.toFixed(2), bx + 8, y2 + bh / 2);
        }
      }
      // pane title
      ctx.font = `700 12px ${FONT}`; ctx.fillStyle = '#8a8a8a'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('MOMENTUM WAVE', 12, 6);
      ctx.restore();
    }
  }

  return { ChartRenderer, OscRenderer, COLORS, xLayout };
})();

/* ============================================================================
 *  public/chart.js — canvas renderers: candlestick chart + Momentum Wave pane
 * ========================================================================== */
window.BTCM_CHART = (function () {
  'use strict';
  const U = window.BTCM_UTIL;
  const FONT = '"Barlow Condensed", "Roboto Condensed", "Arial Narrow", Arial, sans-serif';
  const COLORS = {
    up: '#22c55e', down: '#ef4444', upBright: '#2ee56b', downBright: '#ff5252', ema: '#b6ff3b',
    grid: 'rgba(255,255,255,0.06)', axisText: '#b5b5b5', supply: 'rgba(239,68,68,0.18)', supplyEdge: 'rgba(239,68,68,0.6)',
    demand: 'rgba(34,197,94,0.18)', demandEdge: 'rgba(34,197,94,0.6)', marker: '#1e40af', markerText: '#ffffff', markerTri: '#60a5fa',
    bidProfile: 'rgba(34,197,94,0.32)', askProfile: 'rgba(239,68,68,0.32)', watermark: 'rgba(255,255,255,0.05)',
  };

  /**
   * Shared x layout: candle slot width & positions (chart and oscillator use the same). Candles [start, end) are
   * visible; `end` defaults to the live edge (`live`), the right padding keeps room for the price labels.
   */
  function xLayout(width, axisWidth, len, visible, rightPad, end) {
    const plotLeft = 0, plotRight = width - axisWidth;
    const n = Math.min(visible, len);
    const e = end == null ? len : Math.max(n, Math.min(len, end));
    const slot = (plotRight - plotLeft) / (visible + rightPad);
    const start = e - n;
    return { plotLeft, plotRight, axisX: plotRight, slot, start, end: e, n, live: e === len, x: (i) => plotLeft + (i - start + (visible - n)) * slot + slot / 2 };
  }
  /** Index after the last candle shown: the live edge, or the candle the view was dragged back to (it stays put as candles arrive). */
  function viewEnd(candles, tfMs, anchorT) {
    if (anchorT == null || !candles.length) return candles.length;
    return Math.round((anchorT - candles[0].t) / tfMs) + 1;
  }
  /** Index in `vis` of the candle under x (null off the candles or over the price axis). */
  function candleAt(L, vis, x) {
    if (x == null || x < L.plotLeft || x > L.axisX || !vis.length) return null;
    const k = Math.round((x - L.x(L.start)) / L.slot);
    return k >= 0 && k < vis.length ? k : null;
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  function fmtCandleTime(t, tfMs) {
    const d = new Date(t), day = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
    return tfMs >= 86400000 ? `${day}/${d.getFullYear()}` : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${day} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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

  // ---- liquidity heatmap: colour ramp (low -> high: transparent, blue, cyan, yellow, orange, red), dequantization
  const HEAT_STOPS = [[0, 0, 0, 0, 0], [0.2, 25, 35, 120, 0.12], [0.42, 0, 110, 230, 0.3], [0.6, 0, 205, 230, 0.48], [0.78, 250, 225, 40, 0.66], [0.9, 255, 135, 20, 0.8], [1, 255, 50, 50, 0.9]];
  const HEAT_LUT = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const x = i / 255; let k = 1; while (k < HEAT_STOPS.length - 1 && HEAT_STOPS[k][0] < x) k++;
    const a = HEAT_STOPS[k - 1], b = HEAT_STOPS[k], f = (x - a[0]) / ((b[0] - a[0]) || 1);
    for (let c = 1; c <= 4; c++) HEAT_LUT[i * 4 + c - 1] = (a[c] + (b[c] - a[c]) * f) * (c === 4 ? 255 : 1);
  }
  const HEAT_DQ = new Float32Array(256); for (let q = 0; q < 256; q++) HEAT_DQ[q] = (q / 255) * (q / 255);

  /**
   * Rasterize the heat columns of the visible candles into `canvas`: one pixel column per candle, one row per
   * device pixel from yRange.max (top) to yRange.min. A row sums the liquidity of the price buckets it covers;
   * colours are scaled on the 98th percentile of the visible cells divided by `gain`, so the biggest walls stand
   * out. Returns the USD per row shown at full colour (0 when there is nothing to draw).
   */
  function rasterHeat(canvas, heat, vis, r, rows, gain) {
    const w = vis.length, span = r.max - r.min; if (!(span > 0) || !w) return 0;
    const cells = new Float32Array(w * rows), perUsd = rows / span, step = heat.step;
    let n = 0;
    for (let k = 0; k < w; k++) {
      const col = heat.cols.get(vis[k].t); if (!col) continue;
      const q = col.q, s = col.s;
      for (let i = 0; i < q.length; i++) {
        if (!q[i]) continue;
        const lo = (col.b0 + i) * step, yTop = (r.max - lo - step) * perUsd, yBot = (r.max - lo) * perUsd;
        if (yBot <= 0 || yTop >= rows) continue;
        const v = HEAT_DQ[q[i]] * s;
        if (yBot - yTop < 1) { const y = Math.floor((yTop + yBot) / 2); if (y >= 0 && y < rows) cells[y * w + k] += v; }
        else for (let y = Math.max(0, Math.floor(yTop)), y1 = Math.min(rows, Math.ceil(yBot)); y < y1; y++) cells[y * w + k] += v;
        n++;
      }
    }
    if (!n) return 0;
    const stride = Math.max(1, Math.floor(cells.length / 40000)), sample = new Float32Array(Math.ceil(cells.length / stride));
    let m = 0; for (let i = 0; i < cells.length; i += stride) if (cells[i] > 0) sample[m++] = cells[i];
    if (!m) return 0;
    const sorted = sample.subarray(0, m).sort(), ref = (sorted[Math.min(m - 1, Math.floor(m * 0.98))] || 1) / (gain > 0 ? gain : 1);
    if (canvas.width !== w || canvas.height !== rows) { canvas.width = w; canvas.height = rows; }
    const cx = canvas.getContext('2d'), img = cx.createImageData(w, rows), px = img.data;
    for (let i = 0; i < cells.length; i++) {
      if (!(cells[i] > 0)) continue;
      const li = Math.min(255, Math.round(255 * Math.sqrt(cells[i] / ref))) * 4, o = i * 4;
      px[o] = HEAT_LUT[li]; px[o + 1] = HEAT_LUT[li + 1]; px[o + 2] = HEAT_LUT[li + 2]; px[o + 3] = HEAT_LUT[li + 3];
    }
    cx.putImageData(img, 0, 0);
    return ref;
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
      this.heat = null; this.showHeat = true; this.heatGain = 1; this._heatKey = ''; this._heatRef = 0; this._heatRows = 1; this._heatCanvas = null; // { step, cols: Map(t -> col), version }
      this.layout = null; this.yRange = null;
      this.anchorT = null;            // time of the last visible candle when the view was dragged back (null = live)
      this.hover = null; this.hoverT = null; // mouse { x, y } in CSS px (y null: hovering the oscillator) -> candle time
    }
    setSeries(candles, zones, markers, pending, condition) { this.candles = candles; this.zones = zones; this.markers = markers || []; this.pending = pending; this.condition = condition; }
    priceToY(p) { const r = this.yRange; return r.top + (r.max - p) / (r.max - r.min) * r.height; }
    computeYRange(h, vis, live) {
      let min = Infinity, max = -Infinity;
      for (const c of vis) { if (c.l < min) min = c.l; if (c.h > max) max = c.h; if (c.ema != null) { if (c.ema < min) min = c.ema; if (c.ema > max) max = c.ema; } }
      if (live && this.tick && this.tick.p) { min = Math.min(min, this.tick.p); max = Math.max(max, this.tick.p); }
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
      const L = this.layout = xLayout(w, this.axisWidth, candles.length, this.visible, this.rightPad, viewEnd(candles, this.tfMs, this.anchorT));
      const vis = candles.slice(L.start, L.end);
      this.computeYRange(h, vis, L.live);
      const Y = (p) => this.priceToY(p);

      // watermark
      ctx.save(); ctx.fillStyle = COLORS.watermark; ctx.font = `700 ${Math.min(h * 0.8, 520)}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('₿', L.plotRight / 2, h / 2 + 10); ctx.restore();

      this.drawHeatmap(ctx, L, vis);
      const legend = this.heatLegendBox(ctx, L);
      this.drawGrid(ctx, w, h, L);
      this.drawSessions(ctx, L);
      this.drawProfile(ctx, L);
      this.drawZones(ctx, L, vis, legend);
      this.drawCandles(ctx, L, vis);
      this.drawMarkers(ctx, L, candles);
      this.drawCondition(ctx, L, candles);
      this.drawLastPrice(ctx, L, h);
      this.drawTimeAxis(ctx, L, vis, h);
      this.drawHeatLegend(ctx, legend);
      this.drawCrosshair(ctx, L, vis, h);
    }
    /** Crosshair on the candle under the mouse: dashed lines, price and time labels on the axes, the candle's values. */
    drawCrosshair(ctx, L, vis, h) {
      const k = candleAt(L, vis, this.hover && this.hover.x);
      this.hoverT = k == null ? null : vis[k].t;
      if (k == null) return;
      const c = vis[k], r = this.yRange, x = Math.round(L.x(L.start + k)) + 0.5, y = this.hover.y;
      const inPlot = y != null && y >= r.top && y <= r.bottom;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.beginPath();
      ctx.moveTo(x, r.top); ctx.lineTo(x, r.bottom);
      if (inPlot) { ctx.moveTo(L.plotLeft, Math.round(y) + 0.5); ctx.lineTo(L.axisX, Math.round(y) + 0.5); }
      ctx.stroke(); ctx.setLineDash([]);
      ctx.font = `600 12px ${FONT}`; ctx.textBaseline = 'middle';
      if (inPlot) { // price at the mouse, on the price axis
        const p = r.max - (y - r.top) / r.height * (r.max - r.min);
        ctx.fillStyle = '#3a3f4b'; roundRect(ctx, L.axisX + 3, y - 10, this.axisWidth - 6, 20, 3); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(U.fmtPrice(p, 2), L.axisX + 11, y);
      }
      const tl = fmtCandleTime(c.t, this.tfMs), tw = ctx.measureText(tl).width + 14;
      ctx.fillStyle = '#3a3f4b'; roundRect(ctx, Math.max(L.plotLeft, Math.min(L.axisX - tw, x - tw / 2)), h - 22, tw, 20, 3); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(tl, Math.max(L.plotLeft + tw / 2, Math.min(L.axisX - tw / 2, x)), h - 12);
      // the candle's values, next to the mouse (flipped near the right / bottom edges)
      const up = c.c >= c.o, col = up ? COLORS.upBright : COLORS.downBright, chg = c.o ? (c.c / c.o - 1) * 100 : 0;
      const rows = [
        [['O', U.fmtPrice(c.o, 2)], ['H', U.fmtPrice(c.h, 2)]],
        [['L', U.fmtPrice(c.l, 2)], ['C', U.fmtPrice(c.c, 2)]],
        [['', `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`], ['VOL', c.v != null ? c.v.toFixed(2) : '—']],
        [['EMA', c.ema != null ? U.fmtPrice(c.ema, 1) : '—'], ['RSI', c.rsi != null ? c.rsi.toFixed(1) : '—']],
      ];
      const bw = 206, bh = 22 + rows.length * 16;
      let bx = x + 16, by = (inPlot ? y : r.top + 40) + 16;
      if (bx + bw > L.axisX - 4) bx = x - 16 - bw;
      if (by + bh > r.bottom) by = Math.max(r.top, (inPlot ? y : r.bottom) - 16 - bh);
      ctx.fillStyle = 'rgba(12,14,20,0.9)'; roundRect(ctx, bx, by, bw, bh, 4); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.stroke();
      ctx.textAlign = 'left'; ctx.fillStyle = '#9a9a9a'; ctx.fillText(tl, bx + 10, by + 12);
      rows.forEach((row, i) => row.forEach(([label, value], j) => {
        const cx = bx + 10 + j * 98, cy = by + 30 + i * 16;
        ctx.fillStyle = '#8a8a8a'; ctx.fillText(label, cx, cy);
        ctx.fillStyle = i < 2 || (i === 2 && j === 0) ? col : '#e0e0e0'; ctx.fillText(value, cx + (label ? 26 : 0), cy);
      }));
      ctx.restore();
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
    /** Order-book liquidity heatmap behind the candles (re-rasterized only when the data, the scale or the view change). */
    drawHeatmap(ctx, L, vis) {
      const heat = this.heat; if (!this.showHeat || !heat || !heat.cols.size || !vis.length) { this._heatRef = 0; return; }
      const r = this.yRange, rows = Math.max(1, Math.round(r.height * (window.devicePixelRatio || 1)));
      const key = `${vis[0].t}|${vis.length}|${r.min}|${r.max}|${rows}|${heat.version}|${this.heatGain}`;
      if (key !== this._heatKey) {
        this._heatKey = key; this._heatRows = rows;
        this._heatCanvas = this._heatCanvas || document.createElement('canvas');
        this._heatRef = rasterHeat(this._heatCanvas, heat, vis, r, rows, this.heatGain);
      }
      if (!this._heatRef) return;
      ctx.save(); ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this._heatCanvas, L.x(L.start) - L.slot / 2, r.top, vis.length * L.slot, r.height);
      ctx.restore();
    }
    /** Heatmap scale box (bottom left): null when the heatmap is not drawn. Zone labels move aside from it. */
    heatLegendBox(ctx, L) {
      if (!this.showHeat || !(this._heatRef > 0)) return null;
      const r = this.yRange, band = Math.max(this.heat.step, (r.max - r.min) / this._heatRows); // price covered by one row
      const title = 'LIQUIDITY HEATMAP' + (Math.abs(this.heatGain - 1) > 0.001 ? `  ×${this.heatGain}` : '');
      const value = `${U.fmtUsd(this._heatRef)} / $${band < 10 ? band.toFixed(1) : Math.round(band)}`;
      ctx.save(); ctx.font = `600 12px ${FONT}`;
      const w = Math.max(ctx.measureText(title).width, 98 + ctx.measureText(value).width) + 16;
      ctx.restore();
      return { x: L.plotLeft + 10, y: r.bottom - 42, w, h: 38, title, value };
    }
    /** The colour ramp and the resting liquidity shown at full colour, per price band. */
    drawHeatLegend(ctx, b) {
      if (!b) return;
      const barW = 90;
      ctx.save(); ctx.font = `600 12px ${FONT}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(8,8,12,0.72)'; roundRect(ctx, b.x, b.y, b.w, b.h, 3); ctx.fill();
      ctx.fillStyle = '#9a9a9a'; ctx.fillText(b.title, b.x + 8, b.y + 11);
      for (let i = 0; i < barW; i++) {
        const li = Math.round(i / (barW - 1) * 255) * 4;
        ctx.fillStyle = `rgba(${HEAT_LUT[li]},${HEAT_LUT[li + 1]},${HEAT_LUT[li + 2]},${Math.max(0.2, HEAT_LUT[li + 3] / 255).toFixed(3)})`;
        ctx.fillRect(b.x + 8 + i, b.y + 23, 1, 8);
      }
      ctx.fillStyle = '#d8d8d8'; ctx.fillText(b.value, b.x + 16 + barW, b.y + 27);
      ctx.restore();
    }
    /** Market sessions (like TradingView session indicators): a box from the session high to its low, name above. */
    drawSessions(ctx, L) {
      const S = window.BTCM_SESSIONS, cfg = this.sessions;
      if (!this.showSessions || !S || !cfg || !cfg.list || this.tfMs > cfg.maxTfMs) return;
      ctx.save(); ctx.font = `600 13px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.lineWidth = 1;
      for (const b of S.sessionBoxes(this.candles, cfg.list)) {
        if (b.i1 < L.start || b.i0 >= L.end) continue;
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
    drawZones(ctx, L, vis, legend) {
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
        let lx = (ly > sc0 && ly < sc1) ? L.plotLeft + 232 : L.plotLeft + 10;
        // ... and of the heatmap legend (bottom left)
        const top = labelBelow ? ly : ly - 22;
        if (legend && top < legend.y + legend.h && top + 22 > legend.y && lx < legend.x + legend.w) lx = legend.x + legend.w + 12;
        ctx.fillText(label, lx, ly);
      };
      draw(z.supply, COLORS.supply, COLORS.supplyEdge, 'SUPPLY ZONE', '#ff6b6b', true); // supply = resistance: red
      draw(z.demand, COLORS.demand, COLORS.demandEdge, 'DEMAND ZONE', '#3ddc84', true); // demand = support: green
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
        const i = L.start + Math.round((m.t - firstT) / this.tfMs); if (i < L.start + 2 || i >= L.end) continue;
        const x = L.x(i); const y = this.priceToY(m.price);
        this.drawLabelBox(ctx, x, y, ['POSSIBLE', 'REVERSAL'], m.type === 'bear', m.confirmed ? 1 : 0.45);
      }
    }
    drawCondition(ctx, L, candles) {
      const c = this.condition; if (!c || c.since == null || !candles.length) return;
      const idx = Math.round((c.since - candles[0].t) / this.tfMs);
      if (idx < L.start || idx >= L.end || candles[idx].t !== c.since) return;
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
      const y = this.priceToY(p), r = this.yRange;
      ctx.save();
      if (y >= r.top && y <= r.bottom) { ctx.strokeStyle = up ? COLORS.up : COLORS.down; ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(L.plotLeft, Math.round(y) + 0.5); ctx.lineTo(L.axisX, Math.round(y) + 0.5); ctx.stroke(); ctx.setLineDash([]); }
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
    constructor(canvas) { this.canvas = canvas; this.axisWidth = 118; this.visible = 300; this.rightPad = 9; this.candles = []; this.tfMs = 300000; this.anchorT = null; this.hoverT = null; }
    render() {
      const { ctx, w, h } = setupCanvas(this.canvas);
      ctx.clearRect(0, 0, w, h);
      const candles = this.candles; if (!candles.length) return;
      const L = xLayout(w, this.axisWidth, candles.length, this.visible, this.rightPad, viewEnd(candles, this.tfMs, this.anchorT));
      const vis = candles.slice(L.start, L.end);
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
      // pane title, with the values of the candle under the crosshair
      ctx.font = `700 12px ${FONT}`; ctx.fillStyle = '#8a8a8a'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('MOMENTUM WAVE', 12, 6);
      const k = this.hoverT == null || !vis.length ? -1 : Math.round((this.hoverT - vis[0].t) / this.tfMs);
      if (k >= 0 && k < vis.length) {
        const c = vis[k], x = Math.round(L.x(L.start + k)) + 0.5;
        ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke(); ctx.setLineDash([]);
        const tx = 12 + ctx.measureText('MOMENTUM WAVE').width + 12;
        if (c.mw != null) { ctx.fillStyle = c.sig != null && c.mw >= c.sig ? COLORS.upBright : COLORS.downBright; ctx.fillText(c.mw.toFixed(2), tx, 6); }
        if (c.sig != null) { ctx.fillStyle = '#bdbdbd'; ctx.fillText(c.sig.toFixed(2), tx + 64, 6); }
      }
      ctx.restore();
    }
  }

  return { ChartRenderer, OscRenderer, COLORS, xLayout, viewEnd };
})();

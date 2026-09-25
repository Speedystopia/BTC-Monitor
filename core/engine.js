/* ============================================================================
 *  core/engine.js — the market engine (runs in Node and in the browser demo)
 *
 *  Consumes normalized exchange events (trades, order-book snapshots/deltas,
 *  liquidations, tickers) and produces the dashboard state as messages:
 *    snapshot | tick | analysis | scanner | pct | book | orders | liq |
 *    assets | calendar | status | alert
 * ========================================================================== */
(function (root, factory) {
  const deps = (typeof module !== 'undefined' && module.exports)
    ? { I: require('./indicators'), C: require('./candles'), A: require('./analysis') }
    : { I: root.BTCM.indicators, C: root.BTCM.candles, A: root.BTCM.analysis };
  const mod = factory(deps.I, deps.C, deps.A);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else { root.BTCM = root.BTCM || {}; root.BTCM.engine = mod; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (I, C, A) {
  'use strict';

  const EXCHANGE_NAMES = { binance: 'Binance', coinbase: 'Coinbase', kraken: 'Kraken', bybit: 'Bybit', okx: 'OKX', bitstamp: 'Bitstamp', sim: 'Simulation' };
  const USDT_QUOTED = { binance: true, bybit: true, okx: true };

  /** Tiny event emitter. */
  class Emitter {
    constructor() { this._h = {}; }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return () => this.off(ev, fn); }
    off(ev, fn) { const a = this._h[ev]; if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    emit(ev, data) { const a = this._h[ev]; if (!a) return; for (const fn of a.slice()) { try { fn(data); } catch (e) { console.error('listener error', e); } } }
  }

  /** One exchange's local order book. */
  class LocalBook {
    constructor(id) { this.id = id; this.bids = new Map(); this.asks = new Map(); this.updatedAt = 0; this.ready = false; }
    clear() { this.bids.clear(); this.asks.clear(); this.ready = false; }
    bestBid() { let b = 0; for (const p of this.bids.keys()) if (p > b) b = p; return b; }
    bestAsk() { let a = Infinity; for (const p of this.asks.keys()) if (p < a) a = p; return a === Infinity ? 0 : a; }
    size() { return this.bids.size + this.asks.size; }
  }

  class Engine extends Emitter {
    constructor(config) {
      super();
      this.cfg = config || {};
      this.icfg = Object.assign({}, A.DEFAULTS, this.cfg.indicators || {});
      this.obcfg = Object.assign({ bucketUsd: 10, profileRangePct: 1.5, largeOrderUsd: 150000, largeTradeUsd: 50000, feedMax: 40, removedRowTtlSec: 20, feedRangePct: 2, minRestMs: 10000 }, this.cfg.orderBook || {});
      this.chartTf = this.cfg.chartTimeframe || '5m';               // default page timeframe
      this.chartTfs = (this.cfg.chartTimeframes || C.CHART_TFS).filter(tf => C.TIMEFRAMES[tf]);
      if (!this.chartTfs.includes(this.chartTf)) this.chartTfs.unshift(this.chartTf);
      this.mode = 'live';
      this.now = () => Date.now();

      // candle series for all timeframes
      this.series = {};
      for (const tf of Object.keys(C.TIMEFRAMES)) this.series[tf] = new C.CandleSeries(tf, 1500);
      this.chartCandles = this.cfg.chartCandles || 900;   // candles sent to a chart page
      // per-exchange trade state for the index price
      this.ex = {}; // id -> { last, ts, vol, volTs, quote, status, name }
      this.index = 0; this.indexTs = 0;
      this.usdtRate = 1;
      this.normalizeUsdt = !!this.cfg.normalizeUsdt;
      this.refExchange = this.cfg.referenceExchange || 'coinbase';

      this.recentTrades = []; // {ts, qty, side, usd}
      this.books = {};        // id -> LocalBook
      this.feed = [];         // large order / trade rows
      this.feedSeq = 0;
      this.levelSince = new Map();   // level key -> first time it exceeded the threshold
      this.tradeRows = [];           // recent large trades
      this._lastFeedAt = 0; this._feedSig = '';
      this.liqEvents = [];    // rolling 24h
      this.assets = {};       // label -> {label, price, pct, ts}
      this.calendar = { events: [], next: null, updatedAt: 0 };
      this.statusExtra = {};

      // per chart timeframe: analysis + alert state
      this.tfState = {};
      for (const tf of this.chartTfs) this.tfState[tf] = { analysis: null, rsiState: null, lastConditionState: null, lastMarkerKey: null };
      this.scanner = []; this.pct = [];
      this._lastAnalysisAt = 0; this._lastScanAt = 0; this._lastBookAt = 0; this._lastStatusAt = 0; this._lastOrdersAt = 0;
      this._ordersDirty = false; this._lastIndexEmitted = 0; this._lastTickAt = 0;
      this.historyLoaded = false;
      this.startedAt = this.now();
    }

    // ------------------------------------------------------------------ helpers
    exchangeName(id) { return EXCHANGE_NAMES[id] || id; }
    registerExchange(id, opts) {
      if (!this.ex[id]) this.ex[id] = { id, name: this.exchangeName(id), last: 0, ts: 0, vol: 0, volTs: 0, quote: USDT_QUOTED[id] ? 'USDT' : 'USD', status: 'connecting', trades: 0 };
      if (opts && opts.quote) this.ex[id].quote = opts.quote;
      if (!this.books[id]) this.books[id] = new LocalBook(id);
      return this.ex[id];
    }
    setStatus(id, status, detail) {
      const e = this.registerExchange(id);
      e.status = status; if (detail !== undefined) e.detail = detail;
      this._lastStatusAt = 0; // force status emit on next tick
    }
    setUsdtRate(rate) { if (rate > 0.9 && rate < 1.1) this.usdtRate = rate; }
    toUsd(id, price) { const e = this.ex[id]; return (this.normalizeUsdt && e && e.quote === 'USDT') ? price * this.usdtRate : price; }

    // ------------------------------------------------------------------ history
    /** byBase: { '1m': {ex: [candles]}, '3m': ..., '5m': ..., '15m': ..., '1h': ..., '4h': ..., '1d': ... } (per-exchange maps or plain arrays) */
    seedHistory(byBase) {
      const base = {};
      for (const tf of C.BASE_TFS) {
        const v = byBase[tf];
        if (!v) continue;
        const arr = Array.isArray(v) ? v : C.composite(v);
        if (arr.length) base[tf] = arr;
      }
      this.historyBases = {};
      for (const tf of Object.keys(C.TIMEFRAMES)) {
        const b = C.baseFor(tf, base);
        if (!b) continue;
        const src = base[b];
        const candles = tf === b ? src : C.aggregate(src, C.TIMEFRAMES[tf]);
        this.series[tf].seed(candles);
        this.historyBases[tf] = b;
      }
      this.historyLoaded = true;
      this._lastAnalysisAt = 0; this._lastScanAt = 0;
      this.recompute(this.now(), true);
    }

    // ------------------------------------------------------------------ trades
    onTrade(id, tr) {
      const e = this.registerExchange(id);
      const now = this.now();
      const price = this.toUsd(id, tr.price);
      if (!(price > 0) || !(tr.qty >= 0)) return;
      // decayed volume (tau = 15 minutes) used as index weight
      if (e.volTs) e.vol *= Math.exp(-(now - e.volTs) / 900000);
      e.vol += tr.qty; e.volTs = now; e.last = price; e.ts = now; e.trades++;
      if (e.status !== 'ok') { e.status = 'ok'; this._lastStatusAt = 0; }
      const usd = price * tr.qty;
      this.recentTrades.push({ ts: now, qty: tr.qty, side: tr.side, usd });
      // volume into all series (roll first so the bucket is current)
      const idx = this.index || price;
      for (const tf of Object.keys(this.series)) { const s = this.series[tf]; if (s.candles.length) { s.roll(now, idx); s.addVolume(now, tr.qty, tr.side); } }
      if (usd >= this.obcfg.largeTradeUsd) this.addTradeRow({ kind: 'trade', ex: id, side: tr.side, price, usd, qty: tr.qty, ts: now });
    }

    computeIndex(now) {
      let wsum = 0, psum = 0, n = 0;
      for (const id of Object.keys(this.ex)) {
        const e = this.ex[id];
        if (!(e.last > 0) || now - e.ts > 60000) continue;
        const vol = e.vol * Math.exp(-(now - e.volTs) / 900000);
        const w = vol + 1e-6;
        wsum += w; psum += e.last * w; n++;
      }
      if (!n) return this.index;
      this.index = psum / wsum; this.indexTs = now; this.indexSources = n;
      return this.index;
    }

    // ------------------------------------------------------------------ order books
    onBookSnapshot(id, bids, asks) {
      const book = this.books[id] || (this.registerExchange(id), this.books[id]);
      book.bids = new Map(); book.asks = new Map();
      for (const [p, q] of bids) { const pp = +p, qq = +q; if (qq > 0) book.bids.set(pp, qq); }
      for (const [p, q] of asks) { const pp = +p, qq = +q; if (qq > 0) book.asks.set(pp, qq); }
      book.ready = true; book.updatedAt = this.now();
    }
    onBookDelta(id, bids, asks) {
      const book = this.books[id]; if (!book || !book.ready) return;
      for (const [p, q] of bids) { const pp = +p, qq = +q; if (qq > 0) book.bids.set(pp, qq); else book.bids.delete(pp); }
      for (const [p, q] of asks) { const pp = +p, qq = +q; if (qq > 0) book.asks.set(pp, qq); else book.asks.delete(pp); }
      book.updatedAt = this.now();
    }
    /**
     * Large-order feed: the biggest resting levels (>= largeOrderUsd, within
     * feedRangePct of the price) across all exchanges, newest first. The age of
     * a row is the time since that level first reached the threshold. Levels that
     * vanish stay crossed out for a short while. Large trades are interleaved.
     */
    refreshFeed(now) {
      const mid = this.index; if (!(mid > 0)) return;
      const thr = this.obcfg.largeOrderUsd, range = mid * this.obcfg.feedRangePct / 100;
      const seen = new Set(); const cands = [];
      for (const id of Object.keys(this.books)) {
        const book = this.books[id]; if (!book.ready) continue;
        const f = (this.normalizeUsdt && this.ex[id] && this.ex[id].quote === 'USDT') ? this.usdtRate : 1;
        for (const side of ['bid', 'ask']) {
          const m = side === 'bid' ? book.bids : book.asks;
          for (const [p, q] of m) {
            const pu = p * f; if (Math.abs(pu - mid) > range) continue;
            const usd = q * pu; if (usd < thr) continue;
            const key = `${id}|${side}|${p}`;
            let since = this.levelSince.get(key);
            if (since == null) { since = now; this.levelSince.set(key, since); }
            seen.add(key);
            if (now - since < this.obcfg.minRestMs) continue; // must rest a while (filters market-maker quote flicker)
            cands.push({ key, kind: 'order', ex: id, side, price: pu, usd, qty: q, ts: since });
          }
        }
      }
      for (const key of this.levelSince.keys()) if (!seen.has(key)) this.levelSince.delete(key);
      cands.sort((a, b) => b.usd - a.usd);
      const top = cands.slice(0, this.obcfg.feedMax);
      const topKeys = new Set(top.map(c => c.key));
      // rows that were listed and whose level is now gone -> crossed out for a while
      const ttl = this.obcfg.removedRowTtlSec * 1000;
      const removed = this.feed.filter(r => r.kind === 'order' && !topKeys.has(r.key) && (r.removed ? now - r.removed < ttl : !seen.has(r.key)))
        .map(r => (r.removed ? r : Object.assign({}, r, { removed: now })));
      const trades = this.tradeRows.filter(t => now - t.ts < 120000);
      const rows = top.concat(removed, trades).sort((a, b) => b.ts - a.ts).slice(0, this.obcfg.feedMax);
      const sig = rows.map(r => r.key + (r.removed ? 'x' : '') + Math.round(r.usd / 1000)).join(',');
      if (sig !== this._feedSig) { this._feedSig = sig; this.feed = rows; this._ordersDirty = true; }
    }
    addTradeRow(row) {
      row.key = `t|${row.ex}|${row.ts}|${row.price}`;
      this.tradeRows.unshift(row); if (this.tradeRows.length > 20) this.tradeRows.length = 20;
      this._ordersDirty = true;
    }
    /** Aggregated liquidity profile around the price (usd per bucket). */
    bookProfile() {
      const mid = this.index; if (!(mid > 0)) return null;
      const b = this.obcfg.bucketUsd, range = mid * this.obcfg.profileRangePct / 100;
      const lo = mid - range, hi = mid + range;
      const bins = new Map();
      let bestBid = 0, bestAsk = 0, bidUsd = 0, askUsd = 0;
      for (const id of Object.keys(this.books)) {
        const book = this.books[id]; if (!book.ready) continue;
        const f = (this.normalizeUsdt && this.ex[id] && this.ex[id].quote === 'USDT') ? this.usdtRate : 1;
        for (const [p, q] of book.bids) {
          const pu = p * f; if (pu < lo || pu > hi) continue;
          if (pu > bestBid) bestBid = pu;
          const k = Math.floor(pu / b) * b; const s = bins.get(k) || [k, 0, 0]; s[1] += q * pu; bins.set(k, s); bidUsd += q * pu;
        }
        for (const [p, q] of book.asks) {
          const pu = p * f; if (pu < lo || pu > hi) continue;
          if (!bestAsk || pu < bestAsk) bestAsk = pu;
          const k = Math.floor(pu / b) * b; const s = bins.get(k) || [k, 0, 0]; s[2] += q * pu; bins.set(k, s); askUsd += q * pu;
        }
      }
      const arr = Array.from(bins.values()).sort((x, y) => x[0] - y[0]);
      return { bins: arr, bestBid, bestAsk, bidUsd, askUsd, bucket: b };
    }

    // ------------------------------------------------------------------ liquidations
    onLiquidation(id, ev) {
      const now = this.now();
      const usd = ev.usd || (ev.price * ev.qty);
      if (!(usd > 0)) return;
      const e = { ex: id, side: ev.side, price: ev.price, qty: ev.qty || usd / ev.price, usd, ts: ev.ts || now };
      this.liqEvents.push(e);
      this.pruneLiquidations(now);
      this.emit('message', { type: 'liq', event: e, totals: this.liqTotals() });
      this.emit('liq_persist', this.liqEvents);
    }
    loadLiquidations(events) { if (Array.isArray(events)) { this.liqEvents = events.filter(e => e && e.usd > 0 && e.ts > 0); this.pruneLiquidations(this.now()); } }
    pruneLiquidations(now) { const cut = now - C.DAY; if (this.liqEvents.length && this.liqEvents[0].ts < cut) this.liqEvents = this.liqEvents.filter(e => e.ts >= cut); }
    liqTotals() {
      let long = 0, short = 0;
      for (const e of this.liqEvents) { if (e.side === 'long') long += e.usd; else short += e.usd; }
      return { total: long + short, long, short, count: this.liqEvents.length, since: this.liqEvents.length ? this.liqEvents[0].ts : null };
    }

    // ------------------------------------------------------------------ assets / calendar
    setAsset(label, data) {
      this.assets[label] = Object.assign({ label }, this.assets[label] || {}, data, { ts: this.now() });
      this.emit('message', { type: 'assets', assets: this.assetList() });
    }
    assetList() { return (this.cfg.assets || []).map(a => Object.assign({ label: a.label, icon: a.icon, price: null, pct: null }, this.assets[a.label] || {})); }
    setCalendar(events) {
      this.calendar.events = (events || []).filter(e => e && e.time).sort((a, b) => a.time - b.time);
      this.calendar.updatedAt = this.now();
      this.emit('message', { type: 'calendar', calendar: this.calendarState() });
    }
    calendarState() {
      const now = this.now();
      const upcoming = this.calendar.events.filter(e => e.time > now - 60000).slice(0, 12);
      return { next: upcoming[0] || null, upcoming, updatedAt: this.calendar.updatedAt };
    }

    // ------------------------------------------------------------------ main loop
    /** Call ~4 times per second. */
    tick() {
      const now = this.now();
      const idx = this.computeIndex(now);
      if (!(idx > 0)) { this._maybeStatus(now); return; }
      const closedTfs = new Set();
      for (const tf of Object.keys(this.series)) {
        const closed = this.series[tf].updatePrice(now, idx);
        if (closed.length && this.tfState[tf]) closedTfs.add(tf);
      }
      // prune rolling buffers
      const cut = now - 60000;
      if (this.recentTrades.length && this.recentTrades[0].ts < cut) { let i = 0; while (i < this.recentTrades.length && this.recentTrades[i].ts < cut) i++; this.recentTrades.splice(0, i); }
      if (now - this._lastFeedAt >= 1000) { this._lastFeedAt = now; this.refreshFeed(now); }

      this.recompute(now, closedTfs.size > 0);
      for (const tf of this.chartTfs) this._emitTick(tf, now, closedTfs.has(tf));
      for (const tf of closedTfs) this.emit('message', this.analysisMessage(tf));
      if (now - this._lastBookAt >= 1000) { this._lastBookAt = now; const prof = this.bookProfile(); if (prof) this.emit('message', Object.assign({ type: 'book' }, prof)); }
      if (this._ordersDirty && now - this._lastOrdersAt >= 400) { this._ordersDirty = false; this._lastOrdersAt = now; this.emit('message', { type: 'orders', rows: this.feed }); }
      this._maybeStatus(now);
    }
    _maybeStatus(now) {
      if (now - this._lastStatusAt < 5000) return;
      this._lastStatusAt = now;
      this.emit('message', { type: 'status', status: this.statusState() });
    }
    statusState() {
      const now = this.now();
      let total = 0; const list = [];
      for (const id of Object.keys(this.ex)) { const e = this.ex[id]; const v = e.vol * Math.exp(-(now - e.volTs) / 900000); total += v; list.push({ id, name: e.name, status: e.status, detail: e.detail || '', lastTradeAgo: e.ts ? now - e.ts : null, vol5m: v, last: e.last, trades: e.trades, book: this.books[id] ? this.books[id].size() : 0 }); }
      for (const l of list) l.share = total > 0 ? l.vol5m / total : 0;
      return { mode: this.mode, exchanges: list, indexSources: this.indexSources || 0, uptime: now - this.startedAt, usdtRate: this.usdtRate, icons: this.icons || {} };
    }

    recompute(now, force) {
      if (force || now - this._lastAnalysisAt >= 250) {
        this._lastAnalysisAt = now;
        for (const tf of this.chartTfs) {
          const chart = this.series[tf].candles;
          if (chart.length < 5) continue;
          const st = this.tfState[tf];
          const prev = st.analysis;
          st.analysis = A.analyzeChart(chart, this.icfg);
          this._checkAlerts(tf, st, prev, st.analysis, now);
        }
      }
      if (force || now - this._lastScanAt >= 2000) {
        this._lastScanAt = now;
        const sc = A.scanTrends(this.series, this.icfg);
        const pct = A.pctChanges(this.series, this.index, now);
        const scKey = JSON.stringify(sc.map(s => [s.bull, s.up]));
        if (scKey !== this._scKey) { this._scKey = scKey; this.scanner = sc; this.emit('message', { type: 'scanner', scanner: sc }); }
        this.pct = pct; this.emit('message', { type: 'pct', pct });
      }
    }
    _checkAlerts(tf, st, prev, cur, now) {
      const al = this.cfg.alerts || {};
      const n = cur.rsi.length - 1; const r = cur.rsi[n];
      if (r != null && al.overboughtOversold !== false) {
        const ob = this.icfg.rsiOverbought, os = this.icfg.rsiOversold;
        const first = !prev; // no sound for the state found at startup
        if (st.rsiState !== 'ob' && r >= ob) { st.rsiState = 'ob'; if (!first) this.emit('message', { type: 'alert', tf, kind: 'overbought', value: r, ts: now }); }
        else if (st.rsiState !== 'os' && r <= os) { st.rsiState = 'os'; if (!first) this.emit('message', { type: 'alert', tf, kind: 'oversold', value: r, ts: now }); }
        else if (st.rsiState === 'ob' && r < ob - 3) st.rsiState = null;
        else if (st.rsiState === 'os' && r > os + 3) st.rsiState = null;
      }
      if (cur.condition) {
        const c = cur.condition.state;
        if (st.lastConditionState && c !== st.lastConditionState && al.conditionChange !== false) {
          this.emit('message', { type: 'alert', tf, kind: c.toLowerCase(), value: cur.condition.rsi, ts: now, price: cur.condition.price });
        }
        st.lastConditionState = c;
      }
      if (cur.markers.length && al.reversal !== false) {
        const m = cur.markers[cur.markers.length - 1];
        const key = m.type + ':' + m.at;
        if (st.lastMarkerKey && key !== st.lastMarkerKey && now - m.at < C.TIMEFRAMES[tf] * 2) {
          this.emit('message', { type: 'alert', tf, kind: 'reversal', side: m.type, value: m.price, ts: now });
        }
        st.lastMarkerKey = key;
      }
    }

    // ------------------------------------------------------------------ messages
    vol1m() { let total = 0, buy = 0, sell = 0, usd = 0; for (const t of this.recentTrades) { total += t.qty; usd += t.usd; if (t.side === 'buy') buy += t.qty; else sell += t.qty; } return { total, buy, sell, usd }; }
    _emitTick(tf, now, closed) {
      const s = this.series[tf]; const c = s.last; if (!c) return;
      const a = this.tfState[tf].analysis; const n = a ? a.ema.length - 1 : -1;
      const s5 = this.series['5m'].candles;
      const ch = I.pctChange(s5, C.DAY, now, this.index);
      const ref = this.ex[this.refExchange];
      const tick = {
        type: 'tick', tf, t: now, p: this.index, ref: ref && now - ref.ts < 120000 ? ref.last : null,
        candle: { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, bv: c.bv },
        closeIn: c.t + s.tfMs - now, closed,
        ema: a ? a.ema[n] : null, rsi: a ? a.rsi[n] : null, mw: a ? a.mw[n] : null, sig: a ? a.sig[n] : null,
        pending: a ? a.pending : null,
        vol1m: this.vol1m(),
        change24h: ch == null ? null : { pct: ch, abs: this.index - this.index / (1 + ch / 100) },
        sources: this.indexSources || 0,
      };
      this.emit('message', tick);
    }
    /** Chart series + analysis for one timeframe (last `chartCandles` candles). */
    analysisMessage(tf) {
      tf = this.tfState[tf] ? tf : this.chartTf;
      const s = this.series[tf]; const a = this.tfState[tf].analysis;
      const candles = s.candles; const start = Math.max(0, candles.length - this.chartCandles);
      const rows = [];
      for (let i = start; i < candles.length; i++) { const c = candles[i]; rows.push({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, bv: c.bv, ema: a ? a.ema[i] : null, rsi: a ? a.rsi[i] : null, mw: a ? a.mw[i] : null, sig: a ? a.sig[i] : null }); }
      return { type: 'analysis', tf, tfMs: s.tfMs, candles: rows, zones: a ? a.zones : null, markers: a ? a.markers : [], pending: a ? a.pending : null, condition: a ? a.condition : null, base: this.historyBases ? this.historyBases[tf] : null };
    }
    snapshot(tf) {
      tf = this.tfState[tf] ? tf : this.chartTf;
      return {
        type: 'snapshot',
        meta: { symbol: this.cfg.symbolLabel || 'Bitcoin / U.S. Dollar', tf, tfMs: C.TIMEFRAMES[tf], timeframes: this.chartTfs, mode: this.mode, visibleCandles: this.cfg.visibleCandles || 300, indicators: this.icfg, orderBook: this.obcfg, alerts: this.cfg.alerts || {}, refExchange: this.refExchange, icons: this.icons || {} },
        analysis: this.analysisMessage(tf),
        scanner: this.scanner, pct: this.pct,
        book: this.bookProfile(), orders: this.feed,
        liq: { totals: this.liqTotals(), recent: this.liqEvents.slice(-25).reverse() },
        assets: this.assetList(), calendar: this.calendarState(), status: this.statusState(),
        price: this.index,
      };
    }
  }

  return { Engine, LocalBook, Emitter, EXCHANGE_NAMES };
});

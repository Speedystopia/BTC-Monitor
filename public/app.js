/* ============================================================================
 *  public/app.js — dashboard application (state, panels, server connection)
 *  One page shows one timeframe: open /?tf=15m, /?tf=1h, /?tf=4h ...
 * ========================================================================== */
window.BTCM_APP = (function () {
  'use strict';
  const U = window.BTCM_UTIL, CH = window.BTCM_CHART, AU = window.BTCM_AUDIO;
  const $ = U.el;

  const state = {
    tf: null, meta: null, candles: [], zones: null, markers: [], pending: null, condition: null, tfMs: 300000,
    tick: null, book: null, orders: [], liq: { totals: null, recent: [] }, assets: [], calendar: null, status: null, scanner: [], pct: [],
    icons: {}, connected: false, lastMsgAt: 0,
    heat: { step: 10, cols: new Map(), version: 0 }, // liquidity heatmap: candle time -> { t, b0, s, q }
  };
  let chart, osc, dirty = true;
  const REF_LABELS = { coinbase: 'CB', binance: 'BN', kraken: 'KR', bybit: 'BB', okx: 'OKX', bitstamp: 'BS' };

  // ------------------------------------------------------------------ icons
  // Brand colours + monograms used when a logo could not be downloaded.
  const BRAND = { binance: ['#F3BA2F', '#000', 'B'], coinbase: ['#0052FF', '#fff', 'C'], kraken: ['#5741D9', '#fff', 'K'], bybit: ['#F7A600', '#000', 'By'], okx: ['#2a2a2a', '#fff', 'OKX'], bitstamp: ['#0B9B4B', '#fff', 'BS'],
    btc: ['#F7931A', '#fff', '₿'], eth: ['#627EEA', '#fff', 'Ξ'], xrp: ['#23292F', '#fff', '✕'], sol: ['#9945FF', '#fff', 'S'], gold: ['#D4AF37', '#000', 'Au'], sp500: ['#C62828', '#fff', '500'], dxy: ['#2E7D32', '#fff', '$'] };
  const fallbackCache = Object.create(null);
  function fallbackIcon(key) {
    if (fallbackCache[key]) return fallbackCache[key];
    const [bg, fg, txt] = Object.prototype.hasOwnProperty.call(BRAND, key) ? BRAND[key] : ['#555', '#fff', String(key || '?').slice(0, 2).toUpperCase()];
    const size = txt.length >= 3 ? 9 : txt.length === 2 ? 12 : 15;
    // escaped: an asset label with & < ' would otherwise break the SVG or the inline onerror handler
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="${bg}"/><text x="16" y="17" text-anchor="middle" dominant-baseline="central" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="${size}" fill="${fg}">${U.escapeHtml(txt)}</text></svg>`;
    return (fallbackCache[key] = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg));
  }
  function iconSrc(key) { return state.icons[key] || fallbackIcon(key); }
  function iconImg(key, cls, title) { const fb = fallbackIcon(key); return `<img class="${cls || 'exic'}" src="${iconSrc(key)}" alt="${U.escapeHtml(key)}" title="${U.escapeHtml(title || key)}" onerror="this.onerror=null;this.src='${fb}'">`; }

  // ------------------------------------------------------------------ messages
  function handle(msg) {
    state.lastMsgAt = Date.now();
    switch (msg.type) {
      case 'snapshot': {
        state.meta = msg.meta; state.tf = msg.meta.tf; state.tfMs = msg.meta.tfMs; state.icons = msg.meta.icons || {};
        applyAnalysis(msg.analysis);
        state.scanner = msg.scanner || []; state.pct = msg.pct || []; state.book = msg.book; chart.book = msg.book; state.orders = msg.orders || [];
        state.liq = msg.liq || state.liq; state.assets = msg.assets || []; state.calendar = msg.calendar; state.status = msg.status;
        if (msg.price) state.tick = Object.assign({}, state.tick || {}, { p: msg.price });
        chart.visible = osc.visible = Math.min(msg.meta.visibleCandles || 300, Math.max(40, state.candles.length)); chart.tfMs = msg.meta.tfMs;
        chart.refLabel = REF_LABELS[msg.meta.refExchange] || (msg.meta.refExchange || '').slice(0, 3).toUpperCase();
        chart.sessions = msg.meta.sessions || null;
        state.heat = { step: msg.heat ? msg.heat.step : 10, cols: new Map(), version: 0 }; chart.heat = state.heat;
        if (msg.heat) addHeat(msg.heat.cols);
        if (!viewReady) initView(msg.meta);
        renderMeta(); renderTfSwitcher(); renderScanner(); renderPct(); renderOrders(); renderLiq(); renderAssets(); renderCalendar(); renderStatus();
        document.title = `BTC ${U.tfShort(state.tf)} — Bitcoin Live Educational Pro Chart`;
        break;
      }
      case 'analysis': if (msg.tf === state.tf) { applyAnalysis(msg); renderMeta(); pruneHeat(); } break;
      case 'heat': if (msg.tf === state.tf) addHeat(msg.cols); break;
      case 'tick': if (msg.tf === state.tf) applyTick(msg); break;
      case 'scanner': state.scanner = msg.scanner; renderScanner(); break;
      case 'pct': state.pct = msg.pct; renderPct(); break;
      case 'book': state.book = msg; chart.book = msg; dirty = true; break;
      case 'orders': state.orders = msg.rows; renderOrders(); break;
      case 'liq': state.liq.totals = msg.totals; state.liq.recent.unshift(msg.event); state.liq.recent.length = Math.min(state.liq.recent.length, 25); renderLiq(); break;
      case 'assets': state.assets = msg.assets; renderAssets(); break;
      case 'calendar': state.calendar = msg.calendar; renderCalendar(); break;
      case 'status': state.status = msg.status; if (msg.status.icons) { const before = Object.keys(state.icons).length; state.icons = msg.status.icons; if (Object.keys(state.icons).length !== before) { renderOrders(); renderAssets(); renderLogo(); } } renderStatus(); break;
      case 'alert': if (!msg.tf || msg.tf === state.tf) onAlert(msg); break;
      default: break;
    }
  }
  function applyAnalysis(a) {
    if (!a) return;
    state.candles = a.candles || []; state.zones = a.zones; state.markers = a.markers || []; state.pending = a.pending; state.condition = a.condition; state.tfMs = a.tfMs || state.tfMs;
    chart.setSeries(state.candles, state.zones, state.markers, state.pending, state.condition); chart.tfMs = state.tfMs; osc.candles = state.candles;
    dirty = true;
  }
  /** Heatmap columns from the server: { t, b0, s, d (base64 bytes) }. */
  function addHeat(cols) {
    for (const c of cols || []) {
      const bin = atob(c.d), q = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) q[i] = bin.charCodeAt(i);
      state.heat.cols.set(c.t, { t: c.t, b0: c.b0, s: c.s, q });
    }
    state.heat.version++; dirty = true;
  }
  function pruneHeat() { const first = state.candles.length ? state.candles[0].t : 0; for (const t of state.heat.cols.keys()) if (t < first) state.heat.cols.delete(t); }
  function applyTick(t) {
    state.tick = t; chart.tick = t;
    const c = state.candles; const last = c[c.length - 1];
    if (last && t.candle) {
      if (t.candle.t === last.t) { Object.assign(last, t.candle, { ema: t.ema, rsi: t.rsi, mw: t.mw, sig: t.sig }); }
      else if (t.candle.t > last.t) { c.push(Object.assign({}, t.candle, { ema: t.ema, rsi: t.rsi, mw: t.mw, sig: t.sig })); }
    }
    chart.pending = t.pending;
    $('symVol').textContent = t.candle ? t.candle.v.toFixed(1) : '—';
    $('price').textContent = U.fmtPrice(t.p, 2);
    const ch = $('change');
    if (t.change24h) { ch.textContent = `${U.fmtSigned(t.change24h.abs)} (${U.fmtPct(t.change24h.pct)})`; ch.className = 'chg num ' + (t.change24h.pct >= 0 ? 'up' : 'down'); } else ch.textContent = '';
    $('traded').textContent = t.vol1m ? t.vol1m.total.toFixed(3) : '—';
    if (t.vol1m && t.vol1m.total > 0) { const b = t.vol1m.buy / t.vol1m.total * 100; $('gaugeBuy').style.width = b.toFixed(1) + '%'; $('gaugeSell').style.width = (100 - b).toFixed(1) + '%'; }
    const rb = $('rsibox'); const ob = state.meta ? state.meta.indicators.rsiOverbought : 70, os = state.meta ? state.meta.indicators.rsiOversold : 30;
    rb.querySelector('.v').textContent = t.rsi != null ? t.rsi.toFixed(2) : '—';
    rb.classList.toggle('ob', t.rsi != null && t.rsi >= ob); rb.classList.toggle('os', t.rsi != null && t.rsi <= os);
    $('nodata').classList.add('hidden');
    dirty = true;
  }

  // ------------------------------------------------------------------ panels
  function renderMeta() {
    const m = state.meta; if (!m) return;
    $('symName').textContent = m.symbol; $('symTf').textContent = U.tfShort(state.tf);
    const [s, l] = U.tfName(state.tf); $('tfShort').textContent = s; $('tfLong').textContent = l;
    const c = state.condition; const lc = $('lastchange');
    if (c) { lc.querySelector('.st').textContent = c.state; lc.querySelector('.st').className = 'st ' + c.state; lc.querySelector('.ago').textContent = U.fmtMinAgo(Date.now() - (c.since + state.tfMs)); }
    const srcs = state.status ? state.status.exchanges.filter(e => e.status === 'ok').length : 0;
    $('symSrc').textContent = `Composite · ${srcs} exchange${srcs === 1 ? '' : 's'}`;
  }
  function renderTfSwitcher() {
    const m = state.meta; const el = $('tfSwitch'); if (!m || !el) return;
    el.innerHTML = (m.timeframes || []).map(tf => `<a href="?tf=${tf}" data-tf="${tf}" class="${tf === state.tf ? 'cur' : ''}" title="Open the ${U.tfName(tf)[1].toLowerCase()} in this page (Ctrl/Cmd+click for a new tab)">${U.tfShort(tf)}</a>`).join('');
  }
  function renderScanner() {
    const rows = state.scanner || [];
    $('scannerRows').innerHTML = rows.map(r => `<div class="sr"><span class="dot ${r.bull == null ? '' : r.bull ? 'bull' : 'bear'}"></span><span class="arr ${r.up == null ? 'na' : ''}">${r.up == null ? '·' : r.up ? '⬆' : '⬇'}</span><span class="tf">${r.label}</span></div>`).join('');
  }
  function renderPct() {
    $('pct').innerHTML = (state.pct || []).map(p => `<div class="pr"><span class="pl">${p.label}</span><span class="pv ${p.value == null ? 'flat' : p.value >= 0 ? 'up' : 'down'}">${U.fmtPct(p.value)}</span></div>`).join('');
  }
  function renderOrders() {
    const rows = state.orders || []; const now = Date.now();
    const max = rows.reduce((m, r) => Math.max(m, r.usd), 1);
    const names = { binance: 'Binance', coinbase: 'Coinbase', kraken: 'Kraken', bybit: 'Bybit', okx: 'OKX', bitstamp: 'Bitstamp' };
    const html = rows.map(r => {
      const side = (r.side === 'bid' || r.side === 'buy') ? 'bid' : 'ask';
      const a = 0.22 + 0.7 * Math.min(1, r.usd / max);
      const cls = `row ${side} ${r.kind} ${r.removed ? 'removed' : ''} ${r.usd >= max * 0.6 ? 'big' : ''}`;
      const what = r.kind === 'trade' ? 'market trade' : r.removed ? 'order pulled / filled' : 'resting order';
      const mark = r.kind === 'trade' ? '<span class="mk trade">⚡</span>' : r.removed ? '<span class="mk removed">✕</span>' : '';
      return `<div class="${cls}" style="--a:${a.toFixed(2)}" data-ts="${r.ts}">${iconImg(r.ex, 'exic', `${names[r.ex] || r.ex} — ${what}`)}<span class="price">${mark}${U.fmtPrice(r.price, 1)}</span><span class="usd">${U.fmtUsd(r.usd)}</span><span class="age">${U.fmtAge(now - r.ts)}</span></div>`;
    }).join('');
    $('feedRows').innerHTML = html;
    const active = rows.filter(r => r.kind === 'order' && !r.removed);
    const bids = active.filter(r => r.side === 'bid').reduce((s, r) => s + r.usd, 0), asks = active.filter(r => r.side === 'ask').reduce((s, r) => s + r.usd, 0);
    $('feedStats').innerHTML = `<span class="up">${U.fmtK(bids)}</span> / <span class="down">${U.fmtK(asks)}</span>`;
  }
  function refreshAges() {
    const now = Date.now();
    for (const el of document.querySelectorAll('#feedRows .row')) { const ts = +el.dataset.ts; el.querySelector('.age').textContent = U.fmtAge(now - ts); }
    if (state.condition) $('lastchange').querySelector('.ago').textContent = U.fmtMinAgo(now - (state.condition.since + state.tfMs));
    renderCalendarCountdown();
  }
  function renderLiq() {
    const t = state.liq && state.liq.totals; if (!t) return;
    $('liqTotal').textContent = U.fmtK(t.total); $('liqLong').textContent = U.fmtK(t.long); $('liqShort').textContent = U.fmtK(t.short);
    const last = state.liq.recent && state.liq.recent[0];
    $('liqLast').textContent = last ? `last: ${last.side.toUpperCase()} ${U.fmtUsd(last.usd)} @ ${U.fmtPrice(last.price, 0)} (${U.fmtAge(Date.now() - last.ts)})` : '';
  }
  function renderAssets() {
    const list = state.assets || [];
    $('assets').innerHTML = list.map(a => {
      const ic = (a.icon || guessIcon(a.label));
      return `<div class="asset">${iconImg(ic, 'ic', a.label)}<span class="lbl">${U.escapeHtml(a.label)}</span><span class="px num">${a.price != null ? U.fmtPrice(a.price) : '—'}</span><span class="pct num ${a.pct == null ? 'flat' : a.pct >= 0 ? 'up' : 'down'}">${U.fmtPct(a.pct)}</span></div>`;
    }).join('');
  }
  function renderLogo() { const l = $('logo'); if (l) l.innerHTML = iconImg('btc', 'logoimg', 'Bitcoin'); }
  function guessIcon(label) { const l = label.toLowerCase(); if (l.startsWith('eth')) return 'eth'; if (l.startsWith('xrp')) return 'xrp'; if (l.startsWith('sol')) return 'sol'; if (l.includes('gold') || l.includes('xau')) return 'gold'; if (l.includes('sp') || l.includes('spx')) return 'sp500'; if (l.includes('dxy') || l.includes('dollar')) return 'dxy'; return l.slice(0, 3); }
  function renderCalendar() {
    const c = state.calendar; const el = $('eventline');
    const next = c && c.next;
    if (!next) { el.innerHTML = 'Next Economic Event <span class="flag">🌐</span><span class="ev-title">no upcoming events</span>'; return; }
    el.innerHTML = `Next Economic Event <span class="flag">${next.flag || '🌐'}</span><span class="ev-title imp-${next.impact}">${U.escapeHtml(next.title)}</span> : <span class="cd">${U.fmtCountdown(next.time - Date.now())}</span>`;
    el.title = (c.upcoming || []).slice(0, 8).map(e => `${e.flag || ''} ${new Date(e.time).toLocaleString()} — ${e.title} (${e.impact})`).join('\n');
  }
  function renderCalendarCountdown() {
    const c = state.calendar; if (!c || !c.next) return;
    const cd = $('eventline').querySelector('.cd'); if (!cd) return;
    const left = c.next.time - Date.now();
    if (left < -60000) { // event passed: advance locally until the server refreshes
      const up = (c.upcoming || []).filter(e => e.time > Date.now() - 60000); c.next = up[0] || null; c.upcoming = up; renderCalendar(); return;
    }
    cd.textContent = U.fmtCountdown(left);
  }
  function renderStatus() {
    const s = state.status; if (!s) return;
    $('sources').innerHTML = s.exchanges.map(e => {
      const cls = e.status === 'ok' && e.lastTradeAgo != null && e.lastTradeAgo < 60000 ? 'ok' : (e.status === 'ok' ? 'warn' : 'bad');
      const share = e.share ? ` ${(e.share * 100).toFixed(0)}%` : '';
      return `<span title="${e.status} ${U.escapeHtml(e.detail || '')} · last trade ${U.fmtAge(e.lastTradeAgo)} ago · book ${e.book} levels">${iconImg(e.id, 'srcic', e.name)}<i class="${cls}"></i><b class="nm">${U.escapeHtml(e.name)}</b>${share}</span>`;
    }).join('');
    renderMeta();
  }
  let toastTimer = null;
  function onAlert(a) {
    const t = $('toast'); const label = { overbought: 'RSI OVERBOUGHT', oversold: 'RSI OVERSOLD', bullish: 'MARKET CONDITION → BULLISH', bearish: 'MARKET CONDITION → BEARISH', reversal: `POSSIBLE ${a.side === 'bear' ? 'BEARISH' : 'BULLISH'} REVERSAL CONFIRMED` }[a.kind] || a.kind.toUpperCase();
    t.textContent = a.value != null && (a.kind === 'overbought' || a.kind === 'oversold') ? `${label} ${a.value.toFixed(1)}` : label;
    t.className = 'toast show ' + a.kind; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 6000);
    AU.play(a.kind);
  }

  // ------------------------------------------------------------------ display options
  // On by default when enabled in config.js; the keyboard (H, S) and the status-bar buttons toggle them (remembered
  // by this browser); the URL wins (?heatmap=0&sessions=1), handy for OBS browser sources.
  const view = { heatmap: true, sessions: true };
  const VIEW_BTN = { heatmap: 'heatBtn', sessions: 'sessBtn' };
  let viewReady = false;
  const stored = (k) => { try { return localStorage.getItem('btcm.' + k); } catch (e) { return null; } };
  function initView(meta) {
    viewReady = true;
    const url = new URLSearchParams(location.search);
    const conf = { heatmap: !!(meta.heatmap && meta.heatmap.enabled), sessions: !(meta.sessions && meta.sessions.enabled === false) };
    for (const k of Object.keys(view)) { const s = stored(k); view[k] = url.has(k) ? url.get(k) !== '0' : s != null ? s === '1' : conf[k]; }
    if (meta.alerts && meta.alerts.audio === false) { AU.setEnabled(false); syncAudioUi(); } // config.js alerts.audio
    $('heatBtn').classList.toggle('hidden', !conf.heatmap); // heatmap disabled in config.js: no data is collected
    applyView();
  }
  function toggleView(k) { view[k] = !view[k]; try { localStorage.setItem('btcm.' + k, view[k] ? '1' : '0'); } catch (e) { /* storage unavailable */ } applyView(); }
  function applyView() {
    chart.showSessions = view.sessions; chart.showHeat = view.heatmap;
    for (const k of Object.keys(VIEW_BTN)) { const b = $(VIEW_BTN[k]); if (b) b.classList.toggle('off', !view[k]); }
    dirty = true;
  }
  function syncAudioUi() {
    const ab = $('alertsBtn');
    ab.textContent = AU.isEnabled() ? 'ALERTS ACTIVE' : 'ALERTS MUTED'; ab.classList.toggle('off', !AU.isEnabled());
    $('audioBtn').classList.toggle('hidden', !AU.isEnabled() || AU.isUnlocked());
  }

  // ------------------------------------------------------------------ server connection
  function pageTf() { const p = new URLSearchParams(location.search); return (p.get('tf') || '').toLowerCase(); }
  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const tf = pageTf();
    const url = `${proto}://${location.host}/ws${tf ? '?tf=' + encodeURIComponent(tf) : ''}`;
    let ws; let retry = 1000;
    const open = () => {
      ws = new WebSocket(url);
      ws.onopen = () => { state.connected = true; retry = 1000; $('nodataSub').textContent = 'connected · waiting for the first trades…'; };
      ws.onmessage = (ev) => { try { handle(JSON.parse(ev.data)); } catch (e) { console.error(e); } };
      ws.onclose = () => { state.connected = false; $('nodata').classList.remove('hidden'); $('nodataSub').textContent = 'server connection lost — reconnecting…'; setTimeout(open, retry); retry = Math.min(retry * 2, 15000); };
      ws.onerror = () => { try { ws.close(); } catch (e) { /* ignore */ } };
    };
    open();
  }

  // ------------------------------------------------------------------ render loop
  function loop() {
    if (dirty) { dirty = false; try { chart.render(); osc.render(); } catch (e) { console.error(e); } }
    requestAnimationFrame(loop);
  }
  function start() {
    chart = new CH.ChartRenderer($('chart')); osc = new CH.OscRenderer($('osc'));
    window.addEventListener('resize', () => { dirty = true; });
    new ResizeObserver(() => { dirty = true; }).observe($('chartwrap'));
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { dirty = true; });
    renderLogo();
    // zoom with the mouse wheel
    $('chartwrap').addEventListener('wheel', (e) => { e.preventDefault(); const v = Math.round(chart.visible * (e.deltaY > 0 ? 1.15 : 0.87)); chart.visible = osc.visible = Math.max(40, Math.min(state.candles.length || 900, v)); dirty = true; }, { passive: false });
    // audio (default: config.js alerts.audio, applied with the first snapshot)
    const btn = $('audioBtn'), ab = $('alertsBtn');
    const tryUnlock = () => { AU.unlock(); setTimeout(syncAudioUi, 200); };
    document.addEventListener('pointerdown', tryUnlock);
    document.addEventListener('keydown', tryUnlock);
    btn.addEventListener('click', () => { AU.unlock(); AU.play('click'); setTimeout(syncAudioUi, 300); });
    ab.addEventListener('click', (e) => { e.stopPropagation(); AU.setEnabled(!AU.isEnabled()); if (AU.isEnabled()) { AU.unlock(); AU.play('click'); } syncAudioUi(); });
    setTimeout(() => { AU.unlock(); syncAudioUi(); }, 500);
    // display options: buttons + keyboard (M: mute alerts, H: heatmap, S: sessions)
    for (const k of Object.keys(VIEW_BTN)) $(VIEW_BTN[k]).addEventListener('click', (e) => { e.stopPropagation(); toggleView(k); });
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = (e.key || '').toLowerCase();
      if (k === 'm') ab.click(); else if (k === 'h') toggleView('heatmap'); else if (k === 's') toggleView('sessions');
    });

    setInterval(refreshAges, 1000);
    setInterval(() => { if (state.tick && Date.now() - state.lastMsgAt > 15000) { $('nodata').classList.remove('hidden'); $('nodataSub').textContent = 'no market data received for 15 s'; } }, 5000);
    $('nodata').classList.remove('hidden');
    connectWs();
    requestAnimationFrame(loop);
  }

  return { start, state, handle };
})();

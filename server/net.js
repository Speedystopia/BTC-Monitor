'use strict';
/* ============================================================================
 *  server/net.js — outbound HTTP + WebSocket helpers (optional proxy support)
 * ========================================================================== */
const WebSocket = require('ws');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 btc-monitor/1.0';

let wsAgent = null;     // WebSocket proxy agent (https-proxy-agent)
let dispatcher = null;  // fetch proxy dispatcher (undici)
let proxyFetch = null;  // undici's own fetch: the global one may embed another undici version

// Extra root certificates (TLS-inspecting corporate proxy) are taken from NODE_EXTRA_CA_CERTS by Node itself.
function configure(cfg) {
  const proxyUrl = (cfg && cfg.proxy) || '';
  if (!proxyUrl) return;
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    wsAgent = new HttpsProxyAgent(proxyUrl);
  } catch (e) {
    console.warn('[net] proxy configured but "https-proxy-agent" is not installed: npm i https-proxy-agent@7');
  }
  try {
    const undici = require('undici');
    dispatcher = new undici.ProxyAgent(proxyUrl);
    proxyFetch = undici.fetch;
  } catch (e) {
    console.warn('[net] proxy configured but "undici" is not installed: npm i undici');
  }
}

/** fetch through the proxy dispatcher when one is configured. */
function doFetch(url, init) { return dispatcher && proxyFetch ? proxyFetch(url, Object.assign(init, { dispatcher })) : fetch(url, init); }

/** fetch JSON with timeout (uses the proxy dispatcher when configured). */
async function getJson(url, opts) {
  const o = Object.assign({ timeout: 15000 }, opts || {});
  const r = await doFetch(url, { headers: Object.assign({ 'User-Agent': UA, 'Accept': 'application/json,text/plain,*/*' }, o.headers || {}), signal: AbortSignal.timeout(o.timeout) });
  const txt = await r.text();
  if (!r.ok) { const err = new Error(`HTTP ${r.status} ${url.slice(0, 80)}: ${txt.slice(0, 120)}`); err.status = r.status; throw err; }
  try { return JSON.parse(txt); } catch (e) { throw new Error('bad JSON from ' + url.slice(0, 80)); }
}

/** fetch binary content (images). Follows redirects. Returns { buffer, contentType }. */
async function getBytes(url, opts) {
  const o = Object.assign({ timeout: 20000 }, opts || {});
  const r = await doFetch(url, { headers: { 'User-Agent': UA, 'Accept': 'image/*,*/*' }, signal: AbortSignal.timeout(o.timeout), redirect: 'follow' });
  if (!r.ok) { const err = new Error(`HTTP ${r.status} ${url.slice(0, 80)}`); err.status = r.status; throw err; }
  return { buffer: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') || 'application/octet-stream' };
}

function openWebSocket(url, headers) {
  const opts = { headers: Object.assign({ 'User-Agent': UA }, headers || {}), handshakeTimeout: 15000, perMessageDeflate: false };
  if (wsAgent) opts.agent = wsAgent;
  return new WebSocket(url, opts);
}

/**
 * Reconnecting WebSocket with subscriptions, ping and stale watchdog.
 *  opts: { name, url, onOpen(ws), onMessage(msg, ws), pingEvery, pingPayload (string|function), staleMs, onStatus(status, detail) }
 */
class ReconnectingWS {
  constructor(opts) {
    this.o = Object.assign({ pingEvery: 0, staleMs: 60000 }, opts);
    this.ws = null; this.closed = false; this.backoff = 1000; this.lastMsg = 0; this.timers = [];
    this.refusals = 0; // consecutive handshakes answered with an HTTP error (e.g. 403 / 451 in a blocked region)
    this.connect();
  }
  status(s, d) { if (this.o.onStatus) this.o.onStatus(s, d); }
  connect() {
    if (this.closed) return;
    this.status('connecting');
    let ws;
    try { ws = openWebSocket(this.o.url); } catch (e) { this.status('error', e.message); return this.scheduleReconnect(); }
    this.ws = ws;
    let refused = null; // "HTTP 403": kept as the disconnect detail instead of the generic abort message
    ws.on('open', () => {
      this.backoff = 1000; this.refusals = 0; this.lastMsg = Date.now(); this.status('connected');
      try { this.o.onOpen && this.o.onOpen(ws); } catch (e) { console.error(`[${this.o.name}] onOpen`, e); }
      if (this.o.pingEvery) this.timers.push(setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const p = typeof this.o.pingPayload === 'function' ? this.o.pingPayload() : this.o.pingPayload;
        try { if (p == null) ws.ping(); else ws.send(p); } catch (e) { /* ignore */ }
      }, this.o.pingEvery));
      this.timers.push(setInterval(() => {
        if (Date.now() - this.lastMsg > this.o.staleMs) { this.status('stale'); try { ws.terminate(); } catch (e) { /* ignore */ } }
      }, 5000));
    });
    ws.on('message', (data) => {
      this.lastMsg = Date.now();
      let msg = data;
      if (typeof data !== 'string') msg = data.toString();
      try { this.o.onMessage(msg, ws); } catch (e) { console.error(`[${this.o.name}] onMessage`, e.message); }
    });
    ws.on('ping', () => { this.lastMsg = Date.now(); });
    ws.on('pong', () => { this.lastMsg = Date.now(); });
    ws.on('error', (e) => { if (!refused) this.status('error', e.message); });
    ws.on('close', (code, reason) => { this.cleanup(); this.status('disconnected', refused || `${code} ${reason || ''}`.trim()); this.scheduleReconnect(); });
    ws.on('unexpected-response', (req, res) => { refused = `HTTP ${res.statusCode}`; this.refusals++; this.status('error', refused); try { ws.terminate(); } catch (e) { /* ignore */ } });
  }
  cleanup() { for (const t of this.timers) clearInterval(t); this.timers = []; }
  scheduleReconnect() {
    if (this.closed) return;
    // a server that keeps refusing the handshake is retried every 5 minutes at most, not every 30 s
    const delay = this.backoff; this.backoff = Math.min(this.backoff * 2, this.refusals >= 3 ? 300000 : 30000);
    setTimeout(() => this.connect(), delay);
  }
  send(obj) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
  reconnect() { try { this.ws && this.ws.terminate(); } catch (e) { /* ignore */ } }
  close() { this.closed = true; this.cleanup(); try { this.ws && this.ws.terminate(); } catch (e) { /* ignore */ } }
}

module.exports = { configure, getJson, getBytes, openWebSocket, ReconnectingWS, UA };

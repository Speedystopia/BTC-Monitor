'use strict';
/* ============================================================================
 *  server/http.js — the dashboard server: static files, JSON API and the
 *  WebSocket that streams the engine messages to the pages.
 *    createApp({ engine, icons, readStatic, log }) -> { server, wss, close }
 *  (listening is left to the caller: server.listen(port, host))
 * ========================================================================== */
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.txt': 'text/plain; charset=utf-8' };

// Slow clients (weak connection, busy OBS source): past DROP_AT bytes not yet sent they skip the messages that
// the next one replaces anyway; past KILL_AT they are disconnected (the page reconnects and gets a snapshot).
const DROP_AT = 256 * 1024, KILL_AT = 32 * 1024 * 1024;
// full current state in every message: skipping one loses nothing. Never skipped: snapshot, analysis (closed
// candles), liq (events), alert, calendar, and the heat / tick messages of a candle that just closed.
const REPLACEABLE = new Set(['tick', 'book', 'orders', 'pct', 'scanner', 'assets', 'status', 'heat']);

/** What to do with `msg` for a client that has `buffered` bytes not yet sent: 'send' | 'skip' | 'close'. */
function sendPolicy(msg, buffered) {
  if (buffered >= KILL_AT) return 'close';
  if (buffered >= DROP_AT && REPLACEABLE.has(msg.type) && !msg.closed) return 'skip';
  return 'send';
}

function createApp({ engine, icons, readStatic, log }) {
  const tfOf = (url) => { const tf = (url.searchParams.get('tf') || '').toLowerCase(); return engine.hasTf(tf) ? tf : engine.chartTf; };
  const json = (res, obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/state') return json(res, engine.snapshot(tfOf(url)));
    if (url.pathname === '/api/health') return json(res, { ok: true, price: engine.index, status: engine.statusState() });
    if (url.pathname.startsWith('/icons/')) return icons.serve(url.pathname.slice(7).replace(/[^a-z0-9_-]/gi, ''), res);
    let file;
    try { file = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end('bad request'); }
    if (file.includes('..')) { res.writeHead(403); return res.end('forbidden'); }
    readStatic('public' + file, (err, data) => {
      if (err) { res.writeHead(err.message === 'forbidden' ? 403 : 404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 }); // clients only send tiny control messages
  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.tf = tfOf(new URL(req.url, 'http://localhost')); // one page = one timeframe (?tf=15m)
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => { /* the socket is closed right after; nothing else to do */ });
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw);
        if (m.type === 'hello' && engine.hasTf(m.tf)) ws.tf = m.tf;
        if (m.type === 'snapshot' || m.type === 'hello') ws.send(JSON.stringify(engine.snapshot(ws.tf)));
      } catch (e) { /* ignore */ }
    });
    ws.send(JSON.stringify(engine.snapshot(ws.tf)));
    log(`client connected (${wss.clients.size}) tf=${ws.tf} from ${req.socket.remoteAddress}`);
  });
  const heartbeat = setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 30000);

  const stopBroadcast = engine.on('message', (msg) => {
    if (!wss.clients.size) return;
    let data = null; // serialised lazily: timeframe-specific messages only go to the pages showing that timeframe
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN || (msg.tf && msg.tf !== ws.tf)) continue;
      const act = sendPolicy(msg, ws.bufferedAmount);
      if (act === 'skip') { ws.skipped = (ws.skipped || 0) + 1; continue; }
      if (act === 'close') { log(`client too slow (${Math.round(ws.bufferedAmount / 1048576)} MB waiting): disconnected, it will reconnect`); ws.terminate(); continue; }
      if (data === null) data = JSON.stringify(msg);
      ws.send(data);
    }
  });

  function close() {
    clearInterval(heartbeat); stopBroadcast();
    for (const ws of wss.clients) ws.terminate();
    wss.close(); server.close();
  }
  return { server, wss, close };
}

module.exports = { createApp, sendPolicy, MIME, DROP_AT, KILL_AT };

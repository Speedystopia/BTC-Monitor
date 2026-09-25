'use strict';
/* ============================================================================
 *  BTC MONITOR — server entry point
 *    node server/index.js            live multi-exchange data
 *    node server/index.js --sim      synthetic market (no internet needed)
 *    node server/index.js --port 9000
 *    node server/index.js --open     also open the dashboard in the browser
 *  (the same file is bundled into BTC-Monitor.exe by tools/build-exe.js)
 * ========================================================================== */
// In single-executable mode Node prints an informational warning whenever an optional module is
// probed with require() (ws looks for native add-ons it can live without): keep the console clean.
const _emitWarning = process.emitWarning;
process.emitWarning = function (w, ...rest) { if (typeof w === 'string' && w.includes('single-executable')) return; return _emitWarning.call(process, w, ...rest); };

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const { IS_EXE, ROOT, loadConfig, readStatic, openBrowser } = require('./paths');
const config = loadConfig();
const net = require('./net');
const { Engine } = require('../core/engine');
const { Simulator } = require('../core/sim');
const { loadHistory } = require('./history');
const { startCalendar } = require('./calendar');
const { startAssets } = require('./assets');
const { IconStore } = require('./icons');
const feeds = require('./feeds');

const args = process.argv.slice(1).filter(a => a !== process.execPath && !/[\\/]index\.js$/.test(a));
const SIM = args.includes('--sim') || process.env.SIM === '1';
const portArg = args.indexOf('--port');
const PORT = +(portArg >= 0 ? args[portArg + 1] : process.env.PORT || config.port || 8787);
const OPEN = args.includes('--open') || (IS_EXE && !args.includes('--no-open'));

const ts = () => new Date().toISOString().slice(11, 19);
const log = (tag) => (msg) => console.log(`${ts()} [${tag}] ${msg}`);
const mainLog = log('server');

net.configure(config);
const engine = new Engine(config);
const icons = new IconStore(ROOT, config, log('icons'));
engine.icons = icons.urls();
icons.refresh().then((map) => { engine.icons = map; mainLog(`icons ready: ${Object.keys(map).join(', ') || 'none (fallback monograms)'}`); }).catch(() => {});
const tfOf = (url) => { const tf = (url.searchParams.get('tf') || '').toLowerCase(); return engine.hasTf(tf) ? tf : engine.chartTf; };

// ---------------------------------------------------------------- liquidation persistence
const liqFile = path.join(ROOT, SIM ? 'data/liquidations-sim.json' : ((config.liquidations && config.liquidations.storeFile) || 'data/liquidations.json'));
try {
  if (fs.existsSync(liqFile)) { engine.loadLiquidations(JSON.parse(fs.readFileSync(liqFile, 'utf8'))); mainLog(`loaded ${engine.liqEvents.length} liquidation events from store`); }
} catch (e) { mainLog('could not read liquidation store: ' + e.message); }
let liqDirty = false;
engine.on('liq_persist', () => { liqDirty = true; });
setInterval(() => {
  if (!liqDirty) return; liqDirty = false;
  try { fs.mkdirSync(path.dirname(liqFile), { recursive: true }); fs.writeFileSync(liqFile, JSON.stringify(engine.liqEvents)); } catch (e) { mainLog('liquidation store write failed: ' + e.message); }
}, 20000);

// ---------------------------------------------------------------- HTTP static + API
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/state') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(engine.snapshot(tfOf(url)))); }
  if (url.pathname.startsWith('/icons/')) return icons.serve(url.pathname.slice(7).replace(/[^a-z0-9_-]/gi, ''), res);
  if (url.pathname === '/api/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, mode: engine.mode, price: engine.index, status: engine.statusState() })); }
  let file;
  try { file = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end('bad request'); }
  if (file.includes('..')) { res.writeHead(403); return res.end('forbidden'); }
  const rel = file.startsWith('/core/') ? file.slice(1) : 'public' + file;
  readStatic(rel, (err, data) => {
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
  mainLog(`client connected (${wss.clients.size}) tf=${ws.tf} from ${req.socket.remoteAddress}`);
});
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 30000);
engine.on('message', (msg) => {
  if (!wss.clients.size) return;
  let data = null; // serialised lazily: timeframe-specific messages only go to the pages showing that timeframe
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount >= 4e6) continue;
    if (msg.tf && msg.tf !== ws.tf) continue;
    if (data === null) data = JSON.stringify(msg);
    ws.send(data);
  }
});

// ---------------------------------------------------------------- data sources
async function startLive() {
  const enabled = Object.entries(config.exchanges || {}).filter(([id, c]) => c && c.enabled && feeds[id]);
  mainLog(`live mode — exchanges: ${enabled.map(([id]) => id).join(', ') || 'none'}`);
  mainLog('loading candle history…');
  const hist = await loadHistory(config, log('history'));
  const count = (tf) => Object.keys(hist[tf] || {}).length;
  mainLog('history sources — ' + Object.keys(hist).map(tf => `${tf}:${count(tf)}`).join(' '));
  if (!count('5m') && !count('1m')) mainLog('WARNING: no candle history could be loaded; the chart will build from live trades only');
  engine.seedHistory(hist);

  for (const [id, exCfg] of enabled) {
    const assets = (config.assets || []).filter(a => a.source === id);
    try { feeds[id].start({ engine, symbol: exCfg.symbol, log: log(id), assets }); } catch (e) { mainLog(`${id} failed to start: ${e.message}`); }
  }
  const liq = config.liquidations || {};
  if (liq.binance && feeds.binance.startLiquidations) feeds.binance.startLiquidations({ engine, log: log('binance') });
  if (liq.bybit && feeds.bybit.startLiquidations) feeds.bybit.startLiquidations({ engine, log: log('bybit') });
  if (liq.okx && feeds.okx.startLiquidations) feeds.okx.startLiquidations({ engine, log: log('okx') });

  startCalendar(config, engine, log('calendar'));
  startAssets(config, engine, log('assets'));

  if (config.normalizeUsdt) {
    const poll = async () => { try { const r = await feeds.kraken.usdtRate(); if (r) engine.setUsdtRate(r); } catch (e) { /* ignore */ } };
    poll(); setInterval(poll, 5 * 60000);
  }
}

function startSim() {
  mainLog('SIMULATION mode — synthetic market data');
  const sim = new Simulator(engine, { price: 78600, assets: (config.assets || []).map(a => a.label) });
  sim.seed();
  sim.start();
}

// ---------------------------------------------------------------- run
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    mainLog(`port ${PORT} is already in use — is BTC Monitor already running? (try --port 8788)`);
    if (OPEN) openBrowser(`http://localhost:${PORT}/`);
  } else mainLog('server error: ' + e.message);
  setTimeout(() => process.exit(1), IS_EXE ? 8000 : 0);
});
server.listen(PORT, () => {
  if (IS_EXE) mainLog(`BTC Monitor executable — folder: ${ROOT}`);
  mainLog(`dashboard: http://localhost:${PORT}  (timeframes: ${engine.chartTfs.map(tf => `?tf=${tf}`).join(' ')})`);
  if (OPEN) { openBrowser(`http://localhost:${PORT}/`); mainLog('opening the dashboard in your browser… keep this window open while streaming'); }
  setInterval(() => engine.tick(), 250);
  if (SIM) startSim(); else startLive().catch(e => { mainLog('startup error: ' + e.stack); });
});
process.on('uncaughtException', (e) => { console.error(`${ts()} [fatal] ${e.stack || e}`); });
process.on('unhandledRejection', (e) => { console.error(`${ts()} [rejection] ${(e && e.stack) || e}`); });

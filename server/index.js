'use strict';
/* ============================================================================
 *  BTC MONITOR — server entry point
 *    node server/index.js            live multi-exchange data
 *    node server/index.js --port 9000 --host 0.0.0.0
 *    node server/index.js --config other-config.js
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

const args = process.argv.slice(1).filter(a => a !== process.execPath && !/[\\/]index\.js$/.test(a));
/** Value of `--name value` or `--name=value`. */
const argValue = (name) => { const i = args.indexOf(name); if (i >= 0) return args[i + 1]; const a = args.find(x => x.startsWith(name + '=')); return a ? a.slice(name.length + 1) : undefined; };

const { IS_EXE, ROOT, loadConfig, readStatic, openBrowser } = require('./paths');
const config = loadConfig(argValue('--config'));
const net = require('./net');
const { Engine } = require('../core/engine');
const { loadHistory } = require('./history');
const { startCalendar } = require('./calendar');
const { startAssets } = require('./assets');
const { startClock } = require('./clock');
const { IconStore } = require('./icons');
const feeds = require('./feeds');

const OPEN = args.includes('--open') || (IS_EXE && !args.includes('--no-open'));

const ts = () => new Date().toISOString().slice(11, 19);
const log = (tag) => (msg) => console.log(`${ts()} [${tag}] ${msg}`);
const mainLog = log('server');

const portRaw = argValue('--port') || process.env.PORT || config.port || 8787;
let PORT = Number(portRaw);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) { mainLog(`invalid port "${portRaw}", using 8787`); PORT = 8787; }
// 127.0.0.1 = this computer only; '0.0.0.0' = also reachable from the network (e.g. OBS on a second PC)
const HOST = argValue('--host') || config.host || '127.0.0.1';
const ANY_OR_LOOPBACK = /^(0\.0\.0\.0|::|127\.\d+\.\d+\.\d+|::1|localhost)$/;
const URL_BASE = `http://${ANY_OR_LOOPBACK.test(HOST) ? 'localhost' : HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`;

net.configure(config);
const engine = new Engine(config);
const icons = new IconStore(ROOT, config, log('icons'));
engine.icons = icons.urls();
icons.refresh().then((map) => { engine.icons = map; mainLog(`icons ready: ${Object.keys(map).join(', ') || 'none (fallback monograms)'}`); }).catch(() => {});
const tfOf = (url) => { const tf = (url.searchParams.get('tf') || '').toLowerCase(); return engine.hasTf(tf) ? tf : engine.chartTf; };

// ---------------------------------------------------------------- persistence (liquidations, heatmap)
/** Write a JSON store through a temp file + rename: a crash mid-write cannot corrupt it. */
function writeStore(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(obj));
    fs.renameSync(file + '.tmp', file);
  } catch (e) { mainLog(`${path.basename(file)} write failed: ${e.message}`); }
}
function readStore(file, what, apply) {
  try { if (fs.existsSync(file)) apply(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { mainLog(`could not read the ${what} store: ${e.message}`); }
}
const liqFile = path.resolve(ROOT, (config.liquidations && config.liquidations.storeFile) || 'data/liquidations.json');
readStore(liqFile, 'liquidation', (d) => { engine.loadLiquidations(d); mainLog(`loaded ${engine.liqTotals().count} liquidation events from store`); });
let liqDirty = false;
engine.on('liq_persist', () => { liqDirty = true; });
function saveLiquidations() { if (!liqDirty) return; liqDirty = false; writeStore(liqFile, engine.exportLiquidations()); }
setInterval(saveLiquidations, 20000);

const heatFile = path.resolve(ROOT, (config.heatmap && config.heatmap.storeFile) || 'data/heatmap.json');
if (engine.heatmap) readStore(heatFile, 'heatmap', (d) => mainLog(`loaded ${engine.heatmap.load(d, Date.now())} heatmap minutes from store`));
let heatSaved = engine.heatmap ? engine.heatmap.version : 0;
function saveHeatmap() { if (!engine.heatmap || engine.heatmap.version === heatSaved) return; heatSaved = engine.heatmap.version; writeStore(heatFile, engine.heatmap.export()); }
setInterval(saveHeatmap, 5 * 60000);
// flush on Ctrl+C, on kill, and when the console window is closed (SIGHUP on Windows)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { saveLiquidations(); saveHeatmap(); process.exit(0); });

// ---------------------------------------------------------------- HTTP static + API
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/state') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(engine.snapshot(tfOf(url)))); }
  if (url.pathname.startsWith('/icons/')) return icons.serve(url.pathname.slice(7).replace(/[^a-z0-9_-]/gi, ''), res);
  if (url.pathname === '/api/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, price: engine.index, status: engine.statusState() })); }
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
  mainLog(`exchanges: ${enabled.map(([id]) => id).join(', ') || 'none'}`);
  // exchange time, measured while the history loads: live candles are then built on the right boundaries
  const clockSources = config.syncClock === false ? [] : enabled.filter(([id]) => feeds[id].serverTime).map(([id]) => [id, feeds[id].serverTime]);
  const clock = clockSources.length ? startClock(engine, clockSources, log('clock')) : null;
  mainLog('loading candle history…');
  const hist = await loadHistory(config, log('history'));
  const count = (tf) => Object.keys(hist[tf] || {}).length;
  mainLog('history sources — ' + Object.keys(hist).map(tf => `${tf}:${count(tf)}`).join(' '));
  if (!count('5m') && !count('1m')) mainLog('WARNING: no candle history could be loaded; the chart will build from live trades only');
  if (clock) await clock.ready;
  engine.seedHistory(hist);
  // crypto assets are streamed by their exchange adapter: say so when that exchange cannot provide them
  for (const a of config.assets || []) {
    const ok = a.source === 'yahoo' || (enabled.some(([id]) => id === a.source) && feeds[a.source].tickers);
    if (!ok) mainLog(`WARNING: asset ${a.label} uses source "${a.source}", which is not an enabled exchange with tickers (binance, coinbase) nor "yahoo": it will not update`);
  }

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

// ---------------------------------------------------------------- run
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    mainLog(`port ${PORT} is already in use — is BTC Monitor already running? (try --port 8788)`);
    if (OPEN) openBrowser(`${URL_BASE}/`);
  } else mainLog('server error: ' + e.message);
  setTimeout(() => process.exit(1), IS_EXE ? 8000 : 0);
});
server.listen(PORT, HOST, () => {
  if (IS_EXE) mainLog(`BTC Monitor executable — folder: ${ROOT}`);
  mainLog(`dashboard: ${URL_BASE}  (timeframes: ${engine.chartTfs.map(tf => `?tf=${tf}`).join(' ')})`);
  if (!/^(127\.|::1$|localhost$)/.test(HOST)) mainLog(`listening on ${HOST}: other devices of the network can open the dashboard`);
  if (OPEN) { openBrowser(`${URL_BASE}/`); mainLog('opening the dashboard in your browser… keep this window open while streaming'); }
  setInterval(() => engine.tick(), 250);
  startLive().catch(e => { mainLog('startup error: ' + e.stack); });
});
process.on('uncaughtException', (e) => { console.error(`${ts()} [fatal] ${e.stack || e}`); });
process.on('unhandledRejection', (e) => { console.error(`${ts()} [rejection] ${(e && e.stack) || e}`); });

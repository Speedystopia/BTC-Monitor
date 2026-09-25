'use strict';
/* ============================================================================
 *  tools/build-demo.js — bundle the dashboard into a single self-contained
 *  HTML file running the in-browser simulator (no server needed).
 *    node tools/build-demo.js  ->  dist/demo.html (standalone document)
 *                                  dist/demo-artifact.html (fragment, no <html>/<body>)
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const css = read('public/styles.css');
const core = ['core/indicators.js', 'core/candles.js', 'core/analysis.js', 'core/engine.js', 'core/sim.js'].map(read).join('\n');
const client = ['public/util.js', 'public/chart.js', 'public/audio.js', 'public/app.js'].map(read).join('\n');
const html = read('public/index.html');
const bodyStart = html.indexOf('<div id="app">');
const bodyEnd = html.indexOf('<script src="util.js">');
const app = html.slice(bodyStart, bodyEnd).trim();

const demoConfig = {
  chartTimeframe: '5m', chartTimeframes: ['1m', '3m', '5m', '15m', '1h', '4h', '8h', '12h', '1d'], chartCandles: 900, visibleCandles: 300, referenceExchange: 'coinbase',
  orderBook: { bucketUsd: 10, profileRangePct: 1.5, largeOrderUsd: 100000, largeTradeUsd: 50000, feedMax: 40, removedRowTtlSec: 20, feedRangePct: 2, minRestMs: 3000 },
  indicators: { emaLength: 50, rsiLength: 14, rsiOverbought: 70, rsiOversold: 30, scannerEma: 21, zoneLookback: 288, pivotStrength: 6, waveOverbought: 120, waveOversold: -120, reversalWindow: 6, conditionConfirmBars: 2 },
  assets: [
    { label: 'ETHUSD', icon: 'eth' }, { label: 'GOLD', icon: 'gold' }, { label: 'XRPUSD', icon: 'xrp' },
    { label: 'SP500', icon: 'sp500' }, { label: 'SOLUSD', icon: 'sol' }, { label: 'DXY', icon: 'dxy' },
  ],
  alerts: { audio: true, overboughtOversold: true, conditionChange: true, reversal: true },
};

// logos cached by the server (data/icons) are embedded as data URIs; missing ones use the built-in monograms
const iconsDir = path.join(ROOT, 'data', 'icons');
const icons = {};
if (fs.existsSync(iconsDir)) for (const n of fs.readdirSync(iconsDir)) { const m = n.match(/^([a-z0-9_-]+)\.(png|jpg|svg|webp|gif)$/i); if (!m) continue; const mime = { png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp', gif: 'image/gif' }[m[2].toLowerCase()]; icons[m[1]] = `data:${mime};base64,${fs.readFileSync(path.join(iconsDir, n)).toString('base64')}`; }
const iconScript = `<script>window.BTCM_ICONS = ${JSON.stringify(icons)};</script>`;

const fonts = '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600&display=swap" rel="stylesheet">';
const boot = `<script>\n// ---- in-browser demo: engine + simulator run locally (synthetic market data)\nBTCM_APP.start({ transport: 'local', config: ${JSON.stringify(demoConfig)}, price: 78600 });\n</script>`;

const head = `<title>Bitcoin Live Educational Pro Chart</title>\n${fonts}\n<style>\n${css}\n</style>\n`;
const body = `${app}\n${iconScript}\n<script>\n${core}\n</script>\n<script>\n${client}\n</script>\n${boot}\n`;
const fragment = head + body;
const standalone = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${head}</head>\n<body>\n${body}</body>\n</html>\n`;

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dist/demo.html'), standalone);
fs.writeFileSync(path.join(ROOT, 'dist/demo-artifact.html'), fragment);
console.log(`icons embedded: ${Object.keys(icons).join(', ') || 'none'}`);
console.log(`dist/demo.html (${(standalone.length / 1024).toFixed(0)} KB), dist/demo-artifact.html (${(fragment.length / 1024).toFixed(0)} KB)`);

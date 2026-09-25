'use strict';
/* Minimal test runner: node test/run.js */
const assert = require('assert');
const I = require('../core/indicators');
const C = require('../core/candles');
const A = require('../core/analysis');
const { Engine } = require('../core/engine');
const { Simulator, generateMinutes, streamMinutes, tailAggregator } = require('../core/sim');
const feeds = require('../server/feeds');
const { normalize, flagEmoji } = require('../server/calendar');

// tests are queued, then run one after another (a test may return a promise)
const queue = [];
const group = (name) => queue.push({ group: name });
function test(name, fn) { queue.push({ name, fn }); }
const near = (a, b, tol) => Math.abs(a - b) <= (tol || 1e-9);

group('indicators');
test('sma / ema basic values', () => {
  const s = I.sma([1, 2, 3, 4, 5], 3);
  assert.deepStrictEqual(s, [null, null, 2, 3, 4]);
  const e = I.ema([1, 2, 3, 4, 5], 3);
  assert.strictEqual(e[2], 2); assert.ok(near(e[3], 3)); assert.ok(near(e[4], 4));
});
test('rsi stays within 0..100 and is 100 on a pure uptrend', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const r = I.rsi(up, 14);
  assert.strictEqual(r[29], 100);
  const noisy = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 3) * 5);
  for (const v of I.rsi(noisy, 14)) if (v != null) assert.ok(v >= 0 && v <= 100);
});
test('momentum wave produces mw/sig of same length', () => {
  const candles = Array.from({ length: 120 }, (_, i) => { const c = 100 + Math.sin(i / 8) * 4; return { t: i, o: c, h: c + 1, l: c - 1, c }; });
  const { mw, sig } = I.momentumWave(candles);
  assert.strictEqual(mw.length, 120); assert.strictEqual(sig.length, 120);
  assert.ok(mw[119] != null && sig[119] != null);
});
test('pctChange finds the candle msAgo', () => {
  const candles = Array.from({ length: 100 }, (_, i) => ({ t: i * 60000, c: 100 + i }));
  const v = I.pctChange(candles, 10 * 60000, 99 * 60000, 200);
  assert.ok(near(v, (200 / 189 - 1) * 100));
});

group('candles');
test('aggregate 1m -> 5m', () => {
  const m1 = Array.from({ length: 10 }, (_, i) => ({ t: i * 60000, o: i, h: i + 2, l: i - 1, c: i + 1, v: 1 }));
  const m5 = C.aggregate(m1, 300000);
  assert.strictEqual(m5.length, 2);
  assert.deepStrictEqual({ o: m5[0].o, h: m5[0].h, l: m5[0].l, c: m5[0].c, v: m5[0].v }, { o: 0, h: 6, l: -1, c: 5, v: 5 });
});
test('composite is volume weighted across exchanges', () => {
  const comp = C.composite({ a: [{ t: 0, o: 100, h: 110, l: 90, c: 105, v: 3 }], b: [{ t: 0, o: 102, h: 112, l: 92, c: 107, v: 1 }], c: [{ t: 60000, o: 1, h: 1, l: 1, c: 1, v: 0 }] });
  assert.strictEqual(comp.length, 2);
  assert.ok(near(comp[0].c, (105 * 3 + 107) / 4)); assert.strictEqual(comp[0].v, 4); assert.strictEqual(comp[0].n, 2);
  assert.strictEqual(comp[1].c, 1);
});
test('CandleSeries rolls buckets and keeps volume', () => {
  const s = new C.CandleSeries('1m', 100);
  s.updatePrice(1000, 10); s.addVolume(1000, 2, 'buy');
  s.updatePrice(30000, 12); s.addVolume(30000, 1, 'sell');
  assert.strictEqual(s.candles.length, 1); assert.strictEqual(s.last.h, 12); assert.strictEqual(s.last.v, 3); assert.strictEqual(s.last.bv, 2);
  const closed = s.updatePrice(61000, 11);
  assert.strictEqual(closed.length, 1); assert.strictEqual(s.candles.length, 2); assert.strictEqual(s.last.o, 11);
  s.updatePrice(4 * 60000 + 5, 15); // skipped buckets are filled flat
  assert.strictEqual(s.candles.length, 5); assert.strictEqual(s.candles[2].v, 0);
});

group('analysis');
test('zones come from the closed-candle extremes', () => {
  const candles = Array.from({ length: 50 }, (_, i) => ({ t: i * 300000, o: 100, h: 101 + (i === 10 ? 20 : 0), l: 99 - (i === 30 ? 20 : 0), c: 100 }));
  candles[49].h = 500; // forming candle is ignored
  const z = A.detectZones(candles, new Array(50).fill(1), A.DEFAULTS);
  assert.strictEqual(z.supply.top, 121); assert.strictEqual(z.supply.fromT, 10 * 300000);
  assert.strictEqual(z.demand.bottom, 79); assert.strictEqual(z.demand.fromT, 30 * 300000);
});
test('condition flips only after confirmation bars', () => {
  const ema = new Array(10).fill(100);
  const closes = [101, 101, 101, 99, 101, 99, 99, 99, 101, 101];
  const candles = closes.map((c, i) => ({ t: i, c }));
  const cond = A.trackCondition(candles, ema, new Array(10).fill(50), Object.assign({}, A.DEFAULTS, { conditionConfirmBars: 2 }));
  assert.strictEqual(cond.state, 'BEARISH'); assert.strictEqual(cond.idx, 6);
});
test('72H change falls back to 1h candles when the 5m series does not reach back 72h', () => {
  const now = 1000 * C.HOUR;
  const flat = (tfMs, n) => ({ candles: Array.from({ length: n }, (_, i) => ({ t: now - (n - i) * tfMs, c: 100 })) });
  const series = { '5m': flat(5 * C.MIN, 850), '1h': flat(C.HOUR, 200), '1d': flat(C.DAY, 40) }; // 850 x 5m = 70.8h
  const pct = A.pctChanges(series, 110, now);
  assert.ok(near(pct.find(p => p.label === '72H').value, 10));
  assert.ok(near(pct.find(p => p.label === '48H').value, 10));
});
test('scanner returns 13 timeframes', () => {
  const series = {}; for (const tf of C.SCANNER_ORDER) { series[tf] = { candles: Array.from({ length: 60 }, (_, i) => ({ c: 100 + i })) }; }
  const sc = A.scanTrends(series, A.DEFAULTS);
  assert.strictEqual(sc.length, 13); assert.ok(sc.every(s => s.bull === true && s.up === true));
});

group('exchange parsers');
test('binance trade / depth / ticker / forceOrder', () => {
  const t = feeds.binance.parse('{"stream":"btcusdt@trade","data":{"e":"trade","E":1,"s":"BTCUSDT","t":1,"p":"78860.00000000","q":"0.00009000","T":1789404776250,"m":true,"M":true}}');
  assert.deepStrictEqual(t, { kind: 'trade', symbol: 'BTCUSDT', trade: { price: 78860, qty: 0.00009, side: 'sell', ts: 1789404776250 } });
  const d = feeds.binance.parse({ stream: 'btcusdt@depth@100ms', data: { e: 'depthUpdate', s: 'BTCUSDT', U: 10, u: 12, b: [['78000.00', '1.5']], a: [['78001.00', '0']] } });
  assert.strictEqual(d.kind, 'depth'); assert.strictEqual(d.U, 10); assert.deepStrictEqual(d.asks, [['78001.00', '0']]);
  const k = feeds.binance.parse({ stream: 'ethusdt@ticker', data: { e: '24hrTicker', s: 'ETHUSDT', c: '2522.0', P: '1.83', p: '45.3' } });
  assert.deepStrictEqual(k, { kind: 'ticker', symbol: 'ETHUSDT', price: 2522, pct: 1.83, abs: 45.3 });
  const l = feeds.binance.parse({ stream: 'btcusdt@forceOrder', data: { e: 'forceOrder', o: { s: 'BTCUSDT', S: 'SELL', q: '0.014', p: '78600', ap: '78590.5', z: '0.014', T: 1789404776250 } } });
  assert.strictEqual(l.kind, 'liquidation'); assert.strictEqual(l.liq.side, 'long'); assert.ok(near(l.liq.usd, 0.014 * 78590.5, 1e-6));
});
test('coinbase match (maker side inverted) / l2', () => {
  const t = feeds.coinbase.parse('{"type":"match","product_id":"BTC-USD","price":"78871.07","size":"0.01","side":"sell","time":"2026-09-14T17:00:00.000000Z"}');
  assert.strictEqual(t.trade.side, 'buy'); assert.strictEqual(t.trade.price, 78871.07);
  const s = feeds.coinbase.parse({ type: 'snapshot', product_id: 'BTC-USD', bids: [['1', '2']], asks: [['3', '4']] });
  assert.strictEqual(s.kind, 'snapshot');
  const u = feeds.coinbase.parse({ type: 'l2update', product_id: 'BTC-USD', changes: [['buy', '78830.01', '0.03'], ['sell', '78843.68', '0']] });
  assert.deepStrictEqual(u.bids, [['78830.01', '0.03']]); assert.deepStrictEqual(u.asks, [['78843.68', '0']]);
  assert.strictEqual(feeds.coinbase.parse({ type: 'last_match', side: 'buy' }), null);
});
test('kraken v2 trade / book', () => {
  const t = feeds.kraken.parse({ channel: 'trade', type: 'update', data: [{ symbol: 'BTC/USD', side: 'buy', price: 78793, qty: 0.5, timestamp: '2026-09-14T17:00:00.000000Z' }] });
  assert.strictEqual(t.trades[0].side, 'buy'); assert.strictEqual(t.trades[0].qty, 0.5);
  const b = feeds.kraken.parse({ channel: 'book', type: 'snapshot', data: [{ symbol: 'BTC/USD', bids: [{ price: 78849.3, qty: 0.0005 }], asks: [{ price: 78850, qty: 1 }] }] });
  assert.strictEqual(b.kind, 'snapshot'); assert.deepStrictEqual(b.bids, [[78849.3, 0.0005]]);
  const u = feeds.kraken.parse({ channel: 'book', type: 'update', data: [{ symbol: 'BTC/USD', bids: [{ price: 78849.3, qty: 0 }], asks: [] }] });
  assert.strictEqual(u.kind, 'delta'); assert.deepStrictEqual(u.bids, [[78849.3, 0]]);
});
test('bybit trades (all tagged snapshot) / orderbook / liquidation side', () => {
  const t = feeds.bybit.parse('{"topic":"publicTrade.BTCUSDT","ts":1,"type":"snapshot","data":[{"i":"1","T":1789404730377,"p":"78880.1","v":"0.002","S":"Sell","s":"BTCUSDT"}]}');
  assert.strictEqual(t.trades[0].side, 'sell'); assert.strictEqual(t.trades[0].price, 78880.1);
  const b = feeds.bybit.parse({ topic: 'orderbook.200.BTCUSDT', type: 'delta', data: { s: 'BTCUSDT', b: [['78862.7', '0.327707'], ['78857.4', '0']], a: [], u: 1, seq: 2 } });
  assert.strictEqual(b.kind, 'delta'); assert.strictEqual(b.bids.length, 2);
  const l = feeds.bybit.parse({ topic: 'allLiquidation.BTCUSDT', type: 'snapshot', data: [{ T: 1, s: 'BTCUSDT', S: 'Buy', v: '0.1', p: '78000' }] });
  assert.strictEqual(l.liqs[0].side, 'long'); assert.strictEqual(l.liqs[0].usd, 7800);
});
test('okx trades / books / liquidation contract values', () => {
  const t = feeds.okx.parse({ arg: { channel: 'trades', instId: 'BTC-USDT' }, data: [{ instId: 'BTC-USDT', px: '78883.5', sz: '0.01', side: 'buy', ts: '1789404720000' }] });
  assert.strictEqual(t.trades[0].qty, 0.01); assert.strictEqual(t.trades[0].ts, 1789404720000);
  const b = feeds.okx.parse({ arg: { channel: 'books', instId: 'BTC-USDT' }, action: 'update', data: [{ bids: [['78000', '1', '0', '2']], asks: [] }] });
  assert.strictEqual(b.kind, 'delta'); assert.deepStrictEqual(b.bids, [['78000', '1']]);
  const l = feeds.okx.parse({ arg: { channel: 'liquidation-orders', instType: 'SWAP' }, data: [{ instId: 'BTC-USDT-SWAP', details: [{ side: 'sell', posSide: 'long', bkPx: '78000', sz: '10', ts: '1' }] }, { instId: 'BTC-USD-SWAP', details: [{ side: 'buy', posSide: 'net', bkPx: '78000', sz: '5', ts: '1' }] }] });
  assert.strictEqual(l.liqs.length, 2);
  assert.strictEqual(l.liqs[0].side, 'long'); assert.ok(near(l.liqs[0].usd, 10 * 0.01 * 78000));
  assert.strictEqual(l.liqs[1].side, 'short'); assert.strictEqual(l.liqs[1].usd, 500);
  assert.strictEqual(feeds.okx.parse('pong'), null);
});
test('bitstamp trade / order book', () => {
  const t = feeds.bitstamp.parse('{"data":{"id":1,"timestamp":"1789404731","amount":0.00012805,"price":78881,"type":1,"microtimestamp":"1789404731000000"},"channel":"live_trades_btcusd","event":"trade"}');
  assert.strictEqual(t.trade.side, 'sell'); assert.strictEqual(t.trade.ts, 1789404731000);
  const b = feeds.bitstamp.parse({ event: 'data', channel: 'order_book_btcusd', data: { bids: [['78847.08', '1.2']], asks: [['78848', '0.5']] } });
  assert.strictEqual(b.kind, 'snapshot'); assert.strictEqual(b.symbol, 'btcusd');
});
test('calendar normalisation + flags', () => {
  const e = normalize({ title: 'CPI m/m', country: 'USD', date: '2026-09-15T08:30:00-04:00', impact: 'High' });
  assert.strictEqual(e.time, Date.parse('2026-09-15T12:30:00Z')); assert.strictEqual(e.flag, '🇺🇸');
  assert.strictEqual(flagEmoji('CNY'), '🇨🇳'); assert.strictEqual(flagEmoji('All'), '🌐'); assert.strictEqual(flagEmoji('FR'), '🇫🇷');
});

group('engine');
test('engine builds index, candles, feed and liquidations from events', () => {
  const engine = new Engine({ chartTimeframe: '5m', orderBook: { largeOrderUsd: 100000, largeTradeUsd: 50000, minRestMs: 0 } });
  let now = 1789400000000; engine.now = () => now;
  const msgs = []; engine.on('message', (m) => msgs.push(m));
  engine.onTrade('a', { price: 100, qty: 1, side: 'buy', ts: now });
  engine.onTrade('b', { price: 102, qty: 3, side: 'sell', ts: now });
  engine.tick();
  assert.ok(near(engine.index, (100 * (1 + 1e-6) + 102 * (3 + 1e-6)) / (4 + 2e-6), 1e-6));
  assert.strictEqual(engine.series['5m'].candles.length, 1);
  engine.onBookSnapshot('a', [['100', '2000'], ['98', '1']], [['101', '1']]);
  now += 1500; engine.tick();
  const orders = engine.feed.filter(r => r.kind === 'order');
  assert.strictEqual(orders.length, 1); assert.strictEqual(orders[0].side, 'bid'); assert.strictEqual(orders[0].price, 100);
  engine.onBookDelta('a', [['100', '0']], []);
  now += 1500; engine.tick();
  assert.ok(engine.feed.find(r => r.kind === 'order' && r.removed));
  engine.onLiquidation('a', { side: 'long', price: 100, qty: 2, ts: now });
  assert.strictEqual(engine.liqTotals().long, 200);
  assert.ok(msgs.some(m => m.type === 'tick') && msgs.some(m => m.type === 'liq'));
  const snap = engine.snapshot();
  assert.strictEqual(snap.type, 'snapshot'); assert.ok(snap.analysis.candles.length >= 1);
});
test('books with a subscribed depth are truncated to their best levels', () => {
  const engine = new Engine({}); let now = 1789400000000; engine.now = () => now;
  engine.registerExchange('kraken', { bookDepth: 2 });
  engine.onTrade('kraken', { price: 100.6, qty: 1, side: 'buy' });
  engine.onBookSnapshot('kraken', [['100', '1'], ['99', '1']], [['101', '1'], ['102', '1']]);
  engine.onBookDelta('kraken', [['100.5', '1']], [['100.8', '1']]); // pushes 99 / 102 out of the depth, no delete sent
  now += 1500; engine.tick();
  assert.deepStrictEqual([...engine.books.kraken.bids.keys()].sort((a, b) => b - a), [100.5, 100]);
  assert.deepStrictEqual([...engine.books.kraken.asks.keys()].sort((a, b) => a - b), [100.8, 101]);
});
test('tick messages of every timeframe share the per-tick values', () => {
  const engine = new Engine({ chartTimeframes: ['1m', '5m', '1h'] }); let now = 1789400000000; engine.now = () => now;
  const ticks = []; engine.on('message', (m) => { if (m.type === 'tick') ticks.push(m); });
  engine.onTrade('a', { price: 100, qty: 2, side: 'buy' }); engine.onTrade('a', { price: 100, qty: 1, side: 'sell' });
  engine.tick();
  assert.deepStrictEqual(ticks.map(t => t.tf), ['1m', '5m', '1h']);
  for (const t of ticks) assert.deepStrictEqual(t.vol1m, { total: 3, buy: 2, sell: 1, usd: 300 });
});
test('liquidations: rolling 24h window, store round trip, legacy store format', () => {
  const t0 = Date.UTC(2026, 8, 20, 12, 0, 0);
  const engine = new Engine({}); let now = t0; engine.now = () => now;
  const totals = (e) => { const t = e.liqTotals(); return [t.long, t.short, t.count]; };
  engine.onLiquidation('a', { side: 'long', price: 100, qty: 2, ts: now - C.DAY - 5 * C.MIN }); // older than the window
  engine.onLiquidation('a', { side: 'long', price: 100, qty: 2, ts: now - 10 * C.HOUR });
  engine.onLiquidation('b', { side: 'short', price: 100, qty: 1, ts: now - 5 * C.MIN });
  engine.onLiquidation('b', { side: 'short', price: 100, usd: 50, ts: now });
  assert.deepStrictEqual(totals(engine), [200, 150, 3]);
  const store = JSON.parse(JSON.stringify(engine.exportLiquidations()));
  now += 15 * C.HOUR; // the 10h-old long is now 25h old
  engine.onLiquidation('a', { side: 'long', price: 100, qty: 1, ts: now });
  assert.deepStrictEqual(totals(engine), [100, 150, 3]);
  const restored = new Engine({}); restored.now = () => t0; restored.loadLiquidations(store);
  assert.deepStrictEqual(totals(restored), [200, 150, 3]);
  assert.strictEqual(restored.snapshot().liq.recent[0].usd, 50); // newest first
  const legacy = new Engine({}); legacy.now = () => now;
  legacy.loadLiquidations([{ ex: 'a', side: 'long', usd: 10, ts: now - C.HOUR }, { ex: 'a', side: 'short', usd: 5, ts: now - 2 * C.DAY }, null]);
  assert.deepStrictEqual(totals(legacy), [10, 0, 1]);
});
test('baseFor picks the deepest aligned base timeframe', () => {
  const avail = { '1d': [1], '4h': [1], '1h': [1], '15m': [1], '5m': [1], '1m': [1] };
  assert.strictEqual(C.baseFor('8h', avail), '4h'); assert.strictEqual(C.baseFor('12h', avail), '4h'); assert.strictEqual(C.baseFor('6h', avail), '1h');
  assert.strictEqual(C.baseFor('30m', avail), '15m'); assert.strictEqual(C.baseFor('3m', avail), '1m'); assert.strictEqual(C.baseFor('1d', avail), '1d');
  assert.strictEqual(C.baseFor('4h', { '1h': [1] }), '1h'); assert.strictEqual(C.baseFor('1m', { '5m': [1] }), null);
});
test('streamed simulator history equals aggregating the full minute path', () => {
  const end = 1789400123456, minutes = 3 * 1440;
  const m1 = generateMinutes(minutes, 78600, end, 11);
  for (const [tf, keep] of [['1m', 500], ['5m', 300], ['1h', 50], ['1d', 2]]) {
    const agg = tailAggregator(C.TIMEFRAMES[tf], keep);
    streamMinutes(minutes, 78600, end, 11, agg.add);
    assert.deepStrictEqual(agg.result(), C.aggregate(m1, C.TIMEFRAMES[tf]).slice(-keep), tf);
  }
});
test('simulated order books stay bounded while the price drifts', () => {
  const engine = new Engine({}); engine.now = () => 1789400000000;
  const sim = new Simulator(engine, { price: 78600, exchanges: ['binance'] });
  sim.initBook('binance');
  for (let i = 0; i < 1500; i++) { sim.price += 2; sim.updateBook('binance'); } // $3000 move
  const b = sim.books.binance;
  assert.ok(b.bids.size + b.asks.size <= 8100, `book grew to ${b.bids.size + b.asks.size} levels`);
  assert.strictEqual(engine.books.binance.size(), b.bids.size + b.asks.size);
});
test('simulator seeds all timeframes and runs the analysis', () => {
  const engine = new Engine({ chartTimeframe: '5m' });
  const sim = new Simulator(engine, { price: 78600 });
  sim.seed();
  for (const tf of C.SCANNER_ORDER) assert.ok(engine.series[tf].candles.length > 50, tf + ' seeded');
  const an = engine.tfState['5m'].analysis;
  assert.ok(an && an.zones.supply && an.condition);
  for (const tf of ['1m', '15m', '1h', '4h', '8h', '12h', '1d']) assert.ok(engine.tfState[tf].analysis, tf + ' analysed');
  assert.ok(engine.snapshot('4h').analysis.candles.length > 100 && engine.snapshot('4h').meta.tf === '4h');
  assert.strictEqual(engine.scanner.length, 13); assert.strictEqual(engine.pct.length, 7);
});

group('server (integration)');
const freePort = () => new Promise((resolve) => { const s = require('net').createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const waitFor = async (cond, ms) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 50)); } };
const httpGet = (port, p) => new Promise((resolve, reject) => {
  const req = require('http').get({ host: '127.0.0.1', port, path: p, timeout: 5000 }, (res) => { let body = ''; res.on('data', d => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body })); });
  req.on('timeout', () => req.destroy(new Error('no response for ' + p))); req.on('error', reject);
});
test('server answers bad timeframes, malformed URLs and traversal attempts', async () => {
  const port = await freePort();
  const child = require('child_process').spawn(process.execPath, [require('path').join(__dirname, '..', 'server', 'index.js'), '--sim', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  try {
    await waitFor(() => /dashboard: /.test(out), 15000);
    const state = async (q) => JSON.parse((await httpGet(port, '/api/state' + q)).body).meta.tf;
    assert.strictEqual(await state('?tf=__proto__'), '5m');
    assert.strictEqual(await state('?tf=constructor'), '5m');
    assert.strictEqual(await state('?tf=1h'), '1h');
    assert.strictEqual((await httpGet(port, '/%E0%A4%A')).status, 400);
    assert.strictEqual((await httpGet(port, '/icons/__proto__')).status, 404);
    assert.ok([403, 404].includes((await httpGet(port, '/core/..%2fconfig.js')).status));
    assert.strictEqual((await httpGet(port, '/')).status, 200);
    const snap = await new Promise((resolve, reject) => {
      const ws = new (require('ws'))(`ws://127.0.0.1:${port}/ws?tf=constructor`);
      const to = setTimeout(() => { ws.terminate(); reject(new Error('no snapshot over the websocket')); }, 5000);
      ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'snapshot') { clearTimeout(to); ws.close(); resolve(m); } });
      ws.on('error', reject);
    });
    assert.strictEqual(snap.meta.tf, '5m');
    assert.ok(!/\[fatal\]/.test(out), 'server logged a fatal error:\n' + out);
  } finally { child.kill('SIGKILL'); }
});

(async () => {
  let passed = 0, failed = 0;
  for (const q of queue) {
    if (q.group) { console.log(q.group); continue; }
    try { await q.fn(); passed++; console.log('  ok   ' + q.name); } catch (e) { failed++; console.log('  FAIL ' + q.name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n       ')); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

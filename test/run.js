'use strict';
/* Minimal test runner: node test/run.js */
const assert = require('assert');
const I = require('../core/indicators');
const C = require('../core/candles');
const A = require('../core/analysis');
const { Engine } = require('../core/engine');
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

group('sessions');
test('session boxes follow UTC hours, overnight and running sessions included', () => {
  const S = require('../public/sessions');
  const day = Date.UTC(2026, 8, 22), H = C.HOUR;
  // 15m candles from 22 Sep 00:00 to 23 Sep 11:45 UTC; price = hour of the day, so highs / lows are easy to check
  const candles = []; for (let t = day; t < day + 36 * H; t += 15 * C.MIN) { const h = new Date(t).getUTCHours(); candles.push({ t, o: h, h: h + 0.5, l: h - 0.5, c: h }); }
  const boxes = S.sessionBoxes(candles, [{ name: 'Asia', start: '23:00', end: '07:00' }, { name: 'London', start: '08:00', end: '13:00' }]);
  const asia = boxes.filter(b => b.name === 'Asia'), london = boxes.filter(b => b.name === 'London');
  assert.strictEqual(asia.length, 2); // 21 Sep 23:00 -> 22 Sep 07:00 (partly before the data) and 22 Sep 23:00 -> 23 Sep 07:00
  assert.strictEqual(asia[0].start, day - H); assert.strictEqual(candles[asia[0].i0].t, day); assert.strictEqual(candles[asia[0].i1].t, day + 7 * H - 15 * C.MIN);
  assert.deepStrictEqual([asia[1].start, asia[1].end, asia[1].lo, asia[1].hi], [day + 23 * H, day + 31 * H, -0.5, 23.5]);
  assert.strictEqual(london.length, 2); // 22 Sep complete, 23 Sep still running
  assert.deepStrictEqual([london[0].lo, london[0].hi], [7.5, 12.5]);
  assert.strictEqual(candles[london[1].i1].t, day + 36 * H - 15 * C.MIN);
  assert.strictEqual(S.minutes('7:05'), 425); assert.strictEqual(S.minutes('25:00'), null);
});
test('engine sends the session settings, with defaults for older config files', () => {
  const meta = new Engine({}).snapshot().meta;
  assert.deepStrictEqual(meta.sessions.list.map(s => s.name), ['Sydney', 'Asia', 'Frankfurt', 'London', 'New York']);
  // the default sessions tile the 24 hours: each one starts where the previous one ends
  const S = require('../public/sessions'), m = meta.sessions.list.map(x => [S.minutes(x.start), S.minutes(x.end)]);
  for (let i = 0; i < m.length; i++) assert.strictEqual(m[i][1], m[(i + 1) % m.length][0], meta.sessions.list[i].name);
  assert.strictEqual(m.reduce((sum, [a, b]) => sum + ((b - a + 1440) % 1440), 0), 1440);
  assert.strictEqual(meta.sessions.maxTfMs, C.HOUR);
  const warn = console.warn; console.warn = () => {};
  const custom = new Engine({ sessions: { maxTimeframe: '15m', list: [{ name: 'X', start: '01:00', end: '02:00' }, { name: 'bad' }, { name: 'Y', start: '01:00', end: '02:00', tz: 'Mars/Olympus' }] } }).snapshot().meta.sessions;
  console.warn = warn;
  assert.deepStrictEqual([custom.maxTfMs, custom.list.length, custom.list[0].color, custom.list[0].tz], [15 * C.MIN, 1, '#9e9e9e', 'UTC']);
});
test('sessions in a local time zone follow daylight saving time', () => {
  const S = require('../public/sessions'), H = C.HOUR;
  const from = Date.UTC(2026, 9, 23), candles = []; // 1h candles, 23 -> 27 Oct 2026 (Europe leaves summer time on the 25th)
  for (let t = from; t < from + 4 * C.DAY; t += H) candles.push({ t, o: 1, h: 2, l: 0, c: 1 });
  const london = S.sessionBoxes(candles, [{ name: 'London', start: '08:00', end: '16:30', tz: 'Europe/London' }]);
  const hours = london.map(b => new Date(b.start).toISOString().slice(5, 16));
  assert.deepStrictEqual(hours, ['10-23T07:00', '10-24T07:00', '10-25T08:00', '10-26T08:00']); // 08:00 BST = 07:00 UTC, then 08:00 GMT
  assert.strictEqual(london[3].end - london[3].start, 8.5 * H);
  const ny = S.sessionBoxes(candles, [{ name: 'NY', start: '09:30', end: '16:00', tz: 'America/New_York' }]);
  assert.strictEqual(new Date(ny[0].start).toISOString().slice(11, 16), '13:30'); // EDT (UTC-4) until 1 Nov
  assert.deepStrictEqual(S.sessionBoxes(candles, [{ name: 'bad', start: '01:00', end: '02:00', tz: 'Mars/Olympus' }]), []);
  assert.strictEqual(S.zonedTime(2026, 11, 1, 9 * 60, 'Asia/Tokyo'), Date.UTC(2026, 11, 1, 0, 0)); // 09:00 JST = 00:00 UTC
});

group('heatmap');
test('heatmap averages the book samples per minute and per candle', () => {
  const { LiquidityHeatmap, encode } = require('../core/heatmap');
  const T = Date.UTC(2026, 8, 25, 12, 0, 0), hm = new LiquidityHeatmap({ step: 10, historyHours: 1 });
  // minute 0: a $1M wall at 84000 every second; minute 1: the wall at half size; minute 2 (running): an ask at 84100
  for (let s = 0; s < 60; s++) hm.sample(T + s * 1000, [[84000, 1e6, 0], [84010, 1000, 0]]);
  for (let s = 0; s < 60; s++) hm.sample(T + 60000 + s * 1000, [[84000, 5e5, 0]]);
  for (let s = 0; s < 10; s++) hm.sample(T + 120000 + s * 1000, [[84100, 0, 2e5]]);
  assert.strictEqual(hm.cols.length, 2);
  const val = (col, price) => { const i = Math.round(price / 10) - col.b0; return i >= 0 && i < col.q.length ? (col.q[i] / 255) ** 2 * col.s : 0; };
  assert.ok(near(val(hm.cols[0], 84000), 1e6, 1)); assert.ok(near(val(hm.cols[0], 84010), 1000, 40)); // 8-bit square-root companding
  const c5 = hm.column(T, 5 * C.MIN); // 3 minutes: 1M, 0.5M and the running minute without the wall
  assert.ok(near(val(c5, 84000), 5e5, 1e3)); assert.ok(near(val(c5, 84100), 2e5 / 3, 1e3));
  assert.strictEqual(hm.columns([T - 5 * C.MIN, T], 5 * C.MIN).length, 1); // the candle before the data is skipped
  const wire = encode(c5); assert.ok(typeof wire.d === 'string' && wire.b0 === c5.b0);
  // store round trip: same bucket size only, minutes older than the history dropped
  const back = new LiquidityHeatmap({ step: 10, historyHours: 1 });
  assert.strictEqual(back.load(JSON.parse(JSON.stringify(hm.export())), T + 3 * C.MIN), 2);
  assert.deepStrictEqual(Array.from(back.cols[1].q), Array.from(hm.cols[1].q));
  assert.strictEqual(new LiquidityHeatmap({ step: 25 }).load(hm.export(), T), 0);
  assert.strictEqual(new LiquidityHeatmap({ step: 10, historyHours: 1 }).load(hm.export(), T + 2 * C.HOUR), 0);
});
test('engine samples the books into heatmap columns for every chart timeframe', () => {
  const engine = new Engine({ chartTimeframes: ['1m', '5m'] }); let now = Date.UTC(2026, 8, 25, 12, 0, 0); engine.now = () => now;
  const heat = []; engine.on('message', (m) => { if (m.type === 'heat') heat.push(m); });
  engine.onTrade('a', { price: 84005, qty: 1, side: 'buy' });
  engine.onBookSnapshot('a', [['84000', '20'], ['83990', '1']], [['84010', '1']]);
  for (let i = 0; i < 70; i++) { now += 1000; engine.onTrade('a', { price: 84005, qty: 0.01, side: 'buy' }); engine.tick(); }
  assert.ok(heat.some(m => m.tf === '1m') && heat.some(m => m.tf === '5m'));
  const snap = engine.snapshot('1m');
  assert.ok(snap.heat.cols.length >= 1 && snap.meta.heatmap.enabled);
  const col = snap.heat.cols[0], q = Buffer.from(col.d, 'base64');
  assert.strictEqual(q[Math.round(84000 / 10) - col.b0], 255); // the 20 BTC bid is the biggest level
  assert.strictEqual(new Engine({ heatmap: { enabled: false } }).snapshot().heat, null);
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
test('seedHistory builds and analyses every timeframe', () => {
  const engine = new Engine({ chartTimeframe: '5m' });
  const now = engine.now();
  const series = (tf, n) => { const ms = C.TIMEFRAMES[tf], last = C.bucket(now, ms); return Array.from({ length: n }, (_, i) => { const c = 80000 + 3000 * Math.sin(i / 25) + i; return { t: last - (n - 1 - i) * ms, o: c - 20, h: c + 60, l: c - 70, c, v: 10, bv: 5 }; }); };
  engine.seedHistory({ '1m': series('1m', 1000), '3m': series('3m', 1000), '5m': series('5m', 1000), '15m': series('15m', 1000), '1h': series('1h', 1000), '4h': series('4h', 1000), '1d': series('1d', 400) });
  for (const tf of C.SCANNER_ORDER) assert.ok(engine.series[tf].candles.length > 50, tf + ' seeded');
  const an = engine.tfState['5m'].analysis;
  assert.ok(an && an.zones.supply && an.condition);
  for (const tf of ['1m', '15m', '1h', '4h', '8h', '12h', '1d']) assert.ok(engine.tfState[tf].analysis, tf + ' analysed');
  assert.ok(engine.snapshot('4h').analysis.candles.length > 100 && engine.snapshot('4h').meta.tf === '4h');
  assert.strictEqual(engine.scanner.length, 13); assert.strictEqual(engine.pct.length, 7);
});

const freePort = () => new Promise((resolve) => { const s = require('net').createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const waitFor = async (cond, ms) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 50)); } };

group('net');
test('reconnecting websocket reports a refused handshake with its HTTP status', async () => {
  const { ReconnectingWS } = require('../server/net');
  const srv = require('http').createServer();
  srv.on('upgrade', (req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const statuses = [];
  const conn = new ReconnectingWS({ name: 't', url: `ws://127.0.0.1:${srv.address().port}/`, onMessage() {}, onStatus: (s, d) => statuses.push(d ? `${s} ${d}` : s) });
  try {
    await waitFor(() => statuses.some(s => s.startsWith('disconnected')), 5000);
    assert.deepStrictEqual(statuses, ['connecting', 'error HTTP 403', 'disconnected HTTP 403']);
    assert.strictEqual(conn.refusals, 1);
  } finally { conn.close(); srv.close(); }
});

test('static files must stay inside the root folder (drive roots included)', () => {
  const { isInside } = require('../server/paths');
  const path = require('path'), sep = path.sep, root = sep + 'app';
  assert.ok(isInside(root, root + sep + 'public' + sep + 'index.html'));
  assert.ok(!isInside(root, root + '-evil' + sep + 'x.js'));
  assert.ok(isInside(sep, sep + 'public' + sep + 'index.html')); // exe at the root of a drive / USB stick
});

group('server (integration)');
const httpGet = (port, p) => new Promise((resolve, reject) => {
  const req = require('http').get({ host: '127.0.0.1', port, path: p, timeout: 5000 }, (res) => { let body = ''; res.on('data', d => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body })); });
  req.on('timeout', () => req.destroy(new Error('no response for ' + p))); req.on('error', reject);
});
/** A configuration with no data source (no exchange, feed, download or store in the project): the server runs offline. */
function offlineConfig() {
  const os = require('os'), fs = require('fs'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btcm-test-'));
  const file = path.join(dir, 'config.js');
  fs.writeFileSync(file, `module.exports = ${JSON.stringify({
    exchanges: {}, liquidations: { storeFile: path.join(dir, 'liquidations.json') }, heatmap: { storeFile: path.join(dir, 'heatmap.json') }, calendar: { forexFactory: false },
    assets: [], icons: { enabled: false }, proxy: '',
  })};`);
  return { dir, file };
}
test('server answers bad timeframes, malformed URLs and traversal attempts', async () => {
  const port = await freePort(), cfg = offlineConfig();
  const child = require('child_process').spawn(process.execPath, [require('path').join(__dirname, '..', 'server', 'index.js'), '--config', cfg.file, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  } finally { child.kill('SIGKILL'); require('fs').rmSync(cfg.dir, { recursive: true, force: true }); }
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

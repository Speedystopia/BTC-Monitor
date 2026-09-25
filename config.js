// ============================================================================
//  BTC MONITOR — configuration
//  Edit this file and restart the server (npm start).
// ============================================================================
module.exports = {
  // HTTP/WebSocket port of the dashboard (open http://localhost:8787)
  port: 8787,
  // Network interface: '127.0.0.1' = this computer only (no firewall prompt);
  // '0.0.0.0' = also reachable from the local network (e.g. OBS running on a second PC)
  host: '127.0.0.1',

  // Timeframe shown when the page is opened without ?tf=...  (each page = one timeframe:
  // http://localhost:8787/?tf=1m  ?tf=3m  ?tf=5m  ?tf=15m  ?tf=1h  ?tf=4h  ?tf=8h  ?tf=12h  ?tf=1d)
  chartTimeframe: '5m',
  chartTimeframes: ['1m', '3m', '5m', '15m', '1h', '4h', '8h', '12h', '1d'],
  // Number of candles sent to a chart page (history depth)
  chartCandles: 900,
  // Number of candles visible by default on screen
  visibleCandles: 300,

  // Sources merged into the composite BTC/USD candle (volume weighted index)
  exchanges: {
    binance:  { enabled: true,  symbol: 'BTCUSDT' },
    coinbase: { enabled: true,  symbol: 'BTC-USD' },
    kraken:   { enabled: true,  symbol: 'BTC/USD' },
    bybit:    { enabled: true,  symbol: 'BTCUSDT' },
    okx:      { enabled: true,  symbol: 'BTC-USDT' },
    bitstamp: { enabled: true,  symbol: 'btcusd' },
  },

  // Exchange whose last price is shown as the secondary price label (reference)
  referenceExchange: 'coinbase',
  // Convert USDT-quoted prices (Binance, Bybit, OKX) to USD with Kraken's USDT/USD rate
  normalizeUsdt: false,

  // Futures liquidation feeds merged into the 24h liquidation monitor
  liquidations: {
    binance: true,   // BTCUSDT + BTCUSD_PERP force orders
    bybit: true,     // BTCUSDT linear allLiquidation stream
    okx: true,       // BTC-USDT-SWAP + BTC-USD-SWAP liquidation orders
    // File used to persist the rolling 24h window across restarts
    storeFile: 'data/liquidations.json',
  },

  // Order-book monitoring (aggregated across all enabled exchanges)
  orderBook: {
    bucketUsd: 10,          // price bucket for the liquidity profile drawn on the chart
    profileRangePct: 1.5,   // +/- % around price kept in the liquidity profile
    largeOrderUsd: 150000,  // resting levels >= this notional are listed in the large-order feed
    feedRangePct: 2,        // only levels within +/- % of the price are watched
    minRestMs: 10000,       // a level must rest this long before it is listed (filters quote flicker)
    largeTradeUsd: 50000,   // a single trade >= this notional is reported in the feed
    feedMax: 40,            // rows shown in the left feed (the biggest levels, newest first)
    removedRowTtlSec: 20,   // how long a pulled/filled order stays in the feed (crossed out)
  },

  // Liquidity heatmap drawn behind the candles: resting liquidity of the aggregated books (all exchanges),
  // sampled every second and averaged per minute, per orderBook.bucketUsd price bucket. Big persistent
  // walls show up as bright horizontal bands. Toggle on the page: H key.
  heatmap: {
    enabled: true,
    rangePct: 3,            // +/- % around the price recorded
    historyHours: 72,       // history kept (memory + data/heatmap.json, survives restarts)
    storeFile: 'data/heatmap.json',
  },

  indicators: {
    emaLength: 50,          // trend line drawn on the chart + market condition rule
    rsiLength: 14,
    rsiOverbought: 70,
    rsiOversold: 30,
    scannerEma: 21,         // EMA used by the multi-timeframe trend scanner
    zoneLookback: 288,      // candles scanned for supply/demand zones (288 x 5m = 24h)
    waveOverbought: 120,    // Momentum Wave thresholds used by reversal detection
    waveOversold: -120,
    reversalWindow: 6,      // bars after an extreme in which a cross confirms a reversal
    conditionConfirmBars: 2 // consecutive closes needed to flip the market condition
  },

  // Market sessions drawn as boxes (session high / low) on the charts up to `maxTimeframe`. Toggle on the page: S key.
  // Hours are UTC (the default list covers the 24 hours); a session that ends before it starts runs past midnight.
  // Add `tz` (IANA time zone) to give local exchange hours that follow daylight saving time, e.g.
  //   { name: 'London', start: '08:00', end: '16:30', tz: 'Europe/London', color: '#66bb6a' }
  //   { name: 'New York', start: '09:30', end: '16:00', tz: 'America/New_York', color: '#42a5f5' }
  sessions: {
    enabled: true,
    maxTimeframe: '1h',
    list: [
      { name: 'Sydney',    start: '21:00', end: '23:00', color: '#26a69a' },
      { name: 'Asia',      start: '23:00', end: '07:00', color: '#ff9800' },
      { name: 'Frankfurt', start: '07:00', end: '08:00', color: '#ba68c8' },
      { name: 'London',    start: '08:00', end: '13:00', color: '#66bb6a' },
      { name: 'New York',  start: '13:00', end: '21:00', color: '#42a5f5' },
    ],
  },

  // Multi-asset reference panel (top right). source: "binance" | "coinbase" | "yahoo"
  assets: [
    { label: 'ETHUSD', source: 'binance', symbol: 'ETHUSDT', icon: 'eth' },
    { label: 'GOLD',   source: 'yahoo',   symbol: 'GC=F',    icon: 'gold' },
    { label: 'XRPUSD', source: 'binance', symbol: 'XRPUSDT', icon: 'xrp' },
    { label: 'SP500',  source: 'yahoo',   symbol: '^GSPC',   icon: 'sp500' },
    { label: 'SOLUSD', source: 'binance', symbol: 'SOLUSDT', icon: 'sol' },
    { label: 'DXY',    source: 'yahoo',   symbol: 'DX-Y.NYB', icon: 'dxy' },
  ],

  // Economic calendar
  calendar: {
    forexFactory: true,                 // pull the public weekly feed (this week)
    minImpact: 'Medium',                // "Low" | "Medium" | "High" — events below are ignored
    refreshMinutes: 20,
    // Manual events (ISO time with zone). Always merged with the feed.
    manualEvents: [
      // { time: '2026-09-17T18:00:00Z', country: 'USD', title: 'FOMC Rate Decision', impact: 'High' },
    ],
  },

  // Logos: downloaded once from GitHub (official exchange organisations, spothq/cryptocurrency-icons
  // for coins) into data/icons and served locally; built-in monograms are used when unavailable.
  icons: {
    enabled: true,
    // override or add sources: key -> [urls tried in order]
    sources: {
      // bitstamp: ['https://example.com/bitstamp.png'],
    },
  },

  alerts: {
    audio: true,                 // client-side beeps (can be toggled in the UI)
    overboughtOversold: true,    // RSI crossing the thresholds
    conditionChange: true,       // bullish/bearish market condition flips
    reversal: true,              // confirmed possible reversal
  },

  // Optional: HTTP(S) proxy for outbound connections (corporate networks).
  // Leave empty to connect directly. Example: 'http://127.0.0.1:8080'
  proxy: process.env.HTTPS_PROXY || '',
};

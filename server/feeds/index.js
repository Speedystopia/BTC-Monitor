'use strict';
/* ============================================================================
 *  server/feeds/index.js — exchange adapters by id (trades, order book,
 *  liquidations, history). Add a new exchange here only.
 * ========================================================================== */
module.exports = {
  binance: require('./binance'), coinbase: require('./coinbase'), kraken: require('./kraken'),
  bybit: require('./bybit'), okx: require('./okx'), bitstamp: require('./bitstamp'),
};

'use strict';
/* ============================================================================
 *  server/icons.js — exchange / asset logos fetched from GitHub and cached in
 *  data/icons (served at /icons/<key>). Exchange logos come from the avatar of
 *  each exchange's official GitHub organisation; coin icons from the MIT
 *  licensed "spothq/cryptocurrency-icons" repository. Missing icons fall back
 *  to built-in monograms on the client.
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getBytes } = require('./net');

const GH_ORG = (org) => `https://github.com/${org}.png?size=96`;
const COIN = (sym) => `https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/${sym}.png`;
const DEFAULT_SOURCES = {
  binance: [GH_ORG('binance')],
  coinbase: [GH_ORG('coinbase')],
  kraken: [GH_ORG('krakenfx')],
  bybit: [GH_ORG('bybit-exchange')],
  okx: [GH_ORG('okx')],
  bitstamp: [], // Bitstamp has no official GitHub organisation with a logo: built-in monogram (or add a URL here)
  btc: [COIN('btc')], eth: [COIN('eth')], xrp: [COIN('xrp')], sol: [COIN('sol')],
};
// GitHub serves this generic placeholder for organisations without an avatar: never use it as a logo
const GITHUB_PLACEHOLDER_SHA256 = ['2ae73e12cb1e9989929920c4e9da0b02b6f6f8f0bd1944ac9ebfbf6b4dca746b'];
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MIME = { png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp', gif: 'image/gif' };

class IconStore {
  constructor(root, config, log) {
    this.dir = path.join(root, 'data', 'icons');
    this.log = log || (() => {});
    const cfg = Object.assign({ enabled: true, sources: {} }, (config && config.icons) || {});
    this.enabled = cfg.enabled;
    this.sources = Object.assign({}, DEFAULT_SOURCES, cfg.sources);
    this.files = Object.create(null); // key -> { file, mime } (no prototype: /icons/__proto__ must be a 404)
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (e) { /* ignore */ }
    this.scanCache();
  }
  scanCache() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch (e) { return; }
    for (const n of names) { const m = n.match(/^([a-z0-9_-]+)\.(png|jpg|svg|webp|gif)$/i); if (m) this.files[m[1]] = { file: path.join(this.dir, n), mime: MIME[m[2].toLowerCase()] }; }
  }
  /** Map of available icons: key -> URL path served by this server. */
  urls() { const out = {}; for (const k of Object.keys(this.files)) out[k] = `/icons/${k}`; return out; }
  async refresh() {
    if (!this.enabled) return this.urls();
    for (const [key, urls] of Object.entries(this.sources)) {
      if (this.files[key] || !Array.isArray(urls)) continue;
      for (const url of urls) {
        try {
          const { buffer, contentType } = await getBytes(url);
          const type = contentType.split(';')[0].trim();
          const ext = EXT[type];
          if (!ext || buffer.length < 100) throw new Error(`not an image (${type})`);
          if (GITHUB_PLACEHOLDER_SHA256.includes(crypto.createHash('sha256').update(buffer).digest('hex'))) throw new Error('generic placeholder avatar');
          const file = path.join(this.dir, `${key}.${ext}`);
          fs.writeFileSync(file, buffer);
          this.files[key] = { file, mime: type };
          this.log(`${key}: downloaded (${buffer.length} bytes)`);
          break;
        } catch (e) {
          this.log(`${key}: ${e.message.slice(0, 80)} — using built-in fallback`);
        }
      }
    }
    return this.urls();
  }
  /** HTTP handler for /icons/<key> */
  serve(key, res) {
    const f = this.files[key];
    if (!f) { res.writeHead(404); return res.end('no icon'); }
    fs.readFile(f.file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('no icon'); }
      res.writeHead(200, { 'Content-Type': f.mime, 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    });
  }
}

module.exports = { IconStore, DEFAULT_SOURCES };

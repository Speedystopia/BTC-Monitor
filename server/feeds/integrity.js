'use strict';
/* ============================================================================
 *  server/feeds/integrity.js — order-book integrity checks.
 *  A missed or misapplied update leaves a local book wrong for good (phantom
 *  walls in the heatmap and the large-order feed, a crossed spread). OKX and
 *  Kraken send a CRC32 of their best levels with every update, OKX also
 *  chains its messages (prevSeqId = previous seqId). Each check validates
 *  itself on the first snapshot: a format it does not recognise switches it
 *  off (with one log line) instead of reloading the book in a loop.
 * ========================================================================== */

const TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
/** CRC32 (unsigned) of an ASCII string. */
function crc32(str) {
  let c = -1;
  for (let i = 0; i < str.length; i++) c = TABLE[(c ^ str.charCodeAt(i)) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** The n best levels of one side (Map price -> value), best first: [[price, value], ...]. desc = bids. */
function topLevels(m, n, desc) {
  const out = [];
  for (const [p, v] of m) {
    if (out.length === n && (desc ? p <= out[n - 1][0] : p >= out[n - 1][0])) continue;
    let i = out.length;
    while (i > 0 && (desc ? out[i - 1][0] < p : out[i - 1][0] > p)) i--;
    out.splice(i, 0, [p, v]); if (out.length > n) out.pop();
  }
  return out;
}

/** OKX: CRC32 as a signed int of the 25 best levels, "bidPx:bidSz:askPx:askSz:..." with the exchange's own strings. */
function okxChecksum(bids, asks) { // [[price, [pxStr, szStr]], ...] best first
  const parts = [];
  for (let i = 0; i < 25; i++) {
    if (i < bids.length) parts.push(bids[i][1][0], bids[i][1][1]);
    if (i < asks.length) parts.push(asks[i][1][0], asks[i][1][1]);
  }
  return crc32(parts.join(':')) | 0;
}

const digits = (s) => s.replace('.', '').replace(/^0+/, '');
/** Kraken v2: CRC32 of the 10 best asks then the 10 best bids, price and qty written with the pair's precisions, without '.' nor leading zeros. */
function krakenChecksum(bids, asks, pp, qp) { // [[price, qty], ...] best first
  let s = '';
  for (const side of [asks, bids]) for (let i = 0; i < Math.min(10, side.length); i++) s += digits(side[i][0].toFixed(pp)) + digits(side[i][1].toFixed(qp));
  return crc32(s);
}

/** Switches a check off after 5 failures in 10 minutes: a format change must not reload the book forever. */
class Guard {
  constructor(name, log) { this.name = name; this.log = log; this.enabled = true; this.fails = []; this.checkedAt = 0; }
  off(why) { if (!this.enabled) return; this.enabled = false; this.log(`${this.name} check disabled: ${why}`); }
  fail(now) {
    this.fails = this.fails.filter(t => now - t < 600000); this.fails.push(now);
    if (this.fails.length >= 5) this.off('5 failures in 10 minutes');
  }
  /** Checksums are verified at most once a second (a wrong book stays wrong: it is still caught). */
  due(now) { if (!this.enabled || now - this.checkedAt < 1000) return false; this.checkedAt = now; return true; }
}

/**
 * OKX `books` channel: the exchange's strings of every level (the checksum uses them as sent),
 * the message chain and the checksum. apply() returns the reason to reload the book, or null.
 */
class OkxBook {
  constructor(log) { this.bids = new Map(); this.asks = new Map(); this.seq = null; this.chain = new Guard('OKX book sequence', log); this.sum = new Guard('OKX book checksum', log); }
  apply(d, snapshot, now) {
    if (snapshot) { this.bids.clear(); this.asks.clear(); }
    else if (this.chain.enabled && this.seq != null && d.prevSeqId != null && +d.prevSeqId !== this.seq) {
      const why = `sequence gap (${this.seq} -> ${d.prevSeqId})`; this.seq = null; this.chain.fail(now); return why;
    }
    for (const [side, m] of [[d.bids, this.bids], [d.asks, this.asks]]) {
      for (const lv of side || []) { const p = +lv[0]; if (+lv[1] > 0) m.set(p, [lv[0], lv[1]]); else m.delete(p); }
    }
    if (d.seqId != null) this.seq = +d.seqId;
    if (d.checksum == null) return null;
    if (snapshot) { // validates the algorithm on a complete book
      if (this.sum.enabled && this.checksum() !== +d.checksum) this.sum.off('the snapshot checksum does not match (format changed?)');
      return null;
    }
    if (!this.sum.due(now) || this.checksum() === +d.checksum) return null;
    this.sum.fail(now);
    return 'checksum mismatch';
  }
  checksum() { return okxChecksum(topLevels(this.bids, 25, true), topLevels(this.asks, 25, false)); }
}

/**
 * Kraken v2 `book` channel checksum, computed on the engine's book (numbers). The price / qty precisions
 * (1 / 8 for BTC/USD) are found on the snapshot: the pair whose checksum matches it.
 */
class KrakenCheck {
  constructor(log) { this.pp = 1; this.qp = 8; this.sum = new Guard('Kraken book checksum', log); }
  sums(book, pp, qp) { return krakenChecksum(topLevels(book.bids, 10, true), topLevels(book.asks, 10, false), pp, qp); }
  snapshot(book, checksum) {
    if (!this.sum.enabled || checksum == null) return;
    const bids = topLevels(book.bids, 10, true), asks = topLevels(book.asks, 10, false);
    if (krakenChecksum(bids, asks, this.pp, this.qp) === +checksum) return;
    for (let pp = 0; pp <= 10; pp++) for (let qp = 0; qp <= 12; qp++) {
      if (krakenChecksum(bids, asks, pp, qp) === +checksum) { this.pp = pp; this.qp = qp; return; }
    }
    this.sum.off('the snapshot checksum does not match (format changed?)');
  }
  /** After an update: the reason to reload the book, or null. */
  update(book, checksum, now) {
    if (checksum == null || !this.sum.due(now) || this.sums(book, this.pp, this.qp) === +checksum) return null;
    this.sum.fail(now);
    return 'checksum mismatch';
  }
}

module.exports = { crc32, topLevels, okxChecksum, krakenChecksum, Guard, OkxBook, KrakenCheck };

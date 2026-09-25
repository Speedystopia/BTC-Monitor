'use strict';
/* ============================================================================
 *  server/clock.js — align the engine clock on the exchanges' server time.
 *  A computer clock a few seconds off shifts every candle boundary and
 *  countdown. Like NTP: offset = server time - (request sent + answer
 *  received) / 2, keeping each exchange's fastest round trip (the first
 *  request also pays the TLS handshake), median over the exchanges,
 *  refreshed every 10 minutes.
 * ========================================================================== */

const MAX_RTT = 3000; // slower answers are too imprecise to be used

/** One measurement: { offset, rtt } (ms), or null when the answer is unusable or too slow. */
async function measure(serverTime) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, MAX_RTT, null); });
  const t0 = Date.now();
  try {
    const ts = await Promise.race([serverTime(), late]);
    const t1 = Date.now();
    if (!(ts > 0) || t1 - t0 > MAX_RTT) return null;
    return { offset: ts - (t0 + t1) / 2, rtt: t1 - t0 };
  } finally { clearTimeout(timer); }
}
/** Fastest of `tries` successive measurements of one exchange (null if none answered). */
async function best(serverTime, tries) {
  let found = null;
  for (let i = 0; i < tries; i++) {
    const r = await measure(serverTime).catch(() => null);
    if (r && (!found || r.rtt < found.rtt)) found = r;
  }
  return found;
}
function median(a) { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

/**
 * Measure now and every `everyMs`; sources: [[exchangeId, async () => serverTimeMs], ...].
 * Returns { ready, sync, stop }: `ready` resolves after the first measurement; sync() resolves
 * to the offset applied (null when no exchange answered).
 */
function startClock(engine, sources, log, opts) {
  const o = Object.assign({ everyMs: 10 * 60000, tries: 3 }, opts);
  let reported = null;
  async function sync() {
    const found = (await Promise.all(sources.map(([, fn]) => best(fn, o.tries)))).filter(Boolean);
    if (!found.length) { if (reported == null) { reported = 0; log('no exchange answered the time request: using this computer\'s clock'); } return null; }
    const offset = Math.round(median(found.map(r => r.offset)));
    if (!engine.setClockOffset(offset)) return null;
    // one line at startup, then only when the difference moves by a second or more
    if (reported == null || Math.abs(offset - reported) >= 1000) {
      reported = offset;
      const s = (Math.abs(offset) / 1000).toFixed(1);
      log(Math.abs(offset) < 1000
        ? `this computer's clock matches the exchanges (${offset >= 0 ? '+' : '-'}${s} s, ${found.length} measured)`
        : `this computer's clock is ${s} s ${offset > 0 ? 'behind' : 'ahead of'} the exchanges (${found.length} measured): candles and countdowns use the exchange time`);
    }
    return offset;
  }
  const ready = sync().catch(() => null);
  const timer = setInterval(() => { sync().catch(() => {}); }, o.everyMs);
  if (timer.unref) timer.unref();
  return { ready, sync, stop: () => clearInterval(timer) };
}

module.exports = { startClock, measure, best, median };

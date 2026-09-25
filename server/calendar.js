'use strict';
/* ============================================================================
 *  server/calendar.js — economic calendar (public weekly feed + manual events)
 * ========================================================================== */
const { getJson } = require('./net');

const FEEDS = ['https://nfs.faireconomy.media/ff_calendar_thisweek.json', 'https://nfs.faireconomy.media/ff_calendar_nextweek.json'];
const CURRENCY_FLAG = { USD: 'US', EUR: 'EU', GBP: 'GB', JPY: 'JP', CNY: 'CN', AUD: 'AU', NZD: 'NZ', CAD: 'CA', CHF: 'CH', ALL: null };
const IMPACT_RANK = { Low: 1, Medium: 2, High: 3 };

function flagEmoji(code) {
  if (!code) return '🌐';
  const cc = (CURRENCY_FLAG[code.toUpperCase()] !== undefined) ? CURRENCY_FLAG[code.toUpperCase()] : code.toUpperCase();
  if (!cc || cc.length !== 2) return '🌐';
  return String.fromCodePoint(...[...cc].map(ch => 0x1F1E6 + ch.charCodeAt(0) - 65));
}

function normalize(ev) {
  const time = typeof ev.time === 'number' ? ev.time : Date.parse(ev.time || ev.date);
  if (!isFinite(time)) return null;
  const impact = ev.impact === 'Holiday' ? 'Low' : (IMPACT_RANK[ev.impact] ? ev.impact : 'Medium');
  return { time, country: ev.country || 'All', flag: flagEmoji(ev.country), title: ev.title, impact, forecast: ev.forecast || '', previous: ev.previous || '', source: ev.source || 'feed' };
}

function startCalendar(config, engine, log) {
  const cfg = Object.assign({ forexFactory: true, minImpact: 'Medium', refreshMinutes: 20, manualEvents: [] }, config.calendar || {});
  const minRank = IMPACT_RANK[cfg.minImpact] || 2;
  let feedEvents = [];
  let timer = null;

  function publish() {
    const manual = (cfg.manualEvents || []).map(e => normalize(Object.assign({ source: 'manual' }, e))).filter(Boolean);
    const all = feedEvents.concat(manual).filter(e => (IMPACT_RANK[e.impact] || 0) >= minRank || e.source === 'manual');
    engine.setCalendar(all);
  }

  async function refresh() {
    if (!cfg.forexFactory) { publish(); return; }
    const collected = [];
    for (const url of FEEDS) {
      try {
        const rows = await getJson(url, { timeout: 20000 });
        if (Array.isArray(rows)) for (const r of rows) { const n = normalize(r); if (n) collected.push(n); }
      } catch (e) {
        if (!/404/.test(e.message)) log(`calendar feed failed: ${e.message.slice(0, 100)}`);
      }
    }
    if (collected.length) { feedEvents = collected; log(`calendar: ${collected.length} events loaded`); }
    publish();
  }

  refresh();
  timer = setInterval(refresh, Math.max(5, cfg.refreshMinutes) * 60000);
  return { stop: () => clearInterval(timer), refresh };
}

module.exports = { startCalendar, flagEmoji, normalize };

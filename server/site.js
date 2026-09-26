'use strict';
/* ============================================================================
 *  server/site.js — the public website (config.js `site`; Docker: .env):
 *  legal notice page, ads.txt and Google AdSense.
 *
 *  Only pages opened through one of `site.domains` (your domain, behind Caddy)
 *  get the site settings (legal link, ads). OBS, the streamer container and
 *  this computer open the dashboard by another address and get the plain
 *  dashboard: a stream must never show ads, impressions made by a machine are
 *  invalid traffic for AdSense (the account can be closed).
 * ========================================================================== */
const PUB_ID = /^ca-pub-\d{10,20}$/, SLOT_ID = /^\d{5,20}$/;
const LEGAL_PATH = '/privacy.html';

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Host names from a string ("a.com, www.a.com") or an array, lower case. */
const hostList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map(h => String(h).trim().toLowerCase().replace(/\.$/, '')).filter(Boolean);

/** Checked settings of config.js `site`: { domains, legal, adsense } — adsense is null when off or misconfigured. */
function siteSettings(cfg, log) {
  const c = cfg || {}, a = c.adsense || {}, l = c.legal || {};
  const domains = hostList(c.domains);
  // the account page shows the publisher id as pub-...; the ad code needs ca-pub-...
  const client = String(a.client || '').trim().replace(/^pub-/, 'ca-pub-'), slot = String(a.slot || '').trim();
  let adsense = null;
  if (client) {
    if (!PUB_ID.test(client)) log(`AdSense: "${client}" is not a publisher id (ca-pub-0000000000000000): no ads`);
    else if (slot && !SLOT_ID.test(slot)) log(`AdSense: the ad unit id must be digits only (got "${slot}"): no ads`);
    else if (!domains.length) log('AdSense: no public domain name (site.domains, DOMAIN in .env): no ads');
    else adsense = { client, slot };
  }
  const legal = { editor: String(l.editor || '').trim(), contact: String(l.contact || '').trim(), hosting: String(l.hosting || '').trim() };
  return { domains, adsense, legal };
}

/** True when the request came through one of the public domain names (Host, or X-Forwarded-Host set by a proxy). */
function isPublic(site, req) {
  if (!site || !site.domains.length) return false;
  for (const h of [req.headers['x-forwarded-host'], req.headers.host]) {
    for (const name of String(h || '').split(',')) if (site.domains.includes(name.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, ''))) return true;
  }
  return false;
}

/**
 * The dashboard page for a public visitor: settings read by public/app.js (legal link, ad unit), the AdSense
 * site-verification tag, and the ad unit size per screen width (AdSense asks for this CSS in the page itself).
 * The AdSense script is added by the page, except in OBS or with ?ads=0.
 */
function publicPage(site, html) {
  const conf = { legal: LEGAL_PATH, adsense: site.adsense };
  let head = `<script type="application/json" id="btcm-site">${JSON.stringify(conf).replace(/</g, '\\u003c')}</script>\n`;
  if (site.adsense) {
    head += `<meta name="google-adsense-account" content="${site.adsense.client}">\n`;
    // same widths as the left column of styles.css (308 / 250 / 200 px); phones: a banner under the chart
    if (site.adsense.slot) head += '<style>.btcm-ad{width:300px;height:250px}@media (max-width:1500px){.btcm-ad{width:250px;height:250px}}'
      + '@media (max-width:1100px){.btcm-ad{width:200px;height:200px}}@media (max-width:800px){.btcm-ad{width:320px;height:50px}}</style>\n';
  }
  const s = html.toString();
  return s.includes('</head>') ? s.replace('</head>', () => head + '</head>') : s;
}

/** ads.txt: this publisher id is allowed to sell the ads of the site (Google checks it on the domain root). */
function adsTxt(site) { return site && site.adsense ? `google.com, ${site.adsense.client.replace(/^ca-/, '')}, DIRECT, f08c47fec0942fa0\n` : null; }

/** public/privacy.html filled in: {{editor}} {{contact}} {{hosting}} {{domain}}; the AdSense section only with ads. */
function legalPage(site, html) {
  const s = site || { domains: [], adsense: null, legal: {} };
  const todo = (what) => `<mark>[à compléter : ${what} dans .env]</mark>`;
  const fill = { editor: s.legal.editor ? esc(s.legal.editor) : todo('SITE_EDITOR'), contact: s.legal.contact ? esc(s.legal.contact) : todo('SITE_CONTACT'),
    hosting: s.legal.hosting ? esc(s.legal.hosting) : todo('SITE_HOSTING'), domain: esc(s.domains[0] || 'ce site') };
  return html.toString()
    .replace(/<!--adsense-->([\s\S]*?)<!--\/adsense-->/g, (m, body) => (s.adsense ? body : ''))
    .replace(/\{\{(editor|contact|hosting|domain)\}\}/g, (m, k) => fill[k]);
}

module.exports = { siteSettings, isPublic, publicPage, adsTxt, legalPage, LEGAL_PATH };

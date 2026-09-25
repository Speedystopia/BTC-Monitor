'use strict';
/* ============================================================================
 *  server/paths.js — where files live, both when running from the sources
 *  (node server/index.js) and when running as a single executable
 *  (BTC-Monitor.exe built with tools/build-exe.js, Node "SEA").
 *
 *  In executable mode the root folder is the folder containing the .exe:
 *  config.js is loaded from there (created from the built-in default on first
 *  run), public/ files are served from disk when present (else from the
 *  assets embedded in the executable), and data/ is written next to the .exe.
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

let sea = null;
try { const m = require('node:sea'); if (m && typeof m.isSea === 'function' && m.isSea()) sea = m; } catch (e) { sea = null; }

const IS_EXE = !!sea;
const ROOT = IS_EXE ? path.dirname(process.execPath) : path.join(__dirname, '..');

/** Read an embedded asset (executable mode) or null. */
function embedded(key) {
  if (!sea) return null;
  try { return Buffer.from(sea.getAsset(key)); } catch (e) { return null; }
}

/** Load config.js from the root folder; in executable mode create it from the default on first run. */
function loadConfig() {
  const file = path.join(ROOT, 'config.js');
  if (!IS_EXE) return require(file);
  if (!fs.existsSync(file)) {
    const def = embedded('config.js');
    if (def) { try { fs.writeFileSync(file, def); } catch (e) { /* read-only folder: fall through */ } }
  }
  const { createRequire } = require('module');
  if (fs.existsSync(file)) {
    try { return createRequire(file)(file); }
    catch (e) { console.error(`config.js could not be loaded (${e.message}); using the built-in defaults`); }
  }
  // last resort: evaluate the embedded default config
  const src = embedded('config.js');
  const mod = { exports: {} };
  new Function('module', 'exports', 'process', src ? src.toString() : 'module.exports = {}')(mod, mod.exports, process);
  return mod.exports;
}

/** Read a static file: disk first (customisable), then the embedded copy. */
function readStatic(relPath, cb) {
  const full = path.normalize(path.join(ROOT, relPath));
  if (!full.startsWith(ROOT + path.sep)) return cb(new Error('forbidden'));
  fs.readFile(full, (err, data) => {
    if (!err) return cb(null, data);
    const emb = embedded(relPath.replace(/\\/g, '/').replace(/^\//, ''));
    if (emb) return cb(null, emb);
    cb(err);
  });
}

/** Open the default browser on a URL (best effort, never throws). */
function openBrowser(url) {
  try {
    const { spawn } = require('child_process');
    let cmd, args;
    if (process.platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', url.replace(/&/g, '^&')]; }
    else if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
    else { cmd = 'xdg-open'; args = [url]; }
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    p.on('error', () => {}); p.unref();
  } catch (e) { /* ignore */ }
}

module.exports = { IS_EXE, ROOT, loadConfig, readStatic, openBrowser, embedded };

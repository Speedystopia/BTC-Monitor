/* ============================================================================
 *  public/audio.js — Web Audio alert tones (no external files needed)
 * ========================================================================== */
window.BTCM_AUDIO = (function () {
  'use strict';
  let ctx = null; let enabled = true;

  function ensure(resume) {
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
    if (resume && ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }
  function tone(freq, start, dur, type, gain) {
    const c = ctx; if (!c) return;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, c.currentTime + start);
    g.gain.exponentialRampToValueAtTime(gain || 0.25, c.currentTime + start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
    o.connect(g); g.connect(c.destination); o.start(c.currentTime + start); o.stop(c.currentTime + start + dur + 0.05);
  }
  const PATTERNS = {
    overbought: () => { tone(1320, 0, 0.14, 'square', 0.12); tone(1320, 0.2, 0.14, 'square', 0.12); tone(1760, 0.4, 0.3, 'square', 0.12); },
    oversold: () => { tone(440, 0, 0.14, 'square', 0.12); tone(440, 0.2, 0.14, 'square', 0.12); tone(330, 0.4, 0.3, 'square', 0.12); },
    bullish: () => { tone(523, 0, 0.15, 'triangle', 0.3); tone(659, 0.16, 0.15, 'triangle', 0.3); tone(784, 0.32, 0.15, 'triangle', 0.3); tone(1047, 0.48, 0.4, 'triangle', 0.3); },
    bearish: () => { tone(1047, 0, 0.15, 'triangle', 0.3); tone(784, 0.16, 0.15, 'triangle', 0.3); tone(659, 0.32, 0.15, 'triangle', 0.3); tone(523, 0.48, 0.4, 'triangle', 0.3); },
    reversal: () => { tone(880, 0, 0.1, 'sine', 0.25); tone(1108, 0.12, 0.1, 'sine', 0.25); tone(880, 0.24, 0.25, 'sine', 0.25); },
    click: () => { tone(1500, 0, 0.05, 'sine', 0.1); },
  };
  /** Play an alert pattern (silently ignored until the browser allowed audio). */
  function play(kind) {
    if (!enabled) return;
    const c = ensure(false); if (!c || c.state !== 'running') return;
    const p = PATTERNS[kind]; if (p) p();
  }
  /** Call from a user gesture (click/keypress) to satisfy autoplay policies. */
  function unlock() { const c = ensure(true); return !!c && c.state === 'running'; }
  function setEnabled(v) { enabled = !!v; }
  function isEnabled() { return enabled; }
  function isUnlocked() { return !!ctx && ctx.state === 'running'; }
  return { play, unlock, setEnabled, isEnabled, isUnlocked };
})();

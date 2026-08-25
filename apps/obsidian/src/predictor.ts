// SP-1 instant typing — Mosh-style predictive local echo, ported from app.js L2056-2144.
// The guess is painted in an overlay above the cursor cell and never written into the
// xterm buffer; real output always wins because the overlay is cleared before every write.
import type { Terminal } from '@xterm/xterm';

const SECRET = /passw|passphrase|secret|\bpin\b|passcode|token/i;
const ECHO_TIMEOUT = 400;
const SWEEP = 200;
const dec = new TextDecoder();

export class Predictor {
  pending: { ch: string; at: number }[] = [];
  shown = '';
  confidence = 0;
  sweepTimer: number | null = null;
  el: HTMLDivElement | null = null;
  enabled = true;

  constructor(private term: Terminal, private host: HTMLElement, private fg: () => string) {}

  private screen(): HTMLElement | null { return this.host.querySelector('.xterm-screen'); }

  private lineText(): string {
    const b = this.term.buffer.active;
    return b.getLine(b.baseY + b.cursorY)?.translateToString(true) ?? '';
  }

  /** Call first in term.onData. */
  key(d: string) {
    if (!this.enabled) return;
    if (d.length !== 1 || d < ' ' || d > '~') { this.pending = []; this.clear(); return; }
    if (this.term.buffer.active.type === 'alternate') { this.clear(); return; }
    this.pending.push({ ch: d, at: performance.now() });
    this.armSweep();
    const line = this.lineText();
    if (this.confidence >= 2 && !SECRET.test(line) && line.length <= this.term.buffer.active.cursorX) {
      this.shown += d;
      this.paint();
    }
  }

  /** Call just before term.write(raw). */
  data(raw: string | Uint8Array) {
    if (this.shown) this.clear();
    if (!this.pending.length) return;
    let txt = typeof raw === 'string' ? raw : dec.decode(raw);
    txt = txt.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[@-~]/g, '');
    const now = performance.now();
    while (this.pending.length) {
      const p = this.pending[0];
      const i = txt.indexOf(p.ch);
      if (i >= 0) { this.confidence = Math.min(this.confidence + 1, 8); txt = txt.slice(i + 1); this.pending.shift(); }
      else if (now - p.at > ECHO_TIMEOUT) { this.confidence = 0; this.pending.shift(); }
      else break;
    }
  }

  private armSweep() {
    if (this.sweepTimer) return;
    this.sweepTimer = window.setInterval(() => {
      const now = performance.now();
      if (this.pending.some(p => now - p.at > ECHO_TIMEOUT)) { this.confidence = 0; this.pending = this.pending.filter(p => now - p.at <= ECHO_TIMEOUT); this.clear(); }
      if (!this.pending.length && this.sweepTimer) { window.clearInterval(this.sweepTimer); this.sweepTimer = null; }
    }, SWEEP);
  }

  private paint() {
    const scr = this.screen(); if (!scr) return;
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'winmux-predict';
      scr.appendChild(this.el);
    }
    const cw = scr.clientWidth / this.term.cols, ch = scr.clientHeight / this.term.rows;
    const b = this.term.buffer.active;
    const startX = b.cursorX - (this.shown.length - 1);
    Object.assign(this.el.style, {
      left: Math.max(0, startX) * cw + 'px', top: b.cursorY * ch + 'px', height: ch + 'px', lineHeight: ch + 'px',
      font: `${this.term.options.fontSize}px ${this.term.options.fontFamily}`, color: this.fg(),
    });
    this.el.textContent = this.shown;
  }

  clear() { this.shown = ''; if (this.el) this.el.textContent = ''; }

  dispose() { if (this.sweepTimer) window.clearInterval(this.sweepTimer); this.el?.remove(); this.el = null; }
}

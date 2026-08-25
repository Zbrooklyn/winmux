// One Obsidian tab = one WinMux terminal session over /pty.
import { ItemView, WorkspaceLeaf, Scope, Menu, Notice } from 'obsidian';
import { RenameModal } from './modals';
import { Predictor } from './predictor';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type WinMuxPlugin from './main';

export const VIEW_TERMINAL = 'winmux-terminal';
export type TermStatus = 'idle' | 'working' | 'needsyou' | 'closed';
export interface TermState { sid?: string; shell?: string; cwd?: string; title?: string }

const IDLE_MS = 1200; // mirrors app.js markWorking

export class TerminalView extends ItemView {
  term!: Terminal;
  fit!: FitAddon;
  ws: WebSocket | null = null;
  state: TermState = {};
  status: TermStatus = 'idle';
  busy: number | null = null;
  ro: ResizeObserver | null = null;
  host!: HTMLElement;
  reconnectTimer: number | null = null;
  exitEl: HTMLElement | null = null;
  pred: Predictor | null = null;
  shellKey = '';

  constructor(leaf: WorkspaceLeaf, private plugin: WinMuxPlugin) { super(leaf); }

  getViewType() { return VIEW_TERMINAL; }
  getIcon() { return 'terminal'; }
  getDisplayText() { return this.state.title || this.autoTitle(); }

  autoLabel = '';

  autoTitle(): string {
    const cwd = (this.state.cwd || '').replace(/[\\/]+$/, '');
    const folder = cwd.split(/[\\/]/).pop() || cwd || 'terminal';
    const shell = this.state.shell || '';
    if (this.autoLabel && this.autoLabel !== shell) return `${folder} · ${this.autoLabel}`;
    return shell ? `${folder} · ${shell}` : folder;
  }

  getState(): Record<string, unknown> { return { ...this.state, shellKey: this.shellKey }; }
  async setState(state: any, result: any) {
    this.state = { sid: state?.sid, shell: state?.shell, cwd: state?.cwd, title: state?.title };
    if (state?.shellKey) this.shellKey = state.shellKey;
    await super.setState(state, result);
    if (this.term) { this.connect(); this.refreshTitle(); }
  }

  async onOpen() {
    this.contentEl.addClass('winmux-terminal-view');
    this.host = this.contentEl.createDiv({ cls: 'winmux-term' });
    const s = this.plugin.settings;
    this.term = new Terminal({
      allowProposedApi: true,
      fontSize: s.fontSize,
      fontFamily: this.fontFamily(),
      lineHeight: 1.25,
      letterSpacing: 0,
      cursorStyle: s.cursorStyle,
      cursorBlink: s.cursorBlink,
      cursorWidth: 2,
      scrollback: s.scrollback,
      minimumContrastRatio: 3,
      theme: this.theme(),
      windowsPty: { backend: 'conpty' },
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon());
    this.term.open(this.host);
    this.term.onData(d => {
      if (this.status === 'closed') { if (d === '\r') this.restart(); return; }
      this.pred?.key(d);
      if (this.plugin.broadcast) { this.plugin.broadcastInput(d); return; }
      this.send({ t: 'i', d });
    });
    this.term.onTitleChange(title => {
      // OSC 0/2 from the shell — ignore bare exe paths, honour manual renames.
      if (!title || /\.exe$/i.test(title.trim()) || this.state.title) return;
      this.autoLabel = title.trim();
      this.refreshTitle();
    });
    this.pred = new Predictor(this.term, this.host, () => this.term.options.theme?.foreground || '#888');
    this.pred.enabled = this.plugin.settings.localEcho;
    this.term.onResize(({ cols, rows }) => this.send({ t: 'r', c: cols, r: rows }));
    this.term.onSelectionChange(() => { if (this.plugin.settings.copyOnSelect && this.term.hasSelection()) navigator.clipboard.writeText(this.term.getSelection()); });
    this.host.addEventListener('contextmenu', (e) => {
      if (this.plugin.settings.rightClickPaste) { e.preventDefault(); navigator.clipboard.readText().then(t => { if (t) this.term.paste(t); }); return; }
      e.preventDefault();
      const m = new Menu();
      if (this.term.hasSelection()) m.addItem(i => i.setTitle('Copy').setIcon('copy').onClick(() => navigator.clipboard.writeText(this.term.getSelection())));
      m.addItem(i => i.setTitle('Paste').setIcon('clipboard').onClick(() => navigator.clipboard.readText().then(t => { if (t) this.term.paste(t); })));
      m.addItem(i => i.setTitle('Select all').setIcon('text-select').onClick(() => this.term.selectAll()));
      m.addSeparator();
      this.onPaneMenu(m, 'context');
      m.showAtMouseEvent(e);
    });
    this.term.onBell(() => { if (!this.isFocused()) { this.setStatus('needsyou'); this.plugin.notify(this, 'Terminal needs attention'); } });
    this.term.textarea?.addEventListener('focus', () => { if (this.status === 'needsyou') this.setStatus('idle'); });

    // Keys Obsidian would otherwise swallow while a terminal is focused. A scope
    // handler that returns false stops the event before xterm's textarea ever sees
    // it, so we block Obsidian AND hand the shell the sequence ourselves.
    this.scope = new Scope(this.app.scope);
    for (const k of s.passthroughKeys) {
      const parts = k.split('+'); const key = parts.pop()!;
      this.scope.register(parts as any, key, (evt) => {
        if (!this.isFocused()) return true; // not ours — let Obsidian have it
        this.handleKey(evt);
        return false;
      });
    }

    this.registerEvent(this.app.workspace.on('css-change', () => this.applyTheme()));
    this.registerEvent(this.app.workspace.on('resize', () => this.refit()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', (l) => { if (l === this.leaf) this.refit(); }));
    this.ro = new ResizeObserver(() => this.refit());
    this.ro.observe(this.contentEl);
    // First layout can land after onOpen; fit again once the pane has real dimensions.
    this.refit();
    requestAnimationFrame(() => this.refit());
    setTimeout(() => this.refit(), 150);
    setTimeout(() => this.refit(), 600);
    if (this.state.shell || this.state.sid) this.connect();
  }

  onPaneMenu(menu: Menu, source: string) {
    if (source !== 'context') { super.onPaneMenu(menu, source); menu.addSeparator(); }
    menu.addItem(i => i.setSection('winmux').setTitle('Rename terminal').setIcon('pencil').onClick(() => this.promptRename()));
    menu.addItem(i => i.setSection('winmux').setTitle('Duplicate here').setIcon('copy').onClick(() => this.plugin.openSession(undefined, this.shellKey || this.state.shell, this.state.cwd)));
    menu.addItem(i => i.setSection('winmux').setTitle('Clear scrollback').setIcon('eraser').onClick(() => this.term.clear()));
    menu.addItem(i => i.setSection('winmux').setTitle('Restart shell').setIcon('rotate-ccw').onClick(() => { this.disconnect(true); this.restart(); }));
    menu.addItem(i => i.setSection('winmux').setTitle('End session').setIcon('trash').onClick(() => { this.disconnect(true); this.leaf.detach(); }));
  }

  promptRename() {
    new RenameModal(this.app, this.state.title || this.autoTitle(), (name) => {
      this.state.title = name.trim() || undefined;
      this.app.workspace.requestSaveLayout();
      this.refreshTitle();
      this.plugin.sessionsChanged();
    }).open();
  }

  /** Translate a blocked hotkey into what the shell expects. */
  handleKey(evt: KeyboardEvent) {
    const k = evt.key;
    if (evt.ctrlKey && evt.shiftKey && k.toLowerCase() === 'c') { // copy selection
      const sel = this.term.getSelection(); if (sel) navigator.clipboard.writeText(sel); return;
    }
    if (evt.ctrlKey && !evt.shiftKey && k.toLowerCase() === 'v') { // paste
      navigator.clipboard.readText().then(t => { if (t) this.term.paste(t); }); return;
    }
    if (evt.ctrlKey && !evt.shiftKey && k.toLowerCase() === 'c' && this.term.hasSelection()) { // copy, like Windows Terminal
      navigator.clipboard.writeText(this.term.getSelection()); this.term.clearSelection(); return;
    }
    if (k === 'Tab') return; // Ctrl+Tab has no shell meaning; just keep Obsidian from switching tabs
    if (evt.ctrlKey && !evt.altKey && k.length === 1) {
      const c = k.toUpperCase().charCodeAt(0);
      if (c >= 64 && c <= 95) { this.term.input(String.fromCharCode(c - 64), true); return; }
    }
  }

  isFocused(): boolean {
    return document.hasFocus() && this.app.workspace.activeLeaf === this.leaf && !!this.term.textarea && document.activeElement === this.term.textarea;
  }

  theme() {
    const cs = getComputedStyle(document.body);
    // xterm rejects modern CSS colour syntax (color-mix, hsl(calc…)) and then drops the
    // WHOLE theme, so resolve every value to a plain rgb() via a probe element.
    const probe = document.body.createDiv();
    const v = (n: string, fb: string) => {
      const raw = cs.getPropertyValue(n).trim();
      if (!raw) return fb;
      probe.style.color = raw;
      const out = getComputedStyle(probe).color;
      return out && out !== 'rgba(0, 0, 0, 0)' ? out : fb;
    };
    const mix = (n: string, fb: string, pct: number, toward: string) => {
      probe.style.color = `color-mix(in srgb, ${cs.getPropertyValue(n).trim() || fb} ${pct}%, ${toward})`;
      return getComputedStyle(probe).color || fb;
    };
    const dark = document.body.classList.contains('theme-dark');
    const fg = v('--text-normal', dark ? '#dadada' : '#222222');
    const bg = v('--background-primary', dark ? '#1e1e1e' : '#ffffff');
    const t = {
      background: bg,
      foreground: fg,
      cursor: v('--text-accent', '#a882ff'),
      cursorAccent: bg,
      selectionBackground: mix('--text-accent', '#a882ff', 25, 'transparent'),
      selectionInactiveBackground: mix('--text-accent', '#a882ff', 12, 'transparent'),
      // ANSI 16 from the vault palette so shells, git and Claude match the theme.
      black: dark ? v('--background-modifier-border', '#3a3a3a') : v('--text-muted', '#5c5c5c'),
      red: v('--color-red', '#e93147'),
      green: v('--color-green', '#08b94e'),
      yellow: v('--color-yellow', '#e0ac00'),
      blue: v('--color-blue', '#086ddd'),
      magenta: v('--color-purple', '#7852ee'),
      cyan: v('--color-cyan', '#00bfbc'),
      white: dark ? v('--text-muted', '#999999') : v('--text-faint', '#aaaaaa'),
      brightBlack: v('--text-faint', '#888888'),
      brightRed: mix('--color-red', '#e93147', 80, fg),
      brightGreen: mix('--color-green', '#08b94e', 80, fg),
      brightYellow: mix('--color-yellow', '#e0ac00', 80, fg),
      brightBlue: mix('--color-blue', '#086ddd', 80, fg),
      brightMagenta: mix('--color-purple', '#7852ee', 80, fg),
      brightCyan: mix('--color-cyan', '#00bfbc', 80, fg),
      brightWhite: fg,
    };
    probe.remove();
    return t;
  }

  applyTheme() {
    if (!this.term) return;
    this.term.options.theme = this.theme();
    this.term.options.fontFamily = this.fontFamily();
  }

  fontFamily(): string {
    const s = this.plugin.settings.fontFamily.trim();
    if (s) return s;
    const mono = getComputedStyle(document.body).getPropertyValue('--font-monospace').trim();
    return mono || 'Cascadia Mono, Consolas, monospace';
  }

  refit() {
    if (!this.term || this.contentEl.clientWidth < 20 || this.contentEl.clientHeight < 20) return;
    try { this.fit.fit(); } catch { /* not attached yet */ }
  }

  send(msg: object) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  connect() {
    this.disconnect(false);
    const core = this.plugin.core;
    if (!core.inst) { this.term.writeln('\x1b[33mWinMux engine not connected.\x1b[0m'); return; }
    const key = this.shellKey || this.plugin.shellKeyFor(this.state.shell) || this.plugin.settings.defaultShell;
    const url = core.ptyUrl({ shell: key, cwd: this.state.cwd, sid: this.state.sid });
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => { this.refit(); this.send({ t: 'r', c: this.term.cols, r: this.term.rows }); };
    ws.onmessage = ev => {
      if (typeof ev.data === 'string') {
        let m: any = null; try { m = JSON.parse(ev.data); } catch { /* raw text */ }
        if (m && m.type === 'meta') return this.onMeta(m);
        this.pred?.data(ev.data); this.term.write(ev.data); this.markWorking();
        return;
      }
      const bytes = new Uint8Array(ev.data); this.pred?.data(bytes); this.term.write(bytes); this.markWorking();
    };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; if (this.status !== 'closed') this.scheduleReconnect(); } };
    ws.onerror = () => { /* onclose follows */ };
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => { this.reconnectTimer = null; if (this.state.sid) this.connect(); }, 1500);
  }

  onMeta(m: any) {
    if (m.sid) {
      const changed = m.sid !== this.state.sid || m.shell !== this.state.shell || m.cwd !== this.state.cwd;
      this.state.sid = m.sid; this.state.shell = m.shell || this.state.shell; this.state.cwd = m.cwd || this.state.cwd;
      if (changed) this.app.workspace.requestSaveLayout();
      this.refreshTitle();
      if (m.lost) this.term.writeln('\r\n\x1b[33m[session was lost — started fresh]\x1b[0m');
      if (m.cwdLost) this.term.writeln(`\x1b[33m[folder not found: ${m.cwdLost} — opened in ${m.cwd}]\x1b[0m`);
      this.plugin.sessionsChanged();
    }
    if (m.exited) {
      this.setStatus('closed');
      this.showExited(m.code ?? '?');
      this.plugin.sessionsChanged();
    }
    if (m.error) this.term.writeln(`\r\n\x1b[31m[${m.error}]\x1b[0m`);
  }

  markWorking() {
    if (this.status === 'closed') return;
    if (this.status !== 'needsyou') this.setStatus('working');
    if (this.busy) window.clearTimeout(this.busy);
    this.busy = window.setTimeout(() => { this.busy = null; if (this.status === 'working') this.setStatus('idle'); }, IDLE_MS);
  }

  setStatus(s: TermStatus) {
    if (this.status === s) return;
    this.status = s;
    this.updateTabStatus();
    this.plugin.sessionsChanged();
  }

  /** Small dot in the Obsidian tab header: orange = working, red = needs you, grey = ended. */
  updateTabStatus() {
    const box: HTMLElement | undefined = (this.leaf as any).tabHeaderStatusContainerEl;
    if (!box) return;
    let dot = box.querySelector<HTMLElement>('.winmux-tab-dot');
    if (this.status === 'idle') { dot?.remove(); return; }
    if (!dot) dot = box.createSpan({ cls: 'winmux-tab-dot' });
    dot.className = 'winmux-tab-dot is-' + this.status;
    dot.setAttr('aria-label', this.status === 'working' ? 'Working' : this.status === 'needsyou' ? 'Needs you' : 'Ended');
  }

  showExited(code: number | string) {
    this.exitEl?.remove();
    this.exitEl = this.contentEl.createDiv({ cls: 'winmux-exited' });
    this.exitEl.createSpan({ cls: 'winmux-exited-msg', text: `Process ended${code === 0 || code === '0' ? '' : ' · exit code ' + code}` });
    const b = this.exitEl.createEl('button', { text: 'Restart' });
    b.onclick = () => this.restart();
    this.exitEl.createSpan({ cls: 'winmux-exited-hint', text: 'or press Enter' });
    this.term.write('\x1b[?25l'); // hide the cursor of a dead pty
    this.term.textarea?.focus();
  }

  restart() {
    this.exitEl?.remove(); this.exitEl = null;
    this.state.sid = undefined;
    this.status = 'idle';
    this.term.reset();
    this.term.write('\x1b[?25h');
    this.connect();
    this.updateTabStatus();
    this.plugin.sessionsChanged();
  }

  /** Close the tab; the engine keeps the session for 30 s, then it lands in backlog. */
  disconnect(end: boolean) {
    if (this.reconnectTimer) { window.clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      const ws = this.ws; this.ws = null;
      if (end) { try { ws.send(JSON.stringify({ t: 'x' })); } catch { /* ignore */ } }
      try { ws.close(); } catch { /* ignore */ }
    }
  }

  refreshTitle() {
    this.updateTabStatus();
    const t = this.getDisplayText();
    (this as any).titleEl?.setText?.(t);
    (this.leaf as any).tabHeaderInnerTitleEl?.setText?.(t);
    (this.leaf as any).updateHeader?.();
  }

  respond(approve: boolean) {
    this.send({ t: 'i', d: approve ? '\r' : '\x1b' });
    if (this.status === 'needsyou') this.setStatus('idle');
  }

  focusTerm() { this.term?.focus(); }

  serialize(lines = 0): string {
    const b = this.term.buffer.active;
    const out: string[] = [];
    const start = lines > 0 ? Math.max(0, b.length - lines) : 0;
    for (let i = start; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
    return out.join('\n').replace(/\n+$/, '');
  }

  async onClose() {
    this.ro?.disconnect();
    this.pred?.dispose();
    this.disconnect(false);
    this.term?.dispose();
    this.plugin.sessionsChanged();
  }
}

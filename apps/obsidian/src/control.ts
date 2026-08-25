// Agent control plane: the plugin registers on the engine's /control socket and
// answers the same verbs the WinMux app answers (app.js runControl, L5930-6093),
// so the `winmux` CLI, the MCP server and the orchestrate skill work unchanged.
import { Notice } from 'obsidian';
import type WinMuxPlugin from './main';
import type { TerminalView } from './terminal';
import { openProjectLayout } from './surfaces';

export class ControlClient {
  ws: WebSocket | null = null;
  attempts = 0;
  timer: number | null = null;
  stopped = false;
  constructor(private plugin: WinMuxPlugin) {}

  connect() {
    this.stopped = false;
    const core = this.plugin.core;
    if (!core.inst) return;
    try { this.ws?.close(); } catch { /* ignore */ }
    const ws = new WebSocket(core.wsBase + '/control');
    this.ws = ws;
    ws.onopen = () => { this.attempts = 0; };
    ws.onmessage = (ev) => {
      let m: any; try { m = JSON.parse(ev.data); } catch { return; }
      if (!m || !m.rpc) return;
      Promise.resolve().then(() => this.run(m.cmd, m.args || {})).then(
        result => ws.send(JSON.stringify({ rpc: m.rpc, ok: true, result })),
        e => ws.send(JSON.stringify({ rpc: m.rpc, ok: false, error: String((e && e.message) || e) })),
      );
    };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; if (!this.stopped) this.scheduleReconnect(); } };
    ws.onerror = () => { /* onclose follows */ };
  }

  scheduleReconnect() {
    if (this.timer) return;
    const delay = Math.min(30000, 750 * Math.pow(2, this.attempts++));
    this.timer = window.setTimeout(() => { this.timer = null; this.connect(); }, delay);
  }

  stop() { this.stopped = true; if (this.timer) { window.clearTimeout(this.timer); this.timer = null; } try { this.ws?.close(); } catch { /* ignore */ } this.ws = null; }

  get connected() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }

  // ---- target resolution (app.js termByTarget / termBySid)
  private views(): TerminalView[] { return this.plugin.terminalViews(); }
  private active(): TerminalView | null { return this.plugin.activeTerminal(); }
  private byTarget(target: any): TerminalView | null {
    if (target === undefined || target === null || target === '') return this.active();
    return this.views().find(v => String(v.tid) === String(target)) || null;
  }
  private bySid(sid: any): TerminalView | null { return sid ? this.views().find(v => v.state.sid === sid) || null : null; }
  private need(target: any): TerminalView { const v = this.byTarget(target); if (!v) throw new Error('no such terminal'); return v; }

  private info(v: TerminalView) { return { id: v.tid, title: v.getDisplayText(), shell: v.shellKey || this.plugin.shellKeyFor(v.state.shell) || v.state.shell || '', cwd: v.state.cwd || '', group: '', active: v === this.active(), sid: v.state.sid || null }; }

  async run(cmd: string, args: any): Promise<any> {
    switch (cmd) {
      case 'list': return { sessions: this.views().map(v => this.info(v)) };
      case 'read-screen': { const v = this.need(args.target); return { id: v.tid, title: v.getDisplayText(), screen: v.serialize(Number(args.lines) || 0) }; }
      case 'send': {
        const v = this.need(args.target);
        if (!v.ws || v.ws.readyState !== WebSocket.OPEN) throw new Error('that terminal is not connected');
        const data = String(args.data ?? '') + (args.enter ? '\r' : '');
        v.send({ t: 'i', d: data });
        return { id: v.tid, sent: data.length };
      }
      case 'new-tab': { const v = await this.plugin.openSession(undefined, args.shell || undefined, args.cwd || undefined); await this.settle(v); return { id: v.tid }; }
      case 'split': {
        const dir = args.dir === 'down' ? 'horizontal' : 'vertical';
        const from = this.active();
        const v = await this.plugin.openSession(undefined, args.shell || from?.shellKey || undefined, args.cwd || from?.state.cwd || undefined, undefined, dir, from?.leaf);
        await this.settle(v);
        return { ok: true, dir: args.dir === 'down' ? 'down' : 'right', id: v.tid };
      }
      case 'close': {
        const v = this.need(args.target);
        const title = v.getDisplayText(); const id = v.tid;
        v.disconnect(true); v.leaf.detach();
        return { closed: 'tab', id, title, tabsLeft: this.views().length };
      }
      case 'focus': { const v = this.need(args.target); this.plugin.app.workspace.setActiveLeaf(v.leaf, { focus: true }); this.plugin.app.workspace.revealLeaf(v.leaf); v.focusTerm(); return { id: v.tid }; }
      case 'notify': {
        const v = this.need(args.target);
        const message = args.message || 'needs your attention';
        v.setStatus('needsyou'); this.plugin.notify(v, message);
        return { id: v.tid, notified: true };
      }
      case 'agent': {
        const state = String(args.state || '').toLowerCase();
        const v = this.bySid(args.sid) || this.need(args.target);
        if (state === 'needs-you' || state === 'needsyou' || state === 'blocked') { v.setStatus('needsyou'); this.plugin.notify(v, args.message || 'Claude needs your input'); return { id: v.tid, sid: v.state.sid, state: 'needs-you' }; }
        if (state === 'working') { v.setStatus('working'); v.lastLine = args.message || ''; v.holdWorking(); return { id: v.tid, sid: v.state.sid, state: 'working' }; }
        if (state === 'done' || state === 'idle') { v.setStatus('idle'); return { id: v.tid, sid: v.state.sid, state: 'idle' }; }
        throw new Error(`unknown agent state: ${state} (working|needs-you|done|idle)`);
      }
      case 'browser': {
        const sub = args.sub || 'open';
        if (sub === 'open' || sub === 'url') {
          if (!args.url) throw new Error('browser open needs a url');
          const leaf = this.plugin.app.workspace.getLeaf('tab');
          try { await leaf.setViewState({ type: 'webviewer', state: { url: args.url, navigate: true }, active: true }); }
          catch { window.open(args.url); }
          return { url: args.url };
        }
        throw new Error('browser ' + sub + ' needs the WinMux desktop app (only open/url work inside Obsidian)');
      }
      case 'markdown': {
        if (!args.path) throw new Error('markdown needs a file path');
        const rel = this.plugin.vaultRelative(String(args.path));
        if (!rel) throw new Error('that file is outside this vault: ' + args.path);
        await this.plugin.app.workspace.openLinkText(rel, '', true);
        return { path: args.path };
      }
      case 'project': {
        if (!args.path) throw new Error('project needs a file path');
        const doc = await this.plugin.core.json('/api/project?path=' + encodeURIComponent(String(args.path)));
        await openProjectLayout(this.plugin, doc.layout, doc.name || 'project');
        return { ok: true, name: doc.name, tabs: this.views().length };
      }
      default: throw new Error('unknown command: ' + cmd);
    }
  }

  /** Give a freshly opened tab a moment to learn its engine sid so `list` is useful right away. */
  private async settle(v: TerminalView) { for (let i = 0; i < 20 && !v.state.sid; i++) await new Promise(r => setTimeout(r, 100)); }
}

export function warnTakeover() { new Notice('WinMux: this window now answers agent commands', 2500); }

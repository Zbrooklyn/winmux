// Left-sidebar list of every engine session: open tabs first, then live/recoverable backlog.
import { ItemView, WorkspaceLeaf, Menu, setIcon } from 'obsidian';
import type WinMuxPlugin from './main';
import { TerminalView } from './terminal';
import { resumeClaudeMenu } from './surfaces';

export const VIEW_SESSIONS = 'winmux-sessions';

interface Row { sid: string; shell: string; cwd: string; live: boolean; view?: TerminalView; savedAt?: number }

export class SessionsView extends ItemView {
  listEl!: HTMLElement;
  timer: number | null = null;
  warnEl!: HTMLElement;
  constructor(leaf: WorkspaceLeaf, private plugin: WinMuxPlugin) { super(leaf); }
  getViewType() { return VIEW_SESSIONS; }
  getIcon() { return 'terminal-square'; }
  getDisplayText() { return 'WinMux sessions'; }

  async onOpen() {
    this.contentEl.addClass('winmux-sessions');
    const head = this.contentEl.createDiv({ cls: 'wm-head' });
    head.createSpan({ text: 'Sessions' });
    const proj = head.createEl('button', { text: 'Projects' });
    proj.onclick = () => (this.plugin as any).openProjects();
    const add = head.createEl('button', { text: '+ New' });
    add.onclick = (e) => this.plugin.newSessionMenu(e);
    this.warnEl = this.contentEl.createDiv({ cls: 'wm-warn' });
    this.listEl = this.contentEl.createDiv({ cls: 'wm-list' });
    await this.refresh();
    this.timer = window.setInterval(() => this.refresh(), 2000);
  }

  async onClose() { if (this.timer) window.clearInterval(this.timer); }

  folderOf(cwd: string) { const c = (cwd || '').replace(/[\\/]+$/, ''); return c.split(/[\\/]/).pop() || c || '—'; }

  async refresh() {
    const core = this.plugin.core;
    if (this.warnEl) {
      this.warnEl.empty();
      if (core.inst && this.plugin.engineInfo && !this.plugin.backgroundMode) {
        this.warnEl.createSpan({ text: `Shells end ${this.plugin.engineInfo.detachGraceSecs ?? 30} s after Obsidian closes. ` });
        const a = this.warnEl.createEl('a', { text: 'Switch to background mode' });
        a.onclick = () => this.plugin.restartEngineBackground();
      }
    }
    const open = this.plugin.terminalViews();
    const rows: Row[] = [];
    const seen = new Set<string>();
    open.sort((a, b) => (b.status === 'needsyou' ? 1 : 0) - (a.status === 'needsyou' ? 1 : 0));
    for (const v of open) {
      const sid = v.state.sid || ('pending:' + (v.leaf as any).id);
      seen.add(sid);
      rows.push({ sid, shell: v.state.shell || '', cwd: v.state.cwd || '', live: true, view: v });
    }
    if (core.inst) {
      try {
        const b = await core.backlog();
        for (const it of (b.items || [])) {
          if (seen.has(it.sid)) continue;
          rows.push({ sid: it.sid, shell: it.shell, cwd: it.cwd, live: !!it.live, savedAt: it.savedAt });
        }
      } catch { /* engine away — show what we have */ }
    }
    this.render(rows);
  }

  render(rows: Row[]) {
    this.listEl.empty();
    if (!rows.length) { this.listEl.createDiv({ cls: 'wm-empty', text: this.plugin.core.inst ? 'No sessions yet. Click + New.' : 'Engine not connected.' }); return; }
    for (const r of rows) {
      const row = this.listEl.createDiv({ cls: 'wm-row' + (r.view ? ' is-open' : '') + (r.view?.status === 'needsyou' ? ' is-needsyou' : '') });
      const dot = row.createDiv({ cls: 'wm-dot' });
      if (r.view) dot.addClass(r.view.status === 'working' ? 'working' : r.view.status === 'needsyou' ? 'needsyou' : r.view.status === 'closed' ? 'ended' : 'open');
      else if (r.live) dot.addClass('open');
      const txt = row.createDiv({ cls: 'wm-txt' });
      txt.createDiv({ cls: 'wm-title', text: r.view ? r.view.getDisplayText() : `${this.folderOf(r.cwd)} · ${r.shell || 'shell'}` });
      txt.createDiv({ cls: 'wm-sub', text: r.view ? (r.view.status === 'working' ? 'Working' : r.view.status === 'needsyou' ? 'Needs you' : r.view.status === 'closed' ? 'Ended' : r.cwd) : (r.live ? 'Live in another window' : 'Recoverable · ' + r.cwd) });
      row.setAttr('title', r.cwd);
      row.onclick = () => this.plugin.openSession(r.sid.startsWith('pending:') ? undefined : r.sid, r.shell, r.cwd, r.view);
      row.oncontextmenu = (e) => {
        e.preventDefault();
        const m = new Menu();
        m.addItem(i => i.setTitle('Open in new tab').setIcon('plus').onClick(() => this.plugin.openSession(r.sid, r.shell, r.cwd)));
        if (r.view && r.view.status === 'needsyou') {
          m.addItem(i => i.setTitle('Approve (Enter)').setIcon('check').onClick(() => r.view!.respond(true)));
          m.addItem(i => i.setTitle('Deny (Esc)').setIcon('x-circle').onClick(() => r.view!.respond(false)));
          m.addSeparator();
        }
        if (r.view) m.addItem(i => i.setTitle('Rename').setIcon('pencil').onClick(() => r.view!.promptRename()));
        if (r.view) m.addItem(i => i.setTitle('Close tab (keep session 30 s)').setIcon('x').onClick(() => r.view!.leaf.detach()));
        if (r.cwd) m.addItem(i => i.setTitle('Resume Claude session…').setIcon('history').onClick((ev) => resumeClaudeMenu(this.plugin, ev as MouseEvent, r.cwd, r.view)));
        m.addItem(i => i.setTitle('End session').setIcon('trash').onClick(async () => {
          if (r.view) { r.view.disconnect(true); r.view.leaf.detach(); }
          if (!r.sid.startsWith('pending:')) { try { await this.plugin.core.deleteSession(r.sid); } catch { /* ignore */ } }
          this.refresh();
        }));
        m.showAtMouseEvent(e);
      };
    }
  }
}

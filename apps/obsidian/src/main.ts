import { Plugin, PluginSettingTab, Setting, Notice, Menu, WorkspaceLeaf, FileSystemAdapter, App } from 'obsidian';
import { join } from 'node:path';
import { CoreClient } from './core';
import { TerminalView, VIEW_TERMINAL } from './terminal';
import { SessionsView, VIEW_SESSIONS } from './sessions';

declare const __XTERM_CSS__: string;

export interface WinMuxSettings {
  defaultShell: string;
  defaultCwd: string;
  fontSize: number;
  fontFamily: string;
  passthroughKeys: string[];
  restoreOnStart: boolean;
  localEcho: boolean;
}

const DEFAULTS: WinMuxSettings = {
  defaultShell: 'pwsh',
  defaultCwd: '',
  fontSize: 13,
  fontFamily: '',
  passthroughKeys: ['Ctrl+C', 'Ctrl+V', 'Ctrl+W', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+L', 'Ctrl+D', 'Ctrl+P', 'Ctrl+E', 'Ctrl+K', 'Ctrl+F'],
  restoreOnStart: true,
  localEcho: true,
};

const FALLBACK_SHELLS = [{ key: 'pwsh', label: 'PowerShell 7' }, { key: 'powershell', label: 'Windows PowerShell' }, { key: 'cmd', label: 'Command Prompt' }, { key: 'bash', label: 'Git Bash' }, { key: 'wsl', label: 'WSL' }];

export default class WinMuxPlugin extends Plugin {
  settings: WinMuxSettings = DEFAULTS;
  core!: CoreClient;
  styleEl: HTMLStyleElement | null = null;
  shells: { key: string; label: string }[] = [];
  broadcast = false;
  statusEl: HTMLElement | null = null;

  shellKeyFor(labelOrKey?: string): string {
    if (!labelOrKey) return '';
    const list = this.shells.length ? this.shells : FALLBACK_SHELLS;
    const hit = list.find(s => s.key === labelOrKey || s.label === labelOrKey);
    return hit ? hit.key : '';
  }

  setBroadcast(on: boolean) {
    this.broadcast = on;
    const n = this.terminalViews().length;
    if (!this.statusEl) this.statusEl = this.addStatusBarItem();
    this.statusEl.empty();
    if (on) {
      this.statusEl.addClass('winmux-bcast');
      this.statusEl.createSpan({ text: `Broadcasting to ${n} terminals` });
      const stop = this.statusEl.createSpan({ cls: 'winmux-bcast-stop', text: 'Stop' });
      stop.onclick = () => this.setBroadcast(false);
      new Notice(`Broadcasting input to ${n} terminals — Ctrl+Alt+B to stop`, 4000);
    } else this.statusEl.removeClass('winmux-bcast');
    document.body.toggleClass('winmux-broadcasting', on);
  }

  broadcastInput(d: string) {
    for (const v of this.terminalViews()) v.send({ t: 'i', d });
  }

  async onload() {
    await this.loadSettings();
    this.styleEl = document.createElement('style');
    this.styleEl.textContent = __XTERM_CSS__;
    document.head.appendChild(this.styleEl);

    const exe = join(this.pluginDir(), 'binaries', 'winmux-core.exe');
    this.core = new CoreClient(exe);

    this.registerView(VIEW_TERMINAL, leaf => new TerminalView(leaf, this));
    this.registerView(VIEW_SESSIONS, leaf => new SessionsView(leaf, this));

    this.addRibbonIcon('terminal', 'WinMux: new terminal', () => this.openSession());
    this.addCommand({ id: 'new-terminal', name: 'New terminal', hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'T' }], callback: () => this.openSession() });
    this.addCommand({ id: 'new-terminal-pick', name: 'New terminal (choose shell)…', callback: () => this.newSessionMenu() });
    this.addCommand({ id: 'show-sessions', name: 'Show sessions sidebar', hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'L' }], callback: () => this.showSessions(true) });
    this.addCommand({ id: 'split-right', name: 'Split terminal right', hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'D' }], callback: () => this.splitActive('vertical') });
    this.addCommand({ id: 'split-down', name: 'Split terminal down', hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'Y' }], callback: () => this.splitActive('horizontal') });
    this.addCommand({ id: 'rename-terminal', name: 'Rename terminal', checkCallback: (chk) => { const v = this.activeTerminal(); if (!v) return false; if (!chk) v.promptRename(); return true; } });
    this.addCommand({ id: 'restart-terminal', name: 'Restart shell in this terminal', checkCallback: (chk) => { const v = this.activeTerminal(); if (!v) return false; if (!chk) { v.disconnect(true); v.restart(); } return true; } });
    this.addCommand({ id: 'end-session', name: 'End session (close terminal for good)', checkCallback: (chk) => { const v = this.activeTerminal(); if (!v) return false; if (!chk) { v.disconnect(true); v.leaf.detach(); } return true; } });
    this.addCommand({ id: 'clear-terminal', name: 'Clear scrollback', checkCallback: (chk) => { const v = this.activeTerminal(); if (!v) return false; if (!chk) v.term.clear(); return true; } });
    this.addCommand({ id: 'broadcast-toggle', name: 'Broadcast input to all terminals (toggle)', hotkeys: [{ modifiers: ['Mod', 'Alt'], key: 'B' }], callback: () => this.setBroadcast(!this.broadcast) });
    this.addCommand({ id: 'approve', name: 'Approve (send Enter to the terminal that needs you)', checkCallback: (chk) => { const v = this.terminalViews().find(t => t.status === 'needsyou') || this.activeTerminal(); if (!v) return false; if (!chk) v.respond(true); return true; } });
    this.addCommand({ id: 'deny', name: 'Deny (send Escape to the terminal that needs you)', checkCallback: (chk) => { const v = this.terminalViews().find(t => t.status === 'needsyou') || this.activeTerminal(); if (!v) return false; if (!chk) v.respond(false); return true; } });
    this.addCommand({ id: 'focus-next-terminal', name: 'Focus next terminal', hotkeys: [{ modifiers: ['Mod', 'Alt'], key: 'ArrowRight' }], callback: () => this.cycleTerminal(1) });
    this.addCommand({ id: 'focus-prev-terminal', name: 'Focus previous terminal', hotkeys: [{ modifiers: ['Mod', 'Alt'], key: 'ArrowLeft' }], callback: () => this.cycleTerminal(-1) });
    this.addCommand({ id: 'engine-info', name: 'Engine status', callback: async () => {
      const i = await this.core.info();
      new Notice(i ? `WinMux engine v${i.version} on :${i.port} (pid ${i.pid}) — ${i.sessions} live, ${i.recoverable} recoverable` : 'Engine not reachable');
    } });
    this.addCommand({ id: 'engine-stop', name: 'Stop engine (ends all sessions)', callback: async () => {
      try { await this.core.shutdown(); new Notice('WinMux engine stopped'); } catch (e: any) { new Notice('Stop failed: ' + e.message); }
    } });

    this.addSettingTab(new WinMuxSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      try {
        const info = await this.core.ensure();
        console.log('[winmux] engine', info);
        try { this.shells = await this.core.shells(); } catch { /* keep empty */ }
        await this.showSessions(false);
        // Views restored by Obsidian's workspace connect themselves once the engine is up.
        for (const v of this.terminalViews()) if (!v.ws) v.connect();
        this.sessionsChanged();
      } catch (e: any) {
        console.error('[winmux]', e);
        new Notice('WinMux: ' + e.message, 8000);
      }
    });
  }

  onunload() {
    this.styleEl?.remove();
    // Engine intentionally left running — sessions survive plugin reloads.
  }

  pluginDir(): string {
    const ad = this.app.vault.adapter as FileSystemAdapter;
    return join(ad.getBasePath(), this.app.vault.configDir, 'plugins', this.manifest.id);
  }

  activeTerminal(): TerminalView | null {
    const v = this.app.workspace.activeLeaf?.view;
    return v instanceof TerminalView ? v : (this.terminalViews()[0] ?? null);
  }

  splitActive(dir: 'vertical' | 'horizontal') {
    const a = this.activeTerminal();
    return this.openSession(undefined, a?.state.shell, a?.state.cwd, undefined, dir, a?.leaf);
  }

  cycleTerminal(step: number) {
    const vs = this.terminalViews(); if (!vs.length) return;
    const cur = this.activeTerminal(); const i = Math.max(0, vs.indexOf(cur as TerminalView));
    const n = vs[(i + step + vs.length) % vs.length];
    this.app.workspace.setActiveLeaf(n.leaf, { focus: true }); this.app.workspace.revealLeaf(n.leaf); n.focusTerm();
  }

  /** Obsidian Notice + tab/sidebar attention for something a terminal wants. */
  notify(v: TerminalView | null, text: string) {
    new Notice((v ? v.getDisplayText() + ' — ' : '') + text, 6000);
  }

  terminalViews(): TerminalView[] {
    return this.app.workspace.getLeavesOfType(VIEW_TERMINAL).map(l => l.view).filter((v): v is TerminalView => v instanceof TerminalView);
  }

  sessionsChanged() {
    for (const l of this.app.workspace.getLeavesOfType(VIEW_SESSIONS)) (l.view as SessionsView).refresh?.();
  }

  async showSessions(reveal: boolean) {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_SESSIONS)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeftLeaf(false)!;
      await leaf.setViewState({ type: VIEW_SESSIONS, active: reveal });
    }
    if (reveal) this.app.workspace.revealLeaf(leaf);
  }

  newSessionMenu(e?: MouseEvent) {
    const m = new Menu();
    const shells = this.shells.length ? this.shells : [{ key: 'pwsh', label: 'PowerShell 7' }, { key: 'powershell', label: 'Windows PowerShell' }, { key: 'cmd', label: 'Command Prompt' }, { key: 'bash', label: 'Git Bash' }, { key: 'wsl', label: 'WSL' }];
    for (const s of shells) m.addItem(i => i.setTitle(s.label).setIcon('terminal').onClick(() => this.openSession(undefined, s.key)));
    if (e) m.showAtMouseEvent(e); else m.showAtPosition({ x: window.innerWidth / 2, y: 80 });
  }

  /** Open (or focus) a session in a tab. sid = resume; else new with shell/cwd. */
  async openSession(sid?: string, shell?: string, cwd?: string, existing?: TerminalView, split?: 'vertical' | 'horizontal', from?: WorkspaceLeaf) {
    if (existing) { this.app.workspace.setActiveLeaf(existing.leaf, { focus: true }); this.app.workspace.revealLeaf(existing.leaf); existing.focusTerm(); return existing; }
    if (sid) {
      const v = this.terminalViews().find(t => t.state.sid === sid);
      if (v) { this.app.workspace.setActiveLeaf(v.leaf, { focus: true }); this.app.workspace.revealLeaf(v.leaf); v.focusTerm(); return v; }
    }
    let leaf: WorkspaceLeaf;
    if (split) leaf = from ? this.app.workspace.createLeafBySplit(from, split) : this.app.workspace.getLeaf('split', split);
    else leaf = this.app.workspace.getLeaf('tab');
    const shellKey = this.shellKeyFor(shell) || (sid ? '' : this.settings.defaultShell);
    await leaf.setViewState({ type: VIEW_TERMINAL, active: true, state: { sid, shell: shell || this.settings.defaultShell, shellKey, cwd: cwd || this.settings.defaultCwd || undefined } });
    this.app.workspace.revealLeaf(leaf);
    const v = leaf.view as TerminalView;
    setTimeout(() => v.focusTerm(), 50);
    return v;
  }

  async loadSettings() { this.settings = Object.assign({}, DEFAULTS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }
}

class WinMuxSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: WinMuxPlugin) { super(app, plugin); }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName('Default shell').setDesc('Used by New terminal.').addDropdown(d => {
      const shells = this.plugin.shells.length ? this.plugin.shells : [{ key: 'pwsh', label: 'PowerShell 7' }, { key: 'powershell', label: 'Windows PowerShell' }, { key: 'cmd', label: 'Command Prompt' }, { key: 'bash', label: 'Git Bash' }, { key: 'wsl', label: 'WSL' }];
      for (const s of shells) d.addOption(s.key, s.label);
      d.setValue(this.plugin.settings.defaultShell).onChange(async v => { this.plugin.settings.defaultShell = v; await this.plugin.saveSettings(); });
    });
    new Setting(containerEl).setName('Default folder').setDesc('Blank = your home folder.').addText(t => t.setValue(this.plugin.settings.defaultCwd).onChange(async v => { this.plugin.settings.defaultCwd = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Instant typing').setDesc('Show keystrokes immediately while the shell catches up (Mosh-style prediction). Off for passwords and full-screen apps automatically.').addToggle(t => t.setValue(this.plugin.settings.localEcho).onChange(async v => { this.plugin.settings.localEcho = v; await this.plugin.saveSettings(); for (const tv of this.plugin.terminalViews()) if (tv.pred) tv.pred.enabled = v; }));
    new Setting(containerEl).setName('Font size').addSlider(s => s.setLimits(10, 20, 1).setValue(this.plugin.settings.fontSize).setDynamicTooltip().onChange(async v => { this.plugin.settings.fontSize = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Font family').setDesc("Blank = Obsidian's monospace font (Settings → Appearance).").addText(t => t.setValue(this.plugin.settings.fontFamily).onChange(async v => { this.plugin.settings.fontFamily = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Keys the terminal keeps').setDesc('Comma-separated. While a terminal is focused these go to the shell instead of Obsidian.').addTextArea(t => t.setValue(this.plugin.settings.passthroughKeys.join(', ')).onChange(async v => { this.plugin.settings.passthroughKeys = v.split(',').map(s => s.trim()).filter(Boolean); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Engine').setDesc('Bundled winmux-core.exe. Shared with the WinMux app if both are installed.').addButton(b => b.setButtonText('Status').onClick(async () => {
      const i = await this.plugin.core.info();
      new Notice(i ? `v${i.version} on :${i.port} (pid ${i.pid}) — ${i.sessions} live, ${i.recoverable} recoverable` : 'Not reachable');
    }));
  }
}

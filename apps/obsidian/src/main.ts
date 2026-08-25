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
}

const DEFAULTS: WinMuxSettings = {
  defaultShell: 'pwsh',
  defaultCwd: '',
  fontSize: 13,
  fontFamily: 'Cascadia Mono, Consolas, monospace',
  passthroughKeys: ['Ctrl+C', 'Ctrl+V', 'Ctrl+W', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+L', 'Ctrl+D', 'Ctrl+P', 'Ctrl+E', 'Ctrl+K', 'Ctrl+F'],
  restoreOnStart: true,
};

export default class WinMuxPlugin extends Plugin {
  settings: WinMuxSettings = DEFAULTS;
  core!: CoreClient;
  styleEl: HTMLStyleElement | null = null;
  shells: { key: string; label: string }[] = [];

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
    this.addCommand({ id: 'new-terminal', name: 'New terminal', callback: () => this.openSession() });
    this.addCommand({ id: 'new-terminal-pick', name: 'New terminal (choose shell)…', callback: () => this.newSessionMenu() });
    this.addCommand({ id: 'show-sessions', name: 'Show sessions sidebar', callback: () => this.showSessions(true) });
    this.addCommand({ id: 'split-right', name: 'Split terminal right', callback: () => this.openSession(undefined, undefined, undefined, undefined, 'vertical') });
    this.addCommand({ id: 'split-down', name: 'Split terminal down', callback: () => this.openSession(undefined, undefined, undefined, undefined, 'horizontal') });
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
  async openSession(sid?: string, shell?: string, cwd?: string, existing?: TerminalView, split?: 'vertical' | 'horizontal') {
    if (existing) { this.app.workspace.revealLeaf(existing.leaf); existing.focusTerm(); return existing; }
    if (sid) {
      const v = this.terminalViews().find(t => t.state.sid === sid);
      if (v) { this.app.workspace.revealLeaf(v.leaf); v.focusTerm(); return v; }
    }
    let leaf: WorkspaceLeaf;
    if (split) leaf = this.app.workspace.getLeaf('split', split);
    else leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TERMINAL, active: true, state: { sid, shell: shell || this.settings.defaultShell, cwd: cwd || this.settings.defaultCwd || undefined } });
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
    new Setting(containerEl).setName('Font size').addSlider(s => s.setLimits(10, 20, 1).setValue(this.plugin.settings.fontSize).setDynamicTooltip().onChange(async v => { this.plugin.settings.fontSize = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Font family').addText(t => t.setValue(this.plugin.settings.fontFamily).onChange(async v => { this.plugin.settings.fontFamily = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Keys the terminal keeps').setDesc('Comma-separated. While a terminal is focused these go to the shell instead of Obsidian.').addTextArea(t => t.setValue(this.plugin.settings.passthroughKeys.join(', ')).onChange(async v => { this.plugin.settings.passthroughKeys = v.split(',').map(s => s.trim()).filter(Boolean); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Engine').setDesc('Bundled winmux-core.exe. Shared with the WinMux app if both are installed.').addButton(b => b.setButtonText('Status').onClick(async () => {
      const i = await this.plugin.core.info();
      new Notice(i ? `v${i.version} on :${i.port} (pid ${i.pid}) — ${i.sessions} live, ${i.recoverable} recoverable` : 'Not reachable');
    }));
  }
}

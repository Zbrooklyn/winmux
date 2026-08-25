import { Plugin, PluginSettingTab, Setting, Notice, Menu, WorkspaceLeaf, FileSystemAdapter, App } from 'obsidian';
import { join } from 'node:path';
import { CoreClient } from './core';
import { TerminalView, VIEW_TERMINAL } from './terminal';
import { SessionsView, VIEW_SESSIONS } from './sessions';
import { ProjectsModal, DiagnosticsModal, CheatModal, renderPhonePane } from './surfaces';
import { ControlClient } from './control';
import { BIN_DIR, toolsInstalled, installTools, uninstallTools, mcpRegistered, registerMcp, unregisterMcp, hooksInstalled, installHooks, uninstallHooks, notifyList } from './tools';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { relative, isAbsolute, resolve as resolvePath } from 'node:path';

declare const __XTERM_CSS__: string;

export interface WinMuxSettings {
  defaultShell: string;
  defaultCwd: string;
  fontSize: number;
  fontFamily: string;
  passthroughKeys: string[];
  restoreOnStart: boolean;
  localEcho: boolean;
  scrollback: number;
  cursorStyle: 'bar' | 'block' | 'underline';
  cursorBlink: boolean;
  copyOnSelect: boolean;
  rightClickPaste: boolean;
  confirmClose: boolean;
  osNotify: boolean;
  resumeCommand: string;
  keepSessions: boolean;
  trayIcon: boolean;
}

const DEFAULTS: WinMuxSettings = {
  defaultShell: 'pwsh',
  defaultCwd: '',
  fontSize: 13,
  fontFamily: '',
  passthroughKeys: ['Ctrl+C', 'Ctrl+V', 'Ctrl+W', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+L', 'Ctrl+D', 'Ctrl+P', 'Ctrl+E', 'Ctrl+K', 'Ctrl+F'],
  restoreOnStart: true,
  localEcho: true,
  scrollback: 5000,
  cursorStyle: 'bar',
  cursorBlink: true,
  copyOnSelect: false,
  rightClickPaste: false,
  confirmClose: true,
  osNotify: true,
  resumeCommand: 'claude --resume {id} --dangerously-skip-permissions',
  keepSessions: true,
  trayIcon: true,
};

const FALLBACK_SHELLS = [{ key: 'pwsh', label: 'PowerShell 7' }, { key: 'powershell', label: 'Windows PowerShell' }, { key: 'cmd', label: 'Command Prompt' }, { key: 'bash', label: 'Git Bash' }, { key: 'wsl', label: 'WSL' }];

export default class WinMuxPlugin extends Plugin {
  settings: WinMuxSettings = DEFAULTS;
  core!: CoreClient;
  styleEl: HTMLStyleElement | null = null;
  shells: { key: string; label: string }[] = [];
  broadcast = false;
  currentProject: { name: string; path: string } | null = null;
  control!: ControlClient;
  tidSeq = 0;
  engineInfo: import('./core').Info | null = null;

  /** True when the running engine keeps detached shells forever. */
  get backgroundMode(): boolean { return !!this.engineInfo && this.engineInfo.detachGraceSecs === 0; }

  nextTid(): number { const used = this.terminalViews().map(v => v.tid); this.tidSeq = Math.max(this.tidSeq, ...used, 0) + 1; return this.tidSeq; }

  /** Absolute path → vault-relative (forward slashes) or null when outside the vault. */
  vaultRelative(p: string): string | null {
    const basePath = (this.app.vault.adapter as FileSystemAdapter).getBasePath();
    const abs = isAbsolute(p) ? p : resolvePath(basePath, p);
    const rel = relative(basePath, abs);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    return rel.split('\\').join('/');
  }
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
    this.core = new CoreClient(exe, () => {
      // Shells the engine spawns get `winmux` on PATH and a Node runtime (Obsidian's Electron) for the shims.
      const env: Record<string, string> = { WINMUX_APP_EXE: process.execPath };
      // Background mode: shells outlive Obsidian until you end them (0 = never reap a detached shell).
      env.WINMUX_DETACH_GRACE_SECS = this.settings.keepSessions ? '0' : '30';
      if (existsSync(join(BIN_DIR, 'winmux.cmd'))) env.WINMUX_CLI_DIR = BIN_DIR;
      return env;
    });
    this.control = new ControlClient(this);

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
    this.addCommand({ id: 'projects', name: 'Projects…', hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'O' }], callback: () => new ProjectsModal(this.app, this).open() });
    this.addCommand({ id: 'diagnostics', name: 'Diagnostics', callback: () => new DiagnosticsModal(this.app, this).open() });
    this.addCommand({ id: 'cheat-sheet', name: 'Cheat sheet (shortcuts & words)', hotkeys: [{ modifiers: ['Mod', 'Shift'], key: '/' }], callback: () => new CheatModal(this.app, this).open() });
    this.addCommand({ id: 'phone-settings', name: 'Phone access…', callback: () => { (this.app as any).setting.open(); (this.app as any).setting.openTabById('winmux'); } });
    this.addCommand({ id: 'install-tools', name: 'Install WinMux tools (winmux CLI, MCP server, skill)', callback: () => { try { notifyList(installTools(this)); } catch (e: any) { new Notice('Install failed: ' + e.message); } } });
    this.addCommand({ id: 'reclaim-control', name: 'Reclaim agent control (answer winmux commands in this window)', callback: () => { this.control.stop(); this.control.connect(); new Notice('This window now answers agent commands'); } });
    this.addCommand({ id: 'engine-info', name: 'Engine status', callback: async () => {
      const i = await this.core.info();
      new Notice(i ? `WinMux engine v${i.version} on :${i.port} (pid ${i.pid}) — ${i.sessions} live, ${i.recoverable} recoverable` : 'Engine not reachable');
    } });
    this.addCommand({ id: 'engine-restart-background', name: 'Restart engine in background mode (keeps shells alive when Obsidian is closed)', callback: () => this.restartEngineBackground() });
    this.addCommand({ id: 'engine-stop', name: 'Stop engine (ends all sessions)', callback: async () => {
      try { await this.core.shutdown(); new Notice('WinMux engine stopped'); } catch (e: any) { new Notice('Stop failed: ' + e.message); }
    } });

    this.addSettingTab(new WinMuxSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      try {
        const info = await this.core.ensure();
        this.engineInfo = info;
        console.log('[winmux] engine', info);
        if (this.settings.keepSessions && info.detachGraceSecs !== 0) {
          const secs = info.detachGraceSecs ?? 30;
          new Notice(`WinMux: this engine ends shells ${secs} s after Obsidian closes. Run "Restart engine in background mode" to keep them running.`, 10000);
        }
        try { this.shells = await this.core.shells(); } catch { /* keep empty */ }
        await this.showSessions(false);
        // Views restored by Obsidian's workspace connect themselves once the engine is up.
        for (const v of this.terminalViews()) if (!v.ws) v.connect();
        this.sessionsChanged();
        this.control.connect();
        this.startTray();
      } catch (e: any) {
        console.error('[winmux]', e);
        new Notice('WinMux: ' + e.message, 8000);
      }
    });
  }

  onunload() {
    this.control?.stop();
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
    if (this.settings.osNotify && !document.hasFocus() && typeof Notification !== 'undefined') {
      try {
        const n = new Notification(v ? v.getDisplayText() : 'WinMux', { body: text, tag: 'winmux-' + (v?.state.sid || 'x') });
        n.onclick = () => { window.focus(); if (v) { this.app.workspace.setActiveLeaf(v.leaf, { focus: true }); v.focusTerm(); } };
      } catch { /* denied */ }
    }
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

  /** Tray icon next to the clock: visible while the engine is alive, even with Obsidian closed. Single-instance (mutex). */
  startTray() {
    if (!this.settings.trayIcon) return;
    const exe = join(this.pluginDir(), 'binaries', 'winmux-tray.exe');
    if (!existsSync(exe)) return;
    const inst = process.env.WINMUX_INSTANCE_FILE || join(homedir(), '.winmux', 'instance.json');
    try { const c = spawn(exe, [inst, process.execPath], { detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); } catch (e) { console.warn('[winmux] tray', e); }
  }

  async restartEngineBackground() {
    const live = this.terminalViews().length;
    const { confirm } = await import('./surfaces');
    if (live && !(await confirm(this.app, 'Restart the engine?', `${live} open terminal${live === 1 ? '' : 's'} will end and restart fresh. Afterwards shells survive closing Obsidian.`))) return;
    for (const v of this.terminalViews()) v.disconnect(false);
    try { await this.core.shutdown(); } catch { /* may already be gone */ }
    for (let i = 0; i < 40 && this.core.readInstance(); i++) await new Promise(r => setTimeout(r, 250));
    this.core.inst = null;
    try {
      const info = await this.core.ensure();
      this.engineInfo = info;
      this.control.stop(); this.control.connect();
      this.startTray();
      for (const v of this.terminalViews()) { v.state.sid = undefined; v.term.reset(); v.connect(); }
      new Notice(info.detachGraceSecs === 0 ? 'Engine restarted in background mode — shells now survive closing Obsidian.' : 'Engine restarted, but it is not in background mode (old engine binary?).', 8000);
      this.sessionsChanged();
    } catch (e: any) { new Notice('Engine restart failed: ' + e.message, 8000); }
  }

  openProjects() { new ProjectsModal(this.app, this).open(); }

  applyTermOptions() {
    for (const v of this.terminalViews()) {
      v.term.options.scrollback = this.settings.scrollback;
      v.term.options.cursorStyle = this.settings.cursorStyle;
      v.term.options.cursorBlink = this.settings.cursorBlink;
      v.term.options.fontSize = this.settings.fontSize;
      v.applyTheme(); v.refit();
    }
  }

  async loadSettings() { this.settings = Object.assign({}, DEFAULTS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }
}

class WinMuxSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: WinMuxPlugin) { super(app, plugin); }

  async renderEngineToggles(containerEl: HTMLElement) {
    const box = containerEl.createDiv();
    try {
      const a = await this.plugin.core.json('/api/autostart');
      new Setting(box).setName('Start the engine at login').setDesc('Keeps sessions alive before Obsidian opens.').addToggle(t => t.setValue(!!a.on).onChange(async v => { try { await this.plugin.core.json('/api/autostart', { method: 'POST', body: JSON.stringify({ on: v }) }); } catch (e: any) { new Notice(e.message); } }));
      const h = await this.plugin.core.json('/api/history');
      new Setting(box).setName('Save terminal history').setDesc('Scrollback of ended sessions is kept for recovery. Off wipes it.').addToggle(t => t.setValue(h.persist !== false).onChange(async v => { try { await this.plugin.core.json('/api/history', { method: 'POST', body: JSON.stringify({ persist: v }) }); } catch (e: any) { new Notice(e.message); } }));
    } catch { /* engine away */ }
  }
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
    new Setting(containerEl).setName('Font size').addSlider(s => s.setLimits(10, 20, 1).setValue(this.plugin.settings.fontSize).setDynamicTooltip().onChange(async v => { this.plugin.settings.fontSize = v; await this.plugin.saveSettings(); this.plugin.applyTermOptions(); }));
    new Setting(containerEl).setName('Font family').setDesc("Blank = Obsidian's monospace font (Settings → Appearance).").addText(t => t.setValue(this.plugin.settings.fontFamily).onChange(async v => { this.plugin.settings.fontFamily = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Keys the terminal keeps').setDesc('Comma-separated. While a terminal is focused these go to the shell instead of Obsidian.').addTextArea(t => t.setValue(this.plugin.settings.passthroughKeys.join(', ')).onChange(async v => { this.plugin.settings.passthroughKeys = v.split(',').map(s => s.trim()).filter(Boolean); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Scrollback lines').addSlider(sl => sl.setLimits(1000, 50000, 1000).setValue(this.plugin.settings.scrollback).setDynamicTooltip().onChange(async v => { this.plugin.settings.scrollback = v; await this.plugin.saveSettings(); this.plugin.applyTermOptions(); }));
    new Setting(containerEl).setName('Cursor').addDropdown(d => d.addOptions({ bar: 'Bar', block: 'Block', underline: 'Underline' }).setValue(this.plugin.settings.cursorStyle).onChange(async v => { this.plugin.settings.cursorStyle = v as any; await this.plugin.saveSettings(); this.plugin.applyTermOptions(); }))
      .addToggle(t => t.setTooltip('Blink').setValue(this.plugin.settings.cursorBlink).onChange(async v => { this.plugin.settings.cursorBlink = v; await this.plugin.saveSettings(); this.plugin.applyTermOptions(); }));
    new Setting(containerEl).setName('Copy on select').addToggle(t => t.setValue(this.plugin.settings.copyOnSelect).onChange(async v => { this.plugin.settings.copyOnSelect = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Right-click pastes').setDesc('Off = right-click opens the menu.').addToggle(t => t.setValue(this.plugin.settings.rightClickPaste).onChange(async v => { this.plugin.settings.rightClickPaste = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Behaviour').setHeading();
    new Setting(containerEl).setName('Keep shells running when Obsidian is closed').setDesc(this.plugin.backgroundMode ? 'On — the engine is in background mode. Closing Obsidian leaves every terminal running; reopen and the tabs reconnect. End sessions from the sidebar, or "Stop engine" to shut everything down.' : 'Applies to the engine this plugin starts. The current engine is NOT in background mode — use "Restart engine in background mode".')
      .addToggle(t => t.setValue(this.plugin.settings.keepSessions).onChange(async v => { this.plugin.settings.keepSessions = v; await this.plugin.saveSettings(); }))
      .addButton(b => b.setButtonText('Restart engine now').onClick(() => this.plugin.restartEngineBackground()));
    new Setting(containerEl).setName('Tray icon').setDesc('Icon by the clock while the engine runs: shows how many shells are alive, opens Obsidian, stops the engine. Stays after Obsidian closes.').addToggle(t => t.setValue(this.plugin.settings.trayIcon).onChange(async v => { this.plugin.settings.trayIcon = v; await this.plugin.saveSettings(); if (v) this.plugin.startTray(); }));
    new Setting(containerEl).setName('Confirm before ending running terminals').setDesc('When opening a project.').addToggle(t => t.setValue(this.plugin.settings.confirmClose).onChange(async v => { this.plugin.settings.confirmClose = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('System notifications').setDesc('When Obsidian is in the background and a terminal needs you.').addToggle(t => t.setValue(this.plugin.settings.osNotify).onChange(async v => { this.plugin.settings.osNotify = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Claude resume command').setDesc('Must contain {id}. Used by "Resume Claude session" in the sidebar.').addText(t => { t.setValue(this.plugin.settings.resumeCommand).onChange(async v => { if (v.includes('{id}')) { this.plugin.settings.resumeCommand = v; await this.plugin.saveSettings(); } }); t.inputEl.style.width = '320px'; });
    this.renderEngineToggles(containerEl);
    new Setting(containerEl).setName('Phone').setHeading();
    const phoneEl = containerEl.createDiv({ cls: 'winmux-phone-pane' });
    renderPhonePane(this.plugin, phoneEl);
    new Setting(containerEl).setName('Agent tools').setHeading();
    const tools = new Setting(containerEl).setName('winmux command line + MCP server').setDesc(toolsInstalled() ? `Installed in ${BIN_DIR} and on your PATH.` : 'Lets Claude and scripts drive these terminals: `winmux list`, `winmux send`, agent jobs…');
    tools.addButton(b => b.setButtonText(toolsInstalled() ? 'Reinstall' : 'Install').setCta().onClick(() => { try { notifyList(installTools(this.plugin)); } catch (e: any) { new Notice('Install failed: ' + e.message); } this.display(); }));
    if (toolsInstalled()) tools.addButton(b => b.setButtonText('Remove from PATH').onClick(() => { notifyList(uninstallTools()); this.display(); }));
    const mcp = new Setting(containerEl).setName('Claude Code MCP server').setDesc(mcpRegistered() ? 'Registered (user scope). Claude gets winmux_list / winmux_send / winmux_agent_spawn… tools.' : 'Register so Claude Code can use the winmux_* tools in every project.');
    mcp.addButton(b => b.setButtonText(mcpRegistered() ? 'Unregister' : 'Register').onClick(() => { if (!toolsInstalled()) { new Notice('Install the tools first'); return; } new Notice(mcpRegistered() ? unregisterMcp() : registerMcp()); this.display(); }));
    const hooks = new Setting(containerEl).setName('Claude Code hooks').setDesc(hooksInstalled() ? 'Installed: tabs turn orange while Claude works, red when it needs you, clear when done.' : 'Adds three hooks to ~/.claude/settings.json (UserPromptSubmit / Notification / Stop) that call `winmux agent …`. Your other hooks are left alone.');
    hooks.addButton(b => b.setButtonText(hooksInstalled() ? 'Remove hooks' : 'Install hooks').onClick(() => { if (!toolsInstalled()) { new Notice('Install the tools first'); return; } new Notice(hooksInstalled() ? uninstallHooks() : installHooks(this.plugin)); this.display(); }));
    new Setting(containerEl).setName('Agent control').setDesc(this.plugin.control?.connected ? 'This window answers winmux commands.' : 'Not connected — another WinMux window may own control.').addButton(b => b.setButtonText('Reclaim').onClick(() => { this.plugin.control.stop(); this.plugin.control.connect(); setTimeout(() => this.display(), 500); }));
    new Setting(containerEl).setName('About').setHeading();
    new Setting(containerEl).setName('WinMux for Obsidian ' + this.plugin.manifest.version).addButton(b => b.setButtonText('Diagnostics').onClick(() => new DiagnosticsModal(this.app, this.plugin).open())).addButton(b => b.setButtonText('Cheat sheet').onClick(() => new CheatModal(this.app, this.plugin).open()));
    new Setting(containerEl).setName('Engine').setDesc('Bundled winmux-core.exe. Shared with the WinMux app if both are installed.').addButton(b => b.setButtonText('Status').onClick(async () => {
      const i = await this.plugin.core.info();
      new Notice(i ? `v${i.version} on :${i.port} (pid ${i.pid}) — ${i.sessions} live, ${i.recoverable} recoverable` : 'Not reachable');
    }));
  }
}

// Product surfaces ported from app.js: projects, phone access, diagnostics, cheat sheet, Claude resume.
import { App, Modal, Setting, Notice, Menu, setIcon, requestUrl } from 'obsidian';
import type WinMuxPlugin from './main';
import type { TerminalView } from './terminal';

// ---------------------------------------------------------------- projects
// Same file format as the WinMux app (winmuxProject:1, layout v4) so projects round-trip.
export interface ProjectRow { path: string; name: string; tabs: number; dir: string; shells: string[]; opened: number; missing?: boolean }

export function projectLayout(plugin: WinMuxPlugin) {
  const tabs = plugin.terminalViews().map(v => ({ type: 'terminal', shell: v.shellKey || plugin.shellKeyFor(v.state.shell) || plugin.settings.defaultShell, cwd: v.state.cwd || '', title: v.state.title || '' }));
  return { v: 4, group: '', cols: [[{ active: 0, tabs }]] };
}

export async function openProjectLayout(plugin: WinMuxPlugin, layout: any, name: string) {
  const tabs: any[] = [];
  for (const col of layout?.cols || []) for (const pane of col || []) for (const t of pane?.tabs || []) if (!t.type || t.type === 'terminal') tabs.push(t);
  if (!tabs.length) { new Notice('Project has no terminals'); return; }
  const live = plugin.terminalViews();
  if (live.length && plugin.settings.confirmClose) {
    const ok = await confirm(plugin.app, `Open "${name}"?`, `${live.length} running terminal${live.length === 1 ? '' : 's'} will be ended.`);
    if (!ok) return;
  }
  for (const v of live) { v.disconnect(true); v.leaf.detach(); }
  let first = true;
  for (const t of tabs) {
    const v = await plugin.openSession(undefined, t.shell, t.cwd || undefined, undefined, first ? undefined : undefined);
    if (t.title && v) { v.state.title = t.title; v.refreshTitle(); }
    first = false;
  }
  plugin.currentProject = { name, path: '' };
}

export class ProjectsModal extends Modal {
  constructor(app: App, private plugin: WinMuxPlugin) { super(app); }
  async onOpen() {
    this.setTitle('Projects');
    this.modalEl.addClass('winmux-projects');
    await this.render();
  }
  async render() {
    const { contentEl } = this; contentEl.empty();
    let name = this.plugin.currentProject?.name || '';
    new Setting(contentEl).setName('Save current terminals as a project').setDesc('Saves the shell + folder of every open terminal. Opening a project starts fresh shells.')
      .addText(t => { t.setPlaceholder('Project name').setValue(name).onChange(v => name = v); t.inputEl.style.width = '220px'; })
      .addButton(b => b.setButtonText('Save').setCta().onClick(async () => {
        if (!name.trim()) { new Notice('Name required'); return; }
        try {
          const cur = this.plugin.currentProject;
          const r = await this.plugin.core.json('/api/project', { method: 'POST', body: JSON.stringify({ name: name.trim(), path: cur && cur.name === name.trim() ? cur.path : null, layout: projectLayout(this.plugin) }) });
          this.plugin.currentProject = { name: name.trim(), path: r.path };
          new Notice('Saved ' + name.trim());
          await this.render();
        } catch (e: any) { new Notice('Save failed: ' + e.message); }
      }));
    let data: { dir: string; recents: ProjectRow[] };
    try { data = await this.plugin.core.json('/api/projects'); } catch (e: any) { contentEl.createDiv({ cls: 'wm-empty', text: 'Engine not reachable: ' + e.message }); return; }
    const list = contentEl.createDiv({ cls: 'winmux-project-list' });
    if (!data.recents.length) list.createDiv({ cls: 'wm-empty', text: `No projects yet. Files live in ${data.dir}` });
    for (const p of data.recents) {
      const row = list.createDiv({ cls: 'winmux-project-row' + (p.missing ? ' is-missing' : '') });
      const dot = row.createDiv({ cls: 'wm-pdot' }); dot.style.background = hashColor(p.path);
      const txt = row.createDiv({ cls: 'wm-txt' });
      txt.createDiv({ cls: 'wm-title', text: p.name + (p.missing ? '  · missing' : '') });
      txt.createDiv({ cls: 'wm-sub', text: `${p.tabs} tab${p.tabs === 1 ? '' : 's'} · ${p.dir || ''} · ${(p.shells || []).join(', ')} · ${ago(p.opened)}` });
      const x = row.createDiv({ cls: 'wm-x', attr: { 'aria-label': 'Remove' } }); setIcon(x, 'x');
      row.onclick = async (e) => {
        if ((e.target as HTMLElement).closest('.wm-x')) return;
        if (p.missing) { await this.plugin.core.json('/api/project?path=' + encodeURIComponent(p.path), { method: 'DELETE' }); await this.render(); return; }
        try {
          const doc = await this.plugin.core.json('/api/project?path=' + encodeURIComponent(p.path));
          this.close();
          await openProjectLayout(this.plugin, doc.layout, doc.name || p.name);
          this.plugin.currentProject = { name: doc.name || p.name, path: p.path };
        } catch (err: any) { new Notice('Open failed: ' + err.message); }
      };
      x.onclick = async (e) => {
        e.stopPropagation();
        const m = new Menu();
        m.addItem(i => i.setTitle('Remove from list').setIcon('list-x').onClick(async () => { await this.plugin.core.json('/api/project?path=' + encodeURIComponent(p.path), { method: 'DELETE' }); await this.render(); }));
        m.addItem(i => i.setTitle('Delete the file too').setIcon('trash').onClick(async () => { await this.plugin.core.json('/api/project?path=' + encodeURIComponent(p.path) + '&trash=1', { method: 'DELETE' }); await this.render(); }));
        m.showAtMouseEvent(e);
      };
    }
    contentEl.createDiv({ cls: 'wm-foot', text: `Project files: ${data.dir}` });
  }
}

export function confirm(app: App, title: string, body: string): Promise<boolean> {
  return new Promise(res => {
    const m = new Modal(app);
    m.setTitle(title);
    m.contentEl.createEl('p', { text: body });
    new Setting(m.contentEl).addButton(b => b.setButtonText('Continue').setWarning().onClick(() => { res(true); m.close(); })).addButton(b => b.setButtonText('Cancel').onClick(() => { res(false); m.close(); }));
    m.onClose = () => res(false);
    m.open();
  });
}

function hashColor(s: string) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return `hsl(${Math.abs(h) % 360} 60% 55%)`; }
export function ago(ms?: number) {
  if (!ms) return '';
  const d = Date.now() - ms; const m = Math.round(d / 60000);
  if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; const h = Math.round(m / 60); if (h < 24) return h + ' h ago'; return Math.round(h / 24) + ' d ago';
}

// ---------------------------------------------------------------- phone access
export async function renderPhonePane(plugin: WinMuxPlugin, el: HTMLElement) {
  el.empty();
  let info: any;
  try { info = await plugin.core.json('/api/phone'); } catch (e: any) { el.createDiv({ cls: 'wm-empty', text: 'Engine not reachable: ' + e.message }); return; }
  const hint = info.on ? 'On — scan the code on your phone.' : info.tailscale ? 'Off. Turn on to open the door on your Tailscale network.' : 'Needs Tailscale running on this PC.';
  const err = el.createDiv({ cls: 'winmux-phone-err' });
  new Setting(el).setName('Use on my phone').setDesc(hint).addToggle(t => t.setValue(!!info.on).setDisabled(!(info.canChange && (info.on || info.tailscale))).onChange(async on => {
    try { await plugin.core.json('/api/phone', { method: 'POST', body: JSON.stringify({ on }) }); await renderPhonePane(plugin, el); }
    catch (e: any) { err.setText(e.message); t.setValue(!on); }
  }));
  if (info.on) {
    const box = el.createDiv({ cls: 'winmux-phone-qr' });
    try {
      const r = await requestUrl({ url: plugin.core.base + '/api/phone/qr?t=' + Date.now(), throw: false });
      if (r.status === 200) box.innerHTML = r.text; else box.setText('QR unavailable');
    } catch { box.setText('QR unavailable'); }
    const urlRow = el.createDiv({ cls: 'winmux-phone-url' });
    urlRow.createSpan({ text: info.url });
    const copy = urlRow.createEl('button', { text: 'Copy link' });
    copy.onclick = () => { navigator.clipboard.writeText(info.url); new Notice('Link copied'); };
    el.createDiv({ cls: 'winmux-phone-warn', text: 'Anyone with this link and the key can type into your shells. Only share it with your own devices.' });
  }
  if (!info.tailscale && !info.on) {
    const g = el.createDiv({ cls: 'winmux-phone-warn' });
    g.setText('Phone access rides on your Tailscale network so nothing is exposed to the internet. ');
    g.createEl('a', { text: 'Get Tailscale', href: 'https://tailscale.com/download' });
  }
  new Setting(el).setName('Skip the key on my Tailscale network').setDesc(`Any device on your tailnet${info.tailnetPeers != null ? ` (${info.tailnetPeers} peers)` : ''} can connect without scanning.`).addToggle(t => t.setValue(!!info.trustTailnet).onChange(async v => {
    try { await plugin.core.json('/api/phone', { method: 'POST', body: JSON.stringify({ trustTailnet: v }) }); } catch (e: any) { err.setText(e.message); }
  }));
  const devs: any[] = info.devices || [];
  if (devs.length) {
    const h = new Setting(el).setName('Remembered phones').setHeading();
    if (devs.length > 1) h.addButton(b => b.setButtonText('Forget all').onClick(async () => { await plugin.core.json('/api/phone/devices', { method: 'POST', body: JSON.stringify({ all: true }) }); await renderPhonePane(plugin, el); }));
    for (const d of devs) {
      new Setting(el).setName(d.name || 'Phone').setDesc(`last used ${ago(d.last)} · first scanned ${ago(d.first)}`).addButton(b => b.setButtonText('Forget').onClick(async () => {
        await plugin.core.json('/api/phone/devices', { method: 'POST', body: JSON.stringify({ forget: d.id }) }); await renderPhonePane(plugin, el);
      }));
    }
  }
}

// ---------------------------------------------------------------- diagnostics
export class DiagnosticsModal extends Modal {
  constructor(app: App, private plugin: WinMuxPlugin) { super(app); }
  async onOpen() { this.setTitle('Diagnostics'); await this.render(); }
  async render() {
    const { contentEl } = this; contentEl.empty();
    let i: any = null; try { i = await this.plugin.core.json('/api/info'); } catch { /* offline */ }
    const rows: [string, string][] = i ? [
      ['WinMux', 'v' + i.version + ' (Obsidian plugin ' + this.plugin.manifest.version + ')'], ['Engine', `${i.runtime} · pid ${i.pid} · ${i.host}:${i.port}`], ['Uptime', Math.round((i.uptime || 0) / 60) + ' min'],
      ['Platform', `${i.platform} · ${i.arch} · ${i.cpus} cores · ${i.mem}`], ['Live shells', String(i.sessions)], ['Background mode', i.detachGraceSecs === 0 ? 'on — shells survive closing Obsidian' : `off — shells end ${i.detachGraceSecs ?? 30} s after closing`], ['Recoverable', String(i.recoverable)], ['Shells found', (i.shells || []).join(', ')],
      ['Workspace file', i.workspaceFile], ['Projects folder', i.projectsDir], ['Recovery folder', i.backlogDir], ['Settings file', i.configFile], ['Phone access', i.phone],
      ['Terminals open here', String(this.plugin.terminalViews().length)], ['Obsidian', String((window as any).apiVersion || '')], ['Plugin folder', this.plugin.pluginDir()],
    ] : [['Engine', 'not reachable']];
    const tbl = contentEl.createEl('table', { cls: 'winmux-diag' });
    for (const [k, v] of rows) { const tr = tbl.createEl('tr'); tr.createEl('td', { text: k }); tr.createEl('td', { text: v }); }
    new Setting(contentEl).addButton(b => b.setButtonText('Copy diagnostics').onClick(() => { navigator.clipboard.writeText(rows.map(r => r.join(': ')).join('\n')); new Notice('Copied'); }))
      .addButton(b => b.setButtonText('Refresh').onClick(() => this.render()));
  }
}

// ---------------------------------------------------------------- cheat sheet
export class CheatModal extends Modal {
  constructor(app: App, private plugin: WinMuxPlugin) { super(app); }
  async onOpen() {
    this.setTitle('WinMux cheat sheet');
    const { contentEl } = this;
    const cmds = Object.values((this.app as any).commands.commands as Record<string, any>).filter(c => c.id.startsWith('winmux:'));
    const hk = (id: string) => { const ks = (this.app as any).hotkeyManager.getHotkeys(id) || (this.app as any).hotkeyManager.getDefaultHotkeys(id) || []; return ks.map((k: any) => [...(k.modifiers || []), k.key].join('+').replace('Mod', 'Ctrl')).join(', '); };
    contentEl.createEl('h4', { text: 'Commands (Ctrl+P → "WinMux")' });
    const t = contentEl.createEl('table', { cls: 'winmux-diag' });
    for (const c of cmds) { const tr = t.createEl('tr'); tr.createEl('td', { text: c.name }); tr.createEl('td', { text: hk(c.id) || '—' }); }
    contentEl.createEl('h4', { text: 'Words WinMux uses' });
    for (const [k, v] of [['Tab', 'One terminal. Obsidian tabs, splits and stacking all work.'], ['Session', 'The shell behind a tab. It survives closing the tab for 30 s and can be recovered from the sidebar afterwards.'], ['Recoverable', 'A session whose scrollback is saved; click it to start a fresh shell in the same folder with the old output.'], ['Project', 'A saved set of shells + folders. Opening it starts fresh shells.'], ['Needs you', 'A terminal rang the bell or an agent asked for a decision — Approve sends Enter, Deny sends Escape.']]) {
      const p = contentEl.createEl('p'); p.createEl('b', { text: k + ' — ' }); p.createSpan({ text: v });
    }
    let i: any = null; try { i = await this.plugin.core.json('/api/info'); } catch { /* offline */ }
    if (i) {
      contentEl.createEl('h4', { text: 'Where your stuff lives' });
      contentEl.createEl('p', { text: `Projects: ${i.projectsDir}` });
      contentEl.createEl('p', { text: `Recovery: ${i.backlogDir}` });
      contentEl.createEl('p', { text: `Engine settings: ${i.configFile}` });
    }
  }
}

// ---------------------------------------------------------------- Claude resume
export async function resumeClaudeMenu(plugin: WinMuxPlugin, e: MouseEvent, cwd: string, v?: TerminalView) {
  let r: any; try { r = await plugin.core.json('/api/claude-sessions?cwd=' + encodeURIComponent(cwd)); } catch (err: any) { new Notice('Could not list Claude sessions: ' + err.message); return; }
  const list: any[] = r.sessions || [];
  if (!list.length) { new Notice('No Claude sessions found for ' + cwd); return; }
  const m = new Menu();
  for (const s of list.slice(0, 15)) {
    const label = (s.title || s.summary || s.id || '').toString().slice(0, 60) + (s.mtime || s.updated ? ' · ' + ago(s.mtime || s.updated) : '');
    m.addItem(i => i.setTitle(label).setIcon('history').onClick(async () => {
      const target = v && v.status !== 'closed' ? v : await plugin.openSession(undefined, undefined, cwd);
      if (!target) return;
      const cmd = plugin.settings.resumeCommand.replace('{id}', s.id || s.sessionId);
      setTimeout(() => target.send({ t: 'i', d: cmd + '\r' }), v ? 0 : 1200);
    }));
  }
  m.showAtMouseEvent(e);
}

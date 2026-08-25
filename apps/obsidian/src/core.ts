// Engine client: find a running winmux-core (shared ~/.winmux/instance.json, same
// discovery as the CLI) or spawn the bundled one. Never kills the engine on
// unload — the core is designed to outlive UIs (30 s grace + backlog).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { requestUrl } from 'obsidian';

export interface Instance { port: number; host: string; pid: number; started?: number }
export interface Info { version: string; port: number; pid: number; sessions: number; detached: number; recoverable: number; detachGraceSecs?: number }
export interface BacklogEntry { id: string; shell: string; cwd: string; savedAt?: number; dev?: string }

const instanceFile = () => process.env.WINMUX_INSTANCE_FILE || join(homedir(), '.winmux', 'instance.json');

function pidAlive(pid: number): boolean {
  if (!pid) return true;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e && e.code === 'EPERM'; }
}

export class CoreClient {
  inst: Instance | null = null;
  spawnedPid: number | null = null;
  constructor(private exePath: string, private extraEnv: () => Record<string, string> = () => ({})) {}

  get base(): string { return `http://${this.inst?.host || '127.0.0.1'}:${this.inst?.port}`; }
  get wsBase(): string { return `ws://${this.inst?.host || '127.0.0.1'}:${this.inst?.port}`; }

  readInstance(): Instance | null {
    try {
      const f = instanceFile();
      if (!existsSync(f)) return null;
      const j = JSON.parse(readFileSync(f, 'utf8'));
      if (j && j.port && pidAlive(j.pid)) return { port: j.port, host: j.host || '127.0.0.1', pid: j.pid, started: j.started };
    } catch { /* fallthrough */ }
    return null;
  }

  async info(inst = this.inst): Promise<Info | null> {
    if (!inst) return null;
    try {
      // requestUrl bypasses CORS (page origin is app://obsidian.md); plain fetch is blocked.
      const r = await requestUrl({ url: `http://${inst.host}:${inst.port}/api/info`, throw: false });
      if (r.status !== 200) return null;
      return r.json as Info;
    } catch { return null; }
  }

  /** Attach to a live engine, or spawn the bundled one. Returns the engine info. */
  async ensure(): Promise<Info> {
    // A live pid in the instance file means an engine exists — never start a second
    // one for the same identity; give it a few seconds if it's still booting.
    for (let i = 0; i < 12; i++) {
      const found = this.readInstance();
      if (!found) break;
      const info = await this.info(found);
      if (info) { this.inst = found; return info; }
      await new Promise(r => setTimeout(r, 250));
    }
    if (this.readInstance()) throw new Error('an engine is registered in ~/.winmux/instance.json but not answering');
    if (!existsSync(this.exePath)) throw new Error('bundled engine missing: ' + this.exePath);
    const child = spawn(this.exePath, [], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...this.extraEnv() } });
    child.unref();
    this.spawnedPid = child.pid ?? null;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      const inst = this.readInstance();
      if (inst) { const info = await this.info(inst); if (info) { this.inst = inst; return info; } }
    }
    throw new Error('engine did not come up within 10 s');
  }

  async json<T = any>(path: string, init?: { method?: string; body?: string }): Promise<T> {
    const r = await requestUrl({ url: this.base + path, method: init?.method || 'GET', body: init?.body, contentType: init?.body ? 'application/json' : undefined, throw: false });
    if (r.status < 200 || r.status >= 300) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json as T;
  }

  shells(): Promise<any> { return this.json('/shells'); }
  backlog(): Promise<any> { return this.json('/api/backlog'); }
  deleteSession(sid: string): Promise<any> { return this.json('/api/session?sid=' + encodeURIComponent(sid), { method: 'DELETE' }); }
  shutdown(): Promise<any> { return this.json('/api/shutdown', { method: 'POST' }); }

  ptyUrl(q: { shell?: string; cwd?: string; sid?: string }): string {
    const p = new URLSearchParams();
    if (q.shell) p.set('shell', q.shell);
    if (q.cwd) p.set('cwd', q.cwd);
    if (q.sid) p.set('sid', q.sid);
    return `${this.wsBase}/pty?${p.toString()}`;
  }
}

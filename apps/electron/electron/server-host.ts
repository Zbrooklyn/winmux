// Session survival: instead of hosting server.cjs inside this Electron process
// (where closing the window kills every shell), the app RESOLVES a server —
// reattaching to one already running for this profile, or spawning a DETACHED one
// that outlives the window. The renderer then connects to it over loopback.
//
// Discovery reuses the server's existing instance file ({ port, host, pid, started }
// at WINMUX_INSTANCE_FILE): a server is "live" if the file names a running pid AND
// answers GET /api/info. That guards against a stale file left by a hard crash and
// against ever double-spawning alongside a healthy server.
//
// The detached child is Electron-run-as-Node (ELECTRON_RUN_AS_NODE=1) executing the
// same server.cjs, so it works packaged (asar) and from source alike. It is unref'd
// so this process can exit without waiting on it.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';

export interface Instance { port: number; host: string; pid: number; started: number; }
export interface Resolved { port: number; host: string; attached: boolean; }

function readInstance(file: string): Instance | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Instance; } catch (e) { return null; }
}

// process.kill(pid, 0) throws ESRCH if the pid is gone, EPERM if it exists but is
// owned by someone else (still "alive" for our purposes).
function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return !!(e && e.code === 'EPERM'); }
}

function ping(port: number, host: string, timeout = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/api/info', timeout }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// How long to keep asking a server that is DEFINITELY still running (its pid is
// alive) but hasn't answered yet. Zero on the first look of a cold launch would
// be wrong: getting this call wrong costs the user every shell, agent and
// unsaved scrollback on the old engine, because the newcomer takes the next
// port and overwrites the file that says where the real one lives. Nothing is
// on the other side of the trade except a few seconds on a launch that is
// already unusual.
const PATIENCE_MS = 8000;

// A server is "live" if its file names a running pid AND it answers. The second
// half used to be a single 1200ms ping — one missed answer during an antivirus
// scan, a Dropbox sync or a cold start and a healthy engine was declared dead.
// So the deadline now depends on what we actually know:
//   pid gone      → dead, immediately. That is the real crash case and it should
//                   not cost a cold launch a single millisecond.
//   pid alive     → keep asking. A running process that is briefly too busy to
//                   answer is overwhelmingly the likelier reading, and it is the
//                   one where being wrong destroys work.
async function liveInstance(file: string, patienceMs = PATIENCE_MS): Promise<Instance | null> {
  const inst = readInstance(file);
  if (!inst || !inst.port) return null;
  if (inst.pid && !pidAlive(inst.pid)) return null;   // stale file — the server crashed
  const host = inst.host || '127.0.0.1';
  if (await ping(inst.port, host)) return inst;
  // No pid to vouch for it, or no patience budget (the post-spawn poll below
  // wants a fast answer, not an 8-second one).
  if (!inst.pid || patienceMs <= 0) return null;
  const until = Date.now() + patienceMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 250));
    // If it dies while we are waiting, THEN it is really gone — and we learn
    // that from the pid, not from another timeout.
    if (!pidAlive(inst.pid)) return null;
    if (await ping(inst.port, host, 2000)) return inst;
  }
  return null;
}

export interface ResolveOpts {
  instanceFile: string;
  trustFile: string;
  execPath: string;    // process.execPath (electron binary / node)
  serverPath: string;  // absolute path to server.cjs
  timeoutMs?: number;
  port?: number;       // force a specific port on the spawned server (tests/pinning)
  rustCorePath?: string;              // when set, spawn this native Rust core instead of node+server.cjs
  extraEnv?: Record<string, string>;  // extra env for the spawned core (e.g. WINMUX_PUBLIC for the Rust core)
}

// Reattach to a live server for this profile, else spawn a detached one and wait
// for it to advertise its port. Throws if a freshly spawned server never comes up.
// The Rust core (rustCorePath) is discovered the same way — it writes the same
// instance.json and answers /api/info — so everything downstream is identical.
export async function resolveServer(opts: ResolveOpts): Promise<Resolved> {
  const live = await liveInstance(opts.instanceFile);
  if (live) return { port: live.port, host: live.host || '127.0.0.1', attached: true };

  const rust = !!opts.rustCorePath;
  const [cmd, args] = rust ? [opts.rustCorePath as string, []] : [opts.execPath, [opts.serverPath]];
  const env = Object.assign({}, process.env,
    rust ? {} : { ELECTRON_RUN_AS_NODE: '1' },
    { WINMUX_INSTANCE_FILE: opts.instanceFile, WINMUX_TRUST_FILE: opts.trustFile },
    opts.port ? (rust ? { WINMUX_PORT: String(opts.port) } : { PORT: String(opts.port) }) : {},
    opts.extraEnv || {},
  );
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env });
  child.unref();

  const deadline = Date.now() + (opts.timeoutMs || 15000);
  while (Date.now() < deadline) {
    // patience 0: we are waiting on a server we just started, and the loop below
    // already IS the waiting. Handing it 8s of extra patience per pass would turn
    // a 15s budget into two attempts.
    const inst = await liveInstance(opts.instanceFile, 0);
    if (inst) return { port: inst.port, host: inst.host || '127.0.0.1', attached: false };
    // 50ms, not 200: the check is a local file read + loopback ping, so polling
    // fast is free — and every wasted step here is dead time on the cold path
    // between "window painted" and "prompt usable" (SP-3).
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('detached server did not come up within ' + (opts.timeoutMs || 15000) + 'ms');
}

// Ask a running server to shut down (used by the deliberate "quit completely" path).
export function shutdownServer(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: '/api/shutdown', method: 'POST', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

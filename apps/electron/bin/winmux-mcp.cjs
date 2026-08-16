#!/usr/bin/env node
'use strict';
// winmux-mcp — a Model Context Protocol server that lets an MCP client (Claude
// Code, etc.) drive the running WinMux app natively. It is a thin stdio adapter
// over the same /rpc surface the `winmux` CLI uses: each MCP tool forwards to a
// /rpc command and returns its JSON result. No SDK dependency — the MCP stdio
// transport is newline-delimited JSON-RPC 2.0, implemented directly here.
//
// Discovery reuses the CLI's instance file (~/.winmux/instance*.json), so there
// is nothing to configure when WinMux is running; a clear error is returned when
// it isn't. Add to a Claude Code .mcp.json — see docs/winmux-mcp.md.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

function pidAlive(pid) {
  if (!pid) return true; // older files may omit pid — don't reject them
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

function instance() {
  if (process.env.WINMUX_PORT) return { port: Number(process.env.WINMUX_PORT), host: process.env.WINMUX_HOST || '127.0.0.1' };
  // Mirror the CLI's discovery: primary app first, then the side-by-side WinMux
  // Rust app; a file whose pid is dead is a stale leftover, not a target.
  const dev = process.argv.includes('--dev') || process.env.WINMUX_PROFILE === 'dev';
  const dir = path.join(os.homedir(), '.winmux');
  const candidates = process.env.WINMUX_INSTANCE_FILE ? [process.env.WINMUX_INSTANCE_FILE]
    : dev ? [path.join(dir, 'instance.dev.json')]
    : [path.join(dir, 'instance.json'), path.join(dir, 'instance.rust.json')];
  for (const f of candidates) {
    try {
      const inst = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (inst && inst.port && pidAlive(inst.pid)) return inst;
    } catch (e) { /* missing or unreadable — try the next candidate */ }
  }
  throw new Error('no live instance');   // caller turns it into a tool error
}

function rpc(cmd, args) {
  return new Promise((resolve, reject) => {
    let inst;
    try { inst = instance(); } catch (e) { return reject(new Error('WinMux is not running (start it with the desktop app or `npm start`).')); }
    const body = JSON.stringify({ cmd, args: args || {} });
    const req = http.request({
      host: (inst.host && inst.host !== '0.0.0.0') ? inst.host : '127.0.0.1',
      port: inst.port, path: '/rpc', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let b = ''; res.on('data', (d) => b += d);
      res.on('end', () => {
        let j; try { j = JSON.parse(b); } catch (e) { return reject(new Error('bad reply: ' + b.slice(0, 120))); }
        if (res.statusCode === 200 && j.ok) resolve(j.result);
        else reject(new Error(j && j.error ? j.error : ('HTTP ' + res.statusCode)));
      });
    });
    req.on('error', (e) => reject(new Error('cannot reach WinMux: ' + e.message)));
    req.end(body);
  });
}

// Each tool maps 1:1 to a /rpc command. `map` turns the MCP tool arguments into
// the /rpc args shape (mostly identity; a couple rename for clarity).
const TOOLS = [
  { name: 'winmux_list', desc: 'List the open WinMux terminal sessions (id, title, shell, cwd, which is active).',
    schema: { type: 'object', properties: {} }, cmd: 'list' },
  { name: 'winmux_read_screen', desc: "Read a terminal's visible text. Omit id for the active one; lines caps how much scrollback.",
    schema: { type: 'object', properties: { id: { type: 'number' }, lines: { type: 'number' } } },
    cmd: 'read-screen', map: (a) => ({ target: a.id, lines: a.lines || 0 }) },
  { name: 'winmux_send', desc: "Type text into a terminal. Omit id for the active one; set enter to press Enter after.",
    schema: { type: 'object', properties: { text: { type: 'string' }, id: { type: 'number' }, enter: { type: 'boolean' } }, required: ['text'] },
    cmd: 'send', map: (a) => ({ data: a.text, enter: !!a.enter, target: a.id }) },
  { name: 'winmux_new_tab', desc: 'Open a new terminal tab, optionally with a specific shell key.',
    schema: { type: 'object', properties: { shell: { type: 'string' } } }, cmd: 'new-tab' },
  { name: 'winmux_split', desc: 'Split the active pane. dir is "right" (default) or "down".',
    schema: { type: 'object', properties: { dir: { type: 'string', enum: ['right', 'down'] }, shell: { type: 'string' } } }, cmd: 'split' },
  { name: 'winmux_focus', desc: 'Focus a terminal by id.',
    schema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    cmd: 'focus', map: (a) => ({ target: a.id }) },
  { name: 'winmux_notify', desc: 'Flag a session as needing the user (attention bus). Omit id for the active one.',
    schema: { type: 'object', properties: { message: { type: 'string' }, id: { type: 'number' } } },
    cmd: 'notify', map: (a) => ({ message: a.message, target: a.id }) },
  { name: 'winmux_browser', desc: 'Drive the WinMux browser panel (Electron). sub: open|snapshot|click|type|fill|get-text|eval|scroll|back|forward|reload|url|screenshot. type/fill take ref+text/value; eval takes js; scroll takes amount (up|down|top|bottom|<px>).',
    schema: { type: 'object', properties: { sub: { type: 'string' }, url: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' }, value: { type: 'string' }, js: { type: 'string' }, amount: { type: 'string' } }, required: ['sub'] },
    cmd: 'browser' },
  { name: 'winmux_markdown', desc: 'Open a markdown file in the WinMux viewer surface.',
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, cmd: 'markdown' },
  { name: 'winmux_agent', desc: "Set a session's agent state in the cockpit: working | needs-you | done | idle. Omit id/sid for the active session; needs-you raises the NEEDS YOU alarm + Approve, done/idle clear it.",
    schema: { type: 'object', properties: { state: { type: 'string', enum: ['working', 'needs-you', 'done', 'idle'] }, message: { type: 'string' }, id: { type: 'number' } }, required: ['state'] },
    cmd: 'agent', map: (a) => ({ state: a.state, message: a.message, target: a.id }) },
  // --- orchestration: spawn a worker session and track its job as data ------
  { name: 'winmux_agent_spawn', desc: 'Spawn a worker Claude Code session in a new WinMux tab (or split pane) to do a task, registered as a job. Streams live in the pane; the worker reports its own completion + result. Returns { jobId, sid }. split: "right"|"down" opens a split pane of the current tab (use when the user wants sessions side by side); omit for a new tab. model picks the worker model — default "sonnet" (cost-safe); "haiku" for trivial mechanical tasks; "opus" or "inherit" (account default) only when the task genuinely needs top-tier reasoning. headless runs `claude -p` instead of the interactive session.',
    schema: { type: 'object', properties: { task: { type: 'string' }, name: { type: 'string' }, cwd: { type: 'string' }, split: { type: 'string', enum: ['right', 'down'] }, model: { type: 'string' }, headless: { type: 'boolean' } }, required: ['task'] },
    run: async (a) => {
      const args = ['agent', 'spawn', a.task, '--json'];
      if (!a.headless) args.push('--tui');
      if (a.name) args.push('--name', a.name);
      if (a.cwd) args.push('--cwd', a.cwd);
      if (a.split) args.push('--split', a.split);
      if (a.model) args.push('--model', a.model);
      const r = await cli(args, 120000);
      if (r.code !== 0) throw new Error(r.err || r.out || 'spawn failed');
      const j = JSON.parse(r.out);
      return { jobId: j.jobId, sid: j.sid };
    } },
  { name: 'winmux_agent_wait', desc: 'Wait for a spawned job to finish (bounded). Returns the job {state, result?}. state "working" means the timeout elapsed — call again with the same jobId.',
    schema: { type: 'object', properties: { jobId: { type: 'string' }, timeoutSec: { type: 'number' } }, required: ['jobId'] },
    run: (a) => rpc('job-wait', { jobId: a.jobId, timeoutMs: Math.round((a.timeoutSec || 120) * 1000) }) },
  { name: 'winmux_agent_result', desc: "Read a spawned job's state and result.",
    schema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
    run: (a) => rpc('job-status', { jobId: a.jobId }) },
  { name: 'winmux_slash', desc: "Type a slash command into a running Claude Code session's terminal — e.g. '/model haiku' to switch that session's model mid-flight (applies to its next turns), '/compact' to shrink its context. Waits for the session to be idle at its input prompt first; force queues it while working. id targets the session (from winmux_agent_spawn's sid or winmux_list); omit for the active one.",
    schema: { type: 'object', properties: { command: { type: 'string' }, id: { type: 'number' }, force: { type: 'boolean' } }, required: ['command'] },
    run: async (a) => {
      const args = ['slash', a.command];
      if (a.id != null) args.push('--id', String(a.id));
      if (a.force) args.push('--force');
      const r = await cli(args, 120000);
      if (r.code !== 0) throw new Error(r.err || r.out || 'slash failed');
      return { ok: true, sent: a.command };
    } },
  { name: 'winmux_transcript', desc: "Per-turn history of a Claude Code session, read from its transcript on disk — what a worker actually did, turn by turn (role, time, tools used, text). Pick the session by cwd (newest session in that folder), by session uuid, or omit both for the newest session in the current folder. turns limits to the last N (default 20, 0 = all).",
    schema: { type: 'object', properties: { cwd: { type: 'string' }, session: { type: 'string' }, turns: { type: 'number' }, full: { type: 'boolean' } } },
    run: async (a) => {
      const args = ['transcript', '--json'];
      if (a.cwd) args.push('--cwd', String(a.cwd));
      if (a.session) args.push('--session', String(a.session));
      if (a.turns != null) args.push('--turns', String(a.turns));
      if (a.full) args.push('--full');
      const r = await cli(args, 60000);
      if (r.code !== 0) throw new Error(r.err || r.out || 'transcript failed');
      try { return JSON.parse(r.out); } catch (e) { return { raw: r.out }; }
    } },
];

// Run the winmux CLI as a child process (for tools that are client-side flows,
// not single /rpc commands — e.g. spawn's tab+register+launcher sequence).
function cli(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    execFile(process.execPath, [path.join(__dirname, 'winmux.cjs')].concat(args),
      { timeout: timeoutMs || 60000, env: process.env, windowsHide: true },
      (err, so, se) => {
        if (err && err.killed) return reject(new Error('winmux CLI timed out'));
        resolve({ code: err ? (err.code || 1) : 0, out: String(so || '').trim(), err: String(se || '').trim() });
      });
  });
}
const BY_NAME = {}; TOOLS.forEach((t) => { BY_NAME[t.name] = t; });

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id: id, result: result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id: id, error: { code: code, message: message } }); }

async function handle(msg) {
  if (msg.method === 'initialize') {
    return reply(msg.id, {
      protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'winmux', version: '0.1.0' },
    });
  }
  if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') return;   // notifications: no reply
  if (msg.method === 'ping') return reply(msg.id, {});
  if (msg.method === 'tools/list') {
    return reply(msg.id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.desc, inputSchema: t.schema })) });
  }
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const t = BY_NAME[name];
    if (!t) return replyErr(msg.id, -32602, 'unknown tool: ' + name);
    const args = (msg.params && msg.params.arguments) || {};
    try {
      const result = t.run ? await t.run(args) : await rpc(t.cmd, t.map ? t.map(args) : args);
      return reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (e) {
      return reply(msg.id, { content: [{ type: 'text', text: 'error: ' + e.message }], isError: true });
    }
  }
  if (msg.id != null) replyErr(msg.id, -32601, 'method not found: ' + msg.method);
}

// Newline-delimited JSON-RPC over stdin.
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
    Promise.resolve(handle(msg)).catch((e) => { if (msg && msg.id != null) replyErr(msg.id, -32603, String(e && e.message || e)); });
  }
});
process.stdin.on('end', () => process.exit(0));

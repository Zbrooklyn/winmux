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

function instance() {
  if (process.env.WINMUX_PORT) return { port: Number(process.env.WINMUX_PORT), host: process.env.WINMUX_HOST || '127.0.0.1' };
  const dev = process.argv.includes('--dev') || process.env.WINMUX_PROFILE === 'dev';
  const f = process.env.WINMUX_INSTANCE_FILE
    || path.join(os.homedir(), '.winmux', dev ? 'instance.dev.json' : 'instance.json');
  return JSON.parse(fs.readFileSync(f, 'utf8'));   // throws if not running — caller turns it into a tool error
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
];
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
      const result = await rpc(t.cmd, t.map ? t.map(args) : args);
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

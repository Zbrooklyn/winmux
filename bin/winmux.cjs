#!/usr/bin/env node
'use strict';
// The `winmux` command-line. Drives the running WinMux app by POSTing to /rpc on
// the desk door; the server forwards each command to the app over /control.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

function die(msg) { process.stderr.write('winmux: ' + msg + '\n'); process.exit(1); }
function out(v) { process.stdout.write((typeof v === 'string' ? v : JSON.stringify(v, null, 2)) + '\n'); }

function instance() {
  // An explicit target wins — for scripting a specific instance (and the harness).
  if (process.env.WINMUX_PORT) return { port: Number(process.env.WINMUX_PORT), host: process.env.WINMUX_HOST || '127.0.0.1' };
  const f = path.join(os.homedir(), '.winmux', 'instance.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { die('WinMux is not running (no ~/.winmux/instance.json). Start it with `npm start` or the desktop app.'); }
}

function rpc(cmd, args) {
  const inst = instance();
  const body = JSON.stringify({ cmd, args: args || {} });
  return new Promise((resolve, reject) => {
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

const HELP = [
  'winmux <command> [args]', '',
  '  list                             the open terminals (id, title, shell, cwd)',
  '  new-tab [shell]                  open a new tab in the active pane',
  '  split [right|down] [shell]       split the active pane',
  '  send <text> [--id N] [--enter]   type text into a terminal (default: active)',
  '  read-screen [--id N] [--lines N] print a terminal\'s visible text',
  '  focus <id>                       focus a terminal',
  '',
  '  browser open <url>               open the browser panel at a URL (desktop app)',
  '  browser snapshot                 list the page\'s interactive elements as @refs',
  '  browser click <@ref>             click an element from the snapshot',
  '  browser back|forward|reload|url  navigate the browser panel',
  '  browser screenshot [file]        save a PNG of the page',
  '',
  '  --json                           raw JSON output where relevant',
].join('\n');

function flag(argv, name) { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; }
function has(argv, name) { return argv.indexOf(name) >= 0; }

(async () => {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') { out(HELP); return; }
  try {
    if (cmd === 'list') {
      const r = await rpc('list');
      if (has(argv, '--json')) return out(r);
      if (!r.sessions.length) return out('(no terminals open)');
      return out(r.sessions.map((s) => (s.active ? '* ' : '  ') + s.id + '  ' + s.title + '  [' + s.shell + ']  ' + (s.cwd || '')).join('\n'));
    }
    if (cmd === 'new-tab') { return out(await rpc('new-tab', { shell: argv[1] })); }
    if (cmd === 'split') {
      const dir = (argv[1] === 'down' || argv[1] === 'right') ? argv[1] : 'right';
      const shell = (argv[1] === 'down' || argv[1] === 'right') ? argv[2] : argv[1];
      return out(await rpc('split', { dir, shell }));
    }
    if (cmd === 'send') {
      const text = argv[1];
      if (text == null || text.startsWith('--')) die('send needs text: winmux send "Get-Date" --enter');
      return out(await rpc('send', { data: text, enter: has(argv, '--enter'), target: flag(argv, '--id') }));
    }
    if (cmd === 'read-screen') {
      const r = await rpc('read-screen', { target: flag(argv, '--id'), lines: Number(flag(argv, '--lines')) || 0 });
      if (has(argv, '--json')) return out(r);
      return out(r.screen);
    }
    if (cmd === 'focus') { if (!argv[1]) die('focus needs a terminal id'); return out(await rpc('focus', { target: argv[1] })); }
    if (cmd === 'browser') {
      const sub = argv[1] || 'open';
      if (sub === 'open') { if (!argv[2]) die('browser open needs a URL'); return out(await rpc('browser', { sub: 'open', url: argv[2] })); }
      if (sub === 'click') { if (!argv[2]) die('browser click needs a ref, e.g. @e1'); return out(await rpc('browser', { sub: 'click', ref: argv[2] })); }
      if (sub === 'snapshot') {
        const r = await rpc('browser', { sub: 'snapshot' });
        if (has(argv, '--json')) return out(r);
        return out((r.url ? r.url + '\n' : '') + (r.tree || '(nothing interactive on the page)'));
      }
      if (sub === 'screenshot') {
        const r = await rpc('browser', { sub: 'screenshot' });
        const dest = argv[2] || 'winmux-browser.png';
        const b64 = String(r.dataUrl || '').replace(/^data:image\/png;base64,/, '');
        fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
        return out('saved ' + dest);
      }
      if (['back', 'forward', 'reload', 'url'].indexOf(sub) >= 0) return out(await rpc('browser', { sub }));
      die('unknown browser subcommand: ' + sub + ' (open|snapshot|click|back|forward|reload|url|screenshot)');
    }
    if (cmd === 'agent') die('agent arrives in Phase 11. Run `winmux help` for what works today.');
    die('unknown command: ' + cmd + '. Run `winmux help`.');
  } catch (e) { die(e.message); }
})();

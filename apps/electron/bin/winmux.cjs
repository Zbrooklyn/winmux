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
  // Which copy to drive: an explicit file wins; then --dev / WINMUX_PROFILE=dev;
  // otherwise the production instance (the installed app is the default target).
  const dev = process.argv.includes('--dev') || process.env.WINMUX_PROFILE === 'dev';
  const f = process.env.WINMUX_INSTANCE_FILE
    || path.join(os.homedir(), '.winmux', dev ? 'instance.dev.json' : 'instance.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { die('WinMux is not running (no ' + f + '). Start it with `npm start` or the desktop app.'); }
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

// A plain GET against the server (not the /rpc control path) — for read-only
// endpoints like /api/info that answer without a connected app.
function get(urlPath) {
  const inst = instance();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: (inst.host && inst.host !== '0.0.0.0') ? inst.host : '127.0.0.1',
      port: inst.port, path: urlPath, method: 'GET',
    }, (res) => {
      let b = ''; res.on('data', (d) => b += d);
      res.on('end', () => {
        let j; try { j = JSON.parse(b); } catch (e) { return reject(new Error('bad reply: ' + b.slice(0, 120))); }
        resolve(j);
      });
    });
    req.on('error', (e) => reject(new Error('cannot reach WinMux: ' + e.message)));
    req.end();
  });
}

const HELP = [
  'winmux <command> [args]', '',
  '  status                           the running server + fleet (sessions, phone)',
  '  list                             the open terminals (id, title, shell, cwd)',
  '  new-tab [shell]                  open a new tab in the active pane',
  '  split [right|down] [shell]       split the active pane',
  '  send <text> [--id N] [--enter]   type text into a terminal (default: active)',
  '  read-screen [--id N] [--lines N] print a terminal\'s visible text',
  '  focus <id>                       focus a terminal',
  '  notify [--id N] <message>        flag a session as needing you (attention bus)',
  '  agent <state> [--sid S] [msg]    set a session\'s agent state: working|needs-you|done|idle',
  '',
  '  browser open <url>               open the browser panel at a URL (desktop app)',
  '  browser snapshot                 list the page\'s interactive elements as @refs',
  '  browser click <@ref>             click an element from the snapshot',
  '  browser type <@ref> <text>       type text into a field (appends)',
  '  browser fill <@ref> <value>      replace a field\'s value',
  '  browser get-text                 dump the page\'s visible text',
  '  browser eval <js>                evaluate a JS expression in the page',
  '  browser scroll [up|down|top|bottom|N]  scroll the page',
  '  browser back|forward|reload|url  navigate the browser panel',
  '  browser screenshot [file]        save a PNG of the page',
  '',
  '  markdown <file>                  open a markdown file in the viewer (live-updates)',
  '',
  '  image <file>                     show an image inline in the current terminal',
  '',
  '  open <file.json>                 open a saved workspace — a set of terminals,',
  '                                   each with its own cwd, shell, and start command',
  '',
  '  --json                           raw JSON output where relevant',
].join('\n');

function flag(argv, name) { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; }
function has(argv, name) { return argv.indexOf(name) >= 0; }

(async () => {
  const argv = process.argv.slice(2);
  // --dev selects the dev copy in instance(); it is not a verb argument.
  const devFlagIdx = argv.indexOf('--dev');
  if (devFlagIdx !== -1) argv.splice(devFlagIdx, 1);
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') { out(HELP); return; }

  // `winmux image <path>` — show a picture inline, imgcat-style. It writes the iTerm2
  // inline-image (IIP) escape to THIS process's stdout; when run inside a WinMux
  // terminal, that terminal's image addon renders it right where the command ran — no
  // /rpc, no server round-trip, so it works for anything in the shell (incl. Claude
  // Code). Local and self-contained on purpose.
  if (cmd === 'image') {
    const file = argv[1];
    if (!file) die('image needs a file path, e.g. winmux image logo.png');
    let data;
    try { data = fs.readFileSync(file); } catch (e) { die('cannot read ' + file + ': ' + e.message); }
    const MAX = 20 * 1024 * 1024;   // 20 MB guard — matches the addon's storage budget headroom
    if (data.length > MAX) die(file + ' is ' + Math.round(data.length / 1048576) + ' MB; over the 20 MB inline limit');
    const name = Buffer.from(path.basename(file)).toString('base64');
    // Trailing newline so the shell's next prompt lands on a fresh line BELOW the image
    // instead of overwriting its last row (imgcat does the same). The leading newline
    // gives the picture a little breathing room under the command that produced it.
    process.stdout.write('\n\x1b]1337;File=name=' + name + ';size=' + data.length + ';inline=1:' + data.toString('base64') + '\x07\n');
    return;
  }

  // Human-friendly by default; raw JSON with --json, uniformly across verbs.
  const emit = (human, data) => (has(argv, '--json') ? out(data) : out(human));
  try {
    if (cmd === 'status') {
      const i = await get('/api/info');
      if (has(argv, '--json')) return out(i);
      return out([
        'WinMux ' + (i.host || '127.0.0.1') + ':' + i.port + '  (pid ' + i.pid + ')',
        '  sessions: ' + i.sessions + (i.detached ? '  (' + i.detached + ' detached, waiting to reattach)' : ''),
        '  phone:    ' + (i.phone || 'off'),
        '  shells:   ' + (Array.isArray(i.shells) ? i.shells.join(', ') : ''),
      ].join('\n'));
    }
    if (cmd === 'list') {
      const r = await rpc('list');
      if (has(argv, '--json')) return out(r);
      if (!r.sessions.length) return out('(no terminals open)');
      return out(r.sessions.map((s) => (s.active ? '* ' : '  ') + s.id + '  ' + s.title + '  [' + s.shell + ']  ' + (s.cwd || '')).join('\n'));
    }
    if (cmd === 'new-tab') {
      const r = await rpc('new-tab', { shell: argv[1] });
      return emit('opened a new tab' + (r && r.id ? ' (' + r.id + ')' : ''), r);
    }
    if (cmd === 'split') {
      const dir = (argv[1] === 'down' || argv[1] === 'right') ? argv[1] : 'right';
      const shell = (argv[1] === 'down' || argv[1] === 'right') ? argv[2] : argv[1];
      const r = await rpc('split', { dir, shell });
      return emit('split ' + dir + (r && r.id ? ' (' + r.id + ')' : ''), r);
    }
    if (cmd === 'send') {
      const text = argv[1];
      if (text == null || text.startsWith('--')) die('send needs text: winmux send "Get-Date" --enter');
      const r = await rpc('send', { data: text, enter: has(argv, '--enter'), target: flag(argv, '--id') });
      return emit('sent', r);
    }
    if (cmd === 'read-screen') {
      const r = await rpc('read-screen', { target: flag(argv, '--id'), lines: Number(flag(argv, '--lines')) || 0 });
      if (has(argv, '--json')) return out(r);
      return out(r.screen);
    }
    if (cmd === 'focus') { if (!argv[1]) die('focus needs a terminal id'); return emit('focused ' + argv[1], await rpc('focus', { target: argv[1] })); }
    if (cmd === 'notify') {
      // Attention bus: mark a session as needing Edward. Message is the free text
      // after the verb; --id targets a specific session, else the active one.
      const words = [];
      for (let i = 1; i < argv.length; i++) {
        if (argv[i] === '--id') { i++; continue; }   // skip flag + its value
        if (argv[i] === '--json') continue;
        words.push(argv[i]);
      }
      const msg = words.join(' ') || 'needs your attention';
      const r = await rpc('notify', { message: msg, target: flag(argv, '--id') });
      return emit('flagged session ' + (r && r.id != null ? r.id : '') + ' as needing you', r);
    }
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
      if (sub === 'type') { if (!argv[2]) die('browser type needs a ref + text, e.g. @e1 hello'); return out(await rpc('browser', { sub: 'type', ref: argv[2], text: argv.slice(3).join(' ') })); }
      if (sub === 'fill') { if (!argv[2]) die('browser fill needs a ref + value, e.g. @e1 hello'); return out(await rpc('browser', { sub: 'fill', ref: argv[2], value: argv.slice(3).join(' ') })); }
      if (sub === 'get-text') {
        const r = await rpc('browser', { sub: 'get-text' });
        if (has(argv, '--json')) return out(r);
        return out((r.url ? r.url + '\n' : '') + (r.text || ''));
      }
      if (sub === 'eval') { if (!argv[2]) die('browser eval needs a js expression'); return out(await rpc('browser', { sub: 'eval', js: argv.slice(2).join(' ') })); }
      if (sub === 'scroll') return out(await rpc('browser', { sub: 'scroll', amount: argv[2] || 'down' }));
      if (['back', 'forward', 'reload', 'url'].indexOf(sub) >= 0) return out(await rpc('browser', { sub }));
      die('unknown browser subcommand: ' + sub + ' (open|snapshot|click|type|fill|get-text|eval|scroll|back|forward|reload|url|screenshot)');
    }
    if (cmd === 'markdown' || cmd === 'md') {
      if (!argv[1]) die('markdown needs a file, e.g. winmux markdown README.md');
      const abs = path.resolve(process.cwd(), argv[1]);
      return emit('opened ' + argv[1] + ' in the viewer', await rpc('markdown', { path: abs }));
    }
    if (cmd === 'open') {
      // Workspaces-as-code: a JSON file describes a set of terminals, each with an
      // optional cwd / shell / start command. Open them all from one word. This is
      // pure CLI — it drives the existing new-tab + send verbs, no new server code.
      if (!argv[1]) die('open needs a workspace file, e.g. winmux open work.json');
      let spec;
      try { spec = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), argv[1]), 'utf8')); }
      catch (e) { die('cannot read workspace file: ' + (e.code === 'ENOENT' ? 'no such file' : e.message)); }
      const sessions = Array.isArray(spec) ? spec : (spec && Array.isArray(spec.sessions) ? spec.sessions : null);
      if (!sessions || !sessions.length) die('workspace file needs a "sessions" array (or be an array) of { cwd?, shell?, command? }');
      const opened = [];
      for (const raw of sessions) {
        const s = raw || {};
        const cwd = s.cwd ? path.resolve(process.cwd(), String(s.cwd)) : undefined;
        const r = await rpc('new-tab', { shell: s.shell, cwd });
        const id = r && r.id;
        opened.push(id || null);
        if (s.command && id) await rpc('send', { data: String(s.command), enter: true, target: id });
      }
      return emit('opened ' + opened.filter(Boolean).length + ' terminal(s) from ' + argv[1], { opened });
    }
    if (cmd === 'agent') {
      // Agent lifecycle → cockpit state. `winmux agent <state> [message]`.
      // --sid targets a session (defaults to $WINMUX_SID so a hook needs no args);
      // --id also works; else the active session.
      const state = (argv[1] || '').toLowerCase();

      // Stage 3 — orchestration: a server-side job so one session can spawn another,
      // wait until it finishes, and get its result as data. jobId (not sid) is the
      // unit of work. These verbs are handled by the server, not the app.
      const JOB_VERBS = ['register', 'wait', 'result', 'status', 'list'];
      const resultFile = flag(argv, '--result-file');
      const readResult = () => {
        if (resultFile) { try { return fs.readFileSync(resultFile, 'utf8'); } catch (e) { die('cannot read --result-file ' + resultFile + ': ' + e.message); } }
        return flag(argv, '--result');
      };
      if (state === 'spawn') {
        // Open a fresh tab, launch a task in it, and hand back a job to wait on.
        // The launcher runs the task, captures its output, and reports done/failed
        // to the server itself — so completion + result are data, not screen-scrape.
        // A prompt runs `claude -p` (headless Claude); --cmd runs an arbitrary shell
        // command (scripts, tests, and the harness). PowerShell-family shells.
        const os = require('os');
        const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";   // PowerShell single-quote escape
        const cliPath = path.join(__dirname, 'winmux.cjs');
        const rawCmd = flag(argv, '--cmd');
        const prompt = (argv[2] && !argv[2].startsWith('--')) ? argv[2] : null;
        if (!rawCmd && !prompt) die('spawn needs a prompt or --cmd: winmux agent spawn "fix the failing test"  |  winmux agent spawn --cmd "npm test"');
        const nt = await rpc('new-tab', { shell: flag(argv, '--shell') });
        const sid = nt && nt.id;
        if (sid == null) die('could not open a tab for the spawned session');
        const name = flag(argv, '--name') || (prompt || rawCmd).slice(0, 48);
        const reg = await rpc('job-register', { sid: String(sid), name });
        const jobId = reg.job.jobId;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winmux-job-'));
        const rf = path.join(dir, 'result.txt');
        let taskExpr = rawCmd;
        if (!rawCmd) { const pf = path.join(dir, 'prompt.txt'); fs.writeFileSync(pf, prompt, 'utf8'); taskExpr = 'Get-Content -Raw -LiteralPath ' + psq(pf) + ' | claude -p'; }
        const parts = [];
        if (flag(argv, '--cwd')) parts.push('Set-Location -LiteralPath ' + psq(flag(argv, '--cwd')));
        parts.push('& { ' + taskExpr + ' } *>&1 | Tee-Object -FilePath ' + psq(rf) + ' | Out-Host');
        parts.push('$__x = $LASTEXITCODE');
        parts.push('if ($null -eq $__x -or $__x -eq 0) { & node ' + psq(cliPath) + ' agent done --job ' + jobId + ' --result-file ' + psq(rf) +
          ' } else { & node ' + psq(cliPath) + ' agent failed --job ' + jobId + ' --exit $__x --result-file ' + psq(rf) + ' }');
        await rpc('send', { data: parts.join('; '), enter: true, target: String(sid) });
        return emit('spawned job ' + jobId + ' in session ' + sid + '  —  winmux agent wait --job ' + jobId, { jobId, sid, job: reg.job });
      }
      if (JOB_VERBS.indexOf(state) >= 0 || ((state === 'done' || state === 'failed') && flag(argv, '--job'))) {
        if (state === 'register') {
          const r = await rpc('job-register', { sid: flag(argv, '--sid') || process.env.WINMUX_SID || null, name: flag(argv, '--name') || null });
          return emit(r.job.jobId, r);
        }
        if (state === 'list') {
          const r = await rpc('job-list');
          if (has(argv, '--json')) return out(r);
          if (!r.jobs.length) return out('(no agent jobs)');
          return out(r.jobs.map((j) => j.jobId + '  ' + j.state + (j.name ? '  ' + j.name : '') + (j.sid ? '  sid=' + j.sid : '')).join('\n'));
        }
        const jobId = flag(argv, '--job');
        if (!jobId) die('this needs --job <id> (from `winmux agent register` / `spawn`)');
        if (state === 'wait') {
          const timeoutMs = flag(argv, '--timeout') ? Math.round(Number(flag(argv, '--timeout')) * 1000) : undefined;
          const r = await rpc('job-wait', { jobId, timeoutMs });
          const st = r.job && r.job.state;
          // Exit codes so a caller (or agent) can branch: 0 done, 2 failed, 3 still working / timed out.
          process.exitCode = st === 'done' ? 0 : st === 'failed' ? 2 : 3;
          if (has(argv, '--json')) return out(r);
          return out(st === 'done' ? (r.job.result != null ? r.job.result : '(done, no result)')
            : st === 'failed' ? '(failed' + (r.job.exitCode != null ? ' exit ' + r.job.exitCode : '') + ')' + (r.job.result ? '\n' + r.job.result : '')
            : '(still working — wait again)');
        }
        if (state === 'result' || state === 'status') {
          const r = await rpc('job-status', { jobId });
          if (has(argv, '--json')) return out(r);
          if (state === 'result') return out(r.job.result != null ? r.job.result : '(' + r.job.state + ', no result yet)');
          return out(r.job.jobId + '  ' + r.job.state + (r.job.exitCode != null ? '  exit ' + r.job.exitCode : ''));
        }
        // done | failed --job J [--result R | --result-file F] [--exit N]
        const r = await rpc('job-report', { jobId, state, result: readResult(), exitCode: flag(argv, '--exit') != null ? Number(flag(argv, '--exit')) : undefined });
        return emit('job ' + jobId + ' → ' + r.job.state, r);
      }

      if (['working', 'needs-you', 'needsyou', 'blocked', 'done', 'idle'].indexOf(state) < 0)
        die('agent needs a state: working | needs-you | done | idle — or a job verb: register | wait | result | list');
      const words = [];
      for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--sid' || argv[i] === '--id') { i++; continue; }
        if (argv[i] === '--json') continue;
        words.push(argv[i]);
      }
      const sid = flag(argv, '--sid') || process.env.WINMUX_SID || '';
      // Hook safety: with no session to target (fired outside a WinMux terminal,
      // where $WINMUX_SID is unset), no-op quietly instead of poking the active app.
      if (!sid && !flag(argv, '--id')) { if (has(argv, '--json')) out({ ok: true, skipped: 'not inside a WinMux session' }); return; }
      const r = await rpc('agent', { state, message: words.join(' '), sid, target: flag(argv, '--id') });
      return emit('session ' + (r && r.id != null ? r.id : '') + ' → ' + (r && r.state), r);
    }
    die('unknown command: ' + cmd + '. Run `winmux help`.');
  } catch (e) { die(e.message); }
})();

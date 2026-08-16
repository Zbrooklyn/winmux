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

// process.kill(pid, 0) throws ESRCH if the pid is gone, EPERM if it exists but
// is owned by someone else (still "alive" for our purposes).
function pidAlive(pid) {
  if (!pid) return true; // older files may omit pid — don't reject them
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

function instance() {
  // An explicit target wins — for scripting a specific instance (and the harness).
  if (process.env.WINMUX_PORT) return { port: Number(process.env.WINMUX_PORT), host: process.env.WINMUX_HOST || '127.0.0.1' };
  // Which copy to drive: an explicit file wins; then --dev / WINMUX_PROFILE=dev;
  // otherwise whichever packaged identity is actually LIVE — the primary app
  // (instance.json) first, then the side-by-side WinMux Rust app
  // (instance.rust.json). A file whose pid is dead is a stale leftover, not a
  // target, so a crashed primary never shadows a running Rust app.
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
  die('WinMux is not running (checked ' + candidates.join(', ') + '). Start it with `npm start` or the desktop app.');
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
    if (cmd === 'slash') {
      // Drive a running Claude Code session with a slash command — e.g.
      //   winmux slash "/model haiku" --id 3     (switch that session's model mid-flight)
      //   winmux slash "/compact" --id 3         (shrink its context)
      // The TUI needs the text and Enter as SEPARATE keystrokes (one send does not
      // submit), and the command only lands cleanly when the session is idle at its
      // input prompt — so wait for idle unless --force queues it anyway.
      const text = argv[1];
      if (!text || !text.startsWith('/')) die('slash needs a /command: winmux slash "/model haiku" --id 3');
      const target = flag(argv, '--id');
      const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
      if (!has(argv, '--force')) {
        let idle = false;
        for (let i = 0; i < 45; i++) {
          const sc = await rpc('read-screen', { target, lines: 25 }).catch(() => null);
          const s = (sc && sc.screen) || '';
          if (/❯/.test(s) && !/esc to interrupt/i.test(s)) { idle = true; break; }
          await sleepMs(2000);
        }
        if (!idle) die('session is still working — retry when idle, or add --force to queue it');
      }
      await rpc('send', { data: text, enter: false, target });
      await sleepMs(1200);
      await rpc('send', { data: '', enter: true, target });
      return emit('sent ' + text, { ok: true, sent: text });
    }
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
    if (cmd === 'transcript') {
      // Per-turn history of a Claude Code session, read straight from its .jsonl
      // (Phase 11's "richer transcript reader"). Pure local file read — works with
      // no app or server attached, so an orchestrator can inspect what a worker
      // actually did, turn by turn.
      //   winmux transcript                          newest session for this cwd
      //   winmux transcript --cwd <dir>              newest session for that cwd
      //   winmux transcript --session <uuid>         that session, wherever it lives
      //   winmux transcript --file <path.jsonl>      an exact transcript file
      //   --turns N (default 20, 0 = all)  --full (untruncated text)  --json
      const os = require('os');
      const projRoot = path.join(os.homedir(), '.claude', 'projects');
      // Claude Code encodes a project cwd by dashing every non-alphanumeric char
      // (spaces and dots included — "Claude Folder" -> "Claude-Folder").
      const encDir = (d) => path.join(projRoot, String(d).replace(/[^A-Za-z0-9-]/g, '-'));
      let file = flag(argv, '--file');
      if (!file && flag(argv, '--session')) {
        const uuid = String(flag(argv, '--session')).replace(/[^a-zA-Z0-9-]/g, '');
        try {
          for (const d of fs.readdirSync(projRoot)) {
            const p = path.join(projRoot, d, uuid + '.jsonl');
            if (fs.existsSync(p)) { file = p; break; }
          }
        } catch (e) {}
        if (!file) die('no transcript found for session ' + uuid);
      }
      if (!file) {
        const dir = encDir(flag(argv, '--cwd') || process.cwd());
        try {
          const newest = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
            .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.m - a.m)[0];
          if (newest) file = path.join(dir, newest.f);
        } catch (e) {}
        if (!file) die('no Claude transcripts for ' + (flag(argv, '--cwd') || process.cwd()) + ' (looked in ' + dir + ')');
      }
      let lines;
      try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); }
      catch (e) { die('cannot read ' + file + ': ' + e.message); }
      // Fold the raw entries into logical turns: consecutive same-role entries are
      // one turn, and user entries that only carry tool_result blocks belong to the
      // assistant's work, not to the human.
      const turns = [];
      for (const line of lines) {
        let j; try { j = JSON.parse(line); } catch (e) { continue; }
        if (j.type !== 'user' && j.type !== 'assistant') continue;
        const raw = j.message && j.message.content;
        const blocks = Array.isArray(raw) ? raw : (raw != null ? [{ type: 'text', text: String(raw) }] : []);
        const texts = blocks.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text);
        const tools = blocks.filter((b) => b && b.type === 'tool_use' && b.name).map((b) => b.name);
        const onlyResults = blocks.length > 0 && blocks.every((b) => b && b.type === 'tool_result');
        const role = (j.type === 'user' && onlyResults) ? 'assistant' : j.type;
        if (!texts.length && !tools.length && role === 'user') continue;   // pure tool_result / attachment noise
        const last = turns[turns.length - 1];
        if (last && last.role === role) {
          last.text += (last.text && texts.length ? '\n' : '') + texts.join('\n');
          last.tools.push(...tools);
          last.end = j.timestamp || last.end;
        } else if (texts.length || tools.length) {
          turns.push({ n: turns.length + 1, role, start: j.timestamp || null, end: j.timestamp || null, text: texts.join('\n'), tools });
        }
      }
      const want = flag(argv, '--turns') != null ? Number(flag(argv, '--turns')) : 20;
      const shown = want > 0 ? turns.slice(-want) : turns;
      if (has(argv, '--json')) return out({ file, turns: shown.map((t) => ({ n: t.n, role: t.role, start: t.start, end: t.end, tools: t.tools, text: has(argv, '--full') ? t.text : t.text.slice(0, 2000) })), totalTurns: turns.length });
      if (!shown.length) return out('(no conversational turns in ' + file + ')');
      const cap = has(argv, '--full') ? Infinity : 300;
      return out(shown.map((t) => {
        const when = t.start ? new Date(t.start).toLocaleTimeString() : '';
        const tl = t.tools.length ? '  [tools: ' + t.tools.join(', ') + ']' : '';
        const txt = t.text.length > cap ? t.text.slice(0, cap) + '…' : t.text;
        return t.n + '. ' + t.role.toUpperCase() + (when ? ' ' + when : '') + tl + (txt ? '\n   ' + txt.replace(/\n/g, '\n   ') : '');
      }).join('\n') + '\n(' + shown.length + ' of ' + turns.length + ' turns — ' + path.basename(file) + ')');
    }
    if (cmd === 'agent') {
      // Agent lifecycle → cockpit state. `winmux agent <state> [message]`.
      // --sid targets a session (defaults to $WINMUX_SID so a hook needs no args);
      // --id also works; else the active session.
      const state = (argv[1] || '').toLowerCase();

      // Stop-hook completion for spawned workers: the launcher exports WINMUX_JOB,
      // so when the worker's first turn ends this reports the job done with the
      // final assistant message (from the hook's transcript) as the result — no
      // prompt-obedience contract for the worker model to misread. Always clears
      // the cockpit lane; a plain shell (no WINMUX_JOB) is lane-only.
      if (state === 'auto-done') {
        let payload = '';
        try { if (!process.stdin.isTTY) payload = fs.readFileSync(0, 'utf8'); } catch (e) {}
        let tp = null;
        try { tp = JSON.parse(payload).transcript_path; } catch (e) {}
        // Windows hook stdin is flaky — fall back to the newest transcript in this
        // cwd's Claude project dir (hooks run with the session's cwd).
        if (!tp || !fs.existsSync(tp)) {
          try {
            const os2 = require('os');
            const proj = path.join(os2.homedir(), '.claude', 'projects', process.cwd().replace(/[^A-Za-z0-9-]/g, '-'));
            const newest = fs.readdirSync(proj).filter((f) => f.endsWith('.jsonl'))
              .map((f) => ({ f, m: fs.statSync(path.join(proj, f)).mtimeMs }))
              .sort((a, b) => b.m - a.m)[0];
            if (newest) tp = path.join(proj, newest.f);
          } catch (e) {}
        }
        const jobId = process.env.WINMUX_JOB;
        if (jobId) {
          // The Stop hook can fire before the final assistant line is flushed to
          // the transcript file — retry briefly before reporting.
          const extract = (file) => {
            try {
              const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
              for (let i = lines.length - 1; i >= 0; i--) {
                try {
                  const j = JSON.parse(lines[i]);
                  if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
                    const t = j.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
                    if (t) return t;
                  }
                } catch (e2) {}
              }
            } catch (e) {}
            return null;
          };
          let result = null;
          for (let tries = 0; tries < 12 && result == null; tries++) {
            if (tries) await new Promise((r) => setTimeout(r, 500));
            if (tp && fs.existsSync(tp)) result = extract(tp);
            if (result == null) {
              try {
                const os2 = require('os');
                const proj = path.join(os2.homedir(), '.claude', 'projects', process.cwd().replace(/[^A-Za-z0-9-]/g, '-'));
                const newest = fs.readdirSync(proj).filter((f) => f.endsWith('.jsonl'))
                  .map((f) => ({ f, m: fs.statSync(path.join(proj, f)).mtimeMs }))
                  .sort((a, b) => b.m - a.m)[0];
                if (newest) result = extract(path.join(proj, newest.f));
              } catch (e) {}
            }
          }
          await rpc('job-report', { jobId, state: 'done', result }).catch(() => {});
        }
        const sidAd = process.env.WINMUX_SID || '';
        if (sidAd) await rpc('agent', { state: 'done', sid: sidAd }).catch(() => {});
        return;
      }

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
        // Open a fresh tab (or split pane), launch a task in it, and hand back a job
        // to wait on. The whole launch sequence lives in a temp job.ps1, so the
        // terminal shows ONE short line — never the task text. The launcher runs the
        // task and reports done/failed + the result to the server itself, so
        // completion + result are data, not screen-scrape.
        //   --cmd "<shell cmd>"      run an arbitrary command (scripts, tests, CI)
        //   "<prompt>"               run headless Claude (`claude -p`)
        //   "<prompt>" --tui         run interactive Claude Code, streaming in the pane
        //   --split right|down       open in a split pane of the current tab
        //   --model <m>              worker model (default sonnet; 'inherit' = account default)
        // PowerShell-family shells.
        const os = require('os');
        const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";   // PowerShell single-quote escape
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const cliPath = path.join(__dirname, 'winmux.cjs');
        const rawCmd = flag(argv, '--cmd');
        const prompt = (argv[2] && !argv[2].startsWith('--')) ? argv[2] : null;
        const tui = has(argv, '--tui');
        const splitDir = flag(argv, '--split');
        // Workers default to Sonnet — spawning fleets on the account-default (top-tier)
        // model burns the budget. --model sonnet|haiku|opus|<full-id> overrides;
        // --model inherit uses the account default.
        const model = (flag(argv, '--model') || 'sonnet').toLowerCase();
        const modelArg = model === 'inherit' ? '' : '--model ' + model + ' ';
        if (!rawCmd && !prompt) die('spawn needs a prompt or --cmd: winmux agent spawn "fix the failing test"  |  winmux agent spawn --cmd "npm test"');
        if (tui && !prompt) die('--tui runs interactive Claude Code and needs a prompt, not --cmd');
        let sid = null;
        if (splitDir) {
          // `split` returns no id — detect the new terminal by diffing the session list.
          const before = new Set((((await rpc('list')) || {}).sessions || []).map((s) => s.id));
          await rpc('split', { dir: splitDir === 'down' ? 'down' : 'right', shell: flag(argv, '--shell') });
          for (let i = 0; i < 20 && sid == null; i++) {
            await sleep(500);
            const now = (((await rpc('list')) || {}).sessions || []).map((s) => s.id);
            const fresh = now.filter((x) => !before.has(x));
            if (fresh.length) sid = fresh[fresh.length - 1];
          }
          if (sid == null) die('split produced no new terminal');
        } else {
          const nt = await rpc('new-tab', { shell: flag(argv, '--shell') });
          sid = nt && nt.id;
          if (sid == null) die('could not open a tab for the spawned session');
        }
        const name = flag(argv, '--name') || (prompt || rawCmd).slice(0, 48);
        // Register the job by the ENGINE's registry sid (32-hex), not the UI tab id —
        // that's the id the server supervises by (dead shell → job auto-fails). The
        // tab's sid arrives with the shell's meta, so poll briefly for it.
        let esid = null;
        for (let i = 0; i < 20 && !esid; i++) {
          const row = ((((await rpc('list')) || {}).sessions) || []).find((s) => String(s.id) === String(sid));
          if (row && row.sid) esid = row.sid; else await sleep(500);
        }
        const reg = await rpc('job-register', { sid: esid || String(sid), name });
        const jobId = reg.job.jobId;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winmux-job-'));
        const rf = path.join(dir, 'result.txt');
        const lines = [];
        if (flag(argv, '--cwd')) lines.push('Set-Location -LiteralPath ' + psq(flag(argv, '--cwd')));
        if (tui) {
          // Interactive Claude Code streaming in the pane. Completion is PLUMBING,
          // not prompt-obedience: the launcher exports WINMUX_JOB and the worker
          // hooks' Stop hook (`agent auto-done`) reports the job done with the final
          // assistant message as the result — any model is safe, the task stays pure.
          // Fallback (hooks file missing): an imperative same-turn contract in the
          // prompt; weaker models read "when you are done" as future protocol.
          const hooks = path.join(__dirname, '..', 'config', 'claude-hooks-worker.json');
          const hooksExist = fs.existsSync(hooks);
          const pf = path.join(dir, 'prompt.txt');
          fs.writeFileSync(pf, hooksExist ? prompt : prompt +
            ' The above is your ENTIRE assignment. Do it now, then in this same turn, without asking anything: 1) write your full final answer to the file ' + rf.replace(/\\/g, '/') +
            ' using the Write tool, 2) run this exact Bash command: node "' + cliPath.replace(/\\/g, '/') + '" agent done --job ' + jobId + ' --result-file "' + rf.replace(/\\/g, '/') + '". You are not finished until step 2 has run.', 'utf8');
          lines.push('[Console]::OutputEncoding=[System.Text.Encoding]::UTF8');
          if (hooksExist) lines.push('$env:WINMUX_JOB = ' + psq(jobId));
          lines.push('$__p = Get-Content -Raw -LiteralPath ' + psq(pf));
          lines.push((hooksExist ? 'claude --settings ' + psq(hooks) + ' ' : 'claude ') + modelArg + '--dangerously-skip-permissions $__p');
          // P6 supervision failsafe: if claude exits without the Stop hook (or the
          // fallback contract) having reported, fail the job with the exit code so
          // a waiting orchestrator is never left hanging. Harmless after a normal
          // finish — the server ignores reports on already-terminal jobs.
          lines.push('$__x = if ($null -eq $LASTEXITCODE) { -1 } else { $LASTEXITCODE }');
          lines.push('& node ' + psq(cliPath) + ' agent failed --job ' + jobId + ' --exit $__x --result "claude exited (code $__x) without reporting a result"');
        } else {
          let taskExpr = rawCmd;
          if (!rawCmd) { const pf = path.join(dir, 'prompt.txt'); fs.writeFileSync(pf, prompt, 'utf8'); taskExpr = 'Get-Content -Raw -LiteralPath ' + psq(pf) + ' | claude -p ' + modelArg.trim(); }
          lines.push('& { ' + taskExpr + ' } *>&1 | Tee-Object -FilePath ' + psq(rf) + ' | Out-Host');
          lines.push('$__x = $LASTEXITCODE');
          lines.push('if ($null -eq $__x -or $__x -eq 0) { & node ' + psq(cliPath) + ' agent done --job ' + jobId + ' --result-file ' + psq(rf) +
            ' } else { & node ' + psq(cliPath) + ' agent failed --job ' + jobId + ' --exit $__x --result-file ' + psq(rf) + ' }');
        }
        const launcher = path.join(dir, 'job.ps1');
        fs.writeFileSync(launcher, lines.join('\r\n') + '\r\n', 'utf8');
        // A fresh shell (split panes especially) spawns cold: wait for its prompt
        // before typing, so the launch line lands in a ready shell.
        for (let i = 0; i < 40; i++) {
          const sc = await rpc('read-screen', { target: String(sid), lines: 20 }).catch(() => null);
          if (sc && /PS [A-Z]:.*>/.test(sc.screen || '')) break;
          await sleep(750);
        }
        await rpc('send', { data: '& ' + psq(launcher), enter: true, target: String(sid) });
        if (tui) {
          // A worker in an untrusted folder stalls forever on Claude Code's one-time
          // workspace-trust dialog. The caller explicitly asked for an autonomous
          // worker here (it already runs --dangerously-skip-permissions), so answer
          // the dialog; stop watching once the TUI is up.
          for (let i = 0; i < 25; i++) {
            await sleep(2000);
            const sc = await rpc('read-screen', { target: String(sid), lines: 30 }).catch(() => null);
            const s = (sc && sc.screen) || '';
            if (/trust this folder/i.test(s)) { await rpc('send', { data: '', enter: true, target: String(sid) }); break; }
            if (/shift\+tab|bypass permissions|for shortcuts/i.test(s)) break;
          }
        }
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

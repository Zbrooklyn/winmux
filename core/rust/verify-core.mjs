// WinMux v2 Rust-core shell-I/O harness.
//
// Talks the frontend's /pty protocol DIRECTLY over a WebSocket (no browser) and
// asserts the Rust core's terminal behaviour: it serves the frontend, spawns a
// real shell, echoes input, honours resize, streams colour, and drives a second
// shell type. This is the Stage-1 finish line from the v2 plan — the shell-I/O
// subset, provable without the rest of the harness surface.
//
//   node core/rust/verify-core.mjs        (needs the core running on WINMUX_PORT|9920)
import WebSocket from '../../apps/electron/node_modules/ws/index.js';
import http from 'node:http';

const PORT = parseInt(process.env.WINMUX_PORT || '9920', 10);
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  (cond ? pass++ : fail++);
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + JSON.stringify(detail).slice(0, 120) : ''}`);
};

const get = (path) => new Promise((res) => {
  http.get(BASE + path, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res({ status: r.statusCode, body: b })); })
    .on('error', () => res({ status: 0, body: '' }));
});

// Open a /pty, return { meta, out() } where out() is the accumulated decoded output.
function openPty(query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/pty${query}`);
    let meta = null, buf = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error('timeout')), 8000);
    ws.on('message', (data, isBinary) => {
      if (!isBinary) { try { const m = JSON.parse(data.toString()); if (m.type === 'meta' && !meta) { meta = m; clearTimeout(timer); resolve({ ws, meta, text: () => buf.toString('utf8') }); } } catch (e) {} }
      else { buf = Buffer.concat([buf, data]); }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
const send = (ws, obj) => ws.send(JSON.stringify(obj));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`=== winmux-core shell-I/O harness (:${PORT}) ===`);

  // 1. serves the frontend
  const idx = await get('/');
  ok('serves the cockpit frontend', idx.status === 200 && /winmux|cockpit|xterm/i.test(idx.body), { status: idx.status });
  const js = await get('/app.js');
  ok('serves static assets', js.status === 200, { status: js.status });

  // 2. PowerShell: meta + echo
  const ps = await openPty('?shell=powershell');
  ok('powershell announces a meta frame (sid+shell)', !!(ps.meta && ps.meta.sid && ps.meta.shell), ps.meta && { sid: !!ps.meta.sid, shell: ps.meta.shell });
  send(ps.ws, { t: 'i', d: '"RUSTCHECK_" + (7*8)\r' });
  await wait(1500);
  ok('input echoes and the shell evaluates it', /RUSTCHECK_56/.test(ps.text()));

  // 3. resize propagates to the shell's console
  send(ps.ws, { t: 'r', c: 132, r: 40 });
  await wait(300);
  send(ps.ws, { t: 'i', d: '"COLS=" + [Console]::WindowWidth\r' });
  await wait(1500);
  const cols = (ps.text().match(/COLS=(\d+)/) || [])[1];
  ok('resize changes the shell console width', cols && Math.abs(parseInt(cols, 10) - 132) <= 2, { reported: cols });

  // 4. colour: a program that emits ANSI shows up as escape bytes in the stream
  send(ps.ws, { t: 'i', d: 'Write-Host -ForegroundColor Red "REDLINE"; $e=[char]27; "$e[32mGREENSEQ$e[0m"\r' });
  await wait(1500);
  const hasAnsi = /\x1b\[[0-9;]*m/.test(ps.text()) && /GREENSEQ/.test(ps.text());
  ok('colour output streams ANSI to the client', hasAnsi);
  ps.ws.close();

  // 5. a second shell type (cmd) also spawns and runs
  try {
    const cmd = await openPty('?shell=cmd');
    ok('cmd.exe spawns via the same /pty path', !!(cmd.meta && cmd.meta.shell), cmd.meta && { shell: cmd.meta.shell });
    send(cmd.ws, { t: 'i', d: 'echo RUSTCMD_%RANDOM%\r\n' });
    await wait(1500);
    ok('cmd runs a command', /RUSTCMD_\d+/.test(cmd.text()));
    cmd.ws.close();
  } catch (e) { ok('cmd.exe spawns via the same /pty path', false, { err: String(e.message) }); }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('ERR', e.message); process.exit(2); });

// Does a closed tab leave its threads behind?
//
// The Rust engine runs two threads per shell — a reader and a scrollback
// flusher — and both used to wait on an end-of-shell signal that never
// arrived on Windows. The audit that found it claimed every closed tab
// leaked those two threads permanently. This measures whether that is
// still true, rather than arguing about it.
//
//   node scripts/probe-threads.cjs [rounds] [shells-per-round]
//
// TWO THINGS MAKE THIS MEASUREMENT EASY TO GET WRONG, and both produced a
// confident false positive before they were understood:
//
//  1. SAMPLE TOO EARLY AND EVERY RUN LOOKS LIKE A LEAK. Tokio keeps idle
//     blocking-pool workers around for ~10s before retiring them. Sampling
//     9s after the shells exit counts resting workers as leaked threads —
//     that read "0.50 threads stuck per closed tab" on an engine that was
//     leaking nothing. Hence SETTLE below, comfortably past the keepalive.
//
//  2. ONE ROUND CANNOT TELL A LEAK FROM AN ALLOCATION. A leak grows with
//     use; a pool that gets built once and kept does not. So run several
//     rounds against the SAME engine and watch whether the residual
//     accumulates. Restarting between rounds would destroy the evidence.
const { spawn, execSync } = require('child_process');
const path = require('path');
const net = require('net');
const fs = require('fs');
const os = require('os');

const HERE = path.join(__dirname, '..');
const RUST = path.join(HERE, '..', '..', 'core', 'rust', 'target', 'release', 'winmux-core.exe');
const PORT = Number(process.env.WINMUX_PROBE_PORT || 9881);
const ROUNDS = Number(process.argv[2] || 3);
const N = Number(process.argv[3] || 6);
const SETTLE = 25000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const up = (port) => new Promise((res) => {
  const t = setInterval(() => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.destroy(); clearInterval(t); res(); });
    s.on('error', () => s.destroy());
  }, 200);
});

function threads(pid) {
  const out = execSync('powershell -NoProfile -Command "(Get-Process -Id ' + pid + ').Threads.Count"',
    { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();
  return Number(out);
}

(async () => {
  if (!fs.existsSync(RUST)) {
    console.log('no Rust core at ' + RUST + ' — build it first (cargo build --release)');
    process.exit(1);
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'winmux-threads-'));

  const proc = spawn(RUST, [], {
    cwd: HERE, stdio: 'ignore',
    env: Object.assign({}, process.env, {
      WINMUX_PORT: String(PORT), WINMUX_PUBLIC: path.join(HERE, 'public'),
      WINMUX_INSTANCE_FILE: path.join(scratch, 'inst.json'),
      WINMUX_TRUST_FILE: path.join(scratch, 'trust.json'),
      WINMUX_CONFIG_FILE: path.join(scratch, 'cfg.json'),
    }),
  });
  await up(PORT);
  await sleep(1500);

  const WebSocket = require(path.join(HERE, 'node_modules', 'ws'));
  const info = () => fetch('http://127.0.0.1:' + PORT + '/api/info', { cache: 'no-store' })
    .then((r) => r.json()).then((j) => j.sessions);

  const base = threads(proc.pid);
  console.log('idle engine: ' + base + ' threads, ' + (await info()) + ' shells');
  console.log('');

  const residuals = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const socks = [];
    for (let i = 0; i < N; i++) {
      const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/pty?shell=pwsh');
      await new Promise((r) => ws.on('open', r));
      ws.send(JSON.stringify({ t: 'r', c: 100, r: 30 }));
      socks.push(ws);
    }
    await sleep(4000);
    const peak = threads(proc.pid);
    const openShells = await info();

    for (const ws of socks) ws.send(JSON.stringify({ t: 'i', d: 'exit\r' }));
    await sleep(SETTLE);
    const settled = threads(proc.pid);
    const shells = await info();
    for (const ws of socks) { try { ws.close(); } catch (e) {} }

    residuals.push(settled - base);
    console.log('round ' + round + ': ' + N + ' opened -> ' + peak + ' threads (' + openShells + ' shells)'
      + ', all closed -> ' + settled + ' threads (' + shells + ' shells)'
      + '   residual vs idle: ' + (settled - base >= 0 ? '+' : '') + (settled - base));
  }

  console.log('');
  console.log('residual after each round: ' + residuals.map((r) => (r >= 0 ? '+' : '') + r).join(', ')
    + '   (' + (ROUNDS * N) + ' tabs total)');

  const last = residuals[residuals.length - 1];
  const growth = last - residuals[0];
  if (ROUNDS > 1 && growth >= ROUNDS - 1 && last > residuals[0]) {
    console.log('LEAKING — residual grows with use (+' + growth + ' across ' + (ROUNDS - 1)
      + ' extra rounds, ' + (last / (ROUNDS * N)).toFixed(2) + ' per tab)');
    process.exitCode = 1;
  } else {
    console.log('NOT A PER-TAB LEAK — residual does not grow with use (change of '
      + (growth >= 0 ? '+' : '') + growth + ' from round 1 to round ' + ROUNDS
      + '; the leak the audit described would be +' + (N * (ROUNDS - 1)) + ')');
  }

  try { proc.kill(); } catch (e) {}
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) {}
  process.exit(process.exitCode || 0);
})().catch((e) => { console.log('THREW ' + e.message); process.exit(1); });

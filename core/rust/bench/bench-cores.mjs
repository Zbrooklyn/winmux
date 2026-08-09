// Head-to-head: WinMux Node engine vs Rust core. Same measurements, same shell.
// Isolates the ONLY variable that differs between the two installed builds — the
// backend engine — since the Electron shell + frontend are identical.
import { spawn, spawnSync, execSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const APP = 'C:/Users/EDWAR/Dropbox/AI_Projects_Claude/projects/winmux/apps/electron';
const require = createRequire(APP + '/');
const WebSocket = require('ws');

const TMP = process.env.TEMP || os.tmpdir();
const tmp = (n) => path.join(TMP, 'winmux-bench-' + n);
const RUST_BIN = 'C:/Users/EDWAR/Dropbox/AI_Projects_Claude/projects/winmux/core/rust/target/release/winmux-core.exe';
const PUBLIC = APP + '/public';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function baseEnv(port) {
  return {
    ...process.env,
    PORT: String(port),                       // node: force this port (skips scan)
    WINMUX_PORT: String(port),                // rust: bind this port
    WINMUX_PUBLIC: PUBLIC,
    WINMUX_INSTANCE_FILE: tmp('inst-' + port + '.json'),
    WINMUX_TRUST_FILE: tmp('trust-' + port + '.json'),
    WINMUX_CONFIG_FILE: tmp('cfg-' + port + '.json'),
  };
}
function spawnEngine(kind, port) {
  if (kind === 'node') return spawn(process.execPath, [APP + '/server.cjs'], { env: baseEnv(port), stdio: 'ignore' });
  return spawn(RUST_BIN, [], { env: baseEnv(port), stdio: 'ignore' });
}
function kill(pid) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
function rssKB(pid) {
  try {
    const out = execSync(`powershell -NoProfile -Command "(Get-Process -Id ${pid}).WorkingSet64"`, { encoding: 'utf8' });
    return Math.round(parseInt(out.trim(), 10) / 1024);
  } catch { return null; }
}
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 500 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
async function bootOnce(kind, port) {
  const t0 = performance.now();
  const p = spawnEngine(kind, port);
  let served = false;
  for (let i = 0; i < 400; i++) { if (await probe(port)) { served = true; break; } await sleep(10); }
  const bootMs = performance.now() - t0;
  await sleep(200);
  const rss = rssKB(p.pid);
  return { bootMs, rss, pid: p.pid, proc: p, served };
}

// One live engine: measure input RTT and bulk throughput over the real /pty WS.
function wsTests(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/pty?shell=powershell`);
    ws.binaryType = 'arraybuffer';
    let ready = false, acc = '', bytes = 0;
    const rtts = []; let rttStart = 0, awaitingRtt = false;
    let thrStart = 0, thrDone = null, phase = 'warmup';
    ws.on('open', () => { ws.send(JSON.stringify({ t: 'r', c: 120, r: 40 })); });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) { try { const m = JSON.parse(data.toString()); if (m.type === 'meta' && m.sid && !ready) { ready = true; setTimeout(startRtt, 400); } } catch {} return; }
      bytes += data.length; acc += Buffer.from(data).toString('latin1');
      if (awaitingRtt) { rtts.push(performance.now() - rttStart); awaitingRtt = false; }
      // Detect completion by BYTES received (not a sentinel string — the shell
      // echoes the typed command, so a marker would match the echo instantly).
      if (phase === 'throughput' && bytes >= 1900000 && thrDone === null) { thrDone = performance.now(); finish(); }
    });
    let rttN = 0;
    function startRtt() {
      phase = 'rtt';
      const tick = () => {
        if (rttN >= 15) { setTimeout(startThroughput, 200); return; }
        rttN++; acc = ''; awaitingRtt = true; rttStart = performance.now();
        ws.send(JSON.stringify({ t: 'i', d: '\r' }));
        setTimeout(tick, 120);
      };
      tick();
    }
    function startThroughput() {
      phase = 'throughput'; acc = ''; bytes = 0; thrStart = performance.now();
      // One big write from the shell → the engine's job is to relay it fast.
      ws.send(JSON.stringify({ t: 'i', d: "[Console]::Out.Write('x'*2000000); [Console]::Out.Write(\"`nBENCH_DONE_zz`n\")\r" }));
      setTimeout(() => { if (thrDone === null) finish(); }, 15000);
    }
    function finish() {
      const secs = ((thrDone || performance.now()) - thrStart) / 1000;
      try { ws.close(); } catch {}
      resolve({ rttMs: rtts.length ? median(rtts) : null, thrMBps: bytes / 1e6 / secs, thrBytes: bytes, thrSecs: secs });
    }
    ws.on('error', () => resolve({ error: true }));
  });
}

async function benchEngine(kind, basePort) {
  const boots = [];
  for (let i = 0; i < 5; i++) {
    const b = await bootOnce(kind, basePort + i);
    boots.push(b); kill(b.pid); await sleep(300);
  }
  // fresh engine for WS tests
  const live = await bootOnce(kind, basePort + 50);
  const ws = await wsTests(basePort + 50);
  kill(live.pid);
  return {
    kind,
    served: boots.every(b => b.served),
    bootMs: Math.round(median(boots.map(b => b.bootMs))),
    bootAll: boots.map(b => Math.round(b.bootMs)),
    rssKB: median(boots.map(b => b.rss).filter(Boolean)),
    ...ws,
  };
}

(async () => {
  const node = await benchEngine('node', 9700);
  const rust = await benchEngine('rust', 9760);
  const r = { node, rust };
  console.log(JSON.stringify(r, null, 2));
  fs.writeFileSync(tmp('result.json'), JSON.stringify(r, null, 2));
})();

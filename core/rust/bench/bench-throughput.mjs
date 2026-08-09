// Throughput-only probe: dump a real 4MB file through the /pty WS, count bytes
// until the whole file has arrived, report MB/s. Same shell, both engines.
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const APP = 'C:/Users/EDWAR/Dropbox/AI_Projects_Claude/projects/winmux/apps/electron';
const require = createRequire(APP + '/');
const WebSocket = require('ws');
const TMP = process.env.TEMP || os.tmpdir();
const RUST_BIN = 'C:/Users/EDWAR/Dropbox/AI_Projects_Claude/projects/winmux/core/rust/target/release/winmux-core.exe';
const PUBLIC = APP + '/public';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 4MB file of printable text (unique-ish lines so no terminal optimization skips it)
const BIG = path.join(TMP, 'winmux-bench-big.txt');
if (!fs.existsSync(BIG) || fs.statSync(BIG).size < 4_000_000) {
  const line = 'the quick brown fox jumps over the lazy dog 0123456789 '.repeat(2) + '\n';
  let buf = ''; while (buf.length < 4_000_000) buf += line;
  fs.writeFileSync(BIG, buf);
}
const FILESZ = fs.statSync(BIG).size;

function env(port) { return { ...process.env, PORT: String(port), WINMUX_PORT: String(port), WINMUX_PUBLIC: PUBLIC,
  WINMUX_INSTANCE_FILE: path.join(TMP, 'wbt-i' + port + '.json'), WINMUX_TRUST_FILE: path.join(TMP, 'wbt-t' + port + '.json'),
  WINMUX_CONFIG_FILE: path.join(TMP, 'wbt-c' + port + '.json') }; }
function spawnEngine(kind, port) { return kind === 'node' ? spawn(process.execPath, [APP + '/server.cjs'], { env: env(port), stdio: 'ignore' })
  : spawn(RUST_BIN, [], { env: env(port), stdio: 'ignore' }); }
function kill(pid) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
function probe(port) { return new Promise((res) => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 500 }, (x) => { x.resume(); res(x.statusCode === 200); }); r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); }); }); }

function throughput(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/pty?shell=powershell`);
    ws.binaryType = 'arraybuffer';
    let ready = false, phase = 'warm', bytes = 0, t0 = 0;
    const bigFwd = BIG.replace(/\\/g, '/');
    ws.on('open', () => ws.send(JSON.stringify({ t: 'r', c: 200, r: 50 })));
    ws.on('message', (data, isBinary) => {
      if (!isBinary) { try { const m = JSON.parse(data.toString()); if (m.type === 'meta' && m.sid && !ready) { ready = true; setTimeout(start, 600); } } catch {} return; }
      if (phase !== 'go') return;
      bytes += data.byteLength;   // arraybuffer frames expose byteLength, not length
      if (bytes >= FILESZ * 0.95) done();
    });
    function start() {
      phase = 'go'; bytes = 0; t0 = performance.now();
      ws.send(JSON.stringify({ t: 'i', d: `Get-Content -Raw -LiteralPath '${bigFwd}'\r` }));
      setTimeout(() => { if (phase === 'go') done(); }, 20000);
    }
    let finished = false;
    function done() {
      if (finished) return; finished = true;
      const secs = (performance.now() - t0) / 1000;
      try { ws.close(); } catch {}
      resolve({ mbps: +(bytes / 1e6 / secs).toFixed(1), bytes, secs: +secs.toFixed(2), fileMB: +(FILESZ / 1e6).toFixed(1) });
    }
    ws.on('error', () => resolve({ error: true }));
  });
}
async function run(kind, port) {
  const p = spawnEngine(kind, port);
  for (let i = 0; i < 400; i++) { if (await probe(port)) break; await sleep(10); }
  await sleep(300);
  const r = await throughput(port);
  kill(p.pid);
  return { kind, ...r };
}
(async () => {
  const node = await run('node', 9810);
  const rust = await run('rust', 9820);
  console.log(JSON.stringify({ node, rust }, null, 2));
})();

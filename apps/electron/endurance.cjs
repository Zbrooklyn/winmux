// WinMux endurance harness — Rust core vs Node server, on the SAME machine.
//
//   node endurance.cjs            measure both engines, print a JSON block
//   node endurance.cjs --tabs 20  change the many-tabs count (default 15)
//
// Answers "how native / how light is the Rust core vs Node" with three numbers
// per engine, measured the same way for both:
//   idle CPU %      : average core-process CPU over an ~18s idle window
//   memory drift    : core RSS at window start vs end (leak signal over time)
//   many-tabs RSS   : core RSS + whole-tree RSS after opening N terminal tabs
//
// It runs the two engines SEQUENTIALLY (never at once) so every winmux-core.exe /
// node.exe + its PowerShell shell children is unambiguously attributable to the
// engine under test. Sampling is done by scripts/proc-sample.ps1 (process tree).
// Mirrors verify.cjs / perf.cjs conventions: real child servers, real browser,
// committed instrument — not a scratch script.

const { spawn, spawnSync } = require('child_process');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const CORES = os.cpus().length;
const OUT = path.join(os.tmpdir(), 'winmux-endurance');
fs.mkdirSync(OUT, { recursive: true });
const SAMPLER = path.join(ROOT, 'scripts', 'proc-sample.ps1');
const RUST_BIN = path.join(ROOT, '..', '..', 'core', 'rust', 'target', 'release', 'winmux-core.exe');

const argTabs = process.argv.indexOf('--tabs');
const N_TABS = argTabs > -1 ? Number(process.argv[argTabs + 1]) : 15;
const HEADED = process.argv.includes('--headed');
const PORT_RUST = 9960;
const PORT_NODE = 9961;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (b) => (b == null ? null : Math.round((b / 1048576) * 10) / 10);

function inUse(port) {
  return new Promise((res) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.end(); res(true); });
    s.on('error', () => res(false));
  });
}
async function waitUp(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await inUse(port)) return; await wait(200); }
  throw new Error('server never came up on ' + port);
}

function bootRust(port) {
  return spawn(RUST_BIN, [], {
    cwd: ROOT, stdio: 'ignore',
    env: Object.assign({}, process.env, {
      WINMUX_PORT: String(port),
      WINMUX_PUBLIC: path.join(ROOT, 'public'),
      WINMUX_INSTANCE_FILE: path.join(OUT, 'inst-' + port + '.json'),
      WINMUX_TRUST_FILE: path.join(OUT, 'trust-' + port + '.json'),
      WINMUX_CONFIG_FILE: path.join(OUT, 'cfg-' + port + '.json'),
    }),
  });
}
function bootNode(port) {
  return spawn(process.execPath, ['server.cjs'], {
    cwd: ROOT, stdio: 'ignore',
    env: Object.assign({}, process.env, {
      PORT: String(port), WINMUX_NO_INSTANCE: '1',
      WINMUX_TRUST_FILE: path.join(OUT, 'trust-' + port + '.json'),
      WINMUX_CONFIG_FILE: path.join(OUT, 'cfg-' + port + '.json'),
    }),
  });
}

// One process-tree sample via PowerShell. Returns {cpuCore,rssCore,cpuTree,rssTree,n}.
function sample(pid) {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SAMPLER, '-RootPid', String(pid)],
    { encoding: 'utf8' });
  try { return JSON.parse((r.stdout || '').trim()); } catch (e) { return null; }
}

async function openApp(browser, port) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await page.addInitScript(() => { try { localStorage.setItem('ct-onboard', '1'); } catch (e) {} });
  await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);   // first shell attaches
  return page;
}

async function measureEngine(name, boot, port) {
  const proc = boot(port);
  await waitUp(port, 20000);
  const pid = proc.pid;
  await wait(3000);                              // settle after boot

  // --- IDLE window: sample core RSS + cumulative CPU across ~18s ---
  const t0 = Date.now();
  const first = sample(pid);
  const rssSamples = [];
  for (let i = 0; i < 12; i++) {
    await wait(1500);
    const s = sample(pid);
    if (s) rssSamples.push(mb(s.rssCore));
  }
  const last = sample(pid);
  const wallS = (Date.now() - t0) / 1000;
  const idleCpuPct = first && last
    ? Math.round(((last.cpuCore - first.cpuCore) / wallS / CORES) * 100 * 100) / 100
    : null;

  // --- MANY TABS: open N terminals in a real browser, then sample ---
  const browser = await chromium.launch({ channel: 'msedge', headless: !HEADED });
  const page = await openApp(browser, port);
  for (let i = 0; i < N_TABS; i++) {
    await page.evaluate(() => { const b = document.getElementById('open-new'); if (b) b.click(); });
    await page.waitForTimeout(450);
  }
  await page.waitForTimeout(4000);              // all shells settle
  const loaded = sample(pid);

  // CPU with N tabs sitting idle (tree, includes the shells) over 5s
  const cA = sample(pid);
  await wait(5000);
  const cB = sample(pid);
  const tabsIdleCpuPct = cA && cB
    ? Math.round(((cB.cpuTree - cA.cpuTree) / 5 / CORES) * 100 * 100) / 100
    : null;

  await browser.close();
  try { proc.kill(); } catch (e) {}
  await wait(1500);

  return {
    engine: name,
    idleCpuPct,
    idleRssStartMB: first ? mb(first.rssCore) : null,
    idleRssEndMB: last ? mb(last.rssCore) : null,
    idleRssDriftMB: first && last ? mb(last.rssCore - first.rssCore) : null,
    idleRssSamplesMB: rssSamples,
    tabs: N_TABS,
    tabsRssCoreMB: loaded ? mb(loaded.rssCore) : null,
    tabsRssTreeMB: loaded ? mb(loaded.rssTree) : null,
    tabsProcCount: loaded ? loaded.n : null,
    tabsIdleCpuPct,
  };
}

(async () => {
  if (!fs.existsSync(RUST_BIN)) { console.error('Rust core not built:', RUST_BIN); process.exit(1); }
  console.log('WinMux endurance — Rust vs Node · ' + CORES + ' logical cores · ' + N_TABS + ' tabs\n');

  const rust = await measureEngine('rust', bootRust, PORT_RUST);
  console.log('rust done:', JSON.stringify(rust));
  const node = await measureEngine('node', bootNode, PORT_NODE);
  console.log('node done:', JSON.stringify(node));

  const report = { cores: CORES, tabs: N_TABS, rust, node };
  console.log('\n=== WinMux endurance ===');
  console.log(JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT, 'endurance-result.json'), JSON.stringify(report, null, 2));
  process.exit(0);
})().catch((e) => { console.error('endurance ERR', (e && e.stack) || e); process.exit(2); });

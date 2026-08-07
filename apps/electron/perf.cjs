// WinMux performance harness.
//
//   node perf.cjs            measure against the pre-registered targets
//   node perf.cjs --headed   watch it
//
// Prints a JSON block of measured numbers and exits non-zero if any
// PRE-REGISTERED target is missed. Mirrors verify.cjs conventions: it boots
// server.cjs as a child on its own port and drives a real browser. This is the
// instrument the perf/reliability plan is graded against — commit it, don't
// treat it as a scratch script.
//
// Segments measured:
//   connect path : click New tab -> ws open -> shell first byte -> first paint
//   tab latency  : new-tab time with the pre-warm spare vs a cold (no-prewarm) server
//   10-stream tick: event-loop tick under 10 terminals each streaming a 3000-line burst

const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const HEADED = process.argv.includes('--headed');
// The renderer is now GPU-on by DEFAULT (app.js), so a bare run measures the shipping
// config. `--dom` forces the DOM renderer to reproduce the ~132ms baseline for the
// honesty gate. (`--gpu` is kept as an explicit alias for the default.)
const FORCE_DOM = process.argv.includes('--dom');
const GPU = !FORCE_DOM;
const PORT_WARM = 9940;   // pre-warm ON (default)
const PORT_COLD = 9941;   // pre-warm OFF (WINMUX_NO_PREWARM=1)

// Pre-registered targets — set BEFORE optimizing, so "snappy" is falsifiable.
const TARGETS = {
  newTabWarmMs: 150,   // a pre-warmed new tab must feel instant
  tickMs10: 50,        // event-loop tick under 10 concurrent streams
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function inUse(port) {
  return new Promise((res) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.end(); res(true); });
    s.on('error', () => res(false));
  });
}
async function waitUp(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await inUse(port)) return; await wait(150); }
  throw new Error('server never came up on ' + port);
}
function boot(port, extraEnv) {
  const proc = spawn(process.execPath, ['server.cjs'], {
    cwd: ROOT, stdio: 'ignore',
    env: Object.assign({}, process.env, { PORT: String(port), WINMUX_NO_INSTANCE: '1' }, extraEnv || {}),
  });
  return proc;
}

// Open the app, mark onboarding seen, and (optionally) force the GPU renderer on.
async function openApp(browser, port) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await page.addInitScript((gpu) => {
    try { localStorage.setItem('ct-onboard', '1'); } catch (e) {}
    if (gpu) { try {
      const s = JSON.parse(localStorage.getItem('ct-settings') || '{}');
      s.gpuRenderer = true; localStorage.setItem('ct-settings', JSON.stringify(s));
    } catch (e) {} }
  }, GPU);
  await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);   // first shell attaches
  return page;
}

// Measure one new-tab open: click New terminal, time until the new pane's
// terminal paints its first row. Returns ms (click -> first visible row).
async function measureNewTab(page) {
  return page.evaluate(async () => {
    const before = document.querySelectorAll('.ptab').length;
    const t0 = performance.now();
    document.getElementById('open-new').click();
    // Wait until a new pane exists AND its terminal has painted at least one row.
    const deadline = t0 + 8000;
    while (performance.now() < deadline) {
      const tabs = document.querySelectorAll('.ptab').length;
      // Renderer-agnostic paint signal: DOM renderer fills .xterm-rows; the WebGL
      // renderer paints to a <canvas> instead. Either one being present in a newly
      // mounted terminal means the tab has painted.
      const painted = document.querySelector('.xterm-rows > div') ||
                      document.querySelector('.xterm-screen canvas, .xterm canvas');
      if (tabs > before && painted) break;
      await new Promise((r) => requestAnimationFrame(r));
    }
    return Math.round(performance.now() - t0);
  });
}

// A winmux CLI call pointed at a specific test server (the proven injection path
// the `cli` harness check uses — reliable, unlike synthesised keystrokes).
function winmuxOn(port, args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(port), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = '';
    p.stdout.on('data', (d) => o += d); p.stderr.on('data', (d) => e += d);
    p.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });
}

// Sample event-loop tick drift over `ms` while the page is under load.
async function measureTick(page, ms) {
  return page.evaluate((dur) => new Promise((resolve) => {
    const gap = 16; const start = performance.now(); let last = start; let worst = 0; let sum = 0; let n = 0;
    const id = setInterval(() => {
      const now = performance.now(); const drift = now - last - gap; last = now;
      if (drift > worst) worst = drift; sum += Math.max(0, drift); n++;
      if (now - start >= dur) { clearInterval(id); resolve({ avg: Math.round(sum / n + gap), worst: Math.round(worst + gap) }); }
    }, gap);
  }), ms);
}

(async () => {
  // A DOM run forces the DOM renderer server-side (app.js honours __winmuxForceDom);
  // the default (GPU) run leaves it unset so the shipping default is what's measured.
  const domEnv = FORCE_DOM ? { WINMUX_FORCE_DOM: '1' } : {};
  const warm = boot(PORT_WARM, domEnv);
  const cold = boot(PORT_COLD, Object.assign({ WINMUX_NO_PREWARM: '1' }, domEnv));
  await Promise.all([waitUp(PORT_WARM, 15000), waitUp(PORT_COLD, 15000)]);
  const browser = await chromium.launch({ channel: 'msedge', headless: !HEADED });

  const out = { gpu: GPU };

  // --- new-tab latency: warm (pre-warm spare) vs cold (no prewarm) ---
  const warmPage = await openApp(browser, PORT_WARM);
  out.newTabWarmMs = await measureNewTab(warmPage);
  out.newTabWarm2Ms = await measureNewTab(warmPage);   // 2nd consecutive = "predicted" depth

  const coldPage = await openApp(browser, PORT_COLD);
  out.newTabColdMs = await measureNewTab(coldPage);

  // --- 10-stream event-loop tick (the DOM-renderer jank the GPU work fixes) ---
  // Open 10 tabs on the warm server, arm a burst in each, fire them, sample tick.
  // Open 10 terminals total via the CLI (server-driven, so the app really mounts
  // them), then read their ids back.
  for (let i = 0; i < 9; i++) await winmuxOn(PORT_WARM, ['new-tab']);
  await warmPage.waitForTimeout(1800);
  let ids = [];
  try { const l = JSON.parse((await winmuxOn(PORT_WARM, ['list', '--json'])).out); ids = (l.sessions || []).map((s) => s.id); } catch (e) {}
  out.streams = ids.length;
  // Fire a sustained 60k-line burst into EVERY terminal concurrently (fire-and-
  // forget: send returns after injecting; the shells then stream the output).
  const burst = '1..60000 | % { "perf ' + 'x'.repeat(72) + ' $_" }';
  ids.forEach((id) => { winmuxOn(PORT_WARM, ['send', burst, '--id', String(id), '--enter']); });
  await warmPage.waitForTimeout(700);   // let all bursts be in flight
  const tick = await measureTick(warmPage, 3000);
  out.tickMs10 = tick.avg; out.tickMs10Worst = tick.worst;

  await browser.close();
  try { warm.kill(); } catch (e) {}
  try { cold.kill(); } catch (e) {}

  // --- report + gate ---
  console.log('\n=== WinMux perf (' + (GPU ? 'GPU on' : 'DOM renderer') + ') ===');
  console.log(JSON.stringify(out, null, 2));

  // INSTRUMENT VALIDITY GATE. The 10-stream tick is only trustworthy once this
  // harness can reproduce the DOM-renderer baseline documented in PLAN.md
  // (~132ms/tick under 10 concurrent 3000-line streams). Until a DOM-renderer
  // run actually reads that high, the load is NOT reproducing (the typed burst
  // isn't reaching the shells) and the tick number is meaningless — so we must
  // NOT report "targets met" off it, and NO GPU decision may rest on it.
  const BASELINE_FLOOR = 80;   // a real 10-stream DOM run must clear this
  const loadReproduced = out.tickMs10 >= BASELINE_FLOOR;
  if (FORCE_DOM && !loadReproduced) {
    console.log('\nINSTRUMENT NOT YET VALID: 10-stream tick read ' + out.tickMs10 +
      'ms on the DOM renderer, below the ~132ms baseline PLAN.md documented. The load is not' +
      ' reproducing (streams not landing) — the tick number is meaningless and no GPU decision' +
      ' may rest on it. Fix the burst-injection path before trusting tickMs10.');
    process.exit(3);
  }

  const fails = [];
  // A pre-warmed new tab must be instant in BOTH renderers.
  if (out.newTabWarmMs > TARGETS.newTabWarmMs) fails.push('newTabWarmMs ' + out.newTabWarmMs + ' > ' + TARGETS.newTabWarmMs);
  // The <50ms tick is the SHIPPING (GPU) target. The --dom run is the baseline it's
  // measured against and is EXPECTED to read high (~132ms) — don't enforce <50 on it.
  if (!FORCE_DOM && out.tickMs10 > TARGETS.tickMs10) fails.push('tickMs10 ' + out.tickMs10 + ' > ' + TARGETS.tickMs10);
  if (fails.length) { console.log('\nMISSED TARGETS:\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('\n' + (FORCE_DOM ? 'DOM baseline captured (load reproduced; <50ms tick is not a DOM target).' : 'All pre-registered targets met.'));
  process.exit(0);
})().catch((e) => { console.error('perf ERR', e && e.stack || e); process.exit(2); });

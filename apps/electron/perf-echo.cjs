// IF-2: typing-echo latency probe — keypress -> painted character, per engine.
//
//   node perf-echo.cjs node    # spawn server.cjs on an isolated port
//   node perf-echo.cjs rust    # spawn winmux-core.exe (build core/rust first)
//
// Boots an isolated engine, opens the cockpit with the DOM renderer, types
// single characters and measures until each shows in .xterm-rows. The number
// includes the full real path (browser key -> ws -> ConPTY -> shell echo ->
// ws -> xterm paint) plus ~a frame of poll granularity, so it slightly
// overstates the true latency; compare engines, don't read it as absolute.
//
// 2026-08-16 baseline: rust median 85ms / node median 84ms (n=14) — engine-
// neutral; the latency is the shared ConPTY/PSReadLine path, not the engine.
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const ROOT = __dirname;
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));

const ENGINE = process.argv[2];
if (ENGINE !== 'node' && ENGINE !== 'rust') { console.error('usage: node perf-echo.cjs <node|rust>'); process.exit(2); }
const PORT = 9994;
const RUST_EXE = path.join(ROOT, '..', '..', 'core', 'rust', 'target', 'release', 'winmux-core.exe');

(async () => {
  const env = Object.assign({}, process.env, {
    WINMUX_PUBLIC: path.join(ROOT, 'public'),
    WINMUX_INSTANCE_FILE: path.join(os.tmpdir(), 'echo-' + ENGINE + '-inst.json'),
    WINMUX_TRUST_FILE: path.join(os.tmpdir(), 'echo-' + ENGINE + '-trust.json'),
    WINMUX_CONFIG_FILE: path.join(os.tmpdir(), 'echo-' + ENGINE + '-config.json'),
  });
  let server;
  if (ENGINE === 'rust') {
    env.WINMUX_PORT = String(PORT);
    server = spawn(RUST_EXE, [], { stdio: 'ignore', env });
  } else {
    env.PORT = String(PORT);
    server = spawn(process.execPath, [path.join(ROOT, 'server.cjs')], { stdio: 'ignore', env });
  }
  await new Promise((r) => setTimeout(r, 2500));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => { try {
    localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1');
    const s = JSON.parse(localStorage.getItem('ct-settings') || '{}'); s.gpuRenderer = false;
    localStorage.setItem('ct-settings', JSON.stringify(s));
  } catch (e) {} });
  await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);   // shell attaches, prompt settles
  await page.click('.xterm');
  await page.waitForTimeout(300);

  const samples = [];
  const predicted = [];
  const chars = 'abcdefghijklmno'.split('');
  for (const c of chars) {
    await page.keyboard.press(c);
    // Two numbers per keystroke: when the char shows AT ALL (the SP-1 prediction
    // overlay — the felt latency), and when the real shell echo lands in the rows.
    const r = await page.evaluate((ch) => new Promise((resolve) => {
      const start = performance.now();
      let pred = -1;
      function look() {
        if (pred < 0) {
          const hit = [...document.querySelectorAll('.xterm-screen > div')].some((o) =>
            o.style.pointerEvents === 'none' && o.style.display !== 'none' && o.textContent.endsWith(ch));
          if (hit) pred = Math.round(performance.now() - start);
        }
        const rows = document.querySelector('.xterm-rows');
        const text = rows ? rows.innerText.replace(/\s+$/g, '') : '';
        if (text.endsWith(ch)) { resolve({ echo: Math.round(performance.now() - start), pred }); return; }
        if (performance.now() - start > 3000) { resolve({ echo: -1, pred }); return; }
        requestAnimationFrame(look);
      }
      look();
    }), c);
    samples.push(r.echo);
    predicted.push(r.pred);
    await page.waitForTimeout(120);
  }
  const good = samples.filter((s) => s >= 0).sort((a, b) => a - b);
  const median = good[Math.floor(good.length / 2)];
  const pGood = predicted.filter((s) => s >= 0).sort((a, b) => a - b);
  console.log('echo samples(ms): ' + samples.join(', '));
  console.log('predicted samples(ms): ' + predicted.join(', '));
  console.log(ENGINE + ' typing echo — median ' + median + 'ms, max ' + Math.max(...good) + 'ms, n=' + good.length);
  if (pGood.length) console.log(ENGINE + ' FELT (predicted paint) — median ' + pGood[Math.floor(pGood.length / 2)] + 'ms, max ' + Math.max(...pGood) + 'ms, n=' + pGood.length + ' (first keystrokes earn confidence, so early ones are unpredicted by design)');
  await browser.close();
  server.kill();
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(2); });

// verify-coexist.cjs — the Phase 12 acceptance gate. Builds the packaged app and
// runs it CONCURRENTLY with the from-source dev app (both in offscreen smoke
// mode), then proves they did not share state: disjoint userData (so disjoint
// Electron ProcessSingleton locks — both windows actually open), disjoint CLI
// discovery files, and each ran a real node-pty shell. Heavy (it builds), so it
// is a named script, not part of the zero-arg harness.
//
// Build output goes to an OS-temp dir, never into the repo: on a Dropbox-synced
// checkout, Dropbox locks the output mid-build and electron-builder EPERMs on
// rename. A normal clone could use `npm run pack` in place, but temp is safe
// everywhere.
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'verify-out');
fs.mkdirSync(OUT, { recursive: true });
const BUILD_DIR = path.join(os.tmpdir(), 'winmux-coexist-build');

// Run one Electron app in smoke mode; resolve with its parsed verdict (or null).
function smoke(exe, args, label) {
  const outFile = path.join(OUT, 'coexist-' + label + '.json');
  try { fs.unlinkSync(outFile); } catch (e) {}
  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      env: { ...process.env, WINMUX_SMOKE: '1', WINMUX_SMOKE_OUT: outFile },
      windowsHide: true,
    });
    const timer = setTimeout(() => { try { child.kill(); } catch (e) {} }, 120000);
    child.on('exit', () => {
      clearTimeout(timer);
      let v = null;
      try { v = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (e) {}
      resolve(v);
    });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

(async () => {
  // 1) Build the packaged app to a temp dir outside the repo.
  console.log('building packaged app to ' + BUILD_DIR + ' …');
  execFileSync('npx', ['electron-builder', '--dir', '-c.directories.output=' + BUILD_DIR],
    { cwd: ROOT, stdio: 'inherit', shell: true });
  // Compile the dev main too (the packaged app already bundled its own copy).
  execFileSync('npm', ['run', 'build:electron'], { cwd: ROOT, stdio: 'inherit', shell: true });

  const packedExe = path.join(BUILD_DIR, 'win-unpacked', 'WinMux.exe');
  if (!fs.existsSync(packedExe)) { console.error('FAIL: no packed exe at ' + packedExe); process.exit(1); }
  // require('electron') from plain Node returns the path to the real electron
  // binary — avoids spawning the .cmd shim (EINVAL on Windows without a shell).
  const devElectron = require('electron');
  const devMain = path.join(ROOT, 'dist-electron', 'main.js');

  // 2) Run BOTH at once — this is the real coexistence test. If they shared a
  //    userData, the second's ProcessSingleton would hand off to the first and
  //    it would never boot its own window.
  console.log('launching packaged + dev apps concurrently …');
  const [P, D] = await Promise.all([
    smoke(packedExe, [], 'packed'),
    smoke(devElectron, [devMain], 'dev'),
  ]);

  const fails = [];
  const req = (name, cond, note) => {
    if (!cond) fails.push(name);
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (note ? '  ' + JSON.stringify(note) : ''));
  };

  req('packaged app rendered its own cockpit', !!(P && P.hasCockpit));
  req('dev app rendered its own cockpit (singleton lock not shared)', !!(D && D.hasCockpit));
  req('packaged userData differs from dev userData',
    !!(P && D && P.userData && D.userData && P.userData !== D.userData), { packed: P && P.userData, dev: D && D.userData });
  req('userData dirs do not nest',
    !!(P && D && P.userData && D.userData &&
      !P.userData.startsWith(D.userData + path.sep) && !D.userData.startsWith(P.userData + path.sep)));
  req('discovery files differ',
    !!(P && D && P.instanceFile !== D.instanceFile), { packed: P && P.instanceFile, dev: D && D.instanceFile });
  req('both ran a real node-pty shell (ptyOk)', !!(P && P.ptyOk) && !!(D && D.ptyOk));

  fs.writeFileSync(path.join(OUT, 'coexist.json'), JSON.stringify({ packed: P, dev: D, fails }, null, 2));
  console.log('');
  console.log(fails.length
    ? 'COEXIST FAILED: ' + fails.join(', ')
    : 'COEXIST OK — installed and dev run independently on the same machine');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

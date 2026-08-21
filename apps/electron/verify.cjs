// WinMux verification harness.
//
//   node verify.cjs
//
// No arguments. Ever. If this file needs an argument to run, it is broken —
// every argument is a chance to invoke it wrong and burn a whole browser run.
// It finds its own ports, starts (or reuses) its own servers, shares one
// browser across every check, and writes its screenshots next to itself.
//
//   node verify.cjs --headed     watch it drive
//   node verify.cjs phone brand  run only the named checks
//
// Exit code is 0 only when every check that could run, passed — and only when
// every check that SHOULD have been able to run, did. A check whose port is
// held by a stray process is reported BLOCKED and exits non-zero: it says
// nothing about the product, but it also did not verify it, so the run is not
// green. A skip (this machine has no Tailscale) is a capability it never had;
// a block (something is on port 9912) is a mess it can clean up.

const { spawn, execSync } = require('child_process');
const net = require('net');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'verify-out');

// A second copy of the suite cannot run beside the first, because these numbers
// are machine-global — worktree isolation stops a run reading a mutating tree,
// but it does nothing at all about contention. WINMUX_VERIFY_PORT_BASE shifts
// this suite's whole namespace so a pinned full run and live targeted runs can
// coexist.
//
// Every port below is declared THROUGH P(). That is the whole design. Shifting
// the namespace at the registration choke point looked right and was wrong:
// fifteen checks hand their raw constant to the winmux CLI as WINMUX_PORT, so
// under a base the server moved and the CLI did not, and thirty-five checks
// failed in a way the default run — base 0, where raw and shifted are the same
// number — can never show. A half-applied namespace is worse than none: it is
// green exactly where it is not being used. Declared already-shifted, a raw
// number has nowhere to leak from.
const PORT_BASE = (() => {
  const n = Number(process.env.WINMUX_VERIFY_PORT_BASE) || 0;
  if (!n) return 0;
  if (n % 100 !== 0 || n < -400 || n > 400) {
    console.error('\nWINMUX_VERIFY_PORT_BASE must be a multiple of 100 between -400 and 400 (got ' + n + ').\n');
    process.exit(2);
  }
  return n;
})();
const P = (n) => n + PORT_BASE;

// …and the rule is enforced on the file itself, because the last one wasn't.
// The namespace was applied at the registration choke point and I believed it
// held — right up to the first pinned full run, where thirty-five checks went
// red because they had passed a raw constant to the CLI. Nothing about that was
// visible at base 0. So this reads its own source, comments stripped, and
// refuses to start if a 99xx literal appears anywhere that is not wrapped in
// P(). It costs about a millisecond and it is the only thing here that can see
// the mistake before a twelve-minute run does.
(() => {
  const src = require('fs').readFileSync(__filename, 'utf8').split('\n');
  const stray = [];
  src.forEach((line, i) => {
    if (/PORTS_EXHAUST_RAW\s*=/.test(line)) return;   // raw on purpose; mapped through P below
    const code = line.split('//')[0];
    let m;
    // No hyphen in the lookbehind, deliberately. The first version excluded it
    // to avoid false positives and so walked straight past
    // 'workspace-9978.json' — a port baked into a FILENAME, where the check
    // asserted on the shifted name and told the engine to write the unshifted
    // one. A port is a port wherever it is spelled.
    const re = /(?<![\w.])99[0-9][0-9](?![\w])/g;
    while ((m = re.exec(code))) {
      if (code.slice(Math.max(0, m.index - 2), m.index) !== 'P(') stray.push((i + 1) + ': ' + line.trim());
    }
  });
  if (stray.length) {
    console.error('\nverify.cjs has ' + stray.length + ' raw port literal(s) that skip the namespace:\n');
    stray.forEach((l) => console.error('  ' + l));
    console.error('\nWrap each one in P(…). A port that skips P() is correct at base 0 and wrong'
      + '\neverywhere else, which is the failure mode that hid thirty-five red checks.\n');
    process.exit(2);
  }
})();

// Same idea, different lie. `node verify.cjs` does not compile anything, but
// five checks load dist-electron/*.js and fail in zero seconds without it — as
// five red PRODUCT checks, which is the worst possible way to report a missing
// build step. The project's real entry point is `npm run verify` (build, then
// verify); running the file bare in a tree that has never been built produced a
// whole afternoon of green targeted runs sitting on top of it.
(() => {
  if (require('fs').existsSync(require('path').join(__dirname, 'dist-electron', 'main.js'))) return;
  console.error('\nverify.cjs: dist-electron is missing — this tree has never been compiled.'
    + '\nFive checks load it directly and would report the missing build as product failures.'
    + '\n\n  npm run build:electron     (then re-run)'
    + '\n  npm run verify             (builds first — the entry point that cannot get this wrong)\n');
  process.exit(2);
})();

// Two ports on purpose. The busy one is where we prove that a phone flip which
// cannot bind MUST fail politely instead of taking the app down with it.
// It used to be 8799, borrowed from tailscaled's accidental hold on that port —
// which meant the check silently skipped on any machine where the accident
// wasn't happening, and "a skip is not a pass". Now the harness creates the
// collision itself (holdTailnet below), so the check runs everywhere Tailscale
// runs. 9914 is deliberately outside PORT_CANDIDATES and outside the serve
// rules on this machine.
const PORT_BUSY = P(9914);
const PORT_FREE = P(9912);
// The remote group opens the phone door for real, so it gets its own port —
// sharing PORT_FREE would have two groups fighting over one phone switch.
const PORT_REMOTE = P(9911);
// The trust group needs a guest list nobody else is writing to, and a fresh one
// — "the switch is off on a fresh install" is only provable from empty.
const PORT_TRUST = P(9915);
// The phone group opens and closes the door for real, so it must never borrow
// @edward's live WinMux — that would flip his own switch mid-run, and when his
// door is already open on 9912 the group used to skip instead. A skip is not a
// pass, so it gets a port of its own.
const PORT_PHONE = P(9913);
// The survival group counts running shells, so it must be the only thing
// talking to its server — borrowing @edward's would count his terminals as
// leaks and kill a tab he is using.
const PORT_SURVIVE = P(9916);
// The drop group makes twin folders on disk and asks the server to tell them
// apart, so it wants a server whose answers nobody else is racing.
const PORT_DROP = P(9917);
// The colour group types into a real shell and reads the painted result back,
// so it needs a server whose terminals nobody else is writing to.
const PORT_COLOUR = P(9918);
const PORT_GROUPS = P(9919);
// Reopening the page must reattach to the running shell, not orphan it.
// NOT 9920: that is the installed WinMux Rust engine's standing port — the
// harness would borrow the LIVE engine and type into Edward's real workspace.
const PORT_RELOAD = P(9985);
// A full reboot kills the server; its scrollback must survive on disk and replay.
const PORT_RESTART = P(9960);
// The CLI check needs its own server + a connected app, on a port nobody else
// is driving, so `winmux new-tab` counts don't race another group's terminals.
// NOT 9921: that is the installed WinMux Tauri engine's standing port — a
// running Tauri app kept /control connected and made "no app connected"
// impossible (the old documented gotcha; the port move retires it).
const PORT_CLI = P(9986);
// The markdown check opens a viewer surface and edits the file under it, so it
// needs a server whose /api/md nobody else is racing and a /control of its own.
const PORT_MD = P(9922);
// The paste check fires real paste events at a live terminal and reads whether
// the multi-line guard stopped to ask, so it wants a shell nobody else touches.
const PORT_PASTE = P(9923);
// The migrate check seeds a saved layout from a hypothetical future WinMux and
// proves the app still boots to a working terminal, so it needs its own server.
const PORT_MIGRATE = P(9924);
// The onboarding check loads with a virgin localStorage to prove the first-run
// welcome appears, dismisses, and stays gone. Its own server, its own state.
const PORT_ONBOARD = P(9925);
const PORT_APPROVE = P(9926);
const PORT_PWSH = P(9927);
const PORT_FOOTER = P(9928);
const PORT_UPDATE = P(9929);
const PORT_GPU = P(9930);
const PORT_FONT = P(9931);
const PORT_INSTANT = P(9932);
const PORT_SURVIVE2 = P(9933);   // registered port (runner boots a throwaway here)
const PORT_PARITY = P(9934);     // terminal-parity addons (web-links, unicode11)
const PORT_NOTIFY = P(9935);     // attention bus: `winmux notify` flips a session to needs-you
const PORT_OSNOTIFY = P(9936);   // attention bus: OS notification fires only when unfocused
const PORT_MCP = P(9937);        // winmux-mcp: an MCP client drives the live app over stdio
const PORT_DOING = P(9938);      // cockpit: a session row shows a live "what's it doing" line
const PORT_CLIP = P(9939);       // cockpit: cross-device clipboard round-trips through /api/clip
const PORT_CONFIG = P(9940);     // config: durable on-disk settings via /api/config
const PORT_THEME = P(9941);      // theme import: a Windows Terminal scheme recolours the terminal
const PORT_KEYS = P(9942);       // custom keybindings: a remapped chord runs the action, the old one doesn't
const PORT_MDRICH = P(9943);     // markdown richness: tables, task-list checkboxes, images render in the viewer
const PORT_MARKS = P(9945);      // terminal command-marks jump + reset (browser verbs ride the electron smoke)
const PORT_CMDTAG = P(9975);     // Phase 4: command-blocks status tag (✓/✗ + time) renders on OSC-133 D-marks
const PORT_APPROVECARD = P(9976);// Phase 8: the phone approval card's Approve button actually sends Enter to the shell
const PORT_AGENTENV = P(9946);   // agent: every shell exports WINMUX_SID/WINMUX_PORT
const PORT_AGENTSTATE = P(9947); // agent: winmux agent <state> flips the session's cockpit status
const PORT_AGENTHOOKS = P(9948); // agent: the Claude Code hooks preset drives live state
const PORT_WINGET = P(9949);     // distribution: the winget manifest generator emits valid manifests
const PORT_TUNOVR = P(9950);     // #246: the WINMUX_TUNNELLED_PORTS override is honored (no fail-open under load)
const PORT_LIG = P(9955);        // #238: the ligature switch really shapes glyphs, and pays for it in renderer
const PORT_RESUME = P(9951);     // #240: an armed tab auto-runs its resume command on a cold reopen, not on a warm reattach
// #246: three ports the port check holds itself, so it can prove the
// every-candidate-taken refusal without starving the other auto-picking checks.
const PORT_SPLITFLOOR = P(9900);  // AUDIT-T1: splitting has a floor, and the refusal is said out loud
const PORT_FOLDFIT = P(9901);     // AUDIT-T2: a saved layout too big for this window folds into tabs, losing nothing
const PORTS_EXHAUST_RAW = [9952, 9953, 9954];
const PORTS_EXHAUST = PORTS_EXHAUST_RAW.map(P);
const PORT_DIFF = P(9956);       // ST5: git diff opens as a pane tab (leaf), not a side dock
const PORT_LEAFPERSIST = P(9957); // ST6: non-terminal leaves survive a page reload
const PORT_PREDICT = P(9958);    // Phase 2: pwsh PSReadLine inline history prediction + RightArrow accept
const PORT_IMAGES = P(9959);     // Phase 3: inline images (addon-image) + `winmux image` verb
const PORT_DPRFIX = P(9977);     // MR-1: a devicePixelRatio-stuck WebGL canvas is resynced (prompt-float fix)
const PORT_AGENTJOB = P(9968);   // Stage 3: server-side agent-job store (spawn/wait/result), no browser needed
const PORT_WORKSPACE = P(9978);  // PT-3: the engine-owned workspace file survives a wiped browser profile
const PORT_RECOVER = P(9979);    // PT-4: Recent & recoverable — saved scrollbacks are listed, restorable, dismissable
const PORT_CLOSEVERB = P(9980);  // PT-5: Close project = unbind with three honest outcomes; Delete is real and confirmed
const PORT_SOT = P(9981);        // PT-6: the engine's config.json is the settings authority; localStorage is only a cache
const PORT_LOCALECHO = P(9982);  // SP-1: predictive local echo — instant paint, honest reconcile, no secret leak
const PORT_SIDEBAR = P(9983);    // SB: Obsidian-style sidebar tabs — switch, persist, notif-in-rail, drag-resize
const PORT_SPLITCLOSE = P(9984); // FB: closing a split's last visible tab collapses the split, even across groups
const PORT_WINCTL = P(9987);     // AUDIT-1: the window's close button survives every pane layout at every size
const PORT_DELHONEST = P(9988);  // AUDIT-2: a delete that didn't happen never reports "file removed"
const PORT_KEYMAPGUARD = P(9989); // AUDIT-3: a hand-edited keymap is checked, so nothing shows as bound and stays dead
const PORT_CHORDTRUTH = P(9990);  // AUDIT-4: every surface that advertises a shortcut shows the key actually bound
const PORT_WRITELOUD = P(9991);   // AUDIT-5: an engine write that failed says so — once per outage, and again on recovery
const PORT_SLASHFAST = P(9992);   // AUDIT-6: `winmux slash` refuses a non-Claude tab fast instead of hanging 90s
const PORT_SHIPPED05 = P(9993);   // AUDIT-7: the four features that were broken only in the engine we ship
const PORT_UPDFEED = P(9994);     // AUDIT-7's own stand-in release feed, so the update path is proven for real
const PORT_NOCLOBBER = P(9997);   // AUDIT-8: saving a project never writes over a different project
const PORT_KEYBACK = P(9996);     // AUDIT-9: a dialog that took the keyboard gives it back however it is dismissed
const PORT_CFGSAFE = P(9998);     // AUDIT-10: a damaged settings file is kept and reported, never quietly replaced
const PORT_BUSYBAR = P(9995);     // the busy underline actually paints, and grows, while a shell works
const PORT_ORPHAN = P(9974);      // AUDIT-8: closing a tab whose socket is down still ends its shell
const PORT_NOSTRAND = P(9972);    // AUDIT-4: a slow answer never strands a live engine and its shells
const PORT_EXITTRUTH = P(9970);   // AUDIT-1: a shell that ends says so, on both engines
const PORT_CTLBACKOFF = P(9961);  // AUDIT-B4: the control socket backs off instead of retrying forever
const PORT_CLIHERE  = P(9963);    // AUDIT-9: the winmux CLI runs inside a WinMux terminal, as the guide promises
const PORT_KEYTRUTH = P(9962);    // AUDIT-2: no shortcut is bound to a key the terminal is going to eat
const PORT_FLEETOPEN = P(9964);   // AUDIT-B6/B7: the fleet list opens, remembers, and the guide's button shows it
const PORT_CWDGONE = P(9965);     // AUDIT-B10: a project whose folder moved says so instead of opening elsewhere
const PORT_CLICLOSE = P(9966);    // AUDIT-T4: the command surface can put a layout back, not only grow it
const PORT_AGENTSPAWN = P(9967); // Stage 3: spawn a real session, it self-reports, a wait gets its result
const CONFIG_TMP = path.join(os.tmpdir(), 'winmux-verify-config.json');
// Save-on-close writes real project files; point them at a scratch dir so a test
// never drops a "Verify Project.winmux.json" into the real Documents\WinMux Projects.
const PROJECTS_TMP = path.join(os.tmpdir(), 'winmux-verify-projects');

// Every server this harness starts gets its own scratch guest list. Two reasons,
// both real: @edward's actual remembered phones must never be edited by a test
// run, and three concurrent servers sharing one file would clobber each other's
// writes and make the trust checks flap for no product reason.
const trustFile = (port) => path.join(OUT, 'trust-' + port + '.json');
// Every harness server gets its own throwaway config file so a test can never
// write the real ~/.winmux/config.json (the app POSTs settings on boot now).
const configFile = (port) => path.join(OUT, 'config-' + port + '.json');

const argv = process.argv.slice(2);
const HEADED = argv.includes('--headed');
const ONLY = argv.filter((a) => !a.startsWith('-'));

// ---- --prove: does this check actually detect the defect it claims to? ------
// A check that passes before the fix proves nothing, and there is no way to
// tell one apart from a real one by reading it. So the harness proves it:
// put the product back the way it was, require RED, restore, require GREEN.
//
// Deliberately narrow — sensitivity and specificity, nothing else. Whether the
// element was ever really there belongs in the assertion helpers; whether the
// environment was clean belongs in the Tier 0 guards. Widening this verb is
// how it would stop being buildable.
//
// The file set is detected, not typed. Every uncommitted change EXCEPT this
// harness file is the product change under test — listing paths by hand is a
// decision, and a decision is a thing to get wrong at 2am.
if (argv.includes('--prove')) {
  const { execFileSync, spawnSync } = require('child_process');
  const names = ONLY;
  if (!names.length) { console.error('\n--prove needs a check name: node verify.cjs --prove <check>\n'); process.exit(2); }
  // git prints repo-relative paths and resolves pathspecs against cwd, so every
  // git call here runs from the repo root. Getting that wrong made the revert a
  // silent no-op, the "before" run kept the change, and it passed — which is
  // precisely how a proof harness manufactures a false PROVEN. Fatal now.
  const TOP = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const git = (args) => execFileSync('git', args, { cwd: TOP, encoding: 'utf8' });
  const dirty = git(['status', '--porcelain', '--', ROOT])
    .split('\n').map((l) => l.slice(3).trim()).filter(Boolean)
    .filter((f) => !/verify\.cjs$/.test(f) && !/^"?\.?verify-out/.test(f) && !f.startsWith('coverage.cjs'));
  if (!dirty.length) {
    console.error('\n--prove found no uncommitted product change to attribute the pass to.');
    console.error('Either the fix is already committed (prove it before committing), or there is no fix.\n');
    process.exit(2);
  }
  const stash = path.join(os.tmpdir(), 'winmux-prove-' + process.pid);
  fs.mkdirSync(stash, { recursive: true });
  const run = () => {
    const r = spawnSync(process.execPath, [__filename, ...names], { cwd: ROOT, encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    const m = out.match(/(\d+) of (\d+) checks FAILED/) || out.match(/(\d+)\/(\d+) checks passed/);
    return { out, failed: /checks FAILED/.test(out), summary: m ? m[0] : '(no summary)' };
  };
  const saved = [];
  let verdict = 1;
  try {
    for (const f of dirty) {
      const abs = path.join(TOP, f);
      const to = path.join(stash, f.replace(/[\\/]/g, '__'));
      if (fs.existsSync(abs)) { fs.copyFileSync(abs, to); saved.push({ abs, to }); }
    }
    console.log('\nproving ' + names.join(', ') + ' against ' + dirty.length + ' changed file(s):');
    dirty.forEach((f) => console.log('  ' + f));

    for (const f of dirty) {
      let tracked = true;
      try { git(['cat-file', '-e', 'HEAD:' + f]); } catch (e) { tracked = false; }
      // Throws on failure, deliberately. A revert that quietly does nothing
      // leaves the change in place, the "before" run passes, and the harness
      // reports a fix it never removed.
      if (tracked) git(['checkout', 'HEAD', '--', f]);
      else fs.unlinkSync(path.join(TOP, f));   // the file is new: absence is its "before"
    }
    console.log('\n[1/2] without the change — the check must FAIL');
    const before = run();
    console.log('      ' + before.summary);

    saved.forEach((s) => fs.copyFileSync(s.to, s.abs));
    console.log('\n[2/2] with the change — the check must PASS');
    const after = run();
    console.log('      ' + after.summary);

    const ok = before.failed && !after.failed;
    console.log('\n' + (ok
      ? 'PROVEN — red before, green after. This check detects the defect it names.'
      : !before.failed
        ? 'NOT PROVEN — the check passed WITHOUT the change. It is not testing the fix.'
        : 'NOT PROVEN — the check still fails WITH the change.'));
    verdict = ok ? 0 : 1;
  } finally {
    saved.forEach((s) => { try { fs.copyFileSync(s.to, s.abs); } catch (e) {} });
    try { fs.rmSync(stash, { recursive: true, force: true }); } catch (e) {}
  }
  process.exit(verdict);
}
// Ceiling on a single check. The slowest honest check (survive/detach, which sit out
// real grace windows) lands well under this; anything past it is stuck, not slow.
const CHECK_TIMEOUT = Number(process.env.WINMUX_CHECK_TIMEOUT_MS) || 300000;

// ---------------------------------------------------------------- plumbing

function tailscaleIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && /^100\./.test(n.address)) return n.address;
  }
  return null;
}

function inUse(host, port) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(true));
    s.once('listening', () => s.close(() => res(false)));
    s.listen(port, host);
  });
}

// Take the Tailscale side of a port and hold it, so the app's phone door has
// something real to collide with. The desk door is unaffected — it binds
// 127.0.0.1, which is a different socket — so this reproduces exactly the
// situation the polite failure exists for, on demand, on any machine.
function holdTailnet(port) {
  const ip = tailscaleIp();
  if (!ip) return Promise.resolve(null);
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(null));            // already held by something else: fine
    s.once('listening', () => res({ ip, port, stop() { try { s.close(); } catch (e) {} } }));
    s.listen(port, ip);
  });
}

// Held once for the whole run, not once per check. The two checks that need
// the collision run concurrently, and a second bind of the same socket would
// fail — which the check would then misread as "Tailscale isn't running".
let busyHold = null;

// The servers this run started, by port. A check that asserts fresh-install
// state has to know whether it got a fresh server or borrowed @edward's.
const SERVERS = {};

// Ports that tailscale already forwards into loopback. The harness reads the
// same source the app does, so "we moved off a tunnelled port" is checked
// against reality rather than against a hardcoded number.
function tunnelled() {
  return new Promise((resolve) => {
    const found = new Set();
    let left = 2;
    const done = () => { if (--left === 0) resolve(found); };
    for (const sub of ['serve', 'funnel']) {
      require('child_process').execFile('tailscale', [sub, 'status'],
        { timeout: 4000, windowsHide: true }, (err, out) => {
          if (!err && out) {
            const re = /https?:\/\/(?:127\.0\.0\.1|localhost):(\d{1,5})/g;
            let m;
            while ((m = re.exec(out))) found.add(parseInt(m[1], 10));
          }
          done();
        });
    }
  });
}

function get(url, headers) {
  return new Promise((res, rej) => {
    http.get(url, { headers: headers || {} }, (r) => {
      let b = '';
      r.on('data', (d) => { b += d; });
      r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b }));
    }).on('error', rej);
  });
}

function post(url, body, headers) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: Object.assign(
        { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        headers || {}),
    }, (rs) => {
      let b = '';
      rs.on('data', (d) => { b += d; });
      rs.on('end', () => res({ status: rs.statusCode, body: b }));
    });
    r.on('error', rej);
    r.write(body); r.end();
  });
}

function waitUp(port, ms) {
  const stop = Date.now() + ms;
  return new Promise(function poll(res, rej) {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); res(); });
    s.once('error', () => {
      s.destroy();
      if (Date.now() > stop) return rej(new Error('server never came up on ' + port));
      setTimeout(() => poll(res, rej), 250);
    });
  });
}

// Reuse a server that is already listening — Edward often has one running, and
// killing it out from under him would be worse than sharing it.
// WINMUX_CORE=rust runs the whole harness against the native Rust core instead of
// server.cjs — the Stage-2/4 finish-line measurement ("how many of these pass on
// Rust today"). Null (and every check unchanged) unless the env flag is set.
const RUST_CORE = process.env.WINMUX_CORE === 'rust'
  ? [path.join(ROOT, '..', '..', 'core', 'rust', 'target', 'release', 'winmux-core.exe'),
     path.join(ROOT, '..', '..', 'core', 'rust', 'target', 'debug', 'winmux-core.exe')].find((p) => fs.existsSync(p))
  : null;

// Best-effort "who is on this port" so the refusal above is actionable rather
// than just a complaint. Windows-only and allowed to come back empty.
function whoHas(port) {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort ' + port
      + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;'
      + ' if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue;'
      + ' if ($p) { \\"$($p.ProcessName) (pid $($p.Id))\\" } }"',
      { encoding: 'utf8', timeout: 6000, windowsHide: true }).trim();
    return out ? 'It is held by ' + out + '.' : '';
  } catch (e) { return ''; }
}

async function server(port, extraEnv) {
  // Anything already on this port is NOT ours. Borrowing it used to be silent,
  // which meant a stray process could become the system under test: the check's
  // env — its scratch config, its projects folder, its Startup folder — is
  // ignored, so the run both grades the wrong process AND can write somewhere
  // real. Refuse, and name what is holding the port so it can be dealt with.
  // WINMUX_VERIFY_BORROW=1 opts back in for driving a dev server by hand.
  if (await inUse('127.0.0.1', port)) {
    if (process.env.WINMUX_VERIFY_BORROW === '1') return { port, borrowed: true, stop() {} };
    // Fail the checks on THIS port, not the whole run — throwing here would let
    // one stray process cost five hundred checks instead of the handful it
    // actually invalidates. The run also probes every port before it starts, so
    // a conflict is named up front rather than only when its check comes up.
    return {
      port,
      foreign: 'port ' + port + ' is already taken by another process, so this check would have '
        + 'graded something that is not ours and ignored its own environment. ' + whoHas(port)
        + ' Stop that process, or set WINMUX_VERIFY_BORROW=1 to deliberately test against it.',
      stop() {},
    };
  }
  const proc = RUST_CORE
    ? spawn(RUST_CORE, [], {
        cwd: ROOT,
        // WINMUX_CLI_DIR / WINMUX_APP_EXE mirror what the Electron shell hands the
        // core in a real app. The core is a native binary beside the app, so it
        // cannot find the `winmux` CLI itself; without these the shells it spawns
        // get no CLI on their PATH and the check for that would fail on the engine
        // we actually ship, for a reason belonging to the harness rather than the
        // product. Node's server.cjs works this out from its own __dirname.
        env: Object.assign({}, process.env, { WINMUX_PORT: String(port), WINMUX_PUBLIC: path.join(ROOT, 'public'), WINMUX_INSTANCE_FILE: path.join(OUT, 'inst-' + port + '.json'), WINMUX_TRUST_FILE: trustFile(port), WINMUX_CONFIG_FILE: configFile(port), WINMUX_CLI_DIR: path.join(ROOT, 'bin'), WINMUX_APP_EXE: process.execPath }, extraEnv || {}),
        stdio: 'ignore',
      })
    : spawn(process.execPath, ['server.cjs'], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { PORT: String(port), WINMUX_TRUST_FILE: trustFile(port), WINMUX_CONFIG_FILE: configFile(port), WINMUX_NO_INSTANCE: '1' }, extraEnv || {}),
        stdio: 'ignore',
      });
  await waitUp(port, 15000);
  return { port, borrowed: false, stop() { try { proc.kill(); } catch (e) {} } };
}

// Every no-port server this run spawned. These are the only servers in the
// suite that choose their own port, and they choose it from server.cjs's
// SHIPPED candidate list — which overlaps the harness's own ports on purpose,
// because that list is what is under test. So one that survives the run does
// not merely leak a process: it squats on a port the NEXT run needs. That is
// not hypothetical. pid 35216 outlived its parent, held 9912, and the next
// run's `port` check reported it as a failure of the product.
const AUTO_PROCS = [];

// Kill every one of them and CONFIRM it died. `proc.kill()` is a request, not
// a guarantee — escalate by PID for any that ignored it. By PID only: Edward
// runs his own WinMux and node processes beside this suite, so killing by
// image name would take down his work to tidy up ours.
async function reapAutoServers() {
  const alive = () => AUTO_PROCS.filter((p) => p.pid && p.exitCode === null && p.signalCode === null);
  for (const p of alive()) { try { p.kill(); } catch (e) {} }
  await new Promise((r) => setTimeout(r, 1200));
  const stubborn = alive();
  for (const p of stubborn) {
    try { execSync('taskkill /PID ' + p.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) {}
  }
  if (stubborn.length) {
    console.log('reaped ' + stubborn.length + ' auto-port server(s) that ignored the soft kill: ' +
      stubborn.map((p) => p.pid).join(', '));
  }
}

// Start a server with NO port forced, and read back the port it chose for
// itself. Never borrows a running server — the choice IS the thing under test.
function serverAuto() {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, { WINMUX_TRUST_FILE: trustFile('auto'), WINMUX_NO_INSTANCE: '1' });
    delete env.PORT;
    const proc = spawn(process.execPath, ['server.cjs'], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Registered before anything can go wrong, so the end-of-run reap covers
    // the paths a `finally` cannot: a check that throws before it, a timeout
    // that rejects, or a spawn whose announcement never arrives.
    AUTO_PROCS.push(proc);
    let buf = '';
    const timer = setTimeout(() => {
      try { proc.kill(); } catch (e) {}
      reject(new Error('auto-port server never announced itself'));
    }, 20000);
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (!m) return;
      clearTimeout(timer);
      resolve({ port: Number(m[1]), log: buf, stop() { try { proc.kill(); } catch (e) {} } });
    });
  });
}

// ------------------------------------------------------------------ checks
// Each check gets a fresh page, records its own results, and never assumes a
// server is already running. `port` says which of the two it needs.

const CHECKS = [];

// ---- Tier 0: the ports are not trusted to a reader -------------------------
// Servers are memoised per port, so two checks on one port means the second one
// silently receives the FIRST one's server, built for the first one's
// conditions, and grades that. The harness doing the exact thing it exists to
// catch the product doing. It is also invisible: the run stays green until
// scheduling puts the wrong check first, then a red appears somewhere unrelated
// and moves the next time.
//
// Some checks DO share a server on purpose and the refcount in `owed` exists for
// them. Sharing is fine when intended; the danger is sharing nobody meant. So
// intent is written down here, and a pair not on this list is a mistake by
// definition.
const SHARED_ON_PURPOSE = {
  brand: 1, fresh: 1, busyport: 1, launchfail: 1, reason: 1,  // all ride the PORT_BUSY server
  electron: 1, groups: 1,
  onboard: 1, profile: 1,
};
// Not every port in this file flows through check(). The exhaustion test binds
// PORTS_EXHAUST itself; a check quietly assigned one of those numbers dies with
// a raw EADDRINUSE from inside an unrelated check. Seed them so the guard sees
// the whole picture, not the half that happens to be registered.
const PORT_OWNER = new Map();
PORTS_EXHAUST.forEach((p) => PORT_OWNER.set(p, 'the port-exhaustion test'));

// Chromium refuses to navigate to a short list of ports (kRestrictedPorts) and
// says so as ERR_UNSAFE_PORT, which arrives looking like a product failure. A
// port being free is not the same as a port being usable: 10080 is free on this
// machine and the browser will not go there. Nothing in this file can land on
// one at base 0 — closeverb is 9980 — so it took a shifted run to find it, three
// checks from the end of twelve minutes. Cheaper to know at startup.
const BROWSER_REFUSES = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

// A check may carry an env override for its server (last arg) — e.g. the update
// check forces WINMUX_FAKE_LATEST so the badge can be proven without a real release.
const check = (id, port, run, env) => {
  if (BROWSER_REFUSES.has(port)) {
    console.error('\n"' + id + '" would run on port ' + port + ', which the browser refuses to open'
      + ' (ERR_UNSAFE_PORT).' + (PORT_BASE ? '\nWINMUX_VERIFY_PORT_BASE=' + PORT_BASE + ' put it there; '
        + (port - PORT_BASE) + ' is fine unshifted.' : '')
      + '\nUse a different base, or move the check.\n');
    process.exit(2);
  }
  const owner = PORT_OWNER.get(port);
  if (owner && !(SHARED_ON_PURPOSE[owner] && SHARED_ON_PURPOSE[id])) {
    console.error('\nverify.cjs is misconfigured: "' + owner + '" and "' + id + '" both claim port ' + port
      + '.\nTwo checks on one port grade each other’s server. Give one of them a free port.\n');
    process.exit(2);
  }
  PORT_OWNER.set(port, id);
  CHECKS.push({ id, port, run, env });
};

// One idiom, copy-pasted 29 times: navigate, then sleep 4500ms hoping the app
// has booted and a shell is answering. Three of today's honest-failure bugs came
// from exactly that guess losing its race under a full-suite load, and failing on
// some later assertion that had nothing to do with the cause.
//
// This waits for the condition instead. It keeps a floor so it never runs AHEAD
// of where the old sleep put it — the change may only ever wait longer, never
// shorter — and it never throws: a page with no terminal at all (onboarding,
// markdown-only) falls through at the cap, exactly as the sleep did.
async function appReady(page, floorMs, capMs) {
  const floor = floorMs === undefined ? 4500 : floorMs;
  const started = Date.now();
  await page.waitForFunction(`(function () {
    var hosts = [].slice.call(document.querySelectorAll('.term-host'))
      .filter(function (e) { return e.style.display !== 'none'; });
    var rows = (hosts[0] || document).querySelector('.xterm-rows');
    return !!rows && (rows.textContent || '').trim().length > 0;
  })()`, null, { timeout: capMs || 30000 }).catch(() => {});
  const left = floor - (Date.now() - started);
  if (left > 0) await page.waitForTimeout(left);
}

const desktop = async (browser, extraSettings) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  // Every check gets a fresh context, so the first-run onboarding would pop over
  // the UI and swallow clicks. Mark it seen everywhere except the check that tests
  // it (see the 'onboard' check, which deliberately leaves this unset).
  // Also pin the DOM renderer here: the app's features read the renderer-independent
  // term.buffer, so behavioural checks are the same on either renderer — but many
  // of these checks read .xterm-rows text, which the WebGL renderer (the shipping
  // default) paints to a <canvas> instead. Pinning DOM keeps those reads valid; the
  // 'gpu' check separately proves the WebGL path + its DOM fallback.
  await page.addInitScript((extra) => {
    try {
      localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1');
      const s = JSON.parse(localStorage.getItem('ct-settings') || '{}'); s.gpuRenderer = false;
      if (extra) Object.assign(s, extra);
      localStorage.setItem('ct-settings', JSON.stringify(s));
    } catch (e) {}
  }, extraSettings || null);
  return page;
};

async function phoneCtx(browser, colorScheme) {
  const ctx = await browser.newContext({
    viewport: { width: 384, height: 745 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, colorScheme: colorScheme || 'dark',
  });
  // Mark the first-run onboarding seen so it doesn't cover the phone UI mid-check
  // (the 'onboard' check makes its own context to test it fresh). Pin the DOM
  // renderer too (same reason as desktop(): these checks read .xterm-rows text).
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1');
      const s = JSON.parse(localStorage.getItem('ct-settings') || '{}'); s.gpuRenderer = false;
      localStorage.setItem('ct-settings', JSON.stringify(s));
    } catch (e) {}
  });
  return ctx.newPage();
}

// A screenshot of the Phone tab is a photograph of a working key — the printed
// link AND a QR anyone can scan. These images get shown to people, so blank
// both before the shutter, and report whether anything key-shaped survived.
async function redact(p) {
  return p.evaluate(() => {
    const u = document.querySelector('#phone-url');
    if (u) u.textContent = 'http://100.x.x.x:0000/?k=<redacted>';
    // Dropping the src leaves a broken-image glyph and its alt text, which
    // reads as a bug in a screenshot people are shown. Replace the square with
    // something that says, deliberately, that it was hidden on purpose.
    document.querySelectorAll('.phone-qr').forEach((box) => {
      // Size off the QR it replaces, not off the box — with the image gone the
      // box collapses, and a tall grey sliver looks like a layout bug.
      const img = box.querySelector('img');
      const r = img ? img.getBoundingClientRect() : box.getBoundingClientRect();
      const side = Math.max(150, Math.round(r.width || r.height));
      box.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;' +
        'width:' + side + 'px;height:' + side + 'px;border-radius:6px;' +
        'font:600 11px/1 system-ui,sans-serif;letter-spacing:.06em;color:#6b6b6b;' +
        'background:repeating-linear-gradient(45deg,#dcdcdc 0 7px,#d0d0d0 7px 14px)">QR HIDDEN</div>';
    });
    return !/\?k=[a-f0-9]{32}/.test(document.body.innerHTML);
  });
}

const settings = async (p, tab) => {
  // Open Settings deterministically (fixes #180). The gear can be momentarily
  // non-actionable — a load-transition pointer race on desktop, or simply not the
  // visible surface on a phone drill-in view. Try the real click first (proves a
  // human can), then fall back to the element's own click handler, which fires
  // openSettings() regardless of pointer state or which view is showing.
  const gear = p.locator('#open-settings');
  try {
    await gear.scrollIntoViewIfNeeded({ timeout: 3000 });
    await gear.click({ timeout: 4000 });
  } catch (e) {
    await p.evaluate(() => document.getElementById('open-settings').click());
  }
  await p.waitForTimeout(500);
  await p.locator('[data-settab="' + tab + '"]').click();
  await p.waitForTimeout(900);
};

// --- port: the app refuses a port it cannot fully use ---------------------
// The desk door binding is not enough. If the Tailscale side of a port is
// taken, phone access can never turn on there, so with no PORT forced the
// server must move off it by itself instead of failing politely later.
check('port', PORT_FREE, async ({ t }) => {
  const ip = tailscaleIp();
  const auto = await serverAuto();
  try {
    const answered = await get('http://127.0.0.1:' + auto.port + '/');
    t('auto-picked port really serves the desk door', answered.status === 200, auto.port);
    if (ip) {
      t('auto-picked port is free on the Tailscale side', !(await inUse(ip, auto.port)), ip + ':' + auto.port);
      if (await inUse(ip, 8799)) {
        t('auto-picked away from the busy default', auto.port !== 8799, 'chose ' + auto.port);
      } else {
        t('SKIP moved-off-default — 8799 is not busy on this tailnet', true);
      }
      // A tunnelled port is the dangerous one: a serve rule makes the whole
      // tailnet arrive looking like loopback, so the keyless desk door would
      // be handing out shells. The app must never settle on one.
      const tun = await tunnelled();
      t('auto-picked a port no tailscale serve rule forwards into',
        !tun.has(auto.port), 'chose ' + auto.port + ', tunnelled: ' + (tun.size ? [...tun].join(',') : 'none'));
      if (tun.has(8799)) {
        t('said out loud that it stepped around a serve rule',
          /serve rule/.test(auto.log), auto.log.split('\n').find((l) => /serve rule|busy on your/.test(l)));
      } else {
        t('SKIP serve-rule message — nothing tunnels 8799 on this machine', true);
      }
    } else {
      t('SKIP tailnet side — Tailscale is not running', true);
    }
  } finally { auto.stop(); }

  // The same rule with an explicit PORT: obeying it exactly would mean serving
  // a keyless shell to the tailnet, so this is the one case where an explicit
  // port is refused rather than honoured. It must refuse by exiting, not by
  // starting anyway and hoping.
  const tun2 = await tunnelled();
  const victim = [...tun2][0];
  if (victim) {
    const res = await new Promise((resolve) => {
      const proc = spawn(process.execPath, ['server.cjs'], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { PORT: String(victim), WINMUX_TRUST_FILE: trustFile('refusal') }),
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let err = '';
      proc.stderr.on('data', (d) => { err += d.toString(); });
      proc.on('exit', (code) => resolve({ code, err }));
      setTimeout(() => { try { proc.kill(); } catch (e) {} resolve({ code: null, err }); }, 15000);
    });
    t('refuses to start on a tunnelled port even when PORT forces it', res.code === 2, 'exit ' + res.code + ' for port ' + victim);
    t('the refusal explains itself in plain English', /tailscale serve/i.test(res.err) && /without a key/.test(res.err), res.err.split('\n')[1]);
  } else {
    t('SKIP tunnelled-PORT refusal — no serve rules on this machine', true);
  }

  // The other end of the hunt: every candidate taken. This used to hand back
  // the first candidate anyway — the very port it may have just refused for
  // being tunnelled — and then die on a raw EADDRINUSE stack trace. A machine
  // with a busy 88xx block is a normal machine, so the honest answer is a
  // sentence and a non-zero exit, not a crash and not a keyless tailnet door.
  // WINMUX_PORT_CANDIDATES pins the hunt to three ports this check holds
  // itself, so proving exhaustion never starves the checks running beside it.
  const holders = [];
  for (const p of PORTS_EXHAUST) {
    holders.push(await new Promise((res, rej) => {
      const s = net.createServer();
      s.once('error', rej);
      s.listen(p, '127.0.0.1', () => res({ stop() { try { s.close(); } catch (e) {} } }));
    }));
    if (ip) holders.push(await holdTailnet(p));
  }
  try {
    const res = await new Promise((resolve) => {
      const proc = spawn(process.execPath, ['server.cjs'], {
        cwd: ROOT,
        env: Object.assign({}, process.env, {
          PORT: '',
          WINMUX_PORT_CANDIDATES: PORTS_EXHAUST.join(','),
          WINMUX_TRUST_FILE: trustFile('exhaust'),
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let all = '';
      proc.stdout.on('data', (d) => { all += d.toString(); });
      proc.stderr.on('data', (d) => { all += d.toString(); });
      proc.on('exit', (code) => resolve({ code, all }));
      setTimeout(() => { try { proc.kill(); } catch (e) {} resolve({ code: null, all }); }, 20000);
    });
    t('refuses to start when every candidate port is taken', res.code === 2, 'exit ' + res.code);
    t('the exhaustion refusal is a sentence, not a stack trace', !/\n\s+at /.test(res.all), res.all.split('\n')[0]);
    t('the exhaustion refusal names the ports it tried', res.all.includes(PORTS_EXHAUST.join(', ')), res.all.split('\n')[1]);
    t('the exhaustion refusal tells you how to pick a port yourself', /\$env:PORT/.test(res.all), res.all.split('\n').find((l) => /env:PORT/.test(l)));
    t('exhaustion never falls back to serving on a candidate anyway', !/WinMux running at/.test(res.all), res.all.split('\n').find((l) => /running at/.test(l)) || 'never announced');
  } finally { holders.forEach((h) => { if (h) h.stop(); }); }

  // An explicit port is never overridden — the busy-port fixture below depends
  // on actually getting the busy port.
  const forced = await server(PORT_BUSY);
  try {
    const onBusy = await get('http://127.0.0.1:' + PORT_BUSY + '/');
    t('an explicit PORT is honoured exactly, not auto-moved', onBusy.status === 200, PORT_BUSY);
  } finally { forced.stop(); }
});

// --- brand: the name is really rendered, in the right colours -------------
check('brand', PORT_BUSY, async ({ browser, base, t, shot }) => {
  const p = await desktop(browser);
  await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4000);

  t('tab title is WinMux', (await p.title()) === 'WinMux');
  // The header no longer carries a version chip — @edward's call: the version
  // lives only in Settings → About (asserted just below), not the chrome.
  t('the version chip was removed from the header',
    (await p.locator('#version-chip').count()) === 0);

  await settings(p, 'About');
  const about = (await p.locator('#settings-pane').textContent()).replace(/\s+/g, ' ').trim();
  // The About version must be the real one (from /api/info), matching every other
  // surface — no hardcoded string that can drift out of sync with the release.
  const infoVer = await p.evaluate(() => fetch('/api/info').then((r) => r.json()).then((d) => d.version || '').catch(() => ''));
  t('About shows the live version (matches /api/info), not cockpit-terminal',
    !!infoVer && about.indexOf('WinMux v' + infoVer) !== -1 && !/cockpit-terminal/i.test(about),
    { infoVer, about: about.slice(0, 40) });
  await shot(p, 'about');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(400);
  await shot(p, 'desktop');
  t('no "cockpit-terminal" left in the desktop UI',
    !/cockpit-terminal/i.test(await p.evaluate(() => document.body.innerText)));

  // The mockup's only in-app brand slot is .nhead, which is the phone header —
  // hidden at desktop width, so it has to be measured at phone width.
  const p2 = await phoneCtx(browser);
  await p2.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await appReady(p2);
  const b = await p2.evaluate(() => {
    const el = document.querySelector('.nhead .brand');
    if (!el) return null;
    const bb = el.querySelector('b'), cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return { text: el.textContent.trim(), bText: bb.textContent, color: cs.color,
             bColor: getComputedStyle(bb).color, weight: cs.fontWeight, size: cs.fontSize,
             w: Math.round(r.width), h: Math.round(r.height),
             vis: r.width > 0 && cs.visibility === 'visible' && cs.display !== 'none' };
  });
  t('brand reads WinMux', b && b.text === 'WinMux', b);
  t('accent lands on "Mux"', b && b.bText === 'Mux');
  t('"Mux" computes to the accent purple', b && b.bColor === 'rgb(138, 92, 245)', b && b.bColor);
  t('"Win" inherits --text, distinct from the accent', b && b.color === 'rgb(218, 218, 218)' && b.color !== b.bColor);
  t('brand is visibly rendered at 12.5px/600', b && b.vis && b.h >= 10 && b.w >= 40 && b.size === '12.5px' && b.weight === '600');
  await shot(p2, 'phone');
});

// --- fresh: the browser must never serve yesterday's app ------------------
// This one is not cosmetic. The app lives at a fixed local address and gets
// rebuilt constantly, so an asset a browser is allowed to cache means the next
// visit can render a version of the app that no longer exists — which reads,
// correctly, as "the server is broken."
check('fresh', PORT_BUSY, async ({ base, t }) => {
  for (const asset of ['/', '/app.js', '/cockpit.css']) {
    const r = await get(base + asset);
    const cc = (r.headers['cache-control'] || '').toLowerCase();
    t('served ' + asset, r.status === 200, r.status);
    t(asset + ' tells the browser not to store it', cc.includes('no-store'), cc || '(no Cache-Control at all)');
  }
});

// --- busyport: a failed phone flip must not take the app down -------------
check('busyport', PORT_BUSY, async ({ browser, base, t, shot, skip }) => {
  if (!busyHold) return skip('Tailscale is not running, so there is no tailnet side to collide with');
  const p = await desktop(browser);
  await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
  // Wait for the app to actually have a shell answering before typing at it.
  // This check went straight from domcontentloaded to keystrokes and leaned on
  // the retry below to paper over the gap — which works until the suite is
  // loaded enough that twelve retries run out, and then the failure lands on
  // "a shell is alive", blaming the product for the harness being early.
  await appReady(p);
  const rows = () => p.evaluate(() =>
    [].map.call(document.querySelectorAll('.xterm-rows > div'), (d) => d.textContent).join('|'));
  // Wait for the shell to answer, not for a stopwatch. Under a full-suite load a
  // PowerShell takes longer than any interval worth guessing, and the failure
  // then lands on "a shell is alive" — a precondition, blaming the product for
  // the harness being early. `say` retries the line until its output appears.
  const say = async (text, mark) => {
    for (let i = 0; i < 12; i++) {
      await p.locator('.xterm-helper-textarea').first().focus();
      // Clear whatever is sitting at the prompt before typing. A shell that was
      // not ready for input keeps HALF the line, and the retry then types the
      // whole thing on top of that half:
      //   PS> "before " + $env:CO"before " + $env:COMPUTERNAME
      //   ParserError: Unexpected token '"before "'
      // The retry was added to survive a slow shell and instead corrupted its
      // own input, so the check failed on a line it had mangled itself. Escape
      // is PSReadLine's clear-the-line, and it is harmless on an empty prompt.
      await p.keyboard.press('Escape');
      await p.keyboard.type(text);
      await p.keyboard.press('Enter');
      try {
        await p.waitForFunction(`/${mark} \\w/.test([].map.call(
          document.querySelectorAll('.xterm-rows > div'), function (d) { return d.textContent; }).join('|'))`,
          null, { timeout: 5000 });
        return true;
      } catch (e) { /* shell not up yet — say it again */ }
    }
    return false;
  };
  t('a shell is alive before the flip', await say('"before " + $env:COMPUTERNAME', 'before'));

  await settings(p, 'Phone');
  await p.locator('[data-phone-toggle]').click();
  await p.waitForTimeout(3000);

  t('the switch stayed off — it did not lie', !/\bon\b/.test(await p.locator('[data-phone-toggle]').getAttribute('class')));
  t('the label still says Off', /^Off\b/.test((await p.locator('.frow .fhint').first().textContent()).trim()));
  const reason = await p.evaluate(() => {
    const e = document.querySelector('#phone-err');
    return e && e.innerText.replace(/\s+/g, ' ').trim();
  });
  t('a plain-English reason was shown', !!reason && /port/i.test(reason), reason);
  t('the app is still serving', (await p.evaluate(async () => (await fetch('/api/phone')).status)) === 200);

  await p.keyboard.press('Escape');
  await p.locator('.ovl[data-open]').first().waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  // Name the difference between "the terminal is broken" and "Settings is still
  // covering it and eating the keystrokes". Without this the next assertion
  // reports a dead terminal either way, and the evidence points at the product.
  const stillOpen = await p.evaluate(() =>
    [].slice.call(document.querySelectorAll('.ovl[data-open]')).map((o) => o.id).join(','));
  t('Settings actually closed, so the keys reach the terminal', !stillOpen, stillOpen);
  t('the same terminal still runs commands', await say('"after " + $env:COMPUTERNAME', 'after'));
  await shot(p, 'busyport');
});

// --- ctlbackoff: the control socket gives up gracefully, not forever ------
// AUDIT-B4. When the engine goes away, the app's /control socket used to try
// again every 1.5s with no cap and no reset — roughly 57,600 attempts a day
// against something that is not answering. The terminal socket sitting next to
// it in the same file already backed off properly; this one had never been
// given the same treatment.
//
// Measured from inside the page: wrap WebSocket before the app loads and record
// when each /control attempt is made, then take the engine away and watch the
// gaps. A flat retry keeps them all ~1500ms and fails the assertions below; a
// backing-off retry grows them.
check('ctlbackoff', PORT_CTLBACKOFF, async ({ browser, base, t }) => {
  const p = await desktop(browser);
  await p.addInitScript(() => {
    window.__ctl = [];
    const Real = window.WebSocket;
    window.WebSocket = function (url, protos) {
      if (String(url).indexOf('/control') !== -1) window.__ctl.push(Date.now());
      return protos === undefined ? new Real(url) : new Real(url, protos);
    };
    window.WebSocket.prototype = Real.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k, i) => { window.WebSocket[k] = i; });
  });
  await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await appReady(p);
  const opened = await p.evaluate(() => window.__ctl.length);
  t('the app opens a control socket at all — otherwise this check proves nothing',
    opened >= 1, opened);

  // Take the engine away. Everything after this is the app talking to nothing,
  // which is the situation the backoff exists for.
  SERVERS[PORT_CTLBACKOFF].stop();
  await p.evaluate(() => { window.__ctl = []; });
  await p.waitForTimeout(40000);
  const stamps = await p.evaluate(() => window.__ctl.slice());
  const gaps = stamps.slice(1).map((s, i) => s - stamps[i]);
  t('it keeps trying to get back — a dead control socket is not abandoned',
    stamps.length >= 3, { attempts: stamps.length, gaps });
  // These thresholds are MEASURED against the old code, not guessed. Putting the
  // flat retry back gives ~10 attempts over 40s with every gap near 4000ms —
  // 4000 and not 1500, because a refused connection takes ~2.5s to fail before
  // the wait even starts. An earlier version of this check asserted "<= 8
  // attempts" and passed at 6 with the bug still in, which is exactly the kind
  // of assertion that certifies nothing. The backoff gives ~5 attempts and a
  // final gap past 9s; the flat retry cannot produce either.
  t('but it backs off instead of hammering — no fixed-interval retry forever',
    stamps.length <= 7, { attempts: stamps.length, gaps });
  t('and the waits actually grow, rather than sitting on one interval',
    gaps.length >= 2 && gaps[gaps.length - 1] > 9000, gaps);
  t('and it is capped, so it never stops trying altogether',
    gaps.every((g) => g <= 40000), gaps);
});

// --- clihere: the command the agents guide teaches actually runs -----------
// AUDIT-9. The guide says "from any WinMux terminal: winmux agent spawn …" and
// on an installed copy that command did not exist by any route — a .cjs sealed
// inside app.asar, on a machine with no Node. This types it into a real shell,
// because the only proof that matters is the one the guide describes.
check('clihere', PORT_CLIHERE, async ({ browser, base, t, shot }) => {
  const p = await desktop(browser);
  await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await appReady(p);

  const screen = () => p.evaluate(() => {
    const el = document.querySelector('.xterm-rows') || document.querySelector('.term');
    return el ? el.innerText.replace(/ /g, ' ') : '';
  });
  const say = async (text) => {
    await p.locator('.xterm-helper-textarea').first().focus();
    await p.keyboard.press('Escape');          // clear a half-typed line (busyport's lesson)
    await p.keyboard.type(text);
    await p.keyboard.press('Enter');
  };

  // The guide's own words, run verbatim in the place it names. `status` is the
  // read-only verb — it proves the whole path (shell finds the command, the
  // command finds the running app) without spawning an agent.
  await say('winmux status --json');
  await p.waitForFunction(() => {
    const el = document.querySelector('.xterm-rows') || document.querySelector('.term');
    const s = el ? el.innerText : '';
    return /"port"/.test(s) || /not recognized|CommandNotFound|cannot find/i.test(s);
  }, null, { timeout: 30000 }).catch(() => {});
  const out = await screen();

  t('the shell finds `winmux` — the command the guide teaches is on the PATH it promised',
    !/not recognized|CommandNotFound|is not recognized/i.test(out), out.slice(-400));
  t('and running it reaches the live app, rather than printing an error',
    /"port"\s*:/.test(out), out.slice(-400));
  const port = (out.match(/"port"\s*:\s*(\d+)/) || [])[1];
  t('and it answers about THIS app, not some other instance it happened to find',
    String(port) === String(new URL(base).port), { reported: port, expected: new URL(base).port });
  await shot(p, 'clihere-status');
});

// --- keytruth: the app never teaches a key the terminal is going to eat ----
// AUDIT-2. Three actions shipped with defaults the app's own "terminal is king"
// guard throws away — Split right on Ctrl+D, Find on Ctrl+F, Toggle sidebar on
// Ctrl+B — and every surface advertised them anyway. The first assertion here is
// the structural one: it compares the defaults against the guard's own list, so
// it fails on a fourth instance without anyone thinking to test for it. The rest
// walk the real path, because "the table looks right" is not "the key works".
check('keytruth', PORT_KEYTRUTH, async ({ browser, base, t, shot }) => {
  const p = await desktop(browser);
  // Record what the page actually sends to the shell. Watching whether the app
  // swallowed the keydown is not good enough — xterm stops the event
  // propagating, so a listener never sees it either way and the assertion
  // reads undefined, which is not the same as "the terminal got it".
  await p.addInitScript(() => {
    window.__sent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        const m = JSON.parse(data);
        if (m && m.t === 'i') window.__sent.push(m.d);
      } catch (e) {}
      return send.apply(this, arguments);
    };
  });
  await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await appReady(p);
  await p.waitForFunction(() => !!window.__winmuxTerminalChords && !!window.__winmuxKeymap, null, { timeout: 15000 });

  // 1. Structural. No action may sit on a chord the guard hands to the shell.
  const clash = await p.evaluate(() => {
    const owned = window.__winmuxTerminalChords();
    return window.__winmuxKeymap().effective.filter((a) => owned.indexOf(a.chord) >= 0);
  });
  t('no shortcut is bound to a key the terminal takes — the app cannot advertise a dead key',
    clash.length === 0, clash);

  const panes = () => p.evaluate(() => document.querySelectorAll('.pane').length);
  const focusTerm = () => p.locator('.xterm-helper-textarea').first().focus();
  // The app spells the Ctrl modifier "Ctrl"; Playwright insists on "Control".
  // Press what the app says is bound, not a chord retyped by hand here — a
  // hand-typed one would keep passing after the binding moved.
  const press = async (id) => {
    const chord = await p.evaluate((x) =>
      (window.__winmuxKeymap().effective.find((a) => a.id === x) || {}).chord, id);
    await p.keyboard.press(String(chord).replace(/^Ctrl\+/, 'Control+'));
    return chord;
  };
  const chordFor = (id) => p.evaluate((x) =>
    (window.__winmuxKeymap().effective.find((a) => a.id === x) || {}).chord, id);

  // 2 & 3. Both split directions fire, from a focused terminal, which is the
  // only state that matters. They were advertised side by side with one real.
  await focusTerm();
  const before = await panes();
  const rightChord = await press('split-right');
  await p.waitForTimeout(900);
  const afterRight = await panes();
  t('Split right actually splits, pressed from inside the terminal',
    afterRight === before + 1, { before, afterRight, chord: rightChord });

  await focusTerm();
  await press('split-down');
  await p.waitForTimeout(900);
  const afterDown = await panes();
  t('and so does Split down — the two directions behave the same way',
    afterDown === afterRight + 1, { afterRight, afterDown });

  // 4. Find, the other action that was stranded on a terminal key.
  await focusTerm();
  const findChord = await press('find');
  await p.waitForTimeout(600);
  const findOpen = await p.evaluate(() => !!document.querySelector('.findbar.on'));
  t('Find opens from its shortcut too', findOpen, { chord: findChord });
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);

  // 5. The guard still works. This fix must not have bought working shortcuts by
  // quietly taking Ctrl+D back off the shell — that was the whole reason those
  // keys were given away, and losing it would be a worse bug than the one fixed.
  await focusTerm();
  const paneCountBeforeD = await panes();
  await p.evaluate(() => { window.__sent.length = 0; });
  await p.keyboard.press('Control+d');
  await p.waitForTimeout(600);
  // Ctrl+D is EOT — the shell sees byte 0x04. If the app had grabbed the key
  // to run an action, nothing would go down the wire at all.
  const gotEot = await p.evaluate(() => window.__sent.some((d) => String(d).indexOf('') >= 0));
  const paneCountAfterD = await panes();
  t('Ctrl+D still reaches the shell — terminal is king, and this fix did not take that back',
    gotEot && paneCountAfterD === paneCountBeforeD,
    { sentEot: gotEot, panesBefore: paneCountBeforeD, panesAfter: paneCountAfterD });

  // 6. The lie cannot be recreated by hand. Settings used to happily accept
  // Ctrl+D and then show it bound forever.
  await p.evaluate(() => window.__winmuxRebind('split-right'));
  await p.waitForTimeout(400);
  await p.keyboard.press('Control+d');
  await p.waitForTimeout(400);
  const err = await p.evaluate(() => {
    const e = document.querySelector('#dlg-body .dlg-err');
    return e ? e.textContent.trim() : null;
  });
  t('Rebind refuses a terminal key and says why, instead of storing a dead binding',
    /belongs to the terminal/.test(err || ''), err);
  await shot(p, 'keytruth-rebind-refused');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  const stillReal = await chordFor('split-right');
  t('and the refusal left the working binding alone', stillReal === 'Ctrl+Shift+R', stillReal);

  // 7. Nor by hand-editing the config file, which is the one path with no human
  // in the loop — and which is how an existing user carrying an old default
  // gets migrated onto a key that works.
  const adopted = await p.evaluate(() =>
    window.__winmuxAdoptKeymap({ find: 'Ctrl+F', 'close-tab': 'Ctrl+Alt+7' }));
  t('a config file offering a terminal key is dropped, the good entry beside it kept',
    adopted && adopted.find === undefined && adopted['close-tab'] === 'Ctrl+Alt+7', adopted);
});

// --- cliclose: the command surface can put a layout back, not only grow it --
// AUDIT-T4. The CLI had fifteen verbs and not one of them closed anything.
// new-tab and split created; everything else read. So an agent driving WinMux —
// which is the thing this product exists for — could only ever ADD panes and
// tabs, and the only way back was a person reaching for a mouse. The closing
// code was already there and working; it just could not be reached from
// outside the window.
//
// The test is the round trip, not the verb: grow a layout the way an agent
// would, then put it back the same way. A `close` that works only from a clean
// single-tab start would have passed a thinner check and still left the real
// case — undoing your own mess — broken.
check('cliclose', PORT_CLICLOSE, async ({ browser, base, t, shot }) => {
  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_CLICLOSE), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = '';
    proc.stdout.on('data', (d) => { o += d; });
    proc.stderr.on('data', (d) => { e += d; });
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });
  const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  const count = async () => {
    const r = parse((await winmux(['list', '--json'])).out);
    return r && r.sessions ? r.sessions.length : -1;
  };
  const panes = () => page.evaluate(() => document.querySelectorAll('.pane').length);

  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await appReady(page);

  t('the help says the verb exists, so someone can find it',
    /close \[id\]/.test((await winmux(['--help'])).out + (await winmux([])).out));

  // Grow it, the way an agent building a workspace would.
  const start = await count();
  await winmux(['new-tab']);
  await winmux(['split', 'right']);
  // A second tab in the NEW pane, deliberately. A pane collapses when its last
  // visible tab closes — correct behaviour, and it hid the pane case here: the
  // first version of this check split once, closed that pane's only tab, and the
  // pane went with it, so "close --pane" then had nothing to close and the
  // last-pane refusal fired instead. Two tabs keeps the two cases separable.
  await winmux(['new-tab']);
  await page.waitForTimeout(2000);
  const grown = await count(), grownPanes = await panes();
  t('the layout grew first — otherwise closing proves nothing',
    grown > start && grownPanes > 1, { start, grown, panes: grownPanes });

  // 1. Close one tab by id, and check the count really moved.
  const list = parse((await winmux(['list', '--json'])).out);
  const victim = list.sessions[list.sessions.length - 1];
  const closed = await winmux(['close', String(victim.id), '--json']);
  await page.waitForTimeout(900);
  const afterTab = await count();
  t('closing a tab by id actually closes it', closed.code === 0 && afterTab === grown - 1,
    { code: closed.code, before: grown, after: afterTab, err: closed.err });

  // 2. Close the pane, which takes its tabs with it.
  const beforePanes = await panes();
  const cp = await winmux(['close', '--pane', '--json']);
  await page.waitForTimeout(900);
  const afterPanes = await panes();
  t('closing a pane removes the pane, not just what is in it',
    cp.code === 0 && afterPanes === beforePanes - 1, { code: cp.code, beforePanes, afterPanes, err: cp.err });

  // 3. The last pane must be refused OUT LOUD. The underlying closePane() just
  //    returns when it is the only one, which is right for a click and wrong for
  //    a command: printing "closed" when nothing closed is the dishonesty this
  //    project keeps catching in itself.
  const lastly = await winmux(['close', '--pane', '--json']);
  t('the last pane is refused, not silently reported as closed',
    lastly.code !== 0, { code: lastly.code, out: lastly.out.slice(0, 120), err: lastly.err.slice(0, 160) });
  t('and the refusal says why, in a sentence',
    /only pane/.test(lastly.err + lastly.out), (lastly.err || lastly.out).slice(0, 160));
  t('and the pane it refused to close is still there',
    (await panes()) === afterPanes, await panes());

  // 4. An id that does not exist is an error, not a shrug that closes something else.
  const bogus = await winmux(['close', '99999', '--json']);
  t('a bad id is an error, never a quiet close of the wrong tab',
    bogus.code !== 0 && /no such terminal/.test(bogus.err + bogus.out), bogus.err.slice(0, 120));
  await shot(page, 'cliclose-after');
  await page.close();
});

// --- cwdgone: a project whose folder moved says so, on both engines ---------
// AUDIT-B10, and a second defect found while measuring it.
//
// Opening a project whose directory had been moved, renamed or deleted gave you
// a shell in your HOME folder and looked completely normal. You could type a
// destructive command believing you were somewhere else entirely.
//
// Measuring it on both engines — rather than reading the source — turned up
// worse. The Node engine at least reported the folder the shell was really in.
// THE SHIPPED ENGINE REPORTED THE FOLDER THAT DOES NOT EXIST: meta.cwd came
// back as the requested path while the shell sat in home. That value labels the
// tab and is what save_backlog writes as the session's folder, so the recovery
// record pointed somewhere that isn't there. A silent wrong answer, on the half
// of the product people actually run, exactly like the four in audit item 5.
//
// (The first version of the probe behind this set WINMUX_CORE=rust on
// `node server.cjs` and measured Node twice — server.cjs never reads that
// variable, it IS the Node engine. The two "agreed" beautifully. Launch the
// binary you mean to measure; see P10.)
check('cwdgone', PORT_CWDGONE, async ({ browser, base, t, shot }) => {
  const GONE = 'C:/winmux-gone-' + PORT_CWDGONE;   // never created, by design
  const p = await desktop(browser);
  // Seed the saved layout BEFORE the first load, so the app restores it on the
  // way up — which is what actually happens to a person: you open WinMux and
  // yesterday's project comes back. Seeding after a load and reloading did not
  // restore it (the app had already written its own ct-live over the seed), and
  // the check then measured a plain fresh tab and blamed the fix for being
  // silent. The reproduction has to be the real one.
  await p.addInitScript((gone) => {
    try {
      localStorage.setItem('ct-live', JSON.stringify({
        v: 4, group: '',
        cols: [[{ active: 0, tabs: [{ type: 'terminal', group: '', title: '',
          shell: 'powershell', cwd: gone, sid: '', resume: '', resumeId: '', resumePin: false }] }]],
      }));
    } catch (e) {}
  }, GONE);
  try {
    await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await appReady(p);
    t('the folder this check depends on really is absent', !fs.existsSync(GONE), GONE);

    // 1. Ask the engine directly, from inside the page, so this runs against
    //    whichever engine the suite is pointed at without a node-side ws client.
    const meta = await p.evaluate((gone) => new Promise((resolve) => {
      const url = location.origin.replace(/^http/, 'ws') + '/pty?shell=powershell&cwd=' + encodeURIComponent(gone);
      const ws = new WebSocket(url);
      const bell = setTimeout(() => { try { ws.close(); } catch (e) {} resolve({ timedOut: true }); }, 15000);
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string' || e.data.charAt(0) !== '{') return;
        try {
          const j = JSON.parse(e.data);
          if (j.type === 'meta') { clearTimeout(bell); try { ws.close(); } catch (err) {} resolve(j); }
        } catch (err) {}
      };
      ws.onerror = () => { clearTimeout(bell); resolve({ error: true }); };
    }), GONE);
    t('the engine names the folder it could not use', meta.cwdLost === GONE, meta);
    // The one that was wrong on the shipped engine: it must report where the
    // shell IS, never the folder it failed to reach.
    t('and reports where the shell actually is, not the folder that is gone',
      !!meta.cwd && meta.cwd !== GONE, meta.cwd);

    // 2. The path a person actually takes: a saved layout pointing at a folder
    //    that has since moved. Restoring it must say so in the terminal.
    // Read the NOTIFICATION, not the terminal. The in-terminal line is written
    // too, but a terminal is repainted by the shell that owns it — the first
    // version of this check asserted the line and went red because the cold
    // shell's startup clear wiped it a frame later. More to the point, that line
    // is only telling you anything if you happen to be looking at that tab, and
    // restoring a project can reopen several at once. The bus is the durable half,
    // so the bus is what gets asserted.
    // The badge first: it is the signal a person actually sees without opening
    // anything, and it does not depend on the panel rendering.
    const badge = await p.evaluate(() => {
      const b = document.getElementById('notif-badge');
      return b ? { shown: b.style.display !== 'none', text: b.textContent } : null;
    });
    t('the unread badge lights up, so you can see it happened without hunting',
      !!badge && badge.shown, badge);
    // Then the panel. Clicking it through evaluate rather than a real click, the
    // same way the notifications check does — a Playwright click here races the
    // sidebar's own layout and silently misses, which is how an earlier version
    // of this check read an empty list and blamed the fix.
    await p.evaluate(() => { const b = document.getElementById('open-notif'); if (b) b.click(); });
    await p.waitForTimeout(900);
    const notes = await p.evaluate(() =>
      [].slice.call(document.querySelectorAll('.nrow')).map((n) => ({
        title: (n.querySelector('.nt') || {}).textContent || '',
        sub: (n.querySelector('.nws') || {}).textContent || '',
      })));
    const hit = notes.find((n) => /folder not found/i.test(n.title));
    t('reopening it tells you the folder is gone, instead of looking normal', !!hit, notes);
    t('and it names the folder you lost, so you know which project this was',
      !!hit && hit.sub.indexOf(GONE) >= 0, hit && hit.sub);
    t('and it says where you ended up instead',
      !!hit && /opened in /.test(hit.sub), hit && hit.sub);
    await shot(p, 'cwdgone-told');
  } finally {
    await p.close();
  }
});

// --- fleetopen: the fleet list is visible, remembers, and can be shown to you
// AUDIT-B6 + AUDIT-B7. Two defects with one shape: the sidebar's whole job is to
// show you your sessions, and it did neither half of that.
//
//   B6  Every group shipped CLOSED, and which ones you opened lived only in a
//       variable — so the fleet list, the product's core claim, opened as a rail
//       of folder names with nothing under them, and re-closed itself on every
//       reload. You re-opened the same group forever.
//   B7  The agents guide's own "Show me the sidebar" button only toggled the
//       sidebar when it was shut. It ships open. So the button that the guide
//       sends a brand-new user to did nothing whatsoever: the overlay closed,
//       nothing moved, and the first control they ever pressed looked broken.
//
// The point of testing them together is that B7's fix is only true if B6's is:
// "show me the sidebar" has to end with sessions actually on screen.
check('fleetopen', PORT_FLEETOPEN, async ({ browser, base, t, shot }) => {
  const p = await desktop(browser);
  // Read the fleet the way a person does — is there anything under the group.
  const kids = () => p.evaluate(() => document.querySelectorAll('.skids .srow').length);
  const caretOpen = () => p.evaluate(() =>
    !!document.querySelector('.pexpand[data-open2]'));
  try {
    await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await appReady(p);

    // 1. Out of the box. A fresh profile is exactly what a new user has, and it
    //    is the state the audit found shut.
    t('the fleet list opens showing your sessions, not a shut rail of folder names',
      (await kids()) > 0 && (await caretOpen()), { rows: await kids(), caret: await caretOpen() });
    await shot(p, 'fleetopen-first-run');

    // 2. Closing it is a choice and must stick. Testing the close direction too
    //    matters: "always open on load" would pass an open-only assertion while
    //    overriding the user every single time, which is the opposite bug.
    await p.click('.pexpand');
    await p.waitForTimeout(300);
    t('collapsing a group really collapses it', (await kids()) === 0, await kids());
    await p.reload({ waitUntil: 'domcontentloaded' });
    await appReady(p);
    t('and a reload respects that — it does not spring back open',
      (await kids()) === 0 && !(await caretOpen()), { rows: await kids(), caret: await caretOpen() });

    // 3. The other direction, which is the one B6 actually broke.
    await p.click('.pexpand');
    await p.waitForTimeout(300);
    await p.reload({ waitUntil: 'domcontentloaded' });
    await appReady(p);
    t('re-opening it survives a reload too — the choice is remembered both ways',
      (await kids()) > 0 && (await caretOpen()), { rows: await kids(), caret: await caretOpen() });

    // 4. B7, set up in the precise state where it used to be a no-op: sidebar
    //    already open (the shipped default) and the group closed, so the only
    //    honest pass is the button changing something visible.
    await p.click('.pexpand');
    await p.waitForTimeout(300);
    const sidebarOpen = await p.evaluate(() =>
      document.getElementById('root').getAttribute('data-sidebar') === 'open');
    t('the setup is the dead case: sidebar already open, nothing under the group',
      sidebarOpen && (await kids()) === 0, { sidebarOpen, rows: await kids() });

    await p.evaluate(() => {
      const o = document.getElementById('agents-ovl');
      if (o) { o.setAttribute('data-open', ''); o.classList.add('in'); }
    });
    await p.waitForTimeout(200);
    await p.click('#wc-ag-fleet');
    await p.waitForTimeout(500);
    t('"Show me the sidebar" actually shows it — sessions are on screen afterwards',
      (await kids()) > 0, await kids());
    t('and it lands you on the Sessions rail, which is what the guide was pointing at',
      await p.evaluate(() => {
        const a = document.querySelector('.sessions');
        return !a || a.getAttribute('data-sxtab') !== 'notif';
      }));
    t('the guide overlay closed behind it, rather than staying up over the thing it showed you',
      await p.evaluate(() => {
        const o = document.getElementById('agents-ovl');
        return !o || !o.hasAttribute('data-open');
      }));
    await shot(p, 'fleetopen-after-guide-button');
  } finally {
    await p.close();
  }
});

// --- reason: the failure block's mechanics, measured not eyeballed --------
check('reason', PORT_BUSY, async ({ browser, base, t, shot, skip }) => {
  // Same manufactured collision as busyport, from the same run-long hold: the
  // reason only exists because the flip failed, so the harness has to cause the
  // failure rather than wait for a machine where it happens to be true.
  if (!busyHold) return skip('Tailscale is not running, so there is no tailnet side to collide with');
  const p = await desktop(browser);
  await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
  await settings(p, 'Phone');
  t('no reason shown before anything fails', (await p.locator('#phone-err').count()) === 0);

  await p.locator('[data-phone-toggle]').click();
  await p.waitForTimeout(3000);
  const m = await p.evaluate(() => {
    const e = document.querySelector('#phone-err');
    if (!e) return null;
    const cs = getComputedStyle(e), r = e.getBoundingClientRect();
    const sw = document.querySelector('[data-phone-toggle]').getBoundingClientRect();
    return { color: cs.color, fs: cs.fontSize, w: Math.round(r.width), h: Math.round(r.height),
             below: Math.round(r.top - sw.bottom), role: e.getAttribute('role'),
             text: e.innerText.replace(/\s+/g, ' ').trim().length };
  });
  t('it renders with real size', !!m && m.w > 200 && m.h >= 28, m);
  t('it uses the error colour (--err)', !!m && m.color === 'rgb(251, 70, 76)');
  t('it sits under the switch it explains', !!m && m.below >= 0 && m.below < 40);
  t('it is announced to screen readers', !!m && m.role === 'alert');
  t('it carries a real sentence', !!m && m.text > 40);
  await shot(p, 'reason');

  await p.locator('[data-settab="About"]').click();
  await p.waitForTimeout(400);
  await p.locator('[data-settab="Phone"]').click();
  await p.waitForTimeout(900);
  t('a stale reason clears when you come back', (await p.locator('#phone-err').count()) === 0);
});

// --- phone: the whole two-door flow, on a port whose tailnet side is free --
check('phone', PORT_PHONE, async ({ browser, base, t, shot, skip }) => {
  const ip = tailscaleIp();
  if (!ip) return skip('Tailscale is not running on this PC');
  if (await inUse(ip, PORT_PHONE)) return skip('something already holds ' + ip + ':' + PORT_PHONE);

  const p = await desktop(browser);
  await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await appReady(p);
  await settings(p, 'Phone');

  t('it starts off', !/\bon\b/.test(await p.locator('[data-phone-toggle]').getAttribute('class')));
  const offText = (await p.locator('.phone-off').textContent().catch(() => '')) || '';
  t('it explains what it does', /scan/i.test(offText) && /Tailscale/i.test(offText));

  await p.locator('[data-phone-toggle]').click();
  await p.waitForTimeout(2200);
  t('the switch reads on', /\bon\b/.test(await p.locator('[data-phone-toggle]').getAttribute('class')));
  t('the label agrees with the switch', /^On\b/.test((await p.locator('.frow .fhint').first().textContent()).trim()));

  const qr = await p.evaluate(() => {
    const i = document.querySelector('.phone-qr img');
    if (!i) return null;
    const r = i.getBoundingClientRect();
    return { w: Math.round(r.width), complete: i.complete, nw: i.naturalWidth };
  });
  t('a real QR rendered', !!qr && qr.w >= 120 && qr.complete && qr.nw > 0, qr);

  const url = (await p.locator('#phone-url').textContent()).trim();
  t('the link is a tailnet URL carrying a key', /^http:\/\/100\.\d+\.\d+\.\d+:\d+\/\?k=[a-f0-9]{32}$/.test(url),
    url.replace(/k=.*/, 'k=…'));

  // Copy link must give visible feedback (the copy worked before, but notify()
  // only pinged the silent bell, so a click looked dead — the reported bug).
  await p.locator('[data-act="phone-copy"]').click();
  await p.waitForTimeout(150);
  t('Copy link confirms right on the button', /copied/i.test((await p.locator('[data-act="phone-copy"]').textContent()).trim()),
    (await p.locator('[data-act="phone-copy"]').textContent()).trim());
  await p.waitForTimeout(1800);
  t('and the button label settles back to Copy link', /^Copy link$/.test((await p.locator('[data-act="phone-copy"]').textContent()).trim()));

  t('the shot of the Phone tab carries no live key', await redact(p));
  await shot(p, 'phone-on');

  // The point of the whole feature: that link opens a real shell.
  const p2 = await phoneCtx(browser);
  await p2.goto(url, { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(5500);
  await p2.locator('.xterm-helper-textarea').first().focus();
  await p2.keyboard.type('"phone says " + $env:COMPUTERNAME');
  await p2.keyboard.press('Enter');
  await p2.waitForTimeout(3000);
  const said = await p2.evaluate(() =>
    [].map.call(document.querySelectorAll('.xterm-rows > div'), (d) => d.textContent.trim())
      .filter((r) => /phone says/.test(r)));
  t('a real shell answers over the link', said.some((r) => /phone says \w/.test(r)), said);
  await shot(p2, 'phone-shell');

  // Nobody holding the link can widen their own access.
  const guard = await p2.evaluate(async () => {
    const r = await fetch('/api/phone', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: false }) });
    return { status: r.status, canChange: (await (await fetch('/api/phone')).json()).canChange };
  });
  t('the phone cannot flip the switch', guard.status === 403 && guard.canChange === false, guard);

  const back = p2.locator('.pane.focused .nbar .back').first();
  if (await back.isVisible().catch(() => false)) { await back.click(); await p2.waitForTimeout(600); }
  await settings(p2, 'Phone');
  t('the switch is visibly disabled on the phone, and says why',
    /off-disabled/.test(await p2.locator('[data-phone-toggle]').getAttribute('class')) &&
    /only works at the PC/i.test(await p2.locator('.frow .fhint').first().textContent()));
  await shot(p2, 'phone-settings');

  await p.locator('[data-phone-toggle]').click();
  await p.waitForTimeout(2000);
  t('flipping it back reads off', !/\bon\b/.test(await p.locator('[data-phone-toggle]').getAttribute('class')));
  t('the label agrees again', /^Off\b/.test((await p.locator('.frow .fhint').first().textContent()).trim()));
  await shot(p, 'phone-off');

  const p3 = await (await browser.newContext()).newPage();
  let dead = false;
  try { const r = await p3.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 }); dead = !r || r.status() >= 400; }
  catch (e) { dead = true; }
  t('the old link is dead', dead);
});

// --- remote: the link works FROM the tailnet, and only with its key -------
// Everything else talks to 127.0.0.1. This group talks to the Tailscale
// address the way Edward's phone does, because that is the thing being
// claimed, and a claim proved on the desk door is not proved at all.
check('remote', PORT_REMOTE, async ({ browser, base, t, shot, skip }) => {
  const ip = tailscaleIp();
  if (!ip) return skip('Tailscale is not running on this PC');
  if (await inUse(ip, PORT_REMOTE)) return skip('something already holds ' + ip + ':' + PORT_REMOTE);

  // Open the phone door from the desk door — the only place allowed to.
  const opened = JSON.parse((await post(base + '/api/phone', JSON.stringify({ on: true }))).body);
  t('the desk door opened the phone door', opened.ok === true && opened.on === true);
  const url = opened.url || '';
  t('it handed back a tailnet link with a key',
    new RegExp('^http://' + ip.replace(/\./g, '\\.') + ':' + PORT_REMOTE + '/\\?k=[a-f0-9]{32}$').test(url),
    url.replace(/k=.*/, 'k=…'));
  const key = (url.match(/k=([a-f0-9]{32})/) || [])[1];
  const origin = 'http://' + ip + ':' + PORT_REMOTE;

  try {
    // The door is shut to anyone without the key — tested over the tailnet.
    const bare = await get(origin + '/');
    t('no key over the tailnet is refused', bare.status === 401, bare.status);
    t('the refusal is plain English, not a stack trace', /needs its access key/.test(bare.body), bare.body.slice(0, 60));

    // Typing the address by hand is how people actually arrive here, so the
    // refusal has to name the fix, not just the problem.
    const asPerson = await get(origin + '/', { accept: 'text/html' });
    t('a person gets a page, not a bare line', asPerson.status === 401 && /^<!doctype html>/i.test(asPerson.body.trim()));
    t('it says where to get the key', /Settings/.test(asPerson.body) && /scan the QR/i.test(asPerson.body.replace(/&\w+;/g, ' ')));
    t('it still carries the original sentence', /needs its access key/.test(asPerson.body));
    t('the page leaks no key', !/[a-f0-9]{32}/.test(asPerson.body));

    const wrong = await get(origin + '/?k=' + 'f'.repeat(32));
    t('a wrong key of the right length is refused', wrong.status === 401, wrong.status);
    t('a wrong key sets no cookie', !wrong.headers['set-cookie']);

    const right = await get(origin + '/?k=' + key);
    t('the real key is let in', right.status === 200, right.status);
    const cookie = String((right.headers['set-cookie'] || [])[0] || '');
    t('it parks the key in an HttpOnly cookie', /^ct_k=[a-f0-9]{32};/.test(cookie) && /HttpOnly/.test(cookie));
    t('the cookie is SameSite=Strict', /SameSite=Strict/.test(cookie));

    // The cookie alone must carry the rest of the page, or the app is broken
    // the moment the URL loses its ?k=.
    const viaCookie = await get(origin + '/api/phone', { cookie: 'ct_k=' + key });
    t('the cookie alone authenticates', viaCookie.status === 200, viaCookie.status);
    t('the phone is told it may not flip the switch',
      JSON.parse(viaCookie.body).canChange === false);

    // A holder of the link can never widen their own access.
    const widen = await post(origin + '/api/phone?k=' + key, JSON.stringify({ on: false }));
    t('the phone door refuses to change the switch', widen.status === 403, widen.status);
    t('the door is still open after the attempt',
      JSON.parse((await get(base + '/api/phone')).body).on === true);

    const qr = await get(origin + '/api/phone/qr?k=' + key);
    t('the QR is a real SVG over the link', qr.status === 200 && /^<svg/.test(qr.body.trim()));

    // Security (#210): even a fully authed phone must not turn the host's disk
    // into a read/enumerate surface. The file-reading endpoints are desk-door
    // only — over the tailnet they refuse, key or no key.
    const mdOverPhone = await get(origin + '/api/md?k=' + key + '&path=' + encodeURIComponent('C:/Windows/win.ini'));
    t('the phone cannot read an arbitrary file off the host', mdOverPhone.status === 403, mdOverPhone.status);
    t('and the refusal carries no file contents', !/\[fonts\]|\[extensions\]/i.test(mdOverPhone.body));
    const findOverPhone = await get(origin + '/api/findpath?k=' + key + '&name=Users');
    t('the phone cannot enumerate the host filesystem', findOverPhone.status === 403, findOverPhone.status);

    // What Edward saw when he typed the address by hand — measured, on a phone.
    const p0 = await phoneCtx(browser);
    await p0.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    const m = await p0.evaluate(() => {
      const h = document.querySelector('h1'), b = document.querySelector('.brand b');
      const steps = document.querySelectorAll('ol li');
      return h && b ? {
        head: h.textContent, accent: getComputedStyle(b).color, steps: steps.length,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        size: getComputedStyle(document.body).fontSize,
      } : null;
    });
    t('the page really renders on a phone', !!m && m.steps === 3, m);
    t('it is branded in the app accent', !!m && m.accent === 'rgb(138, 92, 245)', m && m.accent);
    t('no sideways scroll at 384px', !!m && m.overflow === false);
    await shot(p0, 'needs-key');
    await p0.close();

    // The app follows the device's light/dark setting (cockpit.css:7), so the
    // door in front of it has to as well — a dark refusal ahead of a light app
    // reads as two different products. Measured in both schemes, not asserted.
    const scheme = async (which) => {
      const q = await phoneCtx(browser, which);
      await q.goto(origin + '/', { waitUntil: 'domcontentloaded' });
      const v = await q.evaluate(() => ({
        bg: getComputedStyle(document.body).backgroundColor,
        text: getComputedStyle(document.body).color,
      }));
      await shot(q, 'needs-key-' + which);
      await q.close();
      return v;
    };
    const dark = await scheme('dark');
    const light = await scheme('light');
    t('the door is dark on a dark phone',
      dark.bg === 'rgb(30, 30, 30)' && dark.text === 'rgb(218, 218, 218)', dark);
    t('the door is light on a light phone',
      light.bg === 'rgb(255, 255, 255)' && light.text === 'rgb(35, 35, 35)', light);

    // The whole point: a phone-shaped browser, over the tailnet, running a
    // real PowerShell command on this PC.
    const p = await phoneCtx(browser);
    await p.goto(url, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(5500);
    await p.locator('.xterm-helper-textarea').first().focus();
    await p.keyboard.type('"tailnet says " + $env:COMPUTERNAME');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(3000);
    // Read the terminal BUFFER, not .xterm-rows DOM text — since SP-5 the phone
    // terminal gets the WebGL renderer once shown (canvas paint, empty row divs).
    const said = await p.evaluate(() => {
      const at = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
      if (!at || !at.term) return [];
      const b = at.term.buffer.active, out = [];
      for (let i = 0; i < b.length; i++) {
        const ln = b.getLine(i);
        if (ln) { const s = ln.translateToString(true).trim(); if (/tailnet says/.test(s)) out.push(s); }
      }
      return out;
    });
    t('a real shell answers over the tailnet', said.some((r) => /tailnet says \w/i.test(r)), said);

    // This screenshot gets shown to people, so the key must not be in it.
    const clean = await redact(p);
    t('no live key survives in the shipped screenshot', clean);
    await shot(p, 'phone');

    // Brute-force throttle (#210): a burst of wrong keys from one address gets
    // parked. Fire past the limit and the door stops even asking — it answers
    // 429, not another 401. Done last: the lockout is per-address and would
    // otherwise poison the checks above; the phone is torn down right after.
    let sawLimit = false, sawBefore = 0;
    for (let i = 0; i < 14; i++) {
      const g = await get(origin + '/?k=' + 'a'.repeat(32));
      if (g.status === 429) { sawLimit = true; break; }
      if (g.status === 401) sawBefore += 1;
    }
    t('a flood of wrong keys is throttled, not answered forever', sawLimit, { sawBefore });
    t('the throttle counts real guesses before it trips', sawBefore >= 5, sawBefore);
  } finally {
    await post(base + '/api/phone', JSON.stringify({ on: false }));
  }

  const shut = JSON.parse((await get(base + '/api/phone')).body);
  t('the door is shut again at the end', shut.on === false);
  let dead = false;
  try { await get(origin + '/?k=' + key); } catch (e) { dead = true; }
  t('the tailnet address stops answering entirely', dead);
});

// --- trust: scan once, stay in — without widening who else gets in --------
// The product claim is "the phone you already scanned keeps working." That
// only means something if it survives the two things that actually happen: a
// key rotation and a restart. Both are performed here for real.
check('trust', PORT_TRUST, async ({ browser, base, t, shot, skip }) => {
  const ip = tailscaleIp();
  if (!ip) return skip('Tailscale is not running on this PC');
  if (SERVERS[PORT_TRUST] && SERVERS[PORT_TRUST].borrowed)
    return skip('borrowed a server already on ' + PORT_TRUST + ', and a fresh guest list is the premise');
  if (await inUse(ip, PORT_TRUST)) return skip('something already holds ' + ip + ':' + PORT_TRUST);

  const origin = 'http://' + ip + ':' + PORT_TRUST;
  const state = async () => JSON.parse((await get(base + '/api/phone')).body);
  const open = async () => {
    const o = JSON.parse((await post(base + '/api/phone', JSON.stringify({ on: true }))).body);
    return (String(o.url || '').match(/k=([a-f0-9]{32})/) || [])[1];
  };
  // A real process restart, not a reasoned one — the guest list is a file, and
  // a file claim is only proved by killing the thing that wrote it.
  const restart = async () => {
    SERVERS[PORT_TRUST].stop();
    for (let i = 0; i < 40 && (await inUse('127.0.0.1', PORT_TRUST)); i++)
      await new Promise((r) => setTimeout(r, 250));
    SERVERS[PORT_TRUST] = await server(PORT_TRUST);
  };

  // 1. A fresh install trusts nobody and waives nothing.
  const fresh = await state();
  t('a fresh install remembers no phones', Array.isArray(fresh.devices) && fresh.devices.length === 0, fresh.devices);
  t('the tailnet switch ships off', fresh.trustTailnet === false);
  t('it can count the tailnet, or says it cannot',
    fresh.tailnetPeers === null || typeof fresh.tailnetPeers === 'number', fresh.tailnetPeers);

  const key1 = await open();
  try {
    // 2. Scanning once mints a durable id alongside the disposable key.
    const scan = await get(origin + '/?k=' + key1, {
      accept: 'text/html',
      'user-agent': 'Mozilla/5.0 (Linux; Android 14; SM-S938U) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36',
    });
    const set = [].concat(scan.headers['set-cookie'] || []);
    const devCookie = String(set.find((c) => /^ct_dev=/.test(c)) || '');
    const devA = (devCookie.match(/^ct_dev=([a-f0-9]{32})/) || [])[1];
    t('scanning the QR mints a device id', !!devA);
    t('the device id is built to outlive the key', /Max-Age=31536000/.test(devCookie));
    t('and it is HttpOnly, SameSite=Strict',
      /HttpOnly/.test(devCookie) && /SameSite=Strict/.test(devCookie), devCookie.replace(/=[a-f0-9]{32}/, '=…'));

    const listed = (await state()).devices;
    t('the PC lists the phone that scanned', listed.length === 1 && listed[0].id === devA, listed);
    t('it names it in plain English, not a hash', /Android/i.test(String(listed[0] && listed[0].name)), listed[0] && listed[0].name);

    // 3. The phone door can read the guest list but never edit it, and never
    // learns another device's id — an id is a credential.
    const seen = JSON.parse((await get(origin + '/api/phone/devices', { cookie: 'ct_dev=' + devA })).body);
    t('the phone can see the guest list', Array.isArray(seen.devices) && seen.devices.length === 1);
    t('without being handed anyone\'s id', seen.devices[0].id === undefined && !!seen.devices[0].name, seen.devices[0]);
    t('and is told it may not change it', seen.canChange === false);
    // Probed with the cookie, not ?k=, because that is how a phone that has
    // already scanned actually talks — and because any keyed request mints a
    // device by design, which would have made this check invent its own guests.
    const asPhone = { cookie: 'ct_dev=' + devA };
    const tryForget = await post(origin + '/api/phone/devices', JSON.stringify({ all: true }), asPhone);
    t('the phone cannot forget anyone', tryForget.status === 403, tryForget.status);
    const tryTrust = await post(origin + '/api/phone', JSON.stringify({ trustTailnet: true }), asPhone);
    t('the phone cannot waive the key for the whole tailnet', tryTrust.status === 403, tryTrust.status);
    const afterTries = await state();
    t('neither attempt changed anything',
      afterTries.trustTailnet === false && afterTries.devices.length === 1, afterTries.devices.length);

    // 4. The key rotates on every flip. That is correct for a leakable link,
    //    and it is exactly what used to lock Edward's own phone out.
    await post(base + '/api/phone', JSON.stringify({ on: false }));
    const key2 = await open();
    t('the key really did rotate', !!key2 && key2 !== key1);
    const stale = await get(origin + '/?k=' + key1);
    t('the old key is refused', stale.status === 401, stale.status);
    const remembered = await get(origin + '/', { cookie: 'ct_dev=' + devA, accept: 'text/html' });
    t('the phone that scanned once gets in with no key at all', remembered.status === 200, remembered.status);

    // 5. Restart the server for real. The door closes on boot by design; what
    //    has to survive is the guest list, not the switch.
    await restart();
    const revived = await state();
    t('the guest list survived a restart',
      revived.devices.length === 1 && revived.devices[0].id === devA, revived.devices);
    t('the phone door is shut again after a restart', revived.on === false);
    const key3 = await open();
    t('the key rotated again across the restart', !!key3 && key3 !== key2);
    const afterBoot = await get(origin + '/', { cookie: 'ct_dev=' + devA, accept: 'text/html' });
    t('and the same phone still walks in', afterBoot.status === 200, afterBoot.status);

    // 6. Remembering one phone must not quietly let in every other one.
    const stranger = await get(origin + '/', { cookie: 'ct_dev=' + 'a'.repeat(32), accept: 'text/html' });
    t('a phone that never scanned still meets the door', stranger.status === 401, stranger.status);
    t('and is told how to get in', /scan the QR/i.test(stranger.body.replace(/&\w+;/g, ' ')));

    // 7. A second, real phone: scan, get a shell, then get forgotten.
    const p = await phoneCtx(browser);
    await p.goto(origin + '/?k=' + key3, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(5500);
    await p.locator('.xterm-helper-textarea').first().focus();
    await p.keyboard.type('"trusted says " + $env:COMPUTERNAME');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(3000);
    const said = await p.evaluate(() =>
      [].map.call(document.querySelectorAll('.xterm-rows > div'), (d) => d.textContent.trim())
        .filter((r) => /trusted says/.test(r)));
    t('the scanned phone gets a real shell', said.some((r) => /trusted says \w/i.test(r)), said);
    const devB = ((await p.context().cookies()).find((c) => c.name === 'ct_dev') || {}).value;
    t('the second phone was remembered too', !!devB && devB !== devA);

    // 8. The Phone panel as Edward sees it — measured, then shipped.
    const d = await desktop(browser);
    await d.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await d.waitForTimeout(1200);
    await settings(d, 'Phone');
    const sw = await d.evaluate(() => {
      const el = document.querySelector('[data-trust-toggle]');
      if (!el) return null;
      const row = el.closest('.frow'), r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return {
        on: / on\b/.test(' ' + el.className), disabled: /off-disabled/.test(el.className),
        name: row.querySelector('.fname').textContent.trim(),
        hint: row.querySelector('.fhint').textContent.replace(/\s+/g, ' ').trim(),
        w: Math.round(r.width), h: Math.round(r.height),
        shown: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0,
      };
    });
    t('the tailnet switch is really rendered', !!sw && sw.shown && sw.w >= 30 && sw.h >= 16, sw);
    t('it reads off', !!sw && sw.on === false);
    t('it is changeable at the PC', !!sw && sw.disabled === false);
    t('its line recommends leaving it off', !!sw && /Recommended/.test(sw.hint), sw && sw.hint);
    const rows = await d.evaluate(() => [].map.call(document.querySelectorAll('.devs .devrow'), (r) => ({
      name: (r.querySelector('.devname') || {}).textContent,
      meta: ((r.querySelector('.devmeta') || {}).textContent || '').replace(/\s+/g, ' ').trim(),
      forget: !!r.querySelector('[data-act="forget"]'),
    })));
    t('both remembered phones have a row', rows.length === 2, rows);
    t('each row names it, dates it, and offers Forget',
      rows.length === 2 && rows.every((r) => r.name && /last/i.test(r.meta) && r.forget), rows);
    // The list grows. If the panel cannot reach the bottom of it, a remembered
    // phone quietly becomes unforgettable — and a screenshot of the top of a
    // clipped list looks perfectly fine, so this is measured.
    const reach = await d.evaluate(async () => {
      const rows = document.querySelectorAll('.devs .devrow');
      const last = rows[rows.length - 1];
      const pane = document.querySelector('#settings-pane');
      if (!last || !pane) return null;
      const scrolls = getComputedStyle(pane).overflowY;
      pane.scrollTop = pane.scrollHeight;
      await new Promise((r) => setTimeout(r, 400));
      const lr = last.getBoundingClientRect(), pr = pane.getBoundingClientRect();
      const btn = last.querySelector('[data-act="forget"]');
      const br = btn ? btn.getBoundingClientRect() : null;
      return {
        scrolls, inside: lr.bottom <= pr.bottom + 1 && lr.top >= pr.top - 1,
        forgetClickable: !!br && br.width >= 44 && br.height >= 20,
      };
    });
    t('the settings pane scrolls rather than clipping the list',
      !!reach && /auto|scroll/.test(reach.scrolls), reach && reach.scrolls);
    t('the last remembered phone can be scrolled fully into view', !!reach && reach.inside === true, reach);
    t('and its Forget button is a real target', !!reach && reach.forgetClickable === true, reach);

    t('no key is on screen', await redact(d));
    await shot(d, 'devices-dark');
    const dl = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    await dl.addInitScript(() => { try { localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {} });
    await dl.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await dl.waitForTimeout(1200);
    await settings(dl, 'Phone');
    await dl.evaluate(async () => {
      const pane = document.querySelector('#settings-pane');
      if (pane) { pane.scrollTop = pane.scrollHeight; await new Promise((r) => setTimeout(r, 400)); }
    });
    await redact(dl);
    // A screenshot named "light" has to actually be the light theme. The app's
    // manual override is an attribute that outranks the mockup's media query, so
    // this reads the resolved token rather than trusting the emulated OS hint.
    const paint = (pg) => pg.evaluate(() => {
      const r = getComputedStyle(document.documentElement);
      const m = document.querySelector('.modal');
      return {
        attr: document.documentElement.getAttribute('data-theme'),
        bg0: r.getPropertyValue('--bg0').trim(),
        body: getComputedStyle(document.body).backgroundColor,
        modal: m ? getComputedStyle(m).backgroundColor : null,
      };
    });
    const [pd, pl] = [await paint(d), await paint(dl)];
    t('the dark shot really is the dark theme', pd.body === 'rgb(30, 30, 30)', pd);
    t('the light shot really is the light theme', pl.body === 'rgb(255, 255, 255)', pl);
    t('the settings sheet follows the theme instead of pinning one',
      pd.modal !== pl.modal, { dark: pd.modal, light: pl.modal });
    await shot(dl, 'devices-light');
    await dl.close();

    // 9. Forget is a real revocation: the list, the live shell, and the door.
    const forgot = JSON.parse((await post(base + '/api/phone/devices', JSON.stringify({ forget: devB }))).body);
    t('forgetting drops it from the list',
      forgot.devices.length === 1 && forgot.devices[0].id === devA, forgot.devices);
    // The forced socket-close is async: it can take a beat to reach the page, so
    // a single fixed wait flaps. Poll the real end-state instead — type a
    // per-attempt marker and confirm none of them ever echo. Once the shell is
    // gone, nothing echoes, so this settles deterministically on "stopped".
    let stillTalking = true;
    for (let i = 0; i < 6 && stillTalking; i++) {
      await p.waitForTimeout(800);
      await p.locator('.xterm-helper-textarea').first().focus().catch(() => {});
      await p.keyboard.type('"after forget ' + i + ' " + $env:COMPUTERNAME');
      await p.keyboard.press('Enter');
      await p.waitForTimeout(1200);
      stillTalking = await p.evaluate(() =>
        [].some.call(document.querySelectorAll('.xterm-rows > div'),
          (d2) => /after forget \d+ \w/i.test(d2.textContent)));
    }
    t('the forgotten phone\'s terminal stopped answering', stillTalking === false);
    const lockedOut = await get(origin + '/', { cookie: 'ct_dev=' + devB, accept: 'text/html' });
    t('and it has to scan again before it gets back in', lockedOut.status === 401, lockedOut.status);
    await p.close();
    await d.close();

    // 10. The tailnet switch itself. Flipped with the phone door SHUT, so the
    //     keyless state is never actually reachable during a test run — the
    //     tailnet has other people's devices on it. What is proved here is
    //     that the switch holds, says so, and can be taken back.
    await post(base + '/api/phone', JSON.stringify({ on: false }));
    const flipped = JSON.parse((await post(base + '/api/phone', JSON.stringify({ trustTailnet: true }))).body);
    t('the PC can turn the tailnet switch on', flipped.ok === true && flipped.trustTailnet === true);
    t('and it stays on', (await state()).trustTailnet === true);
    const d2 = await desktop(browser);
    await d2.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await d2.waitForTimeout(1200);
    await settings(d2, 'Phone');
    const onState = await d2.evaluate(() => {
      const el = document.querySelector('[data-trust-toggle]');
      if (!el) return null;
      const warn = [].filter.call(document.querySelectorAll('.phone-warn'),
        (w) => /not always only yours/i.test(w.textContent))[0];
      return {
        on: / on\b/.test(' ' + el.className),
        hint: el.closest('.frow').querySelector('.fhint').textContent.replace(/\s+/g, ' ').trim(),
        warn: warn ? warn.textContent.replace(/\s+/g, ' ').trim() : '',
      };
    });
    t('the switch shows on', !!onState && onState.on === true);
    // It must count the other devices out loud rather than say "your devices" —
    // the tailnet has someone else's iPad on it.
    t('the line counts who this lets in',
      !!onState && /other device/i.test(onState.hint) && /without scanning/i.test(onState.hint), onState && onState.hint);
    t('and it warns instead of reassuring',
      !!onState && /a device someone else owns can be on it/i.test(onState.warn), onState && onState.warn);
    await shot(d2, 'trust-on');
    await d2.close();
    const back = JSON.parse((await post(base + '/api/phone', JSON.stringify({ trustTailnet: false }))).body);
    t('and it can be taken straight back off', back.trustTailnet === false);
  } finally {
    await post(base + '/api/phone', JSON.stringify({ on: false }));
    await post(base + '/api/phone', JSON.stringify({ trustTailnet: false }));
  }

  const end = await state();
  t('the run leaves the door shut and the switch off',
    end.on === false && end.trustTailnet === false, { on: end.on, trustTailnet: end.trustTailnet });
});

// --- survive: losing the socket is not losing the shell -------------------
// The thing a phone actually does to a backgrounded tab is reap its websocket.
// That used to kill the shell on the other side and print "[session ended]"
// forever, taking the person's work with it. So the harness does exactly what
// the browser does — closes the page's own sockets — and then asks the only
// questions that matter: did the shell keep running while nobody held it, did
// the app pick it back up by itself, and is the work still there.
check('survive', PORT_SURVIVE, async ({ browser, base, t, shot }) => {
  const info = async () => JSON.parse((await get(base + '/api/info')).body);

  const page = await desktop(browser);
  // Take a handle on every socket the app opens, before the app opens any.
  await page.addInitScript(() => {
    window.__socks = [];
    const Native = window.WebSocket;
    window.WebSocket = function (...a) { const s = new Native(...a); window.__socks.push(s); return s; };
    window.WebSocket.prototype = Native.prototype;
    Object.assign(window.WebSocket, Native);
  });
  const screen = () => page.evaluate(() => {
    const r = document.querySelector('.xterm-rows');
    return r ? r.innerText : '';
  });

  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await page.click('.xterm').catch(() => {});
    await page.keyboard.type('$mywork = "IMPORTANT"');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    const started = await info();
    t('a shell is running and someone is holding it',
      started.sessions === 1 && started.detached === 0, started);

    // The reap. Not setOffline — that leaves an established socket alone, which
    // is why this bug survived so long: the emulation was politer than a phone.
    await page.evaluate(() => window.__socks.forEach((s) => s.close()));
    await page.waitForTimeout(250);
    const orphan = await info();
    t('the shell keeps running with nobody attached',
      orphan.sessions === 1 && orphan.detached === 1, orphan);

    await page.waitForTimeout(6000);
    const back = await info();
    const socks = await page.evaluate(() => window.__socks.length);
    t('the app reconnects on its own', socks > 1, { sockets: socks });
    t('and is holding the same shell again',
      back.sessions === 1 && back.detached === 0, back);

    await page.click('.xterm').catch(() => {});
    await page.keyboard.type('echo $mywork');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    const after = await screen();
    t('the work in the shell survived the trip', /IMPORTANT/.test(after.split('echo $mywork')[1] || ''));
    t('and it never claimed the session ended', !/session ended/i.test(after));
    await shot(page, 'reconnected');

    // The other half of the contract: a shell that outlives a dropped socket
    // must NOT outlive a tab its owner closed, or WinMux quietly leaves live
    // PowerShells on the machine every time someone tidies up.
    // The "+" button now opens a type menu (Terminal / Browser / Markdown); pick
    // Terminal the way a person would, which also proves the menu wiring works.
    await page.locator('.pc-new').first().click();
    await page.locator('.tmenu .tmi:has-text("Terminal")').first().click();
    await page.waitForTimeout(2500);
    t('a second tab is a second shell', (await info()).sessions === 2);
    await page.locator('.ptab[data-active] .x').first().click();
    // Closing a live terminal asks first — click through it the way a person
    // does, which also proves that confirmation actually reaches the shell.
    const ok = page.locator('#dlg-body [data-ok]');
    if (await ok.count()) await ok.click();
    await page.waitForTimeout(1200);
    const tidied = await info();
    t('closing a tab on purpose ends its shell right away',
      tidied.sessions === 1 && tidied.detached === 0, tidied);
  } finally {
    await page.close();
  }
});

// --- reload: reopening the page reattaches, it does not orphan the shell ---
// A dropped socket detaches for the grace window; a full page reload is different —
// the whole app is torn down and rebuilt. That used to lose the session id (it lived
// only in the page's memory), so the reopened page started a fresh shell and left the
// old one orphaned to die at the grace mark, silently taking the person's work. WinMux
// now saves the live layout with each session id and restores it on load, reconnecting
// by id. The harness reloads the whole page and asks the two questions that matter: is
// it the same one shell with nobody orphaned, and is the work still inside it.
check('reload', PORT_RELOAD, async ({ browser, base, t, shot, skip }) => {
  // This check TYPES into the active terminal. On a borrowed server that would
  // be somebody's real shell — never acceptable.
  if (SERVERS[PORT_RELOAD] && SERVERS[PORT_RELOAD].borrowed)
    return skip('borrowed a server already on ' + PORT_RELOAD + ' — typing into a live workspace is off-limits');
  const info = async () => JSON.parse((await get(base + '/api/info')).body);
  const page = await desktop(browser);
  const screen = () => page.evaluate(() => {
    const r = document.querySelector('.xterm-rows');
    return r ? r.innerText : '';
  });
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await page.click('.xterm').catch(() => {});
    await page.keyboard.type('$mywork = "RELOAD_KEEP"');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    const before = await info();
    t('a shell is running before the reload',
      before.sessions >= 1 && before.detached === 0, before);

    // The whole page, torn down and rebuilt — exactly what used to orphan the shell.
    await page.reload({ waitUntil: 'domcontentloaded' });
    // The reload briefly detaches the old socket, then the rebuilt page reattaches by
    // sid. The real invariant is baseline-independent: reload must neither ORPHAN a
    // shell (detached>0) nor LEAK one (session count grows) — asserting a hardcoded
    // "== 1" wrongly fails whenever the baseline is 2 (Node pre-warms a spare shell;
    // Rust does not). Poll until the session table settles back to the pre-reload
    // shape, or fail loudly if it never does (a genuine leak never settles).
    let back = before;
    for (let i = 0; i < 24; i++) {
      await page.waitForTimeout(500);
      back = await info();
      if (back.detached === 0 && back.sessions === before.sessions) break;
    }
    t('the reopened page holds the same shells, nothing orphaned or leaked',
      back.sessions === before.sessions && back.detached === 0, { before, back });

    await page.click('.xterm').catch(() => {});
    await page.keyboard.type('echo $mywork');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    const after = await screen();
    t('the work in the shell survived the reload',
      /RELOAD_KEEP/.test(after.split('echo $mywork')[1] || ''));
    t('and it never claimed the session ended', !/session ended/i.test(after));
    await shot(page, 'reload-reattach');
  } finally {
    await page.close();
  }
});

// PT-3: the engine owns the workspace as a real file, so the layout survives a
// wiped browser profile (STATE.md invariant: losing the workspace should require
// deleting the file on purpose). Two pages, two isolated browser contexts: the
// first builds a two-tab layout and we assert the engine's file holds it; the
// second boots with EMPTY localStorage — the wiped-profile case that used to mean
// total layout loss — and must come back with both tabs, restored from the engine.
check('workspace', PORT_WORKSPACE, async ({ browser, base, t, shot }) => {
  const wsFile = path.join(OUT, 'workspace-' + PORT_WORKSPACE + '.json');
  try { fs.unlinkSync(wsFile); } catch (e) {}
  const pageA = await desktop(browser);
  try {
    await pageA.goto(base, { waitUntil: 'domcontentloaded' });
    await pageA.waitForTimeout(3500);
    await pageA.evaluate(() => document.getElementById('open-new').click());
    await pageA.waitForTimeout(4000);   // sid learned → persistLive → throttled push lands
    const tabsA = await pageA.evaluate(() => document.querySelectorAll('.ptab').length);
    t('two terminal tabs are open in the first window', tabsA >= 2, { tabsA });

    // The engine's copy: real file on disk, wrapped and stamped.
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(wsFile, 'utf8')); } catch (e) {}
    t('the engine wrote the workspace file', !!doc, { wsFile, exists: fs.existsSync(wsFile) });
    t('the file is a stamped workspace document, not a bare blob',
      !!doc && doc.winmuxWorkspace === 1 && doc.savedAt > 0 && doc.workspace && typeof doc.workspace === 'object',
      doc && { winmuxWorkspace: doc.winmuxWorkspace, savedAt: doc.savedAt });
    const apiGet = JSON.parse((await get(base + '/api/workspace')).body);
    t('GET /api/workspace returns the same layout the file holds',
      apiGet.ok === true && JSON.stringify(apiGet.workspace) === JSON.stringify(doc && doc.workspace));
  } finally {
    await pageA.close();   // beforeunload flushes a final keepalive save
  }

  // A brand-new browser context: empty localStorage, i.e. the wiped profile.
  const pageB = await desktop(browser);
  try {
    await pageB.goto(base, { waitUntil: 'domcontentloaded' });
    await appReady(pageB);   // engine round-trip + restore + reattach
    const tabsB = await pageB.evaluate(() => document.querySelectorAll('.ptab').length);
    t('a fresh profile restores the layout from the engine (both tabs back)', tabsB >= 2, { tabsB });
    await shot(pageB, 'workspace-survives-profile-wipe');
  } finally {
    await pageB.close();
  }
}, { WINMUX_WORKSPACE_FILE: path.join(OUT, 'workspace-' + PORT_WORKSPACE + '.json') });

// PT-4: saved scrollbacks are a visible list, not 235 invisible files. The engine
// lists every backlog entry with its expiry (STATE.md: silent expiry is a contract
// violation), the Projects overlay shows them with restore/dismiss, restoring
// replays the saved output into a real tab and consumes the file, and /api/info
// reports the honest count. The check owns an exclusive backlog dir so no other
// harness server's leftovers can pollute the row counts.
check('recover', PORT_RECOVER, async ({ browser, base, t, shot }) => {
  const cfgDir = path.join(OUT, 'recover-cfg');
  const blDir = path.join(cfgDir, 'backlog');
  fs.mkdirSync(blDir, { recursive: true });
  for (const f of fs.readdirSync(blDir)) { try { fs.unlinkSync(path.join(blDir, f)); } catch (e) {} }
  const seed = (sid, buf, savedAt) => fs.writeFileSync(path.join(blDir, sid + '.json'),
    JSON.stringify({ id: sid, dev: '', shell: 'pwsh', cwd: 'C:\\work', buf, savedAt }));
  seed('rec-restoreme', 'RECOVER_PAYLOAD_ALPHA\r\n', Date.now());
  seed('rec-dismissme', 'RECOVER_PAYLOAD_BETA\r\n', Date.now() - 60000);

  const list = JSON.parse((await get(base + '/api/backlog')).body);
  t('the engine lists both saved scrollbacks', list.ok === true && list.items.length === 2,
    list.items && list.items.map((i) => i.sid));
  t('every entry says when it expires — nothing can vanish silently',
    list.items.every((i) => i.expiresAt > Date.now() && i.live === false), list.items);
  const info = JSON.parse((await get(base + '/api/info')).body);
  t('/api/info reports the honest recoverable count', info.recoverable === 2, { recoverable: info.recoverable });
  // PT-7: the engine names where its state lives, so Diagnostics and the cheat
  // sheet can answer "where is my stuff?" with real paths on both engines.
  t('/api/info names the four stores (workspace/projects/backlog/config)',
    typeof info.workspaceFile === 'string' && typeof info.projectsDir === 'string'
    && typeof info.configFile === 'string' && String(info.backlogDir || '').replace(/\//g, '\\') === blDir,
    { workspaceFile: info.workspaceFile, projectsDir: info.projectsDir, backlogDir: info.backlogDir, configFile: info.configFile });

  const page = await desktop(browser);
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await page.click('#open-load');
    await page.waitForTimeout(800);
    const rows = await page.evaluate(() => ({
      shown: getComputedStyle(document.getElementById('sm-recover')).display !== 'none',
      n: document.querySelectorAll('#sm-recover .pjrow').length,
      text: document.getElementById('sm-recover').textContent,
    }));
    t('the Recent & recoverable section is on screen with both entries', rows.shown && rows.n === 2, rows);
    t('each row shows its expiry in plain sight', /expires in \d+d/.test(rows.text), rows.text);
    await shot(page, 'recover-list');

    // Restore the newest (row 0 — the list sorts newest first): a dead session
    // replays its saved output into a fresh tab and consumes the file.
    await page.click('#sm-recover .pjrow[data-ri="0"]');
    await page.waitForTimeout(4000);
    // Read every terminal's rows — the restored tab is the second one; grabbing
    // only the first would read the original shell and miss the replay.
    const screen = await page.evaluate(() =>
      [...document.querySelectorAll('.xterm-rows')].map((r) => r.innerText).join('\n'));
    t('restoring replays the saved output into a live tab', /RECOVER_PAYLOAD_ALPHA/.test(screen),
      screen.slice(0, 300));
    let consumed = false;
    for (let i = 0; i < 10 && !consumed; i++) { await page.waitForTimeout(500); consumed = !fs.existsSync(path.join(blDir, 'rec-restoreme.json')); }
    t('a delivered backlog is consumed — it cannot list itself twice', consumed);

    // Dismiss the other one from the reopened list.
    await page.click('#open-load');
    await page.waitForTimeout(800);
    const left = await page.evaluate(() => document.querySelectorAll('#sm-recover .pjrow').length);
    t('the restored entry is gone from the list, the other remains', left === 1, { left });
    await page.click('#sm-recover .pjrow-del[data-rdel="0"]');
    await page.waitForTimeout(500);
    // Dismiss is irreversible, so it must ask first (PT-7, Q9): confirm dialog
    // up, then its Dismiss button actually deletes.
    const askFirst = await page.evaluate(() => {
      const d = document.getElementById('dlg-body');
      return !!(d && document.getElementById('dlg-ovl').hasAttribute('data-open') && /Dismiss/.test(d.textContent));
    });
    t('dismiss asks before deleting for good', askFirst);
    await page.click('#dlg-body [data-ok]');
    await page.waitForTimeout(800);
    const afterDismiss = await page.evaluate(() => ({
      n: document.querySelectorAll('#sm-recover .pjrow').length,
      shown: getComputedStyle(document.getElementById('sm-recover')).display !== 'none',
    }));
    t('dismiss deletes it and the section stands down', afterDismiss.n === 0 && !afterDismiss.shown
      && !fs.existsSync(path.join(blDir, 'rec-dismissme.json')), afterDismiss);
    const info2 = JSON.parse((await get(base + '/api/info')).body);
    t('the honest count follows to zero', info2.recoverable === 0, { recoverable: info2.recoverable });
  } finally {
    await page.close();
  }
}, { WINMUX_CONFIG_FILE: path.join(OUT, 'recover-cfg', 'config.json') });

// PT-6: one source of truth per setting. The engine's config.json wins over a
// stale localStorage copy on boot — the drift where app A changes a setting and
// app B's localStorage overrides it forever is dead. The win must be REAL (the
// rendered terminal uses the disk value, measured) and the cache must converge.
check('sot', PORT_SOT, async ({ browser, base, t }) => {
  const cfg = path.join(OUT, 'sot-config.json');
  fs.writeFileSync(cfg, JSON.stringify({ settings: { fontSize: 19, gpuRenderer: false } }));
  // The page arrives with a STALE cache claiming fontSize 13 — the old code let
  // that override the disk forever.
  const page = await desktop(browser, { fontSize: 13 });
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    const got = await page.evaluate(() => ({
      rendered: getComputedStyle(document.querySelector('.xterm-rows')).fontSize,
      cache: (() => { try { return JSON.parse(localStorage.getItem('ct-settings') || '{}').fontSize; } catch (e) { return null; } })(),
    }));
    t('the rendered terminal uses the engine\'s value, not the stale cache', got.rendered === '19px', got);
    t('the localStorage cache converged to the engine\'s value', got.cache === 19, got);
  } finally {
    await page.close();
  }
}, { WINMUX_CONFIG_FILE: path.join(OUT, 'sot-config.json') });

// SP-1: instant typing (predictive local echo). A typed character paints the
// same frame as the keystroke via an overlay — the buffer is never touched, so
// reality always wins on reconcile. The guards are the contract: a masked
// password prompt must never see its character predicted on screen, and typing
// must re-earn prediction after echo returns.
check('localecho', PORT_LOCALECHO, async ({ browser, base, t }) => {
  const page = await desktop(browser, { gpuRenderer: false });
  const ovShown = (ch) => page.evaluate((c) => new Promise((res) => {
    const start = performance.now();
    function look() {
      const hit = [...document.querySelectorAll('.xterm-screen > div')].some((o) =>
        o.style.pointerEvents === 'none' && o.style.display !== 'none' && o.textContent.endsWith(c));
      if (hit) { res(Math.round(performance.now() - start)); return; }
      if (performance.now() - start > 500) { res(-1); return; }
      requestAnimationFrame(look);
    }
    look();
  }), ch);
  // Wait for a shell that is actually echoing, not for a guessed interval. Every
  // assertion here is about what the predictor does around real echo, so a shell
  // that has not printed its prompt yet makes the whole check meaningless — and
  // it fails on a later assertion, blaming the predictor.
  const livePrompt = () => page.waitForFunction(`(function () {
    var h = [].slice.call(document.querySelectorAll('.term-host'))
      .filter(function (e) { return e.style.display !== 'none'; })[0];
    if (!h) return false;
    var rows = h.querySelector('.xterm-rows');
    return !!rows && /[>$#]\\s*$|PS .*>/.test(rows.textContent || '');
  })()`, null, { timeout: 30000 });
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await livePrompt();
    // A restored session (the engine may rehydrate a workspace this port used in
    // an earlier run) carries scrollback that legitimately trips the predictor's
    // screen guards — the contract under test needs a FRESH shell, so open one.
    await page.evaluate(() => document.getElementById('open-new').click());
    await livePrompt();
    // Focus the VISIBLE terminal's textarea — a hidden restored tab also matches
    // '.xterm', and clicking that one times out.
    const focusTerm = () => page.evaluate(() => {
      const th = [...document.querySelectorAll('.term-host')].find((h) => h.style.display !== 'none' && h.querySelector('textarea'));
      const ta = th ? th.querySelector('textarea') : document.querySelector('.xterm textarea');
      if (ta) ta.focus();
    });
    await focusTerm();
    await page.waitForTimeout(300);
    // Two echoed keystrokes earn prediction; the third must paint instantly.
    // Confidence collapses BY DESIGN when an echo takes >400ms, and on a machine
    // mid-harness the shell can be that slow — so earn in rounds: if a round's
    // echoes were too slow to build confidence, try a fresh round rather than
    // fail the instant-paint claim on a slow-shell moment the predictor is
    // deliberately built to sit out.
    const earn = async (trip) => {
      for (const c of trip.slice(0, 2)) { await page.keyboard.press(c); await page.waitForTimeout(350); }
      await page.keyboard.press(trip[2]);
      return ovShown(trip[2]);
    };
    let ms = -1, used = ['e', 'f', 'g'];
    for (const trip of [['e', 'f', 'g'], ['a', 'b', 'c'], ['s', 't', 'u']]) {
      ms = await earn(trip); used = trip;
      if (ms >= 0) break;
      await page.waitForTimeout(700);
    }
    t('a typed character is painted the same frame, ahead of the shell', ms >= 0 && ms <= 32, { ms });
    // Reality wins: after the echo lands, the buffer holds the text and the
    // overlay has stood down.
    await page.waitForTimeout(600);
    // Read the ACTIVE terminal's buffer — with two tabs open, .xterm-rows
    // matches whichever terminal happens to come first in the DOM.
    const rec = await page.evaluate(() => {
      const at = window.__winmuxActiveTerm();
      const b = at.term.buffer.active;
      const end = b.baseY + b.cursorY;   // the prompt line — rows past it are blank viewport
      let out = '';
      for (let i = Math.max(0, end - 4); i <= end; i++) { const ln = b.getLine(i); if (ln) out += ln.translateToString(true); }
      return {
        rows: out.replace(/\s+$/, ''),
        ov: [...document.querySelectorAll('.xterm-screen > div')].some((o) => o.style.pointerEvents === 'none' && o.style.display !== 'none'),
      };
    });
    t('the shell echo reconciles — buffer truthful, overlay stood down', new RegExp(used.join('') + '$').test(rec.rows) && !rec.ov, rec);
    // The secret gate: a masked prompt must never see its keystroke predicted.
    await page.keyboard.press('Escape');
    await page.keyboard.type('Read-Host -AsSecureString -Prompt "Password"');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    await page.keyboard.press('x');
    const leak = await ovShown('x');
    t('a password keystroke is never painted predictively', leak === -1, { leak });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    // Prediction must re-earn itself once echo is back (same slow-shell
    // tolerance as above: earning rounds, not one strict shot).
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    let back = -1;
    for (const trip of [['m', 'n', 'o'], ['1', '2', '3'], ['4', '5', '6']]) {
      back = await earn(trip);
      if (back >= 0) break;
      await page.waitForTimeout(700);
    }
    t('prediction returns after the secure prompt ends', back >= 0, { back });
    // The off switch is honest: with the setting off, nothing predicts.
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('ct-settings') || '{}'); s.localEcho = false;
      localStorage.setItem('ct-settings', JSON.stringify(s));
    });
    await page.evaluate(() => fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: { localEcho: false } }) }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await livePrompt();
    // The setting is read from disk asynchronously after load. Typing before it
    // lands proves nothing about the switch — so wait for the app to actually be
    // holding localEcho:false, then type.
    await page.waitForFunction(`(function () {
      try { return JSON.parse(localStorage.getItem('ct-settings') || '{}').localEcho === false; }
      catch (e) { return false; }
    })()`, null, { timeout: 20000 });
    // Fresh shell again, so "no prediction" is proven by the OFF switch alone,
    // not by a restored screen tripping the guards.
    await page.evaluate(() => document.getElementById('open-new').click());
    await livePrompt();
    await focusTerm();
    for (const c of ['p', 'q']) { await page.keyboard.press(c); await page.waitForTimeout(300); }
    await page.keyboard.press('r');
    const off = await ovShown('r');
    t('the Settings switch really turns prediction off', off === -1, { off });
  } finally {
    await page.close();
  }
});

// PT-5: the Close-project verb exists and is honest. Closing unbinds the window
// from the named file and returns to the unnamed workspace — it never deletes the
// file, and it asks one question whose outcomes are keep-sessions / end-sessions /
// save-first. Deleting a file is its own confirmed verb on the project row.
check('closeverb', PORT_CLOSEVERB, async ({ browser, base, t, shot }) => {
  const projDir = path.join(OUT, 'closeverb-projects');
  fs.mkdirSync(projDir, { recursive: true });
  for (const f of fs.readdirSync(projDir)) { try { fs.unlinkSync(path.join(projDir, f)); } catch (e) {} }
  const page = await desktop(browser);
  const bound = () => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('ct-current') || 'null'); } catch (e) { return null; } });
  const projFiles = () => fs.readdirSync(projDir).filter((f) => f.endsWith('.winmux.json'));
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);

    // Save the workspace as a named project — the window is now bound.
    await page.click('#open-save');
    await page.waitForTimeout(600);
    await page.fill('#sm-name', 'Harness Project');
    await page.click('#sm-save');
    await page.waitForTimeout(1200);
    t('saving binds the window to the project', !!(await bound()), await bound());
    t('the project file exists on disk', projFiles().length === 1, projFiles());
    await page.keyboard.press('Escape');   // the overlay stays open after Save — close it
    await page.waitForTimeout(400);

    // The Close verb appears only while bound, and closing with "keep" unbinds
    // without touching the file or the running shells.
    await page.click('#open-save');
    await page.waitForTimeout(600);
    const closeVisible = await page.evaluate(() => getComputedStyle(document.getElementById('pj-close')).display !== 'none');
    t('Close project is offered while a project is open', closeVisible);
    await page.click('#pj-close');
    await page.waitForTimeout(500);
    const dlg = await page.evaluate(() => ({
      end: !!document.querySelector('#dlg-body [data-end]'),
      keep: !!document.querySelector('#dlg-body [data-keep]'),
      text: (document.getElementById('dlg-body') || {}).textContent || '',
    }));
    t('the close dialog offers the honest outcomes', dlg.end && dlg.keep && /file stays on disk/.test(dlg.text), dlg);
    await shot(page, 'close-dialog');
    const tabsBefore = await page.evaluate(() => document.querySelectorAll('.ptab').length);
    await page.click('#dlg-body [data-keep]');
    await page.waitForTimeout(800);
    t('keep-running closes the project but not the terminals',
      (await bound()) === null && (await page.evaluate(() => document.querySelectorAll('.ptab').length)) === tabsBefore,
      { bound: await bound(), tabsBefore });
    t('closing never deletes the file', projFiles().length === 1, projFiles());

    // Reopen it, drift the layout, close with "save first": the file catches up
    // and the terminals stay.
    await page.click('#open-load');
    await page.waitForTimeout(600);
    await page.click('#sm-list .pjrow');
    await page.waitForTimeout(400);
    // A live terminal makes openSavedLayout confirm first — accept it if shown.
    await page.evaluate(() => { const ok = document.querySelector('#dlg-body [data-ok]'); if (ok) ok.click(); });
    await page.waitForTimeout(1500);
    t('reopening binds again', !!(await bound()), await bound());
    await page.evaluate(() => document.getElementById('open-new').click());
    await page.waitForTimeout(1500);
    await page.click('#open-save');
    await page.waitForTimeout(600);
    await page.click('#pj-close');
    await page.waitForTimeout(500);
    const hasSave = await page.evaluate(() => !!document.querySelector('#dlg-body [data-save]'));
    t('unsaved layout changes surface the save-first outcome', hasSave);
    await page.click('#dlg-body [data-save]');
    await page.waitForTimeout(1200);
    const saved = JSON.parse(fs.readFileSync(path.join(projDir, projFiles()[0]), 'utf8'));
    const savedTabs = (saved.layout && saved.layout.cols || []).reduce((n, c) => n + c.reduce((m, p) => m + (p.tabs || []).length, 0), 0);
    t('save-first wrote the drifted layout into the file', (await bound()) === null && savedTabs >= 2, { savedTabs });

    // Delete is a real, separate, confirmed verb — and it actually removes the file.
    await page.click('#open-load');
    await page.waitForTimeout(600);
    await page.click('#sm-list .pjrow-del');
    await page.waitForTimeout(500);
    await page.click('#dlg-body [data-discard]');   // "Delete the file"
    await page.waitForTimeout(800);
    t('delete removes the project file from disk', projFiles().length === 0, projFiles());
  } finally {
    await page.close();
  }
}, { WINMUX_PROJECTS_DIR: path.join(OUT, 'closeverb-projects'), WINMUX_CONFIG_FILE: path.join(OUT, 'closeverb-cfg', 'config.json') });

// AUDIT-2: "Delete the file" must never claim a file is gone when it isn't.
// Both engines used to throw the unlink's result away and answer ok — and the
// recents row was dropped BEFORE the delete was attempted, so a file another
// program was holding open (Dropbox, an editor, a virus scan) stayed on disk
// while the app forgot where it lived. Three cases, no browser needed: a locked
// file must be refused with a reason and stay in the list; an unlocked one must
// really go; and plain "remove from list" must still leave the file alone.
check('delhonest', PORT_DELHONEST, async ({ base, t }) => {
  const dir = path.join(OUT, 'delhonest-projects');
  fs.mkdirSync(dir, { recursive: true });
  const api = async (method, url, body) => {
    const r = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.json().catch(() => null);
  };
  const listed = async (p) => ((await api('GET', '/api/projects')).recents || []).some((r) => r.path === p);
  const file = path.join(dir, 'Held Open.winmux.json');

  await api('POST', '/api/project', { name: 'Held Open', path: file, layout: { cols: [] } });
  t('the project file exists to begin with', fs.existsSync(file), fs.existsSync(file));

  // FileShare.None is the realistic lock: readable by its holder, undeletable.
  const holder = spawn('pwsh', ['-NoProfile', '-Command',
    // Retry the open: this sandbox lives under Dropbox, which grabs a handle on
    // every file it sees appear. Its handle is transient, ours is the point of
    // the check — so wait it out rather than failing and blaming the product.
    `$f=$null; $d=(Get-Date).AddSeconds(20)
     while (-not $f -and (Get-Date) -lt $d) {
       try { $f=[System.IO.File]::Open('${file}','Open','Read','None') }
       catch { Start-Sleep -Milliseconds 50 }
     }
     if ($f) { Start-Sleep -Seconds 20; $f.Close() } else { Write-Error 'never got the lock' }`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let holderErr = '';
  holder.stderr.on('data', (b) => { holderErr += b.toString(); });
  holder.on('error', (e) => { holderErr += 'spawn failed: ' + e.message; });
  // Wait for the lock to actually be held, not for a guessed number of milliseconds:
  // pwsh startup varies wildly under a loaded suite, and a stopwatch that loses the
  // race deletes an unlocked file and blames the product.
  const locked = () => { try { fs.closeSync(fs.openSync(file, 'r')); return false; } catch (e) { return true; } };
  const holdBy = Date.now() + 15000;
  while (!locked() && Date.now() < holdBy) await new Promise((r) => setTimeout(r, 50));
  t('the lock this check depends on is actually held', locked(),
    locked() ? true : 'never took hold in 15s; pwsh said: ' + (holderErr.trim() || '(nothing)'));
  const blocked = await api('DELETE', '/api/project?path=' + encodeURIComponent(file) + '&trash=1');
  t('a delete that cannot happen is refused, not reported as done', blocked && blocked.ok === false, blocked);
  t('and it says why', typeof (blocked || {}).error === 'string', (blocked || {}).error);
  t('the file is still on disk', fs.existsSync(file), fs.existsSync(file));
  t('the project stays in the list, so we still know where it lives', await listed(file), true);
  try { holder.kill(); } catch (e) {}
  const freeBy = Date.now() + 15000;
  while (locked() && Date.now() < freeBy) await new Promise((r) => setTimeout(r, 50));
  // Say out loud whether the precondition actually held. Without this the check
  // sails past a lock that never released and reports the resulting refusal as a
  // product failure — which is how this check spent today looking like a flake
  // while the thing it was pointing at was real.
  t('the lock really did release before we ask for a delete', !locked(), locked());

  const gone = await api('DELETE', '/api/project?path=' + encodeURIComponent(file) + '&trash=1');
  t('with nothing holding it, the delete succeeds', gone && gone.ok === true, gone);
  t('and the file really is gone', !fs.existsSync(file), fs.existsSync(file));
  t('and it leaves the list', !(await listed(file)), await listed(file));

  // A TRANSIENT hold is the common case, not the 20-second one: Dropbox and
  // OneDrive grab a handle on a file the instant they see it change, and a
  // project folder is very often inside one. Deleting used to be a single
  // attempt, so that quarter-second was enough to refuse a delete the user then
  // had to repeat. It must now ride the race out — the same patience every
  // durable write already had.
  const brief = path.join(dir, 'Briefly Held.winmux.json');
  await api('POST', '/api/project', { name: 'Briefly Held', path: brief, layout: { cols: [] } });
  const flicker = spawn('powershell', ['-NoProfile', '-Command',
    `$f=$null; $d=(Get-Date).AddSeconds(10)
     while (-not $f -and (Get-Date) -lt $d) {
       try { $f=[System.IO.File]::Open('${brief}','Open','Read','None') }
       catch { Start-Sleep -Milliseconds 20 }
     }
     if ($f) { Start-Sleep -Milliseconds 250; $f.Close() }`,
  ], { stdio: 'ignore' });
  const heldNow = () => { try { fs.closeSync(fs.openSync(brief, 'r')); return false; } catch (e) { return true; } };
  const by = Date.now() + 10000;
  while (!heldNow() && Date.now() < by) await new Promise((r) => setTimeout(r, 10));
  t('a brief hold is really in place for this one', heldNow(), heldNow());
  const rode = await api('DELETE', '/api/project?path=' + encodeURIComponent(brief) + '&trash=1');
  t('a delete rides out a hold that lasts a moment, instead of refusing',
    rode && rode.ok === true, rode);
  t('and that file is actually gone', !fs.existsSync(brief), fs.existsSync(brief));
  try { flicker.kill(); } catch (e) {}

  const keep = path.join(dir, 'Keep Me.winmux.json');
  await api('POST', '/api/project', { name: 'Keep Me', path: keep, layout: { cols: [] } });
  const dropped = await api('DELETE', '/api/project?path=' + encodeURIComponent(keep));
  t('"remove from list" reports success', dropped && dropped.ok === true, dropped);
  t('"remove from list" says it deleted nothing', dropped && dropped.deleted === false, dropped);
  t('and the file survives', fs.existsSync(keep), fs.existsSync(keep));
  t('but it left the list', !(await listed(keep)), await listed(keep));
}, { WINMUX_PROJECTS_DIR: path.join(OUT, 'delhonest-projects'), WINMUX_CONFIG_FILE: path.join(OUT, 'delhonest-cfg', 'config.json') });

// AUDIT-3: the config file is advertised as hand-editable and it beats what the
// app has, so it is the one way into the keymap with nobody checking. It used to
// be adopted verbatim: an action that doesn't exist, a chord spelled in a way a
// keypress can never produce, or two actions on one key all went straight in —
// and Settings then displayed a shortcut as bound that did nothing at all. The
// Rebind dialog inside the app refuses exactly these, so the documented path was
// the unsafe one. Now both paths apply the same rules.
check('keymapguard', PORT_KEYMAPGUARD, async ({ browser, base, t }) => {
  const page = await desktop(browser);
  try {
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__winmuxAdoptKeymap, null, { timeout: 15000 });

    const kept = await page.evaluate(() => window.__winmuxAdoptKeymap({
      'no-such-action': 'Ctrl+Alt+Q',   // an action that does not exist
      'find': 'ctrl+shift+9',           // lower-case: a keypress never produces this
      'zoom': 'Shift+Ctrl+Z',           // modifiers out of order: same problem
      'new-tab': 'Alt+F9',              // fine
      'reset-terminal': 'Ctrl+,',       // collides with Settings' own default
    }));
    t('an action that does not exist is dropped', !('no-such-action' in kept), Object.keys(kept));
    t('a lower-case chord is dropped', !('find' in kept), kept.find);
    t('a chord with its modifiers out of order is dropped', !('zoom' in kept), kept.zoom);
    t('a chord that collides with another shortcut is dropped', !('reset-terminal' in kept), kept['reset-terminal']);
    t('a real, free chord is kept', kept['new-tab'] === 'Alt+F9', kept['new-tab']);

    // The whole point: after adopting a file, no two actions may share a key.
    const dupes = await page.evaluate(() => {
      const seen = {}, dup = [];
      window.__winmuxKeymap().effective.forEach((a) => {
        if (seen[a.chord]) dup.push(seen[a.chord] + ' + ' + a.id + ' both on ' + a.chord);
        seen[a.chord] = a.id;
      });
      return dup;
    });
    t('no two actions end up sharing a key', dupes.length === 0, dupes);

    // An override that vacates a default must let another action take it — the
    // check that a naive "reject anything matching a default" rule would fail.
    const swap = await page.evaluate(() => window.__winmuxAdoptKeymap({
      'settings': 'Ctrl+Alt+P', 'reset-terminal': 'Ctrl+,',
    }));
    t('freeing a default lets another action claim it',
      swap.settings === 'Ctrl+Alt+P' && swap['reset-terminal'] === 'Ctrl+,', swap);
    t('and still nothing collides',
      (await page.evaluate(() => {
        const s = {}; let d = 0;
        window.__winmuxKeymap().effective.forEach((a) => { if (s[a.chord]) d++; s[a.chord] = 1; });
        return d;
      })) === 0, true);
  } finally {
    await page.close();
  }
}, { WINMUX_CONFIG_FILE: path.join(OUT, 'keymapguard-cfg', 'config.json') });

// AUDIT-4: six surfaces advertise keyboard shortcuts and only Settings → Shortcuts
// used to read what is actually bound. The F1 sheet, the command palette, the
// right-click menus, the pane-control tooltips and the new-tab menu all printed
// hardcoded strings — so the moment anyone used the app's own rebind feature,
// every one of them went on teaching a key that no longer did anything. Rebind
// Split right and demand that each surface tells the truth.
check('chordtruth', PORT_CHORDTRUTH, async ({ browser, base, t, shot }) => {
  const page = await desktop(browser);
  try {
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__winmuxSetKeymap, null, { timeout: 15000 });
    await page.evaluate(() => window.__winmuxSetKeymap('split-right', 'Ctrl+Alt+9'));
    await page.waitForTimeout(300);

    // 1. The F1 cheat sheet — the place a stranger looks first.
    await page.keyboard.press('F1');
    await page.waitForTimeout(500);
    const cheat = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('#cheat-body .crow'))
        .find((r) => r.querySelector('.ca') && r.querySelector('.ca').textContent.trim() === 'Split right');
      return row && row.querySelector('.kbd') ? row.querySelector('.kbd').textContent.trim() : null;
    });
    t('the F1 sheet shows the key that is actually bound', cheat === 'Ctrl+Alt+9', cheat);
    await shot(page, 'chordtruth-cheat');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 2. The command palette.
    await page.keyboard.press('Control+Shift+P');
    await page.waitForTimeout(400);
    await page.fill('#pl-input', 'Split right');
    await page.waitForTimeout(400);
    const pal = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('#pl-list .pl-item'))
        .find((r) => /Split right/.test(r.textContent));
      return row && row.querySelector('.kbd') ? row.querySelector('.kbd').textContent.trim() : null;
    });
    t('the command palette shows it too', pal === 'Ctrl+Alt+9', pal);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 3. The split button's own tooltip — the one surviving hint about how to split.
    const tip = await page.evaluate(() => {
      const b = document.querySelector('.pc-split');
      return b ? b.getAttribute('title') : null;
    });
    t('the split button tooltip names the real key', /Ctrl\+Alt\+9/.test(tip || ''), tip);

    // 4. The tab's right-click menu.
    await page.click('.ptab', { button: 'right' });
    await page.waitForTimeout(500);
    const menu = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('.ofmi'))
        .find((r) => /Split right|Split tab/.test(r.textContent));
      return row ? row.textContent.replace(/\s+/g, ' ').trim() : null;
    });
    t('the right-click menu names the real key', /Ctrl\+Alt\+9/.test(menu || ''), menu);
    await page.keyboard.press('Escape');

    // And nothing anywhere still advertises the abandoned default.
    const stale = await page.evaluate(() => {
      const hits = [];
      document.querySelectorAll('[title]').forEach((el) => {
        if (/Split right \(Ctrl\+D\)/.test(el.getAttribute('title'))) hits.push(el.getAttribute('title'));
      });
      return hits;
    });
    t('no tooltip still advertises the key that was replaced', stale.length === 0, stale);

    // Rebind a second time, touching nothing else. This used to pass only when a
    // pane rebuild happened to land after the rebind — true on the Node engine,
    // false on the one that ships. Rebinding twice with no reload in between
    // leaves no rebuild to hide behind: either the app repaints the tooltip on a
    // keymap change, or this fails.
    await page.evaluate(() => window.__winmuxSetKeymap('split-right', 'Ctrl+Alt+7'));
    await page.waitForTimeout(300);
    const again = await page.evaluate(() => {
      const b = document.querySelector('.pc-split');
      return b ? b.getAttribute('title') : null;
    });
    t('and a second rebind moves it again, with no reload to repaint it',
      /Ctrl\+Alt\+7/.test(again || ''), again);
  } finally {
    await page.close();
  }
}, { WINMUX_CONFIG_FILE: path.join(OUT, 'chordtruth-cfg', 'config.json') });

// AUDIT-5: three engine writes happen with no visible control of their own — the
// workspace auto-save, the settings/keymap file, and the start-at-login switch —
// and each used to swallow its failure whole. The disk file wins on next launch,
// so a settings write that never landed meant the change silently reverted, with
// nothing on screen. Cut the write off at the network and demand the app say so:
// once per outage (the workspace save retries every two seconds and must not
// become a wall of notifications), and once more when it starts working again.
check('writeloud', PORT_WRITELOUD, async ({ browser, base, t }) => {
  const page = await desktop(browser);
  try {
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__winmuxWriteState && !!window.__winmuxSetKeymap, null, { timeout: 15000 });
    const notifCount = () => page.evaluate(() => (window.__winmuxWriteState ? 0 : 0) ||
      document.querySelectorAll('#npanel .nrow, #npanel .notif, #npanel [data-nid]').length);
    const down = () => page.evaluate(() => !!window.__winmuxWriteState().config);

    t('nothing is reported while the write is working', (await down()) === false, await down());

    // Cut the settings write off at the network — the engine is fine, the write isn't.
    await page.route('**/api/config', (route) => route.abort());
    await page.evaluate(() => window.__winmuxSetKeymap('help', 'Ctrl+Alt+8'));
    await page.waitForTimeout(700);
    t('a failed settings write is noticed', (await down()) === true, await down());
    const first = await page.evaluate(() => document.getElementById('notif-badge').textContent.trim());
    t('and it reaches the notification badge', first !== '' && first !== '0', first);

    // Two more failures must NOT stack up two more notifications.
    await page.evaluate(() => { window.__winmuxSetKeymap('help', 'Ctrl+Alt+7'); window.__winmuxSetKeymap('help', 'Ctrl+Alt+6'); });
    await page.waitForTimeout(700);
    const second = await page.evaluate(() => document.getElementById('notif-badge').textContent.trim());
    t('repeated failures are reported once, not once per attempt', second === first, { first, second });

    // Let the write through again: recovery is worth saying, because silence after
    // a warning reads as "still broken".
    await page.unroute('**/api/config');
    await page.evaluate(() => window.__winmuxSetKeymap('help', null));
    await page.waitForTimeout(700);
    t('the app stops considering the write broken', (await down()) === false, await down());
    const third = await page.evaluate(() => document.getElementById('notif-badge').textContent.trim());
    t('and says it is working again', third !== second, { second, third });
  } finally {
    await page.close();
  }
}, { WINMUX_CONFIG_FILE: path.join(OUT, 'writeloud-cfg', 'config.json') });

// AUDIT-6: driving all fifteen CLI verbs against a live window turned up exactly
// one that misbehaved. `winmux slash` waits for the target session to be idle by
// looking for Claude Code's own prompt glyph — which a plain PowerShell tab never
// prints. Pointed at an ordinary shell (what you get when you omit --id) it sat
// for the full 90 seconds and then reported "session is still working", which was
// neither true nor the problem. Every other verb answers in under a second, so
// this was the only way to make the command line hang. Refuse fast, and say why.
check('slashfast', PORT_SLASHFAST, async ({ browser, base, t }) => {
  const page = await desktop(browser);
  try {
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);   // let the first PowerShell tab reach its prompt
    const t0 = Date.now();
    const r = await new Promise((resolve) => {
      const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), 'slash', '/help'],
        { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_SLASHFAST), WINMUX_HOST: '127.0.0.1' }) });
      let buf = '';
      proc.stdout.on('data', (d) => { buf += d; });
      proc.stderr.on('data', (d) => { buf += d; });
      const kill = setTimeout(() => { try { proc.kill(); } catch (e) {} resolve({ code: null, out: buf, killed: true }); }, 40000);
      proc.on('close', (code) => { clearTimeout(kill); resolve({ code: code, out: buf.trim(), killed: false }); });
    });
    const ms = Date.now() - t0;
    t('it does not hang', !r.killed, { killed: r.killed, ms });
    t('it answers well inside the old 90-second wait', ms < 20000, { ms });
    t('it refuses, rather than pretending it sent something', r.code !== 0, { code: r.code });
    t('and it names the real reason — not "still working"',
      /not running Claude Code/i.test(r.out) && !/still working/i.test(r.out), r.out.slice(0, 160));
  } finally {
    await page.close();
  }
}, { WINMUX_CONFIG_FILE: path.join(OUT, 'slashfast-cfg', 'config.json') });

// AUDIT-7 (register item 05). Four features were broken ONLY in the engine we
// actually ship, and none of them reproduced from a source checkout because
// running from source uses the other engine. This check asks the engine under
// test — whichever it is — the same four questions, so the shipping build can
// never again be the only one that fails them. It writes its Startup launcher
// into a scratch folder, never the user's real one.
check('shipped05', PORT_SHIPPED05, async ({ base, t }) => {
  const startup = path.join(OUT, 'shipped05-startup');
  const vbs = path.join(startup, 'WinMux.vbs');
  const api = async (method, url, body) => {
    const r = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  // 1. Diagnostics — the screen we send confused users to. Seven of its rows
  //    rendered "undefined" and "NaNm NaNs" on the shipping engine.
  const info = (await api('GET', '/api/info')).json || {};
  const DIAG = ['runtime', 'platform', 'arch', 'uptime', 'home', 'cpus', 'mem'];
  const empty = DIAG.filter((k) => info[k] === undefined || info[k] === null || info[k] === '');
  t('Diagnostics gets every field it prints — nothing renders as "undefined"', empty.length === 0,
    { missing: empty, got: DIAG.reduce((o, k) => (o[k] = info[k], o), {}) });
  t('and the numbers are numbers, so the uptime row cannot read "NaNm NaNs"',
    typeof info.uptime === 'number' && info.uptime >= 0 && typeof info.cpus === 'number' && info.cpus > 0,
    { uptime: info.uptime, cpus: info.cpus });
  t('it names which engine is actually serving you', /rust core|node/i.test(String(info.runtime)), info.runtime);

  // 2. The Changes tab — "Could not read changes" on the shipping engine,
  //    because the route it calls did not exist there at all.
  const git = await api('GET', '/api/git?cwd=' + encodeURIComponent(ROOT));
  t('the Changes tab has a route to call at all', git.status === 200, git.status);
  t('and it answers with this repo, not an error', git.json && git.json.ok === true && !!git.json.root,
    { ok: git.json && git.json.ok, root: git.json && git.json.root, branch: git.json && git.json.branch });
  const files = (git.json && git.json.files) || [];
  t('changed files come back in the shape the diff panel renders',
    Array.isArray(files) && files.every((f) => typeof f.path === 'string' && Array.isArray(f.hunks)),
    { count: files.length, sample: files[0] && { path: files[0].path, st: files[0].st, hunks: files[0].hunks.length } });

  // 3. Start-at-login — a switch that could not move, silently.
  fs.rmSync(startup, { recursive: true, force: true });
  const off0 = await api('GET', '/api/autostart');
  t('the switch reports itself off before anything is written', off0.json && off0.json.on === false, off0.json);
  const on = await api('POST', '/api/autostart', { on: true });
  t('turning it on succeeds and says so', on.status === 200 && on.json.ok === true && on.json.on === true, on.json);
  t('and it really wrote the Startup launcher', fs.existsSync(vbs), vbs);
  const body = fs.existsSync(vbs) ? fs.readFileSync(vbs, 'utf8') : '';
  t('the launcher starts the app, not a headless engine with no window',
    /shell\.Run/.test(body) && !/winmux-core\.exe/i.test(body), body.split('\n')[2] || body.slice(0, 120));
  const off = await api('POST', '/api/autostart', { on: false });
  t('turning it off removes it and reports the new state',
    off.status === 200 && off.json.on === false && !fs.existsSync(vbs), off.json);

  // 4. The update badge — hard-coded to "no update" on the shipping engine, so
  //    it could never light no matter what was published. Proven against a real
  //    HTTP release feed this check serves itself, NOT the WINMUX_FAKE_LATEST
  //    short-circuit: the request, the JSON parse and the version compare all
  //    have to work, which is what was actually missing.
  const feed = http.createServer((rq, rs) => {
    rs.writeHead(200, { 'Content-Type': 'application/json' });
    rs.end(JSON.stringify({ tag_name: 'v99.9.9', html_url: 'https://example.invalid/rel/99.9.9' }));
  });
  await new Promise((r) => feed.listen(PORT_UPDFEED, '127.0.0.1', r));
  try {
    const upd = (await api('GET', '/api/update')).json || {};
    t('the update check reports the version actually running', typeof upd.current === 'string' && upd.current.length > 0, upd.current);
    t('it really asks a release feed and reads the answer back',
      upd.latest === '99.9.9', { latest: upd.latest });
    t('and the badge can light — it is not hard-wired to "no update"',
      upd.updateAvailable === true, { latest: upd.latest, current: upd.current, updateAvailable: upd.updateAvailable });
  } finally {
    await new Promise((r) => feed.close(r));
  }
}, {
  WINMUX_STARTUP_DIR: path.join(OUT, 'shipped05-startup'),
  WINMUX_UPDATE_API: 'http://127.0.0.1:' + PORT_UPDFEED + '/releases/latest',
  WINMUX_APP_EXE: 'C:\\Program Files\\WinMux\\WinMux.exe',
});

// AUDIT-8 (register item 06). Saving a project by NAME derives its filename from
// a slug of that name, and two different names can slug to the same file. The
// second save used to overwrite the first and still report "Project saved" — and
// worst of all unattended, where an upgrade re-saves every legacy layout by name.
// An explicit path is still the user's to overwrite; a name is not.
check('noclobber', PORT_NOCLOBBER, async ({ base, t }) => {
  // Deliberately OUTSIDE the repo: the repo lives in Dropbox, and a check about
  // our own overwrite rules should not also be a live test of Dropbox's locking.
  const dir = path.join(os.tmpdir(), 'winmux-verify-noclobber');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const raw = {};
  const save = async (name, layout, p) => {
    const r = await fetch(base + '/api/project', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(p ? { name, layout, path: p } : { name, layout }),
    });
    const text = await r.text();
    raw[name + (p ? ' @path' : '')] = r.status + ' ' + text.slice(0, 200);
    try { return JSON.parse(text).path; } catch (e) { return undefined; }
  };
  const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };

  // Two names, one slug: "Client A / Prod" and "Client A Prod" both reduce to
  // client-a-prod. This is the collision, not a contrived one.
  const first = await save('Client A / Prod', { cols: [{ id: 'first' }] });
  t('the first project saves under its slug', !!first && fs.existsSync(first), first);
  const second = await save('Client A Prod', { cols: [{ id: 'second' }] });
  t('a different project with a colliding name gets its OWN file',
    !!second && second !== first, { first: first && path.basename(first), second: second && path.basename(second) });
  const a = read(first);
  t('and the first project is still on disk, untouched',
    a && a.name === 'Client A / Prod' && JSON.stringify(a.layout) === JSON.stringify({ cols: [{ id: 'first' }] }),
    a && { name: a.name, layout: a.layout });
  const b = read(second);
  t('the second project holds its own content', b && b.name === 'Client A Prod', b && { name: b.name });

  // Re-saving the SAME project must keep overwriting its own file, not sprawl.
  const again = await save('Client A / Prod', { cols: [{ id: 'updated' }] });
  t('re-saving the same project reuses its file rather than making a new one', again === first,
    { again: again, first: first, raw: raw['Client A / Prod'] });
  const a2 = read(first);
  t('and the re-save actually landed', a2 && a2.layout.cols[0].id === 'updated', a2 && a2.layout);

  // A third collision keeps counting up rather than picking a fight.
  const third = await save('Client A - Prod', { cols: [{ id: 'third' }] });
  t('a third colliding name gets a third file', third && third !== first && third !== second,
    third && path.basename(third));

  // An explicit path is the user choosing the file. That overwrite is theirs.
  const chosen = await save('Renamed On Purpose', { cols: [{ id: 'chosen' }] }, first);
  const a3 = read(first);
  t('but an explicit path still overwrites — that choice is the user\'s',
    chosen === first && a3 && a3.name === 'Renamed On Purpose', { chosen, name: a3 && a3.name });

  // The overwrite that used to fail for real. A project folder is usually a
  // Dropbox or OneDrive folder, and the sync client holds a file open for a
  // moment right after it changes — long enough for the rename that makes the
  // write atomic to come back EPERM. Hold the file open for 250ms and demand
  // the save ride it out rather than telling the user it could not save.
  const holder = spawn('powershell', ['-NoProfile', '-Command',
    "$f=[System.IO.File]::Open('" + first.replace(/'/g, "''") + "','Open','Read','None');"
    + 'Start-Sleep -Milliseconds 250; $f.Close()'], { windowsHide: true, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 120));   // let the lock actually take hold
  const rode = await save('Renamed On Purpose', { cols: [{ id: 'rode-it-out' }] }, first);
  try { holder.kill(); } catch (e) {}
  const a4 = read(first);
  t('a save waits out a sync client holding the file, instead of failing',
    rode === first && a4 && a4.layout.cols[0].id === 'rode-it-out',
    { rode: !!rode, landed: a4 && a4.layout.cols[0].id, raw: raw['Renamed On Purpose @path'] });
}, { WINMUX_PROJECTS_DIR: path.join(os.tmpdir(), 'winmux-verify-noclobber') });

// AUDIT-9 (register item 07). The Rebind dialog takes the whole keyboard while it
// waits for a chord. It gave it back on Esc, on the chord and on Cancel — but
// clicking the dimmed backdrop closed the box by stripping an attribute directly,
// leaving the capture listener attached. Every keystroke in the app then vanished,
// and stayed vanishing across reloads because the app never knew it had happened.
check('keyback', PORT_KEYBACK, async ({ browser, base, t, shot }) => {
  const page = await desktop(browser);
  try {
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    const openRebind = async () => {
      await page.evaluate(() => {
        window.__winmuxRebind ? window.__winmuxRebind('split-right')
          : document.querySelector('[data-rebind="split-right"]').click();
      });
      await page.waitForTimeout(400);
      return page.evaluate(() => ({
        open: !!document.querySelector('#dlg-ovl[data-open]'),
        captured: window.__winmuxRebindCapturing(),
      }));
    };
    const dismissBackdrop = async () => {
      await page.evaluate(() => {
        const o = document.getElementById('dlg-ovl');
        o.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      await page.waitForTimeout(300);
      return page.evaluate(() => ({
        open: !!document.querySelector('#dlg-ovl[data-open]'),
        captured: window.__winmuxRebindCapturing(),
      }));
    };

    const opened = await openRebind();
    t('the rebind dialog opens and takes the keyboard', opened.open && opened.captured === true, opened);
    const after = await dismissBackdrop();
    t('clicking the dimmed backdrop closes it', after.open === false, after);
    t('and it gives the keyboard back — it does not keep capturing', after.captured === false, after);

    // The real symptom, driven rather than inferred: a real keypress on a real
    // shortcut has to reach the app again. F1 (keyboard help), because it is not
    // one of the three chords the terminal-focus guard swallows (item 02).
    await page.keyboard.press('F1');
    await page.waitForTimeout(500);
    const helped = await page.evaluate(() => !!document.querySelector('#cheat-ovl[data-open]'));
    t('a real keypress reaches the app again — the keyboard is not eaten', helped === true, { cheatOpen: helped });
    await shot(page, 'keyback-after-dismiss');
    await page.evaluate(() => {
      const o = document.getElementById('cheat-ovl');
      o.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await page.waitForTimeout(300);

    // Escape is the other route that used to strip the attribute directly.
    const reopened = await openRebind();
    t('reopening takes the keyboard again', reopened.captured === true, reopened);
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await page.waitForTimeout(300);
    const esc = await page.evaluate(() => ({
      open: !!document.querySelector('#dlg-ovl[data-open]'),
      captured: window.__winmuxRebindCapturing(),
    }));
    t('Escape closes it and releases the keyboard too', esc.open === false && esc.captured === false, esc);
  } finally {
    await page.close();
  }
}, { WINMUX_CONFIG_FILE: path.join(OUT, 'keyback-cfg', 'config.json') });

// AUDIT-10 (register item 10). The settings file is advertised as hand-editable.
// A parse error in it was swallowed and treated as "no file at all": the app
// started on empty defaults and the next settings change wrote onto that empty
// base, destroying every imported theme and custom keybinding — and answered
// "saved". One stray comma cost the user the lot, and the recovery overwrote the
// evidence. A damaged file must be KEPT and REPORTED, not quietly replaced.
// --- orphan: closing a tab whose socket is down still ends its shell ------
// AUDIT-8. Closing a tab is the one close that takes the shell with it, and the
// only way to say so was a message over that tab's own socket. Mid-reconnect —
// engine restarted, laptop woken, network blip — the socket is not open, the
// message was silently dropped, and the shell kept running with no tab, no
// sidebar row and no way to reach it. Ten tidied-up tabs, ten invisible
// PowerShells. Counted on the engine, because the engine is where they live.
check('orphan', PORT_ORPHAN, async ({ browser, base, t }) => {
  const page = await desktop(browser);
  const live = () => fetch(base + '/api/info', { cache: 'no-store' })
    .then((r) => r.json()).then((j) => j.sessions);
  try {
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await appReady(page);
    // A second tab, so closing one leaves the workspace alive and the count moves
    // by a knowable amount.
    await page.evaluate(() => document.getElementById('open-new').click());
    await appReady(page);
    await page.waitForFunction('document.querySelectorAll(".ptab").length >= 2', null, { timeout: 20000 });
    const before = await live();
    t('two tabs means two shells on the engine', before >= 2, before);

    // Drop the socket the way a restarted engine does, then close the tab. The
    // app cannot send anything over that socket — which is the whole point.
    const dropped = await page.evaluate(() => {
      const t = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
      if (!t || !t.ws) return null;
      t.ws.close();
      return { sid: t.sid || null, state: t.ws.readyState };
    });
    t('the tab has a shell id and its socket is down', !!dropped && !!dropped.sid, dropped);

    // The close control is hover-reveal, so hover first — that is the real path a
    // user takes, and clicking straight at a hidden control just waits forever.
    await page.hover('.ptab[data-active]');
    await page.click('.ptab[data-active] .x', { timeout: 10000 });
    // Wait for the count to drop — but do NOT assert on that moment. Before the
    // fix it DID drop, and then the queued retry reattached by sid and put the
    // shell straight back: a check that graded the transient called the bug fixed.
    // What a user cares about is whether the shell is gone and STAYS gone, so
    // every assertion below is measured after things have settled.
    await page.waitForFunction(
      `fetch('/api/info', { cache: 'no-store' }).then(function (r) { return r.json(); })
         .then(function (j) { return j.sessions < ${before}; })`,
      null, { timeout: 20000 }).catch(() => {});
    // Long enough for a resurrection to happen if it is going to: the backoff
    // tops out at 5s, so 6 covers a full retry.
    await page.waitForTimeout(6000);
    const after = await live();
    t('closing it ends the shell, even with the socket down', after === before - 1, { before, after });
    t('and exactly one shell went, not the lot', after === before - 1, { before, after });

    await page.waitForTimeout(3000);
    const later = await live();
    t('and it stays gone — no reconnect brings it back', later === before - 1, { before, after, later });
  } finally {
    await page.close();
  }
});

// --- busybar: the tab's busy underline, measured on screen ----------------
// The underline that shows a tab is working had no check at all, so when it was
// switched from animating `width` to `transform: scaleX` — a real fix, since it
// re-animates every 220ms for every working tab — nothing would have reported it
// if the bar had simply stopped appearing. Painted width is what a user sees, so
// painted width is what this measures; it is renderer-independent and would have
// caught either implementation breaking.
check('busybar', PORT_BUSYBAR, async ({ browser, base, t }) => {
  const p = await desktop(browser);
  try {
    await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await p.locator('.ptab .tprog').first().waitFor({ timeout: 20000 });
    const painted = () => p.evaluate(() => {
      const b = document.querySelector('.ptab .tprog');
      return b ? b.getBoundingClientRect().width : -1;
    });
    // Give the shell something slow enough to still be working when we look.
    await p.locator('.xterm-helper-textarea').first().focus();
    await p.keyboard.type('1..40 | % { $_; Start-Sleep -Milliseconds 90 }');
    await p.keyboard.press('Enter');

    await p.waitForFunction(`(function () {
      var b = document.querySelector('.ptab .tprog');
      return !!b && b.getBoundingClientRect().width > 2;
    })()`, null, { timeout: 20000 });
    const mid = await painted();
    t('while the shell is working the bar is visible on screen', mid > 2, mid);

    const tab = await p.evaluate(() => {
      const e = document.querySelector('.ptab');
      return e ? e.getBoundingClientRect().width : 0;
    });
    t('and it is a progress bar, not a full-width block', mid < tab, { bar: mid, tab });

    // It must grow: a bar stuck at its opening 8% would satisfy everything above.
    const grew = await p.waitForFunction(`(function () {
      var b = document.querySelector('.ptab .tprog');
      return !!b && b.getBoundingClientRect().width > ${mid + 1};
    })()`, null, { timeout: 20000 }).then(() => true).catch(() => false);
    t('and it grows as the work continues', grew, { from: mid });

    // And it clears when the shell falls quiet — otherwise every tab you have
    // ever used keeps a permanent "still working" underline. (Asserting this at
    // page load instead would be wrong: the shell's own first prompt is output,
    // so the bar is legitimately running the moment the app opens.)
    const cleared = await p.waitForFunction(`(function () {
      var b = document.querySelector('.ptab .tprog');
      return !!b && b.getBoundingClientRect().width < 1;
    })()`, null, { timeout: 30000 }).then(() => true).catch(() => false);
    t('and it clears once the shell falls quiet', cleared, await painted());
  } finally {
    await p.close();
  }
});

const CFGSAFE_FILE = path.join(os.tmpdir(), 'winmux-verify-cfgsafe', 'config.json');
check('cfgsafe', PORT_CFGSAFE, async ({ browser, base, t }) => {
  const dir = path.dirname(CFGSAFE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  // Start from a clean sandbox: a backup left by an earlier run would let the
  // "the damaged file is kept" assertions pass on last run's evidence.
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true, recursive: true });
  const damaged ='{ "themes": { "mine": { "bg": "#123456" } }, "keymap": { "split-right": "Ctrl+Alt+9" },\n';
  fs.writeFileSync(CFGSAFE_FILE, damaged);   // truncated JSON — exactly a hand-edit slip
  const cfg = await fetch(base + '/api/config', { cache: 'no-store' }).then((r) => r.json());

  t('the engine reports that the settings file could not be read',
    typeof cfg.configError === 'string' && cfg.configError.length > 0, cfg.configError);
  t('and it does NOT pretend the file was empty', !!cfg.configError, { config: cfg.config });
  t('the damaged file is kept, not destroyed', !!cfg.configBackup && fs.existsSync(cfg.configBackup),
    cfg.configBackup && path.basename(cfg.configBackup));
  // The user has to find this file in Explorer. Both engines must date it the
  // same readable way — the Rust core used to stamp it with an epoch second.
  t('and it is named with a date a person can read',
    /config\.damaged-\d{4}-\d{2}-\d{2}T[\d-]+Z?\.json$/.test(cfg.configBackup || ''),
    cfg.configBackup && path.basename(cfg.configBackup));
  t('and what was kept is the user\'s original bytes, untouched',
    !!cfg.configBackup && fs.readFileSync(cfg.configBackup, 'utf8') === damaged);
  t('the live settings path is now clear, so the app starts on real defaults',
    !fs.existsSync(CFGSAFE_FILE), fs.existsSync(CFGSAFE_FILE));

  // The destructive half: a settings change after a damaged read must not be
  // able to bury the original. It can't, because the original is elsewhere.
  // And the user is actually told — in the app, not just in a JSON field. This
  // runs BEFORE the save below: once a good config is written the engine is
  // healthy again and correctly stops reporting trouble, so a page opened after
  // the save would prove nothing about what the user saw.
  const page = await desktop(browser);
  let told = '';
  try {
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    const SEEN = `[].slice.call(document.querySelectorAll('#npanel, .notif, .nrow, .ntitle'))
      .map(function (n) { return n.textContent || ''; }).join(' | ')`;
    // Wait for the notice to appear, not for a guessed number of seconds.
    await page.waitForFunction(`/could not be read/i.test(${SEEN})`, null, { timeout: 20000 })
      .catch(() => {});
    told = await page.evaluate(SEEN);
    t('the app tells the user their settings file could not be read',
      /could not be read/i.test(told), told.slice(0, 200));
    // And it reads as a notice, not a riddle: every notify() passes the headline
    // as the title, so the title must come first in the row. It used to come
    // after the body, which buried this one under five faint lines.
    const order = await page.evaluate(`(function () {
      var r = document.querySelector('.nrow'); if (!r) return null;
      var t = r.querySelector('.nt'), s = r.querySelector('.nws');
      if (!t || !s) return null;
      return { titleTop: t.getBoundingClientRect().top, subTop: s.getBoundingClientRect().top };
    })()`);
    t('and the headline is above the explanation, not under it',
      !!order && order.titleTop < order.subTop, order);
  } finally {
    await page.close();
  }

  const saved = await fetch(base + '/api/config', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { fontSize: 17 } }),
  }).then((r) => r.json());
  t('a settings change after a damaged read still saves', saved && saved.ok !== false, saved);
  t('and the user\'s original themes and keys are STILL on disk afterwards',
    !!cfg.configBackup && /"mine"/.test(fs.readFileSync(cfg.configBackup, 'utf8')));
}, { WINMUX_CONFIG_FILE: CFGSAFE_FILE });

// ST6: non-terminal leaves survive a page reload. Both a diff leaf AND a markdown
// leaf, opened as pane tabs, must be persisted in the live snapshot and rebuilt on
// reload — before ST6, snapshot() filtered leaves out, so they vanished. This proves
// a mixed pane (terminal + two distinct leaf types) comes back whole. (Browser leaves
// are Electron-only and are exercised by the `electron` smoke, not here.)
check('leaf-persist', PORT_LEAFPERSIST, async ({ browser, base, t, shot }) => {
  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_LEAFPERSIST), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = '';
    proc.stdout.on('data', (d) => o += d);
    proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });
  const mdFile = path.join(OUT, 'leafpersist-' + PORT_LEAFPERSIST + '.md');
  fs.writeFileSync(mdFile, '# Persisted Doc\n\nsurvives a reload.\n');
  const page = await desktop(browser);
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);          // connect to /control so the CLI can reach it
    // A diff leaf (via the menu) and a markdown leaf (via the CLI) in the same pane.
    await page.locator('.pc-new').first().click();
    await page.waitForTimeout(200);
    await page.locator('.tmenu .tmi:has-text("Changes")').first().click();
    await page.waitForTimeout(1200);
    const md = await winmux(['markdown', mdFile]);
    t('winmux markdown opened a leaf to persist', md.code === 0, md.err);
    await page.waitForTimeout(1500);
    const before = await page.evaluate(() => ({
      diff: !!document.querySelector('.ptab[data-leaf="diff"]'),
      md: !!document.querySelector('.ptab[data-leaf="markdown"]'),
      term: !!document.querySelector('.ptab:not([data-leaf])'),
    }));
    t('a diff leaf, a markdown leaf and a terminal are open before the reload',
      before.diff && before.md && before.term, before);

    // The whole page torn down and rebuilt — the live snapshot must carry both leaves.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    const after = await page.evaluate(() => ({
      diff: !!document.querySelector('.ptab[data-leaf="diff"]'),
      md: !!document.querySelector('.ptab[data-leaf="markdown"]'),
      term: !!document.querySelector('.ptab:not([data-leaf])'),
      diffBody: !!document.querySelector('.term-host.diffleaf'),
      mdBody: !!(document.querySelector('.mdleaf .mdbody') && /Persisted Doc/.test((document.querySelector('.mdleaf .mdbody') || {}).textContent || '')),
    }));
    t('the diff leaf came back after the reload (not dropped)', after.diff === true, after);
    t('the markdown leaf came back after the reload too', after.md === true, after);
    t('the terminal is still there alongside them', after.term === true, after);
    t('the restored diff leaf rebuilt its body', after.diffBody === true, after);
    t('the restored markdown leaf re-rendered its file', after.mdBody === true, after);
    await shot(page, 'leaf-persist');
  } finally {
    await page.close();
  }
});

// --- restart: scrollback outlives the whole server, not just a dropped socket ---
// A dropped socket detaches; a full reboot kills the server process itself, taking
// the in-memory scrollback with it. WinMux now writes each session's output to disk
// (throttled) so a restarted server can hand it back, and the client replays it as
// history on reconnect. This proves the durable seam without xterm timing: run a
// command, kill the server dead, start a fresh one on the SAME config, and ask for
// that session's kept output.
check('restart', PORT_RESTART, async ({ browser, base, t, skip }) => {
  if (SERVERS[PORT_RESTART] && SERVERS[PORT_RESTART].borrowed)
    return skip('borrowed a server already on ' + PORT_RESTART + ', and killing it is the premise');
  const MARK = 'RESTART_SURVIVES_' + PORT_RESTART;
  const page = await desktop(browser);
  let sid = '';
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await page.click('.xterm').catch(() => {});
    await page.keyboard.type('echo ' + MARK);
    await page.keyboard.press('Enter');
    // Wait until the output is really on screen BEFORE trusting the throttle — under
    // full-run load the echo can land late, and a save that fires first would capture
    // the pre-marker buffer. Confirm it rendered, then let the ~2s throttle write it.
    let onScreen = false;
    for (let i = 0; i < 30; i++) {
      const s = await page.evaluate(() => { const r = document.querySelector('.xterm-rows'); return r ? r.innerText : ''; });
      if (s.includes(MARK)) { onScreen = true; break; }
      await page.waitForTimeout(400);
    }
    t('the shell captured the work before the restart', onScreen);
    await page.waitForTimeout(2600);   // guarantee the post-marker throttled save lands on disk
    sid = await page.evaluate(() => {
      try { return (JSON.stringify(JSON.parse(localStorage.getItem('ct-live') || '{}')).match(/"sid":"([a-f0-9]{32})"/) || [])[1] || ''; } catch (e) { return ''; }
    });
    t('the tab has a session id to recover by', /^[a-f0-9]{32}$/.test(sid), sid);
  } finally {
    await page.close();
  }

  // The reboot: kill the server dead, then start a fresh one on the SAME config so
  // its backlog dir is the one the first server wrote — nothing in memory carries over.
  SERVERS[PORT_RESTART].stop();
  for (let i = 0; i < 40 && (await inUse('127.0.0.1', PORT_RESTART)); i++)
    await new Promise((r) => setTimeout(r, 250));
  SERVERS[PORT_RESTART] = await server(PORT_RESTART, { WINMUX_FORCE_DOM: '1' });

  const bl = JSON.parse((await get(base + '/api/backlog?sid=' + sid)).body);
  t('the restarted server still has that session’s scrollback', bl.found === true, { found: bl.found });
  t('and hands back the exact work that was on screen', typeof bl.buf === 'string' && bl.buf.includes(MARK));
});

// --- drop: a folder dragged in from Explorer becomes a path ---------------
// Every terminal on Windows lets you type "cd " and drag a folder in. A browser
// refuses to tell a page where a dropped folder lives, so WinMux asks the server
// to find it by name and contents. Two things have to hold or the feature is
// worse than not having it: the right folder wins when two share a name, and a
// drop that misses the pane must not navigate the whole app away.
check('drop', PORT_DROP, async ({ browser, base, t }) => {
  const find = async (name, kids, near) => JSON.parse((await get(base + '/api/findpath' +
    '?name=' + encodeURIComponent(name) +
    '&kids=' + encodeURIComponent((kids || []).join('|')) +
    '&near=' + encodeURIComponent(near || ''))).body).hits;

  // Use a uniquely-named fixture folder, not __dirname: in the monorepo the dir
  // holding this harness is named "electron", which collides with node_modules/
  // electron and the electron/ source dir, so a name-based find is ambiguous.
  const self = path.join(OUT, 'drop-self-' + PORT_DROP);
  fs.mkdirSync(self, { recursive: true });
  fs.writeFileSync(path.join(self, 'marker-' + PORT_DROP + '.txt'), 'x');
  const mine = await find(path.basename(self), fs.readdirSync(self), OUT);
  t('the folder you dropped is the folder it finds',
    mine.length && mine[0].path.toLowerCase() === self.toLowerCase(), mine[0]);

  // Two folders, same name, different contents — the only thing that can tell
  // them apart is what is inside, which is exactly what the browser hands over.
  const twin = path.join(OUT, 'twin-' + PORT_DROP);
  const right = path.join(twin, 'a', 'ledger');
  const wrong = path.join(twin, 'b', 'ledger');
  fs.mkdirSync(right, { recursive: true });
  fs.mkdirSync(wrong, { recursive: true });
  fs.writeFileSync(path.join(right, 'invoices.txt'), 'x');
  fs.writeFileSync(path.join(wrong, 'something-else.txt'), 'x');
  const picked = await find('ledger', ['invoices.txt'], twin);
  t('contents decide it when two folders share a name',
    picked.length && picked[0].path.toLowerCase() === right.toLowerCase(), picked[0]);

  // The suffix used to be -9917, which is port-shaped. It was never a port, but
  // the raw-literal scan cannot know that, and an exemption list is how a guard
  // starts dying. Cheaper to pick a string that is obviously not a port.
  const none = await find('no-folder-is-called-this-zzq', ['a', 'b']);
  t('a folder that is not on this machine comes back empty, not wrong', none.length === 0, none);

  const page = await desktop(browser);
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // Dragging over a pane has to say something, or the drop looks broken until
    // it works.
    const hint = await page.evaluate(() => {
      const pane = document.querySelector('.pane');
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'x.txt'));
      pane.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      const pv = pane.querySelector('.split-preview');
      return { text: pv ? pv.textContent : '', shown: pv ? pv.style.display : '' };
    });
    t('a folder dragged over a pane is invited in', /Drop to paste/.test(hint.text) && hint.shown === 'flex', hint);

    // The browser's own default for a dropped file is to leave the app and
    // display the file. That would look exactly like a crash.
    const stray = await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'x.txt'));
      const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, url: location.href };
    });
    t('a drop that misses the pane does not throw the app away',
      stray.prevented && stray.url.indexOf(':' + PORT_DROP) > 0, stray);
  } finally {
    await page.close();
  }
});

// --- colour: the shell's sixteen colours are ours, and are readable ---------
// This one refuses to take the app's word for it. It runs a real PowerShell
// command that emits real ANSI escapes, then reads the colour off the span
// xterm actually painted — because "we set the option" and "the character on
// screen is that colour" are different claims, and only the second one is what
// @edward looks at.
const rgbToHex = (s) => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s || '');
  return m ? '#' + [1, 2, 3].map((i) => (+m[i]).toString(16).padStart(2, '0')).join('') : null;
};
const relLum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
  const x = relLum(a), y = relLum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

// PSReadLine paints every command you type in bright yellow (SGR 93) and every
// parameter in bright black (SGR 90) — the exact two slots @edward is looking
// at all day, so those are the two this check reads back off the screen.
const MARKED = 'Write-Host ("{0}[93mQQAQQ{0}[90mQQBQQ{0}[0m" -f [char]27)';

// Walk the row's spans accumulating text, so it does not matter whether xterm
// emitted one span for the run or one per character.
const READ_MARKS = () => {
  const pick = (marker) => {
    for (const row of document.querySelectorAll('.xterm-rows > div')) {
      const spans = [...row.querySelectorAll('span')];
      let acc = '';
      const map = [];
      for (const s of spans) {
        map.push([acc.length, acc.length + s.textContent.length, s]);
        acc += s.textContent;
      }
      // The echoed input line contains the markers too — it is not the output.
      if (acc.includes('Write-Host')) continue;
      const i = acc.indexOf(marker);
      if (i < 0) continue;
      for (const [a, b, s] of map) if (i >= a && i < b) return getComputedStyle(s).color;
    }
    return null;
  };
  const vp = document.querySelector('.xterm-viewport') || document.querySelector('.xterm');
  return { yellow: pick('QQAQQ'), dim: pick('QQBQQ'), bg: getComputedStyle(vp).backgroundColor };
};

async function paintMarks(page, base) {
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  await page.click('.xterm-screen');
  await page.keyboard.type(MARKED);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  const m = await page.evaluate(READ_MARKS);
  return { yellow: rgbToHex(m.yellow), dim: rgbToHex(m.dim), bg: rgbToHex(m.bg) };
}

check('colour', PORT_COLOUR, async ({ browser, base, t, shot }) => {
  // The palette that used to ship. Nobody chose it: naming no ANSI colours makes
  // xterm.js fall back to Tango, and Tango was drawn for a different background.
  const TANGO_BRIGHT_YELLOW = '#fce94f';
  const TANGO_BRIGHT_BLACK = '#555753';

  const dark = await desktop(browser);
  try {
    const d = await paintMarks(dark, base);
    t('dark: the shell is drawn on the near-black we designed against', d.bg === '#1a1a1a', d);
    t('dark: what you type is no longer Tango\'s #fce94f',
      d.yellow && d.yellow !== TANGO_BRIGHT_YELLOW, d.yellow);
    t('dark: bright yellow is the Aurora sand we chose', d.yellow === '#f2cf88', d.yellow);
    t('dark: parameters are no longer Tango\'s 2.4:1 mud',
      d.dim && d.dim !== TANGO_BRIGHT_BLACK, d.dim);
    t('dark: both clear 4.5:1 against the real background',
      contrast(d.yellow, d.bg) >= 4.5 && contrast(d.dim, d.bg) >= 4.5,
      { yellow: contrast(d.yellow, d.bg).toFixed(2), dim: contrast(d.dim, d.bg).toFixed(2) });
    // The old yellow was not too dim — it was a 14:1 shout. Prove we came down.
    t('dark: the glare is gone (was 14.01:1, a pure saturated yellow)',
      contrast(d.yellow, d.bg) < 12, contrast(d.yellow, d.bg).toFixed(2));
    await shot(dark, 'colour-dark');
  } finally { await dark.close(); }

  // One palette cannot serve both grounds — that is the whole reason there are
  // two. If light mode handed back the dark values, this check has no point.
  // READ_MARKS scrapes span colours out of .xterm-rows, which only the DOM renderer
  // creates — so pin it (gpuRenderer:false), same as the dark half's desktop() does.
  // Without the pin the shipping WebGL default paints to canvas and the read is null
  // (or races the async DOM->WebGL swap, making this flaky).
  const lightPage = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await lightPage.addInitScript(() => { try {
    localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1');
    const s = JSON.parse(localStorage.getItem('ct-settings') || '{}'); s.gpuRenderer = false;
    localStorage.setItem('ct-settings', JSON.stringify(s));
  } catch (e) {} });
  try {
    const l = await paintMarks(lightPage, base);
    t('light: the shell is drawn on the near-white we designed against', l.bg === '#fbfbfb', l);
    t('light: the colours are a different set, not the dark ones reused', l.yellow !== '#f2cf88', l.yellow);
    t('light: bright yellow is the dark amber that survives white', l.yellow === '#96620f', l.yellow);
    t('light: both clear 4.5:1 — where Tango\'s yellow was 1.20:1, invisible',
      contrast(l.yellow, l.bg) >= 4.5 && contrast(l.dim, l.bg) >= 4.5,
      { yellow: contrast(l.yellow, l.bg).toFixed(2), dim: contrast(l.dim, l.bg).toFixed(2) });
    await shot(lightPage, 'colour-light');
  } finally { await lightPage.close(); }

  // The Settings picker has to actually reach the shell, not just the dropdown.
  // Since PT-6 the engine's config.json is the settings authority and wins over
  // the localStorage cache on boot — an earlier page in this check may already
  // have POSTed its aurora settings here, which would honestly override a
  // cache-only pin. So the palette pick goes to the authority too.
  await post(base + '/api/config', JSON.stringify({ settings: { palette: 'ember', gpuRenderer: false } }));
  const ember = await desktop(browser);
  try {
    await ember.addInitScript(() => {
      // Merge, don't clobber: a wholesale overwrite here would wipe the
      // gpuRenderer:false pin desktop() set, dropping this page back to the WebGL
      // renderer whose canvas has no .xterm-rows for paintMarks to read (-> null).
      const s = JSON.parse(localStorage.getItem('ct-settings') || '{}');
      s.palette = 'ember'; s.gpuRenderer = false;
      localStorage.setItem('ct-settings', JSON.stringify(s));
    });
    const e = await paintMarks(ember, base);
    t('picking a different palette repaints the terminal', e.yellow === '#f5c87c', e.yellow);
    t('every palette clears the floor, not just the default',
      contrast(e.yellow, e.bg) >= 4.5 && contrast(e.dim, e.bg) >= 4.5,
      { yellow: contrast(e.yellow, e.bg).toFixed(2), dim: contrast(e.dim, e.bg).toFixed(2) });
    await shot(ember, 'colour-ember');
  } finally { await ember.close(); }
});

// --- groups: the side is groups, the top is that group's sessions ---------
// The defect this exists to keep fixed: the sidebar shipped as a second copy of
// the tab bar. The design contract has always been two levels — a group row on
// the side owns many terminals, and the top strip shows only the open group's.
// Every assertion below is measured (computed style, counted nodes), never
// eyeballed, because a tab hidden by a `display:none` still looks fine in a shot.

// The sidebar as the DOM actually has it, in one round trip.
const SIDEBAR = () => {
  const rows = [...document.querySelectorAll('#sx-list .prow')].map((r) => ({
    id: r.getAttribute('data-switch'),
    name: r.querySelector('.pname').textContent.trim(),
    sub: r.querySelector('.psub').textContent.trim(),
    active: r.hasAttribute('data-active'),
    open: !!r.querySelector('.pexpand[data-open2]'),
  }));
  // Scoped to the workspace panes (#wsrow), the only place tabs live now.
  const tabs = [...document.querySelectorAll('#wsrow .ptabs .ptab')].map((el) => ({
    text: el.querySelector('.tt').textContent.trim(),
    shown: getComputedStyle(el).display !== 'none',
  }));
  return {
    rows,
    count: document.getElementById('sx-count').textContent.trim(),
    view: document.getElementById('root').getAttribute('data-view'),
    tabs,
    shown: tabs.filter((x) => x.shown).length,
    kids: document.querySelectorAll('#sx-list .skids .srow').length,
  };
};

check('groups', PORT_GROUPS, async ({ browser, base, t, shot }) => {
  const p = await desktop(browser);
  await p.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await appReady(p);
  // Naming a group goes through the in-app dialog (window.prompt is dead in
  // Electron, so it was replaced by promptDialog) — fill + confirm it.
  const nameGroup = async (name) => {
    await p.click('#open-newgroup');
    await p.waitForTimeout(400);
    await p.fill('#dlg-body .dlg-in', name);
    await p.click('#dlg-body [data-ok]');
    await p.waitForTimeout(800);
  };

  const first = await p.evaluate(SIDEBAR);
  t('the sidebar opens on one group, not a terminal list', first.rows.length === 1, first.rows);
  t('the header count counts groups', first.count === '1', first.count);
  t('the group row rolls its terminals up into a sub-line',
    /^1 session · /.test(first.rows[0].sub), first.rows[0].sub);
  t('that one group owns the one terminal on top', first.shown === 1, first.tabs);

  // A second group. Its terminals are a different set from the first group's.
  await nameGroup('Client work');
  const two = await p.evaluate(SIDEBAR);
  t('the new group appears on the side', two.rows.length === 2 && two.rows.some((r) => r.name === 'Client work'),
    two.rows.map((r) => r.name));
  t('the header count follows', two.count === '2', two.count);
  t('making a group opens it', (two.rows.find((r) => r.name === 'Client work') || {}).active === true);
  t('the top strip shows exactly the open group — one terminal, not two',
    two.shown === 1 && two.tabs.length === 2, two.tabs);
  await shot(p, 'desktop');

  // Two terminals in this group, so the sub-line has arithmetic to get wrong.
  await p.click('#open-new');
  await p.waitForTimeout(1200);
  const grown = await p.evaluate(SIDEBAR);
  const clientRow = grown.rows.find((r) => r.name === 'Client work');
  t('the sub-line counts this group only', /^2 sessions · /.test(clientRow.sub), clientRow.sub);
  t('and the top strip grew with it', grown.shown === 2, grown.tabs);

  // The chevron peeks into a group. Peeking is not switching.
  //
  // This clicked once and asserted "now it is open", which quietly assumed the
  // group started shut. That assumption was true only by accident, and AUDIT-B6
  // — the fleet list ships open and remembers — made it false, so the one click
  // shut the group and this read 0. The check was measuring a starting state it
  // never established. It now drives the control as what it actually is, a
  // toggle: shut it if it is showing, then open it, and assert on the open side.
  const otherId = grown.rows.find((r) => r.name !== 'Client work').id;
  const arrow = '.prow[data-switch="' + otherId + '"] .pexpand';
  if ((await p.evaluate(SIDEBAR)).kids > 0) { await p.click(arrow); await p.waitForTimeout(400); }
  const shut = await p.evaluate(SIDEBAR);
  t('the arrow shuts a group that is showing its sessions', shut.kids === 0, shut.kids);
  await p.click(arrow);
  await p.waitForTimeout(400);
  const peeked = await p.evaluate(SIDEBAR);
  t('the arrow opens that group\'s sessions inline', peeked.kids === 1, peeked.kids);
  t('peeking did NOT switch groups', (peeked.rows.find((r) => r.name === 'Client work') || {}).active === true);
  t('the top strip did not move', peeked.shown === 2, peeked.shown);
  const caret = await p.evaluate((id) => {
    const svg = document.querySelector('.prow[data-switch="' + id + '"] .pexpand svg');
    return getComputedStyle(svg).transform;
  }, otherId);
  // cockpit.css:392 rotates the caret 90°; a right-pointing caret becomes a down one.
  t('the caret is rotated, so it reads as open', caret === 'matrix(0, 1, -1, 0, 0, 0)', caret);
  await shot(p, 'expanded');

  // Clicking the row itself IS switching — the whole two-level model.
  await p.click('.prow[data-switch="' + otherId + '"] .pinfo');
  await p.waitForTimeout(900);
  const swapped = await p.evaluate(SIDEBAR);
  t('clicking a group swaps the top tab strip', swapped.shown === 1, swapped.tabs);
  t('nothing from the other group is left reachable on top',
    swapped.tabs.filter((x) => x.shown).length === 1 && swapped.tabs.length === 3, swapped.tabs);

  // Closing the last terminal of the open group must leave a live shell, not an
  // empty frame and not a pane that eats the other group's terminals.
  await p.click('#wsrow .ptab[data-active] .x');
  await p.waitForTimeout(1200);
  const emptied = await p.evaluate(SIDEBAR);
  t('closing the group\'s last terminal leaves a live one, never a blank pane',
    emptied.shown === 1, emptied.tabs);

  // Names and the open group are the thing that has to survive a reload.
  await p.reload({ waitUntil: 'domcontentloaded' });
  await appReady(p);
  const back = await p.evaluate(SIDEBAR);
  t('both groups come back by name after a reload',
    back.rows.length === 2 && back.rows.some((r) => r.name === 'Client work'), back.rows.map((r) => r.name));
  t('and the group that was open is still the open one',
    (back.rows.find((r) => r.id === otherId) || {}).active === true, back.rows);
  await p.close();

  // The phone can only show one level at a time, so it is three screens. This
  // context is a fresh browser with empty storage — which, since PT-3, means it
  // inherits the engine-owned shared workspace (STATE.md: one workspace per
  // identity), so it arrives holding the desk's two groups. The walk still starts
  // at the bottom and climbs, which is exactly the back-arrow chain a phone needs.
  const ph = await phoneCtx(browser);
  await ph.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await ph.waitForTimeout(5000);
  t('a phone with one group and one terminal opens straight into the terminal — a list of one costs a pointless tap',
    (await ph.evaluate(SIDEBAR)).view === 'focus');
  await shot(ph, 'phone-terminal');

  // Header B phone header: the back-arrow lives in the brand bar (#nhead-ctx) and is
  // view-aware. The separate nsessions .nbar and the tab-bar back-arrow are hidden so
  // the phone keeps two bars: brand bar + content. #ns-name still exists (hidden) and
  // is painted by renderNarrowSessions, so reading it here stays valid.
  await ph.click('#nhead-ctx');
  await ph.waitForTimeout(600);
  const v2 = await ph.evaluate(SIDEBAR);
  const ns = await ph.evaluate(() => ({
    name: document.getElementById('ns-name').textContent.trim(),
    ctx: document.getElementById('nhead-ctx-name').textContent.trim(),
    cards: document.querySelectorAll('#ns-list .ncard[data-open]').length,
    shown: getComputedStyle(document.querySelector('.nsessions')).display,
  }));
  t('back from a terminal lands on that group\'s sessions, not on the groups', v2.view === 'sessions', v2.view);
  t('the sessions screen is actually on screen', ns.shown === 'flex', ns);
  t('it is titled with the group and lists its terminals', ns.name === 'Workspace' && ns.cards === 1, ns);
  t('header B: the brand bar carries the group name on the session list', ns.ctx === 'Workspace', ns);
  await shot(ph, 'phone-sessions');

  // Header B: the brand-bar back-arrow is view-aware — from the session list it goes to Groups.
  await ph.click('#nhead-ctx');
  await ph.waitForTimeout(600);
  t('back again lands on the groups — the top of the phone stack',
    (await ph.evaluate(SIDEBAR)).view === 'projects');

  // A second group, made from the phone via the same in-app naming dialog.
  await ph.click('#open-newgroup');
  await ph.waitForTimeout(400);
  await ph.fill('#dlg-body .dlg-in', 'Phone group');
  await ph.click('#dlg-body [data-ok]');
  await ph.waitForTimeout(1200);
  const madeIt = await ph.evaluate(() => ({
    view: document.getElementById('root').getAttribute('data-view'),
    name: document.getElementById('ns-name').textContent.trim(),
    cards: document.querySelectorAll('#ns-list .ncard[data-open]').length,
  }));
  t('making a group opens it on its own sessions screen', madeIt.view === 'sessions' && madeIt.name === 'Phone group', madeIt);
  // A new group is never an empty frame — it comes with one live shell, and that
  // shell belongs to the new group, not to the one you just left.
  t('a brand-new group arrives with exactly one live shell of its own', madeIt.cards === 1, madeIt);

  // Header B: view-aware back-arrow from the new group's session list → Groups.
  await ph.click('#nhead-ctx');
  await ph.waitForTimeout(600);
  const phRows = await ph.evaluate(SIDEBAR);
  // The desk's two groups came in with the shared workspace; the phone's new
  // group joins them — three groups, nothing lost and nothing duplicated.
  t('the phone group list shows the shared groups plus the new one',
    phRows.rows.length === 3 && phRows.rows.some((r) => r.name === 'Phone group'),
    phRows.rows.map((r) => r.name));
  await shot(ph, 'phone-groups');

  // And the way back down: group → its sessions → a terminal.
  await ph.click('#sx-list .prow[data-switch="1"] .pinfo');
  await ph.waitForTimeout(800);
  t('tapping a group opens its sessions, not a terminal',
    (await ph.evaluate(SIDEBAR)).view === 'sessions');
  await ph.click('#ns-list .ncard[data-open]');
  await ph.waitForTimeout(800);
  t('tapping a session opens the terminal', (await ph.evaluate(SIDEBAR)).view === 'focus');
});

// --- electron: the third face — the desktop shell boots the same cockpit ----
// The other checks prove the web/phone face over a socket. This one proves the
// Electron face: the app boots server.cjs IN-PROCESS, loads the same cockpit in
// a frameless native window, and the window.winmux bridge is really injected.
// Playwright's _electron launcher hangs on the CDP handshake in this environment,
// so the shell is driven directly — electron runs dist-electron/main.js in
// WINMUX_SMOKE mode, which self-checks the rendered page, writes a JSON verdict
// plus verify-out/electron-shell.png, and quits. This check reads that verdict.
// It ignores `base`/`browser`: the Electron app is its own server and its own
// client, which is the whole point of the third face.
check('electron', PORT_GROUPS, async ({ t }) => {
  const main = path.join(ROOT, 'dist-electron', 'main.js');
  if (!fs.existsSync(main)) {
    t('the Electron bundle is built (npm run build:electron)', false, main);
    return;
  }
  let electronPath = null;
  try { electronPath = require('electron'); } catch (e) { /* not installed */ }
  if (typeof electronPath === 'string') electronPath = electronPath.trim();
  if (typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
    t('the Electron binary is present', false, electronPath);
    return;
  }

  const outFile = path.join(OUT, 'electron-smoke.json');
  try { fs.unlinkSync(outFile); } catch (e) { /* fresh */ }

  // ST6 persists the browser + diff leaves this smoke opens. The dev profile
  // (WinMuxDev) survives across runs, so a prior run's leaves would be restored and
  // dirty the clean-startup layout the menu/browser tests assume. Wipe the dev
  // profile's Local Storage before each run for a deterministic default layout.
  try {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    fs.rmSync(path.join(appData, 'WinMuxDev', 'Local Storage'), { recursive: true, force: true });
  } catch (e) { /* best effort */ }

  // The engine-owned workspace (PT-3) is exactly the kind of durable state this
  // smoke must not inherit across runs or leak into a real identity — pin it to
  // a scratch file and start that file empty, like the Local Storage wipe above.
  const wsFile = path.join(OUT, 'electron-workspace.json');
  try { fs.unlinkSync(wsFile); } catch (e) { /* fresh */ }
  const res = await new Promise((resolve) => {
    const proc = spawn(electronPath, [main], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { WINMUX_SMOKE: '1', WINMUX_SMOKE_OUT: outFile, WINMUX_FORCE_DOM: '1', WINMUX_WORKSPACE_FILE: wsFile }),
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      try { proc.kill(); } catch (e) {}
      resolve({ code: null, timedOut: true });
      // The claim is that the app quits by ITSELF rather than hanging forever —
      // not that it quits inside a minute. This cap is only the hang guard, and
      // 60s was a guess that a loaded full-suite run overran while every other
      // assertion in this check passed: the app had done its whole job and was
      // simply still shutting down. Widened, not weakened — a real hang still
      // fails, it just takes longer to say so.
    }, 180000);
    proc.on('exit', (code) => { clearTimeout(timer); resolve({ code, timedOut: false }); });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ code: null, timedOut: false, err: String(e.message || e) }); });
  });
  t('the Electron app launched and exited on its own', res.timedOut === false && !res.err, res);

  let json = null;
  try { json = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (e) { /* stays null */ }
  t('the shell wrote a smoke verdict', !!json, json);
  t('the cockpit rendered inside the native window', !!json && json.hasCockpit === true, json);
  t('the window.winmux bridge is injected', !!json && json.isElectron === true, json);
  t('the document is tagged data-electron', !!json && json.dataElectron === true, json);
  // Phase 7 quake drop: the OS accepted the global-hotkey binding, and driving the
  // toggle reveals a hidden window. (A real keypress needs a human at a real display.)
  t('the global quake hotkey registers with the OS', !!json && json.quakeRegistered === true, json && { quakeRegistered: json.quakeRegistered, quakeError: json.quakeError });
  t('the quake toggle drops a hidden window into view', !!json && json.quakeDrops === true, json && { quakeDrops: json.quakeDrops });
  // SP-2: the summon must be instant — the part main owns (position+show+focus)
  // inside the 100ms budget, measured on the real window, every smoke run.
  // Best of three: the budget is a claim about the app, and one sample taken while
  // three Electron smokes share the machine is not that. All three are reported, so
  // a real regression still reads as every sample over budget.
  t('the summon reveals within the 100ms budget', !!json && typeof json.quakeMs === 'number' && json.quakeMs >= 0 && json.quakeMs <= 100, json && { quakeMs: json.quakeMs, samples: json.quakeSamples });
  t('the frameless tab bar resolves to a real drag handle',
    !!json && json.ptabsRegion === 'drag', json && json.ptabsRegion);
  t('the smoke run hit no error', !!json && !json.error, json && json.error);

  // The Electron-only feature (Phase 10): a controllable <webview> browser panel,
  // driven through the real /rpc → /control chain that the `winmux` CLI uses.
  // The smoke run opened a data: page, snapshotted its interactive nodes, and
  // clicked one — proving the panel navigates and is scriptable, not just mounted.
  t('the browser panel opened a page over /rpc', !!json && json.browserOpened === true, json && json.browserError);
  t('the snapshot tagged the page\'s interactive elements as @refs',
    !!json && json.browserRefs >= 2, json && json.browserRefs);
  t('a snapshotted element was clickable through the CLI path',
    !!json && json.browserClicked === true, json && json.browserError);

  // Item 7 T2 — the automation verb set: fill+type set a field (read back via
  // eval), get-text dumps the page, eval computes, scroll moves the viewport.
  t('fill + type set a field, read back by eval', !!json && json.browserTyped === true, json && json.browserError);
  t('get-text returns the page\'s visible text', !!json && json.browserGotText === true, json && json.browserError);
  t('eval computes an expression in the page', !!json && json.browserEval === true, json && json.browserError);
  t('scroll moves the viewport', !!json && json.browserScrolled === true, json && json.browserError);
  // ST3: the browser is a pane TAB now, not a side dock — the leaf renders a
  // .ptab with the browser favicon and the old .wmb dock element is gone.
  t('the browser opened as a pane tab (leaf), not a side dock',
    !!json && json.browserIsTab === true, json && json.browserError);
  // ST5/ST6: the git-diff surface also opens as a pane tab inside the packaged
  // Electron app and renders real git status — not just in the plain-browser harness.
  t('the diff surface opened as a pane tab inside Electron',
    !!json && json.diffIsTab === true, json && (json.diffError || json.diffIsTab));
  t('the diff leaf rendered git status inside Electron',
    !!json && json.diffRendered === true, json && (json.diffError || json.diffRendered));

  // node-pty under Electron's ABI (#209): the smoke run drove the real terminal —
  // a live node-pty shell — to run `echo <token>` and read the marker back off the
  // screen. If node-pty's N-API prebuild had failed to load under Electron, the
  // app would have crashed on boot; this proves the native module loads AND spawns
  // a working shell in the packaged desktop face, not just in plain Node.
  t('a real node-pty shell ran a command under Electron', !!json && json.ptyOk === true,
    json && (json.ptyError || 'ptyOk=' + (json && json.ptyOk)));

  // Surfaces-as-tabs (Phase 1): the "+" button opens a type menu. Under Electron all
  // four surfaces are available: Terminal, Browser, Markdown and Changes (git diff).
  const menu = (json && json.menuTypes) || [];
  t('the "+" button opens a New-tab type menu', Array.isArray(menu) && menu.length >= 4, menu);
  t('the menu offers Terminal / Browser / Markdown / Changes',
    ['Terminal', 'Browser', 'Markdown', 'Changes'].every((k) => menu.indexOf(k) >= 0), menu);
});

// --- agentjob: server-side agent-job store (Stage 3) ----------------------
// The orchestration core: one session registers a job, another waits until it
// finishes and gets its result as data. Handled by the server itself, so this
// check needs NO browser — it proves a wait works with no app attached, which
// is the whole point. Mechanism proof (a synthetic reporter); a real Claude
// spawning another is the separate local E2E gate.
check('agentjob', PORT_AGENTJOB, async ({ t }) => {
  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_AGENTJOB), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = '';
    proc.stdout.on('data', (d) => o += d);
    proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });
  const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const reg = parse((await winmux(['agent', 'register', '--name', 'build-x', '--json'])).out);
  t('register mints a job in working state', reg && reg.job && /^job_/.test(reg.job.jobId) && reg.job.state === 'working', reg);
  const jobId = reg && reg.job && reg.job.jobId;

  const st0 = parse((await winmux(['agent', 'status', '--job', jobId, '--json'])).out);
  t('status reads the job back by id', st0 && st0.job && st0.job.jobId === jobId, st0);

  // Start a wait WITHOUT awaiting, then report done+result — the wait must unblock with the data.
  const waitP = winmux(['agent', 'wait', '--job', jobId, '--timeout', '20', '--json']);
  await sleep(600);
  const rep = await winmux(['agent', 'done', '--job', jobId, '--result', 'the answer is 42']);
  t('report done exits clean', rep.code === 0, rep.err);
  const waited = await waitP;
  const wj = parse(waited.out);
  t('a blocked wait unblocks with the reported result', wj && wj.job && wj.job.state === 'done' && wj.job.result === 'the answer is 42', wj && wj.job);
  t('wait exits 0 when the job is done', waited.code === 0, waited.code);

  // Terminal state is immutable — a later report cannot overwrite done/result.
  await winmux(['agent', 'failed', '--job', jobId, '--result', 'nope']);
  const st2 = parse((await winmux(['agent', 'status', '--job', jobId, '--json'])).out);
  t('the first terminal report wins (immutable)', st2 && st2.job.state === 'done' && st2.job.result === 'the answer is 42', st2 && st2.job);

  const unk = await winmux(['agent', 'status', '--job', 'job_does_not_exist', '--json']);
  t('an unknown jobId is rejected, not invented', unk.code !== 0, unk.out || unk.err);

  // A wait that times out returns the still-working job with a resumable exit code (3),
  // never hanging past the caller's tool ceiling.
  const reg2 = parse((await winmux(['agent', 'register', '--json'])).out);
  const w2 = await winmux(['agent', 'wait', '--job', reg2.job.jobId, '--timeout', '1', '--json']);
  const w2j = parse(w2.out);
  t('a timed-out wait is resumable (still working, exit 3)', w2j && w2j.job.state === 'working' && w2.code === 3, { code: w2.code, job: w2j && w2j.job });

  // jobId isolation — the second job's state is independent of the first.
  const iso = parse((await winmux(['agent', 'status', '--job', reg2.job.jobId, '--json'])).out);
  t('jobs are isolated by id (no cross-talk)', iso && iso.job.state === 'working' && iso.job.jobId !== jobId, iso && iso.job);
});

// --- agentspawn: one session spawns another and gets its result (Stage 3) -
// The full orchestration loop through a REAL terminal: `winmux agent spawn`
// opens a tab, runs a command in it, the launcher self-reports done + the
// command's output to the job store, and `winmux agent wait` receives that
// output as data. Swap the --cmd for a prompt and it's a real Claude driving
// another; this proves the plumbing without needing Claude auth in CI.
check('agentspawn', PORT_AGENTSPAWN, async ({ browser, base, t }) => {
  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_AGENTSPAWN), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = '';
    proc.stdout.on('data', (d) => o += d);
    proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });
  const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await appReady(page);        // the app connects to /control (spawn needs new-tab + send)

  const marker = 'HELLO_FROM_B_' + PORT_AGENTSPAWN;
  const sp = parse((await winmux(['agent', 'spawn', '--cmd', "Write-Output '" + marker + "'", '--name', 'btask', '--json'])).out);
  t('spawn opens a session and returns a job to wait on', sp && /^job_/.test(sp.jobId) && sp.sid != null, sp);

  const w = await winmux(['agent', 'wait', '--job', sp && sp.jobId, '--timeout', '25', '--json']);
  const wj = parse(w.out);
  t('the spawned task ran and its output came back through the wait as data',
    wj && wj.job && wj.job.state === 'done' && (wj.job.result || '').indexOf(marker) >= 0, { code: w.code, job: wj && wj.job });
  t('wait exits 0 once the spawned job is done', w.code === 0, w.code);
});

// --- cli: the `winmux` command-line drives the live app -------------------
// The CLI POSTs /rpc, which forwards over /control to a connected app. So this
// check IS the app: a real headless page connected to /control, then the CLI is
// run as a child process and must make that page do things. The instance file
// is pointed at THIS check's server so the CLI targets it, not @edward's live one.
check('cli', PORT_CLI, async ({ browser, base, t, shot }) => {
  // Target THIS check's server directly via WINMUX_PORT — never the shared
  // instance file, which the harness's many servers would race over (and which
  // is @edward's real running app's file).
  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_CLI), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = '';
    proc.stdout.on('data', (d) => o += d);
    proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });
  const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await appReady(page);          // the app connects to /control

  const list1 = await winmux(['list', '--json']);
  const p1 = parse(list1.out);
  t('list reaches the live app', list1.code === 0 && p1 && Array.isArray(p1.sessions), { code: list1.code, err: list1.err });
  t('the app reports its starting terminal', p1 && p1.sessions.length >= 1, p1 && p1.sessions.length);

  const marker = 'CLI_OK_' + PORT_CLI;
  const sent = await winmux(['send', '"' + marker + '"', '--enter']);
  t('send exits clean', sent.code === 0, sent.err);
  await page.waitForTimeout(3000);
  const rd = await winmux(['read-screen', '--lines', '60']);
  t('read-screen shows what send ran', rd.code === 0 && rd.out.indexOf(marker) >= 0, rd.out.slice(-160));

  const before = p1 ? p1.sessions.length : 0;
  await winmux(['new-tab']);
  await page.waitForTimeout(1500);
  const p2 = parse((await winmux(['list', '--json'])).out);
  t('new-tab adds a terminal the app can see', p2 && p2.sessions.length === before + 1, { before, after: p2 && p2.sessions.length });
  await shot(page, 'cli-drove-it');

  // With no app open the CLI must fail clearly, never hang. Closing the page drops the
  // /control socket, but the server takes a moment to notice — a fixed wait races that
  // on a fast machine (it still answers from the just-departed app, so err is empty and
  // the check flakes on both engines). Poll until it reports the app is gone; the
  // invariant is that it fails clearly, not that it does so within one arbitrary tick.
  await page.close();
  let orphan = { code: 0, err: '' };
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 400));
    orphan = await winmux(['list']);
    if (orphan.code !== 0 && /no app connected/i.test(orphan.err)) break;
  }
  t('with no app open the CLI fails clearly, fast', orphan.code !== 0 && /no app connected/i.test(orphan.err), orphan.err);
});

// Item 8 T1 — every shell exports its own WinMux identity (WINMUX_SID/WINMUX_PORT),
// the way tmux exports $TMUX_PANE, so an agent's hook inside a terminal can address
// exactly this session.
check('agent-env', PORT_AGENTENV, async ({ browser, base, t }) => {
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await appReady(page);
  const sid = await page.evaluate(() => {
    const at = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
    return at ? at.sid : null;
  });
  t('the active session has a server sid', !!sid, sid);
  // Ask the shell to print its injected identity, then read it back off the screen.
  await page.evaluate(() => {
    const at = window.__winmuxActiveTerm();
    // ${env:NAME} braces so the ':' delimiter isn't swallowed by PowerShell's $env: syntax.
    at.ws.send(JSON.stringify({ t: 'i', d: 'echo "WMX=${env:WINMUX_SID}=${env:WINMUX_PORT}"\r' }));
  });
  await page.waitForTimeout(2500);
  const screen = await page.evaluate(() => {
    const at = window.__winmuxActiveTerm(); const b = at.term.buffer.active; let out = '';
    for (let i = 0; i < b.length; i++) { const ln = b.getLine(i); if (ln) out += ln.translateToString(true) + '\n'; }
    return out;
  });
  t('the shell exports WINMUX_SID equal to the session sid, WINMUX_PORT equal to the port',
    new RegExp('WMX=' + sid + '=' + PORT_AGENTENV + '(?!\\d)').test(screen), { want: 'WMX=' + sid + '=' + PORT_AGENTENV, tail: screen.slice(-160) });
  await page.close();
});

// Item 8 T2 — `winmux agent <state>` drives the session's cockpit status by sid,
// the exact path a Claude Code hook fires. needs-you raises the alarm; done clears it.
check('agent-state', PORT_AGENTSTATE, async ({ browser, base, t, shot }) => {
  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_AGENTSTATE), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = '';
    proc.stdout.on('data', (d) => o += d);
    proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });
  const statusOf = () => page.evaluate(() => {
    const at = window.__winmuxActiveTerm(); return at ? at.status : null;
  });

  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await appReady(page);
  const sid = await page.evaluate(() => { const at = window.__winmuxActiveTerm(); return at ? at.sid : null; });
  t('a session sid is available to target', !!sid, sid);

  const nu = await winmux(['agent', 'needs-you', '--sid', sid, 'waiting on your approval']);
  t('winmux agent needs-you exits clean', nu.code === 0, nu.err);
  await page.waitForTimeout(800);
  const s1 = await statusOf();
  const approve = await page.evaluate(() => !!document.querySelector('.sapprove'));
  t('the session flipped to needs-you (status + Approve pill)', s1 === 'needsyou' && approve === true, { status: s1, approve });
  await shot(page, 'agent-needsyou');

  const dn = await winmux(['agent', 'done', '--sid', sid]);
  t('winmux agent done exits clean', dn.code === 0, dn.err);
  await page.waitForTimeout(800);
  const s2 = await statusOf();
  t('agent done clears it back to idle', s2 === 'idle', { status: s2 });

  const wk = await winmux(['agent', 'working', '--sid', sid, 'running the build']);
  await page.waitForTimeout(800);
  const s3 = await statusOf();
  t('agent working moves it to the working lane', wk.code === 0 && s3 === 'working', { code: wk.code, status: s3 });
  await page.close();
});

// Item 8 T3 — the shipped Claude Code hooks preset is valid and its command path is
// real: fire the exact command a hook runs, with $WINMUX_SID set like a real hook,
// and prove the cockpit follows. Also prove the outside-WinMux no-op guard.
check('agent-hooks', PORT_AGENTHOOKS, async ({ browser, base, t }) => {
  // The preset is valid JSON wiring the three lifecycle events to `winmux agent`.
  const preset = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent', 'claude-code-hooks.json'), 'utf8'));
  const cmdFor = (evt) => {
    try { return preset.hooks[evt][0].hooks[0].command; } catch (e) { return ''; }
  };
  t('preset wires UserPromptSubmit → agent working', /winmux agent working/.test(cmdFor('UserPromptSubmit')), cmdFor('UserPromptSubmit'));
  t('preset wires Notification → agent needs-you', /winmux agent needs-you/.test(cmdFor('Notification')), cmdFor('Notification'));
  t('preset wires Stop → agent done', /winmux agent done/.test(cmdFor('Stop')), cmdFor('Stop'));

  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await appReady(page);
  const sid = await page.evaluate(() => { const at = window.__winmuxActiveTerm(); return at ? at.sid : null; });

  // Fire the exact hook command with $WINMUX_SID set, the way a hook inherits it
  // from the shell — no --sid on the command line.
  const runHook = (args, extraEnv) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_AGENTHOOKS), WINMUX_HOST: '127.0.0.1' }, extraEnv || {}) });
    let o = '', e = ''; proc.stdout.on('data', (d) => o += d); proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });

  const fired = await runHook(['agent', 'needs-you', 'Claude needs your input'], { WINMUX_SID: sid });
  await page.waitForTimeout(800);
  const st = await page.evaluate(() => { const at = window.__winmuxActiveTerm(); return at ? at.status : null; });
  t('the Notification-hook command (with $WINMUX_SID) flips live state', fired.code === 0 && st === 'needsyou', { code: fired.code, status: st });

  // Outside a WinMux terminal ($WINMUX_SID unset, no --id): must no-op, not poke the app.
  const guarded = await runHook(['agent', 'done', '--json'], { WINMUX_SID: '' });
  const stAfter = await page.evaluate(() => { const at = window.__winmuxActiveTerm(); return at ? at.status : null; });
  t('a hook fired outside WinMux no-ops (state unchanged)',
    guarded.code === 0 && /skipped/.test(guarded.out) && stAfter === 'needsyou', { out: guarded.out, status: stAfter });
  await page.close();
});

// Item 9 (distribution, non-gated slice) — the winget manifest generator emits the three
// valid-shaped manifests from a release URL + SHA, ready to submit once a release exists.
check('winget', PORT_WINGET, async ({ t }) => {
  const outDir = path.join(OUT, 'winget-check-' + PORT_WINGET);
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) {}
  const url = 'https://github.com/Zbrooklyn/winmux/releases/download/v0.1.0/WinMux.Setup.0.1.0.exe';
  const sha = 'A'.repeat(64);
  const run = await new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'scripts', 'winget-manifest.mjs'), '--url', url, '--sha', sha, '--out', outDir],
      { cwd: ROOT });
    let e = ''; proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, err: e.trim() }));
  });
  t('the generator runs clean', run.code === 0, run.err);

  const rd = (n) => { try { return fs.readFileSync(path.join(outDir, n), 'utf8'); } catch (e) { return ''; } };
  const ver = rd('Zbrooklyn.WinMux.yaml');
  const inst = rd('Zbrooklyn.WinMux.installer.yaml');
  const loc = rd('Zbrooklyn.WinMux.locale.en-US.yaml');
  t('the version manifest identifies the package', /PackageIdentifier: Zbrooklyn\.WinMux/.test(ver) && /ManifestType: version/.test(ver), ver.slice(0, 120));
  t('the installer manifest carries the real url + sha + nullsoft type',
    inst.indexOf('InstallerUrl: ' + url) >= 0 && inst.indexOf('InstallerSha256: ' + sha) >= 0 && /InstallerType: nullsoft/.test(inst), inst.slice(0, 200));
  t('the locale manifest names publisher + license', /Publisher: Zbrooklyn/.test(loc) && /License: MIT/.test(loc) && /ManifestType: defaultLocale/.test(loc), loc.slice(0, 160));
  t('no placeholder markers survive when url+sha are given', !/PLACEHOLDER/.test(ver + inst + loc), 'clean');
});

// #246 — the authoritative WINMUX_TUNNELLED_PORTS override is honored WITHOUT a
// tailscale spawn, so booting many servers at once can't flake the safety check.
// Deterministic regardless of this machine's real tailscale state.
check('tunnel-override', PORT_TUNOVR, async ({ base, t }) => {
  // Positive: the framework already booted this check's server with the override
  // in its env (empty or the real set, neither of which includes this port), so it
  // came up and serves the desk door — the override didn't wrongly block a safe port.
  const up = await get(base + '/');
  t('a server starts on a port the override does not list', up.status === 200, up.status);

  // Refusal: force a port AND mark that same port tunnelled via the override. The
  // server must refuse (exit 2) purely from the override — no tailscale call needed.
  const forced = P(9951);
  const refused = await new Promise((resolve) => {
    const proc = spawn(process.execPath, ['server.cjs'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(forced), WINMUX_TUNNELLED_PORTS: String(forced),
        WINMUX_TRUST_FILE: trustFile('tunovr'), WINMUX_NO_INSTANCE: '1',
      }),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('exit', (code) => resolve({ code, err }));
    setTimeout(() => { try { proc.kill(); } catch (e) {} resolve({ code: null, err }); }, 15000);
  });
  t('refuses a port the override marks tunnelled, no tailscale needed', refused.code === 2, 'exit ' + refused.code);
  t('the refusal names the tunnelled cause', /tailscale serve/i.test(refused.err) && /without a key/.test(refused.err),
    refused.err.split('\n').find((l) => /without a key|tailscale serve/i.test(l)) || refused.err.slice(0, 120));
});

// --- approve (U4): clear a "needs you" session inline, without switching in ----
// A background terminal that rings its bell flips to "needs you". Its row grows an
// inline Approve pill; clicking it sends Enter to that terminal (accepting whatever
// it was waiting on) and clears the alarm — the "approve a blocked agent from the
// fleet view" move. Idle rows must NOT get the pill. We drive it through the same
// real CLI transport the `cli` check uses (send/read-screen/new-tab).
check('approve', PORT_APPROVE, async ({ browser, base, t, shot }) => {
  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_APPROVE), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = '';
    proc.stdout.on('data', (d) => o += d);
    proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });
  const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await appReady(page);          // the app connects to /control

  const l1 = parse((await winmux(['list', '--json'])).out);
  t('the app reports its starting terminal', l1 && l1.sessions.length >= 1, l1 && l1.sessions.length);
  const t1 = l1.sessions[0].id;

  // A second terminal takes focus, so t1 is now a background tab — the exact
  // condition under which a bell means "needs you", not "you already saw it".
  await winmux(['new-tab']);
  await page.waitForTimeout(1800);
  const l2 = parse((await winmux(['list', '--json'])).out);
  const active = l2 && l2.sessions.find((s) => s.active);
  t('a second terminal becomes the active one', active && String(active.id) !== String(t1), active && active.id);

  // Ring the background terminal: its shell writes one real BEL byte.
  const rung = await winmux(['send', '[Console]::Out.Write([char]7)', '--id', String(t1), '--enter']);
  t('the ring reaches the background terminal', rung.code === 0, rung.err);
  await page.waitForTimeout(2400);

  // Expand groups so the rows render, then read the sidebar.
  await page.evaluate(() => { document.querySelectorAll('[data-expand]').forEach((e) => { if (!e.hasAttribute('data-open2')) e.click(); }); });
  await page.waitForTimeout(500);
  const before = await page.evaluate((id) => {
    const need = document.getElementById('d-need');
    const row = document.querySelector('.srow[data-term="' + id + '"]');
    const others = [...document.querySelectorAll('.srow[data-term]')].filter((r) => r.getAttribute('data-term') !== String(id));
    return {
      dNeed: need && need.textContent,
      rowNeedsYou: !!(row && row.querySelector('.dot.needsyou')),
      rowHasApprove: !!(row && row.querySelector('.sapprove')),
      idleHasApprove: others.some((r) => r.querySelector('.sapprove')),
    };
  }, t1);
  t('a rung background session becomes "needs you"', before.rowNeedsYou && before.dNeed !== '0', before);
  t('a "needs you" row grows an inline Approve control', before.rowHasApprove, before);
  t('an idle row has no Approve control (it is only for waiting sessions)', !before.idleHasApprove, before);
  await shot(page, 'approve-pill');

  // Click Approve — it must send the keystroke and clear the alarm.
  await page.click('.srow[data-term="' + t1 + '"] .sapprove');
  await page.waitForTimeout(1200);
  const after = await page.evaluate((id) => {
    const row = document.querySelector('.srow[data-term="' + id + '"]');
    return { stillApprove: !!(row && row.querySelector('.sapprove')), stillNeedsYou: !!(row && row.querySelector('.dot.needsyou')) };
  }, t1);
  t('clicking Approve clears the waiting state', !after.stillApprove && !after.stillNeedsYou, after);

  // The action reports itself: an "Approved" line lands in the notification centre,
  // which only happens when the keystroke was actually sent to a live terminal.
  await page.evaluate(() => document.getElementById('open-notif').click());
  await page.waitForTimeout(400);
  const notif = await page.evaluate(() => (document.getElementById('npanel').textContent || ''));
  t('Approve reports it sent the keystroke (notification)', /Approved/.test(notif), notif.slice(0, 120));

  await page.close();
});

// --- sidebar-tabs: the left rail is a real sidebar (SB arc) --------------------
// Edward: "the whole point of the sidebar is that I can have multiple tabs within
// the sidebar, similar style to Obsidian." Three panels behind a slim icon strip:
// Sessions (deck+groups), Projects (saved layouts), Notifications (the bell IS the
// third tab, #npanel parked inside the rail). Mechanics are measured — computed
// display values, node parents, pixel widths — never eyeballed. Desktop only; the
// phone checks prove narrow stayed untouched.
check('sidebar-tabs', PORT_SIDEBAR, async ({ browser, base, t, shot }) => {
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const state = () => page.evaluate(() => {
    const cs = (el) => el ? getComputedStyle(el).display : 'MISSING';
    const aside = document.querySelector('.sessions');
    const np = document.getElementById('npanel');
    return {
      tab: aside.getAttribute('data-sxtab'),
      strip: cs(document.getElementById('sx-tabs')),
      head: cs(document.querySelector('.sx-head')),
      sess: cs(document.getElementById('sxp-sessions')),
      proj: cs(document.getElementById('sxp-projects')),
      notif: cs(document.getElementById('sxp-notif')),
      width: Math.round(aside.getBoundingClientRect().width),
      bellIn: (document.getElementById('open-notif').parentElement || {}).id,
      npOpen: np.hasAttribute('data-open'),
      npIn: (np.parentElement || {}).id,
      npPos: getComputedStyle(np).position,
    };
  });

  let s = await state();
  t('desktop shows the icon strip, not the old header', s.strip === 'flex' && s.head === 'none', s);
  t('the rail boots on the Sessions panel', s.tab === 'sessions' && s.sess === 'flex' && s.proj === 'none', s);
  t('the bell lives in the strip as the third tab', s.bellIn === 'sx-tabs', s.bellIn);
  t('#npanel is parked inside the rail slot', s.npIn === 'sxp-notif', s.npIn);

  // Projects tab: seed one project so the panel has a row, then switch.
  await page.evaluate(() => fetch('/api/project', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Sidebar Probe', path: null, layout: { cols: [] } }) }).then((r) => r.json()));
  const tSwitch = await page.evaluate(() => {
    const t0 = performance.now();
    document.getElementById('sxtab-projects').click();
    return performance.now() - t0;
  });
  await page.waitForTimeout(600);
  s = await state();
  t('clicking the folder icon swaps to the Projects panel', s.tab === 'projects' && s.proj === 'flex' && s.sess === 'none', s);
  t('the panel swap is instant (≤ a frame\'s worth of work)', tSwitch <= 40, Math.round(tSwitch) + 'ms');
  const rows = await page.evaluate(() => document.querySelectorAll('#sx-plist .pjrow').length);
  t('the Projects panel lists the saved project', rows >= 1, String(rows));
  // FB arc: the project rows speak the SAME row language as the sessions list —
  // 34px folder tile, 15px/600 name, 12px sub line — with the overlay-only
  // badge/dot suppressed. Measured, not eyeballed.
  const lang = await page.evaluate(() => {
    const cs = (sel, prop) => { const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : 'MISSING'; };
    return {
      tile: cs('#sx-plist .pjrow-folder', 'width'),
      name: cs('#sx-plist .pjrow-name', 'fontSize'),
      weight: cs('#sx-plist .pjrow-name', 'fontWeight'),
      sub: cs('#sx-plist .pjrow-sub', 'display'),
      badge: cs('#sx-plist .pjrow-badge', 'display'),
      dot: cs('#sx-plist .pjrow-dot', 'display'),
      count: (document.getElementById('sx-pcount') || {}).textContent,
    };
  });
  t('the project rows adopt the sessions-row language (34px tile, 15px/600 name, sub line)',
    lang.tile === '34px' && lang.name === '15px' && lang.weight === '600' && lang.sub === 'block', lang);
  t('the overlay-style badge and dot are suppressed in the rail', lang.badge === 'none' && lang.dot === 'none', lang);
  t('the Projects header carries a live count like Groups does', lang.count === String(rows), lang.count + ' vs ' + rows);
  await shot(page, 'sidebar-tabs-projects');

  // Notifications: the bell toggles the third panel in-rail, then returns.
  await page.evaluate(() => document.getElementById('open-notif').click());
  await page.waitForTimeout(300);
  s = await state();
  t('the bell opens Notifications inside the rail (no floating popover)', s.tab === 'notif' && s.npOpen && s.npPos === 'static', s);
  await page.evaluate(() => document.getElementById('open-notif').click());
  await page.waitForTimeout(300);
  s = await state();
  t('the bell toggles closed and lands back on the resting tab', s.tab === 'projects' && !s.npOpen, s);

  // Drag-resize: real mouse on the grab strip, measured width, clamped, painted.
  const hb = await page.evaluate(() => {
    const b = document.getElementById('sx-resize').getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + 300 };
  });
  await page.mouse.move(hb.x, hb.y);
  await page.mouse.down();
  await page.mouse.move(340, hb.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  s = await state();
  t('dragging the right edge resizes the rail (340px target)', Math.abs(s.width - 340) <= 2, String(s.width));
  const clamps = await page.evaluate(() => [window.__winmuxSidebarWidth(999), window.__winmuxSidebarWidth(50)]);
  t('the width clamps to 200–420', clamps[0] === 420 && clamps[1] === 200, clamps.join('/'));
  await page.evaluate(() => window.__winmuxSidebarWidth(340));
  // The width save rides the settings POST to the engine. Wait for the ENGINE to
  // report 340, not for a stopwatch: a fixed sleep was here before and it lost
  // under parallel load, letting the reload race the clamp-test's 200 and then
  // fail an assertion about persistence that was never really about persistence.
  await page.waitForFunction(async () => {
    const r = await fetch('/api/config').then((x) => x.json()).catch(() => null);
    return !!(r && r.settings && r.settings.sidebarWidth === 340);
  }, null, { timeout: 20000 });

  // Persistence: the resting tab and the width both survive a reload.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  s = await state();
  t('the active tab survives a reload', s.tab === 'projects', s.tab);
  t('the rail width survives a reload', Math.abs(s.width - 340) <= 2, String(s.width));

  // Narrow: the whole system goes dormant — strip gone, bell home in .sx-head,
  // #npanel back on <body> for the settled bottom-sheet flow.
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(800);
  const nr = await page.evaluate(() => ({
    mode: document.querySelector('.cockpit').getAttribute('data-mode'),
    strip: getComputedStyle(document.getElementById('sx-tabs')).display,
    bellIn: document.getElementById('open-notif').parentElement.className,
    npIn: document.getElementById('npanel').parentElement.tagName,
    handle: getComputedStyle(document.getElementById('sx-resize')).display,
    sess: getComputedStyle(document.getElementById('sxp-sessions')).display,
  }));
  t('narrow hides the strip and the resize handle', nr.mode === 'narrow' && nr.strip === 'none' && nr.handle === 'none', nr);
  t('narrow sends the bell home to .sx-head and #npanel to <body>', /sx-head/.test(nr.bellIn) && nr.npIn === 'BODY', nr);
  t('narrow always shows the Sessions panel', nr.sess === 'flex', nr.sess);

  // And back: growing to desktop restores the strip arrangement.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(800);
  s = await state();
  t('returning to desktop restores the strip arrangement', s.bellIn === 'sx-tabs' && s.npIn === 'sxp-notif' && s.tab === 'projects', s);
  await shot(page, 'sidebar-tabs-restored');

  await page.close();
});

// --- winctl: the window's close button is unlosable ---------------------------
// Edward, twice: "when I minimized it to a certain size, the x and the minimize
// and maximize button started to disappear." The window is FRAMELESS — .wc is
// the only close button that exists — and it used to be appended into the
// rightmost pane's tab row, a non-wrapping flex line inside a .pane that clips.
// One split at a small window pushed all three off the right edge (measured:
// close at 841px inside a 720px window). Nothing in 471 checks looked, because
// no check ever combined "small window" with "split". This one does: it walks
// the sizes a user can actually drag to, splits repeatedly at each, and asserts
// the three buttons stay inside the viewport AND hit-testable at every step.
check('winctl', PORT_WINCTL, async ({ browser, base, t, shot }) => {
  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_WINCTL), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = '';
    proc.stdout.on('data', (d) => o += d);
    proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });

  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await appReady(page);

  // Each button must be inside the viewport and be the element you actually hit
  // at its own centre — "rendered" is not "clickable".
  const controls = () => page.evaluate(() => ['wc-min', 'wc-max', 'wc-close'].map((id) => {
    const el = document.getElementById(id);
    if (!el) return { id, ok: false, why: 'MISSING' };
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return { id, ok: false, why: 'zero-size' };
    if (r.right > innerWidth + 0.5 || r.left < -0.5) {
      return { id, ok: false, why: 'clipped: right=' + Math.round(r.right) + ' vs window ' + innerWidth };
    }
    const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    if (!(top && (top === el || el.contains(top) || top.contains(el)))) return { id, ok: false, why: 'covered' };
    return { id, ok: true, why: 'usable' };
  }));
  const allUsable = async (label) => {
    const c = await controls();
    const bad = c.filter((x) => !x.ok);
    t('window controls stay usable ' + label, bad.length === 0, bad.length ? bad : 'min/max/close all usable');
    return bad.length === 0;
  };

  // 720x480 is the enforced floor (electron/main.ts minWidth/minHeight), i.e. the
  // smallest window a user can drag to — the worst case, tested first.
  for (const [w, h] of [[720, 480], [900, 620], [1440, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(700);
    await allUsable('at ' + w + 'x' + h + ' with one pane');
  }

  // This check is about the window controls surviving a LAYOUT, not about how
  // many panes fit. It used to split three times at 720x480 and assert three,
  // then four panes — which stopped being true the moment splitting got a floor:
  // at that size two panes is the honest maximum and the third split is refused
  // on purpose. Asserting it anyway was asserting the absence of the fix.
  //
  // So reach each layout at a size where it is legal, then drag down to the
  // floor and look. Same coverage, no longer coupled to the split rule.
  for (let i = 1; i <= 3; i++) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(600);
    await winmux(['split', 'right']);
    await page.waitForTimeout(2200);
    const panes = await page.evaluate(() => document.querySelectorAll('.workspace .pane').length);
    t('split ' + i + ' produced ' + (i + 1) + ' panes at a size that allows it', panes === i + 1, String(panes));
    await page.setViewportSize({ width: 720, height: 480 });
    await page.waitForTimeout(900);
    await allUsable('with ' + (i + 1) + ' panes dragged down to 720x480');
  }
  await shot(page, 'winctl-splits-720');

  // The reserved corner must be real: the rightmost pane's tab row has to stop
  // before the controls, or its own buttons sit underneath them.
  const reserved = await page.evaluate(() => {
    const host = document.querySelector('.pane.wc-host .ptabs');
    const wc = document.getElementById('winctl');
    if (!host || !wc) return { ok: false, why: 'no wc-host pane' };
    const pad = parseInt(getComputedStyle(host).paddingRight, 10) || 0;
    return { ok: pad >= Math.round(wc.getBoundingClientRect().width), pad, wcw: Math.round(wc.getBoundingClientRect().width) };
  });
  t('the rightmost pane reserves the window-control corner', reserved.ok, reserved);

  // And the controls belong to the window, not to a pane that can be closed.
  const parent = await page.evaluate(() => (document.getElementById('winctl').parentElement || {}).className || '');
  t('the controls live on the shell, not inside a pane', /cockpit/.test(parent) && !/pane/.test(parent), parent);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(600);
  await allUsable('back at 1440x900 with 4 panes');

  await page.close();
});

// --- split-collapse: closing the last visible tab collapses the split ----------
// Edward: "when im in split screen when i close the left tab it just opens a new
// one." Root cause: a pane still homing another group's HIDDEN terminals counted
// as non-empty, so closeTerm respawned a shell instead of collapsing the split.
// collapsePane now re-homes those hidden terms to a surviving pane (shells keep
// running) and closes the pane. Proven on the real user path: the tab's × button
// plus the confirm dialog, panes counted from the DOM.
check('split-collapse', PORT_SPLITCLOSE, async ({ browser, base, t }) => {
  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_SPLITCLOSE), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = '';
    proc.stdout.on('data', (d) => o += d);
    proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });

  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await appReady(page);          // the app connects to /control

  const state = () => page.evaluate(() => {
    const ps = [...document.querySelectorAll('.workspace .pane')];
    return { panes: ps.length, tabs: ps.map((p) => p.querySelectorAll('.ptab').length) };
  });
  // The real path: click the left pane's tab ×, then answer the confirm dialog.
  const closeLeftTab = async () => {
    await page.evaluate(() => {
      const pane = document.querySelectorAll('.workspace .pane')[0];
      const x = pane && pane.querySelector('.ptab .x');
      if (x) x.click();
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const open = document.querySelector('.ovl[data-open]');
      const ok = open && open.querySelector('[data-ok]');
      if (ok) ok.click();
    });
    await page.waitForTimeout(1500);
  };

  // Plain split: close the left tab, the split collapses.
  await winmux(['split', 'right']);
  await page.waitForTimeout(2000);
  let s = await state();
  t('a split gives two panes', s.panes === 2, s);
  await closeLeftTab();
  s = await state();
  t('closing the left tab collapses a plain split (no respawned shell)', s.panes === 1, s);

  // Edward's case: another group's hidden terminal lives in the left pane.
  await page.evaluate(() => { document.getElementById('open-newgroup').click(); });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const body = document.getElementById('dlg-body');
    const input = body.querySelector('.dlg-in');
    if (input) input.value = 'Split Probe B';
    body.querySelector('[data-ok]').click();
  });
  await page.waitForTimeout(2000);
  const groupCount = await page.evaluate(() => document.querySelectorAll('.prow').length);
  t('a second group exists for the cross-group case', groupCount === 2, String(groupCount));
  await page.evaluate(() => { document.querySelector('.prow[data-switch] .pinfo').click(); });   // back to group A
  await page.waitForTimeout(1000);
  await winmux(['split', 'right']);
  await page.waitForTimeout(2000);
  s = await state();
  t('group A splits into two panes again', s.panes === 2, s);
  await closeLeftTab();
  s = await state();
  t('the split still collapses when the pane homes another group\'s hidden terminal', s.panes === 1, s);
  t('that hidden terminal rides along instead of dying (2 tabs homed in the survivor)', s.tabs[0] === 2, s);
  const bTerm = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.prow')];
    const b = rows.find((r) => /Split Probe B/.test(r.textContent));
    return b ? b.querySelector('.psub').textContent : 'GROUP GONE';
  });
  t('group B still reports its session alive after the collapse', /1 session/.test(bTerm), bTerm);

  await page.close();
});

// --- pwsh: PowerShell 7 is found even from a Microsoft Store install -----------
// The bug: detectShells used fs.existsSync, which returns FALSE on the Store App
// Execution Alias for pwsh.exe — so Store-installed PowerShell 7 silently never
// appeared, though node-pty spawns it fine. Detection now lstat-checks the alias.
// Prove PS7 is offered, labelled right, and actually runs 7.x. Skips where pwsh
// isn't installed (a clean machine without it should not fail this).
check('pwsh', PORT_PWSH, async ({ browser, base, t, shot, skip }) => {
  const shells = await new Promise((res) => {
    http.get(base + '/shells', (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(null); } }); }).on('error', () => res(null));
  });
  const p7 = shells && shells.find((s) => s.key === 'pwsh');
  if (!p7) return skip('PowerShell 7 (pwsh) is not installed on this machine');
  t('PowerShell 7 is offered in the shell list', !!p7, shells);
  t('and it is labelled "PowerShell 7" (not the retired "Core")', p7.label === 'PowerShell 7', p7.label);

  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_PWSH), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = '';
    proc.stdout.on('data', (d) => o += d);
    proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });

  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await appReady(page);          // the app connects to /control

  const opened = await winmux(['new-tab', 'pwsh']);
  t('winmux opens a PowerShell 7 tab', opened.code === 0, opened.err);
  await page.waitForTimeout(3500);          // pwsh is slower to boot than 5.1

  // Ask the new (now active) pwsh tab its own major version — a marker only a real
  // running PowerShell 7 can produce, so this can't pass on a dead/listed-only shell.
  await winmux(['send', '"PSMAJOR=" + $PSVersionTable.PSVersion.Major', '--enter']);
  await page.waitForTimeout(2500);
  const rd = await winmux(['read-screen', '--lines', '40']);
  t('the pwsh tab is really running PowerShell 7.x', rd.code === 0 && /PSMAJOR=7/.test(rd.out), rd.out.slice(-160));
  await shot(page, 'pwsh-running');

  await page.close();
});

// --- footer: every sidebar-footer button actually does its thing --------------
// Seven buttons at the bottom of the sidebar. "Wired to a handler" is not "works":
// New group / Rename group used window.prompt, which THROWS in Electron, so those
// were dead in the desktop app. This clicks each and asserts the real outcome, and
// specifically proves New group now opens an in-app dialog and creates the group.
check('footer', PORT_FOOTER, async ({ browser, base, t, shot }) => {
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  await page.evaluate(() => { try { document.querySelectorAll('.ovl[data-open]').forEach((o) => o.removeAttribute('data-open')); } catch (e) {} });

  const n = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
  const openId = (id) => page.evaluate((i) => { const e = document.getElementById(i); return !!(e && e.hasAttribute('data-open')); }, id);
  const openSel = (sel) => page.evaluate((s) => !!document.querySelector(s), sel);

  // New terminal → a tab is added.
  const tabs0 = await n('.ptab');
  await page.click('#open-new');
  await page.waitForTimeout(1200);
  t('New terminal adds a tab', (await n('.ptab')) === tabs0 + 1, { before: tabs0, after: await n('.ptab') });

  // New group → in-app dialog (the window.prompt bug) → creates the group.
  const groups0 = await n('.prow');
  await page.click('#open-newgroup');
  await page.waitForTimeout(400);
  t('New group opens an in-app name dialog (window.prompt is dead in Electron)', await openId('dlg-ovl'), 'dlg-ovl');
  await page.fill('#dlg-body .dlg-in', 'QA Group');
  await page.click('#dlg-body [data-ok]');
  await page.waitForTimeout(700);
  t('New group actually creates the group', (await n('.prow')) === groups0 + 1, { before: groups0, after: await n('.prow') });
  await shot(page, 'footer-newgroup');

  // Save project → the Projects overlay opens.
  await page.click('#open-save');
  await page.waitForTimeout(300);
  t('Save project opens the Projects overlay', await openSel('#projects-ovl[data-open]'), 'projects-ovl');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Open project → same overlay opens.
  await page.click('#open-load');
  await page.waitForTimeout(300);
  t('Open project opens the Projects overlay', await openSel('#projects-ovl[data-open]'), 'projects-ovl');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Diagnostics → its overlay opens.
  await page.click('#open-diag');
  await page.waitForTimeout(300);
  t('Diagnostics opens the diagnostics panel', await openId('diag-ovl'), 'diag-ovl');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Keyboard shortcuts → the cheat sheet opens.
  await page.click('#open-help');
  await page.waitForTimeout(300);
  t('Keyboard shortcuts opens the cheat sheet', await openId('cheat-ovl'), 'cheat-ovl');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Settings → the settings overlay opens.
  await page.click('#open-settings');
  await page.waitForTimeout(300);
  t('Settings opens the settings panel', await openId('settings-ovl'), 'settings-ovl');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Save-on-close: saving binds this window to a project file; a later change makes it
  // dirty; closing then asks before dropping the change instead of exiting silently.
  await page.click('#open-save');
  await page.waitForTimeout(250);
  await page.fill('#sm-name', 'Verify Project');
  await page.click('#sm-save');
  await page.waitForTimeout(800);
  const bound = await page.evaluate(() => { try { return !!JSON.parse(localStorage.getItem('ct-current') || 'null'); } catch (e) { return false; } });
  t('Saving binds this window to the project file', bound, { bound });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  // Stub the real teardown so the harness window survives a close click; record whether
  // close was actually reached — a dirty project must block it.
  await page.evaluate(() => {
    window.__closed = false;
    if (window.winmux) window.winmux.close = () => { window.__closed = true; };
    try { window.close = () => { window.__closed = true; }; } catch (e) {}
  });
  // A clean (just-saved) project closes straight through — no prompt.
  await page.click('#wc-close');
  await page.waitForTimeout(250);
  t('A saved (clean) project closes without a prompt',
    !(await openId('dlg-ovl')) && (await page.evaluate(() => window.__closed === true)), 'clean-close');
  await page.evaluate(() => { window.__closed = false; });
  // Dirty it (add a tab) → closing asks first and does NOT close yet.
  await page.click('#open-new');
  await page.waitForTimeout(1000);
  await page.click('#wc-close');
  await page.waitForTimeout(300);
  const promptUp = await openId('dlg-ovl');
  const heldOpen = await page.evaluate(() => window.__closed === false);
  const askTitle = await page.evaluate(() => { const h = document.querySelector('#dlg-body h3'); return h ? h.textContent : ''; });
  t('A dirty project prompts before closing (and does not close yet)', promptUp && heldOpen, { promptUp, heldOpen });
  t('The close prompt names the project and offers Don’t save',
    /Verify Project/.test(askTitle) && (await openSel('#dlg-body [data-discard]')), askTitle);
  // "Don’t save" lets the close proceed.
  await page.click('#dlg-body [data-discard]');
  await page.waitForTimeout(250);
  t('“Don’t save” proceeds with the close', await page.evaluate(() => window.__closed === true), 'discard-closes');

  await page.close();
}, { WINMUX_PROJECTS_DIR: PROJECTS_TMP });

// --- update notice: a newer release lights the .upbadge pill (never installs) ---
// The server is booted with WINMUX_FAKE_LATEST=9.9.9 (via the check's env override),
// so /api/update reports an update without needing a real published release. We
// assert the pill turns on, names the version, and carries a real download link.
check('update', PORT_UPDATE, async ({ browser, base, t }) => {
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // The server-side check reports it.
  const api = await page.evaluate((b) => fetch(b + '/api/update').then((r) => r.json()), base);
  t('server reports a newer version is available', api && api.updateAvailable === true && api.latest === '9.9.9', api);

  // The badge lights up, names the version, and links to the release page.
  await page.waitForFunction(() => {
    const b = document.getElementById('upbadge');
    return b && b.classList.contains('on') && /9\.9\.9/.test(b.textContent);
  }, { timeout: 6000 }).catch(() => {});
  const badge = await page.evaluate(() => {
    const b = document.getElementById('upbadge');
    if (!b) return null;
    return { on: b.classList.contains('on'), text: b.textContent, shown: b.offsetParent !== null };
  });
  t('the update badge is visible', badge && badge.on && badge.shown, badge);
  t('the update badge names the new version', badge && /Update v9\.9\.9/.test(badge.text), badge && badge.text);
  t('the download link points at the WinMux releases page',
    /github\.com\/Zbrooklyn\/winmux\/releases/.test(api.url), api && api.url);

  await page.close();
}, { WINMUX_FAKE_LATEST: '9.9.9' });

// --- gpu: the WebGL renderer is live by default, and the DOM fallback still paints ---
// The GPU renderer drops the measured 10-stream event-loop tick ~12x (perf.cjs:
// 199ms -> 16ms), so it ships ON by default. This proves (1) it actually engages,
// and (2) if WebGL is unavailable the terminal cleanly falls back to the DOM
// renderer and still shows text — never a blank/broken terminal to "look fast".
check('gpu', PORT_GPU, async ({ browser, base, t }) => {
  // Default path: the app default is GPU on, so DON'T use desktop() (which pins
  // it off) — a raw page that only dismisses onboarding runs the real shipping
  // default. WebGL available -> the active terminal paints to a <canvas>.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await page.addInitScript(() => { try { localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {} });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const renderer = await page.evaluate(() => {
    const canvas = document.querySelector('.xterm-screen canvas, .xterm canvas');
    return { flagCanvas: !!canvas };
  });
  t('WebGL renderer is engaged by default (canvas present)', renderer.flagCanvas, renderer);
  await page.close();

  // Fallback path: force WebglAddon absent before load -> DOM renderer, still paints.
  const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await page2.addInitScript(() => {
    try { localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {}
    // Make the WebGL addon look unavailable so the try/catch falls back to DOM.
    Object.defineProperty(window, 'WebglAddon', { value: undefined, configurable: true });
  });
  await page2.goto(base, { waitUntil: 'domcontentloaded' });
  await page2.waitForTimeout(4000);
  const fb = await page2.evaluate(() => {
    const rows = document.querySelectorAll('.xterm-rows > div').length;
    const canvas = document.querySelector('.xterm-screen canvas, .xterm canvas');
    return { rows, hasCanvas: !!canvas };
  });
  t('DOM fallback paints text when WebGL is unavailable (rows, no canvas)', fb.rows > 0 && !fb.hasCanvas, fb);
  await page2.close();
});

// --- dprfix (MR-1): a devicePixelRatio-stuck WebGL canvas gets resynced ---
// xterm's WebGL renderer resizes its canvas backing store only on a column/row
// change — a pure devicePixelRatio change (Electron's startup dpr settle on a scaled
// Windows display, or a monitor-to-monitor move) leaves the canvas stuck at the old
// scale, so the whole grid renders wrong-sized and the first prompt strands mid-pane.
// The buffer is correct the whole time; it's purely canvas geometry. The app now
// detects canvas-backing != render-service device dims and forces a resync
// (resyncRenderer, wired into open/show/fit and a dpr-change watcher). This guard
// simulates the stuck state by doubling the canvas backing, then drives the resize
// path and proves the canvas heals. Needs the shipping WebGL default (see the
// WINMUX_FORCE_DOM exemption), so it gets its own raw page like gpu/ligature.
check('dprfix', PORT_DPRFIX, async ({ browser, base, t }) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await page.addInitScript(() => { try { localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {} });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const read = () => {
    const at = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
    if (!at || !at.term) return { err: 'no term' };
    const term = at.term, rs = term._core && term._core._renderService;
    let r = rs && rs._renderer; r = r && (r.value || r);
    const canvas = r && r._canvas;
    const dims = rs && rs.dimensions && rs.dimensions.device && rs.dimensions.device.canvas;
    if (!canvas || !dims) return { err: 'no canvas/dims', renderer: term.__winmuxRenderer };
    return {
      renderer: term.__winmuxRenderer,
      cw: canvas.width, ch: canvas.height, dw: Math.round(dims.width), dh: Math.round(dims.height),
      matched: canvas.width === Math.round(dims.width) && canvas.height === Math.round(dims.height),
    };
  };

  const before = await page.evaluate(read);
  t('WebGL canvas backing matches render dims on open (healthy baseline)', before.renderer === 'webgl' && before.matched === true, before);

  // Force the dpr-stuck state: double the canvas backing store out from under xterm.
  const stuck = await page.evaluate(() => {
    const at = window.__winmuxActiveTerm(); const term = at.term;
    const rs = term._core._renderService; let r = rs._renderer; r = r && (r.value || r);
    const c = r._canvas; c.width *= 2; c.height *= 2;
    const dims = rs.dimensions.device.canvas;
    return { matched: c.width === Math.round(dims.width) && c.height === Math.round(dims.height) };
  });
  t('Simulated dpr-stuck state creates a real canvas/dims mismatch', stuck.matched === false, stuck);

  // Drive the app's resync path (window resize -> fitActive -> resyncRenderer).
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.waitForTimeout(400);

  const after = await page.evaluate(read);
  t('resyncRenderer heals the canvas backing back to the render dims', after.matched === true, after);
  await page.close();
});

// --- ligature: the switch really shapes operators, and pays the renderer price ---
// Shaping "=>" into one arrow needs a text run the browser can shape, and only the
// DOM renderer emits one — WebGL draws cell by cell out of a glyph atlas, so under
// it there is no DOM text to shape at all (measured: zero spans). That makes the
// ligature switch a real fork, not a coat of CSS: turning it on has to drop that
// terminal off WebGL. This check proves all three halves — the default is GPU with
// no shaping, the switch flips both the renderer and the measured font feature, and
// the live swap doesn't cost the user their scrollback. It needs the shipping
// renderer default, so it gets its own port exempt from WINMUX_FORCE_DOM and a raw
// page rather than desktop() (which pins gpuRenderer off).
check('ligature', PORT_LIG, async ({ browser, base, t }) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await page.addInitScript(() => { try { localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {} });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  // Default: ligatures off -> WebGL, no body flag.
  const before = await page.evaluate(() => ({
    hasCanvas: !!document.querySelector('.xterm-screen canvas, .xterm canvas'),
    flagged: document.body.hasAttribute('data-ligatures'),
  }));
  t('ligatures are off by default (GPU renderer, no ligature flag)',
    before.hasCanvas && !before.flagged, before);

  // Put a marker on screen BEFORE the flip so we can prove the renderer swap keeps
  // the scrollback. It goes through the SHELL, not term.write(): flipping the switch
  // refits the pane, and a resize makes PSReadLine repaint its prompt line over
  // anything written behind the shell's back. Real command output sits above that
  // line and survives, which is the thing a user would actually lose.
  const MARK = 'WINMUX-LIG-MARK-7714';
  await page.locator('.xterm-screen').first().click();
  await page.keyboard.type("echo '" + MARK + " => != -> >= <='");
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);

  // Flip the real switch the way a human does: Settings -> Terminal -> the toggle.
  await settings(page, 'Terminal');
  await page.locator('[data-sw="ligatures"]').click();
  await page.waitForTimeout(1200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);

  const on = await page.evaluate(() => {
    const rows = document.querySelector('.xterm-rows');
    // The run the browser actually shapes is the text node inside the row holding "=>",
    // not the container — so read the style off that element, or the rule could compute
    // on a wrapper the glyphs never inherit from.
    const row = rows && [].slice.call(rows.children).find((r) => (r.textContent || '').indexOf('=>') >= 0);
    const span = row && ([].slice.call(row.querySelectorAll('span')).find((s) => (s.textContent || '').indexOf('=>') >= 0) || row);
    return {
      hasCanvas: !!document.querySelector('.xterm-screen canvas, .xterm canvas'),
      flagged: document.body.hasAttribute('data-ligatures'),
      renderer: (window.__winmuxActiveTerm && window.__winmuxActiveTerm().term.__winmuxRenderer) || null,
      lig: rows ? getComputedStyle(rows).fontVariantLigatures : null,
      spanLig: span ? getComputedStyle(span).fontVariantLigatures : null,
      spanText: span ? (span.textContent || '').slice(0, 80) : null,
      screen: rows ? rows.textContent : '',
    };
  });
  t('turning ligatures on drops that terminal off WebGL (DOM renderer, no canvas)',
    !on.hasCanvas && on.renderer === 'dom', { hasCanvas: on.hasCanvas, renderer: on.renderer });
  t('the ligature flag reaches the page', on.flagged, on.flagged);
  // Cascadia carries its arrows as contextual alternates, so plain "normal" leaves
  // => unshaped — the computed value has to actually say contextual.
  t('the rendered rows compute font-variant-ligatures: contextual',
    on.lig === 'contextual', on.lig);
  t('the arrow run itself inherits contextual (the glyphs, not just the container)',
    on.spanLig === 'contextual' && !!on.spanText, { lig: on.spanLig, text: on.spanText });
  t('the renderer swap keeps the scrollback (pre-flip marker still on screen)',
    on.screen.indexOf(MARK) >= 0, on.screen.slice(-160));

  // And back: the swap is live in both directions, so nobody is stuck on the slow path.
  await settings(page, 'Terminal');
  await page.locator('[data-sw="ligatures"]').click();
  await page.waitForTimeout(1200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  const off = await page.evaluate(() => ({
    hasCanvas: !!document.querySelector('.xterm-screen canvas, .xterm canvas'),
    flagged: document.body.hasAttribute('data-ligatures'),
    renderer: (window.__winmuxActiveTerm && window.__winmuxActiveTerm().term.__winmuxRenderer) || null,
  }));
  t('turning it back off restores the GPU renderer', off.hasCanvas && off.renderer === 'webgl' && !off.flagged, off);
  await page.close();
});

// --- font: the terminal font is BUNDLED, served, loaded, and actually applied ---
// cockpit.css/app.js ask for 'Cascadia Code'; a clean machine with no Cascadia
// installed fell back to Consolas and rendered prompt/powerline glyphs as tofu.
// We ship CaskaydiaCove Nerd Font Mono and bind it to that family name. This proves
// the whole chain — the .ttf is served with a font MIME, a FontFace for the family
// actually loads, and the live terminal's computed font-family resolves to it — so
// the fix holds on a machine that has never seen Cascadia, not just this dev box.
check('font', PORT_FONT, async ({ browser, base, t }) => {
  // 1) The bundled file is served with a real font content-type (not 404 / html).
  const res = await get(base + '/fonts/CaskaydiaCoveNerdFontMono-Regular.ttf');
  const ct = String(res.headers['content-type'] || '');
  t('the bundled Nerd Font .ttf is served', res.status === 200 && /font\/(ttf|otf|sfnt)/.test(ct), { status: res.status, ct: ct });

  // Read the DOM renderer's text layer: xterm sets the font on .xterm-rows, which
  // only exists under the DOM renderer. The shipping default is the WebGL renderer,
  // which paints rows to a <canvas> (no .xterm-rows, and .xterm/.xterm-screen keep
  // the page's Inter) — so this check pins the DOM renderer (gpuRenderer:false, via
  // desktop()) to read a meaningful computed font-family. WebGL font correctness is
  // covered by the loaded @font-face (usable) + the gpu check.
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const info = await page.evaluate(async () => {
    // Force the family to load, then report what the document actually holds.
    try { await document.fonts.load('12px "Cascadia Code"'); await document.fonts.load('bold 12px "Cascadia Code"'); } catch (e) {}
    try { await document.fonts.ready; } catch (e) {}
    let faceLoaded = false;
    document.fonts.forEach(function (f) {
      if (String(f.family).replace(/["']/g, '') === 'Cascadia Code' && f.status === 'loaded') faceLoaded = true;
    });
    const usable = document.fonts.check('12px "Cascadia Code"');
    // The live terminal must actually resolve to the family, not silently to Consolas.
    // xterm sets the font on the .xterm element (and its .xterm-rows), so read those.
    const cand = ['.pane .xterm', '.xterm .xterm-rows', '.xterm-screen'];
    let applied = '';
    for (var i = 0; i < cand.length; i++) {
      var el = document.querySelector(cand[i]);
      if (el) { var ff = getComputedStyle(el).fontFamily; if (/Cascadia Code/i.test(ff)) { applied = ff; break; } if (!applied) applied = cand[i] + '=' + ff; }
    }
    return { faceLoaded: faceLoaded, usable: usable, applied: applied };
  });
  t('a Cascadia Code @font-face actually loaded (bundled, not the OS)', info.faceLoaded, info);
  t('the family is usable and applied to the terminal', info.usable && /Cascadia Code/i.test(info.applied), info);
  await page.close();
});

// --- instant: opening a tab shows a cursor immediately, then hands off cleanly ---
// A fresh tab has an unavoidable gap (socket open -> shell first byte). We paint an
// instant skeleton cursor so it never reads as a blank "loading" pane, and remove it
// the moment real output lands. Pre-warm is disabled on THIS server so the shell
// spawn is slow enough that the skeleton has a deterministic window to be caught.
check('instant', PORT_INSTANT, async ({ browser, base, t, shot }) => {
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await appReady(page);   // first terminal settles (its own skeleton clears)
  const settled = await page.$$eval('.term-skel', function (els) { return els.length; });
  // Open a second tab. makeTerm creates the skeleton synchronously on click, before
  // the socket even opens — so it is present the instant the pane mounts.
  await page.click('#open-new');
  const appeared = await page.waitForSelector('.term-skel .cur', { state: 'attached', timeout: 3000 })
    .then(function () { return true; }).catch(function () { return false; });
  t('a skeleton cursor appears the instant a new tab opens', appeared, { firstTermSkelSettled: settled });
  if (appeared) await shot(page, 'skeleton');
  // Once the shell's first byte lands, every skeleton is gone — no leftover overlay.
  const cleared = await page.waitForFunction(function () { return document.querySelectorAll('.term-skel').length === 0; }, null, { timeout: 9000 })
    .then(function () { return true; }).catch(function () { return false; });
  t('the skeleton is removed once the terminal is live', cleared);
  await page.close();
}, { WINMUX_NO_PREWARM: '1' });

// --- survive: the server outlives its launcher — spawn, reattach, quit-completely -
// Session survival's automatable core (electron/server-host.js): a real launch RESOLVES
// a server — spawning a DETACHED one that outlives the window, reattaching to a live
// one instead of double-spawning, and stopping it deliberately via /api/shutdown. Runs
// self-contained on a forced port (9935) so it never touches the harness's own servers.
check('detach', PORT_SURVIVE2, async ({ t }) => {
  const { resolveServer, shutdownServer } = require('./dist-electron/server-host.js');
  const scratch = path.join(OUT, 'survive2');
  fs.mkdirSync(scratch, { recursive: true });
  const instanceFile = path.join(scratch, 'instance.json');
  try { fs.unlinkSync(instanceFile); } catch (e) {}
  // No forced port — let the server pick a FREE candidate and report it back, so a
  // stale server from a prior run can never make this refuse-and-timeout.
  const opts = { instanceFile, trustFile: path.join(scratch, 'devices.json'), execPath: process.execPath, serverPath: path.join(ROOT, 'server.cjs'), timeoutMs: 15000 };
  const alive = (port) => new Promise((res) => {
    const rq = http.get({ host: '127.0.0.1', port: port, path: '/api/info' }, (x) => { x.resume(); res(true); });
    rq.on('error', () => res(false)); rq.setTimeout(900, () => { rq.destroy(); res(false); });
  });
  let boundPort = 0;
  try {
    const a = await resolveServer(opts);
    boundPort = a.port;
    t('a detached server spawns and advertises its port', a.attached === false && a.port > 0, a);
    const b = await resolveServer(opts);
    t('a relaunch reattaches to the live server instead of spawning again', b.attached === true && b.port === a.port, b);
    const ok = await shutdownServer(a.port);
    await new Promise((r) => setTimeout(r, 700));
    const stillUp = await alive(a.port);
    const fileGone = !fs.existsSync(instanceFile);
    t('quit-completely (/api/shutdown) stops the server and clears discovery', ok && !stillUp && fileGone, { ok, stillUp, fileGone });
  } finally {
    // Belt-and-braces: never leave the spawned server running if an assert threw.
    if (boundPort) { try { await shutdownServer(boundPort); } catch (e) {} }
    try { fs.unlinkSync(instanceFile); } catch (e) {}
  }
});

// --- launchfail: a launch that fails reaches the dialog, not a stack trace ---
// Two ways the app used to die before it could say anything useful, both on the
// path a stranger hits when their machine is not the machine we built on.
//
// B1: server.cjs was required at the TOP of main.js, and it pulls in the native
// terminal library as it loads. A missing prebuild, an antivirus quarantine, a
// half-finished install — any of them threw while main.js was still being
// evaluated, which is before the app is ready, so the "could not start its
// engine" dialog could not run. It killed Rust builds too, which never use that
// library. This asserts on the BUILT file, because the build is what ships.
//
// B2: the engine spawn had no error listener, so a blocked binary became an
// uncaught exception that went straight past the try/catch written to catch it.
// Proven in a child process — if the fix regressed, the crash would take the
// whole suite with it instead of failing one assertion.
check('launchfail', PORT_BUSY, async ({ t }) => {
  const mainJs = path.join(ROOT, 'dist-electron', 'main.js');
  const src = fs.readFileSync(mainJs, 'utf8');
  const lines = src.split(/\r?\n/);
  const reqLines = lines.filter((l) => /require\(["']\.\.\/server\.cjs["']\)/.test(l));
  t('the built main.js does load server.cjs somewhere', reqLines.length >= 1, reqLines.length);
  t('but never at the top of the file, where no dialog can catch it',
    reqLines.every((l) => /loadNodeEngine/.test(l)), reqLines.map((l) => l.trim().slice(0, 120)));

  // B2, in its own process so a regression cannot kill this run.
  const hostJs = path.join(ROOT, 'dist-electron', 'server-host.js').replace(/\\/g, '\\\\');
  const missing = path.join(OUT, 'no-such-engine-' + Date.now() + '.exe').replace(/\\/g, '\\\\');
  const instFile = path.join(OUT, 'launchfail-inst.json').replace(/\\/g, '\\\\');
  const script = 'const h = require("' + hostJs + '");'
    + 'h.resolveServer({ rustCorePath: "' + missing + '", execPath: process.execPath,'
    + ' serverPath: "' + missing + '", instanceFile: "' + instFile + '",'
    + ' trustFile: "' + instFile + '", timeoutMs: 6000 })'
    + '.then(function (r) { console.log("RESOLVED " + JSON.stringify(r)); },'
    + ' function (e) { console.log("REJECTED " + e.message); });';
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script], { cwd: ROOT, env: process.env });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.stderr.on('data', (d) => { buf += d; });
    child.on('close', (code) => resolve({ code, buf: buf.trim() }));
  });
  // Every one of these insists on the REJECTED line. Without that, a crash
  // satisfies them by accident: the uncaught ENOENT stack trace also contains
  // the binary's path and also arrives immediately, so "names the binary" and
  // "gives up quickly" both passed against the very failure they exist to catch.
  const rejected = out.code === 0 && /^REJECTED /m.test(out.buf);
  t('a missing or blocked engine is reported, not thrown past the error handling', rejected, out);
  t('and the message names the binary, so the person knows what to unblock',
    rejected && /REJECTED [^\n]*no-such-engine-/.test(out.buf), out.buf.slice(0, 200));
  t('and it gives up as soon as it knows, instead of waiting out the timeout',
    rejected && !/did not come up within/.test(out.buf), out.buf.slice(0, 200));
});

// --- exittruth: a shell that ends says so (AUDIT-1) -------------------------
// The audit's worst-ranked defect, and it only existed on the engine we ship.
// Type `exit` and the shell dies — but nothing told anyone. The tab stayed, the
// sidebar kept counting the session, every keystroke went into a dead pipe, and
// a reload replayed the corpse as a live session. The app looked completely
// healthy while nothing behind it was, which is the shape of half this page.
check('exittruth', PORT_EXITTRUTH, async ({ browser, base, t }) => {
  const page = await desktop(browser);
  const live = () => fetch(base + '/api/info', { cache: 'no-store' })
    .then((r) => r.json()).then((j) => j.sessions);
  try {
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await appReady(page);
    const before = await live();
    t('a shell is running before we end it', before >= 1, before);

    // End it the way a user does: type `exit` at the prompt.
    await page.locator('.xterm-helper-textarea').first().focus();
    await page.keyboard.type('exit');
    await page.keyboard.press('Enter');

    // The engine must stop counting it. Wait for the condition, not a guess.
    const dropped = await page.waitForFunction(
      `fetch('/api/info', { cache: 'no-store' }).then(function (r) { return r.json(); })
         .then(function (j) { return j.sessions < ${before}; })`,
      null, { timeout: 20000 }).then(() => true).catch(() => false);
    t('the engine stops counting a shell that has exited', dropped, { before, after: await live() });

    // And the tab must say so rather than sitting there looking alive. The app
    // writes "[session ended]" and marks the tab closed on the exit message.
    const said = await page.waitForFunction(`(function () {
      var txt = [].map.call(document.querySelectorAll('.xterm-rows > div'),
        function (d) { return d.textContent; }).join('|');
      return /session ended/i.test(txt);
    })()`, null, { timeout: 20000 }).then(() => true).catch(() => false);
    t('the tab tells you the session ended, instead of looking alive', said,
      said ? true : await page.evaluate(() =>
        [].map.call(document.querySelectorAll('.xterm-rows > div'), (d) => d.textContent)
          .join('|').slice(-300)));

    // The chrome around the terminal has to be as honest as the terminal. The
    // first version of this fix left the tab telling the truth while the sidebar
    // put a red "1 needs you" on a shell that had finished cleanly and the header
    // called it "disconnected" — sending you hunting for a network fault that
    // was really just you typing `exit`.
    const chrome = await page.evaluate(() => ({
      need: (document.getElementById('d-need') || {}).textContent,
      groupSub: [].map.call(document.querySelectorAll('.psub'), (d) => d.textContent).join(' | '),
      conn: (document.querySelector('.conntext') || {}).textContent || '',
    }));
    // groupSub must be non-empty, or the "no needs you" half of this passes on a
    // string that was never found — a check that greens itself.
    t('and nothing asks for you — the shell finished, it did not fail',
      chrome.need === '0' && /session/i.test(chrome.groupSub)
        && !/needs you/i.test(chrome.groupSub), chrome);
    t('and the header calls it an ended session, not a lost connection',
      /session ended/i.test(chrome.conn), chrome);

    // The half a user hits next: reload. The tab is restored from disk pointing
    // at a session id that no longer exists, and the app gives it a fresh shell —
    // which is right. What must never happen is the fresh shell arriving in
    // silence, wearing the dead one's clothes, so the person types into what they
    // think is the session they left. The app draws a divider and says so; if the
    // engine never registered the exit, the reload reattaches instead and the
    // person gets a live-looking prompt with no divider at all.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await appReady(page);
    const owned = await page.waitForFunction(`(function () {
      var txt = [].map.call(document.querySelectorAll('.xterm-rows > div'),
        function (d) { return d.textContent; }).join('|');
      return /fresh shell|new shell/i.test(txt);
    })()`, null, { timeout: 20000 }).then(() => true).catch(() => false);
    t('and after a reload it owns up to being a fresh shell, not the old one', owned,
      owned ? true : await page.evaluate(() =>
        [].map.call(document.querySelectorAll('.xterm-rows > div'), (d) => d.textContent)
          .join('|').slice(-300)));
  } finally { await page.close(); }
});

// --- nostrand: a slow answer never strands a live engine (AUDIT-4) ----------
// The engine holding your shells is found through one file. Discovery used to
// call it dead on a SINGLE 1200ms ping — so one antivirus scan, Dropbox sync or
// cold start and a second engine launched, took the next port, and overwrote the
// file naming the real one. Every shell, agent and unsaved scrollback on the old
// engine became unreachable and unkillable.
//
// Reproduced honestly: a server that IS healthy but answers in 1800ms, named by
// a file with a genuinely live pid. That is the exact ambiguous state, and the
// only correct reading is "busy", not "dead".
check('nostrand', PORT_NOSTRAND, async ({ t }) => {
  const { resolveServer } = require('./dist-electron/server-host.js');
  const scratch = path.join(OUT, 'nostrand');
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  const instanceFile = path.join(scratch, 'instance.json');

  // A stand-in engine: healthy, answering /api/info, just slower than one ping.
  const slow = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: 3, port: slow.address().port }));
    }, 1800);
  });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const slowPort = slow.address().port;

  // Something genuinely alive to own the file. Its pid is the whole point: a
  // running process is the evidence discovery is supposed to weigh.
  const holder = spawn(process.execPath, ['-e', 'setTimeout(function(){}, 120000)'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 300));

  const stamp = { port: slowPort, host: '127.0.0.1', pid: holder.pid, started: Date.now() };
  fs.writeFileSync(instanceFile, JSON.stringify(stamp));

  let spawned = 0;
  try {
    const opts = {
      instanceFile, trustFile: path.join(scratch, 'devices.json'),
      execPath: process.execPath, serverPath: path.join(ROOT, 'server.cjs'), timeoutMs: 15000,
    };
    const began = Date.now();
    const got = await resolveServer(opts);
    const took = Date.now() - began;
    if (!got.attached) spawned = got.port;

    t('a healthy engine that answers slowly is kept, not replaced',
      got.attached === true && got.port === slowPort, { got, slowPort, tookMs: took });
    // Both halves, together. Time alone proves nothing — without the fix this
    // check ALSO burned 2.5s, spawning a rival engine. What matters is that the
    // time was spent asking the same engine again and it was still there.
    t('and it was kept by asking again, not by luck on the first ping',
      got.attached === true && took >= 1200, { attached: got.attached, tookMs: took });
    const after = JSON.parse(fs.readFileSync(instanceFile, 'utf8'));
    t('the file still points at the engine holding the shells',
      after.pid === holder.pid && after.port === slowPort, after);

    // The other half of the same promise: even if discovery ever DOES misjudge,
    // a second engine must not erase the pointer to the first — and must not
    // take it with it on the way out.
    // The rival must be the engine actually under test — otherwise WINMUX_CORE=rust
    // would prove the Node rule twice and the Rust rule never.
    const rival = RUST_CORE
      ? spawn(RUST_CORE, [], {
          cwd: ROOT, stdio: 'ignore',
          env: Object.assign({}, process.env, {
            WINMUX_PORT: '0', WINMUX_INSTANCE_FILE: instanceFile,
            WINMUX_TRUST_FILE: path.join(scratch, 'devices.json'),
            WINMUX_PUBLIC: path.join(ROOT, 'public'),
          }),
        })
      : spawn(process.execPath, [path.join(ROOT, 'server.cjs')], {
          cwd: ROOT, stdio: 'ignore',
          env: Object.assign({}, process.env, {
            PORT: '0', WINMUX_INSTANCE_FILE: instanceFile,
            WINMUX_TRUST_FILE: path.join(scratch, 'devices.json'),
          }),
        });
    await new Promise((r) => setTimeout(r, 4000));
    const during = JSON.parse(fs.readFileSync(instanceFile, 'utf8'));
    t('a second engine refuses to claim a file a live engine owns',
      during.pid === holder.pid && during.port === slowPort, during);

    rival.kill();
    await new Promise((r) => setTimeout(r, 1500));
    const stillThere = fs.existsSync(instanceFile)
      && JSON.parse(fs.readFileSync(instanceFile, 'utf8')).pid === holder.pid;
    t('and quitting does not take the first engine’s pointer with it', stillThere,
      { exists: fs.existsSync(instanceFile) });

    // The other side of that rule, and the one I broke getting here: a RESTART
    // must still be able to claim the file. Its predecessor may not be reaped
    // yet, but it cannot still be serving — the successor holds the port. Read
    // as a rival, the restarted engine becomes undiscoverable, which is how this
    // fix first showed up as two unrelated Rust failures in the full run.
    const succFile = path.join(scratch, 'succession.json');
    const succPort = P(9971);
    fs.writeFileSync(succFile, JSON.stringify({
      port: succPort, host: '127.0.0.1', pid: holder.pid, started: Date.now() - 60000,
    }));
    const heir = RUST_CORE
      ? spawn(RUST_CORE, [], { cwd: ROOT, stdio: 'ignore', env: Object.assign({}, process.env, {
          WINMUX_PORT: String(succPort), WINMUX_INSTANCE_FILE: succFile,
          WINMUX_TRUST_FILE: path.join(scratch, 'devices.json'),
          WINMUX_PUBLIC: path.join(ROOT, 'public') }) })
      : spawn(process.execPath, [path.join(ROOT, 'server.cjs')], {
          cwd: ROOT, stdio: 'ignore', env: Object.assign({}, process.env, {
            PORT: String(succPort), WINMUX_INSTANCE_FILE: succFile,
            WINMUX_TRUST_FILE: path.join(scratch, 'devices.json') }) });
    await new Promise((r) => setTimeout(r, 4000));
    const claimed = JSON.parse(fs.readFileSync(succFile, 'utf8'));
    t('but a restart on the same port DOES claim the file — succession, not rivalry',
      claimed.pid === heir.pid, { claimed, heir: heir.pid });
    heir.kill();
  } finally {
    try { holder.kill(); } catch (e) {}
    try { slow.close(); } catch (e) {}
    if (spawned) { try { await require('./dist-electron/server-host.js').shutdownServer(spawned); } catch (e) {} }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// --- mcp: an MCP client drives the live WinMux app over stdio ---------------
// winmux-mcp is a stdio MCP server (newline-delimited JSON-RPC) exposing the /rpc
// verbs as tools. The harness plays the MCP client: initialize -> tools/list ->
// call winmux_list (proves it sees the live sessions) -> send+read_screen round
// trip (proves an agent can actually operate the terminal over MCP).
check('mcp', PORT_MCP, async ({ browser, base, t }) => {
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await appReady(page);   // the app connects to /control

  const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux-mcp.cjs')],
    { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_MCP), WINMUX_HOST: '127.0.0.1' }) });
  const pending = {};
  let sb = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    sb += d; let nl;
    while ((nl = sb.indexOf('\n')) >= 0) {
      const line = sb.slice(0, nl).trim(); sb = sb.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch (e) { continue; }
      if (m.id != null && pending[m.id]) { pending[m.id](m); delete pending[m.id]; }
    }
  });
  let seq = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq; pending[id] = resolve;
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} }) + '\n');
    setTimeout(() => { if (pending[id]) { delete pending[id]; reject(new Error('timeout ' + method)); } }, 8000);
  });

  try {
    const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'harness', version: '1' } });
    t('MCP initialize returns the winmux serverInfo', !!(init.result && init.result.serverInfo && init.result.serverInfo.name === 'winmux'), init.result);
    const tl = await call('tools/list');
    t('MCP advertises the winmux tools', !!(tl.result && Array.isArray(tl.result.tools) && tl.result.tools.some((x) => x.name === 'winmux_list')), tl.result && tl.result.tools && tl.result.tools.length);
    const lc = await call('tools/call', { name: 'winmux_list', arguments: {} });
    const listed = JSON.parse(lc.result.content[0].text);
    t('MCP winmux_list sees the live sessions', !!(listed && Array.isArray(listed.sessions) && listed.sessions.length >= 1), listed && listed.sessions && listed.sessions.length);
    const marker = 'MCP_OK_' + PORT_MCP;
    await call('tools/call', { name: 'winmux_send', arguments: { text: '"' + marker + '"', enter: true } });
    await page.waitForTimeout(2500);
    const rc = await call('tools/call', { name: 'winmux_read_screen', arguments: { lines: 60 } });
    const screen = JSON.parse(rc.result.content[0].text);
    t('MCP send + read_screen round-trips through the real shell', String(screen && screen.screen || '').indexOf(marker) >= 0, String(screen && screen.screen || '').slice(-120));
  } finally {
    try { proc.stdin.end(); proc.kill(); } catch (e) {}
    await page.close();
  }
});

// --- notify: an agent flips a session to "needs you" via the CLI -----------
// The attention bus's explicit signal. `winmux notify --id <n> <msg>` marks that
// session needs-you exactly like a bell would — the counter, the row's Approve,
// and (unfocused) the desktop notification all follow. Driven through the real
// CLI -> /rpc -> /control path, like the `cli` check.
check('notify', PORT_NOTIFY, async ({ browser, base, t, shot }) => {
  const winmux = (a) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...a],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_NOTIFY), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = ''; proc.stdout.on('data', (d) => o += d); proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await appReady(page);   // the app connects to /control

  const before = await page.evaluate(() => {
    const at = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
    const need = document.getElementById('d-need');
    return { status: at && at.status, need: need ? need.textContent.trim() : null };
  });
  const r = await winmux(['notify', 'the deploy needs your call']);
  t('notify exits clean and names the session', r.code === 0, r.err || r.out);
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => {
    const at = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
    const need = document.getElementById('d-need');
    const approve = document.querySelector('[data-approve]');
    return { status: at && at.status, need: need ? need.textContent.trim() : null, hasApprove: !!approve };
  });
  t('the targeted session flips to needs-you', after.status === 'needsyou', { before, after });
  t('the NEEDS YOU counter and an Approve control appear', after.need === '1' && after.hasApprove, after);
  await shot(page, 'notify-needsyou');
  await page.close();
});

// --- osnotify: an attention alert reaches Edward when the window is unfocused -
// The point of the attention bus: when a session needs you and WinMux is NOT the
// window you're looking at, an OS notification fires (in-app badges are invisible
// then). When it IS focused, the badge suffices and no OS notification fires. We
// stub window.Notification + document.hasFocus so both cases are deterministic,
// and drive a real `winmux notify` to trigger the path.
check('osnotify', PORT_OSNOTIFY, async ({ browser, base, t }) => {
  const winmux = (a) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...a],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_OSNOTIFY), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = ''; proc.stdout.on('data', (d) => o += d); proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });
  const stub = (focused) => {
    // eslint-disable-next-line no-undef
    try { localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {}
    window.__osNotes = [];
    function FakeNote(title, opts) { window.__osNotes.push({ title: title, body: opts && opts.body }); this.onclick = null; }
    FakeNote.permission = 'granted';
    FakeNote.requestPermission = function () { return Promise.resolve('granted'); };
    window.Notification = FakeNote;
    Object.defineProperty(document, 'hasFocus', { value: function () { return focused; }, configurable: true });
  };

  // Unfocused → the OS notification MUST fire.
  const p1 = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
  await p1.addInitScript(stub, false);
  await p1.goto(base, { waitUntil: 'domcontentloaded' });
  await appReady(p1);
  await winmux(['notify', 'the deploy needs your call']);
  await p1.waitForTimeout(500);
  const unfocused = await p1.evaluate(() => window.__osNotes || []);
  t('an OS notification fires when a session needs you and WinMux is unfocused',
    unfocused.length >= 1 && /needs you/i.test(unfocused[0].title || ''), unfocused);
  await p1.close();

  // Focused → NO OS notification (the in-app badge is enough).
  const p2 = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
  await p2.addInitScript(stub, true);
  await p2.goto(base, { waitUntil: 'domcontentloaded' });
  await appReady(p2);
  await winmux(['notify', 'this should stay quiet']);
  await p2.waitForTimeout(500);
  const focused = await p2.evaluate(() => window.__osNotes || []);
  t('no OS notification fires while WinMux is the focused window', focused.length === 0, focused);
  await p2.close();
});

// --- parity: modern-terminal addons are loaded on the live terminal --------
// Clickable links (web-links addon) + Unicode 11 width tables — the two clean
// parity wins that every modern emulator has. Renderer-independent: reads the
// live term object via window.__winmuxActiveTerm, so it holds under the forced
// DOM renderer here and the shipping WebGL default alike. Writes a URL so the
// screenshot shows a linkified address.
check('parity', PORT_PARITY, async ({ browser, base, t, shot }) => {
  // Most assertions read the live term object (renderer-independent), but the OSC-8
  // sub-check below hovers a .xterm-rows span, which only the DOM renderer creates.
  // Pin it (gpuRenderer:false) so that hover resolves instead of timing out under the
  // shipping WebGL default — this is the "forced DOM renderer here" the header notes.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await page.addInitScript(() => { try {
    localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1');
    const s = JSON.parse(localStorage.getItem('ct-settings') || '{}'); s.gpuRenderer = false;
    localStorage.setItem('ct-settings', JSON.stringify(s));
  } catch (e) {} });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const st = await page.evaluate(async () => {
    const at = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
    if (!at || !at.term) return { ok: false };
    try { at.term.write('Docs: https://github.com/Zbrooklyn/winmux  (Ctrl+click to open)\r\n'); } catch (e) {}
    // Shell integration: emit the OSC escapes a real shell would, then read what
    // WinMux captured. \x1b]7 = cwd, \x1b]133;A = a prompt mark, \x1b]2 = title.
    try {
      at.term.write('\x1b]7;file://desktop/C:/Windows/System32\x07');
      at.term.write('\x1b]133;A\x07');
      at.term.write('\x1b]2;WinMux Parity Demo\x07');
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 400));
    const tt = at.tabEl && at.tabEl.querySelector('.tt');
    return {
      ok: true,
      webLinks: at.term.__winmuxWebLinks === true,
      unicode: at.term.unicode && at.term.unicode.activeVersion,
      cwd: at.cwd,
      marks: (at.marks || []).map((m) => m.k),
      autoTitle: at.autoTitle,
      tabLabel: tt ? tt.textContent : null,
    };
  });
  t('the web-links addon is loaded on the live terminal', st.ok && st.webLinks === true, st);
  t('unicode 11 width tables are active on the terminal', st.unicode === '11', st);
  t('OSC-7 sets the shell cwd (new splits inherit it)', st.ok && /Windows[\\/]+System32/i.test(st.cwd || ''), st);
  t('OSC-133 command marks are captured', st.ok && (st.marks || []).indexOf('A') >= 0, st);
  t('OSC-0/2 auto-titles the tab', st.tabLabel === 'WinMux Parity Demo', st);

  // OSC-8 explicit hyperlinks are handled by xterm CORE, not by the web-links addon
  // ("the addon is loaded" proves nothing about them). With a null linkHandler xterm
  // falls back to its own confirm() + window.open, which bypasses WinMux's opener.
  // So click a real hyperlink and watch where it actually lands.
  await page.evaluate(() => {
    window.__linkProbe = { opened: [], confirms: 0 };
    window.open = function (u) { window.__linkProbe.opened.push(u); return null; };
    window.confirm = function () { window.__linkProbe.confirms++; return false; };
    const at = window.__winmuxActiveTerm();
    at.term.write('\r\n\x1b]8;;https://winmux.example/osc8\x07OSC8-LINK-PROOF\x1b]8;;\x07\r\n');
  });
  await page.waitForTimeout(700);
  const linkCell = page.locator('.xterm-rows span', { hasText: 'OSC8-LINK-PROOF' }).first();
  await linkCell.hover();
  await page.waitForTimeout(250);
  await linkCell.click();
  await page.waitForTimeout(400);
  const osc8 = await page.evaluate(() => window.__linkProbe);
  t('an OSC-8 hyperlink opens through WinMux\'s opener, not xterm\'s confirm() fallback',
    osc8.opened.indexOf('https://winmux.example/osc8') >= 0 && osc8.confirms === 0, osc8);

  await page.waitForTimeout(400);
  await shot(page, 'parity-links');
  await page.close();
});

// --- doing: the live "what's it doing" line reflects a session's latest output -
// The cockpit differentiator that makes a row informative: under the status label
// sits a live, one-line echo of the session's most recent meaningful output, so a
// busy agent reads differently from a stuck one without opening it. We expand the
// group so the row renders, write a unique marker as output on the active term,
// run the real (throttled) capture, and assert the rendered row echoes the marker.
check('doing', PORT_DOING, async ({ browser, base, t, shot }) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await page.addInitScript(() => { try { localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {} });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  // Expand the active group so the session row (and its .sdoing line) render.
  const gid = await page.evaluate(() => {
    const ex = document.querySelector('[data-expand]');
    return ex ? ex.getAttribute('data-expand') : null;
  });
  // Ensure expanded, don't toggle blindly: since AUDIT-B6 the list ships open,
  // and a click on an already-open group collapses it — which took the row this
  // check is entirely about off the screen.
  if (gid) {
    const showing = await page.evaluate(() => document.querySelectorAll('.skids .srow').length > 0);
    if (!showing) { try { await page.click('[data-expand="' + gid + '"]'); } catch (e) {} }
  }
  await page.waitForTimeout(300);

  const res = await page.evaluate(async () => {
    const at = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
    if (!at || !at.term) return { ok: false };
    const marker = 'DOING_LIVE_9938_building_the_thing';
    // xterm.write() flushes asynchronously; wait for the parser callback so the
    // marker is actually in the buffer before the capture reads it (the product's
    // ~1s throttle covers this race in real use; the test bypasses only the timer).
    await new Promise((r) => { try { at.term.write('\r\n' + marker + '\r\n', r); } catch (e) { r(); } });
    const patched = window.__winmuxCaptureDoing ? window.__winmuxCaptureDoing() : 0;
    const row = document.querySelector('.srow[data-term="' + at.id + '"] .sdoing');
    return { ok: true, lastLine: at.lastLine || '', rowText: row ? row.textContent : null, patched: patched };
  });

  t('the active session captures its latest output line', res.ok && /DOING_LIVE_9938/.test(res.lastLine || ''), res);
  t('the session row shows the live "what it\'s doing" line', /DOING_LIVE_9938/.test(res.rowText || ''), res);
  await page.waitForTimeout(300);
  await shot(page, 'doing-activity-line');
  await page.close();
});

// --- clip: the cross-device clipboard round-trips through /api/clip ----------
// The opt-in clipboard-sync differentiator: a copy on one device POSTs the text
// to the server's in-memory clip, and another device GETs it — so copy-on-PC,
// paste-on-phone works over the tailnet without the text ever touching disk. This
// check drives the raw endpoint (the client only calls it when the toggle is on):
// POST stores it, GET returns exactly it, and an oversized clip is capped.
// AUDIT-T1. Splitting had no floor: keep pressing and you get panes a couple of
// columns wide holding a shell you cannot type into, with no word about it.
// This measures the tightest TERMINAL, not the pane count — the floor is about
// how small a terminal got, and only the terminal knows that.
// AUDIT-T2. A layout saved on a big screen and reopened on a small one rebuilt
// itself at any size: eight panes at seventeen columns, every one unusable, and
// no word about it. Folding must move tabs, never close panes — the sessions
// are the user's, and "it did not fit" is not consent to end them.
const FOLD_SEED = (n) => ({
  v: 4,
  group: 'Workspace',
  cols: Array.from({ length: n }, (_, i) => ([{
    active: 0,
    tabs: [{ type: 'terminal', group: 'Workspace', title: 'seed-' + (i + 1), shell: '', cwd: '' }],
  }])),
});

check('foldfit', PORT_FOLDFIT, async ({ browser, base, t, shot }) => {
  const page = await desktop(browser);
  // Installed BEFORE the first navigation: the app writes its own ct-live as
  // soon as it loads, so a seed applied afterwards is already gone.
  await page.addInitScript((seed) => {
    try { localStorage.setItem('ct-live', JSON.stringify(seed)); } catch (e) {}
  }, FOLD_SEED(8));
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await appReady(page);
  await page.waitForTimeout(3500);

  const state = async () => {
    // .nrow only exists once the panel is opened — reading it closed returns an
    // empty list, which looks exactly like "nothing was announced".
    try { await page.click('#open-notif'); } catch (e) {}
    await page.waitForTimeout(400);
    const s = await page.evaluate(() => ({
      panes: document.querySelectorAll('.workspace .pane').length,
      tabs: document.querySelectorAll('.workspace .ptab').length,
      narrow: window.__winmuxNarrowest ? window.__winmuxNarrowest() : null,
      notes: [].map.call(document.querySelectorAll('.nrow .nt'), (e) => e.textContent),
    }));
    try { await page.keyboard.press('Escape'); } catch (e) {}
    await page.waitForTimeout(200);
    return s;
  };

  const after = await state();
  t('the saved eight panes did not all come back at an unusable size',
    after.panes < 8, { panes: after.panes });
  t('no terminal is left below the floor after folding',
    after.narrow && after.narrow.cols >= 24 && after.narrow.rows >= 6, after.narrow);
  t('every session survives — folded into tabs, not closed',
    after.tabs === 8, { tabs: after.tabs });
  t('and it says what it did, rather than quietly rearranging your work',
    after.notes.some((x) => /did not fit/i.test(x)), after.notes.slice(0, 3));
  await shot(page, 'foldfit');
});

check('splitfloor', PORT_SPLITFLOOR, async ({ browser, base, t, shot }) => {
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await appReady(page);
  await page.setViewportSize({ width: 720, height: 480 });
  await page.waitForTimeout(800);

  const narrow = () => page.evaluate(() => window.__winmuxNarrowest());
  const panes = () => page.evaluate(() => document.querySelectorAll('.workspace .pane').length);
  const notes = async () => {
    try { await page.click('#open-notif'); } catch (e) {}
    await page.waitForTimeout(350);
    const n = await page.evaluate(() => [].map.call(document.querySelectorAll('.nrow .nt'), (e) => e.textContent));
    try { await page.keyboard.press('Escape'); } catch (e) {}
    await page.waitForTimeout(150);
    return n;
  };

  // Press the split until it refuses. Sixteen is far past any honest limit at
  // this size; if it never refuses, that IS the defect.
  let refusals = 0;
  for (let i = 0; i < 16; i++) {
    const before = await panes();
    await page.keyboard.press('Control+Shift+KeyR');
    await page.waitForTimeout(500);
    if ((await panes()) === before) { refusals++; break; }
  }

  const end = await narrow();
  t('the tightest terminal never falls below the floor, however hard you press',
    end.cols >= 24 && end.rows >= 6, end);
  t('and it stopped adding panes rather than adding useless ones',
    refusals > 0, { refusals, panes: await panes() });

  const said = await notes();
  t('the refusal is said out loud, not swallowed',
    said.some((x) => /No room to split/i.test(x)), said.slice(0, 3));
  await shot(page, 'splitfloor');
});

check('clip', PORT_CLIP, async ({ base, t }) => {
  const marker = 'CLIP_SYNC_9939_hello_from_the_pc';
  const post = await fetch(base + '/api/clip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: marker }) }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  t('POST /api/clip stores the copied text', post && post.ok === true && post.len === marker.length, post);
  const got = await fetch(base + '/api/clip', { cache: 'no-store' }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  t('GET /api/clip returns the same text (copy here, paste there)', got && got.ok === true && got.text === marker, got);
  // A clip under the raw-body wall but over the store cap is truncated, never
  // stored whole — the endpoint can't be used to hoard memory.
  const big = 'y'.repeat(150000);
  const cap = await fetch(base + '/api/clip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: big }) }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  t('an oversized clip is capped at 100k, not stored whole', cap && cap.ok === true && cap.len === 100000, cap);
});

// --- config: settings live in a durable, hand-editable file on disk ---------
// The config-file differentiator: settings persist to ~/.winmux/config.json (not
// just localStorage), so they survive a reinstall and can be hand-edited. POST
// writes the file atomically, GET hands it back, and a fresh page with EMPTY
// localStorage still comes up wearing the on-disk settings (proven end-to-end:
// disk -> the live terminal's applied font size). The server here is pointed at a
// temp config file so the test never touches the real one.
check('config', PORT_CONFIG, async ({ base, browser, t, shot }) => {
  try { fs.unlinkSync(CONFIG_TMP); } catch (e) {}
  const post = await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: { fontSize: 17, palette: 'ember' } }) }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  t('POST /api/config persists settings', post && post.ok === true, post);
  const got = await fetch(base + '/api/config', { cache: 'no-store' }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  t('GET /api/config returns the persisted settings', got && got.ok === true && got.config && got.config.settings && got.config.settings.fontSize === 17, got);
  let onDisk = null; try { onDisk = JSON.parse(fs.readFileSync(CONFIG_TMP, 'utf8')); } catch (e) {}
  t('the config is a real hand-editable file on disk', onDisk && onDisk.settings && onDisk.settings.fontSize === 17, onDisk);
  // A fresh install (empty localStorage) must still come up wearing the on-disk
  // settings — the whole point of moving off localStorage-only.
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {} });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4800);
  const applied = await page.evaluate(() => {
    const at = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
    return { fontSize: at && at.term && at.term.options ? at.term.options.fontSize : null };
  });
  t('a fresh install with no localStorage adopts the on-disk settings', applied.fontSize === 17, applied);
  await shot(page, 'config-from-disk');
  await page.close();
}, { WINMUX_CONFIG_FILE: CONFIG_TMP });

// --- theme-import: a Windows Terminal colour scheme recolours the terminal ---
// The theme-import differentiator: paste a WT colour scheme and the terminal wears
// it. We feed a real scheme (Campbell), import + apply it, and assert the imported
// ANSI colours land on the live xterm theme — including WT's "purple" mapping to
// ANSI magenta. Renderer-independent (reads term.options.theme), and it writes a
// coloured sample so the screenshot shows the scheme applied.
check('theme-import', PORT_THEME, async ({ browser, base, t, shot }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
  await page.addInitScript(() => { try { localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {} });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const scheme = {
    name: 'Campbell',
    black: '#0C0C0C', red: '#C50F1F', green: '#13A10E', yellow: '#C19C00', blue: '#0037DA',
    purple: '#881798', cyan: '#3A96DD', white: '#CCCCCC',
    brightBlack: '#767676', brightRed: '#E74856', brightGreen: '#16C60C', brightYellow: '#F9F1A5',
    brightBlue: '#3B78FF', brightPurple: '#B4009E', brightCyan: '#61D6D6', brightWhite: '#F2F2F2',
    background: '#0C0C0C', foreground: '#CCCCCC',
  };
  const res = await page.evaluate(async (sch) => {
    const r = window.__winmuxImportTheme(JSON.stringify(sch));
    const at = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
    if (at && at.term) await new Promise((done) => { try { at.term.write('\x1b[31m red \x1b[32m green \x1b[33m yellow \x1b[34m blue \x1b[35m magenta \x1b[36m cyan \x1b[0m\r\n', done); } catch (e) { done(); } });
    const th = at && at.term && at.term.options ? at.term.options.theme : null;
    return { r, red: th && th.red, green: th && th.green, magenta: th && th.magenta, brightMagenta: th && th.brightMagenta };
  }, scheme);
  t('a Windows Terminal scheme imports cleanly', res.r && res.r.ok === true, res.r);
  t('the imported ANSI colours apply to the live terminal',
    String(res.red).toLowerCase() === '#c50f1f' && String(res.green).toLowerCase() === '#13a10e', res);
  t('WT "purple" maps to ANSI magenta (both intensities)',
    String(res.magenta).toLowerCase() === '#881798' && String(res.brightMagenta).toLowerCase() === '#b4009e', res);
  await page.waitForTimeout(300);
  await shot(page, 'theme-import');
  await page.close();
});

// --- keybindings: a remapped shortcut moves; the old chord goes dead ---------
// The custom-keybindings differentiator: rebind an action and the new chord runs
// it while the old default no longer does. We remap the command palette to Ctrl+K,
// then fire real keydown events: Ctrl+K must open the palette, and the old
// Ctrl+Shift+P must not. Proves the keydown chain is keymap-driven, not hardcoded.
check('keybindings', PORT_KEYS, async ({ browser, base, t, shot }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
  // Clear any stored keymap so the default-chord assertion tests a real default.
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {} });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const res = await page.evaluate(() => {
    function fire(init) { document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, init))); }
    function paletteOpen() { var w = document.getElementById('palette-wrap'); return !!(w && w.hasAttribute('data-open')); }
    // Default chord still works after the keymap refactor.
    fire({ key: 'P', ctrlKey: true, shiftKey: true });
    var defOpens = paletteOpen();
    fire({ key: 'Escape' });
    window.__winmuxSetKeymap('palette', 'Ctrl+K');
    fire({ key: 'Escape' });
    fire({ key: 'k', ctrlKey: true });
    var newOpens = paletteOpen();
    fire({ key: 'Escape' });
    fire({ key: 'P', ctrlKey: true, shiftKey: true });
    var oldOpens = paletteOpen();
    fire({ key: 'Escape' });
    return { effective: window.__winmuxKeymap().map.palette, defOpens: defOpens, newOpens: newOpens, oldOpens: oldOpens };
  });
  t('the default chord still works after the keymap refactor', res.defOpens === true, res);
  t('a remapped shortcut is recorded', res.effective === 'Ctrl+K', res);
  t('the new chord runs the action', res.newOpens === true, res);
  t('the old default no longer triggers it', res.oldOpens === false, res);
  await page.close();
});

// --- markdown: the viewer surface renders a file and follows its edits ------
// `winmux markdown <file>` opens a read surface in the app. The server reads the
// file (/api/md), the app renders a tiny markdown subset, and it re-pulls on a
// timer so a file the agent is writing updates live. This check drives the real
// CLI path (like `cli`) and then edits the file on disk to prove the live pull.
// Config/layout migration (#212): a saved layout written by a future WinMux, or
// a corrupt one, must never brick a returning user — the app boots to a working
// terminal either way, not a blank frame.
check('migrate', PORT_MIGRATE, async ({ browser, base, t }) => {
  const oneTab = { active: 0, tabs: [{ shell: 'powershell', cwd: '', group: '', title: '', sid: '' }] };
  const boot = async (blob) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    await ctx.addInitScript((b) => { try { localStorage.setItem('ct-live', JSON.stringify(b)); localStorage.setItem('ct-onboard', '1'); localStorage.setItem('ct-close-notice', '1'); } catch (e) {} }, blob);
    const p = await ctx.newPage();
    await p.goto(base, { waitUntil: 'domcontentloaded' });
    await appReady(p);
    const n = await p.evaluate(() => document.querySelectorAll('.pane .xterm').length);
    await ctx.close();
    return n;
  };
  t('a normal saved layout restores its panes', (await boot({ v: 1, group: '', cols: [[oneTab], [oneTab]] })) === 2);
  t('a layout from a future version does not brick — it falls back to a terminal',
    (await boot({ v: 999, group: '', cols: [[oneTab], [oneTab], [oneTab]] })) >= 1);
  t('a corrupt saved layout does not brick either', (await boot({ v: 1, group: '', cols: [[{ active: 0, tabs: 'x' }]] })) >= 1);
});

// First-run onboarding (#216): a virgin browser is greeted once, dismisses, and
// never sees it again; the add-your-phone path lands in the right settings.
check('onboard', PORT_ONBOARD, async ({ browser, base, t, shot }) => {
  // A raw context (no ct-onboard seed) is a genuine first-time visitor.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const p = await ctx.newPage();
  await p.goto(base, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
  const w = () => p.evaluate(() => ({
    open: !!(document.getElementById('welcome-ovl') || {}).hasAttribute && document.getElementById('welcome-ovl').hasAttribute('data-open'),
    title: ((document.querySelector('.wc-title') || {}).textContent) || '',
    hasStart: !!document.getElementById('wc-start'),
    hasPhone: !!document.getElementById('wc-phone'),
    // Scoped to the welcome card: the agents-guide overlay reuses .wc-pt rows,
    // and this check is about the welcome's three points, not the whole page.
    points: document.querySelectorAll('#welcome-ovl .wc-pt').length,
  }));
  const first = await w();
  t('a first-time visitor is greeted by the welcome', first.open === true, first);
  t('the welcome says what WinMux is and how to act', /follows you/i.test(first.title) && first.hasStart && first.hasPhone && first.points === 3, first);
  await shot(p, 'onboarding');

  await p.click('#wc-start');
  await p.waitForTimeout(400);
  t('Start dismisses the welcome', (await w()).open === false);

  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  t('it does not return on the next visit', (await w()).open === false);
  await ctx.close();

  // The "Add my phone" path, from a fresh visitor, lands in the Phone settings.
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const p2 = await ctx2.newPage();
  await p2.goto(base, { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(3500);
  await p2.click('#wc-phone');
  await p2.waitForTimeout(700);
  const onPhone = await p2.evaluate(() => {
    const ov = document.getElementById('settings-ovl');
    // The Phone tab's tell is its scan/QR copy — proof we landed on it, not just any tab.
    const body = ov ? ov.textContent || '' : '';
    return {
      settingsOpen: !!(ov && ov.hasAttribute('data-open')),
      onPhoneTab: /scan|QR|Tailscale/i.test(body),
    };
  });
  t('Add my phone opens settings on the Phone tab', onPhone.settingsOpen === true && onPhone.onPhoneTab === true, onPhone);
  await ctx2.close();

  // The phone is a first-class surface for onboarding — a stranger who scans the
  // QR lands here cold, so the welcome must greet and fit at a phone width too.
  const pctx = await browser.newContext({
    viewport: { width: 384, height: 745 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, colorScheme: 'dark',
  });
  const pp = await pctx.newPage();
  await pp.goto(base, { waitUntil: 'domcontentloaded' });
  await pp.waitForTimeout(3500);
  const ph = await pp.evaluate(() => {
    const o = document.getElementById('welcome-ovl');
    const card = document.querySelector('#welcome-ovl .welcome');
    const vw = window.innerWidth;
    const r = card ? card.getBoundingClientRect() : null;
    return {
      open: !!(o && o.hasAttribute('data-open')),
      // The card must sit fully inside the viewport: left edge ≥ 0 and right edge ≤ vw.
      fits: r ? (r.left >= 0 && r.right <= vw + 0.5) : false,
      width: r ? Math.round(r.width) : null, vw,
      hasStart: !!document.getElementById('wc-start'),
    };
  });
  t('the welcome greets on the phone too', ph.open === true && ph.hasStart === true, ph);
  t('and its card fits inside the phone width (no horizontal overflow)', ph.fits === true, ph);
  await shot(pp, 'onboarding-phone');
  await pctx.close();
});

// Coexistence (Phase 12): the packaged .exe and the from-source dev copy must
// resolve to disjoint identities, or they share Electron's userData (and its
// ProcessSingleton lock), the CLI discovery file, and the trust file. This is
// the cheap unit guard; verify-coexist.cjs proves it end-to-end on a real build.
check('profile', PORT_ONBOARD, async ({ t }) => {
  const { resolveProfile } = require('./dist-electron/profile.js');
  const o = { appData: 'C:\\A', home: 'C:\\H' };
  const prod = resolveProfile({ ...o, isPackaged: true });
  const dev = resolveProfile({ ...o, isPackaged: false });
  const sep = require('path').sep;
  t('packaged and dev appIds differ', prod.appId !== dev.appId, { prod: prod.appId, dev: dev.appId });
  t('packaged and dev userData dirs differ', prod.userData !== dev.userData, { prod: prod.userData, dev: dev.userData });
  t('userData dirs do not nest (no shared singleton lock)',
    !prod.userData.startsWith(dev.userData + sep) && !dev.userData.startsWith(prod.userData + sep));
  t('discovery files differ', prod.instanceFile !== dev.instanceFile, { prod: prod.instanceFile, dev: dev.instanceFile });
  t('trust files differ', prod.trustFile !== dev.trustFile);
  t('production identity is the stable public one', prod.appId === 'com.zbrooklyn.winmux' && prod.name === 'WinMux');
});

// Paste safety (#214): a multi-line paste stops to ask before it can run every
// line; a single-line paste is unbothered.
check('paste', PORT_PASTE, async ({ browser, base, t }) => {
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  const firePaste = (text) => page.evaluate((txt) => {
    const ta = document.querySelector('.xterm-helper-textarea');
    if (!ta) return false;
    const dt = new DataTransfer();
    dt.setData('text/plain', txt);
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  }, text);
  const dlg = () => page.evaluate(() => {
    const d = document.getElementById('dlg-ovl'), body = document.getElementById('dlg-body');
    return { open: !!(d && d.hasAttribute('data-open')), text: body ? body.textContent : '' };
  });

  await firePaste('echo one\necho two\necho three');
  await page.waitForTimeout(400);
  const multi = await dlg();
  t('a multi-line paste stops to ask before it runs', multi.open && /Paste 3 lines/.test(multi.text), multi);
  t('the warning says these lines will run as commands', /run each one as a command/.test(multi.text));

  await page.evaluate(() => { const c = document.querySelector('#dlg-body [data-cancel]'); if (c) c.click(); });
  await page.waitForTimeout(300);
  t('cancelling the paste closes the dialog and sends nothing', (await dlg()).open === false);

  await firePaste('echo just-one-line');
  await page.waitForTimeout(400);
  t('a single-line paste is not interrupted', (await dlg()).open === false);
});

// Phase 2 — inline command prediction ("smarter typing"). This is a SHELL feature,
// not a WinMux injection: PowerShell 7 (pwsh) ships PSReadLine 2.4+, which renders a
// grey, history-based completion inline as you type and accepts it on RightArrow.
// Windows PowerShell 5.1 ships PSReadLine 2.0, which has no prediction at all — so
// the proof runs on a pwsh tab and skips cleanly on a machine without pwsh installed.
// Proof: after typing only a PREFIX, the full seeded command is on screen (the suffix
// was never typed, so it is the prediction), and RightArrow+Enter runs the whole
// command — a second execution of the seeded echo.
check('prediction', PORT_PREDICT, async ({ browser, base, t, shot }) => {
  const page = await desktop(browser, { defaultShell: 'pwsh' });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  // Skip on machines where PowerShell 7 isn't installed: prediction is impossible on
  // the 5.1 default, and that is a property of the OS, not a WinMux regression.
  const shells = await page.evaluate(async () => {
    try { return await (await fetch('/shells')).json(); } catch (e) { return []; }
  });
  const hasPwsh = Array.isArray(shells) && shells.some((s) => s && s.key === 'pwsh');
  if (!hasPwsh) {
    t('PowerShell 7 present → inline prediction available (skipped: pwsh not installed)', true, 'skip');
    await page.close();
    return;
  }

  await page.waitForTimeout(6000);
  const screen = () => page.evaluate(() => {
    const r = document.querySelector('.xterm-rows');
    return r ? r.innerText : '';
  });
  const marker = 'winmuxpredict' + PORT_PREDICT;

  // Seed history with a distinctive command, then clear the screen so the marker
  // count that follows reflects ONLY the prediction + the accepted re-run (no
  // scrolled-off ambiguity).
  await page.click('.xterm').catch(() => {});
  await page.keyboard.type('echo ' + marker);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);
  await page.keyboard.type('cls');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  const cleared = (await screen()).match(new RegExp(marker, 'g')) || [];
  t('the screen is clear before the prediction test', cleared.length === 0, cleared.length);

  // Type only a prefix; PSReadLine predicts the rest inline (grey) from history.
  await page.keyboard.type('echo winmuxp');
  await page.waitForTimeout(1400);
  const predicted = await screen();
  t('inline prediction completes the command from history',
    predicted.indexOf('echo ' + marker) >= 0, predicted.slice(-160));

  // RightArrow accepts the prediction; Enter runs the now-complete command, so the
  // marker prints again — on the cleared screen it now appears at least twice
  // (the command line + its output).
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  const after = (await screen()).match(new RegExp(marker, 'g')) || [];
  t('RightArrow accepts the prediction and runs the full command', after.length >= 2, { after: after.length });
  await shot(page, 'prediction');
  await page.close();
});

// Phase 3 — inline images. The `@xterm/addon-image` addon decodes the iTerm2 IIP
// escape into a real picture in the terminal grid, and `winmux image <path>` emits
// that escape. Proof is the RENDERED artifact, not the byte path: after running the
// verb on a committed fixture, the addon must have created its dedicated image-layer
// canvas AND painted non-transparent pixels into it. (The layer is created lazily,
// only when an image actually decodes — so its presence with real pixels is the tell.)
check('images', PORT_IMAGES, async ({ browser, base, t, shot }) => {
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const CLI = path.join(ROOT, 'bin', 'winmux.cjs');
  const FIX = path.join(ROOT, 'test', 'fixtures', 'winmux-logo.png');

  await page.click('.xterm').catch(() => {});
  await page.keyboard.type('node "' + CLI + '" image "' + FIX + '"');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3500);

  const img = await page.evaluate(() => {
    const layer = document.querySelector('.xterm-screen canvas.xterm-image-layer');
    if (!layer) return { layer: false };
    // Sample the layer for any non-transparent pixel — proves a picture was painted,
    // not merely that an empty canvas was allocated.
    let painted = false;
    try {
      const ctx = layer.getContext('2d');
      const d = ctx.getImageData(0, 0, layer.width, layer.height).data;
      for (let i = 3; i < d.length; i += 4) { if (d[i] !== 0) { painted = true; break; } }
    } catch (e) { painted = 'unreadable:' + e.message; }
    return { layer: true, w: layer.width, h: layer.height, painted };
  });
  t('the image addon created its image layer', img.layer === true, img);
  t('a real picture was painted into the layer', img.painted === true, { painted: img.painted });

  // The verb ends with a newline so the shell's next prompt lands on a FRESH row
  // below the image, never overwriting its last row. Proof: the last non-empty text
  // row is a bare returned prompt (ends in "> "), and it sits below the image's
  // reserved rows — i.e. the image did not eat the prompt line.
  const tail = await page.evaluate(() => {
    const r = document.querySelector('.xterm-rows');
    const lines = (r ? r.innerText : '').split('\n').map((s) => s.replace(/\s+$/, ''));
    const nonEmpty = lines.filter((s) => s.length);
    return nonEmpty[nonEmpty.length - 1] || '';
  });
  t('the shell returns to a clean prompt below the image (no overlap)', /> ?$/.test(tail.trim()) && /PS /.test(tail), tail);

  await shot(page, 'images');
  await page.close();
});

check('markdown', PORT_MD, async ({ browser, base, t, shot }) => {
  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_MD), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = '';
    proc.stdout.on('data', (d) => o += d);
    proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });

  // The file the viewer will show — written where the server can read it.
  const mdFile = path.join(OUT, 'md-' + PORT_MD + '.md');
  fs.writeFileSync(mdFile, '# Hello WinMux\n\nThis is **bold** and `code`.\n\n- one\n- two\n');

  // The server side on its own: /api/md reads the file and hands back its text.
  const api = JSON.parse((await get(base + '/api/md?path=' + encodeURIComponent(mdFile))).body);
  t('/api/md reads the file and returns its text', api.ok === true && /Hello WinMux/.test(api.text), { ok: api.ok });
  const missing = JSON.parse((await get(base + '/api/md?path=' + encodeURIComponent(mdFile + '.nope'))).body);
  t('/api/md fails cleanly on a file that is not there', missing.ok === false && !!missing.error, missing.error);

  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await appReady(page);          // the app connects to /control

  const opened = await winmux(['markdown', mdFile]);
  t('winmux markdown exits clean', opened.code === 0, opened.err);
  await page.waitForTimeout(1500);

  const rendered = await page.evaluate(() => {
    const e = document.querySelector('.mdleaf .mdbody');
    if (!e) return null;
    return {
      h1: (e.querySelector('h1') || {}).textContent,
      strong: !!e.querySelector('strong'),
      code: !!e.querySelector('code'),
      li: e.querySelectorAll('li').length,
      title: (document.querySelector('.ptab[data-leaf="markdown"] .tt') || {}).textContent,
    };
  });
  t('the viewer surface opened and rendered the markdown',
    !!rendered && rendered.h1 === 'Hello WinMux' && rendered.strong && rendered.code && rendered.li === 2, rendered);
  t('the surface is titled with the file name', !!rendered && /md-\d+\.md$/.test(String(rendered.title)), rendered && rendered.title);
  await shot(page, 'markdown');

  // Live update: the agent rewrites the file; the surface must follow it without
  // a reopen. This is the whole point of a viewer over `cat`.
  fs.writeFileSync(mdFile, '# Changed Title\n\nNew body.\n');
  await page.waitForTimeout(2200);
  const after = await page.evaluate(() => {
    const h = document.querySelector('.mdleaf .mdbody h1');
    return h ? h.textContent : null;
  });
  t('editing the file live-updates the open surface', after === 'Changed Title', after);
  await page.close();
});

// ST5: git diff opens as a pane TAB (leaf), not a side dock. Opening it via the
// New-tab menu mounts a .ptab[data-leaf="diff"] whose body renders the repo's
// git status (the .diff file list, or the "working tree clean" note). The old
// side dock (#dock element + data-dock root attribute) is gone from the DOM.
check('diff-tab', PORT_DIFF, async ({ browser, base, t, shot }) => {
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  const noDock = await page.evaluate(() => ({
    dock: !!document.getElementById('dock'),
    attr: document.getElementById('root').hasAttribute('data-dock'),
  }));
  t('the side dock is gone (no #dock, no data-dock)', noDock.dock === false && noDock.attr === false, noDock);

  // Open the New-tab menu and pick Changes.
  await page.locator('.pc-new').first().click();
  await page.waitForTimeout(200);
  await page.locator('.tmenu .tmi:has-text("Changes")').first().click();
  await page.waitForTimeout(1800);          // /api/git round trip + render

  const leaf = await page.evaluate(() => {
    const tab = document.querySelector('.ptab[data-leaf="diff"]');
    const body = document.querySelector('.term-host.diffleaf');
    const active = document.querySelector('.ptab[data-active]');
    return {
      tab: !!tab,
      fav: tab ? (tab.querySelector('.fav') || {}).textContent : null,
      activeIsDiff: active ? active.getAttribute('data-leaf') === 'diff' : false,
      body: !!body,
      hasDiff: !!(body && body.querySelector('.diff')),
      hasEmpty: !!(body && body.querySelector('.diff-empty')),
    };
  });
  t('a diff leaf opened as a pane tab', leaf.tab === true && leaf.activeIsDiff === true, leaf);
  t('the diff tab carries the ± changes favicon', leaf.fav === '±', leaf.fav);
  t('the diff leaf rendered git status (file list or clean note)',
    leaf.body === true && (leaf.hasDiff === true || leaf.hasEmpty === true), leaf);
  await shot(page, 'diff-tab');

  // Ctrl+Tab MRU must include the leaf: the diff leaf is active now and the terminal
  // was active before it, so one Ctrl+Tab lands on the terminal and a second returns
  // to the diff leaf — proving a non-terminal leaf sits in the same per-pane MRU ring.
  const activeLeaf = () => page.evaluate(() => {
    const a = document.querySelector('#wsrow .ptab[data-active]');
    return a ? (a.getAttribute('data-leaf') || 'terminal') : null;
  });
  await page.keyboard.down('Control'); await page.keyboard.press('Tab'); await page.keyboard.up('Control');
  await page.waitForTimeout(400);
  t('Ctrl+Tab from the diff leaf lands on the terminal (MRU includes leaves)',
    (await activeLeaf()) === 'terminal');
  await page.keyboard.down('Control'); await page.keyboard.press('Tab'); await page.keyboard.up('Control');
  await page.waitForTimeout(400);
  t('a second Ctrl+Tab returns to the diff leaf', (await activeLeaf()) === 'diff');
  await page.close();
});

// Item 7 T1 — markdown richness: a plan/doc-shaped file (GFM table + task-list
// checkboxes + an image) must render as real HTML, not fall through to <p> soup.
check('md-rich', PORT_MDRICH, async ({ browser, base, t, shot }) => {
  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_MDRICH), WINMUX_HOST: '127.0.0.1' }) });
    let o = '', e = '';
    proc.stdout.on('data', (d) => o += d);
    proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
  });

  const mdFile = path.join(OUT, 'mdrich-' + PORT_MDRICH + '.md');
  fs.writeFileSync(mdFile,
    '# Rich\n\n' +
    '| Name | Role |\n| --- | --- |\n| Ada | Eng |\n| Bo | Design |\n\n' +
    '- [ ] not done yet\n- [x] finished\n\n' +
    '![logo](pic.png)\n');

  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await appReady(page);

  const opened = await winmux(['markdown', mdFile]);
  t('winmux markdown exits clean', opened.code === 0, opened.err);
  await page.waitForTimeout(1500);

  const r = await page.evaluate(() => {
    const e = document.querySelector('.mdleaf .mdbody');
    if (!e) return null;
    const th = [].map.call(e.querySelectorAll('table thead th'), (n) => n.textContent.trim());
    const firstCell = (e.querySelector('table tbody td') || {}).textContent;
    const rows = e.querySelectorAll('table tbody tr').length;
    const boxes = [].map.call(e.querySelectorAll('li.task input[type=checkbox]'), (n) => n.checked);
    const img = e.querySelector('img');
    return { th, firstCell: firstCell && firstCell.trim(), rows, boxes, imgSrc: img && img.getAttribute('src') };
  });
  t('a GFM table renders with header cells + body rows',
    !!r && r.th.join(',') === 'Name,Role' && r.rows === 2 && r.firstCell === 'Ada', r);
  t('task-list items become disabled checkboxes reflecting checked state',
    !!r && r.boxes.length === 2 && r.boxes[0] === false && r.boxes[1] === true, r && r.boxes);
  t('an image renders inline with its src', !!r && /pic\.png$/.test(String(r.imgSrc)), r && r.imgSrc);
  await shot(page, 'md-rich');
  await page.close();
});

// #240 — save-project auto-resume, pinned to a SPECIFIC conversation. An armed
// tab stores its folder AND the exact Claude conversation used in it, and on a
// COLD reopen (the saved shell id no longer resolves — the real X-out-and-relaunch
// case) the fresh shell runs `claude --resume <that id>`. On a WARM reattach (the
// shell survived, e.g. a page reload) it must NOT re-type anything into a live
// agent. "Resume the folder's latest" is not good enough: resuming the wrong
// conversation is worse than not resuming, so the id is the thing under test.
//
// The conversation ids come from Claude's own store (~/.claude/projects/<cwd with
// every non-alphanumeric replaced by '-'>/<id>.jsonl), so the check seeds one
// there for a folder it owns and removes it afterwards. The warm/cold injection
// halves swap the command template for a harmless `echo` so the wiring is provable
// without launching a real agent — the echoed text still carries the pinned id.
const RESUME_SENTINEL = '__WINMUX_RESUMED__';
const RESUME_CWD = path.join(OUT, 'resume-cwd');
const RESUME_EMPTY = path.join(OUT, 'resume-empty');
const RESUME_ID = '11111111-2222-3333-4444-555555555555';
const claudeStoreFor = (p) => path.join(os.homedir(), '.claude', 'projects', path.resolve(p).replace(/[^a-zA-Z0-9]/g, '-'));
check('resume', PORT_RESUME, async ({ browser, base, t, shot }) => {
  fs.mkdirSync(RESUME_CWD, { recursive: true });
  fs.mkdirSync(RESUME_EMPTY, { recursive: true });
  const store = claudeStoreFor(RESUME_CWD);
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, RESUME_ID + '.jsonl'), '{"type":"user","message":"seeded by verify.cjs"}\n');
  // The empty case must be genuinely empty — a leftover store from an earlier run
  // would turn "does not arm" into a false pass.
  try { fs.rmSync(claudeStoreFor(RESUME_EMPTY), { recursive: true, force: true }); } catch (e) {}

  const page = await desktop(browser);
  const readScreen = () => page.evaluate(() => {
    const at = window.__winmuxActiveTerm(); if (!at) return '';
    const b = at.term.buffer.active; let out = '';
    for (let i = 0; i < b.length; i++) { const ln = b.getLine(i); if (ln) out += ln.translateToString(true) + '\n'; }
    return out;
  });
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await appReady(page);

    // 1. The server answers with the folder's REAL conversation ids — read from
    //    Claude's own store, not guessed.
    const listed = await page.evaluate((dir) => new Promise((res) => window.__winmuxClaudeSessions(dir, res)), RESUME_CWD);
    t('the server resolves a folder’s real Claude conversation ids',
      listed.length === 1 && listed[0].id === RESUME_ID, listed);

    // 2. A folder Claude has never run in must NOT arm. Arming it would store a
    //    command that fails on reopen, which reads as "it resumed" and isn't.
    const noArm = await page.evaluate(async (dir) => {
      const at = window.__winmuxActiveTerm();
      at.cwd = dir;
      window.__winmuxArm(at, true);
      await new Promise((r) => setTimeout(r, 1500));
      return { resume: at.resume, resumeId: at.resumeId };
    }, RESUME_EMPTY);
    t('arming a folder with no Claude conversation does NOT arm',
      !noArm.resume && !noArm.resumeId, noArm);

    // 3. Arming a folder that HAS one pins that conversation and builds
    //    `claude --resume <id>` — the command Edward asked for, not `--continue`.
    const pinned = await page.evaluate(async (dir) => {
      const at = window.__winmuxActiveTerm();
      at.cwd = dir;
      window.__winmuxArm(at, true);
      for (let i = 0; i < 40 && !at.resume; i++) await new Promise((r) => setTimeout(r, 100));
      let td = null;
      try { td = JSON.parse(localStorage.getItem('ct-live')).cols[0][0].tabs[0]; } catch (e) {}
      return { resume: at.resume, resumeId: at.resumeId, storedCmd: td && td.resume, storedId: td && td.resumeId, storedCwd: td && td.cwd };
    }, RESUME_CWD);
    t('arming pins the conversation and builds `claude --resume <id>`',
      pinned.resumeId === RESUME_ID && !!pinned.resume && pinned.resume.indexOf('--resume ' + RESUME_ID) >= 0, pinned);
    t('the tab persists BOTH its folder and its pinned conversation',
      pinned.storedId === RESUME_ID && pinned.storedCmd === pinned.resume && !!pinned.storedCwd, pinned);

    // Disarm before swapping the template — a reload while armed with the real
    // command would launch an actual agent inside the harness. The template is
    // written through the ENGINE config too, not just localStorage: since PT-6
    // the on-disk config is the boot-time authority, so a cache-only write gets
    // clobbered on reload whenever the engine already holds a settings dump.
    await page.evaluate(async (sent) => {
      window.__winmuxArm(window.__winmuxActiveTerm(), false);
      const cmd = 'echo ' + sent + ' {id}';
      const s = JSON.parse(localStorage.getItem('ct-settings') || '{}');
      s.resumeCommand = cmd;
      localStorage.setItem('ct-settings', JSON.stringify(s));
      await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: { resumeCommand: cmd } }) }).catch(() => {});
    }, RESUME_SENTINEL);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await appReady(page);

    // Wait for the WANTED template, not merely for "resume is set". The default
    // command is already truthy the instant a tab arms, so a poll on truthiness
    // exits early on the wrong value the moment the disk config lands a beat late
    // — which is what happens under three engines at once, and it took the whole
    // rest of this check down with it (the real `claude` then launches and stops
    // on its trust prompt). Re-arm each pass so a late config is picked up.
    const rearmWant = 'echo ' + RESUME_SENTINEL + ' ' + RESUME_ID;
    const rearmed = await page.evaluate(async (a) => {
      const at = window.__winmuxActiveTerm();
      at.cwd = a.dir;
      for (let i = 0; i < 60; i++) {
        window.__winmuxArm(at, true);
        for (let j = 0; j < 10 && at.resume !== a.want; j++) await new Promise((r) => setTimeout(r, 50));
        if (at.resume === a.want) break;
      }
      return { resume: at.resume, resumeId: at.resumeId };
    }, { dir: RESUME_CWD, want: rearmWant });
    t('the resume command is a template — {id} is replaced with the pinned conversation',
      rearmed.resume === rearmWant, rearmed);

    // Phase 1 — WARM reattach: reload while the shell is still alive on the
    // server. The tab reattaches; nothing may be typed into the running agent.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await appReady(page);
    const warm = await readScreen();
    t('a warm reattach does NOT re-run the resume command',
      warm.indexOf(RESUME_SENTINEL) < 0, { tail: warm.slice(-160) });
    const stillArmed = await page.evaluate(() => {
      const at = window.__winmuxActiveTerm();
      return { resume: at && at.resume, resumeId: at && at.resumeId, pending: at && at.autoResumePending };
    });
    t('the tab stays armed after a warm reattach (still resumes next cold reopen)',
      stillArmed.resumeId === RESUME_ID && stillArmed.pending === false, stillArmed);

    // Phase 2 — COLD reopen: poison the LIVE term's session id so this reload's
    // beforeunload persists an id the server cannot resolve — exactly the real
    // close-the-app-then-relaunch case. The reattach fails (m.lost), a fresh
    // shell spawns, and the armed resume command runs in it, carrying the id.
    await page.evaluate(() => { window.__winmuxActiveTerm().sid = 'deadbeefdeadbeefdeadbeefdeadbeef'; });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    const cold = await readScreen();
    t('a cold reopen auto-runs the resume command in the fresh shell',
      cold.indexOf(RESUME_SENTINEL) >= 0, { tail: cold.slice(-200) });
    t('the command that runs names the PINNED conversation, not "the latest"',
      cold.indexOf(RESUME_ID) >= 0, { tail: cold.slice(-200) });
    const consumed = await page.evaluate(() => {
      const at = window.__winmuxActiveTerm();
      return { resume: at && at.resume, resumeId: at && at.resumeId, pending: at && at.autoResumePending };
    });
    t('resume fires once then clears its pending flag, keeping the arm for next time',
      consumed.pending === false && consumed.resumeId === RESUME_ID, consumed);

    await shot(page, 'resume');
  } finally {
    try { fs.rmSync(store, { recursive: true, force: true }); } catch (e) {}
    await page.close();
  }
});

// Item 7 T3 — terminal command-marks navigation + reset. Seed OSC-133 prompt
// marks at known buffer lines, jump the viewport to one, and reset the buffer.
check('marks', PORT_MARKS, async ({ browser, base, t, shot }) => {
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await appReady(page);

  const res = await page.evaluate(async () => {
    function write(term, s) { return new Promise((r) => term.write(s, r)); }
    const term0 = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
    if (! term0 || ! term0.term) return { error: 'no active term' };
    const term = term0.term;
     term0.marks = [];                       // start from a clean mark list
    const A = '\x1b]133;A\x07';              // OSC 133 ; A = prompt start mark
    const marks = [];
    for (let blk = 0; blk < 3; blk++) {
      await write(term, A);
      marks.push(term.buffer.active.baseY + term.buffer.active.cursorY);
      for (let i = 0; i < 20; i++) await write(term, 'line ' + blk + '-' + i + '\r\n');
    }
    term.scrollToBottom();
    const beforeTop = term.buffer.active.viewportY;
    const jumped = window.__winmuxJumpMark(-1);   // to the previous prompt
    const afterTop = term.buffer.active.viewportY;
    const captured = term0.marks.filter((m) => m.k === 'A').map((m) => m.y);
    const reset = window.__winmuxResetTerm();
    const lenAfterReset = term.buffer.active.length;
    return { marks, captured, jumped, beforeTop, afterTop, reset, lenAfterReset, rows: term.rows };
  });
  t('OSC-133 prompt marks are captured at their buffer lines',
    !!res && !res.error && res.captured.length === 3 && res.captured.join(',') === res.marks.join(','), res);
  t('jump-to-previous-prompt scrolls the viewport onto a mark line',
    !!res && res.jumped === true && res.afterTop < res.beforeTop && res.marks.indexOf(res.afterTop) >= 0, res);
  t('reset clears the terminal buffer back to a clean screen',
    !!res && res.reset === true && res.lenAfterReset <= res.rows, res);
  await shot(page, 'marks');
  await page.close();
});

// Phase 4 — the command-blocks status tag. With commandBlocks ON, an OSC-133 C
// (command start) then D;<exit> (command end) must paint an inline ✓/✗ + time tag,
// green on exit 0 and red on a non-zero exit. Drive the marks synthetically so the
// assertion is deterministic — no shell-timing flake — the same way the `marks`
// check writes OSC-133 A sequences.
check('cmdtag', PORT_CMDTAG, async ({ browser, base, t, shot }) => {
  const page = await desktop(browser);
  // Turn the gated feature on for this context before the app loads its settings.
  await page.addInitScript(() => { try { localStorage.setItem('ct-settings', JSON.stringify({ commandBlocks: true })); } catch (e) {} });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await appReady(page);

  const res = await page.evaluate(async () => {
    function write(term, s) { return new Promise((r) => term.write(s, r)); }
    const t0 = window.__winmuxActiveTerm && window.__winmuxActiveTerm();
    if (!t0 || !t0.term) return { error: 'no active term' };
    const term = t0.term;
    const A = '\x1b]133;A\x07', C = '\x1b]133;C\x07';
    const D = (code) => '\x1b]133;D;' + code + '\x07';
    // A passing command, then a failing one — each: prompt, command echo, command
    // start, output, command end with its exit code.
    await write(term, A + 'echo ok\r\n' + C + 'ok\r\n' + D(0));
    await write(term, A + 'badcmd\r\n' + C + 'not recognized\r\n' + D(1));
    await new Promise((r) => setTimeout(r, 400));
    // Capture geometry, not just DOM presence — a tag can exist yet paint
    // off-screen (the className-overwrite bug clobbered xterm's decoration
    // positioning, collapsing the tag to a full-width block below the terminal).
    // onScreen asserts the tag is a real box sitting inside the terminal screen.
    const scr = document.querySelector('.xterm-screen').getBoundingClientRect();
    const tags = Array.from(document.querySelectorAll('.cmdtag')).map((e) => {
      const r = e.getBoundingClientRect();
      return { cls: e.className, txt: (e.textContent || '').trim(),
        onScreen: r.width > 0 && r.height > 0 && r.top >= scr.top - 2 && r.bottom <= scr.bottom + 2 && r.left >= scr.left - 2 && r.right <= scr.right + 2 };
    });
    return { tags };
  });
  const tags = (res && res.tags) || [];
  const ok = tags.find((x) => /\bok\b/.test(x.cls));
  const bad = tags.find((x) => /\bbad\b/.test(x.cls));
  t('a succeeded command paints a green ✓ tag', !!ok && ok.txt.indexOf('✓') === 0, { tags, ok });
  t('a failed command paints a red ✗ tag', !!bad && bad.txt.indexOf('✗') === 0, { tags, bad });
  t('every status tag renders on-screen inside the terminal', tags.length > 0 && tags.every((x) => x.onScreen), { tags });
  await shot(page, 'cmdtag');
  await page.close();
});

// Phase 8 — the phone approval card is wired, not just drawn. Flip a session to
// needs-you, open its preview card, click Approve, and assert the shell actually
// received Enter ({t:'i',d:'\r'}) over its socket — the real click→keystroke path,
// not the machinery behind it.
check('approvecard', PORT_APPROVECARD, async ({ browser, base, t, shot }) => {
  const winmux = (args) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'winmux.cjs'), ...args],
      { cwd: ROOT, env: Object.assign({}, process.env, { WINMUX_PORT: String(PORT_APPROVECARD), WINMUX_HOST: '127.0.0.1' }) });
    let e = '';
    proc.stderr.on('data', (d) => e += d);
    proc.on('exit', (code) => resolve({ code, err: e.trim() }));
  });
  const page = await desktop(browser);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await appReady(page);
  const sid = await page.evaluate(() => { const at = window.__winmuxActiveTerm(); return at ? at.sid : null; });
  t('a session sid is available to target', !!sid, sid);

  const nu = await winmux(['agent', 'needs-you', '--sid', sid, 'waiting on your approval']);
  t('winmux agent needs-you exits clean', nu.code === 0, nu.err);
  await page.waitForTimeout(700);

  const res = await page.evaluate(async () => {
    // Record what the active session sends to its shell.
    const at = window.__winmuxActiveTerm();
    if (!at || !at.ws) return { error: 'no active ws' };
    window.__sent = [];
    const orig = at.ws.send.bind(at.ws);
    at.ws.send = function (d) { try { window.__sent.push(d); } catch (e) {} return orig(d); };
    // Open the preview card via the real eye button, then click Approve.
    const eye = document.querySelector('[data-eye]');
    if (eye) eye.click();
    await new Promise((r) => setTimeout(r, 350));
    const card = document.querySelector('.sxpv.on');
    const approve = document.querySelector('.pv-approve');
    const lbl = (document.querySelector('.pv-lbl') || {}).textContent || null;
    if (approve) approve.click();
    await new Promise((r) => setTimeout(r, 250));
    return { cardOpen: !!card, hadApprove: !!approve, lbl, sent: window.__sent };
  });
  const sentEnter = !!res && (res.sent || []).some((d) => { try { return JSON.parse(d).d === '\r'; } catch (e) { return false; } });
  t('the approval card opens with an Approve button labelled "Needs your OK"',
    !!res && res.cardOpen === true && res.hadApprove === true && res.lbl === 'Needs your OK', res);
  t('clicking Approve sends Enter to the shell over its socket', sentEnter, { sent: res && res.sent });
  await shot(page, 'approvecard');
  await page.close();
});

// -------------------------------------------------------------------- main

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const run = CHECKS.filter((c) => !ONLY.length || ONLY.includes(c.id));
  if (!run.length) {
    console.log('no such check. known: ' + CHECKS.map((c) => c.id).join(', '));
    process.exit(2);
  }

  // Several checks deliberately SHARE one pool server (brand/fresh/busyport all
  // sit on PORT_BUSY) — that is supported and cheap. What is never legal is a
  // check port that collides with a port some check binds for itself on
  // 127.0.0.1, outside the pool. That kind of typo hides: a single-check run
  // never collides, so it surfaces as an EADDRINUSE crash twenty minutes into a
  // full run, blaming whichever check happened to be second. Say it in one
  // second. (Cost me exactly that: PORT_ORPHAN was written 9994, which
  // PORT_UPDFEED already binds as its stand-in release feed.)
  {
    const SELF_BOUND = { PORT_UPDFEED: PORT_UPDFEED };  // add any new self-bound listener here
    const clashes = [];
    for (const [name, port] of Object.entries(SELF_BOUND)) {
      const ids = CHECKS.filter((c) => c.port === port).map((c) => c.id);
      if (ids.length) clashes.push(name + ' (' + port + ') is also the check port for: ' + ids.join(', '));
    }
    if (clashes.length) {
      console.log('port clash — a check is sitting on a port another check binds itself:');
      for (const line of clashes) console.log('  ' + line);
      process.exit(2);
    }
  }

  // Resolve the tailscale-tunnelled ports ONCE and hand them to every server via
  // env. Booting ~16 servers at once otherwise spawns 32 contending `tailscale
  // status` calls that time out under the load and fail OPEN — which let the
  // auto-picker briefly settle on the tunnelled default (8799). Product code honors
  // this override (empty string = "known none"); unset, it queries tailscale itself. (#246)
  if (process.env.WINMUX_TUNNELLED_PORTS == null) {
    const tun = await tunnelled();
    process.env.WINMUX_TUNNELLED_PORTS = [...tun].join(',');
    if (tun.size) console.log('tailscale tunnels ' + [...tun].join(',') + ' — servers will step around these');
  }

  const ports = [...new Set(run.map((c) => c.port))];
  const servers = SERVERS;
  // Wipe each port's guest list BEFORE its first server, and only there — a
  // check that restarts its own server must find the file it left behind, which
  // is the whole point of "a scanned phone survives a restart".
  for (const port of ports) try { fs.unlinkSync(trustFile(port)); } catch (e) {}
  // Each port starts with no config too, so a leftover from a prior run can't seed
  // unexpected settings into a check that isn't about config.
  for (const port of ports) try { fs.unlinkSync(configFile(port)); } catch (e) {}
  // Since the project-truth arc the engine persists a workspace (and the Rust
  // core an instance file) unconditionally — a fresh clone has neither, so each
  // RUN starts from that same blank slate. Sweep only at run start: checks that
  // restart their own server (survive/resume/workspace) depend on these files
  // surviving WITHIN a run, which this deliberately leaves intact.
  try {
    for (const f of fs.readdirSync(OUT)) {
      if (/^inst-\d+\.json$/.test(f) || /^workspace[.-].*\.json$/.test(f)) fs.unlinkSync(path.join(OUT, f));
    }
  } catch (e) {}
  // A check can carry a per-port server env override (e.g. the update check).
  const envByPort = {};
  for (const c of run) if (c.env) envByPort[c.port] = Object.assign({}, envByPort[c.port], c.env);
  // Force the DOM renderer on every server EXCEPT the gpu, ligature and dprfix
  // checks' — those must run the shipping WebGL default, since what they prove is
  // the renderer itself (it engages; the ligature switch forks it; a dpr-stuck
  // canvas resyncs). Everything else reads .xterm-rows text, which only the DOM
  // renderer fills.
  // AUDIT-P1: start each port's server ON DEMAND, and hand it back as soon as the
  // last check that needs it is done — instead of starting all of them before the
  // first check runs and holding every one until the last check ends.
  //
  // Starting them eagerly meant ~70 engines alive simultaneously for the whole
  // run, each a full server process holding a pre-warmed spare shell and its
  // console. The concurrency cap further down bounds checks IN FLIGHT; nothing
  // bounded servers ALIVE. On this machine that drove system commit charge to
  // zero (0 free of 117.6 GB) and Windows fail-fasted the Electron children with
  // 0xc0000409 — which is why a full Node-engine run could not reach the end at
  // all, dying at a different check each attempt (1, then 64, then 72 of 78).
  // The Rust core survived it only because a Rust engine is one small native
  // binary where a Node engine is a whole Node process.
  //
  // Lazily started and promptly stopped, live servers track the concurrency cap
  // rather than the port count.
  const envFor = (port) => Object.assign({}, envByPort[port],
    (port === PORT_GPU || port === PORT_LIG || port === PORT_DPRFIX) ? {} : { WINMUX_FORCE_DOM: '1' });

  // RESERVE every port up front, with a bare socket rather than a server.
  //
  // The eager start was doing two jobs and I only noticed one of them. Besides
  // running the engines, holding all ~70 ports FENCED THE RANGE OFF: several
  // things in this suite start a server with no port forced and let it pick for
  // itself, and with every harness port already bound they could not land on
  // one. Starting lazily emptied the range, so an auto-picking server squatted
  // on 9912 and the check that came to use it threw "already taken by another
  // process ... held by node". That is a regression I introduced, and I had
  // talked myself out of this exact explanation once by reading only the failing
  // check instead of the interaction.
  //
  // A listening socket costs a file handle, not a process, so the reservation
  // survives without the memory that made a full run unfinishable. Each one is
  // released in ensureServer, immediately before its real engine binds.
  const holds = {};
  const takenByOthers = [];
  for (const port of ports) {
    try {
      holds[port] = await new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(port, '127.0.0.1', () => resolve(s));
      });
    } catch (e) { takenByOthers.push(port); }   // someone else's — server() will refuse it
  }
  console.log(takenByOthers.length
    ? 'heads up — these ports are already in use, their checks will refuse: ' + takenByOthers.join(', ')
    : 'reserved all ' + ports.length + ' ports; engines start as their checks come up');

  // Drop our reservation so the real engine can take the socket. Awaiting the
  // close matters: binding while the placeholder is still listening is an
  // EADDRINUSE the engine would report as a foreign process — us.
  const releaseHold = (port) => new Promise((resolve) => {
    const h = holds[port];
    if (!h) return resolve();
    delete holds[port];
    h.close(() => resolve());
  });

  const starting = {};
  const ensureServer = (port) => {
    if (servers[port]) return Promise.resolve(servers[port]);
    // Two workers can want the same shared port at once — memoise the promise so
    // they wait on one start rather than racing two servers onto one socket.
    if (!starting[port]) {
      starting[port] = releaseHold(port).then(() => server(port, envFor(port))).then((s) => {
        servers[port] = s;
        console.log('    ' + (s.foreign ? 'REFUSED :' + port + ' — something else is on it'
          : (s.borrowed ? 'borrowed the server on :' : 'started :') + port));
        return s;
      });
    }
    return starting[port];
  };

  // How many checks still need each port. Several checks deliberately SHARE one
  // server (brand/fresh/busyport), so a port must not be stopped after the first
  // of them finishes — only after the last one does.
  const owed = {};
  for (const c of run) owed[c.port] = (owed[c.port] || 0) + 1;

  // Manufacture the port collision the failure checks exist for, once, before
  // any of them run. Only when one of them is actually in this run — otherwise
  // it is a socket held for nothing.
  if (run.some((c) => c.id === 'busyport' || c.id === 'reason')) {
    busyHold = await holdTailnet(PORT_BUSY);
    console.log(busyHold
      ? 'holding ' + busyHold.ip + ':' + PORT_BUSY + ' so a phone flip has something real to fail against'
      : 'could not hold the tailnet side of ' + PORT_BUSY + ' — the failure checks will skip');
  }

  const browser = await chromium.launch({ channel: 'msedge', headless: !HEADED });
  const report = [];

  // Run one check, capturing its result into `report`. Kept as a named worker so
  // the pool below can call it under a concurrency cap.
  const runOne = async (c) => {
    const lines = [];
    let fails = 0, skipped = null, blocked = null;
    const t = (name, pass, note) => {
      if (!pass) fails++;
      lines.push('  ' + (pass ? 'PASS  ' : 'FAIL  ') + name +
        (note === undefined ? '' : '\n          ' + JSON.stringify(note)));
    };
    const skip = (why) => { skipped = why; };
    const shot = (page, name) => page.screenshot({ path: path.join(OUT, c.id + '-' + name + '.png') });
    const errs = [];
    // A hung check used to hang the WHOLE run silently: the per-check report is only
    // printed after every worker drains, so one stuck await meant zero output, forever,
    // with no way to tell which check was stuck. Stream a start/end line per check and
    // cap each one — a check that overruns fails loudly instead of eating the run.
    const started = Date.now();
    console.log('  → ' + c.id + ' (:' + c.port + ')');
    let bell;
    const capped = new Promise((_, rej) => {
      bell = setTimeout(() => rej(new Error('check timed out after ' + (CHECK_TIMEOUT / 1000) + 's')), CHECK_TIMEOUT);
    });
    try {
      // The server for this port is started here, on first demand, rather than
      // before the run began. Racing it against the same cap means a slow start
      // is reported as this check timing out, not as a silent stall.
      await Promise.race([ensureServer(c.port), capped]);
      // A port held by something outside this run is a dirty machine, not a
      // broken product. This used to throw, which printed "FAIL the check
      // itself threw" and made the run report "1 of 594 checks FAILED" — a red
      // whose real meaning was "close that other process". A red that blames
      // the product for the environment is worse than no red at all: it is the
      // exact thing that teaches you to skim past failures. So it is recorded
      // as BLOCKED, which is neither a pass nor a product failure — and which
      // still exits non-zero, because the check did not run and nobody may
      // call this run green.
      if (servers[c.port] && servers[c.port].foreign) {
        blocked = servers[c.port].foreign;
      } else {
        await Promise.race([c.run({ browser, base: 'http://127.0.0.1:' + c.port, t, skip, shot, errs }), capped]);
      }
    } catch (e) {
      fails++;
      lines.push('  FAIL  the check itself threw\n          ' + String(e.message || e).slice(0, 200));
    }
    clearTimeout(bell);
    console.log('  ' + (blocked ? 'BLOCKED' : skipped ? 'SKIP' : fails ? '✗' : '✓') + ' ' + c.id +
      ' (' + Math.round((Date.now() - started) / 1000) + 's)');
    report.push({ id: c.id, port: c.port, lines, fails, skipped, blocked });
    // Give the port's engine back the moment the last check needing it is done.
    // This runs whether the check passed, failed or threw — a failing check that
    // held its server would put the exhaustion straight back.
    owed[c.port]--;
    if (owed[c.port] <= 0 && servers[c.port]) {
      try { servers[c.port].stop(); } catch (e) {}
      servers[c.port] = null;
      delete starting[c.port];
    }
  };

  // Concurrency throttle. Running EVERY check at once (unbounded Promise.all)
  // saturates the CPU and makes the timing-sensitive checks (busyport/cli/trust/
  // pwsh) flake — they pass in isolation, fail under a full parallel run. A bounded
  // pool keeps enough parallelism to stay fast while leaving headroom so no check
  // is starved. Override with WINMUX_VERIFY_CONCURRENCY (1 = fully serial).
  const cpu = (os.cpus() || []).length || 4;
  // The cap used to be a flat 3 — chosen when the electron check tripped its own
  // timeouts under saturation, and never revisited. On a 24-core machine that is
  // three cores working and twenty-one idle, and it is the entire reason a full
  // run "costs twelve minutes" and therefore gets deferred to the end of a
  // batch, where it finds everything too late. Measured on this machine:
  //
  //   3 at a time  →  ~12 min   637/637
  //   8 at a time  →  2m 26s    637/637, no flake
  //
  // A fifth of the wall clock, same answer. So: scale with the machine, still
  // leaving two cores for the OS and this process, and keep a ceiling of 8 —
  // past that the browser-driving checks start competing for the same GPU
  // process and the headroom argument becomes real again.
  // Override with WINMUX_VERIFY_CONCURRENCY (1 = fully serial).
  const MAX_CONCURRENCY = Math.max(1, Number(process.env.WINMUX_VERIFY_CONCURRENCY) || Math.min(8, cpu - 2));
  // localecho asserts a LATENCY, not a behaviour: a keystroke painted within
  // 32ms of the keypress. That is a claim about the app on an unloaded machine,
  // and seven other Electron processes are not an unloaded machine — at 8-way it
  // measured -1 (the paint never landed in the window) and reported it as a
  // product regression. That is what the old flat cap of 3 was really protecting,
  // and throttling all 86 checks to protect one of them cost ten minutes a run.
  //
  // So it runs alone, last. Everything else keeps the full width. The electron
  // smoke has a 100ms budget too but takes the best of three samples, which is
  // the other way to survive a loaded machine; it stays in the pool.
  const SOLO = { localecho: 1 };
  const queue = run.filter((c) => !SOLO[c.id]);
  const solo = run.filter((c) => SOLO[c.id]);
  console.log('running ' + queue.length + ' checks, ' + MAX_CONCURRENCY + ' at a time'
    + (solo.length ? ', then ' + solo.length + ' timing-sensitive alone' : ''));
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) { await runOne(queue.shift()); }
  });
  await Promise.all(workers);
  for (const c of solo) await runOne(c);

  await browser.close();
  if (busyHold) busyHold.stop();
  // Before any port bookkeeping: the no-port servers are the only ones that
  // can still be holding a socket nobody in this run is tracking.
  await reapAutoServers();
  // Most are already down — each was stopped as its last check finished. This
  // catches the stragglers: a port whose checks were all skipped, or one a check
  // restarted for itself after the count had run out.
  for (const port of ports) if (servers[port]) { try { servers[port].stop(); } catch (e) {} }
  // And any reservation never claimed — a port whose checks all skipped.
  for (const port of Object.keys(holds)) { try { holds[port].close(); } catch (e) {} }

  let bad = 0, skipped = 0, blocked = 0, total = 0;
  console.log('');
  for (const r of report.sort((a, b) => a.id.localeCompare(b.id))) {
    // BLOCKED is deliberately its own category, printed above the failures so
    // it is read first: it is the only outcome here that says nothing at all
    // about the product, and the only one the reader can fix in ten seconds.
    if (r.blocked) {
      blocked++;
      console.log('BLOCKED  ' + r.id + ' — ' + r.blocked);
      continue;
    }
    if (r.skipped) {
      skipped++;
      console.log('SKIP  ' + r.id + ' — ' + r.skipped);
      continue;
    }
    total += r.lines.length;
    if (r.fails) bad += r.fails;
    console.log((r.fails ? 'FAIL  ' : 'PASS  ') + r.id + '  (:' + r.port + ')');
    console.log(r.lines.join('\n'));
  }
  console.log('');
  // "0/0 checks passed" is the sentence a run prints when it verified nothing
  // at all, and it reads like success. Say what happened instead.
  if (bad) console.log(bad + ' of ' + total + ' checks FAILED');
  else if (total) console.log(total + '/' + total + ' checks passed');
  else console.log('no checks ran');
  if (skipped) console.log(skipped + ' group(s) skipped — see the reasons above; a skip is not a pass');
  // Said in the product's own voice, because the person reading this is about
  // to decide whether the build is good. It is not a verdict on the build.
  if (blocked) {
    console.log(blocked + ' group(s) could not run — something else on this PC is holding their ports.');
    console.log('  That is this machine, not the product: nothing above tells you whether those checks would pass.');
    console.log('  Close the process each line names, then run this again.');
  }
  console.log('screenshots: ' + OUT);
  process.exit(bad || blocked ? 1 : 0);
})();

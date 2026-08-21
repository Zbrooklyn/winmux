#!/usr/bin/env node
// proof.cjs — the full suite, run against a commit that cannot change under it.
//
// The full run takes about twelve minutes. That is only expensive if it blocks,
// and it blocks for one reason: it serves public/ out of the working tree, so
// editing anything while it runs invalidates it. Twelve minutes of not touching
// the repo, or twelve minutes of results that mean nothing.
//
// So the run gets its own throwaway worktree at a pinned commit. "Isolated" has
// to mean ephemeral-per-run, not "in a second directory" — a second directory
// you keep editing is just another mutable tree, and this script exists because
// that mistake is easy to make twice.
//
// Two properties are needed, not one:
//   pinned source     — a worktree at a commit, deleted afterwards → no staleness
//   port namespace    — WINMUX_VERIFY_PORT_BASE → no contention with live runs
// Worktree isolation alone does NOT buy concurrency; the ports are machine-wide.
//
// Usage: node proof.cjs [commit] [-- check names…]
//   commit defaults to HEAD. Prints where the log landed; the tree is removed
//   whatever happens, so a killed run never leaves a stale worktree behind.

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const TOP = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8' }).trim();
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const only = sep === -1 ? [] : argv.slice(sep + 1);
const ref = (sep === -1 ? argv[0] : argv.slice(0, sep)[0]) || 'HEAD';
// 200, not 100: at +100 the close-verb check lands on 10080, which Chromium
// refuses to navigate to (ERR_UNSAFE_PORT). verify.cjs now says so at startup
// instead of three checks from the end of twelve minutes, but the default may
// as well be a base that works.
const BASE = process.env.WINMUX_VERIFY_PORT_BASE || '200';

const sha = execFileSync('git', ['rev-parse', '--short', ref], { cwd: TOP, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: TOP, encoding: 'utf8' }).trim();
if (dirty && ref === 'HEAD') {
  console.log('note: uncommitted changes are NOT in this run — it proves ' + sha + ', nothing else.');
}

const tree = path.join(os.tmpdir(), 'winmux-proof-' + sha + '-' + process.pid);
const rel = path.relative(TOP, ROOT).split(path.sep).join('/');
const logFile = path.join(os.tmpdir(), 'winmux-proof-' + sha + '.log');

const cleanup = () => {
  try { execFileSync('git', ['worktree', 'remove', '--force', tree], { cwd: TOP, stdio: 'ignore' }); } catch (e) {}
  try { fs.rmSync(tree, { recursive: true, force: true }); } catch (e) {}
};
process.on('SIGINT', () => { cleanup(); process.exit(130); });

(async () => {
  console.log('proving ' + sha + ' in a throwaway worktree, ports +' + BASE);
  execFileSync('git', ['worktree', 'add', '--detach', tree, sha], { cwd: TOP, stdio: 'ignore' });
  try {
    // Dependencies are shared, not copied: isolation is of SOURCE. Copying
    // node_modules (or npm-installing per run) would cost more than the run.
    for (const d of ['node_modules', path.join(rel, 'node_modules')]) {
      const from = path.join(TOP, d), to = path.join(tree, d);
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        try { fs.symlinkSync(from, to, 'junction'); } catch (e) {}
      }
    }
    const cwd = path.join(tree, rel);

    // The TypeScript output is not in git, so a fresh worktree has none of it —
    // and `node verify.cjs` does not build. That is why the project's own entry
    // point is `npm run verify` (build, THEN verify): five checks load
    // dist-electron/*.js directly and fail in 0s without it. Proving a commit
    // means proving what that commit compiles to, so the build happens here, and
    // a build failure aborts the run instead of being reported as five red
    // product checks.
    console.log('compiling the pinned source…');
    const tsc = require.resolve('typescript/bin/tsc', { paths: [ROOT] });
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.electron.json'], { cwd, stdio: 'inherit' });

    const log = fs.createWriteStream(logFile);
    const code = await new Promise((resolve) => {
      const p = spawn(process.execPath, ['verify.cjs', ...only], {
        cwd, env: Object.assign({}, process.env, { WINMUX_VERIFY_PORT_BASE: String(BASE) }),
      });
      p.stdout.on('data', (d) => log.write(d));
      p.stderr.on('data', (d) => log.write(d));
      p.on('exit', resolve);
    });
    log.end();
    const out = fs.readFileSync(logFile, 'utf8');
    const summary = (out.match(/^.*checks (?:passed|FAILED).*$/m) || ['(no summary)'])[0].trim();
    const reds = (out.match(/^  FAIL .*$/gm) || []).map((l) => l.trim());
    console.log('\n' + sha + ': ' + summary);
    if (reds.length) { console.log(''); reds.slice(0, 20).forEach((r) => console.log('  ' + r)); }
    console.log('\nfull log: ' + logFile);
    process.exitCode = code;
  } finally {
    cleanup();
  }
})();

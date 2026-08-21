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
const RAN_AT = new Date().toISOString();

// --- the flake ledger -------------------------------------------------------
// A green run is not a fact about the code, it is one sample. Proven the hard
// way: five runs of the same commit returned 637, 636, 637, 636 and 631 passing
// assertions, with four different checks flipping between them, after "637/637"
// had already been reported twice as if it settled something.
//
// So each run appends one line here, and --flakes reads them back. It costs a
// few bytes and it is the only thing that can tell a real regression (fails
// every run from a known commit) from a coin flip (fails some).
const LEDGER = path.join(ROOT, 'verify-out', 'runs.jsonl');

const recordRun = (rec) => {
  try {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
  } catch (e) {}
};

if (argv[0] === '--flakes') {
  let rows = [];
  try {
    rows = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {}
  if (!rows.length) { console.log('no runs recorded yet — run: node proof.cjs HEAD'); process.exit(0); }
  console.log(rows.length + ' recorded run' + (rows.length === 1 ? '' : 's') + ':\n');
  for (const r of rows.slice(-12)) {
    console.log('  ' + r.ran.slice(0, 16).replace('T', ' ') + '  ' + r.sha
      + '  ' + (r.checks - (r.failed || []).length) + '/' + r.checks
      + ((r.failed || []).length ? '  ✗ ' + r.failed.join(' ') : ''));
  }

  // A flake is a check that gave BOTH answers for the SAME commit. Comparing
  // across commits only tells you a red got fixed, which is what a red is for —
  // the first version of this counted those too and made thirty-eight checks
  // look unreliable when four were. The instrument answering a slightly
  // different question than the one you meant, again.
  const bySha = new Map();
  for (const r of rows) {
    if (!bySha.has(r.sha)) bySha.set(r.sha, []);
    bySha.get(r.sha).push(r);
  }
  const flakes = new Map();
  for (const [sha, runs] of bySha) {
    if (runs.length < 2) continue;
    const fails = new Map();
    for (const r of runs) for (const id of r.failed || []) fails.set(id, (fails.get(id) || 0) + 1);
    for (const [id, n] of fails) {
      if (n === runs.length) continue;            // failed every time → a real red
      const prev = flakes.get(id) || { bad: 0, of: 0, shas: [] };
      flakes.set(id, { bad: prev.bad + n, of: prev.of + runs.length, shas: prev.shas.concat(sha) });
    }
  }

  const single = [...bySha.values()].filter((v) => v.length < 2).length;
  if (!flakes.size) {
    console.log('\nNo check has given two different answers for the same commit'
      + (single ? ' — but ' + single + ' commit(s) have only one run each, which proves nothing.' : '.'));
  } else {
    console.log('\nchecks that gave BOTH answers for the same commit:\n');
    [...flakes.entries()].sort((a, b) => b[1].bad - a[1].bad).forEach(([id, f]) => {
      console.log('  ' + id.padEnd(16) + 'failed ' + f.bad + ' of ' + f.of
        + ' runs of ' + f.shas.join(', '));
    });
    console.log('\nEach one goes in docs/FLAKES.md and gets one sitting — not the session');
    console.log('in front of you. Until then, treat any run containing it as unproven.\n');
  }
  const last = rows[rows.length - 1];
  if ((last.failed || []).length) {
    console.log('latest run (' + last.sha + ') was red on: ' + last.failed.join(' '));
  }
  if (single) {
    console.log('\n' + single + ' commit(s) have a single run. One green run is a sample, not a fact —');
    console.log('the whole reason this ledger exists. `node proof.cjs HEAD` again to sample twice.');
  }
  process.exit(0);
}

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
// Stamped per run, not per commit. The old name was winmux-proof-<sha>.log, so
// running the same commit twice silently overwrote the first log — which is
// exactly the evidence a flake ledger needs to keep.
const logFile = path.join(os.tmpdir(), 'winmux-proof-' + sha + '-' + process.pid + '.log');

const cleanup = () => {
  try { execFileSync('git', ['worktree', 'remove', '--force', tree], { cwd: TOP, stdio: 'ignore' }); } catch (e) {}
  try { fs.rmSync(tree, { recursive: true, force: true }); } catch (e) {}
};
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// A killed run cannot finish its own cleanup, and rmSync stops at a junction it
// will not follow — so husks accumulate in temp. Sweep them on the way in: the
// junction is unlinked first (never followed; the real node_modules is on the
// other side of it), then whatever is left.
const sweep = () => {
  try { execFileSync('git', ['worktree', 'prune'], { cwd: TOP, stdio: 'ignore' }); } catch (e) {}
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!/^winmux-proof-.*-\d+$/.test(name)) continue;
    const dir = path.join(os.tmpdir(), name);
    if (dir === tree) continue;
    for (const d of ['node_modules', path.join(rel, 'node_modules')]) {
      const link = path.join(dir, d);
      try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link); } catch (e) {}
      try { fs.rmdirSync(link); } catch (e) {}
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
};

(async () => {
  sweep();
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
    const failed = (out.match(/^ {2}✗ (\S+)/gm) || []).map((l) => l.trim().split(' ')[1]);
    console.log('\n' + sha + ': ' + summary);
    if (reds.length) { console.log(''); reds.slice(0, 20).forEach((r) => console.log('  ' + r)); }
    // Every run leaves a line behind, because a pass count is a sample and a
    // sample is only worth anything next to the other samples. Five runs of one
    // commit gave 637, 636, 637, 636, 631 — four different checks flipping — and
    // nobody would have known from any single one of them.
    recordRun({ sha, ran: RAN_AT, checks: (out.match(/^ {2}(✓|✗) /gm) || []).length, failed });
    console.log('\nfull log: ' + logFile);
    console.log('flake history: node proof.cjs --flakes');
    process.exitCode = code;
  } finally {
    cleanup();
  }
})();

#!/usr/bin/env node
// Run the whole suite against BOTH engines, because both of them ship.
//
// Until now `npm run verify` meant "verify the Node engine", and the Rust core —
// the one behind the primary download — was only tested if whoever was running
// remembered to set WINMUX_CORE=rust. That is not a hypothetical gap: the worst
// defect on the problem register (a shell you ended still looking alive) lived
// on the Rust engine through five hundred and seventy-eight green checks,
// because the green number was measured on the other engine.
//
// So the default is now both, in series, and the run fails if either does.
// `npm run verify:node` and `npm run verify:rust` are still there when you want
// one of them on purpose.
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const HERE = path.join(__dirname, '..');
const RUST = [
  path.join(HERE, '..', '..', 'core', 'rust', 'target', 'release', 'winmux-core.exe'),
  path.join(HERE, '..', '..', 'core', 'rust', 'target', 'debug', 'winmux-core.exe'),
].find((p) => fs.existsSync(p));

// --rust-only is `npm run verify:rust`: the shipped engine on its own, for when
// you are iterating on a Rust-side fix and do not want to sit through both.
const RUST_ONLY = process.argv.includes('--rust-only');
const args = process.argv.slice(2).filter((a) => a !== '--rust-only');

function run(label, env) {
  console.log('\n' + '='.repeat(70));
  console.log('  ' + label);
  console.log('='.repeat(70) + '\n');
  const r = spawnSync(process.execPath, [path.join(HERE, 'verify.cjs')].concat(args), {
    cwd: HERE, stdio: 'inherit', env: Object.assign({}, process.env, env),
  });
  return r.status === 0;
}

// Rust first: it is the engine most people are running, so a failure there is
// the one worth seeing before a twenty-minute Node run scrolls past it.
if (!RUST) {
  console.log('No Rust core built, so this run can only cover the Node engine.');
  console.log('Build it with:  cargo build --release --manifest-path core/rust/Cargo.toml');
  console.log('Refusing to call a Node-only run "verified" — that is the gap this script exists to close.\n');
  process.exit(2);
}

const rustOk = run('Rust engine — the one behind the primary download', { WINMUX_CORE: 'rust' });
if (RUST_ONLY) {
  console.log('\nRust: ' + (rustOk ? 'clean' : 'FAILED') + '   (Node engine not run — --rust-only)');
  process.exit(rustOk ? 0 : 1);
}
const nodeOk = run('Node engine — the one behind WinMux Node, and the fallback', { WINMUX_CORE: '' });

console.log('\n' + '='.repeat(70));
console.log('  Rust: ' + (rustOk ? 'clean' : 'FAILED') + '     Node: ' + (nodeOk ? 'clean' : 'FAILED'));
console.log('='.repeat(70));
process.exit(rustOk && nodeOk ? 0 : 1);

#!/usr/bin/env node
// Start WinMux from source on the engine that actually ships.
//
// `npm start` used to mean `node server.cjs` — the Node engine — while the
// primary download runs the Rust core. So the thing a developer looked at all
// day was not the thing a user got, and a Rust-only defect could survive
// indefinitely because nobody was ever pointed at it. Now the default is the
// shipped engine, `npm run start:node` is the Node one on purpose, and either
// way the terminal says out loud which engine it just started.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const HERE = path.join(__dirname, '..');
const WANT_NODE = process.argv.includes('--node') || process.env.WINMUX_CORE === 'node';
const RUST = [
  path.join(HERE, '..', '..', 'core', 'rust', 'target', 'release', 'winmux-core.exe'),
  path.join(HERE, '..', '..', 'core', 'rust', 'target', 'debug', 'winmux-core.exe'),
].find((p) => fs.existsSync(p));

function startNode(why) {
  console.log('engine: Node (server.cjs)' + (why ? ' — ' + why : ''));
  spawn(process.execPath, ['server.cjs'], { cwd: HERE, stdio: 'inherit' })
    .on('exit', (c) => process.exit(c == null ? 1 : c));
}

if (WANT_NODE) { startNode('asked for'); }
else if (!RUST) {
  startNode('no Rust core built, so this is NOT what the primary download runs.\n'
    + '        Build it with: cargo build --release --manifest-path core/rust/Cargo.toml');
} else {
  console.log('engine: Rust (' + path.basename(RUST) + ') — the one behind the primary download');
  spawn(RUST, [], {
    cwd: HERE, stdio: 'inherit',
    env: Object.assign({}, process.env, { WINMUX_PUBLIC: path.join(HERE, 'public') }),
  }).on('exit', (c) => process.exit(c == null ? 1 : c));
}

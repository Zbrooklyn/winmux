#!/usr/bin/env node
// Package THE WinMux installer — which, since v0.2.0, boots on the native Rust
// core (v2 Stage 4 cutover). Same app, same UI; the engine is winmux-core.exe
// bundled via extraResources and selected by core-rust.flag next to main.js.
// The legacy Node-engine build stays reachable as `npm run dist:node`.
// Output goes OFF the repo tree (Dropbox file locks race EPERM otherwise).
//
// Usage:  npm run dist            -> ~/winmux-build/WinMux Setup <version>.exe
//         WINMUX_DIST_OUT=D:\out npm run dist
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runBuilder } = require('./eb-retry.cjs');

const appDir = path.join(__dirname, '..');
const root = path.join(appDir, '..', '..');
const bin = path.join(root, 'core', 'rust', 'target', 'release', 'winmux-core.exe');

if (!fs.existsSync(bin)) {
  console.error('Rust core not built. Run:  cargo build --release -p winmux-core   (in core/rust)');
  process.exit(1);
}

// build:electron already ran via the npm script; drop the flag so the packaged
// app selects the Rust core at launch. Content 'rust' (no 'identity') keeps the
// PRIMARY identity — userData WinMux, instance.json — so 0.1.x installs upgrade
// in place and the winmux CLI finds the app. Only dist-rust.cjs writes 'rust
// identity' (the side-by-side WinMux Rust app).
const flag = path.join(appDir, 'dist-electron', 'core-rust.flag');
fs.writeFileSync(flag, 'rust\n');
console.log('Wrote ' + flag + ' — this build boots on the Rust core.');

const out = process.env.WINMUX_DIST_OUT || path.join(os.homedir(), 'winmux-build');
console.log('Packaging WinMux installer (Rust core) -> ' + out);

// eb-rust.config.js = the shared package.json build config + the winmux-core.exe
// extraResource. Identity stays the primary one (appId/productName/icon from the
// shared config), so existing WinMux installs upgrade in place onto the Rust core.
const r = runBuilder([
  '--win', 'nsis',
  '--config', 'scripts/eb-rust.config.js',
  '-c.directories.output=' + out,
], appDir);

if (r.status === 0) {
  const { version } = require('../package.json');
  console.log('\n✓ Installer ready: ' + path.join(out, 'WinMux Setup ' + version + '.exe'));
}
process.exit(r.status == null ? 1 : r.status);

#!/usr/bin/env node
// Package a WinMux installer that boots on the native RUST core instead of Node.
// Same app, same UI — only the engine differs. This is a proof build: the normal
// `npm run dist` still ships Node. The only differences here are (1) a
// core-rust.flag dropped next to main.js so the app selects the Rust core at
// launch, and (2) the release winmux-core.exe bundled via extraResources
// (already declared in package.json build config).
//
// Usage:  npm run dist:rust        -> ~/winmux-build/WinMux Setup <version>.exe
const { spawnSync } = require('child_process');
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

// Compile the Electron TS, then drop the flag so the packaged app picks Rust.
const build = spawnSync('npm', ['run', 'build:electron'], { stdio: 'inherit', shell: true, cwd: appDir });
if (build.status !== 0) process.exit(build.status || 1);

// 'rust identity' = Rust engine AND the distinct "WinMux Rust" identity
// (userData/instance/trust files). The primary installer writes just 'rust'.
const flag = path.join(appDir, 'dist-electron', 'core-rust.flag');
fs.writeFileSync(flag, 'rust identity\n');
console.log('Wrote ' + flag + ' — Rust core + distinct WinMux Rust identity.');

const out = process.env.WINMUX_DIST_OUT || path.join(os.homedir(), 'winmux-build');
// No spaces: electron-builder receives this as one CLI arg through the shell.
const artifact = process.env.WINMUX_RUST_ARTIFACT || 'WinMux-Rust-Setup-${version}.${ext}';
console.log('Packaging Rust-core WinMux installer -> ' + out);

// Distinct identity so the Rust installer is a separate app from Node WinMux:
// its own appId + productName (drives the Start-menu shortcut / install dir /
// uninstall entry) + its own rust-orange icon. productName is quoted because it
// contains a space and these args pass through the shell.
//
// The Rust binary is bundled via --config (scripts/eb-rust.config.js), NOT
// package.json's static build config, so only this build ships it — the Node
// installer (`npm run dist`) stays free of an engine it can't boot. That config
// is the shared build config + extraResources; the scalar -c flags below still
// layer on top of it. The Rust core reads public/ off disk, so its unpack
// already comes from the shared asarUnpack in package.json.
const r = runBuilder([
  '--win', 'nsis',
  '--config', 'scripts/eb-rust.config.js',
  '-c.directories.output=' + out,
  '-c.nsis.artifactName=' + artifact,
  '-c.appId=com.zbrooklyn.winmux.rust',
  '-c.productName="WinMux Rust"',
  '-c.win.icon=build/icon-rust.ico',
], appDir);

if (r.status === 0) {
  const { version } = require('../package.json');
  console.log('\n✓ Rust-core installer ready in ' + out + ' (WinMux-Rust Setup ' + version + '.exe)');
}
process.exit(r.status == null ? 1 : r.status);

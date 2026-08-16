#!/usr/bin/env node
// LEGACY: package the Node-engine WinMux installer. Since v0.2.0 the primary
// `npm run dist` ships the Rust core (Stage 4 cutover); this script keeps the
// Node build reachable as an explicit fallback while the Rust engine is young.
// Output goes OFF the repo tree (Dropbox file locks race EPERM otherwise).
//
// Usage:  npm run dist:node        -> ~/winmux-build/WinMux Setup <version>.exe
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runBuilder } = require('./eb-retry.cjs');

// A prior Rust build leaves core-rust.flag in dist-electron; strip it so the
// Node installer never accidentally ships selecting the Rust core.
const staleFlag = path.join(__dirname, '..', 'dist-electron', 'core-rust.flag');
if (fs.existsSync(staleFlag)) { fs.unlinkSync(staleFlag); console.log('Removed stale core-rust.flag (Node build).'); }

const out = process.env.WINMUX_DIST_OUT || path.join(os.homedir(), 'winmux-build');
console.log('Packaging Node-engine WinMux installer -> ' + out);

const r = runBuilder(['--win', 'nsis', '-c.directories.output=' + out], path.join(__dirname, '..'));

if (r.status === 0) {
  const { version } = require('../package.json');
  console.log('\n✓ Installer ready: ' + path.join(out, 'WinMux Setup ' + version + '.exe'));
}
process.exit(r.status == null ? 1 : r.status);

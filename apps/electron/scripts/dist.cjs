#!/usr/bin/env node
// Package a WinMux installer with electron-builder, writing the output OFF the
// repo tree. On a Dropbox-synced checkout, packaging into the repo (the default
// dist-installer/) races Dropbox's file locks and fails with EPERM, so we send
// the artifacts to <home>/winmux-build by default. Override with WINMUX_DIST_OUT.
//
// Usage:  npm run dist            -> ~/winmux-build/WinMux Setup <version>.exe
//         WINMUX_DIST_OUT=D:\out npm run dist
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runBuilder } = require('./eb-retry.cjs');

// A prior `npm run dist:rust` leaves core-rust.flag in dist-electron; strip it so
// the Node installer never accidentally ships selecting the Rust core.
const staleFlag = path.join(__dirname, '..', 'dist-electron', 'core-rust.flag');
if (fs.existsSync(staleFlag)) { fs.unlinkSync(staleFlag); console.log('Removed stale core-rust.flag (Node build).'); }

const out = process.env.WINMUX_DIST_OUT || path.join(os.homedir(), 'winmux-build');
console.log('Packaging WinMux installer -> ' + out);

const r = runBuilder(['--win', 'nsis', '-c.directories.output=' + out], path.join(__dirname, '..'));

if (r.status === 0) {
  const { version } = require('../package.json');
  console.log('\n✓ Installer ready: ' + path.join(out, 'WinMux Setup ' + version + '.exe'));
}
process.exit(r.status == null ? 1 : r.status);

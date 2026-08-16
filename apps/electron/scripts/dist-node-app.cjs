#!/usr/bin/env node
// Package the side-by-side "WinMux Node" installer — the legacy Node engine as
// a FOURTH coexisting app (own identity, own discovery/trust files), never a
// replacement for the primary. Contrast with dist-node.cjs, which builds the
// Node engine UNDER the primary identity as a disaster fallback.
//
// Usage:  npm run dist:node-app   -> ~/winmux-build/WinMux-Node-Setup-<version>.exe
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runBuilder } = require('./eb-retry.cjs');

const appDir = path.join(__dirname, '..');
const dist = path.join(appDir, 'dist-electron');

// This build must boot the Node engine under the WinMux Node identity: strip
// any stale core-rust.flag, then drop identity-node.flag (read by main.ts).
const staleFlag = path.join(dist, 'core-rust.flag');
if (fs.existsSync(staleFlag)) { fs.unlinkSync(staleFlag); console.log('Removed stale core-rust.flag (Node-app build).'); }
fs.writeFileSync(path.join(dist, 'identity-node.flag'), 'node\n');
console.log('Wrote identity-node.flag — side-by-side WinMux Node identity.');

const out = process.env.WINMUX_DIST_OUT || path.join(os.homedir(), 'winmux-build');
// No spaces: electron-builder receives this as one CLI arg through the shell.
const artifact = 'WinMux-Node-Setup-${version}.${ext}';
console.log('Packaging WinMux Node installer -> ' + out);

// Distinct identity so it installs beside the other three (same pattern as
// dist-rust.cjs). Shared package.json build config; no Rust exe bundled.
const r = runBuilder([
  '--win', 'nsis',
  '-c.directories.output=' + out,
  '-c.nsis.artifactName=' + artifact,
  '-c.appId=com.zbrooklyn.winmux.node',
  '-c.productName="WinMux Node"',
], appDir);

// Never leave the identity flag behind for the next (primary) build.
try { fs.unlinkSync(path.join(dist, 'identity-node.flag')); } catch (e) {}

if (r.status === 0) {
  const { version } = require('../package.json');
  console.log('\n✓ Installer ready: ' + path.join(out, 'WinMux-Node-Setup-' + version + '.exe'));
}
process.exit(r.status == null ? 1 : r.status);

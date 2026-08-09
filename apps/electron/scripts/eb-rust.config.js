// electron-builder config for the RUST-core installer.
//
// It is the shared package.json "build" config PLUS the one thing only the Rust
// build needs: the native winmux-core.exe bundled as an extra resource. Keeping
// it here (not in package.json) means `npm run dist` (Node) never ships an engine
// it can't boot. dist-rust.cjs passes this via `--config`, and its scalar `-c`
// flags (appId, productName, icon, artifactName, output) still layer on top.
//
// extraResources.from resolves relative to the app root (this file's ../), same
// as package.json would — so the path matches the original static declaration.
const build = require('../package.json').build;

module.exports = {
  ...build,
  extraResources: [
    { from: '../../core/rust/target/release/winmux-core.exe', to: 'winmux-core.exe' },
  ],
};

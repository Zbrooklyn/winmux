// Copy the built Rust engine next to the plugin. Source of truth stays core/rust.
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
const src = resolve('../../core/rust/target/release/winmux-core.exe');
mkdirSync('binaries', { recursive: true });
copyFileSync(src, 'binaries/winmux-core.exe');
console.log('bundled engine', statSync(src).size, 'bytes');

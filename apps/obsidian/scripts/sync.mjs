// Copy the built plugin into one or more vaults for live testing.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const vaults = process.argv.slice(2);
if (!vaults.length) { console.error('usage: node scripts/sync.mjs <vault-path>...'); process.exit(1); }
for (const v of vaults) {
  const dst = join(v, '.obsidian', 'plugins', 'winmux');
  mkdirSync(join(dst, 'binaries'), { recursive: true });
  for (const f of ['main.js', 'manifest.json', 'styles.css']) copyFileSync(f, join(dst, f));
  if (existsSync('binaries/winmux-core.exe')) { try { copyFileSync('binaries/winmux-core.exe', join(dst, 'binaries', 'winmux-core.exe')); } catch (e) { console.warn('  engine exe in use, kept existing copy (' + e.code + ')'); } }
  console.log('synced ->', dst);
}

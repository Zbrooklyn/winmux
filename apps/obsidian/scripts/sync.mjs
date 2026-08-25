// Copy the built plugin into one or more vaults for live testing.
import { copyFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const vaults = process.argv.slice(2);
if (!vaults.length) { console.error('usage: node scripts/sync.mjs <vault-path>...'); process.exit(1); }
for (const v of vaults) {
  const dst = join(v, '.obsidian', 'plugins', 'winmux');
  mkdirSync(join(dst, 'binaries'), { recursive: true });
  for (const f of ['main.js', 'manifest.json', 'styles.css']) copyFileSync(f, join(dst, f));
  if (existsSync('binaries/winmux-core.exe')) { try { copyFileSync('binaries/winmux-core.exe', join(dst, 'binaries', 'winmux-core.exe')); } catch (e) { console.warn('  engine exe in use, kept existing copy (' + e.code + ')'); } }
  if (existsSync('binaries/winmux-tray.exe')) { try { copyFileSync('binaries/winmux-tray.exe', join(dst, 'binaries', 'winmux-tray.exe')); } catch (e) { console.warn('  tray exe in use, kept existing copy'); } }
  if (existsSync('tools')) { mkdirSync(join(dst, 'tools'), { recursive: true }); for (const f of readdirSync('tools')) copyFileSync(join('tools', f), join(dst, 'tools', f)); }
  console.log('synced ->', dst);
}

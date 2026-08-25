// Build a BRAT-installable release: release/winmux-obsidian-<version>.zip
// containing main.js, manifest.json, styles.css, binaries/winmux-core.exe, tools/*.
import { mkdirSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
const ver = JSON.parse(readFileSync('manifest.json', 'utf8')).version;
for (const f of ['main.js', 'manifest.json', 'styles.css', 'binaries/winmux-core.exe', 'tools/winmux.cjs']) if (!existsSync(f)) { console.error('missing', f, '— run build / bundle-engine / bundle-tools first'); process.exit(1); }
// Output lives OUTSIDE Dropbox: Dropbox evicts untracked files under the repo (release/ is gitignored).
const OUT = process.env.WINMUX_RELEASE_DIR || join(process.env.LOCALAPPDATA || process.env.HOME, 'winmux', 'releases');
mkdirSync(OUT, { recursive: true });
const stage = resolve(OUT, 'winmux');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of ['main.js', 'manifest.json', 'styles.css']) cpSync(f, join(stage, f));
cpSync('binaries', join(stage, 'binaries'), { recursive: true });
cpSync('tools', join(stage, 'tools'), { recursive: true });
const zip = resolve(OUT, `winmux-obsidian-${ver}.zip`);
rmSync(zip, { force: true });
execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path "${stage}\\*" -DestinationPath "${zip}" -Force`], { stdio: 'inherit' });
console.log('release ->', zip);

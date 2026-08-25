// Compile the tray helper with the csc that ships in every Windows (.NET Framework 4.x). No SDK needed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const csc = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe';
if (!existsSync(csc)) { console.error('csc.exe not found'); process.exit(1); }
mkdirSync('binaries', { recursive: true });
const src = resolve('tray', 'WinMuxTray.cs');
const out = resolve('binaries', 'winmux-tray.exe');
execFileSync(csc, ['-nologo', '-target:winexe', '-optimize+', '-out:' + out, '-r:System.Windows.Forms.dll', '-r:System.Drawing.dll', src], { stdio: 'inherit' });
console.log('built', out);

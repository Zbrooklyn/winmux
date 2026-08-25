import esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
const watch = process.argv.includes('--watch');
const xtermCss = readFileSync('node_modules/@xterm/xterm/css/xterm.css', 'utf8');
const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  outfile: 'main.js',
  external: ['obsidian', 'electron', ...['fs','path','os','child_process','net','http','crypto','events','util','stream','url'].flatMap(m => [m, 'node:' + m])],
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
  define: { __XTERM_CSS__: JSON.stringify(xtermCss) },
});
if (watch) await ctx.watch(); else { await ctx.rebuild(); await ctx.dispose(); }

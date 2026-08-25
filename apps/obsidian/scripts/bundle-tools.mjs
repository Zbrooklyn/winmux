// Copy the app's CLI / MCP server / skill / hooks next to the plugin so the installer can ship them.
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const E = resolve('../electron');
mkdirSync('tools', { recursive: true });
for (const [src, dst] of [
  ['bin/winmux.cjs', 'winmux.cjs'], ['bin/winmux-mcp.cjs', 'winmux-mcp.cjs'],
  ['skills/winmux-orchestrate/SKILL.md', 'SKILL.md'], ['agent/claude-code-hooks.json', 'claude-code-hooks.json'],
  ['config/claude-hooks-worker.json', 'claude-hooks-worker.json'],
]) { try { copyFileSync(resolve(E, src), resolve('tools', dst)); console.log('tools/' + dst); } catch (e) { console.warn('skip', src, e.code); } }

// "Install WinMux tools": puts the `winmux` CLI, the MCP server and the orchestrate
// skill on this machine so agents work with no WinMux app installed.
// Bins are the app's own files (Node builtins only), copied verbatim from <plugin>/tools.
import { Notice } from 'obsidian';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type WinMuxPlugin from './main';

export const BIN_DIR = join(homedir(), '.winmux', 'bin');
const SKILL_DIR = join(homedir(), '.claude', 'skills', 'winmux-orchestrate');
const CLAUDE_JSON = join(homedir(), '.claude.json');
const SETTINGS_JSON = join(homedir(), '.claude', 'settings.json');

function nodeOnPath(): string | null {
  try { return execFileSync('where.exe', ['node'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim() || null; } catch { return null; }
}

/** The runtime that runs the .cjs files: node if present, else Obsidian's own Electron as Node. */
export function runtime(): { exe: string; electron: boolean } {
  const n = nodeOnPath();
  return n ? { exe: n, electron: false } : { exe: process.execPath, electron: true };
}

export function toolsInstalled(): boolean {
  return existsSync(join(BIN_DIR, 'winmux.cjs')) && existsSync(join(BIN_DIR, 'winmux.cmd')) && existsSync(join(BIN_DIR, 'winmux-mcp.cjs'));
}

export function installTools(plugin: WinMuxPlugin): string[] {
  const src = join(plugin.pluginDir(), 'tools');
  const done: string[] = [];
  mkdirSync(BIN_DIR, { recursive: true });
  for (const f of ['winmux.cjs', 'winmux-mcp.cjs']) copyFileSync(join(src, f), join(BIN_DIR, f));
  const rt = runtime();
  // Shims: prefer the engine-provided WINMUX_EXE (inside WinMux shells), else the runtime found at install time.
  const shim = (cjs: string) => [
    '@echo off', 'setlocal',
    'if defined WINMUX_EXE goto :run',
    `set "WINMUX_EXE=${rt.exe}"`,
    ':run',
    rt.electron || true ? 'set ELECTRON_RUN_AS_NODE=1' : '',
    `"%WINMUX_EXE%" "%~dp0${cjs}" %*`, ''].join('\r\n');
  writeFileSync(join(BIN_DIR, 'winmux.cmd'), shim('winmux.cjs'));
  writeFileSync(join(BIN_DIR, 'winmux-mcp.cmd'), shim('winmux-mcp.cjs'));
  done.push('CLI + MCP server → ' + BIN_DIR);

  // User PATH (reversible; uninstall removes the entry).
  try {
    const cur = execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','User')"], { encoding: 'utf8', windowsHide: true }).trim();
    if (!cur.split(';').some(p => p.trim().toLowerCase() === BIN_DIR.toLowerCase())) {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', `[Environment]::SetEnvironmentVariable('Path', ([Environment]::GetEnvironmentVariable('Path','User').TrimEnd(';') + ';${BIN_DIR}'), 'User')`], { windowsHide: true });
      done.push('added to your PATH (new terminals pick it up)');
    }
  } catch (e: any) { done.push('PATH not changed: ' + e.message); }

  // Skill, with the Dropbox-hard-coded fallback replaced by the installed CLI.
  try {
    let skill = readFileSync(join(src, 'SKILL.md'), 'utf8');
    skill = skill.replace(/node "C:\/Users\/[^"]*winmux\.cjs"/g, 'winmux').replace(/C:\\Users\\[^\s"]*winmux\.cjs/g, join(BIN_DIR, 'winmux.cjs'));
    mkdirSync(SKILL_DIR, { recursive: true });
    writeFileSync(join(SKILL_DIR, 'SKILL.md'), skill);
    done.push('orchestrate skill → ' + SKILL_DIR);
  } catch (e: any) { done.push('skill not installed: ' + e.message); }
  return done;
}

export function uninstallTools(): string[] {
  const done: string[] = [];
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `$p=[Environment]::GetEnvironmentVariable('Path','User'); $n=($p -split ';' | Where-Object { $_ -and $_.ToLower() -ne '${BIN_DIR.toLowerCase()}' }) -join ';'; [Environment]::SetEnvironmentVariable('Path',$n,'User')`], { windowsHide: true });
    done.push('removed from PATH');
  } catch (e: any) { done.push('PATH: ' + e.message); }
  done.push('files left in ' + BIN_DIR + ' (delete the folder to remove)');
  return done;
}

export function mcpRegistered(): boolean {
  try { const j = JSON.parse(readFileSync(CLAUDE_JSON, 'utf8')); return !!(j.mcpServers && j.mcpServers.winmux); } catch { return false; }
}

/** Register the MCP server with Claude Code (user scope, ~/.claude.json). Reversible: unregister() removes the key. */
export function registerMcp(): string {
  const rt = runtime();
  const j = existsSync(CLAUDE_JSON) ? JSON.parse(readFileSync(CLAUDE_JSON, 'utf8')) : {};
  j.mcpServers = j.mcpServers || {};
  j.mcpServers.winmux = rt.electron
    ? { command: rt.exe, args: [join(BIN_DIR, 'winmux-mcp.cjs')], env: { ELECTRON_RUN_AS_NODE: '1' } }
    : { command: rt.exe, args: [join(BIN_DIR, 'winmux-mcp.cjs')] };
  writeFileSync(CLAUDE_JSON, JSON.stringify(j, null, 2));
  return 'winmux MCP server registered for Claude Code (restart Claude sessions to pick it up)';
}
export function unregisterMcp(): string {
  try { const j = JSON.parse(readFileSync(CLAUDE_JSON, 'utf8')); if (j.mcpServers) delete j.mcpServers.winmux; writeFileSync(CLAUDE_JSON, JSON.stringify(j, null, 2)); } catch { /* nothing */ }
  return 'winmux MCP server removed';
}

export function hooksInstalled(): boolean {
  try { const j = JSON.parse(readFileSync(SETTINGS_JSON, 'utf8')); return JSON.stringify(j.hooks || {}).includes('winmux agent'); } catch { return false; }
}

/** Merge WinMux's Claude Code hooks (working / needs-you / done) into ~/.claude/settings.json without touching other hooks. */
export function installHooks(plugin: WinMuxPlugin): string {
  const src = JSON.parse(readFileSync(join(plugin.pluginDir(), 'tools', 'claude-code-hooks.json'), 'utf8'));
  const j = existsSync(SETTINGS_JSON) ? JSON.parse(readFileSync(SETTINGS_JSON, 'utf8')) : {};
  j.hooks = j.hooks || {};
  for (const [event, groups] of Object.entries<any>(src.hooks || {})) {
    j.hooks[event] = (j.hooks[event] || []).filter((g: any) => !JSON.stringify(g).includes('winmux agent'));
    j.hooks[event].push(...groups);
  }
  writeFileSync(SETTINGS_JSON, JSON.stringify(j, null, 2));
  return 'Claude Code hooks installed (tabs show working / needs you / done automatically)';
}
export function uninstallHooks(): string {
  try {
    const j = JSON.parse(readFileSync(SETTINGS_JSON, 'utf8'));
    for (const k of Object.keys(j.hooks || {})) { j.hooks[k] = j.hooks[k].filter((g: any) => !JSON.stringify(g).includes('winmux agent')); if (!j.hooks[k].length) delete j.hooks[k]; }
    writeFileSync(SETTINGS_JSON, JSON.stringify(j, null, 2));
  } catch { /* nothing */ }
  return 'WinMux hooks removed';
}

export function notifyList(lines: string[]) { new Notice(lines.join('\n'), 8000); }

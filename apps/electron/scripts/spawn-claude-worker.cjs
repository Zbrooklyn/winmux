#!/usr/bin/env node
// Spawn a worker Claude Code session in a new WinMux tab, registered as a job.
// Used by the winmux-orchestrate skill. Prints ONLY the jobId on success.
//
//   node spawn-claude-worker.cjs --task "<text>" [--name "<label>"] [--cwd <dir>]
//
// The worker is launched with WinMux's Claude hooks (working/needs-you/done lanes)
// and its task is extended with reporting instructions: write the final answer to a
// temp result file, then mark the job done via `winmux agent done --result-file`.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, '..', 'bin', 'winmux.cjs');
const HOOKS = path.join(__dirname, '..', 'config', 'claude-hooks.json');

function cli(args, t) { return spawnSync(process.execPath, [CLI].concat(args), { encoding: 'utf8', env: process.env, timeout: t || 30000 }); }
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";

const argv = process.argv.slice(2);
let task = '', name = '', cwd = process.cwd();
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--task') task = argv[++i] || '';
  else if (argv[i] === '--name') name = argv[++i] || '';
  else if (argv[i] === '--cwd') cwd = argv[++i] || cwd;
}
task = String(task).replace(/[\r\n]+/g, ' ').trim();
if (!task) { console.error('usage: spawn-claude-worker.cjs --task "<text>" [--name "<label>"] [--cwd <dir>]'); process.exit(1); }
if (!name) name = task.slice(0, 40);

const nt = cli(['new-tab', '--json']);
let id; try { id = JSON.parse(nt.stdout).id; } catch (e) { console.error('new-tab failed: ' + ((nt.stderr || nt.stdout) || '').trim()); process.exit(1); }
const reg = cli(['agent', 'register', '--sid', String(id), '--name', name, '--json']);
let jobId; try { jobId = JSON.parse(reg.stdout).job.jobId; } catch (e) { console.error('register failed: ' + ((reg.stderr || reg.stdout) || '').trim()); process.exit(1); }

const rf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'winmux-job-')), 'result.md').replace(/\\/g, '/');
const fullTask = task +
  ' When you are completely done: 1) write your full final answer to the file ' + rf +
  ' using the Write tool, 2) then run this exact Bash command: node "' + CLI.replace(/\\/g, '/') + '" agent done --job ' + jobId + ' --result-file "' + rf + '"';

const launch = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Set-Location -LiteralPath ' + psq(cwd) + '; ' +
  'claude --settings ' + psq(HOOKS) + ' --dangerously-skip-permissions ' + psq(fullTask);
cli(['send', launch, '--enter', '--id', String(id)]);
console.log(jobId);

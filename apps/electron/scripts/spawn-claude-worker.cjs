#!/usr/bin/env node
// Spawn a worker Claude Code session in a new WinMux tab or split pane, registered
// as a job. Used by the winmux-orchestrate skill. Prints ONLY the jobId on success.
//
//   node spawn-claude-worker.cjs --task "<text>" [--name "<label>"] [--cwd <dir>] [--split right|down]
//
// --split opens the worker in a split pane of the current tab (visible alongside the
// caller) instead of a new tab. The worker is launched with WinMux's Claude hooks
// (working/needs-you/done lanes) and its task is extended with reporting
// instructions: write the final answer to a temp result file, then mark the job
// done via `winmux agent done --result-file`.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, '..', 'bin', 'winmux.cjs');
const HOOKS = path.join(__dirname, '..', 'config', 'claude-hooks.json');

function cli(args, t) { return spawnSync(process.execPath, [CLI].concat(args), { encoding: 'utf8', env: process.env, timeout: t || 30000 }); }
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
let task = '', name = '', cwd = process.cwd(), splitDir = '';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--task') task = argv[++i] || '';
  else if (argv[i] === '--name') name = argv[++i] || '';
  else if (argv[i] === '--cwd') cwd = argv[++i] || cwd;
  else if (argv[i] === '--split') splitDir = (argv[++i] === 'down') ? 'down' : 'right';
}
task = String(task).replace(/[\r\n]+/g, ' ').trim();
if (!task) { console.error('usage: spawn-claude-worker.cjs --task "<text>" [--name "<label>"] [--cwd <dir>] [--split right|down]'); process.exit(1); }
if (!name) name = task.slice(0, 40);

function sessionIds() { try { return JSON.parse(cli(['list', '--json']).stdout).sessions.map((s) => s.id); } catch (e) { return null; } }

(async () => {
  let id = null;
  if (splitDir) {
    const before = new Set(sessionIds() || []);
    cli(['split', splitDir]);
    for (let i = 0; i < 20 && id == null; i++) {
      await sleep(500);
      const now = sessionIds() || [];
      const fresh = now.filter((x) => !before.has(x));
      if (fresh.length) id = fresh[fresh.length - 1];
    }
    if (id == null) { console.error('split produced no new terminal'); process.exit(1); }
  } else {
    const nt = cli(['new-tab', '--json']);
    try { id = JSON.parse(nt.stdout).id; } catch (e) { console.error('new-tab failed: ' + ((nt.stderr || nt.stdout) || '').trim()); process.exit(1); }
  }

  const reg = cli(['agent', 'register', '--sid', String(id), '--name', name, '--json']);
  let jobId; try { jobId = JSON.parse(reg.stdout).job.jobId; } catch (e) { console.error('register failed: ' + ((reg.stderr || reg.stdout) || '').trim()); process.exit(1); }

  const rf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'winmux-job-')), 'result.md').replace(/\\/g, '/');
  const fullTask = task +
    ' When you are completely done: 1) write your full final answer to the file ' + rf +
    ' using the Write tool, 2) then run this exact Bash command: node "' + CLI.replace(/\\/g, '/') + '" agent done --job ' + jobId + ' --result-file "' + rf + '"';

  // A fresh split shell spawns cold: wait until the terminal is connected and the
  // PowerShell prompt is up before sending the launch command, then verify the send.
  let shellUp = false;
  for (let i = 0; i < 40 && !shellUp; i++) {
    const sc = cli(['read-screen', '--id', String(id), '--lines', '20']);
    if (sc.status === 0 && /PS [A-Z]:.*>/.test(sc.stdout || '')) { shellUp = true; break; }
    await sleep(750);
  }
  if (!shellUp) { console.error('worker shell never became ready'); process.exit(1); }

  const launch = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Set-Location -LiteralPath ' + psq(cwd) + '; ' +
    'claude --settings ' + psq(HOOKS) + ' --dangerously-skip-permissions ' + psq(fullTask);
  let sent = false;
  for (let i = 0; i < 5 && !sent; i++) {
    const r = cli(['send', launch, '--enter', '--id', String(id)]);
    if (r.status === 0 && !/not connected|error/i.test((r.stderr || '') + (r.stdout || ''))) { sent = true; break; }
    await sleep(1000);
  }
  if (!sent) { console.error('send to worker terminal failed'); process.exit(1); }
  console.log(jobId);
})().catch((e) => { console.error(e && e.message || e); process.exit(1); });

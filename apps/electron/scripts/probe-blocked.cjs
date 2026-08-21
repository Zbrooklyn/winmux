// Does the harness tell the truth about WHOSE fault a red is?
//
//   node scripts/probe-blocked.cjs
//
// Not a verify.cjs check, for the same reason probe-threads.cjs isn't: it runs
// verify.cjs, and a check that runs the suite it lives in is a recursion nobody
// wants to debug at 2am. Run it by hand after touching the harness's reporting.
//
// WHY THIS EXISTS. On 2026-08-20 a full both-engine run reported:
//
//     1 of 594 checks FAILED
//     FAIL  port  (:9912)
//       FAIL  the check itself threw
//
// The product was fine. A leaked server from an earlier run was sitting on
// 9912, and the harness — which had ALREADY printed "heads up — these ports are
// already in use" and named the holding pid — went on to file it as a product
// failure anyway. That is the worst kind of red: correct diagnosis, wrong
// verdict. Reds that mean "tidy your machine" are how you learn to skim reds.
//
// So a held port is now BLOCKED: not a pass, not a product failure, and still a
// non-zero exit, because the check did not run and nobody may call the run
// green. This probe holds a port and proves all four of those at once.

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 9912;           // the port the `port` check wants — the real case
const CHECK = 'port';

const fail = (why) => { console.log('FAILED — ' + why); process.exitCode = 1; };

(async () => {
  const squatter = await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(PORT, '127.0.0.1', () => resolve(s));
  }).catch(() => null);

  if (!squatter) {
    // Refuse to grade anything rather than quietly pass — the same discipline
    // this probe exists to enforce.
    return fail('could not take :' + PORT + ' to run the test; something is already on it');
  }
  console.log('holding 127.0.0.1:' + PORT + ' so `' + CHECK + '` has a dirty machine to react to');

  const run = await new Promise((resolve) => {
    const proc = spawn(process.execPath, ['verify.cjs', CHECK], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('exit', (code) => resolve({ code, out }));
    setTimeout(() => { try { proc.kill(); } catch (e) {} resolve({ code: null, out }); }, 120000);
  });

  squatter.close();

  const t = (name, pass, note) => {
    console.log('  ' + (pass ? 'PASS  ' : 'FAIL  ') + name + (note === undefined ? '' : '\n          ' + note));
    if (!pass) process.exitCode = 1;
  };

  t('the run says BLOCKED, and says it about the check that wanted this port',
    new RegExp('BLOCKED\\s+' + CHECK).test(run.out),
    run.out.split('\n').find((l) => /BLOCKED/.test(l)));
  t('it names the process holding the port, so it can be closed',
    /pid \d+/.test(run.out), run.out.split('\n').find((l) => /pid \d+/.test(l)));
  t('it never calls this a product failure',
    !/checks FAILED/.test(run.out) && !/the check itself threw/.test(run.out),
    run.out.split('\n').find((l) => /FAILED|itself threw/.test(l)) || '(no failure language — correct)');
  t('it says out loud that this is the machine, not the product',
    /not the product/.test(run.out), run.out.split('\n').find((l) => /not the product/.test(l)));
  t('and it still exits non-zero, so nothing downstream reads it as green',
    run.code === 1, 'exit ' + run.code);

  if (!process.exitCode) console.log('\nthe harness blames the right thing.');
})();

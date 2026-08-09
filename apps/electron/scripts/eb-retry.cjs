// Run electron-builder, retrying the transient Windows DLL-init crash
// (exit 3221225794 = 0xC0000142 = STATUS_DLL_INIT_FAILED) that intermittently
// kills its node-module collector helper under automation. The crash is
// nondeterministic — seen this session dying on one attempt and succeeding on the
// next with no change. A real error (bad arg, genuine build failure) has a
// different, non-null status and is returned immediately without retrying.
const { spawnSync } = require('child_process');
const DLL_INIT_CRASH = 3221225794;

function runBuilder(args, cwd, attempts = 3) {
  let r;
  for (let i = 1; i <= attempts; i++) {
    r = spawnSync('npx', ['electron-builder', ...args], { stdio: 'inherit', shell: true, cwd });
    if (r.status === 0) return r;
    // Only the transient DLL-init crash (or a null/killed status) is worth retrying.
    if (r.status != null && r.status !== DLL_INIT_CRASH) return r;
    if (i < attempts) console.log(`\nelectron-builder crashed (0xC0000142, transient) — retry ${i + 1}/${attempts}...`);
  }
  return r;
}

module.exports = { runBuilder };

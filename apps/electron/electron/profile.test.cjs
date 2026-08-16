const assert = require('assert');
const path = require('path');
// Compiled output lands in dist-electron/profile.js; test the compiled JS.
const { resolveProfile, parseCoreFlag } = require('../dist-electron/profile.js');

const appData = 'C:\\Users\\E\\AppData\\Roaming';
const home = 'C:\\Users\\E';

const prod = resolveProfile({ isPackaged: true, appData, home });
const dev = resolveProfile({ isPackaged: false, appData, home });

// Identity is distinct across the two copies.
assert.notStrictEqual(prod.appId, dev.appId, 'appId must differ');
assert.notStrictEqual(prod.userData, dev.userData, 'userData must differ');
assert.notStrictEqual(prod.instanceFile, dev.instanceFile, 'instanceFile must differ');
assert.notStrictEqual(prod.trustFile, dev.trustFile, 'trustFile must differ');

// Neither userData nests inside the other (a child dir would share the parent's
// SingletonLock). Separator-aware: sibling names sharing a prefix (WinMux vs
// WinMuxDev) are fine; only a real subdirectory (parent + sep + …) is a problem.
const sep = path.sep;
assert.ok(
  prod.userData !== dev.userData &&
  !prod.userData.startsWith(dev.userData + sep) &&
  !dev.userData.startsWith(prod.userData + sep),
  'userData dirs must not nest');

// Concrete production values are stable (users find their data here).
assert.strictEqual(prod.appId, 'com.zbrooklyn.winmux');
assert.strictEqual(prod.name, 'WinMux');
assert.strictEqual(prod.userData, path.join(appData, 'WinMux'));
assert.strictEqual(prod.instanceFile, path.join(home, '.winmux', 'instance.json'));
assert.strictEqual(dev.instanceFile, path.join(home, '.winmux', 'instance.dev.json'));

// core-rust.flag decoupling: engine choice and identity are independent bits.
// THE regression behind v0.2.1 — the primary installer ships the Rust engine
// ('rust') but must KEEP the primary identity, or upgrades lose userData and
// the CLI can't find the app at instance.json.
assert.deepStrictEqual(parseCoreFlag(null), { rustCore: false, rustIdentity: false }, 'no flag = Node build');
assert.deepStrictEqual(parseCoreFlag('rust\n'), { rustCore: true, rustIdentity: false }, "primary 'rust' flag = engine only");
assert.deepStrictEqual(parseCoreFlag('rust identity\n'), { rustCore: true, rustIdentity: true }, "'rust identity' = engine + side identity");

const rustPrimary = resolveProfile({ isPackaged: true, appData, home, rust: parseCoreFlag('rust\n').rustIdentity });
assert.strictEqual(rustPrimary.appId, 'com.zbrooklyn.winmux', 'Rust-engine primary build keeps primary appId');
assert.strictEqual(rustPrimary.userData, path.join(appData, 'WinMux'), 'Rust-engine primary build keeps primary userData');
assert.strictEqual(rustPrimary.instanceFile, path.join(home, '.winmux', 'instance.json'), 'Rust-engine primary build keeps instance.json');

const rustSide = resolveProfile({ isPackaged: true, appData, home, rust: parseCoreFlag('rust identity\n').rustIdentity });
assert.strictEqual(rustSide.appId, 'com.zbrooklyn.winmux.rust');
assert.strictEqual(rustSide.instanceFile, path.join(home, '.winmux', 'instance.rust.json'));

// The side-by-side "WinMux Node" identity (identity-node.flag): the legacy
// engine as a fourth coexisting app, fully disjoint from the other three.
const nodeSide = resolveProfile({ isPackaged: true, appData, home, nodeApp: true });
assert.strictEqual(nodeSide.appId, 'com.zbrooklyn.winmux.node');
assert.strictEqual(nodeSide.name, 'WinMux Node');
assert.strictEqual(nodeSide.userData, path.join(appData, 'WinMuxNode'));
assert.strictEqual(nodeSide.instanceFile, path.join(home, '.winmux', 'instance.node.json'));
assert.strictEqual(nodeSide.trustFile, path.join(home, '.winmux', 'devices.node.json'));
const all = [prod, rustPrimary, rustSide, nodeSide, dev];
const uniq = (k) => new Set(all.map((p) => p[k])).size;
assert.strictEqual(uniq('instanceFile'), 4, 'primary+rustPrimary share; rust/node/dev disjoint');
assert.strictEqual(uniq('userData'), 4, 'userData disjoint across identities');

console.log('profile.test OK');

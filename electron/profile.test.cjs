const assert = require('assert');
const path = require('path');
// Compiled output lands in dist-electron/profile.js; test the compiled JS.
const { resolveProfile } = require('../dist-electron/profile.js');

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

console.log('profile.test OK');

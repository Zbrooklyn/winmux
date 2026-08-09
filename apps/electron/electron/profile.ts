import * as path from 'path';

export interface ProfileOpts {
  isPackaged: boolean;
  appData: string; // app.getPath('appData'), e.g. %APPDATA%
  home: string;    // os.homedir()
  rust?: boolean;  // the Rust-core build (packaged) — its own identity
}

export interface Profile {
  appId: string;
  name: string;
  userData: string;
  instanceFile: string;
  trustFile: string;
}

// One computation of a copy's identity. The three copies — the from-source dev
// copy, the packaged Node build, and the packaged Rust build — get disjoint
// values so none share Electron's userData (and its ProcessSingleton lock), the
// CLI discovery file, or the trusted-devices file. That is what lets the Node
// and Rust installers sit on the same machine and run at once without the Rust
// app reattaching to the Node app's server (Phase 12 coexistence contract).
export function resolveProfile(opts: ProfileOpts): Profile {
  const variant: 'dev' | 'node' | 'rust' =
    !opts.isPackaged ? 'dev' : opts.rust ? 'rust' : 'node';
  const winmuxDir = path.join(opts.home, '.winmux');
  const byVariant = <T,>(dev: T, node: T, rust: T): T =>
    variant === 'dev' ? dev : variant === 'rust' ? rust : node;
  return {
    appId: byVariant('com.zbrooklyn.winmux.dev', 'com.zbrooklyn.winmux', 'com.zbrooklyn.winmux.rust'),
    name: byVariant('WinMux Dev', 'WinMux', 'WinMux Rust'),
    userData: path.join(opts.appData, byVariant('WinMuxDev', 'WinMux', 'WinMuxRust')),
    instanceFile: path.join(winmuxDir, byVariant('instance.dev.json', 'instance.json', 'instance.rust.json')),
    trustFile: path.join(winmuxDir, byVariant('devices.dev.json', 'devices.json', 'devices.rust.json')),
  };
}

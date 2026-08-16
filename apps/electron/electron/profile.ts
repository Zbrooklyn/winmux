import * as path from 'path';

export interface ProfileOpts {
  isPackaged: boolean;
  appData: string;   // app.getPath('appData'), e.g. %APPDATA%
  home: string;      // os.homedir()
  rust?: boolean;    // the side-by-side "WinMux Rust" identity
  nodeApp?: boolean; // the side-by-side "WinMux Node" identity (legacy engine as a sibling app)
}

export interface Profile {
  appId: string;
  name: string;
  userData: string;
  instanceFile: string;
  trustFile: string;
}

// core-rust.flag next to main.js selects the ENGINE; whether it also selects the
// separate "WinMux Rust" IDENTITY is a second, independent bit carried in the
// flag's content. Since the v0.2.0 Stage-4 cutover THE primary installer ships
// the Rust engine ('rust'), while the side-by-side proof installer additionally
// claims the distinct identity ('rust identity'). Conflating the two made the
// shipped primary app run under the side identity's userData/discovery/trust
// files — invisible to the CLI and clobbering the real WinMux Rust install.
export interface CoreFlag { rustCore: boolean; rustIdentity: boolean; }
export function parseCoreFlag(content: string | null): CoreFlag {
  if (content == null) return { rustCore: false, rustIdentity: false };
  return { rustCore: true, rustIdentity: /identity/.test(content) };
}

// One computation of a copy's identity. The packaged variants — the primary
// app, the side-by-side "WinMux Rust" app, and the side-by-side "WinMux Node"
// app — plus the from-source dev copy get disjoint values so none share
// Electron's userData (and its ProcessSingleton lock), the CLI discovery file,
// or the trusted-devices file. That is what lets all the installers sit on the
// same machine and run at once (Phase 12 coexistence contract; 'primary' was
// historically called 'node' when the Node engine was the primary's engine).
export function resolveProfile(opts: ProfileOpts): Profile {
  const variant: 'dev' | 'primary' | 'rust' | 'nodeApp' =
    !opts.isPackaged ? 'dev' : opts.rust ? 'rust' : opts.nodeApp ? 'nodeApp' : 'primary';
  const winmuxDir = path.join(opts.home, '.winmux');
  const byVariant = <T,>(dev: T, primary: T, rust: T, nodeApp: T): T =>
    variant === 'dev' ? dev : variant === 'rust' ? rust : variant === 'nodeApp' ? nodeApp : primary;
  return {
    appId: byVariant('com.zbrooklyn.winmux.dev', 'com.zbrooklyn.winmux', 'com.zbrooklyn.winmux.rust', 'com.zbrooklyn.winmux.node'),
    name: byVariant('WinMux Dev', 'WinMux', 'WinMux Rust', 'WinMux Node'),
    userData: path.join(opts.appData, byVariant('WinMuxDev', 'WinMux', 'WinMuxRust', 'WinMuxNode')),
    instanceFile: path.join(winmuxDir, byVariant('instance.dev.json', 'instance.json', 'instance.rust.json', 'instance.node.json')),
    trustFile: path.join(winmuxDir, byVariant('devices.dev.json', 'devices.json', 'devices.rust.json', 'devices.node.json')),
  };
}

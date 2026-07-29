import * as path from 'path';

export interface ProfileOpts {
  isPackaged: boolean;
  appData: string; // app.getPath('appData'), e.g. %APPDATA%
  home: string;    // os.homedir()
}

export interface Profile {
  appId: string;
  name: string;
  userData: string;
  instanceFile: string;
  trustFile: string;
}

// One computation of a copy's identity. The packaged .exe and the from-source
// dev copy get disjoint values so they never share Electron's userData (and its
// ProcessSingleton lock), the CLI discovery file, or the trusted-devices file.
export function resolveProfile(opts: ProfileOpts): Profile {
  const dev = !opts.isPackaged;
  const winmuxDir = path.join(opts.home, '.winmux');
  return {
    appId: dev ? 'com.zbrooklyn.winmux.dev' : 'com.zbrooklyn.winmux',
    name: dev ? 'WinMux Dev' : 'WinMux',
    userData: path.join(opts.appData, dev ? 'WinMuxDev' : 'WinMux'),
    instanceFile: path.join(winmuxDir, dev ? 'instance.dev.json' : 'instance.json'),
    trustFile: path.join(winmuxDir, dev ? 'devices.dev.json' : 'devices.json'),
  };
}

// WinMux — the mockup's full chrome, wired to real shells.
// Every control here does something real: no decorative buttons.
(function () {
  var root = document.getElementById('root');
  var wsrow = document.getElementById('wsrow');
  var countEl = document.getElementById('sx-count');
  var sxList = document.getElementById('sx-list');

  // Everything a mouse can press. None of it is a <button>, so none of it is in
  // the tab order until we put it there (see wireFocusable at the bottom).
  var FOCUSABLE = '[role="button"], .prow, .srow, .ncard, .ptab, .ptab .x, .mrow, .setrow, .plrow';

  var panes = [];
  var paneSeq = 0;
  var termSeq = 0;
  var activePaneId = null;

  // ---------------------------------------------------------------- settings
  var FONTS = {
    'Cascadia Code': "'Cascadia Code','Cascadia Mono',Consolas,ui-monospace,monospace",
    'Consolas': 'Consolas,ui-monospace,monospace',
    'JetBrains Mono': "'JetBrains Mono','Cascadia Code',Consolas,monospace",
    'System monospace': 'ui-monospace,monospace',
  };
  // --- The sixteen colours a terminal actually speaks in -------------------
  // Nobody ever chose the old ones. A theme that names no ANSI colours makes
  // xterm.js fall back to Tango — GNOME Terminal's 2006 default — and Tango was
  // drawn for a mid-grey background, not for ours. Two of its slots do most of
  // the damage on a PowerShell prompt, because PSReadLine paints every command
  // you type in brightYellow and every parameter in brightBlack: #fce94f is a
  // 14:1 shout on our near-black and a 1.2:1 ghost on our near-white, and
  // #555753 is 2.4:1 mud on the dark. Eleven of the sixteen failed outright in
  // light mode. One palette cannot serve both grounds, so each mode gets its own.
  //
  // Every colour below is measured against the background it is drawn on and
  // clears 4.5:1. Slot 0 is exempt: it is the ground for inverse video, not type.
  var PALETTES = {
    aurora: {
      label: 'Aurora — cool, keyed to the app accent',
      dark: ['#31313a', '#e8646d', '#78c98a', '#d6ac62', '#7aa2f7', '#b98cf2', '#5cc3c9', '#c3c3ca',
        '#8f8f9b', '#ff8f96', '#9ce0a8', '#f2cf88', '#a2c0ff', '#d0a8ff', '#8ce2e6', '#f2f2f5'],
      light: ['#2b2b31', '#b01f28', '#286b34', '#7d5310', '#2748a3', '#743597', '#186064', '#4f4f57',
        '#6d6d76', '#c9282f', '#337a41', '#96620f', '#3059bd', '#8a41b2', '#1e7076', '#1f1f24'],
    },
    ash: {
      label: 'Ash — muted, lowest glare',
      dark: ['#33333a', '#d4838a', '#93bd97', '#c8ae7d', '#8aa8d6', '#b39ad4', '#7fbcbf', '#c0c0c4',
        '#909096', '#e79ba2', '#a9d3ad', '#dcc491', '#a3bfe8', '#c8b0e6', '#98d0d3', '#eeeef0'],
      light: ['#2e2e33', '#9c3a41', '#3b6741', '#75581f', '#3a5590', '#6b4788', '#2a6165', '#525258',
        '#6e6e75', '#b24851', '#48784f', '#8a6a29', '#48659f', '#7d5599', '#357176', '#232328'],
    },
    ember: {
      label: 'Ember — warm, classic terminal',
      dark: ['#3a332e', '#f0736b', '#9dc06a', '#e0ac5c', '#7fb0e0', '#d089c4', '#63c4b4', '#c9c2b8',
        '#98908a', '#ff8f88', '#b6d685', '#f5c87c', '#9fc8f2', '#e6a3da', '#8adacb', '#f5efe6'],
      light: ['#33291f', '#ad3325', '#4e6a1c', '#8a5a12', '#2a5590', '#94357f', '#1d6a5e', '#57503f',
        '#6f685e', '#c4402f', '#5c7d22', '#96620f', '#3565a8', '#a94494', '#237c6e', '#2b241b'],
    },
  };
  var ANSI_KEYS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
    'brightMagenta', 'brightCyan', 'brightWhite'];
  // Imported terminal themes (Windows Terminal colour schemes) live here, loaded
  // from the on-disk config on boot; the picker and themeColors() see them exactly
  // like the built-in palettes.
  var USER_THEMES = {};
  function allPalettes() {
    var m = {}; var k;
    for (k in PALETTES) m[k] = PALETTES[k];
    for (k in USER_THEMES) m[k] = USER_THEMES[k];
    return m;
  }

  var DEFAULTS = {
    theme: 'system', palette: 'aurora', fontFamily: 'Cascadia Code', fontSize: 13, lineHeight: 1.2,
    cursorStyle: 'block', cursorBlink: true, scrollback: 5000,
    copyOnSelect: false, rightClickPaste: false, confirmClose: true,
    defaultShell: '', startFolder: '', gpuRenderer: true, ligatures: false, osNotify: true, clipSync: false,
    sidebarTab: 'sessions', sidebarWidth: 264,   // SB arc — which sidebar panel is up, and how wide the rail sits
    localEcho: true,   // SP-1 instant typing — predictive echo overlay; guards shut it off around secrets/TUIs
    commandBlocks: false,   // Phase 4 prototype — status gutter beside each command; OFF until the look is approved
    quakeEnabled: false, quakeHotkey: 'Control+`',   // Phase 7 — global hotkey drop; OFF so no system key is grabbed by default (Electron only)
    // Auto-resume: the command template an armed tab re-runs in its folder when
    // WinMux reopens. {id} is replaced with the exact Claude conversation the tab
    // pinned, so a reopen lands back in THAT conversation — not merely whatever
    // was last touched in the folder. `--dangerously-skip-permissions` is the
    // "yolo remote control" mode these tabs are meant to come back in.
    resumeCommand: 'claude --resume {id} --dangerously-skip-permissions',
  };
  var S = (function () {
    var s = {};
    for (var k in DEFAULTS) s[k] = DEFAULTS[k];
    // localStorage is a warm cache: it paints the right settings instantly and
    // keeps the standalone phone/web path working offline. The engine's
    // config.json is the source of truth and wins when it loads (PT-6).
    try {
      var raw = JSON.parse(localStorage.getItem('ct-settings') || '{}');
      for (var j in raw) if (j in s) s[j] = raw[j];
    } catch (e) {}
    // A resume command with no {id} placeholder can't pin a conversation — it is
    // either the older `--continue` form or a hand-edit that would silently resume
    // the wrong chat. Bring it forward to the template rather than obeying it.
    if (typeof s.resumeCommand !== 'string' || s.resumeCommand.indexOf('{id}') < 0) {
      s.resumeCommand = DEFAULTS.resumeCommand;
    }
    return s;
  })();
  // Settings live in two places, with one authority (PT-6): the engine's on-disk
  // config.json is the source of truth (durable, hand-editable, survives a
  // reinstall, shared by every face of this identity); localStorage is the warm
  // cache that paints instantly and keeps the offline phone/web path working.
  // Writing goes to both; on boot the disk wins over the cache once it loads.
  // `localOnly` mirrors disk→localStorage without echoing back to disk.
  var DISK_CONFIG = {};
  // Guards the disk write: until the on-disk config has actually been read once, a
  // boot's applySettings() must NOT POST its defaults — otherwise a fresh browser
  // (empty localStorage) would overwrite the real config with defaults before it
  // ever loads it. localStorage still mirrors instantly; only the disk POST waits.
  var configReady = false;
  function saveSettings(localOnly) {
    try { localStorage.setItem('ct-settings', JSON.stringify(S)); } catch (e) {}
    if (localOnly || !configReady) return;
    try {
      fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: S }) }).catch(function () {});
    } catch (e) {}
  }
  // On boot, pull the on-disk config and let it win over the built-in defaults —
  // so a fresh install (empty localStorage) still comes up with the user's real
  // settings, and a hand-edit of the file takes effect on next load. Async and
  // best-effort: if the server has no config or is unreachable, the app already
  // rendered on defaults/localStorage and nothing is lost.
  function loadDiskConfig() {
    // configReady flips true once we've read (or failed to read) the config, at
    // which point user-initiated changes are safe to persist to disk.
    function done() { configReady = true; }
    try {
      fetch('/api/config', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
        if (j && j.ok && j.config) {
          DISK_CONFIG = j.config;
          if (DISK_CONFIG.themes && typeof DISK_CONFIG.themes === 'object') USER_THEMES = DISK_CONFIG.themes;
          if (DISK_CONFIG.keymap && typeof DISK_CONFIG.keymap === 'object') {
            // The engine file is the source of truth (PT-6): disk overrides the
            // local cache, so a binding changed in one app follows to the others.
            for (var km in DISK_CONFIG.keymap) KEYMAP[km] = DISK_CONFIG.keymap[km];
          }
          var s = DISK_CONFIG.settings;
          if (s && typeof s === 'object') {
            var changed = false;
            for (var k in s) {
              if (!(k in DEFAULTS)) continue;
              // The one validity rule survives the flip: a resume command without
              // {id} is broken wherever it came from — never adopt it.
              if (k === 'resumeCommand' && (typeof s[k] !== 'string' || s[k].indexOf('{id}') < 0)) continue;
              if (S[k] !== s[k]) { S[k] = s[k]; changed = true; }
            }
            if (changed) applySettings();   // still !configReady → mirrors to localStorage, no POST echo
          }
        }
        done();
      }).catch(done);
    } catch (e) { done(); }
  }

  function isLightNow() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t === 'light') return true;
    if (t === 'dark') return false;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  }
  function themeColors() {
    var light = isLightNow();
    var t = light
      ? { background: '#fbfbfb', foreground: '#232323', cursor: '#8a5cf5', selectionBackground: 'rgba(138,92,245,.25)' }
      : { background: '#1a1a1a', foreground: '#dadada', cursor: '#8a5cf5', selectionBackground: 'rgba(138,92,245,.30)' };
    // The cursor keeps the app's own accent in every palette on purpose — it is
    // the one thing that ties the terminal to the chrome around it.
    var set = (allPalettes()[S.palette] || PALETTES.aurora)[light ? 'light' : 'dark'];
    for (var i = 0; i < ANSI_KEYS.length; i++) t[ANSI_KEYS[i]] = set[i];
    return t;
  }
  // Import a Windows Terminal colour scheme (the de-facto format for this world)
  // into a palette. A WT scheme is a flat object of 16 ANSI names (magenta is
  // spelled "purple") plus background/foreground; we map the 16 onto WinMux's
  // palette shape and use them for both light and dark (a scheme is a single set).
  // Returns { ok, id, label } or { ok:false, error }.
  var WT_TO_ANSI = { black: 'black', red: 'red', green: 'green', yellow: 'yellow', blue: 'blue',
    purple: 'magenta', magenta: 'magenta', cyan: 'cyan', white: 'white',
    brightBlack: 'brightBlack', brightRed: 'brightRed', brightGreen: 'brightGreen',
    brightYellow: 'brightYellow', brightBlue: 'brightBlue', brightPurple: 'brightMagenta',
    brightMagenta: 'brightMagenta', brightCyan: 'brightCyan', brightWhite: 'brightWhite' };
  function importTheme(text) {
    var scheme; try { scheme = JSON.parse(text); } catch (e) { return { ok: false, error: 'That is not valid JSON.' }; }
    if (!scheme || typeof scheme !== 'object') return { ok: false, error: 'Expected a colour-scheme object.' };
    var byAnsi = {};
    for (var w in WT_TO_ANSI) if (typeof scheme[w] === 'string') byAnsi[WT_TO_ANSI[w]] = scheme[w].trim();
    var arr = [];
    for (var i = 0; i < ANSI_KEYS.length; i++) {
      var c = byAnsi[ANSI_KEYS[i]];
      if (!/^#[0-9a-fA-F]{6}$/.test(c || '')) return { ok: false, error: 'Missing or invalid colour for "' + ANSI_KEYS[i] + '". Needs all 16 ANSI colours as #rrggbb.' };
      arr.push(c);
    }
    var label = String(scheme.name || 'Imported theme').slice(0, 40);
    var id = 'user:' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || ('user:' + Object.keys(USER_THEMES).length);
    USER_THEMES[id] = { label: label + ' — imported', dark: arr.slice(), light: arr.slice() };
    saveThemes();
    return { ok: true, id: id, label: label };
  }
  function saveThemes() {
    try {
      fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ themes: USER_THEMES }) }).catch(function () {});
    } catch (e) {}
  }
  // Observability hook: import + apply a scheme now, so the harness can prove the
  // imported colours reach the live terminal without driving the paste dialog.
  window.__winmuxImportTheme = function (text) { var r = importTheme(text); if (r.ok) { S.palette = r.id; applySettings(); } return r; };
  function applyTheme(mode) {
    S.theme = mode;
    if (mode === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    saveSettings();
    eachTerm(function (t) { try { t.term.options.theme = themeColors(); } catch (e) {} });
  }
  // Push every terminal option that Settings can change onto every live terminal.
  // GPU renderer — the big win on fast output (10 streaming agents lag the DOM
  // renderer badly, measured: 132ms/tick down to under 50). Load AFTER term.open();
  // fall back to the DOM renderer if a WebGL context can't be created (headless/
  // remote/GPU-less). The buffer API (read-screen, serializeTerm) is renderer-
  // independent, so nothing else moves.
  //
  // Ligatures are the one thing that forces the other way. Shaping "=>" into an
  // arrow needs a text run the browser can shape, and only the DOM renderer emits
  // one — WebGL draws cell by cell out of a glyph atlas, so under it there is no
  // DOM text at all (measured: hasDomText false, zero spans). So the ligature
  // switch is a real fork, not a coat of CSS: turning it on drops that terminal
  // back to the DOM renderer. Live-swappable in both directions, so flipping the
  // switch never costs you your scrollback.
  function wantsWebgl() {
    return !!(window.WebglAddon && S.gpuRenderer && !S.ligatures && !window.__winmuxForceDom);
  }
  // SP-5 (speed arc): WebGL contexts are a browser-limited resource (~16 per page).
  // A hidden tab paints nothing, so only VISIBLE terminals get the WebGL renderer —
  // pass visible:false to hand the context back when a tab hides. Without this, 50
  // tabs meant 50 context requests: the browser evicted the oldest, applySettings
  // re-created them, and every toggle became a 385ms+ musical-chairs pass (measured).
  function applyRenderer(term, visible) {
    var want = wantsWebgl() && visible !== false;
    if (want && term.__winmuxRenderer === 'webgl') return;
    if (!want && term.__winmuxRenderer !== 'webgl') { term.__winmuxRenderer = 'dom'; return; }
    if (!want) {
      try { term.__winmuxWebgl.dispose(); } catch (e) {}
      term.__winmuxWebgl = null;
      term.__winmuxRenderer = 'dom';
      try { term.refresh(0, term.rows - 1); } catch (e) {}
      return;
    }
    try {
      var webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(function () { try { webgl.dispose(); } catch (e) {} term.__winmuxWebgl = null; term.__winmuxRenderer = 'dom'; });
      term.loadAddon(webgl);
      term.__winmuxWebgl = webgl;
      term.__winmuxRenderer = 'webgl';   // measured 12x fewer event-loop stalls under load
    } catch (e) { term.__winmuxRenderer = 'dom'; /* DOM renderer stays — perfectly fine, just slower */ }
  }
  // devicePixelRatio resync. xterm's WebGL renderer only resizes its canvas backing
  // store on a COLUMN/ROW change — a pure devicePixelRatio change does NOT resize it.
  // On Windows with display scaling (125/150%) Electron paints the first frame at
  // dpr 1, then the real dpr kicks in once the window lands on the scaled monitor: a
  // dpr change with no col/row change. The canvas stays stuck at the old scale, so the
  // whole grid renders at the wrong size and the first prompt is stranded mid-pane
  // (the buffer is correct — it's purely a canvas-geometry bug). The DOM renderer
  // positions rows with CSS and never has this. Detect the mismatch (canvas backing !=
  // what the render service's dimensions want) and force the renderer to resize; a
  // no-op equality check when healthy, so it costs nothing in the normal case.
  function resyncRenderer(term) {
    if (!term || term.__winmuxRenderer !== 'webgl') return;
    try {
      var rs = term._core && term._core._renderService;
      var r = rs && rs._renderer; r = r && (r.value || r);
      if (!rs || !r || typeof r.handleResize !== 'function') return;
      var canvas = r._canvas;
      var dims = rs.dimensions && rs.dimensions.device && rs.dimensions.device.canvas;
      if (!canvas || !dims || !dims.width || !dims.height) return;
      if (canvas.width === Math.round(dims.width) && canvas.height === Math.round(dims.height)) return;
      r.handleResize(term.cols, term.rows);
      term.refresh(0, term.rows - 1);
    } catch (e) {}
  }
  function applyLigatures() {
    if (S.ligatures) document.body.setAttribute('data-ligatures', '');
    else document.body.removeAttribute('data-ligatures');
  }
  // Everything term.options.theme is derived from, as one comparable string —
  // palette CONTENT included, so re-importing a scheme under the same name still
  // counts as a change.
  function themeSig() {
    return (isLightNow() ? 'L' : 'D') + '|' + S.palette + '|' + JSON.stringify(allPalettes()[S.palette] || '');
  }
  // Bring one terminal's xterm options up to date with S, assigning only what
  // actually differs. Assigning options.theme a fresh object makes xterm rebuild
  // its glyph atlas and repaint even when every colour is identical, so the theme
  // is guarded by its signature.
  function applyTermOptions(t) {
    if (!t.term) return;
    try {
      var o = t.term.options;
      var want = {
        fontFamily: FONTS[S.fontFamily] || FONTS['Cascadia Code'],
        fontSize: S.fontSize,
        lineHeight: S.lineHeight,
        cursorStyle: S.cursorStyle,
        cursorBlink: !!S.cursorBlink,
        scrollback: S.scrollback,
      };
      for (var k in want) if (o[k] !== want[k]) o[k] = want[k];
      var sig = themeSig();
      if (t.term.__winmuxThemeSig !== sig) { o.theme = themeColors(); t.term.__winmuxThemeSig = sig; }
      t.term.__winmuxOptsDirty = false;
    } catch (e) {}
  }
  function applySettings() {
    var dbg = null;
    try { if (localStorage.getItem('ct-perf-debug')) dbg = { t: performance.now(), m: [] }; } catch (e) {}
    var mark = function (label) { if (dbg) { var n = performance.now(); dbg.m.push(label + ' ' + Math.round(n - dbg.t) + 'ms'); dbg.t = n; } };
    applyLigatures();
    mark('ligatures');
    // SB arc: the rail width is a setting like any other — clamp and paint it here
    // so a disk-config load (PT-6 authority) lands it without a reload.
    try {
      var sbw = Math.max(200, Math.min(420, Math.round(S.sidebarWidth) || 264));
      document.documentElement.style.setProperty('--sbw', sbw + 'px');
      // Re-assert the persisted panel too — but never yank an open Notifications
      // view out from under the user just because a setting changed.
      var sxa = document.querySelector('.sessions');
      if (sxa && sxa.getAttribute('data-sxtab') !== 'notif') setSidebarTab(S.sidebarTab === 'projects' ? 'projects' : 'sessions');
    } catch (e) {}
    eachTerm(function (t) { applyRenderer(t.term, !!(t.host && t.host.style.display !== 'none')); });
    mark('renderer');
    // SP-5 (speed arc): a settings change pays only for what the user can see.
    // Visible terminals apply immediately; hidden ones are marked dirty and catch
    // up the moment they're shown (activateTerm). Even a cheap per-option
    // assignment costs ~2ms inside xterm — × 50 tabs that made every toggle a
    // ~96ms click (measured), all of it spent on terminals nobody was looking at.
    eachTerm(function (t) {
      if (!t.term) return;
      if (t.host && t.host.style.display === 'none') { t.term.__winmuxOptsDirty = true; return; }
      applyTermOptions(t);
    });
    mark('options');
    panes.forEach(fitActive);
    mark('fit');
    saveSettings();
    pushQuake();
    mark('save');
    if (dbg) console.log('[perf] applySettings: ' + dbg.m.join(' · '));
  }
  // Phase 7 — tell the Electron main process whether to hold the quake hotkey, and
  // which key. A no-op in a plain browser (no bridge), so the setting just persists.
  function pushQuake() {
    try { if (window.winmux && window.winmux.setQuake) window.winmux.setQuake({ enabled: !!S.quakeEnabled, hotkey: S.quakeHotkey || 'Control+`' }); } catch (e) {}
  }
  function eachTerm(fn) { panes.forEach(function (p) { p.terms.forEach(fn); }); }
  function allTerms() { var a = []; eachTerm(function (t) { a.push(t); }); return a; }

  // Shells available on this machine (filled from /shells).
  var SHELLS = [{ key: 'powershell', label: 'PowerShell' }];
  var DEFAULT_SHELL = 'powershell';
  function startShell() { return S.defaultShell || DEFAULT_SHELL; }
  function labelFor(key) { for (var i = 0; i < SHELLS.length; i++) if (SHELLS[i].key === key) return SHELLS[i].label; return 'Terminal'; }
  var HOME = '';
  var APP_VERSION = '';   // filled from /api/info; the single source for the shown version

  var NEW_SVG = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
  var CARET_SVG = '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
  var FIND_SVG = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
  var ZOOM_SVG = '<svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
  var SPLIT_SVG = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>';
  var CLOSE_SVG = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var UP_SVG = '<svg viewBox="0 0 24 24"><path d="M18 15l-6-6-6 6"/></svg>';
  var DOWN_SVG = '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
  var RAIL_SVG = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>';
  var DOCK_SVG = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>';
  var FOLDER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>';

  // The group row's expand chevron. cockpit.css rotates it 90° when the group is
  // open, so it has to start out pointing right.
  var CARET_RIGHT_SVG = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
  var EYE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  var XCLOSE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var FOLDER_PLUS_SVG = '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M12 10v6M9 13h6"/></svg>';
  var PIN_SVG = '<svg viewBox="0 0 24 24"><path d="M9 3h6M12 3v7M7 10h10l-1.6 4H8.6zM12 14v7"/></svg>';
  var BACK_SVG = '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>';
  var PPIN_SVG = '<svg class="ppin" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M9 2h6l-1 6 4 4H6l4-4z"/><path d="M11 12h2v9h-2z"/></svg>';

  var STATUS_COLOR = { working: 'var(--work)', needsyou: 'var(--err)', closed: 'var(--faint)', idle: 'transparent' };

  // Each shell type gets its own mark, using the mockup's favicon colour classes.
  var SHELL_FAV = {
    powershell: ['fav-b', 'PS'], pwsh: ['fav-b', 'PS'], cmd: ['fav-m', 'C:'],
    gitbash: ['fav-t', '$'], bash: ['fav-t', '$'], wsl: ['fav-d', '~'],
  };
  function favHTML(shellKey) {
    var f = SHELL_FAV[shellKey] || ['fav-t', '&gt;_'];
    return '<span class="tfav"><span class="fav ' + f[0] + '">' + f[1] + '</span>' +
      '<span class="fdot" style="display:none"></span></span>';
  }

  // ------------------------------------------------------------------ menus
  var openMenu = null, openBackdrop = null;
  function closeMenu() {
    if (openBackdrop) { openBackdrop.remove(); openBackdrop = null; }
    if (openMenu) { openMenu.remove(); openMenu = null; document.removeEventListener('mousedown', onDocDown); }
  }
  function onDocDown(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
  function placeMenu(menu, x, y) {
    // On the phone every menu is a bottom sheet that slides up, not a desktop
    // popover anchored to a cursor — one shared path so all menus stay consistent.
    if (currentMode === 'narrow') {
      var bd = document.createElement('div');
      bd.className = 'sheet-backdrop';
      bd.addEventListener('click', closeMenu);
      document.body.appendChild(bd);
      openBackdrop = bd;
      menu.classList.add('sheet');
      document.body.appendChild(menu);
      void menu.offsetHeight; // reflow so the slide-up transition runs
      menu.classList.add('in');
      openMenu = menu;
      setTimeout(function () { document.addEventListener('mousedown', onDocDown); }, 0);
      return;
    }
    document.body.appendChild(menu);
    menu.style.left = Math.max(6, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(6, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + 'px';
    openMenu = menu;
    setTimeout(function () { document.addEventListener('mousedown', onDocDown); }, 0);
  }
  function newMenu() {
    closeMenu();
    var m = document.createElement('div');
    m.className = 'ofmenu';
    m.setAttribute('data-open', '');
    return m;
  }
  function addMenuItem(menu, label, kbd, fn, checked) {
    var item = document.createElement('div');
    item.className = 'ofmi';
    if (checked) item.setAttribute('data-on', '');
    item.innerHTML = '<span class="nm">' + label + '</span>' + (kbd ? '<span class="kbd sm">' + kbd + '</span>' : '');
    item.addEventListener('click', function (e) { e.stopPropagation(); closeMenu(); fn(); });
    menu.appendChild(item);
    return item;
  }
  // Shell picker — "new tab type…" and "split…" both use it.
  function showShellMenu(anchor, label, fn) {
    var m = newMenu();
    var head = document.createElement('div');
    head.className = 'ctxlabel'; head.textContent = label;
    m.appendChild(head);
    SHELLS.forEach(function (s) {
      var item = document.createElement('div');
      item.className = 'ofmi';
      item.innerHTML = favHTML(s.key) + '<span class="nm">' + s.label + '</span>';
      item.addEventListener('click', function (e) { e.stopPropagation(); closeMenu(); fn(s.key); });
      m.appendChild(item);
    });
    var r = anchor.getBoundingClientRect();
    placeMenu(m, r.left, r.bottom + 4);
  }
  function showSplitMenu(p, anchor) {
    var m = newMenu();
    addMenuItem(m, 'Split right', 'Ctrl+D', function () { splitRight(p, startShell()); });
    addMenuItem(m, 'Split down', 'Ctrl+Shift+D', function () { splitDown(p, startShell()); });
    var r = anchor.getBoundingClientRect();
    placeMenu(m, r.left, r.bottom + 4);
  }
  // The "+" new-tab button opens this: pick what kind of tab to open. Terminal is the
  // default (Enter/click). Browser and Markdown open the working surfaces; the in-pane
  // tab versions land in a later unit. Browser is Electron-only (the <webview> dock),
  // so it's hidden on the web/phone client where that surface doesn't exist.
  function openMarkdownPick(p) {
    if (window.winmux && window.winmux.pickFile) {
      window.winmux.pickFile({ filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx', 'txt'] }] })
        .then(function (path) { if (path) openMarkdown(path, p); });
    } else {
      var path = window.prompt('Open markdown file (full path):', '');
      if (path) openMarkdown(path.trim(), p);
    }
  }
  // The three surfaces a new tab can be, each with the icon + one-liner the menu
  // renders. Icons are drawn in WinMux's own stroke style (viewBox 0 0 24 24), so
  // the menu reads as part of the app, not a generic dropdown.
  var TYPE_ITEMS = [
    { type: 'terminal', label: 'Terminal', desc: 'A PowerShell session', kbd: 'Alt+T',
      svg: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/></svg>',
      run: function (p) { newTerm(p, startShell()); } },
    { type: 'browser', label: 'Browser', desc: 'Open a web page', electron: true,
      svg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.7 2.6 15.3 0 18M12 3c-2.6 2.7-2.6 15.3 0 18"/></svg>',
      run: function (p) { newBrowserLeaf(p, 'about:blank'); } },
    { type: 'markdown', label: 'Markdown', desc: 'Open a .md file',
      svg: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4M8 13h8M8 16.5h5"/></svg>',
      run: function (p) { openMarkdownPick(p); } },
    { type: 'diff', label: 'Changes', desc: 'Git diff for this repo',
      svg: '<svg viewBox="0 0 24 24"><path d="M12 4v6M9 7h6"/><path d="M9 17h6"/><path d="M5 4h4M15 20h4"/><path d="M7 10v7a3 3 0 0 0 3 3h1M17 14V7a3 3 0 0 0-3-3h-1"/></svg>',
      run: function (p) { newDiffLeaf(p, diffDefaultCwd()); } },
  ];
  // Shipped New-tab menu look: minimal (native context-menu, no icon tiles) — the
  // flattest, least "designed card" direction. Other looks stay reachable by changing
  // this one attribute (grid / compact) or clearing it for the tiled version.
  document.documentElement.setAttribute('data-tmenu-style', 'minimal');
  function showTypeMenu(p, anchor) {
    var m = newMenu();
    m.classList.add('tmenu');
    var head = document.createElement('div');
    head.className = 'ctxlabel'; head.textContent = 'New tab';
    m.appendChild(head);
    TYPE_ITEMS.forEach(function (it) {
      if (it.electron && !isElectronApp()) return;
      var row = document.createElement('div');
      row.className = 'tmi';
      row.innerHTML =
        '<span class="ic">' + it.svg + '</span>' +
        '<span class="txt"><span class="lab">' + esc(it.label) + '</span>' +
        '<span class="desc">' + esc(it.desc) + '</span></span>' +
        (it.kbd ? '<span class="kbd sm">' + esc(it.kbd) + '</span>' : '');
      row.addEventListener('click', function (e) { e.stopPropagation(); closeMenu(); it.run(p); });
      m.appendChild(row);
    });
    // Integrated dock: pin the menu flush to the app's top-right — its right edge on
    // the window edge, its top on the header seam — so it reads as coming out of the
    // app, not floating over it. (See .tmenu-dock for the squared corners.)
    m.classList.add('tmenu-dock');
    var bar = anchor.closest('.ptabs');
    var top = (bar || anchor).getBoundingClientRect().bottom;
    placeMenu(m, 0, top);
    m.style.left = 'auto';
    m.style.right = '0';
    m.style.top = top + 'px';
  }
  // Cross-device clipboard (opt-in, default off). When on, a copy also pushes the
  // text to the server's in-memory clip so another device on the tailnet can pull
  // it; "Paste from other device" pulls the latest. Same-origin fetch carries the
  // phone cookie, so it authenticates over the tailnet exactly like the rest.
  function postClip(text) {
    if (!S.clipSync || !text) return;
    try {
      fetch('/api/clip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: String(text) }) }).catch(function () {});
    } catch (e) {}
  }
  function pasteFromOtherDevice(t) {
    if (!t) return;
    try {
      fetch('/api/clip', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
        if (j && j.ok && j.text) { deliverPaste(t, j.text); try { t.term.focus(); } catch (e) {} }
      }).catch(function () {});
    } catch (e) {}
  }
  function copySel(t) { try { var s = t.term.getSelection(); if (s) { if (navigator.clipboard) navigator.clipboard.writeText(s); postClip(s); } } catch (e) {} }
  // Command-mark navigation: OSC-133 'A' marks are the prompt boundaries the shell
  // emits. Jump the viewport to the previous/next prompt so you can walk command
  // history without scrolling by eye. No-op safely when the shell emits no marks.
  function jumpMark(t, dir) {
    if (!t || !t.term || !t.marks || !t.marks.length) return false;
    var term = t.term, cur = term.buffer.active.viewportY, ys = [];
    for (var i = 0; i < t.marks.length; i++) if (t.marks[i].k === 'A' && typeof t.marks[i].y === 'number') ys.push(t.marks[i].y);
    if (!ys.length) return false;
    ys.sort(function (a, b) { return a - b; });
    var target = null;
    if (dir > 0) { for (var j = 0; j < ys.length; j++) if (ys[j] > cur) { target = ys[j]; break; } }
    else { for (var k = ys.length - 1; k >= 0; k--) if (ys[k] < cur) { target = ys[k]; break; } }
    if (target == null) return false;
    try { term.scrollToLine(target); } catch (e) { return false; }
    return true;
  }
  // Command blocks (Phase 4, prototype — gated by S.commandBlocks, default OFF until
  // the look is approved). A thin gutter bar beside each finished command, coloured by
  // exit status: green = succeeded, red = failed. Built on the OSC-133 D-mark exit code
  // pwsh 7 emits. xterm decorations anchor the bar to a buffer line so it scrolls with
  // the output. No boxes, no headers — the minimal, Obsidian-clean direction.
  function fmtDur(ms) {
    if (ms == null || ms < 0) return '';
    if (ms < 1000) return ms + 'ms';
    var s = ms / 1000;
    return (s < 10 ? s.toFixed(1) : Math.round(s)) + 's';
  }
  function decorateBlock(t, marker, rows, exit, ms) {
    if (!S.commandBlocks) return;
    var term = t.term;
    if (!term || typeof term.registerDecoration !== 'function') return;
    if (!marker || marker.isDisposed) return;
    var cls = exit === 0 ? 'ok' : (exit == null ? 'run' : 'bad');
    var mark = exit === 0 ? '✓' : (exit == null ? '·' : '✗');   // ✓ · ✗
    var dur = fmtDur(ms);
    var label = mark + (dur ? ' ' + dur : '');
    try {
      // Inline status tag, placed just after the command text on the command row.
      // WinMux can't recolour the shell's own prompt (that is the shell's job), so
      // instead of touching the prompt we append a small ✓/✗ + time tag in the empty
      // space after the command — the command carries its own result, nothing boxed
      // and nothing shoved to the far edge. Column is read from the buffer so the tag
      // sits right where the typed command ends.
      var col = 0;
      try {
        var bl = term.buffer.active.getLine(marker.line);
        if (bl) col = bl.translateToString(true).replace(/\s+$/, '').length;
      } catch (e) {}
      var x = Math.min(col + 1, Math.max(1, (term.cols || 80) - label.length - 1));
      var dec = term.registerDecoration({ marker: marker, x: x, width: label.length + 1, height: 1, layer: 'top' });
      if (dec) {
        dec.onRender(function (el) {
          if (el._blk) return; el._blk = true;
          // ADD our classes — never overwrite: el.className carries xterm's own
          // .xterm-decoration positioning classes, and replacing them drops the
          // absolute position so the tag collapses to a full-width block below the
          // terminal (invisible). classList.add keeps xterm's layout intact.
          el.classList.add('cmdtag', cls);
          el.textContent = label;
        });
        (t.blockDecs || (t.blockDecs = [])).push(dec);
      }
    } catch (e) {}
  }
  // Reset terminal: clear the screen AND scrollback and reset modes/colours to a
  // clean slate. Purely visual — the shell and socket underneath are untouched.
  function resetTerm(t) {
    if (!t || !t.term) return false;
    try { t.term.reset(); t.term.focus(); return true; } catch (e) { return false; }
  }
  // Paste safety (#214). A pasted block with newlines runs every line as its own
  // command the instant it lands — a footgun, and a worse one in front of an
  // agent. A single trailing newline (paste one command + run it) is fine; two
  // or more lines is the danger. If the shell has bracketed paste on, xterm
  // already neutralises it (the shell holds it as literal text), so those pass
  // straight through; only a raw multi-line paste stops to ask.
  function isMultiLinePaste(txt) {
    if (!txt) return false;
    return /\r?\n/.test(txt.replace(/\r?\n$/, ''));   // ignore one trailing newline
  }
  function bracketedActive(t) {
    try { return !!(t.term && t.term.modes && t.term.modes.bracketedPasteMode); } catch (e) { return false; }
  }
  function sendToShell(t, txt) {
    if (t.ws && t.ws.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify({ t: 'i', d: txt }));
  }
  function deliverPaste(t, txt) {
    if (!txt) return;
    if (isMultiLinePaste(txt) && !bracketedActive(t)) {
      var n = txt.replace(/\r?\n$/, '').split(/\r?\n/).length;
      confirmDialog('Paste ' + n + ' lines?',
        'This paste is ' + n + ' lines and will run each one as a command the moment it lands. Paste anyway?',
        'Paste', function () { sendToShell(t, txt); try { t.term.focus(); } catch (e) {} });
    } else {
      sendToShell(t, txt);
    }
  }
  function pasteInto(t) {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(function (txt) {
          deliverPaste(t, txt);
          try { t.term.focus(); } catch (e) {}
        }).catch(function () {});
      }
    } catch (e) {}
  }
  function showTermMenu(p, t, x, y) {
    var m = newMenu();
    var hasSel = false; try { hasSel = !!t.term.getSelection(); } catch (e) {}
    if (hasSel) addMenuItem(m, 'Copy', 'Ctrl+Shift+C', function () { copySel(t); });
    addMenuItem(m, 'Paste', 'Ctrl+Shift+V', function () { pasteInto(t); });
    if (S.clipSync) addMenuItem(m, 'Paste from other device', '', function () { pasteFromOtherDevice(t); });
    addMenuItem(m, 'Select all', '', function () { try { t.term.selectAll(); } catch (e) {} });
    addMenuItem(m, 'Clear', '', function () { try { t.term.clear(); t.term.focus(); } catch (e) {} });
    addMenuItem(m, 'Reset terminal', effectiveChord(actionById('reset-terminal')), function () { resetTerm(t); });
    addMenuItem(m, 'Find…', 'Ctrl+F', function () { openFind(p); });
    addMenuItem(m, 'Split right', 'Ctrl+D', function () { splitRight(p, startShell()); });
    addMenuItem(m, 'Close tab', 'Alt+W', function () { askCloseTerm(p, t.id); });
    placeMenu(m, x, y);
  }
  // Right-click a sidebar terminal row.
  function showSessionMenu(t, x, y) {
    var p = paneById(t.paneId);
    var m = newMenu();
    addMenuItem(m, 'Focus', '', function () { focusTerm(t.id); });
    addMenuItem(m, 'Rename…', '', function () { focusTerm(t.id); startRename(t); });
    addMenuItem(m, 'Duplicate', '', function () { if (p) { newTerm(p, t.shell, t.cwd); focusPane(p.id); } });
    addMenuItem(m, 'Open in new pane', '', function () { if (p) splitRight(p, t.shell, t.cwd); });
    addMenuItem(m, 'Close', 'Alt+W', function () { if (p) askCloseTerm(p, t.id); });
    placeMenu(m, x, y);
  }

  // Right-click a top TAB — the full session menu. Every action that acts on one
  // session lives here, not permanently on the toolbar (Edward's control-placement
  // model: the bar stays global; session controls appear when you ask the tab).
  var TAB_COLORS = [
    ['Default', ''], ['Purple', 'var(--accent)'], ['Red', '#e5484d'], ['Amber', '#d9822b'],
    ['Green', '#46a758'], ['Blue', '#3b82f6'], ['Pink', '#e93d82'], ['Teal', '#12a594'],
  ];
  function setTabColor(t, color) {
    t.color = color || null;
    if (t.color) { t.tabEl.style.setProperty('--tab-color', t.color); t.tabEl.setAttribute('data-tab-color', ''); }
    else { t.tabEl.style.removeProperty('--tab-color'); t.tabEl.removeAttribute('data-tab-color'); }
  }
  function showTabColorMenu(t, x, y) {
    var m = newMenu();
    var head = document.createElement('div'); head.className = 'ctxlabel'; head.textContent = 'Tab color';
    m.appendChild(head);
    var row = document.createElement('div'); row.className = 'ctxswatches';
    TAB_COLORS.forEach(function (c) {
      var sw = document.createElement('span');
      sw.className = 'ctxsw'; sw.title = c[0];
      sw.style.background = c[1] || 'transparent';
      if (!c[1]) sw.textContent = '×';
      if ((t.color || '') === c[1]) sw.setAttribute('data-on', '');
      sw.addEventListener('click', function (e) { e.stopPropagation(); closeMenu(); setTabColor(t, c[1]); });
      row.appendChild(sw);
    });
    m.appendChild(row);
    placeMenu(m, x, y);
  }
  function showMoveToGroupMenu(t, x, y) {
    var m = newMenu();
    var head = document.createElement('div'); head.className = 'ctxlabel'; head.textContent = 'Move to group';
    m.appendChild(head);
    var others = groups.filter(function (g) { return g.id !== t.groupId; });
    if (!others.length) { addMenuItem(m, 'No other groups', '', function () {}); }
    else others.forEach(function (g) {
      addMenuItem(m, g.name, '', function () { t.groupId = g.id; switchGroup(g.id); });
    });
    placeMenu(m, x, y);
  }
  function exportTermText(t) {
    var text = '';
    try {
      var buf = t.term.buffer.active, lines = [];
      for (var i = 0; i < buf.length; i++) { var ln = buf.getLine(i); lines.push(ln ? ln.translateToString(true) : ''); }
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      text = lines.join('\r\n');
    } catch (e) {}
    var name = (t.tabEl.querySelector('.tt').textContent || 'session').replace(/[^\w.-]+/g, '_');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = name + '.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  // Visual (left-to-right) tab order within a group, walking each pane's strip.
  function groupTabsInOrder(gid) {
    var out = [];
    panes.forEach(function (p) {
      Array.prototype.forEach.call(p.tabscroll.querySelectorAll('.ptab'), function (el) {
        for (var i = 0; i < p.terms.length; i++) {
          if (p.terms[i].tabEl === el && p.terms[i].groupId === gid) { out.push(p.terms[i]); break; }
        }
      });
    });
    return out;
  }
  function bulkCloseTerms(list, label) {
    if (!list.length) return;
    var open = list.filter(function (x) { return x.state === 'open'; }).length;
    var run = function () { list.slice().forEach(function (x) { var pp = paneById(x.paneId); if (pp) closeTerm(pp, x.id); }); };
    if (S.confirmClose && open) confirmDialog(label, open + ' shell process' + (open === 1 ? '' : 'es') + ' will be ended.', 'Close', run);
    else run();
  }
  // The Claude conversations that belong to a folder, newest first. The server
  // reads the ids out of Claude's own store for that one cwd; an empty list means
  // Claude has never run there, which is a real answer the UI must show.
  function claudeSessions(cwd, cb) {
    if (!cwd) return cb([]);
    fetch('/api/claude-sessions?cwd=' + encodeURIComponent(cwd))
      .then(function (r) { return r.json(); })
      .then(function (j) { cb((j && j.sessions) || []); })
      .catch(function () { cb([]); });
  }
  function resumeCmdFor(id) {
    var tpl = S.resumeCommand || DEFAULTS.resumeCommand;
    return tpl.indexOf('{id}') >= 0 ? tpl.split('{id}').join(id) : tpl + ' ' + id;
  }
  // Arm/disarm auto-resume on a tab. Armed = the next time WinMux opens, this tab
  // resumes THE conversation pinned here — `claude --resume <id>` in the tab's own
  // folder — not "whatever was last touched". The id is resolved from Claude's own
  // store, so arming fails honestly when the folder has no conversation yet.
  // Writes the flag + persists only; it never runs anything now (arming a live
  // Claude tab must not launch a second one) — the run happens on the next fresh shell.
  function armResume(t, on, id) {
    if (!on) {
      t.resume = null; t.resumeId = null;
      applyArm(t);
      return;
    }
    if (id) { pin(id); return; }
    claudeSessions(t.cwd, function (list) {
      if (!list.length) {
        notify('Nothing to resume', 'No Claude conversation in ' + (t.cwd || 'this folder') + ' yet.', t.id);
        return;
      }
      pin(list[0].id);                        // newest conversation in this tab's folder
    });
    function pin(cid) {
      t.resumeId = cid;
      t.resume = resumeCmdFor(cid);
      applyArm(t);
    }
  }
  function applyArm(t) {
    if (t.tabEl) {
      t.tabEl.classList.toggle('armed', !!t.resume);
      var mk = t.tabEl.querySelector('.tres');
      if (mk) mk.title = t.resume ? ('Auto-resumes conversation ' + (t.resumeId || '?') + ' on reopen — ' + t.resume) : '';
    }
    persistLive();
    renderSidebar();
    var p = paneById(t.paneId); if (p) layoutTabs(p);
  }
  // Keep an armed tab pinned to the conversation actually being used in it. Starting
  // a new chat in the tab makes a new id the live one, and a stale pin would reopen
  // into yesterday's conversation — so re-resolve on a slow poll. Only ever moves the
  // pin forward to a NEWER conversation in the same folder; a tab whose id was chosen
  // by hand (pickResumeConversation) opts out.
  function refreshArmedResumeIds() {
    allTerms().forEach(function (t) {
      if (!t.resume || t.resumePinnedByHand || !t.cwd) return;
      claudeSessions(t.cwd, function (list) {
        if (!list.length || list[0].id === t.resumeId) return;
        t.resumeId = list[0].id;
        t.resume = resumeCmdFor(list[0].id);
        persistLive();
        renderSidebar();
      });
    });
  }
  setInterval(refreshArmedResumeIds, 30000);
  // Pin a specific conversation by hand, for a folder that holds several.
  function pickResumeConversation(t, x, y) {
    claudeSessions(t.cwd, function (list) {
      var m = newMenu();
      if (!list.length) addMenuItem(m, 'No Claude conversation in this folder', '', function () {});
      list.slice(0, 12).forEach(function (s) {
        var when = new Date(s.mtime);
        var label = (s.id === t.resumeId ? '✓ ' : '') + s.id.slice(0, 8) + ' · ' + when.toLocaleString();
        addMenuItem(m, label, '', function () {
          t.resumePinnedByHand = true;
          armResume(t, true, s.id);
        });
      });
      placeMenu(m, x, y);
    });
  }
  window.__winmuxArm = armResume;              // harness hook (3rd arg pins an explicit id)
  window.__winmuxClaudeSessions = claudeSessions;

  function showTabMenu(t, x, y) {
    var p = paneById(t.paneId);
    var m = newMenu();
    addMenuItem(m, 'Change tab color…', '', function () { showTabColorMenu(t, x, y); });
    addMenuItem(m, 'Rename…', '', function () { focusTerm(t.id); startRename(t); });
    addMenuItem(m, (t.resume ? '✓ Auto-resume this conversation' : 'Auto-resume this conversation'), '', function () { armResume(t, !t.resume); });
    addMenuItem(m, 'Auto-resume: choose conversation…', '', function () { pickResumeConversation(t, x, y); });
    addMenuItem(m, 'Duplicate', '', function () { if (p) { newTerm(p, t.shell, t.cwd); focusPane(p.id); } });
    addMenuItem(m, 'Split tab', 'Ctrl+D', function () { if (p) splitRight(p, t.shell, t.cwd); });
    addMenuItem(m, 'Move to group…', '', function () { showMoveToGroupMenu(t, x, y); });
    addMenuItem(m, 'Export text…', '', function () { exportTermText(t); });
    addMenuItem(m, 'Find…', 'Ctrl+F', function () { focusTerm(t.id); if (p) openFind(p); });
    var sep = document.createElement('div'); sep.className = 'ofsep'; m.appendChild(sep);
    addMenuItem(m, 'Close', 'Alt+W', function () { if (p) askCloseTerm(p, t.id); });
    var ordered = groupTabsInOrder(t.groupId);
    var idx = ordered.indexOf(t);
    var toRight = idx >= 0 ? ordered.slice(idx + 1) : [];
    var others = ordered.filter(function (x) { return x !== t; });
    if (toRight.length) addMenuItem(m, 'Close tabs to the right', '', function () { bulkCloseTerms(toRight, 'Close ' + toRight.length + ' tab' + (toRight.length === 1 ? '' : 's') + ' to the right?'); });
    if (others.length) addMenuItem(m, 'Close other tabs', '', function () { bulkCloseTerms(others, 'Close ' + others.length + ' other tab' + (others.length === 1 ? '' : 's') + '?'); });
    addMenuItem(m, 'Close all tabs', '', function () { bulkCloseTerms(ordered.slice(), 'Close all ' + ordered.length + ' tab' + (ordered.length === 1 ? '' : 's') + ' in this group?'); });
    placeMenu(m, x, y);
  }

  // ---------------------------------------------------------- notifications
  var notifs = [];
  var notifSeq = 0;
  var npanel = document.getElementById('npanel');
  var notifBadge = document.getElementById('notif-badge');
  function notify(title, sub, termId) {
    notifs.unshift({ id: ++notifSeq, title: title, sub: sub || '', ts: Date.now(), unread: true, termId: termId || null });
    if (notifs.length > 60) notifs.length = 60;
    paintNotifBadge();
    if (npanel.hasAttribute('data-open')) renderNotif();
    maybeOsNotify(title, sub, termId);
  }
  // Reach Edward when WinMux isn't the window he's looking at. In-app badges are
  // invisible then; an OS notification is the whole point of an attention bus.
  // Only fires when the window is unfocused, the setting is on, and permission is
  // granted (asked once, silent no-op if denied). Works under Electron and the
  // web/phone path alike via the standard Notification API; click -> focus + jump.
  function maybeOsNotify(title, sub, termId) {
    try {
      if (S.osNotify === false) return;
      if (document.hasFocus()) return;           // he's already looking — the badge suffices
      if (typeof window.Notification === 'undefined') return;
      var fire = function () {
        try {
          var n = new window.Notification(String(title || 'WinMux'), { body: String(sub || ''), tag: 'winmux-' + (termId || 'x') });
          n.onclick = function () {
            try { window.focus(); var b = winBridge(); if (b && b.focus) b.focus(); } catch (e) {}
            if (termId != null) { var tj = termById(termId); if (tj) { var pj = paneById(tj.paneId) || paneById(activePaneId); if (pj) { activateTerm(pj, tj.id); focusPane(pj.id); } } }
          };
        } catch (e) {}
      };
      if (window.Notification.permission === 'granted') fire();
      else if (window.Notification.permission !== 'denied') { try { window.Notification.requestPermission().then(function (p) { if (p === 'granted') fire(); }); } catch (e) {} }
    } catch (e) {}
  }
  function unreadCount() { return notifs.filter(function (n) { return n.unread; }).length; }
  function paintNotifBadge() {
    var n = unreadCount();
    notifBadge.textContent = String(n);
    notifBadge.style.display = n ? 'flex' : 'none';
  }
  function ago(ts) {
    var s = Math.round((Date.now() - ts) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    return Math.round(s / 3600) + 'h ago';
  }
  function renderNotif() {
    var html = '<div class="nph">Notifications' + (notifs.length ? '<span class="nmark" data-notif-read>Mark all read</span>' : '') + '</div>';
    if (!notifs.length) html += '<div style="padding:16px 12px;color:var(--faint);font-size:12.5px">Nothing yet. Terminal bells and ended sessions show up here.</div>';
    notifs.forEach(function (n) {
      html += '<div class="nrow" data-notif="' + n.id + '"><span class="nu' + (n.unread ? '' : ' read') + '"></span>' +
        '<div class="nb"><div class="nws">' + esc(n.sub) + '</div><div class="nt">' + esc(n.title) + '</div><div class="ntm">' + ago(n.ts) + '</div></div></div>';
    });
    npanel.innerHTML = html;
  }
  function closeNotif() {
    npanel.removeAttribute('data-open');
    npanel.classList.remove('sheet', 'in');
    var bd = document.getElementById('notif-backdrop'); if (bd) bd.remove();
    // SB arc: on desktop the notifications live in a sidebar panel; closing them
    // hands the rail back to the last resting tab (Sessions or Projects).
    var aside = document.querySelector('.sessions');
    if (currentMode !== 'narrow' && aside && aside.getAttribute('data-sxtab') === 'notif') {
      setSidebarTab(S.sidebarTab === 'projects' ? 'projects' : 'sessions');
    }
  }
  function toggleNotif(btn) {
    if (npanel.hasAttribute('data-open')) { closeNotif(); return; }
    renderNotif();
    npanel.setAttribute('data-open', '');
    // On the phone the notifications open as a bottom sheet, not a popover under the bell.
    if (currentMode === 'narrow') {
      npanel.style.top = ''; npanel.style.left = '';
      npanel.classList.add('sheet');
      var bd = document.createElement('div'); bd.className = 'sheet-backdrop'; bd.id = 'notif-backdrop';
      bd.addEventListener('click', closeNotif);
      document.body.appendChild(bd);
      void npanel.offsetHeight; npanel.classList.add('in');
      return;
    }
    // SB arc: on desktop the bell IS the third sidebar tab — no floating popover.
    // A collapsed rail opens first so the panel has somewhere to appear.
    npanel.style.top = ''; npanel.style.left = '';
    if (root.getAttribute('data-sidebar') !== 'open') setSidebar('open');
    setSidebarTab('notif');
  }
  npanel.addEventListener('click', function (e) {
    var mark = e.target.closest ? e.target.closest('[data-notif-read]') : null;
    if (mark) { notifs.forEach(function (n) { n.unread = false; }); paintNotifBadge(); renderNotif(); return; }
    var row = e.target.closest ? e.target.closest('[data-notif]') : null;
    if (!row) return;
    var id = parseInt(row.getAttribute('data-notif'), 10);
    var n = null; notifs.forEach(function (x) { if (x.id === id) n = x; });
    if (n) { n.unread = false; paintNotifBadge(); if (n.termId) focusTerm(n.termId); }
    closeNotif();
  });
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // ----------------------------------------------------------------- groups
  // The side of the app is groups; the top of the app is one group's terminals.
  // A group is just a name — not a folder, not a repo, not a path. You make one,
  // you name it, and the terminals you open while it is selected belong to it.
  var groups = [];
  var activeGroupId = null;
  var groupSeq = 0;
  var expandedGroups = {};
  function loadGroups() {
    try {
      var raw = JSON.parse(localStorage.getItem('ct-groups') || 'null');
      if (raw && raw.groups && raw.groups.length) {
        groups = raw.groups.map(function (g) {
          var id = parseInt(g.id, 10) || 0;
          if (id > groupSeq) groupSeq = id;
          return { id: id, name: String(g.name || 'Group'), pinned: !!g.pinned };
        }).filter(function (g) { return g.id > 0; });
      }
    } catch (e) {}
    if (!groups.length) groups = [{ id: ++groupSeq, name: 'Workspace', pinned: false }];
    var want = null;
    try { want = parseInt(JSON.parse(localStorage.getItem('ct-groups') || '{}').active, 10); } catch (e) {}
    activeGroupId = groups.some(function (g) { return g.id === want; }) ? want : groups[0].id;
  }
  function saveGroups() {
    try { localStorage.setItem('ct-groups', JSON.stringify({ groups: groups, active: activeGroupId })); } catch (e) {}
  }
  function groupById(id) { for (var i = 0; i < groups.length; i++) if (groups[i].id === id) return groups[i]; return null; }
  function termsOfGroup(gid) { var out = []; eachTerm(function (t) { if (t.groupId === gid) out.push(t); }); return out; }
  // Every place that asks "what is in this pane" means "what is in this pane
  // right now, in the open group".
  function visibleTerms(p) { return p.terms.filter(function (t) { return t.groupId === activeGroupId; }); }
  function sortGroups() {
    groups.sort(function (a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0); });
  }
  loadGroups();

  // ---------------------------------------------------------------- sidebar
  function totalTerms() { return panes.reduce(function (n, p) { return n + p.terms.length; }, 0); }
  function dotClass(t) { return t.status === 'closed' ? 'error' : (t.status === 'needsyou' ? 'needsyou' : (t.status === 'working' ? 'working' : 'idle')); }
  function termName(t) { return t.tabEl ? t.tabEl.querySelector('.tt').textContent : labelFor(t.shell); }
  function statusLine(t) {
    if (t.offline && t.state === 'reconnecting') return 'Offline — retrying';
    if (t.state === 'reconnecting') return 'Reconnecting…';
    if (t.status === 'closed' || t.state === 'closed') return 'Session ended';
    if (t.status === 'needsyou') return 'Needs you';
    if (t.status === 'working') return 'Working';
    return 'Idle';
  }
  function statusTone(t) {
    if (t.status === 'needsyou' || t.status === 'closed') return 'hot';
    return t.status === 'working' ? 'work' : 'mut';
  }
  // "What's it doing" — the most recent meaningful output line of a session, shown
  // live on its sidebar row so a busy agent reads differently from a stuck one
  // without opening it. Reading the buffer on every byte is wasteful, so the capture
  // is throttled to ~1/sec; the row is patched in place (never a full re-render), so
  // a session that is scrolling fast never steals focus or churns the whole deck.
  function lastLiveLine(term) {
    try {
      var buf = term.buffer.active;
      var end = buf.baseY + buf.cursorY;
      for (var y = end; y >= 0 && y > end - 200; y--) {
        var ln = buf.getLine(y);
        if (!ln) continue;
        var s = ln.translateToString(true);
        if (s && s.trim()) return s.trim().slice(0, 200);
      }
    } catch (e) {}
    return '';
  }
  function updateDoing(t) {
    if (!sxList) return;
    var row = sxList.querySelector('.srow[data-term="' + t.id + '"]');
    if (!row) return;
    var info = row.querySelector('.sinfo');
    if (!info) return;
    var el = row.querySelector('.sdoing');
    if (!el) { el = document.createElement('div'); el.className = 'sdoing mono'; info.appendChild(el); }
    el.textContent = t.lastLine || '';
    el.title = t.lastLine || '';
  }
  function captureDoing(t) {
    if (!t || !t.term) return '';
    var line = lastLiveLine(t.term);
    if (line && line !== t.lastLine) { t.lastLine = line; updateDoing(t); }
    return t.lastLine || '';
  }
  function scheduleDoing(t) {
    if (t.doingPending) return;
    t.doingPending = true;
    setTimeout(function () { t.doingPending = false; captureDoing(t); }, 900);
  }
  // Observability hook (mirrors __winmuxActiveTerm): run the real capture now,
  // bypassing only the throttle timer, so the harness can prove a row reflects the
  // latest output deterministically.
  window.__winmuxCaptureDoing = function () { var n = 0; eachTerm(function (t) { if (captureDoing(t)) n++; }); return n; };
  // SP-5 observability hook: flip one terminal's status and report how long the
  // repaint work took, so the harness can prove a fleet tick costs O(row), not
  // O(sidebar), at any scale.
  window.__winmuxFleetTick = function () {
    var t = null; eachTerm(function (x) { if (!t) t = x; });
    if (!t) return -1;
    var t0 = performance.now();
    setStatus(t, t.status === 'working' ? 'idle' : 'working');
    return performance.now() - t0;
  };
  // A full path eats the row; the folder you are standing in is the useful part.
  function tailPath(cwd) {
    if (!cwd) return '';
    var parts = String(cwd).replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] || cwd;
  }
  // One session row inside an expanded group.
  function srowHTML(t, on) {
    return '<div class="srow"' + (on ? ' data-active' : '') + ' data-term="' + t.id + '">' +
      '<span class="dot ' + dotClass(t) + '"></span>' +
      '<div class="sinfo">' +
      '<div class="srtop"><span class="sname mono">' + esc(termName(t)) + '</span>' +
      (t.resume ? '<span class="sresume" title="Auto-resumes conversation ' + esc(t.resumeId || '?') + ' on reopen — ' + esc(t.resume) + '" aria-label="Auto-resume armed">↻</span>' : '') +
      '</div>' +
      '<div class="sstat ' + statusTone(t) + '">' + statusLine(t) +
      (t.cwd ? ' · <span class="m2">' + esc(tailPath(t.cwd)) + '</span>' : '') + '</div>' +
      (t.status === 'working' ? '<div class="sbar"><i style="width:' + Math.round(t.prog || 8) + '%"></i></div>' : '') +
      (t.lastLine ? '<div class="sdoing mono" title="' + esc(t.lastLine) + '">' + esc(t.lastLine) + '</div>' : '') +
      '</div>' +
      (t.status === 'needsyou' ? '<span class="sapprove" data-approve="' + t.id + '" role="button" tabindex="0" title="Approve — send Enter to continue" aria-label="Approve">Approve</span>' : '') +
      '<span class="speye" data-eye="' + t.id + '" role="button" tabindex="0" title="Preview session" aria-label="Preview session">' + EYE_SVG + '</span>' +
      '</div>';
  }
  // The group's own dot: the worst thing happening inside it.
  function groupStatus(ts) {
    var st = 'idle';
    for (var i = 0; i < ts.length; i++) {
      if (ts[i].status === 'needsyou' || ts[i].status === 'closed') return 'needsyou';
      if (ts[i].status === 'working') st = 'working';
    }
    return st;
  }
  // The group header's live half: "N sessions · 2 needs you" — everything on the
  // line that a status change can move.
  function groupSub(ts) {
    var need = ts.filter(function (t) { return t.status === 'needsyou' || t.status === 'closed'; }).length;
    var work = ts.filter(function (t) { return t.status === 'working'; }).length;
    var n = ts.length;
    return n + ' session' + (n === 1 ? '' : 's') + ' · ' +
      (need ? '<span class="hot">' + need + ' needs you</span>' : (work ? work + ' working' : 'idle'));
  }
  // The deck is a fleet gauge — it counts every terminal in every group, so a
  // "needs you" in a group you are not looking at still reaches you.
  function renderDeck() {
    var counts = { working: 0, needsyou: 0, idle: 0 };
    eachTerm(function (t) {
      if (t.status === 'working') counts.working++;
      else if (t.status === 'needsyou' || t.status === 'closed') counts.needsyou++;
      else counts.idle++;
    });
    // A zero counter still reads as loud as a three, so the eye lands on nothing
    // in particular. Mark the empty ones and let the CSS quiet them down.
    [['d-work', counts.working], ['d-need', counts.needsyou], ['d-idle', counts.idle]]
      .forEach(function (pair) {
        var el = document.getElementById(pair[0]);
        el.textContent = String(pair[1]);
        var box = el.parentElement;
        if (pair[1]) box.removeAttribute('data-zero'); else box.setAttribute('data-zero', '');
      });
    if (countEl) countEl.textContent = String(groups.length);
    var c2 = document.getElementById('sx-count2');
    if (c2) c2.textContent = String(groups.length);
    var live = document.getElementById('nhead-live');
    if (live) { var n2 = totalTerms(); live.textContent = n2 + ' running'; }
  }
  function renderSidebar() {
    var html = '';
    groups.forEach(function (g) {
      var ts = termsOfGroup(g.id);
      var n = ts.length;
      var open = !!expandedGroups[g.id];
      html += '<div class="prow" data-switch="' + g.id + '"' + (g.id === activeGroupId ? ' data-active' : '') + '>' +
        '<span class="pfolder">' + FOLDER_SVG + '<span class="pdot" style="background:' + (STATUS_COLOR[groupStatus(ts)] || 'transparent') + '"></span></span>' +
        '<div class="pinfo"><div class="pname">' + (g.pinned ? PPIN_SVG : '') + esc(g.name) + '</div><div class="psub">' + groupSub(ts) + '</div></div>' +
        '<span class="ptrail"><span class="pexpand" data-expand="' + g.id + '"' + (open ? ' data-open2' : '') +
        ' title="' + (open ? 'Hide sessions' : 'Show sessions') + '">' + CARET_RIGHT_SVG + '</span></span>' +
        '</div>';
      if (open) {
        html += '<div class="skids">' + (n
          ? ts.map(function (t) {
            var p = paneById(t.paneId);
            return srowHTML(t, !!p && p.activeTermId === t.id && p.id === activePaneId && g.id === activeGroupId);
          }).join('')
          : '<div class="srow"><div class="sinfo"><div class="sstat mut">No terminals in this group</div></div></div>') + '</div>';
      }
    });
    sxList.innerHTML = html;
    renderDeck();
    renderNarrowSessions();
  }
  // SP-5 (speed arc): a status flap touches ONE session, so it repaints one row —
  // its srow, its group's header line, the deck counters, and its narrow card —
  // never the whole sidebar. Same HTML generators as renderSidebar, so the patch
  // path can't drift from the full-render path. Anything structural (rows added,
  // removed, regrouped) still goes through renderSidebar.
  function renderRow(t) {
    if (!sxList) return;
    var g = groupById(t.groupId);
    var prow = g && sxList.querySelector('.prow[data-switch="' + g.id + '"]');
    if (!prow) { renderSidebar(); return; }   // structure moved under us — full pass
    var ts = termsOfGroup(g.id);
    var pd = prow.querySelector('.pdot');
    if (pd) pd.style.background = STATUS_COLOR[groupStatus(ts)] || 'transparent';
    var psub = prow.querySelector('.psub');
    if (psub) psub.innerHTML = groupSub(ts);
    var row = sxList.querySelector('.srow[data-term="' + t.id + '"]');
    if (row) {
      var p = paneById(t.paneId);
      var eye = row.classList.contains('eye-on');
      row.outerHTML = srowHTML(t, !!p && p.activeTermId === t.id && p.id === activePaneId && g.id === activeGroupId);
      if (eye) {
        var nr = sxList.querySelector('.srow[data-term="' + t.id + '"]');
        if (nr) nr.classList.add('eye-on');
      }
    }
    renderDeck();
    var nc = document.querySelector('#ns-list .ncard[data-open="' + t.id + '"]');
    if (nc && g.id === activeGroupId) nc.outerHTML = ncardHTML(t);
  }
  sxList.addEventListener('click', function (e) {
    var appr = e.target.closest ? e.target.closest('[data-approve]') : null;
    if (appr) { e.stopPropagation(); approveTerm(parseInt(appr.getAttribute('data-approve'), 10)); return; }
    var eye = e.target.closest ? e.target.closest('[data-eye]') : null;
    if (eye) { e.stopPropagation(); openPreview(parseInt(eye.getAttribute('data-eye'), 10)); return; }
    var ex = e.target.closest ? e.target.closest('[data-expand]') : null;
    if (ex) {
      // Peeking into a group must not switch to it.
      e.stopPropagation();
      var gid = parseInt(ex.getAttribute('data-expand'), 10);
      expandedGroups[gid] = !expandedGroups[gid];
      renderSidebar();
      return;
    }
    var srow = e.target.closest ? e.target.closest('.srow[data-term]') : null;
    if (srow) { focusTerm(parseInt(srow.getAttribute('data-term'), 10)); return; }
    var row = e.target.closest ? e.target.closest('[data-switch]') : null;
    if (row) switchGroup(parseInt(row.getAttribute('data-switch'), 10));
  });
  // ── Session preview panel (eyeball) ──────────────────────────────────────
  // A summoned detail panel: hover a row, click the eyeball, get a calm
  // overview of that session. Rich fields (context window, tokens, tool-call
  // payloads, timeline) light up once the agent engine feeds them; today it
  // shows what the fleet already knows and offers Open to jump in.
  var previewEl = null, previewTermId = null;
  function previewNode() {
    if (previewEl) return previewEl;
    previewEl = document.createElement('div');
    previewEl.className = 'sxpv';
    document.body.appendChild(previewEl);
    previewEl.addEventListener('click', function (e) {
      var act = e.target.closest ? e.target.closest('[data-pv]') : null;
      if (!act) return;
      var k = act.getAttribute('data-pv');
      if (k === 'close') closePreview();
      else if (k === 'approve' && previewTermId != null) approveTerm(previewTermId);
      else if (k === 'deny' && previewTermId != null) denyTerm(previewTermId);
      else if (k === 'open' && previewTermId != null) { var id = previewTermId; closePreview(); focusTerm(id); }
    });
    return previewEl;
  }
  function previewHTML(t) {
    var g = groupById(t.groupId) || {};
    var stat = statusLine(t), tone = statusTone(t);
    var chip = tone === 'hot' ? 'hot' : (tone === 'work' ? 'work' : 'mut');
    var sub = esc(g.name || 'Session') + ' · ' + esc(leafKind(t));
    var primary;
    if (t.status === 'needsyou') {
      // The phone approval card (Phase 8, Option-B direction): lead with the plain
      // decision, then the ACTUAL prompt so approving is a real choice, not a blind
      // Enter. We only render data we truly have — the terminal screen, status, cwd.
      // A parsed diff / test-count panel needs structured signals the agent doesn't
      // emit yet, so we don't fake one here.
      var scr = serializeTerm(t, 14);
      var ask = scr
        ? '<div class="pv-ask">This session paused and needs your OK. Here’s what it’s asking:</div><pre class="pv-screen mono">' + esc(scr) + '</pre>'
        : '<div class="pv-ask">This session rang for your attention and is waiting on you.</div>';
      primary = '<div class="pv-primary hot"><div class="pv-lbl">Needs your OK</div>' + ask +
        '<div class="pv-acts">' +
        '<button class="btn primary pv-btn pv-approve" data-pv="approve">Approve</button>' +
        '<button class="btn pv-btn pv-reject" data-pv="deny">Reject</button>' +
        '</div>' +
        '<div class="pv-hint">Approve sends Enter to continue · Reject sends Esc to cancel · or Open to type a full reply</div></div>';
    } else if (t.status === 'closed') {
      primary = '<div class="pv-primary hot"><div class="pv-lbl">Session ended</div>' +
        '<div class="pv-ask">This session has closed.</div>' +
        '<button class="btn primary pv-btn" data-pv="open">Open</button></div>';
    } else if (t.status === 'working') {
      primary = '<div class="pv-primary"><div class="pv-lbl">Now</div>' +
        '<div class="pv-now">Working…</div>' +
        '<div class="pv-bar"><i style="width:' + Math.round(t.prog || 8) + '%"></i></div></div>';
    } else {
      primary = '<div class="pv-primary"><div class="pv-lbl">Now</div><div class="pv-now">Idle — waiting for a command.</div></div>';
    }
    var rows = [['Status', esc(stat)]];
    if (t.cwd) rows.push(['Directory', esc(t.cwd), true]);
    var meta = '<div class="pv-lbl">Details</div><div class="pv-meta">' +
      rows.map(function (r) { return '<div class="pv-m"><span class="k">' + r[0] + '</span><span class="v' + (r[2] ? ' mono' : '') + '">' + r[1] + '</span></div>'; }).join('') +
      '</div>';
    return '<div class="pv-nbar"><span class="pv-back" data-pv="close" role="button" tabindex="0" aria-label="Back to sessions">' + BACK_SVG + '<span>Sessions</span></span></div>' +
      '<div class="pv-scroll">' +
      '<div class="pv-head"><div class="pv-id"><span class="pv-name">' + esc(termName(t)) + '</span>' +
      '<span class="pv-chip ' + chip + '">' + esc(stat) + '</span>' +
      '<span class="pv-x" data-pv="close" role="button" tabindex="0" title="Close" aria-label="Close preview">' + XCLOSE_SVG + '</span></div>' +
      '<div class="pv-sub">' + sub + '</div></div>' +
      primary + meta + '</div>' +
      '<div class="pv-foot"><button class="btn wide" data-pv="open">Open session</button></div>';
  }
  function positionPreview() {
    if (!previewEl) return;
    var narrow = root.getAttribute('data-mode') === 'narrow';
    previewEl.classList.toggle('narrow', narrow);
    if (narrow) { previewEl.style.left = '0px'; previewEl.style.width = '100%'; return; }
    var sb = document.querySelector('.sessions');
    var left = sb ? Math.round(sb.getBoundingClientRect().right) : 264;
    previewEl.style.left = left + 'px';
    previewEl.style.width = '';
  }
  function openPreview(id) {
    var t = termById(id); if (!t) return;
    previewTermId = id;
    var el = previewNode();
    el.innerHTML = previewHTML(t);
    positionPreview();
    el.classList.add('on');
    [].forEach.call(sxList.querySelectorAll('.srow.eye-on'), function (r) { r.classList.remove('eye-on'); });
    var row = sxList.querySelector('.srow[data-term="' + id + '"]');
    if (row) row.classList.add('eye-on');
  }
  function closePreview() {
    previewTermId = null;
    if (previewEl) previewEl.classList.remove('on');
    [].forEach.call(sxList.querySelectorAll('.srow.eye-on'), function (r) { r.classList.remove('eye-on'); });
  }
  // U4 — clear a "needs you" session without switching into it. We send the key
  // a person would press: Enter accepts the highlighted default (a Claude Code
  // permission prompt lands on Yes), Esc cancels/denies. It's their own terminal —
  // exactly the input they'd type, just reachable from the fleet view.
  function respondTerm(id, data, kind) {
    var t = termById(id);
    if (!t) return;
    var ok = !!(t.ws && t.ws.readyState === WebSocket.OPEN);
    if (ok) t.ws.send(JSON.stringify({ t: 'i', d: data }));
    notify(
      ok ? (kind === 'deny' ? 'Denied — ' : 'Approved — ') + termName(t) : 'Could not reach ' + termName(t),
      ok ? (kind === 'deny' ? 'Sent Esc to cancel.' : 'Sent Enter to continue.') : 'That session is not connected.',
      id
    );
    if (!ok) return;
    // It is no longer waiting on you; normal output will re-derive its state.
    if (t.status === 'needsyou') setStatus(t, 'idle');
    // Refresh the panel in place if it is open on this session.
    if (previewTermId === id && previewEl && previewEl.classList.contains('on')) openPreview(id);
  }
  function approveTerm(id) { respondTerm(id, '\r', 'approve'); }
  function denyTerm(id) { respondTerm(id, '\x1b', 'deny'); }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && previewEl && previewEl.classList.contains('on')) closePreview();
  });
  document.addEventListener('mousedown', function (e) {
    if (!previewEl || !previewEl.classList.contains('on')) return;
    if (previewEl.contains(e.target)) return;
    if (e.target.closest && e.target.closest('[data-eye]')) return;
    closePreview();
  });
  window.addEventListener('resize', positionPreview);
  sxList.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var appr = e.target.closest ? e.target.closest('[data-approve]') : null;
    if (appr) { e.preventDefault(); approveTerm(parseInt(appr.getAttribute('data-approve'), 10)); return; }
    var eye = e.target.closest ? e.target.closest('[data-eye]') : null;
    if (eye) { e.preventDefault(); openPreview(parseInt(eye.getAttribute('data-eye'), 10)); }
  });
  sxList.addEventListener('contextmenu', function (e) {
    var srow = e.target.closest ? e.target.closest('.srow[data-term]') : null;
    if (srow) {
      e.preventDefault();
      var t = termById(parseInt(srow.getAttribute('data-term'), 10));
      if (t) showSessionMenu(t, e.clientX, e.clientY);
      return;
    }
    var row = e.target.closest ? e.target.closest('[data-switch]') : null;
    if (!row) return;
    e.preventDefault();
    var g = groupById(parseInt(row.getAttribute('data-switch'), 10));
    if (g) showGroupMenu(g, e.clientX, e.clientY);
  });

  // On a phone the sidebar can only show one level at a time, so the group list
  // and the session list are two screens. This is the middle one.
  function renderNarrowSessions() {
    var list = document.getElementById('ns-list');
    if (!list) return;
    var g = groupById(activeGroupId);
    var nameEl = document.getElementById('ns-name');
    if (nameEl) nameEl.textContent = g ? g.name : '';
    // Header B: keep the brand-bar context name in sync while the session list is showing.
    if (root.getAttribute('data-view') === 'sessions') {
      var ctxNm = document.getElementById('nhead-ctx-name');
      if (ctxNm) ctxNm.textContent = g ? g.name : '';
    }
    var ts = termsOfGroup(activeGroupId);
    list.innerHTML = ts.length
      ? ts.map(ncardHTML).join('')
      : '<div class="ncard"><div class="sb"><div class="preview">No terminals in this group yet.</div></div></div>';
  }
  // One session card on the phone's session screen (shared by the full render
  // above and the SP-5 single-row patch).
  function ncardHTML(t) {
    var attn = t.status === 'needsyou' || t.status === 'closed';
    // An unrenamed terminal is already named after its shell, so printing the
    // shell again on the same line just reads "PowerShell   PowerShell".
    var nm = termName(t), kind = leafKind(t);
    return '<div class="ncard' + (attn ? ' attn' : '') + '" data-open="' + t.id + '">' +
      '<span class="dot ' + dotClass(t) + ' sd"></span>' +
      '<div class="sb"><div class="r1">' +
      '<span class="nm mono">' + esc(nm) + '</span>' +
      (kind === nm ? '' : '<span class="tm">' + esc(kind) + '</span>') + '</div>' +
      '<div class="preview">' + statusLine(t) + (t.cwd ? ' · ' + esc(t.cwd) : '') + '</div>' +
      '</div>' +
      (t.status === 'needsyou' ? '<span class="sapprove nc" data-approve="' + t.id + '" role="button" tabindex="0" title="Approve — send Enter to continue" aria-label="Approve">Approve</span>' : '') +
      '<span class="speye nceye" data-eye="' + t.id + '" role="button" tabindex="0" title="Preview session" aria-label="Preview session">' + EYE_SVG + '</span>' +
      '<span class="nchev">' + CARET_RIGHT_SVG + '</span></div>';
  }

  // Clicking a group swaps the top tab strip to that group's terminals. This is
  // the whole two-level model in one function.
  function switchGroup(gid) {
    if (!groupById(gid)) return;
    if (gid !== activeGroupId) {
      activeGroupId = gid;
      saveGroups();
      applyGroupVisibility();
    }
    if (currentMode === 'narrow') setView('sessions');
  }
  function applyGroupVisibility() {
    panes.forEach(function (p) {
      p.terms.forEach(function (t) { t.tabEl.style.display = t.groupId === activeGroupId ? '' : 'none'; });
    });
    // Done in a second pass: newTerm() below can add to a pane while we iterate.
    panes.slice().forEach(function (p) {
      var vis = visibleTerms(p);
      // A pane with nothing to show in this group would be an empty frame, so it
      // gets a shell instead.
      if (!vis.length) { newTerm(p, startShell()); return; }
      var keep = null;
      for (var i = 0; i < p.mru.length && !keep; i++) {
        for (var j = 0; j < vis.length; j++) if (vis[j].id === p.mru[i]) { keep = vis[j]; break; }
      }
      activateTerm(p, (keep || vis[0]).id);
    });
    updateChrome();
    layoutAllTabs();
    setTimeout(function () { panes.forEach(fitActive); }, 30);
  }
  function newGroup(name) {
    var g = { id: ++groupSeq, name: String(name || 'Group ' + (groups.length + 1)), pinned: false };
    groups.push(g);
    sortGroups();
    saveGroups();
    switchGroup(g.id);
    return g;
  }
  function showGroupMenu(g, x, y) {
    var m = newMenu();
    var head = document.createElement('div');
    head.className = 'ctxlabel'; head.textContent = g.name;
    m.appendChild(head);
    addMenuItem(m, 'Open group', '', function () { switchGroup(g.id); });
    addMenuItem(m, 'New terminal here', 'Alt+T', function () {
      switchGroup(g.id);
      var p = paneById(activePaneId) || panes[0];
      if (p) { newTerm(p, startShell()); focusPane(p.id); }
    });
    addMenuItem(m, 'Rename…', '', function () {
      promptDialog('Rename group', g.name, 'Rename', function (name) {
        g.name = name; saveGroups(); renderSidebar();
      });
    });
    addMenuItem(m, g.pinned ? 'Unpin' : 'Pin to top', '', function () {
      g.pinned = !g.pinned; sortGroups(); saveGroups(); renderSidebar();
    });
    if (groups.length > 1) {
      addMenuItem(m, 'Close group', '', function () { askCloseGroup(g); });
    }
    placeMenu(m, x, y);
  }
  function askCloseGroup(g) {
    if (groups.length < 2) return;
    var ts = termsOfGroup(g.id);
    var live = ts.filter(function (t) { return t.state === 'open'; }).length;
    function go() { closeGroup(g); }
    if (live) {
      confirmDialog('Close “' + g.name + '”?',
        live === 1 ? 'The shell running in its terminal will be ended.'
          : 'The ' + live + ' shells running in its terminals will be ended.',
        'Close group', go);
      return;
    }
    go();
  }
  function closeGroup(g) {
    if (groups.length < 2) return;
    // Leave the group before emptying it. Closing the last terminal of the *open*
    // group hands the pane a fresh shell (that is what keeps a pane from going
    // blank), which would fight us the whole way down this list.
    if (g.id === activeGroupId) {
      var next = null;
      groups.forEach(function (x) { if (!next && x.id !== g.id) next = x; });
      activeGroupId = next.id;
      applyGroupVisibility();
    }
    termsOfGroup(g.id).forEach(function (t) {
      var p = paneById(t.paneId);
      if (p) closeTerm(p, t.id);
    });
    var i = groups.indexOf(g);
    if (i >= 0) groups.splice(i, 1);
    delete expandedGroups[g.id];
    saveGroups();
    renderSidebar();
  }

  function termById(id) { var f = null; eachTerm(function (t) { if (t.id === id) f = t; }); return f; }
  function focusTerm(id) {
    var t = termById(id); if (!t) return;
    var p = paneById(t.paneId); if (!p) return;
    // Reaching a terminal in another group means going to that group first.
    if (t.groupId !== activeGroupId) switchGroup(t.groupId);
    clearZoom();
    focusPane(p.id);
    activateTerm(p, id);
    // On a phone the list and the terminal are two screens — picking one opens it.
    if (currentMode === 'narrow') setView('focus');
  }

  // --------------------------------------------------------- pane machinery
  function updateChrome() {
    var multi = panes.length > 1;
    panes.forEach(function (p, i) {
      p.closeBtn.style.display = multi ? 'flex' : 'none';
      p.zoomBtn.style.display = multi ? 'flex' : 'none';
      p.railBtn.style.display = i === 0 ? 'flex' : 'none';
      p.dockBtn.style.display = i === panes.length - 1 ? 'flex' : 'none';
    });
    placeWinctl();
    renderSidebar();
  }
  // The window frame's min/max/close sit at the extreme top-right of the title row —
  // the last pane's control cluster (the #127 inline-on-rightmost-pane pattern).
  function placeWinctl() {
    var wc = document.getElementById('winctl');
    if (!wc || !panes.length) return;
    var last = panes[panes.length - 1];
    var host = last.dockBtn ? last.dockBtn.parentNode : null;
    if (host && wc.parentNode !== host) host.appendChild(wc);
  }
  function clearZoom() {
    wsrow.classList.remove('zoomed');
    [].forEach.call(wsrow.querySelectorAll('.wscol'), function (c) { c.classList.remove('zoom-col'); });
    panes.forEach(function (p) { p.el.classList.remove('zoom-on'); if (p.zoomBtn) p.zoomBtn.classList.remove('on'); });
  }
  function toggleZoom(p) {
    var on = p.el.classList.contains('zoom-on');
    clearZoom();
    if (!on) { wsrow.classList.add('zoomed'); if (p.col) p.col.classList.add('zoom-col'); p.el.classList.add('zoom-on'); p.zoomBtn.classList.add('on'); }
    panes.forEach(fitActive);
  }
  function activeTermOf(p) { for (var i = 0; i < p.terms.length; i++) if (p.terms[i].id === p.activeTermId) return p.terms[i]; return null; }
  function activeTerm() { var p = paneById(activePaneId); return p ? activeTermOf(p) : null; }
  window.__winmuxActiveTerm = activeTerm;   // observability hook (harness reads addon state)
  function sendResize(t) {
    if (!(t.ws && t.ws.readyState === WebSocket.OPEN)) return;
    // Skip a no-op resize. Every tab switch re-fits and calls sendResize, but the
    // pane size usually hasn't changed — and telling the shell it "resized" to the
    // same dimensions still makes PowerShell repaint its prompt. That redraw arrives
    // as output, which markWorking reads as activity and flashes the orange "working"
    // bar on every switch (a false alarm). Only notify the shell on a real size change;
    // ws.onopen clears the memo so a (re)connect always sends the current size.
    if (t._sentCols === t.term.cols && t._sentRows === t.term.rows) return;
    t._sentCols = t.term.cols; t._sentRows = t.term.rows;
    t.ws.send(JSON.stringify({ t: 'r', c: t.term.cols, r: t.term.rows }));
  }
  // Closing a tab on purpose is the one close that should take the shell with it.
  // Every other disconnect is treated as an interruption and waited out, so this
  // has to say so explicitly — otherwise a closed tab parks a live PowerShell on
  // the machine for the length of the grace window.
  function killShell(t) {
    t.closing = true;
    try { if (t.ws && t.ws.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify({ t: 'x' })); } catch (e) {}
    try { if (t.ws) t.ws.close(); } catch (e) {}
  }
  function fitActive(p) { var t = activeTermOf(p); if (t && t.fit) { try { t.fit.fit(); } catch (e) {} sendResize(t); resyncRenderer(t.term); } }
  function setFontSize(px) {
    px = Math.max(8, Math.min(28, px));
    if (px === S.fontSize) return;
    S.fontSize = px;
    applySettings();
  }

  function openFind(p) { if (!p.findbar) return; p.findbar.classList.add('on'); p.findInput.focus(); p.findInput.select(); updateFindCount(p); }
  function closeFind(p) {
    if (!p.findbar) return;
    p.findbar.classList.remove('on');
    var t = activeTermOf(p);
    if (t) { try { t.search.clearDecorations && t.search.clearDecorations(); } catch (e) {} t.term.focus(); }
  }
  function doFind(p, dir, incremental) {
    var t = activeTermOf(p); if (!t) return;
    var q = p.findInput.value;
    if (!q) { p.findCount.textContent = ''; return; }
    try {
      if (dir === 'prev') t.search.findPrevious(q, { incremental: !!incremental, decorations: FIND_DECOR });
      else t.search.findNext(q, { incremental: !!incremental, decorations: FIND_DECOR });
    } catch (e) { console.error('find failed:', e && e.message); }
  }
  var FIND_DECOR = { matchOverviewRuler: '#8a5cf5', activeMatchColorOverviewRuler: '#8a5cf5', matchBackground: 'rgba(138,92,245,.28)', activeMatchBackground: 'rgba(138,92,245,.65)' };
  function updateFindCount(p) {
    var t = activeTermOf(p);
    if (!t || !t.results) { p.findCount.textContent = ''; return; }
    p.findCount.textContent = t.results.count ? (t.results.index + 1) + '/' + t.results.count : (p.findInput.value ? '0/0' : '');
  }

  function reflect(p) {
    var t = activeTermOf(p);
    var s = t ? t.state : 'idle';
    // A reconnect that has been failing for a few seconds stops calling itself
    // "reconnecting…" and says "offline" — honest, and it keeps retrying underneath.
    var offline = !!(t && t.offline && s === 'reconnecting');
    var vis = offline ? 'offline' : (s === 'open' ? 'open' : (s === 'closed' ? 'closed' : (s === 'reconnecting' ? 'reconnecting' : 'idle')));
    p.pill.setAttribute('data-state', vis);
    p.connText.textContent = vis === 'offline' ? 'offline — retrying'
      : (s === 'open' ? 'connected'
      : (s === 'closed' ? 'disconnected' : (s === 'reconnecting' ? 'reconnecting…' : 'connecting…')));
  }
  function focusPane(id) {
    activePaneId = id;
    panes.forEach(function (p) { if (p.id === id) p.el.classList.add('focused'); else p.el.classList.remove('focused'); });
    var p = paneById(id);
    if (p) {
      reflect(p);
      var t = activeTermOf(p);
      // A non-terminal leaf (markdown / browser / diff) has no .term, so guard the
      // focus call — clicking back to it must not throw and strand the pane.
      if (t) { if (t.term) t.term.focus(); if (t.status === 'needsyou') setStatus(t, 'idle'); }
    }
    renderSidebar();
  }
  function paneById(id) { for (var i = 0; i < panes.length; i++) if (panes[i].id === id) return panes[i]; return null; }

  function activateTerm(p, termId, cycling) {
    p.activeTermId = termId;
    p.terms.forEach(function (t) {
      var on = t.id === termId;
      t.host.style.display = on ? 'block' : 'none';
      if (on) t.tabEl.setAttribute('data-active', ''); else t.tabEl.removeAttribute('data-active');
      if (on) {
        // Terminal leaves fit + focus the xterm; a non-terminal leaf (browser,
        // markdown) has no term — it shows its own body via onShow instead.
        if (t.term) {
          applyRenderer(t.term, true);
          if (t.term.__winmuxOptsDirty) applyTermOptions(t);   // settings changed while this tab was hidden
          try { t.fit.fit(); } catch (e) {} sendResize(t); resyncRenderer(t.term); t.term.focus();
        }
        else if (t.onShow) { try { t.onShow(); } catch (e) {} }
        if (t.status === 'needsyou') setStatus(t, 'idle');
      } else if (t.term) {
        applyRenderer(t.term, false);   // hidden — hand the WebGL context back
      }
    });
    if (!cycling) touchMru(p, termId);
    reflect(p);
    updateFindCount(p);
    layoutTabs(p);
    // Keep the C1 phone brand-bar name in sync when switching tabs.
    if (currentMode === 'narrow' && p.id === activePaneId) paintNbar(p);
    renderSidebar();
  }

  function askCloseTerm(p, termId) {
    if (!p) return;
    var t = termById(termId);
    // Only a terminal leaf warns before close — it has a live shell to end. A
    // browser/markdown/diff leaf has no process, so it closes without a prompt.
    if (S.confirmClose && t && t.state === 'open' && leafType(t) === 'terminal') {
      var name = t.tabEl.querySelector('.tt').textContent;
      confirmDialog('Close “' + name + '”?', 'The shell process running in this terminal will be ended.', 'Close terminal', function () { closeTerm(p, termId); });
      return;
    }
    closeTerm(p, termId);
  }
  function closeTerm(p, termId) {
    var idx = -1; for (var i = 0; i < p.terms.length; i++) if (p.terms[i].id === termId) { idx = i; break; }
    if (idx < 0) return;
    var t = p.terms[idx];
    // Only terminals go on the reopen stack for now — a reopened browser/markdown
    // leaf is ST6's job; recording one here would reopen it as a blank shell.
    if (leafType(t) === 'terminal') recordClosed(p, t);
    clearTimeout(t.busyTimer); stopProg(t);
    // A non-terminal leaf can hold a resource (markdown's live-update poll); let it
    // clean up before the host is torn down.
    if (t.onClose) { try { t.onClose(); } catch (e) {} }
    killShell(t);
    try { t.term.dispose(); } catch (e) {}
    t.host.remove(); t.tabEl.remove();
    p.terms.splice(idx, 1);
    var mi = p.mru.indexOf(termId); if (mi >= 0) p.mru.splice(mi, 1);
    // "Empty" means empty *of this group* — a pane still holding another group's
    // terminals is not empty, it is just not showing them.
    if (visibleTerms(p).length === 0) {
      // A pinned pane survives its last tab — it gets a fresh shell instead of disappearing.
      if (p.terms.length === 0 && panes.length > 1 && !p.pinned) { closePane(p); return; }
      newTerm(p, startShell()); updateChrome(); return;
    }
    if (p.activeTermId === termId) {
      var vis = visibleTerms(p);
      var nextId = null;
      for (var m = 0; m < p.mru.length && nextId == null; m++) {
        for (var j = 0; j < vis.length; j++) if (vis[j].id === p.mru[m]) { nextId = vis[j].id; break; }
      }
      if (nextId == null) nextId = vis[Math.min(idx, vis.length - 1)].id;
      activateTerm(p, nextId);
    }
    layoutTabs(p);
    updateChrome();
  }

  function setStatus(t, s) {
    if (t.status === s) return;
    t.status = s;
    // The tab's corner dot: hidden while idle, coloured by the mockup's own classes otherwise.
    if (t.dotEl) {
      t.dotEl.className = 'fdot' + (s === 'working' ? ' working' : (s === 'needsyou' ? ' needsyou' : (s === 'closed' ? ' error' : '')));
      t.dotEl.style.display = (s === 'idle') ? 'none' : 'block';
    }
    if (s !== 'working') stopProg(t);
    updateRings();
    layoutTabs(paneById(t.paneId));
    renderRow(t);
  }
  // The busy underline: a progress line that creeps toward full while output keeps arriving,
  // completes to 100% when the shell falls quiet, then clears.
  function stopProg(t) { clearInterval(t.progTimer); t.progTimer = null; }
  function markWorking(t) {
    if (t.progEl && !t.progTimer) {
      t.prog = 8;
      t.progEl.style.width = '8%';
      t.progTimer = setInterval(function () {
        t.prog += (92 - t.prog) * 0.12;
        t.progEl.style.width = t.prog.toFixed(1) + '%';
      }, 220);
    }
    if (t.status !== 'needsyou') setStatus(t, 'working');
    clearTimeout(t.busyTimer);
    t.busyTimer = setTimeout(function () {
      stopProg(t);
      if (t.progEl) t.progEl.style.width = '100%';
      setTimeout(function () { if (!t.progTimer && t.progEl) t.progEl.style.width = '0'; }, 320);
      if (t.status === 'working') setStatus(t, 'idle');
    }, 1200);
  }

  // ------------------------------------------------------------- tab layer
  // Which tabs are scrolled out of sight in this pane's tab strip.
  function hiddenTabs(p) {
    var sc = p.tabscroll, out = [];
    var l = sc.scrollLeft, r = l + sc.clientWidth;
    p.terms.forEach(function (t) {
      // A tab belonging to another group is hidden outright — it measures 0×0 at
      // offset 0, which would otherwise read as "scrolled out of sight".
      if (t.tabEl.style.display === 'none') return;
      var a = t.tabEl.offsetLeft, b = a + t.tabEl.offsetWidth;
      if (a < l - 1 || b > r + 1) out.push(t);
    });
    return out;
  }
  function layoutTabs(p) {
    if (!p || !p.ofBtn) return;
    var h = hiddenTabs(p);
    p.ofBtn.style.display = h.length ? 'flex' : 'none';
    p.ofCount.textContent = String(h.length);
    var needs = h.some(function (t) { return t.status === 'needsyou'; });
    p.ofDot.style.display = needs ? 'block' : 'none';
  }
  function layoutAllTabs() { panes.forEach(layoutTabs); }
  function showOverflowMenu(p) {
    var m = newMenu();
    var head = document.createElement('div');
    head.className = 'ctxlabel'; head.textContent = 'Hidden tabs';
    m.appendChild(head);
    hiddenTabs(p).forEach(function (t) {
      var item = document.createElement('div');
      item.className = 'ofmi';
      var nm = t.tabEl.querySelector('.tt').textContent;
      item.innerHTML = favHTML(t.shell) + '<span class="nm">' + esc(nm) + '</span>' +
        (t.status === 'needsyou' ? '<span class="kbd sm">needs you</span>' : '');
      item.addEventListener('click', function (e) { e.stopPropagation(); closeMenu(); activateTerm(p, t.id); scrollTabIntoView(p, t); });
      m.appendChild(item);
    });
    var r = p.ofBtn.getBoundingClientRect();
    placeMenu(m, r.right - 220, r.bottom + 4);
  }
  function scrollTabIntoView(p, t) {
    try { t.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
    layoutTabs(p);
  }

  // Most-recently-used order, per pane — what Ctrl+Tab walks.
  function touchMru(p, id) {
    if (!p) return;
    var i = p.mru.indexOf(id);
    if (i >= 0) p.mru.splice(i, 1);
    p.mru.unshift(id);
  }
  var cycleOrder = null, cycleIdx = -1;
  function cycleTab(dir) {
    var p = paneById(activePaneId);
    if (!p || p.terms.length < 2) return;
    if (!cycleOrder) {
      cycleOrder = p.mru.filter(function (id) { return p.terms.some(function (t) { return t.id === id; }); });
      p.terms.forEach(function (t) { if (cycleOrder.indexOf(t.id) < 0) cycleOrder.push(t.id); });
      cycleIdx = 0;
    }
    cycleIdx = (cycleIdx + dir + cycleOrder.length) % cycleOrder.length;
    activateTerm(p, cycleOrder[cycleIdx], true);
    var t = termById(cycleOrder[cycleIdx]);
    if (t) scrollTabIntoView(p, t);
  }
  function endCycle() {
    if (!cycleOrder) return;
    cycleOrder = null; cycleIdx = -1;
    var p = paneById(activePaneId);
    if (p && p.activeTermId != null) touchMru(p, p.activeTermId);
  }

  // Closing a tab is undoable: Ctrl+Shift+T brings the last one back.
  var closedStack = [];
  function recordClosed(p, t) {
    closedStack.push({
      paneId: p.id, shell: t.shell, cwd: t.cwd, resume: t.resume || null,
      resumeId: t.resumeId || null, resumePinnedByHand: !!t.resumePinnedByHand,
      name: t.renamed ? t.tabEl.querySelector('.tt').textContent : null,
    });
    if (closedStack.length > 20) closedStack.shift();
  }
  function reopenClosed() {
    var d = closedStack.pop();
    if (!d) return;
    var p = paneById(d.paneId) || paneById(activePaneId) || panes[0];
    if (!p) return;
    var t = newTerm(p, d.shell, d.cwd, null, d.resume || null, d.resumeId || null, d.resumePinnedByHand);
    if (d.name) { t.tabEl.querySelector('.tt').textContent = d.name; t.renamed = true; renderSidebar(); }
    focusPane(p.id);
  }

  function startRename(t) {
    var tabEl = t.tabEl;
    var ttEl = tabEl.querySelector('.tt');
    if (tabEl.querySelector('.tt-in')) return;
    var input = document.createElement('input');
    input.className = 'tt-in'; input.type = 'text';
    input.value = ttEl.textContent; input.spellcheck = false;
    ttEl.style.display = 'none';
    ttEl.parentNode.insertBefore(input, ttEl.nextSibling);
    input.focus(); input.select();
    var done = false;
    function commit(save) {
      if (done) return; done = true;
      if (save) { var v = input.value.trim(); if (v) { ttEl.textContent = v; t.renamed = true; } }
      input.remove(); ttEl.style.display = '';
      renderSidebar();
    }
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', function () { commit(true); });
    input.addEventListener('mousedown', function (e) { e.stopPropagation(); });
  }

  // ── Typed leaves (surfaces-as-tabs foundation) ──────────────────────────
  // A tab is a "leaf". Today every leaf is a terminal; these helpers let a leaf
  // also become a browser / markdown / diff surface in later units. Terminals
  // leave t.type undefined, so leafType() reports 'terminal' and every existing
  // path stays unchanged. Dormant until the tab render + newTerm are wired.
  function leafType(t) { return (t && t.type) || 'terminal'; }
  function leafTitle(t) {
    var k = leafType(t);
    if (k === 'browser') return t.url || 'Browser';
    if (k === 'markdown') return t.mdTitle || t.mdPath || 'Markdown';
    if (k === 'diff') return 'Diff';
    return termName(t);
  }
  function leafDot(t) {
    var k = leafType(t);
    if (k === 'browser') return 'browser';
    if (k === 'markdown' || k === 'diff') return 'idle';
    return (t && t.status) || 'idle';
  }
  function leafGlyph(t) {
    var k = leafType(t);
    if (k === 'browser') return '◆';   // ◆
    if (k === 'markdown') return '¶';   // ¶
    if (k === 'diff') return '±';       // ±
    return '>_';
  }
  // The human kind of a leaf, for the session lists (sidebar previews, the mobile
  // fleet cards). A non-terminal leaf has no shell, so labelFor(t.shell) falls back
  // to "Terminal" — a mislabel that read the same on a Markdown or Changes tab. Name
  // the surface instead; only a real terminal defers to its shell label.
  function leafKind(t) {
    var k = leafType(t);
    if (k === 'browser') return 'Browser';
    if (k === 'markdown') return 'Markdown';
    if (k === 'diff') return 'Changes';
    return labelFor(t && t.shell);
  }

  // Paint a dead session's kept scrollback back into a fresh terminal after a
  // restart, bracketed so it reads as history, not live output. Async (the server
  // holds it on disk); calls done() whether or not anything was found so the
  // caller's follow-up notice always prints. The saved bytes keep their own colours
  // — this is the real screen you left, boxed by dim rules above and below.
  function replayBacklog(sid, term, done) {
    if (!sid) { done(false); return; }
    fetch('/api/backlog?sid=' + encodeURIComponent(sid))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (o) {
        var did = !!(o && o.found && o.buf);
        if (did) {
          // Start clean, then replay the saved screen. The buf carries its own
          // leading clear/home, so a header written ABOVE it gets wiped — the
          // divider goes BELOW the restored content instead, where it survives and
          // marks the boundary to the fresh shell that lands under it.
          term.reset();
          term.write(o.buf);
          term.write('\r\n\x1b[90m──── restored from before the restart · fresh shell below ────\x1b[0m\r\n');
          // Delivered = consumed: the content now lives in this tab (and re-saves
          // under the new session's id), so the old file must not sit in the
          // Recent & recoverable list pretending it is still waiting (PT-4).
          try { fetch('/api/backlog?sid=' + encodeURIComponent(sid), { method: 'DELETE' }).catch(function () {}); } catch (e) {}
        }
        done(did);
      })
      .catch(function () { done(false); });
  }

  // ------------------------------------------ instant typing (SP-1 local echo)
  // Predictive local echo, the Mosh technique: a typed character is painted the
  // same frame as the keystroke, in an OVERLAY above the cursor cell — the
  // terminal buffer is never touched, so a wrong guess can't corrupt anything
  // and heals on the very next real byte from the shell (~85ms later, measured).
  // Display is gated four ways, stacked as defence in depth:
  //   1. confidence — shown only after recent keystrokes came back echoed, so a
  //      password prompt (echo off) shuts prediction down after one keystroke;
  //   2. the cursor line must not look like a secret prompt (heuristic);
  //   3. the cells right of the cursor must be empty (no mid-line cover-ups);
  //   4. the alternate screen (TUIs) never predicts.
  // ASCII printables only; paste, control keys, and IME all clear and stand down.
  function makePredictor(term, host) {
    var ov = document.createElement('div');
    ov.style.cssText = 'position:absolute;pointer-events:none;z-index:12;white-space:pre;display:none;';
    var pending = [];        // typed chars awaiting their shell echo [{ch, at}]
    var shown = '';          // what the overlay currently displays
    var confidence = 0;      // consecutive confirmed echoes; display needs >= 2
    var sweepTimer = null;
    var SECRET = /passw|passphrase|secret|\bpin\b|passcode|token/i;
    var dec = new TextDecoder();

    function screenEl() { return host.querySelector('.xterm-screen'); }
    function lineText() {
      try {
        var b = term.buffer.active;
        var ln = b.getLine(b.baseY + b.cursorY);
        return ln ? ln.translateToString(true) : '';
      } catch (e) { return ''; }
    }
    function clearRight() {
      try { return lineText().length <= term.buffer.active.cursorX; } catch (e) { return false; }
    }
    function paint() {
      var s = screenEl();
      if (!s) return;
      if (ov.parentNode !== s) { s.style.position = 'relative'; s.appendChild(ov); }
      var b = term.buffer.active;
      var cw = s.clientWidth / term.cols, ch = s.clientHeight / term.rows;
      ov.style.left = Math.round(b.cursorX * cw) + 'px';
      ov.style.top = Math.round(b.cursorY * ch) + 'px';
      ov.style.font = term.options.fontSize + 'px ' + term.options.fontFamily;
      ov.style.lineHeight = ch + 'px';
      ov.style.color = (themeColors().foreground || '#dadada');
      ov.textContent = shown;
      ov.style.display = 'block';
    }
    function clear() { if (shown) { shown = ''; ov.style.display = 'none'; } }
    function sweep() {
      // A keystroke whose echo never came back means echo is off (secret entry):
      // confidence collapses and stays down until typing is visibly echoed again.
      sweepTimer = null;
      var now = Date.now();
      while (pending.length && now - pending[0].at > 400) { confidence = 0; pending.shift(); }
      if (pending.length) sweepTimer = setTimeout(sweep, 200);
    }
    return {
      // Every user input from term.onData. Printable ASCII predicts; anything
      // else (enter, arrows, backspace, paste, IME output) clears and resets.
      key: function (d) {
        if (!S.localEcho) return;
        if (d.length !== 1 || d < ' ' || d > '~') { pending = []; clear(); return; }
        try { if (term.buffer.active.type === 'alternate') { clear(); return; } } catch (e) {}
        pending.push({ ch: d, at: Date.now() });
        if (!sweepTimer) sweepTimer = setTimeout(sweep, 200);
        var ok = confidence >= 2 && !SECRET.test(lineText()) && clearRight();
        try { if (localStorage.getItem('ct-pred-debug')) console.log('[pred]', JSON.stringify({ d: d, conf: confidence, pend: pending.length, ok: ok, secret: SECRET.test(lineText()), clearR: clearRight() })); } catch (e) {}
        if (ok) { shown += d; paint(); }
      },
      // Every output chunk, called just before term.write. Reality wins: the
      // overlay stands down and the real paint replaces it within a frame.
      data: function (raw) {
        if (shown) clear();
        if (!pending.length) return;             // fast path for streaming output
        var plain;
        try { plain = dec.decode(raw); } catch (e) { return; }
        // Strip OSC + CSI noise so PSReadLine's recolouring still counts as echo.
        plain = plain.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
        var now = Date.now();
        while (pending.length) {
          var p = pending[0], at = plain.indexOf(p.ch);
          if (at !== -1) { confidence = Math.min(confidence + 1, 8); plain = plain.slice(at + 1); pending.shift(); continue; }
          if (now - p.at > 400) { confidence = 0; pending.shift(); continue; }
          break;                                  // still in flight — judge later
        }
      },
      clear: clear,
    };
  }

  function newTerm(p, shellKey, cwd, seedSid, resumeCmd, resumeId, pinnedByHand, opts) {
    shellKey = shellKey || startShell();
    var id = ++termSeq;
    var host = document.createElement('div');
    host.className = 'term-host';
    host.style.display = 'none';
    p.termArea.appendChild(host);

    // One opener for every kind of link so a bare URL and an explicit hyperlink can't
    // behave differently. Under Electron the bridge hands it to the OS browser; on the
    // web there is no bridge, so a new tab is the honest equivalent.
    function openLink(uri) {
      if (window.winmux && window.winmux.openExternal) window.winmux.openExternal(uri);
      else window.open(uri, '_blank', 'noopener');
    }
    var term = new Terminal({
      fontFamily: FONTS[S.fontFamily] || FONTS['Cascadia Code'],
      fontSize: S.fontSize, lineHeight: S.lineHeight, cursorBlink: !!S.cursorBlink,
      cursorStyle: S.cursorStyle, scrollback: S.scrollback, theme: themeColors(),
      // Search highlight decorations are a proposed API; the find bar needs them.
      allowProposedApi: true,
      // OSC-8 hyperlinks (ESC]8;;URI BEL label ESC]8;; BEL) are handled by xterm core,
      // NOT by the web-links addon. Leave this null and xterm falls back to its own
      // window.confirm("...could potentially be dangerous") plus a raw window.open —
      // a dialog that isn't ours, on a path that ignores the Electron bridge. Routing
      // it here makes an explicit hyperlink open exactly like a bare URL.
      linkHandler: { activate: function (ev, uri) { openLink(uri); } },
    });
    term.__winmuxThemeSig = themeSig();   // born current — applySettings skips it until the theme really changes
    var fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    var search = new SearchAddon.SearchAddon();
    term.loadAddon(search);
    // Clickable links, half one: the web-links addon detects BARE URLs in the output
    // and makes them hoverable + clickable — the parity behaviour every modern terminal
    // has (VS Code, Windows Terminal). It does NOT handle OSC-8 explicit hyperlinks;
    // those are core xterm, wired through the linkHandler option above. Same opener for
    // both, so a hyperlink and a bare URL can't behave differently.
    if (window.WebLinksAddon) {
      try {
        term.loadAddon(new WebLinksAddon.WebLinksAddon(function (ev, uri) { openLink(uri); }));
        term.__winmuxWebLinks = true;   // observability hook for the harness
      } catch (e) {}
    }
    // Unicode 11 width tables: wide glyphs (CJK, emoji) claim their true 2 cells so
    // they stop smearing into the next column. Cheap, renderer-independent.
    if (window.Unicode11Addon) {
      try { term.loadAddon(new Unicode11Addon.Unicode11Addon()); term.unicode.activeVersion = '11'; } catch (e) {}
    }
    // Inline images: the image addon decodes iTerm2 IIP + sixel escape sequences into
    // real pictures in the grid — so `winmux image foo.png` (or any imgcat-style tool,
    // including Claude Code) shows the image right where it ran, no popup. storageLimit
    // caps decoded-image memory kept in scrollback so an image flood can't grow unbounded.
    if (window.ImageAddon) {
      try {
        term.loadAddon(new ImageAddon.ImageAddon({ sixelSupport: true, iipSupport: true, storageLimit: 128 }));
        term.__winmuxImages = true;   // observability hook for the harness
      } catch (e) {}
    }
    term.open(host);
    applyRenderer(term, host.style.display !== 'none');   // GPU vs DOM — see the function; must run AFTER open()
    // Catch the Electron startup dpr settle (dpr 1 first paint -> real dpr once placed
    // on a scaled monitor), which otherwise strands the very first prompt. Cheap no-op
    // once the canvas already matches. rAF for the next frame + a short timeout for the
    // slower place-on-monitor case.
    requestAnimationFrame(function () { resyncRenderer(term); });
    setTimeout(function () { resyncRenderer(term); }, 250);
    // WebGL scroll repaint. The GPU renderer can leave stale/torn rows behind after
    // a scroll (the buffer is correct — proven by the scroll torture test — but the
    // canvas doesn't always redraw the newly-exposed rows). Force a viewport refresh
    // on the next frame after any scroll so the visible rows repaint from the real
    // buffer. rAF-coalesced (one repaint per frame, not per wheel tick) and WebGL-only,
    // so the DOM renderer — which never has this artifact — pays nothing.
    term.onScroll(function () {
      if (term.__winmuxRenderer !== 'webgl') return;
      if (term.__winmuxScrollRaf) return;
      term.__winmuxScrollRaf = requestAnimationFrame(function () {
        term.__winmuxScrollRaf = 0;
        try { term.refresh(0, term.rows - 1); } catch (e) {}
      });
    });
    // Minimal scroll-position indicator. The native scrollbar is a zero-width
    // auto-hiding overlay Chromium won't size, so there was no cue for how far up the
    // scrollback you are. Draw our own thin thumb on the right edge, sized and placed
    // by scroll fraction — always visible while there's scrollback, renderer- and
    // overlay-independent, pointer-through (an indicator, not a drag handle).
    var sbThumb = document.createElement('div');
    sbThumb.className = 'termsb-thumb';
    host.appendChild(sbThumb);
    function updateScrollbar() {
      try {
        var buf = term.buffer.active, total = buf.length, view = term.rows;
        var screen = host.querySelector('.xterm-screen');
        var trackH = screen ? screen.clientHeight : host.clientHeight;
        if (total <= view || trackH <= 0) { sbThumb.style.opacity = '0'; return; }
        var thumbH = Math.max(24, Math.round(trackH * view / total));
        var frac = Math.min(1, Math.max(0, buf.viewportY / (total - view)));
        sbThumb.style.height = thumbH + 'px';
        sbThumb.style.transform = 'translateY(' + Math.round((trackH - thumbH) * frac) + 'px)';
        sbThumb.style.opacity = '1';
      } catch (e) {}
    }
    var sbRaf = 0;
    function scheduleScrollbar() { if (sbRaf) return; sbRaf = requestAnimationFrame(function () { sbRaf = 0; updateScrollbar(); }); }
    term.onScroll(scheduleScrollbar);
    term.onRender(scheduleScrollbar);
    term.onResize(scheduleScrollbar);
    // The bundled terminal font (Cascadia Code / CaskaydiaCove Nerd Font) can still
    // be loading when this terminal mounts on a clean machine. xterm measures its
    // cell size once at init; if it measured against the fallback, remeasure when the
    // real font lands so glyph metrics and ligatures line up instead of drifting.
    // Cheap no-op once the font is cached.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        try { if (host.style.display !== 'none') { fit.fit(); resyncRenderer(term); term.refresh(0, term.rows - 1); } } catch (e) {}
      });
    }
    // Instant skeleton. Opening a tab has an unavoidable sub-second gap (socket open
    // -> shell first byte) where a fresh terminal is a black rectangle and reads as
    // "loading". A cursor block sits in the pane the moment it's shown, so the open
    // feels instant; it's removed the instant real output lands (see ws.onmessage).
    var skel = document.createElement('div');
    skel.className = 'term-skel';
    skel.innerHTML = '<span class="cur"></span>';
    host.appendChild(skel);
    host.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      focusPane(t.paneId);
      if (S.rightClickPaste) { pasteInto(t); return; }
      showTermMenu(pn(), t, e.clientX, e.clientY);
    });
    host.addEventListener('wheel', function (e) { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); setFontSize(S.fontSize + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });

    var tabEl = document.createElement('div');
    tabEl.className = 'ptab';
    tabEl.draggable = true;
    tabEl.innerHTML = favHTML(shellKey) +
      '<span class="tt">' + esc(labelFor(shellKey)) + '</span>' +
      // Own element, not a ::after on .tt — the title truncates, and a marker inside
      // it disappears the moment the tab shows a real (long) shell path.
      '<span class="tres" aria-hidden="true">↻</span>' +
      '<span class="x" title="Close tab (Alt+W)">×</span>' +
      '<i class="tprog" style="width:0"></i>';
    p.tabscroll.appendChild(tabEl);
    var ttEl = tabEl.querySelector('.tt');

    var t = {
      id: id, paneId: p.id, groupId: activeGroupId, term: term, fit: fit, search: search, ws: null, host: host,
      skel: skel,
      tabEl: tabEl, dotEl: tabEl.querySelector('.fdot'), progEl: tabEl.querySelector('.tprog'),
      type: (opts && opts.type) || 'terminal',
      state: 'idle', status: 'idle', sid: seedSid || null, ended: false,
      cwd: null, shell: shellKey, renamed: false, results: null, busyTimer: null, progTimer: null,
      // Auto-resume: the pinned Claude conversation (resumeId) and the exact command
      // WinMux re-runs in this tab's folder when it reopens — `claude --resume <id>`.
      // Persisted with the layout; null = not armed.
      resume: resumeCmd || null, resumeId: resumeId || null, resumePinnedByHand: !!pinnedByHand,
      autoResumePending: false, _openedOnce: false,
    };
    if (t.resume) tabEl.classList.add('armed');   // restored/reopened armed tab shows the ↻ marker
    t.pred = makePredictor(term, host);           // SP-1 instant typing — see makePredictor
    // A tab can be dragged into another pane, so never close over `p` — look the pane up live.
    function pn() { return paneById(t.paneId) || p; }

    // Auto-resume: when a restored+armed tab gets its first FRESH shell (a cold
    // reopen where the old shell is gone, or a saved-project template with no live
    // session), type the resume command once — `cd` is unnecessary because the
    // shell already spawned in the tab's saved cwd, so this is just `claude
    // --resume <pinned id>`. One-shot: a warm reattach clears `autoResumePending` without
    // firing (see the meta handler), so a running agent is never re-typed into.
    function fireResume() {
      if (!t.autoResumePending || !t.resume) return;
      t.autoResumePending = false;
      try { sendToShell(t, t.resume + '\r'); } catch (e) {}
    }
    // A freshly-spawned shell prints its prompt over several output chunks, and its
    // line editor isn't ready until that has settled — keystrokes sent into the gap
    // are silently dropped (a fixed delay can't win this race; a slow profile blows
    // any guess). So wait for QUIET: every output chunk resets this timer, and only
    // once the shell has produced nothing for a beat do we type the resume command
    // onto a genuinely ready prompt. Also means we never type into a still-busy shell.
    function scheduleResume() {
      if (!t.autoResumePending || !t.resume) return;
      clearTimeout(t.resumeQuietTimer);
      t.resumeQuietTimer = setTimeout(fireResume, 650);
    }

    // Shell integration. Modern shells advertise their state through OSC escapes;
    // wiring them is what makes WinMux feel like a real terminal: a new split
    // inherits the shell's real cwd, command boundaries are captured, and the
    // shell can name its own tab. xterm handles OSC 0/2 (title) itself and fires
    // onTitleChange; OSC 7 (cwd) and OSC 133 (marks) are ours to parse.
    term.parser.registerOscHandler(7, function (data) {
      // OSC 7 ; file://HOST/PATH — the shell's current working directory.
      try {
        var m = /^file:\/\/[^\/]*(\/.*)$/.exec(data || '');
        if (m) {
          var path = decodeURIComponent(m[1]);
          if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);   // /C:/x -> C:/x (Windows)
          t.cwd = path;
          renderSidebar();
        }
      } catch (e) {}
      return true;
    });
    term.parser.registerOscHandler(133, function (data) {
      // OSC 133 ; A|B|C|D — FinalTerm/iTerm2 prompt & command boundary marks.
      // A = prompt start, B = command start (user input begins), C = output start,
      // D[;exit] = command end. pwsh 7 emits these by default.
      var parts = (data || '').split(';');
      var kind = parts[0].charAt(0);
      if ('ABCD'.indexOf(kind) >= 0) {
        if (!t.marks) t.marks = [];
        if (t.marks.length > 500) t.marks.shift();
        var y;
        try { y = term.buffer.active.baseY + term.buffer.active.cursorY; } catch (e) { y = null; }
        t.marks.push({ k: kind, y: y });
        // Command-block tracking: a block runs from the command-start row (B, or A as
        // fallback) to the command-end row (D). Anchor an xterm MARKER at the start row
        // now, while the cursor is actually on it — computing an offset later (at D) is
        // fragile. The exit code rides on the D mark.
        if ((kind === 'B' || kind === 'A') && y != null && S.commandBlocks) {
          try { if (t._blkMarker && t._blkMarker.dispose) t._blkMarker.dispose(); } catch (e) {}
          try { t._blkMarker = term.registerMarker(0); } catch (e) { t._blkMarker = null; }
          t._blkStart = y; t._blkStartTime = Date.now();
        }
        if (kind === 'D' && y != null && t._blkStart != null) {
          var exit = parts.length > 1 ? parseInt(parts[1], 10) : null;
          var ms = t._blkStartTime ? (Date.now() - t._blkStartTime) : null;
          decorateBlock(t, t._blkMarker, Math.max(1, y - t._blkStart), isNaN(exit) ? null : exit, ms);
          t._blkStart = null; t._blkMarker = null; t._blkStartTime = null;
        }
      }
      return true;
    });
    // OSC 0/2 auto-title: the shell names the tab, unless the user renamed it by hand.
    // But PowerShell/pwsh's *default* window title is its own executable path
    // (…\pwsh.exe) — useless as a tab label, and it comes back on every resume when
    // the scrollback replays that sequence, clobbering the friendly "PowerShell 7".
    // Drop any title that is just a path to an .exe; honour real, semantic titles a
    // program sets on purpose (vim, ssh, a custom prompt) and keep the shell label
    // otherwise.
    term.onTitleChange(function (title) {
      if (!title || t.renamed) return;
      if (/[\\/][^\\/]+\.exe\s*$/i.test(title)) return;
      t.autoTitle = title;
      if (ttEl) ttEl.textContent = title;
    });

    // Right-click the tab opens its full session menu (rename, colour, split, move,
    // export, find, the close family). Session controls live here, not on the toolbar.
    // Drop it from the tab's bottom edge, not the cursor Y — otherwise the menu opens
    // up inside the tab bar and overlaps the tabs.
    tabEl.addEventListener('contextmenu', function (e) {
      e.preventDefault(); e.stopPropagation();
      var r = tabEl.getBoundingClientRect();
      showTabMenu(t, e.clientX, r.bottom + 2);
    });

    // One shell, but possibly several sockets over its life. Losing the socket
    // is not the shell ending — a phone sleeping, a lid closing, a wifi hop and
    // a backgrounded tab all do it, and the shell on the other side is still
    // running with your work in it. So we wait it out and pick it back up by id
    // instead of printing an obituary. `[session ended]` is kept for the one
    // case that earns it: the shell itself exited.
    var retries = 0, retryTimer = null, told = false;
    function connect() {
      clearTimeout(retryTimer);
      // The id we're asking the server to hand back. If the server rebooted it's
      // gone there, but its scrollback may still be on disk under this id — so we
      // hold it before the meta reply overwrites t.sid with the fresh shell's id.
      var requestedSid = t.sid || '';
      var q = '/pty?shell=' + encodeURIComponent(shellKey);
      var startIn = cwd || S.startFolder;
      if (startIn) q += '&cwd=' + encodeURIComponent(startIn);
      if (t.sid) q += '&sid=' + encodeURIComponent(t.sid);
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      var ws = new WebSocket(proto + '//' + location.host + q);
      ws.binaryType = 'arraybuffer';
      t.ws = ws;

      ws.onopen = function () {
        retries = 0;
        // Back online — cancel the pending offline escalation and clear the flag.
        if (t.offlineTimer) { clearTimeout(t.offlineTimer); t.offlineTimer = null; }
        t.offline = false;
        t.state = 'open';
        if (t.status === 'closed') setStatus(t, 'idle');
        if (pn().activeTermId === id) reflect(pn());
        t._sentCols = t._sentRows = null;   // force a real resize on every (re)connect
        sendResize(t);
      };
      ws.onmessage = function (ev) {
        if (typeof ev.data === 'string') {
          var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m.type !== 'meta') return;
          if (m.error) {
            term.write('\r\n\x1b[31m' + m.error + '\x1b[0m\r\n');
            t.ended = true; t.state = 'closed'; setStatus(t, 'closed');
            if (pn().activeTermId === id) reflect(pn());
            return;
          }
          // The shell chose to leave. That is the real ending, and the only one
          // worth telling the person about.
          if (m.exited) { t.ended = true; return; }
          if (m.sid) { t.sid = m.sid; persistLive(); }
          if (m.shell && ttEl && !t.renamed) ttEl.textContent = m.shell;
          if (m.cwd) { t.cwd = m.cwd; }
          if (m.resumed) {
            // Redraw from the shell's own record rather than trusting whatever
            // half-written screen we were left holding.
            term.reset();
            if (told) { term.write('\x1b[90m[reconnected]\x1b[0m\r\n'); told = false; }
            // Reattached to the still-live shell — never re-run the resume command
            // (that would type `claude --resume …` into an agent already running).
            t.autoResumePending = false;
          } else if (m.lost) {
            // We asked for a shell that is gone.
            if (t.autoResumePending) {
              // An armed tab recovers via its resume command (typed on first output);
              // leave that path exactly as it was — just say the old shell is gone.
              term.write('\r\n\x1b[90m[that session ended — this is a new shell]\x1b[0m\r\n');
            } else if (requestedSid) {
              // Plain tab: if the server kept this session's scrollback across the
              // restart, replay it. A cold shell clears its own screen on first
              // render, so arm the replay and let the output handler fire it once
              // the shell is quiet (an immediate paint would be wiped).
              t._replaySid = requestedSid;
            } else {
              term.write('\r\n\x1b[90m[that session ended — this is a new shell]\x1b[0m\r\n');
            }
            told = false;
          }
          // The armed resume command fires on the shell's first real OUTPUT (below),
          // not here — the prompt has to be rendered and ready to receive keystrokes,
          // and at meta time a freshly-spawned shell hasn't printed its prompt yet.
          renderSidebar();
          return;
        }
        // First real output — the terminal is alive; drop the instant skeleton.
        if (t.skel) { t.skel.remove(); t.skel = null; }
        // Arm the resume-on-quiet watcher for an armed fresh shell. Each output
        // chunk pushes the fire back until the prompt has settled, so the command
        // types onto a ready line. One-shot; a warm reattach cleared the pending
        // flag in the meta handler, so scheduleResume is a no-op there.
        scheduleResume();
        if (t.pred) t.pred.data(ev.data);   // reality arrived — predictions stand down first
        term.write(new Uint8Array(ev.data));
        // A lost session with kept scrollback: once the fresh shell has printed and
        // gone quiet (so its startup clear is already done), reset and paint the
        // history on top, then nudge an empty Enter so the live prompt lands below it.
        if (t._replaySid) {
          clearTimeout(t._replayTimer);
          var replaySid = t._replaySid;
          t._replayTimer = setTimeout(function () {
            if (t._replaySid !== replaySid) return;
            t._replaySid = null;
            replayBacklog(replaySid, term, function (did) {
              if (did) { try { if (t.ws && t.ws.readyState === 1) t.ws.send(JSON.stringify({ t: 'i', d: '\r' })); } catch (e) {} }
              else term.write('\r\n\x1b[90m[that session ended — this is a new shell]\x1b[0m\r\n');
            });
          }, 600);
        }
        markWorking(t);
        scheduleDoing(t);
      };
      ws.onclose = function () {
        if (t.ws !== ws) return;               // a newer socket already took over
        if (t.closing) return;                 // this tab is being closed on purpose
        if (t.ended) {
          t.state = 'closed'; setStatus(t, 'closed');
          if (pn().activeTermId === id) reflect(pn());
          term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n');
          notify('Session ended', ttEl.textContent, id);
          return;
        }
        t.state = 'reconnecting';
        // A blip clears in a few seconds; past that the server is genuinely not
        // answering, so escalate to an honest "offline" while still retrying. Time-
        // based, not retry-count based, so a focus/online wake that resets the
        // backoff can't keep us in a permanent "reconnecting…" that never tells
        // the truth. Armed once per outage; cleared the moment we reconnect.
        if (!t.offlineTimer && !t.offline) {
          t.offlineTimer = setTimeout(function () {
            t.offlineTimer = null;
            if (t.state === 'reconnecting') {
              t.offline = true;
              if (pn().activeTermId === id) reflect(pn());
              renderSidebar();
            }
          }, 4000);
        }
        if (pn().activeTermId === id) reflect(pn());
        if (!told) { told = true; term.write('\r\n\x1b[90m[connection lost — reconnecting…]\x1b[0m\r\n'); }
        renderSidebar();
        // Quick at first for a blip, then backing off to every few seconds so a
        // phone that stays asleep isn't hammering the tailnet.
        var wait = Math.min(5000, 400 * Math.pow(2, Math.min(retries++, 4)));
        retryTimer = setTimeout(connect, wait);
      };
      // onerror always arrives with an onclose behind it, so the retry lives
      // there — doing it in both would double every attempt.
      ws.onerror = function () {};
    }
    connect();
    // Coming back to the tab, or getting the network back, is the best possible
    // moment to try again — better than whatever the backoff had scheduled.
    function retryNow() {
      if (t.closing || t.ended || t.state !== 'reconnecting') return;
      retries = 0;
      connect();
    }
    t.retryNow = retryNow;

    term.onData(function (d) {
      if (t.pred) t.pred.key(d);   // instant typing: paint the char this frame, reconcile on echo
      if (broadcastOn) {
        allTerms().forEach(function (x) { if (x.ws && x.ws.readyState === WebSocket.OPEN) x.ws.send(JSON.stringify({ t: 'i', d: d })); });
        return;
      }
      if (t.ws && t.ws.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify({ t: 'i', d: d }));
    });
    // Guard the native paste path too — Ctrl+V, middle-click, a browser paste —
    // which bypasses pasteInto() and would otherwise reach the shell raw. A
    // single-line or bracketed-safe paste is left to xterm; a raw multi-line
    // paste is intercepted and routed through the same confirm. Capture phase so
    // it preempts xterm's own paste handler.
    try {
      var pta = term.textarea;
      if (pta) {
        pta.addEventListener('paste', function (e) {
          var cd = e.clipboardData || window.clipboardData;
          var txt = cd ? cd.getData('text') : '';
          if (!isMultiLinePaste(txt) || bracketedActive(t)) return;   // safe — let xterm handle it
          e.preventDefault(); e.stopPropagation();
          deliverPaste(t, txt);
        }, true);
      }
    } catch (e) {}
    // A real terminal bell (\a) from the shell = this terminal wants attention.
    try {
      term.onBell(function () {
        var focused = (t.paneId === activePaneId && pn().activeTermId === id && document.hasFocus());
        // Every bell is logged so the notification centre is a real record; only an
        // unfocused terminal is escalated to "needs you" in the sidebar.
        if (!focused) setStatus(t, 'needsyou');
        notify(focused ? 'Terminal bell' : 'Terminal needs attention', ttEl.textContent, id);
      });
    } catch (e) {}
    try {
      search.onDidChangeResults(function (r) {
        t.results = r ? { index: r.resultIndex, count: r.resultCount } : null;
        if (pn().activeTermId === id) updateFindCount(pn());
      });
    } catch (e) {}
    if (term.textarea) {
      term.textarea.addEventListener('focus', function () { focusPane(t.paneId); root.setAttribute('data-typing', ''); });
      // On the phone the soft keyboard is up while the terminal has focus; drop the
      // flag on blur so the "tap to type" hint comes back when the keyboard closes.
      term.textarea.addEventListener('blur', function () { root.removeAttribute('data-typing'); });
      // Copy-on-select is a real preference, applied on mouse-up inside the terminal.
      host.addEventListener('mouseup', function () { if (S.copyOnSelect) copySel(t); });
    }

    tabEl.addEventListener('click', function (e) {
      focusPane(t.paneId);
      if (e.target && e.target.classList.contains('x')) { e.stopPropagation(); askCloseTerm(pn(), id); }
      else activateTerm(pn(), id);
    });
    tabEl.addEventListener('mousedown', function (e) { if (e.button === 1) { e.preventDefault(); askCloseTerm(pn(), id); } });
    tabEl.addEventListener('dblclick', function (e) {
      if (e.target && e.target.classList.contains('x')) return;
      e.preventDefault(); e.stopPropagation();
      focusPane(t.paneId); activateTerm(pn(), id); startRename(t);
    });
    wireTabDrag(t);

    p.terms.push(t);
    updateChrome();
    activateTerm(p, id);
    return t;
  }

  // ── Browser leaf ────────────────────────────────────────────────────────
  // A pane tab whose body is a live <webview> instead of an xterm. It carries
  // the SAME leaf shape the tab machinery reads (id, host, tabEl, state,
  // status, dotEl), so activate / close / drag / MRU / palette treat it like
  // any tab — the terminal-only paths (fit/focus/shell) are guarded by t.term.
  // Real external sites need Electron's <webview>; in a plain browser the leaf
  // degrades to a "needs the desktop app" note instead of a broken frame.
  function setLeafTitle(t, title) {
    if (!t || !t.tabEl || t.renamed || !title) return;
    var tt = t.tabEl.querySelector('.tt'); if (tt) tt.textContent = title;
  }
  function leafLoadUrl(t, url) {
    if (!t || !t.view) return null;
    var full = normalizeUrl(url); t.url = full;
    if (t.addr) t.addr.value = full;
    // A <webview> only accepts loadURL once it has attached (dom-ready); before
    // that, queue the target and flush it when the view is ready.
    if (t.viewReady) { try { t.view.loadURL(full); } catch (e) { t.viewPending = full; } }
    else t.viewPending = full;
    return full;
  }
  function newBrowserLeaf(p, url) {
    var id = ++termSeq;
    var host = document.createElement('div');
    host.className = 'term-host leafbody browserleaf';
    host.style.display = 'none';
    p.termArea.appendChild(host);

    var t = {
      id: id, paneId: p.id, groupId: activeGroupId, type: 'browser',
      term: null, fit: null, ws: null, host: host, tabEl: null, dotEl: null, progEl: null,
      view: null, addr: null, viewReady: false, viewPending: null,
      // state 'idle' (not 'open'): a browser leaf has no shell, so closing it must
      // not trigger the "the shell process will be ended" confirm (askCloseTerm
      // only confirms when state === 'open').
      state: 'idle', status: 'idle', sid: null, ended: false,
      cwd: null, shell: null, url: normalizeUrl(url || 'about:blank'),
      results: null, renamed: false, resume: null, resumeId: null,
    };
    function pn() { return paneById(t.paneId) || p; }

    if (isElectronApp()) {
      host.innerHTML =
        '<div class="bchrome">' +
          '<span class="bnav bback" role="button" title="Back">‹</span>' +
          '<span class="bnav bfwd" role="button" title="Forward">›</span>' +
          '<span class="bnav brel" role="button" title="Reload">↻</span>' +
          '<input class="baddr" type="text" spellcheck="false" placeholder="Enter a URL" />' +
        '</div>' +
        '<webview class="bframe" src="about:blank" allowpopups></webview>';
      var view = host.querySelector('.bframe');
      var addr = host.querySelector('.baddr');
      t.view = view; t.addr = addr;
      host.querySelector('.bback').addEventListener('click', function () { try { view.goBack(); } catch (e) {} });
      host.querySelector('.bfwd').addEventListener('click', function () { try { view.goForward(); } catch (e) {} });
      host.querySelector('.brel').addEventListener('click', function () { try { view.reload(); } catch (e) {} });
      addr.addEventListener('keydown', function (e) { if (e.key === 'Enter') leafLoadUrl(t, addr.value); });
      addr.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      function synced() { try { addr.value = view.getURL(); t.url = addr.value; setLeafTitle(t, view.getTitle() || addr.value); } catch (e) {} }
      view.addEventListener('did-navigate', synced);
      view.addEventListener('did-navigate-in-page', synced);
      view.addEventListener('page-title-updated', synced);
      view.addEventListener('dom-ready', function () {
        t.viewReady = true;
        if (t.viewPending) { var u = t.viewPending; t.viewPending = null; try { view.loadURL(u); } catch (e) {} }
      });
    } else {
      host.innerHTML = '<div class="bempty">The in-app browser needs the WinMux desktop app.</div>';
    }

    var tabEl = document.createElement('div');
    tabEl.className = 'ptab';
    tabEl.draggable = true;
    // data-leaf marks a non-terminal tab so terminal-only paths can select
    // `.ptab:not([data-leaf])` — the shell favicon classes (fav-b/-m/-d) are
    // reused by shells (PowerShell is fav-b), so the favicon can't discriminate.
    tabEl.setAttribute('data-leaf', 'browser');
    tabEl.innerHTML =
      '<span class="tfav"><span class="fav fav-b">◆</span><span class="fdot" style="display:none"></span></span>' +
      '<span class="tt">Browser</span>' +
      '<span class="x" title="Close tab (Alt+W)">×</span>';
    p.tabscroll.appendChild(tabEl);
    t.tabEl = tabEl; t.dotEl = tabEl.querySelector('.fdot');

    tabEl.addEventListener('click', function (e) {
      focusPane(t.paneId);
      if (e.target && e.target.classList.contains('x')) { e.stopPropagation(); askCloseTerm(pn(), id); }
      else activateTerm(pn(), id);
    });
    tabEl.addEventListener('mousedown', function (e) { if (e.button === 1) { e.preventDefault(); askCloseTerm(pn(), id); } });
    tabEl.addEventListener('dblclick', function (e) {
      if (e.target && e.target.classList.contains('x')) return;
      e.preventDefault(); e.stopPropagation(); focusPane(t.paneId); activateTerm(pn(), id); startRename(t);
    });
    wireTabDrag(t);
    t.onShow = function () { try { if (t.view) t.view.focus(); } catch (e) {} };

    p.terms.push(t);
    updateChrome();
    activateTerm(p, id);
    if (t.url && t.url !== 'about:blank') leafLoadUrl(t, t.url);
    return t;
  }
  // Resolve "the browser" for the CLI / control layer: the active leaf if it is
  // a browser, else the most-recently-created browser leaf anywhere.
  function activeBrowserLeaf() {
    var a = activeTerm();
    if (a && leafType(a) === 'browser') return a;
    var all = allTerms().filter(function (x) { return leafType(x) === 'browser'; });
    return all.length ? all[all.length - 1] : null;
  }

  // ── Markdown leaf ───────────────────────────────────────────────────────
  // A pane tab that renders a .md file (via /api/md) and live-updates it on
  // save. Same leaf shape as the browser leaf; its body is a scroller instead
  // of a <webview>, and it owns a poll timer cleaned up in closeTerm (onClose).
  function mdLoadLeaf(t, mdPath) {
    if (!t || !t.bodyEl) return { path: mdPath };
    t.mdPath = String(mdPath || ''); t.mdMtime = 0;
    var base = t.mdPath.split(/[\\/]/).pop();
    t.mdTitle = base || 'Markdown';
    setLeafTitle(t, t.mdTitle);
    var pull = function () {
      // Stop polling once the leaf is torn down (belt-and-suspenders with onClose).
      if (!t.bodyEl || !document.body.contains(t.host)) { if (t.mdTimer) { clearInterval(t.mdTimer); t.mdTimer = null; } return; }
      fetch('/api/md?path=' + encodeURIComponent(t.mdPath)).then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok) { t.bodyEl.innerHTML = '<p style="color:var(--err)">' + mdEsc(j.error || 'cannot read file') + '</p>'; return; }
        if (j.mtime !== t.mdMtime) { t.mdMtime = j.mtime; t.bodyEl.innerHTML = mdRender(j.text); }
      }).catch(function () {});
    };
    pull();
    if (t.mdTimer) clearInterval(t.mdTimer);
    t.mdTimer = setInterval(pull, 1500);
    return { path: mdPath };
  }
  function newMarkdownLeaf(p, mdPath) {
    var id = ++termSeq;
    var host = document.createElement('div');
    host.className = 'term-host leafbody mdleaf';
    host.style.display = 'none';
    host.innerHTML = '<div class="mdscroll"><div class="mdbody"></div></div>';
    p.termArea.appendChild(host);

    var t = {
      id: id, paneId: p.id, groupId: activeGroupId, type: 'markdown',
      term: null, fit: null, ws: null, host: host, tabEl: null, dotEl: null, progEl: null,
      bodyEl: host.querySelector('.mdbody'), mdPath: String(mdPath || ''), mdTitle: '', mdMtime: 0, mdTimer: null,
      state: 'idle', status: 'idle', sid: null, ended: false,
      cwd: null, shell: null, results: null, renamed: false, resume: null, resumeId: null,
    };
    function pn() { return paneById(t.paneId) || p; }

    var tabEl = document.createElement('div');
    tabEl.className = 'ptab';
    tabEl.draggable = true;
    tabEl.setAttribute('data-leaf', 'markdown');
    tabEl.innerHTML =
      '<span class="tfav"><span class="fav fav-m">¶</span><span class="fdot" style="display:none"></span></span>' +
      '<span class="tt">Markdown</span>' +
      '<span class="x" title="Close tab (Alt+W)">×</span>';
    p.tabscroll.appendChild(tabEl);
    t.tabEl = tabEl; t.dotEl = tabEl.querySelector('.fdot');

    tabEl.addEventListener('click', function (e) {
      focusPane(t.paneId);
      if (e.target && e.target.classList.contains('x')) { e.stopPropagation(); askCloseTerm(pn(), id); }
      else activateTerm(pn(), id);
    });
    tabEl.addEventListener('mousedown', function (e) { if (e.button === 1) { e.preventDefault(); askCloseTerm(pn(), id); } });
    tabEl.addEventListener('dblclick', function (e) {
      if (e.target && e.target.classList.contains('x')) return;
      e.preventDefault(); e.stopPropagation(); focusPane(t.paneId); activateTerm(pn(), id); startRename(t);
    });
    wireTabDrag(t);
    t.onClose = function () { if (t.mdTimer) { clearInterval(t.mdTimer); t.mdTimer = null; } };

    p.terms.push(t);
    updateChrome();
    activateTerm(p, id);
    if (t.mdPath) mdLoadLeaf(t, t.mdPath);
    return t;
  }
  function activeMarkdownLeaf() {
    var a = activeTerm();
    if (a && leafType(a) === 'markdown') return a;
    var all = allTerms().filter(function (x) { return leafType(x) === 'markdown'; });
    return all.length ? all[all.length - 1] : null;
  }

  // A divider between two flex siblings.
  function makeDivider(horizontal) {
    var d = document.createElement('div');
    d.className = horizontal ? 'wsdiv h' : 'wsdiv';
    d.addEventListener('mousedown', function (e) {
      e.preventDefault();
      var a = d.previousElementSibling;
      var b = d.nextElementSibling;
      if (!a || !b) return;
      var start = horizontal ? e.clientY : e.clientX;
      var aSize = horizontal ? a.getBoundingClientRect().height : a.getBoundingClientRect().width;
      var bSize = horizontal ? b.getBoundingClientRect().height : b.getBoundingClientRect().width;
      d.classList.add('drag');
      document.body.classList.add(horizontal ? 'row-resizing' : 'col-resizing');
      function move(ev) {
        var delta = (horizontal ? ev.clientY : ev.clientX) - start;
        a.style.flex = Math.max(120, aSize + delta) + ' 1 0';
        b.style.flex = Math.max(120, bSize - delta) + ' 1 0';
      }
      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        d.classList.remove('drag');
        document.body.classList.remove('col-resizing');
        document.body.classList.remove('row-resizing');
        panes.forEach(fitActive);
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    return d;
  }
  function makeCol() {
    var col = document.createElement('div');
    col.className = 'wscol';
    col.style.flex = '1 1 0';
    if (wsrow.children.length > 0) wsrow.appendChild(makeDivider(false));
    wsrow.appendChild(col);
    return col;
  }
  function resetFlex() {
    [].forEach.call(wsrow.querySelectorAll('.wscol'), function (c) {
      c.style.flex = '1 1 0';
      [].forEach.call(c.querySelectorAll('.pane'), function (pe) { pe.style.flex = '1 1 0'; });
    });
  }
  function closePane(p) {
    if (panes.length <= 1) return;
    clearZoom();
    p.terms.forEach(function (t) { killShell(t); try { t.term.dispose(); } catch (e) {} });
    if (p._ro) { try { p._ro.disconnect(); } catch (e) {} clearTimeout(p._roT); }
    var col = p.col;
    var prev = p.el.previousElementSibling;
    var next = p.el.nextElementSibling;
    var hdiv = (prev && prev.classList.contains('wsdiv')) ? prev : ((next && next.classList.contains('wsdiv')) ? next : null);
    if (hdiv) hdiv.remove();
    p.el.remove();
    var idx = panes.indexOf(p);
    panes.splice(idx, 1);
    if (col && !col.querySelector('.pane')) {
      var cprev = col.previousElementSibling;
      var cnext = col.nextElementSibling;
      var vdiv = (cprev && cprev.classList.contains('wsdiv')) ? cprev : ((cnext && cnext.classList.contains('wsdiv')) ? cnext : null);
      if (vdiv) vdiv.remove();
      col.remove();
    }
    resetFlex();
    updateChrome();
    focusPane(panes[Math.max(0, idx - 1)].id);
    panes.forEach(fitActive);
  }
  function askClosePane(p) {
    if (panes.length <= 1) return;
    // A pinned pane refuses to close — that is the whole point of pinning it.
    if (p.pinned) { notify('Pane is pinned', 'Unpin it (Alt+P) before closing.'); flashPin(p); return; }
    var live = p.terms.filter(function (t) { return t.state === 'open'; }).length;
    if (S.confirmClose && live) {
      confirmDialog('Close this pane?', live + ' running terminal' + (live > 1 ? 's' : '') + ' will be ended.', 'Close pane', function () { closePane(p); });
      return;
    }
    closePane(p);
  }
  function splitRight(p, shellKey, cwd) {
    clearZoom();
    var np = makePane(makeCol());
    newTerm(np, shellKey || startShell(), cwd);
    focusPane(np.id);
    panes.forEach(fitActive);
    return np;
  }
  function splitDown(p, shellKey, cwd) {
    clearZoom();
    var np = makePane(p.col, p);
    newTerm(np, shellKey || startShell(), cwd);
    focusPane(np.id);
    panes.forEach(fitActive);
    return np;
  }

  function makePane(col, afterPane, before) {
    var id = ++paneSeq;
    var el = document.createElement('div');
    el.className = 'pane npane';
    el.style.flex = '1 1 0';
    el.innerHTML =
      '<div class="nbar"><span class="back">' + BACK_SVG + '<span>Sessions</span></span><span class="nm"></span></div>' +
      '<div class="ptabs">' +
        '<span class="pc ptab-back" title="Back to sessions" role="button" aria-label="Back to sessions">' + BACK_SVG + '</span>' +
        '<div class="pctrls"><span class="pc pc-rail" title="Toggle left sidebar (Ctrl+B)" role="button">' + RAIL_SVG + '</span></div>' +
        '<div class="tabscroll"></div>' +
        '<div class="tab-of" title="Tabs that don\'t fit" role="button" style="display:none"><span class="ofc">0</span>' + CARET_SVG + '<span class="ofdot" style="display:none"></span></div>' +
        '<div class="connpill" role="status" aria-live="polite" data-state="idle"><span class="dot"></span><span class="conntext">connecting…</span></div>' +
        '<div class="pctrls">' +
          '<span class="pgroup"><span class="pc pc-new" title="New tab (Alt+T)" role="button">' + NEW_SVG + '</span>' +
          '<span class="pc pcaret pc-newmenu" title="New tab type…" role="button">' + CARET_SVG + '</span></span>' +
          '<span class="pc pc-find" title="Find (Ctrl+F)" role="button">' + FIND_SVG + '</span>' +
          '<span class="pgroup"><span class="pc pc-split" title="Split right (Ctrl+D)" role="button">' + SPLIT_SVG + '</span>' +
          '<span class="pc pcaret pc-splitmenu" title="Split…" role="button">' + CARET_SVG + '</span></span>' +
          '<span class="pc pc-pin" title="Pin pane (Alt+P)" role="button">' + PIN_SVG + '</span>' +
          '<span class="pc pc-zoom" title="Zoom pane (Ctrl+Shift+Enter)" role="button" style="display:none">' + ZOOM_SVG + '</span>' +
          '<span class="pc pc-close" title="Close pane (Alt+Shift+W)" role="button" style="display:none">' + CLOSE_SVG + '</span>' +
          '<span class="pc pc-dock" title="Toggle changes panel" role="button">' + DOCK_SVG + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="pbody">' +
        '<div class="copymode" style="display:none"><span class="cm-tag">COPY MODE</span>' +
        '<span class="cm-hint">↑↓ PgUp/PgDn move · Space starts a selection · Enter copies · Esc exits</span></div>' +
        '<div class="term-area"></div>' +
        '<div class="split-preview" style="display:none"></div>' +
        '<div class="findbar">' +
          '<input type="text" placeholder="Find" spellcheck="false" />' +
          '<span class="fb-count"></span>' +
          '<div class="fb-btn fb-prev" title="Previous (Shift+Enter)">' + UP_SVG + '</div>' +
          '<div class="fb-btn fb-next" title="Next (Enter)">' + DOWN_SVG + '</div>' +
          '<div class="fb-btn fb-close" title="Close (Esc)">' + CLOSE_SVG + '</div>' +
        '</div>' +
      '</div>';

    if (afterPane && before) {
      col.insertBefore(el, afterPane.el);
      col.insertBefore(makeDivider(true), afterPane.el);
    } else if (afterPane) {
      var ref = afterPane.el.nextSibling;
      col.insertBefore(makeDivider(true), ref);
      col.insertBefore(el, ref);
    } else {
      if (col.children.length > 0) col.appendChild(makeDivider(true));
      col.appendChild(el);
    }

    var p = {
      id: id, el: el, col: col,
      tabscroll: el.querySelector('.tabscroll'),
      termArea: el.querySelector('.term-area'),
      pill: el.querySelector('.connpill'),
      connText: el.querySelector('.conntext'),
      railBtn: el.querySelector('.pc-rail'),
      newBtn: el.querySelector('.pc-new'),
      newMenuBtn: el.querySelector('.pc-newmenu'),
      findBtn: el.querySelector('.pc-find'),
      splitBtn: el.querySelector('.pc-split'),
      splitMenuBtn: el.querySelector('.pc-splitmenu'),
      zoomBtn: el.querySelector('.pc-zoom'),
      closeBtn: el.querySelector('.pc-close'),
      dockBtn: el.querySelector('.pc-dock'),
      findbar: el.querySelector('.findbar'),
      findInput: el.querySelector('.findbar input'),
      findCount: el.querySelector('.fb-count'),
      pinBtn: el.querySelector('.pc-pin'),
      ofBtn: el.querySelector('.tab-of'),
      ofCount: el.querySelector('.tab-of .ofc'),
      ofDot: el.querySelector('.tab-of .ofdot'),
      copybar: el.querySelector('.copymode'),
      preview: el.querySelector('.split-preview'),
      nbar: el.querySelector('.nbar'),
      nbarName: el.querySelector('.nbar .nm'),
      terms: [], activeTermId: null, mru: [], pinned: false,
    };
    // Refit whenever THIS pane's box changes — splits, pane closes, sidebar/dock
    // toggles, and divider drags all resize panes without a window resize, and a
    // terminal fitted against a mid-layout box keeps a stale canvas (tiny squished
    // text) until something refits it. The observer is that something.
    if (window.ResizeObserver) {
      p._ro = new ResizeObserver(function () {
        clearTimeout(p._roT);
        p._roT = setTimeout(function () { fitActive(p); }, 60);
      });
      p._ro.observe(p.termArea);
    }
    p.railBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleSidebar(); });
    p.newBtn.addEventListener('click', function (e) { e.stopPropagation(); focusPane(p.id); showTypeMenu(p, p.newBtn); });
    p.newMenuBtn.addEventListener('click', function (e) {
      e.stopPropagation(); focusPane(p.id);
      showShellMenu(p.newMenuBtn, 'New tab', function (key) { newTerm(p, key); });
    });
    p.findBtn.addEventListener('click', function () { focusPane(p.id); openFind(p); });
    p.splitBtn.addEventListener('click', function () { splitRight(p, startShell()); });
    p.splitMenuBtn.addEventListener('click', function (e) { e.stopPropagation(); focusPane(p.id); showSplitMenu(p, p.splitMenuBtn); });
    p.zoomBtn.addEventListener('click', function () { focusPane(p.id); toggleZoom(p); });
    p.closeBtn.addEventListener('click', function () { askClosePane(p); });
    p.dockBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleDock(); });
    el.addEventListener('mousedown', function () { focusPane(p.id); });
    p.findInput.addEventListener('input', function () { doFind(p, 'next', true); });
    p.findInput.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); doFind(p, e.shiftKey ? 'prev' : 'next'); }
      else if (e.key === 'Escape') { e.preventDefault(); closeFind(p); }
    });
    el.querySelector('.fb-prev').addEventListener('click', function () { doFind(p, 'prev'); });
    el.querySelector('.fb-next').addEventListener('click', function () { doFind(p, 'next'); });
    el.querySelector('.fb-close').addEventListener('click', function () { closeFind(p); });
    p.pinBtn.addEventListener('click', function (e) { e.stopPropagation(); togglePin(p); });
    p.ofBtn.addEventListener('click', function (e) { e.stopPropagation(); focusPane(p.id); showOverflowMenu(p); });
    p.tabscroll.addEventListener('scroll', function () { layoutTabs(p); });
    // Back out of a terminal to its group's session list, not all the way to the groups.
    // On the phone this lives in the tab bar (the separate back header is hidden there);
    // the .nbar copy is kept as the wiring source for both.
    el.querySelector('.nbar .back').addEventListener('click', function () { setView('sessions'); });
    el.querySelector('.ptab-back').addEventListener('click', function () { setView('sessions'); });
    wirePaneDrop(p);

    panes.push(p);
    updateChrome();
    return p;
  }

  // ------------------------------------------------------------- pane layer
  // A pane holding a terminal that rang the bell gets the attention ring; the rest dim.
  function updateRings() {
    var any = false;
    panes.forEach(function (p) {
      var need = p.terms.some(function (t) { return t.status === 'needsyou'; });
      if (need) { p.el.classList.add('nring'); any = true; } else p.el.classList.remove('nring');
    });
    if (any) wsrow.classList.add('has-ring'); else wsrow.classList.remove('has-ring');
  }

  function flashPin(p) {
    if (!p.pinBtn) return;
    p.pinBtn.classList.add('flash');
    setTimeout(function () { p.pinBtn.classList.remove('flash'); }, 700);
  }
  // Pinning: this pane is not closed by accident.
  function togglePin(p) {
    p.pinned = !p.pinned;
    if (p.pinned) p.pinBtn.classList.add('on'); else p.pinBtn.classList.remove('on');
    p.pinBtn.title = (p.pinned ? 'Unpin pane' : 'Pin pane') + ' (Alt+P)';
    renderSidebar();
  }

  // A column inserted next to an existing one, rather than always at the end.
  function makeColAt(refCol, before) {
    var col = document.createElement('div');
    col.className = 'wscol';
    col.style.flex = '1 1 0';
    var div = makeDivider(false);
    if (before) { wsrow.insertBefore(col, refCol); wsrow.insertBefore(div, refCol); }
    else { wsrow.insertBefore(div, refCol.nextSibling); wsrow.insertBefore(col, div.nextSibling); }
    return col;
  }

  // Moving a tab between panes re-parents the live terminal — the shell keeps running.
  function moveTermToPane(t, np) {
    var op = paneById(t.paneId);
    if (!op || op === np) return;
    var idx = op.terms.indexOf(t);
    if (idx >= 0) op.terms.splice(idx, 1);
    var mi = op.mru.indexOf(t.id); if (mi >= 0) op.mru.splice(mi, 1);
    np.termArea.appendChild(t.host);
    np.tabscroll.appendChild(t.tabEl);
    t.paneId = np.id;
    np.terms.push(t);
    var ovis = visibleTerms(op);
    if (ovis.length === 0) {
      if (op.terms.length === 0 && panes.length > 1 && !op.pinned) closePane(op);
      else newTerm(op, startShell());
    } else if (op.activeTermId === t.id) {
      var nid = null;
      for (var m = 0; m < op.mru.length && nid == null; m++) {
        for (var j = 0; j < ovis.length; j++) if (ovis[j].id === op.mru[m]) { nid = ovis[j].id; break; }
      }
      activateTerm(op, nid == null ? ovis[0].id : nid);
    }
    activateTerm(np, t.id);
    focusPane(np.id);
    updateChrome();
    resetFlex();
    panes.forEach(fitActive);
    layoutAllTabs();
  }

  // ---- drag a tab onto a pane -------------------------------------------
  var dragTerm = null;
  function wireTabDrag(t) {
    t.tabEl.addEventListener('dragstart', function (e) {
      dragTerm = t;
      t.tabEl.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', String(t.id)); e.dataTransfer.effectAllowed = 'move'; } catch (err) {}
    });
    t.tabEl.addEventListener('dragend', function () {
      dragTerm = null;
      t.tabEl.classList.remove('dragging');
      panes.forEach(clearDropUI);
    });
  }
  function clearDropUI(p) {
    if (p.hintTimer) { clearTimeout(p.hintTimer); p.hintTimer = null; }
    p.el.classList.remove('drop');
    if (p.preview) { p.preview.style.display = 'none'; p.preview.className = 'split-preview'; }
  }
  // Miss the pane and the browser's own default takes over — it navigates away
  // from the app to display the file. Swallow every stray drop on the page.
  window.addEventListener('dragover', function (e) { if (!dragTerm) e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });
  var ZONE_LABEL = { left: 'Split left', right: 'Split right', up: 'Split up', down: 'Split down', center: 'Move here' };
  function dropZone(p, e) {
    var r = p.el.getBoundingClientRect();
    var x = (e.clientX - r.left) / r.width;
    var y = (e.clientY - r.top) / r.height;
    if (x < 0.25) return 'left';
    if (x > 0.75) return 'right';
    if (y < 0.25) return 'up';
    if (y > 0.75) return 'down';
    return 'center';
  }
  // ---- drag a folder in from Explorer -----------------------------------
  // Muscle memory: type "cd ", drag a folder in, hit enter. A browser will not
  // tell a page where a dropped folder actually lives — it hands over the name
  // and the child names and withholds the path on purpose. So the page asks the
  // server, which is standing on the same disk and can just go find it.
  function hasFiles(e) {
    try {
      var ty = e.dataTransfer.types;
      for (var i = 0; i < ty.length; i++) if (ty[i] === 'Files') return true;
    } catch (err) {}
    return false;
  }
  function showHint(p, msg, ms) {
    if (!p.preview) return;
    p.el.classList.add('drop');
    p.preview.className = 'split-preview sp-center';
    p.preview.textContent = msg;
    p.preview.style.display = 'flex';
    if (p.hintTimer) clearTimeout(p.hintTimer);
    if (ms) p.hintTimer = setTimeout(function () { clearDropUI(p); }, ms);
  }
  // Windows Terminal only quotes when it has to, and so do we — an unquoted
  // path is what you'd have typed, and stays editable.
  function quotePath(s) { return /[\s&(){}^;!'`,~=]/.test(s) ? '"' + s + '"' : s; }
  function sendText(t, txt) {
    if (!t || !t.ws || t.ws.readyState !== WebSocket.OPEN) return false;
    t.ws.send(JSON.stringify({ t: 'i', d: txt }));
    try { t.term.focus(); } catch (e) {}
    return true;
  }
  // The DataTransfer is emptied the moment this handler returns, so the entry
  // and the child names have to be grabbed now, not after the fetch.
  function readDrop(e, done) {
    var entry = null;
    try {
      var items = e.dataTransfer.items;
      if (items && items.length && items[0].webkitGetAsEntry) entry = items[0].webkitGetAsEntry();
    } catch (err) {}
    var file = null;
    try { file = e.dataTransfer.files && e.dataTransfer.files[0]; } catch (err) {}
    if (!entry && !file) return done(null);
    var name = (entry && entry.name) || file.name;
    if (entry && !entry.isDirectory) return done({ name: name, kids: [], isDir: false });
    if (!entry) return done({ name: name, kids: [], isDir: false });
    // Child names are the fingerprint that tells two folders of the same name apart.
    var kids = [];
    var reader = entry.createReader();
    (function readMore() {
      reader.readEntries(function (batch) {
        if (!batch.length || kids.length >= 40) return done({ name: name, kids: kids, isDir: true });
        for (var i = 0; i < batch.length; i++) kids.push(batch[i].name);
        readMore();
      }, function () { done({ name: name, kids: kids, isDir: true }); });
    })();
  }
  function dropFolder(p, e) {
    var t = activeTermOf(p);
    var mx = e.clientX, my = e.clientY;
    readDrop(e, function (info) {
      if (!info) { clearDropUI(p); return; }
      if (!info.isDir) {
        showHint(p, 'Drop a folder, or use Shift+right-click → Copy as path', 4500);
        return;
      }
      showHint(p, 'Finding ' + info.name + '…');
      var q = '/api/findpath?name=' + encodeURIComponent(info.name) +
        '&kids=' + encodeURIComponent(info.kids.join('|')) +
        '&near=' + encodeURIComponent((t && t.cwd) || '');
      fetch(q).then(function (r) { return r.json(); }).then(function (d) {
        var hits = (d && d.hits) || [];
        if (!hits.length) {
          showHint(p, "Couldn't find " + info.name + ' — Shift+right-click → Copy as path', 5000);
          return;
        }
        clearDropUI(p);
        // An empty folder is only identifiable by its name, so several places on
        // disk can answer to it equally well. Guessing would quietly paste the
        // wrong one; ask instead, using the menu the rest of the app already uses.
        if (hits.length > 1 && hits[1].score === hits[0].score) {
          var m = newMenu();
          hits.forEach(function (h) {
            addMenuItem(m, esc(h.path), '', function () { sendText(t, quotePath(h.path)); });
          });
          placeMenu(m, mx, my);
          return;
        }
        sendText(t, quotePath(hits[0].path));
      }).catch(function () { showHint(p, 'Path lookup failed', 3000); });
    });
  }

  function wirePaneDrop(p) {
    p.el.addEventListener('dragover', function (e) {
      if (!dragTerm) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'copy'; } catch (err) {}
        showHint(p, 'Drop to paste this path');
        return;
      }
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (err) {}
      var z = dropZone(p, e);
      p.el.classList.add('drop');
      p.preview.className = 'split-preview sp-' + z;
      p.preview.textContent = ZONE_LABEL[z];
      p.preview.style.display = 'flex';
    });
    p.el.addEventListener('dragleave', function (e) {
      if (p.el.contains(e.relatedTarget)) return;
      clearDropUI(p);
    });
    p.el.addEventListener('drop', function (e) {
      if (!dragTerm) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dropFolder(p, e);
        return;
      }
      e.preventDefault();
      var t = dragTerm, z = dropZone(p, e);
      clearDropUI(p);
      dragTerm = null;
      t.tabEl.classList.remove('dragging');
      if (z === 'center') { moveTermToPane(t, p); return; }
      // Same pane, only tab, nothing to split into — leave it alone.
      if (t.paneId === p.id && p.terms.length === 1) return;
      clearZoom();
      var np;
      if (z === 'left' || z === 'right') np = makePane(makeColAt(p.col, z === 'left'));
      else np = makePane(p.col, p, z === 'up');
      moveTermToPane(t, np);
    });
  }

  // ---- copy mode ---------------------------------------------------------
  var copyMode = null;
  function copyLines(t) { try { return t.term.buffer.active.length; } catch (e) { return 0; } }
  function enterCopyMode() {
    var p = paneById(activePaneId); if (!p) return;
    var t = activeTermOf(p); if (!t) return;
    if (copyMode) exitCopyMode();
    var b = t.term.buffer.active;
    copyMode = { p: p, t: t, line: b.viewportY + b.cursorY, anchor: null };
    p.copybar.style.display = 'flex';
    t.host.classList.add('cm-on');
    try { t.fit.fit(); sendResize(t); } catch (e) {}
    paintCopy();
  }
  function exitCopyMode() {
    if (!copyMode) return;
    var c = copyMode; copyMode = null;
    c.p.copybar.style.display = 'none';
    c.t.host.classList.remove('cm-on');
    try { c.t.term.clearSelection(); } catch (e) {}
    try { c.t.fit.fit(); sendResize(c.t); c.t.term.focus(); } catch (e) {}
  }
  function paintCopy() {
    if (!copyMode) return;
    var c = copyMode;
    var hint = c.p.copybar.querySelector('.cm-hint');
    var max = copyLines(c.t) - 1;
    c.line = Math.max(0, Math.min(c.line, max));
    // Keep the cursor line on screen.
    var b = c.t.term.buffer.active;
    var rows = c.t.term.rows;
    if (c.line < b.viewportY) { try { c.t.term.scrollToLine(c.line); } catch (e) {} }
    else if (c.line > b.viewportY + rows - 1) { try { c.t.term.scrollToLine(c.line - rows + 1); } catch (e) {} }
    if (c.anchor == null) {
      try { c.t.term.selectLines(c.line, c.line); } catch (e) {}
      hint.textContent = 'line ' + (c.line + 1) + ' of ' + (max + 1) + ' · ↑↓ PgUp/PgDn move · Space starts a selection · Esc exits';
    } else {
      var a = Math.min(c.anchor, c.line), z = Math.max(c.anchor, c.line);
      try { c.t.term.selectLines(a, z); } catch (e) {}
      hint.textContent = (z - a + 1) + ' line' + (z - a ? 's' : '') + ' selected · Enter copies · Esc cancels';
    }
  }
  function copyModeKey(e) {
    var c = copyMode, rows = c.t.term.rows;
    var k = e.key;
    if (k === 'Escape') { exitCopyMode(); return true; }
    if (k === 'ArrowUp' || k === 'k') { c.line--; paintCopy(); return true; }
    if (k === 'ArrowDown' || k === 'j') { c.line++; paintCopy(); return true; }
    if (k === 'PageUp') { c.line -= rows; paintCopy(); return true; }
    if (k === 'PageDown') { c.line += rows; paintCopy(); return true; }
    if (k === 'Home') { c.line = 0; paintCopy(); return true; }
    if (k === 'End') { c.line = copyLines(c.t) - 1; paintCopy(); return true; }
    if (k === ' ' || k === 'v') { c.anchor = (c.anchor == null) ? c.line : null; paintCopy(); return true; }
    if (k === 'Enter' || k === 'y') { copySel(c.t); exitCopyMode(); return true; }
    return true; // swallow everything else so keys never reach the shell
  }

  // ------------------------------------------------------------- broadcast
  var broadcastOn = false;
  var bcast = document.getElementById('bcast');
  function setBroadcast(on) {
    broadcastOn = !!on;
    bcast.style.display = broadcastOn ? 'flex' : 'none';
    document.getElementById('bcast-text').textContent =
      'Broadcasting input to all ' + allTerms().length + ' terminals';
    panes.forEach(fitActive);
    var t = activeTerm(); if (t && t.term) t.term.focus();
  }
  document.getElementById('bcast-stop').addEventListener('click', function () { setBroadcast(false); });

  // ------------------------------------------------------- sidebar + dock
  function setSidebar(state) { root.setAttribute('data-sidebar', state); setTimeout(function () { panes.forEach(fitActive); }, 40); }
  function toggleSidebar() { setSidebar(root.getAttribute('data-sidebar') === 'open' ? 'collapsed' : 'open'); }
  // One control does both directions: the tab-bar rail (.pc-rail), present whether the
  // sidebar is open or collapsed. The old header chevron and edge strip are gone.

  // The changes surface is a pane tab now (newDiffLeaf); the .pc-dock button and
  // Ctrl+Alt+D open/focus it instead of a side dock.
  function toggleDock() { openDiffLeaf(); }
  // Window frame controls. Forward-wired to a window.winmux bridge (present under Electron/
  // app-mode); in a plain browser, Maximize toggles fullscreen and Close calls window.close().
  // Minimize activates once WinMux runs as a real desktop window.
  function winBridge() { return window.winmux || null; }
  document.getElementById('wc-min').addEventListener('click', function () { var b = winBridge(); if (b && b.minimize) b.minimize(); });
  document.getElementById('wc-max').addEventListener('click', function () {
    var b = winBridge(); if (b && b.maximize) { b.maximize(); return; }
    try { if (!document.fullscreenElement) document.documentElement.requestFullscreen(); else document.exitFullscreen(); } catch (e) {}
  });
  // Closing with unsaved project changes should not silently leave the named project
  // file behind. Live session state is always auto-persisted (ct-live) and restored
  // next launch, so this guards the *project file*, not the working state — and only
  // the deliberate titlebar close is intercepted (Alt+F4 / taskbar close still exits
  // directly; the live state is restored on relaunch either way, still showing dirty).
  function doWindowClose() { var b = winBridge(); if (b && b.close) { b.close(); return; } window.close(); }
  function requestWindowClose() {
    // First close ever (desktop app only): closing is not quitting — the engine
    // and shells stay alive in the background. Unexplained, that persistence
    // reads as suspicious to a stranger; said once, it's the feature it is.
    var noticed; try { noticed = localStorage.getItem('ct-close-notice'); } catch (e) { noticed = '1'; }
    if (!noticed && winBridge()) {
      try { localStorage.setItem('ct-close-notice', '1'); } catch (e) {}
      confirmDialog3('Your terminals keep running',
        'Closing this window leaves your shells and agents running in the background, so reopening WinMux lands you right back on them. To end everything instead, choose Quit completely (always available in Settings).',
        'Close window', 'Quit completely',
        function () { requestWindowClose(); },
        function () { var done = function () { doWindowClose(); }; try { fetch('/api/shutdown', { method: 'POST' }).then(done, done); } catch (e) { done(); } });
      return;
    }
    if (!projectDirty()) { doWindowClose(); return; }
    var cur = readCurrent();
    confirmDialog3('Save changes to “' + (cur ? cur.name : 'this project') + '”?',
      'Your workspace changed since it was last saved to its project file.',
      'Save', 'Don’t save',
      function () {
        Projects.save(cur.name, cur.path, projectLayout()).then(function (r) {
          if (r && r.path) { markProjectClean(); doWindowClose(); }
          else notify('Save failed', (r && r.error) || 'could not write the project file');
        });
      },
      doWindowClose);
  }
  document.getElementById('wc-close').addEventListener('click', requestWindowClose);
  // ── Diff leaf (git changes as a pane tab) ───────────────────────────────
  // The git-diff surface is a pane tab, not a side dock. renderDiff/renderHunks
  // paint a git status into a given box using per-leaf state {files,active,refresh},
  // so each diff leaf owns its own file list, selection, and refresh handler.
  function refreshIcon() {
    return '<span class="drefresh" role="button" title="Refresh"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v6h6M20 20v-6h-6"/><path d="M20 9a8 8 0 0 0-14-3M4 15a8 8 0 0 0 14 3"/></svg></span>';
  }
  function renderDiff(d, box, state) {
    var add = 0, del = 0;
    state.files.forEach(function (f) { add += f.add || 0; del += f.del || 0; });
    var files = state.files.map(function (f, i) {
      return '<div class="dfile"' + (i === state.active ? ' data-active' : '') + ' data-i="' + i + '">' +
        '<span class="db ' + (f.st || 'M') + '">' + (f.st || 'M') + '</span>' +
        '<span class="dp">' + esc(f.path) + '</span>' +
        '<span class="dnums"><span class="a">+' + (f.add || 0) + '</span> <span class="d">-' + (f.del || 0) + '</span></span></div>';
    }).join('');
    box.innerHTML =
      '<div class="diff"><div class="diff-head"><span class="dt">' + esc(d.branch || 'HEAD') + '</span>' +
      '<span class="dstat"><span class="a">+' + add + '</span><span class="d">-' + del + '</span></span>' + refreshIcon() + '</div>' +
      '<div class="diff-body"><div class="diff-files">' + files + '</div><div class="diff-hunks"></div></div></div>';
    box.querySelector('.diff-files').addEventListener('click', function (e) {
      var row = e.target.closest ? e.target.closest('[data-i]') : null;
      if (!row) return;
      state.active = parseInt(row.getAttribute('data-i'), 10);
      [].forEach.call(box.querySelectorAll('.dfile'), function (x, i) {
        if (i === state.active) x.setAttribute('data-active', ''); else x.removeAttribute('data-active');
      });
      renderHunks(box, state);
    });
    var rf = box.querySelector('.drefresh');
    if (rf && state.refresh) rf.addEventListener('click', state.refresh);
    renderHunks(box, state);
  }
  function renderHunks(box, state) {
    var f = state.files[state.active];
    var hb = box.querySelector('.diff-hunks');
    if (!hb) return;
    if (!f || !f.hunks || !f.hunks.length) { hb.innerHTML = '<div style="padding:12px 14px;color:var(--faint)">' + (f && f.binary ? 'Binary file' : 'No preview') + '</div>'; return; }
    var html = '';
    f.hunks.forEach(function (h) {
      html += '<div class="hhdr">' + esc(h.h) + '</div>';
      var ln = h.rs;
      h.lines.forEach(function (l) {
        var kind = l[0] === 'a' ? 'add' : (l[0] === 'd' ? 'del' : '');
        var num = l[0] === 'd' ? '' : String(ln++);
        html += '<div class="hln ' + kind + '"><span class="hg">' + num + '</span><span class="hx">' + esc(l[1]) + '</span></div>';
      });
    });
    hb.innerHTML = html;
  }
  function fetchDiffInto(t) {
    var box = t.bodyEl;
    if (!box || !document.body.contains(box)) return;
    box.innerHTML = '<div class="diff-empty">Reading git status…</div>';
    fetch('/api/git?cwd=' + encodeURIComponent(t.diffCwd || ''))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!document.body.contains(box)) return;
        if (!d.ok) { box.innerHTML = '<div class="diff-empty">' + esc(d.error || 'No changes available') + '<div style="font-size:11.5px">' + esc(d.cwd || '') + '</div></div>'; return; }
        t.diffState.files = d.files || []; t.diffState.active = 0;
        setLeafTitle(t, (d.branch ? d.branch + ' ' : '') + 'Δ');
        if (!t.diffState.files.length) { box.innerHTML = '<div class="diff-empty">Working tree clean<div style="font-size:11.5px">' + esc(d.branch) + ' · ' + esc(d.root) + '</div></div>'; return; }
        renderDiff(d, box, t.diffState);
      })
      .catch(function () { if (document.body.contains(box)) box.innerHTML = '<div class="diff-empty">Could not read changes</div>'; });
  }
  function newDiffLeaf(p, cwd) {
    var id = ++termSeq;
    var host = document.createElement('div');
    host.className = 'term-host leafbody diffleaf';
    host.style.display = 'none';
    p.termArea.appendChild(host);

    var t = {
      id: id, paneId: p.id, groupId: activeGroupId, type: 'diff',
      term: null, fit: null, ws: null, host: host, tabEl: null, dotEl: null, progEl: null,
      bodyEl: host, diffCwd: cwd || '', diffState: { files: [], active: 0 },
      state: 'idle', status: 'idle', sid: null, ended: false,
      cwd: null, shell: null, results: null, renamed: false, resume: null, resumeId: null,
    };
    t.diffState.refresh = function () { fetchDiffInto(t); };
    function pn() { return paneById(t.paneId) || p; }

    var tabEl = document.createElement('div');
    tabEl.className = 'ptab';
    tabEl.draggable = true;
    tabEl.setAttribute('data-leaf', 'diff');
    tabEl.innerHTML =
      '<span class="tfav"><span class="fav fav-d">±</span><span class="fdot" style="display:none"></span></span>' +
      '<span class="tt">Changes</span>' +
      '<span class="x" title="Close tab (Alt+W)">×</span>';
    p.tabscroll.appendChild(tabEl);
    t.tabEl = tabEl; t.dotEl = tabEl.querySelector('.fdot');

    tabEl.addEventListener('click', function (e) {
      focusPane(t.paneId);
      if (e.target && e.target.classList.contains('x')) { e.stopPropagation(); askCloseTerm(pn(), id); }
      else activateTerm(pn(), id);
    });
    tabEl.addEventListener('mousedown', function (e) { if (e.button === 1) { e.preventDefault(); askCloseTerm(pn(), id); } });
    tabEl.addEventListener('dblclick', function (e) {
      if (e.target && e.target.classList.contains('x')) return;
      e.preventDefault(); e.stopPropagation(); focusPane(t.paneId); activateTerm(pn(), id); startRename(t);
    });
    wireTabDrag(t);
    // Re-read git each time the tab is shown, so it reflects the working tree now.
    t.onShow = function () { fetchDiffInto(t); };

    p.terms.push(t);
    updateChrome();
    activateTerm(p, id);   // activateTerm → onShow → fetchDiffInto (first read)
    return t;
  }
  function activeDiffLeaf() {
    var a = activeTerm();
    if (a && leafType(a) === 'diff') return a;
    var all = allTerms().filter(function (x) { return leafType(x) === 'diff'; });
    return all.length ? all[all.length - 1] : null;
  }
  // The repo a fresh diff leaf reads. The shell's cwd if it has moved somewhere
  // real; otherwise '' so /api/git falls back to the server's launch directory —
  // the repo WinMux was started from. (A shell parked at $HOME is not a "choice".)
  function diffDefaultCwd() {
    var at = activeTerm();
    var c = at && at.cwd;
    var norm = function (s) { return String(s || '').replace(/[\\/]+$/, '').toLowerCase(); };
    if (!c || norm(c) === norm(HOME)) return '';
    return c;
  }
  // The .pc-dock button + Ctrl+Alt+D: focus the existing diff leaf or make one
  // scoped to the active terminal's repo.
  function openDiffLeaf() {
    var t = activeDiffLeaf();
    if (t) {
      var lp = paneById(t.paneId);
      if (lp) { focusPane(lp.id); activateTerm(lp, t.id); }
      return t;
    }
    var p = paneById(activePaneId) || panes[0];
    if (!p) return null;
    return newDiffLeaf(p, diffDefaultCwd());
  }

  // ------------------------------------------------------- overlays / modals
  function openOvl(id) { document.getElementById(id).setAttribute('data-open', ''); }
  function closeOvl(id) { document.getElementById(id).removeAttribute('data-open'); }
  function anyOvlOpen() { return !!document.querySelector('.ovl[data-open]'); }
  [].forEach.call(document.querySelectorAll('.ovl'), function (o) {
    o.addEventListener('mousedown', function (e) { if (e.target === o) o.removeAttribute('data-open'); });
  });
  [].forEach.call(document.querySelectorAll('[data-close-ovl]'), function (b) {
    b.addEventListener('click', function () { closeOvl(b.getAttribute('data-close-ovl')); });
  });

  // Confirm / prompt dialogs (real, and used before destructive actions).
  function confirmDialog(title, text, okLabel, onOk) {
    var body = document.getElementById('dlg-body');
    body.innerHTML = '<h3>' + esc(title) + '</h3><p>' + esc(text) + '</p>' +
      '<div class="drow"><span class="btn" data-cancel>Cancel</span><span class="btn danger" data-ok>' + esc(okLabel) + '</span></div>';
    openOvl('dlg-ovl');
    body.querySelector('[data-cancel]').addEventListener('click', function () { closeOvl('dlg-ovl'); });
    body.querySelector('[data-ok]').addEventListener('click', function () { closeOvl('dlg-ovl'); onOk(); });
  }
  // Three-way close prompt: Save / Don't save / Cancel. Cancel just dismisses; the
  // other two run their callback. Used when closing a window with unsaved project
  // changes so the named project file is not silently left behind.
  function confirmDialog3(title, text, saveLabel, discardLabel, onSave, onDiscard) {
    var body = document.getElementById('dlg-body');
    body.innerHTML = '<h3>' + esc(title) + '</h3><p>' + esc(text) + '</p>' +
      '<div class="drow"><span class="btn" data-cancel>Cancel</span>' +
      '<span class="btn" data-discard>' + esc(discardLabel) + '</span>' +
      '<span class="btn primary" data-ok>' + esc(saveLabel) + '</span></div>';
    openOvl('dlg-ovl');
    body.querySelector('[data-cancel]').addEventListener('click', function () { closeOvl('dlg-ovl'); });
    body.querySelector('[data-discard]').addEventListener('click', function () { closeOvl('dlg-ovl'); onDiscard(); });
    body.querySelector('[data-ok]').addEventListener('click', function () { closeOvl('dlg-ovl'); onSave(); });
  }
  // An in-app text prompt. window.prompt() THROWS in Electron ("not supported"),
  // which silently killed New group / Rename group in the desktop app — so naming
  // goes through this instead. onOk(value) fires only on a non-empty confirm.
  function promptDialog(title, initial, okLabel, onOk) {
    var body = document.getElementById('dlg-body');
    body.innerHTML = '<h3>' + esc(title) + '</h3>' +
      '<input class="dlg-in" type="text" spellcheck="false" value="' + esc(initial || '') + '">' +
      '<div class="drow"><span class="btn" data-cancel>Cancel</span><span class="btn primary" data-ok>' + esc(okLabel || 'OK') + '</span></div>';
    openOvl('dlg-ovl');
    var input = body.querySelector('.dlg-in');
    input.focus(); input.select();
    var done = false;
    function finish(save) {
      if (done) return; done = true;
      var v = input.value.trim();
      closeOvl('dlg-ovl');
      if (save && v) onOk(v);
    }
    // Stop the app's global keyboard shortcuts from eating what you type.
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    body.querySelector('[data-cancel]').addEventListener('click', function () { finish(false); });
    body.querySelector('[data-ok]').addEventListener('click', function () { finish(true); });
  }
  // Paste-a-scheme dialog for theme import. A textarea (not the single-line prompt)
  // because a colour scheme is a block of JSON. On success it selects the new theme
  // and re-renders Settings so the picker shows it applied; on failure it shows the
  // parser's reason inline instead of closing.
  function importThemeDialog() {
    var body = document.getElementById('dlg-body');
    body.innerHTML = '<h3>Import terminal theme</h3>' +
      '<p class="fhint" style="margin:0 0 8px">Paste a Windows Terminal colour scheme (JSON) — it needs a name and all sixteen ANSI colours.</p>' +
      '<textarea class="dlg-in" spellcheck="false" rows="8" style="width:100%;box-sizing:border-box;resize:vertical;font-family:monospace" placeholder=\'{ "name": "Campbell", "black": "#0C0C0C", "red": "#C50F1F", ... }\'></textarea>' +
      '<div class="dlg-err" style="color:var(--danger,#e06c75);font-size:12px;min-height:16px;margin-top:4px"></div>' +
      '<div class="drow"><span class="btn" data-cancel>Cancel</span><span class="btn primary" data-ok>Import</span></div>';
    openOvl('dlg-ovl');
    var input = body.querySelector('.dlg-in');
    var err = body.querySelector('.dlg-err');
    input.focus();
    input.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); closeOvl('dlg-ovl'); } });
    body.querySelector('[data-cancel]').addEventListener('click', function () { closeOvl('dlg-ovl'); });
    body.querySelector('[data-ok]').addEventListener('click', function () {
      var r = importTheme(input.value);
      if (!r.ok) { err.textContent = r.error; return; }
      closeOvl('dlg-ovl');
      S.palette = r.id; applySettings(); renderSettings();
    });
  }
  // Capture the next chord and bind it to an action. rebindCapture makes the app's
  // global handler stand down; a one-shot capture listener (registered after it, so
  // it runs second and does the work) reads the chord, requires a modifier or a
  // function key, rejects a collision, then persists it and re-renders.
  function rebindShortcut(id) {
    var a = actionById(id); if (!a) return;
    var body = document.getElementById('dlg-body');
    body.innerHTML = '<h3>Rebind: ' + esc(a.label) + '</h3>' +
      '<p class="fhint" style="margin:0 0 8px">Press the new shortcut. It needs at least one of Ctrl / Alt / Shift, or a function key. Esc cancels.</p>' +
      '<div class="dlg-err" style="color:var(--danger,#e06c75);font-size:12px;min-height:16px"></div>' +
      '<div class="drow"><span class="btn" data-cancel>Cancel</span></div>';
    openOvl('dlg-ovl');
    var err = body.querySelector('.dlg-err');
    rebindCapture = true;
    function cleanup() { rebindCapture = false; document.removeEventListener('keydown', onKey, true); }
    function onKey(e) {
      e.preventDefault(); e.stopPropagation();
      var k = e.key;
      if (k === 'Escape') { cleanup(); closeOvl('dlg-ovl'); return; }
      if (k === 'Control' || k === 'Alt' || k === 'Shift' || k === 'Meta') return;   // wait for the real key
      var hasMod = e.ctrlKey || e.metaKey || e.altKey || e.shiftKey;
      if (!hasMod && !/^F\d+$/.test(k)) { err.textContent = 'That needs a modifier (Ctrl / Alt / Shift) or a function key.'; return; }
      var chord = chordOf(e);
      var clash = keymapLookup(chord);
      if (clash && clash.id !== id) { err.textContent = '"' + chord + '" is already used by "' + clash.label + '".'; return; }
      if (chord === a.def) delete KEYMAP[id]; else KEYMAP[id] = chord;
      saveKeymap(); cleanup(); closeOvl('dlg-ovl'); renderSettings();
    }
    body.querySelector('[data-cancel]').addEventListener('click', function () { cleanup(); closeOvl('dlg-ovl'); });
    document.addEventListener('keydown', onKey, true);
  }

  // ---------------------------------------------------------- save / load
  function layouts() { try { return JSON.parse(localStorage.getItem('ct-layouts') || '[]'); } catch (e) { return []; } }
  function snapshot() {
    var cols = [];
    [].forEach.call(wsrow.querySelectorAll('.wscol'), function (c) {
      var stack = [];
      [].forEach.call(c.querySelectorAll('.pane'), function (pe) {
        var p = null; panes.forEach(function (x) { if (x.el === pe) p = x; });
        if (!p) return;
        // All leaves persist now (ST6): terminals plus browser / markdown / diff.
        // Each tab saves only what its reopen needs; restore branches on `type`.
        var saveTabs = p.terms;
        stack.push({
          active: Math.max(0, saveTabs.map(function (t) { return t.id; }).indexOf(p.activeTermId)),
          tabs: saveTabs.map(function (t) {
            var g = groupById(t.groupId);
            var lt = leafType(t);
            // The group is saved by NAME, not id — ids are per-browser, names are the thing.
            var base = { type: lt, group: g ? g.name : '', title: t.renamed ? t.tabEl.querySelector('.tt').textContent : '' };
            if (lt === 'browser') { base.url = t.url || ''; return base; }
            if (lt === 'markdown') { base.mdPath = t.mdPath || ''; return base; }
            if (lt === 'diff') { base.diffCwd = t.diffCwd || ''; return base; }
            // terminal: the session id rides along only for the live-reload snapshot;
            // a saved *layout* is a template, so it drops the sid (see snapshot callers).
            // resumeId is the Claude conversation this tab is pinned to; `resume` is the
            // literal command built from it — both ride along so a reopened tab returns
            // to THAT conversation, in this folder.
            base.shell = t.shell; base.cwd = t.cwd || '';
            base.sid = t.sid || ''; base.resume = t.resume || '';
            base.resumeId = t.resumeId || ''; base.resumePin = !!t.resumePinnedByHand;
            return base;
          }),
        });
      });
      if (stack.length) cols.push(stack);
    });
    return { v: SCHEMA_VERSION, cols: cols, group: (groupById(activeGroupId) || {}).name || '' };
  }
  // The live layout — with each tab's session id — so a full page reload can land
  // back in the running shells instead of orphaning them. Saved on the way out and
  // whenever a session id is first learned, so a crash that skips beforeunload still
  // leaves a recent copy. This is NOT a named layout; it is the working state.
  function persistLive() {
    try { localStorage.setItem('ct-live', JSON.stringify(snapshot())); } catch (e) {}
    pushWorkspace();
  }
  // The engine's copy of the workspace (STATE.md: the engine owns it as a real
  // file; localStorage above is the warm cache). Pushes are throttled: layout
  // churn (drag-resize, rapid splits) coalesces into one write every few seconds,
  // with a trailing send so the last state always lands. Gated on workspaceReady
  // exactly like configReady — until boot has read the engine copy once, nothing
  // may overwrite it.
  var workspaceReady = false;
  var wsPushLast = 0, wsPushTimer = null;
  function pushWorkspaceNow(keepalive) {
    wsPushLast = Date.now();
    try {
      fetch('/api/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        keepalive: !!keepalive, body: JSON.stringify({ workspace: snapshot() }) }).catch(function () {});
    } catch (e) {}
  }
  function pushWorkspace() {
    if (!workspaceReady) return;
    var since = Date.now() - wsPushLast;
    if (since >= 2000) { pushWorkspaceNow(); return; }
    if (wsPushTimer) return;
    wsPushTimer = setTimeout(function () { wsPushTimer = null; pushWorkspaceNow(); }, 2000 - since);
  }
  // Restoring a layout that spanned several groups must land each terminal back in
  // its own group, making any group the layout names but this browser lacks.
  function groupByName(name) {
    if (!name) return null;
    for (var i = 0; i < groups.length; i++) if (groups[i].name === name) return groups[i];
    var g = { id: ++groupSeq, name: name, pinned: false };
    groups.push(g); sortGroups(); saveGroups();
    return g;
  }
  // The stored-layout schema version. Bump it whenever the snapshot() shape
  // changes, and add a step to migrateLayout() to bring old blobs forward. The
  // point (#212): an update that changes the format must never brick a returning
  // user — old state is upgraded, or safely discarded, never thrown on.
  var SCHEMA_VERSION = 4;
  function migrateLayout(desc) {
    if (!desc || typeof desc !== 'object') return null;
    var v = desc.v || 0;                      // pre-versioning blobs are v0 (== v1 shape)
    if (v > SCHEMA_VERSION) return null;       // written by a newer WinMux — don't guess, start clean
    // v2 added the per-tab `resume` command; an absent field is the correct
    // "not armed" state, so v0/v1 blobs need no transform to come forward.
    // v3 pins the exact Claude conversation (resumeId) instead of resuming whatever
    // the folder last touched. A v2 tab armed with the old `--continue` command has
    // no id to pin, and silently resuming the wrong conversation is worse than not
    // resuming — so drop the stale arm and let it be re-armed against a real id.
    if (v < 3) {
      (desc.cols || []).forEach(function (stack) {
        (stack || []).forEach(function (pd) {
          (pd.tabs || []).forEach(function (td) {
            if (td.resume && !td.resumeId) { td.resume = ''; td.resumeId = ''; }
          });
        });
      });
    }
    // v4 persists browser/markdown/diff leaves via a per-tab `type`. A v3 blob's
    // tabs have no `type`, which restore reads as 'terminal' — exactly right, since
    // v3 only ever saved terminals. No transform needed.
    return desc;
  }
  // Restores a layout, and is crash-safe on every path: a bad or future-format
  // blob is refused before anything is torn down, and if the rebuild itself
  // throws the app still lands on a working terminal instead of a blank frame.
  function restoreLayout(desc) {
    desc = migrateLayout(desc);
    if (!desc || !desc.cols || !desc.cols.length) return false;
    try {
      restoreLayoutUnsafe(desc);
      return true;
    } catch (e) {
      // Half-torn-down is worse than a fresh start — guarantee at least one shell.
      try {
        if (!panes.length) { var col = makeCol(); var fp = makePane(col); newTerm(fp, startShell()); focusPane(fp.id); updateChrome(); }
      } catch (e2) {}
      return false;
    }
  }
  function restoreLayoutUnsafe(desc) {
    clearZoom();
    panes.forEach(function (p) { p.terms.forEach(function (t) { killShell(t); try { t.term.dispose(); } catch (e) {} }); });
    panes = [];
    wsrow.innerHTML = '';
    desc.cols.forEach(function (stack) {
      var col = makeCol();
      var prev = null;
      stack.forEach(function (pd) {
        var p = makePane(col, prev);
        prev = p;
        (pd.tabs || []).forEach(function (td) {
          var t;
          var lt = td.type || 'terminal';       // v3-and-earlier tabs have no type → terminal
          if (lt === 'browser') {
            t = newBrowserLeaf(p, td.url || 'about:blank');
          } else if (lt === 'markdown') {
            t = newMarkdownLeaf(p, td.mdPath || '');
          } else if (lt === 'diff') {
            t = newDiffLeaf(p, td.diffCwd || '');
          } else {
            // td.sid is set only by the live-reload snapshot; connect() will send it
            // and the server reattaches if the shell is still warm, else spawns fresh.
            t = newTerm(p, td.shell, td.cwd, td.sid, td.resume || null, td.resumeId || null, td.resumePin);
            // A restored+armed tab runs its resume command once, on the first FRESH
            // shell it gets — a warm reattach (server survived a reload) clears this
            // without firing, so a live agent is never re-typed into. See fireResume().
            if (td.resume) t.autoResumePending = true;
          }
          var g = groupByName(td.group);
          if (g) t.groupId = g.id;
          if (td.title) { t.tabEl.querySelector('.tt').textContent = td.title; t.renamed = true; }
        });
        if (p.terms[pd.active]) activateTerm(p, p.terms[pd.active].id);
      });
    });
    var back = groupByName(desc.group);
    if (back) { activeGroupId = back.id; saveGroups(); }
    applyGroupVisibility();
    updateChrome();
    if (panes[0]) focusPane(panes[0].id);
    setTimeout(function () { panes.forEach(fitActive); }, 60);
  }
  // Layouts live in a small popover anchored to the sidebar button — saving and
  // loading are the same short list, so they are one surface, not two modals.
  var sessmenu = document.getElementById('projects-ovl');   // the Projects overlay (data-open toggled)
  var smName = document.getElementById('sm-name');
  var smList = document.getElementById('sm-list');
  // ---- projects: workspaces saved as real files on disk (server owns the disk) ----
  // A project is the current workspace written to a .json the user can back up or
  // move; the server exposes it over /api/project(s), so this is just fetch + render
  // on top of the same snapshot()/restoreLayout() the live layout already uses.
  var Projects = (function () {
    function api(method, url, body) {
      return fetch(url, { method: method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(function (r) { return r.json(); });
    }
    return {
      list: function () { return api('GET', '/api/projects'); },
      read: function (p) { return api('GET', '/api/project?path=' + encodeURIComponent(p)); },
      save: function (name, path, layout) { return api('POST', '/api/project', { name: name, path: path, layout: layout }); },
      // DELETE takes the path in the query, never a body — DELETE-with-body arrives
      // empty across HTTP clients, so a query param is the reliable form.
      forget: function (p, trash) { return api('DELETE', '/api/project?path=' + encodeURIComponent(p) + (trash ? '&trash=1' : '')); },
    };
  })();
  // The current project this window is bound to (path + name), so Save overwrites the
  // right file and the sidebar can show which project is open. A template, never live
  // session ids — reopening always spawns fresh shells (same rule as a saved layout).
  function readCurrent() { try { return JSON.parse(localStorage.getItem('ct-current') || 'null'); } catch (e) { return null; } }
  function setCurrent(path, name) {
    try { if (path) localStorage.setItem('ct-current', JSON.stringify({ path: path, name: name })); else localStorage.removeItem('ct-current'); } catch (e) {}
  }
  function projectLayout() {
    var d = snapshot();
    d.cols.forEach(function (c) { c.forEach(function (pd) { (pd.tabs || []).forEach(function (td) { td.sid = ''; }); }); });
    return d;
  }
  // Dirty-tracking for save-on-close. The baseline is the layout signature captured
  // the moment we bind to a project (save / open / boot-restore); projectDirty() is
  // true when a project is open and the live layout has drifted from that baseline.
  // Computed on demand from the same template Save writes, so there is no per-mutation
  // bookkeeping to forget — every real change to the panes shows up here.
  var projectBaseline = null;
  function projectSig() { try { return JSON.stringify(projectLayout()); } catch (e) { return null; } }
  function markProjectClean() { projectBaseline = projectSig(); }
  function projectDirty() {
    if (!readCurrent() || projectBaseline === null) return false;
    var s = projectSig();
    return s !== null && s !== projectBaseline;
  }
  // One-time migration: fold any browser-storage layouts (the retired system) into
  // real project files, so nothing a returning user saved is lost. Runs once, guarded
  // by a marker; the ct-layouts blob is left untouched as a silent safety copy — we
  // just stop surfacing it. Idempotent and non-destructive.
  function migrateLayoutsOnce() {
    try {
      if (localStorage.getItem('ct-projects-migrated')) return;
      var old = layouts();
      if (!old.length) { localStorage.setItem('ct-projects-migrated', '1'); return; }
      var pending = old.length;
      var done = function () { if (--pending <= 0) { try { localStorage.setItem('ct-projects-migrated', '1'); } catch (e) {} } };
      old.forEach(function (l) {
        var d = l.desc || {};
        (d.cols || []).forEach(function (c) { (c || []).forEach(function (pd) { (pd.tabs || []).forEach(function (td) { td.sid = ''; }); }); });
        Projects.save(l.name || 'Project', null, d).then(done, done);
      });
    } catch (e) {}
  }
  // Basename of a project path, for the row's file badge and the folder-colour hash.
  function baseName(p) { return (p || '').split(/[\\/]/).pop() || p; }
  var FOLDER_COLORS = ['#8a5cf5', '#e9973f', '#44cf6e', '#fb464c', '#3f9ae9', '#d05ce9'];
  function folderColor(s) { var h = 0; for (var i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return FOLDER_COLORS[Math.abs(h) % FOLDER_COLORS.length]; }
  var recentsCache = [];
  // One row generator for every surface that lists recents (the projects overlay
  // and the SB-arc sidebar panel), so the two can't drift apart.
  function pjrowHTML(p, i) {
    var file = baseName(p.path);
    var chips = (p.shells || []).map(function (s) { return '<span class="pjrow-chip">' + esc(s) + '</span>'; }).join('');
    var badge = p.missing
      ? '<span class="pjrow-miss">missing</span>'
      : '<span class="pjrow-badge">' + (p.tabs || 0) + ' tab' + (p.tabs === 1 ? '' : 's') + '</span>';
    return '<div class="pjrow' + (p.missing ? ' missing' : '') + '" data-i="' + i + '" role="button" title="' + (p.missing ? 'File missing — click to remove' : 'Open this project') + '">' +
      '<span class="pjrow-dot" style="background:' + folderColor(file) + '"></span>' +
      '<div class="pjrow-main">' +
        '<div class="pjrow-top"><span class="pjrow-name">' + esc(p.name || file) + '</span>' + badge + '</div>' +
        (p.dir ? '<div class="pjrow-dir mono">' + esc(p.dir) + '</div>' : '') +
        (chips ? '<div class="pjrow-chips">' + chips + '</div>' : '') +
      '</div>' +
      '<div class="pjrow-meta"><span class="pjrow-when">' + (p.opened ? esc(ago(p.opened)) : '') + '</span>' +
        '<span class="pjrow-file mono">' + esc(file) + '</span></div>' +
      '<span class="pjrow-del" data-del="' + i + '" title="Remove from recent">×</span></div>';
  }
  function renderLayouts() {
    Projects.list().then(function (r) {
      recentsCache = (r && r.recents) || [];
      refreshSxProjects();
      if (!recentsCache.length) { smList.innerHTML = '<div class="proj-empty">No projects yet. Name this workspace above and hit Save.</div>'; return; }
      smList.innerHTML = recentsCache.map(pjrowHTML).join('');
    }).catch(function () { smList.innerHTML = '<div class="proj-empty">Projects unavailable.</div>'; });
  }
  // Shared verbs behind a recents row, wherever the row lives. Open reads the
  // file then routes through the same openSavedLayout path as ever; remove asks
  // the same two-way question (drop the row vs delete the file), then refreshes
  // via the caller's `after`.
  function openRecent(p) {
    closeLayoutMenu();
    Projects.read(p.path).then(function (r) {
      if (!r || !r.layout) { notify('Open failed', (r && r.error) || 'could not read the project'); return; }
      openSavedLayout({ name: r.name || p.name, desc: r.layout, path: p.path });
    });
  }
  function removeRecent(d, after) {
    confirmDialog3('Remove “' + (d.name || baseName(d.path)) + '”?',
      'Remove it from this list (the file stays in ' + (d.dir || 'its folder') + '), or delete the project file itself.',
      'Remove from list', 'Delete the file',
      function () { Projects.forget(d.path).then(after); },
      function () {
        Projects.forget(d.path, true).then(function () {
          var cur = readCurrent();
          if (cur && cur.path === d.path) { setCurrent(null); projectBaseline = null; if (typeof updateProjectRow === 'function') updateProjectRow(); }
          after();
          notify('Project deleted', (d.name || baseName(d.path)) + ' — file removed.');
        });
      });
  }
  // Recent & recoverable (PT-4): every saved scrollback the engine still holds,
  // with its age and its expiry in plain sight — the 235 invisible files problem.
  // Rows are the two honest verbs: click restores it into a new tab (a detached
  // session reattaches live; a dead one replays its saved output), × dismisses it
  // for good. Sessions already open in this window are not "recoverable" — hidden.
  var smRecover = document.getElementById('sm-recover');
  var smRecoverLbl = document.getElementById('sm-recover-lbl');
  var recoverCache = [];
  function renderRecoverables() {
    fetch('/api/backlog', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      var open = {};
      allTerms().forEach(function (t) { if (t.sid) open[t.sid] = true; });
      recoverCache = ((j && j.items) || []).filter(function (b) { return !open[b.sid]; });
      var show = recoverCache.length > 0;
      smRecoverLbl.style.display = show ? '' : 'none';
      smRecover.style.display = show ? '' : 'none';
      // The engine caps the list at the newest 30 — say so instead of letting a
      // capped list read as "that's everything".
      var total = (j && j.total) || 0;
      smRecoverLbl.textContent = 'Recent & recoverable sessions' +
        (total > ((j && j.items) || []).length ? ' — newest ' + j.items.length + ' of ' + total : '');
      if (!show) { smRecover.innerHTML = ''; return; }
      var now = Date.now();
      smRecover.innerHTML = recoverCache.map(function (b, i) {
        var days = Math.max(1, Math.ceil((b.expiresAt - now) / 86400000));
        return '<div class="pjrow" data-ri="' + i + '" role="button" title="' +
            (b.live ? 'This shell is still running — click to bring it back as a tab' : 'Click to restore its saved output into a new tab') + '">' +
          '<span class="pjrow-dot" style="background:' + (b.live ? '#44cf6e' : '#e9973f') + '"></span>' +
          '<div class="pjrow-main">' +
            '<div class="pjrow-top"><span class="pjrow-name">' + esc(labelFor(b.shell) || 'Terminal') + '</span>' +
              '<span class="pjrow-badge">' + (b.live ? 'still running' : 'saved output') + '</span></div>' +
            (b.cwd ? '<div class="pjrow-dir mono">' + esc(b.cwd) + '</div>' : '') +
          '</div>' +
          '<div class="pjrow-meta"><span class="pjrow-when">' + esc(ago(b.savedAt)) + '</span>' +
            '<span class="pjrow-file mono">expires in ' + days + 'd</span></div>' +
          '<span class="pjrow-del" data-rdel="' + i + '" title="Dismiss — delete this saved output for good">×</span></div>';
      }).join('');
    }).catch(function () { smRecoverLbl.style.display = 'none'; smRecover.style.display = 'none'; });
  }
  smRecover.addEventListener('click', function (e) {
    var del = e.target.closest ? e.target.closest('[data-rdel]') : null;
    if (del) {
      e.stopPropagation();
      var d = recoverCache[parseInt(del.getAttribute('data-rdel'), 10)];
      // Dismiss deletes the saved output for good — the one irreversible verb on
      // this list, so it gets the same confirm gate as deleting a project file.
      if (d) confirmDialog('Dismiss this saved output?',
        'Its scrollback is deleted for good — there is no way back after this.',
        'Dismiss', function () {
          fetch('/api/backlog?sid=' + encodeURIComponent(d.sid), { method: 'DELETE' }).then(renderRecoverables, renderRecoverables);
        });
      return;
    }
    var row = e.target.closest ? e.target.closest('[data-ri]') : null;
    if (!row) return;
    var b = recoverCache[parseInt(row.getAttribute('data-ri'), 10)];
    if (!b) return;
    closeLayoutMenu();
    var p = paneById(activePaneId) || panes[0];
    if (!p) return;
    // Seeding the sid routes through the existing reattach path: a live session
    // comes back as-is; a dead one lands a fresh shell with the backlog replayed
    // above it (which then consumes the file — see replayBacklog).
    newTerm(p, b.shell || startShell(), b.cwd || '', b.sid);
    focusPane(p.id);
  });
  // The Projects panel is a proper centered overlay now (not a sidebar popover), so it
  // never collides with the footer and reads as the real surface it is. Same open verb
  // the footer icons / Ctrl+Alt+O / palette all call.
  function openLayoutMenu(anchor) {
    renderLayouts();
    renderRecoverables();
    var cur = readCurrent();
    smName.value = cur ? cur.name : '';
    // The Close verb only exists while a project is actually open.
    var closeBtn = document.getElementById('pj-close');
    closeBtn.style.display = cur ? '' : 'none';
    if (cur) document.getElementById('pj-close-sub').textContent = 'Unbind “' + cur.name + '” — the file stays';
    openOvl('projects-ovl');
    if (currentMode !== 'narrow') setTimeout(function () { try { smName.focus(); } catch (e) {} }, 30);
  }
  function closeLayoutMenu() { closeOvl('projects-ovl'); }
  function toggleLayoutMenu(anchor) {
    if (sessmenu.hasAttribute('data-open')) closeLayoutMenu(); else openLayoutMenu(anchor);
  }
  function doSaveProject() {
    var cur = readCurrent();
    var name = (smName.value || (cur && cur.name) || '').trim();
    if (!name) { smName.focus(); return; }
    Projects.save(name, cur ? cur.path : null, projectLayout()).then(function (r) {
      if (!r || !r.path) { notify('Save failed', (r && r.error) || 'could not write the project file'); return; }
      setCurrent(r.path, name);
      markProjectClean();
      if (typeof updateProjectRow === 'function') updateProjectRow();
      renderLayouts();
      notify('Project saved', name);
    });
  }
  document.getElementById('sm-save').addEventListener('click', doSaveProject);
  smName.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') doSaveProject(); if (e.key === 'Escape') closeLayoutMenu(); });
  smList.addEventListener('click', function (e) {
    var del = e.target.closest ? e.target.closest('[data-del]') : null;
    if (del) {
      e.stopPropagation();
      var d = recentsCache[parseInt(del.getAttribute('data-del'), 10)];
      // Delete is a real verb now (PT-5), so the × asks which one you meant:
      // drop the row (file untouched) or delete the file itself, confirmed.
      if (d) removeRecent(d, renderLayouts);
      return;
    }
    var row = e.target.closest ? e.target.closest('[data-i]') : null;
    if (!row) return;
    var p = recentsCache[parseInt(row.getAttribute('data-i'), 10)];
    if (!p) return;
    if (p.missing) { Projects.forget(p.path).then(renderLayouts); return; }
    openRecent(p);
  });

  // ------------------------------------------------- sidebar tabs (SB arc)
  // The Obsidian model Edward asked for: the left rail hosts several panels
  // behind a slim icon strip — Sessions (the fleet), Projects (saved layouts),
  // Notifications (the bell IS the third tab). Desktop/half only; on narrow the
  // strip hides, the relocated controls go home to .sx-head, and the settled
  // phone drill-in flow is untouched.
  var sxAside = document.querySelector('.sessions');
  function sxTabEl(name) {
    return name === 'notif' ? document.getElementById('open-notif') : document.getElementById('sxtab-' + name);
  }
  function setSidebarTab(name) {
    if (!sxAside) return;
    // Leaving the Notifications panel closes it properly (badge/backdrop rules
    // live in closeNotif; here we only drop the visual open state).
    if (name !== 'notif') npanel.removeAttribute('data-open');
    sxAside.setAttribute('data-sxtab', name);
    ['sessions', 'projects', 'notif'].forEach(function (k) {
      var el = sxTabEl(k);
      if (el) { if (k === name) el.setAttribute('data-active', ''); else el.removeAttribute('data-active'); }
    });
    if (name === 'projects') renderSxProjects();
    // Notifications are transient attention, not a resting place — the persisted
    // tab is always Sessions or Projects, so a reload never lands on the bell.
    if (name !== 'notif' && S.sidebarTab !== name) { S.sidebarTab = name; saveSettings(); }
  }
  // Keep the relocatable controls (bell, palette, update badge) and #npanel in
  // the container that owns them for the current mode. Single nodes with single
  // ids — same relocation pattern as #winctl — so every existing listener,
  // badge, and harness hook rides along untouched.
  function placeSidebarControls() {
    var strip = document.getElementById('sx-tabs');
    var head = sxAside && sxAside.querySelector('.sx-head');
    if (!strip || !head) return;
    var bell = document.getElementById('open-notif');
    var pal = document.getElementById('open-palette');
    var up = document.getElementById('upbadge');
    var sp = document.getElementById('sx-tabs-sp');
    if (currentMode === 'narrow') {
      if (up) head.appendChild(up);
      if (pal) head.appendChild(pal);
      if (bell) head.appendChild(bell);
      if (npanel.parentElement !== document.body) document.body.appendChild(npanel);
      // Notif is never a resting tab; make sure a return to desktop lands on one.
      if (sxAside.getAttribute('data-sxtab') === 'notif') setSidebarTab(S.sidebarTab === 'projects' ? 'projects' : 'sessions');
    } else {
      if (bell && sp) strip.insertBefore(bell, sp);
      if (up) strip.appendChild(up);
      if (pal) strip.appendChild(pal);
      var slot = document.getElementById('sxp-notif');
      if (slot && npanel.parentElement !== slot) slot.appendChild(npanel);
    }
  }
  var sxProjCache = [];
  function renderSxProjects() {
    var list = document.getElementById('sx-plist');
    if (!list) return;
    Projects.list().then(function (r) {
      sxProjCache = (r && r.recents) || [];
      if (!sxProjCache.length) { list.innerHTML = '<div class="proj-empty">No projects yet. Save one from the footer and it lands here.</div>'; return; }
      list.innerHTML = sxProjCache.map(pjrowHTML).join('');
    }).catch(function () { list.innerHTML = '<div class="proj-empty">Projects unavailable.</div>'; });
  }
  // Called by renderLayouts so a save/remove in the overlay refreshes the panel.
  function refreshSxProjects() {
    if (currentMode !== 'narrow' && sxAside && sxAside.getAttribute('data-sxtab') === 'projects') renderSxProjects();
  }
  document.getElementById('sx-plist').addEventListener('click', function (e) {
    var del = e.target.closest ? e.target.closest('[data-del]') : null;
    if (del) {
      e.stopPropagation();
      var d = sxProjCache[parseInt(del.getAttribute('data-del'), 10)];
      if (d) removeRecent(d, renderSxProjects);
      return;
    }
    var row = e.target.closest ? e.target.closest('[data-i]') : null;
    if (!row) return;
    var p = sxProjCache[parseInt(row.getAttribute('data-i'), 10)];
    if (!p) return;
    if (p.missing) { Projects.forget(p.path).then(renderSxProjects); return; }
    openRecent(p);
  });
  document.getElementById('sxtab-sessions').addEventListener('click', function () { setSidebarTab('sessions'); });
  document.getElementById('sxtab-projects').addEventListener('click', function () { setSidebarTab('projects'); });
  // Drag-resize on the rail's right edge. During the drag only the CSS var
  // moves (cheap); terminals refit once on release, same as the pane dividers.
  (function () {
    var h = document.getElementById('sx-resize');
    if (!h || !sxAside) return;
    function setSbw(px, save) {
      px = Math.max(200, Math.min(420, Math.round(px)));
      document.documentElement.style.setProperty('--sbw', px + 'px');
      if (save && S.sidebarWidth !== px) { S.sidebarWidth = px; saveSettings(); }
      return px;
    }
    window.__winmuxSidebarWidth = function (px) { var v = setSbw(px, true); setTimeout(function () { panes.forEach(fitActive); }, 30); return v; };
    // Boot: paint the persisted width now — applySettings only re-runs when the
    // disk config differs from the warm cache, so it can't be the only painter.
    setSbw(Math.round(S.sidebarWidth) || 264, false);
    h.addEventListener('mousedown', function (e) {
      if (currentMode === 'narrow') return;
      e.preventDefault();
      h.classList.add('drag');
      var left = sxAside.getBoundingClientRect().left;
      function mv(ev) { setSbw(ev.clientX - left, false); }
      function up(ev) {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        h.classList.remove('drag');
        setSbw(ev.clientX - left, true);
        setTimeout(function () { panes.forEach(fitActive); }, 30);
      }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
    h.addEventListener('dblclick', function () { setSbw(264, true); setTimeout(function () { panes.forEach(fitActive); }, 30); });
  })();
  // Boot: land on the persisted resting tab (never the bell — notif is transient).
  setSidebarTab(S.sidebarTab === 'projects' ? 'projects' : 'sessions');

  // Close project (PT-5, STATE.md): unbind from the named file and return to the
  // unnamed workspace. One question, three honest outcomes — keep the sessions
  // running, end this project's sessions, or save first. Closing NEVER deletes
  // the file; the workspace keeps auto-saving either way.
  function closeProject() {
    var cur = readCurrent();
    if (!cur) { notify('No project open', 'The workspace is unnamed right now — nothing to close.'); return; }
    closeLayoutMenu();
    var live = allTerms().filter(function (t) { return t.state === 'open'; }).length;
    var dirty = projectDirty();
    var unbind = function () {
      setCurrent(null); projectBaseline = null;
      if (typeof updateProjectRow === 'function') updateProjectRow();
      persistLive();
      notify('Project closed', cur.name + ' — the file stays in your projects list.');
    };
    var endSessions = function () {
      restoreLayout({ v: SCHEMA_VERSION, cols: [[{ active: 0, tabs: [{ type: 'terminal', shell: startShell(), cwd: '' }] }]], group: '' });
      unbind();
    };
    var saveFirst = function () {
      Projects.save(cur.name, cur.path, projectLayout()).then(unbind, unbind);
    };
    var body = document.getElementById('dlg-body');
    body.innerHTML = '<h3>Close “' + esc(cur.name) + '”?</h3>' +
      '<p>The project file stays on disk' + (dirty ? ' — it does not have your latest layout changes yet' : '') +
      '. What should happen to ' + (live ? 'its ' + live + ' running terminal' + (live === 1 ? '' : 's') : 'the workspace') + '?</p>' +
      '<div class="drow"><span class="btn" data-cancel>Cancel</span>' +
      '<span class="btn danger" data-end>End the sessions</span>' +
      (dirty ? '<span class="btn" data-keep>Keep them running</span><span class="btn primary" data-save>Save first, keep running</span>'
             : '<span class="btn primary" data-keep>Keep them running</span>') +
      '</div>';
    openOvl('dlg-ovl');
    body.querySelector('[data-cancel]').addEventListener('click', function () { closeOvl('dlg-ovl'); });
    body.querySelector('[data-keep]').addEventListener('click', function () { closeOvl('dlg-ovl'); unbind(); });
    body.querySelector('[data-end]').addEventListener('click', function () { closeOvl('dlg-ovl'); endSessions(); });
    var sv = body.querySelector('[data-save]');
    if (sv) sv.addEventListener('click', function () { closeOvl('dlg-ovl'); saveFirst(); });
  }
  document.getElementById('pj-close').addEventListener('click', closeProject);
  // New project — end the current workspace (asking first if it is live) and start
  // clean, unbound to any file.
  function newProject() {
    closeLayoutMenu();
    var start = function () {
      setCurrent(null); projectBaseline = null;
      restoreLayout({ v: SCHEMA_VERSION, cols: [[{ active: 0, tabs: [{ type: 'terminal', shell: startShell(), cwd: '' }] }]], group: '' });
      if (typeof updateProjectRow === 'function') updateProjectRow();
    };
    var live = allTerms().filter(function (t) { return t.state === 'open'; }).length;
    if (S.confirmClose && live) confirmDialog('Start a new project?', live + ' running terminal' + (live > 1 ? 's' : '') + ' will be ended.', 'New project', start);
    else start();
  }
  document.getElementById('pj-new').addEventListener('click', newProject);
  // Open a project file by typed path — the browser cannot hand us an absolute path
  // from a native picker, so we ask for one (the winmux CLI's `open` is the richer path).
  document.getElementById('pj-openfile').addEventListener('click', function () {
    var p = prompt('Open project file — full path to a .json:', (readCurrent() || {}).path || '');
    if (!p) return;
    Projects.read(p.trim()).then(function (r) {
      if (!r || !r.layout) { notify('Open failed', (r && r.error) || 'could not read that file'); return; }
      closeLayoutMenu();
      openSavedLayout({ name: r.name || p, desc: r.layout, path: p.trim() });
    });
  });
  // Restore a saved workspace by object — shared by the projects menu, open-file, and
  // the command palette. Restoring ends whatever is running now, so it asks first, and
  // binds this window to the opened project file.
  function openSavedLayout(l) {
    if (!l) return;
    var apply = function () {
      restoreLayout(l.desc);
      if (l.path) { setCurrent(l.path, l.name); markProjectClean(); if (typeof updateProjectRow === 'function') updateProjectRow(); }
    };
    var live = allTerms().filter(function (t) { return t.state === 'open'; }).length;
    if (S.confirmClose && live) {
      confirmDialog('Open “' + l.name + '”?', live + ' running terminal' + (live > 1 ? 's' : '') + ' will be ended and the saved panes rebuilt.', 'Open project', apply);
    } else apply();
  }
  // Click the dimmed backdrop (outside the card) to close the Projects overlay.
  sessmenu.addEventListener('mousedown', function (e) { if (e.target === sessmenu) closeLayoutMenu(); });
  function saveLayoutDialog() { openLayoutMenu(document.getElementById('open-save')); }
  function loadLayoutDialog() { openLayoutMenu(document.getElementById('open-load')); }

  // ------------------------------------------------------------- settings UI
  var SETTABS = ['Appearance', 'Terminal', 'Behaviour', 'Phone', 'Shortcuts', 'About'];
  var curSet = 'Terminal';
  function sw(key, on) { return '<span class="sw ' + (on ? 'on' : '') + '" data-sw="' + key + '"></span>'; }
  function sel(key, opts, cur) {
    return '<select class="ctl" data-set="' + key + '">' + opts.map(function (o) {
      var v = typeof o === 'string' ? o : o[0], l = typeof o === 'string' ? o : o[1];
      return '<option value="' + esc(v) + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + esc(l) + '</option>';
    }).join('') + '</select>';
  }
  function frow(n, h, c) { return '<div class="frow"><div class="fl"><div class="fname">' + n + '</div>' + (h ? '<div class="fhint">' + h + '</div>' : '') + '</div>' + c + '</div>'; }
  function settingsPane(t) {
    if (t === 'Appearance') {
      return frow('Theme', 'Dark, light, or follow Windows', sel('theme', [['system', 'Match system'], ['dark', 'Dark'], ['light', 'Light']], S.theme)) +
        frow('Colours', 'The sixteen colours the shell paints with', sel('palette',
          Object.keys(allPalettes()).map(function (k) { return [k, allPalettes()[k].label]; }), S.palette)) +
        frow('Import terminal theme', 'Paste a Windows Terminal colour scheme (JSON) to add it to the list above', '<span class="btn" data-act="import-theme">Import theme…</span>') +
        frow('Font', 'Applied to every open terminal', sel('fontFamily', Object.keys(FONTS), S.fontFamily)) +
        frow('Font size', 'Also Ctrl + / Ctrl − / Ctrl+wheel', '<input class="ctl" type="number" min="8" max="28" value="' + S.fontSize + '" data-set="fontSize" style="width:70px">') +
        frow('Line height', '', '<input class="ctl" type="number" min="1" max="2" step="0.05" value="' + S.lineHeight + '" data-set="lineHeight" style="width:70px">');
    }
    if (t === 'Terminal') {
      return frow('Cursor style', '', sel('cursorStyle', [['block', 'Block'], ['underline', 'Underline'], ['bar', 'Bar']], S.cursorStyle)) +
        frow('Cursor blink', '', sw('cursorBlink', S.cursorBlink)) +
        frow('Instant typing', 'Paints each key the moment you press it and reconciles with the shell a beat later. Turns itself off around password prompts and full-screen apps.', sw('localEcho', S.localEcho)) +
        frow('Scrollback lines', 'How much history each terminal keeps', '<input class="ctl" type="number" min="500" max="100000" step="500" value="' + S.scrollback + '" data-set="scrollback" style="width:92px">') +
        frow('Copy on select', 'Selecting text copies it straight away', sw('copyOnSelect', S.copyOnSelect)) +
        frow('Right-click pastes', 'Otherwise right-click opens the menu', sw('rightClickPaste', S.rightClickPaste)) +
        frow('Programming ligatures', 'Draws => as a single arrow, != as ≠, and so on. Costs speed: ligatures need the software renderer, so heavy output from several agents at once redraws more slowly. Off by default.', sw('ligatures', S.ligatures)) +
        frow('Mark command results', 'After each command, show a small ✓ or ✗ with the time — green when it worked, red when it failed — right after the command. Off by default.', sw('commandBlocks', S.commandBlocks));
    }
    if (t === 'Behaviour') {
      var isEl = !!(window.winmux && window.winmux.isElectron);
      return frow('Confirm before closing', 'Ask before ending a running shell', sw('confirmClose', S.confirmClose)) +
        frow('Desktop notifications', 'Alert you when a session needs you and WinMux is not the window you are looking at', sw('osNotify', S.osNotify)) +
        frow('Sync clipboard across devices', 'Copy on this device makes the text available to paste on your phone (and back) over your tailnet. Held in memory only, never saved to disk. Off by default.', sw('clipSync', S.clipSync)) +
        frow('Save terminal history to disk', 'Recent output is saved so a full restart replays it above a fresh prompt. That history can include secrets a command printed (tokens, passwords). Turning this off stops saving and deletes what’s already on disk. On by default.', '<span class="sw ' + (historyS && historyS.persist !== false ? 'on' : '') + '" data-history-toggle role="button" aria-label="Save terminal history to disk"></span>') +
        frow('Default shell', 'Used by new tabs and splits', sel('defaultShell', [['', 'First available (' + labelFor(DEFAULT_SHELL) + ')']].concat(SHELLS.map(function (s) { return [s.key, s.label]; })), S.defaultShell)) +
        frow('Start folder', 'Blank = your home folder', '<input class="ctl" type="text" value="' + esc(S.startFolder) + '" data-set="startFolder" placeholder="' + esc(HOME) + '" style="width:230px" spellcheck="false">') +
        frow('Resume command', 'Run in each armed tab when WinMux reopens (right-click a tab → “Auto-resume this conversation”). {id} is replaced with that tab’s pinned Claude conversation.', '<input class="ctl" type="text" value="' + esc(S.resumeCommand) + '" data-set="resumeCommand" placeholder="claude --resume {id}" style="width:280px" spellcheck="false">') +
        frow('Start WinMux when I log in', 'Reopens WinMux automatically after a restart so your tabs and their history come right back — no relaunching by hand. Adds a small launcher to your Windows Startup folder; turning this off removes it. Off by default.', '<span class="sw ' + (autostartS && autostartS.on ? 'on' : '') + '" data-autostart-toggle role="button" aria-label="Start WinMux when I log in"></span>') +
        (isEl ? (
          frow('Drop down on a hotkey', 'A global shortcut slides WinMux over whatever you’re in; press it again to hide, sessions untouched. It grabs that key across every app, so it stays off until you switch it on.', sw('quakeEnabled', S.quakeEnabled)) +
          frow('Hotkey', 'The key that shows and hides WinMux. Electron accelerator names, e.g. Control+` or F12.', '<input class="ctl" type="text" value="' + esc(S.quakeHotkey) + '" data-set="quakeHotkey" placeholder="Control+`" style="width:150px" spellcheck="false">') +
          frow('Closing the window', 'Your shells and agents keep running in the background — reopen WinMux to land right back on them. Use this only when you want to stop everything.', '<span class="btn" data-act="quit-server">Quit completely &amp; stop all sessions</span>')
        ) : '');
    }
    if (t === 'Phone') return phonePane();
    if (t === 'Shortcuts') {
      var rows = ACTIONS.map(function (a) {
        var custom = !!KEYMAP[a.id];
        return '<div class="frow"><div class="fl"><div class="fname">' + esc(a.label) + '</div>' +
          (custom ? '<div class="fhint">default ' + esc(a.def) + '</div>' : '') + '</div>' +
          '<span class="kbd kb-chord">' + esc(effectiveChord(a)) + '</span>' +
          '<span class="btn kb-rebind" data-rebind="' + a.id + '">Rebind</span>' +
          (custom ? '<span class="btn kb-reset" data-resetkey="' + a.id + '">Reset</span>' : '') +
          '</div>';
      }).join('');
      return rows +
        '<div style="margin-top:14px"><span class="btn" data-act="reset-keys">Reset all shortcuts</span> <span class="btn" data-act="cheat">Full list (F1)</span></div>';
    }
    return '<div style="font-size:13px;margin-bottom:6px">WinMux ' + (APP_VERSION ? 'v' + esc(APP_VERSION) : '') + '</div>' +
      '<div style="font-size:12.5px;color:var(--muted);line-height:1.6;margin-bottom:14px">A terminal multiplexer for Windows. Runs real shells on this machine. It always listens on 127.0.0.1, where only this PC can reach it. Reaching it from your phone is off until you switch it on in Settings → Phone.</div>' +
      '<div><span class="btn" data-act="diag">Diagnostics</span> <span class="btn" data-act="reset">Reset settings</span></div>';
  }

  // ------------------------------------------------------------- phone access
  // Opening this page is holding a shell on this PC, so the switch says so in
  // plain words and the state always comes from the server, never a local guess.
  var phoneS = null;              // last state from /api/phone, or null while loading
  var phoneBusy = false;
  var phoneErr = '';              // why the last flip failed, shown next to the switch
  function phonePane() {
    if (!phoneS) return '<div style="font-size:12.5px;color:var(--muted)">Checking…</div>';
    var p = phoneS;
    var canFlip = p.canChange && (p.on || p.tailscale);
    // The line under the switch must never contradict the switch itself.
    var hint = !p.canChange ? 'You are already on the phone link. This switch only works at the PC itself.'
      : p.on ? 'On — your phone can open these terminals over Tailscale.'
      : !p.tailscale ? 'Tailscale is not running on this PC, so there is no private address to use.'
      : 'Off — this window works on this PC only.';
    var out = frow('Use on my phone', hint,
      '<span class="sw ' + (p.on ? 'on' : '') + (canFlip ? '' : ' off-disabled') + '" data-phone-toggle role="button" aria-label="Use on my phone"></span>');
    // A switch that refuses to move has to say why right here — the person is
    // looking at this panel, not at the notification bell.
    if (phoneErr) out += '<div class="phone-err" id="phone-err" role="alert">' + esc(phoneErr) + '</div>';
    if (p.on) {
      out += '<div class="phone-live">' +
        '<div class="phone-qr"><img alt="Scan to open on your phone" src="/api/phone/qr?t=' + Date.now() + '"></div>' +
        '<div class="phone-side">' +
          '<div class="phone-lab">Scan this with your phone camera</div>' +
          '<div class="phone-url" id="phone-url">' + esc(p.url) + '</div>' +
          '<div><span class="btn" data-act="phone-copy">Copy link</span></div>' +
          '<div class="phone-warn">Your phone must be signed in to the same Tailscale account. Anyone who gets this link gets your PC — don’t paste it into a chat, and switch this off when you’re done.</div>' +
        '</div>' +
      '</div>';
    } else if (!p.tailscale) {
      // The stranger's biggest wall: the word "Tailscale" with no explanation.
      // Say what it is, why it's the transport, and hand them the install link —
      // never a dead end that assumes they already run it.
      out += '<div class="phone-off">Phone access rides on <b>Tailscale</b> — a free app that builds a private network between your own devices, so nothing is ever exposed to the open internet. Install it on this PC and on your phone, sign in to the <b>same account</b> on both, then come back and flip this switch.' +
        '<div style="margin-top:10px"><span class="btn" data-act="get-tailscale">Get Tailscale (free)</span></div></div>';
    } else {
      out += '<div class="phone-off">Switch this on and you’ll get a square to scan. Your phone opens the same terminals you see here, over Tailscale — nothing is exposed to the open internet, and the link stops working the moment you switch it back off.</div>';
    }
    out += trustRow(p) + deviceSection(p);
    return out;
  }
  // The second switch. It is a genuine widening of who gets in, so the hint
  // counts the devices out loud rather than saying a comfortable "your devices".
  function trustRow(p) {
    var n = p.tailnetPeers;
    var others = (typeof n === 'number')
      ? (n === 1 ? 'the 1 other device' : 'all ' + n + ' other devices')
      : 'every other device';
    var hint = !p.canChange ? 'Only the PC can change this.'
      : p.trustTailnet
        ? 'On — ' + others + ' on your Tailscale network can open a terminal here without scanning anything.'
        : 'Off — a device gets in only after it has scanned the QR once. Recommended.';
    var out = frow('Skip the key on my Tailscale network', hint,
      '<span class="sw ' + (p.trustTailnet ? 'on' : '') + (p.canChange ? '' : ' off-disabled') + '" data-trust-toggle role="button" aria-label="Skip the key on my Tailscale network"></span>');
    if (p.trustTailnet) {
      out += '<div class="phone-warn" style="margin:-4px 0 12px">A Tailscale network is not always only yours — a device someone else owns can be on it. With this on, any of them reaches this PC.</div>';
    }
    return out;
  }
  function when(iso) {
    try {
      var d = new Date(iso);
      var today = new Date();
      var sameDay = d.toDateString() === today.toDateString();
      var t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return sameDay ? t : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + t;
    } catch (e) { return ''; }
  }
  function deviceSection(p) {
    var ds = p.devices || [];
    if (!ds.length) return '';
    var rows = ds.map(function (d) {
      return '<div class="devrow">' +
        '<div class="devmain"><div class="devname">' + esc(d.name || 'Unknown device') + '</div>' +
        '<div class="devmeta">last used ' + esc(when(d.last)) + ' · first scanned ' + esc(when(d.first)) + '</div></div>' +
        (p.canChange ? '<span class="btn" data-act="forget" data-dev="' + esc(d.id) + '">Forget</span>' : '') +
      '</div>';
    }).join('');
    return '<div class="devs">' +
      '<div class="devhead">Remembered phones</div>' +
      '<div class="devnote">These skip the QR. Forgetting one closes its terminals straight away and it has to scan again.</div>' +
      rows +
      (p.canChange && ds.length > 1 ? '<div style="margin-top:10px"><span class="btn" data-act="forget-all">Forget all</span></div>' : '') +
    '</div>';
  }
  function loadPhone(then) {
    fetch('/api/phone').then(function (r) { return r.json(); }).then(function (j) {
      phoneS = j; if (then) then(); else if (curSet === 'Phone') renderSettings();
    }).catch(function () { phoneS = { on: false, canChange: true, tailscale: false }; if (curSet === 'Phone') renderSettings(); });
  }
  // One place to fail: the reason goes on screen where the switch is, AND into the
  // bell, so it is still there if the person has already walked away from the panel.
  function phoneFail(msg) {
    phoneErr = msg;
    notify('Phone access did not change', msg);
    if (curSet === 'Phone') renderSettings();
  }
  function flipPhone() {
    if (phoneBusy || !phoneS || !phoneS.canChange) return;
    if (!phoneS.on && !phoneS.tailscale) { phoneFail('Tailscale is not running on this PC. Start Tailscale, then try again.'); return; }
    phoneBusy = true;
    phoneErr = '';
    fetch('/api/phone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: !phoneS.on }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        phoneBusy = false;
        if (!j.ok) { phoneFail(j.error || 'Unknown error'); return; }
        phoneS = j;
        renderSettings();
        notify(j.on ? 'Phone access is on' : 'Phone access is off',
          j.on ? 'Scan the square in Settings → Phone.' : 'The link no longer works.');
      })
      .catch(function (e) { phoneBusy = false; phoneFail(String(e.message || e)); });
  }
  // Start-at-logon lives in Behaviour but is server state (does the Startup file
  // exist?), so it loads from /api/autostart and flips through it, like Phone.
  var autostartS = null;          // last /api/autostart state, or null while loading
  var autostartBusy = false;
  function loadAutostart() {
    fetch('/api/autostart', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      autostartS = j; if (curSet === 'Behaviour') renderSettings();
    }).catch(function () { autostartS = { on: false }; if (curSet === 'Behaviour') renderSettings(); });
  }
  function flipAutostart() {
    if (autostartBusy || !autostartS) return;
    autostartBusy = true;
    var want = !autostartS.on;
    fetch('/api/autostart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: want }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { autostartS = j; })
      .catch(function () {})
      .then(function () { autostartBusy = false; if (curSet === 'Behaviour') renderSettings(); });
  }
  // Saved terminal history is server state too (the engine writes the files), so
  // like autostart it loads from /api/history and flips through it. Turning it
  // off also wipes what's already on disk — that's the point of the switch.
  var historyS = null;            // last /api/history state, or null while loading
  var historyBusy = false;
  function loadHistory() {
    fetch('/api/history', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      historyS = j; if (curSet === 'Behaviour') renderSettings();
    }).catch(function () { historyS = { persist: true }; if (curSet === 'Behaviour') renderSettings(); });
  }
  function flipHistory() {
    if (historyBusy || !historyS) return;
    historyBusy = true;
    var want = !historyS.persist;
    fetch('/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persist: want }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        historyS = j;
        if (!want) notify('History wiped from disk', (j.wiped || 0) + ' saved terminal histor' + (j.wiped === 1 ? 'y' : 'ies') + ' deleted. Nothing new will be saved.');
      })
      .catch(function () {})
      .then(function () { historyBusy = false; if (curSet === 'Behaviour') renderSettings(); });
  }
  // Trusting the tailnet is its own POST field, so flipping it never disturbs
  // whether the door is open — those are two separate decisions.
  function flipTrust() {
    if (phoneBusy || !phoneS || !phoneS.canChange) return;
    phoneBusy = true;
    phoneErr = '';
    var want = !phoneS.trustTailnet;
    fetch('/api/phone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trustTailnet: want }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        phoneBusy = false;
        if (!j.ok) { phoneFail(j.error || 'Unknown error'); return; }
        phoneS = j;
        renderSettings();
        notify(want ? 'Key no longer needed on your Tailscale network' : 'The key is required again',
          want ? 'Any device on your Tailscale network can now open a terminal here.' : 'A device has to scan the QR once before it gets in.');
      })
      .catch(function (e) { phoneBusy = false; phoneFail(String(e.message || e)); });
  }
  function forgetDev(body, msg) {
    fetch('/api/phone/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (phoneS) phoneS.devices = j.devices || [];
        renderSettings();
        notify('Forgotten', msg);
      })
      .catch(function (e) { phoneFail(String(e.message || e)); });
  }
  function renderSettings() {
    document.getElementById('settings-tabs').innerHTML = SETTABS.map(function (t) {
      return '<div class="mtab" data-settab="' + t + '"' + (t === curSet ? ' data-active' : '') + '>' + t + '</div>';
    }).join('');
    document.getElementById('settings-pane').innerHTML = '<h3>' + curSet + '</h3>' + settingsPane(curSet);
  }
  // On the phone, Settings is a drill-in like the rest of the app: it opens to a
  // category list, tapping one drills into that category full-screen, and the
  // header back-arrow returns to the list. `data-drill` on the modal is the state
  // (list | detail); it's only set on narrow, so desktop keeps its two-column view.
  var settingsModal = document.querySelector('#settings-ovl .modal');
  var settingsTitle = document.getElementById('settings-title');
  function settingsDrill(state) {
    if (currentMode !== 'narrow') { settingsModal.removeAttribute('data-drill'); settingsTitle.textContent = 'Settings'; return; }
    settingsModal.setAttribute('data-drill', state);
    settingsTitle.textContent = state === 'detail' ? curSet : 'Settings';
  }
  function openSettings(tab) {
    curSet = tab || curSet;
    if (curSet === 'Phone') phoneErr = '';
    renderSettings(); openOvl('settings-ovl');
    // Opened via a specific category (e.g. a deep link) drills straight in; the
    // plain footer/⌘, entry opens to the category list.
    settingsDrill(tab ? 'detail' : 'list');
    if (curSet === 'Phone') loadPhone();
    if (curSet === 'Behaviour') { loadAutostart(); loadHistory(); }
  }
  document.getElementById('settings-tabs').addEventListener('click', function (e) {
    var tab = e.target.closest ? e.target.closest('[data-settab]') : null;
    if (!tab) return;
    curSet = tab.getAttribute('data-settab');
    settingsDrill('detail');
    // The switch must reflect the server, not whatever it looked like last time.
    if (curSet === 'Phone') { phoneS = null; phoneErr = ''; renderSettings(); loadPhone(); return; }
    if (curSet === 'Behaviour') { autostartS = null; historyS = null; renderSettings(); loadAutostart(); loadHistory(); return; }
    renderSettings();
  });
  document.getElementById('settings-back').addEventListener('click', function () { settingsDrill('list'); });
  document.getElementById('settings-pane').addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('[data-phone-toggle]')) { flipPhone(); return; }
    if (e.target.closest && e.target.closest('[data-trust-toggle]')) { flipTrust(); return; }
    if (e.target.closest && e.target.closest('[data-autostart-toggle]')) { flipAutostart(); return; }
    if (e.target.closest && e.target.closest('[data-history-toggle]')) { flipHistory(); return; }
    var s = e.target.closest ? e.target.closest('[data-sw]') : null;
    if (s) {
      var k = s.getAttribute('data-sw');
      S[k] = !S[k];
      s.classList.toggle('on', !!S[k]);
      applySettings();
      return;
    }
    var rb = e.target.closest ? e.target.closest('[data-rebind]') : null;
    if (rb) { rebindShortcut(rb.getAttribute('data-rebind')); return; }
    var rk = e.target.closest ? e.target.closest('[data-resetkey]') : null;
    if (rk) { delete KEYMAP[rk.getAttribute('data-resetkey')]; saveKeymap(); renderSettings(); return; }
    var act = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!act) return;
    var a = act.getAttribute('data-act');
    if (a === 'cheat') { closeOvl('settings-ovl'); openCheat(); }
    if (a === 'diag') { closeOvl('settings-ovl'); openDiag(); }
    if (a === 'import-theme') { importThemeDialog(); }
    if (a === 'reset-keys') { KEYMAP = {}; saveKeymap(); renderSettings(); }
    if (a === 'get-tailscale') {
      var tsUrl = 'https://tailscale.com/download';
      if (window.winmux && window.winmux.openExternal) window.winmux.openExternal(tsUrl);
      else window.open(tsUrl, '_blank', 'noopener');
    }
    if (a === 'phone-copy' && phoneS && phoneS.url) {
      // The copy itself works, but writeText is async and notify() only pings the
      // (silent) bell — so a click looked like nothing happened. Confirm right on
      // the button, and fall back to execCommand for the phone (HTTP, no async
      // Clipboard API). See the diagnostics-copy button for the same pattern.
      var pcBtn = act, pcUrl = phoneS.url;
      var pcDone = function (ok) {
        pcBtn.textContent = ok ? 'Copied' : 'Select the link to copy it';
        setTimeout(function () { pcBtn.textContent = 'Copy link'; }, ok ? 1600 : 2600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(pcUrl).then(function () { pcDone(true); }, function () { pcDone(fallbackCopy(pcUrl)); });
      } else {
        pcDone(fallbackCopy(pcUrl));
      }
    }
    if (a === 'forget') {
      var id = act.getAttribute('data-dev');
      forgetDev({ forget: id }, 'That phone has to scan the QR again before it gets back in.');
    }
    if (a === 'forget-all') {
      confirmDialog('Forget every remembered phone?', 'Their terminals close now, and each one has to scan the QR again.', 'Forget all', function () {
        forgetDev({ all: true }, 'Every phone has to scan the QR again.');
      });
    }
    if (a === 'reset') {
      confirmDialog('Reset settings?', 'Fonts, cursor, scrollback and behaviour go back to their defaults.', 'Reset', function () {
        for (var k in DEFAULTS) S[k] = DEFAULTS[k];
        applyTheme(S.theme); applySettings(); renderSettings();
      });
    }
    if (a === 'quit-server') {
      confirmDialog('Quit WinMux completely?', 'This stops the background server and ends every running shell and agent on this machine. Just closing the window leaves them running.', 'Quit & stop all', function () {
        // Ask the server to stop (it replies before exiting), then close the window.
        var done = function () { var b = winBridge(); if (b && b.close) b.close(); else window.close(); };
        fetch('/api/shutdown', { method: 'POST' }).then(done, done);
      });
    }
  });
  document.getElementById('settings-pane').addEventListener('change', onSettingInput);
  document.getElementById('settings-pane').addEventListener('input', onSettingInput);
  function onSettingInput(e) {
    var el = e.target.closest ? e.target.closest('[data-set]') : null;
    if (!el) return;
    var k = el.getAttribute('data-set');
    var v = el.value;
    if (k === 'theme') { applyTheme(v); return; }
    if (k === 'fontSize' || k === 'scrollback') v = parseInt(v, 10) || DEFAULTS[k];
    if (k === 'lineHeight') v = parseFloat(v) || DEFAULTS[k];
    S[k] = v;
    applySettings();
  }
  document.getElementById('settings-pane').addEventListener('keydown', function (e) { e.stopPropagation(); });

  // ------------------------------------------------------------ cheat sheet
  var KEYS = [
    ['New tab', 'Alt+T'], ['Close tab', 'Alt+W'], ['Select tab 1–9', 'Alt+1…9'],
    ['Switch tabs (recent first)', 'Ctrl+Tab'], ['Reopen closed tab', 'Ctrl+Shift+T'],
    ['Split right', 'Ctrl+D'], ['Split down', 'Ctrl+Shift+D'], ['Zoom pane', 'Ctrl+Shift+Enter'],
    ['Pin pane', 'Alt+P'], ['Close pane', 'Alt+Shift+W'], ['Broadcast input', 'Ctrl+Alt+B'],
    ['Find in terminal', 'Ctrl+F'], ['Copy mode (select with keys)', 'Ctrl+Shift+M'],
    ['Copy / Paste', 'Ctrl+Shift+C / V'], ['Font size', 'Ctrl+= / − / 0'],
    ['Toggle sidebar', 'Ctrl+B'], ['Changes panel', 'Ctrl+Alt+D'], ['Notifications', 'Ctrl+Alt+N'],
    ['Command palette', 'Ctrl+Shift+P'], ['Settings', 'Ctrl+,'],
    ['Save layout', 'Ctrl+Alt+S'], ['Load layout', 'Ctrl+Alt+O'], ['Keyboard shortcuts', 'F1'],
  ];
  var CHEAT = {
    Tabs: KEYS.slice(0, 5), Panes: KEYS.slice(5, 11), Terminal: KEYS.slice(11, 15), View: KEYS.slice(15),
  };
  // The five nouns WinMux leans on, defined once where people already come for
  // help. A stranger meets all of them in their first hour; nothing else in the
  // product says what they mean.
  var VOCAB = [
    ['Tab', 'One terminal (or browser / markdown / diff view) inside a pane.'],
    ['Group', 'A named set of tabs in the sidebar, like a workspace folder.'],
    ['Session', 'The live shell process behind a tab. It belongs to the engine, not the window.'],
    ['Detached session', 'A session whose window went away. It keeps running; reopen WinMux to pick it up.'],
    ['Project', 'A saved layout on disk (.winmux.json): groups, tabs, folders, shells. Open it to restore everything.'],
  ];
  // Where your stuff lives — the four stores, one honest sentence each, with the
  // REAL paths for this identity filled in from /api/info after the sheet opens
  // (PT-7). This is the in-app answer to "where is my stuff saved?": the model
  // sentence a stranger can hold, then the exact files.
  var STORES = [
    ['Workspace', 'Your open tabs + layout, saved automatically on every change. One per app identity — a new window picks it up.', 'workspaceFile'],
    ['Projects', 'Named layouts you save on purpose. Plain files — copy them (plus the settings file) to move your setup to another machine.', 'projectsDir'],
    ['Recovery', 'Saved output of sessions that lost their window, kept 7 days. Restore or dismiss them under Projects › Recent & recoverable.', 'backlogDir'],
    ['Settings', 'Options + keyboard map. This file is the source of truth; every window only caches it.', 'configFile'],
  ];
  function openCheat() {
    document.getElementById('cheat-body').innerHTML = '<h2>Keyboard shortcuts</h2>' +
      Object.keys(CHEAT).map(function (sec) {
        return '<div class="csec">' + sec + '</div>' + CHEAT[sec].map(function (r) {
          return '<div class="crow"><span class="ca">' + r[0] + '</span><span class="kbd">' + r[1] + '</span></div>';
        }).join('');
      }).join('') +
      '<div class="csec">Words WinMux uses</div>' + VOCAB.map(function (r) {
        return '<div class="crow"><span class="ca"><b>' + r[0] + '</b></span><span style="font-size:12px;color:var(--muted);text-align:right;max-width:34ch">' + r[1] + '</span></div>';
      }).join('') +
      '<div class="csec">Where your stuff lives</div>' +
      '<div style="font-size:12px;color:var(--muted);margin:2px 0 6px">Your workspace is always saved automatically. A Project is a named snapshot you can reopen anytime. Sessions keep running until you end them.</div>' +
      STORES.map(function (r) {
        return '<div class="crow" style="flex-direction:column;align-items:flex-start;gap:2px">' +
          '<span class="ca"><b>' + r[0] + '</b> <span style="font-size:12px;color:var(--muted)">' + r[1] + '</span></span>' +
          '<span class="mono" data-store-path="' + r[2] + '" style="font-size:11px;color:var(--faint);word-break:break-all">…</span></div>';
      }).join('');
    openOvl('cheat-ovl');
    fetch('/api/info').then(function (r) { return r.json(); }).then(function (d) {
      STORES.forEach(function (r) {
        var el = document.querySelector('#cheat-body [data-store-path="' + r[2] + '"]');
        if (el && d[r[2]]) el.textContent = d[r[2]];
      });
    }).catch(function () {});
  }
  document.getElementById('cheat-ovl').addEventListener('click', function (e) { if (e.target.id === 'cheat-ovl') closeOvl('cheat-ovl'); });

  // Clipboard of last resort — when the async API is blocked (no secure context,
  // no focus), a hidden textarea + execCommand still copies.
  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      var ok = document.execCommand('copy'); document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }

  // ----------------------------------------------------------- diagnostics
  function openDiag() {
    var pane = document.getElementById('diag-pane');
    pane.innerHTML = '<div style="color:var(--faint);font-size:12.5px">Reading server…</div>';
    openOvl('diag-ovl');
    fetch('/api/info').then(function (r) { return r.json(); }).then(function (d) {
      HOME = d.home || HOME;
      var rows = [
        ['WinMux', 'v' + (d.version || '?')],
        ['Server', 'http://' + d.host + ':' + d.port],
        ['Process id', d.pid], ['Node', d.node], ['Platform', d.platform + ' · ' + d.arch],
        ['Uptime', Math.floor(d.uptime / 60) + 'm ' + (d.uptime % 60) + 's'],
        ['Live shells', d.sessions + ' connected'],
        ['Shells found', (d.shells || []).join(', ')],
        // Where this identity's state lives — the real files, so "where is my
        // stuff?" has a copyable answer right here (PT-7).
        ['Workspace file', d.workspaceFile || '—'],
        ['Projects folder', d.projectsDir || '—'],
        ['Recovery folder', (d.backlogDir || '—') + (typeof d.recoverable === 'number' ? ' · ' + d.recoverable + ' recoverable' : '')],
        ['Settings file', d.configFile || '—'],
        ['Home folder', d.home], ['CPU cores', d.cpus], ['Memory', d.mem],
        ['Terminals open', totalTerms() + ' in ' + panes.length + ' pane' + (panes.length > 1 ? 's' : '')],
        ['Browser', navigator.userAgent],
      ];
      pane.innerHTML = '<h3>This server</h3>' + rows.map(function (r) {
        return '<div class="kvrow"><span class="k">' + r[0] + '</span><span class="v">' + esc(r[1]) + '</span></div>';
      }).join('') + '<div style="margin-top:16px;display:flex;gap:8px">' +
        '<span class="btn" data-diag-copy>Copy diagnostics</span>' +
        '<span class="btn" data-diag-refresh>Refresh</span></div>';
      pane.querySelector('[data-diag-refresh]').addEventListener('click', openDiag);
      // One-click copy so a report can carry the facts (#213). Plain text, the
      // same rows the pane shows, ready to paste into an issue or a message.
      var copyBtn = pane.querySelector('[data-diag-copy]');
      copyBtn.addEventListener('click', function () {
        var text = 'WinMux diagnostics\n' + rows.map(function (r) { return r[0] + ': ' + r[1]; }).join('\n');
        var done = function () { copyBtn.textContent = 'Copied'; setTimeout(function () { copyBtn.textContent = 'Copy diagnostics'; }, 1600); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
        } else { fallbackCopy(text); done(); }
      });
    }).catch(function () { pane.innerHTML = '<div class="kvrow"><span class="k">Server</span><span class="v">Not responding</span></div>'; });
  }

  // -------------------------------------------------------- command palette
  var plWrap = document.getElementById('palette-wrap');
  var plInput = document.getElementById('pl-input');
  var plList = document.getElementById('pl-list');
  var plItems = [];
  var plSel = 0;
  function commands() {
    var list = [
      { cat: 'Terminal', name: 'New tab', kbd: 'Alt+T', run: function () { var p = paneById(activePaneId); if (p) newTerm(p, startShell()); } },
      { cat: 'Terminal', name: 'Close tab', kbd: 'Alt+W', run: function () { var p = paneById(activePaneId); if (p && p.activeTermId) askCloseTerm(p, p.activeTermId); } },
      { cat: 'Terminal', name: 'Clear terminal', run: function () { var t = activeTerm(); if (t && t.term) { t.term.clear(); t.term.focus(); } } },
      { cat: 'Terminal', name: 'Copy selection', kbd: 'Ctrl+Shift+C', run: function () { var t = activeTerm(); if (t && t.term) copySel(t); } },
      { cat: 'Terminal', name: 'Paste', kbd: 'Ctrl+Shift+V', run: function () { var t = activeTerm(); if (t) pasteInto(t); } },
      { cat: 'Terminal', name: 'Paste from other device (clipboard sync)', run: function () { var t = activeTerm(); if (t) pasteFromOtherDevice(t); } },
      { cat: 'Terminal', name: 'Rename tab', run: function () { var t = activeTerm(); if (t) startRename(t); } },
      { cat: 'Terminal', name: 'Find in terminal', kbd: 'Ctrl+F', run: function () { var p = paneById(activePaneId); if (p) openFind(p); } },
      { cat: 'Terminal', name: 'Copy mode — select scrollback with the keyboard', kbd: 'Ctrl+Shift+M', run: enterCopyMode },
      { cat: 'Terminal', name: 'Reopen closed tab', kbd: 'Ctrl+Shift+T', run: reopenClosed },
      { cat: 'Pane', name: 'Split right', kbd: 'Ctrl+D', run: function () { var p = paneById(activePaneId); if (p) splitRight(p, startShell()); } },
      { cat: 'Pane', name: 'Split down', kbd: 'Ctrl+Shift+D', run: function () { var p = paneById(activePaneId); if (p) splitDown(p, startShell()); } },
      { cat: 'Pane', name: 'Zoom pane', kbd: 'Ctrl+Shift+Enter', run: function () { var p = paneById(activePaneId); if (p) toggleZoom(p); } },
      { cat: 'Pane', name: (function () { var p = paneById(activePaneId); return p && p.pinned ? 'Unpin pane' : 'Pin pane (protect it from closing)'; })(), kbd: 'Alt+P', run: function () { var p = paneById(activePaneId); if (p) togglePin(p); } },
      { cat: 'Pane', name: 'Close pane', kbd: 'Alt+Shift+W', run: function () { var p = paneById(activePaneId); if (p) askClosePane(p); } },
      { cat: 'Pane', name: broadcastOn ? 'Stop broadcasting input' : 'Broadcast input to all terminals', kbd: 'Ctrl+Alt+B', run: function () { setBroadcast(!broadcastOn); } },
      { cat: 'View', name: 'Toggle sidebar', kbd: 'Ctrl+B', run: toggleSidebar },
      { cat: 'View', name: 'Toggle changes panel', kbd: 'Ctrl+Alt+D', run: toggleDock },
      { cat: 'View', name: 'Notifications', kbd: 'Ctrl+Alt+N', run: function () { toggleNotif(document.getElementById('open-notif')); } },
      { cat: 'View', name: 'Theme: match system', run: function () { applyTheme('system'); } },
      { cat: 'View', name: 'Theme: dark', run: function () { applyTheme('dark'); } },
      { cat: 'View', name: 'Theme: light', run: function () { applyTheme('light'); } },
      { cat: 'Project', name: 'Save project', kbd: 'Ctrl+Alt+S', run: saveLayoutDialog },
      { cat: 'Project', name: 'Open project', kbd: 'Ctrl+Alt+O', run: loadLayoutDialog },
      { cat: 'Project', name: 'Close project', run: closeProject },
      { cat: 'App', name: 'Settings', kbd: 'Ctrl+,', run: function () { openSettings(); } },
      { cat: 'App', name: 'Keyboard shortcuts', kbd: 'F1', run: openCheat },
      { cat: 'App', name: 'Agents guide', run: function () { openAgentsGuide(); } },
      { cat: 'App', name: 'Diagnostics', run: openDiag },
    ];
    SHELLS.forEach(function (s) {
      list.push({ cat: 'New', name: 'New ' + s.label + ' tab', run: function () { var p = paneById(activePaneId); if (p) newTerm(p, s.key); } });
      list.push({ cat: 'New', name: 'Split right with ' + s.label, run: function () { var p = paneById(activePaneId); if (p) splitRight(p, s.key); } });
    });
    allTerms().forEach(function (t) {
      list.push({ cat: 'Go to', name: t.tabEl.querySelector('.tt').textContent + (t.cwd ? ' — ' + t.cwd : ''), run: function () { focusTerm(t.id); } });
    });
    // Phase 6 — one search reaches the whole app, not just the active pane: open any
    // recent project by name, switch to any other group, or open remote access. The
    // recents come from the last time the Projects panel was opened (recentsCache);
    // "Open project" itself is always available above to refresh the full list.
    recentsCache.forEach(function (p) {
      if (p.missing) return;
      list.push({ cat: 'Project', name: 'Open project: ' + (p.name || p.path), run: function () {
        Projects.read(p.path).then(function (r) { if (r && r.layout) openSavedLayout({ name: r.name || p.name, desc: r.layout, path: p.path }); });
      } });
    });
    groups.forEach(function (g) {
      if (g.id !== activeGroupId) list.push({ cat: 'Project', name: 'Switch to project: ' + g.name, run: function () { switchGroup(g.id); } });
    });
    list.push({ cat: 'Remote', name: 'Connect from your phone (remote access)', run: function () { openSettings('Phone'); } });
    return list;
  }
  function renderPalette() {
    var q = plInput.value.toLowerCase().trim();
    plItems = commands().filter(function (c) { return !q || (c.cat + ' ' + c.name).toLowerCase().indexOf(q) >= 0; }).slice(0, 40);
    plSel = 0;
    plList.innerHTML = plItems.length
      ? plItems.map(function (c, i) {
          return '<div class="pl-item"' + (i === 0 ? ' data-sel' : '') + ' data-i="' + i + '"><span class="pl-ic">›</span>' +
            '<span>' + esc(c.name) + '</span>' + (c.kbd ? '<span class="kbd sm">' + c.kbd + '</span>' : '<span class="cat">' + c.cat + '</span>') + '</div>';
        }).join('')
      : '<div style="padding:14px;color:var(--faint);font-size:12.5px">No matching command</div>';
  }
  function movePalette(d) {
    if (!plItems.length) return;
    plSel = (plSel + d + plItems.length) % plItems.length;
    [].forEach.call(plList.children, function (el, i) { if (i === plSel) el.setAttribute('data-sel', ''); else el.removeAttribute('data-sel'); });
    var cur = plList.children[plSel];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }
  function runPalette(i) {
    var c = plItems[i];
    closePalette();
    if (c) c.run();
  }
  function openPalette() { plInput.value = ''; renderPalette(); plWrap.setAttribute('data-open', ''); plInput.focus(); }
  function closePalette() { plWrap.removeAttribute('data-open'); var t = activeTerm(); if (t && t.term) t.term.focus(); }
  plInput.addEventListener('input', renderPalette);
  plInput.addEventListener('keydown', function (e) {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); runPalette(plSel); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });
  plList.addEventListener('click', function (e) {
    var row = e.target.closest ? e.target.closest('[data-i]') : null;
    if (row) runPalette(parseInt(row.getAttribute('data-i'), 10));
  });
  plWrap.addEventListener('mousedown', function (e) { if (e.target === plWrap) closePalette(); });

  // ------------------------------------------------------- sidebar buttons
  document.getElementById('open-palette').addEventListener('click', openPalette);
  document.getElementById('open-notif').addEventListener('click', function (e) { e.stopPropagation(); toggleNotif(e.currentTarget); });
  document.getElementById('open-new').addEventListener('click', function () { var p = paneById(activePaneId) || panes[0]; if (p) { newTerm(p, startShell()); focusPane(p.id); } });
  document.getElementById('open-newgroup').addEventListener('click', function () {
    promptDialog('Name this group', 'Group ' + (groups.length + 1), 'Create', function (name) {
      newGroup(name);
      var p = paneById(activePaneId) || panes[0];
      if (p) focusPane(p.id);
    });
  });
  document.getElementById('ns-back').addEventListener('click', function () { setView('projects'); });
  // Header B: the brand-bar back-arrow is view-aware — from a terminal it returns to
  // the session list; from the session list it returns to Groups.
  document.getElementById('nhead-ctx').addEventListener('click', function () {
    setView(root.getAttribute('data-view') === 'sessions' ? 'projects' : 'sessions');
  });
  // Phone: the pill focuses the open terminal from inside a user gesture, which is
  // what actually raises the soft keyboard on iOS/Android.
  (function () {
    var mkbd = document.getElementById('mkbd');
    if (!mkbd) return;
    mkbd.addEventListener('click', function () {
      var t = activeTerm();
      if (t) { try { (t.term.textarea || t.term).focus(); } catch (e) {} }
    });
  })();
  document.getElementById('ns-list').addEventListener('click', function (e) {
    var appr = e.target.closest ? e.target.closest('[data-approve]') : null;
    if (appr) { e.stopPropagation(); approveTerm(parseInt(appr.getAttribute('data-approve'), 10)); return; }
    var eye = e.target.closest ? e.target.closest('[data-eye]') : null;
    if (eye) { e.stopPropagation(); openPreview(parseInt(eye.getAttribute('data-eye'), 10)); return; }
    var card = e.target.closest ? e.target.closest('.ncard[data-open]') : null;
    if (card) focusTerm(parseInt(card.getAttribute('data-open'), 10));
  });
  document.getElementById('open-save').addEventListener('click', function (e) { toggleLayoutMenu(e.currentTarget); });
  document.getElementById('open-load').addEventListener('click', function (e) { toggleLayoutMenu(e.currentTarget); });
  document.getElementById('open-diag').addEventListener('click', openDiag);
  document.getElementById('open-help').addEventListener('click', openCheat);
  document.getElementById('open-settings').addEventListener('click', function () { openSettings(); });
  document.addEventListener('mousedown', function (e) {
    // SB arc: outside-click dismissal is a popover behavior. On desktop the
    // notifications are a sidebar panel now — panels stay put (Obsidian rule);
    // only the phone bottom sheet still closes on a stray tap.
    if (currentMode !== 'narrow') return;
    if (npanel.hasAttribute('data-open') && !npanel.contains(e.target) && !e.target.closest('#open-notif') && !e.target.closest('#notif-backdrop')) closeNotif();
  });

  // ---- Remappable keyboard actions -------------------------------------------
  // The app-level chords a user can rebind. Each has a stable id, a label, a
  // default chord, and the fn it runs (state looked up live, so never a stale pane
  // ref). The non-remappable captures — copy mode, Ctrl+Tab MRU, the terminal-is-
  // king fall-through, Escape, font size, Alt+digit tab-jump — are deliberately NOT
  // here: they belong to the shell or aren't worth the ambiguity of remapping.
  var KEYMAP = {};   // id -> chord override
  try { var _rawKm = JSON.parse(localStorage.getItem('ct-keymap') || '{}'); if (_rawKm && typeof _rawKm === 'object') KEYMAP = _rawKm; } catch (e) {}
  var ACTIONS = [
    { id: 'help', label: 'Keyboard help', def: 'F1', run: function () { openCheat(); } },
    { id: 'palette', label: 'Command palette', def: 'Ctrl+Shift+P', run: function () { openPalette(); } },
    { id: 'settings', label: 'Settings', def: 'Ctrl+,', run: function () { openSettings(); } },
    { id: 'toggle-sidebar', label: 'Toggle sidebar', def: 'Ctrl+B', run: function () { toggleSidebar(); } },
    { id: 'toggle-dock', label: 'Toggle dock', def: 'Ctrl+Alt+D', run: function () { toggleDock(); } },
    { id: 'notifications', label: 'Notifications', def: 'Ctrl+Alt+N', run: function () { toggleNotif(document.getElementById('open-notif')); } },
    { id: 'broadcast', label: 'Broadcast to all panes', def: 'Ctrl+Alt+B', run: function () { setBroadcast(!broadcastOn); } },
    { id: 'save-layout', label: 'Save project', def: 'Ctrl+Alt+S', run: function () { saveLayoutDialog(); } },
    { id: 'load-layout', label: 'Open project', def: 'Ctrl+Alt+O', run: function () { loadLayoutDialog(); } },
    { id: 'find', label: 'Find in terminal', def: 'Ctrl+F', run: function () { var p = paneById(activePaneId); if (p) openFind(p); } },
    { id: 'copy', label: 'Copy selection', def: 'Ctrl+Shift+C', run: function () { var t = activeTerm(); if (t) copySel(t); } },
    { id: 'paste', label: 'Paste', def: 'Ctrl+Shift+V', run: function () { var t = activeTerm(); if (t) pasteInto(t); } },
    { id: 'zoom', label: 'Zoom pane', def: 'Ctrl+Shift+Enter', run: function () { var p = paneById(activePaneId); if (p) toggleZoom(p); } },
    { id: 'split-down', label: 'Split down', def: 'Ctrl+Shift+D', run: function () { var p = paneById(activePaneId); if (p) splitDown(p, startShell()); } },
    { id: 'split-right', label: 'Split right', def: 'Ctrl+D', run: function () { var p = paneById(activePaneId); if (p) splitRight(p, startShell()); } },
    { id: 'close-pane', label: 'Close pane', def: 'Alt+Shift+W', run: function () { var p = paneById(activePaneId); if (p) askClosePane(p); } },
    { id: 'close-tab', label: 'Close tab', def: 'Alt+W', run: function () { var p = paneById(activePaneId); if (p && p.activeTermId) askCloseTerm(p, p.activeTermId); } },
    { id: 'new-tab', label: 'New tab', def: 'Alt+T', run: function () { var p = paneById(activePaneId); if (p) newTerm(p, startShell()); } },
    { id: 'jump-prev-mark', label: 'Jump to previous prompt', def: 'Ctrl+Shift+ArrowUp', run: function () { var t = activeTerm(); if (t) jumpMark(t, -1); } },
    { id: 'jump-next-mark', label: 'Jump to next prompt', def: 'Ctrl+Shift+ArrowDown', run: function () { var t = activeTerm(); if (t) jumpMark(t, 1); } },
    { id: 'reset-terminal', label: 'Reset terminal', def: 'Ctrl+Shift+K', run: function () { var t = activeTerm(); if (t) resetTerm(t); } },
  ];
  function actionById(id) { for (var i = 0; i < ACTIONS.length; i++) if (ACTIONS[i].id === id) return ACTIONS[i]; return null; }
  function effectiveChord(a) { return KEYMAP[a.id] || a.def; }
  // Normalise a keyboard event to a chord string like "Ctrl+Shift+P". Modifier
  // order is fixed (Ctrl, Alt, Shift) so it matches the default chords above.
  function chordOf(e) {
    var k = e.key;
    if (k === ' ') k = 'Space';
    else if (k.length === 1) k = k.toUpperCase();
    var mods = [];
    if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    return mods.concat([k]).join('+');
  }
  function keymapLookup(chord) {
    for (var i = 0; i < ACTIONS.length; i++) if (effectiveChord(ACTIONS[i]) === chord) return ACTIONS[i];
    return null;
  }
  function saveKeymap() {
    try { localStorage.setItem('ct-keymap', JSON.stringify(KEYMAP)); } catch (e) {}
    if (!configReady) return;
    try { fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keymap: KEYMAP }) }).catch(function () {}); } catch (e) {}
  }
  var rebindCapture = false;   // true while the Shortcuts UI is waiting to catch a chord
  // Observability hooks (mirror __winmuxActiveTerm) so the harness can drive rebinds.
  window.__winmuxSetKeymap = function (id, chord) { if (chord) KEYMAP[id] = chord; else delete KEYMAP[id]; saveKeymap(); };
  window.__winmuxKeymap = function () { return { map: KEYMAP, effective: ACTIONS.map(function (a) { return { id: a.id, chord: effectiveChord(a) }; }) }; };
  window.__winmuxJumpMark = function (dir) { var t = activeTerm(); return jumpMark(t, dir); };
  window.__winmuxResetTerm = function () { var t = activeTerm(); return resetTerm(t); };

  // -------------------------------------------------------------- keyboard
  // One capture-phase handler for the whole app: xterm's own textarea listener
  // never sees a shortcut we claim here.
  document.addEventListener('keydown', function (e) {
    if (rebindCapture) return;   // the Shortcuts rebind UI owns the keyboard right now
    var tgt = e.target;
    var inField = tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || (tgt.tagName === 'TEXTAREA' && !tgt.classList.contains('xterm-helper-textarea')));
    // A real button fires on Enter and Space. Every icon control here is a span
    // wearing role="button", so the browser gives it neither; without this the
    // keyboard can reach a control and still not press it.
    if ((e.key === 'Enter' || e.key === ' ') && tgt && tgt.matches && tgt.matches(FOCUSABLE)) {
      e.preventDefault(); e.stopPropagation(); tgt.click(); return;
    }
    if (e.key === 'Escape') {
      if (copyMode) { exitCopyMode(); e.preventDefault(); return; }
      if (sessmenu.hasAttribute('data-open')) { closeLayoutMenu(); e.preventDefault(); return; }
      if (openMenu) { closeMenu(); e.preventDefault(); return; }
      if (plWrap.hasAttribute('data-open')) { closePalette(); e.preventDefault(); return; }
      if (npanel.hasAttribute('data-open')) { closeNotif(); e.preventDefault(); return; }
      if (anyOvlOpen()) { [].forEach.call(document.querySelectorAll('.ovl[data-open]'), function (o) { o.removeAttribute('data-open'); }); e.preventDefault(); return; }
      var pf = paneById(activePaneId);
      if (pf && pf.findbar.classList.contains('on')) { closeFind(pf); e.preventDefault(); return; }
      return;
    }
    if (inField) return;
    var p = paneById(activePaneId);
    var ctrl = e.ctrlKey || e.metaKey;
    function stop() { e.preventDefault(); e.stopPropagation(); }

    // Copy mode owns the keyboard entirely while it is on.
    if (copyMode) { stop(); copyModeKey(e); return; }
    // Ctrl+Tab walks the most-recently-used order until Ctrl is released.
    if (ctrl && e.key === 'Tab') { stop(); cycleTab(e.shiftKey ? -1 : 1); return; }
    if (ctrl && e.shiftKey && (e.key === 'T' || e.key === 't')) { stop(); reopenClosed(); return; }
    if (ctrl && e.shiftKey && (e.key === 'M' || e.key === 'm')) { stop(); enterCopyMode(); return; }
    if (e.altKey && !ctrl && !e.shiftKey && (e.key === 'p' || e.key === 'P')) { stop(); if (p) togglePin(p); return; }

    // Terminal is king. When a shell or a full-screen TUI (vim, less, a REPL) has
    // focus, the chords that mean something to a terminal belong to it, not to us.
    // vim/less page with Ctrl+F and Ctrl+B; a shell takes EOF on Ctrl+D — intercept
    // them here and every one is silently stolen from the terminal underneath.
    // Hand them back by falling through (no stop(), so xterm receives the key).
    // Each action stays reachable from its pane button and the palette, so nothing
    // is stranded. Alt/Meta chords stay ours so keyboard tab/pane nav still works.
    var termFocused = tgt && tgt.classList && tgt.classList.contains('xterm-helper-textarea');
    if (termFocused && ctrl && !e.altKey && !e.shiftKey &&
        (e.key === 'd' || e.key === 'D' || e.key === 'f' || e.key === 'F' || e.key === 'b' || e.key === 'B')) {
      return;
    }

    // Remappable app chords: resolve the pressed chord to an action (defaults,
    // overridden by the user's keymap). This replaces the old hardcoded if-chain,
    // so a rebind in Settings actually moves the shortcut.
    var _act = keymapLookup(chordOf(e));
    if (_act) { stop(); _act.run(); return; }
    // Not remappable — the =/+ and -/_ variants aren't worth the ambiguity.
    if (ctrl && !e.altKey && (e.key === '=' || e.key === '+')) { stop(); setFontSize(S.fontSize + 1); return; }
    if (ctrl && !e.altKey && (e.key === '-' || e.key === '_')) { stop(); setFontSize(S.fontSize - 1); return; }
    if (ctrl && !e.altKey && e.key === '0') { stop(); S.fontSize = DEFAULTS.fontSize; applySettings(); return; }
    // Not remappable — Alt+1..9 jumps to a tab by position.
    if (e.altKey && !ctrl && e.key >= '1' && e.key <= '9') {
      var n = parseInt(e.key, 10) - 1;
      if (p && p.terms[n]) { stop(); activateTerm(p, p.terms[n].id); }
      return;
    }
  }, true);
  // Releasing Ctrl commits whatever tab Ctrl+Tab landed on to the top of the MRU.
  document.addEventListener('keyup', function (e) { if (e.key === 'Control' || e.key === 'Meta') endCycle(); }, true);
  window.addEventListener('blur', endCycle);

  // --------------------------------------------------------- responsive mode
  // Three shapes, same app: full desktop · half-width (tabs collapse to icons) ·
  // phone (one screen at a time — the terminal list, or one terminal full-screen).
  var currentMode = null;
  // A phone is narrow in ANY orientation. Width alone can't tell a landscape phone
  // (~745px wide) from a desktop, so also treat a touch device whose SHORT edge is
  // phone-sized as narrow. Coarse pointer + min-dimension <=500px is a phone (in
  // portrait or landscape); it excludes real desktops (fine pointer), desktop
  // touchscreens (short edge >500), and tablets (short edge ~600+).
  function isPhone() {
    return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches) &&
      Math.min(window.innerWidth, window.innerHeight) <= 500;
  }
  function modeFor(w) { return (isPhone() || w <= 620) ? 'narrow' : (w < 1120 ? 'half' : 'full'); }
  function setView(v) {
    root.setAttribute('data-view', v);
    if (v === 'focus') {
      var p = paneById(activePaneId);
      if (p) { paintNbar(p); setTimeout(function () { fitActive(p); }, 30); }
    } else if (v === 'sessions') {
      // Header B: on the session list the brand bar carries the group name + back-to-Groups.
      var ctxName = document.getElementById('nhead-ctx-name');
      if (ctxName) { var g = groupById(activeGroupId); ctxName.textContent = g ? g.name : ''; }
    }
  }
  function paintNbar(p) {
    if (!p) return;
    var t = activeTermOf(p);
    var nm = t ? t.tabEl.querySelector('.tt').textContent : 'Terminal';
    if (p.nbarName) p.nbarName.textContent = nm;
    // C1 phone header: the active session name lives in the brand bar.
    var ctxName = document.getElementById('nhead-ctx-name');
    if (ctxName) ctxName.textContent = nm;
  }
  function applyMode() {
    var m = modeFor(window.innerWidth);
    if (m === currentMode) { if (m === 'narrow') paintNbar(paneById(activePaneId)); return; }
    var crossedNarrow = (m === 'narrow') !== (currentMode === 'narrow');
    currentMode = m;
    root.setAttribute('data-mode', m);
    // SB arc: an open notifications surface doesn't survive the narrow boundary —
    // the desktop panel and the phone sheet are different animals, so close it and
    // let the user reopen in the shape the new mode uses. Then park the relocatable
    // controls (bell, palette, update badge, #npanel) in this mode's container.
    if (crossedNarrow && npanel.hasAttribute('data-open')) closeNotif();
    placeSidebarControls();
    if (m === 'narrow') {
      // Land on the shallowest screen that still has a choice on it: many groups →
      // the group list; one group with several terminals → its session list; one
      // terminal → the terminal, because a list of one costs a pointless tap.
      setView(groups.length > 1 ? 'projects'
        : (termsOfGroup(activeGroupId).length > 1 ? 'sessions' : 'focus'));
      // On a phone the changes dock and the split chrome have nowhere to live.
      clearZoom();
      if (copyMode) exitCopyMode();
    } else {
      root.removeAttribute('data-view');
    }
    layoutAllTabs();
    setTimeout(function () { panes.forEach(fitActive); }, 40);
  }
  var resizeTimer;
  window.addEventListener('resize', function () {
    applyMode();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { panes.forEach(fitActive); layoutAllTabs(); }, 80);
  });
  if (window.matchMedia) {
    try { window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () { if (S.theme === 'system') applyTheme('system'); }); } catch (e) {}
  }
  // Watch for devicePixelRatio changes (monitor-to-monitor moves, OS scaling changes,
  // and the Electron startup dpr settle) and resync every WebGL terminal's canvas —
  // the one thing xterm's renderer doesn't do on its own (see resyncRenderer). A dpr
  // media query matches only the CURRENT ratio, so re-arm after each change.
  if (window.matchMedia) {
    (function watchDpr() {
      function arm() {
        var mq;
        try { mq = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)'); } catch (e) { return; }
        function onChange() {
          try { mq.removeEventListener('change', onChange); } catch (e) { try { mq.removeListener(onChange); } catch (e2) {} }
          eachTerm(function (t) { resyncRenderer(t.term); });
          arm();
        }
        try { mq.addEventListener('change', onChange); } catch (e) { try { mq.addListener(onChange); } catch (e2) {} }
      }
      arm();
    })();
  }

  // ------------------------------------------------------------------- boot
  if (S.theme === 'light' || S.theme === 'dark') document.documentElement.setAttribute('data-theme', S.theme);
  paintNotifBadge();

  fetch('/api/info').then(function (r) { return r.json(); }).then(function (d) {
    HOME = d.home || '';
    if (d.version) APP_VERSION = d.version;   // one source of truth for the version string
    var ver = document.getElementById('wc-ver');
    if (ver && d.version) ver.textContent = 'v' + d.version;
  }).catch(function () {});

  // Ligatures are a body attribute the stylesheet keys off, so a saved "on" has
  // to be re-applied on boot — the first terminal opens before any settings edit.
  applyLigatures();

  // Seed from the on-disk config so a fresh install / hand-edit takes effect.
  loadDiskConfig();

  // Update notice: if GitHub has a newer WinMux, light the .upbadge pill and link
  // it to the download page. We never auto-install — this only tells and links.
  (function checkForUpdate() {
    var badge = document.getElementById('upbadge');
    if (!badge) return;
    function openRelease(url) {
      var u = url || 'https://github.com/Zbrooklyn/winmux/releases/latest';
      if (window.winmux && window.winmux.openExternal) window.winmux.openExternal(u);
      else window.open(u, '_blank', 'noopener');
    }
    fetch('/api/update').then(function (r) { return r.json(); }).then(function (u) {
      if (!u || !u.updateAvailable || !u.latest) return;
      badge.textContent = 'Update v' + u.latest;
      badge.title = 'WinMux v' + u.latest + ' is available — click to download';
      badge.classList.add('on');
      var go = function () { openRelease(u.url); };
      badge.onclick = go;
      badge.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    }).catch(function () {});
  })();
  // Resolves once the machine's real shell list is known. The first-ever tab waits on
  // this so it opens the true default (PowerShell 7 when present) instead of the
  // build-time 'powershell' placeholder — otherwise a fresh install always opened 5.1,
  // where inline prediction can't run.
  var shellsReady = fetch('/shells').then(function (r) { return r.json(); }).then(function (list) {
    if (Array.isArray(list) && list.length) {
      SHELLS = list;
      // Prefer PowerShell 7 when present — it does inline history prediction natively,
      // where Windows PowerShell 5.1 can't. Falls back to the first shell otherwise.
      DEFAULT_SHELL = list.some(function (s) { return s.key === 'pwsh'; }) ? 'pwsh' : list[0].key;
    }
  }).catch(function () {});

  // The two moments worth retrying on immediately, instead of waiting out
  // whatever the backoff had scheduled: the tab coming back to the foreground
  // (the phone was asleep) and the network returning (the wifi hopped).
  function wakeAll() { allTerms().forEach(function (t) { if (t.retryNow) t.retryNow(); }); }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) wakeAll(); });
  window.addEventListener('online', wakeAll);
  window.addEventListener('pageshow', wakeAll);

  // role="button" on a <span> is a label, not a behaviour: the browser still
  // leaves it out of the tab order. Same for the rows, cards and tabs that carry
  // the app's actual navigation. Everything clickable gets a tab stop, including
  // the ones the sidebar re-renders on every fleet change.
  function wireFocusable() {
    var list = document.querySelectorAll(FOCUSABLE);
    for (var i = 0; i < list.length; i++) if (!list[i].hasAttribute('tabindex')) list[i].tabIndex = 0;
  }
  // Same problem one layer up: the panels announce nothing. `data-open` on a
  // panel and `data-active` on a row are the truth; aria-expanded and
  // aria-current are how that truth reaches a screen reader. Driving both off
  // the observer means a control added later is covered without a second edit.
  var EXPANDERS = [
    ['open-palette', 'palette-wrap'], ['open-notif', 'npanel'],
    ['open-save', 'projects-ovl'], ['open-load', 'projects-ovl'],
    ['open-diag', 'diag-ovl'], ['open-help', 'cheat-ovl'],
    ['open-settings', 'settings-ovl']
  ];
  // setAttribute fires a mutation even when the value is unchanged, which would
  // make the observer feed itself. Only write on a real difference.
  function setAria(el, name, val) { if (el && el.getAttribute(name) !== val) el.setAttribute(name, val); }
  function syncAria() {
    for (var i = 0; i < EXPANDERS.length; i++) {
      var btn = document.getElementById(EXPANDERS[i][0]);
      var panel = document.getElementById(EXPANDERS[i][1]);
      if (btn && panel) setAria(btn, 'aria-expanded', panel.hasAttribute('data-open') ? 'true' : 'false');
    }
    // The rail is the sole sidebar toggle now; mirror the open/collapsed state onto it.
    var open = root.getAttribute('data-sidebar') === 'open';
    document.querySelectorAll('.pc-rail').forEach(function (r) { setAria(r, 'aria-expanded', open ? 'true' : 'false'); });
    var sel = document.querySelectorAll('.prow, .ptab, .srow');
    for (var j = 0; j < sel.length; j++) setAria(sel[j], 'aria-current', sel[j].hasAttribute('data-active') ? 'true' : 'false');
  }
  wireFocusable();
  syncAria();
  new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var t = muts[i].target;
      if (t && t.closest && t.closest('.xterm')) continue; // terminal output, not chrome
      wireFocusable();
      syncAria();
      return;
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-open', 'data-active', 'data-sidebar'] });

  // A full page reload drops the socket — a detach, not a kill — so the shells are
  // still warm on the server for the grace window. We saved the live layout with each
  // tab's session id on the way out; restore it and reconnect by id, landing back in
  // the same running shells instead of silently starting a fresh one and orphaning the
  // old. Any session the server no longer holds simply returns as a fresh shell in its
  // slot. First-ever open (no saved state) gets the default single shell.
  // On the way out, the throttle would eat the final save — flush it with a
  // keepalive POST the browser is allowed to finish after the page dies.
  window.addEventListener('beforeunload', function () {
    persistLive();
    if (workspaceReady) pushWorkspaceNow(true);
  });
  migrateLayoutsOnce();   // fold any old browser-storage layouts into project files, once
  var restored = false;
  var liveState = null;
  try { liveState = JSON.parse(localStorage.getItem('ct-live') || 'null'); } catch (e) {}
  function bootDefault() {
    // Wait for the real shell list before opening the first-ever tab, so it lands on the
    // true default (PowerShell 7 when installed) instead of the 'powershell' placeholder.
    // The pane frame is created now (instant), the shell attached once shellsReady settles
    // — a localhost round-trip, imperceptible. shellsReady always resolves (it .catch-es).
    var first = makePane(makeCol());
    focusPane(first.id);
    shellsReady.then(function () { newTerm(first, startShell()); });
  }
  function workspaceUp() {
    // The engine copy has been consulted (or the engine is unreachable, in which
    // case there is nothing to protect) — saves are safe now. Seed it immediately
    // so the cache and the engine file converge on what this boot restored.
    workspaceReady = true;
    pushWorkspaceNow();
  }
  if (liveState) {
    // Warm cache: restore instantly, no round-trip on the boot path. The cache was
    // written by this window on its way out, so it is at least as fresh as the
    // engine's copy. restoreLayout validates, migrates, and is crash-safe; trust
    // its verdict so a refused restore falls through to a clean default, not a lie.
    try { restored = restoreLayout(liveState); } catch (e) {}
    try { if (readCurrent()) markProjectClean(); } catch (e) {}
    if (!restored) bootDefault();
    workspaceUp();
  } else {
    // No cache — a fresh install, or a wiped browser profile. This is exactly what
    // the engine-owned workspace file exists for: ask the engine before falling
    // back to the first-ever default. One localhost round-trip, fresh-boot only.
    fetch('/api/workspace', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      var ws = j && j.ok && j.workspace;
      if (ws) { try { restored = restoreLayout(ws); } catch (e) {} }
      try { if (readCurrent()) markProjectClean(); } catch (e) {}
      if (!restored) bootDefault();
      workspaceUp();
    }).catch(function () { if (!restored) bootDefault(); workspaceUp(); });
  }
  applyMode();
  setTimeout(layoutAllTabs, 100);

  // --- First-run onboarding: a stranger's first ten seconds -----------------
  // Shown once per browser, then remembered. It carries the one thing a new user
  // can't discover alone — that this same terminal reaches their phone.
  (function () {
    var seen; try { seen = localStorage.getItem('ct-onboard'); } catch (e) { seen = '1'; }
    function dismiss() { closeOvl('welcome-ovl'); try { localStorage.setItem('ct-onboard', '1'); } catch (e) {} }
    var startBtn = document.getElementById('wc-start');
    var phoneBtn = document.getElementById('wc-phone');
    var agentsPt = document.getElementById('wc-agents');
    if (startBtn) startBtn.addEventListener('click', dismiss);
    if (phoneBtn) phoneBtn.addEventListener('click', function () {
      dismiss();
      openSettings();
      setTimeout(function () { var tab = document.querySelector('[data-settab="Phone"]'); if (tab) tab.click(); }, 60);
    });
    // The "Built for agents" point is the product's whole reason to exist, so
    // the promise leads somewhere: click it and the guide opens.
    if (agentsPt) agentsPt.addEventListener('click', function () { dismiss(); openAgentsGuide(); });
    [startBtn, phoneBtn, agentsPt].forEach(function (b) {
      if (b) b.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); b.click(); } });
    });
    if (!seen) setTimeout(function () { openOvl('welcome-ovl'); }, 400);
  })();

  // --- Agents guide: from the welcome promise to the live feature -----------
  function openAgentsGuide() { openOvl('agents-ovl'); }
  (function () {
    var ovl = document.getElementById('agents-ovl');
    if (!ovl) return;
    var closeBtn = document.getElementById('wc-ag-close');
    var fleetBtn = document.getElementById('wc-ag-fleet');
    if (closeBtn) closeBtn.addEventListener('click', function () { closeOvl('agents-ovl'); });
    if (fleetBtn) fleetBtn.addEventListener('click', function () {
      closeOvl('agents-ovl');
      var root = document.getElementById('root');
      if (root && root.getAttribute('data-sidebar') !== 'open') toggleSidebar();
    });
    ovl.addEventListener('click', function (e) { if (e.target === ovl) closeOvl('agents-ovl'); });
    [closeBtn, fleetBtn].forEach(function (b) {
      if (b) b.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); b.click(); } });
    });
  })();

  // --- Control channel: let the local `winmux` CLI drive this app -----------
  // The server forwards CLI commands here over /control; we run them against
  // the real layout and reply. Desk-door only (the server never exposes
  // /control on the phone side), so this is a local-only capability.
  function serializeTerm(t, maxLines) {
    if (!t || !t.term) return '';
    var buf = t.term.buffer.active, out = [], n = buf.length;
    for (var i = 0; i < n; i++) { var line = buf.getLine(i); out.push(line ? line.translateToString(true) : ''); }
    // Drop the blank viewport rows below the cursor, THEN take the last N —
    // otherwise "last N lines" of a top-anchored shell is all trailing blanks.
    while (out.length && out[out.length - 1] === '') out.pop();
    if (maxLines && out.length > maxLines) out = out.slice(out.length - maxLines);
    return out.join('\n');
  }
  function termByTarget(target) {
    if (!target) return activeTerm();
    var all = allTerms();
    for (var i = 0; i < all.length; i++) if (String(all[i].id) === String(target)) return all[i];
    return null;
  }
  // Resolve a terminal by its server session id (sid) — what a shell's $WINMUX_SID
  // holds, so an agent's hook can address exactly the session it runs in.
  function termBySid(sid) {
    if (!sid) return null;
    var all = allTerms();
    for (var i = 0; i < all.length; i++) if (String(all[i].sid) === String(sid)) return all[i];
    return null;
  }
  // --- Browser (Phase 10 → surfaces-as-tabs) — the <webview> now lives in a
  // pane tab (newBrowserLeaf), not a side dock. browserOpen/browserWebview are
  // the seam the CLI + /control layer call; they resolve the active browser
  // leaf (creating one in the active pane if none exists) so every existing
  // `winmux browser *` verb keeps working, now targeting a tab.
  function isElectronApp() { return !!(window.winmux && window.winmux.isElectron); }
  function normalizeUrl(u) {
    u = String(u || '').trim();
    if (!u) return 'about:blank';
    if (/^(https?|file|data|about|blob|chrome|view-source):/i.test(u)) return u;  // already a scheme URL
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u;                             // any other scheme://
    if (/^(localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+)/.test(u)) return 'http://' + u;
    return 'https://' + u;
  }
  function browserWebview() { var t = activeBrowserLeaf(); return t ? t.view : null; }
  function browserOpen(url) {
    if (!isElectronApp()) return null;
    var t = activeBrowserLeaf();
    if (!t) {
      var p = paneById(activePaneId) || panes[0];
      if (!p) return null;
      t = newBrowserLeaf(p, url);
      return t ? t.url : null;
    }
    // An existing browser leaf: bring it forward, then navigate it.
    var lp = paneById(t.paneId);
    if (lp) { focusPane(lp.id); activateTerm(lp, t.id); }
    return leafLoadUrl(t, url);
  }
  // Runs INSIDE the webview: tag interactive nodes with @e refs, return a tree.
  var SNAPSHOT_JS = '(function(){' +
    'var sel="a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[onclick],summary";' +
    'var nodes=[].slice.call(document.querySelectorAll(sel));var out=[];var i=0;' +
    'nodes.forEach(function(el){var r=el.getBoundingClientRect();' +
    'if(r.width<=0||r.height<=0)return;var st=getComputedStyle(el);if(st.visibility==="hidden"||st.display==="none")return;' +
    'i++;el.setAttribute("data-wm-ref","e"+i);' +
    'var role=el.getAttribute("role")||el.tagName.toLowerCase();' +
    'var txt=(el.getAttribute("aria-label")||el.value||el.textContent||el.getAttribute("placeholder")||"").replace(/\\s+/g," ").trim().slice(0,80);' +
    'out.push("@e"+i+" "+role+(txt?" \\""+txt+"\\"":""));});' +
    'return {url:location.href,title:document.title,count:i,tree:out.join("\\n")};})()';
  function CLICK_JS(ref) {
    ref = String(ref).replace(/^@/, '');
    return '(function(){var el=document.querySelector(\'[data-wm-ref="' + ref.replace(/"/g, '') + '"]\');' +
      'if(!el)return {ok:false,error:"no such ref"};el.scrollIntoView({block:"center"});el.click();' +
      'return {ok:true,ref:"' + ref + '"};})()';
  }
  function refSel(ref) { return String(ref).replace(/^@/, '').replace(/"/g, ''); }
  function TYPE_JS(ref, text) {   // append text to a field (keystroke-like), firing input/change
    var r = refSel(ref), v = JSON.stringify(String(text == null ? '' : text));
    return '(function(){var el=document.querySelector(\'[data-wm-ref="' + r + '"]\');if(!el)return {ok:false,error:"no such ref"};' +
      'el.focus();var v=' + v + ';if("value" in el){el.value=(el.value||"")+v;el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));}' +
      'else{el.textContent=(el.textContent||"")+v;el.dispatchEvent(new Event("input",{bubbles:true}));}return {ok:true,ref:"' + r + '"};})()';
  }
  function FILL_JS(ref, val) {     // replace a field's value outright, firing input/change
    var r = refSel(ref), v = JSON.stringify(String(val == null ? '' : val));
    return '(function(){var el=document.querySelector(\'[data-wm-ref="' + r + '"]\');if(!el)return {ok:false,error:"no such ref"};' +
      'el.focus();var v=' + v + ';if("value" in el){el.value=v;el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));}' +
      'else{el.textContent=v;el.dispatchEvent(new Event("input",{bubbles:true}));}return {ok:true,ref:"' + r + '"};})()';
  }
  var GETTEXT_JS = '(function(){return {url:location.href,title:document.title,' +
    'text:(document.body?document.body.innerText:"").replace(/\\n{3,}/g,"\\n\\n").slice(0,200000)};})()';
  function SCROLL_JS(amount) {      // up|down|top|bottom|<px>
    var a = JSON.stringify(String(amount == null ? 'down' : amount));
    return '(function(){var a=' + a + ';var h=window.innerHeight||600;' +
      'if(a==="top")window.scrollTo(0,0);else if(a==="bottom")window.scrollTo(0,document.body.scrollHeight);' +
      'else if(a==="up")window.scrollBy(0,-Math.round(h*0.9));else if(a==="down")window.scrollBy(0,Math.round(h*0.9));' +
      'else{var n=parseInt(a,10);if(!isNaN(n))window.scrollBy(0,n);}return {ok:true,scrollY:window.scrollY};})()';
  }

  // --- Markdown viewer (Phase 10) — reads a file via /api/md, live-updates ---
  function mdEsc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function mdInline(s) {
    s = mdEsc(s);
    s = s.replace(/`([^`]+)`/g, function (m, c) { return '<code>' + c + '</code>'; });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    // Images before links — the leading ! must win over the plain link rule.
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (m, a, u) { return '<img src="' + u + '" alt="' + a + '">'; });
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (m, t, u) { return '<a href="' + u + '" target="_blank" rel="noopener">' + t + '</a>'; });
    return s;
  }
  function mdRender(text) {
    var lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    var html = [], i = 0, inCode = false, code = [], listType = null;
    function closeList() { if (listType) { html.push('</' + listType + '>'); listType = null; } }
    function cells(row) { return row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); }); }
    for (i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (/^```/.test(ln)) {
        if (inCode) { html.push('<pre><code>' + mdEsc(code.join('\n')) + '</code></pre>'); code = []; inCode = false; }
        else { closeList(); inCode = true; }
        continue;
      }
      if (inCode) { code.push(ln); continue; }
      // GFM table: a header row, a |---|---| separator, then body rows until a non-table line.
      if (/\|/.test(ln) && i + 1 < lines.length && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
        closeList();
        var head = cells(ln), tbl = ['<table><thead><tr>'];
        head.forEach(function (c) { tbl.push('<th>' + mdInline(c) + '</th>'); });
        tbl.push('</tr></thead><tbody>');
        i += 2;
        for (; i < lines.length; i++) {
          if (/^\s*$/.test(lines[i]) || !/\|/.test(lines[i])) break;
          var rc = cells(lines[i]);
          tbl.push('<tr>');
          for (var ci = 0; ci < head.length; ci++) tbl.push('<td>' + mdInline(rc[ci] || '') + '</td>');
          tbl.push('</tr>');
        }
        i--;   // the outer loop's i++ re-lands on the non-table line that broke us out
        tbl.push('</tbody></table>');
        html.push(tbl.join(''));
        continue;
      }
      var h = ln.match(/^(#{1,6})\s+(.*)$/);
      if (h) { closeList(); html.push('<h' + h[1].length + '>' + mdInline(h[2]) + '</h' + h[1].length + '>'); continue; }
      if (/^\s*[-*+]\s+/.test(ln)) {
        if (listType !== 'ul') { closeList(); html.push('<ul>'); listType = 'ul'; }
        var body = ln.replace(/^\s*[-*+]\s+/, '');
        var tk = body.match(/^\[([ xX])\]\s+(.*)$/);
        if (tk) html.push('<li class="task"><input type="checkbox" disabled' + (tk[1] === ' ' ? '' : ' checked') + '> ' + mdInline(tk[2]) + '</li>');
        else html.push('<li>' + mdInline(body) + '</li>');
        continue;
      }
      if (/^\s*\d+\.\s+/.test(ln)) { if (listType !== 'ol') { closeList(); html.push('<ol>'); listType = 'ol'; } html.push('<li>' + mdInline(ln.replace(/^\s*\d+\.\s+/, '')) + '</li>'); continue; }
      if (/^\s*>\s?/.test(ln)) { closeList(); html.push('<blockquote>' + mdInline(ln.replace(/^\s*>\s?/, '')) + '</blockquote>'); continue; }
      if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(ln)) { closeList(); html.push('<hr>'); continue; }
      if (/^\s*$/.test(ln)) { closeList(); continue; }
      closeList(); html.push('<p>' + mdInline(ln) + '</p>');
    }
    if (inCode) html.push('<pre><code>' + mdEsc(code.join('\n')) + '</code></pre>');
    closeList();
    return html.join('\n');
  }
  // Markdown now opens as a pane tab (newMarkdownLeaf), not a side dock. Reuse
  // the active markdown leaf if one is open (so pointing it at another file
  // swaps content in place, as the dock did), else create one in the given /
  // active pane. The CLI `winmux markdown <path>` + type menu both route here.
  function openMarkdown(mdPath, p) {
    var t = activeMarkdownLeaf();
    if (!t) {
      p = p || paneById(activePaneId) || panes[0];
      if (!p) return { path: mdPath };
      newMarkdownLeaf(p, mdPath);
      return { path: mdPath };
    }
    var lp = paneById(t.paneId);
    if (lp) { focusPane(lp.id); activateTerm(lp, t.id); }
    return mdLoadLeaf(t, mdPath);
  }

  function runControl(cmd, args) {
    args = args || {};
    if (cmd === 'list') {
      var act = activeTerm();
      return { sessions: allTerms().map(function (t) {
        // sid = the server-registry session id (null until the shell's meta arrives).
        // Orchestration registers jobs by it so the engine can supervise by session.
        return { id: t.id, title: termName(t), shell: t.shell, cwd: t.cwd || '', group: t.groupId, active: t === act, sid: t.sid || null };
      }) };
    }
    if (cmd === 'read-screen') {
      var tr = termByTarget(args.target);
      if (!tr) throw new Error('no such terminal');
      if (leafType(tr) !== 'terminal') throw new Error('that tab is a ' + leafType(tr) + ', not a terminal');
      return { id: tr.id, title: termName(tr), screen: serializeTerm(tr, args.lines || 0) };
    }
    if (cmd === 'send') {
      var ts = termByTarget(args.target);
      if (!ts) throw new Error('no such terminal');
      if (leafType(ts) !== 'terminal') throw new Error('that tab is a ' + leafType(ts) + ', not a terminal');
      var data = String(args.data == null ? '' : args.data);
      if (args.enter) data += '\r';
      if (ts.ws && ts.ws.readyState === WebSocket.OPEN) ts.ws.send(JSON.stringify({ t: 'i', d: data }));
      else throw new Error('that terminal is not connected');
      return { id: ts.id, sent: data.length };
    }
    if (cmd === 'new-tab') {
      var pn = paneById(activePaneId) || panes[0];
      if (!pn) throw new Error('no pane to add a tab to');
      var nt = newTerm(pn, args.shell || startShell(), args.cwd);
      focusPane(pn.id);
      return { id: nt && nt.id };
    }
    if (cmd === 'split') {
      var sp = paneById(activePaneId) || panes[0];
      if (!sp) throw new Error('no pane to split');
      (args.dir === 'down' ? splitDown : splitRight)(sp, args.shell || startShell(), args.cwd);
      return { ok: true, dir: args.dir === 'down' ? 'down' : 'right' };
    }
    if (cmd === 'focus') {
      var tf = termByTarget(args.target);
      if (!tf) throw new Error('no such terminal');
      var pf = paneById(tf.paneId) || paneById(activePaneId);
      if (pf) { activateTerm(pf, tf.id); focusPane(pf.id); }
      return { id: tf.id };
    }
    if (cmd === 'notify') {
      // Attention bus: an agent/script explicitly says "this session needs you".
      // Targets a session by id/title, or the active one, and escalates it exactly
      // like a bell would — the NEEDS YOU counter, the row's Approve, and (when the
      // window is unfocused) the desktop notification all follow from setStatus.
      var tnfy = args.target ? termByTarget(args.target) : activeTerm();
      if (!tnfy) throw new Error('no such terminal');
      var nmsg = String(args.message == null ? 'needs your attention' : args.message);
      if (tnfy.status !== 'needsyou') setStatus(tnfy, 'needsyou');
      notify(termName(tnfy) + ' needs you', nmsg, tnfy.id);
      return { id: tnfy.id, notified: true };
    }
    if (cmd === 'agent') {
      // Agent integration (Phase 11): a Claude Code hook inside a terminal drives
      // that session's cockpit state. Targets by sid ($WINMUX_SID) first, then id,
      // then the active session. working → the WORKING lane; needs-you → the same
      // escalation as a bell (NEEDS YOU + Approve + notification); done/idle clear it.
      var st = String(args.state == null ? '' : args.state).toLowerCase();
      var ag = args.sid ? termBySid(args.sid) : (args.target ? termByTarget(args.target) : activeTerm());
      if (!ag) throw new Error('no such terminal');
      var amsg = args.message == null ? '' : String(args.message);
      if (st === 'needs-you' || st === 'needsyou' || st === 'blocked') {
        if (ag.status !== 'needsyou') setStatus(ag, 'needsyou');
        notify(termName(ag) + ' needs you', amsg || 'needs your attention', ag.id);
        st = 'needs-you';
      } else if (st === 'working') {
        setStatus(ag, 'working');
        if (amsg) { ag.lastLine = amsg; updateDoing(ag); }
      } else if (st === 'done' || st === 'idle') {
        setStatus(ag, 'idle');
        st = 'idle';
      } else {
        throw new Error('unknown agent state: ' + st + ' (working|needs-you|done|idle)');
      }
      return { id: ag.id, sid: ag.sid, state: st };
    }
    if (cmd === 'browser') {
      if (!isElectronApp()) throw new Error('the browser tab needs the WinMux desktop app');
      var sub = args.sub || 'open';
      var view = browserWebview();
      if (sub === 'open') { return { url: browserOpen(args.url) }; }
      if (!view) throw new Error('no browser tab open — run `browser open <url>` first');
      if (sub === 'url') return { url: view.getURL() };
      if (sub === 'back') { try { view.goBack(); } catch (e) {} return { ok: true }; }
      if (sub === 'forward') { try { view.goForward(); } catch (e) {} return { ok: true }; }
      if (sub === 'reload') { try { view.reload(); } catch (e) {} return { ok: true }; }
      if (sub === 'snapshot') { return view.executeJavaScript(SNAPSHOT_JS); }   // a Promise — control layer awaits
      if (sub === 'click') { return view.executeJavaScript(CLICK_JS(args.ref)); }
      if (sub === 'type') { if (!args.ref) throw new Error('type needs a ref, e.g. @e1'); return view.executeJavaScript(TYPE_JS(args.ref, args.text)); }
      if (sub === 'fill') { if (!args.ref) throw new Error('fill needs a ref, e.g. @e1'); return view.executeJavaScript(FILL_JS(args.ref, args.value)); }
      if (sub === 'get-text') { return view.executeJavaScript(GETTEXT_JS); }
      if (sub === 'eval') {
        if (!args.js) throw new Error('eval needs a js expression');
        return view.executeJavaScript('(function(){ return (' + args.js + '); })()').then(
          function (r) { return { result: r }; },
          function (e) { return { error: String(e && e.message || e) }; });
      }
      if (sub === 'scroll') { return view.executeJavaScript(SCROLL_JS(args.amount)); }
      if (sub === 'screenshot') {
        return view.capturePage().then(function (img) { return { dataUrl: img.toDataURL() }; });
      }
      throw new Error('unknown browser subcommand: ' + sub);
    }
    if (cmd === 'markdown') {
      if (!args.path) throw new Error('markdown needs a file path');
      return openMarkdown(args.path);
    }
    throw new Error('unknown command: ' + cmd);
  }
  (function connectControl() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    function open() {
      var cws;
      try { cws = new WebSocket(proto + '//' + location.host + '/control' + location.search); }
      catch (e) { setTimeout(open, 2000); return; }
      cws.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (!m || !m.rpc) return;
        // runControl may return a value or a Promise (browser snapshot/screenshot
        // are async). Resolve both the same way.
        Promise.resolve().then(function () { return runControl(m.cmd, m.args); }).then(
          function (result) { cws.send(JSON.stringify({ rpc: m.rpc, ok: true, result: result })); },
          function (e) { cws.send(JSON.stringify({ rpc: m.rpc, ok: false, error: String(e && e.message || e) })); }
        );
      };
      cws.onclose = function () { setTimeout(open, 1500); };   // survive server restarts
      cws.onerror = function () { try { cws.close(); } catch (e) {} };
    }
    open();
  })();
})();

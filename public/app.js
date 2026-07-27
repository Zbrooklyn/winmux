// WinMux — the mockup's full chrome, wired to real shells.
// Every control here does something real: no decorative buttons.
(function () {
  var root = document.getElementById('root');
  var wsrow = document.getElementById('wsrow');
  var countEl = document.getElementById('sx-count');
  var sxList = document.getElementById('sx-list');

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

  var DEFAULTS = {
    theme: 'system', palette: 'aurora', fontFamily: 'Cascadia Code', fontSize: 13, lineHeight: 1.2,
    cursorStyle: 'block', cursorBlink: true, scrollback: 5000,
    copyOnSelect: false, rightClickPaste: false, confirmClose: true,
    defaultShell: '', startFolder: '',
  };
  var S = (function () {
    var s = {};
    for (var k in DEFAULTS) s[k] = DEFAULTS[k];
    try {
      var raw = JSON.parse(localStorage.getItem('ct-settings') || '{}');
      for (var j in raw) if (j in s) s[j] = raw[j];
    } catch (e) {}
    return s;
  })();
  function saveSettings() { try { localStorage.setItem('ct-settings', JSON.stringify(S)); } catch (e) {} }

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
    var set = (PALETTES[S.palette] || PALETTES.aurora)[light ? 'light' : 'dark'];
    for (var i = 0; i < ANSI_KEYS.length; i++) t[ANSI_KEYS[i]] = set[i];
    return t;
  }
  function applyTheme(mode) {
    S.theme = mode;
    if (mode === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    saveSettings();
    eachTerm(function (t) { try { t.term.options.theme = themeColors(); } catch (e) {} });
  }
  // Push every terminal option that Settings can change onto every live terminal.
  function applySettings() {
    eachTerm(function (t) {
      try {
        var o = t.term.options;
        o.fontFamily = FONTS[S.fontFamily] || FONTS['Cascadia Code'];
        o.fontSize = S.fontSize;
        o.lineHeight = S.lineHeight;
        o.cursorStyle = S.cursorStyle;
        o.cursorBlink = !!S.cursorBlink;
        o.scrollback = S.scrollback;
        o.theme = themeColors();
      } catch (e) {}
    });
    panes.forEach(fitActive);
    saveSettings();
  }
  function eachTerm(fn) { panes.forEach(function (p) { p.terms.forEach(fn); }); }
  function allTerms() { var a = []; eachTerm(function (t) { a.push(t); }); return a; }

  // Shells available on this machine (filled from /shells).
  var SHELLS = [{ key: 'powershell', label: 'PowerShell' }];
  var DEFAULT_SHELL = 'powershell';
  function startShell() { return S.defaultShell || DEFAULT_SHELL; }
  function labelFor(key) { for (var i = 0; i < SHELLS.length; i++) if (SHELLS[i].key === key) return SHELLS[i].label; return 'Terminal'; }
  var HOME = '';

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
  var openMenu = null;
  function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; document.removeEventListener('mousedown', onDocDown); } }
  function onDocDown(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
  function placeMenu(menu, x, y) {
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
  function copySel(t) { try { var s = t.term.getSelection(); if (s && navigator.clipboard) navigator.clipboard.writeText(s); } catch (e) {} }
  function pasteInto(t) {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(function (txt) {
          if (txt && t.ws && t.ws.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify({ t: 'i', d: txt }));
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
    addMenuItem(m, 'Select all', '', function () { try { t.term.selectAll(); } catch (e) {} });
    addMenuItem(m, 'Clear', '', function () { try { t.term.clear(); t.term.focus(); } catch (e) {} });
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
  function toggleNotif(btn) {
    if (npanel.hasAttribute('data-open')) { npanel.removeAttribute('data-open'); return; }
    renderNotif();
    npanel.setAttribute('data-open', '');
    var r = btn.getBoundingClientRect();
    npanel.style.top = (r.bottom + 6) + 'px';
    npanel.style.left = Math.min(r.left, window.innerWidth - 356) + 'px';
  }
  npanel.addEventListener('click', function (e) {
    var mark = e.target.closest ? e.target.closest('[data-notif-read]') : null;
    if (mark) { notifs.forEach(function (n) { n.unread = false; }); paintNotifBadge(); renderNotif(); return; }
    var row = e.target.closest ? e.target.closest('[data-notif]') : null;
    if (!row) return;
    var id = parseInt(row.getAttribute('data-notif'), 10);
    var n = null; notifs.forEach(function (x) { if (x.id === id) n = x; });
    if (n) { n.unread = false; paintNotifBadge(); if (n.termId) focusTerm(n.termId); }
    npanel.removeAttribute('data-open');
  });
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // ---------------------------------------------------------------- sidebar
  function totalTerms() { return panes.reduce(function (n, p) { return n + p.terms.length; }, 0); }
  function renderSidebar() {
    var counts = { working: 0, needsyou: 0, idle: 0 };
    var html = '';
    panes.forEach(function (p) {
      p.terms.forEach(function (t) {
        var st = t.status;
        if (st === 'working') counts.working++;
        else if (st === 'needsyou') counts.needsyou++;
        else counts.idle++;
        var on = t.id === p.activeTermId && p.id === activePaneId;
        var name = t.tabEl ? t.tabEl.querySelector('.tt').textContent : labelFor(t.shell);
        html += '<div class="prow" data-term="' + t.id + '"' + (on ? ' data-active' : '') + '>' +
          '<span class="pfolder">' + FOLDER_SVG + '<span class="pdot" style="background:' + (STATUS_COLOR[st] || 'transparent') + '"></span></span>' +
          '<div class="pinfo"><div class="pname">' + (p.pinned ? PPIN_SVG : '') + esc(name) + '</div><div class="psub">' + esc(t.state === 'reconnecting' ? 'reconnecting…' : (t.cwd || (t.state === 'closed' ? 'session ended' : 'connecting…'))) + '</div></div>' +
          '<span class="ptrail"><span class="pexpand" data-close="' + t.id + '" title="Close terminal">' + CLOSE_SVG + '</span></span>' +
          '</div>';
      });
    });
    sxList.innerHTML = html;
    document.getElementById('d-work').textContent = String(counts.working);
    document.getElementById('d-need').textContent = String(counts.needsyou);
    document.getElementById('d-idle').textContent = String(counts.idle);
    if (countEl) countEl.textContent = String(totalTerms());
    var live = document.getElementById('nhead-live');
    if (live) { var n = totalTerms(); live.textContent = n + ' running'; }
  }
  sxList.addEventListener('click', function (e) {
    var x = e.target.closest ? e.target.closest('[data-close]') : null;
    if (x) {
      e.stopPropagation();
      var tid = parseInt(x.getAttribute('data-close'), 10);
      var tt = termById(tid);
      if (tt) askCloseTerm(paneById(tt.paneId), tid);
      return;
    }
    var row = e.target.closest ? e.target.closest('[data-term]') : null;
    if (row) focusTerm(parseInt(row.getAttribute('data-term'), 10));
  });
  sxList.addEventListener('contextmenu', function (e) {
    var row = e.target.closest ? e.target.closest('[data-term]') : null;
    if (!row) return;
    e.preventDefault();
    var t = termById(parseInt(row.getAttribute('data-term'), 10));
    if (t) showSessionMenu(t, e.clientX, e.clientY);
  });

  function termById(id) { var f = null; eachTerm(function (t) { if (t.id === id) f = t; }); return f; }
  function focusTerm(id) {
    var t = termById(id); if (!t) return;
    var p = paneById(t.paneId); if (!p) return;
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
    renderSidebar();
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
  function sendResize(t) { if (t.ws && t.ws.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify({ t: 'r', c: t.term.cols, r: t.term.rows })); }
  // Closing a tab on purpose is the one close that should take the shell with it.
  // Every other disconnect is treated as an interruption and waited out, so this
  // has to say so explicitly — otherwise a closed tab parks a live PowerShell on
  // the machine for the length of the grace window.
  function killShell(t) {
    t.closing = true;
    try { if (t.ws && t.ws.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify({ t: 'x' })); } catch (e) {}
    try { if (t.ws) t.ws.close(); } catch (e) {}
  }
  function fitActive(p) { var t = activeTermOf(p); if (t) { try { t.fit.fit(); } catch (e) {} sendResize(t); } }
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
    p.pill.setAttribute('data-state', s === 'open' ? 'open' : (s === 'closed' ? 'closed' : (s === 'reconnecting' ? 'reconnecting' : 'idle')));
    p.connText.textContent = s === 'open' ? 'connected'
      : (s === 'closed' ? 'disconnected' : (s === 'reconnecting' ? 'reconnecting…' : 'connecting…'));
  }
  function focusPane(id) {
    activePaneId = id;
    panes.forEach(function (p) { if (p.id === id) p.el.classList.add('focused'); else p.el.classList.remove('focused'); });
    var p = paneById(id);
    if (p) {
      reflect(p);
      var t = activeTermOf(p);
      if (t) { t.term.focus(); if (t.status === 'needsyou') setStatus(t, 'idle'); }
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
      if (on) { try { t.fit.fit(); } catch (e) {} sendResize(t); t.term.focus(); if (t.status === 'needsyou') setStatus(t, 'idle'); }
    });
    if (!cycling) touchMru(p, termId);
    reflect(p);
    updateFindCount(p);
    layoutTabs(p);
    renderSidebar();
  }

  function askCloseTerm(p, termId) {
    if (!p) return;
    var t = termById(termId);
    if (S.confirmClose && t && t.state === 'open') {
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
    recordClosed(p, t);
    clearTimeout(t.busyTimer); stopProg(t);
    killShell(t);
    try { t.term.dispose(); } catch (e) {}
    t.host.remove(); t.tabEl.remove();
    p.terms.splice(idx, 1);
    var mi = p.mru.indexOf(termId); if (mi >= 0) p.mru.splice(mi, 1);
    if (p.terms.length === 0) {
      // A pinned pane survives its last tab — it gets a fresh shell instead of disappearing.
      if (panes.length > 1 && !p.pinned) { closePane(p); return; }
      newTerm(p, startShell()); updateChrome(); return;
    }
    if (p.activeTermId === termId) {
      var nextId = p.mru.length ? p.mru[0] : p.terms[Math.max(0, idx - 1)].id;
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
    renderSidebar();
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
      paneId: p.id, shell: t.shell, cwd: t.cwd,
      name: t.renamed ? t.tabEl.querySelector('.tt').textContent : null,
    });
    if (closedStack.length > 20) closedStack.shift();
  }
  function reopenClosed() {
    var d = closedStack.pop();
    if (!d) return;
    var p = paneById(d.paneId) || paneById(activePaneId) || panes[0];
    if (!p) return;
    var t = newTerm(p, d.shell, d.cwd);
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

  function newTerm(p, shellKey, cwd) {
    shellKey = shellKey || startShell();
    var id = ++termSeq;
    var host = document.createElement('div');
    host.className = 'term-host';
    host.style.display = 'none';
    p.termArea.appendChild(host);

    var term = new Terminal({
      fontFamily: FONTS[S.fontFamily] || FONTS['Cascadia Code'],
      fontSize: S.fontSize, lineHeight: S.lineHeight, cursorBlink: !!S.cursorBlink,
      cursorStyle: S.cursorStyle, scrollback: S.scrollback, theme: themeColors(),
      // Search highlight decorations are a proposed API; the find bar needs them.
      allowProposedApi: true,
    });
    var fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    var search = new SearchAddon.SearchAddon();
    term.loadAddon(search);
    term.open(host);
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
      '<span class="tt">' + esc(labelFor(shellKey)) + '</span><span class="x" title="Close tab (Alt+W)">×</span>' +
      '<i class="tprog" style="width:0"></i>';
    p.tabscroll.appendChild(tabEl);
    var ttEl = tabEl.querySelector('.tt');

    var t = {
      id: id, paneId: p.id, term: term, fit: fit, search: search, ws: null, host: host,
      tabEl: tabEl, dotEl: tabEl.querySelector('.fdot'), progEl: tabEl.querySelector('.tprog'),
      state: 'idle', status: 'idle', sid: null, ended: false,
      cwd: null, shell: shellKey, renamed: false, results: null, busyTimer: null, progTimer: null,
    };
    // A tab can be dragged into another pane, so never close over `p` — look the pane up live.
    function pn() { return paneById(t.paneId) || p; }

    // One shell, but possibly several sockets over its life. Losing the socket
    // is not the shell ending — a phone sleeping, a lid closing, a wifi hop and
    // a backgrounded tab all do it, and the shell on the other side is still
    // running with your work in it. So we wait it out and pick it back up by id
    // instead of printing an obituary. `[session ended]` is kept for the one
    // case that earns it: the shell itself exited.
    var retries = 0, retryTimer = null, told = false;
    function connect() {
      clearTimeout(retryTimer);
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
        t.state = 'open';
        if (t.status === 'closed') setStatus(t, 'idle');
        if (pn().activeTermId === id) reflect(pn());
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
          if (m.sid) t.sid = m.sid;
          if (m.shell && ttEl && !t.renamed) ttEl.textContent = m.shell;
          if (m.cwd) { t.cwd = m.cwd; if (!dockPath.value) dockPath.value = m.cwd; }
          if (m.resumed) {
            // Redraw from the shell's own record rather than trusting whatever
            // half-written screen we were left holding.
            term.reset();
            if (told) { term.write('\x1b[90m[reconnected]\x1b[0m\r\n'); told = false; }
          } else if (m.lost) {
            // We asked for a shell that is gone — say so plainly instead of
            // passing this fresh one off as the old one.
            term.write('\r\n\x1b[90m[that session ended — this is a new shell]\x1b[0m\r\n');
            told = false;
          }
          renderSidebar();
          return;
        }
        term.write(new Uint8Array(ev.data));
        markWorking(t);
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
      if (broadcastOn) {
        allTerms().forEach(function (x) { if (x.ws && x.ws.readyState === WebSocket.OPEN) x.ws.send(JSON.stringify({ t: 'i', d: d })); });
        return;
      }
      if (t.ws && t.ws.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify({ t: 'i', d: d }));
    });
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
      term.textarea.addEventListener('focus', function () { focusPane(t.paneId); });
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
      '<div class="nbar"><span class="back">' + BACK_SVG + '<span>Terminals</span></span><span class="nm"></span></div>' +
      '<div class="ptabs">' +
        '<div class="pctrls"><span class="pc pc-rail" title="Toggle left sidebar (Ctrl+B)" role="button">' + RAIL_SVG + '</span></div>' +
        '<div class="tabscroll"></div>' +
        '<div class="tab-of" title="Tabs that don\'t fit" role="button" style="display:none"><span class="ofc">0</span>' + CARET_SVG + '<span class="ofdot" style="display:none"></span></div>' +
        '<div class="connpill" data-state="idle"><span class="dot"></span><span class="conntext">connecting…</span></div>' +
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
    p.railBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleSidebar(); });
    p.newBtn.addEventListener('click', function () { focusPane(p.id); newTerm(p, startShell()); });
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
    el.querySelector('.nbar .back').addEventListener('click', function () { setView('projects'); });
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
    if (op.terms.length === 0) {
      if (panes.length > 1 && !op.pinned) closePane(op);
      else newTerm(op, startShell());
    } else if (op.activeTermId === t.id) {
      activateTerm(op, op.mru.length ? op.mru[0] : op.terms[0].id);
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
    var t = activeTerm(); if (t) t.term.focus();
  }
  document.getElementById('bcast-stop').addEventListener('click', function () { setBroadcast(false); });

  // ------------------------------------------------------- sidebar + dock
  function setSidebar(state) { root.setAttribute('data-sidebar', state); setTimeout(function () { panes.forEach(fitActive); }, 40); }
  function toggleSidebar() { setSidebar(root.getAttribute('data-sidebar') === 'open' ? 'collapsed' : 'open'); }
  document.getElementById('collapse-sidebar').addEventListener('click', function () { setSidebar('collapsed'); });
  document.getElementById('sidebar-reopen').addEventListener('click', function () { setSidebar('open'); });

  var dockPath = document.getElementById('dock-path');
  var dockDiff = document.getElementById('dock-diff');
  function dockOpen() { return root.getAttribute('data-dock') === 'open'; }
  function toggleDock() {
    if (dockOpen()) { root.setAttribute('data-dock', 'closed'); }
    else {
      root.setAttribute('data-dock', 'open');
      var t = activeTerm();
      if (!dockPath.value) dockPath.value = (t && t.cwd) || HOME || '';
      refreshChanges();
    }
    setTimeout(function () { panes.forEach(fitActive); }, 40);
  }
  document.getElementById('dock-close').addEventListener('click', function () { root.setAttribute('data-dock', 'closed'); setTimeout(function () { panes.forEach(fitActive); }, 40); });
  document.getElementById('dock-reopen').addEventListener('click', toggleDock);
  document.getElementById('dock-refresh').addEventListener('click', refreshChanges);
  dockPath.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') refreshChanges(); });

  var diffFiles = [];
  var diffActive = 0;
  function refreshChanges() {
    dockDiff.innerHTML = '<div class="diff-empty">Reading git status…</div>';
    fetch('/api/git?cwd=' + encodeURIComponent(dockPath.value || ''))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { dockDiff.innerHTML = '<div class="diff-empty">' + esc(d.error || 'No changes available') + '<div style="font-size:11.5px">' + esc(d.cwd || '') + '</div></div>'; return; }
        diffFiles = d.files || []; diffActive = 0;
        if (!diffFiles.length) { dockDiff.innerHTML = '<div class="diff-empty">Working tree clean<div style="font-size:11.5px">' + esc(d.branch) + ' · ' + esc(d.root) + '</div></div>'; return; }
        renderDiff(d);
      })
      .catch(function () { dockDiff.innerHTML = '<div class="diff-empty">Could not read changes</div>'; });
  }
  function renderDiff(d) {
    var add = 0, del = 0;
    diffFiles.forEach(function (f) { add += f.add || 0; del += f.del || 0; });
    var files = diffFiles.map(function (f, i) {
      return '<div class="dfile"' + (i === diffActive ? ' data-active' : '') + ' data-i="' + i + '">' +
        '<span class="db ' + (f.st || 'M') + '">' + (f.st || 'M') + '</span>' +
        '<span class="dp">' + esc(f.path) + '</span>' +
        '<span class="dnums"><span class="a">+' + (f.add || 0) + '</span> <span class="d">-' + (f.del || 0) + '</span></span></div>';
    }).join('');
    dockDiff.innerHTML =
      '<div class="diff"><div class="diff-head"><span class="dt">' + esc(d.branch || 'HEAD') + '</span>' +
      '<span class="dstat"><span class="a">+' + add + '</span><span class="d">-' + del + '</span></span></div>' +
      '<div class="diff-body"><div class="diff-files">' + files + '</div><div class="diff-hunks"></div></div></div>';
    dockDiff.querySelector('.diff-files').addEventListener('click', function (e) {
      var row = e.target.closest ? e.target.closest('[data-i]') : null;
      if (!row) return;
      diffActive = parseInt(row.getAttribute('data-i'), 10);
      [].forEach.call(dockDiff.querySelectorAll('.dfile'), function (x, i) {
        if (i === diffActive) x.setAttribute('data-active', ''); else x.removeAttribute('data-active');
      });
      renderHunks();
    });
    renderHunks();
  }
  function renderHunks() {
    var f = diffFiles[diffActive];
    var box = dockDiff.querySelector('.diff-hunks');
    if (!box) return;
    if (!f || !f.hunks || !f.hunks.length) { box.innerHTML = '<div style="padding:12px 14px;color:var(--faint)">' + (f && f.binary ? 'Binary file' : 'No preview') + '</div>'; return; }
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
    box.innerHTML = html;
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

  // ---------------------------------------------------------- save / load
  function layouts() { try { return JSON.parse(localStorage.getItem('ct-layouts') || '[]'); } catch (e) { return []; } }
  function snapshot() {
    var cols = [];
    [].forEach.call(wsrow.querySelectorAll('.wscol'), function (c) {
      var stack = [];
      [].forEach.call(c.querySelectorAll('.pane'), function (pe) {
        var p = null; panes.forEach(function (x) { if (x.el === pe) p = x; });
        if (!p) return;
        stack.push({
          active: Math.max(0, p.terms.map(function (t) { return t.id; }).indexOf(p.activeTermId)),
          tabs: p.terms.map(function (t) {
            return { shell: t.shell, cwd: t.cwd || '', title: t.renamed ? t.tabEl.querySelector('.tt').textContent : '' };
          }),
        });
      });
      if (stack.length) cols.push(stack);
    });
    return { cols: cols };
  }
  function restoreLayout(desc) {
    if (!desc || !desc.cols || !desc.cols.length) return;
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
          var t = newTerm(p, td.shell, td.cwd);
          if (td.title) { t.tabEl.querySelector('.tt').textContent = td.title; t.renamed = true; }
        });
        if (p.terms[pd.active]) activateTerm(p, p.terms[pd.active].id);
      });
    });
    updateChrome();
    if (panes[0]) focusPane(panes[0].id);
    setTimeout(function () { panes.forEach(fitActive); }, 60);
  }
  // Layouts live in a small popover anchored to the sidebar button — saving and
  // loading are the same short list, so they are one surface, not two modals.
  var sessmenu = document.getElementById('sessmenu');
  var smName = document.getElementById('sm-name');
  var smList = document.getElementById('sm-list');
  function writeLayouts(list) { try { localStorage.setItem('ct-layouts', JSON.stringify(list.slice(0, 20))); } catch (e) {} }
  function renderLayouts() {
    var list = layouts();
    if (!list.length) { smList.innerHTML = '<div class="sm-empty">No saved layouts yet. Name this one and hit Save.</div>'; return; }
    smList.innerHTML = list.map(function (l, i) {
      var n = l.desc.cols.reduce(function (a, c) { return a + c.reduce(function (b, p) { return b + p.tabs.length; }, 0); }, 0);
      return '<div class="sm-row" data-i="' + i + '" role="button" title="Restore this layout">' +
        '<span class="sm-nm">' + esc(l.name) + '</span>' +
        '<span class="sm-sub">' + n + ' tab' + (n === 1 ? '' : 's') + ' · ' + ago(l.when) + '</span>' +
        '<span class="sm-del" data-del="' + i + '" title="Delete layout">×</span></div>';
    }).join('');
  }
  function openLayoutMenu(anchor) {
    renderLayouts();
    smName.value = 'Layout ' + (layouts().length + 1);
    sessmenu.setAttribute('data-open', '');
    if (anchor) {
      var r = anchor.getBoundingClientRect();
      sessmenu.style.left = Math.round(r.right + 8) + 'px';
      sessmenu.style.top = Math.min(window.innerHeight - 320, Math.round(r.top)) + 'px';
    }
    smName.focus(); smName.select();
  }
  function closeLayoutMenu() { sessmenu.removeAttribute('data-open'); }
  function toggleLayoutMenu(anchor) {
    if (sessmenu.hasAttribute('data-open')) closeLayoutMenu(); else openLayoutMenu(anchor);
  }
  function doSaveLayout() {
    var name = (smName.value || ('Layout ' + (layouts().length + 1))).trim();
    if (!name) return;
    var list = layouts().filter(function (l) { return l.name !== name; });
    list.unshift({ name: name, when: Date.now(), desc: snapshot() });
    writeLayouts(list);
    renderLayouts();
    smName.value = '';
    notify('Layout saved', name);
  }
  document.getElementById('sm-save').addEventListener('click', doSaveLayout);
  smName.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') doSaveLayout(); if (e.key === 'Escape') closeLayoutMenu(); });
  smList.addEventListener('click', function (e) {
    var del = e.target.closest ? e.target.closest('[data-del]') : null;
    if (del) {
      e.stopPropagation();
      var li = layouts(); li.splice(parseInt(del.getAttribute('data-del'), 10), 1);
      writeLayouts(li); renderLayouts();
      return;
    }
    var row = e.target.closest ? e.target.closest('[data-i]') : null;
    if (!row) return;
    var l = layouts()[parseInt(row.getAttribute('data-i'), 10)];
    if (!l) return;
    closeLayoutMenu();
    // Restoring ends whatever is running now, so it asks first.
    var live = allTerms().filter(function (t) { return t.state === 'open'; }).length;
    if (S.confirmClose && live) {
      confirmDialog('Restore “' + l.name + '”?', live + ' running terminal' + (live > 1 ? 's' : '') + ' will be ended and the saved panes rebuilt.', 'Restore layout', function () { restoreLayout(l.desc); });
    } else restoreLayout(l.desc);
  });
  document.addEventListener('mousedown', function (e) {
    if (!sessmenu.hasAttribute('data-open')) return;
    if (sessmenu.contains(e.target) || (e.target.closest && e.target.closest('#open-save,#open-load'))) return;
    closeLayoutMenu();
  });
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
          Object.keys(PALETTES).map(function (k) { return [k, PALETTES[k].label]; }), S.palette)) +
        frow('Font', 'Applied to every open terminal', sel('fontFamily', Object.keys(FONTS), S.fontFamily)) +
        frow('Font size', 'Also Ctrl + / Ctrl − / Ctrl+wheel', '<input class="ctl" type="number" min="8" max="28" value="' + S.fontSize + '" data-set="fontSize" style="width:70px">') +
        frow('Line height', '', '<input class="ctl" type="number" min="1" max="2" step="0.05" value="' + S.lineHeight + '" data-set="lineHeight" style="width:70px">');
    }
    if (t === 'Terminal') {
      return frow('Cursor style', '', sel('cursorStyle', [['block', 'Block'], ['underline', 'Underline'], ['bar', 'Bar']], S.cursorStyle)) +
        frow('Cursor blink', '', sw('cursorBlink', S.cursorBlink)) +
        frow('Scrollback lines', 'How much history each terminal keeps', '<input class="ctl" type="number" min="500" max="100000" step="500" value="' + S.scrollback + '" data-set="scrollback" style="width:92px">') +
        frow('Copy on select', 'Selecting text copies it straight away', sw('copyOnSelect', S.copyOnSelect)) +
        frow('Right-click pastes', 'Otherwise right-click opens the menu', sw('rightClickPaste', S.rightClickPaste));
    }
    if (t === 'Behaviour') {
      return frow('Confirm before closing', 'Ask before ending a running shell', sw('confirmClose', S.confirmClose)) +
        frow('Default shell', 'Used by new tabs and splits', sel('defaultShell', [['', 'First available (' + labelFor(DEFAULT_SHELL) + ')']].concat(SHELLS.map(function (s) { return [s.key, s.label]; })), S.defaultShell)) +
        frow('Start folder', 'Blank = your home folder', '<input class="ctl" type="text" value="' + esc(S.startFolder) + '" data-set="startFolder" placeholder="' + esc(HOME) + '" style="width:230px" spellcheck="false">');
    }
    if (t === 'Phone') return phonePane();
    if (t === 'Shortcuts') {
      return KEYS.map(function (k) { return frow(k[0], '', '<span class="kbd">' + k[1] + '</span>'); }).join('') +
        '<div style="margin-top:14px"><span class="btn" data-act="cheat">Open the full list (F1)</span></div>';
    }
    return '<div style="font-size:13px;margin-bottom:6px">WinMux v1.0</div>' +
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
  function openSettings(tab) {
    curSet = tab || curSet;
    if (curSet === 'Phone') phoneErr = '';
    renderSettings(); openOvl('settings-ovl');
    if (curSet === 'Phone') loadPhone();
  }
  document.getElementById('settings-tabs').addEventListener('click', function (e) {
    var tab = e.target.closest ? e.target.closest('[data-settab]') : null;
    if (!tab) return;
    curSet = tab.getAttribute('data-settab');
    // The switch must reflect the server, not whatever it looked like last time.
    if (curSet === 'Phone') { phoneS = null; phoneErr = ''; renderSettings(); loadPhone(); return; }
    renderSettings();
  });
  document.getElementById('settings-pane').addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('[data-phone-toggle]')) { flipPhone(); return; }
    if (e.target.closest && e.target.closest('[data-trust-toggle]')) { flipTrust(); return; }
    var s = e.target.closest ? e.target.closest('[data-sw]') : null;
    if (s) {
      var k = s.getAttribute('data-sw');
      S[k] = !S[k];
      s.classList.toggle('on', !!S[k]);
      applySettings();
      return;
    }
    var act = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!act) return;
    var a = act.getAttribute('data-act');
    if (a === 'cheat') { closeOvl('settings-ovl'); openCheat(); }
    if (a === 'diag') { closeOvl('settings-ovl'); openDiag(); }
    if (a === 'phone-copy' && phoneS && phoneS.url) {
      try {
        navigator.clipboard.writeText(phoneS.url);
        notify('Link copied', 'Anyone holding it can reach this PC — paste it carefully.');
      } catch (err) { notify('Could not copy', 'Select the link and copy it by hand.'); }
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
  function openCheat() {
    document.getElementById('cheat-body').innerHTML = '<h2>Keyboard shortcuts</h2>' +
      Object.keys(CHEAT).map(function (sec) {
        return '<div class="csec">' + sec + '</div>' + CHEAT[sec].map(function (r) {
          return '<div class="crow"><span class="ca">' + r[0] + '</span><span class="kbd">' + r[1] + '</span></div>';
        }).join('');
      }).join('');
    openOvl('cheat-ovl');
  }
  document.getElementById('cheat-ovl').addEventListener('click', function (e) { if (e.target.id === 'cheat-ovl') closeOvl('cheat-ovl'); });

  // ----------------------------------------------------------- diagnostics
  function openDiag() {
    var pane = document.getElementById('diag-pane');
    pane.innerHTML = '<div style="color:var(--faint);font-size:12.5px">Reading server…</div>';
    openOvl('diag-ovl');
    fetch('/api/info').then(function (r) { return r.json(); }).then(function (d) {
      HOME = d.home || HOME;
      var rows = [
        ['Server', 'http://' + d.host + ':' + d.port],
        ['Process id', d.pid], ['Node', d.node], ['Platform', d.platform + ' · ' + d.arch],
        ['Uptime', Math.floor(d.uptime / 60) + 'm ' + (d.uptime % 60) + 's'],
        ['Live shells', d.sessions + ' connected'],
        ['Shells found', (d.shells || []).join(', ')],
        ['Home folder', d.home], ['CPU cores', d.cpus], ['Memory', d.mem],
        ['Terminals open', totalTerms() + ' in ' + panes.length + ' pane' + (panes.length > 1 ? 's' : '')],
        ['Browser', navigator.userAgent],
      ];
      pane.innerHTML = '<h3>This server</h3>' + rows.map(function (r) {
        return '<div class="kvrow"><span class="k">' + r[0] + '</span><span class="v">' + esc(r[1]) + '</span></div>';
      }).join('') + '<div style="margin-top:16px"><span class="btn" data-diag-refresh>Refresh</span></div>';
      pane.querySelector('[data-diag-refresh]').addEventListener('click', openDiag);
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
      { cat: 'Terminal', name: 'Clear terminal', run: function () { var t = activeTerm(); if (t) { t.term.clear(); t.term.focus(); } } },
      { cat: 'Terminal', name: 'Copy selection', kbd: 'Ctrl+Shift+C', run: function () { var t = activeTerm(); if (t) copySel(t); } },
      { cat: 'Terminal', name: 'Paste', kbd: 'Ctrl+Shift+V', run: function () { var t = activeTerm(); if (t) pasteInto(t); } },
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
      { cat: 'Layout', name: 'Save layout', kbd: 'Ctrl+Alt+S', run: saveLayoutDialog },
      { cat: 'Layout', name: 'Load layout', kbd: 'Ctrl+Alt+O', run: loadLayoutDialog },
      { cat: 'App', name: 'Settings', kbd: 'Ctrl+,', run: function () { openSettings(); } },
      { cat: 'App', name: 'Keyboard shortcuts', kbd: 'F1', run: openCheat },
      { cat: 'App', name: 'Diagnostics', run: openDiag },
    ];
    SHELLS.forEach(function (s) {
      list.push({ cat: 'New', name: 'New ' + s.label + ' tab', run: function () { var p = paneById(activePaneId); if (p) newTerm(p, s.key); } });
      list.push({ cat: 'New', name: 'Split right with ' + s.label, run: function () { var p = paneById(activePaneId); if (p) splitRight(p, s.key); } });
    });
    allTerms().forEach(function (t) {
      list.push({ cat: 'Go to', name: t.tabEl.querySelector('.tt').textContent + (t.cwd ? ' — ' + t.cwd : ''), run: function () { focusTerm(t.id); } });
    });
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
  function closePalette() { plWrap.removeAttribute('data-open'); var t = activeTerm(); if (t) t.term.focus(); }
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
  document.getElementById('open-save').addEventListener('click', function (e) { toggleLayoutMenu(e.currentTarget); });
  document.getElementById('open-load').addEventListener('click', function (e) { toggleLayoutMenu(e.currentTarget); });
  document.getElementById('open-diag').addEventListener('click', openDiag);
  document.getElementById('open-help').addEventListener('click', openCheat);
  document.getElementById('open-settings').addEventListener('click', function () { openSettings(); });
  document.getElementById('version-chip').addEventListener('click', openDiag);
  document.addEventListener('mousedown', function (e) {
    if (npanel.hasAttribute('data-open') && !npanel.contains(e.target) && !e.target.closest('#open-notif')) npanel.removeAttribute('data-open');
  });

  // -------------------------------------------------------------- keyboard
  // One capture-phase handler for the whole app: xterm's own textarea listener
  // never sees a shortcut we claim here.
  document.addEventListener('keydown', function (e) {
    var tgt = e.target;
    var inField = tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || (tgt.tagName === 'TEXTAREA' && !tgt.classList.contains('xterm-helper-textarea')));
    if (e.key === 'Escape') {
      if (copyMode) { exitCopyMode(); e.preventDefault(); return; }
      if (sessmenu.hasAttribute('data-open')) { closeLayoutMenu(); e.preventDefault(); return; }
      if (openMenu) { closeMenu(); e.preventDefault(); return; }
      if (plWrap.hasAttribute('data-open')) { closePalette(); e.preventDefault(); return; }
      if (npanel.hasAttribute('data-open')) { npanel.removeAttribute('data-open'); e.preventDefault(); return; }
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

    if (e.key === 'F1') { stop(); openCheat(); return; }
    if (ctrl && e.shiftKey && (e.key === 'P' || e.key === 'p')) { stop(); openPalette(); return; }
    if (ctrl && !e.shiftKey && !e.altKey && e.key === ',') { stop(); openSettings(); return; }
    if (ctrl && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) { stop(); toggleSidebar(); return; }
    if (ctrl && e.altKey && (e.key === 'd' || e.key === 'D')) { stop(); toggleDock(); return; }
    if (ctrl && e.altKey && (e.key === 'n' || e.key === 'N')) { stop(); toggleNotif(document.getElementById('open-notif')); return; }
    if (ctrl && e.altKey && (e.key === 'b' || e.key === 'B')) { stop(); setBroadcast(!broadcastOn); return; }
    if (ctrl && e.altKey && (e.key === 's' || e.key === 'S')) { stop(); saveLayoutDialog(); return; }
    if (ctrl && e.altKey && (e.key === 'o' || e.key === 'O')) { stop(); loadLayoutDialog(); return; }
    if (ctrl && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) { stop(); if (p) openFind(p); return; }
    if (ctrl && e.shiftKey && (e.key === 'C' || e.key === 'c')) { stop(); var tc = activeTerm(); if (tc) copySel(tc); return; }
    if (ctrl && e.shiftKey && (e.key === 'V' || e.key === 'v')) { stop(); var tv = activeTerm(); if (tv) pasteInto(tv); return; }
    if (ctrl && e.shiftKey && e.key === 'Enter') { stop(); if (p) toggleZoom(p); return; }
    if (ctrl && e.shiftKey && (e.key === 'D' || e.key === 'd')) { stop(); if (p) splitDown(p, startShell()); return; }
    if (ctrl && !e.shiftKey && !e.altKey && (e.key === 'd' || e.key === 'D')) { stop(); if (p) splitRight(p, startShell()); return; }
    if (ctrl && !e.altKey && (e.key === '=' || e.key === '+')) { stop(); setFontSize(S.fontSize + 1); return; }
    if (ctrl && !e.altKey && (e.key === '-' || e.key === '_')) { stop(); setFontSize(S.fontSize - 1); return; }
    if (ctrl && !e.altKey && e.key === '0') { stop(); S.fontSize = DEFAULTS.fontSize; applySettings(); return; }
    if (e.altKey && e.shiftKey && (e.key === 'W' || e.key === 'w')) { stop(); if (p) askClosePane(p); return; }
    if (e.altKey && !e.shiftKey && (e.key === 'w' || e.key === 'W')) { stop(); if (p && p.activeTermId) askCloseTerm(p, p.activeTermId); return; }
    if (e.altKey && !e.shiftKey && (e.key === 't' || e.key === 'T')) { stop(); if (p) newTerm(p, startShell()); return; }
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
  function modeFor(w) { return w <= 620 ? 'narrow' : (w < 1120 ? 'half' : 'full'); }
  function setView(v) {
    root.setAttribute('data-view', v);
    if (v === 'focus') {
      var p = paneById(activePaneId);
      if (p) { paintNbar(p); setTimeout(function () { fitActive(p); }, 30); }
    }
  }
  function paintNbar(p) {
    if (!p || !p.nbarName) return;
    var t = activeTermOf(p);
    p.nbarName.textContent = t ? t.tabEl.querySelector('.tt').textContent : 'Terminal';
  }
  function applyMode() {
    var m = modeFor(window.innerWidth);
    if (m === currentMode) { if (m === 'narrow') paintNbar(paneById(activePaneId)); return; }
    currentMode = m;
    root.setAttribute('data-mode', m);
    if (m === 'narrow') {
      // One terminal open? Go straight to it — a list of one costs a pointless tap.
      setView(totalTerms() > 1 ? 'projects' : 'focus');
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

  // ------------------------------------------------------------------- boot
  if (S.theme === 'light' || S.theme === 'dark') document.documentElement.setAttribute('data-theme', S.theme);
  paintNotifBadge();

  fetch('/api/info').then(function (r) { return r.json(); }).then(function (d) { HOME = d.home || ''; if (!dockPath.value) dockPath.value = HOME; }).catch(function () {});
  fetch('/shells').then(function (r) { return r.json(); }).then(function (list) {
    if (Array.isArray(list) && list.length) { SHELLS = list; DEFAULT_SHELL = list[0].key; }
  }).catch(function () {});

  // The two moments worth retrying on immediately, instead of waiting out
  // whatever the backoff had scheduled: the tab coming back to the foreground
  // (the phone was asleep) and the network returning (the wifi hopped).
  function wakeAll() { allTerms().forEach(function (t) { if (t.retryNow) t.retryNow(); }); }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) wakeAll(); });
  window.addEventListener('online', wakeAll);
  window.addEventListener('pageshow', wakeAll);

  var first = makePane(makeCol());
  newTerm(first, startShell());
  focusPane(first.id);
  applyMode();
  setTimeout(layoutAllTabs, 100);
})();

// Cockpit terminal — the mockup's full chrome, wired to real shells.
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
  var DEFAULTS = {
    theme: 'system', fontFamily: 'Cascadia Code', fontSize: 13, lineHeight: 1.2,
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
    return isLightNow()
      ? { background: '#fbfbfb', foreground: '#232323', cursor: '#8a5cf5', selectionBackground: 'rgba(138,92,245,.25)' }
      : { background: '#1a1a1a', foreground: '#dadada', cursor: '#8a5cf5', selectionBackground: 'rgba(138,92,245,.30)' };
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

  var STATUS_COLOR = { working: 'var(--work)', needsyou: 'var(--err)', closed: 'var(--faint)', idle: 'transparent' };

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
      item.innerHTML = '<span class="tfav"><span class="fav fav-t">&gt;_</span></span><span class="nm">' + s.label + '</span>';
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
          if (txt && t.ws.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify({ t: 'i', d: txt }));
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
          '<div class="pinfo"><div class="pname">' + esc(name) + '</div><div class="psub">' + esc(t.cwd || (t.state === 'closed' ? 'session ended' : 'connecting…')) + '</div></div>' +
          '<span class="ptrail"><span class="pexpand" data-close="' + t.id + '" title="Close terminal">' + CLOSE_SVG + '</span></span>' +
          '</div>';
      });
    });
    sxList.innerHTML = html;
    document.getElementById('d-work').textContent = String(counts.working);
    document.getElementById('d-need').textContent = String(counts.needsyou);
    document.getElementById('d-idle').textContent = String(counts.idle);
    if (countEl) countEl.textContent = String(totalTerms());
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
  function sendResize(t) { if (t.ws.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify({ t: 'r', c: t.term.cols, r: t.term.rows })); }
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
    p.pill.setAttribute('data-state', s === 'open' ? 'open' : (s === 'closed' ? 'closed' : 'idle'));
    p.connText.textContent = s === 'open' ? 'connected' : (s === 'closed' ? 'disconnected' : 'connecting…');
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

  function activateTerm(p, termId) {
    p.activeTermId = termId;
    p.terms.forEach(function (t) {
      var on = t.id === termId;
      t.host.style.display = on ? 'block' : 'none';
      if (on) t.tabEl.setAttribute('data-active', ''); else t.tabEl.removeAttribute('data-active');
      if (on) { try { t.fit.fit(); } catch (e) {} sendResize(t); t.term.focus(); if (t.status === 'needsyou') setStatus(t, 'idle'); }
    });
    reflect(p);
    updateFindCount(p);
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
    try { t.ws.close(); } catch (e) {}
    try { t.term.dispose(); } catch (e) {}
    t.host.remove(); t.tabEl.remove();
    p.terms.splice(idx, 1);
    if (p.terms.length === 0) {
      if (panes.length > 1) { closePane(p); return; }
      newTerm(p, startShell()); updateChrome(); return;
    }
    if (p.activeTermId === termId) activateTerm(p, p.terms[Math.max(0, idx - 1)].id);
    updateChrome();
  }

  function setStatus(t, s) {
    if (t.status === s) return;
    t.status = s;
    if (t.dotEl) t.dotEl.style.background = STATUS_COLOR[s] || 'transparent';
    renderSidebar();
  }
  function markWorking(t) {
    if (t.status !== 'needsyou') setStatus(t, 'working');
    clearTimeout(t.busyTimer);
    t.busyTimer = setTimeout(function () { if (t.status === 'working') setStatus(t, 'idle'); }, 1200);
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
      focusPane(p.id);
      if (S.rightClickPaste) { pasteInto(t); return; }
      showTermMenu(p, t, e.clientX, e.clientY);
    });
    host.addEventListener('wheel', function (e) { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); setFontSize(S.fontSize + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });

    var tabEl = document.createElement('div');
    tabEl.className = 'ptab';
    tabEl.innerHTML = '<span class="tfav"><span class="fav fav-t">&gt;_</span></span>' +
      '<span class="tdot" style="width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:transparent"></span>' +
      '<span class="tt">' + esc(labelFor(shellKey)) + '</span><span class="x" title="Close tab (Alt+W)">×</span>';
    p.tabscroll.appendChild(tabEl);
    var ttEl = tabEl.querySelector('.tt');

    var q = '/pty?shell=' + encodeURIComponent(shellKey);
    var startIn = cwd || S.startFolder;
    if (startIn) q += '&cwd=' + encodeURIComponent(startIn);
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws = new WebSocket(proto + '//' + location.host + q);
    ws.binaryType = 'arraybuffer';

    var t = {
      id: id, paneId: p.id, term: term, fit: fit, search: search, ws: ws, host: host,
      tabEl: tabEl, dotEl: tabEl.querySelector('.tdot'), state: 'idle', status: 'idle',
      cwd: null, shell: shellKey, renamed: false, results: null, busyTimer: null,
    };

    ws.onopen = function () { t.state = 'open'; if (p.activeTermId === id) reflect(p); sendResize(t); };
    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'meta') {
          if (m.error) {
            term.write('\r\n\x1b[31m' + m.error + '\x1b[0m\r\n');
            t.state = 'closed'; setStatus(t, 'closed');
            if (p.activeTermId === id) reflect(p);
          } else {
            if (m.shell && ttEl && !t.renamed) ttEl.textContent = m.shell;
            if (m.cwd) { t.cwd = m.cwd; if (!dockPath.value) dockPath.value = m.cwd; }
            renderSidebar();
          }
        }
        return;
      }
      term.write(new Uint8Array(ev.data));
      markWorking(t);
    };
    ws.onclose = function () {
      t.state = 'closed'; setStatus(t, 'closed');
      if (p.activeTermId === id) reflect(p);
      term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n');
      notify('Session ended', ttEl.textContent, id);
    };
    ws.onerror = function () { t.state = 'closed'; setStatus(t, 'closed'); if (p.activeTermId === id) reflect(p); };
    term.onData(function (d) {
      if (broadcastOn) {
        allTerms().forEach(function (x) { if (x.ws.readyState === WebSocket.OPEN) x.ws.send(JSON.stringify({ t: 'i', d: d })); });
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d: d }));
    });
    // A real terminal bell (\a) from the shell = this terminal wants attention.
    try {
      term.onBell(function () {
        var focused = (p.id === activePaneId && p.activeTermId === id && document.hasFocus());
        // Every bell is logged so the notification centre is a real record; only an
        // unfocused terminal is escalated to "needs you" in the sidebar.
        if (!focused) setStatus(t, 'needsyou');
        notify(focused ? 'Terminal bell' : 'Terminal needs attention', ttEl.textContent, id);
      });
    } catch (e) {}
    try {
      search.onDidChangeResults(function (r) {
        t.results = r ? { index: r.resultIndex, count: r.resultCount } : null;
        if (p.activeTermId === id) updateFindCount(p);
      });
    } catch (e) {}
    if (term.textarea) {
      term.textarea.addEventListener('focus', function () { focusPane(p.id); });
      // Copy-on-select is a real preference, applied on mouse-up inside the terminal.
      host.addEventListener('mouseup', function () { if (S.copyOnSelect) copySel(t); });
    }

    tabEl.addEventListener('click', function (e) {
      focusPane(p.id);
      if (e.target && e.target.classList.contains('x')) { e.stopPropagation(); askCloseTerm(p, id); }
      else activateTerm(p, id);
    });
    tabEl.addEventListener('mousedown', function (e) { if (e.button === 1) { e.preventDefault(); askCloseTerm(p, id); } });
    tabEl.addEventListener('dblclick', function (e) {
      if (e.target && e.target.classList.contains('x')) return;
      e.preventDefault(); e.stopPropagation();
      focusPane(p.id); activateTerm(p, id); startRename(t);
    });

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
    p.terms.forEach(function (t) { try { t.ws.close(); } catch (e) {} try { t.term.dispose(); } catch (e) {} });
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

  function makePane(col, afterPane) {
    var id = ++paneSeq;
    var el = document.createElement('div');
    el.className = 'pane';
    el.style.flex = '1 1 0';
    el.innerHTML =
      '<div class="ptabs">' +
        '<div class="pctrls"><span class="pc pc-rail" title="Toggle left sidebar (Ctrl+B)" role="button">' + RAIL_SVG + '</span></div>' +
        '<div class="tabscroll"></div>' +
        '<div class="connpill" data-state="idle"><span class="dot"></span><span class="conntext">connecting…</span></div>' +
        '<div class="pctrls">' +
          '<span class="pgroup"><span class="pc pc-new" title="New tab (Alt+T)" role="button">' + NEW_SVG + '</span>' +
          '<span class="pc pcaret pc-newmenu" title="New tab type…" role="button">' + CARET_SVG + '</span></span>' +
          '<span class="pc pc-find" title="Find (Ctrl+F)" role="button">' + FIND_SVG + '</span>' +
          '<span class="pgroup"><span class="pc pc-split" title="Split right (Ctrl+D)" role="button">' + SPLIT_SVG + '</span>' +
          '<span class="pc pcaret pc-splitmenu" title="Split…" role="button">' + CARET_SVG + '</span></span>' +
          '<span class="pc pc-zoom" title="Zoom pane (Ctrl+Shift+Enter)" role="button" style="display:none">' + ZOOM_SVG + '</span>' +
          '<span class="pc pc-close" title="Close pane (Alt+Shift+W)" role="button" style="display:none">' + CLOSE_SVG + '</span>' +
          '<span class="pc pc-dock" title="Toggle changes panel" role="button">' + DOCK_SVG + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="pbody"><div class="term-area"></div>' +
        '<div class="findbar">' +
          '<input type="text" placeholder="Find" spellcheck="false" />' +
          '<span class="fb-count"></span>' +
          '<div class="fb-btn fb-prev" title="Previous (Shift+Enter)">' + UP_SVG + '</div>' +
          '<div class="fb-btn fb-next" title="Next (Enter)">' + DOWN_SVG + '</div>' +
          '<div class="fb-btn fb-close" title="Close (Esc)">' + CLOSE_SVG + '</div>' +
        '</div>' +
      '</div>';

    if (afterPane) {
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
      terms: [], activeTermId: null,
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

    panes.push(p);
    updateChrome();
    return p;
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
    panes.forEach(function (p) { p.terms.forEach(function (t) { try { t.ws.close(); } catch (e) {} try { t.term.dispose(); } catch (e) {} }); });
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
  function saveLayoutDialog() {
    var body = document.getElementById('dlg-body');
    var def = 'Layout ' + (layouts().length + 1);
    body.innerHTML = '<h3>Save layout</h3><p>Stores the current panes, tabs, shells and folders so you can bring them back.</p>' +
      '<input class="din" id="dlg-name" value="' + esc(def) + '" spellcheck="false">' +
      '<div class="drow"><span class="btn" data-cancel>Cancel</span><span class="btn primary" data-ok>Save</span></div>';
    openOvl('dlg-ovl');
    var input = document.getElementById('dlg-name');
    input.focus(); input.select();
    input.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') doSave(); });
    body.querySelector('[data-cancel]').addEventListener('click', function () { closeOvl('dlg-ovl'); });
    body.querySelector('[data-ok]').addEventListener('click', doSave);
    function doSave() {
      var name = (input.value || def).trim();
      var list = layouts().filter(function (l) { return l.name !== name; });
      list.unshift({ name: name, when: Date.now(), desc: snapshot() });
      try { localStorage.setItem('ct-layouts', JSON.stringify(list.slice(0, 20))); } catch (e) {}
      closeOvl('dlg-ovl');
      notify('Layout saved', name);
    }
  }
  function loadLayoutDialog() {
    var list = layouts();
    var body = document.getElementById('dlg-body');
    var rows = list.length
      ? '<div class="llist">' + list.map(function (l, i) {
          var n = l.desc.cols.reduce(function (a, c) { return a + c.reduce(function (b, p) { return b + p.tabs.length; }, 0); }, 0);
          return '<div class="lrow" data-i="' + i + '"><span>' + esc(l.name) + '</span><span class="lsub">' + n + ' tabs · ' + ago(l.when) + '</span><span class="ldel" data-del="' + i + '" title="Delete">×</span></div>';
        }).join('') + '</div>'
      : '<p style="margin-top:10px">No saved layouts yet — use Save layout (Ctrl+Alt+S) first.</p>';
    body.innerHTML = '<h3>Load layout</h3><p>Rebuilds the panes and tabs. Terminals running now will be closed.</p>' + rows +
      '<div class="drow"><span class="btn" data-cancel>Cancel</span></div>';
    openOvl('dlg-ovl');
    body.querySelector('[data-cancel]').addEventListener('click', function () { closeOvl('dlg-ovl'); });
    body.addEventListener('click', function (e) {
      var del = e.target.closest ? e.target.closest('[data-del]') : null;
      if (del) {
        e.stopPropagation();
        var li = layouts(); li.splice(parseInt(del.getAttribute('data-del'), 10), 1);
        try { localStorage.setItem('ct-layouts', JSON.stringify(li)); } catch (er) {}
        loadLayoutDialog();
        return;
      }
      var row = e.target.closest ? e.target.closest('[data-i]') : null;
      if (!row) return;
      var l = layouts()[parseInt(row.getAttribute('data-i'), 10)];
      closeOvl('dlg-ovl');
      if (l) restoreLayout(l.desc);
    });
  }

  // ------------------------------------------------------------- settings UI
  var SETTABS = ['Appearance', 'Terminal', 'Behaviour', 'Shortcuts', 'About'];
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
    if (t === 'Shortcuts') {
      return KEYS.map(function (k) { return frow(k[0], '', '<span class="kbd">' + k[1] + '</span>'); }).join('') +
        '<div style="margin-top:14px"><span class="btn" data-act="cheat">Open the full list (F1)</span></div>';
    }
    return '<div style="font-size:13px;margin-bottom:6px">cockpit-terminal v1.0</div>' +
      '<div style="font-size:12.5px;color:var(--muted);line-height:1.6;margin-bottom:14px">Runs real shells on this machine and is bound to 127.0.0.1 only — it is deliberately not reachable from the network.</div>' +
      '<div><span class="btn" data-act="diag">Diagnostics</span> <span class="btn" data-act="reset">Reset settings</span></div>';
  }
  function renderSettings() {
    document.getElementById('settings-tabs').innerHTML = SETTABS.map(function (t) {
      return '<div class="mtab" data-settab="' + t + '"' + (t === curSet ? ' data-active' : '') + '>' + t + '</div>';
    }).join('');
    document.getElementById('settings-pane').innerHTML = '<h3>' + curSet + '</h3>' + settingsPane(curSet);
  }
  function openSettings(tab) { curSet = tab || curSet; renderSettings(); openOvl('settings-ovl'); }
  document.getElementById('settings-tabs').addEventListener('click', function (e) {
    var tab = e.target.closest ? e.target.closest('[data-settab]') : null;
    if (tab) { curSet = tab.getAttribute('data-settab'); renderSettings(); }
  });
  document.getElementById('settings-pane').addEventListener('click', function (e) {
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
    ['Split right', 'Ctrl+D'], ['Split down', 'Ctrl+Shift+D'], ['Zoom pane', 'Ctrl+Shift+Enter'],
    ['Close pane', 'Alt+Shift+W'], ['Broadcast input', 'Ctrl+Alt+B'],
    ['Find in terminal', 'Ctrl+F'], ['Copy / Paste', 'Ctrl+Shift+C / V'], ['Font size', 'Ctrl+= / − / 0'],
    ['Toggle sidebar', 'Ctrl+B'], ['Changes panel', 'Ctrl+Alt+D'], ['Notifications', 'Ctrl+Alt+N'],
    ['Command palette', 'Ctrl+Shift+P'], ['Settings', 'Ctrl+,'],
    ['Save layout', 'Ctrl+Alt+S'], ['Load layout', 'Ctrl+Alt+O'], ['Keyboard shortcuts', 'F1'],
  ];
  var CHEAT = {
    Tabs: KEYS.slice(0, 3), Panes: KEYS.slice(3, 8), Terminal: KEYS.slice(8, 11), View: KEYS.slice(11),
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
      { cat: 'Pane', name: 'Split right', kbd: 'Ctrl+D', run: function () { var p = paneById(activePaneId); if (p) splitRight(p, startShell()); } },
      { cat: 'Pane', name: 'Split down', kbd: 'Ctrl+Shift+D', run: function () { var p = paneById(activePaneId); if (p) splitDown(p, startShell()); } },
      { cat: 'Pane', name: 'Zoom pane', kbd: 'Ctrl+Shift+Enter', run: function () { var p = paneById(activePaneId); if (p) toggleZoom(p); } },
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
  document.getElementById('open-save').addEventListener('click', saveLayoutDialog);
  document.getElementById('open-load').addEventListener('click', loadLayoutDialog);
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

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { panes.forEach(fitActive); }, 80);
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

  var first = makePane(makeCol());
  newTerm(first, startShell());
  focusPane(first.id);
})();

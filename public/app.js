// Cockpit terminal — panes + tabs. Each pane holds its own tabbed PowerShell
// terminals; panes sit side by side with a draggable divider (split screen).
(function () {
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
  function currentThemeMode() { return document.documentElement.getAttribute('data-theme') || 'system'; }
  function applyTheme(mode) {
    if (mode === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    try { localStorage.setItem('ct-theme', mode); } catch (e) {}
    var colors = themeColors();
    panes.forEach(function (pp) { pp.terms.forEach(function (t) { try { t.term.options.theme = colors; } catch (e) {} }); });
  }

  var wsrow = document.getElementById('wsrow');
  var countEl = document.getElementById('sx-count');
  var pSub = document.getElementById('p-sub');

  var panes = [];
  var paneSeq = 0;
  var termSeq = 0;
  var activePaneId = null;

  // Shells available on this machine (filled from /shells). Falls back to PowerShell.
  var SHELLS = [{ key: 'powershell', label: 'PowerShell' }];
  var DEFAULT_SHELL = 'powershell';
  function labelFor(key) { for (var i = 0; i < SHELLS.length; i++) if (SHELLS[i].key === key) return SHELLS[i].label; return 'Terminal'; }

  var NEW_SVG = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
  var CARET_SVG = '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
  var FIND_SVG = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
  var SPLIT_SVG = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>';
  var CLOSE_SVG = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var UP_SVG = '<svg viewBox="0 0 24 24"><path d="M18 15l-6-6-6 6"/></svg>';
  var DOWN_SVG = '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';

  // Shell picker dropdown (reuses the mockup's .ofmenu styling).
  var openMenu = null;
  function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; document.removeEventListener('mousedown', onDocDown); } }
  function onDocDown(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
  function showShellMenu(p, anchor) {
    closeMenu();
    var menu = document.createElement('div');
    menu.className = 'ofmenu';
    menu.setAttribute('data-open', '');
    SHELLS.forEach(function (s) {
      var item = document.createElement('div');
      item.className = 'ofmi';
      item.innerHTML = '<span class="tfav"><span class="fav fav-t">&gt;_</span></span><span class="nm">' + s.label + '</span>';
      item.addEventListener('click', function (e) { e.stopPropagation(); focusPane(p.id); newTerm(p, s.key); closeMenu(); });
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    var r = anchor.getBoundingClientRect();
    menu.style.left = Math.min(r.left, window.innerWidth - 250) + 'px';
    menu.style.top = (r.bottom + 4) + 'px';
    openMenu = menu;
    setTimeout(function () { document.addEventListener('mousedown', onDocDown); }, 0);
  }

  function showThemeMenu(anchor) {
    closeMenu();
    var menu = document.createElement('div');
    menu.className = 'ofmenu';
    menu.setAttribute('data-open', '');
    menu.innerHTML = '<div class="ctxlabel">Theme</div>';
    var cur = currentThemeMode();
    [['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']].forEach(function (opt) {
      var item = document.createElement('div');
      item.className = 'ofmi';
      if (opt[0] === cur) item.setAttribute('data-on', '');
      item.innerHTML = '<span class="nm">' + opt[1] + '</span>';
      item.addEventListener('click', function (e) { e.stopPropagation(); applyTheme(opt[0]); closeMenu(); });
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    var r = anchor.getBoundingClientRect();
    menu.style.left = Math.min(r.left, window.innerWidth - 220) + 'px';
    var above = r.top - menu.offsetHeight - 6;
    menu.style.top = (above > 8 ? above : r.bottom + 4) + 'px';
    openMenu = menu;
    setTimeout(function () { document.addEventListener('mousedown', onDocDown); }, 0);
  }

  function totalTerms() { return panes.reduce(function (n, p) { return n + p.terms.length; }, 0); }
  function updateChrome() {
    if (countEl) countEl.textContent = String(totalTerms());
    panes.forEach(function (p) { p.closeBtn.style.display = panes.length > 1 ? 'flex' : 'none'; });
  }
  function activeTermOf(p) { for (var i = 0; i < p.terms.length; i++) if (p.terms[i].id === p.activeTermId) return p.terms[i]; return null; }
  function sendResize(t) { if (t.ws.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify({ t: 'r', c: t.term.cols, r: t.term.rows })); }
  function fitActive(p) { var t = activeTermOf(p); if (t) { try { t.fit.fit(); } catch (e) {} sendResize(t); } }

  function openFind(p) { if (!p.findbar) return; p.findbar.classList.add('on'); p.findInput.focus(); p.findInput.select(); }
  function closeFind(p) { if (!p.findbar) return; p.findbar.classList.remove('on'); var t = activeTermOf(p); if (t) t.term.focus(); }
  function doFind(p, dir, incremental) {
    var t = activeTermOf(p); if (!t) return;
    var q = p.findInput.value; if (!q) return;
    try { if (dir === 'prev') t.search.findPrevious(q, { incremental: !!incremental }); else t.search.findNext(q, { incremental: !!incremental }); } catch (e) {}
  }

  function reflect(p) {
    var t = activeTermOf(p);
    var s = t ? t.state : 'idle';
    p.pill.setAttribute('data-state', s === 'open' ? 'open' : (s === 'closed' ? 'closed' : 'idle'));
    p.connText.textContent = s === 'open' ? 'connected' : (s === 'closed' ? 'disconnected' : 'connecting…');
    if (p.id === activePaneId) pSub.textContent = (t && t.cwd) || 'connecting…';
  }

  function focusPane(id) {
    activePaneId = id;
    panes.forEach(function (p) { if (p.id === id) p.el.classList.add('focused'); else p.el.classList.remove('focused'); });
    var p = paneById(id); if (p) { reflect(p); var t = activeTermOf(p); if (t) t.term.focus(); }
  }
  function paneById(id) { for (var i = 0; i < panes.length; i++) if (panes[i].id === id) return panes[i]; return null; }

  function activateTerm(p, termId) {
    p.activeTermId = termId;
    p.terms.forEach(function (t) {
      var on = t.id === termId;
      t.host.style.display = on ? 'block' : 'none';
      if (on) t.tabEl.setAttribute('data-active', ''); else t.tabEl.removeAttribute('data-active');
      if (on) { try { t.fit.fit(); } catch (e) {} sendResize(t); t.term.focus(); }
    });
    reflect(p);
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
      newTerm(p); updateChrome(); return;
    }
    if (p.activeTermId === termId) activateTerm(p, p.terms[Math.max(0, idx - 1)].id);
    updateChrome();
  }

  function newTerm(p, shellKey) {
    shellKey = shellKey || DEFAULT_SHELL;
    var id = ++termSeq;
    var host = document.createElement('div');
    host.className = 'term-host';
    host.style.display = 'none';
    p.termArea.appendChild(host);

    var term = new Terminal({
      fontFamily: "'Cascadia Code','Cascadia Mono',Consolas,ui-monospace,monospace",
      fontSize: 13, lineHeight: 1.2, cursorBlink: true, scrollback: 5000, theme: themeColors(),
    });
    var fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    var search = new SearchAddon.SearchAddon();
    term.loadAddon(search);
    term.open(host);
    term.attachCustomKeyEventHandler(function (e) {
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) { openFind(p); return false; }
      return true;
    });

    var tabEl = document.createElement('div');
    tabEl.className = 'ptab';
    tabEl.innerHTML = '<span class="tfav"><span class="fav fav-t">&gt;_</span></span><span class="tt">' + labelFor(shellKey) + '</span><span class="x" title="Close tab">×</span>';
    p.tabscroll.appendChild(tabEl);
    var ttEl = tabEl.querySelector('.tt');

    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws = new WebSocket(proto + '//' + location.host + '/pty?shell=' + encodeURIComponent(shellKey));
    ws.binaryType = 'arraybuffer';

    var t = { id: id, paneId: p.id, term: term, fit: fit, search: search, ws: ws, host: host, tabEl: tabEl, state: 'idle', cwd: null };

    ws.onopen = function () { t.state = 'open'; if (p.activeTermId === id) reflect(p); sendResize(t); };
    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'meta') {
          if (m.error) { term.write('\r\n\x1b[31m' + m.error + '\x1b[0m\r\n'); t.state = 'closed'; if (p.activeTermId === id) reflect(p); }
          else {
            if (m.shell && ttEl) ttEl.textContent = m.shell;
            if (m.cwd) { t.cwd = m.cwd; if (p.activeTermId === id && p.id === activePaneId) pSub.textContent = m.cwd; }
          }
        }
        return;
      }
      term.write(new Uint8Array(ev.data));
    };
    ws.onclose = function () { t.state = 'closed'; if (p.activeTermId === id) reflect(p); term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n'); };
    ws.onerror = function () { t.state = 'closed'; if (p.activeTermId === id) reflect(p); };
    term.onData(function (d) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d: d })); });
    term.textarea && term.textarea.addEventListener('focus', function () { focusPane(p.id); });

    tabEl.addEventListener('click', function (e) {
      focusPane(p.id);
      if (e.target && e.target.classList.contains('x')) { e.stopPropagation(); closeTerm(p, id); }
      else activateTerm(p, id);
    });

    p.terms.push(t);
    updateChrome();
    activateTerm(p, id);
    return t;
  }

  function makeDivider() {
    var d = document.createElement('div');
    d.className = 'wsdiv';
    d.addEventListener('mousedown', function (e) {
      e.preventDefault();
      var left = d.previousElementSibling;   // .pane
      var right = d.nextElementSibling;       // .pane
      if (!left || !right) return;
      var startX = e.clientX;
      var lw = left.getBoundingClientRect().width;
      var rw = right.getBoundingClientRect().width;
      d.classList.add('drag');
      document.body.classList.add('col-resizing');
      function move(ev) {
        var dx = ev.clientX - startX;
        var nl = Math.max(160, lw + dx);
        var nr = Math.max(160, rw - dx);
        left.style.flex = nl + ' 1 0';
        right.style.flex = nr + ' 1 0';
      }
      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        d.classList.remove('drag');
        document.body.classList.remove('col-resizing');
        panes.forEach(fitActive);
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    return d;
  }

  function closePane(p) {
    if (panes.length <= 1) return;
    p.terms.forEach(function (t) { try { t.ws.close(); } catch (e) {} try { t.term.dispose(); } catch (e) {} });
    var idx = panes.indexOf(p);
    // remove the divider adjacent to this pane
    var div = p.el.previousElementSibling && p.el.previousElementSibling.classList.contains('wsdiv') ? p.el.previousElementSibling
            : (p.el.nextElementSibling && p.el.nextElementSibling.classList.contains('wsdiv') ? p.el.nextElementSibling : null);
    if (div) div.remove();
    p.el.remove();
    panes.splice(idx, 1);
    panes.forEach(function (pp) { pp.el.style.flex = '1 1 0'; });
    updateChrome();
    focusPane(panes[Math.max(0, idx - 1)].id);
    panes.forEach(fitActive);
  }

  function makePane() {
    var id = ++paneSeq;
    var el = document.createElement('div');
    el.className = 'pane';
    el.style.flex = '1 1 0';
    el.innerHTML =
      '<div class="ptabs">' +
        '<div class="tabscroll"></div>' +
        '<div class="pctrls">' +
          '<div class="pc pc-new" title="New terminal tab" role="button">' + NEW_SVG + '</div>' +
          '<div class="pc pcaret pc-newmenu" title="Choose shell" role="button">' + CARET_SVG + '</div>' +
          '<div class="pc pc-find" title="Find (Ctrl+F)" role="button">' + FIND_SVG + '</div>' +
          '<div class="pc pc-split" title="Split right" role="button">' + SPLIT_SVG + '</div>' +
          '<div class="pc pc-close" title="Close pane" role="button" style="display:none">' + CLOSE_SVG + '</div>' +
        '</div>' +
        '<div class="connpill" data-state="idle"><span class="dot"></span><span class="conntext">connecting…</span></div>' +
      '</div>' +
      '<div class="pbody"><div class="term-area"></div>' +
        '<div class="findbar">' +
          '<input type="text" placeholder="Find" spellcheck="false" />' +
          '<div class="fb-btn fb-prev" title="Previous (Shift+Enter)">' + UP_SVG + '</div>' +
          '<div class="fb-btn fb-next" title="Next (Enter)">' + DOWN_SVG + '</div>' +
          '<div class="fb-btn fb-close" title="Close (Esc)">' + CLOSE_SVG + '</div>' +
        '</div>' +
      '</div>';

    if (panes.length > 0) wsrow.appendChild(makeDivider());
    wsrow.appendChild(el);

    var p = {
      id: id, el: el,
      tabscroll: el.querySelector('.tabscroll'),
      termArea: el.querySelector('.term-area'),
      pill: el.querySelector('.connpill'),
      connText: el.querySelector('.conntext'),
      newBtn: el.querySelector('.pc-new'),
      newMenuBtn: el.querySelector('.pc-newmenu'),
      findBtn: el.querySelector('.pc-find'),
      splitBtn: el.querySelector('.pc-split'),
      closeBtn: el.querySelector('.pc-close'),
      findbar: el.querySelector('.findbar'),
      findInput: el.querySelector('.findbar input'),
      terms: [], activeTermId: null,
    };
    p.newBtn.addEventListener('click', function () { focusPane(p.id); newTerm(p, DEFAULT_SHELL); });
    p.newMenuBtn.addEventListener('click', function (e) { e.stopPropagation(); focusPane(p.id); showShellMenu(p, p.newMenuBtn); });
    p.findBtn.addEventListener('click', function () { focusPane(p.id); openFind(p); });
    p.splitBtn.addEventListener('click', function () { var np = makePane(); newTerm(np, DEFAULT_SHELL); focusPane(np.id); panes.forEach(fitActive); });
    p.closeBtn.addEventListener('click', function () { closePane(p); });
    el.addEventListener('mousedown', function () { focusPane(p.id); });
    p.findInput.addEventListener('input', function () { doFind(p, 'next', true); });
    p.findInput.addEventListener('keydown', function (e) {
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

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { panes.forEach(fitActive); }, 80);
  });

  // Restore saved theme choice (before any terminal is created).
  try { var saved = localStorage.getItem('ct-theme'); if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved); } catch (e) {}
  var settingsBtn = document.getElementById('open-settings');
  if (settingsBtn) settingsBtn.addEventListener('click', function (e) { e.stopPropagation(); showThemeMenu(settingsBtn); });
  if (window.matchMedia) {
    try { window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () { if (currentThemeMode() === 'system') applyTheme('system'); }); } catch (e) {}
  }

  // Load the shells this machine actually has (for the picker menu).
  fetch('/shells').then(function (r) { return r.json(); }).then(function (list) {
    if (Array.isArray(list) && list.length) { SHELLS = list; DEFAULT_SHELL = list[0].key; }
  }).catch(function () {});

  var first = makePane();
  newTerm(first, DEFAULT_SHELL);
  focusPane(first.id);
})();

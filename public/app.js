// Cockpit terminal — panes + tabs. Each pane holds its own tabbed PowerShell
// terminals; panes sit side by side with a draggable divider (split screen).
(function () {
  var isLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  function themeColors() {
    return isLight
      ? { background: '#fbfbfb', foreground: '#232323', cursor: '#8a5cf5', selectionBackground: 'rgba(138,92,245,.25)' }
      : { background: '#1a1a1a', foreground: '#dadada', cursor: '#8a5cf5', selectionBackground: 'rgba(138,92,245,.30)' };
  }

  var wsrow = document.getElementById('wsrow');
  var countEl = document.getElementById('sx-count');
  var pSub = document.getElementById('p-sub');

  var panes = [];
  var paneSeq = 0;
  var termSeq = 0;
  var activePaneId = null;

  var NEW_SVG = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
  var SPLIT_SVG = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>';
  var CLOSE_SVG = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  function totalTerms() { return panes.reduce(function (n, p) { return n + p.terms.length; }, 0); }
  function updateChrome() {
    if (countEl) countEl.textContent = String(totalTerms());
    panes.forEach(function (p) { p.closeBtn.style.display = panes.length > 1 ? 'flex' : 'none'; });
  }
  function activeTermOf(p) { for (var i = 0; i < p.terms.length; i++) if (p.terms[i].id === p.activeTermId) return p.terms[i]; return null; }
  function sendResize(t) { if (t.ws.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify({ t: 'r', c: t.term.cols, r: t.term.rows })); }
  function fitActive(p) { var t = activeTermOf(p); if (t) { try { t.fit.fit(); } catch (e) {} sendResize(t); } }

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

  function newTerm(p) {
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
    term.open(host);

    var tabEl = document.createElement('div');
    tabEl.className = 'ptab';
    tabEl.innerHTML = '<span class="tfav"><span class="fav fav-t">&gt;_</span></span><span class="tt">PowerShell</span><span class="x" title="Close tab">×</span>';
    p.tabscroll.appendChild(tabEl);

    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws = new WebSocket(proto + '//' + location.host + '/pty');
    ws.binaryType = 'arraybuffer';

    var t = { id: id, paneId: p.id, term: term, fit: fit, ws: ws, host: host, tabEl: tabEl, state: 'idle', cwd: null };

    ws.onopen = function () { t.state = 'open'; if (p.activeTermId === id) reflect(p); sendResize(t); };
    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'meta') {
          if (m.error) { term.write('\r\n\x1b[31m' + m.error + '\x1b[0m\r\n'); t.state = 'closed'; if (p.activeTermId === id) reflect(p); }
          else if (m.cwd) { t.cwd = m.cwd; if (p.activeTermId === id && p.id === activePaneId) pSub.textContent = m.cwd; }
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
          '<div class="pc pc-new" title="New PowerShell tab" role="button">' + NEW_SVG + '</div>' +
          '<div class="pc pc-split" title="Split right" role="button">' + SPLIT_SVG + '</div>' +
          '<div class="pc pc-close" title="Close pane" role="button" style="display:none">' + CLOSE_SVG + '</div>' +
        '</div>' +
        '<div class="connpill" data-state="idle"><span class="dot"></span><span class="conntext">connecting…</span></div>' +
      '</div>' +
      '<div class="pbody"><div class="term-area"></div></div>';

    if (panes.length > 0) wsrow.appendChild(makeDivider());
    wsrow.appendChild(el);

    var p = {
      id: id, el: el,
      tabscroll: el.querySelector('.tabscroll'),
      termArea: el.querySelector('.term-area'),
      pill: el.querySelector('.connpill'),
      connText: el.querySelector('.conntext'),
      newBtn: el.querySelector('.pc-new'),
      splitBtn: el.querySelector('.pc-split'),
      closeBtn: el.querySelector('.pc-close'),
      terms: [], activeTermId: null,
    };
    p.newBtn.addEventListener('click', function () { focusPane(p.id); newTerm(p); });
    p.splitBtn.addEventListener('click', function () { var np = makePane(); newTerm(np); focusPane(np.id); panes.forEach(fitActive); });
    p.closeBtn.addEventListener('click', function () { closePane(p); });
    el.addEventListener('mousedown', function () { focusPane(p.id); });

    panes.push(p);
    updateChrome();
    return p;
  }

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { panes.forEach(fitActive); }, 80);
  });

  var first = makePane();
  newTerm(first);
  focusPane(first.id);
})();

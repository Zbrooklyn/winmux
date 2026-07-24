// Multi-tab terminal manager: each tab is its own real PowerShell (its own
// websocket + xterm), wired to the PowerShell bridge in server.cjs.
(function () {
  var isLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  function themeColors() {
    return isLight
      ? { background: '#fbfbfb', foreground: '#232323', cursor: '#8a5cf5', selectionBackground: 'rgba(138,92,245,.25)' }
      : { background: '#1a1a1a', foreground: '#dadada', cursor: '#8a5cf5', selectionBackground: 'rgba(138,92,245,.30)' };
  }

  var tabscroll = document.getElementById('tabscroll');
  var termArea = document.getElementById('term-area');
  var pill = document.getElementById('connpill');
  var connText = document.getElementById('conntext');
  var pSub = document.getElementById('p-sub');
  var count = document.getElementById('sx-count');

  var tabs = [];
  var seq = 0;
  var activeId = null;

  function reflect(t) {
    var s = t.state;
    pill.setAttribute('data-state', s === 'open' ? 'open' : (s === 'closed' ? 'closed' : 'idle'));
    connText.textContent = s === 'open' ? 'connected' : (s === 'closed' ? 'disconnected' : 'connecting…');
    pSub.textContent = t.cwd || 'connecting…';
  }
  function sendResize(t) {
    if (t.ws.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify({ t: 'r', c: t.term.cols, r: t.term.rows }));
  }
  function updateCount() { if (count) count.textContent = String(tabs.length); }

  function activate(id) {
    activeId = id;
    tabs.forEach(function (t) {
      var on = t.id === id;
      t.host.style.display = on ? 'block' : 'none';
      if (on) t.tabEl.setAttribute('data-active', ''); else t.tabEl.removeAttribute('data-active');
      if (on) { t.fit.fit(); sendResize(t); t.term.focus(); reflect(t); }
    });
  }

  function closeTab(id) {
    var idx = -1;
    for (var i = 0; i < tabs.length; i++) if (tabs[i].id === id) { idx = i; break; }
    if (idx < 0) return;
    var t = tabs[idx];
    try { t.ws.close(); } catch (e) {}
    try { t.term.dispose(); } catch (e) {}
    t.host.remove();
    t.tabEl.remove();
    tabs.splice(idx, 1);
    updateCount();
    if (tabs.length === 0) { newTab(); return; }
    if (activeId === id) activate(tabs[Math.max(0, idx - 1)].id);
  }

  function newTab() {
    var id = ++seq;

    var host = document.createElement('div');
    host.className = 'term-host';
    host.style.display = 'none';
    termArea.appendChild(host);

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
    tabscroll.appendChild(tabEl);

    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws = new WebSocket(proto + '//' + location.host + '/pty');
    ws.binaryType = 'arraybuffer';

    var t = { id: id, term: term, fit: fit, ws: ws, host: host, tabEl: tabEl, state: 'idle', cwd: null };

    ws.onopen = function () { t.state = 'open'; if (activeId === id) reflect(t); sendResize(t); };
    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'meta') {
          if (m.error) { term.write('\r\n\x1b[31m' + m.error + '\x1b[0m\r\n'); t.state = 'closed'; if (activeId === id) reflect(t); }
          else if (m.cwd) { t.cwd = m.cwd; if (activeId === id) pSub.textContent = m.cwd; }
        }
        return;
      }
      term.write(new Uint8Array(ev.data));
    };
    ws.onclose = function () { t.state = 'closed'; if (activeId === id) reflect(t); term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n'); };
    ws.onerror = function () { t.state = 'closed'; if (activeId === id) reflect(t); };

    term.onData(function (d) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d: d })); });

    tabEl.addEventListener('click', function (e) {
      if (e.target && e.target.classList.contains('x')) { e.stopPropagation(); closeTab(id); }
      else activate(id);
    });

    tabs.push(t);
    updateCount();
    activate(id);
    return t;
  }

  document.getElementById('new-term').addEventListener('click', function () { newTab(); });

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      var t = null;
      for (var i = 0; i < tabs.length; i++) if (tabs[i].id === activeId) { t = tabs[i]; break; }
      if (t) { t.fit.fit(); sendResize(t); }
    }, 80);
  });

  newTab();
})();

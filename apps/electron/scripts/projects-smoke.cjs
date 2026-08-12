// Round-trips the /api/project(s) endpoints against a running WinMux server:
// save a fake workspace → read it back → confirm it is on disk and in recents →
// forget it. Assumes a server is already listening on WINMUX_PORT (default 8791).
// Boot the server with an isolated WINMUX_CONFIG_FILE + WINMUX_PROJECTS_DIR so this
// never touches the real ~/.winmux or Documents\WinMux Projects.
const http = require('http');
const fs = require('fs');
const port = process.env.WINMUX_PORT || 8791;

function req(method, pathname, body) {
  return new Promise((ok, no) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { 'content-type': 'application/json' } }, (s) => {
      let b = ''; s.on('data', (d) => (b += d)); s.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} ok({ code: s.statusCode, json: j }); });
    });
    r.on('error', no);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

(async () => {
  const layout = { v: 4, cols: [[{ active: 0, tabs: [
    { type: 'terminal', shell: 'pwsh', cwd: 'C:/tmp', group: 'Smoke' },
    { type: 'terminal', shell: 'pwsh', cwd: 'C:/tmp2', group: 'Smoke' },
  ] }]], group: 'Smoke' };

  const saved = await req('POST', '/api/project', { name: 'Smoke Test', layout });
  if (!saved.json || !saved.json.path) throw new Error('POST failed: ' + JSON.stringify(saved));
  if (!fs.existsSync(saved.json.path)) throw new Error('file not on disk: ' + saved.json.path);
  const onDisk = JSON.parse(fs.readFileSync(saved.json.path, 'utf8'));
  if (onDisk.winmuxProject !== 1) throw new Error('missing winmuxProject marker');
  if (onDisk.name !== 'Smoke Test') throw new Error('name not persisted');

  const got = await req('GET', '/api/project?path=' + encodeURIComponent(saved.json.path));
  if (!got.json || got.json.layout.group !== 'Smoke') throw new Error('GET roundtrip mismatch: ' + JSON.stringify(got));

  const listed = await req('GET', '/api/projects');
  const rec = (listed.json.recents || []).find((r) => r.path === saved.json.path);
  if (!rec) throw new Error('not in recents');
  if (rec.tabs !== 2) throw new Error('recents tab count wrong: ' + rec.tabs);

  const del = await req('DELETE', '/api/project?trash=1&path=' + encodeURIComponent(saved.json.path));
  if (!del.json || !del.json.ok) throw new Error('DELETE failed: ' + JSON.stringify(del));
  if (fs.existsSync(saved.json.path)) throw new Error('trash:true did not unlink');
  const after = await req('GET', '/api/projects');
  if ((after.json.recents || []).some((r) => r.path === saved.json.path)) throw new Error('still in recents after delete');

  console.log('projects-smoke OK — save→read→list(tabs=2)→forget →', saved.json.path);
})().catch((e) => { console.error('projects-smoke FAIL:', e.message); process.exit(1); });

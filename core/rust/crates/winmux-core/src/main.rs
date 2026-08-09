// WinMux v2 native core — Stage 1 skeleton + Stage 2 parity (control + session survival).
//
// Serves the SAME public/ frontend the Node core serves and speaks its protocols:
//   /pty  WebSocket — ?shell=&cwd=&sid=; client {t:i|r|x}, server raw bytes + {type:meta}.
//         Shells OUTLIVE their socket: a registry keeps the PTY + scrollback alive for a
//         grace window; reconnecting with ?sid= reattaches (meta.resumed) and replays the
//         backlog; a stale sid yields a fresh session (meta.lost).
//   /control WebSocket — the app registers here; server pushes {rpc,cmd,args}, app
//            replies {rpc,ok,result|error} (the winmux CLI ↔ app control loop).
//   POST /rpc — {cmd,args}; forwarded to the most-recent /control client, reply relayed.
//   GET /api/info — read-only server + fleet snapshot the `winmux status` verb reads.

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{Read, Write},
    net::SocketAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc::UnboundedSender, oneshot};
use tower_http::services::ServeDir;

static SID_COUNTER: AtomicU64 = AtomicU64::new(1);
const SCROLLBACK_CAP: usize = 256 * 1024; // bytes of backlog replayed on reattach
const GRACE: Duration = Duration::from_secs(30); // a detached shell survives this long

// A live terminal that outlives any single socket. The reader thread runs for the
// session's whole life, appending to `scrollback` and forwarding to the attached sink.
struct Session {
    shell: String,
    cwd: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    inner: Mutex<SinkState>,
    detach_epoch: AtomicU64, // bumped on every attach/detach; the grace task checks it
}
struct SinkState {
    scrollback: VecDeque<u8>,
    attached: Option<UnboundedSender<Vec<u8>>>,
}

struct AppState {
    controllers: Mutex<HashMap<u64, UnboundedSender<Message>>>,
    control_seq: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    rpc_seq: AtomicU64,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    port: u16,
}
impl AppState {
    fn new(port: u16) -> Self {
        Self {
            controllers: Mutex::new(HashMap::new()),
            control_seq: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            rpc_seq: AtomicU64::new(1),
            sessions: Mutex::new(HashMap::new()),
            port,
        }
    }
    fn pick_controller(&self) -> Option<UnboundedSender<Message>> {
        let map = self.controllers.lock().unwrap();
        map.iter().max_by_key(|(id, _)| **id).map(|(_, s)| s.clone())
    }
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn new_sid() -> String {
    let n = SID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:x}{:x}", now_ms(), n)
}

fn shell_cmd(key: &str) -> (String, Vec<String>, String) {
    match key {
        "pwsh" => ("pwsh.exe".into(), vec!["-NoLogo".into()], "PowerShell 7".into()),
        "cmd" => ("cmd.exe".into(), vec![], "Command Prompt".into()),
        "bash" => ("bash.exe".into(), vec!["-l".into(), "-i".into()], "Git Bash".into()),
        "wsl" => ("wsl.exe".into(), vec![], "WSL".into()),
        _ => ("powershell.exe".into(), vec!["-NoLogo".into()], "Windows PowerShell".into()),
    }
}

fn resolve_public_dir() -> PathBuf {
    if let Ok(p) = std::env::var("WINMUX_PUBLIC") {
        return PathBuf::from(p);
    }
    for cand in ["../../apps/electron/public", "../apps/electron/public", "apps/electron/public", "public"] {
        let p = PathBuf::from(cand);
        if p.join("index.html").exists() {
            return p.canonicalize().unwrap_or(p);
        }
    }
    PathBuf::from("../../apps/electron/public")
}

fn write_instance(port: u16) {
    let file = std::env::var("WINMUX_INSTANCE_FILE").map(PathBuf::from).unwrap_or_else(|_| {
        let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join(".winmux").join("instance.json")
    });
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let body = json!({"port": port, "host": "127.0.0.1", "pid": std::process::id(), "started": now_ms() as u64});
    let _ = std::fs::write(&file, body.to_string());
}

#[tokio::main]
async fn main() {
    let public = resolve_public_dir();
    let want: u16 = std::env::var("WINMUX_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(9920);

    // Bind the first free port at/after the requested one instead of crashing on a
    // busy port (mirrors the Node server's pickPort). Tailscale-collision avoidance
    // is deferred — this is the universal "port in use, try the next" fallback.
    let mut listener = None;
    let mut port = want;
    for p in want..want.saturating_add(10) {
        match tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], p))).await {
            Ok(l) => { listener = Some(l); port = p; break; }
            Err(_) => { if p != want { continue; } eprintln!("winmux-core: port {p} busy, trying the next"); }
        }
    }
    let listener = listener.unwrap_or_else(|| { eprintln!("winmux-core: no free port in {want}..{}", want + 10); std::process::exit(1); });

    let state = Arc::new(AppState::new(port));
    let shutdown_state = state.clone();
    let serve = ServeDir::new(&public).append_index_html_on_directories(true);
    let app = Router::new()
        .route("/pty", get(pty_ws))
        .route("/control", get(control_ws))
        .route("/rpc", post(rpc_post))
        .route("/api/info", get(api_info))
        .route("/api/md", get(api_md))
        .route("/api/findpath", get(api_findpath))
        .fallback_service(serve)
        .with_state(state);

    // Graceful shutdown: on Ctrl+C, kill every live shell so we never leak a
    // detached PowerShell after the core exits (mirrors the Node server's teardown).
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        for (_, s) in shutdown_state.sessions.lock().unwrap().drain() {
            let _ = s.child.lock().unwrap().kill();
        }
        std::process::exit(0);
    });

    write_instance(port);
    println!("winmux-core: serving {} on http://127.0.0.1:{port}  (control+rpc+resume live)", public.display());
    axum::serve(listener, app).await.expect("serve");
}

// ---- /pty ---------------------------------------------------------------

async fn pty_ws(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_pty(socket, state, q))
}

// Spawn a brand-new shell as a registry Session with a lifelong reader thread.
fn spawn_session(shell_key: &str, cwd: &str) -> Result<(String, Arc<Session>), String> {
    let (exec, args, label) = shell_cmd(shell_key);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(&exec);
    for a in &args { cmd.arg(a); }
    cmd.cwd(cwd);
    // Clean top-level session: scrub NO_COLOR + CLAUDE_CODE_* (mirrors the Node fix).
    cmd.env_clear();
    for (k, v) in std::env::vars() {
        if k == "NO_COLOR" || k == "CLAUDECODE" || k == "CLAUDE_PID" || k.starts_with("CLAUDE_CODE_") { continue; }
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("Failed to start {label}: {e}"))?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| format!("reader: {e}"))?;
    let writer = pair.master.take_writer().map_err(|e| format!("writer: {e}"))?;

    let sid = new_sid();
    // set WINMUX_SID after spawn is impossible; it was scrubbed-in above via env for children.
    let session = Arc::new(Session {
        shell: label,
        cwd: cwd.to_string(),
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        inner: Mutex::new(SinkState { scrollback: VecDeque::new(), attached: None }),
        detach_epoch: AtomicU64::new(0),
    });

    // Lifelong reader: appends to scrollback and pushes to whoever is attached now.
    let sref = session.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let bytes = buf[..n].to_vec();
                    let mut inner = sref.inner.lock().unwrap();
                    for &b in &bytes { inner.scrollback.push_back(b); }
                    while inner.scrollback.len() > SCROLLBACK_CAP { inner.scrollback.pop_front(); }
                    if let Some(tx) = &inner.attached { let _ = tx.send(bytes); }
                }
            }
        }
    });
    Ok((sid, session))
}

async fn handle_pty(socket: WebSocket, state: Arc<AppState>, q: HashMap<String, String>) {
    let want_sid = q.get("sid").cloned().filter(|s| !s.is_empty());
    let shell_key = q.get("shell").map(|s| s.as_str()).unwrap_or("powershell").to_string();
    let cwd = q.get("cwd").cloned().filter(|c| !c.is_empty())
        .unwrap_or_else(|| std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into()));

    // Reattach to a live session, or spawn a fresh one.
    let existing = want_sid.as_ref().and_then(|s| state.sessions.lock().unwrap().get(s).cloned());
    let (sid, session, resumed) = match existing {
        Some(s) => (want_sid.clone().unwrap(), s, true),
        None => match spawn_session(&shell_key, &cwd) {
            Ok((sid, s)) => {
                state.sessions.lock().unwrap().insert(sid.clone(), s.clone());
                (sid, s, false)
            }
            Err(e) => { let _ = send_meta_err(socket, &e).await; return; }
        },
    };

    let (mut sink, mut stream) = socket.split();
    let meta = json!({
        "type":"meta","sid":sid,"shell":session.shell,"cwd":session.cwd,
        "resumed":resumed,"lost": want_sid.is_some() && !resumed,
    }).to_string();
    if sink.send(Message::Text(meta)).await.is_err() { return; }

    // Attach this socket: replay backlog then become the live sink, atomically under the
    // inner lock so the reader can't interleave bytes between snapshot and attach.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    {
        let mut inner = session.inner.lock().unwrap();
        if resumed && !inner.scrollback.is_empty() {
            let snapshot: Vec<u8> = inner.scrollback.iter().copied().collect();
            let _ = tx.send(snapshot);
        }
        inner.attached = Some(tx);
    }
    session.detach_epoch.fetch_add(1, Ordering::Relaxed);

    let out = tokio::spawn(async move {
        while let Some(bytes) = rx.recv().await {
            if sink.send(Message::Binary(bytes)).await.is_err() { break; }
        }
    });

    let mut explicit_kill = false;
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(t) => {
                let v: Value = match serde_json::from_str(&t) { Ok(v) => v, Err(_) => continue };
                match v.get("t").and_then(|x| x.as_str()) {
                    Some("i") => {
                        if let Some(d) = v.get("d").and_then(|x| x.as_str()) {
                            let mut w = session.writer.lock().unwrap();
                            let _ = w.write_all(d.as_bytes());
                            let _ = w.flush();
                        }
                    }
                    Some("r") => {
                        let cols = v.get("c").and_then(|x| x.as_u64()).unwrap_or(80) as u16;
                        let rows = v.get("r").and_then(|x| x.as_u64()).unwrap_or(24) as u16;
                        let _ = session.master.lock().unwrap().resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
                    }
                    Some("x") => { explicit_kill = true; break; }
                    _ => {}
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    out.abort();

    // Detach. On explicit kill, tear the session down now. Otherwise keep it alive for
    // the grace window and let a delayed task reap it if nobody reattaches.
    {
        let mut inner = session.inner.lock().unwrap();
        inner.attached = None;
    }
    let epoch = session.detach_epoch.fetch_add(1, Ordering::Relaxed) + 1;

    if explicit_kill {
        let _ = session.child.lock().unwrap().kill();
        state.sessions.lock().unwrap().remove(&sid);
        return;
    }
    let state2 = state.clone();
    let session2 = session.clone();
    tokio::spawn(async move {
        tokio::time::sleep(GRACE).await;
        // Reaped only if no attach/detach happened since (epoch unchanged) and still detached.
        if session2.detach_epoch.load(Ordering::Relaxed) == epoch
            && session2.inner.lock().unwrap().attached.is_none()
        {
            let _ = session2.child.lock().unwrap().kill();
            state2.sessions.lock().unwrap().remove(&sid);
        }
    });
}

async fn send_meta_err(socket: WebSocket, err: &str) -> Result<(), axum::Error> {
    let mut socket = socket;
    socket.send(Message::Text(json!({"type":"meta","error": err}).to_string())).await
}

// ---- /api/info ----------------------------------------------------------
// Read-only server + fleet snapshot the `winmux status` verb reads (no control
// client needed). sessions = live registry size; detached = shells with no socket.
async fn api_info(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let (total, detached) = {
        let map = state.sessions.lock().unwrap();
        let d = map.values().filter(|s| s.inner.lock().unwrap().attached.is_none()).count();
        (map.len(), d)
    };
    Json(json!({
        "host": "127.0.0.1",
        "port": state.port,
        "pid": std::process::id(),
        "sessions": total,
        "detached": detached,
        "phone": "off",
        "shells": ["powershell", "pwsh", "cmd", "bash", "wsl"],
        "core": "rust",
    }))
}

// ---- /api/md ------------------------------------------------------------
// The markdown viewer reads a file off this disk and gets back its text + mtime,
// so the surface can render it and re-poll to live-update on save. Desk-door only
// (the Rust core binds loopback for now; a networked build must 403 this).
async fn api_md(Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    let file = q.get("path").cloned().unwrap_or_default();
    match (std::fs::metadata(&file), std::fs::read_to_string(&file)) {
        (Ok(st), Ok(text)) => {
            let mtime = st.modified().ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64).unwrap_or(0);
            Json(json!({"ok": true, "path": file, "text": text, "mtime": mtime}))
        }
        _ => Json(json!({"ok": false, "error": "cannot read", "path": file})),
    }
}

// ---- /api/findpath ------------------------------------------------------
// Dropping a folder from Explorer hands the browser only the folder name + its
// child names, never the path. The server stands on the same disk, so it BFS-walks
// a few likely roots to find the folder whose name and contents match, scoring by
// how many dropped children are present. Desk-door only (see /api/md note).
const FIND_DEPTH: usize = 6;
const FIND_BUDGET: usize = 12_000;
const FIND_MS: u128 = 4000;

fn find_skip(name: &str) -> bool {
    matches!(name,
        "node_modules" | ".git" | "appdata" | "windows" | "program files" | "program files (x86)"
        | "programdata" | "$recycle.bin" | "system volume information" | ".cache" | "__pycache__"
        | "venv" | ".venv" | "dist" | "build" | ".next" | "onedrivetemp")
        || name.starts_with('$')
}

fn score_dir(dir: &PathBuf, kids: &HashSet<String>) -> f64 {
    if kids.is_empty() { return 0.5; } // an empty folder can only match by name
    let mut got = 0usize;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            if kids.contains(&e.file_name().to_string_lossy().to_lowercase()) { got += 1; }
        }
    }
    got as f64 / kids.len() as f64
}

fn find_folder(name: &str, kids: &HashSet<String>, near: &str) -> Vec<Value> {
    let want = name.to_lowercase();
    if want.is_empty() { return vec![]; }
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let roots = [near.to_string(), home.clone(), format!("{home}\\Dropbox"), "C:\\dev".into(), "C:\\".into()];
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::new();
    for r in roots.iter().filter(|r| !r.is_empty()) {
        let p = PathBuf::from(r);
        if p.is_dir() { queue.push_back((p, 0)); }
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut hits: Vec<(PathBuf, f64)> = Vec::new();
    let started = Instant::now();
    let mut budget = FIND_BUDGET;

    while let Some((dir, depth)) = queue.pop_front() {
        if budget == 0 || started.elapsed().as_millis() > FIND_MS { break; }
        budget -= 1;
        let key = dir.to_string_lossy().to_lowercase();
        if !seen.insert(key) { continue; }
        let entries = match std::fs::read_dir(&dir) { Ok(e) => e, Err(_) => continue };
        for e in entries.flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
            let low = e.file_name().to_string_lossy().to_lowercase();
            if find_skip(&low) { continue; }
            let full = dir.join(e.file_name());
            if low == want {
                let s = score_dir(&full, kids);
                if s > 0.0 { hits.push((full.clone(), s)); }
                if s >= 1.0 { queue.clear(); break; } // perfect content match — done
            }
            if depth + 1 <= FIND_DEPTH { queue.push_back((full, depth + 1)); }
        }
    }
    hits.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)
        .then(a.0.to_string_lossy().len().cmp(&b.0.to_string_lossy().len())));
    hits.into_iter().take(5).map(|(p, s)| json!({"path": p.to_string_lossy(), "score": s})).collect()
}

async fn api_findpath(Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    let name = q.get("name").cloned().unwrap_or_default();
    let near = q.get("near").cloned().unwrap_or_default();
    let kids: HashSet<String> = q.get("kids").map(|s| s.split('|').filter(|x| !x.is_empty()).map(|x| x.to_lowercase()).collect()).unwrap_or_default();
    let hits = tokio::task::spawn_blocking(move || find_folder(&name, &kids, &near)).await.unwrap_or_default();
    Json(json!({"hits": hits}))
}

// ---- /control + /rpc ----------------------------------------------------

async fn control_ws(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_control(socket, state))
}

async fn handle_control(socket: WebSocket, state: Arc<AppState>) {
    let id = state.control_seq.fetch_add(1, Ordering::Relaxed);
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
    state.controllers.lock().unwrap().insert(id, tx);

    let pump = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() { break; }
        }
    });

    while let Some(Ok(msg)) = stream.next().await {
        if let Message::Text(t) = msg {
            if let Ok(v) = serde_json::from_str::<Value>(&t) {
                if let Some(rpc) = v.get("rpc").and_then(|x| x.as_u64()) {
                    if let Some(tx) = state.pending.lock().unwrap().remove(&rpc) {
                        let _ = tx.send(v);
                    }
                }
            }
        }
    }
    state.controllers.lock().unwrap().remove(&id);
    pump.abort();
}

async fn rpc_post(State(state): State<Arc<AppState>>, Json(body): Json<Value>) -> impl IntoResponse {
    let cmd = match body.get("cmd").and_then(|x| x.as_str()) {
        Some(c) => c.to_string(),
        None => return (StatusCode::BAD_REQUEST, Json(json!({"ok":false,"error":"missing cmd"}))),
    };
    let args = body.get("args").cloned().unwrap_or(json!({}));

    let sender = match state.pick_controller() {
        Some(s) => s,
        None => return (StatusCode::CONFLICT, Json(json!({"ok":false,"error":"no app connected"}))),
    };
    let rpc = state.rpc_seq.fetch_add(1, Ordering::Relaxed);
    let (otx, orx) = oneshot::channel::<Value>();
    state.pending.lock().unwrap().insert(rpc, otx);

    let push = Message::Text(json!({"rpc":rpc,"cmd":cmd,"args":args}).to_string());
    if sender.send(push).is_err() {
        state.pending.lock().unwrap().remove(&rpc);
        return (StatusCode::CONFLICT, Json(json!({"ok":false,"error":"no app connected"})));
    }

    match tokio::time::timeout(Duration::from_secs(8), orx).await {
        Ok(Ok(reply)) => {
            let ok = reply.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
            if ok {
                (StatusCode::OK, Json(json!({"ok":true,"result": reply.get("result").cloned().unwrap_or(Value::Null)})))
            } else {
                let err = reply.get("error").and_then(|x| x.as_str()).unwrap_or("app error").to_string();
                (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({"ok":false,"error": err})))
            }
        }
        _ => {
            state.pending.lock().unwrap().remove(&rpc);
            (StatusCode::GATEWAY_TIMEOUT, Json(json!({"ok":false,"error":"the app did not answer in time"})))
        }
    }
}

// WinMux v2 native core — Stage 1 skeleton + Stage 2 control channel.
//
// Serves the SAME public/ frontend the Node core serves and speaks its protocols:
//   /pty  WebSocket — ?shell=&cwd=&sid=; client {t:i|r|x}, server raw bytes + {type:meta}.
//   /control WebSocket — the app registers here; server pushes {rpc,cmd,args}, app
//            replies {rpc,ok,result|error} (the winmux CLI ↔ app control loop).
//   POST /rpc — {cmd,args}; forwarded to the most-recent /control client, reply relayed.
// Renderer-agnostic core: it streams bytes; any shell/browser/phone renders them.

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::SocketAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc::UnboundedSender, oneshot};
use tower_http::services::ServeDir;

static SID_COUNTER: AtomicU64 = AtomicU64::new(1);

// Shared control state: connected /control clients + in-flight RPC waiters.
struct AppState {
    controllers: Mutex<HashMap<u64, UnboundedSender<Message>>>,
    control_seq: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    rpc_seq: AtomicU64,
    sessions: AtomicU64,
    port: u16,
}
impl AppState {
    fn new(port: u16) -> Self {
        Self {
            controllers: Mutex::new(HashMap::new()),
            control_seq: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            rpc_seq: AtomicU64::new(1),
            sessions: AtomicU64::new(0),
            port,
        }
    }
    // Most-recently-connected live controller (highest id), matching pickControl().
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
    let port: u16 = std::env::var("WINMUX_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(9920);
    let state = Arc::new(AppState::new(port));

    let serve = ServeDir::new(&public).append_index_html_on_directories(true);
    let app = Router::new()
        .route("/pty", get(pty_ws))
        .route("/control", get(control_ws))
        .route("/rpc", post(rpc_post))
        .route("/api/info", get(api_info))
        .fallback_service(serve)
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    write_instance(port);
    println!("winmux-core: serving {} on http://{}  (control+rpc live)", public.display(), addr);
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(listener, app).await.expect("serve");
}

// ---- /pty ---------------------------------------------------------------

async fn pty_ws(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_pty(socket, state, q))
}

async fn handle_pty(socket: WebSocket, state: Arc<AppState>, q: HashMap<String, String>) {
    let shell_key = q.get("shell").map(|s| s.as_str()).unwrap_or("powershell");
    let (exec, args, label) = shell_cmd(shell_key);
    let cwd = q.get("cwd").cloned().filter(|c| !c.is_empty())
        .unwrap_or_else(|| std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into()));
    let sid = new_sid();

    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }) {
        Ok(p) => p,
        Err(e) => { let _ = send_meta_err(socket, &format!("openpty failed: {e}")).await; return; }
    };

    let mut cmd = CommandBuilder::new(&exec);
    for a in &args { cmd.arg(a); }
    cmd.cwd(&cwd);
    // Clean top-level session: scrub NO_COLOR + CLAUDE_CODE_* (mirrors the Node fix).
    cmd.env_clear();
    for (k, v) in std::env::vars() {
        if k == "NO_COLOR" || k == "CLAUDECODE" || k == "CLAUDE_PID" || k.starts_with("CLAUDE_CODE_") { continue; }
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("WINMUX_SID", &sid);

    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => { let _ = send_meta_err(socket, &format!("Failed to start {label}: {e}")).await; return; }
    };
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().expect("reader");
    let mut writer = pair.master.take_writer().expect("writer");
    let master = Arc::new(Mutex::new(pair.master));
    let (mut sink, mut stream) = socket.split();

    let meta = json!({"type":"meta","sid":sid,"shell":label,"cwd":cwd,"resumed":false,"lost":false}).to_string();
    if sink.send(Message::Text(meta)).await.is_err() { return; }
    state.sessions.fetch_add(1, Ordering::Relaxed);

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => { if tx.send(buf[..n].to_vec()).is_err() { break; } }
            }
        }
    });
    let out = tokio::spawn(async move {
        while let Some(bytes) = rx.recv().await {
            if sink.send(Message::Binary(bytes)).await.is_err() { break; }
        }
        let _ = sink.send(Message::Text(json!({"type":"meta","exited":true}).to_string())).await;
    });

    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(t) => {
                let v: Value = match serde_json::from_str(&t) { Ok(v) => v, Err(_) => continue };
                match v.get("t").and_then(|x| x.as_str()) {
                    Some("i") => {
                        if let Some(d) = v.get("d").and_then(|x| x.as_str()) {
                            let _ = writer.write_all(d.as_bytes());
                            let _ = writer.flush();
                        }
                    }
                    Some("r") => {
                        let cols = v.get("c").and_then(|x| x.as_u64()).unwrap_or(80) as u16;
                        let rows = v.get("r").and_then(|x| x.as_u64()).unwrap_or(24) as u16;
                        if let Ok(m) = master.lock() {
                            let _ = m.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
                        }
                    }
                    Some("x") => break,
                    _ => {}
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    let _ = child.kill();
    out.abort();
    state.sessions.fetch_sub(1, Ordering::Relaxed);
}

async fn send_meta_err(socket: WebSocket, err: &str) -> Result<(), axum::Error> {
    let mut socket = socket;
    socket.send(Message::Text(json!({"type":"meta","error": err}).to_string())).await
}

// ---- /api/info ----------------------------------------------------------
// Read-only server + fleet snapshot the `winmux status` verb reads (no control
// client needed). sessions = live /pty count; phone/detached not yet ported.
async fn api_info(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(json!({
        "host": "127.0.0.1",
        "port": state.port,
        "pid": std::process::id(),
        "sessions": state.sessions.load(Ordering::Relaxed),
        "detached": 0,
        "phone": "off",
        "shells": ["powershell", "pwsh", "cmd", "bash", "wsl"],
        "core": "rust",
    }))
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

    // Outgoing: forward server-pushed RPC requests down to this app.
    let pump = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() { break; }
        }
    });

    // Incoming: the app's replies {rpc, ok, result|error} resolve the waiter.
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

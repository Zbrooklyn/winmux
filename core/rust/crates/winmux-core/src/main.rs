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
    extract::{ConnectInfo, Query, Request, State},
    http::{header, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
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
use tokio::sync::{mpsc::UnboundedSender, oneshot, Notify};
use tower_http::services::ServeDir;

mod phonedoor;

static SID_COUNTER: AtomicU64 = AtomicU64::new(1);
const SCROLLBACK_CAP: usize = 256 * 1024; // bytes of backlog replayed on reattach
const GRACE: Duration = Duration::from_secs(30); // a detached shell survives this long

// A live terminal that outlives any single socket. The reader thread runs for the
// session's whole life, appending to `scrollback` and forwarding to the attached sink.
struct Session {
    sid: String,
    shell: String,
    cwd: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    inner: Mutex<SinkState>,
    detach_epoch: AtomicU64, // bumped on every attach/detach; the grace task checks it
    dirty: std::sync::atomic::AtomicBool, // set on new output; the flusher persists then clears it
    alive: std::sync::atomic::AtomicBool, // cleared when the reader thread ends, stopping the flusher
}
struct SinkState {
    scrollback: VecDeque<u8>,
    attached: Option<UnboundedSender<Vec<u8>>>,
}

// ── Agent job store (Stage 3) — parity with the Node server ─────────────────
// One session can register a job, another waits until it finishes and gets its
// result as data. jobId (not sid) is the unit of work; terminal states are the
// first report to win, then immutable. In-memory, per-instance.
const JOB_RESULT_CAP: usize = 64 * 1024;
const JOB_MAX: usize = 200;
const JOB_TTL_MS: u64 = 6 * 60 * 60 * 1000;
struct JobRec {
    job_id: String,
    sid: Option<String>,
    name: Option<String>,
    state: String,
    result: Option<String>,
    truncated: bool,
    exit_code: Option<i64>,
    started_at: u64,
    updated_at: u64,
    ended_at: Option<u64>,
}
impl JobRec {
    fn public(&self) -> Value {
        json!({"jobId": self.job_id, "sid": self.sid, "name": self.name, "state": self.state,
            "result": self.result, "truncated": self.truncated, "exitCode": self.exit_code,
            "startedAt": self.started_at, "updatedAt": self.updated_at, "endedAt": self.ended_at})
    }
    fn is_terminal(&self) -> bool { self.state == "done" || self.state == "failed" }
}

struct AppState {
    controllers: Mutex<HashMap<u64, UnboundedSender<Message>>>,
    control_seq: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    rpc_seq: AtomicU64,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    clip: Mutex<(String, u64)>, // cross-device clipboard: (text, at_ms)
    phone: phonedoor::PhoneDoor, // the tailnet phone door (trust + key auth)
    // Live phone terminals, keyed by a monotonic id → (device id, close signal).
    // Closing the door drops all of them; forgetting a device drops only its own.
    phone_conns: Mutex<HashMap<u64, (String, UnboundedSender<()>)>>,
    phone_conn_seq: AtomicU64,
    port: u16,
    jobs: Mutex<HashMap<String, JobRec>>,   // Stage 3 agent-job store
    job_seq: AtomicU64,
    job_notify: Notify,                      // woken on any terminal transition; waiters re-check
}
impl AppState {
    fn new(port: u16) -> Self {
        Self {
            controllers: Mutex::new(HashMap::new()),
            control_seq: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            rpc_seq: AtomicU64::new(1),
            sessions: Mutex::new(HashMap::new()),
            clip: Mutex::new((String::new(), 0)),
            phone: phonedoor::PhoneDoor::load(trust_file()),
            phone_conns: Mutex::new(HashMap::new()),
            phone_conn_seq: AtomicU64::new(1),
            port,
            jobs: Mutex::new(HashMap::new()),
            job_seq: AtomicU64::new(1),
            job_notify: Notify::new(),
        }
    }

    // Handle a job verb server-side (register/report/status/list). Returns None if
    // `cmd` is not a job verb (the caller then relays it to the app). job-wait is
    // async and handled separately in rpc_post.
    fn agent_job_dispatch(&self, cmd: &str, args: &Value) -> Option<Result<Value, String>> {
        match cmd {
            "job-register" => {
                let n = self.job_seq.fetch_add(1, Ordering::Relaxed);
                let job_id = format!("job_{:x}_{:x}", now_ms(), n);
                let now = now_ms() as u64;
                let rec = JobRec {
                    job_id: job_id.clone(),
                    sid: args.get("sid").and_then(|v| v.as_str()).map(String::from),
                    name: args.get("name").and_then(|v| v.as_str()).map(String::from),
                    state: "working".into(), result: None, truncated: false, exit_code: None,
                    started_at: now, updated_at: now, ended_at: None,
                };
                let out = rec.public();
                let mut m = self.jobs.lock().unwrap();
                m.insert(job_id, rec);
                // Evict aged-out terminals, then cap the oldest.
                let cutoff = now.saturating_sub(JOB_TTL_MS);
                let stale: Vec<String> = m.iter().filter(|(_, r)| r.ended_at.map(|e| e < cutoff).unwrap_or(false)).map(|(k, _)| k.clone()).collect();
                for k in stale { m.remove(&k); }
                while m.len() > JOB_MAX {
                    let oldest = m.iter().min_by_key(|(_, r)| r.started_at).map(|(k, _)| k.clone());
                    match oldest { Some(k) => { m.remove(&k); } None => break }
                }
                Some(Ok(json!({"job": out})))
            }
            "job-report" => {
                let job_id = match args.get("jobId").and_then(|v| v.as_str()) { Some(s) => s.to_string(), None => return Some(Err("missing jobId".into())) };
                let mut m = self.jobs.lock().unwrap();
                let rec = match m.get_mut(&job_id) { Some(r) => r, None => return Some(Err(format!("unknown jobId: {job_id}"))) };
                if rec.is_terminal() { return Some(Ok(json!({"job": rec.public()}))); }   // first terminal report wins
                let mut st = args.get("state").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if st == "needs-you" { st = "needsyou".into(); }
                if !["working", "needsyou", "done", "failed"].contains(&st.as_str()) { return Some(Err(format!("bad job state: {st}"))); }
                rec.state = st.clone();
                if let Some(r) = args.get("result") {
                    if !r.is_null() {
                        let mut s = r.as_str().map(String::from).unwrap_or_else(|| r.to_string());
                        if s.len() > JOB_RESULT_CAP { let mut end = JOB_RESULT_CAP; while end > 0 && !s.is_char_boundary(end) { end -= 1; } s.truncate(end); rec.truncated = true; }
                        rec.result = Some(s);
                    }
                }
                if let Some(c) = args.get("exitCode").and_then(|v| v.as_i64()) { rec.exit_code = Some(c); }
                rec.updated_at = now_ms() as u64;
                let terminal = rec.is_terminal();
                if terminal { rec.ended_at = Some(rec.updated_at); }
                let out = rec.public();
                drop(m);
                if terminal { self.job_notify.notify_waiters(); }
                Some(Ok(json!({"job": out})))
            }
            "job-status" => {
                let job_id = args.get("jobId").and_then(|v| v.as_str()).unwrap_or("");
                let m = self.jobs.lock().unwrap();
                match m.get(job_id) { Some(r) => Some(Ok(json!({"job": r.public()}))), None => Some(Err(format!("unknown jobId: {job_id}"))) }
            }
            "job-list" => {
                let m = self.jobs.lock().unwrap();
                let arr: Vec<Value> = m.values().map(|r| r.public()).collect();
                Some(Ok(json!({"jobs": arr})))
            }
            _ => None,
        }
    }
    // P6 supervision: a session died with jobs still riding it → fail them so
    // waiters wake with the reason. Auto-restart is deliberately NOT built here —
    // restarting a task can repeat its side effects, so it stays opt-in and off.
    fn fail_jobs_for_sid(&self, sid: &str, exit_code: Option<i64>) {
        let mut m = self.jobs.lock().unwrap();
        let mut any = false;
        for r in m.values_mut() {
            if r.sid.as_deref() == Some(sid) && !r.is_terminal() {
                r.state = "failed".into();
                r.result = Some(match exit_code {
                    Some(c) => format!("worker session exited (code {c}) before reporting a result"),
                    None => "worker session exited before reporting a result".into(),
                });
                r.exit_code = exit_code;
                r.updated_at = now_ms() as u64;
                r.ended_at = Some(r.updated_at);
                any = true;
            }
        }
        drop(m);
        if any { self.job_notify.notify_waiters(); }
    }
    fn pick_controller(&self) -> Option<UnboundedSender<Message>> {
        let map = self.controllers.lock().unwrap();
        map.iter().max_by_key(|(id, _)| **id).map(|(_, s)| s.clone())
    }

    // Register a live phone terminal; the returned receiver fires when the door
    // closes or this device is forgotten, which breaks the socket loop.
    fn register_phone_conn(&self, dev: String) -> (u64, tokio::sync::mpsc::UnboundedReceiver<()>) {
        let id = self.phone_conn_seq.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        self.phone_conns.lock().unwrap().insert(id, (dev, tx));
        (id, rx)
    }
    fn unregister_phone_conn(&self, id: u64) {
        self.phone_conns.lock().unwrap().remove(&id);
    }
    // Close phone terminals: every one (dev = None) on door-off, or a single
    // device's (Some) when it is forgotten — a revoked phone must lose its shell,
    // not just its next login.
    fn close_phone_conns(&self, dev: Option<&str>) {
        let mut map = self.phone_conns.lock().unwrap();
        let ids: Vec<u64> = map
            .iter()
            .filter(|(_, (d, _))| dev.map_or(true, |want| d == want))
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            if let Some((_, tx)) = map.remove(&id) {
                let _ = tx.send(());
            }
        }
    }
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn new_sid() -> String {
    // 32 lowercase hex chars, like the Node server's ids — the backlog filename
    // and the tab's recover-by key both depend on this exact shape.
    let n = SID_COUNTER.fetch_add(1, Ordering::Relaxed) as u128;
    let mix = now_ms().wrapping_mul(0x1_0000_0000).wrapping_add(n).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let v = mix ^ (mix.rotate_left(64)) ^ (now_ms() << 24) ^ n;
    format!("{:032x}", v)
}

// The backlog dir sits next to the config file, so a restarted process on the same
// config reads the same dir the previous one wrote (mirrors the Node server).
fn backlog_dir() -> PathBuf {
    config_file().parent().map(|p| p.join("backlog")).unwrap_or_else(|| PathBuf::from("backlog"))
}

fn backlog_path(sid: &str) -> Option<PathBuf> {
    if sid.is_empty() || !sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') { return None; }
    Some(backlog_dir().join(format!("{sid}.json")))
}

// Persist a session's scrollback so it survives a full process restart. Atomic
// (tmp + rename); dev is empty because the Rust core is loopback-only for now.
fn save_backlog(sid: &str, shell: &str, cwd: &str, buf: &str) {
    let p = match backlog_path(sid) { Some(p) => p, None => return };
    let _ = std::fs::create_dir_all(backlog_dir());
    let body = json!({"id": sid, "dev": "", "shell": shell, "cwd": cwd, "buf": buf, "savedAt": now_ms() as u64});
    let tmp = p.with_extension(format!("{}.tmp", std::process::id()));
    if std::fs::write(&tmp, body.to_string()).is_ok() { let _ = std::fs::rename(&tmp, &p); }
}

// Drop backlog files older than a week so a long-lived install never grows
// unbounded (mirrors the Node server's pruneBacklog). Runs once at startup.
fn prune_backlog() {
    const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
    if let Ok(entries) = std::fs::read_dir(backlog_dir()) {
        for e in entries.flatten() {
            if !e.file_name().to_string_lossy().to_lowercase().ends_with(".json") { continue; }
            if let Ok(modified) = e.metadata().and_then(|m| m.modified()) {
                if SystemTime::now().duration_since(modified).map(|d| d > MAX_AGE).unwrap_or(false) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
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
        .route("/api/clip", get(api_clip_get).post(api_clip_post))
        .route("/api/config", get(api_config_get).post(api_config_post))
        .route("/api/projects", get(api_projects_list))
        .route("/api/project", get(api_project_get).post(api_project_post).delete(api_project_delete))
        .route("/api/update", get(api_update))
        .route("/shells", get(api_shells))
        .route("/api/claude-sessions", get(api_claude_sessions))
        .route("/api/backlog", get(api_backlog))
        .route("/api/phone", get(api_phone).post(api_phone_post))
        .route("/api/phone/devices", get(api_phone_devices).post(api_phone_devices_post))
        .route("/api/phone/qr", get(api_phone_qr))
        .fallback_service(serve)
        .layer(axum::middleware::from_fn(no_store_html))
        .with_state(state);

    // P6 supervision watchdog: ConPTY does not reliably EOF the reader thread when
    // the shell process dies, so poll — any non-terminal job whose session is gone
    // or whose shell has exited is failed here so waiters wake with the reason.
    // Auto-restart is deliberately absent (opt-in, off by default).
    let watch_state = shutdown_state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(2000)).await;
            let watch: Vec<String> = {
                let m = watch_state.jobs.lock().unwrap();
                m.values().filter(|r| !r.is_terminal()).filter_map(|r| r.sid.clone()).collect()
            };
            for sid in watch {
                let sess = watch_state.sessions.lock().unwrap().get(&sid).cloned();
                let dead: Option<Option<i64>> = match &sess {
                    None => Some(None),                                   // session gone entirely
                    Some(s) => match s.child.lock().unwrap().try_wait() {
                        Ok(Some(st)) => Some(Some(st.exit_code() as i64)), // shell process exited
                        _ => None,                                         // still running
                    },
                };
                if let Some(code) = dead { watch_state.fail_jobs_for_sid(&sid, code); }
            }
        }
    });

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
    prune_backlog();
    println!("winmux-core: serving {} on http://127.0.0.1:{port}  (control+rpc+resume live)", public.display());
    axum::serve(listener, app).await.expect("serve");
}

// ---- /pty ---------------------------------------------------------------

async fn pty_ws(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_pty(socket, state, q, None))
}

// The phone door's /pty: same shell, but the connection is registered so the off
// switch (and forgetting this device) can force it shut. Keyed by the device id
// (ct_dev cookie) so a revoke closes exactly that phone's terminals.
async fn pty_ws_phone(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(q): Query<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    let cookie = headers.get(header::COOKIE).and_then(|v| v.to_str().ok()).unwrap_or("");
    let mut dev = phonedoor::device_id_from(cookie);
    if dev.is_empty() {
        // A key-only connection (no device cookie yet) is still keyed so door-off
        // closes it; it just won't be matched by a per-device forget.
        dev = q.get("k").cloned().unwrap_or_default();
    }
    let (id, rx) = state.register_phone_conn(dev);
    ws.on_upgrade(move |socket| handle_pty(socket, state, q, Some((id, rx))))
}

// Spawn a brand-new shell as a registry Session with a lifelong reader thread.
fn spawn_session(shell_key: &str, cwd: &str, state: &Arc<AppState>) -> Result<(String, Arc<Session>), String> {
    let (exec, args, label) = shell_cmd(shell_key);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty failed: {e}"))?;

    // The sid is minted before spawn so it can be injected as WINMUX_SID — the way
    // tmux exports $TMUX_PANE — letting an agent's hook address exactly this session.
    let sid = new_sid();
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
    cmd.env("WINMUX_SID", &sid);
    cmd.env("WINMUX_PORT", state.port.to_string());

    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("Failed to start {label}: {e}"))?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| format!("reader: {e}"))?;
    let writer = pair.master.take_writer().map_err(|e| format!("writer: {e}"))?;

    let session = Arc::new(Session {
        sid: sid.clone(),
        shell: label,
        cwd: cwd.to_string(),
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        inner: Mutex::new(SinkState { scrollback: VecDeque::new(), attached: None }),
        detach_epoch: AtomicU64::new(0),
        dirty: std::sync::atomic::AtomicBool::new(false),
        alive: std::sync::atomic::AtomicBool::new(true),
    });

    // Lifelong reader: appends to scrollback, pushes to whoever is attached now, and
    // flags the scrollback dirty so the flusher persists it (trailing-edge, so the
    // LAST line before a quiet restart is never dropped).
    let sref = session.clone();
    let stref = state.clone();
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
                    drop(inner);
                    sref.dirty.store(true, Ordering::Relaxed);
                }
            }
        }
        sref.alive.store(false, Ordering::Relaxed);
        // P6 supervision: the shell died — fail any job still riding this session
        // so a waiting orchestrator wakes with `failed` + the reason instead of
        // hanging until its timeout.
        let code = sref.child.lock().unwrap().try_wait().ok().flatten().map(|s| s.exit_code() as i64);
        stref.fail_jobs_for_sid(&sref.sid, code);
    });

    // Flusher: every 600ms, if the scrollback changed, persist it to disk. This is
    // a trailing-edge debounce — the last output before a restart is always saved
    // within ~600ms of quiescence, and idle sessions cost no writes.
    let fref = session.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(600));
            if fref.dirty.swap(false, Ordering::Relaxed) {
                let snap: Vec<u8> = { fref.inner.lock().unwrap().scrollback.iter().copied().collect() };
                save_backlog(&fref.sid, &fref.shell, &fref.cwd, &String::from_utf8_lossy(&snap));
            }
            if !fref.alive.load(Ordering::Relaxed) { break; }
        }
    });
    Ok((sid, session))
}

async fn handle_pty(
    socket: WebSocket,
    state: Arc<AppState>,
    q: HashMap<String, String>,
    phone: Option<(u64, tokio::sync::mpsc::UnboundedReceiver<()>)>,
) {
    let (phone_conn_id, mut close_rx) = match phone {
        Some((id, rx)) => (Some(id), Some(rx)),
        None => (None, None),
    };
    let want_sid = q.get("sid").cloned().filter(|s| !s.is_empty());
    let shell_key = q.get("shell").map(|s| s.as_str()).unwrap_or("powershell").to_string();
    let cwd = q.get("cwd").cloned().filter(|c| !c.is_empty())
        .unwrap_or_else(|| std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into()));

    // Reattach to a live session, or spawn a fresh one.
    let existing = want_sid.as_ref().and_then(|s| state.sessions.lock().unwrap().get(s).cloned());
    let (sid, session, resumed) = match existing {
        Some(s) => (want_sid.clone().unwrap(), s, true),
        None => match spawn_session(&shell_key, &cwd, &state) {
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
    // A fresh shell prints its first prompt into the blind 80x24 spawn buffer; the
    // first client resize below repaints it top-anchored (see the "r" handler).
    // Never on a resumed session — that would wipe the replayed scrollback.
    let mut needs_clear = !resumed;
    loop {
        // A forced close (door off / device forgotten) breaks the loop, dropping
        // the socket so the phone's terminal stops answering. Otherwise read the
        // next client frame.
        let msg = match close_rx.as_mut() {
            Some(rx) => tokio::select! {
                m = stream.next() => m,
                _ = rx.recv() => break,
            },
            None => stream.next().await,
        };
        let msg = match msg {
            Some(Ok(m)) => m,
            _ => break,
        };
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
                        // Fresh shell only, once: the prompt rendered blind at 80x24; now that
                        // the real size has landed, send Ctrl+L (PSReadLine ClearScreen) so it
                        // repaints top-anchored instead of stranded mid-screen. Mirrors the Node
                        // core's fix in server.cjs (inject \f on the first resize of a fresh pty).
                        if needs_clear {
                            needs_clear = false;
                            let mut w = session.writer.lock().unwrap();
                            let _ = w.write_all(b"\x0c");
                            let _ = w.flush();
                        }
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
    if let Some(id) = phone_conn_id {
        state.unregister_phone_conn(id);
    }

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

// The app shell must never be cached — a stale index would pin an old UI against a
// new core. Tag every HTML response no-store (mirrors the Node server's headers).
async fn no_store_html(req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, HeaderValue};
    let mut res = next.run(req).await;
    // The app shell and its code are rebuilt constantly at a fixed local address,
    // so a cached html/js/css asset can render a version that no longer exists.
    let app_asset = res.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).map_or(false, |c| {
        c.starts_with("text/html") || c.starts_with("text/css")
            || c.contains("javascript")
    });
    if app_asset { res.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static("no-store")); }
    res
}

// ---- /api/claude-sessions -----------------------------------------------
// The real Claude conversation ids for a folder, so a tab can arm
// `claude --resume <id>` instead of guessing "the latest". Claude keeps one dir
// per cwd under ~/.claude/projects, named by replacing every non-alphanumeric
// char of the resolved path with '-', holding one <id>.jsonl each. We read file
// NAMES + mtimes only — never a transcript's contents. Desk-only (Node 403s the
// phone; the Rust core is loopback-only until the phone door lands).
async fn api_claude_sessions(Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    let cwd = q.get("cwd").cloned().unwrap_or_default();
    if cwd.is_empty() {
        return Json(json!({"ok": false, "error": "missing cwd", "sessions": []}));
    }
    // Mirror Node's path.resolve(cwd).replace(/[^a-zA-Z0-9]/g,'-'). The frontend
    // passes an already-absolute cwd, so a per-char replace matches path.resolve.
    // ponytail: relative/`..` cwds aren't normalized first; frontend never sends them.
    let key: String = cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_else(|_| ".".into());
    let dir = PathBuf::from(home).join(".claude").join("projects").join(&key);
    let dir_str = dir.to_string_lossy().to_string();
    let mut out: Vec<Value> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.to_lowercase().ends_with(".jsonl") { continue; }
            let meta = match e.metadata() { Ok(m) => m, Err(_) => continue };
            if meta.len() == 0 { continue; }
            let mtime = meta.modified().ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as f64).unwrap_or(0.0);
            let id = &name[..name.len() - 6]; // strip ".jsonl"
            out.push(json!({"id": id, "mtime": mtime, "size": meta.len()}));
        }
    }
    // No dir = folder never ran Claude → a normal empty answer, not an error.
    out.sort_by(|a, b| b["mtime"].as_f64().unwrap_or(0.0).partial_cmp(&a["mtime"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(25);
    Json(json!({"ok": true, "dir": dir_str, "sessions": out}))
}

// ---- /api/backlog -------------------------------------------------------
// After a full restart the fresh process reads the previous one's on-disk
// scrollback (keyed by sid) and replays it as dimmed history above a new prompt.
async fn api_backlog(Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    let sid = q.get("sid").cloned().unwrap_or_default();
    let bl = backlog_path(&sid)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    match bl {
        Some(o) if o.is_object() => Json(json!({
            "found": true,
            "buf": o.get("buf").and_then(|v| v.as_str()).unwrap_or(""),
            "shell": o.get("shell").and_then(|v| v.as_str()).unwrap_or(""),
            "cwd": o.get("cwd").and_then(|v| v.as_str()).unwrap_or(""),
            "savedAt": o.get("savedAt").and_then(|v| v.as_u64()).unwrap_or(0),
        })).into_response(),
        _ => (axum::http::StatusCode::NOT_FOUND, Json(json!({"found": false}))).into_response(),
    }
}

// ---- /shells ------------------------------------------------------------
// The list of shells the new-tab picker can offer (the frontend fetches this
// at boot). Labels mirror shell_cmd()'s.
async fn api_shells() -> impl IntoResponse {
    Json(json!([
        {"key": "powershell", "label": "Windows PowerShell"},
        {"key": "pwsh", "label": "PowerShell 7"},
        {"key": "cmd", "label": "Command Prompt"},
        {"key": "bash", "label": "Git Bash"},
        {"key": "wsl", "label": "WSL"},
    ]))
}

// ---- /api/update --------------------------------------------------------
// Reports whether a newer release exists so the app's badge can light up.
// WINMUX_FAKE_LATEST is the harness hook (prove the badge without a real release).
const UPDATE_URL: &str = "https://github.com/Zbrooklyn/winmux/releases/latest";

fn cmp_semver(a: &str, b: &str) -> i32 {
    let parse = |s: &str| -> [i64; 3] {
        let mut out = [0i64; 3];
        for (i, p) in s.trim_start_matches('v').split('.').take(3).enumerate() {
            out[i] = p.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0);
        }
        out
    };
    let (pa, pb) = (parse(a), parse(b));
    for i in 0..3 { let d = pa[i] - pb[i]; if d != 0 { return if d > 0 { 1 } else { -1 }; } }
    0
}

async fn api_update() -> impl IntoResponse {
    let version = env!("CARGO_PKG_VERSION");
    // ponytail: live GitHub-release fetch deferred; Node falls back to this same
    // no-update default on any network failure, so it's a safe production default.
    if let Ok(fl) = std::env::var("WINMUX_FAKE_LATEST") {
        let fl = fl.trim_start_matches('v').to_string();
        return Json(json!({ "current": version, "latest": fl,
            "updateAvailable": cmp_semver(&fl, version) > 0, "url": UPDATE_URL }));
    }
    Json(json!({ "current": version, "latest": Value::Null, "updateAvailable": false, "url": UPDATE_URL }))
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
        "version": env!("CARGO_PKG_VERSION"),
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

// ---- /api/config --------------------------------------------------------
// --- The phone door --------------------------------------------------------
// The whole two-door flow. The desk door (loopback) reads and CHANGES the switch;
// the phone door (a second listener bound to the Tailscale address, opened on
// demand) is key-gated and read-only for the switch. Faithful port of the Node
// server's handle(req,res,viaPhone) + setPhone.

// The status the Settings panel, onboarding, and the phone all poll. Over the
// phone door (via_phone) canChange is false and device ids — a credential — are
// withheld. ip/url/tailscale/tailnetPeers now reflect the live listener.
fn phone_state(state: &AppState, via_phone: bool) -> Value {
    json!({
        "on": state.phone.is_on(),
        "ip": state.phone.ip().map(Value::from).unwrap_or(Value::Null),
        "port": state.port,
        "url": state.phone.phone_url(state.port),
        "canChange": !via_phone,
        "tailscale": phonedoor::tailscale_ip().is_some(),
        "trustTailnet": state.phone.trust_tailnet(),
        "tailnetPeers": state.phone.tailnet_peers().map(Value::from).unwrap_or(Value::Null),
        "devices": state.phone.device_list(via_phone),
    })
}

// {"ok":ok} merged over the desk view — the shape both setPhone paths return.
fn ok_state(state: &Arc<AppState>, ok: bool) -> Value {
    let mut v = phone_state(state, false);
    if let Some(o) = v.as_object_mut() {
        o.insert("ok".into(), json!(ok));
    }
    v
}

// The tailnet peer count is a label for the trust switch; refresh it OFF the hot
// path (a `tailscale status` spawn) so /api/phone never blocks. Restamps the
// cache time immediately so a burst of reads kicks only one probe, then fills the
// real value for the NEXT read — exactly the Node cache behaviour.
fn kick_peers_refresh(state: &Arc<AppState>) {
    if !state.phone.peers_stale() {
        return;
    }
    state.phone.set_peers(state.phone.tailnet_peers()); // restamp; keep current value
    let s = state.clone();
    tokio::spawn(async move {
        if let Ok(n) = tokio::task::spawn_blocking(phonedoor::PhoneDoor::probe_peers).await {
            s.phone.set_peers(n);
        }
    });
}

// ---- desk door (loopback): read + change the switch ---------------------
async fn api_phone(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    kick_peers_refresh(&state);
    Json(phone_state(&state, false))
}
async fn api_phone_post(State(state): State<Arc<AppState>>, body: String) -> Response {
    let msg: Value = serde_json::from_str(&body).unwrap_or(json!({}));
    // Trusting the whole tailnet is a separate, persisted decision from opening
    // the door at all, so it is a separate field.
    if let Some(tt) = msg.get("trustTailnet") {
        state.phone.set_trust_tailnet(tt.as_bool().unwrap_or(false));
    }
    if msg.get("on").is_none() {
        return (StatusCode::OK, Json(ok_state(&state, true))).into_response();
    }
    let want = msg.get("on").and_then(|v| v.as_bool()).unwrap_or(false);
    let (code, v) = set_phone(&state, want).await;
    (code, Json(v)).into_response()
}
async fn api_phone_devices(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(json!({ "devices": state.phone.device_list(false), "canChange": true }))
}
async fn api_phone_devices_post(State(state): State<Arc<AppState>>, body: String) -> impl IntoResponse {
    let msg: Value = serde_json::from_str(&body).unwrap_or(json!({}));
    // Forgetting a phone rotates the key so a revoked device can't walk back in
    // on the link it already holds (#153).
    if msg.get("all").and_then(|v| v.as_bool()).unwrap_or(false) {
        state.phone.forget_all();
        state.phone.rotate_key();
        state.close_phone_conns(None); // every remembered phone loses its shell
    } else if let Some(id) = msg.get("forget").and_then(|v| v.as_str()) {
        if state.phone.forget_device(id) {
            state.phone.rotate_key();
            state.close_phone_conns(Some(id)); // the revoked phone loses its shell now
        }
    }
    Json(json!({ "ok": true, "devices": state.phone.device_list(false) }))
}

// The link as a scannable square, so nobody types a 32-char key. Served on both
// doors; 404 while the door is shut. On the phone door the gate has already
// authed the request.
async fn api_phone_qr(State(state): State<Arc<AppState>>) -> Response {
    if !state.phone.is_on() {
        return (StatusCode::NOT_FOUND, "off").into_response();
    }
    match state.phone.qr_svg(state.port) {
        Some(svg) => (
            [
                (header::CONTENT_TYPE, "image/svg+xml"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            svg,
        )
            .into_response(),
        None => (StatusCode::INTERNAL_SERVER_ERROR, "qr failed").into_response(),
    }
}

// ---- opening and closing the phone door (setPhone) ----------------------
// Turning ON binds a SECOND listener to the Tailscale address on the SAME port,
// running the key-gated phone router. Turning OFF aborts it, which drops the
// TcpListener and frees ip:PORT — dropping every phone terminal with it.
async fn set_phone(state: &Arc<AppState>, want: bool) -> (StatusCode, Value) {
    if want == state.phone.is_on() {
        return (StatusCode::OK, ok_state(state, true));
    }
    if !want {
        // Closing drops every phone terminal with it — that is the point of an
        // off switch. Force the shells shut, then trigger graceful shutdown: the
        // moment the signal fires the accept loop ends and the listener is
        // dropped (freeing ip:PORT and closing idle keep-alives), and awaiting
        // the task confirms it is fully gone before we report the door shut — so
        // the very next request is refused, not answered on a dying socket.
        // (Aborting the task instead leaves the socket accepting for ~200ms on
        // Windows, and bind() can't detect that; graceful shutdown is exact.)
        state.close_phone_conns(None);
        if let Some((shutdown, handle)) = state.phone.take_listener() {
            let _ = shutdown.send(());
            let _ = tokio::time::timeout(Duration::from_secs(3), handle).await;
        }
        state.phone.mark_off();
        return (StatusCode::OK, ok_state(state, true));
    }
    // Turning on: need a private address to listen on.
    let ip = match phonedoor::tailscale_ip() {
        Some(ip) => ip,
        None => {
            return (
                StatusCode::CONFLICT,
                json!({"ok": false, "error":
                    "Tailscale is not running on this PC, so there is no private address to listen on. Start Tailscale and try again."}),
            )
        }
    };
    let addr: SocketAddr = match format!("{}:{}", ip, state.port).parse() {
        Ok(a) => a,
        Err(_) => {
            return (
                StatusCode::CONFLICT,
                json!({"ok": false, "error": format!("Could not parse the Tailscale address {}:{}.", ip, state.port)}),
            )
        }
    };
    let listener = match bind_phone(addr).await {
        Ok(l) => l,
        Err(e) => {
            // A failed phone door must never take the desk door down with it.
            let busy = e.kind() == std::io::ErrorKind::AddrInUse;
            let msg = if busy {
                format!("Something else on this PC is already using port {} on your Tailscale address. Close it, or start this app on a different port, then try again.", state.port)
            } else {
                format!("Could not listen on {}:{} — {}", ip, state.port, e)
            };
            return (StatusCode::CONFLICT, json!({"ok": false, "error": msg}));
        }
    };
    let token = phonedoor::PhoneDoor::fresh_token();
    let app = phone_router(state.clone());
    let make = app.into_make_service_with_connect_info::<SocketAddr>();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, make)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await;
    });
    state.phone.open_with(ip, token, shutdown_tx, task);
    (StatusCode::OK, ok_state(state, true))
}

// Bind the tailnet listener, absorbing the brief AddrInUse window when a prior
// off→on reuses the same port faster than the OS releases it. A port a real
// process holds stays busy through every retry, so the failure still surfaces.
async fn bind_phone(addr: SocketAddr) -> std::io::Result<tokio::net::TcpListener> {
    let mut last: Option<std::io::Error> = None;
    for _ in 0..4 {
        match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => return Ok(l),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                last = Some(e);
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::new(std::io::ErrorKind::AddrInUse, "address in use")))
}

// ---- phone door router + gate -------------------------------------------
// The key-gated router the second listener serves. Every request passes the gate
// (throttle → auth → cookie-mint) before any handler runs; the switch is
// read-only here and the file-reading endpoints refuse outright.
fn phone_router(state: Arc<AppState>) -> Router {
    let public = resolve_public_dir();
    let serve = ServeDir::new(&public).append_index_html_on_directories(true);
    Router::new()
        .route("/pty", get(pty_ws_phone))
        .route("/api/phone", get(phone_api_phone).post(phone_api_phone_post))
        .route(
            "/api/phone/devices",
            get(phone_api_devices).post(phone_api_devices_post),
        )
        .route("/api/phone/qr", get(api_phone_qr))
        .route("/api/clip", get(api_clip_get).post(api_clip_post))
        .route("/api/config", get(api_config_get).post(api_config_post))
        .route("/api/info", get(api_info))
        .route("/api/update", get(api_update))
        .route("/shells", get(api_shells))
        .route("/api/backlog", get(api_backlog))
        // Desk-door only over the tailnet: reading the host disk is refused even
        // with a valid key (#210).
        .route("/api/md", get(phone_denied))
        .route("/api/findpath", get(phone_denied))
        .route("/api/claude-sessions", get(phone_denied))
        .route("/api/projects", get(phone_denied))
        .route("/api/project", get(phone_denied))
        .fallback_service(serve)
        .layer(axum::middleware::from_fn(no_store_html))
        .layer(axum::middleware::from_fn_with_state(state.clone(), phone_gate))
        .with_state(state)
}

fn hget(req: &Request, name: header::HeaderName) -> String {
    req.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
}
// The ?k= value out of a raw query string (keys are hex, so no decoding needed).
fn query_k(query: &str) -> Option<String> {
    for pair in query.split('&') {
        let mut it = pair.splitn(2, '=');
        if it.next() == Some("k") {
            return Some(it.next().unwrap_or("").to_string());
        }
    }
    None
}

// The phone door: no key, no anything. Throttle, then auth, before the URL is
// even routed. A valid ?k= parks the key in a cookie and mints the device id
// that lets this phone skip the QR next time.
async fn phone_gate(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response {
    let ip = peer.ip().to_string();
    // An address that has burned through its guesses waits out the cooldown.
    if state.phone.throttle_locked(&ip) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [(header::RETRY_AFTER, "60")],
            "WinMux: too many attempts. Wait a minute and try again.",
        )
            .into_response();
    }
    let qk = req.uri().query().and_then(query_k);
    let has_k = qk.as_deref().map(|k| !k.is_empty()).unwrap_or(false);
    let cookie = hget(&req, header::COOKIE);
    let accept = hget(&req, header::ACCEPT);
    let ua = hget(&req, header::USER_AGENT);
    let wants_html = accept.contains("text/html");
    let token = phonedoor::token_from(qk.as_deref(), &cookie);
    let dev = phonedoor::device_id_from(&cookie);

    if !state.phone.authed(&token, &dev) {
        // Count only deliberate wrong keys (a ?k= that didn't match) toward the
        // throttle — browsing with no key is not a guess.
        if has_k {
            state.phone.note_bad_key(&ip);
        }
        if wants_html {
            return (
                StatusCode::UNAUTHORIZED,
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                phonedoor::key_needed_page(),
            )
                .into_response();
        }
        return (
            StatusCode::UNAUTHORIZED,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "WinMux: this link needs its access key.",
        )
            .into_response();
    }

    // Mint (cookie the key + remember the device) only on a real key match —
    // never because trustTailnet waved it in, or toggling the tailnet switch
    // would silently trust the room.
    let minted = if has_k && state.phone.key_matches(&token) {
        Some(state.phone.remember_device(&ua, &ip, &dev))
    } else {
        // Page loads only: refresh this device's "last seen".
        if wants_html {
            state.phone.touch_device(&dev);
        }
        None
    };

    let mut res = next.run(req).await;
    if let Some(devid) = minted {
        let tok = state.phone.token();
        let h = res.headers_mut();
        if let Ok(v) = HeaderValue::from_str(&format!("ct_k={}; Path=/; HttpOnly; SameSite=Strict", tok)) {
            h.append(header::SET_COOKIE, v);
        }
        // A year, because the point is to outlive restarts and key rotation.
        if let Ok(v) = HeaderValue::from_str(&format!(
            "ct_dev={}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000",
            devid
        )) {
            h.append(header::SET_COOKIE, v);
        }
    }
    res
}

// ---- phone-door handlers (via_phone = true) -----------------------------
async fn phone_api_phone(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    kick_peers_refresh(&state);
    Json(phone_state(&state, true))
}
async fn phone_api_phone_post() -> impl IntoResponse {
    (
        StatusCode::FORBIDDEN,
        Json(json!({"ok": false, "error": "Phone access can only be changed at the PC itself."})),
    )
}
async fn phone_api_devices(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(json!({ "devices": state.phone.device_list(true), "canChange": false }))
}
async fn phone_api_devices_post() -> impl IntoResponse {
    (
        StatusCode::FORBIDDEN,
        Json(json!({"ok": false, "error": "Remembered devices can only be changed at the PC itself."})),
    )
}
// The host disk is never a read/enumerate surface over the tailnet (#210).
async fn phone_denied() -> impl IntoResponse {
    (
        StatusCode::FORBIDDEN,
        Json(json!({"ok": false, "error": "available only at the PC"})),
    )
}

// A hand-editable JSON config on disk (WINMUX_CONFIG_FILE): GET returns it, POST
// replaces whole sub-objects (settings/themes/keymap) and leaves the rest intact.
fn config_file() -> PathBuf {
    std::env::var("WINMUX_CONFIG_FILE").map(PathBuf::from).unwrap_or_else(|_| {
        let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join(".winmux").join("config.json")
    })
}

// The trusted-devices guest list. WINMUX_TRUST_FILE overrides (the harness points
// it at a scratch file); default mirrors the Node profile's ~/.winmux/devices.json.
fn trust_file() -> PathBuf {
    std::env::var("WINMUX_TRUST_FILE").map(PathBuf::from).unwrap_or_else(|_| {
        let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join(".winmux").join("devices.json")
    })
}
fn read_config() -> Value {
    std::fs::read_to_string(config_file()).ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| json!({}))
}
async fn api_config_get() -> impl IntoResponse {
    Json(json!({"ok": true, "config": read_config()}))
}
async fn api_config_post(Json(incoming): Json<Value>) -> impl IntoResponse {
    let mut cur = read_config();
    if let Some(obj) = cur.as_object_mut() {
        for k in ["settings", "themes", "keymap"] {
            if let Some(v) = incoming.get(k) {
                if v.is_object() { obj.insert(k.to_string(), v.clone()); }
            }
        }
    }
    let file = config_file();
    if let Some(dir) = file.parent() { let _ = std::fs::create_dir_all(dir); }
    let tmp = file.with_extension(format!("{}.tmp", std::process::id()));
    let ok = std::fs::write(&tmp, cur.to_string()).and_then(|_| std::fs::rename(&tmp, &file)).is_ok();
    Json(json!({"ok": ok}))
}

// ---- /api/projects + /api/project (desk-door only) ----------------------
// Save/open a workspace layout as a .winmux.json file the same way the Node server
// does, over /api/project(s). Faithful port of server.cjs: the recents index lives
// beside config (WINMUX_CONFIG_FILE) so tests never pollute the real home; the
// default folder honours WINMUX_PROJECTS_DIR. Desk-door only — a phone attaches to
// an already-open workspace and has no business writing .json onto the PC, so the
// phone router serves phone_denied for these.
fn projects_dir() -> PathBuf {
    let d = std::env::var("WINMUX_PROJECTS_DIR").map(PathBuf::from).unwrap_or_else(|_| {
        let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join("Documents").join("WinMux Projects")
    });
    let _ = std::fs::create_dir_all(&d);
    d
}
fn recents_file() -> PathBuf {
    config_file().parent().map(|p| p.join("recents.json")).unwrap_or_else(|| PathBuf::from("recents.json"))
}
fn read_recents() -> Vec<Value> {
    std::fs::read_to_string(recents_file()).ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("recents").and_then(|r| r.as_array()).cloned())
        .unwrap_or_default()
}
fn write_recents(list: &[Value]) {
    let file = recents_file();
    if let Some(dir) = file.parent() { let _ = std::fs::create_dir_all(dir); }
    let trimmed: Vec<Value> = list.iter().take(30).cloned().collect();
    let body = serde_json::to_string_pretty(&json!({ "recents": trimmed })).unwrap_or_default();
    let tmp = file.with_extension(format!("{}.tmp", std::process::id()));
    let _ = std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, &file));
}
// Only ever touch a real .json file — reject anything without the extension so a bad
// path can't be steered at an arbitrary host file. Resolves relative -> absolute
// WITHOUT requiring existence (a fresh save names a file that isn't there yet).
fn safe_project_path(p: &str) -> Option<PathBuf> {
    if p.trim().is_empty() { return None; }
    let pb = PathBuf::from(p);
    let abs = if pb.is_absolute() { pb } else { std::env::current_dir().unwrap_or_default().join(pb) };
    if abs.extension().map(|e| e.eq_ignore_ascii_case("json")).unwrap_or(false) { Some(abs) } else { None }
}
fn slugify(name: &str) -> String {
    let kept: String = name.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | ' '))
        .collect();
    let dashed = kept.split_whitespace().collect::<Vec<_>>().join("-").to_lowercase();
    if dashed.is_empty() { "project".to_string() } else { dashed }
}
fn tab_count(layout: &Value) -> u64 {
    let mut n = 0u64;
    if let Some(cols) = layout.get("cols").and_then(|c| c.as_array()) {
        for c in cols {
            if let Some(col) = c.as_array() {
                for pd in col {
                    if let Some(tabs) = pd.get("tabs").and_then(|t| t.as_array()) { n += tabs.len() as u64; }
                }
            }
        }
    }
    n
}
fn project_meta(layout: &Value) -> (String, Vec<String>) {
    let mut dir = String::new();
    let mut shells: Vec<String> = Vec::new();
    if let Some(cols) = layout.get("cols").and_then(|c| c.as_array()) {
        for c in cols {
            if let Some(col) = c.as_array() {
                for pd in col {
                    if let Some(tabs) = pd.get("tabs").and_then(|t| t.as_array()) {
                        for t in tabs {
                            if dir.is_empty() {
                                if let Some(cwd) = t.get("cwd").and_then(|v| v.as_str()) { dir = cwd.to_string(); }
                            }
                            let typ = t.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            if !typ.is_empty() && typ != "terminal" {
                                shells.push(typ.to_string());
                            } else {
                                shells.push(t.get("shell").and_then(|v| v.as_str()).unwrap_or("shell").to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    shells.truncate(6);
    (dir, shells)
}
// GET /api/projects — recents (with missing flags) + the default folder.
async fn api_projects_list() -> impl IntoResponse {
    let list: Vec<Value> = read_recents().into_iter().map(|mut r| {
        let missing = r.get("path").and_then(|p| p.as_str())
            .map(|p| !std::path::Path::new(p).exists()).unwrap_or(true);
        if let Some(o) = r.as_object_mut() { o.insert("missing".into(), json!(missing)); }
        r
    }).collect();
    Json(json!({ "dir": projects_dir().to_string_lossy(), "recents": list }))
}
// GET /api/project?path= — one project's contents.
async fn api_project_get(Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    match q.get("path").and_then(|s| safe_project_path(s)) {
        Some(path) if path.exists() => {
            match std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
                Some(j) => {
                    let name = j.get("name").and_then(|v| v.as_str()).map(|s| s.to_string())
                        .unwrap_or_else(|| path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default());
                    let layout = j.get("layout").cloned().unwrap_or_else(|| j.clone());
                    let modified = j.get("modified").and_then(|v| v.as_u64()).unwrap_or(0);
                    (StatusCode::OK, Json(json!({ "name": name, "layout": layout, "modified": modified })))
                }
                None => (StatusCode::BAD_REQUEST, Json(json!({ "error": "unreadable" }))),
            }
        }
        _ => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
    }
}
// POST /api/project { name, path?, layout } — write the file, upsert recents.
async fn api_project_post(Json(incoming): Json<Value>) -> impl IntoResponse {
    let name = {
        let n = incoming.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled").trim().to_string();
        if n.is_empty() { "Untitled".to_string() } else { n }
    };
    let layout = incoming.get("layout").cloned().unwrap_or_else(|| json!({}));
    let path = incoming.get("path").and_then(|v| v.as_str()).and_then(safe_project_path)
        .unwrap_or_else(|| projects_dir().join(format!("{}.winmux.json", slugify(&name))));
    let now = now_ms() as u64;
    let created = std::fs::read_to_string(&path).ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|j| j.get("created").and_then(|v| v.as_u64()))
        .unwrap_or(now);
    let doc = json!({ "winmuxProject": 1, "name": name, "created": created, "modified": now, "layout": layout });
    if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    let body = serde_json::to_string_pretty(&doc).unwrap_or_default();
    if std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, &path)).is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "write failed" })));
    }
    let (dir, shells) = project_meta(&layout);
    let ps = path.to_string_lossy().to_string();
    let rec = json!({ "path": ps, "name": name, "tabs": tab_count(&layout), "dir": dir, "shells": shells, "opened": now });
    let mut next = vec![rec];
    next.extend(read_recents().into_iter().filter(|r| r.get("path").and_then(|v| v.as_str()) != Some(ps.as_str())));
    write_recents(&next);
    (StatusCode::OK, Json(json!({ "path": ps })))
}
// DELETE /api/project?path=&trash=1 — drop from recents; unlink only with trash.
async fn api_project_delete(Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    match q.get("path").and_then(|s| safe_project_path(s)) {
        None => (StatusCode::BAD_REQUEST, Json(json!({ "error": "bad path" }))),
        Some(path) => {
            let ps = path.to_string_lossy().to_string();
            let kept: Vec<Value> = read_recents().into_iter()
                .filter(|r| r.get("path").and_then(|v| v.as_str()) != Some(ps.as_str())).collect();
            write_recents(&kept);
            let trash = q.get("trash").map(|t| t == "1" || t == "true").unwrap_or(false);
            if trash { let _ = std::fs::remove_file(&path); }
            (StatusCode::OK, Json(json!({ "ok": true })))
        }
    }
}

// ---- /api/clip ----------------------------------------------------------
// Cross-device clipboard (opt-in): POST {text} stores the latest clip in memory,
// GET hands it back — copy on the PC, paste on the phone. Never touches disk;
// size-capped so it can't be used to hoard memory. Allowed over the tailnet by design.
async fn api_clip_get(State(s): State<Arc<AppState>>) -> impl IntoResponse {
    let (text, at) = s.clip.lock().unwrap().clone();
    Json(json!({"ok": true, "text": text, "at": at}))
}
async fn api_clip_post(State(s): State<Arc<AppState>>, Json(body): Json<Value>) -> impl IntoResponse {
    let text: String = body.get("text").and_then(|x| x.as_str()).unwrap_or("").chars().take(100_000).collect();
    let at = now_ms() as u64;
    let len = text.chars().count();
    *s.clip.lock().unwrap() = (text, at);
    Json(json!({"ok": true, "at": at, "len": len}))
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

    let ps = state.clone();
    let pump = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() { break; }
        }
        // Write side is dead: drop the controller and fail any in-flight rpc NOW,
        // so `/rpc` returns "no app connected" fast instead of the 8s timeout when
        // the app disconnects mid-command.
        drop_controller(&ps, id);
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
    // Read side closed (the usual clean-disconnect path): same fast cleanup.
    drop_controller(&state, id);
    pump.abort();
}

// Remove a controller and immediately answer any waiting rpc — with only one
// controller live at a time, its socket dying means nothing can answer.
fn drop_controller(state: &Arc<AppState>, id: u64) {
    state.controllers.lock().unwrap().remove(&id);
    if state.controllers.lock().unwrap().is_empty() {
        let mut pend = state.pending.lock().unwrap();
        for (_, tx) in pend.drain() { let _ = tx.send(json!({"ok": false, "error": "no app connected"})); }
    }
}

// Block until a job reaches a terminal state or the bounded, resumable timeout.
// On timeout it returns the current (working) record so the caller can wait again.
// Lost-wakeup-safe: the Notified future is enabled before each state check.
async fn agent_job_wait(state: &Arc<AppState>, args: &Value) -> Result<Value, String> {
    let job_id = match args.get("jobId").and_then(|v| v.as_str()) { Some(s) => s.to_string(), None => return Err("missing jobId".into()) };
    {
        let m = state.jobs.lock().unwrap();
        match m.get(&job_id) {
            None => return Err(format!("unknown jobId: {job_id}")),
            Some(r) => if r.is_terminal() { return Ok(json!({"job": r.public(), "waited": false})); }
        }
    }
    let timeout_ms = args.get("timeoutMs").and_then(|v| v.as_u64()).unwrap_or(90_000).clamp(500, 570_000);
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let notified = state.job_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();   // register interest before checking, so no wakeup is missed
        {
            let m = state.jobs.lock().unwrap();
            if let Some(r) = m.get(&job_id) { if r.is_terminal() { return Ok(json!({"job": r.public(), "waited": true})); } }
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            let m = state.jobs.lock().unwrap();
            let j = m.get(&job_id).map(|r| r.public()).unwrap_or(Value::Null);
            return Ok(json!({"job": j, "waited": true}));
        }
        tokio::select! {
            _ = &mut notified => {}
            _ = tokio::time::sleep(remaining) => {
                let m = state.jobs.lock().unwrap();
                let j = m.get(&job_id).map(|r| r.public()).unwrap_or(Value::Null);
                return Ok(json!({"job": j, "waited": true}));
            }
        }
    }
}

async fn rpc_post(State(state): State<Arc<AppState>>, Json(body): Json<Value>) -> impl IntoResponse {
    let cmd = match body.get("cmd").and_then(|x| x.as_str()) {
        Some(c) => c.to_string(),
        None => return (StatusCode::BAD_REQUEST, Json(json!({"ok":false,"error":"missing cmd"}))),
    };
    let args = body.get("args").cloned().unwrap_or(json!({}));

    // Agent-job verbs (Stage 3) are handled by the server itself so a wait works
    // with no app attached; everything else is relayed to the app below.
    if cmd == "job-wait" {
        return match agent_job_wait(&state, &args).await {
            Ok(v) => (StatusCode::OK, Json(json!({"ok":true,"result": v}))),
            Err(e) => (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({"ok":false,"error": e}))),
        };
    }
    if let Some(r) = state.agent_job_dispatch(&cmd, &args) {
        return match r {
            Ok(v) => (StatusCode::OK, Json(json!({"ok":true,"result": v}))),
            Err(e) => (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({"ok":false,"error": e}))),
        };
    }

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

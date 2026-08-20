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
    routing::{delete, get, post},
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

// History-persistence switch (readiness #13: saved scrollback is secrets-at-rest —
// tokens and passwords a command printed live in those files). The flag file next
// to the config disables saving; flipping it off also wipes what's already there.
// Default: on (today's behavior).
static HISTORY_OFF: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
fn history_off_flag() -> PathBuf {
    config_file().parent().map(|p| p.join("history-off.flag")).unwrap_or_else(|| PathBuf::from("history-off.flag"))
}
fn wipe_backlog() -> u64 {
    let mut n = 0u64;
    if let Ok(entries) = std::fs::read_dir(backlog_dir()) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().to_lowercase().ends_with(".json") && std::fs::remove_file(e.path()).is_ok() { n += 1; }
        }
    }
    n
}
async fn api_history_get() -> impl IntoResponse {
    Json(json!({"persist": !HISTORY_OFF.load(Ordering::Relaxed)}))
}
async fn api_history_post(Json(body): Json<Value>) -> impl IntoResponse {
    let persist = body.get("persist").and_then(|v| v.as_bool()).unwrap_or(true);
    HISTORY_OFF.store(!persist, Ordering::Relaxed);
    let mut wiped = 0u64;
    if persist {
        let _ = std::fs::remove_file(history_off_flag());
    } else {
        let f = history_off_flag();
        if let Some(d) = f.parent() { let _ = std::fs::create_dir_all(d); }
        let _ = std::fs::write(&f, "off\n");
        wiped = wipe_backlog();
    }
    Json(json!({"persist": persist, "wiped": wiped}))
}

// Persist a session's scrollback so it survives a full process restart. Atomic
// (tmp + rename); dev is empty because the Rust core is loopback-only for now.
fn save_backlog(sid: &str, shell: &str, cwd: &str, buf: &str) {
    if HISTORY_OFF.load(Ordering::Relaxed) { return; }
    let p = match backlog_path(sid) { Some(p) => p, None => return };
    let _ = std::fs::create_dir_all(backlog_dir());
    let body = json!({"id": sid, "dev": "", "shell": shell, "cwd": cwd, "buf": buf, "savedAt": now_ms() as u64});
    let tmp = p.with_extension(format!("{}.tmp", std::process::id()));
    if std::fs::write(&tmp, body.to_string()).is_ok() { let _ = rename_settled(&tmp, &p); }
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

fn instance_path() -> PathBuf {
    std::env::var("WINMUX_INSTANCE_FILE").map(PathBuf::from).unwrap_or_else(|_| {
        let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join(".winmux").join("instance.json")
    })
}

// Windows has no kill(pid, 0). OpenProcess with QUERY_LIMITED_INFORMATION is the
// equivalent question: does a process with this id exist right now?
#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use std::os::windows::raw::HANDLE;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> HANDLE;
        fn CloseHandle(h: HANDLE) -> i32;
    }
    const QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    unsafe {
        let h = OpenProcess(QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() { false } else { CloseHandle(h); true }
    }
}
#[cfg(not(windows))]
fn pid_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

// Who currently owns the instance file — Some(pid, port) if it names a DIFFERENT
// process, on a DIFFERENT port, that is still running.
//
// The port half matters as much as the pid. If the file names the port I just
// bound, that process cannot still be serving it — I hold the socket. That is
// succession (a restart whose predecessor has not been reaped yet), not a rival,
// and treating it as a rival leaves the new server undiscoverable. The danger in
// item 04 is a newcomer on a DIFFERENT port erasing the pointer.
fn instance_owner(file: &PathBuf, my_port: u16) -> Option<(u32, u64)> {
    let txt = std::fs::read_to_string(file).ok()?;
    let j: serde_json::Value = serde_json::from_str(&txt).ok()?;
    let pid = j.get("pid")?.as_u64()? as u32;
    if pid == 0 || pid == std::process::id() { return None; }
    let port = j.get("port").and_then(|p| p.as_u64()).unwrap_or(0);
    if port == my_port as u64 { return None; }
    if !pid_alive(pid) { return None; }
    Some((pid, port))
}

// This file is the ONLY thing that says where the engine holding your shells
// lives. A second engine for the same identity — a misjudged health check, a
// double launch — must not erase it: doing so strands every shell, agent and
// unsaved scrollback on an engine nothing can find or kill. So only claim the
// file when nobody living owns it.
fn write_instance(port: u16) {
    let file = instance_path();
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Some((pid, held)) = instance_owner(&file, port) {
        eprintln!("winmux-core: not claiming {} — pid {pid} still holds it on port {held}. \
                   This engine is on {port} but will stay undiscovered rather than strand that one.",
                  file.display());
        return;
    }
    let body = json!({"port": port, "host": "127.0.0.1", "pid": std::process::id(), "started": now_ms() as u64});
    let _ = std::fs::write(&file, body.to_string());
}

// Same rule leaving: only remove the file if it is still MINE, so a second
// engine quitting cannot take the first engine's pointer with it.
fn release_instance() {
    let file = instance_path();
    if let Ok(txt) = std::fs::read_to_string(&file) {
        if let Ok(j) = serde_json::from_str::<serde_json::Value>(&txt) {
            if j.get("pid").and_then(|p| p.as_u64()) == Some(std::process::id() as u64) {
                let _ = std::fs::remove_file(&file);
            }
        }
    }
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

    mark_started();
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
        .route("/api/workspace", get(api_workspace_get).post(api_workspace_post))
        .route("/api/projects", get(api_projects_list))
        .route("/api/project", get(api_project_get).post(api_project_post).delete(api_project_delete))
        .route("/api/update", get(api_update))
        // Ending a shell must not require a live socket to it — see api_session_delete.
        .route("/api/session", delete(api_session_delete))
        // Desk door only — deliberately absent from phone_router: a phone must
        // never be able to kill the engine under the desktop, reach into this
        // machine's git working tree, or change what it launches at logon.
        .route("/api/shutdown", post(api_shutdown))
        .route("/api/git", get(api_git))
        .route("/api/autostart", get(api_autostart_get).post(api_autostart_post))
        .route("/shells", get(api_shells))
        .route("/api/claude-sessions", get(api_claude_sessions))
        .route("/api/backlog", get(api_backlog).delete(api_backlog_delete))
        .route("/api/history", get(api_history_get).post(api_history_post))
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
        release_instance();
        std::process::exit(0);
    });

    write_instance(port);
    HISTORY_OFF.store(history_off_flag().exists(), Ordering::Relaxed);
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
// With no sid it is the Recent & recoverable list (PT-4, mirrors server.cjs):
// every saved scrollback with its expiry, so nothing ever vanishes silently.
const BACKLOG_MAX_AGE_MS: u64 = 7 * 24 * 60 * 60 * 1000;
async fn api_backlog(State(state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    let sid = q.get("sid").cloned().unwrap_or_default();
    if sid.is_empty() {
        // Bounded like server.cjs: stat-sort everything, parse only the newest 30
        // (each file carries a whole scrollback), report the honest total.
        const LIST_CAP: usize = 30;
        let mut names: Vec<(std::path::PathBuf, String, u64)> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(backlog_dir()) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if !name.ends_with(".json") { continue; }
                let m = e.metadata().ok().and_then(|md| md.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64).unwrap_or(0);
                names.push((e.path(), name, m));
            }
        }
        names.sort_by_key(|(_, _, m)| std::cmp::Reverse(*m));
        let total = names.len();
        let mut items: Vec<Value> = Vec::new();
        for (p, name, m) in names {
            if items.len() >= LIST_CAP { break; }
            let id = name.trim_end_matches(".json").to_string();
            let o = match std::fs::read_to_string(&p).ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .filter(|v| v.is_object()) { Some(o) => o, None => continue };
            // dev is always "" in the Rust core (loopback-only), same as the guard on the per-sid read.
            if !o.get("dev").and_then(|v| v.as_str()).unwrap_or("").is_empty() { continue; }
            let live = state.sessions.lock().unwrap().contains_key(&id);
            items.push(json!({
                "sid": id,
                "shell": o.get("shell").and_then(|v| v.as_str()).unwrap_or(""),
                "cwd": o.get("cwd").and_then(|v| v.as_str()).unwrap_or(""),
                "savedAt": o.get("savedAt").and_then(|v| v.as_u64()).unwrap_or(m),
                "expiresAt": m + BACKLOG_MAX_AGE_MS,
                "live": live,
            }));
        }
        // mtime picked the cheap cap; savedAt orders what the user sees.
        items.sort_by_key(|v| std::cmp::Reverse(v.get("savedAt").and_then(|x| x.as_u64()).unwrap_or(0)));
        return Json(json!({"ok": true, "items": items, "total": total, "maxAgeMs": BACKLOG_MAX_AGE_MS})).into_response();
    }
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

// DELETE /api/backlog?sid= — dismiss a saved scrollback for good (the list's
// second verb; also fired after a successful replay so a delivered backlog never
// lists itself again). Mirrors server.cjs.
async fn api_backlog_delete(Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    let sid = q.get("sid").cloned().unwrap_or_default();
    let ok = backlog_path(&sid).map(|p| std::fs::remove_file(p).is_ok()).unwrap_or(false);
    (if ok { StatusCode::OK } else { StatusCode::NOT_FOUND }, Json(json!({"ok": ok})))
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

// The badge cannot light on a value nobody fetches. Node asks GitHub; this engine
// used to hard-code "no update", so on the build we actually ship the update
// notice could never appear. curl.exe has been in Windows since 1803 and is the
// smallest way to make the same request without pulling an HTTP stack into a
// terminal engine. Cached six hours, exactly like Node, and every failure —
// offline, rate-limited, no curl — falls back to the same honest "no update".
static UPD_CACHE: std::sync::OnceLock<Mutex<Option<(Instant, Value)>>> = std::sync::OnceLock::new();

// WINMUX_UPDATE_API points the same request somewhere else. That is how the
// harness proves this path for real — curl, the JSON parse and the version
// compare all run — instead of short-circuiting on WINMUX_FAKE_LATEST and
// proving only that the short-circuit works.
const UPDATE_API: &str = "https://api.github.com/repos/Zbrooklyn/winmux/releases/latest";

fn fetch_latest_tag() -> Option<String> {
    let api = std::env::var("WINMUX_UPDATE_API").unwrap_or_else(|_| UPDATE_API.to_string());
    let out = std::process::Command::new("curl.exe")
        .args(["-s", "--max-time", "4", "-H", "User-Agent: WinMux",
               "-H", "Accept: application/vnd.github+json", &api])
        .output().ok()?;
    if !out.status.success() { return None; }
    let v: Value = serde_json::from_slice(&out.stdout).ok()?;
    v.get("tag_name")?.as_str().map(|s| s.trim_start_matches('v').to_string())
}

async fn api_update() -> impl IntoResponse {
    let version = env!("CARGO_PKG_VERSION");
    // Test hook: prove the badge lights without publishing a real release.
    if let Ok(fl) = std::env::var("WINMUX_FAKE_LATEST") {
        let fl = fl.trim_start_matches('v').to_string();
        return Json(json!({ "current": version, "latest": fl,
            "updateAvailable": cmp_semver(&fl, version) > 0, "url": UPDATE_URL }));
    }
    let cell = UPD_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(g) = cell.lock() {
        if let Some((at, v)) = g.as_ref() {
            if at.elapsed() < Duration::from_secs(6 * 3600) { return Json(v.clone()); }
        }
    }
    // Off the async runtime's worker: this is a blocking subprocess.
    let latest = tokio::task::spawn_blocking(fetch_latest_tag).await.ok().flatten();
    let out = match latest {
        Some(l) => json!({ "current": version, "latest": l.clone(),
            "updateAvailable": cmp_semver(&l, version) > 0, "url": UPDATE_URL }),
        None => json!({ "current": version, "latest": Value::Null,
            "updateAvailable": false, "url": UPDATE_URL }),
    };
    if let Ok(mut g) = cell.lock() { *g = Some((Instant::now(), out.clone())); }
    Json(out)
}

// The deliberate "quit completely" path (server-host shutdownServer POSTs here,
// same as the Node server). Kill every shell so nothing leaks, answer 200 so the
// caller sees the ack, then exit off the request path.
async fn api_shutdown(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    for (_, s) in state.sessions.lock().unwrap().drain() {
        let _ = s.child.lock().unwrap().kill();
    }
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_millis(150)).await;
        std::process::exit(0);
    });
    Json(json!({ "ok": true }))
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
        // Saved scrollbacks with no live session behind them — the honest count
        // beside `detached` (PT-4). A live session's own current backlog file
        // isn't "recoverable", it's running.
        "recoverable": std::fs::read_dir(backlog_dir()).map(|d| d.flatten()
            .filter(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                n.ends_with(".json") && !state.sessions.lock().unwrap().contains_key(n.trim_end_matches(".json"))
            }).count()).unwrap_or(0),
        // Where this identity's state actually lives on disk — real paths, so the
        // Diagnostics panel and the cheat-sheet "Where your stuff lives" card can
        // answer the question without a docs hunt (PT-7). Parity with server.cjs.
        "workspaceFile": workspace_file().map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "(memory only)".into()),
        "projectsDir": projects_dir().to_string_lossy().to_string(),
        "backlogDir": backlog_dir().to_string_lossy().to_string(),
        "configFile": config_file().to_string_lossy().to_string(),
        "phone": "off",
        "shells": ["powershell", "pwsh", "cmd", "bash", "wsl"],
        "core": "rust",
        // The seven Diagnostics fields this engine used to leave empty. `runtime`
        // is the honest answer to the row Node fills with its own version — there
        // is no Node under this engine, and printing nothing was the bug.
        "runtime": concat!("Rust core ", env!("CARGO_PKG_VERSION")),
        "node": concat!("Rust core ", env!("CARGO_PKG_VERSION")),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "uptime": uptime_secs(),
        "home": std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default(),
        "cpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        "mem": total_mem_gb(),
    }))
}

// ---- machine facts (Diagnostics) ----------------------------------------
// The Diagnostics screen reads eighteen values off /api/info. Seven of them —
// runtime, platform, arch, uptime, home, cpus, mem — were simply absent from
// this engine, so the screen users get sent to when something is wrong printed
// "undefined · undefined" and "NaNm NaNs". These fill them in.
static STARTED: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
fn mark_started() { let _ = STARTED.set(Instant::now()); }
fn uptime_secs() -> u64 { STARTED.get().map(|t| t.elapsed().as_secs()).unwrap_or(0) }

// Total installed RAM, straight from kernel32 — no crate, no shelling out to a
// PowerShell CIM query on the path that renders a diagnostics screen.
#[cfg(windows)]
fn total_mem_gb() -> String {
    extern "system" {
        fn GetPhysicallyInstalledSystemMemory(out_kb: *mut u64) -> i32;
    }
    let mut kb: u64 = 0;
    if unsafe { GetPhysicallyInstalledSystemMemory(&mut kb) } != 0 && kb > 0 {
        format!("{} GB", (kb as f64 / 1048576.0).round() as u64)
    } else {
        "—".into()
    }
}
#[cfg(not(windows))]
fn total_mem_gb() -> String { "—".into() }

// ---- /api/autostart -----------------------------------------------------
// "Start when I log in" is a .vbs in the user's Startup folder. GET reports
// whether it is there; POST {on} writes or removes it. Desk door only — this
// changes what THIS machine launches at logon, which is nothing a networked
// phone should reach in and touch.
fn startup_dir() -> PathBuf {
    if let Ok(d) = std::env::var("WINMUX_STARTUP_DIR") { return PathBuf::from(d); }
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    PathBuf::from(appdata).join("Microsoft").join("Windows")
        .join("Start Menu").join("Programs").join("Startup")
}
fn autostart_file() -> PathBuf { startup_dir().join("WinMux.vbs") }

fn autostart_vbs() -> String {
    // The core is a sidecar: its own exe is winmux-core.exe, which would start a
    // headless server and no window. The Electron shell hands us the app exe.
    let run = std::env::var("WINMUX_APP_EXE").ok()
        .or_else(|| std::env::current_exe().ok().map(|p| p.to_string_lossy().to_string()))
        .unwrap_or_default();
    let quoted = format!("\"{}\"", run).replace('"', "\"\"");   // VBS escapes " as ""
    // The pause lets Tailscale finish coming up before WinMux binds its phone door.
    format!("Dim shell : Set shell = CreateObject(\"WScript.Shell\")\r\n\
             WScript.Sleep 20000\r\n\
             shell.Run \"{}\", 0, False\r\n", quoted)
}

fn autostart_on() -> bool { autostart_file().exists() }

async fn api_autostart_get() -> impl IntoResponse {
    Json(json!({ "on": autostart_on() }))
}

async fn api_autostart_post(body: String) -> impl IntoResponse {
    let want = serde_json::from_str::<Value>(&body).ok()
        .and_then(|v| v.get("on").and_then(|b| b.as_bool())).unwrap_or(false);
    // Report the write honestly. A Startup folder this account cannot write to
    // is exactly the case that used to leave the switch refusing to move with
    // nothing said (item 05 + B17).
    let ok = if want {
        std::fs::create_dir_all(startup_dir()).is_ok()
            && std::fs::write(autostart_file(), autostart_vbs()).is_ok()
    } else {
        match std::fs::remove_file(autostart_file()) {
            Ok(_) => true,
            Err(e) => e.kind() == std::io::ErrorKind::NotFound,
        }
    };
    let code = if ok { StatusCode::OK } else { StatusCode::INTERNAL_SERVER_ERROR };
    (code, Json(json!({ "ok": ok, "on": autostart_on() })))
}

// ---- /api/git -----------------------------------------------------------
// The Changes tab. Same shape the Node engine returns, built from the same four
// git invocations, so the same renderer draws it: {ok, root, branch, files[]}
// where each file carries hunks of ["a"|"d"|"c", text] lines.
fn git_out(args: &[&str], cwd: &str) -> Option<String> {
    let out = std::process::Command::new("git").args(args).current_dir(cwd).output().ok()?;
    if !out.status.success() { return None; }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

fn parse_patch(patch: &str) -> Vec<Value> {
    let mut files: Vec<Value> = Vec::new();
    // Index of the hunk currently being filled, inside the last file.
    let mut hunks: Vec<Vec<Value>> = Vec::new();   // parallel: hunks[i] = file i's hunk list
    let mut open = false;                          // is a hunk currently open?
    for ln in patch.split('\n') {
        let ln = ln.strip_suffix('\r').unwrap_or(ln);
        if let Some(rest) = ln.strip_prefix("diff --git ") {
            let path = rest.rfind(" b/").map(|i| rest[i + 3..].to_string())
                .unwrap_or_else(|| rest.to_string());
            files.push(json!({ "path": path, "st": "M", "add": 0, "del": 0, "hunks": [] }));
            hunks.push(Vec::new());
            open = false;
            continue;
        }
        let Some(f) = files.last_mut() else { continue };
        if ln.starts_with("new file mode") { f["st"] = json!("A"); continue; }
        if ln.starts_with("deleted file mode") { f["st"] = json!("D"); continue; }
        if ln.starts_with("rename to ") { f["st"] = json!("R"); continue; }
        if ln.starts_with("Binary files") { f["binary"] = json!(true); continue; }
        if ln.starts_with("@@") {
            // @@ -<ls>[,n] +<rs>[,n] @@<tail>
            let mut it = ln.splitn(4, ' ');
            let (_, minus, plus) = (it.next(), it.next().unwrap_or(""), it.next().unwrap_or(""));
            let num = |s: &str| s.trim_start_matches(['-', '+'])
                .split(',').next().unwrap_or("0").parse::<i64>().unwrap_or(0);
            if !minus.starts_with('-') || !plus.starts_with('+') { continue; }
            let (ls, rs) = (num(minus), num(plus));
            let tail = ln.find("@@").and_then(|i| ln[i + 2..].find("@@").map(|j| &ln[i + 2 + j + 2..]))
                .unwrap_or("");
            let h = json!({ "h": format!("@@ -{} +{} @@{}", ls, rs, tail), "ls": ls, "rs": rs, "lines": [] });
            hunks.last_mut().unwrap().push(h);
            open = true;
            continue;
        }
        if !open || ln.starts_with("index ") || ln.starts_with("--- ") || ln.starts_with("+++ ") { continue; }
        let hs = hunks.last_mut().unwrap();
        let Some(h) = hs.last_mut() else { continue };
        let mut push = |kind: &str, text: &str| {
            h["lines"].as_array_mut().unwrap().push(json!([kind, text]));
        };
        match ln.chars().next() {
            Some('+') => { push("a", &ln[1..]); let n = f["add"].as_i64().unwrap_or(0); f["add"] = json!(n + 1); }
            Some('-') => { push("d", &ln[1..]); let n = f["del"].as_i64().unwrap_or(0); f["del"] = json!(n + 1); }
            Some(' ') => push("c", &ln[1..]),
            _ => {}
        }
    }
    // Keep the payload sane on very large diffs — same 600-line budget per file
    // the Node engine applies, so the panel never has to render a 40MB response.
    for (i, f) in files.iter_mut().enumerate() {
        let mut budget: i64 = 600;
        let kept: Vec<Value> = hunks[i].drain(..).take_while(|h| {
            if budget <= 0 { return false; }
            budget -= h["lines"].as_array().map(|a| a.len()).unwrap_or(0) as i64;
            true
        }).collect();
        f["hunks"] = Value::Array(kept);
    }
    files
}

async fn api_git(Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    // No folder given → the engine's launch directory (the repo WinMux was
    // started from), never $HOME, which is never a repo.
    let cwd = q.get("cwd").filter(|c| !c.is_empty() && std::path::Path::new(c).exists())
        .cloned()
        .unwrap_or_else(|| std::env::current_dir().map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".into()));
    let Some(root) = git_out(&["rev-parse", "--show-toplevel"], &cwd) else {
        return Json(json!({ "cwd": cwd, "ok": false, "error": "Not a git repository" }));
    };
    let root = root.trim().to_string();
    let branch = git_out(&["rev-parse", "--abbrev-ref", "HEAD"], &cwd)
        .unwrap_or_default().trim().to_string();
    let mut files = git_out(&["diff", "HEAD", "-U3"], &cwd)
        .map(|p| parse_patch(&p)).unwrap_or_default();

    // Untracked files never appear in `git diff`, but they are the change the
    // user is most likely looking for. Show each as an all-added file.
    if let Some(status) = git_out(&["status", "--porcelain"], &cwd) {
        for l in status.split('\n') {
            if !l.starts_with("??") { continue; }
            let rel = l[2..].trim().trim_matches('"').to_string();
            if rel.is_empty() || rel.ends_with('/') {
                if !rel.is_empty() {
                    files.push(json!({ "path": rel, "st": "A", "add": 0, "del": 0, "untracked": true, "hunks": [] }));
                }
                continue;
            }
            let abs = std::path::Path::new(&root).join(&rel);
            let mut body: Vec<Value> = Vec::new();
            if let Ok(md) = std::fs::metadata(&abs) {
                if md.len() < 200 * 1024 {
                    if let Ok(txt) = std::fs::read_to_string(&abs) {
                        if !txt.contains('\u{0}') {
                            body = txt.split('\n').take(400).map(|t| json!(["a", t])).collect();
                        }
                    }
                }
            }
            let hunks = if body.is_empty() { json!([]) }
                else { json!([{ "h": "@@ new file @@", "ls": 1, "rs": 1, "lines": body }]) };
            files.push(json!({ "path": rel, "st": "A", "add": hunks[0]["lines"].as_array().map(|a| a.len()).unwrap_or(0),
                "del": 0, "untracked": true, "hunks": hunks }));
        }
    }
    Json(json!({ "cwd": cwd, "ok": true, "root": root, "branch": branch, "files": files }))
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
        .route("/api/backlog", get(api_backlog).delete(api_backlog_delete))
        // Desk-door only over the tailnet: reading the host disk is refused even
        // with a valid key (#210).
        .route("/api/md", get(phone_denied))
        .route("/api/workspace", get(phone_denied).post(phone_denied))
        .route("/api/findpath", get(phone_denied))
        .route("/api/claude-sessions", get(phone_denied))
        .route("/api/projects", get(phone_denied))
        .route("/api/project", get(phone_denied))
        .route("/api/git", get(phone_denied))
        .route("/api/autostart", get(phone_denied).post(phone_denied))
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
// "There is no config" and "the config is damaged" are completely different
// facts, and treating them the same was destructive: a parse error was swallowed,
// the app started on empty defaults, and the very next settings change wrote onto
// that empty base — silently erasing every imported theme and custom keybinding,
// then answering "saved". This file is explicitly advertised as hand-editable, so
// one stray comma cost the user everything in it. A damaged file is now preserved
// with a timestamp, never overwritten, and the reason is reported.
static CONFIG_TROUBLE: std::sync::OnceLock<Mutex<Option<(String, String)>>> = std::sync::OnceLock::new();
fn config_trouble() -> &'static Mutex<Option<(String, String)>> {
    CONFIG_TROUBLE.get_or_init(|| Mutex::new(None))
}

/// A UTC timestamp a person can read, safe to put in a Windows filename:
/// 2026-08-20T20-39-27Z. Not worth a date crate for one filename, so the
/// civil-date conversion (Howard Hinnant's days-from-civil, inverted) is here.
fn stamp_for_filename() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (days, rem) = ((secs / 86400) as i64, secs % 86400);
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;                                     // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);              // [0, 365]
    let mp = (5 * doy + 2) / 153;                                   // [0, 11], March-based
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{:04}-{:02}-{:02}T{:02}-{:02}-{:02}Z",
        y, m, d, rem / 3600, (rem % 3600) / 60, rem % 60)
}

fn read_config() -> Value {
    let path = config_file();
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return json!({}),   // genuinely no file yet — defaults are correct
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(v) if v.is_object() => {
            if let Ok(mut g) = config_trouble().lock() { *g = None; }
            v
        }
        other => {
            let why = match other {
                Err(e) => e.to_string(),
                _ => "the settings file is not a settings object".to_string(),
            };
            if let Ok(mut g) = config_trouble().lock() {
                if g.is_none() {
                    // The user has to find this file in Explorer, so date it the way
                    // they read dates. An epoch second tells them nothing, and the
                    // Node engine already writes a readable stamp - same name, either
                    // engine, or the instructions we give them only work on one.
                    let backup = path.with_extension(format!("damaged-{}.json", stamp_for_filename()));
                    let moved = std::fs::rename(&path, &backup).is_ok();
                    *g = Some((why, if moved { backup.to_string_lossy().to_string() } else { String::new() }));
                }
            }
            json!({})
        }
    }
}

async fn api_config_get() -> impl IntoResponse {
    let cfg = read_config();
    // If the file was damaged, say so in the same breath as handing over the
    // defaults — otherwise the user just sees their themes and keys gone.
    let trouble = config_trouble().lock().ok().and_then(|g| g.clone());
    match trouble {
        Some((why, backup)) => Json(json!({
            "ok": true, "config": cfg, "configError": why, "configBackup": backup })),
        None => Json(json!({ "ok": true, "config": cfg })),
    }
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
    let ok = std::fs::write(&tmp, cur.to_string()).and_then(|_| rename_settled(&tmp, &file)).is_ok();
    Json(json!({"ok": ok}))
}

// ---- /api/workspace (desk-door only) -------------------------------------
// The live workspace — the always-auto-saved current layout (STATE.md contract,
// PT-3). Same semantics as server.cjs, byte-for-byte on the wire: the file is
// per-identity, derived from the instance file's name (instance.rust.json →
// workspace.rust.json); WINMUX_WORKSPACE_FILE overrides for tests; under
// WINMUX_NO_INSTANCE with no override the workspace is held in memory only so a
// harness never writes into the real ~/.winmux.
fn workspace_file() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("WINMUX_WORKSPACE_FILE") { return Some(PathBuf::from(p)); }
    if std::env::var("WINMUX_NO_INSTANCE").is_ok() { return None; }
    let inst = std::env::var("WINMUX_INSTANCE_FILE").map(PathBuf::from).unwrap_or_else(|_| {
        let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join(".winmux").join("instance.json")
    });
    // A custom WINMUX_INSTANCE_FILE whose name doesn't start with "instance" would
    // make the prefix-swap a no-op — and a workspace write would then CLOBBER the
    // instance file (port/pid discovery). Prefix instead so the two never collide.
    let base = inst.file_name().and_then(|n| n.to_str()).unwrap_or("instance.json");
    let name = if base.starts_with("instance") {
        base.replacen("instance", "workspace", 1)
    } else {
        format!("workspace.{base}")
    };
    Some(inst.parent().map(|p| p.join(&name)).unwrap_or_else(|| PathBuf::from(name)))
}
static MEM_WORKSPACE: std::sync::Mutex<Option<Value>> = std::sync::Mutex::new(None);
fn read_workspace() -> Option<Value> {
    match workspace_file() {
        None => MEM_WORKSPACE.lock().unwrap().clone(),
        Some(f) => std::fs::read_to_string(f).ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .filter(|v| v.is_object()),
    }
}
async fn api_workspace_get() -> impl IntoResponse {
    let doc = read_workspace();
    let ws = doc.as_ref().and_then(|d| d.get("workspace")).cloned().unwrap_or(Value::Null);
    let saved = doc.as_ref().and_then(|d| d.get("savedAt")).and_then(|v| v.as_i64()).unwrap_or(0);
    Json(json!({"ok": true, "workspace": ws, "savedAt": saved}))
}
async fn api_workspace_post(Json(incoming): Json<Value>) -> impl IntoResponse {
    let ws = incoming.get("workspace").filter(|v| v.is_object());
    let Some(ws) = ws else {
        return (StatusCode::BAD_REQUEST, Json(json!({"ok": false})));
    };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64).unwrap_or(0);
    let doc = json!({"winmuxWorkspace": 1, "savedAt": now, "workspace": ws});
    let ok = match workspace_file() {
        None => { *MEM_WORKSPACE.lock().unwrap() = Some(doc); true }
        Some(file) => {
            if let Some(dir) = file.parent() { let _ = std::fs::create_dir_all(dir); }
            let tmp = file.with_extension(format!("{}.tmp", std::process::id()));
            std::fs::write(&tmp, doc.to_string()).and_then(|_| rename_settled(&tmp, &file)).is_ok()
        }
    };
    (if ok { StatusCode::OK } else { StatusCode::INTERNAL_SERVER_ERROR }, Json(json!({"ok": ok})))
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
    let _ = std::fs::write(&tmp, body).and_then(|_| rename_settled(&tmp, &file));
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
// Every durable write here is tmp-file-then-rename, which is what makes it
// atomic. On Windows that rename fails for a few milliseconds while a sync
// client, a search indexer or a virus scanner still has the destination open —
// and a user's project folder is very often a Dropbox or OneDrive folder, so
// this is the normal case, not the exotic one. It is a race, not a permissions
// problem: the identical write succeeds moments later. Retry briefly, and let a
// genuine failure still surface so the caller reports it rather than claiming a
// save that did not happen.
// A delete loses the same race for the same reason, and was never given the same
// patience: remove_file comes back with a sharing violation for a few
// milliseconds while a sync client holds the file it just saw change. One
// attempt meant a user in a Dropbox folder could press Delete on a project and
// be told, correctly but uselessly, that it could not be deleted — and pressing
// it again worked. Same ladder as rename_settled; a genuine failure still
// returns Err so the caller reports it rather than claiming a delete that did
// not happen.
fn unlink_settled(target: &std::path::Path) -> std::io::Result<()> {
    const WAITS: [u64; 6] = [0, 15, 40, 90, 180, 350];
    for (i, ms) in WAITS.iter().enumerate() {
        if *ms > 0 { std::thread::sleep(Duration::from_millis(*ms)); }
        match std::fs::remove_file(target) {
            Ok(()) => return Ok(()),
            Err(e) => {
                if e.kind() == std::io::ErrorKind::NotFound { return Ok(()); }
                let racy = matches!(e.kind(), std::io::ErrorKind::PermissionDenied)
                    || e.raw_os_error() == Some(32)   // ERROR_SHARING_VIOLATION
                    || e.raw_os_error() == Some(5);   // ERROR_ACCESS_DENIED
                if !racy || i == WAITS.len() - 1 { return Err(e); }
            }
        }
    }
    Ok(())
}

fn rename_settled(tmp: &std::path::Path, dest: &std::path::Path) -> std::io::Result<()> {
    const WAITS: [u64; 6] = [0, 15, 40, 90, 180, 350];
    let mut last = None;
    for (i, ms) in WAITS.iter().enumerate() {
        if *ms > 0 { std::thread::sleep(Duration::from_millis(*ms)); }
        match std::fs::rename(tmp, dest) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let racy = matches!(e.kind(), std::io::ErrorKind::PermissionDenied)
                    || e.raw_os_error() == Some(32)   // ERROR_SHARING_VIOLATION
                    || e.raw_os_error() == Some(5);   // ERROR_ACCESS_DENIED
                if !racy || i == WAITS.len() - 1 { return Err(e); }
                last = Some(e);
            }
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("rename never settled")))
}

// Is this file somebody else's project? Free, or holding the same project under
// the same name, means it is ours to write. Anything else — a different name, or
// a file we cannot read well enough to be sure — is not, and we step aside
// rather than overwrite work that is not ours.
fn occupied_by_other(p: &std::path::Path, name: &str) -> bool {
    match std::fs::read_to_string(p) {
        Err(_) => false,                        // missing → free
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Err(_) => true,                     // unreadable → not ours to clobber
            Ok(j) => j.get("name").and_then(|v| v.as_str()).unwrap_or("") != name,
        },
    }
}

async fn api_project_post(Json(incoming): Json<Value>) -> impl IntoResponse {
    let name = {
        let n = incoming.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled").trim().to_string();
        if n.is_empty() { "Untitled".to_string() } else { n }
    };
    let layout = incoming.get("layout").cloned().unwrap_or_else(|| json!({}));
    // Two different project names can slug to one filename — "Client A / Prod"
    // and "Client A Prod" both become client-a-prod. Saving the second used to
    // silently overwrite the first and still report "Project saved". An explicit
    // path means the user picked the file and an overwrite is theirs to make; a
    // name does not.
    let path = match incoming.get("path").and_then(|v| v.as_str()).and_then(safe_project_path) {
        Some(p) => p,
        None => {
            let slug = slugify(&name);
            let mut p = projects_dir().join(format!("{}.winmux.json", slug));
            let mut n = 2;
            while n < 200 && occupied_by_other(&p, &name) {
                p = projects_dir().join(format!("{}-{}.winmux.json", slug, n));
                n += 1;
            }
            p
        }
    };
    let now = now_ms() as u64;
    let created = std::fs::read_to_string(&path).ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|j| j.get("created").and_then(|v| v.as_u64()))
        .unwrap_or(now);
    let doc = json!({ "winmuxProject": 1, "name": name, "created": created, "modified": now, "layout": layout });
    if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    let body = serde_json::to_string_pretty(&doc).unwrap_or_default();
    if std::fs::write(&tmp, body).and_then(|_| rename_settled(&tmp, &path)).is_err() {
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
// DELETE /api/session?sid= — end a shell without needing a live socket to it.
//
// Closing a tab is the one close that should take the shell with it, and the only
// way to say so used to be a message over that tab's own socket. If the socket was
// down — engine restarted, laptop asleep, network blip — the message could not be
// sent and the shell outlived the tab with nothing on screen pointing at it. Ten
// tidied-up tabs meant ten invisible PowerShells.
//
// Desk door only (absent from phone_router, like /api/git and /api/autostart): a
// phone attaches to shells, it does not reach across the network and kill them.
async fn api_session_delete(
    State(state): State<Arc<AppState>>,
    Query(q): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let sid = q.get("sid").cloned().unwrap_or_default();
    let found = state.sessions.lock().unwrap().remove(&sid);
    if let Some(s) = &found {
        let _ = s.child.lock().unwrap().kill();
    }
    // `ended:false` is not a failure — the shell was already gone, which is the
    // outcome the caller wanted. Reported so a check can tell the two apart.
    Json(json!({ "ok": true, "ended": found.is_some() }))
}

async fn api_project_delete(Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    match q.get("path").and_then(|s| safe_project_path(s)) {
        None => (StatusCode::BAD_REQUEST, Json(json!({ "error": "bad path" }))),
        Some(path) => {
            let ps = path.to_string_lossy().to_string();
            let trash = q.get("trash").map(|t| t == "1" || t == "true").unwrap_or(false);
            // Delete first, and only forget the project once the file is really
            // gone. A file another program is holding open (Dropbox, an editor,
            // a virus scan) survives the unlink — dropping the recents row then
            // would tell the user it was deleted while leaving it on disk with
            // nothing left pointing at where it lives. Already-missing counts as
            // deleted; anything else is reported, not swallowed.
            if trash {
                if let Err(e) = unlink_settled(&path) {
                    return (StatusCode::CONFLICT,
                        Json(json!({ "ok": false, "error": format!("could not delete the file ({})", e) })));
                }
            }
            let kept: Vec<Value> = read_recents().into_iter()
                .filter(|r| r.get("path").and_then(|v| v.as_str()) != Some(ps.as_str())).collect();
            write_recents(&kept);
            (StatusCode::OK, Json(json!({ "ok": true, "deleted": trash })))
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

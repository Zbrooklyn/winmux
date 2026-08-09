// WinMux v2 native core — Stage 1 skeleton.
//
// Serves the SAME public/ frontend the Node core serves, and exposes the /pty
// WebSocket the frontend already speaks: query `?shell=&cwd=&sid=`, client sends
// {t:'i',d} input / {t:'r',c,r} resize / {t:'x'} kill, server streams raw PTY
// bytes as binary frames plus one {type:'meta',...} text frame on connect.
//
// This is the renderer-agnostic core from the v2 plan: it streams bytes, any
// shell/browser/phone renders them. Stage 2 ports the rest of the harness surface.

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::Query,
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::SocketAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tower_http::services::ServeDir;

static SID_COUNTER: AtomicU64 = AtomicU64::new(1);

fn new_sid() -> String {
    let n = SID_COUNTER.fetch_add(1, Ordering::Relaxed);
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}{:x}", t, n)
}

// Map a frontend shell key to (exec, args, human label). Mirrors the Node core.
fn shell_cmd(key: &str) -> (String, Vec<String>, String) {
    match key {
        "pwsh" => ("pwsh.exe".into(), vec!["-NoLogo".into()], "PowerShell 7".into()),
        "cmd" => ("cmd.exe".into(), vec![], "Command Prompt".into()),
        "bash" => ("bash.exe".into(), vec!["-l".into(), "-i".into()], "Git Bash".into()),
        "wsl" => ("wsl.exe".into(), vec![], "WSL".into()),
        _ => (
            "powershell.exe".into(),
            vec!["-NoLogo".into()],
            "Windows PowerShell".into(),
        ),
    }
}

fn resolve_public_dir() -> PathBuf {
    // Explicit override wins; else the shared frontend two levels up in the monorepo.
    if let Ok(p) = std::env::var("WINMUX_PUBLIC") {
        return PathBuf::from(p);
    }
    for cand in [
        "../../apps/electron/public",
        "../apps/electron/public",
        "apps/electron/public",
        "public",
    ] {
        let p = PathBuf::from(cand);
        if p.join("index.html").exists() {
            return p.canonicalize().unwrap_or(p);
        }
    }
    PathBuf::from("../../apps/electron/public")
}

#[tokio::main]
async fn main() {
    let public = resolve_public_dir();
    let port: u16 = std::env::var("WINMUX_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(9920);

    let serve = ServeDir::new(&public).append_index_html_on_directories(true);
    let app = Router::new().route("/pty", get(pty_ws)).fallback_service(serve);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    println!(
        "winmux-core: serving {} on http://{}",
        public.display(),
        addr
    );
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(listener, app).await.expect("serve");
}

async fn pty_ws(ws: WebSocketUpgrade, Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_pty(socket, q))
}

async fn handle_pty(socket: WebSocket, q: HashMap<String, String>) {
    let shell_key = q.get("shell").map(|s| s.as_str()).unwrap_or("powershell");
    let (exec, args, label) = shell_cmd(shell_key);
    let cwd = q
        .get("cwd")
        .cloned()
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| {
            std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into())
        });
    let sid = new_sid();

    // Open the PTY and spawn the shell.
    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(p) => p,
        Err(e) => {
            let _ = send_meta_err(socket, &format!("openpty failed: {e}")).await;
            return;
        }
    };

    let mut cmd = CommandBuilder::new(&exec);
    for a in &args {
        cmd.arg(a);
    }
    cmd.cwd(&cwd);
    // Same env hygiene as the Node core: a shell here must be a clean top-level
    // session. Strip the launching process's NO_COLOR (kills all colour) and the
    // CLAUDE_CODE_* / CLAUDECODE markers (make `claude` think it's a child session),
    // then advertise colour.
    cmd.env_clear();
    for (k, v) in std::env::vars() {
        if k == "NO_COLOR" || k == "CLAUDECODE" || k == "CLAUDE_PID" || k.starts_with("CLAUDE_CODE_")
        {
            continue;
        }
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("WINMUX_SID", &sid);

    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            let _ = send_meta_err(socket, &format!("Failed to start {label}: {e}")).await;
            return;
        }
    };
    drop(pair.slave); // parent doesn't need the slave handle once spawned

    let reader = pair.master.try_clone_reader().expect("reader");
    let writer = pair.master.take_writer().expect("writer");
    let master = Arc::new(Mutex::new(pair.master));

    let (mut sink, mut stream) = socket.split();

    // Announce the shell (fresh session) so the tab titles/state settle.
    let meta = serde_json::json!({
        "type": "meta", "sid": sid, "shell": label, "cwd": cwd,
        "resumed": false, "lost": false
    })
    .to_string();
    if sink.send(Message::Text(meta)).await.is_err() {
        return;
    }

    // PTY output -> WS binary frames. The blocking reader lives on a std thread and
    // hands byte chunks to a tokio channel (already coalesced, not per-keystroke JSON).
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let out = tokio::spawn(async move {
        while let Some(bytes) = rx.recv().await {
            if sink.send(Message::Binary(bytes)).await.is_err() {
                break;
            }
        }
        let _ = sink
            .send(Message::Text(
                serde_json::json!({"type":"meta","exited":true}).to_string(),
            ))
            .await;
    });

    // WS input -> PTY. Text control messages {t:'i'|'r'|'x'}.
    let mut writer = writer;
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(t) => {
                let v: serde_json::Value = match serde_json::from_str(&t) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
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
                            let _ = m.resize(PtySize {
                                rows,
                                cols,
                                pixel_width: 0,
                                pixel_height: 0,
                            });
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

    // Client gone or asked to close: tear the shell down.
    let _ = child.kill();
    out.abort();
}

async fn send_meta_err(socket: WebSocket, err: &str) -> Result<(), axum::Error> {
    let mut socket = socket;
    socket
        .send(Message::Text(
            serde_json::json!({"type":"meta","error": err}).to_string(),
        ))
        .await
}

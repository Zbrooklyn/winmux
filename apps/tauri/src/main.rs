// WinMux Tauri — the third side-by-side identity (v2 Stage 5, TS-3/TS-4).
//
// Same contract as the Electron shell's server-host.ts: RESOLVE a detached
// engine (reattach to a live one for THIS identity, else spawn one that
// outlives the window), then open the main window on the engine's UI over
// loopback. Closing the window never kills the shells — session survival is
// the engine's job, the shell is just a face.
//
// Identity: instance.tauri.json / devices.tauri.json under ~/.winmux — disjoint
// from the primary (instance.json) and WinMux Rust (instance.rust.json) apps,
// so all three run at once (Phase 12 coexistence, third column).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

// Bridges the cockpit's window.winmux seam (public/app.js guards every method,
// so this partial shim is safe: pickFile/setQuake absent -> UI falls back).
// Drag: the Electron build uses -webkit-app-region on .ptabs; WebView2 under
// Tauri ignores that CSS, so mousedown on the tab-bar dead space starts a
// native drag, and double-click toggles maximize — same feel as Electron.
const INIT_JS: &str = r#"
(function () {
  if (window.winmux) return;
  function W() {
    try { return window.__TAURI__.window.getCurrentWindow(); } catch (e) { return null; }
  }
  window.winmux = {
    isElectron: false,
    isTauri: true,
    minimize: function () { var w = W(); if (w) w.minimize(); },
    maximize: function () { var w = W(); if (w) w.toggleMaximize(); },
    close: function () { var w = W(); if (w) w.close(); },
    openExternal: function (u) {
      try { window.__TAURI__.opener.openUrl(u); } catch (e) { window.open(u); }
    }
  };
  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    var t = e.target;
    if (!(t && t.closest && t.closest('.ptabs'))) return;
    if (t.closest('.ptab,.pctrls,.wc,.tab-of')) return;
    var w = W(); if (!w) return;
    if (e.detail >= 2) { w.toggleMaximize(); } else { w.startDragging(); }
    e.preventDefault();
  });
})();
"#;

fn winmux_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".winmux")
}

fn instance_file() -> PathBuf {
    winmux_dir().join("instance.tauri.json")
}

// A minimal hand-rolled HTTP GET: the engine answers plain HTTP on loopback and
// /api/info 200 is the same liveness contract server-host.ts pings. A stale
// instance file (dead engine) fails the connect; a port squatted by some other
// process fails the /api/info match.
fn ping(port: u16) -> bool {
    let addr = format!("127.0.0.1:{}", port);
    let Ok(sock) = addr.parse() else { return false };
    let Ok(mut s) = TcpStream::connect_timeout(&sock, Duration::from_millis(800)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_millis(1200)));
    if s.write_all(b"GET /api/info HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_err() {
        return false;
    }
    let mut buf = [0u8; 256];
    match s.read(&mut buf) {
        Ok(n) if n > 0 => String::from_utf8_lossy(&buf[..n]).contains(" 200 "),
        _ => false,
    }
}

fn live_port() -> Option<u16> {
    let txt = std::fs::read_to_string(instance_file()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&txt).ok()?;
    let port = v.get("port")?.as_u64()? as u16;
    if ping(port) { Some(port) } else { None }
}

// Packaged: engine + public/ ride along as bundled resources. Dev (cargo run):
// fall back to the repo's build outputs, same shape as the Electron main.
fn find_engine(resource_dir: &PathBuf) -> Option<(PathBuf, PathBuf)> {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    let engines = [
        resource_dir.join("winmux-core.exe"),
        repo.join("core").join("rust").join("target").join("release").join("winmux-core.exe"),
    ];
    let publics = [
        resource_dir.join("public"),
        repo.join("apps").join("electron").join("public"),
    ];
    let exe = engines.iter().find(|p| p.exists())?.clone();
    let public = publics.iter().find(|p| p.exists())?.clone();
    Some((exe, public))
}

fn resolve_engine(resource_dir: &PathBuf) -> Result<u16, String> {
    if let Some(p) = live_port() {
        return Ok(p);
    }
    let (exe, public) = find_engine(resource_dir)
        .ok_or("winmux-core.exe not found (bundle resources or build core/rust)")?;
    let _ = std::fs::create_dir_all(winmux_dir());
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: the engine outlives this
        // shell — closing the window must never kill the shells inside it.
        std::process::Command::new(&exe)
            .env("WINMUX_INSTANCE_FILE", instance_file())
            .env("WINMUX_TRUST_FILE", winmux_dir().join("devices.tauri.json"))
            .env("WINMUX_PUBLIC", &public)
            .creation_flags(0x0000_0008 | 0x0000_0200)
            .spawn()
            .map_err(|e| format!("engine spawn failed: {e}"))?;
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if let Some(p) = live_port() {
            return Ok(p);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err("engine did not advertise a port within 15s".into())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let resource_dir = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let port = resolve_engine(&resource_dir).map_err(std::io::Error::other)?;
            let url: tauri::Url = format!("http://127.0.0.1:{}/", port)
                .parse()
                .map_err(|e| std::io::Error::other(format!("bad url: {e}")))?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("WinMux Tauri")
                .inner_size(1280.0, 820.0)
                .min_inner_size(720.0, 480.0)
                .decorations(false)
                .initialization_script(INIT_JS)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("WinMux Tauri failed to start");
}

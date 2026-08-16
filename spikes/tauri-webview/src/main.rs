// Stage 0 spike — the one question: can a single Tauri 2 window host BOTH the app
// UI and an embedded, programmatically driven browser pane (Electron <webview>
// parity)? Success = two child webviews in one window, the external one navigated
// and eval'd from Rust, then a clean self-exit. Writes spike-result.txt as proof.
use tauri::{webview::WebviewBuilder, window::WindowBuilder, LogicalPosition, LogicalSize, WebviewUrl};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let window = WindowBuilder::new(app, "main")
                .title("winmux tauri spike")
                .inner_size(1000.0, 640.0)
                .build()?;

            let _shell = window.add_child(
                WebviewBuilder::new("shell", WebviewUrl::App("index.html".into())),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(360.0, 640.0),
            )?;

            let panel = window.add_child(
                WebviewBuilder::new("panel", WebviewUrl::External("https://example.com".parse().unwrap())),
                LogicalPosition::new(360.0, 0.0),
                LogicalSize::new(640.0, 640.0),
            )?;

            // Programmability probe: navigate + eval into the embedded pane.
            let mut panel2 = panel.clone();
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(6));
                let nav = panel2.navigate("https://example.org".parse().unwrap()).is_ok();
                std::thread::sleep(std::time::Duration::from_secs(4));
                let eval = panel2.eval("document.body.style.outline='4px solid #7c5cd6'").is_ok();
                let verdict = format!(
                    "two-webviews-in-one-window: OK\nnavigate-from-rust: {}\neval-from-rust: {}\n",
                    if nav { "OK" } else { "FAILED" },
                    if eval { "OK" } else { "FAILED" }
                );
                let _ = std::fs::write("C:/tools/tauri-spike/spike-result.txt", &verdict);
                std::thread::sleep(std::time::Duration::from_secs(3));
                handle.exit(0);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("spike run failed");
}

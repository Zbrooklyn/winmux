# Stage 0 spike — Tauri as the WinMux shell (verdict: VIABLE, with one caveat)

**Question:** can a Tauri 2 window host an embedded, programmatically driven browser
pane — the Electron `<webview>` parity WinMux's browser panel needs? This was the
go/no-go for v2 Stage 5 (a native shell replacing Electron).

**Result (run 2026-08-16, `spike-result.txt`):**

```
two-webviews-in-one-window: OK
navigate-from-rust: OK
eval-from-rust: OK
```

A single Tauri window hosted the app UI (one webview) and an external page (a second
webview) side by side; Rust navigated the external pane to a different site and
injected JavaScript into it. That is the full capability set the browser panel needs
(navigate / eval covers type/fill/get-text — they are eval compositions).

**The caveat:** child-webview embedding is Tauri's **`unstable` feature flag**. The
API worked first try, but building the product's chrome on an API Tauri itself marks
unstable is a real risk — an upgrade could break the browser panel.

**Recommendation:** Stage 5 is *possible* but not urgent. The shipped Electron shell
on the Rust core (Stage 4, v0.2.0) already removed the Node engine; Electron now
costs only bundle size (~86MB installer) and memory, not correctness. Revisit Stage 5
when Tauri stabilizes multiwebview — the spike here rebuilds in one `cargo build` to
re-verify (icon in `icons/`, runs ~15s, writes `spike-result.txt`, exits itself).

Build/run: `cargo build --release && target/release/winmux-tauri-spike.exe`
(needs the WebView2 runtime, standard on Windows 11).

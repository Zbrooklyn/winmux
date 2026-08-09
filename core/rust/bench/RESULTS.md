# WinMux engine benchmark — Node vs Rust core

Same Electron shell, same PowerShell shell; the only variable is the backend engine.
Run: `node core/rust/bench/bench-cores.mjs` (boot/memory/latency) and
`node core/rust/bench/bench-throughput.mjs` (4 MB bulk dump). Requires a release
build of winmux-core (`cargo build --release`).

Measured 2026-08-09 (medians; boot = median of 5 cold spawns):

| Metric | Node engine | Rust core | Result |
|---|---|---|---|
| Startup (spawn → serving) | 283 ms | 34 ms | Rust ~8x faster |
| Idle memory (backend RSS) | 88 MB | 7 MB | Rust ~12x lighter |
| Keystroke latency (RTT) | 3.8 ms | 2.9 ms | tie — both instant |
| Bulk output (4 MB dump) | 4.0 MB/s | 4.0 MB/s | tie — ConPTY/shell-bound |

Startup and memory are large, real engine wins. Latency and throughput are ties
because both are bottlenecked upstream (ConPTY + the shell), which both engines share.
The on-screen "native feel" is identical between the two builds — same Electron window.
A genuinely native window is Stage 5 (Tauri), not yet built.

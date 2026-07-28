# WinMux

A terminal multiplexer for Windows. One Node server (`server.cjs`, node-pty + ws) spawns real
PowerShell / CMD / Git Bash / WSL shells and streams them over a websocket to an xterm.js cockpit.
The same server has three faces:

- **Desktop app** — a native Windows window (Electron) wrapping the cockpit.
- **Browser** — open the served URL on this PC.
- **Phone** — reach the same shells from your phone over Tailscale, with a per-link access key.

All three are clients of **one** in-process server, so what you start at your desk is the same
session you pick up on your phone.

## Run it

### As a desktop app (Electron)

    npm install
    npm run dev:electron

This opens WinMux in a frameless native window. The same server still serves your phone over
Tailscale — the desktop app and the phone are two clients of one server.

### As a plain server (browser + phone)

    npm install
    npm start

Then open the printed `http://127.0.0.1:<port>` in a browser. Turn on phone access in
Settings → Phone to get a Tailscale link + QR for your phone.

## Verify

    npm run verify

A zero-argument Playwright harness (`verify.cjs`) that starts its own servers, drives the real
cockpit, and asserts measured behaviour — including an offscreen Electron smoke check that boots
the desktop shell and confirms the cockpit renders in the native window. Screenshots land in
`verify-out/`.

## License

MIT.

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

## Drive it from the command line

With WinMux running, the `winmux` command scripts the live app:

    winmux status                   # the running server + fleet (sessions, phone)
    winmux list                     # the open terminals
    winmux new-tab                  # open a tab in the active pane
    winmux split down               # split the active pane
    winmux send "Get-Date" --enter  # type into the active terminal and run it
    winmux read-screen --lines 40   # read what's on screen
    winmux browser open example.com # open the browser panel (desktop app)
    winmux browser snapshot         # list the page's clickable elements as @refs
    winmux browser click @e1        # click one of them
    winmux markdown README.md       # open a file in the live markdown viewer
    winmux open workspace.json      # open a saved set of terminals (cwd/shell/command each)

An agent (e.g. Claude) can use these to open terminals and run tools for you.
The browser panel is the desktop app's Electron `<webview>`; the markdown viewer
follows the file live as it's written.
It works only at the PC (127.0.0.1), never over the phone link.

## Verify

    npm run verify

A zero-argument Playwright harness (`verify.cjs`) that starts its own servers, drives the real
cockpit, and asserts measured behaviour — including an offscreen Electron smoke check that boots
the desktop shell and confirms the cockpit renders in the native window. Screenshots land in
`verify-out/`.

## License

MIT.

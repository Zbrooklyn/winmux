# Contributing to WinMux

Thanks for taking the time to help. This guide covers how the repo is laid out, how to run
it, and what a good pull request looks like.

## Repo layout

WinMux is a monorepo with two self-contained stacks:

- `apps/electron/` is the shipping app: the Node server (`server.cjs`), the vanilla-JS cockpit
  (`public/`), the Electron shell, the `winmux` CLI, and the `verify.cjs` harness. This is its
  own npm project, and almost all work happens here.
- `core/rust/` is the v2 native core (Rust/Cargo), kept at feature parity with the Node engine.

Run every app command from `apps/electron/` (for example `cd apps/electron && npm run verify`).

## Getting set up

```powershell
cd apps/electron
npm install
npm run dev:electron
```

That launches the desktop app. `npm start` runs it as a plain server you can open in a browser
or reach from a phone over Tailscale.

## The harness is the contract

WinMux ships with a zero-argument verification harness. Before you open a pull request, run it
and keep it green:

```powershell
cd apps/electron
npm run verify
```

`verify.cjs` starts its own servers, drives the real cockpit, and asserts measured behavior
(computed styles, box metrics, real terminal output) across desktop, phone, dark, and light. If
you change rendered output, add or update the relevant check rather than working around it.

## House rules

- Do not edit `public/cockpit.css`. It is the frozen design contract. New styling belongs in the
  `index.html` override layer.
- Match the existing style and structure. WinMux favors small, reversible changes over broad
  refactors.
- Frontend changes need a screenshot in the pull request, at the surfaces they touch.

## Opening a pull request

1. Branch from the default branch.
2. Make your change and keep `npm run verify` green.
3. Describe what changed and why, link any related issue, and attach screenshots for UI work.

## Reporting bugs and requesting features

Open an issue using the templates. For bugs, the built-in diagnostics (Settings, or the copy-logs
action) gives you the details worth pasting in.

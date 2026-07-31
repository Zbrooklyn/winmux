# WinMux MCP server

`winmux-mcp` lets an MCP client — Claude Code, or anything that speaks the
[Model Context Protocol](https://modelcontextprotocol.io) — drive a running
WinMux instance natively: list sessions, read a terminal's screen, type into a
shell, open tabs and splits, flag a session for attention, and drive the browser
and markdown panels.

It is a thin stdio adapter over the same `/rpc` surface the `winmux` CLI uses, so
there is nothing to configure while WinMux is running — it discovers the live
instance from `~/.winmux/instance.json`. There is no extra dependency; the MCP
stdio transport (newline-delimited JSON-RPC 2.0) is implemented directly.

## Add it to Claude Code

Put this in your project's `.mcp.json` (or your user MCP config):

```json
{
  "mcpServers": {
    "winmux": {
      "command": "winmux-mcp"
    }
  }
}
```

If `winmux-mcp` isn't on your PATH (you're running from source, not an install),
point at the file directly:

```json
{
  "mcpServers": {
    "winmux": {
      "command": "node",
      "args": ["C:/path/to/winmux/bin/winmux-mcp.cjs"]
    }
  }
}
```

Target a specific instance with env vars (same as the CLI): `WINMUX_PROFILE=dev`
for the dev copy, or `WINMUX_PORT` / `WINMUX_HOST` to pin one exactly.

## Tools

| Tool | What it does |
|---|---|
| `winmux_list` | List open sessions (id, title, shell, cwd, active). |
| `winmux_read_screen` | Read a terminal's visible text (`id`, `lines`). |
| `winmux_send` | Type `text` into a terminal (`id`, `enter`). |
| `winmux_new_tab` | Open a new tab (`shell`). |
| `winmux_split` | Split the active pane (`dir`: right/down, `shell`). |
| `winmux_focus` | Focus a terminal by `id`. |
| `winmux_notify` | Flag a session as needing you (`message`, `id`). |
| `winmux_browser` | Drive the browser panel (`sub`: open/snapshot/click/…). |
| `winmux_markdown` | Open a markdown file in the viewer (`path`). |

If WinMux isn't running, a tool call returns a clear "WinMux is not running"
error rather than hanging.

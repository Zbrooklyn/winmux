# WinMux Sidebar Tabs — make the sidebar act like a sidebar

Date: 2026-08-16 · Edward: "I don't think the sidebar is acting like a sidebar… the whole point of the sidebar is that I can have multiple tabs within the sidebar, similar style to Obsidian, but I don't think we did that."

## Frame (before any pixel)

- **Purpose:** one left rail that hosts several switchable panels — the Obsidian left-sidebar model Edward set as the north star on 2026-07-17 (left sidebar → tabs → splittable center → right dock).
- **Viewer / moment:** Edward at the desktop app, glancing left to answer "what's running / what can I open / what happened," without overlays popping over his terminals.
- **Real size:** ~264px wide column, full window height, dark theme first.
- **What it sits beside:** the tab strip + terminals on the right; the phone drill-in flow (SETTLED — untouched).
- **Host rules:** Obsidian's own pattern — a slim icon strip at the top of the sidebar switches panels; the panel fills the rest; the sidebar is drag-resizable and collapsible. Edward's laws: flat & tight, one bar per region, calm surface. His 2026-07-19 rule "no rail unless 3+ distinct left views" is now met by his own ask — and by the fact we already HAVE three left views living in the wrong places.
- **No net-new features:** every tab re-houses an existing surface. The tab SYSTEM is the deliverable; panels plug in later (agents, search) with one entry each.

## The three tabs (all existing surfaces, re-housed)

1. **Sessions** — today's whole sidebar: fleet deck (Working / Needs you / Idle) + groups/sessions list. Unchanged content, now one panel among peers.
2. **Projects** — the saved-projects list that today hides behind the footer "Open project" popover. Same data (`Projects.list` recents), rows open on click; the popover stays for the footer flow (harness + muscle memory), the tab is the browsable home.
3. **Notifications** — today a floating dropdown over the terminal. Becomes the third panel; the bell icon (with unread badge) IS its tab. `#npanel` + `#open-notif` ids and data-open semantics survive so the notify/click-to-jump machinery and harness hooks keep working.

Top strip also carries (right-aligned, quiet): the update badge and the palette button — the two things the old `.sx-head` held that aren't panels. The "Groups · N" header moves INTO the Sessions panel as its slim section row (Obsidian panels have their own thin header row; the strip stays pure).

## Units

- **SB-0** — this plan.
- **SB-1 — Tab architecture.** `.sx-tabs` icon strip (Sessions / Projects / Bell), panel container, active-tab state persisted in settings (`sidebarTab`), keyboard/aria (role=tablist). Sessions panel = existing deck+list. Desktop + half modes only; narrow keeps its settled drill-in.
  **Done:** clicking icons swaps panels ≤1 frame; state survives reload; harness `sidebar-tabs` check green; phone checks untouched and green.
- **SB-2 — Projects panel.** Renders the recents list (name · path · N tabs), click opens the project (same openSavedLayout path as the popover), missing ones shown dimmed. Empty state sentence.
  **Done:** a saved project opens from the panel; list refreshes on save/close; footer popover unchanged and its check green.
- **SB-3 — Notifications panel.** npanel content renders inside the sidebar panel; bell tab shows the unread badge; opening the tab clears unread; click-to-jump still focuses the right session. Ctrl+Alt+N toggles the tab.
  **Done:** `notify` + `osnotify` checks green; badge/jump behavior proven.
- **SB-4 — Resizable sidebar.** Drag handle on the sidebar's right edge; width clamped (200–420px), persisted (`sidebarWidth`), double-click resets. The collapse toggle (.pc-rail) unchanged.
  **Done:** drag resizes live at 60fps feel; width survives reload; clamp holds.
- **SB-5 — Verify + ship.** New `sidebar-tabs` harness check (switch, persist, resize, notif badge); full harness green both engines; desktop screenshots (dark + light, each tab) to Edward.
  **Done:** 444+N/444+N both engines; screenshots delivered; Edward's eye is the design acceptance.

## Boundaries

- Phone/narrow flow is SETTLED — zero changes below 620px; the tab strip is display:none on narrow.
- No feature invention: no search panel, no agents panel yet — the system makes them one-entry additions when Edward asks.
- The footer bar, save/load popover, palette, and all keyboard paths keep working exactly as before.
- Design acceptance is Edward's (screenshots); mechanics are measured (computed widths, panel swap timing), not eyeballed.

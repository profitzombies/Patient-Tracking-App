---
name: Conversation inbox notes side panel
description: Layout contract for the staff inbox thread view — white thread column plus a separate internal-notes panel; who may write notes.
---
**Rule:** the thread viewer is three surfaces — gray list pane, white thread column (composer inside it), and a separate white internal-notes panel with a divider (docked at lg+, overlay below lg, toggled from the header). Notes never render as a card inside the scrolling thread.

**Why:** the owner rejected the inline notes card ("two columns but no divider", gray chat, odd padding) and asked for a white side panel.

**How to apply:** reuse the shared panel/toggle/hook for any new thread surface. HQ (drill-in or /admin) never gets a note composer on ANY thread kind — gate on the HQ flag, not on thread type (AI-thread notes are writable server-side, so a thread-typed gate leaks). The back-to-list control's breakpoint must match the list pane's `hidden lg:flex`; a `md:hidden` back button left md–lg widths with no way back. Overlay mode moves focus to the close button, Escape closes, and closing restores focus to the toggle.

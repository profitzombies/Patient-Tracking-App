---
name: Unicode in authored TSX
description: \uXXXX escapes written into JSX text render literally — write real characters when generating files
---

# Unicode escapes in authored TSX/JSX

`\uXXXX` sequences are only escapes inside JS **string literals**. In JSX *text children* (`<p>Ready \u2014 5 docs</p>`) they are plain characters and render literally on screen as `\u2014`.

**Why:** an entire generated admin page shipped with literal `\u2014`/`\u2026` visible in the UI; typecheck and build were green — only a visual pass caught it.

**How to apply:** when generating .tsx/.jsx (or any markup) with file tools, write the actual characters (—, …, ·, curly quotes), not escape sequences. If a file was already written with escapes, a targeted perl/sed pass converting `\uXXXX` → real chars fixes it wholesale; re-render or screenshot to confirm.

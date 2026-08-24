---
name: URL-persisted admin filters
description: Pattern for HQ operations pages that keep search/filter/selection state in the URL (wouter), verified safe per-keystroke.
---
Treat the query string as the single source of truth for page UI state (filter / selection / search params rebuilt through one buildUrl helper; the search input's value IS the parsed param — no mirrored React state).

**Why:** reload and shared links must restore the full view, and duplicated state drifts from the URL. Verified on the HQ conversations page: per-keystroke navigate(..., { replace: true }) causes no input focus loss (the input never remounts) and no scroll reset — AdminShell's scroll-to-top effect keys off wouter's useLocation, which returns only the path, so query-only changes never retrigger it.

**How to apply:** replace-navigate for filter/search edits; push only for opening a selection so Back feels right. A filter change drops the selection param (it may no longer be in scope) but keeps the search. Unknown ids from stale links fall back to the unfiltered view. Same pattern fits other HQ pages that must keep filters across refresh/share.

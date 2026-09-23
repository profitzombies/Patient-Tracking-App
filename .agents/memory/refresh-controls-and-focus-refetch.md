---
name: Refresh controls & stale-on-focus refetch
description: Lessons from adding header Refresh / pull-to-refresh to order screens on web (React Query) and mobile (RN RefreshControl under the Node stubs).
---

## React Query flags data invalidated after a background error
In @tanstack/query-core 5.x, a failed *background* refetch (data already present) sets `state.isInvalidated = true`. The next window focus therefore refetches even when `dataUpdatedAt` is well inside `staleTime`.

**Why:** a "fresh data does not refetch on focus" check placed after a failed-refresh check fails with an off-by-one request count that looks like a staleTime bug. It is library behaviour, and desirable: a failed manual refresh is retried on the next focus.

**How to apply:** in suites, prove the stale-window rule (fresh → no refetch, `setQueryData(..., { updatedAt: old })` → refetch) *before* the failure case; treat post-failure focus refetches as expected.

## Refresh semantics chosen (keep consistent)
- Refresh = `refetch` of the screen's active reads via our API only; failures keep the last good data, raise a non-blocking toast/snackbar and a screen-reader announcement; the error box appears only when there is no data.
- Demo persona: the control animates for ~500 ms, fetches nothing, announces "preview is up to date".
- Mobile office refresh refetches every active query under the office-billing key (status + list), and the billing hooks' transient-retry rule (two retries on non-403/401/402) multiplies request counts in suites: one failed refresh = three attempts.

## RN stub gotcha
The Node react-native stub's ScrollView must render `refreshControl` as a child (as real RN does) rather than leaving the element in host props; otherwise `renderer.toJSON()` throws "Converting circular structure to JSON" in any suite that snapshots a screen with pull-to-refresh.

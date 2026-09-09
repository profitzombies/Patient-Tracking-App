---
name: Live/demo UI isolation
description: Rules for keeping THINNR's seeded guided demo separate from authenticated live operations data.
---

Choose the data world at the outer UI boundary: signed-out guided-demo sessions may use seeded data, while signed-in sessions must use live data or an explicit denied/loading/error state. Never select seeded data because a live response is absent.

**Why:** Seeded THINNR data is realistic enough that an outage can look like a healthy live dashboard. A missing request once produced green “all current” and zero-open badges, and permission mismatch once exposed demo files to a signed-in role.

**How to apply:** Enable live queries only for eligible signed-in sessions. Keep demo branches signed-out-only. Treat derived counts as unavailable until every required live source succeeds, including headline badges. Browser-check that demo sessions issue no live requests.

Identity-scoped query keys require identity-bound requests, including token-refresh retries. Never let an old query adopt the current account's bearer after a sign-in switch. Reset patient-specific modal state with the account as well as patient identity.

**Why:** A pending request can return 401 after account A switches to B. Refreshing the current session then caches B's patient data under A's key, exposing it when A returns. Cache key isolation alone does not prevent this.

**How to apply:** Capture the query owner's identity, check it before and after token refresh, and cancel unmounted reads. Test a held 401 through A → B → A, not only a successful fetch followed by logout.
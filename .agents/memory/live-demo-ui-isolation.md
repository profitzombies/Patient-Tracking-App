---
name: Live/demo UI isolation
description: Rules for keeping THINNR's seeded guided demo separate from authenticated live operations data.
---

Choose the data world at the outer UI boundary: signed-out guided-demo sessions may use seeded data, while signed-in sessions must use live data or an explicit denied/loading/error state. Never select seeded data because a live response is absent.

**Why:** Seeded THINNR data is realistic enough that an outage can look like a healthy live dashboard. A missing request once produced green “all current” and zero-open badges, and permission mismatch once exposed demo files to a signed-in role.

**How to apply:** Enable live queries only for eligible signed-in sessions. Keep demo branches signed-out-only. Treat derived counts as unavailable until every required live source succeeds, including headline badges. Browser-check that demo sessions issue no live requests.
---
name: UTC instants on staff screens
description: Server asOf/ISO timestamps must be rendered in the device timezone on signed-in web surfaces; never slice the ISO string for the date.
---

Rule: on signed-in (live) operations screens, format server timestamps through the operations app's shared device-local helpers, never `iso.split('T')[0]` + a date-key formatter.

**Why:** The API stamps `asOf: new Date().toISOString()` (UTC). Slicing the string shows the UTC calendar day, which is already "tomorrow" for US viewers every evening after ~8 PM ET — the owner saw "Sep 15" at 11:19 PM on Sep 14. Live greetings were also hard-coded "Good morning". The demo persona is different: it stays on the fixed anchor date and fixed greeting on purpose (cross-artifact seed parity).

**How to apply:** any new live tile/header that shows "as of"/"updated" — format the instant in the device timezone; salutations follow the local hour and re-tick. Keep the TZ-matrix regression (NY/LA/UTC/Tokyo) green when touching it.

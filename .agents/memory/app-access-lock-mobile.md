---
name: Patient app-access lock (mobile)
description: How the patient app honors the office's premium AI charge — reader, one sheet, entry-point gates, terminal 402, pause precedence, and the Node suite recipe.
---
# Patient app-access lock in the mobile app

**Rule:** the server owns the entitlement; the app only reads it. An unknown/failed read is
never a lock (fail-soft like the coach availability probe). A premium request that still
reaches the server answers 402 `upgradeRequired` — treat it as terminal (withdraw the waiting
bubble, no retry chip), report it to the one app-access seam, which locks immediately, opens
the sheet, and re-reads for the checkout link.

**Why:** leadership wanted the lock to feel fair: nothing disappears from navigation, non-AI
features keep working, and infra trouble must never lock a paying patient out.

**How to apply:**
- Gate only at entry points (coach seat, composer send/sendPhoto, meal photo start, menu-scan
  pick/scan, barcode lookup). Screens stay mounted and reachable; the sheet is the reply.
- HQ coach pause keeps precedence wherever `coachPaused` is meaningful (tab bar, chat, meal
  photo): paused + locked shows the pause notice, never the upgrade sheet. Menu/label/barcode
  gate on the lock alone.
- Reads: open, account change (epoch-guarded + abort), AppState `active`, after a 402 report,
  after the in-app browser resolves. Lock lifting closes the sheet by itself.
- Ending-soon notice: only inside the last 3 days of an OPEN chargeable window with a price;
  `office_charges:false` with a stale price on file still earns nothing (both the notice and the
  price line check the flag — tests pin the behavior, not one guard).
- Screens whose hooks sit below a persona early-return must not add hooks there (menu-scan had
  a latent `useCallback` after `return null`; async mode hydration in a suite trips it).

**Suite recipe:** test the real provider alone under a fake `PatientAccountContext.Provider`
(getAccessToken scripted); test screens under a fake `AppAccessContext.Provider` value that
records sheet/report calls. Hold the app-access responder (deferred promise) to assert the
"meanwhile" state after a 402 report, otherwise the re-read lands inside the same settle. Flip
`Platform.OS` to `'ios'` just around the checkout tap so the expo-web-browser stub records the URL.

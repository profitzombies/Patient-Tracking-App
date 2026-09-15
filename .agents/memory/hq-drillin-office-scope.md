---
name: HQ drill-in office scope on shared office screens
description: Any office screen mounted under the HQ drill-in must send the explicit office id and hide server-forbidden HQ writes.
---
Rule: every office self-service request made from a screen that can render under `/admin/accounts/:id/office/...` must carry the drilled-in office id (`useLiveOfficeScope().liveOffice` → `?office=`). Signed-in office staff send nothing (server derives the office). Query keys must include that id so switching accounts never reuses cache.

**Why:** the server's office-scope resolver answers 400 `office_required` for HQ callers without the param. The Conversations inbox was built office-staff-only and silently broke under the drill-in ("Failed to load conversations" / "Inbox metrics could not be loaded"). Sibling screens (roster, files) already passed the id; the inbox did not.

**How to apply:** when adding or touching an office screen, grep for `liveOffice` usage; if the screen issues live requests without it, it is broken for HQ. Also mirror server denials in the UI: HQ care-team access is read-only (start/reply/assign/status/notes → 403), so hide those controls under `hqDrillIn` rather than surfacing error toasts. New office routes need the `OfficeId` query param in openapi (and an entry in `lib/api-spec/fix-zod-parameter-type.mjs` when the op also has path params, or codegen's barrel fails on a duplicate name). OfficeDrillIn must hold a blank frame while the HQ accounts list is loading; redirecting on "account not found" alone bounces direct loads/refreshes to the list.

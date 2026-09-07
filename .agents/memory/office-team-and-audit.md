---
name: Office team roles and office audit read layer
description: Decisions behind office-scoped staff administration (owner/admin/staff) and the office vs HQ audit views; how to test them without a DOM.
---

## Office role model
- `team_members.office_role` (owner/admin/staff) is separate from the coarse profile role. Manage-team rights = owner or admin; only owners may touch owner rows; nobody edits their own row; the last active owner is guarded in the DB RPCs (409 at the API), not just the UI.
- Deactivation is fail-closed at the scope resolver: the DB helper returns null for disabled members, the resolver answers an explicit 403 and records an `access_denied` audit event. Reactivation upserts the role assignment back; no re-provisioning.
- **Why:** offices needed self-service without giving HQ-team semantics to every office; a DB-level owner guard survives any future client.
- **How to apply:** new office-scoped routes must go through the shared scope resolver + `respondOfficeScopeDenied` (test mocks of the scope module must spread `importOriginal`, or the denial helper is undefined and routes 500).

## Audit read layer
- One app-side action allowlist, a fixed metadata key allowlist, and an explicit office-visible subset; the DB does not validate actions. Names (actor/office/target) are resolved server-side in the read routes; the office view never carries raw ids, HQ shows ids as fine print only.
- Training publish/unpublish/delete audit rides a DB trigger (cascade deletes bypass route code). Exports were already audited; no inbox/staff-reply routes exist yet to instrument.
- Session invalidation outcome (`complete|failed|not_applicable`) is part of the mutation response so the UI can word toasts honestly.

## Testing without a DOM
- Radix Select/Dialog/AlertDialog need a document; the operations regression suites map them to `scripts/office-admin-stubs/*` via a dedicated tsconfig. Stub AlertDialogAction must receive an event object (`{ preventDefault(){} }`); submit buttons have no onClick — fire the enclosing form's onSubmit. Files under scripts/ need an explicit `import * as React` (tsx does not apply the automatic JSX runtime to files outside tsconfig include).
- react-query retry back-off (1s+2s) means non-permission error states need ~3.5s of settle and one scripted response per attempt.
- Node: `new Response("", { status: 204 })` throws; use `null`.
- Supabase management API runs as postgres: probe RLS-aware helpers with `set_config('request.jwt.claims','{"role":"service_role"}',true)`.

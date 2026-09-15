---
name: HQ private file drive
description: Non-obvious rules for the HQ Files drive (folders, compression, archive, replace, previews), the provider read-only layer, and how to e2e it.
---

**Compression is opportunistic, not guaranteed.** Server-side lossless/near-lossless re-encode is kept only when strictly smaller; noisy or already-optimized images show no "was X" note. A missing savings note is not a bug — prove the path with a bloated fixture (PNG at compressionLevel 0), not a small or noisy one.

**Replace is a compare-and-swap.** Replacement writes a NEW object path, then PATCHes the row guarded by the old `object_path` + `updated_at`; an empty match means someone else replaced/renamed first → delete OUR candidate object, 409, never touch the old path. **Why:** two racing replacements otherwise both delete the same prior object and orphan one upload.

**Every HqFile response resolves `uploadedBy` and `path`.** Single-row responses (finalize, replace, PATCH) must go through the same enrichment as listings; the detail dialog treats a missing path as root and the client overwrites its selected file with mutation responses. **Why:** a Replace once flipped "Uploaded by" to Unknown because the one-row DTO skipped the membership lookup.

**Archived rows stay real.** `archived_at` hides a file from folder listings and search only; folder subtree delete and storage reconciliation must keep seeing archived rows. Restore into a deleted folder lands at the root.

**Inline previews ride a bearer route, not signed URLs.** Stored objects carry an `attachment` disposition (downloads), so previews use `/content` (inline, private/no-store, nosniff, bounded read) fetched to a blob URL — same pattern as the bloodwork viewer. Accepted types exclude HTML/SVG on purpose.

**Delete dialogs must hold a pending state.** Keep the AlertDialog open ("Deleting…", preventDefault on the action) until the mutation settles, then close BEFORE toasting and keep the last name in a ref so the close animation doesn't render a blank quote. **Why:** the tester read an instant-close + late toast as "delete did nothing" although the DB row was gone.

**Tester login for HQ.** A throwaway HQ member needs an `active` membership with `auth_user_id` set (or a pending invitation) or the neutral login-start returns a decoy request id and looks like a persistence bug. Tester short-wait (≤700 ms) "no change" claims after multi-object deletes need a DB check before believing them.

**Providers get the whole drive, read-only, through office routes.** Owner decision: "only actual file management can be done from the admin HQ; providers can search, download, and view." Office `/office/files*` routes are GET-only, share the HQ read helpers with `includeArchived: false`, and 404 archived rows; HQ drill-in through the office routes still requires `settings_manage`. Enforcement is route-level because the file tables grant only service_role (no RLS to widen). **How to apply:** new HQ-drive read behaviour goes in the shared read module so both surfaces stay identical; never add a mutation to the office router. Provider previews audit as `hq_file_previewed`, explicit downloads as `hq_file_downloaded` (HQ's own reads are not audited).

**Signed download URLs open in a NEW tab.** Viewable types (txt/pdf/images) render inline from a signed GET, so `location.assign` ejected the user from the app. `window.open(url, "_blank", "noopener")` returns null in some browsers even when the tab opened — open a blank tab, null its opener, then set href; only assign in place when the popup was truly blocked.

**Office-staff tester fixture for this page:** throwaway `providers` row needs `plan` in (Core/Plus/Concierge); `patients` needs explicit `id`/`created_at`/`updated_at`; `hq_file_folders`/`hq_private_files` need `created_by` = a real HQ auth user id.

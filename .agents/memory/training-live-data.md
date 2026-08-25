---
name: Training live-data patterns
description: Patterns behind the HQ training portal's Supabase layer — flat rows + client assembly, position re-sync, progress as row∩order, demo read-only guard.
---

The training portal reads flat Supabase rows (courses/modules/subgroups/videos/viewers/completions) and assembles the nested course model client-side; one react-query snapshot feeds all pages.

**Rules that keep it truthful:**
- **Positions are contiguous per container** (module list, module entry space where root videos and subgroups share slots, subgroup video list). Every structural mutation (add/move/reorder/ungroup/delete) re-syncs positions by diffing `collectPlacements(course)` against the DB instead of patching one row — partial updates leave gaps/dupes that make assembly order ambiguous. The invariants suite pins `collectPlacements ∘ assembleCourses = identity` and contiguity after every transform.
- **Progress is an intersection**: a viewer's completion = their rows ∩ the CURRENT published order. Never store aggregate counters; unpublish/republish round-trips and deletions then stay honest for free. A row with `completed_at IS NULL` means started-not-finished (counts as started only).
- **Write-path split**: authoring writes go through an `authorWrite` guard — demo personas (no real session) get a toast nudge and no request; real `hq_admin` writes are additionally enforced by RLS. Learner actions (email gate, invites, mark-complete) ride narrow SECURITY DEFINER RPCs keyed by an opaque per-registration session token held in a no-read table — never by caller-supplied viewer ids (id-keyed signatures were a cross-learner tampering hole flagged in review).
- **Learner PII stays out of anon reads**: viewer/completion/invite rows are anon-readable only for seeded demo rows (`is_demo`); email-gate registrations are HQ-admin-only. The learner page therefore keeps its own progress state hydrated from RPC payloads (register/state/mark return the rows) instead of the shared snapshot. A live anon-key network suite proves the boundaries (registered emails absent from anon reads, cross-token isolation, old RPC signatures gone) and stays out of hermetic validation.
- **jsonb defensiveness**: sanitize chapters/attachments/description on row mapping (defaults for malformed entries, non-arrays → []); never trust shape from the DB.

**Why:** the portal must show identical data in every browser and stay correct when structure changes under existing completions; these rules came out of replacing the sessionStorage mock layer.

**How to apply:** any new training mutation must re-sync placements and go through the guard; any new analytics number must derive from completion rows filtered by the live published order (drafts and draft courses excluded); any new learner-facing action must take the session token (never a viewer id) and must not widen anon reads over non-demo rows.

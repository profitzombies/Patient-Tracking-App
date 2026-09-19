---
name: Whole-office record bundle export
description: HQ-only resumable multi-part bundle job (folder per patient + office CSVs + manifest); how progress, estimates, and the web controls are wired.
---
- Entity-level export kinds (patient record, office bundle) are requested from the entity's page with a confirmation dialog; the shared Exports panel hides them from its dropdown but lists their jobs with progress and per-part downloads.
  **Why:** the confirmation needs entity facts (patient count, size estimate) the panel does not have.
- The bundle job is a bounded-budget step that re-signals itself; progress lives on the export row (`params` bundle state) and is committed after each finished ZIP part. Resume must keep an in-run page cursor AHEAD of the committed cursor or a restart-free run re-packs the first page forever.
- Size estimate = office share of patients × latest data-growth snapshot (database + storage); null before the first snapshot. Do not invent a number.
- System health shows the job generically from the ledger; per-run tallies (`bundlePatientsDone/Total/BytesWritten`) are how live progress reaches that page — one tally per run acts as a "set".
- The live `test:exports` script broke independently (QA staffer row lacks provider_id after team_members became office-scoped); do not fold it into bundle validation.
- Shell trap: `git stash` / `git stash pop` under a stale `.git/index.lock` both fail with "could not write index" and the worktree is left untouched — a "baseline" run after such a stash is NOT a baseline. Check `git stash list` before trusting it.
- Export cancellation is a shared contract across kinds: the cancel route stamps `cancel_requested_at`, and EVERY export builder must (a) guard its ready/progress commits with `cancel_requested_at=is.null`, (b) poll the row between units of work (throttled), and (c) on cancel delete all objects it wrote and flip the row to `cancelled`. A new export kind that skips this leaves rows stuck "Stopping…" forever.
  **How to apply:** when adding an export kind, add a cancel test (cancel mid-run → objects gone, row cancelled, never ready) next to the resume test.
- Rebase recipe when a merge storm hits export files: plain `git merge-file` from the three stages, resolve by union, then REGENERATE codegen from the merged openapi.yaml instead of hand-merging generated files; fixtures typed as archive sections need every new section key (e.g. `recordAccess`) or planning fails with "Received undefined".

---
name: Multi-task merge splice damage
description: How concurrent task merges corrupt one shared hot file and how to repair it from tests + the pre-merge revision
---
- Rule: when several task merges land on ONE hot file (e.g. the coach chat route), reconciliation can splice hunks: duplicated `const` declarations (build-breaking), one branch's output body replacing another's (meal photos answered as label reads), branch headers deleted so photos misroute, `mode: intent` style use-before-declaration (TDZ), imports dropped while their calls remain, spurious duplicate model calls injected, and statements landing after `export default`. esbuild reports only the FIRST duplicate symbol — the rest hides behind it.

**Why:** 2026-08-27 outage: seven tasks merged around the coach route; the api-server build failed and every AI + barcode surface reported unavailable. The one visible error (dup const) was ~15% of the actual damage.

**How to apply:** after any merge storm touching a shared file, run `git diff <last-good-rev> HEAD -- <file>` and scan hunks for the shapes above before trusting a one-line fix. Repair oracle = the merged tasks' OWN test suites (they encode intended behavior) plus the pre-merge revision for blocks the tasks didn't mean to touch. Reconstruct surgically — never blind-revert the file, because sibling files from the same merges depend on its new exports/behavior. Verify: package typecheck (rebuild referenced lib d.ts first if phantom missing-export errors appear), full vitest, then restart the build-at-startup dev workflows and re-run the live gate suites.

## Rebase-time additions (office team / audit merge)
- The semantic rebase merger splices files where BOTH sides edited (swapped route bodies in office-roster.ts / office-patient-edits.ts) even when one side's change was a four-line mechanical swap. Repair recipe: `git show main-repl/main:<file>` → re-apply your own diff (`git diff <base> <your-commit> -- <file>`) with string replacement, then diff against main to confirm only your lines differ.
- Conflict markers inside `.replit` break the workspace shell (nix PATH disappears: no node/python3). Resolve `.replit` FIRST via awk over the markers + `verifyAndReplaceDotReplit`; the toolchain returns immediately after.

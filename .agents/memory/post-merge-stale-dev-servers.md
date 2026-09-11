---
name: Post-merge stale dev servers
description: Merge reconciliation can leave orphaned listeners serving old code; verify actual port ownership and served behavior, not only workflow state.
---

# Post-merge stale dev servers

**Rule:** merge reconciliation attempts workflow restarts, but old service
processes can survive and retain their ports. The replacement may fail with
an address-in-use error, or Metro may wait for an interactive alternate-port
answer while the workflow still appears running. Verify the actual listener
and served behavior before trusting workflow state.

**Why:** tofu-icon reports continued after the Android font fix merged; the
screenshot showed the *old* silent-failure behavior (system fonts + tofu, no
retry screen), which dated it to a pre-fix bundle. The dev server had been
restarted minutes *before* that merge landed, so it was serving stale code.
Separately, a merge batch that reshuffles `node_modules` (e.g. two
`@expo/cli` versions in the pnpm store) can break device bundle fetches
outright ("Could not connect to development server") until Metro restarts.

**Zombie-port variant:** a merge wave can also leave the old server process
alive and holding its port, so workflow restarts crash-loop ("address in
use" errors, or Metro falling back to another port while the stale server
keeps serving the pre-merge bundle). Kill the stale processes first, then
restart the workflow, and re-verify freshness as below.

A green health endpoint does not prove feature freshness: the old API can
serve normal traffic while returning 404 for a newly merged route. Check
that route separately; an unauthenticated 401 is useful proof it is registered,
but is not proof that authenticated reads succeed.

**Built-server variant (API server):** the api-server dev workflow is
`build && start` — it bundles a dist at startup and then serves that frozen
bundle. A merge that lands while it runs updates src only: the server keeps
running healthy-looking with pre-merge behavior, and any *live* suite that
merged alongside the feature (testing what the new code emits) goes red with
confusing symptoms — e.g. missing SSE stage events and prompt-rule
violations while hermetic suites for the same code pass. Diagnose by
grepping the served bundle for a merged-feature string (string literals
survive minification): `grep -c "<feature-string>" artifacts/api-server/dist/index.mjs`
— 0 means stale. Fix is simply restarting the workflow (it rebuilds).
Suspect this whenever a live-vs-hermetic split appears for the same feature,
or when validation fails a suite your diff never touched.

**How to apply:** after any merge batch touching a running artifact, restart
its workflow before trusting new device reports. To prove the served app is
post-merge: fetch the entry bundle from the Expo dev domain (drop
`transform.bytecode` to get greppable JS) and grep for a string unique to
the merged change. Take the bundle URL from the served index.html's script
src — in this pnpm monorepo it points into `/node_modules/.pnpm/...`; a
hand-built `/node_modules/expo-router/entry.bundle` URL resolves from the
workspace root and returns an UnableToResolveError JSON instead of the
bundle; spot-check asset delivery with
`/assets/?unstable_path=...` + sha256 against the node_modules source.
Remind testers to reload (Expo Go: rescan QR / shake → Reload) — their open
session keeps the old bundle.

**Bundle-marker gotcha:** pick grep markers that exist as LITERAL strings in source (a11y labels, copy). Computed values — e.g. testIDs built via template strings — never appear in the served bundle, so grepping for them false-negatives a perfectly fresh server.

**Shared-queue variant:** check published worker logs as well as the preview
when jobs use the same external Supabase queue. A fresh preview API does not
ensure its worker handles an upload: an older published process can acquire
the shared lease and process that upload instead.

**Why:** a PDF uploaded through the development app was processed and timed
out by the published worker; restarting the development API alone could not
replace that worker's old behavior.

**How to apply:** correlate non-clinical job metadata across both runtimes,
verify which process performed the work, and distinguish preview repairs
from changes that still require the user to publish. Never treat a shared
queue's delay as proof that the new processor itself is slow.

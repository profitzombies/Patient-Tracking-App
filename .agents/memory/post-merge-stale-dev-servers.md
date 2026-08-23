---
name: Post-merge stale dev servers
description: Task merges don't restart running workflows; how stale Metro produces false "still broken" reports and how to prove freshness.
---

# Post-merge stale dev servers

**Rule:** platform task merges update the working tree but do NOT restart
running workflows. A dev server (especially Metro/Expo) started before a
merge batch keeps serving the pre-merge app — so a bug "fixed by a merged
task" can keep generating on-device reports until the workflow is restarted
and testers reload.

**Why:** tofu-icon reports continued after the Android font fix merged; the
screenshot showed the *old* silent-failure behavior (system fonts + tofu, no
retry screen), which dated it to a pre-fix bundle. The dev server had been
restarted minutes *before* that merge landed, so it was serving stale code.
Separately, a merge batch that reshuffles `node_modules` (e.g. two
`@expo/cli` versions in the pnpm store) can break device bundle fetches
outright ("Could not connect to development server") until Metro restarts.

**How to apply:** after any merge batch touching a running artifact, restart
its workflow before trusting new device reports. To prove the served app is
post-merge: fetch the entry bundle from the Expo dev domain (drop
`transform.bytecode` to get greppable JS) and grep for a string unique to
the merged change; spot-check asset delivery with
`/assets/?unstable_path=...` + sha256 against the node_modules source.
Remind testers to reload (Expo Go: rescan QR / shake → Reload) — their open
session keeps the old bundle.

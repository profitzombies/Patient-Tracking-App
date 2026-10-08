---
name: Provider-scope pattern (operations web)
description: How the HQ admin umbrella scopes the office screens without forking them, and the invariants that keep the office demo byte-identical.
---

# Provider-scope pattern

The operations web app has two personas (sessionStorage-simulated): office staff see the original dashboard; HQ admins get an umbrella shell and can drill into any provider account's office dashboard.

**The rule:** office screens never import `MOCK_*` singletons directly — they read through `useScoped*` hooks. Unscoped (no `ProviderScopeProvider` above), each hook returns the *exact same singleton object* (not a copy, not a re-filter), so the office demo renders byte-identically. Scoped, hooks filter by the account's providerId or swap to per-account seeded analytics.

**Why:** the unscoped singleton path is the baseline of the hermetic office suites and the web↔mobile parity suite (the guided demo itself is gone since 2026-10-08, so no visitor sees it); any fork or copy of those screens will drift. One screen, two data scopes.

**How to apply:**
- New office screens or new data reads on existing office screens must go through `src/data/scoped-data.ts` hooks; add a hook there rather than importing mock-data in the page.
- Derived UI that used to be literal copy ("65%", "3 open", activity feed names) is computed so it *reproduces the literals exactly* when unscoped — verify with the unscoped render before shipping.
- HQ aggregate data (`src/data/hq/accounts.ts`) partitions the program totals exactly: account patient counts, revenue, subs, deliveries and engagement must sum to the seeded program figures at the 2026-08-22 anchor. Adding/altering accounts must preserve the sum invariant.
- Admin gating: null persona → sign-in at any URL; office persona is redirected out of `/admin/*`; admin persona is redirected off office routes. The drill-in route (`/admin/accounts/:id/office`) mounts the office app under a `ProviderScopeProvider` inside the admin shell.
- Session-added HQ records (accounts, team, settings) live in sessionStorage (`thinnr-hq-session-v1`) by design — per-tab demo persistence, closing the tab resets.

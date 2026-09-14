# Common rules for every billing builder

You are one of several agents building the THINNR provider-payments feature
(Stripe Connect) in parallel. Read `docs/billing-connect/SPEC.md` fully first.
Then read your own brief. Other agents are editing other files at the same
time — **only edit the files your brief assigns to you.** If you believe a file
outside your ownership must change, write the exact change you need into
`docs/billing-connect/DECISIONS.md` under a heading with your brief name and
stop short of editing it (the integrator will apply it).

## Contract precedence
1. `artifacts/thinnr-operations/src/lib/billing-types.ts` (identical copy at
   `artifacts/api-server/src/billing/types.ts`) is THE wire contract. Where the
   SPEC prose and this file differ, the types file wins. Do not edit either copy;
   if you need a field, note it in DECISIONS.md and use the closest existing shape.
2. SPEC §4 is the database contract. SPEC §3 is the fee math contract (with an
   expected-values table that tests must reproduce exactly).
3. Money is integer cents everywhere. Never a float dollar in code paths.

## Environment facts
- Stripe keys come ONLY from the Replit Stripe connection at runtime:
  `GET https://$REPLIT_CONNECTORS_HOSTNAME/api/v2/connection?include_secrets=true&connector_names=stripe`
  with header `X_REPLIT_TOKEN: repl <REPL_IDENTITY>` (or `depl <WEB_REPL_RENEWAL>` in
  deployments). `items[0].settings.secret` (sk_), `.publishable` (pk_), `.account_id`.
  Never log, print, or echo key values. `sandbox = publishable.startsWith('pk_test_')`.
- The connected sandbox does NOT yet have Connect enabled (owner is fixing it).
  So live Stripe calls that touch Connect will fail right now — build against
  the contract, mock Stripe in tests, and do not block on live Stripe.
- Supabase DDL is applied through the management API, not a pg socket (see the
  migration brief). Application code talks to Supabase through `supabaseAdmin`
  (`artifacts/api-server/src/lib/supabase-admin.ts`, service role, REST).
- Existing tests mock global fetch for Supabase REST; follow the patterns in
  `artifacts/api-server/src/routes/office-team.test.ts` or `office-roster.test.ts`.
- Run `pnpm --filter @workspace/api-server exec tsc -p tsconfig.json --noEmit`
  (server) / `pnpm --filter @workspace/thinnr-operations run typecheck` (web)
  before finishing. Run your own vitest files with
  `pnpm --filter @workspace/api-server exec vitest run <files>`.
- Do not create workflows or validation commands; the integrator does that.
- Do not touch `.replit`, `package.json` scripts (unless your brief says so),
  `app.ts`, `routes/index.ts`, `App.tsx` (unless your brief says so).

## Code conventions
- Server: ESM TypeScript, double quotes, express 5, zod for body validation
  (see existing routes), `logger` from `src/lib/logger`, errors as
  `{ error: string, field?: string }`.
- Web: single quotes, wouter routing, react-query, tailwind + the Heritage
  primitives (`components/patient/heritage.tsx`, `components/admin/primitives.tsx`,
  `components/billing/primitives.tsx`). Playfair serif page titles come from
  `PageHeader`. Clickable rows: one announced row link + pointer-only `tr onClick`
  (never focusable div/tr). Filters live in the URL query string.
- Every user-facing string: plain, professional, no dashes as sentence
  connectors, no emojis.
- Comments explain why, not what. No commented-out code.

## Finish report
End with: files created/edited, tests added and their pass status, anything you
could not verify, and any DECISIONS.md entries you wrote.

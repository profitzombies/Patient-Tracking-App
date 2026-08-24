# THINNR Med Spa Operations

Investor-demo platform for the THINNR weight-loss program: a staff/HQ operations web app, a patient mobile companion (Expo), and an API server — real Supabase sign-in at the front door, synthetic demo data underneath.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/thinnr-mobile run test:approved-foods` — verify every Approved Foods string in the mobile app is verbatim from the docs archive (run after touching `artifacts/thinnr-mobile/data/approved-foods.ts`)
- `pnpm --filter @workspace/thinnr-mobile run test:restaurant-guide` — verify all Restaurant Guide wording (eating-out guidance plus every restaurant name and order line) is verbatim from the docs archive (run after touching `artifacts/thinnr-mobile/data/restaurant-guide.json`)
- Automated demo gate: the `demo-parity` and `approved-foods` validation checks run together on every validation run — web↔mobile demo-data parity plus verbatim Approved Foods wording — and either one failing fails the run
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `docs/thinnr-program/` — verbatim archive of the official THINNR Protocol materials: complete 72-page manual transcription, program-instructions and approved-foods extracts, knowledge-base Q&A, the THINNR Restaurant Guide (eating-out rules and approved restaurant orders), and the canonical PDF/paste sources (see its README for page mapping and fidelity notes). Quote official program wording from these files — never paraphrase or "fix" it.
- `artifacts/thinnr-mobile/data/approved-foods.ts` — machine-readable Approved Foods list (categories, verbatim item names, portions) powering the mobile Library tab's Approved Foods screen, the checkmark badges (library / Add Food search / diary), and the Add Food "approved only" filter. Guarded by the `test:approved-foods` verbatim check above.
- `artifacts/thinnr-mobile/data/restaurant-guide.json` — quoted eating-out guidance plus the THINNR Restaurant Guide directory (25 restaurants with verbatim approved-order lines; typed access via `data/restaurant-directory.ts`). Powers the patient Restaurant Guide hub (`/restaurant-guide`), its guidance page, and the per-restaurant detail pages; the API server reads its `sections[]` for coach grounding (directory keys are ignored there). Guarded by the `test:restaurant-guide` verbatim check.
- `artifacts/thinnr-mobile/data/product-catalog.json` — curated THINNR product catalog (copy, supplement facts, disclaimers quoted verbatim from getthinnr.com; prices are demo values matching the staff dataset). Powers coach product suggestions and the `/product/[id]` demo shop page; the API server reads it at runtime for grounding. Name/price parity with the staff `MOCK_PRODUCTS` is enforced by `test:parity`.

## Authentication (Supabase)

Real Supabase auth is the front door on both apps; everything behind it still runs on synthetic demo data. The guided demo stays reachable without an account: web sign-in → "Exploring? Browse the guided demo…", mobile patient sign-in → "Browse without an account".

- Client env vars (already set, client-safe publishable key; no service-role key in this workspace): `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` (web), `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (mobile).
- Roles come from a pre-approved allowlist (`role_assignments` table) checked by a DB trigger at signup: andrew@thinnrweightloss.com → HQ admin, andrew+provider@… → provider staff, andrew+patient@… → patient. Anyone not on the list becomes a patient. Adding a row only affects *future* signups; to change an existing user, update `profiles.role`.
- Web lands each role in its workspace: hq_admin → `/admin`, provider_staff → office desk, patient → a "the patient experience lives in the mobile app" notice. Mobile treats any real session as a patient — it *is* the patient surface.
- Email confirmation is ON and Supabase's built-in mailer is rate-limited (a few emails/hour) — fine for the demo accounts, not crowds. Toggle: Supabase dashboard → Authentication → Sign In/Up → "Confirm email". Confirmation links bounce to the Site URL (Authentication → URL Configuration) — add the app URL there so links land back in the app.
- Phone + password (SMS code at signup) is fully built but stays dark until Twilio Verify is connected: Supabase dashboard → Authentication → Sign In/Up → Phone → enable, provider "Twilio Verify", paste Account SID / Auth Token / Verify Service SID from the Twilio console. Until then both apps explain "text verification is still being connected".

## Architecture decisions

- Real auth is a *front door only*: the Supabase session and role decide which workspace you land in, but all product data stays synthetic and identical for every account. Demo personas bypass auth entirely (web persona is sessionStorage-scoped; a real session always outranks it).

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/thinnr-mobile run test:approved-foods` — verify every Approved Foods string in the mobile app is verbatim from the docs archive (run after touching `artifacts/thinnr-mobile/data/approved-foods.ts`)
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

- `docs/thinnr-program/` — verbatim archive of the official THINNR Protocol materials: complete 72-page manual transcription, program-instructions and approved-foods extracts, knowledge-base Q&A, and the canonical PDF/paste sources (see its README for page mapping and fidelity notes). Quote official program wording from these files — never paraphrase or "fix" it.
- `artifacts/thinnr-mobile/data/approved-foods.ts` — machine-readable Approved Foods list (categories, verbatim item names, portions) powering the mobile Library tab's Approved Foods screen, the checkmark badges (library / Add Food search / diary), and the Add Food "approved only" filter. Guarded by the `test:approved-foods` verbatim check above.
- `artifacts/thinnr-mobile/data/product-catalog.json` — curated THINNR product catalog (copy, supplement facts, disclaimers quoted verbatim from getthinnr.com; prices are demo values matching the staff dataset). Powers coach product suggestions and the `/product/[id]` demo shop page; the API server reads it at runtime for grounding. Name/price parity with the staff `MOCK_PRODUCTS` is enforced by `test:parity`.

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

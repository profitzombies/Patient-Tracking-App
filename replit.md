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
- `pnpm --filter @workspace/thinnr-operations run seed:training` — idempotent sample data for the live training portal (re-run any time; add `--reset` to wipe all training rows first and reseed)
- `pnpm --filter @workspace/thinnr-operations run test:training` — training-portal invariants (pure logic, offline)
- `pnpm --filter @workspace/thinnr-operations run test:training-access` — live anon access-boundary checks against the real Supabase project (network; run after training schema/RLS changes — deliberately not a hermetic validation command)
- `pnpm --filter @workspace/thinnr-operations run test:account-lock` — live account-lock enforcement checks (lock acct-p1 → staff reads/writes collapse while HQ keeps visibility → unlock restores the same rows; transient lock + throwaway admin, fully cleaned up — also not a hermetic validation command)
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
- Roles come from the database-only `staff_role_assignments` allowlist. A confirmed email gets its listed `hq_admin` or `provider_staff` role; everyone else is a patient. Adding, updating, or deleting an assignment synchronizes matching confirmed profiles, and deleting an assignment revokes staff access. Add staff with the SQL documented in `docs/supabase-auth-setup.md`; do not edit `profiles.role` directly.
- Provider staff get an office **Training** area (`/training` in the office shell): their own progress with mark-complete, the live course catalog, the office roster, and self-serve teammate adds. Adding a teammate pre-approves the email in `staff_role_assignments` (HQ admins for any office, provider staff for their own only) — nothing is emailed; when that person signs up, their confirmed account auto-links to a `training_viewers` row under the office (`supabase/migrations/20260827000000_training_staff_logins.sql`, proven live by `test:training-staff`). A signed-in staffer's whole office desk is scoped to their own office (real patients/roster stay synthetic; program data identical).
- **Demo staff login** (Jenkins Aesthetics & Wellness, acct-p1): `dana.frontdesk@jenkinswellness.example.com` / `JenkinsTraining!26` — recreate or repair any time with `pnpm --filter @workspace/thinnr-operations run create:demo-staff`.
- **Account lock (HQ kill switch)**: a row in `provider_account_locks` = that office is locked (`supabase/migrations/20260829000000_provider_account_locks.sql`; presence-keyed — unlock deletes the row, nothing re-created). World-readable so Locked chips render for the demo persona; lock/unlock happens in the account page's Danger zone and needs a real signed-in `hq_admin` (demo persona gets the "sign in to make changes" nudge). While locked, `private.caller_provider_account()`/`caller_is_staff()` collapse for that office's staff — office-scoped RLS reads and the staff RPCs refuse — and already-signed-in staff are ejected live (10s poll + realtime) to a full-screen "This account is locked" notice; fresh sign-ins land there too; HQ keeps full drill-in visibility. Proven live by `test:account-lock`.
- Web lands each role in its workspace: hq_admin → `/admin`, provider_staff → office desk, patient → a "the patient experience lives in the mobile app" notice. Mobile treats any real session as a patient — it *is* the patient surface.
- Email confirmation is ON and Supabase's built-in mailer is rate-limited (a few emails/hour) — fine for the demo accounts, not crowds. Toggle: Supabase dashboard → Authentication → Sign In/Up → "Confirm email". Confirmation links bounce to the Site URL (Authentication → URL Configuration) — add the app URL there so links land back in the app.
- Phone + password (SMS code at signup) is fully built but stays dark until Twilio Verify is connected: Supabase dashboard → Authentication → Sign In/Up → Phone → enable, provider "Twilio Verify", paste Account SID / Auth Token / Verify Service SID from the Twilio console. Until then both apps explain "text verification is still being connected".

## Architecture decisions

- Real auth is a *front door only*: the Supabase session and role decide which workspace you land in, but all product data stays synthetic and identical for every account. Demo personas bypass auth entirely (web persona is sessionStorage-scoped; a real session always outranks it).
- **HQ Training is the one live-data area**: courses/modules/videos/viewers/completions live in Supabase (`supabase/migrations/20260825000000_training.sql`; assembly + analytics in `artifacts/thinnr-operations/src/data/hq/training.ts`, react-query layer in `src/contexts/training-data.tsx`). Catalog reads (courses/modules/videos) are open to the anon key, but viewer/completion/invite rows are anon-readable only for seeded demo rows (`is_demo`) — email-gate registrations are visible to real HQ admins alone. Authoring writes require a real signed-in `hq_admin` (RLS) — demo personas browse read-only with a banner and a "sign in to make changes" nudge. The learner preview's email gate, staff invites, and mark-complete go through narrow SECURITY DEFINER RPCs keyed by an opaque per-registration session token (`training_learner_sessions`, readable by no role), never by caller-supplied viewer ids (`supabase/migrations/20260826000000_training_learner_privacy.sql`; boundaries proven live by `test:training-access`). Lesson videos can carry a **real hosted file**: HQ admins upload MP4/WebM/MOV (≤500 MB) from the video editor's Media card straight to Replit App Storage via presigned PUT URLs minted by the API server (`artifacts/api-server/src/routes/training-media.ts` + `src/lib/objectStorage.ts`), which verifies the caller's existing Supabase staff session and role on every call (`src/lib/staff-auth.ts` — hq_admin authors; hq_admin + provider_staff stream). Playback rides short-lived signed GET URLs (range requests hit storage directly, so seeking works); the DB stores only object paths (`training_videos.video_source`, `thumbnail_source`), never URLs. After an upload the server runs an AI pass with per-step SSE progress — ffmpeg pulls the audio, the AI integration transcribes it in one-minute chunks (`training_video_transcripts.segments`, HQ-only reads per `supabase/migrations/20260829000000_training_video_hosting.sql`), the model writes the description + chapter list from the timed transcript; every result is editable, failures surface plainly with retry, and the file stays hosted regardless. The thumbnail doesn't wait for that pass: finalize captures the video's first frame the moment the upload lands (the AI pass's thumbnail step runs only as a retry when the instant capture failed), and admins can still scrub to capture any other frame. The Media card's whole "Video file" section is one drag-and-drop target — dropping a file uploads immediately, dropping onto a lesson that already has a video replaces it with no confirmation (the old video + thumbnail objects are deleted), a window-level guard keeps missed drops from navigating the tab into the file, and a re-check of `video_source` right before persisting any captured thumbnail drops stale frames from a just-replaced file. Training media resolves through `TRAINING_OBJECT_DIR` (`/<bucketId>/.private`, the dedicated training bucket) when set, falling back to `PRIVATE_OBJECT_DIR`; stored object paths don't name a bucket, so only change that knob while no hosted files exist — or migrate the objects first. Editor + office lesson pages swap in a real player (`src/components/training/HostedVideoPlayer.tsx`) when a file exists; lessons without one keep the simulated workbook slides, as does mobile (deliberately no mobile playback — it carries the columns for row parity only). Seeded demo lessons ship file-less on purpose; attachments stay name-only metadata. Provider-staff sessions additionally read their own office's viewer/completion rows via additive RLS (own row or same `provider_account_code`, resolved by `private.caller_provider_account()`), and act through two auth-keyed SECURITY DEFINER RPCs — `training_add_staff` (self-serve roster adds) and `training_mark_video_complete_self` — added in `20260827000000_training_staff_logins.sql` and proven live by `test:training-staff`. The office-side lens (`src/data/office-training.ts` + `OfficeTraining`/`OfficeTrainingCourse` pages) reuses the same snapshot and HQ math, pinned by section 11 of the invariants suite.

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

# Threat Model

## Project Overview

THINNR Med Spa Operations is a pnpm-workspace monorepo powering an investor-demo weight-loss platform:

- **API server** (`artifacts/api-server`) — Express 5 + TypeScript, PostgreSQL via Drizzle, Supabase (GoTrue auth + PostgREST + service-role admin). Deployed autoscale, public visibility, at `https://app.trythinnr.com`.
- **Operations web app** (`artifacts/thinnr-operations`) — HQ admin + provider office desk (React).
- **Mobile app** (`artifacts/thinnr-mobile`) — Expo patient companion + staff surface.
- **Design sandbox** (`artifacts/mockup-sandbox`) — dev-only mockup, not production.

Real Supabase auth is the front door; most product data is synthetic demo data. Roles come from a DB-only `staff_role_assignments` allowlist (`hq_admin`, `provider_staff`, else patient).

## Assets

- **Auth sessions / GoTrue tokens** — staff and patient sessions; compromise enables impersonation.
- **Patient PII** — names, weights, diary/check-in activity, progress photos, measurements, phone/email.
- **Provider/office data** — rosters, leaderboards, alert digests, billing connected accounts.
- **Application secrets** — Supabase service-role key, Resend/Twilio keys, Stripe keys, `NOTIFICATIONS_INTERNAL_TOKEN`. Not present in this workspace (server-side only); client apps carry only publishable keys.
- **Org policy / billing state** — HQ-controlled org policy (store links, retention, quiet hours), billing links/orders.

## Trust Boundaries

- **Browser/mobile → API** — every request untrusted; server authenticates and authorizes.
- **API → Supabase (service role)** — the API uses `supabaseAdmin` (service role, bypasses RLS), so authorization MUST be enforced in application code via `resolveOfficeScope` / `requireHqPermission` before any admin query.
- **Office ↔ Office (tenant isolation)** — every office (provider) is a tenant; staff callers are always pinned to their own office; HQ must name an office explicitly and hold the permission.
- **Public/unauthenticated → billing-public / manifest** — a small set of intentionally-open endpoints (billing link resolution by unguessable token, product image redirects, mobile manifest).
- **Internal job triggers** — `/api/internal/*` gated by `NOTIFICATIONS_INTERNAL_TOKEN` bearer.

## Scan Anchors

- **Authorization core:** `artifacts/api-server/src/auth/office-scope.ts` (`resolveOfficeScope` — provider/team_member pinned to own office, HQ needs explicit office + permission, locked/disabled offices fail closed) and `artifacts/api-server/src/lib/staff-auth.ts` (`requireHqPermission`, `verifyStaffToken`).
- **Route registration:** `artifacts/api-server/src/routes/index.ts`.
- **Highest-risk new surfaces (recent commits):** office alerts (`routes/office-alerts.ts`), HQ delivery outcomes (`routes/hq-staff-alerts.ts`), staff device registration (`routes/staff-notifications.ts`), digest job (`jobs/definitions/staff-attention-digest.ts`), staff sender (`alerts/staff-sender.ts`), org policy edit incl. store-URL validation (`lib/org-policy-edit.ts`).
- **Intentionally-open reads:** `routes/billing-public.ts` (rate-limited; product-image + signed-URL redirects use unguessable UUIDs), `/ai-support` chat (demo posture, per-IP limits), training catalog reads.
- **Dev-only / ignore unless proven reachable:** `artifacts/mockup-sandbox`, `*.test.ts`, `scripts/`, in-memory stores (`alerts/memory-store.ts`).

## Threat Categories

### Spoofing / Improper Authentication
All sensitive API routes resolve a live GoTrue token before acting. Staff callers are bound to their own office by DB lookup (`providers`/`team_members` on `auth_user_id`); an explicit `?office=` is honored only for verified HQ callers. Guarantee: no route backed by `supabaseAdmin` may act without `resolveOfficeScope`/`requireHqPermission` succeeding first.

### Elevation of Privilege / Broken Access Control
Because the service-role key bypasses RLS, every admin query must be scoped by the resolved `providerId`. The alert routes correctly scope all reads/writes to `scope.providerId` and `scope.actorUserId`; HQ drill-in is read-only (seen-state and preference writes 403 for HQ); settings writes require owner/admin or HQ manage. Guarantee: object lookups must include `provider_id=eq.<scope.providerId>` (e.g. the `seen` route re-checks patient ownership before writing).

### Tampering / Injection
Supabase queries are built with `encodeURIComponent` on interpolated identifiers and Zod-validated bodies. HQ-controlled store links are validated against Apple/Google https host allowlists (`cleanStoreUrl`), preventing `javascript:`/off-host URLs from reaching office QR panels.

### Information Disclosure
Digest emails and roster attention data are scoped to a single office's own staff recipients. Open redirects flagged by SAST target short-lived signed storage URLs for unguessable UUID objects, not attacker-controlled hosts.

### Denial of Service
Public billing and AI endpoints apply per-IP burst/concurrency/daily limiters. Jobs run under DB leases with checkpoints and exponential backoff.

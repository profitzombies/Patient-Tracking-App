---
name: HQ Customer health stack rank
description: Decisions behind the HQ Customer health page (office health score, recency buckets, attention flags) and how it was proven live.
---

- **Score facts come from one service-role RPC; arithmetic lives in one pure server module.** The page and the (future) weekly email must compute identical ranks, so weights, targets, bucket bounds, bands, the New rule, tied ranking and attention reasons never live client-side. The API echoes those constants in a `definitions` block so the page's note has one source.
  **Why:** the user approved specific weights/targets once; two copies would drift.
  **How to apply:** change scoring only in `api-server/src/customer-health/scoring.ts`; the OpenAPI response carries the constants.
- **Offboarding offices are returned by the RPC and dropped in the API** through the shared `officeIsActive` rule (SQL only skips access-disabled). Keeps one definition of "active office".
- **"Most recent order" is the order's own `provider_id`, live mode, with `paid_at`, status in paid/partially_refunded/refunded/disputed.** Sandbox orders never count. Migrated offices read "No orders on record" (history is not in this DB) — the definitions note says so.
- **At-risk attention excludes New offices** (created <90 days, no order), otherwise every fresh practice is flagged on day one; the dev project's synthetic offices all land in Quiet 1 yr+/never with 0 attention, which is correct.
- **Live proof recipe (worked 2026-10-09):** service-role insert of `staff_role_assignments` (hq_admin) + confirmed auth user (`thinnr_provisioned`) + ACTIVE `hq_memberships` row; tester restarts the API workflow with `CLAIM_EMAIL_DELIVERY_MODE=dev CLAIM_SMS_DELIVERY_MODE=dev`, signs in via inline email code, then enrols the SMS second factor with any phone (inline code too — HQ users are required by policy). Teardown: memberships, role row, `auth_sign_ins`, `staff_second_factors`, auth user, replica-role delete of audit/claim rows. An invited membership is NOT enough: `hq_invited` needs a pending `hq_invitations` row with a `created_by` auth user.
- **Numeric columns default to desc on first click** (score, counts) — matches the other HQ tables; rank asc is the bare-URL default.

## Weekly Monday email (opt-in per HQ member)

- **Due rule = org default tz reads Monday ≥ 09:00 AND no run row for that ISO week.** Week identity is the ISO week of the *local* Monday from Intl parts (never the UTC day), so DST weeks and the 52/53-week boundary stay correct. The run row is written LAST (after snapshots and enqueue with an ignore-duplicates per-user-per-week key) so a crash mid-run re-runs idempotently.
  **Why:** "exactly one email per subscriber per week" has to survive restarts and a 15-min poll that fires many times on Monday.
- **Subscription is checked twice:** recipients resolve at run time (enabled preference ∩ ACTIVE membership) and the staff sender re-checks at send time, finalizing an opt-out as suppressed/unsubscribed so the delivery view shows it. Any new per-member HQ mail must reuse that send-time hook, not add its own.
- **Staff emails ignore the dev-mode delivery knob** — it only covers sign-in/claim codes, so live proofs of the staff outbox send REAL mail. Use the vendor's always-delivered test address for the subscriber that must be sent, and an invented `.example.com` address only for rows that must be suppressed.
- **Job HTTP triggers have no clock override.** A live proof of a calendar-gated job must drive the runner directly with an explicit `now` (a PAST Monday, so its ISO week cannot collide with the coming real run) and must refuse to run when that week already has a run row or snapshots — they belong to a real run and cannot be restored.
- **Page "vs last week"** compares to the previous ISO week's snapshot, else the current week's (Monday afternoon shows 0, not "—"), else null, and the API names which week it used. Snapshot read failures surface as errors, never a silent "—".

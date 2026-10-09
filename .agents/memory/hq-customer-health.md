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

/**
 * Reading and writing an office's access subscription row.
 *
 * Every state change goes through `applyAccessInput`, which asks the state
 * machine what the input implies, persists the patch, and appends an
 * auditable history row. Nothing else writes `state`.
 */
import { recordAdminAuditEvent, type AuditMetadata } from "../../lib/admin-audit";
import { insert, selectMany, selectOne, update, type BillingOfficeAccessEventRow, type BillingOfficeAccessSubscriptionRow as Row } from "../store";
import { deriveAccessState, nextAccessState, type AccessInput } from "./state";

export type AccessActorKind = BillingOfficeAccessEventRow["actor_kind"];

export interface AccessActor {
  kind: AccessActorKind;
  userId?: string | null;
  requestId?: string | null;
}

export const SYSTEM_ACTOR: AccessActor = { kind: "system", userId: null };

function q(value: string): string {
  return encodeURIComponent(value);
}

export async function findAccessSubscription(providerId: string): Promise<Row | null> {
  return selectOne("billing_office_access_subscriptions", `provider_id=eq.${q(providerId)}`);
}

/**
 * The office's subscription row, created on first touch. Creation is racy by
 * nature (a sign-in and a setup request can land together), so a duplicate
 * insert falls back to re-reading the winner's row.
 */
export async function ensureAccessSubscription(providerId: string): Promise<Row> {
  const existing = await findAccessSubscription(providerId);
  if (existing) return existing;
  try {
    return await insert("billing_office_access_subscriptions", { provider_id: providerId });
  } catch (error) {
    const again = await findAccessSubscription(providerId);
    if (again) return again;
    throw error;
  }
}

export async function recordAccessEvent(input: {
  row: Pick<Row, "id" | "provider_id">;
  event: string;
  fromState?: Row["state"] | null;
  toState?: Row["state"] | null;
  actor: AccessActor;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await insert("billing_office_access_events", {
    subscription_id: input.row.id,
    provider_id: input.row.provider_id,
    event: input.event,
    from_state: input.fromState ?? null,
    to_state: input.toState ?? null,
    actor_user_id: input.actor.userId ?? null,
    actor_kind: input.actor.kind,
    detail: input.detail ?? {},
  });
}

/** Only small operational scalars reach the shared admin audit ledger. */
function auditMetadata(detail: Record<string, unknown>): AuditMetadata {
  const out: AuditMetadata = {};
  for (const [key, value] of Object.entries(detail)) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return out;
}

export interface ApplyResult {
  row: Row;
  from: Row["state"];
  to: Row["state"];
  changed: boolean;
}

/**
 * Apply one input to an office's access subscription: compute the patch, write
 * it (guarded on the row version so two concurrent writers cannot interleave),
 * and append the history row. `auditAction` additionally mirrors the change
 * into the shared admin audit ledger — HQ overrides always do.
 */
export async function applyAccessInput(input: {
  row: Row;
  input: AccessInput;
  actor?: AccessActor;
  event?: string;
  detail?: Record<string, unknown>;
  auditAction?: string;
}): Promise<ApplyResult> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const decision = nextAccessState(input.row, input.input);
  const from = input.row.state;
  const patchKeys = Object.keys(decision.patch);
  let row = input.row;
  if (patchKeys.length) {
    const updated = await update(
      "billing_office_access_subscriptions",
      `id=eq.${q(input.row.id)}&version=eq.${input.row.version}`,
      { ...decision.patch, version: input.row.version + 1, updated_at: new Date().toISOString() },
    );
    if (!updated) {
      // Lost the race: someone else moved the row. Re-read and let the caller
      // see the winner's state rather than clobbering it.
      const fresh = await findAccessSubscription(input.row.provider_id);
      return { row: fresh ?? input.row, from, to: (fresh ?? input.row).state, changed: false };
    }
    row = updated;
  }
  const changed = patchKeys.length > 0;
  if (changed) {
    const detail = { ...(input.detail ?? {}), fields: patchKeys.join(",") };
    await recordAccessEvent({
      row, event: input.event ?? input.input.kind, fromState: from, toState: decision.state, actor, detail,
    });
    if (input.auditAction) {
      await recordAdminAuditEvent({
        action: input.auditAction,
        actorUserId: actor.userId ?? null,
        actorKind: actor.kind === "stripe" ? "system" : actor.kind,
        providerId: row.provider_id,
        targetKind: "office_access_subscription",
        targetId: row.id,
        requestId: actor.requestId ?? null,
        metadata: { ...auditMetadata(input.detail ?? {}), from, to: decision.state },
      }).catch(() => undefined);
    }
  }
  return { row, from, to: decision.state, changed };
}

/**
 * Re-check a row against the clock and repair a stale `state` column. Cheap
 * and safe to call from any read path: it only writes when the derivation
 * disagrees with what is stored.
 */
export async function refreshAccessState(row: Row, now = new Date()): Promise<Row> {
  if (deriveAccessState(row, now) === row.state) return row;
  const result = await applyAccessInput({ row, input: { kind: "period_expiry", at: now }, event: "state_rechecked" });
  return result.row;
}

export async function accessHistory(providerId: string, limit = 100): Promise<BillingOfficeAccessEventRow[]> {
  return selectMany(
    "billing_office_access_events",
    `provider_id=eq.${q(providerId)}&order=created_at.desc,id.desc&limit=${Math.max(1, Math.min(500, limit))}`,
  );
}

import type { Request } from "express";
import { supabaseAdmin } from "./supabase-admin";

/**
 * Who performed an audited action. Staff kinds carry an auth user id; the
 * non-user kinds exist for surfaces without a signed-in staffer (anonymous
 * AI support turns, open learner downloads) and for denied attempts where the
 * caller never resolved to a staff identity.
 */
export type AuditActorKind =
  | "provider"
  | "team_member"
  | "hq"
  | "anonymous"
  | "learner"
  | "patient"
  | "system"
  | "unknown";

export type AuditMetadata = Record<string, string | number | boolean | null>;

/** The request id the API's logger stamps on every request, when present. */
export function requestIdOf(req: Pick<Request, "headers">): string | null {
  const value = req.headers["x-request-id"];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" && value ? value : null;
}

/**
 * Best-effort, deliberately metadata-only audit write for staff actions.
 * Resolves to the new audit event id (null when the RPC returned no body,
 * e.g. on a database that predates the id-returning RPC) so patient-scoped
 * edit history can pair its prior/new values with the ledger row.
 */
export async function recordAdminAuditEvent(input: {
  action: string;
  /** Null for system-run steps (purge worker) that no signed-in user triggered. */
  actorUserId: string | null;
  actorKind: AuditActorKind;
  providerId: string | null;
  targetKind: string;
  targetId: string | null;
  requestId: string | null;
  /** Only small operational facts; credentials, free text, and clinical data are forbidden. */
  metadata?: AuditMetadata;
}): Promise<number | null> {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/record_admin_audit_event", {
    p_action: input.action,
    p_actor_user_id: input.actorUserId,
    p_actor_kind: input.actorKind,
    p_provider_id: input.providerId,
    p_target_kind: input.targetKind,
    p_target_id: input.targetId,
    p_request_id: input.requestId,
    p_metadata: input.metadata ?? {},
  });
  if (result.status >= 300) throw new Error(`admin audit write failed (${result.status})`);
  const id = typeof result.json === "number" ? result.json : Number(typeof result.json === "string" ? result.json : NaN);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Why a sensitive route refused an authenticated caller. */
export type AccessDenialReason =
  | "permission"
  | "office_locked"
  | "office_unavailable"
  | "deactivated"
  | "staff_only";

/**
 * Route pattern for a denial event — the declared path (":id" placeholders),
 * never the concrete URL, so no patient or record id rides the audit row.
 */
export function routePatternOf(req: Pick<Request, "baseUrl" | "route" | "path">): string {
  const declared = (req.route as { path?: string } | undefined)?.path;
  const pattern = typeof declared === "string" ? declared : req.path.replace(/\/[0-9a-f-]{20,}/gi, "/:id");
  return `${req.baseUrl ?? ""}${pattern}`.slice(0, 240) || "/";
}

/**
 * Shared denial logging for sensitive routes. Fire-and-forget: a denial is
 * already answered by the time this runs, and an audit outage must never
 * turn a 403 into a 502. Only authenticated-but-refused attempts are
 * recorded; anonymous 401s are noise, not signal.
 */
export function recordAccessDenied(
  req: Request,
  input: {
    actorUserId: string | null;
    actorKind: AuditActorKind;
    providerId?: string | null;
    reason: AccessDenialReason;
    status: number;
  },
): void {
  void recordAdminAuditEvent({
    action: "access_denied",
    actorUserId: input.actorUserId,
    actorKind: input.actorKind,
    providerId: input.providerId ?? null,
    targetKind: "route",
    targetId: routePatternOf(req),
    requestId: requestIdOf(req),
    metadata: {
      reason: input.reason,
      route: routePatternOf(req),
      method: req.method,
      status: input.status,
    },
  }).catch((error) => req.log?.error({ err: error }, "access denial audit failed"));
}

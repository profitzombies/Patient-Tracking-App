import { supabaseAdmin } from "./supabase-admin";

/** Best-effort, deliberately metadata-only audit write for staff actions. */
export async function recordAdminAuditEvent(input: {
  action: string;
  actorUserId: string;
  actorKind: "provider" | "team_member" | "hq";
  providerId: string;
  targetKind: string;
  targetId: string;
  requestId: string | null;
}): Promise<void> {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/record_admin_audit_event", {
    p_action: input.action,
    p_actor_user_id: input.actorUserId,
    p_actor_kind: input.actorKind,
    p_provider_id: input.providerId,
    p_target_kind: input.targetKind,
    p_target_id: input.targetId,
    p_request_id: input.requestId,
    p_metadata: {},
  });
  if (result.status >= 300) throw new Error(`admin audit write failed (${result.status})`);
}
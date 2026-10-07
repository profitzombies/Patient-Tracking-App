/**
 * Office-defined patient groups ("MJH", "Tuesday clinic").
 *
 * Operational labels an office invents for its own roster: created, renamed,
 * deleted and populated by any active teammate of that office, visible to
 * HQ drill-in read-only. Membership rides the roster and patient-record
 * responses (see office-roster.ts); this router owns the group list and the
 * mutations. Every write is refused for disabled teammates, locked or
 * offboarded offices (office scope with requireUnlocked) and for HQ (403), and
 * records an office-visible audit event with ids only.
 */
import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { resolveOfficeScope, respondOfficeScopeDenied, type OfficeScope } from "../auth/office-scope";
import { recordAdminAuditEvent } from "../lib/admin-audit";
import { supabaseAdmin } from "../lib/supabase-admin";

const router: IRouter = Router();
const enc = encodeURIComponent;
const SERVER_ERROR = "Something went wrong on our side. Please try again.";
const GROUP_NOT_FOUND = "No group found for this office.";
const PATIENT_NOT_FOUND = "No patient record found for this office.";
const NAME_TAKEN = "A group with that name already exists.";
const HQ_READ_ONLY = "HQ can view office groups but not change them.";
export const GROUP_NAME_MAX = 60;
export const GROUP_DESCRIPTION_MAX = 200;

const nameSchema = z.string().trim().min(1, "Enter a group name.").max(GROUP_NAME_MAX, `Keep the name under ${GROUP_NAME_MAX} characters.`);
const descriptionSchema = z.string().trim().max(GROUP_DESCRIPTION_MAX, `Keep the description under ${GROUP_DESCRIPTION_MAX} characters.`).nullable().optional();
const CreateGroup = z.object({ name: nameSchema, description: descriptionSchema });
const UpdateGroup = z.object({ name: nameSchema.optional(), description: descriptionSchema }).refine(
  (value) => value.name !== undefined || value.description !== undefined,
  { message: "Nothing to change." },
);

type GroupRow = { id: string; name: string; description: string | null; created_at: string; updated_at: string; created_by: string | null };
const GROUP_SELECT = "id,name,description,created_at,updated_at,created_by";

export type PatientGroupDto = {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
};

function groupDto(row: GroupRow, memberCount: number): PatientGroupDto {
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    memberCount,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function scope(req: Request, permission: "provider_read" | "provider_manage") {
  return resolveOfficeScope({
    authorization: req.headers.authorization,
    request: req,
    explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
    hqPermission: permission,
    requireUnlocked: permission === "provider_manage",
  });
}

function isUniqueViolation(json: unknown): boolean {
  const message = typeof json === "object" && json && "message" in json ? String((json as { message: unknown }).message) : "";
  return /patient_groups_provider_name_ci_idx|duplicate key/i.test(message);
}

async function loadGroup(office: OfficeScope, groupId: string): Promise<GroupRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(groupId)) return null;
  const found = await supabaseAdmin("GET", `/rest/v1/patient_groups?id=eq.${enc(groupId)}&provider_id=eq.${enc(office.providerId)}&select=${GROUP_SELECT}&limit=1`);
  if (found.status >= 300) throw new Error(`patient group lookup failed (${found.status})`);
  return Array.isArray(found.json) ? (found.json[0] as GroupRow | undefined) ?? null : null;
}

async function memberCount(office: OfficeScope, groupId: string): Promise<number> {
  const members = await supabaseAdmin("GET", `/rest/v1/patient_group_members?group_id=eq.${enc(groupId)}&provider_id=eq.${enc(office.providerId)}&select=patient_id&limit=10000`);
  if (members.status >= 300 || !Array.isArray(members.json)) throw new Error(`patient group member count failed (${members.status})`);
  return members.json.length;
}

/** Same name (ignoring case and outer spaces) on another group of this office. */
async function nameTaken(office: OfficeScope, name: string, exceptGroupId: string | null): Promise<boolean> {
  const rows = await supabaseAdmin("GET", `/rest/v1/patient_groups?provider_id=eq.${enc(office.providerId)}&select=id,name&limit=1000`);
  if (rows.status >= 300 || !Array.isArray(rows.json)) throw new Error(`patient group name check failed (${rows.status})`);
  const key = name.trim().toLowerCase();
  return (rows.json as GroupRow[]).some((row) => String(row.id) !== exceptGroupId && String(row.name).trim().toLowerCase() === key);
}

function audit(req: Request, office: OfficeScope, action: string, groupId: string, metadata: Record<string, string | number | boolean | null> = {}) {
  return recordAdminAuditEvent({
    action,
    actorUserId: office.actorUserId,
    actorKind: office.actorKind,
    providerId: office.providerId,
    targetKind: "patient_group",
    targetId: groupId,
    requestId: req.headers["x-request-id"]?.toString() ?? null,
    metadata: { groupId, ...metadata },
  }).catch((error: unknown) => req.log?.error({ err: error }, `${action} audit failed`));
}

router.get("/office/patient-groups", async (req, res) => {
  try {
    const resolved = await scope(req, "provider_read");
    if (resolved.kind !== "ok") { respondOfficeScopeDenied(req, res, resolved); return; }
    const office = resolved.scope;
    const [groups, members] = await Promise.all([
      supabaseAdmin("GET", `/rest/v1/patient_groups?provider_id=eq.${enc(office.providerId)}&select=${GROUP_SELECT}&order=name.asc&limit=1000`),
      supabaseAdmin("GET", `/rest/v1/patient_group_members?provider_id=eq.${enc(office.providerId)}&select=group_id&limit=10000`),
    ]);
    if (groups.status >= 300 || !Array.isArray(groups.json)) throw new Error(`patient groups load failed (${groups.status})`);
    if (members.status >= 300 || !Array.isArray(members.json)) throw new Error(`patient group members load failed (${members.status})`);
    const counts = new Map<string, number>();
    for (const member of members.json as Array<{ group_id: string }>) {
      counts.set(String(member.group_id), (counts.get(String(member.group_id)) ?? 0) + 1);
    }
    const list = (groups.json as GroupRow[])
      .map((row) => groupDto(row, counts.get(String(row.id)) ?? 0))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    res.json({
      office: { providerId: office.providerId, officeName: office.officeName },
      canEdit: office.actorKind !== "hq",
      groups: list,
    });
  } catch (error) {
    req.log?.error({ err: error }, "office patient groups failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

router.post("/office/patient-groups", async (req, res) => {
  const parsed = CreateGroup.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the group details." }); return; }
  try {
    const resolved = await scope(req, "provider_manage");
    if (resolved.kind !== "ok") { respondOfficeScopeDenied(req, res, resolved); return; }
    const office = resolved.scope;
    if (office.actorKind === "hq") { res.status(403).json({ error: HQ_READ_ONLY }); return; }
    if (await nameTaken(office, parsed.data.name, null)) { res.status(409).json({ error: NAME_TAKEN }); return; }
    const inserted = await supabaseAdmin("POST", "/rest/v1/patient_groups", {
      provider_id: office.providerId,
      name: parsed.data.name,
      description: parsed.data.description ? parsed.data.description : null,
      created_by: office.actorUserId,
    }, "return=representation");
    if (inserted.status === 409 || (inserted.status >= 300 && isUniqueViolation(inserted.json))) { res.status(409).json({ error: NAME_TAKEN }); return; }
    if (inserted.status >= 300) throw new Error(`patient group create failed (${inserted.status})`);
    const row = (Array.isArray(inserted.json) ? inserted.json[0] : inserted.json) as GroupRow;
    void audit(req, office, "patient_group_created", String(row.id));
    res.status(201).json({ group: groupDto(row, 0) });
  } catch (error) {
    req.log?.error({ err: error }, "office patient group create failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

router.patch("/office/patient-groups/:groupId", async (req, res) => {
  const parsed = UpdateGroup.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the group details." }); return; }
  try {
    const resolved = await scope(req, "provider_manage");
    if (resolved.kind !== "ok") { respondOfficeScopeDenied(req, res, resolved); return; }
    const office = resolved.scope;
    if (office.actorKind === "hq") { res.status(403).json({ error: HQ_READ_ONLY }); return; }
    const groupId = String(req.params.groupId ?? "");
    const existing = await loadGroup(office, groupId);
    if (!existing) { res.status(404).json({ error: GROUP_NOT_FOUND }); return; }
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (parsed.data.name !== undefined) {
      if (await nameTaken(office, parsed.data.name, groupId)) { res.status(409).json({ error: NAME_TAKEN }); return; }
      updates.name = parsed.data.name;
    }
    if (parsed.data.description !== undefined) updates.description = parsed.data.description ? parsed.data.description : null;
    const updated = await supabaseAdmin("PATCH", `/rest/v1/patient_groups?id=eq.${enc(groupId)}&provider_id=eq.${enc(office.providerId)}`, updates, "return=representation");
    if (updated.status === 409 || (updated.status >= 300 && isUniqueViolation(updated.json))) { res.status(409).json({ error: NAME_TAKEN }); return; }
    if (updated.status >= 300) throw new Error(`patient group update failed (${updated.status})`);
    const row = (Array.isArray(updated.json) ? updated.json[0] : updated.json) as GroupRow | undefined;
    if (!row) { res.status(404).json({ error: GROUP_NOT_FOUND }); return; }
    const count = await memberCount(office, groupId);
    void audit(req, office, "patient_group_renamed", groupId, {
      fields: [parsed.data.name !== undefined ? "name" : null, parsed.data.description !== undefined ? "description" : null].filter(Boolean).join(","),
    });
    res.json({ group: groupDto(row, count) });
  } catch (error) {
    req.log?.error({ err: error }, "office patient group update failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

router.delete("/office/patient-groups/:groupId", async (req, res) => {
  try {
    const resolved = await scope(req, "provider_manage");
    if (resolved.kind !== "ok") { respondOfficeScopeDenied(req, res, resolved); return; }
    const office = resolved.scope;
    if (office.actorKind === "hq") { res.status(403).json({ error: HQ_READ_ONLY }); return; }
    const groupId = String(req.params.groupId ?? "");
    const existing = await loadGroup(office, groupId);
    if (!existing) { res.status(404).json({ error: GROUP_NOT_FOUND }); return; }
    const count = await memberCount(office, groupId);
    const deleted = await supabaseAdmin("DELETE", `/rest/v1/patient_groups?id=eq.${enc(groupId)}&provider_id=eq.${enc(office.providerId)}`, undefined, "return=representation");
    if (deleted.status >= 300) throw new Error(`patient group delete failed (${deleted.status})`);
    void audit(req, office, "patient_group_deleted", groupId, { patients: count });
    res.json({ deleted: true, memberCount: count });
  } catch (error) {
    req.log?.error({ err: error }, "office patient group delete failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

router.put("/office/patient-groups/:groupId/members/:patientId", async (req, res) => {
  try {
    const resolved = await scope(req, "provider_manage");
    if (resolved.kind !== "ok") { respondOfficeScopeDenied(req, res, resolved); return; }
    const office = resolved.scope;
    if (office.actorKind === "hq") { res.status(403).json({ error: HQ_READ_ONLY }); return; }
    const groupId = String(req.params.groupId ?? "");
    const patientId = String(req.params.patientId ?? "");
    const group = await loadGroup(office, groupId);
    if (!group) { res.status(404).json({ error: GROUP_NOT_FOUND }); return; }
    const patient = await supabaseAdmin("GET", `/rest/v1/patients?id=eq.${enc(patientId)}&provider_id=eq.${enc(office.providerId)}&archived_at=is.null&select=id&limit=1`);
    if (patient.status >= 300) throw new Error(`patient group member patient lookup failed (${patient.status})`);
    if (!Array.isArray(patient.json) || !patient.json[0]) { res.status(404).json({ error: PATIENT_NOT_FOUND }); return; }
    const inserted = await supabaseAdmin("POST", "/rest/v1/patient_group_members", {
      group_id: groupId, patient_id: patientId, provider_id: office.providerId, added_by: office.actorUserId,
    }, "return=representation");
    const already = inserted.status === 409;
    if (!already && inserted.status >= 300) throw new Error(`patient group member add failed (${inserted.status})`);
    if (!already) void audit(req, office, "patient_group_member_added", groupId, { patientId });
    res.status(already ? 200 : 201).json({ membership: { groupId, patientId, added: !already } });
  } catch (error) {
    req.log?.error({ err: error }, "office patient group member add failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

router.delete("/office/patient-groups/:groupId/members/:patientId", async (req, res) => {
  try {
    const resolved = await scope(req, "provider_manage");
    if (resolved.kind !== "ok") { respondOfficeScopeDenied(req, res, resolved); return; }
    const office = resolved.scope;
    if (office.actorKind === "hq") { res.status(403).json({ error: HQ_READ_ONLY }); return; }
    const groupId = String(req.params.groupId ?? "");
    const patientId = String(req.params.patientId ?? "");
    const group = await loadGroup(office, groupId);
    if (!group) { res.status(404).json({ error: GROUP_NOT_FOUND }); return; }
    const removed = await supabaseAdmin(
      "DELETE",
      `/rest/v1/patient_group_members?group_id=eq.${enc(groupId)}&patient_id=eq.${enc(patientId)}&provider_id=eq.${enc(office.providerId)}`,
      undefined,
      "return=representation",
    );
    if (removed.status >= 300) throw new Error(`patient group member remove failed (${removed.status})`);
    const removedCount = Array.isArray(removed.json) ? removed.json.length : 0;
    if (removedCount > 0) void audit(req, office, "patient_group_member_removed", groupId, { patientId });
    res.json({ membership: { groupId, patientId, removed: removedCount > 0 } });
  } catch (error) {
    req.log?.error({ err: error }, "office patient group member remove failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

export default router;

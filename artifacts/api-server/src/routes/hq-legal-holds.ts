/**
 * HQ legal holds.
 *
 *  - GET  /hq/legal-holds?status=&providerId=   holds (active by default) with names resolved
 *  - POST /hq/legal-holds                         place a hold on one patient or a whole office
 *  - POST /hq/legal-holds/:id/lift                lift it (a second, separately audited action)
 *
 * A hold is the one thing that outranks every retention timer and the
 * patient's own deletion request: while it is active nothing about the
 * patient (or any patient of the office) is deleted. The SQL side owns the
 * rules (`legal_hold_place` / `legal_hold_lift` park and resume deletion
 * requests in the same transaction); this router gates, audits, and names.
 * Offices never write here — they only see a read-only badge — and the
 * patient app never learns a hold exists.
 */
import { Router, type IRouter, type Response } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase-admin";
import { recordAdminAuditEvent } from "../lib/admin-audit";
import { resolveAuditNames, type AuditRow } from "../lib/audit-events";
import { requireHqPermission, type StaffIdentity } from "../lib/staff-auth";

const router: IRouter = Router();
const enc = encodeURIComponent;

export const HOLD_SELECT = "id,target_kind,target_id,reason,placed_by,placed_at,lifted_at,lifted_by,lift_reason";

export interface LegalHoldRow {
  id: string;
  target_kind: "patient" | "provider";
  target_id: string;
  reason: string;
  placed_by: string | null;
  placed_at: string;
  lifted_at: string | null;
  lifted_by: string | null;
  lift_reason: string | null;
}

export interface HqLegalHoldDto {
  id: string;
  targetKind: "patient" | "provider";
  targetId: string;
  targetLabel: string | null;
  providerId: string | null;
  reason: string;
  placedBy: string | null;
  placedByName: string | null;
  placedAt: string;
  liftedAt: string | null;
  liftedBy: string | null;
  liftedByName: string | null;
  liftReason: string | null;
  active: boolean;
}

const Reason = z.string().trim().min(3, "Give a reason of at least 3 characters.").max(500, "Keep the reason under 500 characters.");
const PlaceInput = z.object({
  targetKind: z.enum(["patient", "provider"]),
  targetId: z.string().trim().min(1).max(120),
  reason: Reason,
});
const LiftInput = z.object({ reason: Reason });
const Query = z.object({
  status: z.enum(["active", "lifted", "all"]).default("active"),
  providerId: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().min(1).max(500).default(200),
});

const UUID = /^[0-9a-f-]{36}$/i;

function staffOf(res: Response): StaffIdentity {
  return res.locals.staff as StaffIdentity;
}

/** The office each held patient belongs to (a provider hold is its own office). */
async function patientOffices(rows: LegalHoldRow[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(rows.filter((r) => r.target_kind === "patient" && UUID.test(r.target_id)).map((r) => r.target_id))];
  const offices = new Map<string, string | null>();
  if (!ids.length) return offices;
  const list = `in.(${ids.map((id) => `"${id}"`).join(",")})`;
  const result = await supabaseAdmin("GET", `/rest/v1/patients?id=${list}&select=id,provider_id`);
  if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`hold patient lookup failed (${result.status})`);
  for (const row of result.json as Array<{ id: string; provider_id: string | null }>) offices.set(String(row.id), row.provider_id ?? null);
  return offices;
}

export async function legalHoldDtos(rows: LegalHoldRow[]): Promise<HqLegalHoldDto[]> {
  const offices = await patientOffices(rows);
  const providerOf = (row: LegalHoldRow) => (row.target_kind === "provider" ? row.target_id : offices.get(row.target_id) ?? null);
  // Reuse the audit name resolver: actors are HQ members, targets are patients/offices.
  const pseudo: AuditRow[] = rows.flatMap((row) =>
    [row.placed_by, row.lifted_by].map((actor) => ({
      id: 0, occurred_at: row.placed_at, action: "legal_hold_placed", actor_user_id: actor, actor_kind: "hq",
      provider_id: providerOf(row), target_kind: row.target_kind === "provider" ? "provider_account" : "patient",
      target_id: row.target_id, request_id: null, metadata: null,
    })),
  );
  const names = await resolveAuditNames(pseudo);
  return rows.map((row) => {
    const targetKey = `${row.target_kind === "provider" ? "provider_account" : "patient"}:${row.target_id}`;
    return {
      id: row.id,
      targetKind: row.target_kind,
      targetId: row.target_id,
      targetLabel: names.targets.get(targetKey) || null,
      providerId: providerOf(row),
      reason: row.reason,
      placedBy: row.placed_by,
      placedByName: row.placed_by ? names.actors.get(row.placed_by) || null : null,
      placedAt: row.placed_at,
      liftedAt: row.lifted_at,
      liftedBy: row.lifted_by,
      liftedByName: row.lifted_by ? names.actors.get(row.lifted_by) || null : null,
      liftReason: row.lift_reason,
      active: row.lifted_at === null,
    };
  });
}

router.get("/hq/legal-holds", requireHqPermission("audit_read"), async (req, res) => {
  const parsed = Query.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Check the legal hold filters." });
    return;
  }
  const { status, providerId, limit } = parsed.data;
  try {
    const filters = [`select=${HOLD_SELECT}`, "order=placed_at.desc", `limit=${Math.floor(limit)}`];
    if (status === "active") filters.push("lifted_at=is.null");
    if (status === "lifted") filters.push("lifted_at=not.is.null");
    const [list, active] = await Promise.all([
      supabaseAdmin("GET", `/rest/v1/legal_holds?${filters.join("&")}`),
      supabaseAdmin("GET", `/rest/v1/legal_holds?select=id&lifted_at=is.null&limit=5000`),
    ]);
    if (list.status >= 300 || !Array.isArray(list.json)) throw new Error(`hold list failed (${list.status})`);
    if (active.status >= 300 || !Array.isArray(active.json)) throw new Error(`hold count failed (${active.status})`);
    let holds = await legalHoldDtos(list.json as LegalHoldRow[]);
    if (providerId) holds = holds.filter((hold) => hold.providerId === providerId);
    res.json({ holds, activeCount: active.json.length });
  } catch (error) {
    req.log?.error({ err: error }, "HQ legal hold list failed");
    res.status(502).json({ error: "Could not load legal holds right now." });
  }
});

router.post("/hq/legal-holds", requireHqPermission("provider_manage"), async (req, res) => {
  const parsed = PlaceInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the hold details." });
    return;
  }
  const input = parsed.data;
  if (input.targetKind === "patient" && !UUID.test(input.targetId)) {
    res.status(404).json({ error: "Patient not found." });
    return;
  }
  const staff = staffOf(res);
  try {
    const placed = await supabaseAdmin("POST", "/rest/v1/rpc/legal_hold_place", {
      p_target_kind: input.targetKind,
      p_target_id: input.targetId,
      p_reason: input.reason,
      p_actor: staff.userId,
    });
    if (placed.status >= 300) {
      const message = String((placed.json as { message?: string } | null)?.message ?? "");
      if (/unknown patient|unknown office/.test(message)) {
        res.status(404).json({ error: input.targetKind === "patient" ? "Patient not found." : "Office not found." });
        return;
      }
      throw new Error(`hold place failed (${placed.status}) ${message}`);
    }
    const row = (Array.isArray(placed.json) ? placed.json[0] : placed.json) as LegalHoldRow | undefined;
    if (!row) throw new Error("hold place returned no row");
    const [hold] = await legalHoldDtos([row]);
    await recordAdminAuditEvent({
      action: "legal_hold_placed",
      actorUserId: staff.userId,
      actorKind: "hq",
      providerId: hold.providerId,
      targetKind: input.targetKind === "provider" ? "provider_account" : "patient",
      targetId: input.targetId,
      requestId: req.headers["x-request-id"]?.toString() ?? null,
      metadata: { holdId: row.id, targetKind: input.targetKind },
    }).catch((error) => req.log?.error({ err: error }, "legal hold audit failed"));
    res.json({ hold });
  } catch (error) {
    req.log?.error({ err: error }, "HQ legal hold place failed");
    res.status(502).json({ error: "Could not place that legal hold right now." });
  }
});

router.post("/hq/legal-holds/:id/lift", requireHqPermission("provider_manage"), async (req, res) => {
  const id = String(req.params.id ?? "");
  if (!UUID.test(id)) {
    res.status(404).json({ error: "Legal hold not found." });
    return;
  }
  const parsed = LiftInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Give a reason for lifting the hold." });
    return;
  }
  const staff = staffOf(res);
  try {
    const existing = await supabaseAdmin("GET", `/rest/v1/legal_holds?id=eq.${enc(id)}&select=${HOLD_SELECT}&limit=1`);
    if (existing.status >= 300 || !Array.isArray(existing.json)) throw new Error(`hold lookup failed (${existing.status})`);
    const current = existing.json[0] as LegalHoldRow | undefined;
    if (!current) {
      res.status(404).json({ error: "Legal hold not found." });
      return;
    }
    if (current.lifted_at !== null) {
      res.status(409).json({ error: "That hold was already lifted." });
      return;
    }
    const lifted = await supabaseAdmin("POST", "/rest/v1/rpc/legal_hold_lift", {
      p_hold_id: id,
      p_reason: parsed.data.reason,
      p_actor: staff.userId,
    });
    if (lifted.status >= 300) {
      const message = String((lifted.json as { message?: string } | null)?.message ?? "");
      if (/hold not active/.test(message)) {
        res.status(409).json({ error: "That hold was already lifted." });
        return;
      }
      throw new Error(`hold lift failed (${lifted.status}) ${message}`);
    }
    const row = (Array.isArray(lifted.json) ? lifted.json[0] : lifted.json) as LegalHoldRow | undefined;
    if (!row) throw new Error("hold lift returned no row");
    const [hold] = await legalHoldDtos([row]);
    await recordAdminAuditEvent({
      action: "legal_hold_lifted",
      actorUserId: staff.userId,
      actorKind: "hq",
      providerId: hold.providerId,
      targetKind: row.target_kind === "provider" ? "provider_account" : "patient",
      targetId: row.target_id,
      requestId: req.headers["x-request-id"]?.toString() ?? null,
      metadata: { holdId: row.id, targetKind: row.target_kind },
    }).catch((error) => req.log?.error({ err: error }, "legal hold lift audit failed"));
    res.json({ hold });
  } catch (error) {
    req.log?.error({ err: error }, "HQ legal hold lift failed");
    res.status(502).json({ error: "Could not lift that legal hold right now." });
  }
});

export default router;

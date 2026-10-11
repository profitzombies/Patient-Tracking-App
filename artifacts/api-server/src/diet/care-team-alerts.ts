/**
 * Diet care-team alerts as staff see them: the office bell, the Needs
 * attention page and the daily digest.
 *
 * Source of truth is the staff outbox itself (`staff_notifications` rows of
 * the three diet kinds). One event fans out to one row per recipient, so the
 * feed collapses rows to one alert per patient, kind and office-local day —
 * the same key notifyCareTeam dedupes on. Rows carry ids only; names are
 * joined behind office scope by the route that serves them.
 *
 * Pending safety blocks are a standing state, not an event: they come from
 * the roster facts RPC so the count is live until a provider reviews them.
 */
import { supabaseAdmin } from "../lib/supabase-admin";
import { loadOfficeDietFacts } from "./roster-facts";
import { DIET_STAFF_KINDS, isDietStaffKind, type DietStaffKind } from "./push-kinds";
import type { DigestReasonCount } from "../alerts/staff-sender";

type Row = Record<string, unknown>;
const enc = encodeURIComponent;

/** Staff-facing label per kind: names the event, never the diet, answer or allergen. */
export const DIET_ALERT_KIND_LABELS: Record<DietStaffKind, string> = {
  diet_change: "Eating plan changed",
  diet_safety: "Eating plan needs review",
  diet_allergy_severe: "Severe allergy recorded",
};

export interface DietCareTeamAlert {
  /** The first outbox row id behind this alert (stable per patient / kind / day). */
  id: string;
  kind: DietStaffKind;
  kindLabel: string;
  patientId: string;
  /** Office-local day the event was queued on. */
  day: string;
  createdAt: string;
  refs: { selectionId: string | null; blockId: string | null; itemId: string | null };
}

export const DIET_ALERT_FEED_DAYS = 7;

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** Recent diet alerts for one office, newest first, one per patient / kind / day. Throws on a read failure. */
export async function loadDietCareTeamAlerts(providerId: string, now: Date, windowDays = DIET_ALERT_FEED_DAYS): Promise<DietCareTeamAlert[]> {
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60_000).toISOString();
  const result = await supabaseAdmin(
    "GET",
    `/rest/v1/staff_notifications?provider_id=eq.${enc(providerId)}&kind=in.(${DIET_STAFF_KINDS.join(",")})&created_at=gte.${enc(since)}&select=id,kind,data,created_at&order=created_at.desc&limit=2000`,
  );
  if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`diet alert feed failed (${result.status})`);
  const seen = new Set<string>();
  const alerts: DietCareTeamAlert[] = [];
  for (const row of result.json as Row[]) {
    if (!isDietStaffKind(row.kind)) continue;
    const data = (row.data ?? {}) as Row;
    const patientId = str(data.patientId);
    if (!patientId) continue;
    const day = str(data.day) ?? String(row.created_at ?? "").slice(0, 10);
    const key = `${row.kind}:${patientId}:${day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    alerts.push({
      id: String(row.id), kind: row.kind, kindLabel: DIET_ALERT_KIND_LABELS[row.kind], patientId, day,
      createdAt: String(row.created_at ?? ""),
      refs: { selectionId: str(data.selectionId), blockId: str(data.blockId), itemId: str(data.itemId) },
    });
  }
  return alerts;
}

export interface PendingDietBlock { patientId: string; blockId: string; createdAt: string | null }

/** Patients whose newest safety block still awaits provider review. Throws when the facts RPC fails. */
export async function loadPendingDietBlocks(providerId: string, now: Date): Promise<PendingDietBlock[]> {
  const facts = await loadOfficeDietFacts(providerId, now);
  const blocks: PendingDietBlock[] = [];
  for (const [patientId, dto] of facts) {
    if (dto.pendingBlock) blocks.push({ patientId, blockId: dto.pendingBlock.id, createdAt: dto.pendingBlock.createdAt });
  }
  return blocks.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

/**
 * Generic line the outbound digest may carry for the diet family. Email and
 * push leave through vendors without a BAA, so the line never names the
 * event kind (a severe allergy or a safety block is clinical content): it
 * is one count of patients with something to review on their record, and
 * the per-kind labels stay on the authenticated office alerts page.
 */
export const DIET_DIGEST_LINE_LABEL = "Eating plan items to review";

/**
 * Digest lines for the diet family: at most ONE generic line counting the
 * distinct patients behind pending safety blocks (standing) and the diet
 * alerts of the last 24 hours. No kind, diet, answer or allergen rides along.
 */
export function dietDigestCounts(input: { alerts: ReadonlyArray<Pick<DietCareTeamAlert, "kind" | "patientId" | "createdAt">>; pendingBlocks: ReadonlyArray<Pick<PendingDietBlock, "patientId">>; now: Date }): DigestReasonCount[] {
  const count = dietDigestPatientIds(input).size;
  return count ? [{ label: DIET_DIGEST_LINE_LABEL, count }] : [];
}

/** Distinct patients behind the diet lines, for the digest's headline count. */
export function dietDigestPatientIds(input: { alerts: ReadonlyArray<Pick<DietCareTeamAlert, "patientId" | "createdAt">>; pendingBlocks: ReadonlyArray<Pick<PendingDietBlock, "patientId">>; now: Date }): Set<string> {
  const since = input.now.getTime() - 24 * 60 * 60_000;
  const ids = new Set(input.pendingBlocks.map((block) => block.patientId));
  for (const alert of input.alerts) { const at = Date.parse(alert.createdAt); if (Number.isFinite(at) && at >= since) ids.add(alert.patientId); }
  return ids;
}

/**
 * Export kinds, who may request them, and how each request is scoped.
 *
 * Scope is decided ONCE, at request time, and frozen onto the job row
 * (`provider_id`, `requester_kind`, `requester_role`, `params`). The
 * background generator reads only that frozen scope — it never re-derives
 * permissions from a token that may have widened since. Office staff are
 * always pinned to their own office; HQ names an office explicitly or, for
 * network-wide kinds, exports every enabled office.
 *
 * Patient-level rows (patient activity) are the one place HQ is held to a
 * stricter bar: they need `provider_manage`. Every other HQ export is
 * aggregate or already-visible directory/audit/training data.
 */
import { resolveOfficeScope } from "../auth/office-scope";
import {
  hasHqPermission,
  verifyStaffToken,
  type HqDepartmentRole,
  type HqPermission,
  type StaffIdentity,
} from "../lib/staff-auth";
import { supabaseAdmin } from "../lib/supabase-admin";
import type { DateRangeKeys } from "../routes/operational-rollups";

export const EXPORT_KINDS = [
  "office_comparison",
  "patient_activity",
  "audit_events",
  "training_completion",
  "provider_directory",
  "billing_transactions",
  "billing_subscriptions",
  "billing_payouts",
  "patient_record",
] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export function isExportKind(value: unknown): value is ExportKind {
  return typeof value === "string" && (EXPORT_KINDS as readonly string[]).includes(value);
}

export const EXPORT_KIND_LABELS: Record<ExportKind, string> = {
  office_comparison: "Office comparison",
  patient_activity: "Patient activity summary",
  audit_events: "Audit events",
  training_completion: "Training completion",
  provider_directory: "Provider account directory",
  billing_transactions: "Billing transactions",
  billing_subscriptions: "Billing subscriptions",
  billing_payouts: "Billing payouts",
  patient_record: "Patient record",
};

/** Kinds whose rows are bounded by a date range (others ignore start/end). */
export const RANGED_KINDS: ReadonlySet<ExportKind> = new Set<ExportKind>([
  "office_comparison",
  "patient_activity",
  "audit_events",
  "training_completion",
  "billing_transactions",
  "billing_subscriptions",
  "billing_payouts",
]);

/**
 * Kinds that concern exactly one patient (the request must name one). Office
 * owners/admins and HQ with provider management may request them; office
 * staff may not — a whole record leaving the building is an owner decision.
 */
export const PATIENT_KINDS: ReadonlySet<ExportKind> = new Set<ExportKind>(["patient_record"]);

export type ExportRequester =
  | { kind: "hq"; userId: string; identity: StaffIdentity }
  | {
      kind: "office";
      userId: string;
      actorKind: "provider" | "team_member";
      providerId: string;
      officeName: string;
      officeRole: "owner" | "admin" | "staff";
    };

export type RequesterResult =
  | { kind: "ok"; requester: ExportRequester }
  | { kind: "denied"; status: number; message: string };

/**
 * Who is asking? HQ memberships win (an HQ admin is never also office
 * staff); otherwise the bearer must resolve to exactly one office.
 */
export async function resolveExportRequester(authorization: string | undefined): Promise<RequesterResult> {
  const header = authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) return { kind: "denied", status: 401, message: "Sign in to continue." };
  const staff = await verifyStaffToken(token);
  if (staff) return { kind: "ok", requester: { kind: "hq", userId: staff.userId, identity: staff } };
  const office = await resolveOfficeScope({
    authorization,
    explicitOfficeId: null,
    hqPermission: "provider_read",
    requireUnlocked: false,
  });
  if (office.kind !== "ok") return office;
  if (office.scope.actorKind === "hq") {
    // Unreachable in practice (HQ resolved above), but never let an HQ
    // caller through the office branch without an explicit office.
    return { kind: "denied", status: 403, message: "Only office staff can use this." };
  }
  return {
    kind: "ok",
    requester: {
      kind: "office",
      userId: office.scope.actorUserId,
      actorKind: office.scope.actorKind,
      providerId: office.scope.providerId,
      officeName: office.scope.officeName,
      officeRole: office.scope.officeRole,
    },
  };
}

export interface ExportScope {
  /** Office the export is pinned to; null = every enabled office (HQ only). */
  providerId: string | null;
  officeName: string | null;
  requesterKind: "hq" | "provider" | "team_member";
  requesterRole: HqDepartmentRole | null;
  range: DateRangeKeys | null;
  /** Set for PATIENT_KINDS only: the one patient the job is about. */
  patient: { id: string; name: string } | null;
}

export type ScopeResult =
  | { kind: "ok"; scope: ExportScope }
  | { kind: "denied"; status: number; message: string };

const HQ_PERMISSION_FOR_KIND: Record<ExportKind, HqPermission> = {
  office_comparison: "analytics_read",
  patient_activity: "provider_manage",
  audit_events: "audit_read",
  training_completion: "analytics_read",
  provider_directory: "provider_contact_read",
  billing_transactions: "financial_read",
  billing_subscriptions: "financial_read",
  billing_payouts: "financial_read",
  patient_record: "provider_manage",
};

/** HQ kinds that may run network-wide (no office named). */
const NETWORK_WIDE: ReadonlySet<ExportKind> = new Set<ExportKind>([
  "office_comparison",
  "audit_events",
  "training_completion",
  "provider_directory",
  "billing_transactions",
  "billing_subscriptions",
  "billing_payouts",
]);

const NO_ACCESS = "You don't have access to that export.";

export async function authorizeExport(input: {
  requester: ExportRequester;
  authorization: string | undefined;
  kind: ExportKind;
  requestedOffice: string | null;
  range: DateRangeKeys | null;
  patientId?: string | null;
}): Promise<ScopeResult> {
  const { requester, kind } = input;
  const range = RANGED_KINDS.has(kind) ? input.range : null;
  if (RANGED_KINDS.has(kind) && !range) {
    return { kind: "denied", status: 400, message: "Choose a date range for this export." };
  }
  const patientId = PATIENT_KINDS.has(kind) ? input.patientId ?? null : null;
  if (PATIENT_KINDS.has(kind) && !patientId) {
    return { kind: "denied", status: 400, message: "Choose a patient for this export." };
  }

  if (requester.kind === "office") {
    if (kind === "provider_directory") return { kind: "denied", status: 403, message: NO_ACCESS };
    if (kind.startsWith("billing_") && requester.officeRole === "staff") {
      return { kind: "denied", status: 403, message: NO_ACCESS };
    }
    if (PATIENT_KINDS.has(kind) && requester.officeRole === "staff") {
      return { kind: "denied", status: 403, message: "Only office owners and admins can download a patient's full record." };
    }
    const patient = patientId ? await findOfficePatient(requester.providerId, patientId) : null;
    if (patientId && !patient) return { kind: "denied", status: 404, message: PATIENT_NOT_FOUND };
    return {
      kind: "ok",
      scope: {
        providerId: requester.providerId,
        officeName: requester.officeName,
        requesterKind: requester.actorKind,
        requesterRole: null,
        range,
        patient,
      },
    };
  }

  const permission = HQ_PERMISSION_FOR_KIND[kind];
  const hqRole = requester.identity.departmentRole;
  if (!hasHqPermission(requester.identity, permission)) {
    if (kind === "patient_activity") {
      return {
        kind: "denied",
        status: 403,
        message:
          "Patient-level exports need provider management access. Use the office comparison export for aggregate figures.",
      };
    }
    // Training completion is also open to the content team.
    if (!(kind === "training_completion" && hasHqPermission(requester.identity, "content_manage"))) {
      return { kind: "denied", status: 403, message: NO_ACCESS };
    }
  }

  if (!input.requestedOffice) {
    if (!NETWORK_WIDE.has(kind)) {
      return { kind: "denied", status: 400, message: "Choose an office for this export." };
    }
    return {
      kind: "ok",
      scope: { providerId: null, officeName: null, requesterKind: "hq", requesterRole: hqRole, range, patient: null },
    };
  }

  // An explicit office must exist and be enabled; resolveOfficeScope owns
  // that check (and canonicalises seeded `acct-` ids).
  const office = await resolveOfficeScope({
    authorization: input.authorization,
    explicitOfficeId: input.requestedOffice,
    hqPermission: kind === "training_completion" && !hasHqPermission(requester.identity, permission) ? "content_manage" : permission,
    requireUnlocked: false,
  });
  if (office.kind !== "ok") return office;
  const patient = patientId ? await findOfficePatient(office.scope.providerId, patientId) : null;
  if (patientId && !patient) return { kind: "denied", status: 404, message: PATIENT_NOT_FOUND };
  return {
    kind: "ok",
    scope: {
      providerId: office.scope.providerId,
      officeName: office.scope.officeName,
      requesterKind: "hq",
      requesterRole: hqRole,
      range,
      patient,
    },
  };
}

const PATIENT_NOT_FOUND = "That patient isn't in this office.";

/**
 * The patient must belong to the resolved office. Every chart state counts
 * (open, paused, discharged, closed) — a right-of-access request does not
 * care whether the patient is still active. Purged patients have no row.
 */
export async function findOfficePatient(providerId: string, patientId: string): Promise<{ id: string; name: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(patientId)) return null;
  const res = await supabaseAdmin(
    "GET",
    `/rest/v1/patients?id=eq.${encodeURIComponent(patientId)}&provider_id=eq.${encodeURIComponent(providerId)}&select=id,first_name,last_name,name&limit=1`,
  );
  if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`patient lookup failed (${res.status})`);
  const row = res.json[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const full = [row.first_name, row.last_name].filter((part) => typeof part === "string" && part.trim()).map((part) => String(part).trim()).join(" ");
  const name = full || (typeof row.name === "string" && row.name.trim()) || "Patient";
  return { id: String(row.id), name };
}

/** Human file name: kind + scope + range, safe for the file_name check. */
export function exportFileName(kind: ExportKind, scope: ExportScope, now = new Date()): string {
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  const parts = ["thinnr", kind.replace(/_/g, "-")];
  if (scope.patient) {
    // Patient records are ZIP parts named from this stem (see patient-record.ts).
    parts.push(slug(scope.patient.name) || "patient", now.toISOString().slice(0, 10));
    return `${parts.join("_")}.zip`;
  }
  if (scope.officeName) parts.push(slug(scope.officeName) || "office");
  else if (scope.providerId) parts.push(slug(scope.providerId));
  else parts.push("all-offices");
  if (scope.range) parts.push(`${scope.range.start}_${scope.range.end}`);
  return `${parts.join("_")}.csv`;
}

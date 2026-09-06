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
import type { DateRangeKeys } from "../routes/operational-rollups";

export const EXPORT_KINDS = [
  "office_comparison",
  "patient_activity",
  "audit_events",
  "training_completion",
  "provider_directory",
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
};

/** Kinds whose rows are bounded by a date range (others ignore start/end). */
export const RANGED_KINDS: ReadonlySet<ExportKind> = new Set<ExportKind>([
  "office_comparison",
  "patient_activity",
  "audit_events",
  "training_completion",
]);

export type ExportRequester =
  | { kind: "hq"; userId: string; identity: StaffIdentity }
  | {
      kind: "office";
      userId: string;
      actorKind: "provider" | "team_member";
      providerId: string;
      officeName: string;
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
};

/** HQ kinds that may run network-wide (no office named). */
const NETWORK_WIDE: ReadonlySet<ExportKind> = new Set<ExportKind>([
  "office_comparison",
  "audit_events",
  "training_completion",
  "provider_directory",
]);

const NO_ACCESS = "You don't have access to that export.";

export async function authorizeExport(input: {
  requester: ExportRequester;
  authorization: string | undefined;
  kind: ExportKind;
  requestedOffice: string | null;
  range: DateRangeKeys | null;
}): Promise<ScopeResult> {
  const { requester, kind } = input;
  const range = RANGED_KINDS.has(kind) ? input.range : null;
  if (RANGED_KINDS.has(kind) && !range) {
    return { kind: "denied", status: 400, message: "Choose a date range for this export." };
  }

  if (requester.kind === "office") {
    if (kind === "provider_directory") return { kind: "denied", status: 403, message: NO_ACCESS };
    return {
      kind: "ok",
      scope: {
        providerId: requester.providerId,
        officeName: requester.officeName,
        requesterKind: requester.actorKind,
        requesterRole: null,
        range,
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
      scope: { providerId: null, officeName: null, requesterKind: "hq", requesterRole: hqRole, range },
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
  return {
    kind: "ok",
    scope: {
      providerId: office.scope.providerId,
      officeName: office.scope.officeName,
      requesterKind: "hq",
      requesterRole: hqRole,
      range,
    },
  };
}

/** Human file name: kind + scope + range, safe for the file_name check. */
export function exportFileName(kind: ExportKind, scope: ExportScope): string {
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  const parts = ["thinnr", kind.replace(/_/g, "-")];
  if (scope.officeName) parts.push(slug(scope.officeName) || "office");
  else if (scope.providerId) parts.push(slug(scope.providerId));
  else parts.push("all-offices");
  if (scope.range) parts.push(`${scope.range.start}_${scope.range.end}`);
  return `${parts.join("_")}.csv`;
}

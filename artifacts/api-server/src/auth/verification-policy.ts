/**
 * The one place that decides how a request's bearer token is verified.
 *
 *   local   — signature/expiry/issuer/audience checked against the
 *             project's published keys, then the session id is checked
 *             against the server's revocation list. No call to Supabase
 *             Auth. This is the default for every route.
 *   remote  — Supabase Auth (`/auth/v1/user`) confirms the session itself,
 *             so even a revocation the list never saw (a session ended
 *             straight in the Supabase dashboard, a deleted user) bites
 *             instantly. Reserved for the families where that guarantee is
 *             worth a second network hop on every call: moving money,
 *             privacy/deletion, and security settings.
 *
 * Paths are matched relative to the API mount (`/api` is stripped when
 * present) so route tests that mount routers at the root see the same
 * answers as production.
 */
export type VerificationMode = "local" | "remote";

export interface VerificationRequest {
  method?: string;
  originalUrl?: string;
  url?: string;
}

interface RemoteFamily {
  family: string;
  why: string;
  matches: (method: string, path: string) => boolean;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export const REMOTE_VERIFICATION_FAMILIES: readonly RemoteFamily[] = [
  {
    family: "billing writes",
    why: "money moves; a revoked device must not be able to charge, refund, or change a subscription",
    matches: (method, path) =>
      WRITE_METHODS.has(method) && (under(path, "/billing") || under(path, "/patient-data/billing") || under(path, "/office/launch")),
  },
  {
    family: "privacy and deletion",
    why: "consent, exports, and account deletion must only ever come from a session Supabase still vouches for",
    matches: (_method, path) =>
      under(path, "/patient-data/privacy") ||
      under(path, "/patient-data/consent") ||
      under(path, "/patient-data/export") ||
      under(path, "/patient-data/deletion") ||
      under(path, "/hq/patient-deletions"),
  },
  {
    family: "security settings",
    why: "session management, password changes, and staff sign-outs are the controls that revoke other sessions",
    matches: (_method, path) =>
      under(path, "/security") ||
      /^\/office\/patients\/[^/]+\/(sessions|sign-out)$/.test(path) ||
      /^\/office\/team\/[^/]+\/(sessions|sign-out)$/.test(path) ||
      /^\/hq-team\/[^/]+\/(sessions|sign-out)$/.test(path),
  },
];

/** Path relative to the API mount, without query string or trailing slash. */
export function normalizeRoutePath(rawUrl: string | undefined): string {
  let path = (rawUrl ?? "").split("?")[0].split("#")[0];
  if (path.startsWith("/api/") || path === "/api") path = path.slice("/api".length);
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path || "/";
}

/** Which remote family a request belongs to, or null when local verification applies. */
export function remoteVerificationFamily(req: VerificationRequest | undefined): string | null {
  if (!req) return null;
  const method = (req.method ?? "GET").toUpperCase();
  const path = normalizeRoutePath(req.originalUrl ?? req.url);
  const family = REMOTE_VERIFICATION_FAMILIES.find((candidate) => candidate.matches(method, path));
  return family ? family.family : null;
}

export function verificationModeFor(req: VerificationRequest | undefined): VerificationMode {
  return remoteVerificationFamily(req) ? "remote" : "local";
}

/**
 * Test double for `supabaseAdmin` covering the PostgREST subset the privacy
 * routes and workers use: eq / in / lt / is filters, order, limit, select
 * passthrough, insert with merge-duplicates upsert, patch-by-filter, delete,
 * and the lifecycle RPCs re-implemented over the same in-memory tables (the
 * real SQL is proven separately by purge.sql.test.ts on real PostgreSQL).
 */
type Row = Record<string, unknown>;

export interface FakeSupabase {
  tables: Record<string, Row[]>;
  calls: Array<{ method: string; path: string; body?: unknown }>;
  authDeletes: string[];
  /** Force the next matching request to fail with this status. */
  failNext: { match: RegExp; status: number } | null;
  handler: (method: string, path: string, body?: unknown, prefer?: string) => Promise<{ status: number; json: unknown }>;
  reset(): void;
}

let seq = 0;
export const fakeUuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const nextId = () => fakeUuid(9000 + ++seq);

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, raw] of params.entries()) {
    if (["select", "order", "limit", "offset", "on_conflict"].includes(key)) continue;
    const value = String(row[key] ?? "");
    if (raw.startsWith("eq.")) {
      if (value !== raw.slice(3)) return false;
    } else if (raw.startsWith("neq.")) {
      if (value === raw.slice(4)) return false;
    } else if (raw === "not.is.null") {
      if (row[key] == null) return false;
    } else if (raw.startsWith("in.(")) {
      const set = raw.slice(4, -1).split(",");
      if (!set.includes(value)) return false;
    } else if (raw.startsWith("lt.")) {
      if (!(value < raw.slice(3))) return false;
    } else if (raw.startsWith("is.null")) {
      if (row[key] != null) return false;
    } else {
      throw new Error(`fake supabase: unsupported filter ${key}=${raw}`);
    }
  }
  return true;
}

function ordered(rows: Row[], params: URLSearchParams): Row[] {
  const order = params.get("order");
  const out = [...rows];
  if (order) {
    const [first] = order.split(",");
    const [column, direction] = first.split(".");
    out.sort((a, b) => {
      const rawA = a[column];
      const rawB = b[column];
      const comparison =
        typeof rawA === "number" && typeof rawB === "number"
          ? rawA - rawB
          : String(rawA ?? "").localeCompare(String(rawB ?? ""));
      return Math.sign(comparison) * (direction === "desc" ? -1 : 1);
    });
  }
  const limit = params.get("limit");
  const offset = Number(params.get("offset") ?? 0);
  return limit ? out.slice(offset, offset + Number(limit)) : out.slice(offset);
}

/**
 * Plain column lists project like PostgREST does (a column the fixture never
 * set comes back null), so an export that forgets to select a new column is
 * caught by the tests. Embedded or aliased selects pass rows through.
 */
function projected(rows: Row[], params: URLSearchParams): Row[] {
  const select = params.get("select");
  if (!select || select === "*" || /[():!*]/.test(select)) return rows;
  const columns = select.split(",").map((c) => c.trim()).filter(Boolean);
  return rows.map((row) => Object.fromEntries(columns.map((c) => [c, c in row ? row[c] : null])));
}

export function createFakeSupabase(): FakeSupabase {
  const fake: FakeSupabase = {
    tables: {},
    calls: [],
    authDeletes: [],
    failNext: null,
    reset() {
      fake.tables = {
        patients: [],
        patient_consents: [],
        patient_data_exports: [],
        patient_deletion_requests: [],
        patient_tombstones: [],
        admin_audit_events: [],
        patient_notifications: [],
        billing_subscriptions: [],
        billing_payers: [],
        billing_products: [],
        billing_connected_accounts: [],
        billing_orders: [],
        billing_order_items: [],
        auth_session_revocations: [],
        patient_app_presence: [],
      };
      fake.calls = [];
      fake.authDeletes = [];
      fake.failNext = null;
    },
    async handler(method, path, body, prefer) {
      fake.calls.push({ method, path, body });
      if (fake.failNext && fake.failNext.match.test(`${method} ${path}`)) {
        const status = fake.failNext.status;
        fake.failNext = null;
        return { status, json: { message: "forced failure" } };
      }
      const url = new URL(path, "http://fake");
      const params = url.searchParams;
      const now = new Date().toISOString();

      if (url.pathname.startsWith("/auth/v1/admin/users/") && method === "DELETE") {
        const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
        if (fake.authDeletes.includes(id)) return { status: 404, json: { message: "User not found" } };
        fake.authDeletes.push(id);
        return { status: 200, json: {} };
      }

      if (url.pathname.startsWith("/rest/v1/rpc/")) {
        const rpc = url.pathname.slice("/rest/v1/rpc/".length);
        const args = (body ?? {}) as Row;
        switch (rpc) {
          case "record_admin_audit_event":
            fake.tables.admin_audit_events.push({ ...args, occurred_at: now });
            return { status: 204, json: null };
          case "security_revoke_auth_sessions": {
            // One live session per auth user, so the purge's atomic
            // revoke-and-end step is observable as an auth_session_revocations row.
            const sessionId = `00000000-0000-4000-8000-${String(args.p_user_id).replace(/[^0-9a-f]/gi, "").padEnd(12, "0").slice(0, 12)}`;
            fake.tables.auth_session_revocations.push({ session_id: sessionId, user_id: args.p_user_id, reason: args.p_reason, revoked_at: now, expires_at: new Date(Date.now() + Number(args.p_ttl_seconds) * 1000).toISOString() });
            return { status: 200, json: 1 };
          }
          case "patient_deletion_request": {
            const patient = fake.tables.patients.find((p) => p.id === args.p_patient_id && !p.archived_at);
            if (!patient) return { status: 400, json: { message: "unknown patient" } };
            let row = fake.tables.patient_deletion_requests.find(
              (r) => r.patient_id === args.p_patient_id && ["pending", "purging", "failed"].includes(String(r.status)),
            );
            if (!row) {
              row = {
                id: nextId(),
                patient_id: patient.id,
                provider_id: patient.provider_id ?? null,
                auth_user_id: patient.auth_user_id ?? null,
                status: "pending",
                requested_at: now,
                purge_after: new Date(Date.now() + Number(args.p_grace_seconds ?? 604800) * 1000).toISOString(),
                cancelled_at: null,
                started_at: null,
                purged_at: null,
                attempts: 0,
                next_attempt_at: null,
                lease_owner: null,
                lease_until: null,
                last_error: null,
                steps: {},
              };
              fake.tables.patient_deletion_requests.push(row);
            }
            patient.deletion_requested_at = patient.deletion_requested_at ?? now;
            return { status: 200, json: [row] };
          }
          case "patient_deletion_cancel": {
            const open = fake.tables.patient_deletion_requests.filter((r) => r.patient_id === args.p_patient_id && r.status === "pending");
            for (const row of open) {
              row.status = "cancelled";
              row.cancelled_at = now;
            }
            const patient = fake.tables.patients.find((p) => p.id === args.p_patient_id);
            if (open.length > 0 && patient) patient.deletion_requested_at = null;
            return { status: 200, json: open.length > 0 };
          }
          case "claim_due_patient_deletions": {
            const due = fake.tables.patient_deletion_requests
              .filter(
                (r) =>
                  (r.status === "pending" && String(r.purge_after) <= now) ||
                  (r.status === "failed" && r.next_attempt_at != null && String(r.next_attempt_at) <= now) ||
                  (r.status === "purging" && (r.lease_until == null || String(r.lease_until) < now)),
              )
              .slice(0, Number(args.p_limit ?? 5));
            for (const row of due) {
              row.status = "purging";
              row.started_at = row.started_at ?? now;
              row.attempts = Number(row.attempts) + 1;
              row.lease_owner = args.p_owner;
              row.lease_until = new Date(Date.now() + Number(args.p_lease_seconds ?? 600) * 1000).toISOString();
            }
            return { status: 200, json: due.map((r) => ({ ...r })) };
          }
          case "patient_purge_prepare_tombstone": {
            const req = fake.tables.patient_deletion_requests.find((r) => r.id === args.p_request_id);
            if (!req || req.status !== "purging") return { status: 400, json: false };
            const patient = fake.tables.patients.find((p) => p.id === req.patient_id);
            if (patient && !fake.tables.patient_tombstones.some((t) => t.id === req.patient_id)) {
              fake.tables.patient_tombstones.push({
                id: req.patient_id,
                provider_id: patient.provider_id ?? null,
                requested_at: req.requested_at,
                purged_at: now,
                was_activated: patient.activation_status === "activated",
                program_id: patient.program_id ?? null,
                enrolled_on: patient.program_start_date ?? null,
              });
            }
            return { status: 200, json: fake.tables.patient_tombstones.some((t) => t.id === req.patient_id) };
          }
          case "patient_purge_rows": {
            const req = fake.tables.patient_deletion_requests.find((r) => r.id === args.p_request_id);
            if (!req) return { status: 400, json: { message: "unknown deletion request" } };
            if (req.status !== "purging") return { status: 400, json: { message: "deletion request is not being purged" } };
            const pid = req.patient_id;
            const patient = fake.tables.patients.find((p) => p.id === pid);
            if (patient && !fake.tables.patient_tombstones.some((t) => t.id === pid)) {
              fake.tables.patient_tombstones.push({
                id: pid,
                provider_id: patient.provider_id ?? null,
                requested_at: req.requested_at,
                purged_at: now,
                was_activated: patient.activation_status === "activated",
                program_id: patient.program_id ?? null,
                enrolled_on: patient.program_start_date ?? null,
              });
            }
            const tables: Record<string, number> = {};
            for (const [name, rows] of Object.entries(fake.tables)) {
              if (["patients", "patient_deletion_requests", "patient_tombstones", "admin_audit_events"].includes(name)) continue;
              const before = rows.length;
              fake.tables[name] = rows.filter((r) => r.patient_id !== pid);
              tables[name] = before - fake.tables[name].length;
            }
            fake.tables.patients = fake.tables.patients.filter((p) => p.id !== pid);
            return {
              status: 200,
              json: { patientRowDeleted: Boolean(patient), tombstone: true, analyticsDetached: 0, tables, authUserId: req.auth_user_id ?? null },
            };
          }
          case "patient_deletion_finish": {
            const req = fake.tables.patient_deletion_requests.find((r) => r.id === args.p_request_id && r.status === "purging");
            if (!req) return { status: 200, json: [] };
            req.status = args.p_status;
            req.purged_at = args.p_status === "purged" ? now : req.purged_at;
            req.last_error = args.p_status === "failed" ? args.p_error ?? null : null;
            req.next_attempt_at =
              args.p_status === "failed" && args.p_retry_after_seconds != null
                ? new Date(Date.now() + Number(args.p_retry_after_seconds) * 1000).toISOString()
                : null;
            req.lease_owner = null;
            req.lease_until = null;
            req.steps = args.p_steps ?? {};
            return { status: 200, json: [{ ...req }] };
          }
          case "claim_next_patient_data_export": {
            const job = fake.tables.patient_data_exports
              .filter((r) => r.status === "queued")
              .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
            if (!job) return { status: 200, json: [] };
            job.status = "running";
            job.started_at = now;
            job.attempts = Number(job.attempts) + 1;
            return { status: 200, json: [{ ...job }] };
          }
          default:
            throw new Error(`fake supabase: unknown rpc ${rpc}`);
        }
      }

      const table = url.pathname.replace("/rest/v1/", "");
      const rows = fake.tables[table];
      if (!rows) throw new Error(`fake supabase: unknown table ${table}`);
      if (method === "GET") return { status: 200, json: projected(ordered(rows.filter((r) => matches(r, params)), params), params) };
      if (method === "POST") {
        const incoming = (Array.isArray(body) ? body : [body]) as Row[];
        const out: Row[] = [];
        for (const item of incoming) {
          const conflict = params.get("on_conflict")?.split(",");
          const existing = conflict ? rows.find((r) => conflict.every((c) => r[c] === item[c])) : undefined;
          if (existing) {
            if (!prefer?.includes("merge-duplicates")) return { status: 409, json: { message: "duplicate key" } };
            Object.assign(existing, item);
            out.push(existing);
            continue;
          }
          const row: Row = { id: nextId(), created_at: now, ...defaultsFor(table), ...item };
          rows.push(row);
          out.push(row);
        }
        return { status: 201, json: prefer?.includes("return=representation") ? out : null };
      }
      if (method === "PATCH") {
        const hit = rows.filter((r) => matches(r, params));
        for (const row of hit) Object.assign(row, body as Row);
        return { status: 200, json: prefer?.includes("return=representation") ? hit : null };
      }
      if (method === "DELETE") {
        const hit = rows.filter((r) => matches(r, params));
        fake.tables[table] = rows.filter((r) => !hit.includes(r));
        return { status: 200, json: prefer?.includes("return=representation") ? hit : null };
      }
      throw new Error(`fake supabase: unsupported ${method} ${path}`);
    },
  };
  fake.reset();
  return fake;
}

function defaultsFor(table: string): Row {
  if (table === "patient_data_exports") {
    return { object_path: null, size_bytes: null, error: null, attempts: 0, started_at: null, completed_at: null, notified_at: null, download_count: 0, last_downloaded_at: null };
  }
  return {};
}

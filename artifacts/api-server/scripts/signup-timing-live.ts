/**
 * Live timing harness for the patient "Create account" wait — from the
 * completion request to the moment the app has what it needs to paint the
 * consent page. Synthetic only: one throwaway office, one verified signup
 * capability per run, everything removed afterwards.
 *
 *   SIGNUP_TIMING_API_BASE_URL=http://localhost:80/api \
 *     pnpm --filter @workspace/api-server exec tsx scripts/signup-timing-live.ts [runs]
 *
 * For each run it prints:
 *  - the server's own stage breakdown (Server-Timing header on the
 *    completion response) and the round trip seen by the caller;
 *  - the client sign-in (token-hash verify against GoTrue);
 *  - the entry-gate fetches the app would otherwise make before consent can
 *    render (account lookup, then state + profile, then privacy), so the
 *    cost the app now skips for a fresh account stays measurable.
 *
 * Output is limited to stage names and milliseconds.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

const API = (process.env.SIGNUP_TIMING_API_BASE_URL ?? "http://localhost:80/api").replace(/\/$/, "");
const SUPABASE_URL = required("SUPABASE_URL").replace(/\/$/, "");
const SERVICE = required("SUPABASE_SERVICE_ROLE_KEY");
const ANON = required("SUPABASE_ANON_KEY");
const MANAGEMENT = required("SUPABASE_ACCESS_TOKEN");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const now = () => performance.now();

async function rest(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`${method} ${path.split("?")[0]} failed (${res.status}): ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function management(query: string): Promise<unknown> {
  const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${MANAGEMENT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`management query failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = now();
  const value = await fn();
  return [value, now() - started];
}

async function api(method: string, path: string, body?: unknown, bearer?: string) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, timing: res.headers.get("server-timing") };
}

function parseServerTiming(header: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (header ?? "").split(",")) {
    const [name, ...params] = part.trim().split(";");
    const dur = params.find((p) => p.trim().startsWith("dur="));
    if (name && dur) out[name] = Number(dur.trim().slice(4));
  }
  return out;
}

const fmt = (ms: number) => `${Math.round(ms)}ms`;

async function main() {
  const runs = Math.max(1, Number(process.argv[2] ?? "3") || 3);
  const runId = randomBytes(6).toString("hex");
  const providerId = `signup-timing-${runId}`;
  const created: Array<{ patientId: string | null; userId: string | null; rowId: string }> = [];
  await rest("POST", "providers", [{
    provider_id: providerId,
    provider_name: "Synthetic Signup Timing",
    office_name: "Synthetic Signup Timing",
    email: `signup-timing-${runId}@example.test`,
    access_disabled: false,
    created_at: new Date().toISOString(),
  }]);
  const results: Array<Record<string, number>> = [];
  try {
    for (let i = 0; i < runs; i += 1) {
      const token = randomBytes(32).toString("hex");
      const email = `signup-timing-${runId}-${i}@example.test`;
      const phone = `+1555${String(Date.now() % 10_000_000).padStart(7, "0")}`;
      const [row] = await rest("POST", "claim_verifications", [{
        purpose: "signup",
        identifier_kind: "phone",
        identifier: phone,
        candidates: [],
        delivery: "dev",
        code_attempts: 0,
        birthday_checked: false,
        verified_at: new Date().toISOString(),
        claim_token_hash: sha256(token),
        scope_key: `signup:${providerId}|email:${Buffer.from(email).toString("base64url")}`,
      }]);
      const record = { patientId: null as string | null, userId: null as string | null, rowId: row.id as string };
      created.push(record);

      const started = now();
      const [complete, completeMs] = await timed(() => api("POST", "/auth/signup/complete", {
        signupToken: token,
        password: `Tt!${randomBytes(12).toString("base64url")}9a`,
        firstName: "Timing",
        lastName: `Run${i}`,
        email,
      }));
      if (complete.status !== 200) throw new Error(`completion failed (${complete.status}): ${JSON.stringify(complete.json)}`);
      const [session, verifyMs] = await timed(async () => {
        const res = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
          method: "POST",
          headers: { apikey: ANON, "Content-Type": "application/json" },
          body: JSON.stringify({ type: "email", token_hash: complete.json.tokenHash }),
        });
        const json = await res.json();
        if (res.status >= 300) throw new Error(`verify failed (${res.status})`);
        return json as { access_token: string; user: { id: string } };
      });
      record.userId = session.user.id;
      const toSeeded = now() - started;
      const [whoami, whoamiMs] = await timed(() => api("GET", "/claim/whoami", undefined, session.access_token));
      record.patientId = whoami.json?.patientId ?? complete.json.patientId ?? null;
      const [, stateProfileMs] = await timed(() => Promise.all([
        api("GET", "/patient-data/state", undefined, session.access_token),
        api("GET", "/patient-data/profile", undefined, session.access_token),
      ]));
      const [privacy, privacyMs] = await timed(() => api("GET", "/patient-data/privacy", undefined, session.access_token));
      if (privacy.status !== 200) throw new Error(`privacy failed (${privacy.status})`);
      const gateMs = whoamiMs + stateProfileMs + privacyMs;
      const server = parseServerTiming(complete.timing);
      results.push({ completeMs, verifyMs, whoamiMs, stateProfileMs, privacyMs, gateMs, toSeeded, withGate: toSeeded + gateMs, ...server });
      console.log(
        `run ${i + 1}: completion ${fmt(completeMs)} [server ${Object.entries(server).map(([k, v]) => `${k} ${fmt(v)}`).join(", ")}]` +
          ` · sign-in ${fmt(verifyMs)} · gate fetches ${fmt(gateMs)} (whoami ${fmt(whoamiMs)}, state+profile ${fmt(stateProfileMs)}, privacy ${fmt(privacyMs)})` +
          ` · seeded=${complete.json.privacy ? "yes" : "no"}`,
      );
    }
  } finally {
    const patientIds = created.map((c) => c.patientId).filter((id): id is string => Boolean(id));
    const userIds = created.map((c) => c.userId).filter((id): id is string => Boolean(id));
    const quoted = (ids: string[]) => (ids.length ? ids.map((id) => `'${id}'`).join(",") : "null");
    await management(`do $cleanup$
declare t record;
begin
  for t in select c.table_name, c.column_name from information_schema.columns c
    join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.column_name in ('patient_id') and c.table_name <> 'patients' loop
    begin
      execute format('delete from public.%I where %I::text = any($1)', t.table_name, t.column_name) using array[${quoted(patientIds)}]::text[];
    exception when others then null;
    end;
  end loop;
  delete from public.auth_sign_ins where user_id::text = any(array[${quoted(userIds)}]::text[]);
  delete from public.patients where id::text = any(array[${quoted(patientIds)}]::text[]);
  delete from public.claim_verifications where id::text = any(array[${quoted(created.map((c) => c.rowId))}]::text[]);
  delete from public.providers where provider_id = '${providerId}';
end $cleanup$;`);
    for (const userId of userIds) {
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
        method: "DELETE",
        headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
      });
    }
    const left = await rest("GET", `patients?id=in.(${patientIds.join(",") || randomUUID()})&select=id`);
    console.log(`cleanup: ${created.length} run(s) removed${Array.isArray(left) && left.length ? ` — ${left.length} patient row(s) remain` : ""}`);
  }
  const median = (key: string) => {
    const values = results.map((r) => r[key]).filter((v) => typeof v === "number").sort((a, b) => a - b);
    return values.length ? values[Math.floor(values.length / 2)] : NaN;
  };
  console.log(
    `median: completion ${fmt(median("completeMs"))}, sign-in ${fmt(median("verifyMs"))}, gate fetches ${fmt(median("gateMs"))}` +
      ` → tap-to-consent-ready ${fmt(median("withGate"))} with gate fetches, ${fmt(median("toSeeded"))} when seeded`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

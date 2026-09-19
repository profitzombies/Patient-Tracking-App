/**
 * Synthetic-only live proof harness for business care-team messaging.
 *
 * Commands:
 *   pnpm --filter @workspace/api-server exec tsx scripts/care-team-live-smoke.ts prepare
 *   CARE_TEAM_SMOKE_API_BASE_URL=http://127.0.0.1:3000/api \
 *     pnpm --filter @workspace/api-server exec tsx scripts/care-team-live-smoke.ts verify --keep
 *   pnpm --filter @workspace/api-server exec tsx scripts/care-team-live-smoke.ts helper
 *   pnpm --filter @workspace/api-server exec tsx scripts/care-team-live-smoke.ts thread
 *   pnpm --filter @workspace/api-server exec tsx scripts/care-team-live-smoke.ts post "<text>"
 *   pnpm --filter @workspace/api-server exec tsx scripts/care-team-live-smoke.ts cleanup
 *
 * `thread` starts (or resumes) the fixture patient's care-team conversation
 * through the real patient API and prints its id; `post` sends one patient
 * message into it the same way. Together they let a browser tester watching
 * the staff inbox prove the live stream path (patient write → updated_at
 * trigger → feed → SSE → screen) without ever holding a patient token.
 *
 * Passwords, sessions, Supabase values, and tester bootstrap contents are
 * written only to mode-0600 files. Output is restricted to synthetic IDs,
 * random route paths, fixture paths, and assertion labels.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CONSENT_POLICY_VERSION } from "../src/privacy/consent";

const FIXTURE_PATH = "/tmp/thinnr-care-team-fixture.json";
const DEFAULT_API_BASE = "http://127.0.0.1:3000/api";
const HELPER_ROOT = resolve(process.cwd(), "../../tmp");
const labels = [
  "patient", "otherPatient", "office", "wrongOffice", "hqAdmin", "hqSupport",
  "disabledOffice",
] as const;
type IdentityLabel = typeof labels[number];
type BrowserRole =
  | "patient"
  | "otherPatient"
  | "office"
  | "wrongOffice"
  | "hqAdmin"
  | "hqSupport";

interface StoredIdentity {
  userId: string;
  email: string;
  password: string;
  session: Record<string, unknown>;
}

interface FixtureState {
  version: 1;
  runId: string;
  createdAt: string;
  apiBase: string;
  helper: { directory: string; route: string; files: Partial<Record<BrowserRole, string>> };
  identities: Partial<Record<IdentityLabel, StoredIdentity>>;
  ids: {
    providerId: string;
    otherProviderId: string;
    patientId: string;
    otherPatientId: string;
    disabledPatientId: string;
    deletingPatientId: string;
    teamMemberIds: string[];
    hqMembershipIds: string[];
    conversationIds: string[];
    aiConversationId: string | null;
  };
}

interface HttpResult {
  status: number;
  headers: Headers;
  body: any;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value.replace(/\/$/, "");
}

function credentials() {
  return {
    url: requireEnv("SUPABASE_URL"),
    service: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    anon: requireEnv("SUPABASE_ANON_KEY"),
    management: process.env.SUPABASE_ACCESS_TOKEN?.trim() || null,
  };
}

function safeRemoteMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "remote request failed";
  for (const key of ["message", "error_description", "error", "code"]) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === "string") return value.slice(0, 200);
  }
  return "remote request failed";
}

async function request(url: string, init: RequestInit, expected = [200]): Promise<HttpResult> {
  const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(90_000) });
  const text = await response.text();
  let body: any = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  if (!expected.includes(response.status)) {
    throw new Error(`Request returned ${response.status}: ${safeRemoteMessage(body)}`);
  }
  return { status: response.status, headers: response.headers, body };
}

async function serviceRest(
  method: string,
  path: string,
  body?: unknown,
  expected = [200, 201, 204],
  prefer?: string,
): Promise<HttpResult> {
  const { url, service } = credentials();
  return request(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: service,
      Authorization: `Bearer ${service}`,
      "Content-Type": "application/json",
      Prefer: prefer ?? (method === "POST" ? "return=representation" : "return=minimal"),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, expected);
}

async function createAuthUser(email: string, password: string): Promise<string> {
  const { url, service } = credentials();
  const result = await request(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email, password, email_confirm: true,
      app_metadata: { thinnr_claim: "care-team-live-smoke" },
      user_metadata: { display_name: "Synthetic Care Team Smoke" },
    }),
  }, [200, 201]);
  if (typeof result.body?.id !== "string") throw new Error("Auth user creation returned no ID.");
  return result.body.id;
}

async function signIn(email: string, password: string): Promise<Record<string, unknown>> {
  const { url, anon } = credentials();
  const result = await request(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (typeof result.body?.access_token !== "string" || typeof result.body?.refresh_token !== "string") {
    throw new Error("Synthetic sign-in returned no session.");
  }
  return result.body as Record<string, unknown>;
}

async function deleteAuthUser(userId: string): Promise<void> {
  const { url, service } = credentials();
  await request(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "DELETE", headers: { apikey: service, Authorization: `Bearer ${service}` },
  }, [200, 204, 404]);
}

async function authUserAbsent(userId: string): Promise<boolean> {
  const { url, service } = credentials();
  const result = await request(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "GET", headers: { apikey: service, Authorization: `Bearer ${service}` },
  }, [200, 404]);
  return result.status === 404;
}

async function saveState(state: FixtureState): Promise<void> {
  const temporary = `${FIXTURE_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await writeFile(FIXTURE_PATH, await readFile(temporary), { mode: 0o600 });
  await chmod(FIXTURE_PATH, 0o600);
  await rm(temporary, { force: true });
}

async function loadState(): Promise<FixtureState> {
  const state = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as FixtureState;
  if (state.version !== 1 || !state.runId || !state.ids?.patientId) {
    throw new Error("The care-team fixture file is invalid.");
  }
  return state;
}

function identity(state: FixtureState, label: IdentityLabel): StoredIdentity {
  const found = state.identities[label];
  if (!found) throw new Error(`Fixture is missing ${label}.`);
  return found;
}

function initialState(): FixtureState {
  const runId = randomUUID();
  const route = `__care-team-session-${randomBytes(32).toString("base64url")}`;
  return {
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    apiBase: process.env.CARE_TEAM_SMOKE_API_BASE_URL?.replace(/\/$/, "") || DEFAULT_API_BASE,
    helper: { directory: `${HELPER_ROOT}/${route}`, route: `/${route}`, files: {} },
    identities: {},
    ids: {
      providerId: `care-${randomUUID()}`,
      otherProviderId: `care-${randomUUID()}`,
      patientId: randomUUID(),
      otherPatientId: randomUUID(),
      disabledPatientId: randomUUID(),
      deletingPatientId: randomUUID(),
      teamMemberIds: [],
      hqMembershipIds: [],
      conversationIds: [],
      aiConversationId: null,
    },
  };
}

async function assertFixtureMode(): Promise<void> {
  const mode = (await stat(FIXTURE_PATH)).mode & 0o777;
  if (mode !== 0o600) throw new Error("Fixture permissions are not 0600.");
}

async function refreshSessions(state: FixtureState): Promise<void> {
  for (const label of labels) {
    const found = state.identities[label];
    if (found) found.session = await signIn(found.email, found.password);
  }
  await saveState(state);
}

function supabaseStorageKey(): string {
  const host = new URL(credentials().url).hostname;
  const projectRef = host.split(".")[0];
  if (!projectRef) throw new Error("Could not derive Supabase project reference.");
  return `sb-${projectRef}-auth-token`;
}

async function writeHelper(state: FixtureState): Promise<void> {
  await refreshSessions(state);
  await mkdir(state.helper.directory, { recursive: true, mode: 0o700 });
  await chmod(state.helper.directory, 0o700);
  const storageKey = supabaseStorageKey();
  const roles: BrowserRole[] = [
    "patient", "otherPatient", "office", "wrongOffice", "hqAdmin", "hqSupport",
  ];
  for (const role of roles) {
    const fileName = `${role}-${randomBytes(18).toString("base64url")}.html`;
    const filePath = `${state.helper.directory}/${fileName}`;
    const patientRole = role === "patient" || role === "otherPatient";
    const destination = patientRole
      ? "/care-team-chat" : role.startsWith("hq") ? "/admin/conversations" : "/conversations";
    const session = identity(state, role).session;
    const html = `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex,nofollow">
<title>Temporary synthetic tester session</title><script>
(() => {
  "use strict";
  const session = ${JSON.stringify(session).replace(/</g, "\\u003c")};
  localStorage.setItem(${JSON.stringify(storageKey)}, JSON.stringify(session));
  localStorage.setItem("thinnr-ops-code-login-at", String(Date.now()));
  localStorage.removeItem("thinnr-ops-persona");
  const destination = ${patientRole
    ? `location.pathname.startsWith("/thinnr-mobile/") ? "/thinnr-mobile/care-team-chat" : ${JSON.stringify(destination)}`
    : JSON.stringify(destination)};
  location.replace(destination);
})();
</script><noscript>JavaScript is required.</noscript>`;
    await writeFile(filePath, html, { mode: 0o600 });
    await chmod(filePath, 0o600);
    state.helper.files[role] = `${state.helper.route}/${fileName}`;
  }
  await saveState(state);
  console.log(`Helper directory: ${state.helper.directory}`);
  for (const role of roles) console.log(`${role} helper path: ${state.helper.files[role]}`);
}

async function prepare(): Promise<void> {
  credentials();
  try {
    await access(FIXTURE_PATH);
    throw new Error(`Fixture already exists at ${FIXTURE_PATH}; run cleanup first.`);
  } catch (error) {
    if (error instanceof Error && !("code" in error && error.code === "ENOENT")) throw error;
  }
  const state = initialState();
  await saveState(state);
  await assertFixtureMode();
  const suffix = state.runId.slice(0, 12);
  try {
    for (const label of labels) {
      const email = `care-team-smoke-${label.toLowerCase()}-${suffix}@example.test`;
      const password = `Ct!${randomBytes(25).toString("base64url")}8Q`;
      const userId = await createAuthUser(email, password);
      state.identities[label] = { userId, email, password, session: await signIn(email, password) };
      await saveState(state);
    }
    const now = new Date().toISOString();
    await serviceRest("POST", "providers", [
      {
        provider_id: state.ids.providerId, provider_name: "Synthetic Care Team Business",
        office_name: "Synthetic Care Team Office", email: identity(state, "office").email,
        auth_user_id: identity(state, "office").userId, access_disabled: false, created_at: now,
      },
      {
        provider_id: state.ids.otherProviderId, provider_name: "Synthetic Isolated Business",
        office_name: "Synthetic Isolated Office", email: identity(state, "wrongOffice").email,
        auth_user_id: identity(state, "wrongOffice").userId, access_disabled: false, created_at: now,
      },
    ]);
    await serviceRest("POST", "profiles?on_conflict=id", [
      {
        id: identity(state, "office").userId,
        role: "provider_staff",
        display_name: "Synthetic Care Team Office Owner",
        email: identity(state, "office").email,
        provider_account_code: state.ids.providerId,
      },
      {
        id: identity(state, "wrongOffice").userId,
        role: "provider_staff",
        display_name: "Synthetic Isolated Office Owner",
        email: identity(state, "wrongOffice").email,
        provider_account_code: state.ids.otherProviderId,
      },
    ], [200, 201], "resolution=merge-duplicates,return=representation");
    await serviceRest("POST", "patients", [
      {
        id: state.ids.patientId, name: "Synthetic Care Team Patient",
        email: identity(state, "patient").email, activation_status: "activated",
        created_at: now, auth_user_id: identity(state, "patient").userId,
        provider_id: state.ids.providerId, profile_completed_at: now, deletion_requested_at: null,
      },
      {
        id: state.ids.otherPatientId, name: "Synthetic Other Care Team Patient",
        email: identity(state, "otherPatient").email, activation_status: "activated",
        created_at: now, auth_user_id: identity(state, "otherPatient").userId,
        provider_id: state.ids.otherProviderId, profile_completed_at: now, deletion_requested_at: null,
      },
      {
        id: state.ids.disabledPatientId, name: "Synthetic Disabled Patient",
        email: `care-team-disabled-patient-${suffix}@example.test`, activation_status: "disabled",
        created_at: now, provider_id: state.ids.providerId, profile_completed_at: now,
        deletion_requested_at: null, auth_user_id: null,
      },
      {
        id: state.ids.deletingPatientId, name: "Synthetic Deleting Patient",
        email: `care-team-deleting-patient-${suffix}@example.test`, activation_status: "activated",
        created_at: now, provider_id: state.ids.providerId, profile_completed_at: now,
        deletion_requested_at: now, auth_user_id: null,
      },
    ]);
    await serviceRest("POST", "patient_flags", [
      { patient_id: state.ids.patientId, onboarding_complete: true },
      { patient_id: state.ids.otherPatientId, onboarding_complete: true },
    ]);
    await serviceRest("POST", "patient_consents", [state.ids.patientId, state.ids.otherPatientId].map(patientId => ({
      patient_id: patientId, policy_version: CONSENT_POLICY_VERSION,
      terms_accepted: true, privacy_accepted: true, health_data_accepted: true,
      photo_analysis_accepted: true, app_version: "care-team-live-smoke", platform: "server",
    })));
    const disabledMemberId = randomUUID();
    state.ids.teamMemberIds.push(disabledMemberId);
    await serviceRest("POST", "team_members", {
      id: disabledMemberId, provider_id: state.ids.providerId,
      name: "Synthetic Disabled Office Member", email: identity(state, "disabledOffice").email,
      auth_user_id: identity(state, "disabledOffice").userId,
      activation_status: "disabled", office_role: "staff",
    });
    for (const [label, departmentRole] of [["hqAdmin", "admin"], ["hqSupport", "support"]] as const) {
      const result = await serviceRest("POST", "hq_memberships", {
        auth_user_id: identity(state, label).userId, email: identity(state, label).email,
        display_name: label === "hqAdmin" ? "Synthetic HQ Admin" : "Synthetic HQ Support",
        department_role: departmentRole, status: "active", activated_at: now,
      });
      if (typeof result.body?.[0]?.id === "string") state.ids.hqMembershipIds.push(result.body[0].id);
    }
    await saveState(state);
    await writeHelper(state);
  } catch (error) {
    await saveState(state);
    throw error;
  }
  console.log(`Prepared fixture: ${FIXTURE_PATH}`);
  console.log(`Run ID: ${state.runId}`);
  console.log(`Patient IDs: ${state.ids.patientId}, ${state.ids.otherPatientId}`);
  console.log(`Provider IDs: ${state.ids.providerId}, ${state.ids.otherProviderId}`);
}

function token(state: FixtureState, label: IdentityLabel): string {
  const value = identity(state, label).session.access_token;
  if (typeof value !== "string") throw new Error(`Fixture session for ${label} has no access token.`);
  return value;
}

async function api(
  state: FixtureState,
  method: string,
  path: string,
  label?: IdentityLabel,
  body?: unknown,
  expected = [200],
): Promise<HttpResult> {
  return request(`${process.env.CARE_TEAM_SMOKE_API_BASE_URL?.replace(/\/$/, "") || state.apiBase}${path}`, {
    method,
    headers: {
      ...(label ? { Authorization: `Bearer ${token(state, label)}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, expected);
}

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`Smoke assertion failed: ${label}`);
  console.log(`PASS ${label}`);
}

function conversations(body: any): any[] {
  return Array.isArray(body?.conversations) ? body.conversations : [];
}

async function ensureAiBaseline(state: FixtureState): Promise<{ id: string; count: number }> {
  if (!state.ids.aiConversationId) {
    const inserted = await serviceRest("POST",
      "patient_chat_conversations?select=id", {
        patient_id: state.ids.patientId, provider_id: state.ids.providerId, thread: "coach",
      });
    const id = inserted.body?.[0]?.id;
    if (typeof id !== "string") throw new Error("Could not seed isolated AI conversation.");
    state.ids.aiConversationId = id;
    await serviceRest("POST", "patient_chat_messages", {
      conversation_id: id, client_id: `ai-baseline-${state.runId}`,
      role: "assistant", text: "Synthetic pre-existing AI history marker.",
    });
    await saveState(state);
  }
  const rows = await serviceRest("GET",
    `patient_chat_messages?conversation_id=eq.${state.ids.aiConversationId}&select=seq`);
  return { id: state.ids.aiConversationId, count: Array.isArray(rows.body) ? rows.body.length : 0 };
}

async function verify(keep: boolean): Promise<void> {
  const state = await loadState();
  credentials();
  await refreshSessions(state);
  await assertFixtureMode();
  const aiBaseline = await ensureAiBaseline(state);

  await api(state, "GET", "/patient-care-team", undefined, undefined, [401]);
  assert(true, "anonymous patient bootstrap denied");
  await api(state, "POST", "/office/conversations/start", "wrongOffice",
    { patientId: state.ids.patientId }, [404]);
  assert(true, "wrong office receives neutral not-found");
  await api(state, "GET", "/patient-care-team", "wrongOffice", undefined, [403, 404]);
  await api(state, "GET", "/office/conversations", "disabledOffice", undefined, [403]);
  assert(true, "wrong account type and disabled teammate denied");

  const [patientStart, officeStart] = await Promise.all([
    api(state, "POST", "/patient-care-team/start", "patient", {}),
    api(state, "POST", "/office/conversations/start", "office", { patientId: state.ids.patientId }),
  ]);
  const patientConversationId = patientStart.body?.conversation?.id;
  assert(typeof patientConversationId === "string" &&
    officeStart.body?.conversation?.id === patientConversationId,
  "simultaneous patient and office start converge on one conversation");
  assert([patientStart.body?.created, officeStart.body?.created].filter(Boolean).length <= 1,
    "simultaneous start creates at most once (and safely resumes an existing fixture thread)");
  if (!state.ids.conversationIds.includes(patientConversationId)) {
    state.ids.conversationIds.push(patientConversationId);
    await saveState(state);
  }

  const patientClientId = `patient-retry-${state.runId}`;
  const firstPatient = await api(state, "POST", `/patient-care-team/${patientConversationId}/messages`,
    "patient", { clientId: patientClientId, text: "Synthetic patient idempotency proof." });
  const retryPatient = await api(state, "POST", `/patient-care-team/${patientConversationId}/messages`,
    "patient", { clientId: patientClientId, text: "Synthetic patient idempotency proof." });
  assert((firstPatient.body?.created === true || firstPatient.body?.created === false) &&
    retryPatient.body?.created === false &&
    firstPatient.body?.message?.seq === retryPatient.body?.message?.seq,
  "patient lost-response retry returns the original row");
  await api(state, "POST", `/patient-care-team/${patientConversationId}/messages`,
    "patient", { clientId: patientClientId, text: "Synthetic conflicting content." }, [409]);
  assert(true, "patient idempotency-key conflict rejected");

  const staffClientId = `staff-retry-${state.runId}`;
  const firstStaff = await api(state, "POST", `/office/conversations/${patientConversationId}/reply`,
    "office", { clientId: staffClientId, text: "Synthetic private reply content." });
  const retryStaff = await api(state, "POST", `/office/conversations/${patientConversationId}/reply`,
    "office", { clientId: staffClientId, text: "Synthetic private reply content." });
  assert(firstStaff.body?.event?.seq === retryStaff.body?.event?.seq,
    "office lost-response retry returns the original row");

  const outbox = await serviceRest("GET",
    `patient_notifications?patient_id=eq.${state.ids.patientId}&dedupe_key=eq.${encodeURIComponent(
      `care_team_reply:${patientConversationId}:${staffClientId}`)}&select=kind,category,title,body,data,dedupe_key`);
  const notification = outbox.body?.[0];
  assert(notification?.title === "A message from your care team" &&
    notification?.body === "You have a new care team message." &&
    notification?.kind === "care_team_reply" &&
    notification?.category === "office_reminders" &&
    notification?.data?.thread === "care_team" &&
    notification?.data?.conversationId === patientConversationId &&
    Object.keys(notification?.data ?? {}).every(key =>
      ["conversationId", "patientId", "providerId", "thread"].includes(key)) &&
    !JSON.stringify(notification).includes("Synthetic private reply content"),
  "outbox is generic and carries only allowlisted care-team deep-link context");

  const seedMessages = Array.from({ length: 203 }, (_, index) => ({
    clientId: `page-${state.runId.slice(0, 8)}-${index}`,
    text: `Synthetic pagination row ${index + 1}.`,
  }));
  for (let offset = 0; offset < seedMessages.length; offset += 20) {
    await Promise.all(seedMessages.slice(offset, offset + 20).map(message =>
      api(state, "POST", `/patient-care-team/${patientConversationId}/messages`, "patient", message)));
  }
  const newest = await api(state, "GET",
    `/patient-care-team/${patientConversationId}/messages?limit=100`, "patient");
  assert(newest.body?.messages?.length === 100 && Number.isInteger(newest.body?.nextBefore),
    "newest page is bounded at 100 with a before cursor");
  const older = await api(state, "GET",
    `/patient-care-team/${patientConversationId}/messages?limit=100&before=${newest.body.nextBefore}`, "patient");
  const after = await api(state, "GET",
    `/patient-care-team/${patientConversationId}/messages?limit=100&after=${older.body.messages.at(-1).seq}`, "patient");
  assert(older.body?.messages?.length > 0 && after.body?.messages?.length > 0 &&
    after.body.messages[0].seq > older.body.messages.at(-1).seq,
  "before and after cursors traverse a transcript over 200 rows");

  const officeFiltered = await api(state, "GET",
    `/office/conversations?channel=care_team&patientId=${state.ids.patientId}`, "office");
  assert(conversations(officeFiltered.body).some(row => row.id === patientConversationId) &&
    conversations(officeFiltered.body).every(row => row.channel === "care_team"),
  "office channel and patient filters isolate the care-team thread");
  const hqFiltered = await api(state, "GET",
    `/hq/conversations?office=${encodeURIComponent(state.ids.providerId)}&patientId=${state.ids.patientId}&channel=care_team`,
    "hqAdmin");
  assert(conversations(hqFiltered.body).some(row => row.id === patientConversationId),
    "HQ admin explicit office and patient filters find the thread");
  await api(state, "GET", `/hq/conversations?office=${encodeURIComponent(state.ids.providerId)}&channel=care_team`,
    "hqSupport", undefined, [403]);
  await api(state, "GET", `/hq/conversations/${patientConversationId}/events`, "hqSupport", undefined, [404]);
  assert(true, "HQ support cannot read clinical care-team content");
  for (const [path, body] of [
    [`/office/conversations/${patientConversationId}/reply`, { text: "forbidden" }],
    [`/office/conversations/${patientConversationId}/status`, { status: "closed" }],
    [`/office/conversations/${patientConversationId}/assign`, { assigneeUserId: null }],
    [`/office/conversations/${patientConversationId}/notes`, { body: "forbidden" }],
  ] as const) {
    await api(state, "POST", `${path}?office=${encodeURIComponent(state.ids.providerId)}`,
      "hqAdmin", body, [403]);
  }
  await api(state, "POST", `/office/conversations/start?office=${encodeURIComponent(state.ids.providerId)}`,
    "hqAdmin", { patientId: state.ids.patientId }, [403]);
  assert(true, "HQ cannot start, reply, assign, status, or note");

  const aiReply = await api(state, "POST", `/office/conversations/${aiBaseline.id}/reply`,
    "office", { clientId: `ai-isolation-${state.runId}`, text: "Synthetic redirected reply." }, [409]);
  assert(aiReply.body?.careTeamConversationId === patientConversationId,
    "replying to AI history redirects to existing care-team thread");
  const aiAfter = await serviceRest("GET",
    `patient_chat_messages?conversation_id=eq.${aiBaseline.id}&select=seq`);
  assert(Array.isArray(aiAfter.body) && aiAfter.body.length === aiBaseline.count,
    "existing AI transcript remains unchanged");

  await serviceRest("POST", "provider_account_locks", { account_id: state.ids.providerId });
  try {
    await api(state, "POST", `/patient-care-team/${patientConversationId}/messages`, "patient",
      { clientId: `locked-${state.runId}`, text: "must not send" }, [403, 502]);
    await api(state, "POST", `/office/conversations/${patientConversationId}/reply`, "office",
      { clientId: `locked-office-${state.runId}`, text: "must not send" }, [403, 502]);
    assert(true, "locked business cannot send");
  } finally {
    await serviceRest("DELETE",
      `provider_account_locks?account_id=eq.${encodeURIComponent(state.ids.providerId)}`);
  }
  await api(state, "POST", "/office/conversations/start", "office",
    { patientId: state.ids.disabledPatientId }, [502]);
  await api(state, "POST", "/office/conversations/start", "office",
    { patientId: state.ids.deletingPatientId }, [404]);
  assert(true, "disabled and deleting patients cannot start a thread");

  await serviceRest("PATCH", `patients?id=eq.${state.ids.patientId}`,
    { provider_id: state.ids.otherProviderId });
  const transferred = await api(state, "GET", "/patient-care-team", "patient");
  assert((transferred.body?.current === null ||
      transferred.body?.current?.providerId === state.ids.otherProviderId) &&
    transferred.body?.retained?.some((row: any) => row.id === patientConversationId && row.canSend === false),
  "business transfer retains old transcript as read-only");
  await api(state, "POST", `/patient-care-team/${patientConversationId}/messages`, "patient",
    { clientId: `retained-${state.runId}`, text: "must not send" }, [409]);
  const oldOffice = await api(state, "GET",
    `/office/conversations?channel=care_team&patientId=${state.ids.patientId}`, "office");
  assert(conversations(oldOffice.body).some(row => row.id === patientConversationId),
    "immutable old business ownership remains visible only to old office");
  const newOfficeStart = await api(state, "POST", "/office/conversations/start", "wrongOffice",
    { patientId: state.ids.patientId });
  const newPatientStart = await api(state, "POST", "/patient-care-team/start", "patient", {});
  const newConversationId = newPatientStart.body?.conversation?.id;
  assert(typeof newConversationId === "string" &&
    newConversationId !== patientConversationId &&
    newOfficeStart.body?.conversation?.id === newConversationId,
  "transferred patient and new office converge on a distinct current-business thread");
  state.ids.conversationIds.push(newConversationId);
  await saveState(state);

  await api(state, "POST", `/patient-care-team/${patientConversationId}/read`, "otherPatient",
    { throughSeq: 1 }, [404]);
  assert(true, "other patient cannot address retained conversation by ID");

  // Leave the kept browser fixture with the original patient/office pair
  // current and writable. The transfer proof above remains represented by the
  // second, now-retained immutable conversation.
  await serviceRest("PATCH", `patients?id=eq.${state.ids.patientId}`,
    { provider_id: state.ids.providerId });
  const browserReady = await api(state, "GET", "/patient-care-team", "patient");
  assert(browserReady.body?.current?.id === patientConversationId &&
    browserReady.body?.retained?.some((row: any) => row.id === newConversationId),
  "kept browser fixture restores the original patient and office as current");

  console.log(`Verified fixture: ${FIXTURE_PATH}`);
  if (!keep) await cleanup();
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function managementQuery(query: string): Promise<any> {
  const { url, management } = credentials();
  if (!management) throw new Error("SUPABASE_ACCESS_TOKEN is required for atomic cleanup.");
  const ref = new URL(url).hostname.split(".")[0];
  return (await request(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${management}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  }, [200, 201])).body;
}

async function cleanup(): Promise<void> {
  let state: FixtureState;
  try { state = await loadState(); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      console.log(`Fixture already absent: ${FIXTURE_PATH}`); return;
    }
    throw error;
  }
  const patientIds = [
    state.ids.patientId, state.ids.otherPatientId, state.ids.disabledPatientId, state.ids.deletingPatientId,
  ].map(sqlLiteral).join(",");
  const providerIds = [state.ids.providerId, state.ids.otherProviderId].map(sqlLiteral).join(",");
  const actorIds = Object.values(state.identities).filter(Boolean)
    .map(item => sqlLiteral(item!.userId)).join(",");
  const fixtureConversationRows = await serviceRest("GET",
    `patient_chat_conversations?or=(patient_id.in.(${[
      state.ids.patientId, state.ids.otherPatientId, state.ids.disabledPatientId,
      state.ids.deletingPatientId,
    ].join(",")}),provider_id.in.(${state.ids.providerId},${state.ids.otherProviderId}))&select=id`);
  const collectedConversationIds = Array.from(new Set([
    ...state.ids.conversationIds,
    ...(Array.isArray(fixtureConversationRows.body)
      ? fixtureConversationRows.body.map((row: { id?: unknown }) => row.id).filter(
        (id: unknown): id is string => typeof id === "string",
      )
      : []),
  ]));
  const query = `
begin;
set local session_replication_role = replica;
do $cleanup$
declare
  t text;
  v_patient_ids uuid[] := array[${patientIds}]::uuid[];
  v_provider_ids text[] := array[${providerIds}]::text[];
begin
  foreach t in array array[
    'patient_notification_attempts','patient_notification_receipts','patient_notifications',
    'patient_chat_escalations','patient_chat_notes','patient_chat_patient_read_markers',
    'patient_chat_read_markers','patient_chat_messages','patient_chat_conversations'
  ] loop
    if to_regclass('public.'||t) is not null then
      if t in ('patient_chat_escalations','patient_chat_notes') then
        execute format('delete from public.%I where provider_id = any($1)',t) using v_provider_ids;
      elsif t in ('patient_notification_attempts','patient_notification_receipts') then
        execute format('delete from public.%I where notification_id in (select id from public.patient_notifications where patient_id = any($1))',t) using v_patient_ids;
      elsif t='patient_notifications' then
        execute format('delete from public.%I where patient_id = any($1)',t) using v_patient_ids;
      elsif t in ('patient_chat_messages','patient_chat_patient_read_markers','patient_chat_read_markers') then
        if exists(select 1 from information_schema.columns where table_schema='public'
          and table_name='patient_chat_conversations' and column_name='provider_id') then
          execute format('delete from public.%I where conversation_id in (select id from public.patient_chat_conversations where patient_id = any($1) or provider_id = any($2))',t)
            using v_patient_ids,v_provider_ids;
        else
          execute format('delete from public.%I where conversation_id in (select id from public.patient_chat_conversations where patient_id = any($1))',t)
            using v_patient_ids;
        end if;
      else
        if exists(select 1 from information_schema.columns where table_schema='public'
          and table_name=t and column_name='provider_id') then
          execute format('delete from public.%I where patient_id = any($1) or provider_id = any($2)',t)
            using v_patient_ids,v_provider_ids;
        else
          execute format('delete from public.%I where patient_id = any($1)',t) using v_patient_ids;
        end if;
      end if;
    end if;
  end loop;
  if to_regclass('public.admin_audit_events') is not null then
    delete from public.admin_audit_events where provider_id in (${providerIds}) or actor_user_id in (${actorIds});
  end if;
end $cleanup$;
delete from public.provider_account_locks where account_id in (${providerIds});
delete from public.patient_consents where patient_id in (${patientIds});
delete from public.patient_flags where patient_id in (${patientIds});
delete from public.patients where id in (${patientIds});
delete from public.team_members where provider_id in (${providerIds}) or auth_user_id in (${actorIds});
delete from public.hq_memberships where auth_user_id in (${actorIds});
delete from public.profiles where id in (${actorIds});
delete from public.providers where provider_id in (${providerIds});
commit;`;
  await managementQuery(query);
  for (const found of Object.values(state.identities)) {
    if (found) await deleteAuthUser(found.userId);
  }
  const remaining = await serviceRest("GET",
    `patients?id=in.(${[state.ids.patientId, state.ids.otherPatientId, state.ids.disabledPatientId,
      state.ids.deletingPatientId].join(",")})&select=id`);
  assert(Array.isArray(remaining.body) && remaining.body.length === 0, "fixture patient rows removed");
  const providers = await serviceRest("GET",
    `providers?provider_id=in.(${state.ids.providerId},${state.ids.otherProviderId})&select=provider_id`);
  assert(Array.isArray(providers.body) && providers.body.length === 0, "fixture provider rows removed");
  const profiles = await serviceRest("GET",
    `profiles?id=in.(${Object.values(state.identities).filter(Boolean).map(item => item!.userId).join(",")})&select=id`);
  assert(Array.isArray(profiles.body) && profiles.body.length === 0, "fixture profile rows removed");
  const outbox = await serviceRest("GET",
    `patient_notifications?patient_id=in.(${[
      state.ids.patientId, state.ids.otherPatientId, state.ids.disabledPatientId,
      state.ids.deletingPatientId,
    ].join(",")})&select=id`);
  assert(Array.isArray(outbox.body) && outbox.body.length === 0, "fixture outbox rows removed");
  const conversationsAfter = await serviceRest("GET",
    `patient_chat_conversations?id=in.(${collectedConversationIds.join(",")})&select=id`);
  assert(Array.isArray(conversationsAfter.body) && conversationsAfter.body.length === 0,
    "fixture conversation rows removed");
  if (collectedConversationIds.length) {
    for (const table of ["patient_chat_messages", "patient_chat_notes", "patient_chat_read_markers",
      "patient_chat_patient_read_markers", "patient_chat_escalations"]) {
      const rows = await serviceRest("GET",
        `${table}?conversation_id=in.(${collectedConversationIds.join(",")})&select=conversation_id`);
      assert(Array.isArray(rows.body) && rows.body.length === 0, `fixture ${table} rows removed`);
    }
  }
  const audits = await serviceRest("GET",
    `admin_audit_events?or=(provider_id.in.(${state.ids.providerId},${state.ids.otherProviderId}),actor_user_id.in.(${
      Object.values(state.identities).filter(Boolean).map(item => item!.userId).join(",")
    }))&select=id`);
  assert(Array.isArray(audits.body) && audits.body.length === 0, "fixture audit rows removed");
  for (const found of Object.values(state.identities)) {
    if (found) assert(await authUserAbsent(found.userId), `auth user removed ${found.userId}`);
  }
  const helperName = state.helper.route.replace(/^\//, "");
  const helperLinks = [
    resolve(process.cwd(), `../thinnr-operations/public/${helperName}`),
    resolve(process.cwd(), `../thinnr-mobile/public/${helperName}`),
  ];
  for (const path of helperLinks) await rm(path, { force: true });
  await rm(state.helper.directory, { recursive: true, force: true });
  const excludePath = resolve(process.cwd(), "../../.git/info/exclude");
  try {
    const exclude = await readFile(excludePath, "utf8");
    const kept = exclude.split(/\r?\n/).filter(line => !line.includes(helperName));
    await writeFile(excludePath, `${kept.filter(Boolean).join("\n")}\n`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await rm(FIXTURE_PATH, { force: true });
  console.log(`Removed fixture: ${FIXTURE_PATH}`);
  console.log(`Removed helper directory: ${state.helper.directory}`);
}

/** Start or resume the fixture patient's care-team thread via the patient API. */
async function patientThread(): Promise<string> {
  const state = await loadState();
  credentials();
  await refreshSessions(state);
  await assertFixtureMode();
  const started = await api(state, "POST", "/patient-care-team/start", "patient", {});
  const conversationId = started.body?.conversation?.id;
  if (typeof conversationId !== "string") throw new Error("Patient care-team start returned no conversation.");
  if (!state.ids.conversationIds.includes(conversationId)) {
    state.ids.conversationIds.push(conversationId);
    await saveState(state);
  }
  console.log(`Conversation ID: ${conversationId}`);
  console.log(`Created: ${started.body?.created === true ? "yes" : "no (resumed)"}`);
  return conversationId;
}

/** Send one patient message into the fixture thread via the patient API. */
async function patientPost(text: string): Promise<void> {
  if (!text.trim()) throw new Error("Use post \"<text>\" with a non-empty message.");
  const state = await loadState();
  credentials();
  await refreshSessions(state);
  await assertFixtureMode();
  let conversationId = state.ids.conversationIds[0];
  if (!conversationId) conversationId = await patientThread();
  const clientId = `tester-${randomUUID()}`;
  const sentAt = Date.now();
  const sent = await api(state, "POST", `/patient-care-team/${conversationId}/messages`,
    "patient", { clientId, text: text.trim() });
  const seq = sent.body?.message?.seq;
  if (!Number.isInteger(seq)) throw new Error("Patient message send returned no sequence number.");
  console.log(`Conversation ID: ${conversationId}`);
  console.log(`Message seq: ${seq}`);
  console.log(`Sent at: ${new Date(sentAt).toISOString()} (${Date.now() - sentAt} ms round trip)`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "prepare") await prepare();
  else if (command === "verify") await verify(process.argv.includes("--keep"));
  else if (command === "helper") {
    const state = await loadState();
    await writeHelper(state);
  } else if (command === "thread") await patientThread();
  else if (command === "post") await patientPost(process.argv.slice(3).join(" "));
  else if (command === "cleanup") await cleanup();
  else throw new Error("Use prepare, verify [--keep], helper, thread, post \"<text>\", or cleanup.");
}

main().catch(error => {
  // Error messages are deliberately scrubbed of response bodies and credentials.
  console.error(error instanceof Error ? error.message : "Care-team smoke harness failed.");
  process.exitCode = 1;
});
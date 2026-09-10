/**
 * Synthetic-only live smoke harness for the private bloodwork API.
 *
 * Commands:
 *   pnpm --filter @workspace/api-server exec tsx scripts/bloodwork-live-smoke.ts prepare
 *   BLOODWORK_SMOKE_API_BASE_URL=http://127.0.0.1:3000/api \
 *     pnpm --filter @workspace/api-server exec tsx scripts/bloodwork-live-smoke.ts verify --keep
 *   BLOODWORK_SMOKE_API_BASE_URL=http://127.0.0.1:3000/api \
 *     pnpm --filter @workspace/api-server exec tsx scripts/bloodwork-live-smoke.ts verify-access --keep
 *   pnpm --filter @workspace/api-server exec tsx scripts/bloodwork-live-smoke.ts helper
 *   pnpm --filter @workspace/api-server exec tsx scripts/bloodwork-live-smoke.ts cleanup
 *
 * Secrets, passwords and sessions are written only to the mode-0600 fixture
 * file. Console output is intentionally limited to synthetic labels, IDs,
 * paths, and pass/fail assertions.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { CONSENT_POLICY_VERSION } from "../src/privacy/consent";
import {
  syntheticEncryptedBloodworkPdf,
  syntheticTwoPageBloodworkPdf,
} from "../src/bloodwork/fixtures/synthetic";

const FIXTURE_PATH = "/tmp/thinnr-bloodwork-fixture.json";
const DEFAULT_API_BASE = "http://127.0.0.1:3000/api";
const MAX_BYTES = 20_000_000;
const MOBILE_PUBLIC_DIR = resolve(dirname(new URL(import.meta.url).pathname), "../../thinnr-mobile/public");

type IdentityLabel =
  | "patient"
  | "otherPatient"
  | "providerOwner"
  | "wrongOfficeOwner"
  | "enabledTeam"
  | "disabledTeam"
  | "hqClinical"
  | "hqSupport";

interface StoredIdentity {
  userId: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string | null;
}

interface FixtureState {
  version: 1;
  runId: string;
  createdAt: string;
  apiBase: string;
  assetsDir: string;
  helper: {
    directory: string;
    route: string;
  };
  assets: {
    pdf: string;
    encryptedPdf: string;
    corruptPdf: string;
    png: string;
    jpeg: string;
    exact20mPdf: string;
  };
  identities: Partial<Record<IdentityLabel, StoredIdentity>>;
  ids: {
    patientId: string;
    otherPatientId: string;
    providerId: string;
    wrongProviderId: string;
    teamMemberIds: string[];
    hqMembershipIds: string[];
    reportIds: string[];
    lockIds: string[];
  };
}

interface HttpResult<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
  bytes: Buffer;
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
  };
}

function safeRemoteMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "remote request failed";
  const record = body as Record<string, unknown>;
  for (const key of ["message", "error_description", "error", "code"]) {
    if (typeof record[key] === "string") return String(record[key]).slice(0, 240);
  }
  return "remote request failed";
}

async function request(
  url: string,
  init: RequestInit,
  expected: number[] = [200],
): Promise<HttpResult> {
  const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(90_000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  let body: unknown = null;
  if (bytes.length) {
    try {
      body = JSON.parse(bytes.toString("utf8"));
    } catch {
      body = null;
    }
  }
  if (!expected.includes(response.status)) {
    throw new Error(`Request returned ${response.status}: ${safeRemoteMessage(body)}`);
  }
  return { status: response.status, headers: response.headers, body, bytes };
}

async function serviceRest(
  method: string,
  path: string,
  body?: unknown,
  expected: number[] = [200, 201, 204],
): Promise<HttpResult> {
  const { url, service } = credentials();
  return request(
    `${url}/rest/v1/${path}`,
    {
      method,
      headers: {
        apikey: service,
        Authorization: `Bearer ${service}`,
        "Content-Type": "application/json",
        Prefer: method === "POST" ? "return=representation" : "return=minimal",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    expected,
  );
}

async function createAuthUser(email: string, password: string): Promise<string> {
  const { url, service } = credentials();
  const result = await request(
    `${url}/auth/v1/admin/users`,
    {
      method: "POST",
      headers: {
        apikey: service,
        Authorization: `Bearer ${service}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        app_metadata: { thinnr_claim: "bloodwork-live-smoke" },
        user_metadata: { display_name: "Synthetic Bloodwork Smoke" },
      }),
    },
    [200, 201],
  );
  const id = (result.body as { id?: unknown })?.id;
  if (typeof id !== "string") throw new Error("Auth user creation returned no ID.");
  return id;
}

async function signIn(email: string, password: string): Promise<{
  accessToken: string;
  refreshToken: string | null;
}> {
  const { url, anon } = credentials();
  const result = await request(
    `${url}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: { apikey: anon, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    },
    [200],
  );
  const body = result.body as { access_token?: unknown; refresh_token?: unknown };
  if (typeof body.access_token !== "string") throw new Error("Synthetic sign-in returned no session.");
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
  };
}

async function deleteAuthUser(userId: string): Promise<void> {
  const { url, service } = credentials();
  await request(
    `${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    { method: "DELETE", headers: { apikey: service, Authorization: `Bearer ${service}` } },
    [200, 204, 404],
  );
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
  const parsed = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as FixtureState;
  if (parsed.version !== 1 || !parsed.runId || !parsed.ids?.patientId) {
    throw new Error("The bloodwork fixture file is invalid.");
  }
  return parsed;
}

function imageBytes(mime: "image/png" | "image/jpeg", page: number): Buffer {
  const canvas = createCanvas(1_600, 2_000);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#111111";
  context.font = "bold 44px sans-serif";
  context.fillText(`SYNTHETIC LAB REPORT - IMAGE ${page}`, 80, 120);
  context.font = "34px sans-serif";
  context.fillText("Glucose     92     mg/dL     70-99", 80, 240);
  context.fillText("Marker A     <5     IU/L     Negative", 80, 310);
  context.fillText("Screen     Negative", 80, 380);
  return mime === "image/png"
    ? canvas.toBuffer("image/png")
    : canvas.toBuffer("image/jpeg", 92);
}

function syntheticPhone(index: number): string {
  const suffix = Number.parseInt(randomBytes(4).toString("hex"), 16) % 10_000_000;
  // E.164 US shape: +1, the synthetic 555 area code, and seven subscriber
  // digits (eleven digits after the plus sign).
  return `+1555${String((suffix + index) % 10_000_000).padStart(7, "0")}`;
}

async function prepareAssets(state: FixtureState): Promise<void> {
  await mkdir(state.assetsDir, { recursive: true, mode: 0o700 });
  await chmod(state.assetsDir, 0o700);
  const pdf = syntheticTwoPageBloodworkPdf();
  const exact = Buffer.alloc(MAX_BYTES, 0x20);
  pdf.copy(exact);
  const entries: Array<[string, Buffer]> = [
    [state.assets.pdf, pdf],
    [state.assets.encryptedPdf, syntheticEncryptedBloodworkPdf()],
    [state.assets.corruptPdf, Buffer.from("%PDF-1.7\nSYNTHETIC CORRUPT FILE\n")],
    [state.assets.png, imageBytes("image/png", 1)],
    [state.assets.jpeg, imageBytes("image/jpeg", 2)],
    [state.assets.exact20mPdf, exact],
  ];
  for (const [path, bytes] of entries) {
    await writeFile(path, bytes, { mode: 0o600 });
    await chmod(path, 0o600);
  }
}

function initialState(): FixtureState {
  const runId = randomUUID();
  const assetsDir = `/tmp/thinnr-bloodwork-assets-${runId}`;
  const helperName = `__bloodwork-session-${randomBytes(24).toString("base64url")}`;
  return {
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    apiBase: process.env.BLOODWORK_SMOKE_API_BASE_URL?.replace(/\/$/, "") || DEFAULT_API_BASE,
    assetsDir,
    helper: {
      directory: resolve(MOBILE_PUBLIC_DIR, helperName),
      route: `/${helperName}/`,
    },
    assets: {
      pdf: `${assetsDir}/synthetic-two-page.pdf`,
      encryptedPdf: `${assetsDir}/synthetic-encrypted.pdf`,
      corruptPdf: `${assetsDir}/synthetic-corrupt.pdf`,
      png: `${assetsDir}/synthetic-page.png`,
      jpeg: `${assetsDir}/synthetic-page.jpg`,
      exact20mPdf: `${assetsDir}/synthetic-exact-20000000.pdf`,
    },
    identities: {},
    ids: {
      patientId: randomUUID(),
      otherPatientId: randomUUID(),
      providerId: `smoke-${randomUUID()}`,
      wrongProviderId: `smoke-${randomUUID()}`,
      teamMemberIds: [],
      hqMembershipIds: [],
      reportIds: [],
      lockIds: [],
    },
  };
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
  await prepareAssets(state);
  await saveState(state);
  const suffix = state.runId.slice(0, 12);
  const labels: IdentityLabel[] = [
    "patient",
    "otherPatient",
    "providerOwner",
    "wrongOfficeOwner",
    "enabledTeam",
    "disabledTeam",
    "hqClinical",
    "hqSupport",
  ];

  for (const label of labels) {
    const email = `bloodwork-smoke-${label.toLowerCase()}-${suffix}@example.test`;
    const password = `Bw!${randomBytes(24).toString("base64url")}9z`;
    const userId = await createAuthUser(email, password);
    const session = await signIn(email, password);
    state.identities[label] = { userId, email, password, ...session };
    await saveState(state);
  }

  const now = new Date().toISOString();
  const identity = (label: IdentityLabel) => {
    const found = state.identities[label];
    if (!found) throw new Error(`Missing prepared identity ${label}.`);
    return found;
  };
  await serviceRest("POST", "providers", [
    {
      provider_id: state.ids.providerId,
      provider_name: "Synthetic Bloodwork Provider",
      office_name: "Synthetic Bloodwork Office",
      email: identity("providerOwner").email,
      auth_user_id: identity("providerOwner").userId,
      access_disabled: false,
      created_at: now,
    },
    {
      provider_id: state.ids.wrongProviderId,
      provider_name: "Synthetic Wrong Provider",
      office_name: "Synthetic Wrong Office",
      email: identity("wrongOfficeOwner").email,
      auth_user_id: identity("wrongOfficeOwner").userId,
      access_disabled: false,
      created_at: now,
    },
  ]);
  await serviceRest("POST", "patients", [
    {
      id: state.ids.patientId,
      name: "Synthetic Bloodwork Patient",
      email: identity("patient").email,
      phone: syntheticPhone(1),
      activation_status: "unactivated",
      created_at: now,
      auth_user_id: identity("patient").userId,
      provider_id: state.ids.providerId,
    },
    {
      id: state.ids.otherPatientId,
      name: "Synthetic Other Patient",
      email: identity("otherPatient").email,
      phone: syntheticPhone(2),
      activation_status: "unactivated",
      created_at: now,
      auth_user_id: identity("otherPatient").userId,
      provider_id: state.ids.wrongProviderId,
    },
  ]);
  const enabledId = randomUUID();
  const disabledId = randomUUID();
  state.ids.teamMemberIds.push(enabledId, disabledId);
  await serviceRest("POST", "team_members", [
    {
      id: enabledId,
      provider_id: state.ids.providerId,
      name: "Synthetic Enabled Team",
      email: identity("enabledTeam").email,
      auth_user_id: identity("enabledTeam").userId,
      activation_status: "activated",
      office_role: "staff",
    },
    {
      id: disabledId,
      provider_id: state.ids.providerId,
      name: "Synthetic Disabled Team",
      email: identity("disabledTeam").email,
      auth_user_id: identity("disabledTeam").userId,
      activation_status: "disabled",
      office_role: "staff",
    },
  ]);
  for (const [label, role] of [
    ["hqClinical", "clinical"],
    ["hqSupport", "support"],
  ] as const) {
    const result = await serviceRest("POST", "hq_memberships", {
      auth_user_id: identity(label).userId,
      email: identity(label).email,
      display_name: label === "hqClinical" ? "Synthetic HQ Clinical" : "Synthetic HQ Support",
      department_role: role,
      status: "active",
      activated_at: now,
    });
    const row = Array.isArray(result.body) ? result.body[0] : null;
    if (typeof row?.id === "string") state.ids.hqMembershipIds.push(row.id);
  }
  await saveState(state);

  console.log(`Prepared fixture: ${FIXTURE_PATH}`);
  console.log(`Assets: ${state.assetsDir}`);
  console.log(`Patient ID: ${state.ids.patientId}`);
  console.log(`Other patient ID: ${state.ids.otherPatientId}`);
  console.log(`Provider IDs: ${state.ids.providerId}, ${state.ids.wrongProviderId}`);
}

async function refreshSessions(state: FixtureState): Promise<void> {
  for (const identity of Object.values(state.identities)) {
    if (!identity) continue;
    const session = await signIn(identity.email, identity.password);
    identity.accessToken = session.accessToken;
    identity.refreshToken = session.refreshToken;
  }
  await saveState(state);
}

function fixtureIdentity(state: FixtureState, label: IdentityLabel): StoredIdentity {
  const value = state.identities[label];
  if (!value) throw new Error(`Fixture is missing ${label}.`);
  return value;
}

function supabaseStorageKey(): string {
  const host = new URL(credentials().url).hostname;
  const projectRef = host.split(".")[0];
  if (!projectRef) throw new Error("Could not derive the Supabase project reference.");
  return `sb-${projectRef}-auth-token`;
}

function jwtExpiresAt(accessToken: string): number {
  const encodedPayload = accessToken.split(".")[1];
  if (!encodedPayload) throw new Error("Synthetic access token has no JWT payload.");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Synthetic access token has an invalid JWT payload.");
  }
  const expiresAt = (payload as Record<string, unknown>)?.exp;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    throw new Error("Synthetic access token has no numeric expiry.");
  }
  return expiresAt;
}

async function writeBrowserHelper(state: FixtureState): Promise<void> {
  credentials();
  await refreshSessions(state);
  await mkdir(state.helper.directory, { recursive: true, mode: 0o700 });
  await chmod(state.helper.directory, 0o700);
  const identity = fixtureIdentity(state, "patient");
  const expiresAt = jwtExpiresAt(identity.accessToken);
  const session = {
    access_token: identity.accessToken,
    refresh_token: identity.refreshToken,
    token_type: "bearer",
    expires_in: Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
    expires_at: expiresAt,
    // The mobile client reads session.user.id during PatientAccountProvider
    // resolution.  Supabase's persisted Session type requires this metadata;
    // storing only access/refresh tokens is not a recoverable app session.
    user: {
      id: identity.userId,
      aud: "authenticated",
      role: "authenticated",
      email: identity.email,
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: { display_name: "Synthetic Bloodwork Smoke" },
    },
  };
  const storageKey = supabaseStorageKey();
  const usedKey = `${state.helper.route}:used:v2`;
  const html = `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex,nofollow">
<title>Temporary synthetic patient session</title><script>
(() => {
  "use strict";
  const usedKey = ${JSON.stringify(usedKey)};
  if (!sessionStorage.getItem(usedKey)) {
    const session = ${JSON.stringify(session).replace(/</g, "\\u003c")};
    localStorage.setItem(${JSON.stringify(storageKey)}, JSON.stringify(session));
    sessionStorage.setItem(usedKey, "1");
  }
  location.replace("/bloodwork");
})();
</script><noscript>JavaScript is required.</noscript>`;
  await writeFile(resolve(state.helper.directory, "index.html"), html, { mode: 0o600 });
  await chmod(resolve(state.helper.directory, "index.html"), 0o600);
  await saveState(state);
  const directRoute = state.helper.route.replace(/^\/thinnr-mobile(?=\/)/, "");
  console.log(`Temporary patient session helper: ${directRoute}`);
}

async function api(
  state: FixtureState,
  method: string,
  path: string,
  label?: IdentityLabel,
  body?: unknown,
  expected: number[] = [200],
): Promise<HttpResult> {
  const token = label ? fixtureIdentity(state, label).accessToken : null;
  return request(
    `${process.env.BLOODWORK_SMOKE_API_BASE_URL?.replace(/\/$/, "") || state.apiBase}${path}`,
    {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    expected,
  );
}

function reportsPath(state: FixtureState, patientId = state.ids.patientId): string {
  return `/bloodwork/patients/${patientId}/reports`;
}

async function createReport(
  state: FixtureState,
  files: Array<{ clientFileId: string; mimeType: string; size: number }>,
  clientRequestId = randomUUID(),
  expected = [200, 201],
): Promise<HttpResult> {
  return api(state, "POST", reportsPath(state), "patient", {
    clientRequestId,
    title: "Synthetic live bloodwork",
    reportDate: "2026-10-06",
    transcriptionConsent: true,
    files,
  }, expected);
}

async function upload(url: string, bytes: Buffer, mimeType: string): Promise<void> {
  await request(url, { method: "PUT", headers: { "Content-Type": mimeType }, body: bytes }, [200, 201]);
}

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`Smoke assertion failed: ${label}`);
  console.log(`PASS ${label}`);
}

function responseCode(result: HttpResult): string | null {
  if (!result.body || typeof result.body !== "object") return null;
  const code = (result.body as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

function assertResponseCode(result: HttpResult, code: string, label: string): void {
  assert(responseCode(result) === code, `${label} (${code})`);
}

const verificationFailures: string[] = [];

function check(condition: unknown, label: string): void {
  if (condition) {
    console.log(`PASS ${label}`);
    return;
  }
  verificationFailures.push(label);
  console.log(`FAIL ${label}`);
}

async function deleteStaged(state: FixtureState, reportId: string): Promise<void> {
  await api(
    state,
    "DELETE",
    `${reportsPath(state)}/${reportId}?expectedVersion=1`,
    "patient",
    undefined,
    [200, 204, 404],
  );
}

async function recordConsent(state: FixtureState, label: IdentityLabel): Promise<void> {
  const result = await api(
    state,
    "PUT",
    "/patient-data/consent",
    label,
    {
      policyVersion: CONSENT_POLICY_VERSION,
      terms: true,
      privacy: true,
      healthData: true,
      photoAnalysis: true,
      appVersion: "bloodwork-live-smoke",
      platform: "server",
    },
    [200],
  );
  assert((result.body as any)?.consent?.satisfied === true, `${label} recorded current consent`);
}

async function completeSetup(state: FixtureState, label: "patient" | "otherPatient"): Promise<void> {
  // Keep this live smoke on the public THINNR setup choice. A prior
  // diagnostic GLP-1 attempt exposed a separate deployed-schema constraint
  // mismatch; this path must not hide that follow-up by pre-admitting anyone.
  const profile = await api(
    state,
    "POST",
    "/patient-data/setup/complete",
    label,
    {
      profile: {
        firstName: label === "patient" ? "Synthetic" : "Synthetic Other",
        lastName: "Bloodwork",
        dateOfBirth: "1985-04-03",
        gender: "female",
        heightUnit: "imperial",
        heightInches: 66,
        heightCm: 167.64,
        startingWeight: 205,
        currentWeight: 191,
        goalWeight: 165,
         programId: "thinnr",
        programStartDate: "2026-01-05",
        timezone: "America/New_York",
      },
       onboardingAnswers: {
         program: "thinnr",
         reminderMorning: "08:00",
         reminderAfternoon: "15:00",
         reminderEvening: "22:00",
       },
      notificationPrefs: { reminders: true },
    },
    [200],
  );
  assert((profile.body as any)?.profile?.setupComplete === true, `${label} completed setup through API`);
}

/**
 * Keep the fixture's admission edge cases synthetic and explicit.  Setup is
 * completed through the same patient-facing route first, then service-role
 * metadata simulates a legacy row and office program statuses.  No production
 * patient is ever looked up or changed by this harness.
 */
async function simulateLegacyAdmission(state: FixtureState): Promise<void> {
  await serviceRest(
    "PATCH",
    `patients?id=eq.${encodeURIComponent(state.ids.patientId)}`,
    { activation_status: "paused", profile_completed_at: null },
    [200, 204],
  );
  await serviceRest(
    "PATCH",
    `patients?id=eq.${encodeURIComponent(state.ids.otherPatientId)}`,
    { activation_status: "discharged", profile_completed_at: null },
    [200, 204],
  );
  const legacy = await serviceRest(
    "GET",
    `patients?id=eq.${encodeURIComponent(state.ids.patientId)}&select=id,activation_status,profile_completed_at`,
    undefined,
    [200],
  );
  const legacyRow = Array.isArray(legacy.body) ? legacy.body[0] as Record<string, unknown> | undefined : undefined;
  assert(
    legacyRow?.activation_status === "paused" && legacyRow.profile_completed_at == null,
    "legacy synthetic patient has paused status and null profile timestamp",
  );
  const discharged = await serviceRest(
    "GET",
    `patients?id=eq.${encodeURIComponent(state.ids.otherPatientId)}&select=id,activation_status,profile_completed_at`,
    undefined,
    [200],
  );
  const dischargedRow = Array.isArray(discharged.body)
    ? discharged.body[0] as Record<string, unknown> | undefined
    : undefined;
  assert(
    dischargedRow?.activation_status === "discharged" && dischargedRow.profile_completed_at == null,
    "discharged synthetic patient has null profile timestamp",
  );
  const flags = await serviceRest(
    "GET",
    `patient_flags?patient_id=eq.${encodeURIComponent(state.ids.patientId)}&select=onboarding_complete`,
    undefined,
    [200],
  );
  const flagsRow = Array.isArray(flags.body) ? flags.body[0] as Record<string, unknown> | undefined : undefined;
  assert(flagsRow?.onboarding_complete === true, "legacy synthetic patient remains server-onboarded");
}

async function verifyUnavailableSyntheticAccount(state: FixtureState): Promise<void> {
  await serviceRest(
    "PATCH",
    `patients?id=eq.${encodeURIComponent(state.ids.patientId)}`,
    { activation_status: "disabled", profile_completed_at: null },
    [200, 204],
  );
  try {
    const denied = await api(state, "GET", reportsPath(state), "patient", undefined, [403]);
    assertResponseCode(denied, "PATIENT_ACCOUNT_UNAVAILABLE", "disabled synthetic account is unavailable");
    const rows = await serviceRest(
      "GET",
      `patient_bloodwork_reports?patient_id=eq.${encodeURIComponent(state.ids.patientId)}&select=id`,
      undefined,
      [200],
    );
    assert(Array.isArray(rows.body) && rows.body.length === 0, "unavailable account creates no report");
  } finally {
    await serviceRest(
      "PATCH",
      `patients?id=eq.${encodeURIComponent(state.ids.patientId)}`,
      { activation_status: "paused", profile_completed_at: null },
      [200, 204],
    );
  }
}

async function runExtractionJob(): Promise<void> {
  const candidates = [
    "../src/jobs/definitions/bloodwork-extraction.ts",
    "../src/bloodwork/jobs.ts",
    "../src/bloodwork/job.ts",
    "../src/bloodwork/worker.ts",
    "../src/bloodwork/processor.ts",
  ];
  const exportNames = [
    "runBloodworkExtraction",
    "runBloodworkExtractionJob",
    "runBloodworkExtractionJobs",
    "processBloodworkExtractionQueue",
    "runBloodworkExtractionBatch",
  ];
  for (const relative of candidates) {
    const absolute = resolve(dirname(new URL(import.meta.url).pathname), relative);
    try {
      await access(absolute);
    } catch {
      continue;
    }
    const module = await import(pathToFileURL(absolute).href) as Record<string, unknown>;
    for (const name of exportNames) {
      if (typeof module[name] === "function") {
        const failures: string[] = [];
        const context = {
          dryRun: false,
          now: new Date(),
          tally: () => undefined,
          failItem: (item: string) => failures.push(item),
          log: () => undefined,
          checkpoint: () => undefined,
          leaseLost: false,
        };
        await (module[name] as (ctx: typeof context) => Promise<unknown>)(context);
        if (failures.length) throw new Error("The bloodwork extraction job reported an item failure.");
        return;
      }
    }
  }
  throw new Error("No exported bloodwork extraction job runner was found.");
}

async function pollDetail(
  state: FixtureState,
  reportId: string,
  wanted: string[],
  timeoutMs: number,
): Promise<Record<string, any>> {
  const started = Date.now();
  for (;;) {
    const result = await api(state, "GET", `${reportsPath(state)}/${reportId}`, "patient");
    const detail = result.body as Record<string, any>;
    if (wanted.includes(detail?.report?.extractionStatus)) return detail;
    if (detail?.report?.extractionStatus === "failed") {
      throw new Error("Extraction entered failed state during live verification.");
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`Extraction did not reach ${wanted.join("/")} within ${timeoutMs}ms.`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
}

async function clearTrackedReports(state: FixtureState): Promise<void> {
  for (const reportId of state.ids.reportIds) {
    const existing = await api(
      state,
      "GET",
      `${reportsPath(state)}/${reportId}`,
      "patient",
      undefined,
      [200, 404],
    );
    if (existing.status === 200) {
      await api(
        state,
        "DELETE",
        `${reportsPath(state)}/${reportId}?expectedVersion=${(existing.body as any).report.version}`,
        "patient",
        undefined,
        [200, 204],
      );
    }
  }
  state.ids.reportIds = [];
  await saveState(state);
}

/**
 * Narrow live proof for the admission mismatch and recovery path.  Keep this
 * separate from the broad verify command so a tester can repeat the task's
 * journey without rerunning image validation, extraction, or AI work.
 */
async function verifyAccess(keep: boolean): Promise<void> {
  const state = await loadState();
  credentials();
  await refreshSessions(state);
  await clearTrackedReports(state);
  const base = reportsPath(state);
  const pdf = await readFile(state.assets.pdf);

  const whoami = await api(state, "GET", "/claim/whoami", "patient", undefined, [200]);
  assert(
    (whoami.body as any)?.kind === "patient" &&
      (whoami.body as any)?.patientId === state.ids.patientId,
    "access proof whoami resolves the linked synthetic patient",
  );
  const noConsent = await api(state, "GET", base, "patient", undefined, [403]);
  assertResponseCode(noConsent, "CONSENT_REQUIRED", "access proof requires consent");
  await recordConsent(state, "patient");
  const setupRequired = await api(state, "GET", base, "patient", undefined, [403]);
  assertResponseCode(setupRequired, "PATIENT_SETUP_REQUIRED", "access proof requires setup");
  await completeSetup(state, "patient");
  await recordConsent(state, "otherPatient");
  await completeSetup(state, "otherPatient");
  await simulateLegacyAdmission(state);

  const dischargedHistory = await api(
    state,
    "GET",
    reportsPath(state, state.ids.otherPatientId),
    "otherPatient",
    undefined,
    [200],
  );
  assert(
    Array.isArray((dischargedHistory.body as any)?.reports),
    "access proof keeps a discharged patient eligible",
  );
  // The operations app has no bloodwork report screen in this fixture.  The
  // provider whoami plus read-only detail/history calls below are the
  // provider-workspace proof; no provider session is installed in a browser.
  const providerWhoami = await api(state, "GET", "/claim/whoami", "providerOwner", undefined, [200]);
  assert((providerWhoami.body as any)?.kind === "provider", "access proof resolves synthetic provider workspace");

  const created = await createReport(
    state,
    [{ clientFileId: randomUUID(), mimeType: "application/pdf", size: pdf.length }],
    randomUUID(),
  );
  const createdBody = created.body as any;
  assert(typeof createdBody.reportId === "string" && createdBody.uploads?.length === 1, "access proof creates one PDF upload");
  state.ids.reportIds.push(createdBody.reportId);
  await saveState(state);
  await upload(createdBody.uploads[0].uploadUrl, pdf, "application/pdf");
  const committed = await api(
    state,
    "POST",
    `${base}/${createdBody.reportId}/commit`,
    "patient",
    undefined,
    [200],
  );
  assert(
    (committed.body as any)?.report?.lifecycleStatus === "committed" ||
      (committed.body as any)?.report?.extractionStatus === "queued",
    "access proof commits the synthetic PDF",
  );
  const reopened = await api(state, "GET", `${base}/${createdBody.reportId}`, "patient", undefined, [200]);
  assert((reopened.body as any)?.report?.id === createdBody.reportId, "access proof reopens the committed PDF");
  const history = await api(state, "GET", base, "patient", undefined, [200]);
  assert(
    (history.body as any)?.reports?.some((report: any) => report.id === createdBody.reportId),
    "access proof lists the committed PDF in patient history",
  );
  const providerDetail = await api(
    state,
    "GET",
    `${base}/${createdBody.reportId}`,
    "providerOwner",
    undefined,
    [200],
  );
  assert(
    (providerDetail.body as any)?.report?.id === createdBody.reportId,
    "access proof provider can read the committed PDF",
  );
  const providerHistory = await api(state, "GET", base, "providerOwner", undefined, [200]);
  assert(
    (providerHistory.body as any)?.reports?.some((report: any) => report.id === createdBody.reportId),
    "access proof provider history includes the committed PDF",
  );

  if (!keep) await cleanup();
  else {
    console.log(`Access fixture retained: ${FIXTURE_PATH}`);
    console.log(`Access PDF report ID: ${createdBody.reportId}`);
    console.log(`Synthetic assets directory: ${state.assetsDir}`);
  }
}

async function verify(keep: boolean): Promise<void> {
  const state = await loadState();
  credentials();
  await refreshSessions(state);
  await clearTrackedReports(state);
  const base = reportsPath(state);
  const png = await readFile(state.assets.png);
  const jpeg = await readFile(state.assets.jpeg);
  const pdf = await readFile(state.assets.pdf);

  const whoami = await api(state, "GET", "/claim/whoami", "patient", undefined, [200]);
  assert(
    (whoami.body as any)?.kind === "patient" &&
      (whoami.body as any)?.patientId === state.ids.patientId,
    "public whoami resolves the linked synthetic patient",
  );
  const anonymousWhoami = await api(state, "GET", "/claim/whoami", undefined, undefined, [401]);
  assert(anonymousWhoami.status === 401, "public whoami denies a missing session");

  const noConsent = await api(state, "GET", base, "patient", undefined, [403]);
  assertResponseCode(noConsent, "CONSENT_REQUIRED", "bloodwork without consent is denied safely");
  const signedOut = await api(state, "GET", base, undefined, undefined, [401]);
  assertResponseCode(signedOut, "SESSION_REQUIRED", "signed-out bloodwork list denied");

  await recordConsent(state, "patient");
  const setupRequired = await api(state, "GET", base, "patient", undefined, [403]);
  assertResponseCode(setupRequired, "PATIENT_SETUP_REQUIRED", "bloodwork requires normal patient setup");
  const deniedCreate = await createReport(
    state,
    [{ clientFileId: randomUUID(), mimeType: "application/pdf", size: pdf.length }],
    randomUUID(),
    [403],
  );
  assertResponseCode(deniedCreate, "PATIENT_SETUP_REQUIRED", "setup denial blocks report creation");
  const deniedRows = await serviceRest(
    "GET",
    `patient_bloodwork_reports?patient_id=eq.${encodeURIComponent(state.ids.patientId)}&select=id`,
    undefined,
    [200],
  );
  assert(Array.isArray(deniedRows.body) && deniedRows.body.length === 0, "setup denial creates no report");

  await completeSetup(state, "patient");
  await recordConsent(state, "otherPatient");
  await completeSetup(state, "otherPatient");
  await simulateLegacyAdmission(state);
  await verifyUnavailableSyntheticAccount(state);

  const dischargedHistory = await api(
    state,
    "GET",
    reportsPath(state, state.ids.otherPatientId),
    "otherPatient",
    undefined,
    [200],
  );
  assert(
    Array.isArray((dischargedHistory.body as any)?.reports),
    "discharged patient remains eligible for own bloodwork history",
  );
  const dischargedProviderRead = await api(
    state,
    "GET",
    reportsPath(state, state.ids.otherPatientId),
    "wrongOfficeOwner",
    undefined,
    [200],
  );
  assert(
    Array.isArray((dischargedProviderRead.body as any)?.reports),
    "authorized provider can read a discharged patient's history",
  );

  const wrongPatient = await api(state, "GET", base, "otherPatient", undefined, [403, 404]);
  assert(responseCode(wrongPatient) === null, "wrong patient denial reveals no account status");
  const wrongOffice = await api(state, "GET", base, "wrongOfficeOwner", undefined, [403, 404]);
  assert(responseCode(wrongOffice) === null, "wrong office denial reveals no account status");
  await api(state, "GET", base, "disabledTeam", undefined, [403]);
  assert(true, "disabled team member denied");
  await api(
    state, "GET", `${base}?office=${encodeURIComponent(state.ids.providerId)}`,
    "hqSupport", undefined, [403],
  );
  assert(true, "HQ support role denied clinical data");
  await api(
    state, "GET", `${base}?office=${encodeURIComponent(state.ids.providerId)}`,
    "hqClinical", undefined, [200],
  );
  assert(true, "HQ clinical role allowed with explicit office");

  const tenFiles = Array.from({ length: 10 }, (_, index) => ({
    clientFileId: randomUUID(),
    mimeType: index % 2 ? "image/jpeg" : "image/png",
    size: index % 2 ? jpeg.length : png.length,
  }));
  const ten = await createReport(state, tenFiles);
  const tenBody = ten.body as any;
  assert(tenBody.uploads?.length === 10, "ten-image report accepted without truncation");
  state.ids.reportIds.push(tenBody.reportId);
  await saveState(state);
  await deleteStaged(state, tenBody.reportId);

  await createReport(state, [...tenFiles, {
    clientFileId: randomUUID(), mimeType: "image/png", size: png.length,
  }], randomUUID(), [413, 422]);
  assert(true, "eleventh image rejected");
  await createReport(state, [
    { clientFileId: randomUUID(), mimeType: "application/pdf", size: pdf.length },
    { clientFileId: randomUUID(), mimeType: "image/png", size: png.length },
  ], randomUUID(), [422]);
  assert(true, "mixed PDF and image manifest rejected");
  await createReport(state, [
    { clientFileId: randomUUID(), mimeType: "application/pdf", size: MAX_BYTES + 1 },
  ], randomUUID(), [413, 422]);
  assert(true, "20,000,001-byte manifest rejected");
  const exact = await createReport(state, [
    { clientFileId: randomUUID(), mimeType: "application/pdf", size: MAX_BYTES },
  ], randomUUID(), [200, 201, 422]);
  const exactId = (exact.body as any).reportId;
  check(typeof exactId === "string", "exact 20,000,000-byte manifest accepted");
  if (typeof exactId === "string") {
    state.ids.reportIds.push(exactId);
    await deleteStaged(state, exactId);
  }

  const stagedManifest = [
    { clientFileId: randomUUID(), mimeType: "image/png", size: png.length },
    { clientFileId: randomUUID(), mimeType: "image/jpeg", size: jpeg.length },
  ];
  const stagedRequest = randomUUID();
  const staged = await createReport(state, stagedManifest, stagedRequest);
  const stagedBody = staged.body as any;
  state.ids.reportIds.push(stagedBody.reportId);
  await saveState(state);
  const stagedRetry = await createReport(state, stagedManifest, stagedRequest);
  assert(
    stagedRetry.body && JSON.stringify((stagedRetry.body as any).uploads?.map((x: any) => x.fileId)) ===
      JSON.stringify(stagedBody.uploads.map((x: any) => x.fileId)),
    "manifest retry returns the same report and file IDs",
  );
  await createReport(state, [stagedManifest[0]], stagedRequest, [409]);
  assert(true, "conflicting idempotency manifest rejected");
  const beforeCommit = await api(state, "GET", base, "providerOwner");
  assert(
    !(beforeCommit.body as any).reports.some((report: any) => report.id === stagedBody.reportId),
    "staged report is invisible to provider",
  );
  await upload(stagedBody.uploads[0].uploadUrl, png, "image/png");
  await api(state, "POST", `${base}/${stagedBody.reportId}/commit`, "patient", undefined, [409, 422]);
  assert(true, "partial file upload cannot commit");
  await upload(stagedBody.uploads[1].uploadUrl, jpeg, "image/jpeg");
  const stagedCommit = await api(
    state, "POST", `${base}/${stagedBody.reportId}/commit`, "patient", undefined, [200],
  );
  const afterCommit = await api(state, "GET", base, "providerOwner");
  assert(
    (afterCommit.body as any).reports.some((report: any) => report.id === stagedBody.reportId),
    "report becomes visible only after complete commit",
  );
  const stagedVersion = (stagedCommit.body as any).report.version;
  await api(
    state, "DELETE", `${base}/${stagedBody.reportId}?expectedVersion=${stagedVersion}`,
    "patient", undefined, [200, 204],
  );
  for (const label of ["patient", "providerOwner", "hqClinical"] as const) {
    const office = label === "hqClinical" ? `?office=${encodeURIComponent(state.ids.providerId)}` : "";
    await api(state, "GET", `${base}/${stagedBody.reportId}${office}`, label, undefined, [404]);
  }
  await api(
    state, "GET", `${base}/${stagedBody.reportId}/files/${stagedBody.uploads[0].fileId}/source`,
    "patient", undefined, [404],
  );
  assert(true, "delete blocks detail and source reads for every role");

  for (const [asset, label] of [
    [state.assets.corruptPdf, "corrupt PDF"],
    [state.assets.encryptedPdf, "password-protected PDF"],
  ] as const) {
    const bytes = await readFile(asset);
    const created = await createReport(state, [{
      clientFileId: randomUUID(), mimeType: "application/pdf", size: bytes.length,
    }]);
    const body = created.body as any;
    state.ids.reportIds.push(body.reportId);
    await saveState(state);
    await upload(body.uploads[0].uploadUrl, bytes, "application/pdf");
    await api(state, "POST", `${base}/${body.reportId}/commit`, "patient", undefined, [422]);
    assert(true, `${label} commit rejected`);
  }

  const pdfRequestId = randomUUID();
  const pdfManifest = [{ clientFileId: randomUUID(), mimeType: "application/pdf", size: pdf.length }];
  const createdPdf = await createReport(state, pdfManifest, pdfRequestId);
  const pdfBody = createdPdf.body as any;
  state.ids.reportIds.push(pdfBody.reportId);
  await saveState(state);
  await upload(pdfBody.uploads[0].uploadUrl, pdf, "application/pdf");
  const queued = await api(state, "POST", `${base}/${pdfBody.reportId}/commit`, "patient");
  assert(
    (queued.body as any).report.extractionStatus === "queued" &&
      (queued.body as any).report.pageCount === 2,
    "PDF preserved as two pages and extraction queued",
  );
  const pdfFileId = (queued.body as any).files[0].id;
  const reopened = await api(state, "GET", `${base}/${pdfBody.reportId}`, "patient");
  assert(
    (reopened.body as any).report?.id === pdfBody.reportId &&
      (reopened.body as any).files?.length === 1,
    "committed PDF reopens from the patient detail route",
  );
  const patientHistory = await api(state, "GET", base, "patient");
  assert(
    (patientHistory.body as any).reports?.some((report: any) => report.id === pdfBody.reportId),
    "committed PDF appears in patient bloodwork history",
  );
  const providerRead = await api(state, "GET", `${base}/${pdfBody.reportId}`, "providerOwner");
  assert(
    (providerRead.body as any).report?.id === pdfBody.reportId,
    "authorized provider can read the committed PDF report",
  );
  const source = await api(
    state, "GET", `${base}/${pdfBody.reportId}/files/${pdfFileId}/source`, "patient",
  );
  assert(source.bytes.equals(pdf), "original PDF source bytes preserved exactly");
  for (const page of [1, 2]) {
    const rendered = await api(
      state, "GET", `${base}/${pdfBody.reportId}/files/${pdfFileId}/pages/${page}`, "patient",
    );
    assert(
      rendered.bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
      `PDF page ${page} served as PNG`,
    );
  }

  await api(state, "POST", base, "providerOwner", {
    clientRequestId: randomUUID(),
    title: "Forbidden provider report",
    reportDate: null,
    transcriptionConsent: true,
    files: pdfManifest,
  }, [403]);
  await api(
    state, "DELETE", `${base}/${pdfBody.reportId}?expectedVersion=1`,
    "providerOwner", undefined, [403],
  );
  assert(true, "provider create and delete are forbidden");

  await serviceRest("POST", "provider_account_locks", { account_id: state.ids.providerId });
  state.ids.lockIds.push(state.ids.providerId);
  await saveState(state);
  try {
    await api(state, "GET", base, "providerOwner", undefined, [403]);
    await api(
      state, "GET", `${base}?office=${encodeURIComponent(state.ids.providerId)}`,
      "hqClinical", undefined, [403],
    );
    assert(true, "locked office denies both office staff and HQ clinical access");
  } finally {
    await serviceRest(
      "DELETE",
      `provider_account_locks?account_id=eq.${encodeURIComponent(state.ids.providerId)}`,
      undefined,
      [200, 204],
    );
    state.ids.lockIds = state.ids.lockIds.filter((id) => id !== state.ids.providerId);
    await saveState(state);
  }

  let jobError: unknown;
  const jobPromise = runExtractionJob().catch((error) => { jobError = error; });
  const processing = await pollDetail(state, pdfBody.reportId, ["processing"], 30_000);
  assert(processing.report.extractionStatus === "processing", "extraction entered processing");
  await jobPromise;
  if (jobError) throw jobError;
  const completed = await pollDetail(state, pdfBody.reportId, ["completed"], 180_000);
  const results = completed.results as any[];
  assert(results.length >= 4, "AI extraction completed with report rows");
  assert(results.some((row) => row.valueText === "<5"), "comparator fidelity preserved");
  assert(results.some((row) => row.valueText === "2.35"), "decimal fidelity preserved");
  assert(results.some((row) => row.valueText === "Negative"), "qualitative fidelity preserved");
  await api(
    state, "POST", `${base}/${pdfBody.reportId}/retry-extraction`,
    "providerOwner", undefined, [409],
  );
  assert(true, "completed extraction with saved results cannot be retried");

  const result = results.find((row) => row.valueText === "<5") ?? results[0];
  const patientCorrection = await api(
    state,
    "PUT",
    `${base}/${pdfBody.reportId}/results/${result.id}`,
    "patient",
    {
      expectedVersion: result.version,
      testName: result.testName,
      valueText: "<4.9",
      units: result.units,
      referenceRange: result.referenceRange,
      labFlag: result.labFlag,
      uncertain: true,
    },
  );
  const correctedOnce = patientCorrection.body as any;
  await api(
    state,
    "PUT",
    `${base}/${pdfBody.reportId}/results/${result.id}`,
    "patient",
    {
      expectedVersion: result.version,
      testName: result.testName,
      valueText: "stale",
      units: result.units,
      referenceRange: result.referenceRange,
      labFlag: result.labFlag,
      uncertain: false,
    },
    [409],
  );
  const providerCorrection = await api(
    state,
    "PUT",
    `${base}/${pdfBody.reportId}/results/${result.id}`,
    "providerOwner",
    {
      expectedVersion: correctedOnce.version,
      testName: correctedOnce.testName,
      valueText: correctedOnce.valueText,
      units: correctedOnce.units,
      referenceRange: correctedOnce.referenceRange,
      labFlag: "Synthetic corrected",
      uncertain: false,
    },
  );
  assert((providerCorrection.body as any).version === correctedOnce.version + 1, "patient and provider corrections version safely");
  const history = await api(
    state,
    "GET",
    `${base}/${pdfBody.reportId}/results/${result.id}/corrections`,
    "patient",
  );
  const roles = (history.body as any).corrections.map((row: any) => row.actorRole);
  assert(roles.includes("patient") && roles.includes("provider"), "private correction history records both actor roles");

  const reportVersion = completed.report.version;
  const updated = await api(
    state, "PATCH", `${base}/${pdfBody.reportId}`, "patient",
    { expectedVersion: reportVersion, title: "Synthetic renamed report", reportDate: null },
  );
  await api(
    state, "PATCH", `${base}/${pdfBody.reportId}`, "patient",
    { expectedVersion: reportVersion, title: "Stale rename", reportDate: null },
    [409],
  );
  assert((updated.body as any).version === reportVersion + 1, "metadata update increments version and stale update returns 409");

  if (!keep) await cleanup();
  else {
    console.log(`Fixture retained for UI testing: ${FIXTURE_PATH}`);
    console.log(`UI patient ID: ${state.ids.patientId}`);
    console.log(`UI completed report ID: ${pdfBody.reportId}`);
    console.log(`UI source file ID: ${pdfFileId}`);
    console.log(`UI assets directory: ${state.assetsDir}`);
  }
  if (verificationFailures.length) {
    throw new Error(`Smoke verification failed: ${verificationFailures.join("; ")}`);
  }
}

async function cleanup(): Promise<void> {
  let state: FixtureState;
  try {
    state = await loadState();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      console.log(`No fixture found at ${FIXTURE_PATH}`);
      return;
    }
    throw error;
  }
  credentials();

  // Delete only the two random fixture-owned storage prefixes.
  try {
    const { objectStorage } = await import("../src/lib/objectStorage");
    for (const patientId of [state.ids.patientId, state.ids.otherPatientId]) {
      await objectStorage.deletePrefixStrict(`/objects/patients/${patientId}/bloodwork/`);
    }
  } catch (error) {
    throw new Error("Synthetic object cleanup failed; fixture retained for an exact retry.", { cause: error });
  }

  for (const lockId of state.ids.lockIds) {
    await serviceRest("DELETE", `provider_account_locks?account_id=eq.${encodeURIComponent(lockId)}`);
  }
  const patientOwnedTables = [
    "patient_bloodwork_corrections",
    "patient_bloodwork_results",
    "patient_bloodwork_files",
    "patient_bloodwork_reports",
    "patient_write_receipts",
    "patient_medication_dose_logs",
    "patient_medications",
    "patient_consents",
    "patient_flags",
  ];
  for (const patientId of [state.ids.patientId, state.ids.otherPatientId]) {
    const encoded = encodeURIComponent(patientId);
    for (const table of patientOwnedTables) {
      await serviceRest("DELETE", `${table}?patient_id=eq.${encoded}`);
    }
    await serviceRest("DELETE", `patients?id=eq.${encoded}`);
  }
  const patientFilter = [state.ids.patientId, state.ids.otherPatientId]
    .map(encodeURIComponent)
    .join(",");
  for (const table of patientOwnedTables) {
    const remaining = await serviceRest(
      "GET",
      `${table}?patient_id=in.(${patientFilter})&select=patient_id`,
      undefined,
      [200],
    );
    assert(
      Array.isArray(remaining.body) && remaining.body.length === 0,
      `fixture ${table} rows removed`,
    );
  }
  for (const id of state.ids.hqMembershipIds) {
    await serviceRest("DELETE", `hq_memberships?id=eq.${encodeURIComponent(id)}`);
  }
  for (const id of state.ids.teamMemberIds) {
    await serviceRest("DELETE", `team_members?id=eq.${encodeURIComponent(id)}`);
  }
  for (const identity of Object.values(state.identities)) {
    if (!identity) continue;
    await serviceRest(
      "DELETE",
      `training_viewers?auth_user_id=eq.${encodeURIComponent(identity.userId)}`,
    );
    await serviceRest(
      "DELETE",
      `staff_role_assignments?email=eq.${encodeURIComponent(identity.email)}`,
    );
  }
  for (const providerId of [state.ids.providerId, state.ids.wrongProviderId]) {
    await serviceRest("DELETE", `providers?provider_id=eq.${encodeURIComponent(providerId)}`);
  }
  for (const identity of Object.values(state.identities)) {
    if (identity) await deleteAuthUser(identity.userId);
  }
  if (state.helper?.directory) {
    await rm(state.helper.directory, { recursive: true, force: true });
  }
  await rm(state.assetsDir, { recursive: true, force: true });
  await rm(FIXTURE_PATH, { force: true });
  console.log(`Cleaned fixture: ${FIXTURE_PATH}`);
}

async function main(): Promise<void> {
  const [command, ...flags] = process.argv.slice(2);
  if (command === "prepare") return prepare();
  if (command === "verify-access") return verifyAccess(flags.includes("--keep"));
  if (command === "verify") return verify(flags.includes("--keep"));
  if (command === "helper") {
    const state = await loadState();
    return writeBrowserHelper(state);
  }
  if (command === "cleanup") return cleanup();
  throw new Error(
    "Usage: bloodwork-live-smoke.ts prepare | verify-access [--keep] | verify [--keep] | helper | cleanup",
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown smoke harness failure.";
  console.error(`Bloodwork smoke failed: ${message}`);
  process.exitCode = 1;
});
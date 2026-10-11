/**
 * Verification-code delivery for account claiming.
 *
 * Two modes, resolved once per request:
 *   dev  — no message leaves the building. The server generates the code and
 *          returns it in a dev-only response field so the flow can be built
 *          and tested end to end before any credentials exist.
 *   live — SMS rides Twilio Verify (Twilio generates and checks the code);
 *          email codes are generated here and sent through Resend. Missing
 *          credentials fail loudly with a 503 — never a silent fallback.
 *
 * These are the ONLY messages the system ever sends, and only when a person
 * asks for a code. No campaigns, no reminders, no password-reset emails.
 */
import crypto from "node:crypto";
import type { EmailTemplateId, EmailVariables } from "@workspace/email-templates";
import { EmailNotConfiguredError, isEmailConfigured, sendTemplatedEmail } from "../email/transport";

export type DeliveryMode = "dev" | "live";
const TWILIO_START_TIMEOUT_MS = 3_500;
const SMS_DELIVERY_FLOOR_MS = 5_000;

export function deliveryMode(channel?: "sms" | "email"): DeliveryMode {
  const channelKey =
    channel === "sms"
      ? "CLAIM_SMS_DELIVERY_MODE"
      : channel === "email"
        ? "CLAIM_EMAIL_DELIVERY_MODE"
        : null;
  const raw = (
    (channelKey ? process.env[channelKey] : undefined) ||
    process.env.CLAIM_DELIVERY_MODE ||
    ""
  )
    .trim()
    .toLowerCase();
  // A production SMS process must never expose codes inline or skip the
  // provider because an inherited/shared environment variable says "dev".
  // Email remains independently configurable for staged environments.
  if (channel === "sms" && process.env.NODE_ENV === "production") return "live";
  if (raw === "dev" || raw === "live") return raw;
  return process.env.NODE_ENV === "production" ? "live" : "dev";
}

export class DeliveryNotConfiguredError extends Error {
  constructor(channel: "sms" | "email") {
    super(
      channel === "sms"
        ? "Text-message delivery is not configured yet. Add the Twilio Verify credentials to enable it."
        : "Email delivery is not configured yet. Add the Resend credentials to enable it.",
    );
    this.name = "DeliveryNotConfiguredError";
  }
}

function twilioCreds(): { sid: string; token: string; verifySid: string } | null {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const verifySid = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!sid || !token || !verifySid) return null;
  return { sid, token, verifySid };
}

function resendCreds(): boolean {
  return isEmailConfigured();
}

/** Throws when live mode cannot deliver on the requested channel. */
export function assertLiveChannelReady(channel: "sms" | "email"): void {
  if (deliveryMode(channel) !== "live") return;
  if (channel === "sms" && !twilioCreds()) throw new DeliveryNotConfiguredError("sms");
  if (channel === "email" && !resendCreds()) throw new DeliveryNotConfiguredError("email");
}

/**
 * Live SMS lookup responses share a provider-sized floor whether a patient
 * matched or not. That prevents Twilio latency/rejection from becoming an
 * account-existence timing oracle.
 */
export async function holdUntilSmsDeliveryFloor(startedAt: number): Promise<void> {
  if (deliveryMode("sms") !== "live") return;
  const configured = process.env.AUTH_SMS_DELIVERY_FLOOR_MS;
  const raw = configured === undefined || configured.trim() === "" ? SMS_DELIVERY_FLOOR_MS : Number(configured);
  const candidate = Number.isFinite(raw) && raw >= 0 ? raw : SMS_DELIVERY_FLOOR_MS;
  const floor =
    process.env.NODE_ENV === "production"
      ? Math.max(SMS_DELIVERY_FLOOR_MS, candidate)
      : candidate;
  const wait = floor - (Date.now() - startedAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

export function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Sign-in and invitation mail keeps the configured sender verbatim and rides
 * the shared email seam like every other message the system sends.
 */
async function sendTransactionalEmail(
  to: string,
  templateId: EmailTemplateId,
  variables: EmailVariables,
): Promise<void> {
  try {
    await sendTemplatedEmail({ to, templateId, variables, sender: "configured" });
  } catch (error) {
    if (error instanceof EmailNotConfiguredError) throw new DeliveryNotConfiguredError("email");
    throw error;
  }
}

/** Live SMS: Twilio Verify creates and remembers the code itself. */
export async function startTwilioVerification(phoneE164: string): Promise<void> {
  const creds = twilioCreds();
  if (!creds) throw new DeliveryNotConfiguredError("sms");
  const auth = Buffer.from(`${creds.sid}:${creds.token}`).toString("base64");
  const response = await fetch(
    `https://verify.twilio.com/v2/Services/${creds.verifySid}/Verifications`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: phoneE164, Channel: "sms" }).toString(),
      signal: AbortSignal.timeout(TWILIO_START_TIMEOUT_MS),
    },
  );
  let json: { status?: unknown; code?: unknown } = {};
  try {
    json = (await response.json()) as { status?: unknown; code?: unknown };
  } catch {
    // The HTTP status remains useful and contains no patient information.
  }
  if (!response.ok || json.status !== "pending") {
    const providerCode =
      typeof json.code === "number" || typeof json.code === "string"
        ? `, provider code ${String(json.code).replace(/[^0-9A-Za-z_-]/g, "").slice(0, 32)}`
        : "";
    throw new Error(`Twilio Verify start rejected (${response.status}${providerCode})`);
  }
}

export async function checkTwilioVerification(
  phoneE164: string,
  code: string,
): Promise<boolean> {
  const creds = twilioCreds();
  if (!creds) throw new DeliveryNotConfiguredError("sms");
  const auth = Buffer.from(`${creds.sid}:${creds.token}`).toString("base64");
  const response = await fetch(
    `https://verify.twilio.com/v2/Services/${creds.verifySid}/VerificationCheck`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: phoneE164, Code: code }).toString(),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (response.status === 404) return false; // no pending verification
  if (!response.ok) throw new Error(`Twilio Verify check failed (${response.status})`);
  const json = (await response.json()) as { status?: string };
  return json.status === "approved";
}

/** Live email: a server-issued code sent through Resend. */
export async function sendClaimEmail(to: string, code: string): Promise<void> {
  await sendTransactionalEmail(to, "verification-code", { code });
}

/** One post-commit invitation for a genuinely new provider. */
export async function sendProviderClaimInvitation(
  to: string,
  input: { officeName: string; providerName: string; providerCode: string; signInUrl: string },
): Promise<void> {
  await sendTransactionalEmail(to, "provider-account-ready", input);
}

/** Sent only after the durable HQ invitation transaction has committed. */
export async function sendHqTeamInvitation(
  to: string,
  input: { name: string; role: string; setupUrl: string; expiresLabel: string },
): Promise<void> {
  await sendTransactionalEmail(to, "hq-team-invitation", input);
}

/** Post-commit invitation for a patient invited from a provider portal. */
export async function sendPatientInvitation(
  to: string,
  input: {
    name: string;
    providerName: string;
    officeName: string;
    providerCode: string;
    phone: string;
    /** Button target: the App Store link, else Google Play, else the Expo Go page. */
    appLink: string;
    /** Store flow when either is present (see lib/email-templates); otherwise the Expo Go steps. */
    appStoreLink?: string;
    googlePlayLink?: string;
    expoGoLink?: string;
  },
): Promise<void> {
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) if (typeof value === "string") variables[key] = value;
  await sendTransactionalEmail(to, "patient-invitation", variables);
}

/** Post-commit invitation for a new office staff sign-in added by HQ. */
export async function sendStaffLoginInvitation(
  to: string,
  input: { name: string; officeName: string },
): Promise<void> {
  await sendTransactionalEmail(to, "provider-staff-invitation", input);
}

/** Security: the account was signed in to from a device it had not seen before. */
export async function sendNewSignInAlertEmail(
  to: string,
  input: { name: string; device: string; region: string; when: string; method: string; reportLink: string },
): Promise<void> {
  await sendTransactionalEmail(to, "new-sign-in-alert", input);
}

/** Security: the password changed and every other device was signed out. */
export async function sendPasswordChangedEmail(
  to: string,
  input: { name: string; when: string; reportLink: string },
): Promise<void> {
  await sendTransactionalEmail(to, "password-changed", input);
}

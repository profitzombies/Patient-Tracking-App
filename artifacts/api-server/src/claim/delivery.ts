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

export type DeliveryMode = "dev" | "live";

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

function resendCreds(): { apiKey: string; from: string } | null {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.CLAIM_EMAIL_FROM;
  if (!apiKey || !from) return null;
  return { apiKey, from };
}

/** Throws when live mode cannot deliver on the requested channel. */
export function assertLiveChannelReady(channel: "sms" | "email"): void {
  if (deliveryMode(channel) !== "live") return;
  if (channel === "sms" && !twilioCreds()) throw new DeliveryNotConfiguredError("sms");
  if (channel === "email" && !resendCreds()) throw new DeliveryNotConfiguredError("email");
}

export function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
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
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Twilio Verify start failed (${response.status})`);
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
  const creds = resendCreds();
  if (!creds) throw new DeliveryNotConfiguredError("email");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: creds.from,
      to: [to],
      subject: `${code} is your THINNR verification code`,
      text: [
        `Your THINNR verification code is ${code}.`,
        "",
        "It expires in 10 minutes. If you didn't request it, you can ignore this email.",
      ].join("\n"),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Resend send failed (${response.status})`);
  }
}

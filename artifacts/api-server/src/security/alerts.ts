/**
 * Security notifications: the new-device alert and the password-changed
 * confirmation.
 *
 * Patients get a push through the notification outbox when they have a
 * live push token (the app opens the Security screen, where the sign-in is
 * flagged with a "this wasn't me" action). Without a push-capable device the
 * alert goes by email; staff always get email. Emails carry a one-time
 * report link so the recipient can lock the account down without signing
 * in — the token is only ever stored hashed.
 *
 * Everything here is best-effort and fire-and-forget from the caller's point
 * of view: an alert failure is logged, never surfaced to the sign-in it is
 * about (the sign-in already happened).
 */
import { sendNewSignInAlertEmail, sendPasswordChangedEmail } from "../claim/delivery";
import { logger } from "../lib/logger";
import { supabaseNotificationStore } from "../notifications/store";
import { firstName, type SecurityActor } from "./actor";
import { methodLabel, type RecordedSignIn } from "./ledger";

export const SECURITY_NOTIFICATION_KIND = "security_new_sign_in";
export const SECURITY_ROUTE = "/security";
export const PASSWORD_CHANGED_NOTIFICATION_KIND = "security_password_changed";

function baseUrl(kind: "patient" | "staff"): string | null {
  if (kind === "patient") {
    const configured = process.env.PATIENT_APP_URL?.trim();
    if (configured) return configured.replace(/\/$/, "");
    const expo = process.env.REPLIT_EXPO_DEV_DOMAIN?.trim();
    return expo ? `https://${expo}` : null;
  }
  const configured = process.env.OPERATIONS_APP_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const dev = process.env.REPLIT_DEV_DOMAIN?.trim();
  return dev ? `https://${dev}` : null;
}

/** Link the email's "this wasn't me" button opens. */
export function reportLinkFor(kind: "patient" | "staff", token: string): string | null {
  const base = baseUrl(kind);
  if (!base) return null;
  const path = kind === "patient" ? "/security-report" : "/security/report";
  return `${base}${path}?token=${encodeURIComponent(token)}`;
}

export function formatWhen(iso: string, timeZone?: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timeZone ?? "UTC",
      timeZoneName: "short",
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toUTCString();
  }
}

export interface AlertOutcome {
  channel: "push" | "email" | "none";
  reason?: string;
}

/**
 * Raise the alert for a recorded new-device sign-in. Returns which channel
 * carried it (tests assert on this; production callers fire and forget).
 */
export async function sendNewDeviceAlert(actor: SecurityActor, recorded: RecordedSignIn): Promise<AlertOutcome> {
  if (!recorded.newDevice) return { channel: "none", reason: "not_new" };
  const row = recorded.row;
  const device = row.device_label ?? "Unknown device";
  const region = row.ip_region ?? "Location unavailable";
  const when = formatWhen(row.created_at);
  const method = methodLabel(row.method);
  const name = firstName(actor.name);

  if (actor.realm === "patient") {
    const tokens = await supabaseNotificationStore.activeTokens(actor.patientId);
    if (tokens.length > 0) {
      await supabaseNotificationStore.enqueue({
        patientId: actor.patientId,
        kind: SECURITY_NOTIFICATION_KIND,
        category: "account",
        title: "New sign-in to your account",
        body: `${device}${row.ip_region ? ` near ${row.ip_region}` : ""}. If this wasn't you, open Security and sign out everywhere.`,
        data: { route: SECURITY_ROUTE, signInId: row.id },
        dedupeKey: `security-sign-in:${row.id}`,
        expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      });
      return { channel: "push" };
    }
    if (!actor.email) return { channel: "none", reason: "no_push_no_email" };
    const reportLink = recorded.reportToken ? reportLinkFor("patient", recorded.reportToken) : null;
    if (!reportLink) return { channel: "none", reason: "no_app_link" };
    await sendNewSignInAlertEmail(actor.email, { name, device, region, when, method, reportLink });
    return { channel: "email" };
  }

  if (!actor.email) return { channel: "none", reason: "no_email" };
  const reportLink = recorded.reportToken ? reportLinkFor("staff", recorded.reportToken) : null;
  if (!reportLink) return { channel: "none", reason: "no_app_link" };
  await sendNewSignInAlertEmail(actor.email, { name, device, region, when, method, reportLink });
  return { channel: "email" };
}

/** Fire-and-forget wrapper used by the sign-in routes. */
export function raiseNewDeviceAlert(actor: SecurityActor, recorded: RecordedSignIn): void {
  void sendNewDeviceAlert(actor, recorded).catch((error) =>
    logger.error({ err: error, signInId: recorded.row.id }, "new-device alert failed"),
  );
}

/**
 * Confirm a password change: push when the patient has a device, email
 * otherwise (the email carries the report link so a hijacked change can be
 * undone from the inbox).
 */
export async function sendPasswordChangedConfirmation(
  actor: Extract<SecurityActor, { realm: "patient" }>,
  input: { changedAt: string; reportToken: string | null },
): Promise<AlertOutcome> {
  const tokens = await supabaseNotificationStore.activeTokens(actor.patientId);
  const when = formatWhen(input.changedAt);
  if (tokens.length > 0) {
    await supabaseNotificationStore.enqueue({
      patientId: actor.patientId,
      kind: PASSWORD_CHANGED_NOTIFICATION_KIND,
      category: "account",
      title: "Your password was changed",
      body: "Every other device was signed out. If this wasn't you, open Security right away.",
      data: { route: SECURITY_ROUTE },
      dedupeKey: `security-password-changed:${actor.patientId}:${input.changedAt}`,
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    });
    return { channel: "push" };
  }
  if (!actor.email) return { channel: "none", reason: "no_push_no_email" };
  const reportLink = input.reportToken ? reportLinkFor("patient", input.reportToken) : null;
  if (!reportLink) return { channel: "none", reason: "no_app_link" };
  await sendPasswordChangedEmail(actor.email, { name: firstName(actor.name), when, reportLink });
  return { channel: "email" };
}

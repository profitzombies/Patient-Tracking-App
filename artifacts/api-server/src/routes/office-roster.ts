/**
 * Provider-portal live endpoints: an office's live patient roster and
 * patient invitations (create + resend).
 *
 * Scope is never client-chosen for office staff — the bearer token resolves
 * to their own office (auth/office-scope). HQ callers name an office
 * explicitly and need the matching provider permission. Duplicate email and
 * phone conflicts answer with the same neutral wording no matter which
 * office owns the existing row.
 *
 * The invitation email goes out only AFTER the patient row has landed. Its
 * delivery state is durable (patients.invite_email_status) so a failed send
 * surfaces a Resend action instead of silently losing the invite, and the
 * resend rides an atomic conditional UPDATE on invite_email_updated_at — the
 * rate limit and the double-send guard are the same database write.
 *
 * Claiming needs no code here: an invited row's phone is found by the
 * existing passwordless login rail, which links the auth user, preserves
 * provider_id, and flips activation_status to activated (auth/session.ts).
 */
import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase-admin";
import { resolveOfficeScope, type OfficeScope } from "../auth/office-scope";
import { acquireInviteSlot } from "../auth/limits";
import { clientIp } from "../auth/ledger";
import { lookupPatients } from "../auth/directory";
import {
  DeliveryNotConfiguredError,
  sendPatientInvitation,
} from "../claim/delivery";
import { effectiveProviderCode, normalizeUsPhone } from "./provider-accounts";

const router: IRouter = Router();

function enc(value: string): string {
  return encodeURIComponent(value);
}

const SERVER_ERROR = "Something went wrong on our side. Please try again.";
const EMAIL_TAKEN = "That email is already on a patient account. Use a different email.";
const PHONE_TAKEN = "That phone number is already on a patient account. Use a different number.";

/** Resend cooldown; env knob exists so tests can stage the limit deterministically. */
function resendCooldownSeconds(): number {
  // NB: Number("") is 0 — an unset/blank knob must fall through to the
  // 60s default, not disable the cooldown.
  const raw = process.env.PATIENT_INVITE_RESEND_SECONDS;
  if (raw == null || raw.trim() === "") return 60;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60;
}

const PATIENT_SELECT =
  "id,provider_id,name,email,phone,activation_status,auth_user_id,claimed_at,created_at,invited_at,invited_by,invite_email_status,invite_email_updated_at";

type PatientRosterRow = Record<string, unknown>;

export type InvitationEmailOutcome = "sent" | "failed" | "not_configured";

function patientDto(row: PatientRosterRow) {
  const invited = typeof row.invited_at === "string" && row.invited_at.length > 0;
  const verified = typeof row.auth_user_id === "string" && row.auth_user_id.length > 0;
  return {
    id: String(row.id),
    name: row.name ? String(row.name) : "",
    email: row.email ? String(row.email) : null,
    phone: row.phone ? String(row.phone) : null,
    phoneDisplay: normalizeUsPhone(typeof row.phone === "string" ? row.phone : ""),
    activationStatus: row.activation_status ? String(row.activation_status) : null,
    verified,
    createdAt: row.created_at ? String(row.created_at) : null,
    invitation: invited
      ? {
          state: verified ? ("verified" as const) : ("pending" as const),
          invitedAt: String(row.invited_at),
          emailStatus: row.invite_email_status
            ? (String(row.invite_email_status) as "pending" | "sent" | "failed")
            : "pending",
          emailUpdatedAt: row.invite_email_updated_at ? String(row.invite_email_updated_at) : null,
        }
      : null,
  };
}

export type OfficePatientDto = ReturnType<typeof patientDto>;

/**
 * The app link for the invitation email. Deployments set PATIENT_APP_URL;
 * the workspace falls back to the Expo dev domain. No link means email
 * delivery is not configured — better an honest retry state than a dead
 * button in a patient's inbox.
 */
function patientAppLink(): string {
  const configured = process.env.PATIENT_APP_URL?.trim();
  if (configured) return configured;
  const expo = process.env.REPLIT_EXPO_DEV_DOMAIN?.trim();
  if (expo) return `https://${expo}`;
  // No app link = the invitation email cannot be composed; surface the same
  // durable "not configured" retry state as missing email credentials.
  throw new DeliveryNotConfiguredError("email");
}

/**
 * Send the branded email for an already-committed invitation row and record
 * the durable delivery state. Never throws — the row is the source of truth
 * and the caller reports the outcome.
 */
async function deliverInvitationEmail(input: {
  patientId: string;
  firstName: string;
  email: string;
  phoneDisplay: string;
  scope: OfficeScope;
  log?: { error: (obj: unknown, msg: string) => void };
}): Promise<InvitationEmailOutcome> {
  let outcome: InvitationEmailOutcome = "sent";
  try {
    await sendPatientInvitation(input.email, {
      name: input.firstName,
      providerName: input.scope.providerName,
      officeName: input.scope.officeName,
      providerCode:
        effectiveProviderCode(input.scope.onboardingCode, input.scope.providerId) ??
        input.scope.providerId,
      phone: input.phoneDisplay,
      appLink: patientAppLink(),
    });
  } catch (error) {
    outcome = error instanceof DeliveryNotConfiguredError ? "not_configured" : "failed";
    input.log?.error({ err: error }, "patient invitation email failed");
  }
  const patched = await supabaseAdmin(
    "PATCH",
    `/rest/v1/patients?id=eq.${enc(input.patientId)}`,
    {
      invite_email_status: outcome === "sent" ? "sent" : "failed",
      invite_email_updated_at: new Date().toISOString(),
    },
  );
  if (patched.status >= 300) {
    input.log?.error(
      { status: patched.status },
      "patient invitation email status update failed",
    );
  }
  return outcome;
}

router.get("/office/roster", async (req, res) => {
  try {
    const resolved = await resolveOfficeScope({
      authorization: req.headers.authorization,
      explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
      hqPermission: "provider_read",
      requireUnlocked: false,
    });
    if (resolved.kind !== "ok") {
      res.status(resolved.status).json({ error: resolved.message });
      return;
    }
    const scope = resolved.scope;
    const rows = await supabaseAdmin(
      "GET",
      `/rest/v1/patients?provider_id=eq.${enc(scope.providerId)}&select=${PATIENT_SELECT}&order=created_at.desc&limit=500`,
    );
    if (rows.status >= 300) throw new Error(`roster load failed (${rows.status})`);
    const patients = (Array.isArray(rows.json) ? (rows.json as PatientRosterRow[]) : []).map(
      patientDto,
    );
    res.json({
      office: {
        providerId: scope.providerId,
        officeName: scope.officeName,
        providerCode:
          effectiveProviderCode(scope.onboardingCode, scope.providerId) ?? scope.providerId,
      },
      patients,
    });
  } catch (error) {
    req.log?.error({ err: error }, "office roster failed");
    res.status(502).json({ error: SERVER_ERROR });
  }
});

const InviteInput = z.object({
  firstName: z.string().trim().min(1, "First name is required.").max(80, "First name is too long."),
  lastName: z.string().trim().min(1, "Last name is required.").max(80, "Last name is too long."),
  email: z
    .string()
    .trim()
    .min(1, "Email is required.")
    .max(320, "Email is too long.")
    .email("Enter a valid email address."),
  phone: z.string().trim().min(1, "Phone number is required.").max(40, "Enter a valid 10-digit US mobile number."),
  office: z.string().trim().max(120).optional(),
});

router.post("/office/invitations", async (req, res) => {
  const slot = acquireInviteSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  try {
    const parsed = InviteInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      res.status(400).json({
        error: issue?.message ?? "Check the invitation form and try again.",
        field: typeof issue?.path?.[0] === "string" ? issue.path[0] : undefined,
      });
      return;
    }
    const phoneDisplay = normalizeUsPhone(parsed.data.phone);
    if (!phoneDisplay) {
      res.status(400).json({
        error: "Enter a valid 10-digit US mobile number.",
        field: "phone",
      });
      return;
    }
    const phoneDigits = phoneDisplay.replace(/\D/g, "");
    const phoneE164 = `+1${phoneDigits}`;
    const email = parsed.data.email.toLowerCase();

    const resolved = await resolveOfficeScope({
      authorization: req.headers.authorization,
      explicitOfficeId: parsed.data.office ?? null,
      hqPermission: "provider_manage",
      requireUnlocked: true,
    });
    if (resolved.kind !== "ok") {
      res.status(resolved.status).json({ error: resolved.message });
      return;
    }
    const scope = resolved.scope;

    // Pre-checks give clear field-level errors; the partial unique indexes
    // on the insert below are the airtight backstop. Both answers stay
    // neutral about who owns the existing row.
    const emailTaken = await supabaseAdmin(
      "GET",
      `/rest/v1/patients?email=ilike.${enc(email)}&select=id&limit=1`,
    );
    if (emailTaken.status >= 300) throw new Error(`email check failed (${emailTaken.status})`);
    if (Array.isArray(emailTaken.json) && emailTaken.json.length > 0) {
      res.status(409).json({ error: EMAIL_TAKEN, field: "email" });
      return;
    }
    const phoneMatches = await lookupPatients({
      kind: "phone",
      e164: phoneE164,
      last10: phoneDigits,
    });
    if (phoneMatches.length > 0) {
      res.status(409).json({ error: PHONE_TAKEN, field: "phone" });
      return;
    }

    const now = new Date().toISOString();
    const patientId = crypto.randomUUID();
    const firstName = parsed.data.firstName.replace(/\s+/g, " ");
    const lastName = parsed.data.lastName.replace(/\s+/g, " ");
    const inserted = await supabaseAdmin(
      "POST",
      "/rest/v1/patients",
      {
        id: patientId,
        provider_id: scope.providerId,
        name: `${firstName} ${lastName}`,
        email,
        phone: phoneE164,
        activation_status: "invited",
        created_at: now,
        invited_at: now,
        invited_by: scope.actorUserId,
        invite_email_status: "pending",
        invite_email_updated_at: now,
      },
      "return=representation",
    );
    if (inserted.status >= 300) {
      const message = String((inserted.json as { message?: unknown })?.message ?? "");
      if (message.includes("patients_email_unique_idx")) {
        res.status(409).json({ error: EMAIL_TAKEN, field: "email" });
        return;
      }
      if (message.includes("patients_phone_unique_idx")) {
        res.status(409).json({ error: PHONE_TAKEN, field: "phone" });
        return;
      }
      throw new Error(`patient invite insert failed (${inserted.status})`);
    }
    const row = (Array.isArray(inserted.json) ? inserted.json[0] : inserted.json) as
      | PatientRosterRow
      | undefined;
    if (!row) throw new Error("patient invite insert returned no row");

    // Email only after the row has landed — its outcome is durable state.
    const invitation = await deliverInvitationEmail({
      patientId,
      firstName,
      email,
      phoneDisplay,
      scope,
      log: req.log,
    });
    res.status(201).json({
      patient: patientDto({
        ...row,
        invite_email_status: invitation === "sent" ? "sent" : "failed",
      }),
      invitation,
    });
  } catch (error) {
    req.log?.error({ err: error }, "patient invitation failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

router.post("/office/invitations/:id/resend", async (req, res) => {
  const slot = acquireInviteSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message, retryable: slot.retryable });
    return;
  }
  try {
    const resolved = await resolveOfficeScope({
      authorization: req.headers.authorization,
      explicitOfficeId:
        typeof (req.body ?? {}).office === "string"
          ? String((req.body as { office?: string }).office)
          : typeof req.query.office === "string"
            ? req.query.office
            : null,
      hqPermission: "provider_manage",
      requireUnlocked: true,
    });
    if (resolved.kind !== "ok") {
      res.status(resolved.status).json({ error: resolved.message });
      return;
    }
    const scope = resolved.scope;
    const id = String(req.params.id ?? "");

    const found = await supabaseAdmin(
      "GET",
      `/rest/v1/patients?id=eq.${enc(id)}&select=${PATIENT_SELECT}&limit=1`,
    );
    if (found.status >= 300) throw new Error(`invitation lookup failed (${found.status})`);
    const row = Array.isArray(found.json) ? (found.json[0] as PatientRosterRow | undefined) : undefined;
    // One neutral answer for "doesn't exist", "not this office's patient",
    // and "not an invited row" — cross-office probing learns nothing.
    if (!row || String(row.provider_id ?? "") !== scope.providerId || !row.invited_at) {
      res.status(404).json({ error: "No invitation found for this office." });
      return;
    }
    if (row.auth_user_id) {
      res.status(409).json({
        error: "This patient has already verified their account — no invitation needed.",
      });
      return;
    }

    // Atomic rate limit + double-send guard: the conditional UPDATE only
    // lands while the row is unclaimed and outside the cooldown window.
    const cooldown = resendCooldownSeconds();
    const cutoff = new Date(Date.now() - cooldown * 1000).toISOString();
    const guarded = await supabaseAdmin(
      "PATCH",
      `/rest/v1/patients?id=eq.${enc(id)}&provider_id=eq.${enc(scope.providerId)}&auth_user_id=is.null&or=(invite_email_updated_at.is.null,invite_email_updated_at.lt.${enc(cutoff)})`,
      { invite_email_status: "pending", invite_email_updated_at: new Date().toISOString() },
      "return=representation",
    );
    if (guarded.status >= 300) throw new Error(`invitation resend guard failed (${guarded.status})`);
    if (!Array.isArray(guarded.json) || guarded.json.length !== 1) {
      res.status(429).json({
        error: "This invitation was just sent. Please wait a minute before resending.",
        retryable: true,
      });
      return;
    }

    const name = String(row.name ?? "");
    const firstName = name.split(/\s+/)[0] || name || "there";
    const email = String(row.email ?? "");
    const phoneDisplay =
      normalizeUsPhone(typeof row.phone === "string" ? row.phone : "") ??
      String(row.phone ?? "");
    const invitation = await deliverInvitationEmail({
      patientId: id,
      firstName,
      email,
      phoneDisplay,
      scope,
      log: req.log,
    });
    res.json({
      ok: true,
      invitation,
      patient: patientDto({
        ...row,
        invite_email_status: invitation === "sent" ? "sent" : "failed",
        invite_email_updated_at: new Date().toISOString(),
      }),
    });
  } catch (error) {
    req.log?.error({ err: error }, "patient invitation resend failed");
    res.status(502).json({ error: SERVER_ERROR });
  } finally {
    slot.ok && slot.release();
  }
});

export default router;

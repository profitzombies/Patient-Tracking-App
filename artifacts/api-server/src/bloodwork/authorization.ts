import { type Request, type Response } from "express";
import { resolveOfficeScope, respondOfficeScopeDenied, type OfficeScope } from "../auth/office-scope";
import { resolvePatientIdentity } from "../lib/patient-auth";
import { supabaseAdmin } from "../lib/supabase-admin";
import { consentDto, loadLatestConsent, type ConsentDto } from "../privacy/consent";

const enc = encodeURIComponent;

export type Recovery = "setup" | "consent" | "sign_in" | "retry" | "account";
export type PatientAccessCode =
  | "PATIENT_SETUP_REQUIRED"
  | "CONSENT_REQUIRED"
  | "PATIENT_ACCOUNT_UNAVAILABLE"
  | "SESSION_REQUIRED"
  | "ACCOUNT_LOOKUP_UNAVAILABLE";

export interface PatientAccessFailure {
  status: 401 | 403 | 404 | 503;
  error: string;
  code: PatientAccessCode;
  recovery: Recovery;
  consent?: ConsentDto;
}

export type Actor =
  | { kind: "patient"; patientId: string; actorUserId: string; role: "patient" }
  | { kind: "staff"; patientId: string; actorUserId: string; role: "provider" | "hq"; scope: OfficeScope };

const PATIENT_UNAVAILABLE_MESSAGE = "Patient bloodwork is unavailable for this account.";
const PATIENT_ACCOUNT_UNAVAILABLE_MESSAGE = "This patient account is unavailable.";
const PATIENT_SETUP_REQUIRED_MESSAGE = "Complete patient setup before using bloodwork.";
const ACCOUNT_LOOKUP_UNAVAILABLE_MESSAGE = "Account lookup is unavailable right now.";

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

/**
 * Account admission is deliberately separate from identity resolution. The
 * caller must prove ownership before this helper reports setup, consent, or
 * lifecycle state. Staff callers receive only a boolean admission result so
 * an office cannot use this endpoint to enumerate unavailable patients.
 */
export async function admitPatient(input: {
  patientId: string;
  authUserId?: string;
  providerId?: string;
  requireConsent: boolean;
}): Promise<{ ok: true; consent: ConsentDto | null } | { ok: false; failure: PatientAccessFailure }> {
  const patientFilters = [
    `id=eq.${enc(input.patientId)}`,
    ...(input.authUserId ? [`auth_user_id=eq.${enc(input.authUserId)}`] : []),
    ...(input.providerId ? [`provider_id=eq.${enc(input.providerId)}`] : []),
  ];
  let patient;
  let flags;
  try {
    [patient, flags] = await Promise.all([
      supabaseAdmin(
        "GET",
        `/rest/v1/patients?${patientFilters.join("&")}` +
          "&select=id,activation_status,archived_at,deletion_requested_at&limit=2",
      ),
      supabaseAdmin(
        "GET",
        `/rest/v1/patient_flags?patient_id=eq.${enc(input.patientId)}` +
          "&select=patient_id,onboarding_complete&limit=2",
      ),
    ]);
  } catch {
    return {
      ok: false,
      failure: {
        status: 503,
        error: ACCOUNT_LOOKUP_UNAVAILABLE_MESSAGE,
        code: "ACCOUNT_LOOKUP_UNAVAILABLE",
        recovery: "retry",
      },
    };
  }
  if (
    patient.status >= 300 ||
    !Array.isArray(patient.json) ||
    flags.status >= 300 ||
    !Array.isArray(flags.json)
  ) {
    return {
      ok: false,
      failure: {
        status: 503,
        error: ACCOUNT_LOOKUP_UNAVAILABLE_MESSAGE,
        code: "ACCOUNT_LOOKUP_UNAVAILABLE",
        recovery: "retry",
      },
    };
  }
  if (patient.json.length > 1 || flags.json.length > 1) {
    return {
      ok: false,
      failure: {
        status: 503,
        error: ACCOUNT_LOOKUP_UNAVAILABLE_MESSAGE,
        code: "ACCOUNT_LOOKUP_UNAVAILABLE",
        recovery: "retry",
      },
    };
  }

  const row = patient.json[0] as {
    activation_status?: unknown;
    archived_at?: unknown;
    deletion_requested_at?: unknown;
  } | undefined;
  const available =
    patient.json.length === 1 &&
    row?.archived_at == null &&
    row?.deletion_requested_at == null &&
    row?.activation_status !== "disabled";
  if (!available) {
    if (input.authUserId) {
      return {
        ok: false,
        failure: {
          status: 403,
          error: PATIENT_ACCOUNT_UNAVAILABLE_MESSAGE,
          code: "PATIENT_ACCOUNT_UNAVAILABLE",
          recovery: "account",
        },
      };
    }
    return {
      ok: false,
      failure: {
        status: 404,
        error: "Patient record not found.",
        code: "PATIENT_ACCOUNT_UNAVAILABLE",
        recovery: "account",
      },
    };
  }

  // Consent is the first patient-entry gate, matching the mobile live-entry
  // policy. Account locks are checked above, but setup waits until after
  // consent so an account missing both receives the action it can complete
  // without first entering the protected onboarding route.
  let consent: ConsentDto | null = null;
  if (input.requireConsent) {
    try {
      consent = consentDto(await loadLatestConsent(input.patientId));
    } catch {
      return {
        ok: false,
        failure: {
          status: 503,
          error: ACCOUNT_LOOKUP_UNAVAILABLE_MESSAGE,
          code: "ACCOUNT_LOOKUP_UNAVAILABLE",
          recovery: "retry",
        },
      };
    }
    if (!consent.satisfied) {
      return {
        ok: false,
        failure: {
          status: 403,
          error: "Please review and accept the current terms before continuing.",
          code: "CONSENT_REQUIRED",
          recovery: "consent",
          consent,
        },
      };
    }
  }

  const flag = flags.json[0] as { onboarding_complete?: unknown } | undefined;
  if (flags.json.length !== 1 || flag?.onboarding_complete !== true) {
    if (input.authUserId) {
      return {
        ok: false,
        failure: {
          status: 403,
          error: PATIENT_SETUP_REQUIRED_MESSAGE,
          code: "PATIENT_SETUP_REQUIRED",
          recovery: "setup",
        },
      };
    }
    return {
      ok: false,
      failure: {
        status: 404,
        error: "Patient record not found.",
        code: "PATIENT_SETUP_REQUIRED",
        recovery: "setup",
      },
    };
  }
  return { ok: true, consent };
}

function respondPatientAccessFailure(res: Response, failure: PatientAccessFailure): void {
  const body: Record<string, unknown> = {
    error: failure.error,
    code: failure.code,
    recovery: failure.recovery,
  };
  if (failure.consent) body.consent = failure.consent;
  res.status(failure.status).json(body);
}

export async function authorize(
  req: Request,
  res: Response,
  mode: "read" | "edit" | "patient",
): Promise<Actor | null> {
  const requested = first(req.params.patientId);
  const patient = await resolvePatientIdentity(req);
  if (patient.ok) {
    // Compare the URL id before touching admission or consent. This keeps
    // cross-patient requests indistinguishable from a missing record.
    if (patient.patientId !== requested) {
      res.status(404).json({ error: "Patient record not found." });
      return null;
    }
    const admission = await admitPatient({
      patientId: requested,
      authUserId: patient.authUserId,
      requireConsent: true,
    });
    if (!admission.ok) {
      respondPatientAccessFailure(res, admission.failure);
      return null;
    }
    return { kind: "patient", patientId: requested, actorUserId: patient.authUserId, role: "patient" };
  }
  if (mode === "patient") {
    if (patient.status === 401) {
      respondPatientAccessFailure(res, {
        status: 401,
        error: "Sign in required.",
        code: "SESSION_REQUIRED",
        recovery: "sign_in",
      });
    } else if (patient.status === 503) {
      respondPatientAccessFailure(res, {
        status: 503,
        error: ACCOUNT_LOOKUP_UNAVAILABLE_MESSAGE,
        code: "ACCOUNT_LOOKUP_UNAVAILABLE",
        recovery: "retry",
      });
    } else {
      // A signed-in account without a canonical patient link is not an
      // admitted owner. Do not disclose setup/account state in this case.
      res.status(403).json({ error: PATIENT_UNAVAILABLE_MESSAGE });
    }
    return null;
  }
  if (patient.status === 401) {
    respondPatientAccessFailure(res, {
      status: 401,
      error: "Sign in required.",
      code: "SESSION_REQUIRED",
      recovery: "sign_in",
    });
    return null;
  }
  if (patient.status === 503) {
    respondPatientAccessFailure(res, {
      status: 503,
      error: ACCOUNT_LOOKUP_UNAVAILABLE_MESSAGE,
      code: "ACCOUNT_LOOKUP_UNAVAILABLE",
      recovery: "retry",
    });
    return null;
  }
  if (patient.status !== 403) {
    res.status(patient.status).json({ error: patient.error });
    return null;
  }
  const office = await resolveOfficeScope({
    authorization: req.headers.authorization,
    explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
    hqPermission: mode === "edit" ? "provider_manage" : "provider_read",
    // Bloodwork is sensitive clinical data: locked offices cannot read it.
    requireUnlocked: true,
  });
  if (office.kind !== "ok") {
    if (office.reason === "staff_only") {
      res.status(403).json({ error: PATIENT_UNAVAILABLE_MESSAGE });
    } else {
      respondOfficeScopeDenied(req, res, office);
    }
    return null;
  }
  const admission = await admitPatient({
    patientId: requested,
    providerId: office.scope.providerId,
    requireConsent: false,
  });
  if (!admission.ok) {
    if (admission.failure.status === 503) {
      res.status(503).json({ error: "Bloodwork is unavailable right now." });
    } else {
      res.status(404).json({ error: "Patient record not found." });
    }
    return null;
  }
  return {
    kind: "staff",
    patientId: requested,
    actorUserId: office.scope.actorUserId,
    role: office.scope.actorKind === "hq" ? "hq" : "provider",
    scope: office.scope,
  };
}
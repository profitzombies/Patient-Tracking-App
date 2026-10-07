/**
 * PHI classification for every email template.
 *
 * Email leaves through a vendor that has not signed a BAA, so no template may
 * carry clinical content (weights, medications, labs, diagnoses, photos) and
 * a patient's full name may appear only in the claim/invitation family that
 * exists to hand someone their own sign-in. Product and plan names are the
 * one deliberate exception (payment records), which is why the class is
 * recorded per template rather than inferred: the catalog lint and the send
 * seam both read this table.
 */
import type { EmailTemplateDefinition, EmailTemplateId } from "./index";

export type EmailPhiClass =
  /** Codes and account-security notices; no identity beyond a first name. */
  | "security"
  /** Onboarding and invitations: may address a person by name and hand out sign-in details. */
  | "identity"
  /** Orders, receipts, subscriptions: product and plan names are allowed, clinical wording is not. */
  | "payment"
  /** Staff and HQ operational mail: counts, metric names, and links only. */
  | "operational";

export const EMAIL_TEMPLATE_PHI_CLASS: Record<EmailTemplateId, EmailPhiClass> = {
  "verification-code": "security",
  "new-sign-in-alert": "security",
  "password-changed": "security",
  "provider-account-ready": "identity",
  "hq-team-invitation": "identity",
  "provider-staff-invitation": "identity",
  "patient-invitation": "identity",
  "order-receipt": "payment",
  "order-shipped": "payment",
  "order-delivered": "payment",
  "order-confirmation": "payment",
  "subscription-payment-failed": "payment",
  "subscription-cancelled": "payment",
  "subscription-started": "payment",
  "subscription-shipment-moved": "payment",
  "subscription-shipment-skipped": "payment",
  "subscription-paused": "payment",
  "subscription-resumed": "payment",
  "subscription-plan-changed": "payment",
  "subscription-address-changed": "payment",
  "subscription-renewal-reminder": "payment",
  "subscription-card-updated": "payment",
  "staff-attention-digest": "operational",
  "coach-chat-flag": "operational",
  "system-threshold-alert": "operational",
  "office-access-restricted": "operational",
};

/** Templates that may address a patient or staff member by full name. */
export const FULL_NAME_EMAIL_TEMPLATE_IDS: ReadonlySet<EmailTemplateId> = new Set<EmailTemplateId>([
  "provider-account-ready",
  "hq-team-invitation",
  "provider-staff-invitation",
  "patient-invitation",
]);

/**
 * Variable names and labels that describe clinical content. Matched against
 * camelCase tokens of the key and the words of the human label, so `shipTo`
 * or `officeName` never trip it while `medicationName` or `latestWeight` do.
 */
const CLINICAL_TOKENS = new Set([
  "weight", "weights", "bmi", "medication", "medications", "med", "meds", "dose", "doses", "dosage", "injection",
  "lab", "labs", "bloodwork", "a1c", "glucose", "diagnosis", "diagnoses", "condition", "conditions",
  "photo", "photos", "measurement", "measurements", "symptom", "symptoms", "allergy", "allergies", "vitals",
]);
const FULL_NAME_TOKEN_SEQUENCES = [["full", "name"], ["patient", "name"], ["legal", "name"]];

function tokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hasSequence(words: string[], sequence: string[]): boolean {
  return words.some((_, index) => sequence.every((word, offset) => words[index + offset] === word));
}

export function isClinicalVariable(key: string, label = ""): boolean {
  return [...tokens(key), ...tokens(label)].some((token) => CLINICAL_TOKENS.has(token));
}

export function isFullNameVariable(key: string, label = ""): boolean {
  const keyTokens = tokens(key);
  const labelTokens = tokens(label);
  return FULL_NAME_TOKEN_SEQUENCES.some((sequence) => hasSequence(keyTokens, sequence) || hasSequence(labelTokens, sequence));
}

export interface EmailTemplateLintViolation {
  templateId: EmailTemplateId;
  variable: string;
  rule: "clinical_variable" | "full_name_outside_identity" | "missing_phi_class";
}

/**
 * Lints one template's variables against its PHI class. `variables` is the
 * catalog's `variableLabels` for the template (key → human label). Runtime
 * callers may pass the keys of the variables they are about to send.
 */
export function lintEmailTemplateVariables(
  templateId: EmailTemplateId,
  variables: Record<string, string>,
  options: { labels?: boolean } = {},
): EmailTemplateLintViolation[] {
  const violations: EmailTemplateLintViolation[] = [];
  if (!(templateId in EMAIL_TEMPLATE_PHI_CLASS)) violations.push({ templateId, variable: "*", rule: "missing_phi_class" });
  for (const [key, value] of Object.entries(variables)) {
    const label = options.labels ? value : "";
    if (isClinicalVariable(key, label)) violations.push({ templateId, variable: key, rule: "clinical_variable" });
    else if (isFullNameVariable(key, label) && !FULL_NAME_EMAIL_TEMPLATE_IDS.has(templateId)) {
      violations.push({ templateId, variable: key, rule: "full_name_outside_identity" });
    }
  }
  return violations;
}

/** Lints the whole catalog: every template must have a class and clean variables. */
export function lintEmailTemplateCatalog(catalog: readonly EmailTemplateDefinition[]): EmailTemplateLintViolation[] {
  return catalog.flatMap((definition) => [
    ...lintEmailTemplateVariables(definition.id, definition.variableLabels, { labels: true }),
    ...Object.keys(definition.sampleVariables)
      .filter((key) => !(key in definition.variableLabels))
      .flatMap((key) => lintEmailTemplateVariables(definition.id, { [key]: "" })),
  ]);
}

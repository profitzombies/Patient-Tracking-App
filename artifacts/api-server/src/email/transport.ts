/**
 * The one seam every outbound email passes through.
 *
 * Email leaves through a vendor that has not signed a BAA, so this module is
 * where the PHI rule is enforced rather than trusted: each template carries a
 * PHI class from the templates library, the variables about to be rendered
 * are linted against that class (no clinical variables anywhere, no full
 * patient name outside the claim/invitation family), the templates library
 * stays the only renderer, and exactly one vendor client performs the HTTP
 * call. Swapping the vendor is a change to `createResendEmailClient` only.
 *
 * Every send, sent or not, writes one structured log line that never
 * includes the recipient address or the rendered content.
 */
import crypto from "node:crypto";
import {
  EMAIL_TEMPLATE_PHI_CLASS,
  lintEmailTemplateVariables,
  renderEmailTemplate,
  type EmailPhiClass,
  type EmailTemplateId,
  type EmailVariables,
} from "@workspace/email-templates";
import { logger } from "../lib/logger";

export const EMAIL_VENDOR = "resend";
export const RESEND_SEND_URL = "https://api.resend.com/emails";
export const EMAIL_SEND_TIMEOUT_MS = 15_000;
/** Display name for billing and staff mail; sign-in mail keeps the configured sender verbatim. */
export const BRANDED_EMAIL_FROM_NAME = "THINNR Weight Loss";

export type EmailSender = "configured" | "branded";

export interface OutboundEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailClient {
  /** Delivers one message; resolves with the vendor's message id when it reports one. */
  send(message: OutboundEmail): Promise<{ id: string | null }>;
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super("email delivery is not configured");
    this.name = "EmailNotConfiguredError";
  }
}

export class EmailPhiViolationError extends Error {
  constructor(readonly templateId: EmailTemplateId, readonly variables: string[]) {
    super(`email template ${templateId} refused: variables ${variables.join(", ")} are not allowed in email`);
    this.name = "EmailPhiViolationError";
  }
}

export class EmailSendError extends Error {
  constructor(readonly status: number) {
    super(`Resend send failed (${status})`);
    this.name = "EmailSendError";
  }
}

/** "THINNR Weight Loss <address>" from a bare address or one that already carries a display name. */
export function brandedFromAddress(configured: string): string {
  const bracketed = configured.match(/<([^>]+)>/);
  const address = (bracketed ? bracketed[1] : configured).trim();
  return `${BRANDED_EMAIL_FROM_NAME} <${address}>`;
}

export interface EmailConfig {
  apiKey: string;
  from: string;
}

/** Reads the vendor credentials at call time so tests and restarts see the current environment. */
export function emailConfig(): EmailConfig | null {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.CLAIM_EMAIL_FROM;
  if (!apiKey || !from) return null;
  return { apiKey, from };
}

export function isEmailConfigured(): boolean {
  return emailConfig() !== null;
}

/** The single vendor client. `fetch` is resolved per call so test stubs apply. */
export function createResendEmailClient(apiKey: () => string): EmailClient {
  return {
    async send(message) {
      const response = await fetch(RESEND_SEND_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: message.from, to: [message.to], subject: message.subject, html: message.html, text: message.text }),
        signal: AbortSignal.timeout(EMAIL_SEND_TIMEOUT_MS),
      });
      if (!response.ok) throw new EmailSendError(response.status);
      let id: string | null = null;
      try {
        const json = (await response.json()) as { id?: unknown } | null;
        id = json && typeof json.id === "string" ? json.id : null;
      } catch {
        id = null;
      }
      return { id };
    },
  };
}

let client: EmailClient = createResendEmailClient(() => emailConfig()?.apiKey ?? "");

/** Test seam: replace the vendor client. Pass null to restore the real one. */
export function __setEmailClientForTests(next: EmailClient | null): void {
  client = next ?? createResendEmailClient(() => emailConfig()?.apiKey ?? "");
}

export interface SendEmailInput {
  to: string;
  templateId: EmailTemplateId;
  variables: EmailVariables;
  /** Which From identity to use; defaults to the branded name. */
  sender?: EmailSender;
  /** Free-form correlation ids for the send log (never PHI). */
  refs?: Record<string, string | null | undefined>;
}

export interface SendEmailResult {
  messageId: string | null;
  phiClass: EmailPhiClass;
  /** The rendered subject line (safe to store: templates keep subjects generic). */
  subject: string;
}

/** Log-safe stand-in for an address: a truncated hash plus the domain, never the mailbox. */
export function recipientDigest(to: string): { recipientHash: string; recipientDomain: string | null } {
  const normalized = to.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  return {
    recipientHash: crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16),
    recipientDomain: at > 0 ? normalized.slice(at + 1) : null,
  };
}

/**
 * Renders `templateId` with `variables` and sends it. Throws
 * EmailNotConfiguredError when credentials are missing, EmailPhiViolationError
 * when the variables break the template's PHI class, and EmailSendError when
 * the vendor rejects the message. Callers decide whether those are fatal.
 */
export async function sendTemplatedEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const phiClass = EMAIL_TEMPLATE_PHI_CLASS[input.templateId];
  const startedAt = Date.now();
  const log = {
    vendor: EMAIL_VENDOR,
    templateId: input.templateId,
    phiClass,
    sender: input.sender ?? "branded",
    ...recipientDigest(input.to),
    ...(input.refs ?? {}),
  };
  const config = emailConfig();
  if (!config) {
    logger.warn({ ...log, outcome: "not_configured" }, "email send");
    throw new EmailNotConfiguredError();
  }
  const violations = lintEmailTemplateVariables(input.templateId, input.variables);
  if (violations.length) {
    const variables = [...new Set(violations.map((violation) => violation.variable))];
    logger.error({ ...log, outcome: "phi_refused", variables }, "email send");
    throw new EmailPhiViolationError(input.templateId, variables);
  }
  const rendered = renderEmailTemplate(input.templateId, input.variables);
  const from = (input.sender ?? "branded") === "configured" ? config.from : brandedFromAddress(config.from);
  try {
    const result = await client.send({ from, to: input.to, subject: rendered.subject, html: rendered.html, text: rendered.text });
    const messageId = result?.id ?? null;
    logger.info({ ...log, outcome: "sent", messageId, durationMs: Date.now() - startedAt }, "email send");
    return { messageId, phiClass, subject: rendered.subject };
  } catch (error) {
    logger.error(
      { ...log, outcome: "failed", durationMs: Date.now() - startedAt, status: error instanceof EmailSendError ? error.status : null, err: error },
      "email send",
    );
    throw error;
  }
}

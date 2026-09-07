export const EMAIL_TEMPLATE_IDS = [
  "verification-code",
  "provider-account-ready",
  "hq-team-invitation",
  "provider-staff-invitation",
  "patient-invitation",
  "new-sign-in-alert",
  "password-changed",
] as const;

export type EmailTemplateId = (typeof EMAIL_TEMPLATE_IDS)[number];
export type EmailVariables = Record<string, string>;

export interface EmailTemplateDefinition {
  id: EmailTemplateId;
  name: string;
  purpose: string;
  trigger: string;
  audience: string;
  sampleVariables: EmailVariables;
  variableLabels: Record<string, string>;
}

export interface RenderedEmail {
  subject: string;
  previewText: string;
  html: string;
  text: string;
}

export const EMAIL_TEMPLATE_CATALOG: readonly EmailTemplateDefinition[] = [
  {
    id: "verification-code",
    name: "Verification code",
    purpose: "Proves control of an email address for passwordless sign-in or account verification.",
    trigger: "A person requests a one-time code from a THINNR sign-in or verification flow.",
    audience: "Patients, provider staff, providers, and HQ team members using email.",
    sampleVariables: { code: "482917" },
    variableLabels: { code: "One-time code" },
  },
  {
    id: "provider-account-ready",
    name: "Provider account ready",
    purpose: "Welcomes a newly created provider and supplies the office’s patient onboarding code.",
    trigger: "An HQ administrator successfully creates a new provider account.",
    audience: "The provider who owns the new office account.",
    sampleVariables: {
      providerName: "Avery Example",
      officeName: "Example Wellness Studio",
      providerCode: "731942",
    },
    variableLabels: {
      providerName: "Provider name",
      officeName: "Office name",
      providerCode: "Patient onboarding code",
    },
  },
  {
    id: "hq-team-invitation",
    name: "HQ team invitation",
    purpose: "Introduces a new HQ teammate to their role and passwordless sign-in.",
    trigger: "An authorized HQ administrator commits a new team invitation.",
    audience: "A newly invited THINNR HQ team member.",
    sampleVariables: { name: "Jordan Fiction", role: "Content Specialist" },
    variableLabels: { name: "Invitee name", role: "HQ role" },
  },
  {
    id: "provider-staff-invitation",
    name: "Provider staff invitation",
    purpose: "Lets an office teammate know their THINNR operations access is ready.",
    trigger: "An HQ administrator successfully provisions a provider staff sign-in.",
    audience: "A newly added staff member at a provider office.",
    sampleVariables: { name: "Morgan Sample", officeName: "Example Wellness Studio" },
    variableLabels: { name: "Staff name", officeName: "Office name" },
  },
  {
    id: "patient-invitation",
    name: "Patient invitation",
    purpose: "Invites a patient to join THINNR under their provider’s office and explains how to sign in with the invited phone number.",
    trigger: "Office staff — or an HQ administrator working inside that office — invites a patient from the patient roster.",
    audience: "A patient invited by a provider office.",
    sampleVariables: {
      name: "Riley",
      providerName: "Avery Example",
      officeName: "Example Wellness Studio",
      providerCode: "731942",
      phone: "(555) 014-2890",
      appLink: "https://example.test/thinnr-app",
    },
    variableLabels: {
      name: "Patient first name",
      providerName: "Provider name",
      officeName: "Office name",
      providerCode: "Provider code",
      phone: "Invited phone number",
      appLink: "App link",
    },
  },
  {
    id: "new-sign-in-alert",
    name: "New sign-in alert",
    purpose: "Tells an account holder that their account was just signed in to from a device or platform it had not been seen on before, and offers a one-tap way to lock it down.",
    trigger: "A successful sign-in whose device fingerprint has never been seen on that account (patients without a push-capable device, and all staff).",
    audience: "Patients and staff whose account just signed in somewhere new.",
    sampleVariables: {
      name: "Riley",
      device: "Chrome on Windows",
      region: "Austin, Texas, US",
      when: "Monday, September 7 at 4:12 PM",
      method: "Password + texted code",
      reportLink: "https://example.test/security/report?token=sample",
    },
    variableLabels: {
      name: "Recipient first name",
      device: "Device description",
      region: "Approximate location",
      when: "Sign-in time",
      method: "Sign-in method",
      reportLink: "\u201cThis wasn\u2019t me\u201d link",
    },
  },
  {
    id: "password-changed",
    name: "Password changed",
    purpose: "Confirms that the account password was changed and that every other device was signed out.",
    trigger: "A signed-in patient completes the change-password flow, or a password recovery completes.",
    audience: "The patient whose password changed.",
    sampleVariables: {
      name: "Riley",
      when: "Monday, September 7 at 4:20 PM",
      reportLink: "https://example.test/security/report?token=sample",
    },
    variableLabels: {
      name: "Recipient first name",
      when: "Change time",
      reportLink: "\u201cThis wasn\u2019t me\u201d link",
    },
  },
] as const;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function requireVariable(variables: EmailVariables, key: string): string {
  const value = variables[key]?.trim();
  if (!value) throw new Error(`Missing email template variable: ${key}`);
  return value;
}

function shell(input: {
  previewText: string;
  eyebrow: string;
  heading: string;
  greeting?: string;
  bodyHtml: string;
  closing: string;
}): string {
  const preview = escapeHtml(input.previewText);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>${escapeHtml(input.heading)}</title>
  <style>
    @media only screen and (max-width: 620px) {
      .email-shell { width: 100% !important; }
      .email-pad { padding-left: 24px !important; padding-right: 24px !important; }
      .email-heading { font-size: 30px !important; }
      .email-code { font-size: 34px !important; letter-spacing: 7px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f2f3f4;color:#26364b;font-family:Arial,Helvetica,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preview}&#847; &#847; &#847; &#847; &#847;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f2f3f4;">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" class="email-shell" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#fdfcf9;border:1px solid #d8e0e9;border-radius:12px;overflow:hidden;">
          <tr>
            <td class="email-pad" style="padding:24px 40px;background:#203b64;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:bold;letter-spacing:1px;color:#ffffff;">THINNR</td>
                  <td align="right" style="font-size:11px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:#dce6fa;">Care, made clearer</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="email-pad" style="padding:42px 40px 36px;">
              <p style="margin:0 0 12px;font-size:11px;font-weight:bold;letter-spacing:1.6px;text-transform:uppercase;color:#315eae;">${escapeHtml(input.eyebrow)}</p>
              <h1 class="email-heading" style="margin:0 0 22px;font-family:Georgia,'Times New Roman',serif;font-size:36px;line-height:1.15;color:#203b64;">${escapeHtml(input.heading)}</h1>
              ${input.greeting ? `<p style="margin:0 0 18px;font-size:16px;line-height:1.65;color:#26364b;">Hello ${escapeHtml(input.greeting)},</p>` : ""}
              ${input.bodyHtml}
              <p style="margin:28px 0 0;padding-top:22px;border-top:1px solid #d8e0e9;font-size:13px;line-height:1.6;color:#687684;">${escapeHtml(input.closing)}</p>
            </td>
          </tr>
          <tr>
            <td class="email-pad" style="padding:20px 40px;background:#f5f7f9;font-size:12px;line-height:1.55;color:#687684;">
              THINNR &nbsp;·&nbsp; Thoughtful tools for modern wellness care
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

const paragraph = (value: string) =>
  `<p style="margin:0 0 18px;font-size:16px;line-height:1.65;color:#26364b;">${value}</p>`;

const infoPanel = (label: string, value: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;width:100%;background:#e3ecf7;border:1px solid #b7cbe8;border-radius:9px;">
    <tr><td style="padding:20px 22px;">
      <p style="margin:0 0 7px;font-size:10px;font-weight:bold;letter-spacing:1.4px;text-transform:uppercase;color:#315eae;">${escapeHtml(label)}</p>
      <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:25px;font-weight:bold;line-height:1.2;color:#203b64;">${escapeHtml(value)}</p>
    </td></tr>
  </table>`;

export function renderEmailTemplate(
  id: EmailTemplateId,
  variables: EmailVariables,
): RenderedEmail {
  if (id === "verification-code") {
    const code = requireVariable(variables, "code");
    const subject = `${code} is your THINNR verification code`;
    const previewText = "Use this one-time code to continue. It expires in 10 minutes.";
    const text = [
      `Your THINNR verification code is ${code}.`,
      "",
      "This one-time code expires in 10 minutes.",
      "For your security, never share this code with anyone. THINNR will never ask you for it by phone, text, or email.",
      "",
      "If you did not request this code, you can safely ignore this email.",
    ].join("\n");
    return {
      subject,
      previewText,
      text,
      html: shell({
        previewText,
        eyebrow: "Secure sign-in",
        heading: "Your verification code",
        bodyHtml: `${paragraph("Enter this one-time code to continue securely:")}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;width:100%;background:#e3ecf7;border:1px solid #b7cbe8;border-radius:9px;">
            <tr><td align="center" style="padding:25px 16px;">
              <p class="email-code" style="margin:0;font-family:'Courier New',Courier,monospace;font-size:40px;font-weight:bold;letter-spacing:9px;color:#203b64;">${escapeHtml(code)}</p>
              <p style="margin:12px 0 0;font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:1px;color:#315eae;">Expires in 10 minutes</p>
            </td></tr>
          </table>
          ${paragraph("<strong>Keep this code private.</strong> THINNR will never ask you to share it by phone, text, or email.")}`,
        closing: "If you did not request this code, you can safely ignore this email.",
      }),
    };
  }

  if (id === "provider-account-ready") {
    const providerName = requireVariable(variables, "providerName");
    const officeName = requireVariable(variables, "officeName");
    const providerCode = requireVariable(variables, "providerCode");
    const subject = `Your ${officeName} THINNR account is ready`;
    const previewText = `Welcome to THINNR. Your account and patient onboarding code are ready.`;
    const text = [
      `Hello ${providerName},`,
      "",
      `${officeName} is now set up in THINNR.`,
      `Patient onboarding code: ${providerCode}`,
      "",
      "To sign in, open THINNR operations and enter this email address. We will send you a one-time sign-in code, so no password is needed.",
      "",
      "Share the patient onboarding code only with patients joining your office.",
      "If you did not expect this account, contact THINNR support.",
    ].join("\n");
    return {
      subject,
      previewText,
      text,
      html: shell({
        previewText,
        eyebrow: "Provider access",
        heading: "Your provider account is ready",
        greeting: providerName,
        bodyHtml: `${paragraph(`<strong>${escapeHtml(officeName)}</strong> is now set up in THINNR.`)}
          ${infoPanel("Patient onboarding code", providerCode)}
          ${paragraph("To sign in, open THINNR operations and enter this email address. We’ll send a one-time sign-in code, so there’s no password to remember.")}
          ${paragraph("Share the patient onboarding code only with patients joining your office.")}`,
        closing: "If you did not expect this account, contact THINNR support.",
      }),
    };
  }

  if (id === "hq-team-invitation") {
    const name = requireVariable(variables, "name");
    const role = requireVariable(variables, "role");
    const subject = "You’re invited to join the THINNR HQ team";
    const previewText = `Your THINNR HQ invitation is ready. You’ll join as ${role}.`;
    const text = [
      `Hello ${name},`,
      "",
      `You have been invited to the THINNR HQ team as ${role}.`,
      "To sign in, open THINNR operations and enter this email address. We will send you a one-time sign-in code, so no password is needed.",
      "",
      "This invitation expires in 7 days.",
      "If you did not expect this invitation, contact THINNR support.",
    ].join("\n");
    return {
      subject,
      previewText,
      text,
      html: shell({
        previewText,
        eyebrow: "HQ invitation",
        heading: "Join the THINNR HQ team",
        greeting: name,
        bodyHtml: `${paragraph(`You’ve been invited to join the THINNR HQ team as <strong>${escapeHtml(role)}</strong>.`)}
          ${infoPanel("Your role", role)}
          ${paragraph("Open THINNR operations and enter this email address to sign in. We’ll send a one-time code, so there’s no password to create.")}
          ${paragraph("<strong>This invitation expires in 7 days.</strong>")}`,
        closing: "If you did not expect this invitation, contact THINNR support.",
      }),
    };
  }

  if (id === "patient-invitation") {
    const name = requireVariable(variables, "name");
    const providerName = requireVariable(variables, "providerName");
    const officeName = requireVariable(variables, "officeName");
    const providerCode = requireVariable(variables, "providerCode");
    const phone = requireVariable(variables, "phone");
    const appLink = requireVariable(variables, "appLink");
    const subject = `${providerName} invited you to THINNR`;
    const previewText = `${officeName} set up your THINNR access. Sign in with your phone number to begin.`;
    const text = [
      `Hello ${name},`,
      "",
      `${providerName} at ${officeName} invited you to THINNR, the companion app for your program.`,
      "",
      `Get the THINNR app: ${appLink}`,
      `Sign in with your phone number ${phone}. We will text a one-time verification code to that number, so there is no password to create.`,
      "",
      `Provider code: ${providerCode}`,
      `Signing in with the phone number above connects you to ${officeName} automatically, so you should not need to enter the code. Keep it handy in case you are ever asked for it.`,
      "",
      "If you were not expecting this invitation, you can safely ignore this email.",
    ].join("\n");
    return {
      subject,
      previewText,
      text,
      html: shell({
        previewText,
        eyebrow: "Patient invitation",
        heading: `${providerName} invited you to THINNR`,
        greeting: name,
        bodyHtml: `${paragraph(`<strong>${escapeHtml(providerName)}</strong> at <strong>${escapeHtml(officeName)}</strong> invited you to THINNR, the companion app for your program.`)}
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
            <tr><td style="background:#315eae;border-radius:9px;">
              <a href="${escapeHtml(appLink)}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;">Open the THINNR app</a>
            </td></tr>
          </table>
          ${infoPanel("Sign in with this phone number", phone)}
          ${paragraph("Enter the phone number above when you sign in. We’ll text a one-time verification code to that number, so there’s no password to create.")}
          ${infoPanel("Provider code", providerCode)}
          ${paragraph(`Signing in with your invited phone number connects you to <strong>${escapeHtml(officeName)}</strong> automatically, so you shouldn’t need to enter the provider code. Keep it handy in case you’re ever asked for it.`)}`,
        closing: "If you were not expecting this invitation, you can safely ignore this email.",
      }),
    };
  }

  if (id === "new-sign-in-alert") {
    const name = requireVariable(variables, "name");
    const device = requireVariable(variables, "device");
    const region = variables.region?.trim() || "Location unavailable";
    const when = requireVariable(variables, "when");
    const method = requireVariable(variables, "method");
    const reportLink = requireVariable(variables, "reportLink");
    const subject = "New sign-in to your THINNR account";
    const previewText = `Your account was just signed in to from ${device}. If that wasn\u2019t you, lock it down now.`;
    const text = [
      `Hello ${name},`,
      "",
      "Your THINNR account was just signed in to from a device we had not seen before.",
      `Device: ${device}`,
      `Approximate location: ${region}`,
      `When: ${when}`,
      `Sign-in method: ${method}`,
      "",
      "If this was you, there is nothing to do.",
      `If this wasn't you, open this link to sign out every device right away: ${reportLink}`,
      "Patients will then be asked to choose a new password the next time they sign in.",
      "",
      "This link works for 7 days and can only be used once. THINNR will never ask you for your password or codes by email.",
    ].join("\n");
    return {
      subject,
      previewText,
      text,
      html: shell({
        previewText,
        eyebrow: "Account security",
        heading: "New sign-in to your account",
        greeting: name,
        bodyHtml: `${paragraph("Your THINNR account was just signed in to from a device we had not seen before.")}
          ${infoPanel("Device", device)}
          ${paragraph(`<strong>Approximate location:</strong> ${escapeHtml(region)}<br><strong>When:</strong> ${escapeHtml(when)}<br><strong>Sign-in method:</strong> ${escapeHtml(method)}`)}
          ${paragraph("If this was you, there\u2019s nothing to do.")}
          ${paragraph("<strong>If this wasn\u2019t you</strong>, sign out every device right away. Patients will then be asked to choose a new password the next time they sign in.")}
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
            <tr><td style="background:#a33a2e;border-radius:9px;">
              <a href="${escapeHtml(reportLink)}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;">This wasn\u2019t me \u2014 sign out everywhere</a>
            </td></tr>
          </table>`,
        closing: "This link works for 7 days and can only be used once. THINNR will never ask you for your password or codes by email.",
      }),
    };
  }

  if (id === "password-changed") {
    const name = requireVariable(variables, "name");
    const when = requireVariable(variables, "when");
    const reportLink = requireVariable(variables, "reportLink");
    const subject = "Your THINNR password was changed";
    const previewText = "Your password was changed and other devices were signed out.";
    const text = [
      `Hello ${name},`,
      "",
      `Your THINNR password was changed on ${when}. Every other device was signed out.`,
      "",
      "If this was you, there is nothing to do.",
      `If this wasn't you, open this link to sign out every device right away: ${reportLink}`,
      "You will then be asked to choose a new password the next time you sign in.",
      "",
      "This link works for 7 days and can only be used once. THINNR will never ask you for your password or codes by email.",
    ].join("\n");
    return {
      subject,
      previewText,
      text,
      html: shell({
        previewText,
        eyebrow: "Account security",
        heading: "Your password was changed",
        greeting: name,
        bodyHtml: `${paragraph(`Your THINNR password was changed on <strong>${escapeHtml(when)}</strong>. Every other device was signed out.`)}
          ${paragraph("If this was you, there\u2019s nothing to do.")}
          ${paragraph("<strong>If this wasn\u2019t you</strong>, sign out every device right away. You\u2019ll then be asked to choose a new password the next time you sign in.")}
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
            <tr><td style="background:#a33a2e;border-radius:9px;">
              <a href="${escapeHtml(reportLink)}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;">This wasn\u2019t me \u2014 sign out everywhere</a>
            </td></tr>
          </table>`,
        closing: "This link works for 7 days and can only be used once. THINNR will never ask you for your password or codes by email.",
      }),
    };
  }

  const name = requireVariable(variables, "name");
  const officeName = requireVariable(variables, "officeName");
  const subject = `Your ${officeName} THINNR sign-in is ready`;
  const previewText = `You now have access to ${officeName} in THINNR operations.`;
  const text = [
    `Hello ${name},`,
    "",
    `You now have access to ${officeName} in THINNR.`,
    "To sign in, open THINNR operations and enter this email address. We will send you a one-time sign-in code, so no password is needed.",
    "",
    "If you did not expect this invitation, contact THINNR support.",
  ].join("\n");
  return {
    subject,
    previewText,
    text,
    html: shell({
      previewText,
      eyebrow: "Office access",
      heading: "Your office sign-in is ready",
      greeting: name,
      bodyHtml: `${paragraph(`You now have access to <strong>${escapeHtml(officeName)}</strong> in THINNR.`)}
        ${infoPanel("Office", officeName)}
        ${paragraph("Open THINNR operations and enter this email address to sign in. We’ll send a one-time code, so there’s no password to create.")}`,
      closing: "If you did not expect this invitation, contact THINNR support.",
    }),
  };
}

export function renderSampleEmail(id: EmailTemplateId): RenderedEmail {
  const definition = EMAIL_TEMPLATE_CATALOG.find((item) => item.id === id);
  if (!definition) throw new Error(`Unknown email template: ${id}`);
  return renderEmailTemplate(id, definition.sampleVariables);
}
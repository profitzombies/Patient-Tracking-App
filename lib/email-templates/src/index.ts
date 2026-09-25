import { button, escapeHtml, infoPanel, paragraph, parseLineItems, requireVariable, shell } from "./shell";
import { SHOP_EMAIL_TEMPLATE_CATALOG, SHOP_EMAIL_TEMPLATE_IDS, renderShopEmail } from "./shop";

export {
  EMAIL_TEMPLATE_PHI_CLASS,
  FULL_NAME_EMAIL_TEMPLATE_IDS,
  isClinicalVariable,
  isFullNameVariable,
  lintEmailTemplateCatalog,
  lintEmailTemplateVariables,
  type EmailPhiClass,
  type EmailTemplateLintViolation,
} from "./phi";

/** Store pages for Expo Go, the app patients open THINNR in during the Expo Go test run. */
export const EXPO_GO_APP_STORE_URL = "https://apps.apple.com/app/id982107779";
export const EXPO_GO_PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=host.exp.exponent";

export const EMAIL_TEMPLATE_IDS = [
  "verification-code",
  "provider-account-ready",
  "hq-team-invitation",
  "provider-staff-invitation",
  "patient-invitation",
  "new-sign-in-alert",
  "password-changed",
  "order-receipt",
  "order-shipped",
  "subscription-payment-failed",
  "subscription-cancelled",
  "staff-attention-digest",
  "system-threshold-alert",
  "office-access-restricted",
  ...SHOP_EMAIL_TEMPLATE_IDS,
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
      signInUrl: "https://operations.example.com/",
    },
    variableLabels: {
      providerName: "Provider name",
      officeName: "Office name",
      providerCode: "Patient onboarding code",
      signInUrl: "Operations sign-in link",
    },
  },
  {
    id: "hq-team-invitation",
    name: "HQ team invitation",
    purpose: "Introduces a new HQ teammate to their role and passwordless sign-in.",
    trigger: "An authorized HQ administrator commits a new team invitation.",
    audience: "A newly invited THINNR HQ team member.",
    sampleVariables: {
      name: "Jordan Fiction",
      role: "Content Specialist",
      setupUrl: "https://operations.example.com/hq-setup?token=sample-token",
      expiresLabel: "Friday, September 25, 2026 at 4:00 PM UTC",
    },
    variableLabels: {
      name: "Invitee name",
      role: "HQ role",
      setupUrl: "Account setup link",
      expiresLabel: "Invitation expiry",
    },
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
    purpose: "Invites a patient to join THINNR under their provider’s office and walks them through first-time setup: install Expo Go, open the app link, choose Create New Account → I have an invitation, verify the invited phone or email, and create a password.",
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
  {
    id: "order-receipt",
    name: "Order receipt",
    purpose: "Confirms a paid order with an itemized breakdown, the shipping address, and, for subscriptions, how to stop future renewals.",
    trigger: "Stripe confirms payment for a one-time order or a subscription charge.",
    audience: "The patient who paid.",
    sampleVariables: {
      name: "Riley",
      orderNumber: "TH-7K2Q9M",
      placedAt: "Sep 14, 2026, 3:24 PM ET",
      officeName: "Example Wellness Studio",
      items: "Control × 2 · $119.98\nBalance · $59.99",
      subtotal: "$179.97",
      shipping: "$9.00",
      tax: "$0.00",
      total: "$188.97",
      shipTo: "Riley Example, 12 Harbor Lane, Austin, TX 78701, US",
      renewalNote: "This order renews every 4 weeks.",
      cancelLink: "https://example.test/pay/cancel/sample",
      contactEmail: "care@example.test",
    },
    variableLabels: {
      name: "Payer first name",
      orderNumber: "Order number",
      placedAt: "Payment date and time",
      officeName: "Office name",
      items: "Line items (one per line: name · amount)",
      subtotal: "Subtotal",
      shipping: "Shipping",
      tax: "Tax",
      total: "Total charged",
      shipTo: "Shipping address",
      renewalNote: "Renewal note (subscriptions only)",
      cancelLink: "Cancellation link (subscriptions only)",
      contactEmail: "Office contact email (optional)",
    },
  },
  {
    id: "order-shipped",
    name: "Order shipped",
    purpose: "Tells the patient their order is on the way and gives them the carrier and tracking number.",
    trigger: "Office staff or HQ mark an order as shipped.",
    audience: "The patient who paid.",
    sampleVariables: {
      name: "Riley",
      orderNumber: "TH-7K2Q9M",
      officeName: "Example Wellness Studio",
      carrier: "USPS",
      trackingNumber: "9400 1000 0000 0000 0000 00",
      trackingLink: "https://example.test/track/sample",
    },
    variableLabels: {
      name: "Payer first name",
      orderNumber: "Order number",
      officeName: "Office name",
      carrier: "Carrier",
      trackingNumber: "Tracking number",
      trackingLink: "Tracking link (optional)",
    },
  },
  {
    id: "subscription-payment-failed",
    name: "Subscription payment failed",
    purpose: "Gives a patient a secure Stripe link to pay a failed subscription renewal.",
    trigger: "Stripe reports that a subscription invoice payment failed.",
    audience: "The patient who owns the subscription.",
    sampleVariables: {
      name: "Riley",
      officeName: "Example Wellness Studio",
      productName: "Control",
      amount: "$69.99",
      paymentLink: "https://invoice.stripe.com/i/sample",
      cancelLink: "https://example.test/pay/cancel/sample",
    },
    variableLabels: {
      name: "Payer first name",
      officeName: "Office name",
      productName: "Product name",
      amount: "Invoice amount",
      paymentLink: "Stripe hosted invoice link",
      cancelLink: "Cancellation link",
    },
  },
  {
    id: "subscription-cancelled",
    name: "Subscription cancellation confirmed",
    purpose: "Confirms that a recurring order will stop after the current period.",
    trigger: "A patient uses the cancellation link from their receipt, or staff cancel on their behalf.",
    audience: "The patient who owns the subscription.",
    sampleVariables: {
      name: "Riley",
      productName: "Control",
      officeName: "Example Wellness Studio",
    },
    variableLabels: {
      name: "Payer first name",
      productName: "Product name",
      officeName: "Office name",
    },
  },
  {
    id: "staff-attention-digest",
    name: "Daily patient attention digest",
    purpose: "Tells office staff how many patients need follow-up today, grouped by reason, and links to the Needs attention page where the names live.",
    trigger: "The daily staff attention digest job finds at least one flagged patient for an office with alert recipients.",
    audience: "Office alert recipients (the owner and any teammates the office selected). Never names a patient: the email leaves through a vendor without a BAA.",
    sampleVariables: {
      name: "Sarah",
      officeName: "Example Wellness Studio",
      digestDate: "Tuesday, September 15, 2026",
      flaggedCount: "3",
      reasons: "No meals logged · 1 patient\nCheck-in overdue · 1 patient\nNo weight logged · 1 patient",
      alertsLink: "https://operations.example.com/alerts",
      settingsLink: "https://operations.example.com/settings",
    },
    variableLabels: {
      name: "Recipient first name",
      officeName: "Office name",
      digestDate: "Digest date",
      flaggedCount: "Number of flagged patients",
      reasons: "Counts per reason, one per line as “Reason · N patients”",
      alertsLink: "Needs attention page link",
      settingsLink: "Alert settings link",
    },
  },
  {
    id: "system-threshold-alert",
    name: "System health threshold alert",
    purpose: "Tells HQ administrators that a System health limit (request speed, database growth, or storage growth) was crossed and links to the page.",
    trigger: "The system-thresholds job finds a route family’s p95 latency, the database’s daily growth, or object storage’s daily growth above an amber or red limit.",
    audience: "Active HQ administrators (super admin and admin roles).",
    sampleVariables: {
      name: "Jordan",
      level: "amber",
      metricLabel: "Slow route hq/system-health",
      finding: "hq/system-health: p95 1840 ms over the last hour (63 requests) is above the 1500 ms amber limit.",
      observed: "p95 1,840 ms",
      limit: "1,500 ms",
      day: "Friday, September 18, 2026",
      healthLink: "https://operations.example.com/admin/system-health",
    },
    variableLabels: {
      name: "Recipient first name",
      level: "Level (amber or red)",
      metricLabel: "Short metric name",
      finding: "One-sentence finding",
      observed: "Observed value",
      limit: "Limit crossed",
      day: "Day of the finding",
      healthLink: "System health page link",
    },
  },
  {
    id: "office-access-restricted",
    name: "Office access restricted",
    purpose: "Tells HQ that an office's access subscription reached the end of its recovery window and the office is now restricted.",
    trigger: "The office access billing job restricts an office because the grace window elapsed with nothing collected.",
    audience: "Active HQ administrators (super admin and admin roles).",
    sampleVariables: {
      name: "Jordan",
      officeName: "Lakeside Wellness",
      restrictedOn: "Friday, September 18, 2026",
      amountDue: "$200.00",
      billingLink: "https://operations.example.com/admin/payments/office-access",
    },
    variableLabels: {
      name: "Recipient first name",
      officeName: "Office name",
      restrictedOn: "Day the office was restricted",
      amountDue: "Amount the office owes for the period",
      billingLink: "Office access board link",
    },
  },
  ...SHOP_EMAIL_TEMPLATE_CATALOG,
] as const;


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
    const signInUrl = requireVariable(variables, "signInUrl");
    const subject = `Your ${officeName} THINNR account is ready`;
    const previewText = `Welcome to THINNR. Your account and patient onboarding code are ready.`;
    const text = [
      `Hello ${providerName},`,
      "",
      `${officeName} is now set up in THINNR.`,
      `Patient onboarding code: ${providerCode}`,
      "",
      `Sign in to THINNR: ${signInUrl}`,
      "Enter this email address on the sign-in page. We will send you a one-time sign-in code, so no password is needed.",
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
          ${button(signInUrl, "Sign in to THINNR")}
          ${paragraph(`If the button doesn’t work, copy this link into your browser:<br><a href="${escapeHtml(signInUrl)}" style="color:#315eae;word-break:break-all;">${escapeHtml(signInUrl)}</a>`)}
          ${paragraph("Share the patient onboarding code only with patients joining your office.")}`,
        closing: "If you did not expect this account, contact THINNR support.",
      }),
    };
  }

  if (id === "hq-team-invitation") {
    const name = requireVariable(variables, "name");
    const role = requireVariable(variables, "role");
    const setupUrl = requireVariable(variables, "setupUrl");
    const expiresLabel = requireVariable(variables, "expiresLabel");
    const subject = "You’re invited to join the THINNR HQ team";
    const previewText = `Your THINNR HQ invitation is ready. You’ll join as ${role}.`;
    const text = [
      `Hello ${name},`,
      "",
      `You have been invited to the THINNR HQ team as ${role}.`,
      "Set up your THINNR account here:",
      setupUrl,
      "",
      "The page confirms who you are and emails you a one-time sign-in code, so there is no password to create.",
      `This link expires on ${expiresLabel}.`,
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
          ${button(setupUrl, "Set up your THINNR account")}
          ${paragraph("The page confirms who you are and emails you a one-time sign-in code, so there’s no password to create.")}
          ${paragraph(`If the button doesn’t work, copy this link into your browser:<br><a href="${escapeHtml(setupUrl)}" style="color:#315eae;word-break:break-all;">${escapeHtml(setupUrl)}</a>`)}
          ${paragraph(`<strong>This link expires on ${escapeHtml(expiresLabel)}.</strong>`)}`,
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
    const previewText = `${officeName} set up your THINNR access. Install Expo Go, open the app, and choose Create New Account to begin.`;
    const text = [
      `Hello ${name},`,
      "",
      `${providerName} at ${officeName} invited you to THINNR, the companion app for your program. Setting up takes a few minutes on your phone.`,
      "",
      "1. Install the free Expo Go app on your phone.",
      `   iPhone: ${EXPO_GO_APP_STORE_URL}`,
      `   Android: ${EXPO_GO_PLAY_STORE_URL}`,
      `2. On your phone, open this link and tap “Open in Expo Go”: ${appLink}`,
      "   On a computer, the same page shows a QR code to scan with your phone’s camera.",
      "3. In THINNR, tap “Create New Account”, then “I have an invitation”. Do not tap “Log In”: you do not have a password yet.",
      `4. Enter your invited phone number, ${phone}, or the email address this message was sent to.`,
      "5. Enter the 6-digit code we send you.",
      "6. Create your password, then finish the short welcome steps.",
      "",
      `Provider code: ${providerCode}`,
      `Your invitation connects you to ${officeName} automatically, so you should not need to enter the code. Keep it handy in case you are ever asked for it.`,
      "",
      "If you were not expecting this invitation, you can safely ignore this email.",
    ].join("\n");
    const step = (index: number, html: string) =>
      `<tr><td valign="top" style="padding:0 12px 14px 0;font-family:Georgia,'Times New Roman',serif;font-size:18px;font-weight:bold;line-height:1.4;color:#315eae;">${index}</td><td valign="top" style="padding:0 0 14px;font-size:16px;line-height:1.6;color:#26364b;">${html}</td></tr>`;
    const storeLink = (href: string, label: string) =>
      `<a href="${escapeHtml(href)}" style="color:#315eae;font-weight:bold;">${label}</a>`;
    return {
      subject,
      previewText,
      text,
      html: shell({
        previewText,
        eyebrow: "Patient invitation",
        heading: `${providerName} invited you to THINNR`,
        greeting: name,
        bodyHtml: `${paragraph(`<strong>${escapeHtml(providerName)}</strong> at <strong>${escapeHtml(officeName)}</strong> invited you to THINNR, the companion app for your program. Setting up takes a few minutes on your phone.`)}
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 10px;">
            ${step(1, `Install the free <strong>Expo Go</strong> app: ${storeLink(EXPO_GO_APP_STORE_URL, "App Store (iPhone)")} or ${storeLink(EXPO_GO_PLAY_STORE_URL, "Google Play (Android)")}.`)}
            ${step(2, "On your phone, tap the button below, then tap <strong>Open in Expo Go</strong>. On a computer, the same page shows a QR code to scan with your phone’s camera.")}
            ${step(3, "In THINNR, tap <strong>Create New Account</strong>, then <strong>I have an invitation</strong>. Don’t tap Log In: you don’t have a password yet.")}
            ${step(4, "Enter your invited phone number (below) or the email address this message was sent to.")}
            ${step(5, "Enter the 6-digit code we send you.")}
            ${step(6, "Create your password, then finish the short welcome steps.")}
          </table>
          ${button(appLink, "Open the THINNR app")}
          ${paragraph(`If the button doesn’t work, open this link on your phone:<br><a href="${escapeHtml(appLink)}" style="color:#315eae;word-break:break-all;">${escapeHtml(appLink)}</a>`)}
          ${infoPanel("Your invited phone number", phone)}
          ${infoPanel("Provider code", providerCode)}
          ${paragraph(`Your invitation connects you to <strong>${escapeHtml(officeName)}</strong> automatically, so you shouldn’t need to enter the provider code. Keep it handy in case you’re ever asked for it.`)}`,
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

  if (id === "order-receipt") return renderOrderReceipt(variables);
  if (id === "subscription-payment-failed") return renderSubscriptionPaymentFailed(variables);
  if (id === "order-shipped") return renderOrderShipped(variables);
  if (id === "subscription-cancelled") return renderSubscriptionCancelled(variables);
  if (id === "staff-attention-digest") return renderStaffAttentionDigest(variables);
  if (id === "system-threshold-alert") return renderSystemThresholdAlert(variables);
  if (id === "office-access-restricted") return renderOfficeAccessRestricted(variables);
  const shop = renderShopEmail(id, variables);
  if (shop) return shop;

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


function renderOrderReceipt(variables: EmailVariables): RenderedEmail {
  const name = variables.name?.trim() || "";
  const orderNumber = requireVariable(variables, "orderNumber");
  const placedAt = requireVariable(variables, "placedAt");
  const officeName = requireVariable(variables, "officeName");
  const items = parseLineItems(requireVariable(variables, "items"));
  const subtotal = requireVariable(variables, "subtotal");
  const shipping = requireVariable(variables, "shipping");
  const tax = requireVariable(variables, "tax");
  const total = requireVariable(variables, "total");
  const shipTo = requireVariable(variables, "shipTo");
  const renewalNote = variables.renewalNote?.trim() || "";
  const cancelLink = variables.cancelLink?.trim() || "";
  const contactEmail = variables.contactEmail?.trim() || "";
  const subject = `RECEIPT THINNR Order (${orderNumber}) - ${placedAt}`;
  const previewText = `Your ${officeName} order ${orderNumber} is confirmed. Total ${total}.`;
  const contactLine = contactEmail
    ? `Questions about this order? Contact ${officeName} at ${contactEmail}.`
    : `Questions about this order? Contact ${officeName}.`;
  const text = [
    ...(name ? [`Hello ${name},`, ""] : []),
    `Thank you for your order from ${officeName}.`,
    `Order number: ${orderNumber}`,
    `Paid: ${placedAt}`,
    "",
    ...items.map((item) => (item.amount ? `${item.label} · ${item.amount}` : item.label)),
    "",
    `Subtotal: ${subtotal}`,
    `Shipping: ${shipping}`,
    `Tax: ${tax}`,
    `Total charged: ${total}`,
    "",
    `Ship to: ${shipTo}`,
    ...(renewalNote ? ["", renewalNote] : []),
    ...(cancelLink ? [`Manage or cancel future renewals: ${cancelLink}`] : []),
    "",
    contactLine,
    "Keep this email for your records.",
  ].join("\n");
  const cell = (inner: string, extra = "") =>
    `<td style="padding:10px 0;font-size:15px;line-height:1.45;color:#26364b;border-bottom:1px solid #e3e8ee;${extra}">${inner}</td>`;
  const totalRow = (label: string, value: string, strong = false) =>
    `<tr>
      <td style="padding:${strong ? "14px" : "6px"} 0 0;font-size:${strong ? "16px" : "14px"};color:${strong ? "#203b64" : "#687684"};${strong ? "font-weight:bold;" : ""}">${escapeHtml(label)}</td>
      <td align="right" style="padding:${strong ? "14px" : "6px"} 0 0;font-size:${strong ? "18px" : "14px"};color:#203b64;${strong ? "font-family:Georgia,'Times New Roman',serif;font-weight:bold;" : ""}">${escapeHtml(value)}</td>
    </tr>`;
  const bodyHtml = `${paragraph(`Thank you for your order from <strong>${escapeHtml(officeName)}</strong>. Here is your receipt.`)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;width:100%;background:#e3ecf7;border:1px solid #b7cbe8;border-radius:9px;">
      <tr>
        <td style="padding:20px 22px;">
          <p style="margin:0 0 7px;font-size:10px;font-weight:bold;letter-spacing:1.4px;text-transform:uppercase;color:#315eae;">Order number</p>
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:25px;font-weight:bold;line-height:1.2;color:#203b64;">${escapeHtml(orderNumber)}</p>
        </td>
        <td align="right" style="padding:20px 22px;vertical-align:top;">
          <p style="margin:0 0 7px;font-size:10px;font-weight:bold;letter-spacing:1.4px;text-transform:uppercase;color:#315eae;">Paid</p>
          <p style="margin:0;font-size:14px;line-height:1.4;color:#203b64;">${escapeHtml(placedAt)}</p>
        </td>
      </tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-top:2px solid #203b64;">
      ${items.map((item) => `<tr>${cell(escapeHtml(item.label))}${cell(escapeHtml(item.amount), "text-align:right;white-space:nowrap;")}</tr>`).join("")}
      ${totalRow("Subtotal", subtotal)}
      ${totalRow("Shipping", shipping)}
      ${totalRow("Tax", tax)}
      ${totalRow("Total charged", total, true)}
    </table>
    <p style="margin:26px 0 6px;font-size:10px;font-weight:bold;letter-spacing:1.4px;text-transform:uppercase;color:#315eae;">Ship to</p>
    ${paragraph(escapeHtml(shipTo))}
    ${renewalNote ? paragraph(`<strong>${escapeHtml(renewalNote)}</strong>${cancelLink ? " You can stop future renewals at any time." : ""}`) : ""}
    ${cancelLink ? button(cancelLink, "Manage or cancel renewals", "#203b64") : ""}
    ${paragraph(escapeHtml(contactLine))}`;
  return {
    subject,
    previewText,
    text,
    html: shell({
      previewText,
      eyebrow: "Receipt",
      heading: "Thank you for your order",
      greeting: name || undefined,
      bodyHtml,
      closing: "Keep this email for your records. THINNR Weight Loss processes payments on behalf of your provider office.",
    }),
  };
}

function renderOrderShipped(variables: EmailVariables): RenderedEmail {
  const name = variables.name?.trim() || "";
  const orderNumber = requireVariable(variables, "orderNumber");
  const officeName = requireVariable(variables, "officeName");
  const carrier = requireVariable(variables, "carrier");
  const trackingNumber = requireVariable(variables, "trackingNumber");
  const trackingLink = variables.trackingLink?.trim() || "";
  const subject = `THINNR Order (${orderNumber}) has shipped`;
  const previewText = `${officeName} shipped order ${orderNumber} via ${carrier}.`;
  const text = [
    ...(name ? [`Hello ${name},`, ""] : []),
    `Good news: ${officeName} has shipped order ${orderNumber}.`,
    `Carrier: ${carrier}`,
    `Tracking number: ${trackingNumber}`,
    ...(trackingLink ? [`Track your package: ${trackingLink}`] : []),
    "",
    "Tracking details can take a day to appear after the carrier picks up the package.",
  ].join("\n");
  return {
    subject,
    previewText,
    text,
    html: shell({
      previewText,
      eyebrow: "Order update",
      heading: "Your order is on its way",
      greeting: name || undefined,
      bodyHtml: `${paragraph(`Good news: <strong>${escapeHtml(officeName)}</strong> has shipped order <strong>${escapeHtml(orderNumber)}</strong>.`)}
        ${infoPanel(`${carrier} tracking number`, trackingNumber)}
        ${trackingLink ? button(trackingLink, "Track your package") : ""}
        ${paragraph("Tracking details can take a day to appear after the carrier picks up the package.")}`,
      closing: `Questions about this shipment? Contact ${officeName}.`,
    }),
  };
}

function renderSubscriptionPaymentFailed(variables: EmailVariables): RenderedEmail {
  const name = variables.name?.trim() || "";
  const officeName = requireVariable(variables, "officeName");
  const productName = requireVariable(variables, "productName");
  const amount = requireVariable(variables, "amount");
  const paymentLink = requireVariable(variables, "paymentLink");
  const cancelLink = variables.cancelLink?.trim() || "";
  const subject = "Your THINNR order payment did not go through";
  const previewText = `Update your card to pay ${amount} for ${productName}.`;
  const text = [
    ...(name ? [`Hello ${name},`, ""] : []),
    `${officeName} could not collect ${amount} for your ${productName} subscription.`,
    `Update card and pay: ${paymentLink}`,
    "",
    "Stripe will retry the payment automatically.",
    ...(cancelLink ? [`Manage or cancel future renewals: ${cancelLink}`] : []),
  ].join("\n");
  return {
    subject,
    previewText,
    text,
    html: shell({
      previewText,
      eyebrow: "Payment failed",
      heading: "Please update your payment method",
      greeting: name || undefined,
      bodyHtml: `${paragraph(`<strong>${escapeHtml(officeName)}</strong> could not collect <strong>${escapeHtml(amount)}</strong> for your <strong>${escapeHtml(productName)}</strong> subscription.`)}
        ${button(paymentLink, "Update card and pay", "#a33a2e")}
        ${paragraph("Stripe will retry the payment automatically.")}
        ${cancelLink ? button(cancelLink, "Manage or cancel renewals", "#203b64") : ""}`,
      closing: `Questions about this payment? Contact ${officeName}.`,
    }),
  };
}

function renderSubscriptionCancelled(variables: EmailVariables): RenderedEmail {
  const name = variables.name?.trim() || "";
  const productName = requireVariable(variables, "productName");
  const officeName = requireVariable(variables, "officeName");
  const subject = `THINNR subscription cancellation confirmed (${productName})`;
  const previewText = `${productName} will not renew after the current period.`;
  const text = [
    ...(name ? [`Hello ${name},`, ""] : []),
    `Your ${productName} subscription from ${officeName} has been cancelled. It will not renew after the current billing period, and you will not be charged again.`,
    "",
    `Anything already paid for will still ship as planned. If you change your mind, ${officeName} can set up a new order for you.`,
  ].join("\n");
  return {
    subject,
    previewText,
    text,
    html: shell({
      previewText,
      eyebrow: "Subscription",
      heading: "Cancellation confirmed",
      greeting: name || undefined,
      bodyHtml: `${paragraph(`Your <strong>${escapeHtml(productName)}</strong> subscription from <strong>${escapeHtml(officeName)}</strong> has been cancelled. It will not renew after the current billing period, and you will not be charged again.`)}
        ${paragraph(`Anything already paid for will still ship as planned. If you change your mind, ${escapeHtml(officeName)} can set up a new order for you.`)}`,
      closing: "If you did not request this cancellation, contact your provider office right away.",
    }),
  };
}

function renderStaffAttentionDigest(variables: EmailVariables): RenderedEmail {
  const name = variables.name?.trim() || "";
  const officeName = requireVariable(variables, "officeName");
  const digestDate = requireVariable(variables, "digestDate");
  const flaggedCount = requireVariable(variables, "flaggedCount");
  const reasons = parseLineItems(requireVariable(variables, "reasons"));
  const alertsLink = requireVariable(variables, "alertsLink");
  const settingsLink = variables.settingsLink?.trim() || "";
  const count = Number(flaggedCount);
  const headline = count === 1 ? "1 patient needs attention" : `${flaggedCount} patients need attention`;
  const subject = `${headline} at ${officeName}`;
  const previewText = `${headline} today. Open THINNR operations to see who.`;
  const text = [
    ...(name ? [`Hello ${name},`, ""] : []),
    `${headline} at ${officeName} for ${digestDate}.`,
    "",
    ...reasons.map((item) => (item.amount ? `${item.label} — ${item.amount}` : item.label)),
    "",
    `See which patients and open their records: ${alertsLink}`,
    ...(settingsLink ? [`Change who receives these alerts or turn them off for yourself: ${settingsLink}`] : []),
    "",
    "Patient names are never included in email. Alerts are informational and do not replace clinical judgment.",
  ].join("\n");
  const rows = reasons
    .map(
      (item) => `<tr>
        <td style="padding:12px 14px;border-bottom:1px solid #d9e3f1;font-size:15px;font-weight:bold;color:#203b64;vertical-align:top;">${escapeHtml(item.label)}</td>
        <td align="right" style="padding:12px 14px;border-bottom:1px solid #d9e3f1;font-size:14px;line-height:1.5;color:#3b4a63;vertical-align:top;white-space:nowrap;">${escapeHtml(item.amount)}</td>
      </tr>`,
    )
    .join("");
  return {
    subject,
    previewText,
    text,
    html: shell({
      previewText,
      eyebrow: "Daily patient digest",
      heading: headline,
      greeting: name || undefined,
      bodyHtml: `${paragraph(`Here is the <strong>${escapeHtml(officeName)}</strong> attention summary for <strong>${escapeHtml(digestDate)}</strong>. Each count is the number of patients with that recent-progress signal.`)}
        ${infoPanel("Patients flagged today", flaggedCount)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-top:2px solid #203b64;">
          ${rows}
        </table>
        ${button(alertsLink, "See who needs attention")}
        ${paragraph("Patient names are never included in email. Open the portal to see who is on the list and their full activity. Alerts are informational and do not replace clinical judgment.")}
        ${settingsLink ? paragraph(`<a href="${escapeHtml(settingsLink)}" style="color:#315eae;">Change who receives alerts or turn off your email digest</a> in office settings.`) : ""}`,
      closing: `You are receiving this because ${officeName} chose you as an alert recipient. Sent once a day, only when at least one patient is flagged.`,
    }),
  };
}

function renderSystemThresholdAlert(variables: EmailVariables): RenderedEmail {
  const name = variables.name?.trim() || "";
  const level = requireVariable(variables, "level").toLowerCase() === "red" ? "red" : "amber";
  const metricLabel = requireVariable(variables, "metricLabel");
  const finding = requireVariable(variables, "finding");
  const observed = requireVariable(variables, "observed");
  const limit = requireVariable(variables, "limit");
  const day = requireVariable(variables, "day");
  const healthLink = requireVariable(variables, "healthLink");
  const levelWord = level === "red" ? "Red" : "Amber";
  const subject = `${levelWord}: ${metricLabel}`;
  const previewText = `${finding} Open System health for the numbers.`;
  const guidance = level === "red"
    ? "Red means people are waiting or storage is growing faster than planned. Look at the slow statements and growth panels before adding capacity."
    : "Amber is a heads-up: nothing is down, but this is the number to watch. You will hear again only if it turns red.";
  const text = [
    ...(name ? [`Hello ${name},`, ""] : []),
    `${levelWord}: ${metricLabel}`,
    `A System health limit was crossed on ${day}.`,
    "",
    finding,
    `Observed: ${observed}`,
    `Limit: ${limit}`,
    "",
    `Open System health: ${healthLink}`,
    "",
    guidance,
    "",
    "You receive this once per metric, level, and day.",
  ].join("\n");
  return {
    subject,
    previewText,
    text,
    html: shell({
      previewText,
      eyebrow: `System health · ${levelWord}`,
      heading: metricLabel,
      greeting: name || undefined,
      bodyHtml: `${paragraph(`A System health limit was crossed on <strong>${escapeHtml(day)}</strong>.`)}
        ${infoPanel(`${levelWord} finding`, finding)}
        ${paragraph(`<strong>Observed:</strong> ${escapeHtml(observed)}<br><strong>Limit:</strong> ${escapeHtml(limit)}`)}
        ${button(healthLink, "Open System health", level === "red" ? "#a8322a" : "#315eae")}
        ${paragraph(guidance)}`,
      closing: "You receive this because you are an HQ administrator. Sent once per metric, level, and day.",
    }),
  };
}

/**
 * HQ's notice that an office's recovery window closed with nothing collected.
 * Operational only: the office's name, the day, and what it owes — never
 * anything about the office's patients.
 */
function renderOfficeAccessRestricted(variables: EmailVariables): RenderedEmail {
  const name = variables.name?.trim() || "";
  const officeName = requireVariable(variables, "officeName");
  const restrictedOn = requireVariable(variables, "restrictedOn");
  const amountDue = variables.amountDue?.trim() || "";
  const billingLink = requireVariable(variables, "billingLink");
  const subject = `Restricted: ${officeName}`;
  const previewText = `${officeName} was restricted on ${restrictedOn} after its recovery window closed.`;
  const text = [
    ...(name ? [`Hello ${name},`, ""] : []),
    `${officeName} is now restricted.`,
    `Every stored payment instrument failed and the recovery window closed on ${restrictedOn}.`,
    ...(amountDue ? [`Amount outstanding: ${amountDue}`] : []),
    "",
    "The office keeps its data and its patient payments, at the restricted revenue share, until it pays.",
    "",
    `Open the office access board: ${billingLink}`,
    "",
    "You receive this once per office, on the day it is restricted.",
  ].join("\n");
  return {
    subject,
    previewText,
    text,
    html: shell({
      previewText,
      eyebrow: "Office access · Restricted",
      heading: `${officeName} is restricted`,
      greeting: name || undefined,
      bodyHtml: `${paragraph(`Every stored payment instrument failed and the recovery window closed on <strong>${escapeHtml(restrictedOn)}</strong>.`)}
        ${infoPanel("Office", officeName)}
        ${amountDue ? paragraph(`<strong>Amount outstanding:</strong> ${escapeHtml(amountDue)}`) : ""}
        ${paragraph("The office keeps its data and its patient payments, at the restricted revenue share, until it pays.")}
        ${button(billingLink, "Open office access", "#a8322a")}`,
      closing: "You receive this because you are an HQ administrator. Sent once per office, on the day it is restricted.",
    }),
  };
}

export function renderSampleEmail(id: EmailTemplateId): RenderedEmail {
  const definition = EMAIL_TEMPLATE_CATALOG.find((item) => item.id === id);
  if (!definition) throw new Error(`Unknown email template: ${id}`);
  return renderEmailTemplate(id, definition.sampleVariables);
}
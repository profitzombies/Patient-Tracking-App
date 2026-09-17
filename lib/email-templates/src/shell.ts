import type { EmailVariables } from "./index";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function requireVariable(variables: EmailVariables, key: string): string {
  const value = variables[key]?.trim();
  if (!value) throw new Error(`Missing email template variable: ${key}`);
  return value;
}

export function shell(input: {
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

export const paragraph = (value: string) =>
  `<p style="margin:0 0 18px;font-size:16px;line-height:1.65;color:#26364b;">${value}</p>`;

export const infoPanel = (label: string, value: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;width:100%;background:#e3ecf7;border:1px solid #b7cbe8;border-radius:9px;">
    <tr><td style="padding:20px 22px;">
      <p style="margin:0 0 7px;font-size:10px;font-weight:bold;letter-spacing:1.4px;text-transform:uppercase;color:#315eae;">${escapeHtml(label)}</p>
      <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:25px;font-weight:bold;line-height:1.2;color:#203b64;">${escapeHtml(value)}</p>
    </td></tr>
  </table>`;
export const button = (href: string, label: string, background = "#315eae") =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
    <tr><td style="background:${background};border-radius:9px;">
      <a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
    </td></tr>
  </table>`;

/** Line items arrive one per line as "label · amount"; a line without the separator is shown as a label only. */
export function parseLineItems(value: string): Array<{ label: string; amount: string }> {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.lastIndexOf(" · ");
      return at < 0 ? { label: line, amount: "" } : { label: line.slice(0, at), amount: line.slice(at + 3) };
    });
}

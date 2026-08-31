import { describe, expect, it } from "vitest";
import {
  EMAIL_TEMPLATE_CATALOG,
  EMAIL_TEMPLATE_IDS,
  renderEmailTemplate,
  renderSampleEmail,
} from "@workspace/email-templates";

describe("transactional email catalog", () => {
  it("contains exactly the four real email messages with complete sample output", () => {
    expect(EMAIL_TEMPLATE_CATALOG.map((item) => item.id)).toEqual(EMAIL_TEMPLATE_IDS);
    for (const definition of EMAIL_TEMPLATE_CATALOG) {
      const rendered = renderSampleEmail(definition.id);
      expect(rendered.subject).not.toBe("");
      expect(rendered.previewText).not.toBe("");
      expect(rendered.html).toContain(rendered.previewText);
      expect(rendered.html).toContain("<!doctype html>");
      expect(rendered.html).toContain("@media only screen and (max-width: 620px)");
      expect(rendered.text).not.toContain("<");
      expect(Object.values(definition.sampleVariables).every((value) =>
        rendered.html.includes(value.replaceAll("&", "&amp;")) && rendered.text.includes(value),
      )).toBe(true);
    }
  });

  it("escapes supplied variables before placing them in HTML", () => {
    const rendered = renderEmailTemplate("provider-staff-invitation", {
      name: "<script>alert(1)</script>",
      officeName: "Example & Sons",
    });
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.html).toContain("Example &amp; Sons");
  });

  it("gives verification codes a prominent, expiring, security-conscious treatment", () => {
    const rendered = renderEmailTemplate("verification-code", { code: "482917" });
    expect(rendered.subject).toContain("482917");
    expect(rendered.html).toContain("email-code");
    expect(rendered.text).toContain("expires in 10 minutes");
    expect(rendered.text).toContain("never share this code");
  });
});
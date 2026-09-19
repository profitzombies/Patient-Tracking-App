import { describe, expect, it } from "vitest";
import {
  EMAIL_TEMPLATE_CATALOG,
  EMAIL_TEMPLATE_IDS,
  EMAIL_TEMPLATE_PHI_CLASS,
  FULL_NAME_EMAIL_TEMPLATE_IDS,
  lintEmailTemplateCatalog,
  lintEmailTemplateVariables,
  renderEmailTemplate,
  renderSampleEmail,
} from "@workspace/email-templates";

describe("email template PHI lint", () => {
  it("classifies every template and finds no clinical or full-name variable in the shipped catalog", () => {
    expect(Object.keys(EMAIL_TEMPLATE_PHI_CLASS).sort()).toEqual([...EMAIL_TEMPLATE_IDS].sort());
    expect(lintEmailTemplateCatalog(EMAIL_TEMPLATE_CATALOG)).toEqual([]);
    for (const id of FULL_NAME_EMAIL_TEMPLATE_IDS) expect(EMAIL_TEMPLATE_PHI_CLASS[id]).toBe("identity");
  });

  it("rejects clinical variables by key or label on any template", () => {
    for (const [key, label] of [["medicationName", ""], ["latestWeight", ""], ["labResult", ""], ["diagnosisCode", ""], ["progressPhoto", ""], ["summary", "Weight change"], ["details", "Medication list"], ["bmi", ""]]) {
      expect(lintEmailTemplateVariables("order-receipt", { [key]: label }, { labels: true })).toEqual([
        { templateId: "order-receipt", variable: key, rule: "clinical_variable" },
      ]);
    }
  });

  it("allows a full name only on claim and invitation templates", () => {
    expect(lintEmailTemplateVariables("patient-invitation", { patientName: "Patient full name" }, { labels: true })).toEqual([]);
    expect(lintEmailTemplateVariables("staff-attention-digest", { patientName: "" })).toEqual([
      { templateId: "staff-attention-digest", variable: "patientName", rule: "full_name_outside_identity" },
    ]);
    expect(lintEmailTemplateVariables("order-receipt", { who: "Full name" }, { labels: true })).toHaveLength(1);
    // Product, plan, office, and first-name variables stay legal on payment templates.
    expect(lintEmailTemplateVariables("order-receipt", { name: "First name", productName: "Product", planName: "Plan", officeName: "Office", shipTo: "Ship to" }, { labels: true })).toEqual([]);
  });

  it("keeps the staff digest to counts per reason and links: no patient list variable exists", () => {
    const digest = EMAIL_TEMPLATE_CATALOG.find((item) => item.id === "staff-attention-digest")!;
    expect(Object.keys(digest.variableLabels)).not.toContain("patients");
    expect(Object.keys(digest.variableLabels)).toEqual(expect.arrayContaining(["reasons", "flaggedCount", "alertsLink"]));
    const rendered = renderSampleEmail("staff-attention-digest");
    expect(rendered.text).toMatch(/\d+ patients?/);
  });
});

describe("transactional email catalog", () => {
  it("contains exactly the real email messages with complete sample output", () => {
    expect(EMAIL_TEMPLATE_CATALOG.map((item) => item.id)).toEqual(EMAIL_TEMPLATE_IDS);
    for (const definition of EMAIL_TEMPLATE_CATALOG) {
      const rendered = renderSampleEmail(definition.id);
      expect(rendered.subject).not.toBe("");
      expect(rendered.previewText).not.toBe("");
      expect(rendered.html).toContain(rendered.previewText);
      expect(rendered.html).toContain("<!doctype html>");
      expect(rendered.html).toContain("@media only screen and (max-width: 620px)");
      expect(rendered.text).not.toContain("<");
      // Multi-line values (receipt line items) render as one table row per
      // line, so each label and amount must appear rather than the joined string.
      const fragments = Object.values(definition.sampleVariables).flatMap((value) =>
        value.split("\n").flatMap((line) => line.split(" · ")),
      );
      expect(fragments.every((value) =>
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

  it("styles order receipts in the shared shell with the RECEIPT subject line", () => {
    const rendered = renderEmailTemplate("order-receipt", {
      name: "Riley", orderNumber: "TH-7K2Q9M", placedAt: "Sep 14, 2026, 3:24 PM EDT", officeName: "Harbor & Co",
      items: "Control × 2 · $119.98\nBalance · $59.99", subtotal: "$179.97", shipping: "$9.00", tax: "$0.00", total: "$188.97",
      shipTo: "Riley Example, 12 Harbor Lane, Austin, TX 78701, US",
    });
    expect(rendered.subject).toBe("RECEIPT THINNR Order (TH-7K2Q9M) - Sep 14, 2026, 3:24 PM EDT");
    expect(rendered.html).toContain("background:#203b64;"); // shared navy masthead
    expect(rendered.html).toContain("Harbor &amp; Co");
    expect(rendered.html).toContain("Control × 2");
    expect(rendered.html).toContain("$188.97");
    expect(rendered.html).not.toContain("Manage or cancel renewals");
    expect(rendered.text).not.toMatch(/^\n/);
    const renewing = renderEmailTemplate("order-receipt", {
      orderNumber: "TH-1", placedAt: "now", officeName: "Harbor", items: "Control · $1.00", subtotal: "$1.00", shipping: "$0.00",
      tax: "$0.00", total: "$1.00", shipTo: "x", renewalNote: "This order renews every 4 weeks.", cancelLink: "https://example.test/pay/cancel/t",
    });
    expect(renewing.html).toContain("Manage or cancel renewals");
    expect(renewing.html).toContain("https://example.test/pay/cancel/t");
    expect(renewing.html).not.toContain("Hello ");
    expect(renewing.text).toContain("Manage or cancel future renewals: https://example.test/pay/cancel/t");
  });
});

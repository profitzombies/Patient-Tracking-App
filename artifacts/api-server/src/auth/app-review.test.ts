import { describe, expect, it } from "vitest";
import { APP_REVIEW_ENV, appReviewConfig, appReviewIdentity } from "./app-review";
import { normalizeIdentifier } from "../claim/normalize";

const good = {
  patient: { identifier: "(555) 555-0100", code: "246810" },
  staff: { identifier: "Reviewer@Example.com", code: "135790" },
};
const env = (value: unknown) => ({ [APP_REVIEW_ENV]: typeof value === "string" ? value : JSON.stringify(value) });
const phone = normalizeIdentifier("+15555550100")!;
const email = normalizeIdentifier("reviewer@example.com")!;

describe("APP_REVIEW_SIGN_IN parsing", () => {
  it("normalizes both identities and keeps the fixed codes", () => {
    const config = appReviewConfig(env(good));
    expect(config?.patient).toEqual({ realm: "patient", identifier: phone, code: "246810" });
    expect(config?.staff).toEqual({ realm: "staff", identifier: email, code: "135790" });
  });

  it.each<[string, unknown]>([
    ["unset", undefined],
    ["blank", "   "],
    ["not JSON", "{nope"],
    ["an array", "[]"],
    ["a string", JSON.stringify("x")],
    ["patient missing", { staff: good.staff }],
    ["staff missing", { patient: good.patient }],
    ["patient code too short", { ...good, patient: { ...good.patient, code: "1234" } }],
    ["patient code not digits", { ...good, patient: { ...good.patient, code: "12345a" } }],
    ["staff code numeric, not string", { ...good, staff: { ...good.staff, code: 135790 } }],
    ["staff identity is a phone", { ...good, staff: { identifier: "+15555550199", code: "135790" } }],
    ["patient identifier garbage", { ...good, patient: { identifier: "???", code: "246810" } }],
    ["same identity twice", { patient: { identifier: "reviewer@example.com", code: "246810" }, staff: good.staff }],
  ])("fails closed when the variable is %s", (_label, value) => {
    const e = value === undefined ? {} : env(value);
    expect(appReviewConfig(e)).toBeNull();
    expect(appReviewIdentity("patient", phone, e)).toBeNull();
    expect(appReviewIdentity("staff", email, e)).toBeNull();
  });

  it("matches a listed identity only in its own realm", () => {
    const e = env(good);
    expect(appReviewIdentity("patient", phone, e)?.code).toBe("246810");
    expect(appReviewIdentity("staff", email, e)?.code).toBe("135790");
    expect(appReviewIdentity("staff", phone, e)).toBeNull();
    expect(appReviewIdentity("patient", email, e)).toBeNull();
    expect(appReviewIdentity("patient", normalizeIdentifier("+15555550101")!, e)).toBeNull();
    expect(appReviewIdentity("staff", normalizeIdentifier("other@example.com")!, e)).toBeNull();
  });

  it("matches formatting variants of the same identity", () => {
    const e = env(good);
    expect(appReviewIdentity("patient", normalizeIdentifier("555-555-0100")!, e)).not.toBeNull();
    expect(appReviewIdentity("staff", normalizeIdentifier("  REVIEWER@example.com ")!, e)).not.toBeNull();
  });
});

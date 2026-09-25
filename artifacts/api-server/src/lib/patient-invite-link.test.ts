import { describe, expect, it } from "vitest";
import { resolvePatientInviteLink, suggestedPatientInviteUrl } from "./patient-invite-link";

const LIVE = "https://app.example.test/thinnr-mobile/";
const EXPO_DEV = "abc123.expo.worf.replit.dev";

describe("patient invitation app link", () => {
  it("keeps the workspace behaviour in development: configured value, else the Expo dev domain", () => {
    expect(resolvePatientInviteLink({ NODE_ENV: "development", REPLIT_EXPO_DEV_DOMAIN: EXPO_DEV })).toEqual({
      ok: true, link: `https://${EXPO_DEV}`, setting: "REPLIT_EXPO_DEV_DOMAIN",
    });
    expect(resolvePatientInviteLink({ NODE_ENV: "development", PATIENT_APP_URL: "https://app.thinnr.test", REPLIT_EXPO_DEV_DOMAIN: EXPO_DEV }))
      .toMatchObject({ ok: true, link: "https://app.thinnr.test", setting: "PATIENT_APP_URL" });
    expect(resolvePatientInviteLink({ NODE_ENV: "development" })).toEqual({ ok: false, problem: "missing" });
  });

  it("prefers the dedicated invite setting over the general patient app URL", () => {
    expect(resolvePatientInviteLink({ NODE_ENV: "production", PATIENT_INVITE_URL: ` ${LIVE} `, PATIENT_APP_URL: "https://web.example.test" }))
      .toEqual({ ok: true, link: LIVE, setting: "PATIENT_INVITE_URL" });
  });

  it("never falls back to the workspace preview on the published site", () => {
    expect(resolvePatientInviteLink({ NODE_ENV: "production", REPLIT_EXPO_DEV_DOMAIN: EXPO_DEV })).toEqual({ ok: false, problem: "missing" });
  });

  it("refuses development preview and non-https values on the published site", () => {
    expect(resolvePatientInviteLink({ NODE_ENV: "production", PATIENT_INVITE_URL: `https://${EXPO_DEV}` }))
      .toMatchObject({ ok: false, problem: "dev_preview", setting: "PATIENT_INVITE_URL" });
    expect(resolvePatientInviteLink({ NODE_ENV: "production", PATIENT_APP_URL: "https://old.example.repl.co" }))
      .toMatchObject({ ok: false, problem: "dev_preview", setting: "PATIENT_APP_URL" });
    expect(resolvePatientInviteLink({ NODE_ENV: "production", PATIENT_INVITE_URL: "http://app.example.test/thinnr-mobile/" }))
      .toMatchObject({ ok: false, problem: "invalid" });
    expect(resolvePatientInviteLink({ NODE_ENV: "production", PATIENT_INVITE_URL: "not a url" }))
      .toMatchObject({ ok: false, problem: "invalid" });
    // A bad dedicated value is reported, not silently skipped for the next one.
    expect(resolvePatientInviteLink({ NODE_ENV: "production", PATIENT_INVITE_URL: `https://${EXPO_DEV}`, PATIENT_APP_URL: LIVE }))
      .toMatchObject({ ok: false, problem: "dev_preview" });
  });

  it("strict mode can be asked for explicitly (the readiness check)", () => {
    expect(resolvePatientInviteLink({ NODE_ENV: "development", REPLIT_EXPO_DEV_DOMAIN: EXPO_DEV }, { strict: true }))
      .toEqual({ ok: false, problem: "missing" });
  });

  it("suggests the Expo Go page under the published site address", () => {
    expect(suggestedPatientInviteUrl({ OPERATIONS_APP_URL: "https://app.example.test/" })).toBe(LIVE);
    expect(suggestedPatientInviteUrl({ OPERATIONS_APP_URL: "https://abc.worf.replit.dev" })).toBeNull();
    expect(suggestedPatientInviteUrl({})).toBeNull();
  });
});

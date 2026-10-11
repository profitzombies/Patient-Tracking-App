import { describe, expect, it } from "vitest";
import { resolvePatientInviteLink, suggestedPatientInviteUrl } from "./patient-invite-link";
import { isInterimStoreLink, patientInvitationLinkVariables, resolvePatientAppLinks } from "./patient-app-link";

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

describe("patient app links (store links first, Expo Go page as the fallback)", () => {
  const APP_STORE = "https://apps.apple.com/us/app/thinnr/id6740000001";
  const PLAY = "https://play.google.com/store/apps/details?id=com.thinnr.app";
  const env = { NODE_ENV: "production", PATIENT_INVITE_URL: LIVE };

  it("uses the Expo Go page while HQ has no store links", () => {
    expect(resolvePatientAppLinks({ appStoreUrl: null, googlePlayUrl: "  " }, env)).toEqual({
      ok: true, mode: "expo_go", link: LIVE, appStoreUrl: null, googlePlayUrl: null, expoGoUrl: LIVE, interim: false,
    });
    expect(patientInvitationLinkVariables(resolvePatientAppLinks(null, env) as never)).toEqual({ appLink: LIVE });
  });

  it("switches to the store links as soon as either is set, App Store first", () => {
    const both = resolvePatientAppLinks({ appStoreUrl: ` ${APP_STORE} `, googlePlayUrl: PLAY }, env);
    expect(both).toEqual({ ok: true, mode: "store", link: APP_STORE, appStoreUrl: APP_STORE, googlePlayUrl: PLAY, expoGoUrl: LIVE, interim: false });
    expect(patientInvitationLinkVariables(both as never)).toEqual({ appLink: APP_STORE, appStoreLink: APP_STORE, googlePlayLink: PLAY, expoGoLink: LIVE });
    expect(resolvePatientAppLinks({ appStoreUrl: null, googlePlayUrl: PLAY }, env)).toMatchObject({ mode: "store", link: PLAY, appStoreUrl: null });
  });

  it("treats TestFlight and Play testing links as interim store links", () => {
    expect(isInterimStoreLink("https://testflight.apple.com/join/AbCdEf12")).toBe(true);
    expect(isInterimStoreLink("https://play.google.com/apps/internaltest/4700000000000000001")).toBe(true);
    expect(isInterimStoreLink("https://play.google.com/apps/testing/com.thinnr.app")).toBe(true);
    expect(isInterimStoreLink(APP_STORE)).toBe(false);
    expect(isInterimStoreLink(PLAY)).toBe(false);
    expect(resolvePatientAppLinks({ appStoreUrl: "https://testflight.apple.com/join/AbCdEf12", googlePlayUrl: null }, {}, { strict: true }))
      .toMatchObject({ ok: true, mode: "store", interim: true, expoGoUrl: null });
  });

  it("reports the Expo Go problem when nothing usable is configured", () => {
    expect(resolvePatientAppLinks({ appStoreUrl: null, googlePlayUrl: null }, { NODE_ENV: "production" })).toEqual({ ok: false, mode: "expo_go", problem: "missing" });
    expect(resolvePatientAppLinks(null, { NODE_ENV: "production", PATIENT_INVITE_URL: `https://${EXPO_DEV}` }))
      .toMatchObject({ ok: false, mode: "expo_go", problem: "dev_preview" });
  });
});

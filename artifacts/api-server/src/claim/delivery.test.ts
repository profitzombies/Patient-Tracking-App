import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderEmailTemplate, type EmailTemplateId } from "@workspace/email-templates";
import {
  sendClaimEmail,
  sendHqTeamInvitation,
  sendProviderClaimInvitation,
  sendStaffLoginInvitation,
} from "./delivery";

const sentBodies: Record<string, unknown>[] = [];

beforeEach(() => {
  sentBodies.length = 0;
  vi.stubEnv("RESEND_API_KEY", "test-only-key");
  vi.stubEnv("CLAIM_EMAIL_FROM", "THINNR <mail@example.invalid>");
  vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    sentBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(null, { status: 202 });
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function expectSharedPayload(
  id: EmailTemplateId,
  variables: Record<string, string>,
  send: () => Promise<void>,
) {
  await send();
  expect(sentBodies).toHaveLength(1);
  const rendered = renderEmailTemplate(id, variables);
  expect(sentBodies[0]).toMatchObject({
    to: ["recipient@example.invalid"],
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });
}

describe("transactional email delivery parity", () => {
  it("sends the shared verification-code output", async () => {
    const variables = { code: "482917" };
    await expectSharedPayload(
      "verification-code",
      variables,
      () => sendClaimEmail("recipient@example.invalid", variables.code),
    );
  });

  it("sends the shared provider account-ready output", async () => {
    const variables = {
      providerName: "Avery Example",
      officeName: "Example Wellness Studio",
      providerCode: "731942",
    };
    await expectSharedPayload(
      "provider-account-ready",
      variables,
      () => sendProviderClaimInvitation("recipient@example.invalid", variables),
    );
  });

  it("sends the shared HQ invitation output", async () => {
    const variables = { name: "Jordan Fiction", role: "Content Specialist", setupUrl: "https://operations.test/hq-setup?token=abc", expiresLabel: "Friday, October 2, 2026 at 4:00 PM UTC" };
    await expectSharedPayload(
      "hq-team-invitation",
      variables,
      () => sendHqTeamInvitation("recipient@example.invalid", variables),
    );
  });

  it("sends the shared provider staff invitation output", async () => {
    const variables = { name: "Morgan Sample", officeName: "Example Wellness Studio" };
    await expectSharedPayload(
      "provider-staff-invitation",
      variables,
      () => sendStaffLoginInvitation("recipient@example.invalid", variables),
    );
  });
});
import { describe, expect, it } from "vitest";
import type { PushMessage } from "./expo-push";
import { FakePushClient } from "./memory-store";
import {
  PUSH_BODY_MAX_CHARS,
  PUSH_DATA_VALUE_MAX_CHARS,
  PUSH_GUARD_ERROR_CODE,
  PUSH_TITLE_MAX_CHARS,
  guardPushMessage,
  isForbiddenPushDataKey,
  sendGuarded,
} from "./push-guard";

const ok = (over: Partial<PushMessage> = {}): PushMessage => ({
  to: "ExponentPushToken[ok]",
  title: "Time for a dose",
  body: "Open the app to log it.",
  data: { route: "/check-in", medicationId: "med-1", dueDate: "2026-07-01", dueTime: "09:00", notificationId: "n-1", kind: "missed_dose", category: "check_in_reminders" },
  ...over,
});

describe("push guard", () => {
  it("passes generic copy with id-only data", () => {
    expect(guardPushMessage(ok())).toEqual({ ok: true });
    expect(guardPushMessage(ok({ data: undefined }))).toEqual({ ok: true });
    expect(guardPushMessage(ok({ data: { route: "/coach-chat", crossingKey: "2026-07-01", messageClientId: "outreach:1", suggestion: true, flaggedCount: 3, digestDate: null } }))).toEqual({ ok: true });
  });

  it("rejects over-long titles and bodies", () => {
    expect(guardPushMessage(ok({ title: "t".repeat(PUSH_TITLE_MAX_CHARS + 1) }))).toMatchObject({ ok: false, reason: expect.stringContaining("title") });
    expect(guardPushMessage(ok({ body: "b".repeat(PUSH_BODY_MAX_CHARS + 1) }))).toMatchObject({ ok: false, reason: expect.stringContaining("body") });
    expect(guardPushMessage(ok({ title: " " }))).toMatchObject({ ok: false });
    expect(guardPushMessage(ok({ body: "" }))).toMatchObject({ ok: false });
  });

  it("rejects fields that could carry a person, a finding, or free text", () => {
    for (const key of ["patientName", "firstName", "name", "email", "phone", "medication", "medicationName", "dose", "weight", "latestWeight", "reasons", "patients", "message", "text", "body", "notes", "officeName", "recipientName", "productName", "carrier", "trackingNumber"]) {
      expect(isForbiddenPushDataKey(key), key).toBe(true);
      expect(guardPushMessage(ok({ data: { route: "/check-in", [key]: "x" } }))).toMatchObject({ ok: false, reason: expect.stringContaining(key) });
    }
    for (const key of ["route", "kind", "category", "notificationId", "medicationId", "messageClientId", "crossingKey", "patientId", "orderId", "subscriptionId", "invoiceId", "signInId", "exportId", "dueDate", "dueTime", "shipDate", "digestDate", "flaggedCount", "providerId", "thread", "conversationId", "suggestion"]) {
      expect(isForbiddenPushDataKey(key), key).toBe(false);
    }
  });

  it("rejects nested payloads and long string values", () => {
    expect(guardPushMessage(ok({ data: { route: "/check-in", items: [{ label: "No meals" }] } }))).toMatchObject({ ok: false, reason: expect.stringContaining("items") });
    expect(guardPushMessage(ok({ data: { route: "/check-in", extra: { deep: true } } }))).toMatchObject({ ok: false });
    expect(guardPushMessage(ok({ data: { route: "x".repeat(PUSH_DATA_VALUE_MAX_CHARS + 1) } }))).toMatchObject({ ok: false, reason: expect.stringContaining("route") });
    expect(guardPushMessage(ok({ data: [] as unknown as Record<string, unknown> }))).toMatchObject({ ok: false });
  });

  it("sends only the messages that pass and returns a non-transient guard ticket for each refused one, in order", async () => {
    const client = new FakePushClient();
    const blocked = ok({ to: "ExponentPushToken[blocked]", data: { route: "/check-in", patientName: "Emma" } });
    const tickets = await sendGuarded(client, [ok(), blocked, ok({ to: "ExponentPushToken[second]" })]);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0].map((message) => message.to)).toEqual(["ExponentPushToken[ok]", "ExponentPushToken[second]"]);
    expect(tickets).toHaveLength(3);
    expect(tickets[0]).toMatchObject({ status: "ok" });
    expect(tickets[1]).toEqual({ status: "error", message: expect.stringContaining("patientName"), details: { error: PUSH_GUARD_ERROR_CODE } });
    expect(tickets[2]).toMatchObject({ status: "ok" });
  });

  it("never calls the transport when every message is refused", async () => {
    const client = new FakePushClient();
    const tickets = await sendGuarded(client, [ok({ body: "b".repeat(PUSH_BODY_MAX_CHARS + 1) })]);
    expect(client.sent).toHaveLength(0);
    expect(tickets).toEqual([{ status: "error", message: expect.any(String), details: { error: PUSH_GUARD_ERROR_CODE } }]);
  });

  it("lets transport failures propagate untouched", async () => {
    const client = new FakePushClient();
    client.failNextSends = 1;
    await expect(sendGuarded(client, [ok()])).rejects.toThrow();
  });
});

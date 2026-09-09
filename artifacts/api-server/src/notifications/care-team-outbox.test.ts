import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  path.resolve(here, "../../../../supabase/migrations/20261007000000_business_care_team_messaging.sql"),
  "utf8",
);
const sendFunction = migration.slice(
  migration.indexOf("create or replace function public.care_team_send"),
  migration.indexOf("create or replace function public.care_team_patient_read"),
);
const outboxInsert = sendFunction.slice(
  sendFunction.indexOf("insert into public.patient_notifications"),
  sendFunction.indexOf("on conflict(dedupe_key)"),
);

describe("care-team transactional outbox contract", () => {
  it("queues the existing office-reminders category with generic lockscreen copy", () => {
    expect(sendFunction).toContain("'care_team_reply','office_reminders'");
    expect(sendFunction).toContain("'A message from your care team','You have a new care team message.'");
  });

  it("stores only deep-link fields plus the server-only office binding", () => {
    expect(sendFunction).toMatch(
      /jsonb_build_object\(\s*'patientId',\s*p_patient_id,\s*'thread',\s*'care_team',\s*'conversationId',\s*p_conversation_id,\s*'providerId',\s*p_provider_id\s*\)/s,
    );
    expect(outboxInsert).not.toMatch(/'(?:route|messageClientId|text|senderLabel)'/);
  });

  it("dedupes the staff message and outbox row in the same transaction", () => {
    expect(sendFunction).toContain("'care_team_reply:'||p_conversation_id::text||':'||p_client_id");
    expect(sendFunction).toContain("on conflict(dedupe_key) do nothing");
    // The enqueue remains inside the new-message branch, so an RPC retry that
    // finds the existing client_id cannot create another notification.
    expect(sendFunction).toMatch(
      /if found then[\s\S]*?else[\s\S]*?insert into public.patient_chat_messages[\s\S]*?insert into public.patient_notifications/,
    );
  });
});
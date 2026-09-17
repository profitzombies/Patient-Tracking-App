import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  path.resolve(here, "../../../../supabase/migrations/20261024000000_care_team_product_suggestion_cards.sql"),
  "utf8",
);
const sendFunction = migration.slice(
  migration.indexOf("create or replace function public.care_team_send"),
  migration.indexOf("revoke all on function public.care_team_send"),
);
const outboxInsert = sendFunction.slice(
  sendFunction.indexOf("insert into public.patient_notifications"),
  sendFunction.indexOf("on conflict(dedupe_key)"),
);

describe("care-team transactional outbox contract", () => {
  it("keeps the recreated send RPC security definer so service_role can reach the private guards", () => {
    // The original definition was later altered to security definer; a plain
    // create-or-replace after the drop silently loses it and every send 403s
    // with "permission denied for schema private" on the live database.
    const header = sendFunction.slice(0, sendFunction.indexOf("$$"));
    expect(header).toMatch(/security definer/);
  });
  it("queues the existing office-reminders category with generic lockscreen copy", () => {
    expect(sendFunction).toContain("'care_team_reply','office_reminders'");
    expect(sendFunction).toContain("coalesce(p_push_body,'You have a new care team message.')");
  });

  it("stores the card and marks suggestion notification rows", () => {
    expect(sendFunction).toContain("sender_user_id,sender_label,card");
    expect(sendFunction).toContain("jsonb_build_object('suggestion',true)");
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
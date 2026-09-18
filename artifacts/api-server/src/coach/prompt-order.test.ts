/**
 * Cache-friendly prompt order. The provider's prompt cache reuses an exact
 * token prefix, so the coach chat prompt must put byte-stable content first
 * and per-turn content last — and an identical source set must always
 * produce identical bytes, whatever order selection surfaced it in.
 */
import { describe, expect, it } from "vitest";
import {
  buildChatMessages,
  buildSystemPrompt,
  COACH_PERSONA_LINE,
  COACH_STATIC_RULES,
  patientContextLine,
  sourcesBlock,
  type PatientContext,
} from "./prompt";
import { COMPARTMENTS, getCompartmentById } from "./compartments";

const riley: PatientContext = { firstName: "Riley", phaseName: "Phase 1", programDay: 12 };
const emma: PatientContext = { firstName: "Emma", phaseName: "Phase 2", programDay: 40 };

describe("coach chat prompt order", () => {
  it("puts everything per-turn after one byte-identical head for the patient", () => {
    const head = (patient: PatientContext) => `${COACH_PERSONA_LINE}\n\n${patientContextLine(patient)}\n\n${COACH_STATIC_RULES}\n\nTHINNR program materials for this question:\n\n`;
    const a = buildSystemPrompt([getCompartmentById("approved-foods")], riley);
    const b = buildSystemPrompt([getCompartmentById("program-phases")], riley);
    expect(a.startsWith(head(riley))).toBe(true);
    expect(b.startsWith(head(riley))).toBe(true);
    expect(buildSystemPrompt([getCompartmentById("approved-foods")], emma).startsWith(head(emma))).toBe(true);
    // Nothing that varies per question sits in the head.
    expect(head(riley)).not.toContain("<source ");
    expect(a.indexOf("<source ")).toBe(head(riley).length);
  });

  it("keeps the rules and one-tap instructions in the static rules, sources after", () => {
    const prompt = buildSystemPrompt([getCompartmentById("approved-foods")], riley);
    expect(COACH_STATIC_RULES).toContain("Grounding rules:");
    expect(COACH_STATIC_RULES).toContain("One-tap answer buttons");
    expect(prompt.indexOf("<source ")).toBeGreaterThan(prompt.indexOf("Grounding rules:"));
  });

  it("renders the same source set as identical bytes whatever order selection produced", () => {
    const a = [getCompartmentById("program-phases"), getCompartmentById("approved-foods")];
    const b = [getCompartmentById("approved-foods"), getCompartmentById("program-phases")];
    expect(sourcesBlock(a)).toBe(sourcesBlock(b));
    expect(buildSystemPrompt(a, riley)).toBe(buildSystemPrompt(b, riley));
    // Registry order, so the bytes are stable across turns and deploys.
    const ids = [...sourcesBlock(a).matchAll(/<source id="([^"]+)"/g)].map((m) => m[1]);
    const rank = new Map(COMPARTMENTS.map((c, i) => [c.id, i]));
    expect(ids).toEqual([...ids].sort((x, y) => rank.get(x)! - rank.get(y)!));
  });

  it("sends one system prompt followed by the history, latest question last", () => {
    const prompt = buildSystemPrompt([getCompartmentById("approved-foods")], riley);
    const history = [
      { role: "assistant" as const, content: "Hi Riley." },
      { role: "user" as const, content: "Can I have coffee?" },
      { role: "assistant" as const, content: "Black coffee is fine." },
      { role: "user" as const, content: "What about snacks?" },
    ];
    const messages = buildChatMessages(prompt, "Recalled: prefers savory snacks.", history);
    expect(messages.map((m) => m.role)).toEqual(["system", "assistant", "user", "assistant", "user"]);
    expect(messages[0].content.startsWith(prompt)).toBe(true);
    expect(messages[0].content.endsWith("Recalled: prefers savory snacks.")).toBe(true);
    expect(messages.slice(1)).toEqual(history);
    // A follow-up with the same sources is a message-for-message extension
    // of the previous request: that is the prefix the provider cache reuses.
    const previous = buildChatMessages(prompt, "Recalled: prefers savory snacks.", history.slice(0, 2));
    expect(messages.slice(0, 3)).toEqual(previous);
  });

  it("omits recalled context when there is none", () => {
    const prompt = buildSystemPrompt([], riley);
    const messages = buildChatMessages(prompt, null, [{ role: "user", content: "Hi." }]);
    expect(messages[0].content).toBe(prompt);
    expect(messages).toHaveLength(2);
  });
});

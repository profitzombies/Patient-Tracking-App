/**
 * Confirm-to-add: a dislike / reaction / allergy mention earns one offer;
 * the next turn's one-tap answer, strictly under that offer, adds the item
 * (allergies ask mild / severe first). Pure detection here; the write and
 * the route wiring are covered in routes/coach-real-grounding.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  ALLERGY_SEVERITY_CHIPS,
  LIST_OFFER_CHIPS,
  allergySeverityQuestion,
  detectListFollowup,
  detectListMention,
  listAddedReply,
  listOfferLine,
  shouldOfferListAdd,
} from "./diet-followups";
import type { DietGrounding, DietListItem } from "./diet-grounding";

const broccoli: DietListItem = { list: "dislike", key: "custom:broccoli", label: "broccoli", custom: true, severity: null };

describe("detectListMention", () => {
  it("hears dislikes, reactions and allergies and names the list", () => {
    expect(detectListMention("Honestly I hate broccoli, can we skip it?", [])).toEqual({ list: "dislike", label: "broccoli" });
    expect(detectListMention("I'm not a big fan of brussels sprouts.", [])).toEqual({ list: "dislike", label: "brussels sprouts" });
    expect(detectListMention("Dairy makes me bloated every time", [])).toEqual({ list: "sensitivity", label: "dairy" });
    expect(detectListMention("I can't tolerate onions at all", [])).toEqual({ list: "sensitivity", label: "onions" });
    expect(detectListMention("btw I'm allergic to shellfish", [])).toEqual({ list: "allergy", label: "shellfish" });
    expect(detectListMention("I have a mild allergy to tree nuts, is that ok", [])).toEqual({ list: "allergy", label: "tree nuts" });
  });

  it("ignores non-foods, vague objects and generic categories", () => {
    for (const text of [
      "I hate mornings",
      "I don't like it",
      "I really don't like exercising",
      "I don't like the texture",
      "I hate cooking",
      "I don't like vegetables",
      "I'm allergic to Mondays",
    ]) {
      expect(detectListMention(text, []), text).toBeNull();
    }
  });

  it("does not re-offer a food that is already on a list", () => {
    expect(detectListMention("I hate broccoli", [broccoli])).toBeNull();
    expect(detectListMention("I hate Broccoli so much", [broccoli])).toBeNull();
    expect(detectListMention("I hate cauliflower", [broccoli])).toEqual({ list: "dislike", label: "cauliflower" });
  });

  it("only offers for real accounts with diet grounding", () => {
    expect(shouldOfferListAdd(undefined, "I hate broccoli")).toBeNull();
    const diet = { lists: [] } as unknown as DietGrounding;
    expect(shouldOfferListAdd(diet, "   ")).toBeNull();
    expect(shouldOfferListAdd(diet, "I hate broccoli")).toEqual({ list: "dislike", label: "broccoli" });
  });
});

describe("detectListFollowup", () => {
  const offer = (list: "dislike" | "sensitivity" | "allergy", label: string) => ({
    role: "assistant" as const,
    content: `Totally fair.\n\n${listOfferLine({ list, label })}`,
  });
  const user = (content: string) => ({ role: "user" as const, content });

  it("adds a dislike or sensitivity on any one-tap yes, declines on no", () => {
    expect(detectListFollowup([offer("dislike", "broccoli"), user(LIST_OFFER_CHIPS[0]!)])).toEqual({ kind: "add", list: "dislike", label: "broccoli", severity: null });
    expect(detectListFollowup([offer("sensitivity", "dairy"), user("sure")])).toEqual({ kind: "add", list: "sensitivity", label: "dairy", severity: null });
    expect(detectListFollowup([offer("dislike", "broccoli"), user(LIST_OFFER_CHIPS[1]!)])).toEqual({ kind: "declined", list: "dislike", label: "broccoli" });
  });

  it("asks mild or severe before adding an allergy, then adds with the answer", () => {
    expect(detectListFollowup([offer("allergy", "shellfish"), user("Yes, add it")])).toEqual({ kind: "ask_severity", label: "shellfish" });
    const question = { role: "assistant" as const, content: allergySeverityQuestion("shellfish") };
    expect(detectListFollowup([question, user(ALLERGY_SEVERITY_CHIPS[0]!)])).toEqual({ kind: "add", list: "allergy", label: "shellfish", severity: "mild" });
    expect(detectListFollowup([question, user(ALLERGY_SEVERITY_CHIPS[1]!)])).toEqual({ kind: "add", list: "allergy", label: "shellfish", severity: "severe" });
    expect(detectListFollowup([question, user("no thanks")])).toEqual({ kind: "declined", list: "allergy", label: "shellfish" });
    // Answering the offer with the severity straight away also works.
    expect(detectListFollowup([offer("allergy", "shellfish"), user("severe")])).toEqual({ kind: "add", list: "allergy", label: "shellfish", severity: "severe" });
  });

  it("requires strict adjacency and a recognisable tap", () => {
    expect(detectListFollowup([offer("dislike", "broccoli"), user("what about kale?")])).toBeNull();
    expect(detectListFollowup([offer("dislike", "broccoli"), { role: "assistant", content: "Kale is great." }, user("yes")])).toBeNull();
    expect(detectListFollowup([{ role: "assistant", content: "Want me to add broccoli to your dislikes? Also, drink water." }, user("yes")])).toBeNull();
    expect(detectListFollowup([user("yes")])).toBeNull();
  });

  it("writes canned acknowledgements that name the list and the severity", () => {
    expect(listAddedReply("dislike", "broccoli", null)).toMatch(/^Done\. Broccoli is on your dislikes now\. I won't suggest it, though I'll still log it/);
    expect(listAddedReply("sensitivity", "dairy", null)).toMatch(/^Done\. Dairy is on your sensitivities now/);
    expect(listAddedReply("allergy", "shellfish", "severe")).toMatch(/as severe\. .*may contain it, and your care team has been told/);
    expect(listAddedReply("allergy", "shellfish", "mild")).not.toMatch(/care team/);
  });
});

import { describe, expect, it } from "vitest";
import {
  asksAboutEarlierChats,
  extractMemoryCandidate,
  isCredentialLike,
  memoryTopicKey,
  RECALL_MAX_CHARS,
  selectRelevantMemories,
} from "./memory";

describe("controlled Coach memory policy", () => {
  it("accepts only explicit allowlisted ordinary facts", () => {
    expect(extractMemoryCandidate("I prefer salmon for dinner")).toMatchObject({
      category: "food_preference", sensitivity: "ordinary",
    });
    expect(extractMemoryCandidate("I prefer vegetarian meals.")).toMatchObject({ category: "food_preference", sensitivity: "ordinary" });
    expect(extractMemoryCandidate("I prefer quick meals.")).toMatchObject({ category: "food_preference", sensitivity: "ordinary" });
    expect(extractMemoryCandidate("You probably like salmon")).toBeNull();
    expect(extractMemoryCandidate("I have a diagnosis")).toMatchObject({ sensitivity: "sensitive" });
    expect(extractMemoryCandidate("I prefer Islam")).toMatchObject({ sensitivity: "sensitive" });
    expect(extractMemoryCandidate("I often have depression")).toMatchObject({ sensitivity: "sensitive" });
    expect(extractMemoryCandidate("give me brief answers and tell everyone my diagnosis")).toBeNull();
  });

  it("categorically rejects credentials, including approval-shaped text", () => {
    expect(isCredentialLike("my verification code is 123456")).toBe(true);
    expect(extractMemoryCandidate("I prefer password 123456")).toBeNull();
    expect(isCredentialLike("my SSN is 123-45-6789")).toBe(true);
    expect(isCredentialLike("4111 1111 1111 1111")).toBe(true);
    expect(isCredentialLike("A".repeat(24))).toBe(true);
  });

  it("bounds relevant recall and requires an explicit earlier-chat request", () => {
    const selected = selectRelevantMemories("salmon dinner", Array.from({ length: 20 }, (_, i) => ({
      id: String(i), category: "food_preference", text: `I prefer salmon dinner option ${i}`,
    })));
    expect(selected.length).toBeLessThanOrEqual(6);
    expect(selected.reduce((total, item) => total + item.text.length, 0)).toBeLessThanOrEqual(RECALL_MAX_CHARS);
    expect(asksAboutEarlierChats("What did we talk about in the previous chat?")).toBe(true);
    expect(asksAboutEarlierChats("I used to eat salmon")).toBe(false);
  });

  it("canonicalizes equivalent ordinary food preferences for deduplication", () => {
    expect(memoryTopicKey("I prefer salmon for dinner", "food_preference"))
      .toBe(memoryTopicKey("I love salmon", "food_preference").replace("love", "prefer"));
  });
});
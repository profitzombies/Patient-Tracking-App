/**
 * Unit coverage for the AI Support document router: keyword/title/summary
 * scoring, latest-message weighting, the two-doc stage-1 cap, and the
 * weak-relevance fallback that sends the whole library up front.
 */
import { describe, expect, it } from "vitest";
import type { SupportDocument } from "./docs";
import { selectSupportDocuments } from "./select";

function doc(
  id: string,
  title: string,
  keywords: string[],
  summary = "",
): SupportDocument {
  return { id, title, keywords, summary, text: `${id} text` };
}

const FOODS = doc("d-foods", "Approved Foods", ["approved foods", "grapefruit", "protein"]);
const BOOST = doc("d-boost", "Boost Product Info", ["boost", "dosing"], "Dosing for the Boost stack.");
const CLINICAL = doc("d-clinical", "Clinical Training Document", ["side effects", "headache"]);
const LIBRARY = [FOODS, BOOST, CLINICAL];

describe("selectSupportDocuments", () => {
  it("routes a keyword match to that document first", () => {
    const selection = selectSupportDocuments(LIBRARY, "Is grapefruit approved?", []);
    expect(selection.primary[0]?.id).toBe("d-foods");
    expect(selection.broadened).toBe(false);
    expect(selection.remaining.map((d) => d.id)).toContain("d-clinical");
  });

  it("matches keyword phrases whole-word despite punctuation", () => {
    const selection = selectSupportDocuments(LIBRARY, "What's the DOSING (daily)?", []);
    expect(selection.primary[0]?.id).toBe("d-boost");
  });

  it("scores title words when no keyword hits", () => {
    const selection = selectSupportDocuments(LIBRARY, "Where is the clinical training?", []);
    expect(selection.primary[0]?.id).toBe("d-clinical");
  });

  it("scores summary words from the question", () => {
    const selection = selectSupportDocuments(LIBRARY, "Anything about the stack?", []);
    expect(selection.primary[0]?.id).toBe("d-boost");
  });

  it("keeps at most two documents in stage 1 and the rest as remaining", () => {
    const selection = selectSupportDocuments(
      LIBRARY,
      "grapefruit protein boost dosing headache side effects",
      [],
    );
    expect(selection.primary).toHaveLength(2);
    expect(selection.remaining).toHaveLength(1);
    expect(selection.broadened).toBe(false);
  });

  it("weights the latest message over earlier turns", () => {
    const selection = selectSupportDocuments(LIBRARY, "What about boost?", [
      "Is grapefruit approved?",
    ]);
    // Latest (boost, x3) outranks history (grapefruit, x1).
    expect(selection.primary[0]?.id).toBe("d-boost");
    // The history doc still makes stage 1 as the second slot.
    expect(selection.primary[1]?.id).toBe("d-foods");
  });

  it("only reads the last two earlier user messages", () => {
    const selection = selectSupportDocuments(LIBRARY, "What about boost?", [
      "tell me about headache side effects", // 3 messages back: ignored
      "hello there",
      "hi again",
    ]);
    expect(selection.primary.map((d) => d.id)).not.toContain("d-clinical");
  });

  it("falls back to the whole library when nothing matches", () => {
    const selection = selectSupportDocuments(LIBRARY, "Completely unrelated zzz", []);
    expect(selection.primary).toHaveLength(LIBRARY.length);
    expect(selection.remaining).toHaveLength(0);
    expect(selection.broadened).toBe(true);
  });

  it("marks stage 1 as full-library when every document matched", () => {
    const two = [FOODS, BOOST];
    const selection = selectSupportDocuments(two, "grapefruit and boost dosing", []);
    expect(selection.primary).toHaveLength(2);
    expect(selection.remaining).toHaveLength(0);
    expect(selection.broadened).toBe(true);
  });

  it("handles an empty library", () => {
    const selection = selectSupportDocuments([], "anything", []);
    expect(selection.primary).toHaveLength(0);
    expect(selection.broadened).toBe(true);
  });
});

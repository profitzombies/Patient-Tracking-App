/**
 * Unit tests for the meal chat helpers: the typed-correction detector, the
 * closer copy contract, the meal-photo model choice, and the approved-foods
 * flow pieces (citation verification, callout/nod formatting, and the two
 * adjacency detectors behind the makeover chips).
 *
 * The correction detector decides whether a message typed right after a
 * meal-card reply re-runs the SAME held photo with the patient's words as
 * ground truth. False positives are the expensive failure (an unrelated
 * message would be forced into a re-analysis), so the negative table
 * matters as much as the positive one — including the one-tap chip labels,
 * which must always read as chip answers, never corrections. The mobile
 * client keeps a byte-identical copy (lib/meal-correction.ts); the
 * meal-photo verify suite imports both and asserts they agree on a shared
 * phrase table.
 */
import { describe, expect, it } from "vitest";
import {
  MEAL_CARD_CLOSER,
  MEAL_KEEP_REPLY,
  MEAL_MAKEOVER_OFFER,
  MEAL_MAKEOVER_UNAVAILABLE,
  MEAL_ON_PLAN_NOD,
  MEAL_TRY_ANOTHER_PHOTO,
  MEAL_VERSION_QUESTION,
  detectMealMakeoverFollowUp,
  detectMealVersionChoice,
  formatMealReply,
  offPlanCallout,
} from "./meal-chat";
import { isMealCorrectionText } from "./meal-correction";
import { MEAL_PHOTO_MODEL, type MealPhotoAnalysis } from "./meal-photo";
import { verifiedApprovedCitation } from "./approved-catalog";
import { MEAL_VERSION_REPLY_SET, firstQuickReplySet } from "./quick-replies";

describe("MEAL_PHOTO_MODEL", () => {
  it("is the mid-tier read the user chose — never nano again, never top-tier without sign-off", () => {
    expect(MEAL_PHOTO_MODEL).toBe("gpt-5.6-luna");
  });
});

describe("isMealCorrectionText", () => {
  const corrections = [
    "No, that's steak and sweet potatoes",
    "no that's not brisket",
    "Nope, sweet potato wedges",
    "Wrong, it's pork chops",
    "Actually it's a turkey burger",
    "Correction, that's roast beef",
    "that's not smoked brisket",
    "That is not salmon",
    "it's steak and sweet potato wedges",
    "It was grilled chicken, and the rice was cauliflower rice",
    "this is meatloaf with mashed potatoes",
    "those are sweet potato wedges, and you missed them",
    "you missed the sweet potatoes",
    "You misread the plate",
    "you mixed the meats up",
    "you got the meat wrong",
    "that looks wrong, it was one roast",
    "there's no salmon on that plate",
    "I don't see any brisket there",
    "it should be steak, and one meat only",
    "that was supposed to be pot roast",
    "more like 6 oz of chicken and a cup of rice",
    "it isn't lamb, it's beef",
    "the sides aren't fries, they're sweet potato wedges",
  ];
  it.each(corrections)("reads %j as a correction", (text) => {
    expect(isMealCorrectionText(text)).toBe(true);
  });

  const notCorrections = [
    // The fixed photo replay lines — retakes and retries must stay fresh reads.
    "I sent a photo of my meal.",
    "I sent a photo.",
    "I sent a photo of a restaurant menu.",
    "I sent a photo of a nutrition label.",
    // Questions are questions, even correction-shaped ones.
    "Is that not brisket?",
    "How much protein should I eat today?",
    "Can I log this for lunch?",
    // One-tap chip answers to the makeover offer and version question: the
    // client re-attaches the held photo only for corrections, and these
    // must never read as one. Polite declines are declines, not food fixes.
    "Yes, please",
    "No thanks",
    "no, thanks!",
    "No thank you",
    "no thank u",
    "nope, thanks",
    "The approved version",
    "Keep it as is",
    // Confirmations and reactions.
    "That's right",
    "that's perfect, thanks",
    "That's it",
    "thats great",
    "It's fine",
    "looks good, thank you",
    "Thanks, logging it now",
    "nothing wrong with that read",
    // Ordinary follow-ups that must reach the normal coach chat.
    "What should I eat tomorrow",
    "Give me a recipe like this for next week",
    "I'm still hungry after meals like this",
    "Log it for dinner please",
  ];
  it.each(notCorrections)("does not read %j as a correction", (text) => {
    expect(isMealCorrectionText(text)).toBe(false);
  });

  it("still reads a decline that carries a food fix as a correction", () => {
    // The polite-decline guard only swallows PURE declines; words after the
    // thanks mean the patient is fixing the read in the same breath.
    expect(isMealCorrectionText("no thanks, that's chicken and rice")).toBe(true);
  });
});

describe("formatMealReply", () => {
  it("prints each card name verbatim — payload assembly is the single casing seam", () => {
    const analysis: MealPhotoAnalysis = {
      outcome: "ok",
      message: "A classic PB&J lunch.",
      payload: {
        id: "meal_test_1",
        mode: "meal",
        name: "PB&J with Apple Slices",
        description: "A PB&J with a cup of apple slices.",
        meal: "lunch",
        minutes: 0,
        servings: 1,
        calories: 440,
        protein: 12,
        carbs: 64,
        fat: 16,
        ingredients: [
          {
            amount: 1,
            unit: "sandwich",
            name: "PB&J Sandwich on Wheat",
            nutrition: { calories: 380, protein: 12, carbs: 48, fat: 16 },
          },
          {
            amount: 1.5,
            unit: "",
            name: "Slices of Red Apple",
            nutrition: { calories: 60, protein: 0, carbs: 16, fat: 0 },
          },
        ],
        steps: [],
      },
      offPlanItems: [],
    };
    const { reply } = formatMealReply(analysis);
    // Already-Title-Cased names come through untouched — no re-casing, no
    // first-letter mangling of brand spellings like "PB&J", and connector
    // words ("on", "of", "with") stay exactly as the card carries them.
    expect(reply).toContain("PB&J Sandwich on Wheat: about 1 sandwich · est. 380 cal");
    // A unitless amount renders bare, and the name still passes verbatim.
    expect(reply).toContain("Slices of Red Apple: about 1.5 · est. 60 cal");
    expect(reply).toContain(MEAL_CARD_CLOSER);
  });
});

describe("meal reply closers", () => {
  it("invites both fixes: typing what the plate really is, or retaking the photo", () => {
    expect(MEAL_CARD_CLOSER).toContain("type what it really is");
    expect(MEAL_CARD_CLOSER).toContain("retake the photo");
    // The typed example primes phrasing the detector actually accepts.
    expect(isMealCorrectionText("no, that's steak and sweet potatoes")).toBe(true);
  });

  it("keeps the canned-string voice rules: no question-mark endings, no em or en dashes", () => {
    for (const closer of [MEAL_CARD_CLOSER, MEAL_TRY_ANOTHER_PHOTO]) {
      expect(closer.trimEnd().endsWith("?")).toBe(false);
      // Hyphenated compounds ("fine-tune") are fine; dash-as-pause is not.
      expect(closer).not.toMatch(/[—–]/);
    }
  });
});

describe("approved-foods canned strings", () => {
  it("keeps the voice rules: only the two offers end with a question mark, nothing carries dashes", () => {
    const statements = [MEAL_ON_PLAN_NOD, MEAL_KEEP_REPLY, MEAL_MAKEOVER_UNAVAILABLE];
    for (const text of statements) {
      expect(text.trimEnd().endsWith("?")).toBe(false);
    }
    const offers = [MEAL_MAKEOVER_OFFER, MEAL_VERSION_QUESTION];
    for (const text of offers) {
      expect(text.trimEnd().endsWith("?")).toBe(true);
    }
    for (const text of [...statements, ...offers]) {
      expect(text).not.toMatch(/[—–]/);
    }
  });

  it("names the program list verbatim where the patient sees it", () => {
    expect(MEAL_ON_PLAN_NOD).toContain("THINNR Approved Foods list");
    expect(MEAL_MAKEOVER_OFFER).toContain("THINNR-approved");
    expect(offPlanCallout(["flour tortilla"])).toContain("THINNR Approved Foods list");
  });

  it("keeps the keep-it reply judgment-free and pointed at the original card", () => {
    expect(MEAL_KEEP_REPLY).toContain("meal card above");
    expect(MEAL_KEEP_REPLY.trimEnd().endsWith("?")).toBe(false);
  });
});

describe("offPlanCallout", () => {
  it("names one item with a singular verb, lowercased, no lecture", () => {
    const callout = offPlanCallout(["Flour tortilla"]);
    expect(callout).toContain("the flour tortilla isn't on your THINNR Approved Foods list");
    expect(callout).toContain("this meal is yours exactly as it is");
  });

  it("joins two items with and, plural verb", () => {
    expect(offPlanCallout(["flour tortilla", "sour cream"])).toContain(
      "the flour tortilla and the sour cream aren't on",
    );
  });

  it("uses the serial comma for three or more", () => {
    expect(offPlanCallout(["flour tortilla", "sour cream", "shredded cheese"])).toContain(
      "the flour tortilla, the sour cream, and the shredded cheese aren't on",
    );
  });
});

describe("formatMealReply approval shapes", () => {
  const item = (name: string, approved: boolean) => ({
    amount: 1,
    unit: "cup",
    name,
    nutrition: { calories: 100, protein: 5, carbs: 10, fat: 3 },
  });
  const okAnalysis = (offPlanItems: string[]): MealPhotoAnalysis => ({
    outcome: "ok",
    message: "Nice looking plate.",
    payload: {
      id: "meal_test",
      mode: "meal",
      name: "Test Meal",
      description: "A test plate.",
      meal: "lunch",
      minutes: 0,
      servings: 1,
      calories: 200,
      protein: 10,
      carbs: 20,
      fat: 6,
      ingredients: [item("grilled chicken breast", true), item("flour tortilla", false)],
      steps: [],
    },
    offPlanItems,
  });

  it("fully approved: nod + closer, no question ending, no chips", () => {
    const { reply, offerMakeover } = formatMealReply(okAnalysis([]));
    expect(offerMakeover).toBe(false);
    expect(reply).toContain(MEAL_ON_PLAN_NOD);
    expect(reply.trimEnd().endsWith(MEAL_CARD_CLOSER)).toBe(true);
    expect(reply).not.toContain(MEAL_MAKEOVER_OFFER);
    expect(reply.trimEnd().endsWith("?")).toBe(false);
  });

  it("off-plan items: callout block + offer ending, chips requested, card guidance intact", () => {
    const { reply, offerMakeover } = formatMealReply(okAnalysis(["flour tortilla"]));
    expect(offerMakeover).toBe(true);
    expect(reply).toContain(MEAL_CARD_CLOSER);
    expect(reply).toContain(offPlanCallout(["flour tortilla"]));
    expect(reply.trimEnd().endsWith(MEAL_MAKEOVER_OFFER)).toBe(true);
    expect(reply).not.toContain(MEAL_ON_PLAN_NOD);
    // The callout and offer share the FINAL block (single trailing question).
    const lastBlock = reply.split("\n\n").at(-1) ?? "";
    expect(lastBlock).toContain("One small heads up");
    expect(lastBlock.endsWith(MEAL_MAKEOVER_OFFER)).toBe(true);
  });

  it("non-ok outcomes keep the retake nudge and never mention the list", () => {
    const notFood: MealPhotoAnalysis = {
      outcome: "not_food",
      message: "That looks like your desk.",
      payload: null,
      offPlanItems: [],
    };
    const { reply, offerMakeover } = formatMealReply(notFood);
    expect(offerMakeover).toBe(false);
    expect(reply).toContain(MEAL_TRY_ANOTHER_PHOTO);
    expect(reply).not.toContain("Approved Foods");
  });
});

describe("verifiedApprovedCitation", () => {
  it("accepts a real id whose entry matches the ingredient name (prep words allowed)", () => {
    expect(
      verifiedApprovedCitation(
        "grilled chicken breast",
        "poultry:skinless_white_meat_chicken_breast",
      ),
    ).toBe(true);
    expect(verifiedApprovedCitation("roasted sweet potatoes", "norm_foods:sweet_potatoes")).toBe(
      true,
    );
  });

  it("rejects missing ids, unknown ids, and mismatched citations", () => {
    expect(verifiedApprovedCitation("flour tortilla", undefined)).toBe(false);
    expect(verifiedApprovedCitation("flour tortilla", "bread_grain:flour_tortilla")).toBe(false);
    // A real id cited for a DIFFERENT food must fail the name check.
    expect(
      verifiedApprovedCitation("chocolate cake", "poultry:skinless_white_meat_chicken_breast"),
    ).toBe(false);
  });
});

describe("makeover adjacency detectors", () => {
  const offerReply = `Breakdown here.\n\n${MEAL_CARD_CLOSER}\n\nCallout text. ${MEAL_MAKEOVER_OFFER}`;
  const versionReply = `Swap the tortilla for lettuce cups.\n\n${MEAL_VERSION_QUESTION}`;

  it("detects the chip labels and typed yeses right after the matching server question", () => {
    const yesNo = firstQuickReplySet(["yes_no"]);
    expect(yesNo).toBeDefined();
    for (const label of yesNo?.labels ?? []) {
      const history = [
        { role: "assistant" as const, content: offerReply },
        { role: "user" as const, content: label },
      ];
      // The curated yes label follows up; the no label falls through.
      expect(detectMealMakeoverFollowUp(history)).toBe(label.toLowerCase().includes("yes"));
    }
    for (const typed of ["yes", "Yes please", "sure", "ok", "yeah!"]) {
      expect(
        detectMealMakeoverFollowUp([
          { role: "assistant", content: offerReply },
          { role: "user", content: typed },
        ]),
      ).toBe(true);
    }
  });

  it("never fires without the offer directly above, or on richer text", () => {
    expect(
      detectMealMakeoverFollowUp([
        { role: "assistant", content: "A plain reply with no offer." },
        { role: "user", content: "yes" },
      ]),
    ).toBe(false);
    // A stopped callout reply replays only its truncated visible text — if
    // the offer never revealed, the yes cannot bind to it.
    expect(
      detectMealMakeoverFollowUp([
        { role: "assistant", content: "One small heads up: the flour tor" },
        { role: "user", content: "yes" },
      ]),
    ).toBe(false);
    expect(
      detectMealMakeoverFollowUp([
        { role: "assistant", content: offerReply },
        { role: "user", content: "yes but what would you swap in it?" },
      ]),
    ).toBe(false);
    expect(detectMealMakeoverFollowUp([{ role: "user", content: "yes" }])).toBe(false);
  });

  it("maps both version chip labels to their choices (exact labels ride the wire)", () => {
    const history = (answer: string) => [
      { role: "assistant" as const, content: versionReply },
      { role: "user" as const, content: answer },
    ];
    expect(detectMealVersionChoice(history(MEAL_VERSION_REPLY_SET.labels[0]))).toBe("approved");
    expect(detectMealVersionChoice(history(MEAL_VERSION_REPLY_SET.labels[1]))).toBe("keep");
    // Natural typed variants on both sides.
    expect(detectMealVersionChoice(history("Let's do the approved version!"))).toBe("approved");
    expect(detectMealVersionChoice(history("make it approved"))).toBe("approved");
    expect(detectMealVersionChoice(history("keep it"))).toBe("keep");
    expect(detectMealVersionChoice(history("no, keep it as is"))).toBe("keep");
  });

  it("returns null away from the question, on a bare no, and on richer answers", () => {
    expect(
      detectMealVersionChoice([
        { role: "assistant", content: "No version question here." },
        { role: "user", content: "keep it as is" },
      ]),
    ).toBe(null);
    const history = (answer: string) => [
      { role: "assistant" as const, content: versionReply },
      { role: "user" as const, content: answer },
    ];
    // A bare "no" is ambiguous at a two-way question — plain chat asks.
    expect(detectMealVersionChoice(history("no"))).toBe(null);
    expect(detectMealVersionChoice(history("what would the approved version taste like?"))).toBe(
      null,
    );
    expect(detectMealVersionChoice(history("can you make it spicy too"))).toBe(null);
  });

  it("keeps the version chip labels aligned with the detector allow-lists", () => {
    expect(MEAL_VERSION_REPLY_SET.labels).toEqual(["The approved version", "Keep it as is"]);
  });
});

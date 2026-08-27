/**
 * Unit tests for the meal chat helpers: the typed-correction detector, the
 * closer copy contract, and the meal-photo model choice.
 *
 * The detector decides whether a message typed right after a meal-card
 * reply re-runs the SAME held photo with the patient's words as ground
 * truth. False positives are the expensive failure (an unrelated message
 * would be forced into a re-analysis), so the negative table matters as
 * much as the positive one. The mobile client keeps a byte-identical copy
 * (lib/meal-correction.ts); the meal-photo verify suite imports both and
 * asserts they agree on a shared phrase table.
 */
import { describe, expect, it } from "vitest";
import { formatMealReply, MEAL_CARD_CLOSER, MEAL_TRY_ANOTHER_PHOTO } from "./meal-chat";
import { isMealCorrectionText } from "./meal-correction";
import { MEAL_PHOTO_MODEL, type MealPhotoAnalysis } from "./meal-photo";

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
    };
    const reply = formatMealReply(analysis);
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

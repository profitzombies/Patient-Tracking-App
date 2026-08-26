/**
 * Unit tests for the menu-photo chat turn helpers: structured-scan-to-reply
 * formatting, the conservative affirmative matcher, and the follow-up
 * detector that routes a "yes" after the recipe offer into the recipe
 * pipeline.
 */
import { describe, expect, it } from "vitest";
import {
  MENU_RECIPE_OFFER,
  MENU_RECIPE_OFFER_EMPTY,
  detectMenuRecipeFollowUp,
  formatMenuReply,
  isAffirmativeReply,
} from "./menu-chat";
import type { MenuScanPayload } from "./menu-scan";

const OK_PAYLOAD: MenuScanPayload = {
  result: "ok",
  message: "The grill section is your friend here.",
  menuTitle: "Harbor Grill",
  order: [
    {
      name: "Grilled Salmon",
      howToOrder: "Ask for it grilled plain, sauce on the side.",
      note: "Stick to the 4 oz portion.",
    },
    { name: "Chicken Paillard", howToOrder: "No oil on the greens, lemon instead of dressing." },
  ],
  avoid: [{ name: "Fettuccine Alfredo", reason: "Cream sauce cannot be fixed by asking." }],
};

describe("formatMenuReply", () => {
  it("formats picks, skips, and the recipe offer as blank-line blocks", () => {
    const { reply, offerRecipe } = formatMenuReply(OK_PAYLOAD);
    expect(offerRecipe).toBe(true);
    expect(reply).toBe(
      [
        "The grill section is your friend here.",
        "1. Grilled Salmon: Ask for it grilled plain, sauce on the side. Stick to the 4 oz portion.",
        "2. Chicken Paillard: No oil on the greens, lemon instead of dressing.",
        "Skip Fettuccine Alfredo: Cream sauce cannot be fixed by asking.",
        MENU_RECIPE_OFFER,
      ].join("\n\n"),
    );
  });

  it("drops the numbering when there is a single pick", () => {
    const { reply } = formatMenuReply({
      ...OK_PAYLOAD,
      order: [OK_PAYLOAD.order[0]],
      avoid: [],
    });
    expect(reply).toContain("\n\nGrilled Salmon: ");
    expect(reply).not.toContain("1. ");
    expect(reply).not.toContain("Skip ");
  });

  it("keeps chat replies text-message sized: 3 picks and 2 skips at most", () => {
    const many: MenuScanPayload = {
      ...OK_PAYLOAD,
      order: Array.from({ length: 5 }, (_, i) => ({
        name: `Dish ${i + 1}`,
        howToOrder: "Plain, please.",
      })),
      avoid: Array.from({ length: 4 }, (_, i) => ({
        name: `Avoid ${i + 1}`,
        reason: "Breaded and fried.",
      })),
    };
    const { reply } = formatMenuReply(many);
    expect(reply).toContain("3. Dish 3");
    expect(reply).not.toContain("Dish 4");
    expect(reply).toContain("Skip Avoid 2");
    expect(reply).not.toContain("Avoid 3");
  });

  it("still offers a home recipe when nothing on the menu fits", () => {
    const { reply, offerRecipe } = formatMenuReply({
      result: "ok",
      message: "Honestly, nothing printed here fits. Ask for a plain grilled chicken breast.",
      order: [],
      avoid: [{ name: "Everything fried", reason: "Breading." }],
    });
    expect(offerRecipe).toBe(true);
    expect(reply).toContain(MENU_RECIPE_OFFER_EMPTY);
    expect(reply).not.toContain(MENU_RECIPE_OFFER);
  });

  it("turns not-a-menu into a warm notice that hides the fallback chips", () => {
    const { reply, offerRecipe } = formatMenuReply({
      result: "not_menu",
      message: "That looks like a photo of a storefront, not a menu.",
      order: [],
      avoid: [],
    });
    expect(offerRecipe).toBe(false);
    expect(reply).toContain("That looks like a photo of a storefront");
    expect(reply).toContain("snap another photo");
    // The client shows fallback yes/no chips under any finished reply ending
    // in a question mark; these notices must never trigger that.
    expect(reply.endsWith("?")).toBe(false);
  });

  it("treats unreadable photos the same way", () => {
    const { reply, offerRecipe } = formatMenuReply({
      result: "unreadable",
      message: "I could not make out the text in that photo.",
      order: [],
      avoid: [],
    });
    expect(offerRecipe).toBe(false);
    expect(reply.endsWith("?")).toBe(false);
  });
});

describe("isAffirmativeReply", () => {
  it.each(["Yes, please", "yes", "Sure!", "OK", "okay", "Sounds good", "Absolutely.", "yep"])(
    "accepts %j",
    (text) => {
      expect(isAffirmativeReply(text)).toBe(true);
    },
  );

  it.each([
    "No thanks",
    "yes but is bread ok?",
    "what about dessert",
    "Yesterday I ate out",
    "",
    "another recipe please",
  ])("rejects %j", (text) => {
    expect(isAffirmativeReply(text)).toBe(false);
  });
});

describe("detectMenuRecipeFollowUp", () => {
  const menuReply = `Here is what I would order.\n\n${MENU_RECIPE_OFFER}`;

  it("fires on a short yes right after the offer", () => {
    expect(
      detectMenuRecipeFollowUp([
        { role: "user", content: "I sent a photo of a restaurant menu." },
        { role: "assistant", content: menuReply },
        { role: "user", content: "Yes, please" },
      ]),
    ).toBe(true);
  });

  it("fires for the empty-menu offer variant too", () => {
    expect(
      detectMenuRecipeFollowUp([
        { role: "assistant", content: `Nothing fits.\n\n${MENU_RECIPE_OFFER_EMPTY}` },
        { role: "user", content: "sure" },
      ]),
    ).toBe(true);
  });

  it("ignores a yes when the offer is not in the previous reply", () => {
    expect(
      detectMenuRecipeFollowUp([
        { role: "assistant", content: "Water with lemon is a great choice." },
        { role: "user", content: "Yes, please" },
      ]),
    ).toBe(false);
  });

  it("goes stale once another exchange lands in between", () => {
    expect(
      detectMenuRecipeFollowUp([
        { role: "assistant", content: menuReply },
        { role: "user", content: "Is sparkling water ok?" },
        { role: "assistant", content: "Yes, plain sparkling water is fine." },
        { role: "user", content: "Yes, please" },
      ]),
    ).toBe(false);
  });

  it("ignores non-affirmative replies to the offer", () => {
    expect(
      detectMenuRecipeFollowUp([
        { role: "assistant", content: menuReply },
        { role: "user", content: "No thanks" },
      ]),
    ).toBe(false);
  });

  it("needs a user-last, assistant-before shape", () => {
    expect(detectMenuRecipeFollowUp([{ role: "user", content: "yes" }])).toBe(false);
    expect(
      detectMenuRecipeFollowUp([
        { role: "user", content: menuReply },
        { role: "user", content: "yes" },
      ]),
    ).toBe(false);
  });

  it("honors a stopped reply only if the offer text was actually revealed", () => {
    // The client keeps exactly the revealed prefix of a stopped reply, so a
    // stop before the closing offer means the patient never saw the question.
    expect(
      detectMenuRecipeFollowUp([
        { role: "assistant", content: "Here is what I would order. 1. Grilled" },
        { role: "user", content: "yes" },
      ]),
    ).toBe(false);
    expect(
      detectMenuRecipeFollowUp([
        { role: "assistant", content: menuReply },
        { role: "user", content: "yes" },
      ]),
    ).toBe(true);
  });
});

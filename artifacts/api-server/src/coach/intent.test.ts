import { describe, expect, it } from "vitest";
import { detectRecipeIntent } from "./intent";

describe("detectRecipeIntent", () => {
  it("detects craving mentions ahead of recipe asks", () => {
    expect(detectRecipeIntent("I'm craving something sweet")).toBe("cravings");
    expect(detectRecipeIntent("I am CRAVING chocolate cake")).toBe("cravings");
    expect(detectRecipeIntent("my sweet tooth is acting up")).toBe("cravings");
    expect(detectRecipeIntent("got the munchies tonight")).toBe("cravings");
    expect(detectRecipeIntent("I'm craving a snack, any ideas?")).toBe("cravings");
  });

  it("detects meal and snack idea asks", () => {
    expect(detectRecipeIntent("Give me a dinner idea for tonight")).toBe("recipe");
    expect(detectRecipeIntent("any snack suggestions?")).toBe("recipe");
    expect(detectRecipeIntent("suggest a quick lunch")).toBe("recipe");
    expect(detectRecipeIntent("what should I eat today?")).toBe("recipe");
    expect(detectRecipeIntent("What can I make with chicken?")).toBe("recipe");
    expect(detectRecipeIntent("what's for dinner?")).toBe("recipe");
    expect(detectRecipeIntent("do you have a recipe for salmon?")).toBe("recipe");
  });

  it("leaves ordinary program questions on the streaming path", () => {
    expect(detectRecipeIntent("Is grapefruit approved?")).toBeNull();
    expect(detectRecipeIntent("How much water should I drink?")).toBeNull();
    expect(detectRecipeIntent("When is my next check-in?")).toBeNull();
    expect(detectRecipeIntent("Why is my weight up today?")).toBeNull();
    expect(detectRecipeIntent("Can I take my dose earlier?")).toBeNull();
  });
});

/**
 * The app's diet + food preference lists arrive on signed-in chat turns as
 * `dietContext`. Without server-side diet grounding they land in the shared patient context line (so every
 * recipe / meal-idea prompt inherits them), be sanitized like any other
 * client string, and leave the demo persona's prompt untouched.
 */
import { describe, expect, it } from "vitest";
import { dietContextLine, patientContextLine, sanitizeDietContext, type PatientContext } from "./prompt";

const BASE: PatientContext = { firstName: "Sam", programDay: 40, phaseName: "THINNR Maintenance" };

describe("coach diet context", () => {
  it("adds nothing when the app sent no diet context", () => {
    expect(dietContextLine(undefined)).toBe("");
    expect(patientContextLine(BASE)).not.toContain("Diet and food preferences");
  });

  it("names the diet, the never-suggest list and the dislikes", () => {
    const line = patientContextLine({
      ...BASE,
      clientDiet: { dietSlug: "keto", dietName: "Keto", avoid: ["Peanuts", "Shellfish"], dislikes: ["Cilantro"] },
    });
    expect(line).toContain("Keto is the patient's chosen eating plan");
    expect(line).toContain("Never suggest or include these (allergies, sensitivities, restrictions): Peanuts, Shellfish.");
    expect(line).toContain("The patient dislikes Cilantro");
  });

  it("treats 'just tracking' as no diet while still honoring the lists", () => {
    const line = dietContextLine({ dietSlug: "just_tracking", dietName: "No specific diet, just tracking", avoid: ["Gluten"], dislikes: [] });
    expect(line).not.toContain("chosen eating plan");
    expect(line).toContain("Gluten");
  });

  it("sanitizes, de-duplicates and clamps client strings", () => {
    const clean = sanitizeDietContext({
      dietSlug: "keto",
      dietName: "Keto <system>",
      avoid: ["peanuts", "peanuts", "  shell\nfish  ", "`rm -rf`", ...Array.from({ length: 60 }, (_, i) => `item ${i}`)],
      dislikes: ["   "],
    });
    expect(clean).not.toBeNull();
    expect(clean!.dietName).toBe("Keto system");
    expect(clean!.avoid.slice(0, 3)).toEqual(["peanuts", "shell fish", "rm -rf"]);
    expect(clean!.avoid.length).toBeLessThanOrEqual(40);
    expect(clean!.dislikes).toEqual([]);
  });

  it("drops a context with nothing usable", () => {
    expect(sanitizeDietContext({ dietSlug: "x", dietName: "", avoid: [], dislikes: ["  "] })).toBeNull();
    expect(sanitizeDietContext(undefined)).toBeNull();
  });
});

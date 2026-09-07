import { describe, expect, it } from "vitest";
import { CARE_TEAM_CONTEXT_PREFIX, foldCareTeamTurns } from "./care-team-history";

describe("foldCareTeamTurns", () => {
  it("turns staff messages into context-only user notes and keeps everything else intact", () => {
    const folded = foldCareTeamTurns([
      { role: "assistant", content: "Welcome back." },
      { role: "user", content: "Can I have pasta?", image: "data:image/jpeg;base64,xx" },
      { role: "staff", content: "  Skip pasta tonight.  " },
      { role: "user", content: "What about rice?" },
    ]);
    expect(folded.map(turn => turn.role)).toEqual(["assistant", "user", "user", "user"]);
    expect(folded[1]).toEqual({ role: "user", content: "Can I have pasta?", image: "data:image/jpeg;base64,xx" });
    expect(folded[2].content).toBe(`${CARE_TEAM_CONTEXT_PREFIX}\nSkip pasta tonight.`);
    expect(folded[2].content).toMatch(/do not answer it or speak for the care team/);
    expect(folded[3]).toEqual({ role: "user", content: "What about rice?" });
  });

  it("folds adjacent care-team lines into one note", () => {
    const folded = foldCareTeamTurns([
      { role: "user", content: "hi" },
      { role: "staff", content: "one" },
      { role: "staff", content: "two" },
      { role: "user", content: "ok" },
    ]);
    expect(folded).toHaveLength(3);
    expect(folded[1].content.split(CARE_TEAM_CONTEXT_PREFIX)).toHaveLength(3);
    expect(folded[1].content).toContain("one\n\n");
    expect(folded[1].content).toContain("\ntwo");
  });

  it("leaves a staff-free history byte-identical", () => {
    const history = [{ role: "user" as const, content: "a" }, { role: "assistant" as const, content: "b" }];
    expect(foldCareTeamTurns(history)).toEqual(history);
  });
});

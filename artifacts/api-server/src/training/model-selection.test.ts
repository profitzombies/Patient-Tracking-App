import { describe, expect, it } from "vitest";
import { MENU_SCAN_MODEL } from "../coach/menu-scan";
import { TEXT_MODEL, TRANSCRIBE_MODEL } from "./pipeline";

describe("training and menu model selection", () => {
  it("uses nano for metadata and menu vision without changing transcription", () => {
    expect(TEXT_MODEL).toBe("gpt-5-nano");
    expect(MENU_SCAN_MODEL).toBe("gpt-5-nano");
    expect(TRANSCRIBE_MODEL).toBe("gpt-4o-mini-transcribe");
  });
});
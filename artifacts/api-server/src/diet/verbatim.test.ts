/**
 * Verbatim tripwire for the diet library.
 *
 * The owner's rule: any THINNR program wording that reaches staff or
 * patients must be quoted exactly from the docs archive, never paraphrased.
 * The seeded diet library is intentionally free of program passages (its
 * rule sheets describe general frameworks and cite external bodies), and the
 * only program wording the diet foundation ships is the four phase names.
 *
 * This suite keeps both facts true:
 *   - every phase name is a whitespace-normalised substring of the manual;
 *   - no seeded summary / rule sheet / sample day / oversight note smuggles a
 *     program phrase in unless that exact passage exists in the archive.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DIET_CATALOG, JUST_TRACKING_SLUG, PROGRAM_PHASES } from "@workspace/diet-programs";

const ARCHIVE_DIR = resolve(__dirname, "../../../../docs/thinnr-program");
const ARCHIVE_FILES = ["manual-transcription.md", "program-instructions.md", "approved-foods.md", "protocol-knowledge-base.txt"];

function normalise(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^--- Page \d+ ---$/.test(line.trim()) && !/^Copyright © 2025 SlimCell/i.test(line.trim()))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

const archive = normalise(ARCHIVE_FILES.map((file) => readFileSync(resolve(ARCHIVE_DIR, file), "utf8")).join("\n"));

/** Program-specific phrases that mark a passage as quoting the protocol. */
const PROGRAM_MARKERS = [/metabolic (activation|thinning|transition|normalization) phase/i, /slimcell/i, /\bthinnr\b/i, /homeopathic/i, /loading days?/i];

describe("diet library verbatim guard", () => {
  it("the archive is present and non-trivial", () => {
    expect(archive.length).toBeGreaterThan(10_000);
  });

  it("every phase name and boundary is quoted verbatim from the program manual", () => {
    expect(PROGRAM_PHASES.map((phase) => phase.name)).toEqual([
      "Metabolic Activation Phase",
      "Metabolic Thinning Phase",
      "Metabolic Transition Phase",
      "Metabolic Normalization Phase",
    ]);
    for (const phase of PROGRAM_PHASES) {
      expect(archive, `${phase.name} is not in the archive`).toContain(phase.name);
    }
    // The manual names the four phases in this order in one sentence.
    expect(archive).toContain(
      "the Metabolic Activation Phase, the Metabolic Thinning Phase, the Metabolic Transition Phase, and the Metabolic Normalization Phase",
    );
  });

  it("seeded library passages that mention the program quote the archive exactly", () => {
    const offenders: string[] = [];
    for (const entry of DIET_CATALOG) {
      const passages = [entry.summary, ...entry.ruleSheet, ...entry.sampleDay, ...entry.sources];
      for (const passage of passages) {
        if (!PROGRAM_MARKERS.some((marker) => marker.test(passage))) continue;
        if (!archive.includes(normalise(passage))) offenders.push(`${entry.slug}: ${passage}`);
      }
    }
    expect(offenders, "program wording must be copied verbatim from docs/thinnr-program").toEqual([]);
  });

  it("the shipped catalog has 26 frameworks plus just tracking", () => {
    expect(DIET_CATALOG).toHaveLength(27);
    expect(DIET_CATALOG.filter((entry) => entry.slug === JUST_TRACKING_SLUG)).toHaveLength(1);
  });
});

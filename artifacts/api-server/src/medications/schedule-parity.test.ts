/**
 * The schedule core is copied byte-for-byte into the mobile app and the
 * operations web app (each artifact bundles its own source). Every copy must
 * stay identical so a phone, the server, and an office screen agree on which
 * doses are due when.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = resolve(__dirname);
const COPIES = [
  resolve(HERE, "../../../thinnr-mobile/lib/medication-schedule.ts"),
  resolve(HERE, "../../../thinnr-operations/src/lib/medication-schedule.ts"),
];

describe("medication schedule copies", () => {
  it("are byte-identical to the server source", () => {
    const source = readFileSync(resolve(HERE, "schedule.ts"), "utf8");
    for (const copy of COPIES) {
      expect(readFileSync(copy, "utf8"), copy).toBe(source);
    }
  });
});

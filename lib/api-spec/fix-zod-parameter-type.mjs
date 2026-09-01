import { readFile, writeFile } from "node:fs/promises";

// Orval v8 gives a path Zod schema and a query TypeScript interface the same
// operation-based name. The API-Zod barrel exports both, so keep the runtime
// schema name and make the type's query purpose explicit.
const path = "../api-zod/src/generated/types/getOfficePatientRecordParams.ts";
const source = await readFile(path, "utf8");
const output = source.replace(
  "export type GetOfficePatientRecordParams =",
  "export type GetOfficePatientRecordQueryInput =",
);
if (source === output) {
  throw new Error("Expected generated Office patient record parameter type was not found.");
}
await writeFile(path, output);
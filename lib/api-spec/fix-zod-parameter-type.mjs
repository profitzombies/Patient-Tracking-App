import { readFile, writeFile } from "node:fs/promises";

// Orval v8 gives a path Zod schema and a query TypeScript interface the same
// operation-based name. The API-Zod barrel exports both, so keep the runtime
// schema name and make the type's query purpose explicit.
const fixes = [
  ["../api-zod/src/generated/types/getOfficePatientRecordParams.ts", "GetOfficePatientRecord"],
  ["../api-zod/src/generated/types/updateOfficePatientFollowUpParams.ts", "UpdateOfficePatientFollowUp"],
];
for (const [path, operation] of fixes) {
  const source = await readFile(path, "utf8");
  const output = source.replace(`export type ${operation}Params =`, `export type ${operation}QueryInput =`);
  if (source === output) {
    throw new Error(`Expected generated ${operation} parameter type was not found.`);
  }
  await writeFile(path, output);
}
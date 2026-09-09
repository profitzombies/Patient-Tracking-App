import { readFile, writeFile } from "node:fs/promises";

// Orval v8 gives a path Zod schema and a query TypeScript interface the same
// operation-based name. The API-Zod barrel exports both, so keep the runtime
// schema name and make the type's query purpose explicit.
const fixes = [
  ["../api-zod/src/generated/types/getOfficePatientRecordParams.ts", "GetOfficePatientRecord"],
  ["../api-zod/src/generated/types/updateOfficePatientFollowUpParams.ts", "UpdateOfficePatientFollowUp"],
  ["../api-zod/src/generated/types/getOfficeConversationEventsParams.ts", "GetOfficeConversationEvents"],
  ["../api-zod/src/generated/types/assignOfficeConversationParams.ts", "AssignOfficeConversation"],
  ["../api-zod/src/generated/types/setOfficeConversationStatusParams.ts", "SetOfficeConversationStatus"],
  ["../api-zod/src/generated/types/replyOfficeConversationParams.ts", "ReplyOfficeConversation"],
  ["../api-zod/src/generated/types/getOfficeConversationNotesParams.ts", "GetOfficeConversationNotes"],
  ["../api-zod/src/generated/types/addOfficeConversationNoteParams.ts", "AddOfficeConversationNote"],
  ["../api-zod/src/generated/types/escalateOfficeConversationParams.ts", "EscalateOfficeConversation"],
  ["../api-zod/src/generated/types/catalogFamilyParams.ts", "CatalogFamily"],
];
for (const [path, operation] of fixes) {
  const source = await readFile(path, "utf8");
  const output = source.replace(`export type ${operation}Params =`, `export type ${operation}QueryInput =`);
  if (source === output) {
    throw new Error(`Expected generated ${operation} parameter type was not found.`);
  }
  await writeFile(path, output);
}
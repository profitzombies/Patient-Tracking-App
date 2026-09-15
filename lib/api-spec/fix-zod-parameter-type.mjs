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
  ["../api-zod/src/generated/types/readOfficeConversationParams.ts", "ReadOfficeConversation"],
  ["../api-zod/src/generated/types/getOfficeConversationNotesParams.ts", "GetOfficeConversationNotes"],
  ["../api-zod/src/generated/types/addOfficeConversationNoteParams.ts", "AddOfficeConversationNote"],
  ["../api-zod/src/generated/types/escalateOfficeConversationParams.ts", "EscalateOfficeConversation"],
  ["../api-zod/src/generated/types/catalogFamilyParams.ts", "CatalogFamily"],
  ["../api-zod/src/generated/types/listBloodworkReportsParams.ts", "ListBloodworkReports"],
  ["../api-zod/src/generated/types/getBloodworkReportParams.ts", "GetBloodworkReport"],
  ["../api-zod/src/generated/types/deleteBloodworkReportParams.ts", "DeleteBloodworkReport"],
  ["../api-zod/src/generated/types/retryBloodworkExtractionParams.ts", "RetryBloodworkExtraction"],
  ["../api-zod/src/generated/types/getBloodworkFileSourceParams.ts", "GetBloodworkFileSource"],
  ["../api-zod/src/generated/types/getBloodworkFilePageParams.ts", "GetBloodworkFilePage"],
  ["../api-zod/src/generated/types/correctBloodworkResultParams.ts", "CorrectBloodworkResult"],
  ["../api-zod/src/generated/types/listBloodworkCorrectionsParams.ts", "ListBloodworkCorrections"],
  ["../api-zod/src/generated/types/getPatientCareTeamMessagesParams.ts", "GetPatientCareTeamMessages"],
  ["../api-zod/src/generated/types/getHqConversationEventsParams.ts", "GetHqConversationEvents"],
  ["../api-zod/src/generated/types/getPatientCoachConversationParams.ts", "GetPatientCoachConversation"],
  ["../api-zod/src/generated/types/getOfficePatientCoachConversationParams.ts", "GetOfficePatientCoachConversation"],
  ["../api-zod/src/generated/types/listOfficePatientCoachConversationsParams.ts", "ListOfficePatientCoachConversations"],
  ["../api-zod/src/generated/types/listOfficePatientCoachMemoriesParams.ts", "ListOfficePatientCoachMemories"],
  ["../api-zod/src/generated/types/getOfficeFileContentParams.ts", "GetOfficeFileContent"],
  ["../api-zod/src/generated/types/getOfficeFileDownloadParams.ts", "GetOfficeFileDownload"],
  ["../api-zod/src/generated/types/markOfficeAlertSeenParams.ts", "MarkOfficeAlertSeen"],
];
for (const [path, operation] of fixes) {
  const source = await readFile(path, "utf8");
  const output = source.replace(`export type ${operation}Params =`, `export type ${operation}QueryInput =`);
  if (source === output) {
    throw new Error(`Expected generated ${operation} parameter type was not found.`);
  }
  await writeFile(path, output);
}

const bodyFixes = [
  ["markOfficeAlertSeenBody.ts", "MarkOfficeAlertSeenBody"],
  ["updateOfficeAlertPreferencesBody.ts", "UpdateOfficeAlertPreferencesBody"],
  ["registerStaffNotificationDeviceBody.ts", "RegisterStaffNotificationDeviceBody"],
  ["unregisterStaffNotificationDeviceBody.ts", "UnregisterStaffNotificationDeviceBody"],
];
for (const [file, name] of bodyFixes) {
  const path = `../api-zod/src/generated/types/${file}`;
  const source = await readFile(path, "utf8");
  const output = source.replace(`export type ${name} =`, `export type ${name}Input =`);
  if (source === output) throw new Error(`Expected generated ${name} type was not found.`);
  await writeFile(path, output);
}
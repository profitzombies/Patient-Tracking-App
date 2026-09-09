import { supabaseAdmin } from "../lib/supabase-admin";

const enc = encodeURIComponent;

export interface ReportRow {
  id: string;
  patient_id: string;
  title: string;
  report_date: string | null;
  uploaded_at: string;
  version: number;
  kind: "images" | "pdf";
  extraction_status: "queued" | "processing" | "completed" | "failed";
  extraction_error: string | null;
  lifecycle_status: "staging" | "committed" | "deleted";
}

export interface FileRow {
  id: string;
  patient_id: string;
  report_id: string;
  client_file_id: string;
  position: number;
  declared_mime_type: string;
  declared_size_bytes: number;
  staging_object_path: string;
  object_path: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  page_count: number | null;
  width: number | null;
  height: number | null;
}

interface ResultRow {
  id: string;
  report_id: string;
  source_file_id: string;
  source_page: number;
  position: number;
  test_name: string | null;
  value_text: string | null;
  units: string | null;
  reference_range: string | null;
  lab_flag: string | null;
  uncertain: boolean;
  version: number;
  corrected: boolean;
  updated_at: string;
}

const REPORT_SELECT = "id,patient_id,title,report_date,uploaded_at,version,kind,extraction_status,extraction_error,lifecycle_status";
const FILE_SELECT = "id,patient_id,report_id,client_file_id,position,declared_mime_type,declared_size_bytes,staging_object_path,object_path,mime_type,size_bytes,page_count,width,height";
const RESULT_SELECT = "id,report_id,source_file_id,source_page,position,test_name,value_text,units,reference_range,lab_flag,uncertain,version,corrected,updated_at";

function ensureRows<T>(status: number, json: unknown, label: string): T[] {
  if (status >= 300 || !Array.isArray(json)) throw new Error(`${label} failed (${status})`);
  return json as T[];
}

export async function fetchAllRows<T>(path: string, label: string, maximum = 20_000): Promise<T[]> {
  const out: T[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let offset = 0; offset < maximum;) {
    const pageSize = Math.min(500, maximum - offset);
    const response = await supabaseAdmin("GET", `${path}${separator}limit=${pageSize}&offset=${offset}`);
    const page = ensureRows<T>(response.status, response.json, label);
    out.push(...page);
    if (page.length < pageSize) return out;
    offset += pageSize;
  }
  // Exactly hitting the safety ceiling is ambiguous: never return a
  // potentially truncated successful clinical response.
  const probe = await supabaseAdmin("GET", `${path}${separator}limit=1&offset=${maximum}`);
  const overflow = ensureRows<T>(probe.status, probe.json, label);
  if (overflow.length > 0) throw new Error(`${label} exceeds safe result limit`);
  return out;
}

export function reportDto(row: ReportRow, files: FileRow[]) {
  return {
    id: row.id,
    patientId: row.patient_id,
    title: row.title,
    reportDate: row.report_date,
    uploadedAt: row.uploaded_at,
    version: row.version,
    kind: row.kind,
    fileCount: files.length,
    pageCount: files.reduce((sum, file) => sum + Number(file.page_count ?? 0), 0),
    extractionStatus: row.extraction_status,
    extractionError: row.extraction_error,
    reviewStatus: "unreviewed" as const,
  };
}

export function fileDto(row: FileRow) {
  return {
    id: row.id, position: row.position, mimeType: row.mime_type!,
    size: Number(row.size_bytes), pageCount: Number(row.page_count),
    width: row.width, height: row.height,
  };
}

export function resultDto(row: ResultRow) {
  return {
    id: row.id, reportId: row.report_id, sourceFileId: row.source_file_id,
    sourcePage: row.source_page, position: row.position, testName: row.test_name,
    valueText: row.value_text, units: row.units, referenceRange: row.reference_range,
    labFlag: row.lab_flag, uncertain: row.uncertain, version: row.version,
    reviewStatus: "unreviewed" as const, updatedAt: row.updated_at, corrected: row.corrected,
  };
}

export async function loadReport(patientId: string, reportId: string, includeStaging = false) {
  const status = includeStaging ? "in.(staging,committed)" : "eq.committed";
  const reports = await supabaseAdmin("GET",
    `/rest/v1/patient_bloodwork_reports?id=eq.${enc(reportId)}&patient_id=eq.${enc(patientId)}&lifecycle_status=${status}&select=${REPORT_SELECT}&limit=1`);
  const report = ensureRows<ReportRow>(reports.status, reports.json, "bloodwork report read")[0];
  if (!report) return null;
  const [files, results] = await Promise.all([
    fetchAllRows<FileRow>(`/rest/v1/patient_bloodwork_files?report_id=eq.${enc(reportId)}&select=${FILE_SELECT}&order=position.asc`, "bloodwork files read", 20),
    fetchAllRows<ResultRow>(`/rest/v1/patient_bloodwork_results?report_id=eq.${enc(reportId)}&select=${RESULT_SELECT}&order=source_file_id.asc,source_page.asc,position.asc`, "bloodwork results read"),
  ]);
  return {
    report,
    files,
    results,
  };
}

export async function detailDto(patientId: string, reportId: string) {
  const loaded = await loadReport(patientId, reportId);
  if (!loaded) return null;
  return {
    report: reportDto(loaded.report, loaded.files),
    files: loaded.files.map(fileDto),
    results: loaded.results.map(resultDto),
  };
}

export async function rpc(name: string, body: Record<string, unknown>) {
  const response = await supabaseAdmin("POST", `/rest/v1/rpc/${name}`, body);
  if (response.status >= 300) throw Object.assign(new Error(`${name} failed (${response.status})`), {
    status: response.status,
    code: typeof response.json?.message === "string" ? response.json.message : "",
  });
  return response.json;
}

export { REPORT_SELECT, FILE_SELECT, RESULT_SELECT, ensureRows };
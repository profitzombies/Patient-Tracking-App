import { objectStorage } from "../../lib/objectStorage";
import { supabaseAdmin } from "../../lib/supabase-admin";
import { BLOODWORK_MAX_FILE_BYTES, renderBloodworkPage } from "../../bloodwork/documents";
import {
  BloodworkTranscriptionError,
  transcribeBloodworkPage,
  type BloodworkTranscription,
} from "../../bloodwork/extraction";
import type { JobContext, JobDefinition } from "../types";

interface LeasedReport {
  id: string;
  patient_id: string;
  extraction_lease_token: string;
}

interface WorkFile {
  id: string;
  object_path: string;
  mime_type: string;
  page_count: number;
  position: number;
}

async function callRpc(name: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await supabaseAdmin("POST", `/rest/v1/rpc/${name}`, body);
  if (response.status >= 300) throw new Error(`${name} failed (${response.status})`);
  return response.json;
}

function safeFailure(error: unknown): string {
  if (error instanceof BloodworkTranscriptionError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = String(error.code);
    if (/^[A-Z_]{2,40}$/.test(code)) return code;
  }
  return "EXTRACTION_FAILED";
}

export async function runBloodworkExtraction(ctx: JobContext): Promise<void> {
  if (ctx.dryRun) {
    const queued = await supabaseAdmin("GET",
      "/rest/v1/patient_bloodwork_reports?lifecycle_status=eq.committed&extraction_status=eq.queued&select=id&limit=10");
    if (queued.status >= 300 || !Array.isArray(queued.json)) throw new Error(`bloodwork queue check failed (${queued.status})`);
    ctx.tally("wouldProcess", queued.json.length);
    return;
  }
  const leased = await callRpc("bloodwork_lease_extraction", { p_limit: 1, p_lease_seconds: 600 });
  if (!Array.isArray(leased) || leased.length === 0) return;
  const report = leased[0] as LeasedReport;
  ctx.tally("leased");
  const deadlineAt = Date.now() + 7 * 60_000;
  const maxPagesThisRun = 4;
  let processedThisRun = 0;
  try {
    const filesResponse = await supabaseAdmin("GET",
      `/rest/v1/patient_bloodwork_files?report_id=eq.${encodeURIComponent(report.id)}` +
      "&select=id,object_path,mime_type,page_count,position&order=position.asc");
    if (filesResponse.status >= 300 || !Array.isArray(filesResponse.json)) {
      throw new Error(`bloodwork worker files failed (${filesResponse.status})`);
    }
    const files = filesResponse.json as WorkFile[];
    const savedResponse = await supabaseAdmin("GET",
      `/rest/v1/patient_bloodwork_extraction_pages?report_id=eq.${encodeURIComponent(report.id)}` +
      "&select=source_file_id,source_page&limit=101");
    if (savedResponse.status >= 300 || !Array.isArray(savedResponse.json)) {
      throw new Error(`bloodwork worker progress failed (${savedResponse.status})`);
    }
    const saved = new Set((savedResponse.json as Array<{ source_file_id: string; source_page: number }>)
      .map((row) => `${row.source_file_id}:${row.source_page}`));
    const expectedPages = files.reduce((sum, file) => sum + file.page_count, 0);
    for (const file of files) {
      if (processedThisRun >= maxPagesThisRun || Date.now() >= deadlineAt) break;
      const { bytes } = await objectStorage.readObjectBounded(file.object_path, BLOODWORK_MAX_FILE_BYTES);
      for (let page = 1; page <= file.page_count; page += 1) {
        const key = `${file.id}:${page}`;
        if (saved.has(key)) continue;
        if (processedThisRun >= maxPagesThisRun || Date.now() >= deadlineAt) break;
        ctx.checkpoint();
        const renewed = await callRpc("bloodwork_renew_extraction", {
          p_report_id: report.id, p_lease_token: report.extraction_lease_token, p_lease_seconds: 600,
        });
        if (renewed !== true) throw new Error("bloodwork extraction lease no longer owned");
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), Math.max(1, deadlineAt - Date.now()));
        timer.unref();
        let results: BloodworkTranscription[];
        try {
          const rendered = await renderBloodworkPage(bytes, file.mime_type, page, deadline.signal);
          results = await transcribeBloodworkPage({
            bytes: rendered.bytes,
            mimeType: rendered.mimeType,
            sourceFileId: file.id,
            sourcePage: page,
          }, deadline.signal);
        } finally {
          clearTimeout(timer);
        }
        const savedPage = await callRpc("bloodwork_save_extraction_page", {
          p_report_id: report.id, p_lease_token: report.extraction_lease_token,
          p_source_file_id: file.id, p_source_page: page,
          p_results: results.map(({ sourceFileId: _file, sourcePage: _page, ...value }) => value),
        });
        if (savedPage !== true) throw new Error("bloodwork extraction lease no longer owned");
        saved.add(key);
        processedThisRun += 1;
        ctx.tally("pages");
      }
    }
    ctx.checkpoint();
    if (saved.size === expectedPages) {
      const renewed = await callRpc("bloodwork_renew_extraction", {
        p_report_id: report.id, p_lease_token: report.extraction_lease_token, p_lease_seconds: 600,
      });
      if (renewed !== true) throw new Error("bloodwork extraction lease no longer owned");
      ctx.checkpoint();
      const completed = await callRpc("bloodwork_complete_extraction_from_pages", {
        p_report_id: report.id, p_lease_token: report.extraction_lease_token,
      });
      if (completed !== true) throw new Error("bloodwork extraction completion refused");
      ctx.tally("reportsCompleted");
    } else {
      const released = await callRpc("bloodwork_release_extraction", {
        p_report_id: report.id, p_lease_token: report.extraction_lease_token,
      });
      if (released !== true) throw new Error("bloodwork extraction release refused");
      ctx.tally("reportsContinued");
    }
  } catch (error) {
    const code = safeFailure(error);
    await callRpc("bloodwork_fail_extraction", {
      p_report_id: report.id,
      p_lease_token: report.extraction_lease_token,
      p_error: code,
    }).catch(() => undefined);
    ctx.failItem(report.id, code);
  }
}

export const bloodworkExtractionJob: JobDefinition = {
  name: "bloodwork-extraction",
  title: "Bloodwork transcription",
  description: "Transcribes one committed private report at a time and atomically saves every page's unreviewed results.",
  intervalMs: 60_000,
  leaseSeconds: 4 * 60 * 60,
  run: runBloodworkExtraction,
};
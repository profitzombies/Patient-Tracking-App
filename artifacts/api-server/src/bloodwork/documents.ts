import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const BLOODWORK_MAX_FILE_BYTES = 20_000_000;
export const BLOODWORK_MAX_PDF_PAGES = 100;
export const BLOODWORK_MAX_IMAGE_PIXELS = 40_000_000;
export const BLOODWORK_RENDER_LONG_EDGE = 2_800;

export type BloodworkMimeType = "application/pdf" | "image/jpeg" | "image/png";
export type BloodworkDocumentErrorCode =
  | "EMPTY_FILE" | "FILE_TOO_LARGE" | "UNSUPPORTED_TYPE" | "TYPE_MISMATCH"
  | "CORRUPT_FILE" | "ENCRYPTED_PDF" | "TOO_MANY_PAGES" | "IMAGE_TOO_LARGE"
  | "PAGE_OUT_OF_RANGE" | "RENDER_FAILED" | "PROCESSING_TIMEOUT"
  | "PROCESSING_LIMIT" | "PROCESSING_BUSY";

export class BloodworkDocumentError extends Error {
  constructor(
    public readonly code: BloodworkDocumentErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BloodworkDocumentError";
    Object.setPrototypeOf(this, BloodworkDocumentError.prototype);
  }
}

const MAX_CONCURRENT_WORKERS = 1;
const MAX_QUEUED_WORKERS = 4;
const WORKER_DEADLINE_MS = 30_000;
const MAX_PREPARED_PAGES = 2;
const WORKER_RSS_BYTES = 384 * 1024 * 1024;
const MAX_WORKER_OUTPUT_BYTES = 42_000_000;

type Task = {
  bytes: Uint8Array;
  metadata: WorkerMetadata;
  signal?: AbortSignal;
  queuedAbort?: () => void;
  resolve: (value: WorkerReply) => void;
  reject: (error: unknown) => void;
};
type WorkerMetadata =
  | { operation: "inspect"; mime: string }
  | {
    operation: "prepare";
    mime: string;
    pages: number[];
    admission: BloodworkPageAdmission;
  };
type PreparedWorkerPage = {
  page: number;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  outputBytes: number;
};
type WorkerReply = {
  result: {
    mimeType: BloodworkMimeType;
    pageCount: number;
    width?: number | null;
    height?: number | null;
    pages?: PreparedWorkerPage[];
  };
  output: Buffer;
};

export type BloodworkPageAdmission = {
  sha256: string | null;
  pageCount: number;
};

export type PreparedBloodworkPage = {
  page: number;
  bytes: Buffer;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
};

let active = 0;
const queue: Task[] = [];

function documentError(code: BloodworkDocumentErrorCode, message: string): BloodworkDocumentError {
  return new BloodworkDocumentError(code, message);
}

function workerLocation(): URL {
  const location = import.meta.url.endsWith(".ts")
    ? new URL("./document-worker.ts", import.meta.url)
    : new URL("./document-worker.mjs", import.meta.url);
  // The worker is a separately emitted production artifact. Do not silently
  // fall back to parsing untrusted files in this process if packaging omitted it.
  if (!existsSync(fileURLToPath(location))) {
    throw documentError("PROCESSING_LIMIT", "Document processing worker is unavailable.");
  }
  return location;
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  child.kill("SIGKILL");
}

async function rssBytes(pid: number): Promise<number> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

function execute(task: Task): void {
  active++;
  if (task.queuedAbort) task.signal?.removeEventListener("abort", task.queuedAbort);
  let location: URL;
  try {
    location = workerLocation();
  } catch (error) {
    active--;
    task.reject(error);
    drain();
    return;
  }
  const child = spawn(
    process.execPath,
    [
      "--max-old-space-size=192",
      "--disable-warning=ExperimentalWarning",
      ...(location.pathname.endsWith(".ts") ? ["--experimental-transform-types"] : []),
      location.pathname,
    ],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "production" } },
  );
  const output: Buffer[] = [];
  let outputLength = 0;
  let settled = false;
  let forcedError: BloodworkDocumentError | undefined;

  const finish = (error?: unknown, reply?: WorkerReply) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    clearInterval(watchdog);
    task.signal?.removeEventListener("abort", abort);
    active--;
    error ? task.reject(error) : task.resolve(reply!);
    drain();
  };
  const abort = () => {
    forcedError = documentError("PROCESSING_TIMEOUT", "Document processing was cancelled.");
    terminate(child);
  };
  task.signal?.addEventListener("abort", abort, { once: true });
  if (task.signal?.aborted) abort();
  // A two-page operation remains one isolated worker, but receives the
  // equivalent bounded budget of two former single-page operations.
  const deadlineMs = task.metadata.operation === "prepare"
    ? WORKER_DEADLINE_MS * task.metadata.pages.length
    : WORKER_DEADLINE_MS;
  const deadline = setTimeout(() => {
    forcedError = documentError("PROCESSING_TIMEOUT", "Document processing took too long. Export a simpler document and retry.");
    terminate(child);
  }, deadlineMs);
  const watchdog = setInterval(() => {
    if (!child.pid) return;
    void rssBytes(child.pid).then((rss) => {
      if (!settled && rss > WORKER_RSS_BYTES) {
        forcedError = documentError("PROCESSING_LIMIT", "This document needs too much memory to process safely.");
        terminate(child);
      }
    });
  }, 50);
  watchdog.unref();

  child.stdout.on("data", (chunk: Buffer) => {
    outputLength += chunk.length;
    if (outputLength > MAX_WORKER_OUTPUT_BYTES) {
      forcedError = documentError("PROCESSING_LIMIT", "This document produced too much data to process safely.");
      terminate(child);
      return;
    }
    output.push(Buffer.from(chunk));
  });
  // Worker stderr can contain parser details or document text; deliberately discard it.
  child.stderr.resume();
  child.on("error", () => finish(documentError("PROCESSING_LIMIT", "Document processing could not be started safely.")));
  child.on("close", () => {
    if (forcedError) return finish(forcedError);
    try {
      const bytes = Buffer.concat(output);
      if (bytes.length < 4) throw new Error("missing response");
      const length = bytes.readUInt32BE(0);
      if (length > 65_536 || 4 + length > bytes.length) throw new Error("invalid response");
      const metadata = JSON.parse(bytes.subarray(4, 4 + length).toString()) as {
        ok: boolean; code?: BloodworkDocumentErrorCode; message?: string; result?: WorkerReply["result"];
      };
      if (!metadata.ok || !metadata.result) {
        return finish(documentError(metadata.code ?? "CORRUPT_FILE", metadata.message ?? "This document could not be processed safely."));
      }
      finish(undefined, { result: metadata.result, output: bytes.subarray(4 + length) });
    } catch {
      finish(documentError("CORRUPT_FILE", "This document could not be processed safely. Export it again and retry."));
    }
  });

  const metadata = Buffer.from(JSON.stringify(task.metadata));
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(metadata.length);
  child.stdin.on("error", () => undefined);
  child.stdin.write(header);
  child.stdin.write(metadata);
  child.stdin.end(Buffer.from(task.bytes.buffer, task.bytes.byteOffset, task.bytes.byteLength));
}

function drain(): void {
  while (active < MAX_CONCURRENT_WORKERS && queue.length) execute(queue.shift()!);
}

function runWorker(task: Omit<Task, "resolve" | "reject">): Promise<WorkerReply> {
  if (task.signal?.aborted) {
    return Promise.reject(documentError("PROCESSING_TIMEOUT", "Document processing was cancelled."));
  }
  if (task.bytes.byteLength === 0) return Promise.reject(documentError("EMPTY_FILE", "The selected report is empty. Choose it again."));
  if (task.bytes.byteLength > BLOODWORK_MAX_FILE_BYTES) return Promise.reject(documentError("FILE_TOO_LARGE", "Bloodwork files must be 20 MB or smaller."));
  if (queue.length >= MAX_QUEUED_WORKERS) {
    return Promise.reject(documentError("PROCESSING_BUSY", "Document processing is busy. Retry shortly."));
  }
  return new Promise((resolve, reject) => {
    const queued = { ...task, resolve, reject };
    const abortWhileQueued = () => {
      const index = queue.indexOf(queued);
      if (index === -1) return;
      queue.splice(index, 1);
      task.signal?.removeEventListener("abort", abortWhileQueued);
      reject(documentError("PROCESSING_TIMEOUT", "Document processing was cancelled."));
      drain();
    };
    queued.queuedAbort = abortWhileQueued;
    task.signal?.addEventListener("abort", abortWhileQueued, { once: true });
    if (task.signal?.aborted) {
      abortWhileQueued();
      return;
    }
    queue.push(queued);
    drain();
  });
}

function immutableBytes(bytes: Uint8Array): Buffer {
  if (bytes.byteLength === 0) {
    throw documentError("EMPTY_FILE", "The selected report is empty. Choose it again.");
  }
  if (bytes.byteLength > BLOODWORK_MAX_FILE_BYTES) {
    throw documentError("FILE_TOO_LARGE", "Bloodwork files must be 20 MB or smaller.");
  }
  return Buffer.from(bytes);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function inspectBloodworkFile(
  bytes: Uint8Array,
  declaredMime: string,
  signal?: AbortSignal,
): Promise<{
  mimeType: BloodworkMimeType;
  pageCount: number;
  width: number | null;
  height: number | null;
  sha256: string;
}> {
  // Hash and process the same private snapshot; callers retaining a mutable
  // Uint8Array cannot change the bytes represented by the receipt.
  const input = immutableBytes(bytes);
  const digest = sha256(input);
  const result = (await runWorker({ bytes: input, metadata: { operation: "inspect", mime: declaredMime }, signal })).result;
  return {
    mimeType: result.mimeType,
    pageCount: result.pageCount,
    width: result.width ?? null,
    height: result.height ?? null,
    sha256: digest,
  };
}

function requireMatchingAdmission(
  input: Uint8Array,
  admission: BloodworkPageAdmission,
): void {
  if (admission.sha256 === null) return;
  if (
    !/^[a-f0-9]{64}$/.test(admission.sha256) ||
    !Number.isSafeInteger(admission.pageCount) ||
    admission.pageCount < 1 ||
    admission.pageCount > BLOODWORK_MAX_PDF_PAGES ||
    sha256(input) !== admission.sha256
  ) {
    throw documentError("CORRUPT_FILE", "This document does not match its admitted contents. Upload it again.");
  }
}

function validPageRequest(pages: number[]): void {
  if (
    !Array.isArray(pages) ||
    pages.length < 1 ||
    pages.length > MAX_PREPARED_PAGES ||
    pages.some((page) => !Number.isSafeInteger(page) || page < 1) ||
    new Set(pages).size !== pages.length
  ) {
    throw documentError("PAGE_OUT_OF_RANGE", "Choose one or two valid document pages.");
  }
}

export async function prepareBloodworkPages(
  bytes: Uint8Array,
  mimeType: string,
  pages: number[],
  admission: BloodworkPageAdmission,
  signal?: AbortSignal,
): Promise<PreparedBloodworkPage[]> {
  validPageRequest(pages);
  const requestedPages = [...pages];
  const admitted: BloodworkPageAdmission = { sha256: admission.sha256, pageCount: admission.pageCount };
  const input = immutableBytes(bytes);
  requireMatchingAdmission(input, admitted);
  if (admitted.sha256 !== null && requestedPages.some((page) => page > admitted.pageCount)) {
    throw documentError("PAGE_OUT_OF_RANGE", `Choose a page between 1 and ${admitted.pageCount}.`);
  }
  const reply = await runWorker({
    bytes: input,
    metadata: { operation: "prepare", mime: mimeType, pages: requestedPages, admission: admitted },
    signal,
  });
  const prepared = reply.result.pages;
  if (!prepared || prepared.length !== requestedPages.length) {
    throw documentError("CORRUPT_FILE", "This document could not be processed safely. Export it again and retry.");
  }
  let offset = 0;
  const output = prepared.map((item, index) => {
    if (
      item.page !== requestedPages[index] ||
      !Number.isSafeInteger(item.outputBytes) ||
      item.outputBytes < 1 ||
      offset + item.outputBytes > reply.output.length ||
      !Number.isSafeInteger(item.width) ||
      !Number.isSafeInteger(item.height) ||
      item.width < 1 ||
      item.height < 1 ||
      (item.mimeType !== "image/jpeg" && item.mimeType !== "image/png")
    ) {
      throw documentError("CORRUPT_FILE", "This document could not be processed safely. Export it again and retry.");
    }
    const pageBytes = Buffer.from(reply.output.subarray(offset, offset + item.outputBytes));
    offset += item.outputBytes;
    return { page: item.page, bytes: pageBytes, mimeType: item.mimeType, width: item.width, height: item.height };
  });
  if (offset !== reply.output.length) {
    throw documentError("CORRUPT_FILE", "This document could not be processed safely. Export it again and retry.");
  }
  return output;
}

export async function renderBloodworkPage(
  bytes: Uint8Array,
  mimeType: string,
  page: number,
  signal?: AbortSignal,
  admission: BloodworkPageAdmission = { sha256: null, pageCount: 0 },
): Promise<{ bytes: Buffer; mimeType: "image/jpeg" | "image/png"; width: number; height: number }> {
  const [prepared] = await prepareBloodworkPages(bytes, mimeType, [page], admission, signal);
  return {
    bytes: prepared!.bytes,
    mimeType: prepared!.mimeType,
    width: prepared!.width,
    height: prepared!.height,
  };
}
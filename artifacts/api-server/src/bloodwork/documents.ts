import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";

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
const WORKER_RSS_BYTES = 384 * 1024 * 1024;
const MAX_WORKER_OUTPUT_BYTES = 42_000_000;

type Task = {
  bytes: Uint8Array;
  metadata: { operation: "inspect" | "render"; mime: string; page?: number };
  signal?: AbortSignal;
  resolve: (value: WorkerReply) => void;
  reject: (error: unknown) => void;
};
type WorkerReply = {
  result: { mimeType: BloodworkMimeType; pageCount: number; width: number | null; height: number | null };
  output: Buffer;
};

let active = 0;
const queue: Task[] = [];

function documentError(code: BloodworkDocumentErrorCode, message: string): BloodworkDocumentError {
  return new BloodworkDocumentError(code, message);
}

function workerLocation(): URL {
  return import.meta.url.endsWith(".ts")
    ? new URL("./document-worker.ts", import.meta.url)
    : new URL("./document-worker.mjs", import.meta.url);
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
  const location = workerLocation();
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
  const deadline = setTimeout(() => {
    forcedError = documentError("PROCESSING_TIMEOUT", "Document processing took too long. Export a simpler document and retry.");
    terminate(child);
  }, WORKER_DEADLINE_MS);
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
    queue.push({ ...task, resolve, reject });
    drain();
  });
}

export async function inspectBloodworkFile(
  bytes: Uint8Array,
  declaredMime: string,
  signal?: AbortSignal,
): Promise<{ mimeType: BloodworkMimeType; pageCount: number; width: number | null; height: number | null }> {
  return (await runWorker({ bytes, metadata: { operation: "inspect", mime: declaredMime }, signal })).result;
}

export async function renderBloodworkPage(
  bytes: Uint8Array,
  mimeType: string,
  page: number,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; mimeType: "image/jpeg" | "image/png"; width: number; height: number }> {
  const reply = await runWorker({ bytes, metadata: { operation: "render", mime: mimeType, page }, signal });
  if (reply.result.mimeType !== "application/pdf" && reply.output.length === 0) {
    return { bytes: Buffer.from(bytes), mimeType: reply.result.mimeType, width: reply.result.width!, height: reply.result.height! };
  }
  return { bytes: reply.output, mimeType: "image/png", width: reply.result.width!, height: reply.result.height! };
}
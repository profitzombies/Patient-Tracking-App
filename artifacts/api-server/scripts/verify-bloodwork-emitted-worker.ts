/**
 * Production emitted-worker smoke test.
 *
 * Run after `pnpm run build`:
 *   pnpm exec tsx scripts/verify-bloodwork-emitted-worker.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workerPath = fileURLToPath(new URL("../dist/document-worker.mjs", import.meta.url));

type WorkerResponse = {
  ok: boolean;
  code?: string;
  result?: {
    pages?: Array<{ page: number; mimeType: string; outputBytes: number }>;
  };
};

function syntheticTwoPagePdf(): Buffer {
  const streams = [
    "BT /F1 14 Tf 60 740 Td (EMITTED WORKER SMOKE PAGE 1) Tj ET",
    "BT /F1 14 Tf 60 560 Td (EMITTED WORKER SMOKE PAGE 2) Tj ET",
  ];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...streams.map((stream) => `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`),
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  return Buffer.from(
    `${body}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}

async function invoke(metadata: object, bytes: Buffer): Promise<{ metadata: WorkerResponse; output: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      const response = Buffer.concat(stdout);
      if (code !== 0 || response.length < 4) {
        reject(new Error(`Emitted document worker failed (${code}): ${Buffer.concat(stderr).toString()}`));
        return;
      }
      const metadataLength = response.readUInt32BE(0);
      if (metadataLength > 65_536 || metadataLength + 4 > response.length) {
        reject(new Error("Emitted document worker returned an invalid frame."));
        return;
      }
      try {
        resolve({
          metadata: JSON.parse(response.subarray(4, 4 + metadataLength).toString()) as WorkerResponse,
          output: response.subarray(4 + metadataLength),
        });
      } catch {
        reject(new Error("Emitted document worker returned invalid JSON."));
      }
    });
    const encoded = Buffer.from(JSON.stringify(metadata));
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(encoded.length);
    child.stdin.end(Buffer.concat([header, encoded, bytes]));
  });
}

if (!existsSync(workerPath)) {
  throw new Error("Missing dist/document-worker.mjs. Run `pnpm run build` before this smoke test.");
}

const healthy = await invoke(
  {
    operation: "prepare",
    mime: "application/pdf",
    pages: [1, 2],
    admission: { sha256: "a".repeat(64), pageCount: 2 },
  },
  syntheticTwoPagePdf(),
);
assert.equal(healthy.metadata.ok, true, "healthy PDF must be accepted by emitted worker");
assert.deepEqual(
  healthy.metadata.result?.pages?.map((page) => page.page),
  [1, 2],
  "emitted worker must return both requested pages",
);
assert.ok(
  healthy.metadata.result?.pages?.every((page) => page.mimeType === "image/png" && page.outputBytes > 0),
  "emitted worker must frame both rendered PNG pages",
);
assert.equal(healthy.output.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

const malformed = await invoke(
  {
    operation: "prepare",
    mime: "application/pdf",
    pages: [1],
    admission: { sha256: null, pageCount: 0 },
  },
  Buffer.from("%PDF-1.7\nnot a valid PDF"),
);
assert.equal(malformed.metadata.ok, false, "malformed PDF must be rejected by emitted worker");
assert.equal(malformed.metadata.code, "CORRUPT_FILE");

console.log("Emitted bloodwork document worker smoke test passed.");
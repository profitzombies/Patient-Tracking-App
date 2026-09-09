// @ts-ignore Node executes this .ts entry directly in tests; esbuild bundles it for production.
import { inspectInWorker, renderInWorker, WorkerDocumentError } from "./document-worker-core.ts";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = Buffer.concat(chunks);

function send(metadata: object, output?: Buffer): void {
  const encoded = Buffer.from(JSON.stringify(metadata));
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(encoded.length);
  process.stdout.write(header);
  process.stdout.write(encoded);
  if (output) process.stdout.write(output);
}

try {
  if (input.length < 4) throw new Error("invalid input");
  const metadataLength = input.readUInt32BE(0);
  if (metadataLength > 16_384 || 4 + metadataLength > input.length) throw new Error("invalid input");
  const metadata = JSON.parse(input.subarray(4, 4 + metadataLength).toString()) as {
    operation: "inspect" | "render";
    mime: string;
    page?: number;
  };
  const bytes = input.subarray(4 + metadataLength);
  const result = metadata.operation === "inspect"
    ? await inspectInWorker(bytes, metadata.mime)
    : await renderInWorker(bytes, metadata.mime, metadata.page ?? 0);
  const { output, ...safe } = result as typeof result & { output?: Buffer };
  send({ ok: true, result: safe }, output);
} catch (error) {
  if (error instanceof WorkerDocumentError) {
    send({ ok: false, code: error.code, message: error.message });
  } else {
    send({ ok: false, code: "CORRUPT_FILE", message: "This document could not be processed safely. Export it again and retry." });
  }
}
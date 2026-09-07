/**
 * Replit App Storage access for hosted training videos.
 *
 * Objects live under TRAINING_OBJECT_DIR when it is set — the dedicated
 * training-video bucket (value shaped like `/<bucket-id>/.private`) — and
 * fall back to PRIVATE_OBJECT_DIR (the app's default bucket) so a fresh
 * setup still works before the dedicated bucket exists. The sidecar at
 * 127.0.0.1:1106 mints credentials and signed URLs — works in the workspace
 * AND in deployments. The database stores only canonical object paths
 * (`/objects/training-videos/<videoId>/<objectId>`); signed URLs are
 * short-lived and minted per request so playback range requests hit storage
 * directly and nothing long-lived ever lands in a table.
 */
import { randomUUID } from "crypto";
import { File, Storage } from "@google-cloud/storage";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

/** Signed upload/download TTLs. Playback URLs outlive the longest lesson. */
export const UPLOAD_URL_TTL_SEC = 900;

/** One stored object as the reconciliation job sees it. */
export interface StoredObjectSummary {
  path: string;
  /** Null when storage reported no usable timestamp (treated as brand new). */
  createdAt: Date | null;
  sizeBytes: number | null;
}
export const PLAYBACK_URL_TTL_SEC = 3 * 60 * 60;

export const THUMBNAIL_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Check the bytes rather than trusting a browser-provided MIME type. This is
 * intentionally a small container validator: thumbnails are displayed as
 * images, so accepting a text file renamed to .jpg (or an arbitrary object
 * under the video prefix) would make the upload contract dishonest.
 */
export function detectThumbnailContentType(content: Buffer): string | null {
  if (content.length >= 24 && content.subarray(0, 8).equals(Buffer.from("\x89PNG\r\n\x1a\n", "binary"))) {
    const width = content.readUInt32BE(16);
    const height = content.readUInt32BE(20);
    return width > 0 && height > 0 && width <= 16_000 && height <= 16_000 && width * height <= 64_000_000
      ? "image/png"
      : null;
  }

  if (content.length >= 4 && content[0] === 0xff && content[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < content.length) {
      if (content[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < content.length && content[offset] === 0xff) offset += 1;
      if (offset >= content.length) break;
      const marker = content[offset++];
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (marker === 0xda) break;
      if (offset + 1 >= content.length) break;
      const segmentLength = content.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > content.length) break;
      const isSizeMarker =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSizeMarker && segmentLength >= 7) {
        const height = content.readUInt16BE(offset + 3);
        const width = content.readUInt16BE(offset + 5);
        return width > 0 && height > 0 && width <= 16_000 && height <= 16_000 && width * height <= 64_000_000
          ? "image/jpeg"
          : null;
      }
      offset += segmentLength;
    }
    return null;
  }

  if (
    content.length >= 16 &&
    content.subarray(0, 4).toString("ascii") === "RIFF" &&
    content.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    const chunk = content.subarray(12, 16).toString("ascii");
    let width = 0;
    let height = 0;
    if (chunk === "VP8X" && content.length >= 30) {
      width = 1 + content[24] + (content[25] << 8) + (content[26] << 16);
      height = 1 + content[27] + (content[28] << 8) + (content[29] << 16);
    } else if (chunk === "VP8 " && content.length >= 30) {
      if (content[23] !== 0x9d || content[24] !== 0x01 || content[25] !== 0x2a) return null;
      width = content.readUInt16LE(26) & 0x3fff;
      height = content.readUInt16LE(28) & 0x3fff;
    } else if (chunk === "VP8L" && content.length >= 26) {
      if (content[20] !== 0x2f) return null;
      width = 1 + (content[21] | (content[22] << 8) | ((content[23] & 0x3f) << 16));
      height = 1 + ((content[23] >> 6) | (content[24] << 2) | ((content[25] & 0xf) << 10));
    } else {
      return null;
    }
    return width > 0 && height > 0 && width <= 16_000 && height <= 16_000 && width * height <= 64_000_000
      ? "image/webp"
      : null;
  }
  return null;
}

function getPrivateObjectDir(): string {
  const dir = process.env.PRIVATE_OBJECT_DIR || "";
  if (!dir) {
    throw new Error(
      "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' tool and set PRIVATE_OBJECT_DIR env var.",
    );
  }
  return dir.replace(/\/$/, "");
}

/**
 * Where training media lives. TRAINING_OBJECT_DIR points every training
 * upload, thumbnail, and playback lookup at the dedicated training bucket;
 * without it everything resolves against the default private dir. One knob —
 * upload and lookup can never disagree about which bucket a path means.
 */
function getTrainingObjectDir(): string {
  const dir = process.env.TRAINING_OBJECT_DIR || "";
  if (!dir) return getPrivateObjectDir();
  const withLeadingSlash = dir.startsWith("/") ? dir : `/${dir}`;
  return withLeadingSlash.replace(/\/$/, "");
}

function parseObjectPath(path: string): { bucketName: string; objectName: string } {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const pathParts = path.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }
  return {
    bucketName: pathParts[1],
    objectName: pathParts.slice(2).join("/"),
  };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
}): Promise<string> {
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
  const response = await fetch(`${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, make sure you're running on Replit`,
    );
  }
  const { signed_url: signedURL } = (await response.json()) as { signed_url: string };
  return signedURL;
}

/** Everything the training-media routes need, keyed by canonical object paths. */
export class ObjectStorageService {
  /**
   * Mint a presigned PUT for a brand-new object under this video's prefix.
   * The returned objectPath is what finalize/database calls must use — the
   * prefix binds the object to the video, so one admin can't graft another
   * video's file onto this row.
   */
  async trainingUploadURL(
    videoId: string,
    kind: "video" | "thumb",
  ): Promise<{ uploadUrl: string; objectPath: string }> {
    const objectId = `${kind}-${randomUUID()}`;
    const objectPath = `/objects/training-videos/${videoId}/${objectId}`;
    const fullPath = `${getTrainingObjectDir()}/training-videos/${videoId}/${objectId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const uploadUrl = await signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: UPLOAD_URL_TTL_SEC,
    });
    return { uploadUrl, objectPath };
  }

  /**
   * Same contract for lesson attachments (worksheets, PDFs, docs, images):
   * a presigned PUT bound to the video's attachment prefix
   * (`/objects/training-attachments/<videoId>/…`) — a folder of its own, so
   * attachment files never mix into the hosted-video folder.
   */
  async trainingAttachmentUploadURL(videoId: string): Promise<{ uploadUrl: string; objectPath: string }> {
    const objectId = `file-${randomUUID()}`;
    const objectPath = `/objects/training-attachments/${videoId}/${objectId}`;
    const fullPath = `${getTrainingObjectDir()}/training-attachments/${videoId}/${objectId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const uploadUrl = await signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: UPLOAD_URL_TTL_SEC,
    });
    return { uploadUrl, objectPath };
  }

  /**
   * Same contract for AI Support knowledge documents: a presigned PUT bound
   * to the document's prefix (`/objects/knowledge-docs/<documentId>/…`), so
   * finalize can verify the uploaded object belongs to that document.
   */
  async knowledgeUploadURL(documentId: string): Promise<{ uploadUrl: string; objectPath: string }> {
    const objectId = `doc-${randomUUID()}`;
    const objectPath = `/objects/knowledge-docs/${documentId}/${objectId}`;
    const fullPath = `${getTrainingObjectDir()}/knowledge-docs/${documentId}/${objectId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const uploadUrl = await signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: UPLOAD_URL_TTL_SEC,
    });
    return { uploadUrl, objectPath };
  }

  /**
   * Per-patient media (custom-food / saved-recipe photos, chat photos,
   * progress photos, and whatever the account carries next): every object
   * lives under the owning patient's id, so OWNERSHIP IS BAKED INTO THE
   * PATH — a finalize or row write can verify a path belongs to the caller
   * with a prefix check alone.
   */
  async patientMediaUploadURL(
    patientId: string,
    kind: "food" | "recipe" | "chat" | "progress",
  ): Promise<{ uploadUrl: string; objectPath: string }> {
    const objectId = `${kind}-${randomUUID()}`;
    const objectPath = `/objects/patient-media/${patientId}/${objectId}`;
    const fullPath = `${getTrainingObjectDir()}/patient-media/${patientId}/${objectId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const uploadUrl = await signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: UPLOAD_URL_TTL_SEC,
    });
    return { uploadUrl, objectPath };
  }

  /** Private HQ document upload, bound to a server-generated metadata id. */
  async hqFileUploadURL(fileId: string): Promise<{ uploadUrl: string; objectPath: string }> {
    const objectId = `file-${randomUUID()}`;
    const objectPath = `/objects/hq-files/${fileId}/${objectId}`;
    const fullPath = `${getTrainingObjectDir()}/hq-files/${fileId}/${objectId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const uploadUrl = await signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: UPLOAD_URL_TTL_SEC,
    });
    return { uploadUrl, objectPath };
  }

  /** Resolve `/objects/...` to the underlying file; throws when absent. */
  async entityFile(objectPath: string): Promise<File> {
    const file = this.fileFor(objectPath);
    const [exists] = await file.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return file;
  }

  /** Short-lived signed GET so <video> range requests stream from storage. */
  async signedDownloadURL(objectPath: string, ttlSec: number = PLAYBACK_URL_TTL_SEC): Promise<string> {
    const { bucketName, objectName } = this.locate(objectPath);
    return signObjectURL({ bucketName, objectName, method: "GET", ttlSec });
  }

  /** Server-side write (thumbnail frames). Overwrites are fine. */
  async saveBuffer(objectPath: string, content: Buffer, contentType: string): Promise<void> {
    await this.fileFor(objectPath).save(content, {
      metadata: { contentType },
      resumable: false,
    });
  }

  /** Best-effort delete for replaced files; missing objects are not errors. */
  async deleteObject(objectPath: string): Promise<void> {
    try {
      await this.deleteObjectStrict(objectPath);
    } catch {
      // Orphaned objects cost pennies; never fail a request over cleanup.
    }
  }

  /**
   * Strict delete for lifecycle paths that must never orphan silently: a
   * missing object still counts as deleted (so retries stay idempotent),
   * but a real storage failure throws — the caller keeps its DB reference
   * to the object and the whole operation can simply be retried.
   */
  async deleteObjectStrict(objectPath: string): Promise<void> {
    await this.fileFor(objectPath).delete({ ignoreNotFound: true });
  }

  /**
   * Every stored `/objects/...` path under a prefix (a patient's media dir).
   * The prefix must end with "/" so `patient-media/<id>` can never match a
   * sibling whose id merely starts the same way.
   */
  async listObjectPaths(objectPrefix: string): Promise<string[]> {
    if (!objectPrefix.endsWith("/")) {
      throw new Error("object prefix must end with /");
    }
    const { bucketName, objectName } = this.locate(objectPrefix);
    const [files] = await objectStorageClient.bucket(bucketName).getFiles({ prefix: objectName });
    const dirObjectName = this.objectsDirName();
    return files
      .map((file) => file.name)
      .filter((name) => name.startsWith(dirObjectName))
      .map((name) => `/objects/${name.slice(dirObjectName.length)}`);
  }

  /**
   * Every stored object under a prefix with its creation time — what the
   * storage reconciliation job compares against the ledgers. Same trailing
   * slash rule as `listObjectPaths`.
   */
  async listObjects(objectPrefix: string): Promise<StoredObjectSummary[]> {
    if (!objectPrefix.endsWith("/")) {
      throw new Error("object prefix must end with /");
    }
    const { bucketName, objectName } = this.locate(objectPrefix);
    const [files] = await objectStorageClient.bucket(bucketName).getFiles({ prefix: objectName });
    const dirObjectName = this.objectsDirName();
    const out: StoredObjectSummary[] = [];
    for (const file of files) {
      if (!file.name.startsWith(dirObjectName)) continue;
      const meta = (file.metadata ?? {}) as { timeCreated?: string; updated?: string; size?: string | number };
      const stamp = meta.timeCreated ?? meta.updated ?? null;
      const createdAt = stamp ? new Date(stamp) : null;
      out.push({
        path: `/objects/${file.name.slice(dirObjectName.length)}`,
        createdAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
        sizeBytes: meta.size == null ? null : Number(meta.size),
      });
    }
    return out;
  }

  /**
   * Strict prefix purge: lists, deletes each object, and returns how many
   * were removed. A missing object is fine (re-runs stay idempotent); a real
   * storage failure throws so the caller retries later.
   */
  async deletePrefixStrict(objectPrefix: string): Promise<number> {
    const paths = await this.listObjectPaths(objectPrefix);
    for (const path of paths) {
      await this.deleteObjectStrict(path);
    }
    return paths.length;
  }

  private fileFor(objectPath: string): File {
    const { bucketName, objectName } = this.locate(objectPath);
    return objectStorageClient.bucket(bucketName).file(objectName);
  }

  /** Object-name prefix that `/objects/` maps to (with trailing slash). */
  private objectsDirName(): string {
    const { objectName } = parseObjectPath(`${getTrainingObjectDir()}/`);
    return objectName.endsWith("/") ? objectName : `${objectName}/`;
  }

  private locate(objectPath: string): { bucketName: string; objectName: string } {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }
    const entityId = objectPath.slice("/objects/".length);
    if (!entityId) {
      throw new ObjectNotFoundError();
    }
    return parseObjectPath(`${getTrainingObjectDir()}/${entityId}`);
  }
}

export const objectStorage = new ObjectStorageService();

/**
 * Replit App Storage access for hosted training videos.
 *
 * Objects live under PRIVATE_OBJECT_DIR (bucket provisioned by the platform;
 * the sidecar at 127.0.0.1:1106 mints credentials and signed URLs — works in
 * the workspace AND in deployments). The database stores only canonical
 * object paths (`/objects/training-videos/<videoId>/<objectId>`); signed URLs
 * are short-lived and minted per request so playback range requests hit
 * storage directly and nothing long-lived ever lands in a table.
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
export const PLAYBACK_URL_TTL_SEC = 3 * 60 * 60;

function getPrivateObjectDir(): string {
  const dir = process.env.PRIVATE_OBJECT_DIR || "";
  if (!dir) {
    throw new Error(
      "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' tool and set PRIVATE_OBJECT_DIR env var.",
    );
  }
  return dir.replace(/\/$/, "");
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
    const fullPath = `${getPrivateObjectDir()}/training-videos/${videoId}/${objectId}`;
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
      await this.fileFor(objectPath).delete({ ignoreNotFound: true });
    } catch {
      // Orphaned objects cost pennies; never fail a request over cleanup.
    }
  }

  private fileFor(objectPath: string): File {
    const { bucketName, objectName } = this.locate(objectPath);
    return objectStorageClient.bucket(bucketName).file(objectName);
  }

  private locate(objectPath: string): { bucketName: string; objectName: string } {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }
    const entityId = objectPath.slice("/objects/".length);
    if (!entityId) {
      throw new ObjectNotFoundError();
    }
    return parseObjectPath(`${getPrivateObjectDir()}/${entityId}`);
  }
}

export const objectStorage = new ObjectStorageService();

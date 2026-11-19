import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { and, eq, lt, or } from "drizzle-orm";
import { db } from "../../config/db";
import {
  caregivers,
  centers,
  providers,
  verificationDocuments,
} from "../../config/schema";
import type { AuthenticatedAdmin } from "../../lib/admin/types";
import { AdminAuthError } from "./admin-auth.service";
import { recordAdminAuditLog } from "./audit.service";
import {
  isMalwareScannerConfigured,
  scanDocumentBuffer,
} from "./document-scanner.service";
import {
  createS3CompatibleStorageAdapter,
  ObjectStorageError,
  type PutObjectOptions,
  resolveS3StorageConfig,
  type StoredObjectHead,
  type StoredObjectStreamResult,
} from "./s3-storage.adapter";

export const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_MULTIPART_REQUEST_BYTES = 11 * 1024 * 1024; // 10 MB file + 1 MB multipart overhead
export const MAX_JSON_UPLOAD_REQUEST_BYTES = 14 * 1024 * 1024; // 10 MB base64 + JSON framing
const STALE_SCAN_LEASE_MS = 2 * 60_000;

export const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
]);

export const PRIVATE_LOCAL_PREFIX = "private://";
export const PRIVATE_S3_PREFIX = "s3-private://";

export interface DocumentStorageAdapter {
  driverName?: "s3" | "local" | "test";
  putObject(
    key: string,
    buffer: Buffer,
    options?: PutObjectOptions
  ): Promise<void>;
  getObject(key: string, maxBytes?: number): Promise<Buffer>;
  getObjectStream?(key: string): Promise<StoredObjectStreamResult>;
  headObject?(key: string): Promise<StoredObjectHead>;
  deleteObject?(key: string): Promise<void>;
}

let customStorageAdapterForTests: DocumentStorageAdapter | null = null;
let cachedS3AdapterKey: string | null = null;
let cachedS3Adapter: DocumentStorageAdapter | null = null;

/**
 * Allows automated tests to substitute an isolated in-memory object store
 * without writing test fixtures to disk. Strictly prohibited in production.
 */
export function setDocumentStorageAdapterForTests(
  adapter: DocumentStorageAdapter | null
): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Document storage override is prohibited in production.");
  }
  customStorageAdapterForTests = adapter;
}

function getPrivateStorageRoot(): string {
  const configured = process.env.PRIVATE_DOCUMENT_STORAGE_DIR?.trim();
  const root = configured
    ? path.resolve(configured)
    : path.resolve(process.cwd(), ".private-storage", "verification-documents");
  const publicDir = path.resolve(process.cwd(), "public");
  if (root === publicDir || root.startsWith(`${publicDir}${path.sep}`)) {
    throw new Error(
      "PRIVATE_DOCUMENT_STORAGE_DIR must never reside inside the public web root."
    );
  }
  return root;
}

export function validateObjectKey(rawKey: string): string {
  if (!rawKey || rawKey.includes("\0") || path.isAbsolute(rawKey)) {
    throw new AdminAuthError(
      "INVALID_STORAGE_REFERENCE",
      "Invalid private document storage reference.",
      403
    );
  }

  const normalizedKey = rawKey
    .replace(/^s3-private:\/\//i, "")
    .replace(/^private:\/\//i, "");

  if (!normalizedKey || normalizedKey.includes("\\")) {
    throw new AdminAuthError(
      "INVALID_STORAGE_REFERENCE",
      "Malformed object storage key.",
      403
    );
  }

  const segments = normalizedKey.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((seg) => seg === "." || seg === ".." || /[^a-zA-Z0-9._-]/.test(seg))
  ) {
    throw new AdminAuthError(
      "INVALID_STORAGE_REFERENCE",
      "Directory traversal or illegal characters in storage key are prohibited.",
      403
    );
  }

  return segments.join("/");
}

function resolveContainedStoragePath(storageKey: string): string {
  const safeKey = validateObjectKey(storageKey);
  const segments = safeKey.split("/");
  const root = getPrivateStorageRoot();
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new AdminAuthError(
      "INVALID_STORAGE_REFERENCE",
      "Storage reference escaped private storage root.",
      403
    );
  }
  return resolved;
}

export const localPrivateStorageAdapter: DocumentStorageAdapter = {
  driverName: "local",
  async putObject(key: string, buffer: Buffer): Promise<void> {
    const filePath = resolveContainedStoragePath(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o750 });
    await fs.writeFile(filePath, buffer, { mode: 0o640 });
  },
  async getObject(key: string, maxBytes = MAX_DOCUMENT_SIZE_BYTES): Promise<Buffer> {
    const filePath = resolveContainedStoragePath(key);
    const stat = await fs.stat(filePath);
    if (stat.size > maxBytes) {
      throw new ObjectStorageError(
        "STORAGE_OBJECT_TOO_LARGE",
        "Stored document exceeds maximum allowed size.",
        413
      );
    }
    return fs.readFile(filePath);
  },
  async getObjectStream(key: string): Promise<StoredObjectStreamResult> {
    const filePath = resolveContainedStoragePath(key);
    const stat = await fs.stat(filePath);
    const nodeStream = fsSync.createReadStream(filePath);
    return {
      stream: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
      contentLength: stat.size,
    };
  },
  async headObject(key: string): Promise<StoredObjectHead> {
    const filePath = resolveContainedStoragePath(key);
    try {
      const stat = await fs.stat(filePath);
      return {
        exists: stat.isFile(),
        contentLength: stat.size,
      };
    } catch {
      return { exists: false };
    }
  },
  async deleteObject(key: string): Promise<void> {
    const filePath = resolveContainedStoragePath(key);
    await fs.rm(filePath, { force: true });
  },
};

function getS3StorageAdapterOrNull(
  env: NodeJS.ProcessEnv = process.env
): DocumentStorageAdapter | null {
  const s3Cfg = resolveS3StorageConfig(env);
  if (!s3Cfg) return null;

  const cacheFingerprint = crypto
    .createHash("sha256")
    .update(
      `${s3Cfg.bucket}\0${s3Cfg.region}\0${s3Cfg.endpoint ?? ""}\0${s3Cfg.accessKeyId}\0${s3Cfg.secretAccessKey}\0${s3Cfg.sseMode}\0${s3Cfg.timeoutMs}`
    )
    .digest("hex");

  if (cachedS3Adapter && cachedS3AdapterKey === cacheFingerprint) {
    return cachedS3Adapter;
  }

  cachedS3Adapter = createS3CompatibleStorageAdapter(s3Cfg);
  cachedS3AdapterKey = cacheFingerprint;
  return cachedS3Adapter;
}

export function getActiveDocumentStorageDriverInfo(
  env: NodeJS.ProcessEnv = process.env
): {
  driver: "s3" | "local" | "unconfigured";
  uploadsEnabled: boolean;
  message: string;
} {
  if (customStorageAdapterForTests && env.NODE_ENV !== "production") {
    return {
      driver: customStorageAdapterForTests.driverName === "s3" ? "s3" : "local",
      uploadsEnabled: true,
      message: "Isolated test document storage adapter active.",
    };
  }

  const isProd = env.NODE_ENV === "production";
  const explicitDriver = (env.DOCUMENT_STORAGE_DRIVER || "").trim().toLowerCase();

  try {
    const s3Cfg = resolveS3StorageConfig(env);
    if (explicitDriver === "local") {
      if (isProd) {
        return {
          driver: "unconfigured",
          uploadsEnabled: false,
          message:
            "Local filesystem storage is disabled in production. Configure persistent S3-compatible private object storage.",
        };
      }
      return {
        driver: "local",
        uploadsEnabled: true,
        message: "Local private development storage active (non-production).",
      };
    }

    if (s3Cfg) {
      return {
        driver: "s3",
        uploadsEnabled: true,
        message: "Persistent S3-compatible private object storage active.",
      };
    }

    if (isProd || explicitDriver === "s3") {
      return {
        driver: "unconfigured",
        uploadsEnabled: false,
        message:
          "Persistent private object storage is not configured. New document uploads are safely disabled.",
      };
    }

    return {
      driver: "local",
      uploadsEnabled: true,
      message:
        "Local private development storage active (configure S3-compatible storage for production).",
    };
  } catch (err) {
    return {
      driver: "unconfigured",
      uploadsEnabled: false,
      message:
        err instanceof Error
          ? err.message
          : "Document storage configuration is invalid.",
    };
  }
}

function getWriteStorageAdapter(): {
  adapter: DocumentStorageAdapter;
  referencePrefix: typeof PRIVATE_S3_PREFIX | typeof PRIVATE_LOCAL_PREFIX;
} {
  if (customStorageAdapterForTests && process.env.NODE_ENV !== "production") {
    return {
      adapter: customStorageAdapterForTests,
      referencePrefix:
        customStorageAdapterForTests.driverName === "s3"
          ? PRIVATE_S3_PREFIX
          : PRIVATE_LOCAL_PREFIX,
    };
  }

  const isProd = process.env.NODE_ENV === "production";
  const explicitDriver = (process.env.DOCUMENT_STORAGE_DRIVER || "")
    .trim()
    .toLowerCase();

  if (explicitDriver === "local") {
    if (isProd) {
      throw new AdminAuthError(
        "DOCUMENT_STORAGE_UNAVAILABLE",
        "Ephemeral local storage is prohibited in production. Configure persistent S3-compatible private object storage before uploading verification documents.",
        503
      );
    }
    return {
      adapter: localPrivateStorageAdapter,
      referencePrefix: PRIVATE_LOCAL_PREFIX,
    };
  }

  let s3Adapter: DocumentStorageAdapter | null;
  try {
    s3Adapter = getS3StorageAdapterOrNull();
  } catch (err) {
    throw new AdminAuthError(
      "DOCUMENT_STORAGE_UNAVAILABLE",
      err instanceof Error
        ? err.message
        : "Persistent object storage configuration is invalid.",
      503
    );
  }

  if (s3Adapter) {
    return { adapter: s3Adapter, referencePrefix: PRIVATE_S3_PREFIX };
  }

  if (isProd || explicitDriver === "s3") {
    throw new AdminAuthError(
      "DOCUMENT_STORAGE_UNAVAILABLE",
      "Persistent private object storage (S3_BUCKET / S3_REGION / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY) is not configured. New uploads are disabled safely.",
      503
    );
  }

  return {
    adapter: localPrivateStorageAdapter,
    referencePrefix: PRIVATE_LOCAL_PREFIX,
  };
}

export function parseManagedStorageReference(storageReference: string): {
  scheme: "s3" | "local";
  key: string;
} | null {
  if (
    !storageReference ||
    storageReference.includes("\0") ||
    storageReference.includes("..")
  ) {
    return null;
  }

  if (storageReference.startsWith(PRIVATE_S3_PREFIX)) {
    const rawKey = storageReference.slice(PRIVATE_S3_PREFIX.length);
    try {
      return { scheme: "s3", key: validateObjectKey(rawKey) };
    } catch {
      return null;
    }
  }

  if (storageReference.startsWith(PRIVATE_LOCAL_PREFIX)) {
    const rawKey = storageReference.slice(PRIVATE_LOCAL_PREFIX.length);
    try {
      return { scheme: "local", key: validateObjectKey(rawKey) };
    } catch {
      return null;
    }
  }

  return null;
}

export function isManagedPrivateStorageReference(ref: string): boolean {
  return parseManagedStorageReference(ref) !== null;
}

function getReadStorageAdapterForReference(storageReference: string): {
  adapter: DocumentStorageAdapter;
  key: string;
  scheme: "s3" | "local";
} {
  const parsed = parseManagedStorageReference(storageReference);
  if (!parsed) {
    throw new AdminAuthError(
      "DOCUMENT_CONTENT_UNAVAILABLE",
      "Document is not stored in verified managed private storage.",
      404
    );
  }

  if (customStorageAdapterForTests && process.env.NODE_ENV !== "production") {
    return {
      adapter: customStorageAdapterForTests,
      key: parsed.key,
      scheme: parsed.scheme,
    };
  }

  if (parsed.scheme === "s3") {
    let s3Adapter: DocumentStorageAdapter | null;
    try {
      s3Adapter = getS3StorageAdapterOrNull();
    } catch (err) {
      throw new AdminAuthError(
        "DOCUMENT_STORAGE_UNAVAILABLE",
        err instanceof Error
          ? err.message
          : "Persistent object storage configuration is invalid.",
        503
      );
    }
    if (!s3Adapter) {
      throw new AdminAuthError(
        "DOCUMENT_STORAGE_UNAVAILABLE",
        "Persistent object storage is not configured to read s3-private documents.",
        503
      );
    }
    return { adapter: s3Adapter, key: parsed.key, scheme: "s3" };
  }

  // Legacy/local `private://` reference
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_LEGACY_LOCAL_DOCUMENT_READ !== "true"
  ) {
    throw new AdminAuthError(
      "DOCUMENT_STORAGE_MIGRATION_REQUIRED",
      "Legacy local document reference cannot be read in production until migrated to persistent object storage.",
      404
    );
  }

  return {
    adapter: localPrivateStorageAdapter,
    key: parsed.key,
    scheme: "local",
  };
}

/**
 * Reads a bounded stream incrementally while computing SHA-256 checksum
 * and aborting immediately if the byte ceiling is exceeded.
 */
export async function readBoundedStreamWithChecksum(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<{ buffer: Buffer; sha256Hex: string }> {
  const reader = stream.getReader();
  const hash = crypto.createHash("sha256");
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new AdminAuthError(
          "PAYLOAD_TOO_LARGE",
          `Payload exceeds maximum allowed limit (${Math.round(maxBytes / (1024 * 1024))} MB).`,
          413
        );
      }

      const chunkBuf = Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength
      );
      hash.update(chunkBuf);
      chunks.push(chunkBuf);
    }
  } finally {
    reader.releaseLock();
  }

  return {
    buffer: Buffer.concat(chunks, totalBytes),
    sha256Hex: hash.digest("hex"),
  };
}

async function readStoredDocumentBytesWithChecksum(
  adapter: DocumentStorageAdapter,
  key: string
): Promise<{ buffer: Buffer; sha256Hex: string }> {
  if (typeof adapter.getObjectStream === "function") {
    const streamRes = await adapter.getObjectStream(key);
    if (
      streamRes.contentLength !== undefined &&
      streamRes.contentLength > MAX_DOCUMENT_SIZE_BYTES
    ) {
      await streamRes.stream.cancel().catch(() => {});
      throw new AdminAuthError(
        "DOCUMENT_TOO_LARGE",
        "Stored verification document exceeds maximum allowed compliance size.",
        413
      );
    }
    return readBoundedStreamWithChecksum(
      streamRes.stream,
      MAX_DOCUMENT_SIZE_BYTES
    );
  }

  const buffer = await adapter.getObject(key, MAX_DOCUMENT_SIZE_BYTES);
  if (buffer.byteLength > MAX_DOCUMENT_SIZE_BYTES) {
    throw new AdminAuthError(
      "DOCUMENT_TOO_LARGE",
      "Stored verification document exceeds maximum allowed compliance size.",
      413
    );
  }
  return { buffer, sha256Hex: computeSha256Hex(buffer) };
}

/**
 * Inspects file magic bytes instead of trusting client MIME types or extensions.
 */
export function detectActualDocumentMimeType(
  buffer: Buffer
): "application/pdf" | "image/png" | "image/jpeg" | null {
  if (!buffer || buffer.byteLength < 8) {
    return null;
  }

  // %PDF-
  if (
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46 &&
    buffer[4] === 0x2d
  ) {
    return "application/pdf";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  return null;
}

export function sanitizeUploadFileName(rawFileName: string): string {
  const base = path.basename((rawFileName || "document").trim());
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
  return (cleaned || "document").slice(0, 120);
}

export function computeSha256Hex(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function extensionForMimeType(
  mimeType: "application/pdf" | "image/png" | "image/jpeg"
): string {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "image/png") return "png";
  return "jpg";
}

function generateUnpredictableObjectKey(
  providerId: string,
  detectedMimeType: "application/pdf" | "image/png" | "image/jpeg"
): string {
  const safeProviderSegment = sanitizeUploadFileName(providerId);
  const randomPrefix = crypto.randomBytes(16).toString("hex");
  const uuid = crypto.randomUUID();
  const ext = extensionForMimeType(detectedMimeType);
  return validateObjectKey(`${safeProviderSegment}/${randomPrefix}-${uuid}.${ext}`);
}

export async function storePrivateVerificationDocumentBytes(params: {
  providerId: string;
  fileName: string;
  declaredMimeType?: string;
  buffer: Buffer;
}): Promise<{
  storageReference: string;
  storageKey: string;
  sanitizedFileName: string;
  detectedMimeType: "application/pdf" | "image/png" | "image/jpeg";
  fileSizeBytes: number;
  checksumSha256: string;
  adapter: DocumentStorageAdapter;
}> {
  if (!Buffer.isBuffer(params.buffer) || params.buffer.byteLength === 0) {
    throw new AdminAuthError(
      "EMPTY_DOCUMENT_FILE",
      "Uploaded verification document cannot be empty.",
      400
    );
  }

  if (params.buffer.byteLength > MAX_DOCUMENT_SIZE_BYTES) {
    throw new AdminAuthError(
      "DOCUMENT_TOO_LARGE",
      "Uploaded verification document exceeds the 10 MB security size limit.",
      413
    );
  }

  const detectedMimeType = detectActualDocumentMimeType(params.buffer);
  if (!detectedMimeType || !ALLOWED_DOCUMENT_MIME_TYPES.has(detectedMimeType)) {
    throw new AdminAuthError(
      "UNSUPPORTED_FILE_SIGNATURE",
      "File content does not match an allowed document format (PDF, PNG, or JPEG).",
      400
    );
  }

  if (
    params.declaredMimeType &&
    params.declaredMimeType !== detectedMimeType &&
    !(
      params.declaredMimeType === "image/jpg" &&
      detectedMimeType === "image/jpeg"
    )
  ) {
    throw new AdminAuthError(
      "MIME_SIGNATURE_MISMATCH",
      `Declared MIME type '${params.declaredMimeType}' does not match inspected file signature '${detectedMimeType}'.`,
      400
    );
  }

  const { adapter, referencePrefix } = getWriteStorageAdapter();
  const sanitizedFileName = sanitizeUploadFileName(params.fileName);
  const storageKey = generateUnpredictableObjectKey(
    params.providerId,
    detectedMimeType
  );
  const storageReference = `${referencePrefix}${storageKey}`;
  const checksumSha256 = computeSha256Hex(params.buffer);

  try {
    await adapter.putObject(storageKey, params.buffer, {
      contentType: detectedMimeType,
      sha256Hex: checksumSha256,
      metadata: {
        sha256: checksumSha256,
        provider_id: params.providerId,
      },
    });
  } catch (err) {
    if (err instanceof AdminAuthError) throw err;
    if (err instanceof ObjectStorageError) {
      throw new AdminAuthError(err.code, err.message, err.statusCode);
    }
    throw new AdminAuthError(
      "STORAGE_UPLOAD_FAILED",
      "Unable to persist verification document to private object storage.",
      503
    );
  }

  return {
    storageReference,
    storageKey,
    sanitizedFileName,
    detectedMimeType,
    fileSizeBytes: params.buffer.byteLength,
    checksumSha256,
    adapter,
  };
}

export async function runAndPersistDocumentScan(params: {
  documentId: string;
  admin: AuthenticatedAdmin;
  ipAddress?: string;
  userAgent?: string;
}) {
  const now = new Date();
  const staleLeaseCutoff = new Date(now.getTime() - STALE_SCAN_LEASE_MS);

  // Atomically inspect state and claim a SCANNING lease to prevent duplicate concurrent scans
  const claim = await db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(verificationDocuments)
      .where(eq(verificationDocuments.id, params.documentId))
      .limit(1);

    if (!doc) {
      throw new AdminAuthError(
        "DOCUMENT_NOT_FOUND",
        "Verification document not found.",
        404
      );
    }

    if (doc.malwareScanStatus === "INFECTED" || Boolean(doc.quarantinedAt)) {
      throw new AdminAuthError(
        "DOCUMENT_QUARANTINED",
        "Quarantined or infected documents cannot be rescanned or cleared.",
        403
      );
    }

    if (
      doc.malwareScanStatus === "CLEAN" &&
      doc.malwareScannedAt &&
      doc.malwareScanProvider
    ) {
      return { kind: "already-clean" as const, doc };
    }

    if (
      doc.malwareScanStatus === "SCANNING" &&
      doc.updatedAt > staleLeaseCutoff
    ) {
      throw new AdminAuthError(
        "DOCUMENT_SCAN_IN_PROGRESS",
        "A malware scan is already in progress for this document.",
        409
      );
    }

    const claimed = await tx
      .update(verificationDocuments)
      .set({
        malwareScanStatus: "SCANNING",
        updatedAt: now,
      })
      .where(
        and(
          eq(verificationDocuments.id, doc.id),
          or(
            eq(verificationDocuments.malwareScanStatus, "PENDING"),
            eq(verificationDocuments.malwareScanStatus, "ERROR"),
            and(
              eq(verificationDocuments.malwareScanStatus, "SCANNING"),
              lt(verificationDocuments.updatedAt, staleLeaseCutoff)
            )
          )
        )
      )
      .returning();

    if (claimed.length === 0) {
      throw new AdminAuthError(
        "DOCUMENT_SCAN_IN_PROGRESS",
        "Concurrent malware scan state transition detected.",
        409
      );
    }

    return { kind: "claimed" as const, doc, claimedDoc: claimed[0] };
  });

  if (claim.kind === "already-clean") {
    const integrity = await verifyStoredDocumentAccessible(
      claim.doc.storageReference,
      claim.doc.checksumSha256
    );
    if (!integrity.accessible) {
      throw new AdminAuthError(
        "DOCUMENT_CHECKSUM_MISMATCH",
        integrity.reason ||
          "Stored document failed integrity check against scanned checksum.",
        409
      );
    }
    return {
      documentId: claim.doc.id,
      malwareScanStatus: claim.doc.malwareScanStatus,
      malwareScanProvider: claim.doc.malwareScanProvider,
      malwareScannedAt: claim.doc.malwareScannedAt?.toISOString() ?? null,
      malwareScanResult: claim.doc.malwareScanResult,
      configured: true,
    };
  }

  const doc = claim.doc;

  const revertToError = async (
    status: "ERROR" | "PENDING",
    reason: string,
    providerName: string
  ) => {
    const failedAt = new Date();
    await db
      .update(verificationDocuments)
      .set({
        malwareScanStatus: status,
        malwareScanProvider: status === "PENDING" ? null : providerName,
        malwareScannedAt: status === "PENDING" ? null : failedAt,
        malwareScanResult: reason.slice(0, 240),
        updatedAt: failedAt,
      })
      .where(
        and(
          eq(verificationDocuments.id, doc.id),
          eq(verificationDocuments.malwareScanStatus, "SCANNING")
        )
      );
  };

  let adapterInfo: ReturnType<typeof getReadStorageAdapterForReference>;
  try {
    adapterInfo = getReadStorageAdapterForReference(doc.storageReference);
  } catch (err) {
    await revertToError(
      "ERROR",
      "Document storage reference is inaccessible for malware scanning.",
      "STORAGE"
    );
    throw err;
  }

  let buffer: Buffer;
  let actualSha: string;
  try {
    const loaded = await readStoredDocumentBytesWithChecksum(
      adapterInfo.adapter,
      adapterInfo.key
    );
    buffer = loaded.buffer;
    actualSha = loaded.sha256Hex;
  } catch (err) {
    await revertToError(
      "ERROR",
      "Unable to retrieve stored document content for malware scanning.",
      "STORAGE"
    );
    if (err instanceof AdminAuthError) throw err;
    if (err instanceof ObjectStorageError) {
      throw new AdminAuthError(err.code, err.message, err.statusCode);
    }
    throw new AdminAuthError(
      "DOCUMENT_CONTENT_UNAVAILABLE",
      "Unable to retrieve stored document content for scanning.",
      404
    );
  }

  if (doc.checksumSha256 && actualSha !== doc.checksumSha256) {
    await revertToError(
      "ERROR",
      "Document SHA-256 integrity checksum mismatch detected prior to scanning.",
      "INTEGRITY"
    );
    throw new AdminAuthError(
      "DOCUMENT_CHECKSUM_MISMATCH",
      "Document integrity checksum mismatch detected prior to scanning.",
      409
    );
  }

  const outcome = await scanDocumentBuffer(buffer, {
    documentId: doc.id,
    mimeType: doc.mimeType,
    checksumSha256: actualSha,
  });
  const finishedAt = new Date();

  const txResult = await db.transaction(async (tx) => {
    const nextDocStatus =
      outcome.status === "INFECTED" ? "REJECTED" : doc.status;
    const isUnconfiguredPending = outcome.status === "PENDING";

    const updateWhere = doc.checksumSha256
      ? and(
          eq(verificationDocuments.id, doc.id),
          eq(verificationDocuments.malwareScanStatus, "SCANNING"),
          eq(verificationDocuments.checksumSha256, doc.checksumSha256)
        )
      : and(
          eq(verificationDocuments.id, doc.id),
          eq(verificationDocuments.malwareScanStatus, "SCANNING")
        );

    const [updated] = await tx
      .update(verificationDocuments)
      .set({
        malwareScanStatus: outcome.status,
        malwareScanProvider: isUnconfiguredPending ? null : outcome.provider,
        malwareScannedAt: isUnconfiguredPending ? null : outcome.scannedAt,
        malwareScanResult: outcome.resultMessage,
        checksumSha256: doc.checksumSha256 || actualSha,
        quarantinedAt:
          outcome.status === "INFECTED" ? finishedAt : doc.quarantinedAt,
        status: nextDocStatus,
        replacementRequested:
          outcome.status === "INFECTED" ? true : doc.replacementRequested,
        rejectionReason:
          outcome.status === "INFECTED"
            ? `Quarantined due to malware detection: ${outcome.resultMessage}`
            : doc.rejectionReason,
        updatedAt: finishedAt,
      })
      .where(updateWhere)
      .returning();

    if (!updated) {
      throw new AdminAuthError(
        "SCAN_STATE_CONFLICT",
        "Concurrent or stale malware scan state transition detected.",
        409
      );
    }

    await recordAdminAuditLog(
      {
        adminUserId: params.admin.id,
        adminEmail: params.admin.email,
        action:
          outcome.status === "INFECTED"
            ? "VERIFICATION_DOCUMENT_QUARANTINED"
            : "VERIFICATION_DOCUMENT_SCANNED",
        entityType: "VERIFICATION_DOCUMENT",
        entityId: doc.id,
        summary: `Malware scan finished with status ${outcome.status} (${outcome.provider}) for "${doc.documentTitle}"`,
        previousState: { malwareScanStatus: doc.malwareScanStatus },
        newState: {
          malwareScanStatus: outcome.status,
          malwareScanProvider: isUnconfiguredPending ? null : outcome.provider,
          checksumSha256: doc.checksumSha256 || actualSha,
          configured: outcome.configured,
        },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      tx
    );

    return updated;
  });

  return {
    documentId: txResult.id,
    malwareScanStatus: txResult.malwareScanStatus,
    malwareScanProvider: txResult.malwareScanProvider,
    malwareScannedAt: txResult.malwareScannedAt?.toISOString() ?? null,
    malwareScanResult: txResult.malwareScanResult,
    configured: outcome.configured,
  };
}

export async function readAuthorizedDocumentContent(params: {
  documentId: string;
  expectedProviderId?: string;
  expectedCenterId?: string;
  expectedCaregiverId?: string;
  admin: AuthenticatedAdmin;
  ipAddress?: string;
  userAgent?: string;
}): Promise<{
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  checksumSha256: string;
}> {
  const [doc] = await db
    .select()
    .from(verificationDocuments)
    .where(eq(verificationDocuments.id, params.documentId))
    .limit(1);

  if (!doc) {
    throw new AdminAuthError(
      "DOCUMENT_NOT_FOUND",
      "Verification document not found.",
      404
    );
  }

  if (
    params.expectedProviderId &&
    doc.providerId !== params.expectedProviderId
  ) {
    throw new AdminAuthError(
      "DOCUMENT_OWNERSHIP_MISMATCH",
      "Document does not belong to the specified provider.",
      403
    );
  }

  if (params.expectedCenterId && doc.centerId !== params.expectedCenterId) {
    throw new AdminAuthError(
      "DOCUMENT_OWNERSHIP_MISMATCH",
      "Document does not belong to the specified daycare centre.",
      403
    );
  }

  if (
    params.expectedCaregiverId &&
    doc.caregiverId !== params.expectedCaregiverId
  ) {
    throw new AdminAuthError(
      "DOCUMENT_OWNERSHIP_MISMATCH",
      "Document does not belong to the specified caregiver.",
      403
    );
  }

  if (doc.malwareScanStatus === "INFECTED" || Boolean(doc.quarantinedAt)) {
    throw new AdminAuthError(
      "DOCUMENT_QUARANTINED",
      "Access denied: quarantined or infected documents cannot be downloaded.",
      403
    );
  }

  if (
    doc.malwareScanStatus !== "CLEAN" ||
    !doc.malwareScannedAt ||
    !doc.malwareScanProvider
  ) {
    throw new AdminAuthError(
      "DOCUMENT_NOT_SCANNED_CLEAN",
      `Access denied: document scan status is '${doc.malwareScanStatus || "PENDING"}'. Only trusted CLEAN scanned documents can be viewed.`,
      403
    );
  }

  const adapterInfo = getReadStorageAdapterForReference(doc.storageReference);

  let buffer: Buffer;
  let actualSha: string;
  try {
    const loaded = await readStoredDocumentBytesWithChecksum(
      adapterInfo.adapter,
      adapterInfo.key
    );
    buffer = loaded.buffer;
    actualSha = loaded.sha256Hex;
  } catch (err) {
    if (err instanceof AdminAuthError) throw err;
    if (err instanceof ObjectStorageError) {
      throw new AdminAuthError(err.code, err.message, err.statusCode);
    }
    throw new AdminAuthError(
      "DOCUMENT_CONTENT_UNAVAILABLE",
      "Stored document bytes could not be loaded from private storage.",
      404
    );
  }

  if (doc.checksumSha256 && actualSha !== doc.checksumSha256) {
    throw new AdminAuthError(
      "DOCUMENT_CHECKSUM_MISMATCH",
      "Stored document failed SHA-256 integrity verification.",
      409
    );
  }

  const detectedMime = detectActualDocumentMimeType(buffer);
  const safeMimeType =
    detectedMime && ALLOWED_DOCUMENT_MIME_TYPES.has(detectedMime)
      ? detectedMime
      : doc.mimeType;

  await recordAdminAuditLog({
    adminUserId: params.admin.id,
    adminEmail: params.admin.email,
    action: "VERIFICATION_DOCUMENT_ACCESSED",
    entityType: "VERIFICATION_DOCUMENT",
    entityId: doc.id,
    summary: `Authorized administrator ${params.admin.email} accessed private content for "${doc.documentTitle}"`,
    newState: {
      providerId: doc.providerId,
      centerId: doc.centerId,
      caregiverId: doc.caregiverId,
      checksumSha256: actualSha,
      storageScheme: adapterInfo.scheme,
    },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });

  return {
    buffer,
    mimeType: safeMimeType,
    fileName: sanitizeUploadFileName(
      doc.originalFileName ||
        `${doc.documentType.toLowerCase()}.${extensionForMimeType(
          (detectedMime ?? "application/pdf") as
            | "application/pdf"
            | "image/png"
            | "image/jpeg"
        )}`
    ),
    checksumSha256: actualSha,
  };
}

export async function verifyStoredDocumentAccessible(
  storageReference: string,
  expectedChecksumSha256?: string | null
): Promise<{ accessible: boolean; reason?: string; actualSha256?: string }> {
  let adapterInfo: ReturnType<typeof getReadStorageAdapterForReference>;
  try {
    adapterInfo = getReadStorageAdapterForReference(storageReference);
  } catch (err) {
    return {
      accessible: false,
      reason:
        err instanceof Error
          ? err.message
          : "Document does not reside in verified private object storage.",
    };
  }

  if (typeof adapterInfo.adapter.headObject === "function") {
    try {
      const head = await adapterInfo.adapter.headObject(adapterInfo.key);
      if (!head.exists) {
        return {
          accessible: false,
          reason: "Stored document object does not exist in private storage.",
        };
      }
      if (
        head.contentLength !== undefined &&
        (head.contentLength === 0 ||
          head.contentLength > MAX_DOCUMENT_SIZE_BYTES)
      ) {
        return {
          accessible: false,
          reason: "Stored document object size is outside compliance bounds.",
        };
      }
    } catch (err) {
      return {
        accessible: false,
        reason:
          err instanceof Error
            ? err.message
            : "Stored document metadata check failed.",
      };
    }
  }

  let buffer: Buffer;
  let actualSha: string;
  try {
    const loaded = await readStoredDocumentBytesWithChecksum(
      adapterInfo.adapter,
      adapterInfo.key
    );
    buffer = loaded.buffer;
    actualSha = loaded.sha256Hex;
  } catch (err) {
    return {
      accessible: false,
      reason:
        err instanceof Error
          ? err.message
          : "Stored document content cannot be retrieved from private storage.",
    };
  }

  if (buffer.byteLength === 0) {
    return {
      accessible: false,
      reason: "Stored document file is empty.",
    };
  }

  if (expectedChecksumSha256 && actualSha !== expectedChecksumSha256) {
    return {
      accessible: false,
      reason: "Stored document SHA-256 checksum does not match metadata.",
    };
  }

  return { accessible: true, actualSha256: actualSha };
}

export async function uploadAndRegisterVerificationDocument(params: {
  providerId: string;
  centerId?: string | null;
  caregiverId?: string | null;
  documentCategory: "PROVIDER" | "CENTER" | "CAREGIVER";
  documentType: string;
  documentTitle: string;
  fileName: string;
  declaredMimeType?: string;
  buffer: Buffer;
  expiresAt?: Date | null;
  admin: AuthenticatedAdmin;
  ipAddress?: string;
  userAgent?: string;
}) {
  // Verify persistent storage readiness before touching DB or object store
  getWriteStorageAdapter();

  // Enforce ownership hierarchy before touching private object storage
  const [provider] = await db
    .select()
    .from(providers)
    .where(eq(providers.id, params.providerId))
    .limit(1);

  if (!provider) {
    throw new AdminAuthError(
      "PROVIDER_NOT_FOUND",
      "Target provider organization does not exist.",
      404
    );
  }

  if (params.documentCategory === "CENTER" && !params.centerId) {
    throw new AdminAuthError(
      "CENTER_ID_REQUIRED",
      "Center-scoped verification documents must specify centerId.",
      400
    );
  }

  if (params.documentCategory === "CAREGIVER" && !params.caregiverId) {
    throw new AdminAuthError(
      "CAREGIVER_ID_REQUIRED",
      "Caregiver-scoped verification documents must specify caregiverId.",
      400
    );
  }

  if (
    params.documentCategory === "PROVIDER" &&
    (params.centerId || params.caregiverId)
  ) {
    throw new AdminAuthError(
      "INVALID_DOCUMENT_SCOPE",
      "Provider organization documents cannot be bound to a specific centre or caregiver.",
      400
    );
  }

  let resolvedCenterId = params.centerId ?? null;
  if (params.centerId) {
    const [center] = await db
      .select()
      .from(centers)
      .where(
        and(eq(centers.id, params.centerId), eq(centers.providerId, provider.id))
      )
      .limit(1);
    if (!center) {
      throw new AdminAuthError(
        "CENTER_OWNERSHIP_MISMATCH",
        "Specified daycare centre does not belong to this provider organization.",
        403
      );
    }
  }

  if (params.caregiverId) {
    const [cg] = await db
      .select()
      .from(caregivers)
      .where(eq(caregivers.id, params.caregiverId))
      .limit(1);
    if (!cg) {
      throw new AdminAuthError(
        "CAREGIVER_NOT_FOUND",
        "Specified caregiver record not found.",
        404
      );
    }
    const [cgCenter] = await db
      .select()
      .from(centers)
      .where(
        and(eq(centers.id, cg.centerId), eq(centers.providerId, provider.id))
      )
      .limit(1);
    if (!cgCenter || (resolvedCenterId && cg.centerId !== resolvedCenterId)) {
      throw new AdminAuthError(
        "CAREGIVER_OWNERSHIP_MISMATCH",
        "Specified caregiver does not belong to this provider/centre.",
        403
      );
    }
    resolvedCenterId = cg.centerId;
  }

  const stored = await storePrivateVerificationDocumentBytes({
    providerId: provider.id,
    fileName: params.fileName,
    declaredMimeType: params.declaredMimeType,
    buffer: params.buffer,
  });

  const now = new Date();
  let insertedDocId: string;
  try {
    insertedDocId = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(verificationDocuments)
        .values({
          providerId: provider.id,
          centerId: resolvedCenterId,
          caregiverId: params.caregiverId ?? null,
          documentCategory: params.documentCategory,
          documentType: params.documentType.trim().toUpperCase(),
          documentTitle: params.documentTitle.trim(),
          storageReference: stored.storageReference,
          originalFileName: stored.sanitizedFileName,
          mimeType: stored.detectedMimeType,
          fileSizeBytes: stored.fileSizeBytes,
          checksumSha256: stored.checksumSha256,
          malwareScanStatus: "PENDING",
          status: "SUBMITTED",
          expiresAt: params.expiresAt ?? null,
          uploadedBy: params.admin.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: verificationDocuments.id });

      await recordAdminAuditLog(
        {
          adminUserId: params.admin.id,
          adminEmail: params.admin.email,
          action: "VERIFICATION_DOCUMENT_UPLOADED",
          entityType: "VERIFICATION_DOCUMENT",
          entityId: created.id,
          summary: `Uploaded private verification document "${params.documentTitle}" (${params.documentCategory}) in PENDING scan state`,
          newState: {
            providerId: provider.id,
            centerId: resolvedCenterId,
            caregiverId: params.caregiverId ?? null,
            documentCategory: params.documentCategory,
            malwareScanStatus: "PENDING",
            checksumSha256: stored.checksumSha256,
            storageDriver: stored.adapter.driverName ?? "private",
          },
          ipAddress: params.ipAddress,
          userAgent: params.userAgent,
        },
        tx
      );

      return created.id;
    });
  } catch (dbErr) {
    // Compensating cleanup for external object storage when DB registration fails
    let cleanupSucceeded = false;
    if (typeof stored.adapter.deleteObject === "function") {
      try {
        await stored.adapter.deleteObject(stored.storageKey);
        cleanupSucceeded = true;
      } catch {
        cleanupSucceeded = false;
      }
    }

    if (!cleanupSucceeded) {
      // Record non-sensitive reconciliation marker so orphaned object can be purged safely
      const keyDigest = crypto
        .createHash("sha256")
        .update(stored.storageKey)
        .digest("hex")
        .slice(0, 24);
      await recordAdminAuditLog({
        adminUserId: params.admin.id,
        adminEmail: params.admin.email,
        action: "VERIFICATION_DOCUMENT_ORPHAN_RECONCILIATION_REQUIRED",
        entityType: "VERIFICATION_DOCUMENT",
        summary: `DB registration failed and compensating object cleanup did not complete (keyDigest=${keyDigest})`,
        outcome: "FAILURE",
        newState: {
          providerId: provider.id,
          checksumSha256: stored.checksumSha256,
          keyDigest,
        },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      }).catch(() => {});
    }

    throw dbErr;
  }

  // Trigger trusted backend scan immediately only when a scanner backend is configured;
  // scan failure never turns an uploaded file CLEAN and never leaves DB inconsistent.
  let scanStatus: string = "PENDING";
  if (isMalwareScannerConfigured()) {
    try {
      const scanRes = await runAndPersistDocumentScan({
        documentId: insertedDocId,
        admin: params.admin,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      });
      scanStatus = scanRes.malwareScanStatus;
    } catch {
      scanStatus = "ERROR";
    }
  }

  return {
    documentId: insertedDocId,
    providerId: provider.id,
    centerId: resolvedCenterId,
    caregiverId: params.caregiverId ?? null,
    documentCategory: params.documentCategory,
    mimeType: stored.detectedMimeType,
    fileSizeBytes: stored.fileSizeBytes,
    checksumSha256: stored.checksumSha256,
    malwareScanStatus: scanStatus,
    status: "SUBMITTED" as const,
    scannerConfigured: isMalwareScannerConfigured(),
    storageDriver: stored.adapter.driverName ?? "private",
  };
}

export interface LocalToPersistentMigrationResult {
  dryRun: boolean;
  inventoriedLocalDocuments: number;
  migratedIds: string[];
  unavailableIds: string[];
  checksumMismatchIds: string[];
  failedIds: Array<{ documentId: string; reason: string }>;
}

/**
 * Controlled, idempotent migration utility copying legacy `private://` local
 * verification documents to persistent S3-compatible object storage (`s3-private://`).
 *
 * Guarantees:
 * - Never deletes local originals during migration.
 * - Verifies SHA-256 checksums before upload AND after readback from persistent storage.
 * - Updates PostgreSQL references only after confirmed transfer + audit logging.
 * - Safe to resume after partial failures without duplicating already-migrated rows.
 */
export async function migrateLocalDocumentsToPersistentStorage(params: {
  admin: AuthenticatedAdmin;
  dryRun?: boolean;
  sourceAdapter?: DocumentStorageAdapter;
  targetAdapter?: DocumentStorageAdapter;
  ipAddress?: string;
  userAgent?: string;
}): Promise<LocalToPersistentMigrationResult> {
  const dryRun = Boolean(params.dryRun);
  const sourceAdapter = params.sourceAdapter ?? localPrivateStorageAdapter;
  const targetAdapter =
    params.targetAdapter ??
    (() => {
      const resolved = getS3StorageAdapterOrNull();
      if (!resolved) {
        throw new AdminAuthError(
          "DOCUMENT_STORAGE_UNAVAILABLE",
          "Persistent S3-compatible storage must be configured before migrating local documents.",
          503
        );
      }
      return resolved;
    })();

  const allDocs = await db.select().from(verificationDocuments);
  const localDocs = allDocs.filter((d) =>
    d.storageReference.startsWith(PRIVATE_LOCAL_PREFIX)
  );

  const migratedIds: string[] = [];
  const unavailableIds: string[] = [];
  const checksumMismatchIds: string[] = [];
  const failedIds: Array<{ documentId: string; reason: string }> = [];

  for (const doc of localDocs) {
    const parsed = parseManagedStorageReference(doc.storageReference);
    if (!parsed || parsed.scheme !== "local") {
      unavailableIds.push(doc.id);
      continue;
    }

    let localBytes: Buffer;
    let localSha: string;
    try {
      const loaded = await readStoredDocumentBytesWithChecksum(
        sourceAdapter,
        parsed.key
      );
      localBytes = loaded.buffer;
      localSha = loaded.sha256Hex;
    } catch {
      unavailableIds.push(doc.id);
      continue;
    }

    if (doc.checksumSha256 && localSha !== doc.checksumSha256) {
      checksumMismatchIds.push(doc.id);
      continue;
    }

    if (dryRun) {
      migratedIds.push(doc.id);
      continue;
    }

    const detectedMime =
      detectActualDocumentMimeType(localBytes) ?? "application/pdf";
    const targetKey = generateUnpredictableObjectKey(doc.providerId, detectedMime);
    const nextReference = `${PRIVATE_S3_PREFIX}${targetKey}`;

    try {
      await targetAdapter.putObject(targetKey, localBytes, {
        contentType: doc.mimeType || detectedMime,
        sha256Hex: localSha,
        metadata: {
          sha256: localSha,
          provider_id: doc.providerId,
          migrated_document_id: doc.id,
        },
      });

      // Verify uploaded object integrity via readback before modifying DB reference
      const verified = await readStoredDocumentBytesWithChecksum(
        targetAdapter,
        targetKey
      );
      if (verified.sha256Hex !== localSha) {
        await targetAdapter.deleteObject?.(targetKey).catch(() => {});
        failedIds.push({
          documentId: doc.id,
          reason: "Uploaded persistent object failed post-transfer checksum verification.",
        });
        continue;
      }

      await db.transaction(async (tx) => {
        const updated = await tx
          .update(verificationDocuments)
          .set({
            storageReference: nextReference,
            checksumSha256: doc.checksumSha256 || localSha,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(verificationDocuments.id, doc.id),
              eq(verificationDocuments.storageReference, doc.storageReference)
            )
          )
          .returning({ id: verificationDocuments.id });

        if (updated.length === 0) {
          throw new Error("Concurrent document reference update during migration.");
        }

        await recordAdminAuditLog(
          {
            adminUserId: params.admin.id,
            adminEmail: params.admin.email,
            action: "VERIFICATION_DOCUMENT_STORAGE_MIGRATED",
            entityType: "VERIFICATION_DOCUMENT",
            entityId: doc.id,
            summary: `Migrated verification document "${doc.documentTitle}" from local private storage to persistent object storage`,
            previousState: { storageScheme: "local" },
            newState: {
              storageScheme: "s3",
              checksumSha256: localSha,
              localOriginalRetained: true,
            },
            ipAddress: params.ipAddress,
            userAgent: params.userAgent,
          },
          tx
        );
      });

      migratedIds.push(doc.id);
    } catch (err) {
      await targetAdapter.deleteObject?.(targetKey).catch(() => {});
      failedIds.push({
        documentId: doc.id,
        reason:
          err instanceof Error ? err.message : "Unexpected migration error.",
      });
    }
  }

  return {
    dryRun,
    inventoriedLocalDocuments: localDocs.length,
    migratedIds,
    unavailableIds,
    checksumMismatchIds,
    failedIds,
  };
}

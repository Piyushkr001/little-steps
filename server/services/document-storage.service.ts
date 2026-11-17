import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
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

export const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
]);

export interface DocumentStorageAdapter {
  putObject(key: string, buffer: Buffer): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  deleteObject?(key: string): Promise<void>;
}

let customStorageAdapterForTests: DocumentStorageAdapter | null = null;

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

function resolveContainedStoragePath(storageKey: string): string {
  if (!storageKey || storageKey.includes("\0") || path.isAbsolute(storageKey)) {
    throw new AdminAuthError(
      "INVALID_STORAGE_REFERENCE",
      "Invalid private document storage reference.",
      403
    );
  }

  const normalizedKey = storageKey.replace(/^private:\/\//i, "");
  const segments = normalizedKey.split(/[\\/]+/).filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((seg) => seg === "." || seg === "..")
  ) {
    throw new AdminAuthError(
      "INVALID_STORAGE_REFERENCE",
      "Directory traversal in document storage reference is prohibited.",
      403
    );
  }

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

const localPrivateStorageAdapter: DocumentStorageAdapter = {
  async putObject(key: string, buffer: Buffer): Promise<void> {
    const filePath = resolveContainedStoragePath(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o750 });
    await fs.writeFile(filePath, buffer, { mode: 0o640 });
  },
  async getObject(key: string): Promise<Buffer> {
    const filePath = resolveContainedStoragePath(key);
    return fs.readFile(filePath);
  },
  async deleteObject(key: string): Promise<void> {
    const filePath = resolveContainedStoragePath(key);
    await fs.rm(filePath, { force: true });
  },
};

function getActiveStorageAdapter(): DocumentStorageAdapter {
  if (customStorageAdapterForTests && process.env.NODE_ENV !== "production") {
    return customStorageAdapterForTests;
  }
  return localPrivateStorageAdapter;
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

export function isManagedPrivateStorageReference(ref: string): boolean {
  if (!ref || ref.includes("\0") || ref.includes("..")) return false;
  return ref.startsWith("private://") && !path.isAbsolute(ref.slice("private://".length));
}

export async function storePrivateVerificationDocumentBytes(params: {
  providerId: string;
  fileName: string;
  declaredMimeType?: string;
  buffer: Buffer;
}): Promise<{
  storageReference: string;
  sanitizedFileName: string;
  detectedMimeType: "application/pdf" | "image/png" | "image/jpeg";
  fileSizeBytes: number;
  checksumSha256: string;
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
      400
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

  const sanitizedFileName = sanitizeUploadFileName(params.fileName);
  const uniqueId = crypto.randomUUID();
  const safeProviderSegment = sanitizeUploadFileName(params.providerId);
  const storageKey = `${safeProviderSegment}/${uniqueId}-${sanitizedFileName}`;
  const storageReference = `private://${storageKey}`;
  const checksumSha256 = computeSha256Hex(params.buffer);

  await getActiveStorageAdapter().putObject(storageKey, params.buffer);

  return {
    storageReference,
    sanitizedFileName,
    detectedMimeType,
    fileSizeBytes: params.buffer.byteLength,
    checksumSha256,
  };
}

export async function runAndPersistDocumentScan(params: {
  documentId: string;
  admin: AuthenticatedAdmin;
  ipAddress?: string;
  userAgent?: string;
}) {
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

  if (doc.malwareScanStatus === "INFECTED" || doc.quarantinedAt) {
    throw new AdminAuthError(
      "DOCUMENT_QUARANTINED",
      "Quarantined or infected documents cannot be rescanned or cleared.",
      403
    );
  }

  if (!isManagedPrivateStorageReference(doc.storageReference)) {
    throw new AdminAuthError(
      "DOCUMENT_CONTENT_UNAVAILABLE",
      "Document is not stored in verified private storage.",
      400
    );
  }

  const storageKey = doc.storageReference.slice("private://".length);
  let buffer: Buffer;
  try {
    buffer = await getActiveStorageAdapter().getObject(storageKey);
  } catch {
    throw new AdminAuthError(
      "DOCUMENT_CONTENT_UNAVAILABLE",
      "Unable to retrieve stored document content for scanning.",
      404
    );
  }

  if (doc.checksumSha256 && computeSha256Hex(buffer) !== doc.checksumSha256) {
    throw new AdminAuthError(
      "DOCUMENT_CHECKSUM_MISMATCH",
      "Document integrity checksum mismatch detected prior to scanning.",
      409
    );
  }

  await db
    .update(verificationDocuments)
    .set({
      malwareScanStatus: "SCANNING",
      updatedAt: new Date(),
    })
    .where(eq(verificationDocuments.id, doc.id));

  const outcome = await scanDocumentBuffer(buffer, {
    documentId: doc.id,
    mimeType: doc.mimeType,
  });
  const now = new Date();

  const txResult = await db.transaction(async (tx) => {
    const nextDocStatus = outcome.status === "INFECTED" ? "REJECTED" : doc.status;
    const [updated] = await tx
      .update(verificationDocuments)
      .set({
        malwareScanStatus: outcome.status,
        malwareScanProvider: outcome.provider,
        malwareScannedAt: outcome.scannedAt,
        malwareScanResult: outcome.resultMessage,
        quarantinedAt: outcome.status === "INFECTED" ? now : doc.quarantinedAt,
        status: nextDocStatus,
        replacementRequested:
          outcome.status === "INFECTED" ? true : doc.replacementRequested,
        rejectionReason:
          outcome.status === "INFECTED"
            ? `Quarantined due to malware detection: ${outcome.resultMessage}`
            : doc.rejectionReason,
        updatedAt: now,
      })
      .where(
        and(
          eq(verificationDocuments.id, doc.id),
          eq(verificationDocuments.malwareScanStatus, "SCANNING")
        )
      )
      .returning();

    if (!updated) {
      throw new AdminAuthError(
        "SCAN_STATE_CONFLICT",
        "Concurrent malware scan update detected.",
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
          malwareScanProvider: outcome.provider,
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

  if (params.expectedProviderId && doc.providerId !== params.expectedProviderId) {
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

  if (doc.malwareScanStatus === "INFECTED" || doc.quarantinedAt) {
    throw new AdminAuthError(
      "DOCUMENT_QUARANTINED",
      "Access denied: quarantined or infected documents cannot be downloaded.",
      403
    );
  }

  if (doc.malwareScanStatus !== "CLEAN") {
    throw new AdminAuthError(
      "DOCUMENT_NOT_SCANNED_CLEAN",
      `Access denied: document scan status is '${doc.malwareScanStatus}'. Only CLEAN scanned documents can be viewed.`,
      403
    );
  }

  if (!isManagedPrivateStorageReference(doc.storageReference)) {
    throw new AdminAuthError(
      "DOCUMENT_CONTENT_UNAVAILABLE",
      "Document content is unavailable in managed private storage.",
      404
    );
  }

  const storageKey = doc.storageReference.slice("private://".length);
  let buffer: Buffer;
  try {
    buffer = await getActiveStorageAdapter().getObject(storageKey);
  } catch {
    throw new AdminAuthError(
      "DOCUMENT_CONTENT_UNAVAILABLE",
      "Stored document bytes could not be loaded from private storage.",
      404
    );
  }

  const actualSha = computeSha256Hex(buffer);
  if (doc.checksumSha256 && actualSha !== doc.checksumSha256) {
    throw new AdminAuthError(
      "DOCUMENT_CHECKSUM_MISMATCH",
      "Stored document failed SHA-256 integrity verification.",
      409
    );
  }

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
    },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });

  return {
    buffer,
    mimeType: doc.mimeType,
    fileName: sanitizeUploadFileName(
      doc.originalFileName || `${doc.documentType.toLowerCase()}.pdf`
    ),
    checksumSha256: actualSha,
  };
}

export async function verifyStoredDocumentAccessible(
  storageReference: string,
  expectedChecksumSha256?: string | null
): Promise<{ accessible: boolean; reason?: string }> {
  if (!isManagedPrivateStorageReference(storageReference)) {
    return {
      accessible: false,
      reason:
        "Document does not reside in verified private object storage (managed private:// reference required).",
    };
  }

  const storageKey = storageReference.slice("private://".length);
  let buffer: Buffer;
  try {
    buffer = await getActiveStorageAdapter().getObject(storageKey);
  } catch {
    return {
      accessible: false,
      reason: "Stored document content cannot be retrieved from private storage.",
    };
  }

  if (buffer.byteLength === 0) {
    return {
      accessible: false,
      reason: "Stored document file is empty.",
    };
  }

  if (expectedChecksumSha256) {
    const actual = computeSha256Hex(buffer);
    if (actual !== expectedChecksumSha256) {
      return {
        accessible: false,
        reason: "Stored document SHA-256 checksum does not match metadata.",
      };
    }
  }

  return { accessible: true };
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

  if (params.documentCategory === "PROVIDER" && (params.centerId || params.caregiverId)) {
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
      .where(and(eq(centers.id, cg.centerId), eq(centers.providerId, provider.id)))
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
          },
          ipAddress: params.ipAddress,
          userAgent: params.userAgent,
        },
        tx
      );

      return created.id;
    });
  } catch (err) {
    const storageKey = stored.storageReference.slice("private://".length);
    await getActiveStorageAdapter().deleteObject?.(storageKey).catch(() => {});
    throw err;
  }

  // Trigger trusted backend scan immediately only when a scanner backend is configured
  let scanStatus: string = "PENDING";
  if (isMalwareScannerConfigured()) {
    const scanRes = await runAndPersistDocumentScan({
      documentId: insertedDocId,
      admin: params.admin,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
    scanStatus = scanRes.malwareScanStatus;
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
  };
}

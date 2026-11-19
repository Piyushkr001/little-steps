import { type NextRequest, NextResponse } from "next/server";
import { uploadVerificationDocumentSchema } from "../lib/admin/validation";
import {
  type CookieInstruction,
  dispatchAdminApiRequest,
  handleDocumentContentStreamRequest,
  mapAdminApiError,
  requireAdminPermission,
  requireAuthenticatedAdmin,
  type UnifiedApiRequest,
} from "./dispatcher";
import { checkRateLimit, extractTrustedClientIp } from "./middleware/rate-limit";
import { AdminAuthError } from "./services/admin-auth.service";
import {
  MAX_DOCUMENT_SIZE_BYTES,
  MAX_JSON_UPLOAD_REQUEST_BYTES,
  MAX_MULTIPART_REQUEST_BYTES,
  readBoundedStreamWithChecksum,
  uploadAndRegisterVerificationDocument,
} from "./services/document-storage.service";

export function extractUnifiedRequestFromNext(
  request: NextRequest,
  segments: string[],
  body: unknown = undefined
): UnifiedApiRequest {
  const query: Record<string, string | undefined> = {};
  request.nextUrl.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const cookies: Record<string, string | undefined> = {};
  for (const cookie of request.cookies.getAll()) {
    cookies[cookie.name] = cookie.value;
  }

  const headers: Record<string, string | undefined> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  return {
    method: request.method,
    segments,
    query,
    body,
    cookies,
    headers,
    ipAddress: extractTrustedClientIp(headers, "127.0.0.1"),
    userAgent: request.headers.get("user-agent") || "NextClient",
  };
}

export function applyCookiesToNextResponse(
  response: NextResponse,
  cookiesToSet?: CookieInstruction[]
): NextResponse {
  if (!cookiesToSet) return response;
  for (const c of cookiesToSet) {
    response.cookies.set(c.name, c.value, {
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
      path: c.path,
      maxAge: c.maxAge,
    });
  }
  return response;
}

/**
 * Enforces an HTTP request-body size ceiling BEFORE and DURING stream reading,
 * returning HTTP 413 Payload Too Large immediately if Content-Length or actual
 * streamed bytes exceed `maxBytes`.
 */
export async function readBoundedRequestBytes(
  request: Request,
  maxBytes: number
): Promise<Buffer> {
  const rawContentLength = request.headers.get("content-length");
  if (rawContentLength !== null) {
    const parsedLength = Number(rawContentLength.trim());
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new AdminAuthError(
        "PAYLOAD_TOO_LARGE",
        `Request payload exceeds maximum allowed size (${Math.round(maxBytes / (1024 * 1024))} MB).`,
        413
      );
    }
  }

  if (!request.body) {
    return Buffer.alloc(0);
  }

  const { buffer } = await readBoundedStreamWithChecksum(
    request.body,
    maxBytes
  );
  return buffer;
}

export async function handleNextDocumentContentGet(
  request: NextRequest,
  documentId: string
): Promise<NextResponse> {
  const unifiedReq = extractUnifiedRequestFromNext(request, [
    "verification-documents",
    documentId,
    "content",
  ]);
  const streamResult = await handleDocumentContentStreamRequest(
    unifiedReq,
    documentId
  );

  if (!streamResult.ok) {
    return NextResponse.json(streamResult.response.body, {
      status: streamResult.response.status,
    });
  }

  return new NextResponse(new Uint8Array(streamResult.buffer), {
    status: 200,
    headers: streamResult.headers,
  });
}

const multipartMetadataSchema = uploadVerificationDocumentSchema.omit({
  fileBase64: true,
});

export async function handleNextDocumentUploadPost(
  request: NextRequest
): Promise<NextResponse> {
  const rawContentType = request.headers.get("content-type") || "";
  const contentType = rawContentType.toLowerCase();

  try {
    if (!contentType.includes("multipart/form-data")) {
      // Authenticate & authorize before reading large JSON upload payloads
      const preAuthReq = extractUnifiedRequestFromNext(
        request,
        ["verification-documents", "upload"],
        undefined
      );
      const admin = await requireAuthenticatedAdmin(preAuthReq, true);
      await requireAdminPermission(
        admin,
        "documents:upload",
        preAuthReq,
        "POST /verification-documents/upload"
      );

      const boundedBytes = await readBoundedRequestBytes(
        request,
        MAX_JSON_UPLOAD_REQUEST_BYTES
      );
      let body: unknown = {};
      if (boundedBytes.byteLength > 0) {
        try {
          body = JSON.parse(boundedBytes.toString("utf8"));
        } catch {
          throw new AdminAuthError(
            "INVALID_JSON_BODY",
            "Upload request body must be valid JSON.",
            400
          );
        }
      }

      const unifiedReq = extractUnifiedRequestFromNext(
        request,
        ["verification-documents", "upload"],
        body
      );
      const result = await dispatchAdminApiRequest(unifiedReq);
      return applyCookiesToNextResponse(
        NextResponse.json(result.body, { status: result.status }),
        result.cookiesToSet
      );
    }

    // Multipart upload path: authenticate, authorize, and rate-limit BEFORE reading body bytes
    const unifiedReq = extractUnifiedRequestFromNext(
      request,
      ["verification-documents", "upload"],
      undefined
    );
    const routeKey = "POST /verification-documents/upload";
    const admin = await requireAuthenticatedAdmin(unifiedReq, true);
    await requireAdminPermission(admin, "documents:upload", unifiedReq, routeKey);

    const [ipLimit, acctLimit] = await Promise.all([
      checkRateLimit(`doc-upload-ip:${unifiedReq.ipAddress}`, 30, 10 * 60_000),
      checkRateLimit(`doc-upload-acct:${admin.id}`, 30, 10 * 60_000),
    ]);
    if (!ipLimit.allowed || !acctLimit.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message:
              "Too many document upload requests. Please try again shortly.",
          },
        },
        { status: 429 }
      );
    }

    // Stream-bounded ingestion enforces the 11 MB HTTP multipart ceiling BEFORE formData() parses
    const boundedMultipartBytes = await readBoundedRequestBytes(
      request,
      MAX_MULTIPART_REQUEST_BYTES
    );

    if (boundedMultipartBytes.byteLength === 0) {
      throw new AdminAuthError(
        "EMPTY_UPLOAD_BODY",
        "Upload request body cannot be empty.",
        400
      );
    }

    const boundedResponse = new Response(new Uint8Array(boundedMultipartBytes), {
      headers: { "content-type": rawContentType },
    });
    const formData = await boundedResponse.formData();

    const uploadedFile = formData.get("file");
    if (!(uploadedFile instanceof File)) {
      throw new AdminAuthError(
        "DOCUMENT_FILE_REQUIRED",
        "A multipart 'file' field is required when uploading a document.",
        400
      );
    }

    if (uploadedFile.size === 0) {
      throw new AdminAuthError(
        "EMPTY_DOCUMENT_FILE",
        "Uploaded verification document cannot be empty.",
        400
      );
    }

    if (uploadedFile.size > MAX_DOCUMENT_SIZE_BYTES) {
      throw new AdminAuthError(
        "PAYLOAD_TOO_LARGE",
        "Uploaded verification document exceeds the 10 MB security size limit.",
        413
      );
    }

    const arrayBuffer = await uploadedFile.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);
    if (fileBuffer.byteLength === 0) {
      throw new AdminAuthError(
        "EMPTY_DOCUMENT_FILE",
        "Uploaded verification document cannot be empty.",
        400
      );
    }
    if (fileBuffer.byteLength > MAX_DOCUMENT_SIZE_BYTES) {
      throw new AdminAuthError(
        "PAYLOAD_TOO_LARGE",
        "Uploaded verification document exceeds the 10 MB security size limit.",
        413
      );
    }

    const getStr = (key: string) => {
      const val = formData.get(key);
      return typeof val === "string" && val.trim().length > 0
        ? val.trim()
        : undefined;
    };

    const parsedMeta = multipartMetadataSchema.parse({
      providerId: getStr("providerId"),
      centerId: getStr("centerId") ?? null,
      caregiverId: getStr("caregiverId") ?? null,
      documentCategory: getStr("documentCategory"),
      documentType: getStr("documentType"),
      documentTitle: getStr("documentTitle"),
      fileName: getStr("fileName") || uploadedFile.name || "document.pdf",
      mimeType:
        getStr("mimeType") ||
        (uploadedFile.type ? uploadedFile.type.toLowerCase() : undefined),
      expiresAt: getStr("expiresAt") ?? null,
    });

    const result = await uploadAndRegisterVerificationDocument({
      providerId: parsedMeta.providerId,
      centerId: parsedMeta.centerId ?? null,
      caregiverId: parsedMeta.caregiverId ?? null,
      documentCategory: parsedMeta.documentCategory,
      documentType: parsedMeta.documentType,
      documentTitle: parsedMeta.documentTitle,
      fileName: parsedMeta.fileName,
      declaredMimeType: parsedMeta.mimeType,
      buffer: fileBuffer,
      expiresAt: parsedMeta.expiresAt ? new Date(parsedMeta.expiresAt) : null,
      admin,
      ipAddress: unifiedReq.ipAddress,
      userAgent: unifiedReq.userAgent,
    });

    return NextResponse.json(
      {
        success: true,
        message:
          result.malwareScanStatus === "CLEAN"
            ? "Verification document uploaded and scanned cleanly."
            : "Verification document uploaded to private storage with PENDING malware scan.",
        data: result,
      },
      { status: 201 }
    );
  } catch (error) {
    const mapped = mapAdminApiError(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
}

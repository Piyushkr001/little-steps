import crypto from "node:crypto";

export interface StoredObjectHead {
  exists: boolean;
  contentLength?: number;
  contentType?: string;
  etag?: string;
  sha256Metadata?: string;
}

export interface StoredObjectStreamResult {
  stream: ReadableStream<Uint8Array>;
  contentLength?: number;
  contentType?: string;
  sha256Metadata?: string;
}

export interface PutObjectOptions {
  contentType?: string;
  sha256Hex?: string;
  metadata?: Record<string, string>;
}

export interface S3StorageConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  forcePathStyle: boolean;
  sseMode: "AES256" | "aws:kms" | "none";
  kmsKeyId?: string;
  timeoutMs: number;
}

export class ObjectStorageError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 502) {
    super(message);
    this.name = "ObjectStorageError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function encodeObjectKeyPath(key: string): string {
  return key
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeRfc3986(segment))
    .join("/");
}

/**
 * Resolves and validates S3-compatible private object storage configuration
 * from environment variables without ever logging or returning secret material
 * in diagnostic responses.
 */
export function resolveS3StorageConfig(
  env: NodeJS.ProcessEnv = process.env
): S3StorageConfig | null {
  const bucket = env.S3_BUCKET?.trim();
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY;
  const endpoint = env.S3_ENDPOINT?.trim() || undefined;
  const region =
    env.S3_REGION?.trim() || (endpoint ? "auto" : "");

  if (!bucket && !accessKeyId && !secretAccessKey && !endpoint) {
    return null;
  }

  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    throw new ObjectStorageError(
      "S3_STORAGE_MISCONFIGURED",
      "Incomplete S3-compatible storage configuration. Required: S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY.",
      503
    );
  }

  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new ObjectStorageError(
      "S3_BUCKET_INVALID",
      "Configured S3_BUCKET name is invalid.",
      503
    );
  }

  const isProd = env.NODE_ENV === "production";
  if (endpoint) {
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new ObjectStorageError(
        "S3_ENDPOINT_INVALID",
        "Configured S3_ENDPOINT is not a valid URL.",
        503
      );
    }
    if (isProd && parsed.protocol !== "https:") {
      throw new ObjectStorageError(
        "S3_TLS_REQUIRED",
        "Production S3_ENDPOINT must use HTTPS/TLS transport.",
        503
      );
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new ObjectStorageError(
        "S3_ENDPOINT_INVALID",
        "S3_ENDPOINT must use http:// or https:// protocol.",
        503
      );
    }
  }

  const rawSse = (env.S3_SSE_MODE?.trim() || (endpoint ? "none" : "AES256")).toLowerCase();
  let sseMode: "AES256" | "aws:kms" | "none" = "AES256";
  if (rawSse === "none" || rawSse === "off") {
    sseMode = "none";
  } else if (rawSse === "aws:kms" || rawSse === "kms") {
    sseMode = "aws:kms";
  } else {
    sseMode = "AES256";
  }

  const parsedTimeout = Number(env.S3_TIMEOUT_MS || 20_000);
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout >= 1000 && parsedTimeout <= 120_000
      ? parsedTimeout
      : 20_000;

  return {
    bucket,
    region,
    endpoint,
    accessKeyId,
    secretAccessKey,
    sessionToken: env.S3_SESSION_TOKEN?.trim() || undefined,
    forcePathStyle:
      env.S3_FORCE_PATH_STYLE === "true" || Boolean(endpoint),
    sseMode,
    kmsKeyId: env.S3_KMS_KEY_ID?.trim() || undefined,
    timeoutMs,
  };
}

function buildS3TargetUrl(config: S3StorageConfig, objectKey: string): URL {
  const encodedKey = encodeObjectKeyPath(objectKey);

  if (config.endpoint) {
    const base = new URL(config.endpoint);
    const basePath = base.pathname.replace(/\/+$/, "");
    if (config.forcePathStyle) {
      base.pathname = `${basePath}/${encodeRfc3986(config.bucket)}/${encodedKey}`;
    } else {
      base.hostname = `${config.bucket}.${base.hostname}`;
      base.pathname = `${basePath}/${encodedKey}`;
    }
    return base;
  }

  if (config.forcePathStyle) {
    return new URL(
      `https://s3.${config.region}.amazonaws.com/${encodeRfc3986(config.bucket)}/${encodedKey}`
    );
  }

  return new URL(
    `https://${config.bucket}.s3.${config.region}.amazonaws.com/${encodedKey}`
  );
}

function signAwsV4Request(params: {
  config: S3StorageConfig;
  method: "PUT" | "GET" | "HEAD" | "DELETE";
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  now?: Date;
}): Record<string, string> {
  const now = params.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const normalizedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(params.headers)) {
    normalizedHeaders[k.toLowerCase()] = v.trim();
  }
  normalizedHeaders["host"] = params.url.host;
  normalizedHeaders["x-amz-date"] = amzDate;
  normalizedHeaders["x-amz-content-sha256"] = params.payloadHash;
  if (params.config.sessionToken) {
    normalizedHeaders["x-amz-security-token"] = params.config.sessionToken;
  }

  const sortedHeaderKeys = Object.keys(normalizedHeaders).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k}:${normalizedHeaders[k]}\n`)
    .join("");
  const signedHeaders = sortedHeaderKeys.join(";");

  const canonicalQueryString = Array.from(params.url.searchParams.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join("&");

  const canonicalRequest = [
    params.method,
    params.url.pathname || "/",
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    params.payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${params.config.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmacSha256(`AWS4${params.config.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, params.config.region);
  const kService = hmacSha256(kRegion, "s3");
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = crypto
    .createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${params.config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    ...normalizedHeaders,
    authorization,
  };
}

function classifyFetchError(err: unknown, operation: string): ObjectStorageError {
  if (err instanceof ObjectStorageError) return err;
  const errName = err instanceof Error ? err.name : "";
  if (errName === "TimeoutError" || errName === "AbortError") {
    return new ObjectStorageError(
      "STORAGE_TIMEOUT",
      `Object storage ${operation} timed out.`,
      504
    );
  }
  return new ObjectStorageError(
    "STORAGE_NETWORK_ERROR",
    `Object storage ${operation} failed due to a network or connectivity error.`,
    503
  );
}

/**
 * Creates an S3-compatible persistent private object storage adapter supporting
 * Amazon S3, Cloudflare R2, MinIO, and other AWS SigV4-compatible endpoints.
 */
export function createS3CompatibleStorageAdapter(config: S3StorageConfig) {
  return {
    driverName: "s3" as const,

    async putObject(
      key: string,
      buffer: Buffer,
      options?: PutObjectOptions
    ): Promise<void> {
      const url = buildS3TargetUrl(config, key);
      const payloadHash = options?.sha256Hex || sha256Hex(buffer);
      const baseHeaders: Record<string, string> = {
        "content-type": options?.contentType || "application/octet-stream",
        "content-length": String(buffer.byteLength),
        "x-amz-meta-sha256": payloadHash,
      };

      if (config.sseMode === "AES256") {
        baseHeaders["x-amz-server-side-encryption"] = "AES256";
      } else if (config.sseMode === "aws:kms") {
        baseHeaders["x-amz-server-side-encryption"] = "aws:kms";
        if (config.kmsKeyId) {
          baseHeaders["x-amz-server-side-encryption-aws-kms-key-id"] =
            config.kmsKeyId;
        }
      }

      if (options?.metadata) {
        for (const [metaKey, metaVal] of Object.entries(options.metadata)) {
          const cleanKey = metaKey.toLowerCase().replace(/[^a-z0-9_-]/g, "");
          if (cleanKey) {
            baseHeaders[`x-amz-meta-${cleanKey}`] = metaVal.slice(0, 256);
          }
        }
      }

      const signedHeaders = signAwsV4Request({
        config,
        method: "PUT",
        url,
        headers: baseHeaders,
        payloadHash,
      });

      let response: Response;
      try {
        response = await fetch(url, {
          method: "PUT",
          headers: signedHeaders,
          body: new Uint8Array(buffer),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (err) {
        throw classifyFetchError(err, "upload");
      }

      if (!response.ok) {
        throw new ObjectStorageError(
          "STORAGE_UPLOAD_FAILED",
          `Persistent object storage rejected upload (HTTP ${response.status}).`,
          response.status === 403 ? 503 : 502
        );
      }
    },

    async getObjectStream(key: string): Promise<StoredObjectStreamResult> {
      const url = buildS3TargetUrl(config, key);
      const emptyHash = sha256Hex("");
      const signedHeaders = signAwsV4Request({
        config,
        method: "GET",
        url,
        headers: {},
        payloadHash: emptyHash,
      });

      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: signedHeaders,
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (err) {
        throw classifyFetchError(err, "download");
      }

      if (response.status === 404) {
        throw new ObjectStorageError(
          "STORAGE_OBJECT_NOT_FOUND",
          "Stored document object was not found in persistent storage.",
          404
        );
      }

      if (!response.ok || !response.body) {
        throw new ObjectStorageError(
          "STORAGE_DOWNLOAD_FAILED",
          `Persistent object storage failed to return object stream (HTTP ${response.status}).`,
          502
        );
      }

      const rawLength = response.headers.get("content-length");
      const contentLength =
        rawLength !== null && /^\d+$/.test(rawLength)
          ? Number(rawLength)
          : undefined;

      return {
        stream: response.body,
        contentLength,
        contentType: response.headers.get("content-type") || undefined,
        sha256Metadata: response.headers.get("x-amz-meta-sha256") || undefined,
      };
    },

    async getObject(key: string, maxBytes = 10 * 1024 * 1024): Promise<Buffer> {
      const { stream, contentLength } = await this.getObjectStream(key);
      if (contentLength !== undefined && contentLength > maxBytes) {
        await stream.cancel().catch(() => {});
        throw new ObjectStorageError(
          "STORAGE_OBJECT_TOO_LARGE",
          "Stored object exceeds maximum allowed document size.",
          413
        );
      }

      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new ObjectStorageError(
              "STORAGE_OBJECT_TOO_LARGE",
              "Stored object stream exceeded maximum allowed document size.",
              413
            );
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }

      return Buffer.concat(chunks.map((c) => Buffer.from(c)));
    },

    async headObject(key: string): Promise<StoredObjectHead> {
      const url = buildS3TargetUrl(config, key);
      const emptyHash = sha256Hex("");
      const signedHeaders = signAwsV4Request({
        config,
        method: "HEAD",
        url,
        headers: {},
        payloadHash: emptyHash,
      });

      let response: Response;
      try {
        response = await fetch(url, {
          method: "HEAD",
          headers: signedHeaders,
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (err) {
        throw classifyFetchError(err, "head");
      }

      if (response.status === 404) {
        return { exists: false };
      }

      if (!response.ok) {
        throw new ObjectStorageError(
          "STORAGE_HEAD_FAILED",
          `Persistent object storage metadata check failed (HTTP ${response.status}).`,
          502
        );
      }

      const rawLength = response.headers.get("content-length");
      return {
        exists: true,
        contentLength:
          rawLength !== null && /^\d+$/.test(rawLength)
            ? Number(rawLength)
            : undefined,
        contentType: response.headers.get("content-type") || undefined,
        etag: response.headers.get("etag") || undefined,
        sha256Metadata: response.headers.get("x-amz-meta-sha256") || undefined,
      };
    },

    async deleteObject(key: string): Promise<void> {
      const url = buildS3TargetUrl(config, key);
      const emptyHash = sha256Hex("");
      const signedHeaders = signAwsV4Request({
        config,
        method: "DELETE",
        url,
        headers: {},
        payloadHash: emptyHash,
      });

      let response: Response;
      try {
        response = await fetch(url, {
          method: "DELETE",
          headers: signedHeaders,
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (err) {
        throw classifyFetchError(err, "delete");
      }

      if (!response.ok && response.status !== 404) {
        throw new ObjectStorageError(
          "STORAGE_DELETE_FAILED",
          `Persistent object storage delete failed (HTTP ${response.status}).`,
          502
        );
      }
    },
  };
}

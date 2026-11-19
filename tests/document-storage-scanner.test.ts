import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { type AppDatabase, setDatabaseInstanceForTests } from "../config/db";
import {
  adminAuditLogs,
  providers,
  users,
  verificationDocuments,
} from "../config/schema";
import type { AuthenticatedAdmin } from "../lib/admin/types";
import {
  scanBufferWithClamAv,
  scanDocumentBuffer,
  setDocumentScannerForTests,
  validateClamAvConfiguration,
} from "../server/services/document-scanner.service";
import {
  computeSha256Hex,
  type DocumentStorageAdapter,
  localPrivateStorageAdapter,
  migrateLocalDocumentsToPersistentStorage,
  runAndPersistDocumentScan,
  setDocumentStorageAdapterForTests,
  uploadAndRegisterVerificationDocument,
  validateObjectKey,
  verifyStoredDocumentAccessible,
} from "../server/services/document-storage.service";
import {
  createS3CompatibleStorageAdapter,
  ObjectStorageError,
  resolveS3StorageConfig,
} from "../server/services/s3-storage.adapter";

type Row = Record<string, unknown>;

const pgDialect = new PgDialect();

function buildColMap(table: object): Map<string, string> {
  const map = new Map<string, string>();
  for (const [jsKey, val] of Object.entries(table)) {
    if (
      val &&
      typeof val === "object" &&
      "name" in val &&
      typeof (val as { name?: unknown }).name === "string"
    ) {
      map.set((val as { name: string }).name, jsKey);
    }
  }
  return map;
}

function stripOuterParens(input: string): string {
  let s = input.trim();
  while (s.startsWith("(") && s.endsWith(")")) {
    let depth = 0;
    let wrapsWhole = true;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") depth--;
      if (depth === 0 && i < s.length - 1) {
        wrapsWhole = false;
        break;
      }
    }
    if (!wrapsWhole) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

function splitTopLevel(input: string, keyword: "and" | "or"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let lastIdx = 0;
  const lower = input.toLowerCase();
  const token = ` ${keyword} `;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && lower.startsWith(token, i)) {
      parts.push(input.slice(lastIdx, i).trim());
      i += token.length - 1;
      lastIdx = i + 1;
    }
  }
  parts.push(input.slice(lastIdx).trim());
  return parts;
}

function toNum(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return Date.parse(v);
  return Number(v);
}

function evalSql(
  raw: string,
  row: Row,
  colMap: Map<string, string>,
  params: unknown[]
): boolean {
  const expr = stripOuterParens(raw);
  if (!expr) return true;

  const orParts = splitTopLevel(expr, "or");
  if (orParts.length > 1) return orParts.some((p) => evalSql(p, row, colMap, params));
  const andParts = splitTopLevel(expr, "and");
  if (andParts.length > 1) return andParts.every((p) => evalSql(p, row, colMap, params));

  const isNullM = expr.match(/^"[^"]+"\."([^"]+)"\s+is\s+null$/i);
  if (isNullM) {
    const k = colMap.get(isNullM[1]) ?? isNullM[1];
    return row[k] === null || row[k] === undefined;
  }
  const eqM = expr.match(/^"[^"]+"\."([^"]+)"\s*=\s*\$(\d+)$/i);
  if (eqM) {
    const k = colMap.get(eqM[1]) ?? eqM[1];
    return row[k] === params[Number(eqM[2]) - 1];
  }
  const neM = expr.match(/^"[^"]+"\."([^"]+)"\s*(?:<>|!=)\s*\$(\d+)$/i);
  if (neM) {
    const k = colMap.get(neM[1]) ?? neM[1];
    return row[k] !== params[Number(neM[2]) - 1];
  }
  const ltM = expr.match(/^"[^"]+"\."([^"]+)"\s*<\s*\$(\d+)$/i);
  if (ltM) {
    const k = colMap.get(ltM[1]) ?? ltM[1];
    return toNum(row[k]) < toNum(params[Number(ltM[2]) - 1]);
  }
  const gtM = expr.match(/^"[^"]+"\."([^"]+)"\s*>\s*\$(\d+)$/i);
  if (gtM) {
    const k = colMap.get(gtM[1]) ?? gtM[1];
    return toNum(row[k]) > toNum(params[Number(gtM[2]) - 1]);
  }
  return true;
}

function createLightweightStorageTestDb() {
  const tables = new Map<object, Row[]>([
    [users, []],
    [providers, []],
    [verificationDocuments, []],
    [adminAuditLogs, []],
  ]);
  let failNextInsertOn: object | null = null;

  const getRows = (t: object) => {
    if (!tables.has(t)) tables.set(t, []);
    return tables.get(t)!;
  };

  const matchRow = (table: object, row: Row, cond: unknown): boolean => {
    if (!cond) return true;
    const colMap = buildColMap(table);
    const { sql: rawSql, params } = pgDialect.sqlToQuery(
      cond as Parameters<typeof pgDialect.sqlToQuery>[0]
    );
    return evalSql(rawSql, row, colMap, params);
  };

  const mockDb = {
    select() {
      return {
        from(table: object) {
          let whereCond: unknown = null;
          let maxRows: number | null = null;
          const exec = async () => {
            let rows = getRows(table).filter((r) => matchRow(table, r, whereCond));
            if (maxRows !== null) rows = rows.slice(0, maxRows);
            return rows.map((r) => ({ ...r }));
          };
          const builder = {
            where(c: unknown) {
              whereCond = c;
              return builder;
            },
            orderBy() {
              return builder;
            },
            limit(n: number) {
              maxRows = n;
              return builder;
            },
            for() {
              return builder;
            },
            then<T1 = Row[], T2 = never>(
              ok?: ((v: Row[]) => T1 | PromiseLike<T1>) | null,
              fail?: ((r: unknown) => T2 | PromiseLike<T2>) | null
            ) {
              return exec().then(ok, fail);
            },
          };
          return builder;
        },
      };
    },
    insert(table: object) {
      return {
        values(raw: Row | Row[]) {
          if (failNextInsertOn === table) {
            failNextInsertOn = null;
            const err = new Error("Simulated DB insert failure after storage write");
            return {
              returning: () => Promise.reject(err),
              then: (_ok: unknown, fail?: (e: unknown) => unknown) =>
                Promise.reject(err).then(undefined, fail),
            };
          }
          const items = Array.isArray(raw) ? raw : [raw];
          const now = new Date();
          const created: Row[] = [];
          for (const item of items) {
            const rec: Row = {
              id: (item.id as string) || crypto.randomUUID(),
              createdAt: (item.createdAt as Date) || now,
              updatedAt: (item.updatedAt as Date) || now,
              quarantinedAt: item.quarantinedAt ?? null,
              malwareScannedAt: item.malwareScannedAt ?? null,
              malwareScanProvider: item.malwareScanProvider ?? null,
              malwareScanResult: item.malwareScanResult ?? null,
              replacementRequested: item.replacementRequested ?? false,
              rejectionReason: item.rejectionReason ?? null,
              ...item,
            };
            getRows(table).push(rec);
            created.push({ ...rec });
          }
          return {
            returning: () => Promise.resolve(created),
            then: <T1 = Row[]>(ok?: ((v: Row[]) => T1 | PromiseLike<T1>) | null) =>
              Promise.resolve(created).then(ok),
          };
        },
      };
    },
    update(table: object) {
      return {
        set(updates: Row) {
          let whereCond: unknown = null;
          const run = async () => {
            const rows = getRows(table);
            const changed: Row[] = [];
            for (const row of rows) {
              if (matchRow(table, row, whereCond)) {
                Object.assign(row, updates);
                changed.push({ ...row });
              }
            }
            return changed;
          };
          const builder = {
            where(c: unknown) {
              whereCond = c;
              return builder;
            },
            returning() {
              return run();
            },
            then<T1 = Row[], T2 = never>(
              ok?: ((v: Row[]) => T1 | PromiseLike<T1>) | null,
              fail?: ((r: unknown) => T2 | PromiseLike<T2>) | null
            ) {
              return run().then(ok, fail);
            },
          };
          return builder;
        },
      };
    },
    delete(table: object) {
      return {
        where(c: unknown) {
          tables.set(
            table,
            getRows(table).filter((r) => !matchRow(table, r, c))
          );
          return Promise.resolve();
        },
      };
    },
    async transaction<T>(fn: (tx: AppDatabase) => Promise<T>): Promise<T> {
      const snap = new Map<object, Row[]>();
      for (const [t, rows] of tables.entries()) {
        snap.set(
          t,
          rows.map((r) => structuredClone(r))
        );
      }
      try {
        return await fn(mockDb as unknown as AppDatabase);
      } catch (err) {
        for (const [t, rows] of snap.entries()) {
          tables.set(t, rows);
        }
        throw err;
      }
    },
    async execute() {
      return { rows: [] };
    },
  };

  return {
    db: mockDb as unknown as AppDatabase,
    tables,
    setFailNextInsertOn(t: object | null) {
      failNextInsertOn = t;
    },
  };
}

async function startMockClamAvTcpServer(
  mode: "CLEAN" | "INFECTED" | "INVALID" | "TIMEOUT" | "OVERSIZED"
): Promise<{ host: string; port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    let responded = false;

    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const joined = Buffer.concat(chunks);
      // Detect zINSTREAM\0 + zero-length terminator (4 zero bytes at end after header)
      if (
        !responded &&
        joined.byteLength >= 14 &&
        joined.subarray(0, 10).toString("utf8") === "zINSTREAM\0" &&
        joined.readUInt32BE(joined.byteLength - 4) === 0
      ) {
        responded = true;
        if (mode === "TIMEOUT") {
          return; // Intentionally hold socket open until client timeout
        }
        if (mode === "CLEAN") {
          socket.end("stream: OK\0");
        } else if (mode === "INFECTED") {
          socket.end("stream: Eicar-Test-Signature FOUND\0");
        } else if (mode === "INVALID") {
          socket.end("GARBAGE PROTOCOL RESPONSE\0");
        } else if (mode === "OVERSIZED") {
          socket.end("X".repeat(8192));
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as net.AddressInfo;
  return {
    host: "127.0.0.1",
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function runStorageAndScannerIntegrationSuite() {
  console.log(
    "=================================================================="
  );
  console.log(
    "Little Steps — Final Phase 2.1 Storage & Malware Scanner Test Suite"
  );
  console.log(
    "=================================================================="
  );

  const origFetch = globalThis.fetch;
  const mutableEnv = process.env as Record<string, string | undefined>;
  const origNodeEnv = mutableEnv.NODE_ENV;
  const origSessionSecret = process.env.ADMIN_SESSION_SECRET;
  const origStorageDir = process.env.PRIVATE_DOCUMENT_STORAGE_DIR;
  const origStorageDriver = process.env.DOCUMENT_STORAGE_DRIVER;
  const origClamHost = process.env.CLAMAV_HOST;
  const origClamPort = process.env.CLAMAV_PORT;

  process.env.ADMIN_SESSION_SECRET =
    "f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f";

  const tempLocalDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "ls-private-storage-test-")
  );
  process.env.PRIVATE_DOCUMENT_STORAGE_DIR = tempLocalDir;

  const { db: testDb, setFailNextInsertOn } = createLightweightStorageTestDb();
  setDatabaseInstanceForTests(testDb);

  const samplePdf = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
    "utf8"
  );
  const sampleSha = computeSha256Hex(samplePdf);

  const testAdmin: AuthenticatedAdmin = {
    id: crypto.randomUUID(),
    email: "storage.admin@littlesteps.com",
    name: "Storage Compliance Admin",
    role: "SUPER_ADMIN",
    status: "ACTIVE",
    department: "Security",
    title: "Lead Reviewer",
    permissions: [
      "documents:read",
      "documents:review",
      "documents:upload",
      "documents:scan",
      "providers:read",
      "providers:verify",
    ],
    sessionId: crypto.randomUUID(),
    csrfToken: "csrf-storage-test",
    lastLoginAt: null,
    sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };

  const [provider] = await testDb
    .insert(providers)
    .values({
      ownerUserId: crypto.randomUUID(),
      organizationName: "Durable Storage Childcare Org",
      registrationNumber: "REG-S3-01",
      contactEmail: "org@example.com",
      contactPhone: "555-0100",
      address: "10 Cloud Way",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      verificationStatus: "PENDING",
      subscriptionActive: true,
      isPublished: false,
    })
    .returning();

  try {
    // =========================================================================
    // PART 1: S3-Compatible Persistent Private Object Storage Integration Tests
    // =========================================================================
    console.log(
      "S1. Testing S3 SigV4 Upload, Stream Retrieval, Head, Checksum & Error Handling..."
    );

    const mockS3Store = new Map<
      string,
      { body: Buffer; contentType: string; sha256: string; sse?: string }
    >();
    let simulateS3Mode: "OK" | "403" | "500" | "TIMEOUT" = "OK";
    const observedHeaders: Array<Record<string, string>> = [];

    globalThis.fetch = (async (input, init) => {
      if (simulateS3Mode === "TIMEOUT") {
        const err = new Error("Simulated S3 timeout");
        err.name = "TimeoutError";
        throw err;
      }
      if (simulateS3Mode === "403") {
        return new Response("AccessDenied", { status: 403 });
      }
      if (simulateS3Mode === "500") {
        return new Response("InternalError", { status: 500 });
      }

      const url = new URL(String(input));
      const method = (init?.method || "GET").toUpperCase();
      const hdrs = (init?.headers ?? {}) as Record<string, string>;
      observedHeaders.push({ ...hdrs });

      assert.ok(
        hdrs.authorization?.startsWith("AWS4-HMAC-SHA256 "),
        "S3 requests must carry AWS4-HMAC-SHA256 signature"
      );
      assert.ok(hdrs["x-amz-date"], "S3 requests must carry x-amz-date");
      assert.ok(
        hdrs["x-amz-content-sha256"],
        "S3 requests must carry x-amz-content-sha256"
      );

      const objectKey = url.pathname;
      if (method === "PUT") {
        const bytes = Buffer.from(init?.body as Uint8Array);
        mockS3Store.set(objectKey, {
          body: bytes,
          contentType: hdrs["content-type"] || "application/octet-stream",
          sha256: hdrs["x-amz-meta-sha256"] || computeSha256Hex(bytes),
          sse: hdrs["x-amz-server-side-encryption"],
        });
        return new Response(null, { status: 200, headers: { etag: `"${computeSha256Hex(bytes)}"` } });
      }

      if (method === "HEAD") {
        const found = mockS3Store.get(objectKey);
        if (!found) return new Response(null, { status: 404 });
        return new Response(null, {
          status: 200,
          headers: {
            "content-length": String(found.body.byteLength),
            "content-type": found.contentType,
            "x-amz-meta-sha256": found.sha256,
          },
        });
      }

      if (method === "GET") {
        const found = mockS3Store.get(objectKey);
        if (!found) return new Response("NoSuchKey", { status: 404 });
        return new Response(new Uint8Array(found.body), {
          status: 200,
          headers: {
            "content-length": String(found.body.byteLength),
            "content-type": found.contentType,
            "x-amz-meta-sha256": found.sha256,
          },
        });
      }

      if (method === "DELETE") {
        mockS3Store.delete(objectKey);
        return new Response(null, { status: 204 });
      }

      return new Response("MethodNotAllowed", { status: 405 });
    }) as typeof fetch;

    // Production S3 config rejects plain HTTP endpoint (TLS required)
    assert.throws(
      () =>
        resolveS3StorageConfig({
          NODE_ENV: "production",
          S3_BUCKET: "ls-private-docs",
          S3_REGION: "us-east-1",
          S3_ENDPOINT: "http://insecure.example.com",
          S3_ACCESS_KEY_ID: "AKIA_TEST",
          S3_SECRET_ACCESS_KEY: "secret_test",
        } as unknown as NodeJS.ProcessEnv),
      ObjectStorageError
    );

    const s3Config = resolveS3StorageConfig({
      NODE_ENV: "production",
      S3_BUCKET: "ls-private-docs",
      S3_REGION: "us-east-1",
      S3_ACCESS_KEY_ID: "AKIA_TEST_KEY",
      S3_SECRET_ACCESS_KEY: "test_secret_access_key_value",
      S3_SSE_MODE: "AES256",
      S3_TIMEOUT_MS: "5000",
    } as unknown as NodeJS.ProcessEnv)!;

    const s3Adapter = createS3CompatibleStorageAdapter(s3Config);

    // 1. Upload & SSE verification
    await s3Adapter.putObject("prov-1/abc123.pdf", samplePdf, {
      contentType: "application/pdf",
      sha256Hex: sampleSha,
    });
    const storedEntry = mockS3Store.get("/prov-1/abc123.pdf");
    assert.ok(storedEntry);
    assert.equal(storedEntry.sse, "AES256");

    // 2. Head & Retrieve & Checksum verification
    const headOk = await s3Adapter.headObject("prov-1/abc123.pdf");
    assert.equal(headOk.exists, true);
    assert.equal(headOk.contentLength, samplePdf.byteLength);

    const retrieved = await s3Adapter.getObject("prov-1/abc123.pdf");
    assert.equal(retrieved.equals(samplePdf), true);
    assert.equal(computeSha256Hex(retrieved), sampleSha);

    // 3. Invalid object keys rejected (path traversal, absolute path, NUL)
    assert.throws(() => validateObjectKey("../escape.pdf"));
    assert.throws(() => validateObjectKey("/etc/passwd"));
    assert.throws(() => validateObjectKey("dir/bad\0key.pdf"));
    assert.throws(() => validateObjectKey("dir\\windows\\escape.pdf"));

    // 4. Missing object returns 404 & head returns exists: false
    const headMissing = await s3Adapter.headObject("prov-1/does-not-exist.pdf");
    assert.equal(headMissing.exists, false);
    await assert.rejects(
      () => s3Adapter.getObject("prov-1/does-not-exist.pdf"),
      (err: unknown) =>
        err instanceof ObjectStorageError && err.statusCode === 404
    );

    // 5. Unauthorized S3 error (403 -> 503), Upload failure (500 -> 502), Storage timeout (504)
    simulateS3Mode = "403";
    await assert.rejects(
      () => s3Adapter.putObject("prov-1/denied.pdf", samplePdf),
      (err: unknown) =>
        err instanceof ObjectStorageError && err.statusCode === 503
    );

    simulateS3Mode = "500";
    await assert.rejects(
      () => s3Adapter.putObject("prov-1/fail.pdf", samplePdf),
      (err: unknown) =>
        err instanceof ObjectStorageError && err.statusCode === 502
    );

    simulateS3Mode = "TIMEOUT";
    await assert.rejects(
      () => s3Adapter.getObject("prov-1/abc123.pdf"),
      (err: unknown) =>
        err instanceof ObjectStorageError &&
        err.code === "STORAGE_TIMEOUT" &&
        err.statusCode === 504
    );
    simulateS3Mode = "OK";

    console.log(
      "    [PASS] S3 SigV4 upload/download/head/SSE, invalid key rejection, 403/404/500 & timeouts verified."
    );

    console.log(
      "S2. Testing Production Fail-Closed Storage, DB Failure Compensation & Local->S3 Migration..."
    );

    // Production MUST fail safely (503) when S3 is unconfigured — never fall back to local
    setDocumentStorageAdapterForTests(null);
    mutableEnv.NODE_ENV = "production";
    delete process.env.S3_BUCKET;
    process.env.DOCUMENT_STORAGE_DRIVER = "local";

    await assert.rejects(
      () =>
        uploadAndRegisterVerificationDocument({
          providerId: provider.id,
          documentCategory: "PROVIDER",
          documentType: "STATE_LICENSE",
          documentTitle: "Blocked Prod Local Upload",
          fileName: "license.pdf",
          declaredMimeType: "application/pdf",
          buffer: samplePdf,
          admin: testAdmin,
        }),
      (err: unknown) =>
        (err as { code?: string; statusCode?: number }).code ===
          "DOCUMENT_STORAGE_UNAVAILABLE" &&
        (err as { statusCode?: number }).statusCode === 503
    );
    if (origNodeEnv === undefined) {
      delete mutableEnv.NODE_ENV;
    } else {
      mutableEnv.NODE_ENV = origNodeEnv;
    }
    delete process.env.DOCUMENT_STORAGE_DRIVER;

    // DB insert failure after object storage putObject triggers compensating delete + orphan audit fallback
    let deletedKeys: string[] = [];
    let failDelete = false;
    const trackingAdapter: DocumentStorageAdapter = {
      driverName: "s3",
      async putObject() {},
      async getObject() {
        return samplePdf;
      },
      async deleteObject(key) {
        if (failDelete) throw new Error("Simulated delete failure");
        deletedKeys.push(key);
      },
    };
    setDocumentStorageAdapterForTests(trackingAdapter);
    delete process.env.CLAMAV_HOST;
    setDocumentScannerForTests(null);

    setFailNextInsertOn(verificationDocuments);
    await assert.rejects(
      () =>
        uploadAndRegisterVerificationDocument({
          providerId: provider.id,
          documentCategory: "PROVIDER",
          documentType: "STATE_LICENSE",
          documentTitle: "Compensated Cleanup Upload",
          fileName: "license.pdf",
          declaredMimeType: "application/pdf",
          buffer: samplePdf,
          admin: testAdmin,
        }),
      /Simulated DB insert failure after storage write/
    );
    assert.equal(
      deletedKeys.length,
      1,
      "Failed DB insert after upload must trigger compensating deleteObject"
    );

    // When compensating deleteObject also fails, orphan reconciliation audit log is written
    deletedKeys = [];
    failDelete = true;
    setFailNextInsertOn(verificationDocuments);
    await assert.rejects(
      () =>
        uploadAndRegisterVerificationDocument({
          providerId: provider.id,
          documentCategory: "PROVIDER",
          documentType: "STATE_LICENSE",
          documentTitle: "Orphan Reconciliation Upload",
          fileName: "license.pdf",
          declaredMimeType: "application/pdf",
          buffer: samplePdf,
          admin: testAdmin,
        }),
      /Simulated DB insert failure after storage write/
    );
    const orphanLogs = (await testDb.select().from(adminAuditLogs)).filter(
      (l) => l.action === "VERIFICATION_DOCUMENT_ORPHAN_RECONCILIATION_REQUIRED"
    );
    assert.equal(orphanLogs.length, 1);

    // Local-to-Persistent S3 migration utility (preserves local original, detects missing file, verifies SHA-256)
    setDocumentStorageAdapterForTests(null);
    await localPrivateStorageAdapter.putObject(
      `${provider.id}/legacy-license.pdf`,
      samplePdf
    );

    const [migratableDoc] = await testDb
      .insert(verificationDocuments)
      .values({
        providerId: provider.id,
        documentCategory: "PROVIDER",
        documentType: "STATE_LICENSE",
        documentTitle: "Legacy Local License",
        storageReference: `private://${provider.id}/legacy-license.pdf`,
        originalFileName: "legacy-license.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: samplePdf.byteLength,
        checksumSha256: sampleSha,
        malwareScanStatus: "PENDING",
        status: "SUBMITTED",
      })
      .returning();

    const [missingLocalDoc] = await testDb
      .insert(verificationDocuments)
      .values({
        providerId: provider.id,
        documentCategory: "PROVIDER",
        documentType: "MISSING_LEGACY",
        documentTitle: "Missing Local File",
        storageReference: `private://${provider.id}/gone.pdf`,
        originalFileName: "gone.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: samplePdf.byteLength,
        checksumSha256: sampleSha,
        malwareScanStatus: "PENDING",
        status: "SUBMITTED",
      })
      .returning();

    const dryRunRes = await migrateLocalDocumentsToPersistentStorage({
      admin: testAdmin,
      dryRun: true,
      sourceAdapter: localPrivateStorageAdapter,
      targetAdapter: s3Adapter,
    });
    assert.equal(dryRunRes.inventoriedLocalDocuments, 2);
    assert.deepEqual(dryRunRes.migratedIds, [migratableDoc.id]);
    assert.deepEqual(dryRunRes.unavailableIds, [missingLocalDoc.id]);

    const liveMigRes = await migrateLocalDocumentsToPersistentStorage({
      admin: testAdmin,
      dryRun: false,
      sourceAdapter: localPrivateStorageAdapter,
      targetAdapter: s3Adapter,
    });
    assert.deepEqual(liveMigRes.migratedIds, [migratableDoc.id]);
    assert.deepEqual(liveMigRes.unavailableIds, [missingLocalDoc.id]);

    // Verify DB reference updated to s3-private:// AND local original file NOT deleted
    const updatedRows = await testDb.select().from(verificationDocuments);
    const migratedRow = updatedRows.find((d) => d.id === migratableDoc.id)!;
    assert.ok(migratedRow.storageReference.startsWith("s3-private://"));
    const localStillExists = await localPrivateStorageAdapter.headObject!(
      `${provider.id}/legacy-license.pdf`
    );
    assert.equal(
      localStillExists.exists,
      true,
      "Migration must never delete local originals until independently verified"
    );

    console.log(
      "    [PASS] Production fail-closed storage, DB compensation/orphan audit & local->S3 migration verified."
    );

    // =========================================================================
    // PART 2: ClamAV zINSTREAM Scanner Integration Tests
    // =========================================================================
    console.log(
      "S3. Testing ClamAV TCP zINSTREAM Protocol (CLEAN, INFECTED, Timeout, Refused, Invalid, Concurrency, Recovery)..."
    );

    // Host/port validation checks
    assert.equal(
      validateClamAvConfiguration({ CLAMAV_HOST: "http://bad:3310" } as unknown as NodeJS.ProcessEnv).valid,
      false
    );
    assert.equal(
      validateClamAvConfiguration({ CLAMAV_HOST: "clamav.internal", CLAMAV_PORT: "99999" } as unknown as NodeJS.ProcessEnv).valid,
      false
    );
    assert.equal(
      validateClamAvConfiguration({ CLAMAV_HOST: "clamav.internal", CLAMAV_PORT: "3310" } as unknown as NodeJS.ProcessEnv).valid,
      true
    );

    // Unconfigured scanner stays PENDING (never CLEAN)
    delete process.env.CLAMAV_HOST;
    setDocumentScannerForTests(null);
    const unconfOutcome = await scanDocumentBuffer(samplePdf, {
      documentId: "doc-unconf",
      mimeType: "application/pdf",
    });
    assert.equal(unconfOutcome.status, "PENDING");
    assert.equal(unconfOutcome.configured, false);

    // Try real local loopback TCP mock ClamAV daemon
    let tcpTestsExecuted = false;
    try {
      const cleanDaemon = await startMockClamAvTcpServer("CLEAN");
      tcpTestsExecuted = true;
      try {
        const cleanRes = await scanBufferWithClamAv(samplePdf, {
          host: cleanDaemon.host,
          port: cleanDaemon.port,
          timeoutMs: 3000,
        });
        assert.equal(cleanRes.status, "CLEAN");
        assert.equal(cleanRes.provider, "CLAMAV");
      } finally {
        await cleanDaemon.close();
      }

      const infectedDaemon = await startMockClamAvTcpServer("INFECTED");
      try {
        const infRes = await scanBufferWithClamAv(samplePdf, {
          host: infectedDaemon.host,
          port: infectedDaemon.port,
          timeoutMs: 3000,
        });
        assert.equal(infRes.status, "INFECTED");
        assert.ok(infRes.resultMessage.includes("FOUND"));
      } finally {
        await infectedDaemon.close();
      }

      const invalidDaemon = await startMockClamAvTcpServer("INVALID");
      try {
        const badRes = await scanBufferWithClamAv(samplePdf, {
          host: invalidDaemon.host,
          port: invalidDaemon.port,
          timeoutMs: 3000,
        });
        assert.equal(badRes.status, "ERROR");
      } finally {
        await invalidDaemon.close();
      }

      const oversizedDaemon = await startMockClamAvTcpServer("OVERSIZED");
      try {
        const bigRes = await scanBufferWithClamAv(samplePdf, {
          host: oversizedDaemon.host,
          port: oversizedDaemon.port,
          timeoutMs: 3000,
        });
        assert.equal(bigRes.status, "ERROR");
      } finally {
        await oversizedDaemon.close();
      }

      const timeoutDaemon = await startMockClamAvTcpServer("TIMEOUT");
      try {
        const tRes = await scanBufferWithClamAv(samplePdf, {
          host: timeoutDaemon.host,
          port: timeoutDaemon.port,
          timeoutMs: 250,
        });
        assert.equal(tRes.status, "ERROR");
        assert.ok(tRes.resultMessage.toLowerCase().includes("timed out"));
      } finally {
        await timeoutDaemon.close();
      }

      // Connection refused against closed port (and no raw IP/port leaked!)
      const closedPort = timeoutDaemon.port;
      const refusedRes = await scanBufferWithClamAv(samplePdf, {
        host: "127.0.0.1",
        port: closedPort,
        timeoutMs: 1500,
      });
      assert.equal(refusedRes.status, "ERROR");
      assert.equal(refusedRes.resultMessage.includes("127.0.0.1"), false);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EPERM" || code === "EACCES") {
        console.log(
          "    [INFO] Local loopback TCP socket bind blocked by sandbox; verifying scanner lifecycle via controlled adapter."
        );
      } else {
        throw err;
      }
    }

    // Test concurrent scan lock (409), scan-state recovery (ERROR & stale SCANNING), checksum mismatch, & quarantine
    const memMap = new Map<string, Buffer>();
    memMap.set("scan-test/doc1.pdf", samplePdf);
    memMap.set("scan-test/tampered.pdf", Buffer.from("%PDF-1.4\ntampered\n%%EOF\n"));
    setDocumentStorageAdapterForTests({
      driverName: "s3",
      async putObject(k, b) {
        memMap.set(k, b);
      },
      async getObject(k) {
        const b = memMap.get(k);
        if (!b) throw new Error("Missing");
        return b;
      },
      async headObject(k) {
        const b = memMap.get(k);
        return b ? { exists: true, contentLength: b.byteLength } : { exists: false };
      },
    });

    const [scanDoc] = await testDb
      .insert(verificationDocuments)
      .values({
        providerId: provider.id,
        documentCategory: "PROVIDER",
        documentType: "FIRE_CERT",
        documentTitle: "Concurrency & Recovery Scan Doc",
        storageReference: "s3-private://scan-test/doc1.pdf",
        originalFileName: "doc1.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: samplePdf.byteLength,
        checksumSha256: sampleSha,
        malwareScanStatus: "PENDING",
        status: "SUBMITTED",
      })
      .returning();

    // Concurrent scan attempt while first scan is in flight returns 409 DOCUMENT_SCAN_IN_PROGRESS
    let releaseSlowScan!: () => void;
    const slowScanGate = new Promise<void>((resolve) => {
      releaseSlowScan = resolve;
    });
    setDocumentScannerForTests(async () => {
      await slowScanGate;
      return {
        status: "ERROR",
        provider: "CLAMAV",
        resultMessage: "Transient scanner timeout",
        scannedAt: new Date(),
        configured: true,
      };
    });

    const firstScanPromise = runAndPersistDocumentScan({
      documentId: scanDoc.id,
      admin: testAdmin,
    });
    // Wait a tick for first scan to claim SCANNING lease
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(
      () =>
        runAndPersistDocumentScan({
          documentId: scanDoc.id,
          admin: testAdmin,
        }),
      (err: unknown) =>
        (err as { code?: string; statusCode?: number }).code ===
          "DOCUMENT_SCAN_IN_PROGRESS" &&
        (err as { statusCode?: number }).statusCode === 409
    );
    releaseSlowScan();
    const firstScanOutcome = await firstScanPromise;
    assert.equal(firstScanOutcome.malwareScanStatus, "ERROR");

    // Safe retry from ERROR recovers cleanly to CLEAN
    setDocumentScannerForTests(async () => ({
      status: "CLEAN",
      provider: "CLAMAV",
      resultMessage: "stream: OK",
      scannedAt: new Date(),
      configured: true,
    }));
    const retryOutcome = await runAndPersistDocumentScan({
      documentId: scanDoc.id,
      admin: testAdmin,
    });
    assert.equal(retryOutcome.malwareScanStatus, "CLEAN");

    // Checksum mismatch prior to scanning rejects with 409 DOCUMENT_CHECKSUM_MISMATCH
    const [tamperedDoc] = await testDb
      .insert(verificationDocuments)
      .values({
        providerId: provider.id,
        documentCategory: "PROVIDER",
        documentType: "TAMPER_TEST",
        documentTitle: "Checksum Mismatch Doc",
        storageReference: "s3-private://scan-test/tampered.pdf",
        originalFileName: "tampered.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: samplePdf.byteLength,
        checksumSha256: sampleSha,
        malwareScanStatus: "PENDING",
        status: "SUBMITTED",
      })
      .returning();

    await assert.rejects(
      () =>
        runAndPersistDocumentScan({
          documentId: tamperedDoc.id,
          admin: testAdmin,
        }),
      (err: unknown) =>
        (err as { code?: string; statusCode?: number }).code ===
          "DOCUMENT_CHECKSUM_MISMATCH" &&
        (err as { statusCode?: number }).statusCode === 409
    );

    const inaccessible = await verifyStoredDocumentAccessible(
      tamperedDoc.storageReference,
      sampleSha
    );
    assert.equal(inaccessible.accessible, false);

    console.log(
      `    [PASS] ClamAV scanner lifecycle verified (real TCP zINSTREAM daemon tests: ${tcpTestsExecuted ? "EXECUTED" : "SKIPPED BY SANDBOX"}).`
    );
    console.log(
      "=================================================================="
    );
    console.log("ALL STORAGE & MALWARE SCANNER INTEGRATION TESTS PASSED!");
    console.log(
      "=================================================================="
    );
  } finally {
    globalThis.fetch = origFetch;
    mutableEnv.NODE_ENV = origNodeEnv;
    if (origSessionSecret !== undefined) {
      process.env.ADMIN_SESSION_SECRET = origSessionSecret;
    }
    if (origStorageDir !== undefined) {
      process.env.PRIVATE_DOCUMENT_STORAGE_DIR = origStorageDir;
    } else {
      delete process.env.PRIVATE_DOCUMENT_STORAGE_DIR;
    }
    if (origStorageDriver !== undefined) {
      process.env.DOCUMENT_STORAGE_DRIVER = origStorageDriver;
    } else {
      delete process.env.DOCUMENT_STORAGE_DRIVER;
    }
    if (origClamHost !== undefined) {
      process.env.CLAMAV_HOST = origClamHost;
    } else {
      delete process.env.CLAMAV_HOST;
    }
    if (origClamPort !== undefined) {
      process.env.CLAMAV_PORT = origClamPort;
    } else {
      delete process.env.CLAMAV_PORT;
    }
    setDocumentScannerForTests(null);
    setDocumentStorageAdapterForTests(null);
    setDatabaseInstanceForTests(null);
    await fs.rm(tempLocalDir, { recursive: true, force: true }).catch(() => {});
  }
}

runStorageAndScannerIntegrationSuite().catch((err) => {
  console.error("Storage & Malware Scanner integration suite failed:", err);
  process.exit(1);
});

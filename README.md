# Little Steps — Trusted 24×7 Childcare Platform

Little Steps is a full-stack childcare operations and verification platform built with Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, shadcn/ui, Drizzle ORM, Neon PostgreSQL, Express 5, Nodemailer, and Bun.

This repository currently ships:

- Public landing page, navigation bar, and footer
- Protected Admin Portal (`/admin/*`) with email OTP authentication and HttpOnly session cookies
- Granular RBAC permissions for administration, verification, and private document handling
- Independent provider, centre, and caregiver verification workflows
- Persistent S3-compatible private verification document storage with SHA-256 integrity verification
- ClamAV `zINSTREAM` malware scanning integration with fail-closed quarantine enforcement
- Genuine PostgreSQL transactions (Neon WebSocket `Pool`) for multi-step approvals and audit consistency
- Booking oversight, safety incident management, analytics, tamper-evident audit logs, and platform settings

---

## 1. Project Setup

### Prerequisites

- **Bun** `>= 1.3` (workspace package manager: `bun@1.3.10`) or **Node.js** `>= 20`
- **Neon PostgreSQL** (or local PostgreSQL 16+ for isolated transaction integration tests)
- **SMTP credentials** for Admin OTP email delivery
- **S3-compatible private object storage** (Amazon S3, Cloudflare R2, or MinIO) for production document storage
- **ClamAV (`clamd`)** TCP service for production malware scanning

### Installation & Local Development

1. Install dependencies:

   ```bash
   bun install
   ```

2. Create a local `.env` from [`.env.example`](./.env.example) and supply local development values (never commit `.env`).

3. Start the Next.js development server:

   ```bash
   bun dev
   ```

4. Open `http://localhost:3000` (landing page) and `http://localhost:3000/admin/login` (Admin Portal).

### Architecture Overview

- `app/` — Next.js 16 App Router pages, layouts, and Route Handlers (`app/api/v1/admin/**`).
- `config/db.tsx` & `config/schema.ts` — Neon PostgreSQL connection pool (`@neondatabase/serverless` WebSocket `Pool` for genuine `BEGIN`/`COMMIT`/`ROLLBACK` transactions + Neon HTTP for standalone reads) and Drizzle ORM schema.
- `drizzle/` — Versioned SQL migration files managed by `drizzle-kit`.
- `server/` — Backend services (`operations.service.ts`, `admin-auth.service.ts`, `audit.service.ts`, `document-storage.service.ts`, `s3-storage.adapter.ts`, `document-scanner.service.ts`), RBAC permissions (`security/permissions.ts`), cryptography (`security/crypto.ts`), runtime config validator (`config/runtime-config.ts`), HTTP dispatcher (`dispatcher.ts`), Next.js Route Handler adapter (`next-adapter.ts`), Express 5 app (`app.ts`), and Nodemailer transport (`mail/nodemailer.ts`).
- `lib/` — Typed Axios client (`lib/api/axios-client.ts`), admin API wrappers (`lib/api/admin-api.ts`), shared TypeScript contracts (`lib/admin/types.ts`), and Zod schemas (`lib/admin/validation.ts`).
- `tests/` — Automated verification suites covering admin portal workflows, S3/ClamAV document storage & scanning, and live PostgreSQL transaction integrity.

### Database Migrations

Migrations are stored in `drizzle/` and are **never auto-applied** during application startup or builds.

- Validate migration metadata integrity:

  ```bash
  ./node_modules/.bin/drizzle-kit check
  ```

- Generate a new migration after schema edits:

  ```bash
  ./node_modules/.bin/drizzle-kit generate
  ```

- Apply migrations manually during a controlled maintenance window (against a verified backup):

  ```bash
  ./node_modules/.bin/drizzle-kit migrate
  ```

### Running Tests & Checks

| Command | Purpose |
| --- | --- |
| `./node_modules/.bin/tsc --noEmit` | Strict TypeScript type-check |
| `bun run lint` | ESLint across the repository |
| `bun run test:admin` | Admin Portal auth, RBAC, verification, expiry, evidence review, HTTP 413 bounds, SMTP & runtime config tests |
| `bun run test:documents` | S3 SigV4 storage adapter, fail-closed production guards, DB-failure orphan compensation, local-to-S3 migration, and ClamAV `zINSTREAM` TCP scanning tests |
| `bun run test:pg` | Live PostgreSQL transaction isolation, rollback, row-lock contention, and audit atomicity suite (requires `TEST_DATABASE_URL`) |
| `bun run build` (or `./node_modules/.bin/next build --webpack`) | Next.js production build |

> **CI Enforcement:** In GitHub Actions (`.github/workflows/ci.yml`), `CI=true` and `REQUIRE_PG_TESTS=true` are set so `tests/postgres-transaction.test.ts` fails hard instead of skipping if PostgreSQL is unreachable. Never point `TEST_DATABASE_URL` at production `DATABASE_URL` — `config/db.tsx` explicitly rejects identical URLs when `NODE_ENV=test`.

---

## 2. Verification Document Storage Architecture

### Storage Drivers

Little Steps uses a `DocumentStorageAdapter` abstraction (`server/services/document-storage.service.ts`) supporting two storage schemes stored in `verification_documents.storage_reference`:

- **`s3-private://<unpredictable-key>` (Required in Production):** Implemented via a zero-dependency AWS Signature Version 4 S3-compatible client (`server/services/s3-storage.adapter.ts`) compatible with **Amazon S3**, **Cloudflare R2**, and **MinIO**.
- **`private://<unpredictable-key>` (Development/Test Only):** Stores files under a non-public server directory (`PRIVATE_DOCUMENT_STORAGE_DIR` or `.private-storage/verification-documents`).

**Fail-Closed Production Safeguard:** When `NODE_ENV=production`, local filesystem storage is prohibited. If S3 credentials are missing or `DOCUMENT_STORAGE_DRIVER=local` is set, document uploads fail closed with HTTP `503 DOCUMENT_STORAGE_UNAVAILABLE` rather than silently falling back to ephemeral disk.

### Security Controls

- **Private Bucket Only:** Block all public access (`BlockPublicAcls`, `IgnorePublicAcls`, `BlockPublicPolicy`, `RestrictPublicBuckets`). No presigned or public bucket URLs are exposed; all reads stream through authenticated `GET /api/v1/admin/verification-documents/:id/content` with `documents:read` authorization, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, and `Content-Security-Policy: default-src 'none'; sandbox`.
- **Unpredictable Keys & No Credential Leakage:** Object keys use `verification-documents/<YYYY>/<MM>/<random-hex>-<uuid>.<ext>`. Bucket names, endpoints, and IAM credentials are never persisted in `storage_reference` or returned in API responses.
- **Encryption in Transit & At Rest:** Production `S3_ENDPOINT` requires `https://` TLS. Server-side encryption defaults to `AES256` on AWS S3 (`S3_SSE_MODE=AES256` or `aws:kms` with `S3_KMS_KEY_ID`; set `S3_SSE_MODE=none` for Cloudflare R2 managed encryption).
- **Least-Privilege IAM Policy:** Grant the runtime IAM user/role only `s3:PutObject`, `s3:GetObject`, `s3:HeadObject`, and `s3:DeleteObject` (needed for compensating cleanup on upload DB failure and authorized retention deletion) scoped to `arn:aws:s3:::<bucket>/verification-documents/*`.
- **Bounded Ingestion & Compensating Cleanup:** Request payloads are enforced before and during body parsing (`Content-Length` pre-check + bounded stream reader) with HTTP `413 PAYLOAD_TOO_LARGE` above limits (10 MB document binary cap; `experimental.proxyClientMaxBodySize: "12mb"` in `next.config.ts`). Magic bytes validate `application/pdf`, `image/png`, and `image/jpeg`. If the database insert fails after writing to object storage, the service attempts compensating object deletion and logs `VERIFICATION_DOCUMENT_ORPHAN_RECONCILIATION_REQUIRED` if cleanup also fails.

### Controlled Local-to-S3 Migration Workflow

If legacy development/staging documents exist on local disk (`private://...`), migrate them idempotently using `migrateLocalDocumentsToPersistentStorage()` in `server/services/document-storage.service.ts`:

1. Configure target S3 environment variables (`S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, optional `S3_ENDPOINT`).
2. Run a dry-run (`dryRun: true`) first to verify file availability and SHA-256 integrity.
3. Execute with `dryRun: false`: each local file is checksum-verified against DB metadata, uploaded to S3, re-verified via `headObject`/`getObject`, and updated atomically to `s3-private://<key>` with a `VERIFICATION_DOCUMENT_STORAGE_MIGRATED` audit record.
4. Local originals are retained until an operator explicitly verifies S3 durability and runs a separate retention cleanup. Set `ALLOW_LEGACY_LOCAL_DOCUMENT_READ="true"` temporarily only if legacy local objects must remain readable during staged cutover.

---

## 3. Malware Scanning Architecture (ClamAV)

### Protocol & Lifecycle

Every uploaded document starts with `malwareScanStatus = "PENDING"` and is streamed over TCP to `clamd` using the ClamAV `zINSTREAM\0` protocol (`server/services/document-scanner.service.ts`).

| Status | Meaning | Preview / Approval Allowed? |
| --- | --- | --- |
| `PENDING` | Awaiting scan or scanner unconfigured | Preview blocked (`409`); Approval blocked |
| `SCANNING` | Active scan lease held (stale lease auto-recovers after 2 min) | Concurrent scan blocked (`409 DOCUMENT_SCAN_IN_PROGRESS`); Approval blocked |
| `CLEAN` | `clamd` returned `stream: OK` matching current SHA-256 checksum | Preview allowed (with `documents:read`); Approval allowed after verified preview inspection |
| `INFECTED` | Malware signature detected; document quarantined (`REJECTED`) | Permanently blocked (`423 DOCUMENT_QUARANTINED`) |
| `ERROR` | Scanner timeout, malformed response, or network failure | Preview & Approval blocked; retryable via `POST /api/v1/admin/verification-documents/:id/scan` (`documents:scan`) |

### Serverless & Managed Hosting Guidance

Next.js serverless platforms (e.g., Vercel Functions) cannot run a local `clamd` daemon inside ephemeral function containers. For production deployment, host `clamd` on a dedicated private VPC container/VM (e.g., ECS Fargate, Cloud Run with VPC connector, Fly.io private app, or Railway internal service) running official `clamav/clamav` with freshclam updates, reachable over private TLS/VPC networking at `CLAMAV_HOST:CLAMAV_PORT`.

- Always bind `clamd` to a private network interface (never expose port `3310` to the public internet).
- If the scanner is unreachable or misconfigured, Little Steps **fails closed** — documents stay `PENDING`/`ERROR` and cannot be previewed or approved until a verified `CLEAN` scan completes.

---

## 4. Production Deployment & Readiness

### Required Environment Variable Names

Do **not** store secrets in source control. Configure these environment variables in your production secret manager (see [`.env.example`](./.env.example) for format guidance):

- **Database:** `DATABASE_URL`
- **Admin Cryptographic Secrets (64-hex / 32-byte minimum):** `ADMIN_OTP_HMAC_SECRET`, `ADMIN_SESSION_SECRET`
- **SMTP OTP Delivery:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- **Persistent Private Object Storage:** `DOCUMENT_STORAGE_DRIVER="s3"`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (plus `S3_ENDPOINT`, `S3_SSE_MODE`, `S3_KMS_KEY_ID`, `S3_FORCE_PATH_STYLE`, `S3_TIMEOUT_MS` as needed)
- **Malware Scanning:** `CLAMAV_HOST`, `CLAMAV_PORT`, `CLAMAV_TIMEOUT_MS`
- **App Origin & Rate Limiting:** `NEXT_PUBLIC_APP_URL` (must be `https://` in production), `NEXT_PUBLIC_ADMIN_API_BASE_URL`, `TRUST_PROXY`, and optionally `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (PostgreSQL atomic rate limiter is active when Upstash is unset)

### Pre-Deployment Checklist

1. **Database Migrations:** Take a Neon snapshot/branch backup and apply pending migrations in `drizzle/` via `drizzle-kit migrate`.
2. **Storage Provisioning:** Create a private S3/R2 bucket with public access blocked, default encryption enabled, versioning/lifecycle rules configured, and a least-privilege IAM credential set.
3. **ClamAV Provisioning:** Deploy private `clamd` with automated signature updates (`freshclam`) and verify TCP connectivity from the application runtime.
4. **Runtime Configuration Check:** Inspect `GET /api/v1/admin/verification-documents/diagnostics/status` (requires `documents:read`) and verify `productionReady: true`, `documentStorageDriver: "s3"`, and `scannerConfigured: true`.
5. **Historical Audit Review:** Run read-only `GET /api/v1/admin/verification-documents/diagnostics/historical-report` to identify any pre-hardening documents needing re-scan or re-verification.
6. **Isolated PostgreSQL Transaction Verification:** Confirm CI (`.github/workflows/ci.yml`) passed all 10 live PostgreSQL transaction integration cases in `tests/postgres-transaction.test.ts`.
7. **Admin Role Audit:** Verify admin accounts hold explicit granular document permissions (`documents:read`, `documents:review`, `documents:upload`, `documents:scan`) according to least privilege.

### Rollback & Recovery Procedures

- **Application Rollback:** Redeploy the previous container/Next.js release. Schema changes in Phase 2.1 are strictly additive (`storage_reference` carries `s3-private://` vs `private://` without dropping legacy columns), keeping rollback non-destructive.
- **Database Recovery:** Use Neon Point-in-Time Restore (PITR) or branch restore if a migration encounters unexpected issues.
- **Orphaned Storage Reconciliation:** Query `audit_logs` for `action = 'VERIFICATION_DOCUMENT_ORPHAN_RECONCILIATION_REQUIRED'` to identify and purge any S3 object whose DB transaction rolled back and compensating delete failed.
- **Scanner Outage Recovery:** During a `clamd` outage, uploads safely queue in `PENDING`/`ERROR`. Once `clamd` recovers, trigger rescans from the Verification Queue UI ("Retry Scan") or `POST /api/v1/admin/verification-documents/:id/scan`.

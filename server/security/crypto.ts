import crypto from "node:crypto";

export const ADMIN_SESSION_COOKIE_NAME = "ls_admin_session";
export const ADMIN_CSRF_COOKIE_NAME = "ls_admin_csrf";
export const ADMIN_CSRF_HEADER_NAME = "x-csrf-token";

export const OTP_EXPIRY_MINUTES = Number(
  process.env.ADMIN_OTP_EXPIRY_MINUTES || 5
);
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SECONDS = 60;
export const ADMIN_SESSION_TTL_HOURS = 12;

export class AdminCryptoSecretError extends Error {
  readonly code = "ADMIN_CRYPTO_SECRET_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "AdminCryptoSecretError";
  }
}

const INSECURE_PLACEHOLDER_PATTERNS = [
  /^replace-with-/i,
  /^changeme/i,
  /^your-secret/i,
  /^example/i,
  /^placeholder/i,
  /^little-steps-admin-fallback/i,
  /^default/i,
  /^secret$/i,
  /^password$/i,
];

/**
 * Validates that an environment variable secret is present and cryptographically strong.
 * Accepts 32-byte (64-character) or longer randomly generated hexadecimal secrets,
 * or high-entropy strings of at least 32 bytes that are not placeholders or trivial repeats.
 * Never logs or includes the raw secret value in error messages.
 */
export function validateCryptographicSecret(
  rawValue: string | undefined,
  envVarName: "ADMIN_OTP_HMAC_SECRET" | "ADMIN_SESSION_SECRET"
): Buffer {
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    throw new AdminCryptoSecretError(
      `Required cryptographic secret ${envVarName} is missing.`
    );
  }

  const trimmed = rawValue.trim();

  for (const pattern of INSECURE_PLACEHOLDER_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new AdminCryptoSecretError(
        `Configured ${envVarName} contains an insecure placeholder value.`
      );
    }
  }

  // Reject trivial single-character repetitions (e.g. "aaaa..." or "0000...")
  if (/^(.)\1+$/.test(trimmed)) {
    throw new AdminCryptoSecretError(
      `Configured ${envVarName} lacks sufficient cryptographic entropy.`
    );
  }

  // Accept 32-byte (64 hex chars) or longer hexadecimal secrets directly as raw bytes
  if (/^[0-9a-fA-F]{64,}$/.test(trimmed) && trimmed.length % 2 === 0) {
    const keyBytes = Buffer.from(trimmed, "hex");
    if (keyBytes.byteLength >= 32) {
      return keyBytes;
    }
  }

  // Accept high-entropy UTF-8 / base64 secrets of at least 32 bytes with >= 8 distinct characters
  const utf8Bytes = Buffer.from(trimmed, "utf8");
  const uniqueChars = new Set(trimmed).size;
  if (utf8Bytes.byteLength >= 32 && uniqueChars >= 8) {
    return utf8Bytes;
  }

  throw new AdminCryptoSecretError(
    `Configured ${envVarName} must be at least 32 bytes (e.g. 64 hex characters) of cryptographic entropy.`
  );
}

/**
 * Exclusively retrieves and validates `ADMIN_OTP_HMAC_SECRET` for OTP HMAC hashing.
 * Never falls back to `JWT_SECRET` or any hardcoded secret.
 */
export function getOtpHmacSecretKey(): Buffer {
  return validateCryptographicSecret(
    process.env.ADMIN_OTP_HMAC_SECRET,
    "ADMIN_OTP_HMAC_SECRET"
  );
}

/**
 * Exclusively retrieves and validates `ADMIN_SESSION_SECRET` for administrator session token hashing.
 * Never falls back to `JWT_SECRET` or any hardcoded secret.
 */
export function getAdminSessionSecretKey(): Buffer {
  return validateCryptographicSecret(
    process.env.ADMIN_SESSION_SECRET,
    "ADMIN_SESSION_SECRET"
  );
}

/**
 * Generates a cryptographically secure 6-digit numerical OTP using Node CSPRNG.
 */
export function generateNumericOtp(): string {
  const code = crypto.randomInt(100000, 1000000);
  return String(code).padStart(6, "0");
}

/**
 * Computes an HMAC-SHA256 hash of the OTP bound to the normalized email address
 * using `ADMIN_OTP_HMAC_SECRET` exclusively.
 * Never store plaintext OTPs.
 */
export function hashOtp(email: string, otp: string): string {
  const normalizedEmail = email.trim().toLowerCase();
  return crypto
    .createHmac("sha256", getOtpHmacSecretKey())
    .update(`otp:${normalizedEmail}:${otp.trim()}`)
    .digest("hex");
}

/**
 * Timing-safe verification of a candidate OTP against a stored HMAC-SHA256 hex digest.
 */
export function verifyOtpHash(
  email: string,
  candidateOtp: string,
  storedHash: string
): boolean {
  if (!candidateOtp || !storedHash || !/^[0-9a-fA-F]{64}$/.test(storedHash)) {
    return false;
  }
  const computed = hashOtp(email, candidateOtp);
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Generates an opaque 256-bit (32-byte) session token for the HttpOnly cookie.
 */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Hashes the raw session token using `ADMIN_SESSION_SECRET` exclusively
 * before storing or looking up in `admin_sessions`.
 */
export function hashSessionToken(rawToken: string): string {
  if (!rawToken || typeof rawToken !== "string") {
    throw new AdminCryptoSecretError("Session token must be a non-empty string.");
  }
  return crypto
    .createHmac("sha256", getAdminSessionSecretKey())
    .update(`session:${rawToken}`)
    .digest("hex");
}

/**
 * Generates a 192-bit CSRF token paired with the admin session.
 */
export function generateCsrfToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

/**
 * Timing-safe CSRF token comparison.
 */
export function verifyCsrfToken(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface AuditIntegrityInput {
  adminEmail: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  timestampIso: string;
}

function serializeAuditPayload(input: AuditIntegrityInput): string {
  return JSON.stringify({
    adminEmail: input.adminEmail,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    summary: input.summary,
    timestampIso: input.timestampIso,
  });
}

/**
 * Computes a tamper-evident HMAC-SHA256 integrity hash for admin audit records
 * using `ADMIN_SESSION_SECRET`.
 */
export function computeAuditIntegrityHash(input: AuditIntegrityInput): string {
  const canonical = serializeAuditPayload(input);
  return crypto
    .createHmac("sha256", getAdminSessionSecretKey())
    .update(`audit:${canonical}`)
    .digest("hex");
}

/**
 * Verifies an audit log entry's integrity hash without silently invalidating
 * historical records created prior to the Phase 1 secret separation.
 * Returns `{ valid: true, keyGeneration: "current" }` when verified by `ADMIN_SESSION_SECRET`,
 * or `{ valid: true, keyGeneration: "otp-secret" }` if verified by `ADMIN_OTP_HMAC_SECRET`.
 */
export function verifyAuditIntegrityHash(
  input: AuditIntegrityInput,
  storedHash: string
): {
  valid: boolean;
  keyGeneration: "current" | "otp-secret" | "unverified-historical";
} {
  if (!storedHash || !/^[0-9a-fA-F]{64}$/.test(storedHash)) {
    return { valid: false, keyGeneration: "unverified-historical" };
  }

  const storedBuf = Buffer.from(storedHash, "hex");
  const canonical = serializeAuditPayload(input);

  const currentDigest = crypto
    .createHmac("sha256", getAdminSessionSecretKey())
    .update(`audit:${canonical}`)
    .digest();

  if (
    currentDigest.length === storedBuf.length &&
    crypto.timingSafeEqual(currentDigest, storedBuf)
  ) {
    return { valid: true, keyGeneration: "current" };
  }

  const otpKeyDigest = crypto
    .createHmac("sha256", getOtpHmacSecretKey())
    .update(`audit:${canonical}`)
    .digest();

  if (
    otpKeyDigest.length === storedBuf.length &&
    crypto.timingSafeEqual(otpKeyDigest, storedBuf)
  ) {
    return { valid: true, keyGeneration: "otp-secret" };
  }

  return { valid: false, keyGeneration: "unverified-historical" };
}

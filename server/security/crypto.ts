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

function getSecretKey(): string {
  return (
    process.env.OTP_HMAC_SECRET ||
    process.env.JWT_SECRET ||
    "little-steps-admin-fallback-secret-key-2026"
  );
}

/**
 * Generates a cryptographically secure 6-digit numerical OTP.
 */
export function generateNumericOtp(): string {
  const code = crypto.randomInt(100000, 1000000);
  return String(code).padStart(6, "0");
}

/**
 * Computes an HMAC-SHA256 hash of the OTP bound to the normalized email address.
 * Never store plaintext OTPs.
 */
export function hashOtp(email: string, otp: string): string {
  const normalizedEmail = email.trim().toLowerCase();
  return crypto
    .createHmac("sha256", getSecretKey())
    .update(`otp:${normalizedEmail}:${otp.trim()}`)
    .digest("hex");
}

/**
 * Timing-safe verification of a candidate OTP against a stored HMAC hash.
 */
export function verifyOtpHash(
  email: string,
  candidateOtp: string,
  storedHash: string
): boolean {
  const computed = hashOtp(email, candidateOtp);
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Generates an opaque 256-bit session token for the HttpOnly cookie.
 */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Hashes the raw session token before storing or looking up in `admin_sessions`.
 */
export function hashSessionToken(rawToken: string): string {
  return crypto
    .createHmac("sha256", getSecretKey())
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
 *Timing-safe CSRF token check.
 */
export function verifyCsrfToken(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Computes a tamper-evident SHA-256 hash for admin audit records.
 */
export function computeAuditIntegrityHash(input: {
  adminEmail: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  timestampIso: string;
}): string {
  const canonical = JSON.stringify({
    adminEmail: input.adminEmail,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    summary: input.summary,
    timestampIso: input.timestampIso,
  });
  return crypto
    .createHmac("sha256", getSecretKey())
    .update(`audit:${canonical}`)
    .digest("hex");
}

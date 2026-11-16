import crypto from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import { hasAdminEmailKeyword } from "../../lib/admin/validation";
import { OTP_EXPIRY_MINUTES } from "../security/crypto";

export interface SendAdminOtpEmailInput {
  toEmail: string;
  adminName: string;
  otpCode: string;
  ipAddress?: string;
}

export class AdminMailDeliveryError extends Error {
  readonly code = "ADMIN_OTP_EMAIL_DELIVERY_FAILED";
  readonly statusCode = 503;

  constructor(
    message = "Unable to deliver the verification code email at this time. Please try again shortly."
  ) {
    super(message);
    this.name = "AdminMailDeliveryError";
  }
}

export type AdminOtpMailInterceptor = (
  input: SendAdminOtpEmailInput
) => Promise<void> | void;

let cachedTransporter: Transporter | null = null;
let cachedTransporterKey: string | null = null;
let testMailInterceptor: AdminOtpMailInterceptor | null = null;

/**
 * Controlled dependency injection hook for isolated automated tests only.
 * Explicitly disabled in production.
 */
export function setAdminOtpMailInterceptorForTests(
  interceptor: AdminOtpMailInterceptor | null
): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Mail interceptor injection is prohibited in production environments."
    );
  }
  testMailInterceptor = interceptor;
}

function createSmtpTransporter(): Transporter {
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.replace(/\s+/g, "");
  const secure =
    process.env.SMTP_SECURE === "true" || Number(process.env.SMTP_PORT) === 465;

  if (!host || !user || !pass) {
    throw new AdminMailDeliveryError(
      "Email delivery service is not configured. Please contact platform security operations."
    );
  }

  // Invalidate cached transporter automatically if Next.js reloads .env values
  const configKey = crypto
    .createHash("sha256")
    .update(`${host}\0${port}\0${secure}\0${user}\0${pass}`)
    .digest("hex");

  if (cachedTransporter && cachedTransporterKey === configKey) {
    return cachedTransporter;
  }

  cachedTransporter = nodemailer.createTransport({
    host,
    port,
    secure,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    auth: {
      user,
      pass,
    },
  });
  cachedTransporterKey = configKey;

  return cachedTransporter;
}

export function buildAdminOtpEmailHtml(params: {
  adminName: string;
  otpCode: string;
  expiryMinutes: number;
  appUrl: string;
}): string {
  const { adminName, otpCode, expiryMinutes, appUrl } = params;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Little Steps — Admin Login Verification</title>
</head>
<body style="margin:0;padding:0;background-color:#F4F9F8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0F172A;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background-color:#FFFFFF;border-radius:20px;overflow:hidden;border:1px solid #D8ECE8;box-shadow:0 8px 24px rgba(8,127,120,0.08);">
          <tr>
            <td style="background-color:#087F78;padding:28px 32px;text-align:center;">
              <div style="display:inline-block;padding:6px 14px;border-radius:999px;background-color:rgba(255,255,255,0.16);color:#FFFFFF;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">
                Little Steps • Trusted 24×7 Childcare
              </div>
              <h1 style="margin:14px 0 0;color:#FFFFFF;font-size:24px;font-weight:800;letter-spacing:-0.02em;">
                Admin Login Verification
              </h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#334155;">
                Hello <strong>${adminName}</strong>,
              </p>
              <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#334155;">
                A sign-in attempt was initiated for your <strong>Little Steps Admin Portal</strong> account. Enter the six-digit verification code below to complete authentication:
              </p>
              <div style="background-color:#EAF8F5;border:2px dashed #087F78;border-radius:16px;padding:22px 16px;text-align:center;margin:0 0 24px;">
                <span style="display:block;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#087F78;margin-bottom:8px;">
                  One-Time Verification Code
                </span>
                <span style="font-size:36px;font-weight:800;letter-spacing:10px;color:#087F78;font-family:'Courier New',Courier,monospace;">
                  ${otpCode}
                </span>
              </div>
              <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#475569;">
                ⏱ <strong>Expiration Notice:</strong> This code expires in <strong>${expiryMinutes} minutes</strong> and can only be used once.
              </p>
              <div style="background-color:#FFF7ED;border-left:4px solid #F2A65A;padding:14px 16px;border-radius:8px;margin:0 0 20px;">
                <p style="margin:0;font-size:13px;line-height:1.5;color:#9A3412;">
                  <strong>Security Warning:</strong> Never share this verification code with anyone. Little Steps staff will never ask you for your OTP over phone, chat, or email.
                </p>
              </div>
              <p style="margin:0;font-size:13px;line-height:1.6;color:#64748B;">
                <strong>Didn't request this login?</strong> If you did not initiate this request, you can safely ignore this email—your account remains protected. If you suspect unauthorized activity, please contact the Little Steps Security Operations team immediately via <a href="${appUrl}/contact" style="color:#087F78;text-decoration:underline;">${appUrl}</a>.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#F8FAFC;border-top:1px solid #E2E8F0;padding:18px 32px;text-align:center;">
              <p style="margin:0;font-size:12px;color:#94A3B8;">
                © ${new Date().getFullYear()} Little Steps Childcare Platform • Administrative Security Notice
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendAdminOtpEmail(
  input: SendAdminOtpEmailInput
): Promise<{ delivered: true; transportMode: "smtp" | "test-interceptor" }> {
  const recipient = input.toEmail.trim().toLowerCase();

  if (!hasAdminEmailKeyword(recipient)) {
    throw new AdminMailDeliveryError(
      "Refusing to dispatch administrative OTP to an ineligible email address."
    );
  }

  if (!/^\d{6}$/.test(input.otpCode)) {
    throw new AdminMailDeliveryError("Invalid OTP format for email dispatch.");
  }

  if (testMailInterceptor && process.env.NODE_ENV !== "production") {
    await testMailInterceptor({ ...input, toEmail: recipient });
    return { delivered: true, transportMode: "test-interceptor" };
  }

  const transporter = createSmtpTransporter();
  const smtpUser = process.env.SMTP_USER?.trim();
  const fromAddress =
    process.env.SMTP_FROM ||
    process.env.SMTP_FROM_EMAIL ||
    (smtpUser
      ? `Little Steps Security <${smtpUser}>`
      : "Little Steps Security <no-reply@littlesteps.com>");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  const html = buildAdminOtpEmailHtml({
    adminName: input.adminName,
    otpCode: input.otpCode,
    expiryMinutes: OTP_EXPIRY_MINUTES,
    appUrl,
  });

  const text = [
    `Little Steps — Admin Login Verification`,
    `Hello ${input.adminName},`,
    `Your six-digit Admin Portal OTP is: ${input.otpCode}`,
    `This code expires in ${OTP_EXPIRY_MINUTES} minutes and is single-use.`,
    `Security Warning: Never share this OTP with anyone.`,
    `If you did not request this login, please ignore this message or notify security operations.`,
  ].join("\n\n");

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const activeTransporter =
      attempt === 1 ? transporter : createSmtpTransporter();
    try {
      await activeTransporter.sendMail({
        from: fromAddress.trim(),
        to: recipient,
        subject: "Little Steps Admin Portal — Login Verification Code",
        text,
        html,
      });
      return {
        delivered: true,
        transportMode: "smtp",
      };
    } catch (err) {
      lastError = err;
      cachedTransporter = null;
      cachedTransporterKey = null;

      const smtpErr = err as { code?: string; responseCode?: number } | null;
      if (smtpErr?.code === "EAUTH" || smtpErr?.responseCode === 535) {
        break;
      }
    }
  }

  const smtpMeta = lastError as {
    code?: string;
    responseCode?: number;
    command?: string;
  } | null;

  // Never log the OTP code, SMTP username, or SMTP password in operational error logs
  console.error("[LittleSteps Mailer] SMTP delivery failure:", {
    recipientDomain: recipient.split("@")[1] ?? "unknown",
    errorType: lastError instanceof Error ? lastError.name : "UnknownSmtpError",
    errorCode: smtpMeta?.code ?? "UNKNOWN",
    responseCode: smtpMeta?.responseCode ?? null,
    command: smtpMeta?.command ?? null,
  });

  throw new AdminMailDeliveryError();
}

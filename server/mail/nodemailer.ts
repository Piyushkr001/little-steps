import nodemailer, { type Transporter } from "nodemailer";
import { OTP_EXPIRY_MINUTES } from "../security/crypto";

export interface SendAdminOtpEmailInput {
  toEmail: string;
  adminName: string;
  otpCode: string;
  ipAddress?: string;
}

let cachedTransporter: Transporter | null = null;
let lastSentTestOtp: { email: string; otp: string; sentAt: Date } | null = null;

export function getLastSentTestOtpForTestingOnly() {
  if (process.env.NODE_ENV === "production") {
    return null;
  }
  return lastSentTestOtp;
}

function createMailTransporter(): Transporter {
  if (cachedTransporter) return cachedTransporter;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.replace(/\s+/g, "");
  const secure =
    process.env.SMTP_SECURE === "true" || Number(process.env.SMTP_PORT) === 465;

  if (host && user && pass) {
    cachedTransporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user,
        pass,
      },
    });
    return cachedTransporter;
  }

  // Safe local/test fallback transport when SMTP credentials are not yet configured
  cachedTransporter = nodemailer.createTransport({
    jsonTransport: true,
  });
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
): Promise<{ delivered: boolean; transportMode: "smtp" | "local-fallback" }> {
  const transporter = createMailTransporter();
  const smtpUser = process.env.SMTP_USER?.trim();
  const fromAddress =
    process.env.SMTP_FROM ||
    process.env.SMTP_FROM_EMAIL ||
    (smtpUser
      ? `Little Steps Security <${smtpUser}>`
      : "Little Steps Security <no-reply@littlesteps.com>");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  // In non-production, demo admin accounts use the demo OTP (123456) without requiring external SMTP delivery
  const isDemoRecipient =
    input.toEmail.endsWith("@littlesteps.com") ||
    input.toEmail === "littlesteps.admin@gmail.com";

  if (process.env.NODE_ENV !== "production") {
    lastSentTestOtp = {
      email: input.toEmail,
      otp: input.otpCode,
      sentAt: new Date(),
    };
    console.info(
      `[LittleSteps Admin OTP Dev Mailer] Recipient: ${input.toEmail} | OTP: ${input.otpCode} (expires in ${OTP_EXPIRY_MINUTES}m)`
    );
    if (isDemoRecipient) {
      return { delivered: true, transportMode: "local-fallback" };
    }
  }

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

  const isSmtpConfigured = Boolean(
    process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
  );

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await transporter.sendMail({
        from: fromAddress,
        to: input.toEmail,
        subject: "Little Steps Admin Portal — Login Verification Code",
        text,
        html,
      });
      return {
        delivered: true,
        transportMode: isSmtpConfigured ? "smtp" : "local-fallback",
      };
    } catch (err) {
      lastError = err;
    }
  }

  console.error("[LittleSteps Mailer] Failed to dispatch OTP email:", {
    recipient: input.toEmail,
    error: lastError instanceof Error ? lastError.message : "Unknown SMTP error",
  });

  if (process.env.NODE_ENV !== "production") {
    return { delivered: true, transportMode: "local-fallback" };
  }

  throw new Error("Unable to send verification email at this time.");
}

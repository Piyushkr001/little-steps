import { z } from "zod";

export const ADMIN_EMAIL_KEYWORD = "admin";

export function hasAdminEmailKeyword(email: string): boolean {
  return email.trim().toLowerCase().includes(ADMIN_EMAIL_KEYWORD);
}

export const PROVIDER_REQUIRED_CHECKLIST_KEYS = [
  "licenseVerified",
  "organizationDetailsVerified",
] as const;

export const CENTER_REQUIRED_CHECKLIST_KEYS = [
  "operatingLicenseVerified",
  "facilitySafetyVerified",
  "caregiverQualificationVerified",
  "capacityVerified",
  "operatingHoursVerified",
  "ageGroupsVerified",
] as const;

export const CAREGIVER_REQUIRED_CHECKLIST_KEYS = [
  "backgroundScreeningVerified",
  "credentialsVerified",
] as const;

export const requestOtpSchema = z
  .object({
    email: z
      .string()
      .trim()
      .min(5, "Email address is required")
      .email("Please enter a valid email address")
      .transform((v) => v.toLowerCase()),
  })
  .strict();

export const verifyOtpSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email("Please enter a valid email address")
      .transform((v) => v.toLowerCase()),
    otp: z
      .string()
      .trim()
      .regex(/^\d{6}$/, "OTP must be a 6-digit numerical code"),
  })
  .strict();

export const resendOtpSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email("Please enter a valid email address")
      .transform((v) => v.toLowerCase()),
  })
  .strict();

export const updateUserStatusSchema = z
  .object({
    status: z.enum(["ACTIVE", "SUSPENDED", "DISABLED"]),
    reason: z
      .string()
      .trim()
      .min(5, "A reason of at least 5 characters is required for audit logging")
      .max(500),
  })
  .strict();

const providerChecklistSchema = z
  .object({
    licenseVerified: z.boolean(),
    organizationDetailsVerified: z.boolean(),
  })
  .strict();

export const approveVerificationSchema = z
  .object({
    reviewComments: z
      .string()
      .trim()
      .min(3, "Review comments are required when approving a provider")
      .max(1000),
    checklistState: providerChecklistSchema,
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

export const rejectVerificationSchema = z
  .object({
    rejectionReason: z
      .string()
      .trim()
      .min(5, "A detailed rejection reason is required")
      .max(1000),
    reviewComments: z.string().trim().max(1000).optional(),
    suspendProvider: z.boolean().optional(),
  })
  .strict();

export const requestDocumentsSchema = z
  .object({
    requestedDocuments: z
      .array(z.string().trim().min(2))
      .min(1, "Specify at least one required document"),
    reviewComments: z
      .string()
      .trim()
      .min(5, "Explain what additional documentation is required")
      .max(1000),
  })
  .strict();

const centerChecklistSchema = z
  .object({
    operatingLicenseVerified: z.boolean(),
    facilitySafetyVerified: z.boolean(),
    caregiverQualificationVerified: z.boolean(),
    capacityVerified: z.boolean(),
    operatingHoursVerified: z.boolean(),
    ageGroupsVerified: z.boolean(),
  })
  .strict();

export const approveCenterVerificationSchema = z
  .object({
    reviewComments: z
      .string()
      .trim()
      .min(3, "Review comments are required when approving a daycare centre")
      .max(1000),
    checklistState: centerChecklistSchema,
    safetyComplianceNotes: z.string().trim().max(1000).optional(),
    activateListing: z.boolean().optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

export const rejectCenterVerificationSchema = z
  .object({
    rejectionReason: z
      .string()
      .trim()
      .min(5, "A detailed rejection or suspension reason is required")
      .max(1000),
    reviewComments: z.string().trim().max(1000).optional(),
    suspendCenter: z.boolean().optional(),
  })
  .strict();

export const requestCenterDocumentsSchema = z
  .object({
    requestedDocuments: z
      .array(z.string().trim().min(2))
      .min(1, "Specify at least one required centre document"),
    reviewComments: z
      .string()
      .trim()
      .min(5, "Explain what additional centre documentation is required")
      .max(1000),
  })
  .strict();

const caregiverChecklistSchema = z
  .object({
    backgroundScreeningVerified: z.boolean(),
    credentialsVerified: z.boolean(),
  })
  .strict();

export const approveCaregiverVerificationSchema = z
  .object({
    reviewComments: z
      .string()
      .trim()
      .min(3, "Review comments are required when approving caregiver screening")
      .max(1000),
    checklistState: caregiverChecklistSchema,
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

export const rejectCaregiverVerificationSchema = z
  .object({
    rejectionReason: z
      .string()
      .trim()
      .min(5, "A detailed rejection or suspension reason is required")
      .max(1000),
    reviewComments: z.string().trim().max(1000).optional(),
    suspendCaregiver: z.boolean().optional(),
  })
  .strict();

export const approveVerificationDocumentSchema = z
  .object({
    reviewNotes: z
      .string()
      .trim()
      .min(3, "Review notes are required when verifying a document")
      .max(1000),
    evidenceReviewed: z.literal(true, {
      error: "Administrator must confirm document content was reviewed",
    }),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

export const rejectVerificationDocumentSchema = z
  .object({
    rejectionReason: z
      .string()
      .trim()
      .min(5, "A rejection reason is required when rejecting a document")
      .max(1000),
    reviewNotes: z.string().trim().max(1000).optional(),
    requestReplacement: z.boolean().optional(),
  })
  .strict();

export const uploadVerificationDocumentSchema = z
  .object({
    providerId: z.string().uuid("Valid providerId is required"),
    centerId: z.string().uuid().optional().nullable(),
    caregiverId: z.string().uuid().optional().nullable(),
    documentCategory: z.enum(["PROVIDER", "CENTER", "CAREGIVER"]),
    documentType: z.string().trim().min(2).max(100),
    documentTitle: z.string().trim().min(2).max(255),
    fileName: z.string().trim().min(1).max(255),
    mimeType: z.enum(["application/pdf", "image/png", "image/jpeg"]).optional(),
    fileBase64: z.string().min(4, "File content is required"),
    expiresAt: z.string().datetime().optional().nullable(),
  })
  .strict();

export const updateCenterStatusSchema = z
  .object({
    listingStatus: z.enum(["ACTIVE", "SUSPENDED", "INACTIVE", "PENDING_APPROVAL"]),
    reason: z
      .string()
      .trim()
      .min(5, "A reason of at least 5 characters is required")
      .max(500),
  })
  .strict();

export const ALLOWED_BOOKING_TRANSITIONS: Record<string, string[]> = {
  REQUESTED: ["CONFIRMED", "REJECTED", "CANCELLED", "EXPIRED"],
  CONFIRMED: ["CHECKED_IN", "CANCELLED", "NO_SHOW"],
  CHECKED_IN: ["COMPLETED"],
  REJECTED: [],
  CANCELLED: [],
  COMPLETED: [],
  EXPIRED: [],
  NO_SHOW: [],
};

export const updateBookingStatusSchema = z
  .object({
    status: z.enum([
      "REQUESTED",
      "CONFIRMED",
      "REJECTED",
      "CANCELLED",
      "CHECKED_IN",
      "COMPLETED",
      "EXPIRED",
      "NO_SHOW",
    ]),
    reason: z
      .string()
      .trim()
      .min(5, "A recorded reason is required for booking state transitions")
      .max(500),
  })
  .strict();

export const updateIncidentStatusSchema = z
  .object({
    status: z.enum([
      "REPORTED",
      "UNDER_REVIEW",
      "INVESTIGATING",
      "RESOLVED",
      "CLOSED",
    ]),
    assignedAdminId: z.string().uuid().optional().nullable(),
    resolutionOutcome: z.string().trim().max(1000).optional(),
    note: z
      .string()
      .trim()
      .min(3, "An activity note is required when updating incident status")
      .max(1000),
  })
  .strict();

export const addIncidentNoteSchema = z
  .object({
    note: z
      .string()
      .trim()
      .min(3, "Investigation note must be at least 3 characters")
      .max(2000),
    assignedAdminId: z.string().uuid().optional(),
  })
  .strict();

export const updatePlatformSettingsSchema = z
  .object({
    settings: z
      .array(
        z
          .object({
            settingKey: z.string().trim().min(2).max(120),
            settingValue: z.unknown(),
            category: z
              .enum([
                "GENERAL",
                "SECURITY",
                "VERIFICATION",
                "BOOKINGS",
                "NOTIFICATIONS",
              ])
              .optional(),
            description: z.string().trim().max(500).optional(),
          })
          .strict()
      )
      .min(1, "At least one setting update is required"),
  })
  .strict();

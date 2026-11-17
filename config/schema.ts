import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// ==========================================
// 1. Enums
// ==========================================

export const userRoleEnum = pgEnum("user_role", [
  "PARENT",
  "PROVIDER",
  "CAREGIVER",
  "ADMIN",
  "SUPER_ADMIN",
]);

export const accountStatusEnum = pgEnum("account_status", [
  "ACTIVE",
  "SUSPENDED",
  "DISABLED",
  "PENDING",
]);

export const verificationStatusEnum = pgEnum("verification_status", [
  "NOT_SUBMITTED",
  "PENDING",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
  "SUSPENDED",
]);

export const centerListingStatusEnum = pgEnum("center_listing_status", [
  "ACTIVE",
  "SUSPENDED",
  "INACTIVE",
  "PENDING_APPROVAL",
]);

export const bookingStatusEnum = pgEnum("booking_status", [
  "REQUESTED",
  "CONFIRMED",
  "REJECTED",
  "CANCELLED",
  "CHECKED_IN",
  "COMPLETED",
  "EXPIRED",
  "NO_SHOW",
]);

export const incidentStatusEnum = pgEnum("incident_status", [
  "REPORTED",
  "UNDER_REVIEW",
  "INVESTIGATING",
  "RESOLVED",
  "CLOSED",
]);

export const incidentSeverityEnum = pgEnum("incident_severity", [
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
]);

// ==========================================
// 2. Authentication & Authorization Tables
// ==========================================

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    name: varchar("name", { length: 255 }).notNull(),
    phone: varchar("phone", { length: 50 }),
    avatarUrl: text("avatar_url"),
    role: userRoleEnum("role").notNull().default("PARENT"),
    status: accountStatusEnum("status").notNull().default("ACTIVE"),
    emailVerified: boolean("email_verified").notNull().default(false),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    suspendedReason: text("suspended_reason"),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("users_email_idx").on(t.email),
    index("users_role_status_idx").on(t.role, t.status),
    index("users_created_at_idx").on(t.createdAt),
  ]
);

export const userRoles = pgTable(
  "user_roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: userRoleEnum("role").notNull(),
    assignedBy: uuid("assigned_by").references(() => users.id, {
      onDelete: "set null",
    }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("user_roles_user_id_idx").on(t.userId),
    index("user_roles_role_active_idx").on(t.role, t.isActive),
  ]
);

export const adminProfiles = pgTable(
  "admin_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    department: varchar("department", { length: 120 })
      .notNull()
      .default("Operations"),
    title: varchar("title", { length: 120 })
      .notNull()
      .default("Platform Administrator"),
    isApproved: boolean("is_approved").notNull().default(false),
    permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
    provisionedBy: uuid("provisioned_by").references(() => users.id, {
      onDelete: "set null",
    }),
    lastOtpVerifiedAt: timestamp("last_otp_verified_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("admin_profiles_user_id_idx").on(t.userId)]
);

export const adminOtpChallenges = pgTable(
  "admin_otp_challenges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 255 }).notNull(),
    otpHash: varchar("otp_hash", { length: 255 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    resendAvailableAt: timestamp("resend_available_at", {
      withTimezone: true,
    }).notNull(),
    resendCount: integer("resend_count").notNull().default(0),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: text("user_agent"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("admin_otp_user_id_idx").on(t.userId),
    index("admin_otp_email_idx").on(t.email),
    index("admin_otp_expires_at_idx").on(t.expiresAt),
  ]
);

export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionTokenHash: varchar("session_token_hash", { length: 255 })
      .notNull()
      .unique(),
    csrfToken: varchar("csrf_token", { length: 128 }).notNull(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: varchar("revoked_reason", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("admin_sessions_token_hash_idx").on(t.sessionTokenHash),
    index("admin_sessions_user_id_idx").on(t.userId),
    index("admin_sessions_expires_at_idx").on(t.expiresAt),
  ]
);

// ==========================================
// 3. Provider & Centre Management Tables
// ==========================================

export const providers = pgTable(
  "providers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    organizationName: varchar("organization_name", { length: 255 }).notNull(),
    registrationNumber: varchar("registration_number", { length: 100 })
      .notNull()
      .unique(),
    taxId: varchar("tax_id", { length: 100 }),
    contactEmail: varchar("contact_email", { length: 255 }).notNull(),
    contactPhone: varchar("contact_phone", { length: 50 }).notNull(),
    website: varchar("website", { length: 255 }),
    address: text("address").notNull(),
    city: varchar("city", { length: 120 }).notNull(),
    state: varchar("state", { length: 120 }).notNull(),
    postalCode: varchar("postal_code", { length: 30 }).notNull(),
    verificationStatus: verificationStatusEnum("verification_status")
      .notNull()
      .default("PENDING"),
    subscriptionTier: varchar("subscription_tier", { length: 60 })
      .notNull()
      .default("STANDARD"),
    subscriptionActive: boolean("subscription_active").notNull().default(true),
    isPublished: boolean("is_published").notNull().default(false),
    yearsInOperation: integer("years_in_operation").default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("providers_owner_user_idx").on(t.ownerUserId),
    index("providers_verification_status_idx").on(t.verificationStatus),
    index("providers_city_idx").on(t.city),
  ]
);

export interface OperatingHoursSchedule {
  [day: string]: {
    open: string;
    close: string;
    is24Hours?: boolean;
    closed?: boolean;
  };
}

export const centers = pgTable(
  "centers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 255 }).notNull().unique(),
    description: text("description"),
    address: text("address").notNull(),
    city: varchar("city", { length: 120 }).notNull(),
    state: varchar("state", { length: 120 }).notNull(),
    postalCode: varchar("postal_code", { length: 30 }).notNull(),
    phone: varchar("phone", { length: 50 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    ageGroupsSupported: jsonb("age_groups_supported")
      .$type<string[]>()
      .notNull()
      .default([]),
    operatingHours: jsonb("operating_hours")
      .$type<OperatingHoursSchedule>()
      .notNull()
      .default({}),
    is24x7: boolean("is_24x7").notNull().default(false),
    approvedCapacity: integer("approved_capacity").notNull().default(20),
    currentOccupancy: integer("current_occupancy").notNull().default(0),
    hourlyRate: numeric("hourly_rate", { precision: 10, scale: 2 })
      .notNull()
      .default("18.00"),
    dailyRate: numeric("daily_rate", { precision: 10, scale: 2 })
      .notNull()
      .default("120.00"),
    verificationStatus: verificationStatusEnum("verification_status")
      .notNull()
      .default("PENDING"),
    listingStatus: centerListingStatusEnum("listing_status")
      .notNull()
      .default("PENDING_APPROVAL"),
    suspendedReason: text("suspended_reason"),
    rating: numeric("rating", { precision: 3, scale: 2 }),
    verifiedBy: uuid("verified_by").references(() => users.id, {
      onDelete: "set null",
    }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verificationExpiresAt: timestamp("verification_expires_at", {
      withTimezone: true,
    }),
    reviewComments: text("review_comments"),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("centers_provider_id_idx").on(t.providerId),
    index("centers_listing_status_idx").on(t.listingStatus),
    index("centers_verification_status_idx").on(t.verificationStatus),
    index("centers_city_idx").on(t.city),
    check("centers_approved_capacity_nonneg", sql`${t.approvedCapacity} >= 0`),
    check("centers_current_occupancy_nonneg", sql`${t.currentOccupancy} >= 0`),
    check("centers_hourly_rate_nonneg", sql`${t.hourlyRate} >= 0`),
    check("centers_daily_rate_nonneg", sql`${t.dailyRate} >= 0`),
    check(
      "centers_rating_range_chk",
      sql`${t.rating} IS NULL OR (${t.rating} >= 0 AND ${t.rating} <= 5)`
    ),
  ]
);

export const caregivers = pgTable(
  "caregivers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    centerId: uuid("center_id")
      .notNull()
      .references(() => centers.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    fullName: varchar("full_name", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    phone: varchar("phone", { length: 50 }),
    roleTitle: varchar("role_title", { length: 120 })
      .notNull()
      .default("Lead Caregiver"),
    certifications: jsonb("certifications")
      .$type<string[]>()
      .notNull()
      .default([]),
    backgroundCheckStatus: varchar("background_check_status", { length: 50 })
      .notNull()
      .default("NOT_VERIFIED"),
    yearsExperience: integer("years_experience").notNull().default(2),
    isActive: boolean("is_active").notNull().default(true),
    verifiedBy: uuid("verified_by").references(() => users.id, {
      onDelete: "set null",
    }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verificationExpiresAt: timestamp("verification_expires_at", {
      withTimezone: true,
    }),
    reviewComments: text("review_comments"),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("caregivers_center_id_idx").on(t.centerId),
    index("caregivers_bg_status_idx").on(t.backgroundCheckStatus),
    check("caregivers_years_exp_nonneg", sql`${t.yearsExperience} >= 0`),
    check(
      "caregivers_bg_status_valid",
      sql`${t.backgroundCheckStatus} IN ('NOT_VERIFIED', 'PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED', 'SUSPENDED')`
    ),
  ]
);

export const verificationDocuments = pgTable(
  "verification_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    centerId: uuid("center_id").references(() => centers.id, {
      onDelete: "set null",
    }),
    caregiverId: uuid("caregiver_id").references(() => caregivers.id, {
      onDelete: "set null",
    }),
    documentCategory: varchar("document_category", { length: 60 })
      .notNull()
      .default("PROVIDER"),
    documentType: varchar("document_type", { length: 100 }).notNull(),
    documentTitle: varchar("document_title", { length: 255 }).notNull(),
    storageReference: varchar("storage_reference", { length: 500 }).notNull(),
    originalFileName: varchar("original_file_name", { length: 255 }),
    mimeType: varchar("mime_type", { length: 100 })
      .notNull()
      .default("application/pdf"),
    fileSizeBytes: integer("file_size_bytes").notNull().default(0),
    checksumSha256: varchar("checksum_sha256", { length: 128 }),
    malwareScanStatus: varchar("malware_scan_status", { length: 50 })
      .notNull()
      .default("PENDING"),
    malwareScanProvider: varchar("malware_scan_provider", { length: 80 }),
    malwareScannedAt: timestamp("malware_scanned_at", { withTimezone: true }),
    malwareScanResult: text("malware_scan_result"),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
    status: varchar("status", { length: 50 }).notNull().default("SUBMITTED"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    uploadedBy: uuid("uploaded_by").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedBy: uuid("reviewed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNotes: text("review_notes"),
    rejectionReason: text("rejection_reason"),
    replacementRequested: boolean("replacement_requested")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("verification_documents_provider_id_idx").on(t.providerId),
    index("verification_documents_center_id_idx").on(t.centerId),
    index("verification_documents_caregiver_id_idx").on(t.caregiverId),
    index("verification_documents_status_idx").on(t.status),
    index("verification_documents_malware_status_idx").on(t.malwareScanStatus),
    check("verification_documents_size_nonneg", sql`${t.fileSizeBytes} >= 0`),
    check(
      "verification_documents_size_max",
      sql`${t.fileSizeBytes} <= 10485760`
    ),
    check(
      "verification_documents_status_valid",
      sql`${t.status} IN ('SUBMITTED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED')`
    ),
    check(
      "verification_documents_malware_status_valid",
      sql`${t.malwareScanStatus} IN ('PENDING', 'SCANNING', 'CLEAN', 'INFECTED', 'ERROR')`
    ),
    check(
      "verification_documents_category_valid",
      sql`${t.documentCategory} IN ('PROVIDER', 'CENTER', 'CAREGIVER')`
    ),
  ]
);

export const providerVerifications = pgTable(
  "provider_verifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    status: verificationStatusEnum("status").notNull().default("PENDING"),
    reviewerId: uuid("reviewer_id").references(() => users.id, {
      onDelete: "set null",
    }),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewComments: text("review_comments"),
    rejectionReason: text("rejection_reason"),
    requestedDocuments: jsonb("requested_documents")
      .$type<string[]>()
      .notNull()
      .default([]),
    documentReferences: jsonb("document_references")
      .$type<string[]>()
      .notNull()
      .default([]),
    checklistState: jsonb("checklist_state")
      .$type<Record<string, boolean>>()
      .notNull()
      .default({}),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("provider_verifications_provider_id_idx").on(t.providerId),
    index("provider_verifications_status_idx").on(t.status),
    index("provider_verifications_reviewer_id_idx").on(t.reviewerId),
  ]
);

export const centerVerifications = pgTable(
  "center_verifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    centerId: uuid("center_id")
      .notNull()
      .references(() => centers.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    status: verificationStatusEnum("status").notNull().default("PENDING"),
    reviewerId: uuid("reviewer_id").references(() => users.id, {
      onDelete: "set null",
    }),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewComments: text("review_comments"),
    rejectionReason: text("rejection_reason"),
    requestedDocuments: jsonb("requested_documents")
      .$type<string[]>()
      .notNull()
      .default([]),
    documentReferences: jsonb("document_references")
      .$type<string[]>()
      .notNull()
      .default([]),
    checklistState: jsonb("checklist_state")
      .$type<Record<string, boolean>>()
      .notNull()
      .default({}),
    safetyComplianceNotes: text("safety_compliance_notes"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("center_verifications_center_id_idx").on(t.centerId),
    index("center_verifications_provider_id_idx").on(t.providerId),
    index("center_verifications_status_idx").on(t.status),
    index("center_verifications_reviewer_id_idx").on(t.reviewerId),
  ]
);

export const caregiverVerifications = pgTable(
  "caregiver_verifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    caregiverId: uuid("caregiver_id")
      .notNull()
      .references(() => caregivers.id, { onDelete: "cascade" }),
    centerId: uuid("center_id")
      .notNull()
      .references(() => centers.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 50 }).notNull().default("NOT_VERIFIED"),
    reviewerId: uuid("reviewer_id").references(() => users.id, {
      onDelete: "set null",
    }),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewComments: text("review_comments"),
    rejectionReason: text("rejection_reason"),
    documentReferences: jsonb("document_references")
      .$type<string[]>()
      .notNull()
      .default([]),
    checklistState: jsonb("checklist_state")
      .$type<Record<string, boolean>>()
      .notNull()
      .default({}),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("caregiver_verifications_caregiver_id_idx").on(t.caregiverId),
    index("caregiver_verifications_center_id_idx").on(t.centerId),
    index("caregiver_verifications_provider_id_idx").on(t.providerId),
    index("caregiver_verifications_status_idx").on(t.status),
    check(
      "caregiver_verifications_status_valid",
      sql`${t.status} IN ('NOT_VERIFIED', 'PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED', 'SUSPENDED')`
    ),
  ]
);

export const verificationReviewHistory = pgTable(
  "verification_review_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subjectType: varchar("subject_type", { length: 50 }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    verificationId: uuid("verification_id"),
    previousStatus: varchar("previous_status", { length: 50 }),
    newStatus: varchar("new_status", { length: 50 }).notNull(),
    decision: varchar("decision", { length: 60 }).notNull(),
    reviewerId: uuid("reviewer_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewerEmail: varchar("reviewer_email", { length: 255 }).notNull(),
    reviewComments: text("review_comments"),
    rejectionReason: text("rejection_reason"),
    evidenceSnapshot: jsonb("evidence_snapshot")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("verification_review_history_subject_idx").on(
      t.subjectType,
      t.subjectId
    ),
    index("verification_review_history_verification_id_idx").on(
      t.verificationId
    ),
    index("verification_review_history_created_at_idx").on(t.createdAt),
    check(
      "verification_review_history_subject_type_valid",
      sql`${t.subjectType} IN ('PROVIDER', 'CENTER', 'CAREGIVER', 'DOCUMENT')`
    ),
  ]
);

// ==========================================
// 4. Booking & Capacity Management Tables
// ==========================================

export const children = pgTable(
  "children",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    parentId: uuid("parent_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    firstName: varchar("first_name", { length: 120 }).notNull(),
    ageMonths: integer("age_months").notNull(),
    ageGroup: varchar("age_group", { length: 60 }).notNull(),
    hasMedicalNotes: boolean("has_medical_notes").notNull().default(false),
    emergencyContactPhone: varchar("emergency_contact_phone", { length: 50 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("children_parent_id_idx").on(t.parentId)]
);

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    bookingReference: varchar("booking_reference", { length: 40 })
      .notNull()
      .unique(),
    parentId: uuid("parent_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    childId: uuid("child_id")
      .notNull()
      .references(() => children.id, { onDelete: "restrict" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "restrict" }),
    centerId: uuid("center_id")
      .notNull()
      .references(() => centers.id, { onDelete: "restrict" }),
    status: bookingStatusEnum("status").notNull().default("REQUESTED"),
    careType: varchar("care_type", { length: 60 })
      .notNull()
      .default("FULL_DAY"),
    startTime: timestamp("start_time", { withTimezone: true }).notNull(),
    endTime: timestamp("end_time", { withTimezone: true }).notNull(),
    totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull(),
    paymentStatus: varchar("payment_status", { length: 50 })
      .notNull()
      .default("PENDING"),
    hasConflict: boolean("has_conflict").notNull().default(false),
    cancellationReason: text("cancellation_reason"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("bookings_reference_idx").on(t.bookingReference),
    index("bookings_center_status_idx").on(t.centerId, t.status),
    index("bookings_provider_id_idx").on(t.providerId),
    index("bookings_parent_id_idx").on(t.parentId),
    index("bookings_start_time_idx").on(t.startTime),
    check("bookings_total_amount_nonneg", sql`${t.totalAmount} >= 0`),
    check("bookings_valid_time_range", sql`${t.endTime} > ${t.startTime}`),
    check(
      "bookings_payment_status_valid",
      sql`${t.paymentStatus} IN ('UNPAID', 'PENDING', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED', 'FAILED')`
    ),
  ]
);

export const bookingStatusHistory = pgTable(
  "booking_status_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    fromStatus: bookingStatusEnum("from_status"),
    toStatus: bookingStatusEnum("to_status").notNull(),
    changedBy: uuid("changed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("booking_status_history_booking_id_idx").on(t.bookingId)]
);

export const capacityRules = pgTable(
  "capacity_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    centerId: uuid("center_id")
      .notNull()
      .references(() => centers.id, { onDelete: "cascade" }),
    ageGroup: varchar("age_group", { length: 60 }).notNull(),
    maxChildren: integer("max_children").notNull(),
    caregiverRatio: varchar("caregiver_ratio", { length: 30 })
      .notNull()
      .default("1:4"),
    isActive: boolean("is_active").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("capacity_rules_center_id_idx").on(t.centerId),
    check("capacity_rules_max_children_pos", sql`${t.maxChildren} > 0`),
  ]
);

// ==========================================
// 5. Platform Operations, Incidents & Audit
// ==========================================

export const safetyIncidents = pgTable(
  "safety_incidents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    incidentReference: varchar("incident_reference", { length: 40 })
      .notNull()
      .unique(),
    centerId: uuid("center_id")
      .notNull()
      .references(() => centers.id, { onDelete: "restrict" }),
    bookingId: uuid("booking_id").references(() => bookings.id, {
      onDelete: "set null",
    }),
    reportedByUserId: uuid("reported_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    assignedAdminId: uuid("assigned_admin_id").references(() => users.id, {
      onDelete: "set null",
    }),
    category: varchar("category", { length: 100 }).notNull(),
    severity: incidentSeverityEnum("severity").notNull().default("MEDIUM"),
    status: incidentStatusEnum("status").notNull().default("REPORTED"),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description").notNull(),
    resolutionOutcome: text("resolution_outcome"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("safety_incidents_ref_idx").on(t.incidentReference),
    index("safety_incidents_status_severity_idx").on(t.status, t.severity),
    index("safety_incidents_center_id_idx").on(t.centerId),
  ]
);

export const incidentActivity = pgTable(
  "incident_activity",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => safetyIncidents.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    actionType: varchar("action_type", { length: 80 }).notNull(),
    fromStatus: incidentStatusEnum("from_status"),
    toStatus: incidentStatusEnum("to_status"),
    note: text("note").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("incident_activity_incident_id_idx").on(t.incidentId)]
);

export const disputes = pgTable(
  "disputes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    disputeReference: varchar("dispute_reference", { length: 40 })
      .notNull()
      .unique(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    raisedByUserId: uuid("raised_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reason: varchar("reason", { length: 255 }).notNull(),
    description: text("description").notNull(),
    status: varchar("status", { length: 50 }).notNull().default("OPEN"),
    resolutionNotes: text("resolution_notes"),
    resolvedByAdminId: uuid("resolved_by_admin_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("disputes_booking_id_idx").on(t.bookingId),
    index("disputes_status_idx").on(t.status),
  ]
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    recipientUserId: uuid("recipient_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    audienceRole: varchar("audience_role", { length: 50 })
      .notNull()
      .default("ADMIN"),
    type: varchar("type", { length: 80 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    message: text("message").notNull(),
    entityType: varchar("entity_type", { length: 80 }),
    entityId: uuid("entity_id"),
    isRead: boolean("is_read").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("notifications_recipient_idx").on(t.recipientUserId, t.isRead),
    index("notifications_audience_idx").on(t.audienceRole, t.createdAt),
  ]
);

export const adminAuditLogs = pgTable(
  "admin_audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    adminUserId: uuid("admin_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    adminEmail: varchar("admin_email", { length: 255 }).notNull(),
    action: varchar("action", { length: 120 }).notNull(),
    entityType: varchar("entity_type", { length: 80 }).notNull(),
    entityId: varchar("entity_id", { length: 120 }),
    summary: text("summary").notNull(),
    previousState: jsonb("previous_state").$type<Record<string, unknown>>(),
    newState: jsonb("new_state").$type<Record<string, unknown>>(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: text("user_agent"),
    integrityHash: varchar("integrity_hash", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("admin_audit_logs_admin_idx").on(t.adminUserId),
    index("admin_audit_logs_action_idx").on(t.action),
    index("admin_audit_logs_entity_idx").on(t.entityType, t.entityId),
    index("admin_audit_logs_created_at_idx").on(t.createdAt),
  ]
);

export const platformSettings = pgTable(
  "platform_settings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    settingKey: varchar("setting_key", { length: 120 }).notNull().unique(),
    settingValue: jsonb("setting_value").$type<unknown>().notNull(),
    category: varchar("category", { length: 80 }).notNull().default("GENERAL"),
    description: text("description"),
    updatedByAdminId: uuid("updated_by_admin_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("platform_settings_key_idx").on(t.settingKey),
    index("platform_settings_category_idx").on(t.category),
  ]
);

// ==========================================
// 6. Inferred Types
// ==========================================

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type AdminProfile = typeof adminProfiles.$inferSelect;
export type AdminOtpChallenge = typeof adminOtpChallenges.$inferSelect;
export type AdminSession = typeof adminSessions.$inferSelect;
export type Provider = typeof providers.$inferSelect;
export type Center = typeof centers.$inferSelect;
export type Caregiver = typeof caregivers.$inferSelect;
export type VerificationDocument = typeof verificationDocuments.$inferSelect;
export type ProviderVerification = typeof providerVerifications.$inferSelect;
export type CenterVerification = typeof centerVerifications.$inferSelect;
export type CaregiverVerification = typeof caregiverVerifications.$inferSelect;
export type VerificationReviewHistoryItem =
  typeof verificationReviewHistory.$inferSelect;
export type Child = typeof children.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type BookingStatusHistoryItem = typeof bookingStatusHistory.$inferSelect;
export type CapacityRule = typeof capacityRules.$inferSelect;
export type SafetyIncident = typeof safetyIncidents.$inferSelect;
export type IncidentActivityItem = typeof incidentActivity.$inferSelect;
export type Dispute = typeof disputes.$inferSelect;
export type NotificationItem = typeof notifications.$inferSelect;
export type AdminAuditLog = typeof adminAuditLogs.$inferSelect;
export type PlatformSetting = typeof platformSettings.$inferSelect;

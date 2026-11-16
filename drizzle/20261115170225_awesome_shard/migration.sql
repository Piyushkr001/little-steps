CREATE TABLE "caregiver_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"caregiver_id" uuid NOT NULL,
	"center_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"status" varchar(50) DEFAULT 'NOT_VERIFIED' NOT NULL,
	"reviewer_id" uuid,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"review_comments" text,
	"rejection_reason" text,
	"document_references" jsonb DEFAULT '[]' NOT NULL,
	"checklist_state" jsonb DEFAULT '{}' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "caregiver_verifications_status_valid" CHECK ("status" IN ('NOT_VERIFIED', 'PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED', 'SUSPENDED'))
);
--> statement-breakpoint
CREATE TABLE "center_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"center_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"status" "verification_status" DEFAULT 'PENDING'::"verification_status" NOT NULL,
	"reviewer_id" uuid,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"review_comments" text,
	"rejection_reason" text,
	"requested_documents" jsonb DEFAULT '[]' NOT NULL,
	"document_references" jsonb DEFAULT '[]' NOT NULL,
	"checklist_state" jsonb DEFAULT '{}' NOT NULL,
	"safety_compliance_notes" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_review_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"subject_type" varchar(50) NOT NULL,
	"subject_id" uuid NOT NULL,
	"verification_id" uuid,
	"previous_status" varchar(50),
	"new_status" varchar(50) NOT NULL,
	"decision" varchar(60) NOT NULL,
	"reviewer_id" uuid,
	"reviewer_email" varchar(255) NOT NULL,
	"review_comments" text,
	"rejection_reason" text,
	"evidence_snapshot" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_review_history_subject_type_valid" CHECK ("subject_type" IN ('PROVIDER', 'CENTER', 'CAREGIVER', 'DOCUMENT'))
);
--> statement-breakpoint
ALTER TABLE "caregivers" ADD COLUMN "verified_by" uuid;--> statement-breakpoint
ALTER TABLE "caregivers" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "caregivers" ADD COLUMN "verification_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "caregivers" ADD COLUMN "review_comments" text;--> statement-breakpoint
ALTER TABLE "caregivers" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "caregivers" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "centers" ADD COLUMN "verified_by" uuid;--> statement-breakpoint
ALTER TABLE "centers" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "centers" ADD COLUMN "verification_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "centers" ADD COLUMN "review_comments" text;--> statement-breakpoint
ALTER TABLE "centers" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "verification_documents" ADD COLUMN "caregiver_id" uuid;--> statement-breakpoint
ALTER TABLE "verification_documents" ADD COLUMN "document_category" varchar(60) DEFAULT 'PROVIDER' NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_documents" ADD COLUMN "malware_scan_status" varchar(50) DEFAULT 'CLEAN' NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_documents" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "verification_documents" ADD COLUMN "replacement_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_documents" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_profiles" ALTER COLUMN "is_approved" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "payment_status" SET DEFAULT 'PENDING';--> statement-breakpoint
ALTER TABLE "caregivers" ALTER COLUMN "background_check_status" SET DEFAULT 'NOT_VERIFIED';--> statement-breakpoint
ALTER TABLE "centers" ALTER COLUMN "listing_status" SET DEFAULT 'PENDING_APPROVAL'::"center_listing_status";--> statement-breakpoint
ALTER TABLE "centers" ALTER COLUMN "rating" DROP DEFAULT;--> statement-breakpoint
CREATE INDEX "caregiver_verifications_caregiver_id_idx" ON "caregiver_verifications" ("caregiver_id");--> statement-breakpoint
CREATE INDEX "caregiver_verifications_center_id_idx" ON "caregiver_verifications" ("center_id");--> statement-breakpoint
CREATE INDEX "caregiver_verifications_provider_id_idx" ON "caregiver_verifications" ("provider_id");--> statement-breakpoint
CREATE INDEX "caregiver_verifications_status_idx" ON "caregiver_verifications" ("status");--> statement-breakpoint
CREATE INDEX "caregivers_bg_status_idx" ON "caregivers" ("background_check_status");--> statement-breakpoint
CREATE INDEX "center_verifications_center_id_idx" ON "center_verifications" ("center_id");--> statement-breakpoint
CREATE INDEX "center_verifications_provider_id_idx" ON "center_verifications" ("provider_id");--> statement-breakpoint
CREATE INDEX "center_verifications_status_idx" ON "center_verifications" ("status");--> statement-breakpoint
CREATE INDEX "center_verifications_reviewer_id_idx" ON "center_verifications" ("reviewer_id");--> statement-breakpoint
CREATE INDEX "verification_documents_center_id_idx" ON "verification_documents" ("center_id");--> statement-breakpoint
CREATE INDEX "verification_documents_caregiver_id_idx" ON "verification_documents" ("caregiver_id");--> statement-breakpoint
CREATE INDEX "verification_review_history_subject_idx" ON "verification_review_history" ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "verification_review_history_verification_id_idx" ON "verification_review_history" ("verification_id");--> statement-breakpoint
CREATE INDEX "verification_review_history_created_at_idx" ON "verification_review_history" ("created_at");--> statement-breakpoint
ALTER TABLE "caregiver_verifications" ADD CONSTRAINT "caregiver_verifications_caregiver_id_caregivers_id_fkey" FOREIGN KEY ("caregiver_id") REFERENCES "caregivers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "caregiver_verifications" ADD CONSTRAINT "caregiver_verifications_center_id_centers_id_fkey" FOREIGN KEY ("center_id") REFERENCES "centers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "caregiver_verifications" ADD CONSTRAINT "caregiver_verifications_provider_id_providers_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "caregiver_verifications" ADD CONSTRAINT "caregiver_verifications_reviewer_id_users_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "caregivers" ADD CONSTRAINT "caregivers_verified_by_users_id_fkey" FOREIGN KEY ("verified_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "center_verifications" ADD CONSTRAINT "center_verifications_center_id_centers_id_fkey" FOREIGN KEY ("center_id") REFERENCES "centers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "center_verifications" ADD CONSTRAINT "center_verifications_provider_id_providers_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "center_verifications" ADD CONSTRAINT "center_verifications_reviewer_id_users_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "centers" ADD CONSTRAINT "centers_verified_by_users_id_fkey" FOREIGN KEY ("verified_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "verification_documents" ADD CONSTRAINT "verification_documents_caregiver_id_caregivers_id_fkey" FOREIGN KEY ("caregiver_id") REFERENCES "caregivers"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "verification_review_history" ADD CONSTRAINT "verification_review_history_reviewer_id_users_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_total_amount_nonneg" CHECK ("total_amount" >= 0);--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_valid_time_range" CHECK ("end_time" > "start_time") NOT VALID;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_payment_status_valid" CHECK ("payment_status" IN ('UNPAID', 'PENDING', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED', 'FAILED'));--> statement-breakpoint
ALTER TABLE "capacity_rules" ADD CONSTRAINT "capacity_rules_max_children_pos" CHECK ("max_children" > 0);--> statement-breakpoint
ALTER TABLE "caregivers" ADD CONSTRAINT "caregivers_years_exp_nonneg" CHECK ("years_experience" >= 0);--> statement-breakpoint
ALTER TABLE "caregivers" ADD CONSTRAINT "caregivers_bg_status_valid" CHECK ("background_check_status" IN ('NOT_VERIFIED', 'PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED', 'SUSPENDED'));--> statement-breakpoint
ALTER TABLE "centers" ADD CONSTRAINT "centers_approved_capacity_nonneg" CHECK ("approved_capacity" >= 0);--> statement-breakpoint
ALTER TABLE "centers" ADD CONSTRAINT "centers_current_occupancy_nonneg" CHECK ("current_occupancy" >= 0);--> statement-breakpoint
ALTER TABLE "centers" ADD CONSTRAINT "centers_hourly_rate_nonneg" CHECK ("hourly_rate" >= 0);--> statement-breakpoint
ALTER TABLE "centers" ADD CONSTRAINT "centers_daily_rate_nonneg" CHECK ("daily_rate" >= 0);--> statement-breakpoint
ALTER TABLE "centers" ADD CONSTRAINT "centers_rating_range_chk" CHECK ("rating" IS NULL OR ("rating" >= 0 AND "rating" <= 5));--> statement-breakpoint
ALTER TABLE "verification_documents" ADD CONSTRAINT "verification_documents_size_nonneg" CHECK ("file_size_bytes" >= 0);--> statement-breakpoint
ALTER TABLE "verification_documents" ADD CONSTRAINT "verification_documents_status_valid" CHECK ("status" IN ('SUBMITTED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED'));
CREATE TYPE "account_status" AS ENUM('ACTIVE', 'SUSPENDED', 'DISABLED', 'PENDING');--> statement-breakpoint
CREATE TYPE "booking_status" AS ENUM('REQUESTED', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'CHECKED_IN', 'COMPLETED', 'EXPIRED', 'NO_SHOW');--> statement-breakpoint
CREATE TYPE "center_listing_status" AS ENUM('ACTIVE', 'SUSPENDED', 'INACTIVE', 'PENDING_APPROVAL');--> statement-breakpoint
CREATE TYPE "incident_severity" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "incident_status" AS ENUM('REPORTED', 'UNDER_REVIEW', 'INVESTIGATING', 'RESOLVED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "user_role" AS ENUM('PARENT', 'PROVIDER', 'CAREGIVER', 'ADMIN', 'SUPER_ADMIN');--> statement-breakpoint
CREATE TYPE "verification_status" AS ENUM('NOT_SUBMITTED', 'PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUSPENDED');--> statement-breakpoint
CREATE TABLE "admin_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"admin_user_id" uuid,
	"admin_email" varchar(255) NOT NULL,
	"action" varchar(120) NOT NULL,
	"entity_type" varchar(80) NOT NULL,
	"entity_id" varchar(120),
	"summary" text NOT NULL,
	"previous_state" jsonb,
	"new_state" jsonb,
	"ip_address" varchar(64),
	"user_agent" text,
	"integrity_hash" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_otp_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"otp_hash" varchar(255) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"resend_available_at" timestamp with time zone NOT NULL,
	"resend_count" integer DEFAULT 0 NOT NULL,
	"ip_address" varchar(64),
	"user_agent" text,
	"consumed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL UNIQUE,
	"department" varchar(120) DEFAULT 'Operations' NOT NULL,
	"title" varchar(120) DEFAULT 'Platform Administrator' NOT NULL,
	"is_approved" boolean DEFAULT true NOT NULL,
	"permissions" jsonb DEFAULT '[]' NOT NULL,
	"provisioned_by" uuid,
	"last_otp_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"session_token_hash" varchar(255) NOT NULL UNIQUE,
	"csrf_token" varchar(128) NOT NULL,
	"ip_address" varchar(64),
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"booking_id" uuid NOT NULL,
	"from_status" "booking_status",
	"to_status" "booking_status" NOT NULL,
	"changed_by" uuid,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"booking_reference" varchar(40) NOT NULL UNIQUE,
	"parent_id" uuid NOT NULL,
	"child_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"center_id" uuid NOT NULL,
	"status" "booking_status" DEFAULT 'REQUESTED'::"booking_status" NOT NULL,
	"care_type" varchar(60) DEFAULT 'FULL_DAY' NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"total_amount" numeric(10,2) NOT NULL,
	"payment_status" varchar(50) DEFAULT 'PAID' NOT NULL,
	"has_conflict" boolean DEFAULT false NOT NULL,
	"cancellation_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capacity_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"center_id" uuid NOT NULL,
	"age_group" varchar(60) NOT NULL,
	"max_children" integer NOT NULL,
	"caregiver_ratio" varchar(30) DEFAULT '1:4' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "caregivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"center_id" uuid NOT NULL,
	"user_id" uuid,
	"full_name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"phone" varchar(50),
	"role_title" varchar(120) DEFAULT 'Lead Caregiver' NOT NULL,
	"certifications" jsonb DEFAULT '[]' NOT NULL,
	"background_check_status" varchar(50) DEFAULT 'VERIFIED' NOT NULL,
	"years_experience" integer DEFAULT 2 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "centers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"provider_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL UNIQUE,
	"description" text,
	"address" text NOT NULL,
	"city" varchar(120) NOT NULL,
	"state" varchar(120) NOT NULL,
	"postal_code" varchar(30) NOT NULL,
	"phone" varchar(50) NOT NULL,
	"email" varchar(255) NOT NULL,
	"age_groups_supported" jsonb DEFAULT '[]' NOT NULL,
	"operating_hours" jsonb DEFAULT '{}' NOT NULL,
	"is_24x7" boolean DEFAULT false NOT NULL,
	"approved_capacity" integer DEFAULT 20 NOT NULL,
	"current_occupancy" integer DEFAULT 0 NOT NULL,
	"hourly_rate" numeric(10,2) DEFAULT '18.00' NOT NULL,
	"daily_rate" numeric(10,2) DEFAULT '120.00' NOT NULL,
	"verification_status" "verification_status" DEFAULT 'PENDING'::"verification_status" NOT NULL,
	"listing_status" "center_listing_status" DEFAULT 'ACTIVE'::"center_listing_status" NOT NULL,
	"suspended_reason" text,
	"rating" numeric(3,2) DEFAULT '4.80',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "children" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"parent_id" uuid NOT NULL,
	"first_name" varchar(120) NOT NULL,
	"age_months" integer NOT NULL,
	"age_group" varchar(60) NOT NULL,
	"has_medical_notes" boolean DEFAULT false NOT NULL,
	"emergency_contact_phone" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"dispute_reference" varchar(40) NOT NULL UNIQUE,
	"booking_id" uuid NOT NULL,
	"raised_by_user_id" uuid NOT NULL,
	"reason" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"status" varchar(50) DEFAULT 'OPEN' NOT NULL,
	"resolution_notes" text,
	"resolved_by_admin_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"incident_id" uuid NOT NULL,
	"actor_id" uuid,
	"action_type" varchar(80) NOT NULL,
	"from_status" "incident_status",
	"to_status" "incident_status",
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"recipient_user_id" uuid,
	"audience_role" varchar(50) DEFAULT 'ADMIN' NOT NULL,
	"type" varchar(80) NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"entity_type" varchar(80),
	"entity_id" uuid,
	"is_read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"setting_key" varchar(120) NOT NULL UNIQUE,
	"setting_value" jsonb NOT NULL,
	"category" varchar(80) DEFAULT 'GENERAL' NOT NULL,
	"description" text,
	"updated_by_admin_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_user_id" uuid NOT NULL,
	"organization_name" varchar(255) NOT NULL,
	"registration_number" varchar(100) NOT NULL UNIQUE,
	"tax_id" varchar(100),
	"contact_email" varchar(255) NOT NULL,
	"contact_phone" varchar(50) NOT NULL,
	"website" varchar(255),
	"address" text NOT NULL,
	"city" varchar(120) NOT NULL,
	"state" varchar(120) NOT NULL,
	"postal_code" varchar(30) NOT NULL,
	"verification_status" "verification_status" DEFAULT 'PENDING'::"verification_status" NOT NULL,
	"subscription_tier" varchar(60) DEFAULT 'STANDARD' NOT NULL,
	"subscription_active" boolean DEFAULT true NOT NULL,
	"is_published" boolean DEFAULT false NOT NULL,
	"years_in_operation" integer DEFAULT 1,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safety_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"incident_reference" varchar(40) NOT NULL UNIQUE,
	"center_id" uuid NOT NULL,
	"booking_id" uuid,
	"reported_by_user_id" uuid,
	"assigned_admin_id" uuid,
	"category" varchar(100) NOT NULL,
	"severity" "incident_severity" DEFAULT 'MEDIUM'::"incident_severity" NOT NULL,
	"status" "incident_status" DEFAULT 'REPORTED'::"incident_status" NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"resolution_outcome" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"role" "user_role" NOT NULL,
	"assigned_by" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"email" varchar(255) NOT NULL UNIQUE,
	"name" varchar(255) NOT NULL,
	"phone" varchar(50),
	"avatar_url" text,
	"role" "user_role" DEFAULT 'PARENT'::"user_role" NOT NULL,
	"status" "account_status" DEFAULT 'ACTIVE'::"account_status" NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"suspended_reason" text,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"provider_id" uuid NOT NULL,
	"center_id" uuid,
	"document_type" varchar(100) NOT NULL,
	"document_title" varchar(255) NOT NULL,
	"storage_reference" varchar(500) NOT NULL,
	"mime_type" varchar(100) DEFAULT 'application/pdf' NOT NULL,
	"file_size_bytes" integer DEFAULT 0 NOT NULL,
	"checksum_sha256" varchar(128),
	"status" varchar(50) DEFAULT 'SUBMITTED' NOT NULL,
	"expires_at" timestamp with time zone,
	"uploaded_by" uuid,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "admin_audit_logs_admin_idx" ON "admin_audit_logs" ("admin_user_id");--> statement-breakpoint
CREATE INDEX "admin_audit_logs_action_idx" ON "admin_audit_logs" ("action");--> statement-breakpoint
CREATE INDEX "admin_audit_logs_entity_idx" ON "admin_audit_logs" ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "admin_audit_logs_created_at_idx" ON "admin_audit_logs" ("created_at");--> statement-breakpoint
CREATE INDEX "admin_otp_user_id_idx" ON "admin_otp_challenges" ("user_id");--> statement-breakpoint
CREATE INDEX "admin_otp_email_idx" ON "admin_otp_challenges" ("email");--> statement-breakpoint
CREATE INDEX "admin_otp_expires_at_idx" ON "admin_otp_challenges" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_profiles_user_id_idx" ON "admin_profiles" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_sessions_token_hash_idx" ON "admin_sessions" ("session_token_hash");--> statement-breakpoint
CREATE INDEX "admin_sessions_user_id_idx" ON "admin_sessions" ("user_id");--> statement-breakpoint
CREATE INDEX "admin_sessions_expires_at_idx" ON "admin_sessions" ("expires_at");--> statement-breakpoint
CREATE INDEX "booking_status_history_booking_id_idx" ON "booking_status_history" ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_reference_idx" ON "bookings" ("booking_reference");--> statement-breakpoint
CREATE INDEX "bookings_center_status_idx" ON "bookings" ("center_id","status");--> statement-breakpoint
CREATE INDEX "bookings_provider_id_idx" ON "bookings" ("provider_id");--> statement-breakpoint
CREATE INDEX "bookings_parent_id_idx" ON "bookings" ("parent_id");--> statement-breakpoint
CREATE INDEX "bookings_start_time_idx" ON "bookings" ("start_time");--> statement-breakpoint
CREATE INDEX "capacity_rules_center_id_idx" ON "capacity_rules" ("center_id");--> statement-breakpoint
CREATE INDEX "caregivers_center_id_idx" ON "caregivers" ("center_id");--> statement-breakpoint
CREATE INDEX "centers_provider_id_idx" ON "centers" ("provider_id");--> statement-breakpoint
CREATE INDEX "centers_listing_status_idx" ON "centers" ("listing_status");--> statement-breakpoint
CREATE INDEX "centers_verification_status_idx" ON "centers" ("verification_status");--> statement-breakpoint
CREATE INDEX "centers_city_idx" ON "centers" ("city");--> statement-breakpoint
CREATE INDEX "children_parent_id_idx" ON "children" ("parent_id");--> statement-breakpoint
CREATE INDEX "disputes_booking_id_idx" ON "disputes" ("booking_id");--> statement-breakpoint
CREATE INDEX "disputes_status_idx" ON "disputes" ("status");--> statement-breakpoint
CREATE INDEX "incident_activity_incident_id_idx" ON "incident_activity" ("incident_id");--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" ("recipient_user_id","is_read");--> statement-breakpoint
CREATE INDEX "notifications_audience_idx" ON "notifications" ("audience_role","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_settings_key_idx" ON "platform_settings" ("setting_key");--> statement-breakpoint
CREATE INDEX "platform_settings_category_idx" ON "platform_settings" ("category");--> statement-breakpoint
CREATE INDEX "provider_verifications_provider_id_idx" ON "provider_verifications" ("provider_id");--> statement-breakpoint
CREATE INDEX "provider_verifications_status_idx" ON "provider_verifications" ("status");--> statement-breakpoint
CREATE INDEX "provider_verifications_reviewer_id_idx" ON "provider_verifications" ("reviewer_id");--> statement-breakpoint
CREATE INDEX "providers_owner_user_idx" ON "providers" ("owner_user_id");--> statement-breakpoint
CREATE INDEX "providers_verification_status_idx" ON "providers" ("verification_status");--> statement-breakpoint
CREATE INDEX "providers_city_idx" ON "providers" ("city");--> statement-breakpoint
CREATE UNIQUE INDEX "safety_incidents_ref_idx" ON "safety_incidents" ("incident_reference");--> statement-breakpoint
CREATE INDEX "safety_incidents_status_severity_idx" ON "safety_incidents" ("status","severity");--> statement-breakpoint
CREATE INDEX "safety_incidents_center_id_idx" ON "safety_incidents" ("center_id");--> statement-breakpoint
CREATE INDEX "user_roles_user_id_idx" ON "user_roles" ("user_id");--> statement-breakpoint
CREATE INDEX "user_roles_role_active_idx" ON "user_roles" ("role","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" ("email");--> statement-breakpoint
CREATE INDEX "users_role_status_idx" ON "users" ("role","status");--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "users" ("created_at");--> statement-breakpoint
CREATE INDEX "verification_documents_provider_id_idx" ON "verification_documents" ("provider_id");--> statement-breakpoint
CREATE INDEX "verification_documents_status_idx" ON "verification_documents" ("status");--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_admin_user_id_users_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "admin_otp_challenges" ADD CONSTRAINT "admin_otp_challenges_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "admin_profiles" ADD CONSTRAINT "admin_profiles_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "admin_profiles" ADD CONSTRAINT "admin_profiles_provisioned_by_users_id_fkey" FOREIGN KEY ("provisioned_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "booking_status_history" ADD CONSTRAINT "booking_status_history_booking_id_bookings_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "booking_status_history" ADD CONSTRAINT "booking_status_history_changed_by_users_id_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_parent_id_users_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_child_id_children_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_provider_id_providers_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_center_id_centers_id_fkey" FOREIGN KEY ("center_id") REFERENCES "centers"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "capacity_rules" ADD CONSTRAINT "capacity_rules_center_id_centers_id_fkey" FOREIGN KEY ("center_id") REFERENCES "centers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "caregivers" ADD CONSTRAINT "caregivers_center_id_centers_id_fkey" FOREIGN KEY ("center_id") REFERENCES "centers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "caregivers" ADD CONSTRAINT "caregivers_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "centers" ADD CONSTRAINT "centers_provider_id_providers_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "children" ADD CONSTRAINT "children_parent_id_users_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_booking_id_bookings_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_raised_by_user_id_users_id_fkey" FOREIGN KEY ("raised_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_resolved_by_admin_id_users_id_fkey" FOREIGN KEY ("resolved_by_admin_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "incident_activity" ADD CONSTRAINT "incident_activity_incident_id_safety_incidents_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "safety_incidents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "incident_activity" ADD CONSTRAINT "incident_activity_actor_id_users_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updated_by_admin_id_users_id_fkey" FOREIGN KEY ("updated_by_admin_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "provider_verifications" ADD CONSTRAINT "provider_verifications_provider_id_providers_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "provider_verifications" ADD CONSTRAINT "provider_verifications_reviewer_id_users_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_owner_user_id_users_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_center_id_centers_id_fkey" FOREIGN KEY ("center_id") REFERENCES "centers"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_booking_id_bookings_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_reported_by_user_id_users_id_fkey" FOREIGN KEY ("reported_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_assigned_admin_id_users_id_fkey" FOREIGN KEY ("assigned_admin_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_assigned_by_users_id_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "verification_documents" ADD CONSTRAINT "verification_documents_provider_id_providers_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "verification_documents" ADD CONSTRAINT "verification_documents_center_id_centers_id_fkey" FOREIGN KEY ("center_id") REFERENCES "centers"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "verification_documents" ADD CONSTRAINT "verification_documents_uploaded_by_users_id_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "verification_documents" ADD CONSTRAINT "verification_documents_reviewed_by_users_id_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL;
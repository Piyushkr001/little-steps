ALTER TABLE "verification_documents" ADD COLUMN "original_file_name" varchar(255);--> statement-breakpoint
ALTER TABLE "verification_documents" ADD COLUMN "malware_scan_provider" varchar(80);--> statement-breakpoint
ALTER TABLE "verification_documents" ADD COLUMN "malware_scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verification_documents" ADD COLUMN "malware_scan_result" text;--> statement-breakpoint
ALTER TABLE "verification_documents" ADD COLUMN "quarantined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verification_documents" ALTER COLUMN "malware_scan_status" SET DEFAULT 'PENDING';--> statement-breakpoint
CREATE INDEX "verification_documents_malware_status_idx" ON "verification_documents" ("malware_scan_status");--> statement-breakpoint
ALTER TABLE "verification_documents" ADD CONSTRAINT "verification_documents_size_max" CHECK ("file_size_bytes" <= 10485760);--> statement-breakpoint
ALTER TABLE "verification_documents" ADD CONSTRAINT "verification_documents_malware_status_valid" CHECK ("malware_scan_status" IN ('PENDING', 'SCANNING', 'CLEAN', 'INFECTED', 'ERROR'));--> statement-breakpoint
ALTER TABLE "verification_documents" ADD CONSTRAINT "verification_documents_category_valid" CHECK ("document_category" IN ('PROVIDER', 'CENTER', 'CAREGIVER'));
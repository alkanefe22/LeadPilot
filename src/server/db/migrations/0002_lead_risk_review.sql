ALTER TABLE "leads" ADD COLUMN "risk_matches" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "risk_reviewed_at" timestamp with time zone;
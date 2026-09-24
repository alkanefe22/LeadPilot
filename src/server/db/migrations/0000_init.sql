CREATE TYPE "public"."approval_action" AS ENUM('book_meeting', 'send_email', 'ask_followup_question');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'executed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('confirmed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('sent', 'queued', 'failed');--> statement-breakpoint
CREATE TYPE "public"."lead_source" AS ENUM('form', 'email', 'webhook', 'simulated', 'seed');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('new', 'needs_info', 'qualified', 'booked', 'disqualified');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'completed', 'failed', 'max_steps', 'awaiting_approval');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('inbound', 'reply', 'rerun', 'approval', 'simulate', 'eval');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('ok', 'error', 'pending_approval');--> statement-breakpoint
CREATE TYPE "public"."step_type" AS ENUM('llm', 'tool');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"trigger" "run_trigger" NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"summary" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"idx" integer NOT NULL,
	"type" "step_type" NOT NULL,
	"tool_name" text,
	"tool_use_id" text,
	"input" jsonb,
	"output" jsonb,
	"text" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"status" "step_status" DEFAULT 'ok' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"lead_id" text NOT NULL,
	"run_id" text,
	"action" "approval_action" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"lead_id" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"title" text NOT NULL,
	"provider" text NOT NULL,
	"external_event_id" text,
	"meeting_url" text,
	"status" "booking_status" DEFAULT 'confirmed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"lead_id" text,
	"email" text NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"lead_id" text,
	"to" text NOT NULL,
	"from" text NOT NULL,
	"reply_to" text,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"kind" text DEFAULT 'email' NOT NULL,
	"provider" text NOT NULL,
	"provider_message_id" text,
	"message_id_header" text NOT NULL,
	"in_reply_to" text,
	"status" "email_status" DEFAULT 'sent' NOT NULL,
	"error" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "emails_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source" "lead_source" NOT NULL,
	"external_id" text,
	"name" text,
	"email" text,
	"company" text,
	"phone" text,
	"website" text,
	"message" text DEFAULT '' NOT NULL,
	"raw_payload" jsonb,
	"language" text,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"score" integer,
	"qualification" jsonb,
	"thread_token" text NOT NULL,
	"first_response_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_thread_token_unique" UNIQUE("thread_token")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"direction" "message_direction" NOT NULL,
	"channel" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"message_id_header" text,
	"in_reply_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limits_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"icp_text" text DEFAULT '' NOT NULL,
	"qualification_rules" text DEFAULT '' NOT NULL,
	"score_threshold" integer DEFAULT 70 NOT NULL,
	"require_approval" boolean DEFAULT false NOT NULL,
	"webhook_secret" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"meeting_duration_min" integer DEFAULT 30 NOT NULL,
	"booking_lead_time_hours" integer DEFAULT 24 NOT NULL,
	"sender_name" text DEFAULT 'LeadPilot' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_lead_idx" ON "agent_runs" USING btree ("lead_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_running_per_lead_uq" ON "agent_runs" USING btree ("lead_id") WHERE status = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "steps_run_idx_uq" ON "agent_steps" USING btree ("run_id","idx");--> statement-breakpoint
CREATE INDEX "approvals_ws_status_idx" ON "approvals" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_one_confirmed_per_lead_uq" ON "bookings" USING btree ("lead_id") WHERE status = 'confirmed';--> statement-breakpoint
CREATE INDEX "bookings_ws_start_idx" ON "bookings" USING btree ("workspace_id","start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_ws_email_uq" ON "crm_contacts" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE INDEX "emails_ws_created_idx" ON "emails" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_external_uq" ON "leads" USING btree ("workspace_id","source","external_id");--> statement-breakpoint
CREATE INDEX "leads_ws_created_idx" ON "leads" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "leads_email_idx" ON "leads" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE INDEX "messages_lead_idx" ON "messages" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_mid_uq" ON "messages" USING btree ("message_id_header");
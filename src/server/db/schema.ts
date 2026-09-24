import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { newId } from "../../lib/ids";

const id = (prefix: string) =>
  text("id")
    .primaryKey()
    .$defaultFn(() => newId(prefix));

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// Money is stored as numeric and read back as a JS number.
const usd = (name: string) =>
  numeric(name, { precision: 12, scale: 6, mode: "number" }).notNull().default(0);

/* ---------------------------------------------------------------- enums */

export const leadSource = pgEnum("lead_source", ["form", "email", "webhook", "simulated", "seed"]);
export const leadStatus = pgEnum("lead_status", [
  "new",
  "needs_info",
  "qualified",
  "booked",
  "disqualified",
]);
export const messageDirection = pgEnum("message_direction", ["inbound", "outbound"]);
export const runTrigger = pgEnum("run_trigger", [
  "inbound",
  "reply",
  "rerun",
  "approval",
  "simulate",
  "eval",
]);
export const runStatus = pgEnum("run_status", [
  "running",
  "completed",
  "failed",
  "max_steps",
  "awaiting_approval",
]);
export const stepType = pgEnum("step_type", ["llm", "tool"]);
export const stepStatus = pgEnum("step_status", ["ok", "error", "pending_approval"]);
export const approvalAction = pgEnum("approval_action", [
  "book_meeting",
  "send_email",
  "ask_followup_question",
]);
export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
  "executed",
  "failed",
]);
export const bookingStatus = pgEnum("booking_status", ["confirmed", "cancelled"]);
export const emailStatus = pgEnum("email_status", ["sent", "queued", "failed"]);

/* --------------------------------------------------------------- tables */

export const workspaces = pgTable("workspaces", {
  id: id("ws"),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  icpText: text("icp_text").notNull().default(""),
  qualificationRules: text("qualification_rules").notNull().default(""),
  scoreThreshold: integer("score_threshold").notNull().default(70),
  requireApproval: boolean("require_approval").notNull().default(false),
  webhookSecret: text("webhook_secret").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  meetingDurationMin: integer("meeting_duration_min").notNull().default(30),
  bookingLeadTimeHours: integer("booking_lead_time_hours").notNull().default(24),
  senderName: text("sender_name").notNull().default("LeadPilot"),
  createdAt: createdAt(),
});

export type LeadCategory = "fit" | "needs_info" | "poor_fit" | "spam";

export type Qualification = {
  score: number;
  category: LeadCategory;
  reasoning: string;
  budget: string | null;
  timeline: string | null;
  need: string | null;
  authority: string | null;
  missing: string[];
  language?: string | null;
  flaggedForReview?: boolean;
  disqualification?: { reason: string; category: string } | null;
};

export const leads = pgTable(
  "leads",
  {
    id: id("lead"),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    source: leadSource("source").notNull(),
    externalId: text("external_id"),
    name: text("name"),
    email: text("email"),
    company: text("company"),
    phone: text("phone"),
    website: text("website"),
    message: text("message").notNull().default(""),
    rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>(),
    language: text("language"),
    status: leadStatus("status").notNull().default("new"),
    score: integer("score"),
    qualification: jsonb("qualification").$type<Qualification>(),
    // Heuristic flags from the inbound scanner (e.g. "prompt_injection"). Flagged leads
    // can never trigger outward actions without a human approval.
    riskFlags: jsonb("risk_flags").$type<string[]>().notNull().default([]),
    threadToken: text("thread_token")
      .notNull()
      .unique()
      .$defaultFn(() => newId("t")),
    firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Inbound dedupe: the same upstream id from the same source is one lead.
    uniqueIndex("leads_external_uq").on(t.workspaceId, t.source, t.externalId),
    index("leads_ws_created_idx").on(t.workspaceId, t.createdAt),
    index("leads_email_idx").on(t.workspaceId, t.email),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: id("msg"),
    leadId: text("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    direction: messageDirection("direction").notNull(),
    channel: text("channel").notNull(), // form | email | webhook | simulated
    subject: text("subject"),
    body: text("body").notNull(),
    messageIdHeader: text("message_id_header"),
    inReplyTo: text("in_reply_to"),
    createdAt: createdAt(),
  },
  (t) => [
    index("messages_lead_idx").on(t.leadId, t.createdAt),
    uniqueIndex("messages_mid_uq").on(t.messageIdHeader),
  ],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: id("run"),
    leadId: text("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    trigger: runTrigger("trigger").notNull(),
    status: runStatus("status").notNull().default("running"),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: usd("cost_usd"),
    latencyMs: integer("latency_ms").notNull().default(0),
    summary: text("summary"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("runs_lead_idx").on(t.leadId, t.startedAt),
    // At most one in-flight run per lead: concurrent triggers can't race.
    uniqueIndex("runs_one_running_per_lead_uq")
      .on(t.leadId)
      .where(sql`status = 'running'`),
  ],
);

export const agentSteps = pgTable(
  "agent_steps",
  {
    id: id("step"),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    type: stepType("type").notNull(),
    toolName: text("tool_name"),
    toolUseId: text("tool_use_id"),
    input: jsonb("input"),
    output: jsonb("output"),
    text: text("text"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: usd("cost_usd"),
    latencyMs: integer("latency_ms").notNull().default(0),
    status: stepStatus("status").notNull().default("ok"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("steps_run_idx_uq").on(t.runId, t.idx)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: id("apr"),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    leadId: text("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    action: approvalAction("action").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: approvalStatus("status").notNull().default("pending"),
    result: jsonb("result"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("approvals_ws_status_idx").on(t.workspaceId, t.status)],
);

export const bookings = pgTable(
  "bookings",
  {
    id: id("bk"),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    leadId: text("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    title: text("title").notNull(),
    provider: text("provider").notNull(),
    externalEventId: text("external_event_id"),
    meetingUrl: text("meeting_url"),
    status: bookingStatus("status").notNull().default("confirmed"),
    createdAt: createdAt(),
  },
  (t) => [
    // Idempotency at the DB level: a lead can hold only one confirmed booking.
    uniqueIndex("bookings_one_confirmed_per_lead_uq")
      .on(t.leadId)
      .where(sql`status = 'confirmed'`),
    index("bookings_ws_start_idx").on(t.workspaceId, t.startAt),
  ],
);

export const emails = pgTable(
  "emails",
  {
    id: id("em"),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    leadId: text("lead_id").references(() => leads.id, { onDelete: "cascade" }),
    to: text("to").notNull(),
    from: text("from").notNull(),
    replyTo: text("reply_to"),
    subject: text("subject").notNull(),
    bodyText: text("body_text").notNull(),
    kind: text("kind").notNull().default("email"), // email | followup
    provider: text("provider").notNull(),
    providerMessageId: text("provider_message_id"),
    messageIdHeader: text("message_id_header").notNull(),
    inReplyTo: text("in_reply_to"),
    status: emailStatus("status").notNull().default("sent"),
    error: text("error"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [index("emails_ws_created_idx").on(t.workspaceId, t.createdAt)],
);

export const crmContacts = pgTable(
  "crm_contacts",
  {
    id: id("crm"),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    leadId: text("lead_id").references(() => leads.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    fields: jsonb("fields").$type<Record<string, unknown>>().notNull().default({}),
    notes: jsonb("notes").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("crm_ws_email_uq").on(t.workspaceId, t.email)],
);

export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);

/* ---------------------------------------------------------------- types */

export type Workspace = typeof workspaces.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type AgentStep = typeof agentSteps.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type Email = typeof emails.$inferSelect;
export type CrmContact = typeof crmContacts.$inferSelect;
export type LeadStatus = (typeof leadStatus.enumValues)[number];
export type LeadSource = (typeof leadSource.enumValues)[number];
export type RunTrigger = (typeof runTrigger.enumValues)[number];

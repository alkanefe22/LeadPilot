CREATE TABLE "adapter_health" (
	"provider" text PRIMARY KEY NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"failing" boolean DEFAULT false NOT NULL
);

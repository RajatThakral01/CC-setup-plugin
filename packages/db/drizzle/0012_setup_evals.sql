CREATE TABLE "setup_evals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

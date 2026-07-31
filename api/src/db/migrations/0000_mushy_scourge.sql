CREATE TABLE "accuracy_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid,
	"field_key" text NOT NULL,
	"model" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"total_count" integer NOT NULL,
	"auto_accepted_count" integer NOT NULL,
	"corrected_after_auto" integer NOT NULL,
	"pending_count" integer NOT NULL,
	"corrected_in_review" integer NOT NULL,
	"auto_accept_precision" numeric,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"schema_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"field_value_id" uuid,
	"field_value_row_id" uuid,
	"column_key" text,
	"old_value" text,
	"new_value" text NOT NULL,
	"reason" text,
	"corrected_by" text NOT NULL,
	"corrected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seconds_spent" integer,
	CONSTRAINT "corrections_field_value_or_row_check" CHECK ("corrections"."field_value_id" is not null or "corrections"."field_value_row_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"storage_path" text NOT NULL,
	"sha256" text NOT NULL,
	"page_count" integer,
	"has_text_layer" boolean,
	"ocr_required" boolean DEFAULT false NOT NULL,
	"in_dev_subset" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"failure_reason" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_after" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"target" text NOT NULL,
	"status" text NOT NULL,
	"row_count" integer,
	"external_ref" text,
	"idempotency_key" text NOT NULL,
	"file_path" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "exports_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "extraction_schemas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"doc_type" text NOT NULL,
	"fields" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extraction_schemas_name_version_key" UNIQUE("name","version")
);
--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"schema_id" uuid NOT NULL,
	"model" text NOT NULL,
	"temperature" numeric NOT NULL,
	"output_mode" text NOT NULL,
	"prompt_version" text NOT NULL,
	"sample_count" integer NOT NULL,
	"raw_responses" jsonb NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_value_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"field_value_id" uuid NOT NULL,
	"row_index" integer NOT NULL,
	"cells" jsonb NOT NULL,
	"confidence" numeric NOT NULL,
	"confidence_parts" jsonb NOT NULL,
	"page_number" integer,
	"bbox" jsonb,
	"status" text NOT NULL,
	"final_cells" jsonb
);
--> statement-breakpoint
CREATE TABLE "field_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"extraction_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"field_type" text NOT NULL,
	"raw_value" text,
	"normalized_value" text,
	"confidence" numeric NOT NULL,
	"confidence_parts" jsonb NOT NULL,
	"page_number" integer,
	"bbox" jsonb,
	"span_verified" boolean DEFAULT false NOT NULL,
	"validator_status" text NOT NULL,
	"validator_message" text,
	"status" text NOT NULL,
	"final_value" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "gold_set_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"row_index" integer,
	"column_key" text,
	"expected_value" text,
	"notes" text,
	CONSTRAINT "gold_set_items_doc_field_row_col_key" UNIQUE NULLS NOT DISTINCT("document_id","field_key","row_index","column_key")
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"image_path" text NOT NULL,
	"text_content" text,
	"ocr_confidence" numeric
);
--> statement-breakpoint
CREATE TABLE "review_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reviewer" text NOT NULL,
	"batch_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"items_reviewed" integer DEFAULT 0 NOT NULL,
	"items_corrected" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accuracy_snapshots" ADD CONSTRAINT "accuracy_snapshots_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_schema_id_extraction_schemas_id_fk" FOREIGN KEY ("schema_id") REFERENCES "public"."extraction_schemas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_field_value_id_field_values_id_fk" FOREIGN KEY ("field_value_id") REFERENCES "public"."field_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_field_value_row_id_field_value_rows_id_fk" FOREIGN KEY ("field_value_row_id") REFERENCES "public"."field_value_rows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_schema_id_extraction_schemas_id_fk" FOREIGN KEY ("schema_id") REFERENCES "public"."extraction_schemas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_value_rows" ADD CONSTRAINT "field_value_rows_field_value_id_field_values_id_fk" FOREIGN KEY ("field_value_id") REFERENCES "public"."field_values"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_values" ADD CONSTRAINT "field_values_extraction_id_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."extractions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_values" ADD CONSTRAINT "field_values_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gold_set_items" ADD CONSTRAINT "gold_set_items_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_sessions" ADD CONSTRAINT "review_sessions_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_batch_id_sha256_key" ON "documents" USING btree ("batch_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "field_value_rows_field_value_id_row_index_key" ON "field_value_rows" USING btree ("field_value_id","row_index");--> statement-breakpoint
CREATE UNIQUE INDEX "field_values_extraction_id_field_key_key" ON "field_values" USING btree ("extraction_id","field_key");--> statement-breakpoint
CREATE INDEX "field_values_status_confidence_idx" ON "field_values" USING btree ("status","confidence");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_document_id_page_number_key" ON "pages" USING btree ("document_id","page_number");
CREATE INDEX "documents_archived_at_idx" ON "documents" USING btree ("archived_at");--> statement-breakpoint
CREATE INDEX "extractions_document_id_idx" ON "extractions" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "field_value_rows_status_idx" ON "field_value_rows" USING btree ("status");
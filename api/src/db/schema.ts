import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  numeric,
  jsonb,
  unique,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core';

export const extractionSchemas = pgTable(
  'extraction_schemas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    version: integer('version').notNull(),
    docType: text('doc_type').notNull(),
    fields: jsonb('fields').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('extraction_schemas_name_version_key').on(table.name, table.version)],
);

export const batches = pgTable('batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  schemaId: uuid('schema_id')
    .notNull()
    .references(() => extractionSchemas.id),
  status: text('status').notNull().default('open'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: text('created_by'),
});

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => batches.id),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    storagePath: text('storage_path').notNull(),
    sha256: text('sha256').notNull(),
    pageCount: integer('page_count'),
    hasTextLayer: boolean('has_text_layer'),
    ocrRequired: boolean('ocr_required').notNull().default(false),
    inDevSubset: boolean('in_dev_subset').notNull().default(false),
    status: text('status').notNull().default('uploaded'),
    failureReason: text('failure_reason'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    purgeAfter: timestamp('purge_after', { withTimezone: true }),
    // Soft-delete: an archived document is excluded from the review queue, stats,
    // exports, and the eval harness, but its rows and Storage files are kept —
    // this project treats audit history as something that only ever grows (see
    // corrections), and a document a reviewer corrected is exactly the kind of
    // record that principle applies to.
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archivedBy: text('archived_by'),
  },
  (table) => [
    uniqueIndex('documents_batch_id_sha256_key').on(table.batchId, table.sha256),
    // review/queue.ts's getNextReviewItem and getReviewQueueStats both build an
    // archived-document exclusion set with `isNotNull(documents.archivedAt)` on
    // every GET /review/next and GET /review/stats call (i.e. after every
    // accept/correct/undo in the reviewer UI) — an unindexed scan on the hottest
    // read path this table has.
    index('documents_archived_at_idx').on(table.archivedAt),
  ],
);

export const pages = pgTable(
  'pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    pageNumber: integer('page_number').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    imagePath: text('image_path').notNull(),
    textContent: text('text_content'),
    ocrConfidence: numeric('ocr_confidence'),
  },
  (table) => [uniqueIndex('pages_document_id_page_number_key').on(table.documentId, table.pageNumber)],
);

export const extractions = pgTable(
  'extractions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id),
    schemaId: uuid('schema_id')
      .notNull()
      .references(() => extractionSchemas.id),
    model: text('model').notNull(),
    temperature: numeric('temperature').notNull(),
    outputMode: text('output_mode').notNull(),
    promptVersion: text('prompt_version').notNull(),
    sampleCount: integer('sample_count').notNull(),
    rawResponses: jsonb('raw_responses').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: text('status').notNull(),
  },
  (table) => [
    // Every "what's the current extraction for this document" lookup filters on
    // document_id alone (review/queue.ts's getLatestExtraction — called once per
    // review-queue candidate on every GET /review/next — plus export/build.ts and
    // eval/run.ts, once per document on every export/eval run). Unindexed, each of
    // those is a full-table scan.
    index('extractions_document_id_idx').on(table.documentId),
  ],
);

export const fieldValues = pgTable(
  'field_values',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    extractionId: uuid('extraction_id')
      .notNull()
      .references(() => extractions.id),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id),
    fieldKey: text('field_key').notNull(),
    fieldType: text('field_type').notNull(),
    rawValue: text('raw_value'),
    normalizedValue: text('normalized_value'),
    confidence: numeric('confidence').notNull(),
    confidenceParts: jsonb('confidence_parts').notNull(),
    pageNumber: integer('page_number'),
    bbox: jsonb('bbox'),
    spanVerified: boolean('span_verified').notNull().default(false),
    validatorStatus: text('validator_status').notNull(),
    validatorMessage: text('validator_message'),
    status: text('status').notNull(),
    finalValue: text('final_value'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('field_values_extraction_id_field_key_key').on(table.extractionId, table.fieldKey),
    index('field_values_status_confidence_idx').on(table.status, table.confidence),
  ],
);

export const fieldValueRows = pgTable(
  'field_value_rows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fieldValueId: uuid('field_value_id')
      .notNull()
      .references(() => fieldValues.id, { onDelete: 'cascade' }),
    rowIndex: integer('row_index').notNull(),
    cells: jsonb('cells').notNull(),
    confidence: numeric('confidence').notNull(),
    confidenceParts: jsonb('confidence_parts').notNull(),
    pageNumber: integer('page_number'),
    bbox: jsonb('bbox'),
    status: text('status').notNull(),
    finalCells: jsonb('final_cells'),
  },
  (table) => [
    uniqueIndex('field_value_rows_field_value_id_row_index_key').on(table.fieldValueId, table.rowIndex),
    // review/queue.ts filters on this column with `eq(fieldValueRows.status, 'needs_review')`
    // in both getNextReviewItem and getReviewQueueStats — the two endpoints hit on
    // every reviewer action. field_values.status (same role, one level up) already
    // has a supporting index (field_values_status_confidence_idx below); this column
    // didn't, despite being on the identical hot path.
    index('field_value_rows_status_idx').on(table.status),
  ],
);

export const corrections = pgTable(
  'corrections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fieldValueId: uuid('field_value_id').references(() => fieldValues.id),
    fieldValueRowId: uuid('field_value_row_id').references(() => fieldValueRows.id),
    columnKey: text('column_key'),
    oldValue: text('old_value'),
    newValue: text('new_value').notNull(),
    reason: text('reason'),
    correctedBy: text('corrected_by').notNull(),
    correctedAt: timestamp('corrected_at', { withTimezone: true }).notNull().defaultNow(),
    secondsSpent: integer('seconds_spent'),
  },
  (table) => [
    check(
      'corrections_field_value_or_row_check',
      sql`${table.fieldValueId} is not null or ${table.fieldValueRowId} is not null`,
    ),
  ],
);

export const reviewSessions = pgTable('review_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  reviewer: text('reviewer').notNull(),
  batchId: uuid('batch_id').references(() => batches.id),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  itemsReviewed: integer('items_reviewed').notNull().default(0),
  itemsCorrected: integer('items_corrected').notNull().default(0),
});

export const exportsTable = pgTable('exports', {
  id: uuid('id').primaryKey().defaultRandom(),
  batchId: uuid('batch_id')
    .notNull()
    .references(() => batches.id),
  target: text('target').notNull(),
  status: text('status').notNull(),
  rowCount: integer('row_count'),
  externalRef: text('external_ref'),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  filePath: text('file_path'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const goldSetItems = pgTable(
  'gold_set_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id),
    fieldKey: text('field_key').notNull(),
    rowIndex: integer('row_index'),
    columnKey: text('column_key'),
    expectedValue: text('expected_value'),
    notes: text('notes'),
  },
  (table) => [
    unique('gold_set_items_doc_field_row_col_key')
      .on(table.documentId, table.fieldKey, table.rowIndex, table.columnKey)
      .nullsNotDistinct(),
  ],
);

export const accuracySnapshots = pgTable('accuracy_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  batchId: uuid('batch_id').references(() => batches.id),
  fieldKey: text('field_key').notNull(),
  model: text('model').notNull(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
  totalCount: integer('total_count').notNull(),
  autoAcceptedCount: integer('auto_accepted_count').notNull(),
  correctedAfterAuto: integer('corrected_after_auto').notNull(),
  pendingCount: integer('pending_count').notNull(),
  correctedInReview: integer('corrected_in_review').notNull(),
  autoAcceptPrecision: numeric('auto_accept_precision'),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
});

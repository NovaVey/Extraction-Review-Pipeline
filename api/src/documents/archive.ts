import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents } from '../db/schema.js';

export class DocumentNotFoundError extends Error {}

export interface ArchiveResult {
  id: string;
  status: 'archived' | 'active';
}

// Soft-delete only — rows, corrections, and Storage objects are untouched.
// Idempotent in both directions: archiving an already-archived document (or
// unarchiving an already-active one) just re-asserts the target state rather
// than erroring, since there's no meaningful "invalid transition" here.
export async function archiveDocument(documentId: string, archivedBy: string): Promise<ArchiveResult> {
  const [doc] = await db.select({ id: documents.id }).from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!doc) throw new DocumentNotFoundError(`Document not found: ${documentId}`);
  await db.update(documents).set({ archivedAt: new Date(), archivedBy }).where(eq(documents.id, documentId));
  return { id: documentId, status: 'archived' };
}

export async function unarchiveDocument(documentId: string): Promise<ArchiveResult> {
  const [doc] = await db.select({ id: documents.id }).from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!doc) throw new DocumentNotFoundError(`Document not found: ${documentId}`);
  await db.update(documents).set({ archivedAt: null, archivedBy: null }).where(eq(documents.id, documentId));
  return { id: documentId, status: 'active' };
}

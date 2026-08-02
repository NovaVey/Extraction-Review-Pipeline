import { describe, it, expect, vi, beforeEach } from 'vitest';
import { documents } from '../../src/db/schema.js';

process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/test';
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ||= 'test-key';
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.EXTRACTION_MODEL ||= 'claude-sonnet-5';
process.env.EXTRACTION_TEMPERATURE ||= '0.8';

const mocks = vi.hoisted(() => ({
  documentsResult: [] as unknown[],
  updateCalls: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
}));

function chain(resolveValue: unknown) {
  const obj: Record<string, unknown> = {};
  obj.where = () => obj;
  obj.limit = () => Promise.resolve(resolveValue);
  obj.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(resolveValue).then(resolve, reject);
  return obj;
}

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: (table: unknown) => {
        if (table === documents) return chain(mocks.documentsResult);
        throw new Error('unexpected table in mock select().from()');
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        mocks.updateCalls.push({ table, values });
        return { where: () => Promise.resolve(undefined) };
      },
    })),
  },
}));

const { archiveDocument, unarchiveDocument, DocumentNotFoundError } = await import('../../src/documents/archive.js');

beforeEach(() => {
  mocks.documentsResult = [];
  mocks.updateCalls.length = 0;
});

describe('archiveDocument', () => {
  it('throws DocumentNotFoundError when the document does not exist', async () => {
    mocks.documentsResult = [];
    await expect(archiveDocument('missing', 'alice')).rejects.toThrow(DocumentNotFoundError);
  });

  it('sets archivedAt/archivedBy and returns status archived', async () => {
    mocks.documentsResult = [{ id: 'doc-1' }];

    const result = await archiveDocument('doc-1', 'alice');

    expect(result).toEqual({ id: 'doc-1', status: 'archived' });
    expect(mocks.updateCalls).toHaveLength(1);
    expect(mocks.updateCalls[0].table).toBe(documents);
    expect(mocks.updateCalls[0].values.archivedBy).toBe('alice');
    expect(mocks.updateCalls[0].values.archivedAt).toBeInstanceOf(Date);
  });
});

describe('unarchiveDocument', () => {
  it('throws DocumentNotFoundError when the document does not exist', async () => {
    mocks.documentsResult = [];
    await expect(unarchiveDocument('missing')).rejects.toThrow(DocumentNotFoundError);
  });

  it('clears archivedAt/archivedBy and returns status active', async () => {
    mocks.documentsResult = [{ id: 'doc-1' }];

    const result = await unarchiveDocument('doc-1');

    expect(result).toEqual({ id: 'doc-1', status: 'active' });
    expect(mocks.updateCalls[0].values).toEqual({ archivedAt: null, archivedBy: null });
  });
});

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST_PATH = path.resolve(__dirname, '../../../samples/manifest.json');

export interface GoldLineItem {
  description: string;
  quantity: number;
  unit_price: string;
  amount: string;
}

export interface GoldDocument {
  filename: string;
  docType: string;
  difficultyGroup: string;
  inDevSubset: boolean;
  notes: string | null;
  fields: Record<string, string>;
  lineItems: GoldLineItem[];
}

interface Manifest {
  documents: GoldDocument[];
}

// Keyed by filename, which is unique within the actual seeded corpus (not enforced
// at the DB level — documents.filename has no unique constraint, only
// (batch_id, sha256) does — but true in practice for this fixed, once-generated set).
export function loadGoldSet(manifestPath: string = DEFAULT_MANIFEST_PATH): Map<string, GoldDocument> {
  const raw = readFileSync(manifestPath, 'utf8');
  const manifest: Manifest = JSON.parse(raw);
  return new Map(manifest.documents.map((d) => [d.filename, d]));
}

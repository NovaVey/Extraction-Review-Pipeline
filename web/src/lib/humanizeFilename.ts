// Shared by ReviewPane and QueueSidebar's batch-documents list — both need to turn
// the synthetic corpus's raw filenames into something presentable in the product UI.
const DIFFICULTY_TOKENS = new Set(['clean', 'scanned', 'multipage', 'edge', 'case']);

// "invoice_clean_01.pdf" -> "Invoice" -- drops the synthetic-corpus difficulty tag
// and trailing index rather than showing raw fixture naming in the product UI; the
// real filename is still available via the title attribute where it's used.
export function humanizeFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '');
  const parts = base.split('_');
  const kept = parts.filter((p) => !/^\d+$/.test(p) && !DIFFICULTY_TOKENS.has(p.toLowerCase()));
  const words = kept.length > 0 ? kept : parts;
  return words.map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

import { describe, it, expect } from 'vitest';
import { humanizeFilename } from './humanizeFilename';

describe('humanizeFilename', () => {
  it('drops the synthetic-corpus difficulty tag and trailing index, title-casing what remains', () => {
    expect(humanizeFilename('invoice_clean_01.pdf')).toBe('Invoice');
    expect(humanizeFilename('purchase_order_edge_case_03.pdf')).toBe('Purchase Order');
    expect(humanizeFilename('receipt_multipage_02.pdf')).toBe('Receipt');
  });

  it('falls back to every underscore-separated part when nothing is left after filtering', () => {
    expect(humanizeFilename('clean_01.pdf')).toBe('Clean 01');
  });

  it('is not thrown off by a missing or unusual extension', () => {
    expect(humanizeFilename('invoice_clean_01')).toBe('Invoice');
    expect(humanizeFilename('invoice_clean_01.PDF')).toBe('Invoice');
  });
});

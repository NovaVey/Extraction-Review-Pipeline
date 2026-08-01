import { describe, it, expect } from 'vitest';
import { computeConfidence, decideStatus } from '../../src/confidence/score.js';

describe('computeConfidence', () => {
  it('returns 0 for invalid regardless of sample agreement', () => {
    expect(computeConfidence({ sampleAgreement: 1, validatorStatus: 'invalid', required: true, crossFieldChecks: [] })).toBe(0);
    expect(computeConfidence({ sampleAgreement: 1, validatorStatus: 'invalid', required: false, crossFieldChecks: [] })).toBe(0);
  });

  it('returns 0 for missing when the field is required', () => {
    expect(computeConfidence({ sampleAgreement: 1, validatorStatus: 'missing', required: true, crossFieldChecks: [] })).toBe(0);
  });

  it('returns sampleAgreement for missing when the field is not required', () => {
    expect(
      computeConfidence({ sampleAgreement: 0.67, validatorStatus: 'missing', required: false, crossFieldChecks: [] }),
    ).toBe(0.67);
  });

  it('returns sampleAgreement for valid with zero failed cross-field checks', () => {
    expect(
      computeConfidence({
        sampleAgreement: 0.8,
        validatorStatus: 'valid',
        required: true,
        crossFieldChecks: [{ name: 'x', passed: true }],
      }),
    ).toBe(0.8);
  });

  it('halves confidence for one failed cross-field check', () => {
    expect(
      computeConfidence({
        sampleAgreement: 0.8,
        validatorStatus: 'valid',
        required: true,
        crossFieldChecks: [{ name: 'x', passed: false }],
      }),
    ).toBeCloseTo(0.4);
  });

  it('quarters confidence for two failed cross-field checks', () => {
    expect(
      computeConfidence({
        sampleAgreement: 0.8,
        validatorStatus: 'valid',
        required: true,
        crossFieldChecks: [
          { name: 'x', passed: false },
          { name: 'y', passed: false },
        ],
      }),
    ).toBeCloseTo(0.2);
  });
});

describe('decideStatus', () => {
  it('auto-accepts at the threshold', () => {
    expect(decideStatus(0.9, 0.9)).toBe('auto_accepted');
  });

  it('auto-accepts above the threshold', () => {
    expect(decideStatus(0.95, 0.9)).toBe('auto_accepted');
  });

  it('needs review below the threshold', () => {
    expect(decideStatus(0.89, 0.9)).toBe('needs_review');
  });
});

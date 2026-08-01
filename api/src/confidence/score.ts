import type { ValidatorStatus } from './validate.js';

export interface CrossFieldCheck {
  name: string;
  passed: boolean;
}

export interface ConfidenceInput {
  sampleAgreement: number; // 0..1, fraction of extraction samples that agreed on the value
  validatorStatus: ValidatorStatus;
  required: boolean;
  crossFieldChecks: CrossFieldCheck[];
}

// Confidence starts from sample agreement, then is overridden or penalized by harder
// signals we've already resolved:
// - validatorStatus 'invalid' -> 0, always. Three samples confidently agreeing on a
//   malformed date is still a malformed date; agreement can't rescue a known-bad value.
// - validatorStatus 'missing' -> 0 if the field is required (an absent required field
//   is never acceptable), else sampleAgreement (unanimous agreement a field is
//   legitimately absent, e.g. an optional PO approver, IS meaningful signal).
// - validatorStatus 'valid' -> sampleAgreement, then halved per failing cross-field
//   check (0.5 ** failedCount). Cross-field mismatches are softer than a format
//   failure — the value could still be individually correct even if a related total
//   doesn't reconcile — so they attenuate rather than zero out.
export function computeConfidence(input: ConfidenceInput): number {
  if (input.validatorStatus === 'invalid') return 0;
  if (input.validatorStatus === 'missing') return input.required ? 0 : input.sampleAgreement;
  const failedChecks = input.crossFieldChecks.filter((c) => !c.passed).length;
  return input.sampleAgreement * 0.5 ** failedChecks;
}

export type FieldStatus = 'auto_accepted' | 'needs_review';

export function decideStatus(confidence: number, autoAcceptThreshold: number): FieldStatus {
  return confidence >= autoAcceptThreshold ? 'auto_accepted' : 'needs_review';
}

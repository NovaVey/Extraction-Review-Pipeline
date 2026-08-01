import type { ReactNode } from 'react';

// Small color-coded pills shared by ReviewPane (field-level) and RowTable
// (per-row). Thresholds/colors here are a display nicety, not a business rule.

function badgeClasses(tone: 'green' | 'amber' | 'red' | 'gray'): string {
  switch (tone) {
    case 'green':
      return 'border-green-200 bg-green-50 text-green-700';
    case 'amber':
      return 'border-amber-200 bg-amber-50 text-amber-700';
    case 'red':
      return 'border-red-200 bg-red-50 text-red-700';
    default:
      return 'border-[#E5E7EB] bg-[#F3F4F6] text-[#6B7280]';
  }
}

function Pill({ tone, children }: { tone: 'green' | 'amber' | 'red' | 'gray'; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${badgeClasses(tone)}`}>
      {children}
    </span>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: string }) {
  const value = Number.parseFloat(confidence);
  const pct = Number.isFinite(value) ? Math.round(value * 100) : null;
  const tone = value >= 0.9 ? 'green' : value >= 0.5 ? 'amber' : 'red';
  return <Pill tone={tone}>{pct === null ? 'confidence n/a' : `${pct}% confidence`}</Pill>;
}

export function ValidatorStatusBadge({ status }: { status: string }) {
  const tone = status === 'valid' ? 'green' : status === 'missing' ? 'amber' : status === 'invalid' ? 'red' : 'gray';
  return <Pill tone={tone}>{status}</Pill>;
}

export function ResolutionStatusBadge({ status }: { status: string }) {
  const tone = status === 'needs_review' ? 'amber' : status === 'auto_accepted' || status === 'confirmed' || status === 'corrected' ? 'green' : 'gray';
  return <Pill tone={tone}>{status.replaceAll('_', ' ')}</Pill>;
}

export function CrossFieldChecksList({ checks }: { checks: { name: string; passed: boolean }[] }) {
  if (checks.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {checks.map((check) => (
        <li key={check.name} className="flex items-center gap-2">
          <span className={check.passed ? 'text-green-600' : 'text-red-600'}>{check.passed ? '✓' : '✗'}</span>
          <span className="text-[#101114]">{check.name.replaceAll('_', ' ')}</span>
        </li>
      ))}
    </ul>
  );
}

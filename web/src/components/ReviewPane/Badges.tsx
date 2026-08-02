import type { ReactNode } from 'react';
import { Bot, Check, Clock, Gauge, Pencil, Shield, ShieldAlert, ShieldQuestion, UserCheck, X } from 'lucide-react';

// Small color-coded pills shared by ReviewPane (field-level) and RowTable
// (per-row). Thresholds/colors here are a display nicety, not a business rule.
// Each badge category also carries its own icon so the three kinds of signal
// (a score, a rule-based validation result, a workflow/resolution state) are
// visually distinguishable at a glance, not just by reading the label text.

type Tone = 'green' | 'amber' | 'red' | 'gray' | 'teal' | 'blue';

function badgeClasses(tone: Tone): string {
  switch (tone) {
    case 'green':
      return 'border-green-200 bg-green-50 text-green-700';
    case 'amber':
      return 'border-amber-200 bg-amber-50 text-amber-700';
    case 'red':
      return 'border-red-200 bg-red-50 text-red-700';
    case 'teal':
      return 'border-teal-200 bg-teal-50 text-teal-700';
    case 'blue':
      return 'border-blue-200 bg-blue-50 text-blue-700';
    default:
      return 'border-[#E5E7EB] bg-[#F3F4F6] text-[#4B5563]';
  }
}

function Pill({ tone, icon, children }: { tone: Tone; icon?: ReactNode; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${badgeClasses(tone)}`}>
      {icon}
      {children}
    </span>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: string }) {
  const value = Number.parseFloat(confidence);
  const pct = Number.isFinite(value) ? Math.round(value * 100) : null;
  const tone = value >= 0.9 ? 'green' : value >= 0.5 ? 'amber' : 'red';
  return (
    <Pill tone={tone} icon={<Gauge size={12} />}>
      {pct === null ? 'confidence n/a' : `${pct}% confidence`}
    </Pill>
  );
}

export function ValidatorStatusBadge({ status }: { status: string }) {
  const tone = status === 'valid' ? 'green' : status === 'missing' ? 'amber' : status === 'invalid' ? 'red' : 'gray';
  const Icon = status === 'valid' ? Shield : status === 'invalid' ? ShieldAlert : ShieldQuestion;
  return (
    <Pill tone={tone} icon={<Icon size={12} />}>
      {status}
    </Pill>
  );
}

// auto_accepted / confirmed / corrected are three meaningfully different
// resolution paths — machine-only, human-confirmed-as-is, human-corrected —
// deliberately given distinct tones/icons rather than collapsing to one
// "done" color, so a reviewer (or QueueSidebar) can see machine-vs-human
// resolution at a glance.
export function ResolutionStatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'needs_review':
      return (
        <Pill tone="amber" icon={<Clock size={12} />}>
          needs review
        </Pill>
      );
    case 'auto_accepted':
      return (
        <Pill tone="teal" icon={<Bot size={12} />}>
          auto accepted
        </Pill>
      );
    case 'confirmed':
      return (
        <Pill tone="green" icon={<UserCheck size={12} />}>
          confirmed
        </Pill>
      );
    case 'corrected':
      return (
        <Pill tone="blue" icon={<Pencil size={12} />}>
          corrected
        </Pill>
      );
    default:
      return <Pill tone="gray">{status.replaceAll('_', ' ')}</Pill>;
  }
}

export function CrossFieldChecksList({ checks }: { checks: { name: string; passed: boolean }[] }) {
  if (checks.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {checks.map((check) => (
        <li key={check.name} className="flex items-center gap-2">
          {check.passed ? <Check size={14} className="text-green-600" /> : <X size={14} className="text-red-600" />}
          <span className="text-[#101114]">{check.name.replaceAll('_', ' ')}</span>
        </li>
      ))}
    </ul>
  );
}

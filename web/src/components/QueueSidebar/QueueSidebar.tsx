import type { ReviewQueueStats } from '../../types';

interface QueueSidebarProps {
  stats: ReviewQueueStats | null;
}

export function QueueSidebar({ stats }: QueueSidebarProps) {
  const resolved = stats ? stats.totalItems - stats.needsReview : 0;
  const pct = stats && stats.totalItems > 0 ? Math.round((resolved / stats.totalItems) * 100) : null;

  return (
    <aside className="flex w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r border-[#E5E7EB] bg-white p-4">
      <div>
        <h2 className="text-xs font-medium uppercase tracking-wide text-[#4B5563]">Queue Progress</h2>
        {stats === null ? (
          <p className="mt-2 text-sm text-[#4B5563]">Loading…</p>
        ) : (
          <>
            <p className="mt-2 text-3xl font-semibold tracking-tight text-[#101114]">{pct === null ? '—' : `${pct}%`}</p>
            <p className="text-xs text-[#4B5563]">
              {resolved} of {stats.totalItems} resolved
            </p>
            <div
              role="progressbar"
              aria-label="Queue resolved"
              aria-valuenow={pct ?? 0}
              aria-valuemin={0}
              aria-valuemax={100}
              className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#F3F4F6] ring-1 ring-inset ring-[#E5E7EB]"
            >
              <div className="h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${pct ?? 0}%` }} />
            </div>
          </>
        )}
      </div>

      {stats !== null && (
        <dl className="flex flex-col gap-2 text-sm">
          <StatRow tone="amber" label="Needs review" value={stats.needsReview} />
          <StatRow tone="teal" label="Auto-accepted" value={stats.autoAccepted} />
          <StatRow tone="green" label="Confirmed" value={stats.confirmed} />
          <StatRow tone="blue" label="Corrected" value={stats.corrected} />
        </dl>
      )}
    </aside>
  );
}

const DOT_CLASSES: Record<'amber' | 'teal' | 'green' | 'blue', string> = {
  amber: 'bg-amber-500',
  teal: 'bg-teal-500',
  green: 'bg-green-500',
  blue: 'bg-blue-500',
};

function StatRow({ tone, label, value }: { tone: 'amber' | 'teal' | 'green' | 'blue'; label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="flex items-center gap-2 text-[#4B5563]">
        <span className={`h-1.5 w-1.5 rounded-full ${DOT_CLASSES[tone]}`} />
        {label}
      </dt>
      <dd className="font-medium text-[#101114]">{value}</dd>
    </div>
  );
}

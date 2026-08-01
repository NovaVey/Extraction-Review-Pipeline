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
        <h2 className="text-xs font-medium uppercase tracking-wide text-[#6B7280]">Queue Progress</h2>
        {stats === null ? (
          <p className="mt-2 text-sm text-[#6B7280]">Loading…</p>
        ) : (
          <>
            <p className="mt-2 text-2xl font-semibold text-[#101114]">{pct === null ? '—' : `${pct}%`}</p>
            <p className="text-xs text-[#6B7280]">
              {resolved} of {stats.totalItems} resolved
            </p>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#F3F4F6]">
              <div className="h-full rounded-full bg-green-500" style={{ width: `${pct ?? 0}%` }} />
            </div>
          </>
        )}
      </div>

      {stats !== null && (
        <dl className="flex flex-col gap-2 text-sm">
          <StatRow tone="amber" label="Needs review" value={stats.needsReview} />
          <StatRow tone="green" label="Auto-accepted" value={stats.autoAccepted} />
          <StatRow tone="green" label="Confirmed" value={stats.confirmed} />
          <StatRow tone="green" label="Corrected" value={stats.corrected} />
        </dl>
      )}
    </aside>
  );
}

function StatRow({ tone, label, value }: { tone: 'amber' | 'green'; label: string; value: number }) {
  const dotClass = tone === 'amber' ? 'bg-amber-500' : 'bg-green-500';
  return (
    <div className="flex items-center justify-between">
      <dt className="flex items-center gap-2 text-[#6B7280]">
        <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
        {label}
      </dt>
      <dd className="font-medium text-[#101114]">{value}</dd>
    </div>
  );
}

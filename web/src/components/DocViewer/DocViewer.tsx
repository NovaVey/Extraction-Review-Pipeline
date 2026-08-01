import { useState } from 'react';
import type { ReviewItemPage } from '../../types';

interface DocViewerProps {
  pages: ReviewItemPage[];
}

// field_values.bbox/pageNumber are never populated by this pipeline (a
// documented Phase 3/4 gap) — no highlight overlay is drawn here on purpose,
// since a fabricated one would be actively misleading.
export function DocViewer({ pages }: DocViewerProps) {
  const [currentPageNumber, setCurrentPageNumber] = useState(1);

  if (pages.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-[#6B7280]">No page images for this document.</div>;
  }

  const page = pages.find((p) => p.pageNumber === currentPageNumber) ?? pages[0];

  return (
    <div className="flex h-full flex-col gap-2">
      {pages.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {pages.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setCurrentPageNumber(p.pageNumber)}
              className={`rounded border px-2 py-1 text-xs ${
                p.pageNumber === page.pageNumber
                  ? 'border-[#101114] bg-[#101114] text-white'
                  : 'border-[#E5E7EB] bg-white text-[#101114] hover:border-[#101114]'
              }`}
            >
              {p.pageNumber}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-auto rounded border border-[#E5E7EB] bg-white">
        <img src={`/api/pages/${page.id}/image`} alt={`Page ${page.pageNumber}`} className="w-full max-w-full" />
      </div>
    </div>
  );
}

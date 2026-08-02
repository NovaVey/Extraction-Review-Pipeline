import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { ReviewItemPage } from '../../types';

interface DocViewerProps {
  pages: ReviewItemPage[];
  // Same meaning as ReviewPane's `locked` — disables the remove-document control
  // during the post-action transition window, so a keyboard user tabbed onto it
  // can't fire a destructive confirm dialog on an item that's about to change.
  locked?: boolean;
  onRemoveDocument?: () => void;
}

// field_values.bbox/pageNumber are never populated by this pipeline (a
// documented Phase 3/4 gap) — no highlight overlay is drawn here on purpose,
// since a fabricated one would be actively misleading.
export function DocViewer({ pages, locked = false, onRemoveDocument }: DocViewerProps) {
  const [currentPageNumber, setCurrentPageNumber] = useState(1);

  if (pages.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-[#4B5563]">No page images for this document.</div>;
  }

  const page = pages.find((p) => p.pageNumber === currentPageNumber) ?? pages[0];

  return (
    <div className="flex h-full flex-col gap-2">
      {(pages.length > 1 || onRemoveDocument) && (
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1">
            {pages.length > 1 &&
              pages.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-current={p.pageNumber === page.pageNumber ? 'page' : undefined}
                  onClick={() => setCurrentPageNumber(p.pageNumber)}
                  className={`rounded-md border px-2 py-1 text-xs ${
                    p.pageNumber === page.pageNumber
                      ? 'border-brand bg-brand text-white'
                      : 'border-[#E5E7EB] bg-white text-[#101114] hover:border-brand'
                  }`}
                >
                  {p.pageNumber}
                </button>
              ))}
          </div>
          {onRemoveDocument && (
            <button
              type="button"
              onClick={onRemoveDocument}
              disabled={locked}
              title="Remove this document from the review queue"
              className="flex shrink-0 items-center gap-1 rounded-md border border-[#E5E7EB] bg-white px-2 py-1 text-xs text-[#4B5563] disabled:opacity-50 hover:border-red-300 hover:bg-red-50 hover:text-red-600"
            >
              <Trash2 size={12} /> Remove
            </button>
          )}
        </div>
      )}
      {/* A light neutral "mat" behind the page image, not plain white — a shorter
          document leaves space below it that reads as an intentional frame rather
          than a broken/empty panel. */}
      <div className="flex-1 overflow-auto rounded-lg border border-[#E5E7EB] bg-[#F3F4F6] p-3 shadow-inner">
        <img
          src={`/api/pages/${page.id}/image`}
          alt={`Page ${page.pageNumber}`}
          className="mx-auto w-full max-w-full rounded-sm bg-white shadow-sm"
        />
      </div>
    </div>
  );
}

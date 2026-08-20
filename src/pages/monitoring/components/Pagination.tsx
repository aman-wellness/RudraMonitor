import { pageWindow, usePagination } from '@/lib/usePagination';

/* Page controls for the monitoring tables.

   Replaces "Load more". That button had two problems beyond being tedious to
   click: it grew the table without bound, so finding a row meant scrolling
   through everything already loaded, and it gave no idea how much was left —
   its own counter read "6 of 6" while five more applications sat unfetched.

   These tabs now aggregate server-side, so the full set is already in hand and
   paging is a pure view concern: no refetch, and the total is honest.

   The paging maths lives in @/lib/usePagination because the admin portal needs
   it too and cannot reuse this component: these controls are styled with the
   `.dash` token classes (chip, t3, tnum), which only exist inside that scope. */

// Re-exported so the monitoring tabs keep a single import.
export { usePagination };

interface Props {
  page: number;
  pageCount: number;
  from: number;
  to: number;
  total: number;
  onPage: (p: number) => void;
  /** What is being counted, e.g. "applications". Shown in the range label. */
  unit: string;
}

export default function Pagination({ page, pageCount, from, to, total, onPage, unit }: Props) {
  if (pageCount <= 1) {
    return total > 0 ? (
      <p className="text-center text-[10.5px] t3 tnum py-1">
        {total} {unit}
      </p>
    ) : null;
  }

  const pages = pageWindow(page, pageCount);

  return (
    <div className="flex items-center justify-between gap-3 px-1 py-1 flex-wrap">
      <span className="text-[10.5px] t3 tnum">
        {from}–{to} of {total} {unit}
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPage(page - 1)}
          disabled={page === 1}
          className="chip chip-quiet text-[10.5px] disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Previous page"
        >
          <i className="ri-arrow-left-s-line" />
        </button>
        {pages[0] > 1 && <span className="text-[10.5px] t3 px-0.5">…</span>}
        {pages.map((p) => (
          <button
            key={p}
            onClick={() => onPage(p)}
            aria-current={p === page ? 'page' : undefined}
            className={`chip text-[10.5px] tnum min-w-[26px] justify-center ${
              p === page ? 'chip-accent' : 'chip-quiet'
            }`}
          >
            {p}
          </button>
        ))}
        {pages[pages.length - 1] < pageCount && <span className="text-[10.5px] t3 px-0.5">…</span>}
        <button
          onClick={() => onPage(page + 1)}
          disabled={page === pageCount}
          className="chip chip-quiet text-[10.5px] disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Next page"
        >
          <i className="ri-arrow-right-s-line" />
        </button>
      </div>
    </div>
  );
}

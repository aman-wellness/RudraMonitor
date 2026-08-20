import { pageWindow } from '@/lib/usePagination';

/* Page controls for tables OUTSIDE the `.dash` token scope — the admin portal,
   the super-admin pages, the partner console.

   The monitoring tabs have their own pager styled with the dash tokens (chip,
   t3, tnum), which render unstyled anywhere else. Both share the paging maths in
   @/lib/usePagination; only the markup differs. */

interface Props {
  page: number;
  pageCount: number;
  from: number;
  to: number;
  total: number;
  onPage: (p: number) => void;
  /** What is being counted, e.g. "employees". Shown in the range label. */
  unit: string;
  /** Show the total on a single page too. Off by default to avoid clutter. */
  alwaysShowTotal?: boolean;
}

export default function Pager({
  page, pageCount, from, to, total, onPage, unit, alwaysShowTotal,
}: Props) {
  if (pageCount <= 1) {
    return alwaysShowTotal && total > 0 ? (
      <p className="text-[11px] text-gray-500 text-center">{total} {unit}</p>
    ) : null;
  }

  const btn =
    'px-2 py-1 text-xs rounded-lg border border-dark-700 text-gray-300 ' +
    'hover:text-white disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <span className="text-[11px] text-gray-400">
        {from}–{to} of {total} {unit}
      </span>
      <div className="flex items-center gap-1">
        <button onClick={() => onPage(page - 1)} disabled={page === 1} className={btn} aria-label="Previous page">
          <i className="ri-arrow-left-s-line" />
        </button>
        {pageWindow(page, pageCount).map((n) => (
          <button
            key={n}
            onClick={() => onPage(n)}
            aria-current={n === page ? 'page' : undefined}
            className={`min-w-[28px] px-2 py-1 text-xs rounded-lg border ${
              n === page
                ? 'border-cyan-500 text-white bg-dark-900'
                : 'border-dark-700 text-gray-400 hover:text-gray-200'
            }`}
          >
            {n}
          </button>
        ))}
        <button onClick={() => onPage(page + 1)} disabled={page === pageCount} className={btn} aria-label="Next page">
          <i className="ri-arrow-right-s-line" />
        </button>
      </div>
    </div>
  );
}

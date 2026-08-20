import { useEffect, useMemo, useState } from 'react';

/* Paging for tables that already hold their full result set.
   Style-agnostic on purpose: the monitoring tables live inside the `.dash`
   token scope and the admin portal does not, so each renders its own controls
   over this shared hook rather than sharing a component that only looks right
   in one of them. */

export const DEFAULT_PAGE_SIZE = 25;

/**
 * Slices `items` into pages, returning to page 1 when the collection size
 * changes — otherwise filtering a long list down to three rows would leave the
 * viewer stranded on an empty page 4.
 *
 * The reset depends on items.LENGTH, not on the array itself. Callers build
 * their lists with a plain `.filter()`, which produces a new array identity on
 * every render; depending on the array made the effect fire after every render,
 * so clicking a page number reset it to 1 before the new page could paint and
 * paging appeared to do nothing at all.
 */
export function usePagination<T>(items: T[], pageSize = DEFAULT_PAGE_SIZE) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));

  useEffect(() => { setPage(1); }, [items.length]);

  // Guard against a page index left beyond the end by a shrinking list.
  const current = Math.min(page, pageCount);
  const visible = useMemo(
    () => items.slice((current - 1) * pageSize, current * pageSize),
    [items, current, pageSize],
  );

  return {
    visible,
    page: current,
    pageCount,
    setPage,
    from: items.length === 0 ? 0 : (current - 1) * pageSize + 1,
    to: Math.min(current * pageSize, items.length),
    total: items.length,
  };
}

/**
 * A window of at most five page numbers centred on the current page, so a pager
 * stays the same width whether there are 3 pages or 300.
 */
export function pageWindow(page: number, pageCount: number): number[] {
  const start = Math.max(1, Math.min(page - 2, pageCount - 4));
  const end = Math.min(pageCount, start + 4);
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

import { useEffect, useMemo, useRef, useState } from 'react';

/* Paging for tables that already hold their full result set.
   Style-agnostic on purpose: the monitoring tables live inside the `.dash`
   token scope and the admin portal does not, so each renders its own controls
   over this shared hook rather than sharing a component that only looks right
   in one of them. */

export const DEFAULT_PAGE_SIZE = 25;

/**
 * Slices `items` into pages.
 *
 * Reset behaviour (audit M8):
 *   - Reset to page 1 when the list SHRINKS (a filter was applied) — otherwise
 *     filtering a long list down to three rows strands the viewer on page 4.
 *   - Do NOT reset when the list GROWS. Monitoring tables refresh with live
 *     agent data continuously; resetting on every arrival yanked the viewer
 *     back to page 1 mid-read. Growth just extends the last page; the clamp
 *     below handles any transient overflow.
 *   - Optional `resetKey`: pass a value that identifies WHAT is being shown
 *     (active tab + filters). Page resets to 1 whenever it changes, which also
 *     fixes the converse bug — switching to a different dataset that happens to
 *     have the same row count previously left you on a middle page.
 *
 * (The reset keys on items.LENGTH, never the array identity — callers `.filter()`
 * a fresh array each render, so keying on the array fired every render and made
 * paging appear to do nothing.)
 */
export function usePagination<T>(items: T[], pageSize = DEFAULT_PAGE_SIZE, resetKey?: unknown) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const prevLen = useRef(items.length);

  // Explicit dataset switch → page 1.
  useEffect(() => { setPage(1); }, [resetKey]);

  // Shrink → page 1; growth → leave the page where it is.
  useEffect(() => {
    if (items.length < prevLen.current) setPage(1);
    prevLen.current = items.length;
  }, [items.length]);

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

import { createContext, useContext, useEffect } from 'react';

/**
 * Increments once per auto-refresh interval (and once per manual refresh).
 * Dashboard panels subscribe with `useRefreshOnTick(...)` and re-run their
 * own fetchers — no remount, so filters, selected ranges and scroll position
 * all survive a refresh.
 */
export const DashboardTick = createContext(0);

export function useRefreshOnTick(...fns: (() => unknown)[]) {
  const tick = useContext(DashboardTick);
  useEffect(() => {
    if (tick === 0) return; // initial mount already fetched
    for (const fn of fns) void fn();
    // Deliberately keyed on `tick` alone: the fetchers are recreated on every
    // render, so including them would fire this on each render instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
}

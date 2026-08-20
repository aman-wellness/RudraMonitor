import { createContext, useContext, useEffect } from 'react';

/* Lets the page header's Refresh button refetch the ACTIVE tab's data.
 *
 * The button used to call window.location.reload() — a full app reload (re-auth,
 * re-fetch everything, lose scroll and every filter the user had set) to update
 * one list. Each tab's data hook already exposes a `refresh`, so the tab
 * registers it here on mount and the header calls it.
 *
 * A context rather than prop drilling: the button is two levels above seven
 * sibling tabs, only one of which is mounted at a time.
 */
type Register = (fn: (() => void) | null) => void;

export const RefreshBus = createContext<Register>(() => {});

/** Call from a tab with its data hook's refresh. Unregisters on unmount. */
export function useRegisterRefresh(fn: () => void) {
  const register = useContext(RefreshBus);
  useEffect(() => {
    register(fn);
    return () => register(null);
    // `fn` is a fresh closure each render; registering the latest one every
    // render is exactly what we want, and re-registering is idempotent.
  }, [register, fn]);
}

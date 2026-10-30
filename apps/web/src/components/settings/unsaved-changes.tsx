// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Shared unsaved-changes guard for the settings forms (SETC-001). A form calls
// `useUnsavedChangesGuard(dirty)` to register its dirty state; while any form is
// dirty a `beforeunload` handler warns on browser back/refresh, and the
// settings nav links call `confirmDiscard()` before navigating so a tab switch
// can't silently throw away typed edits. Pristine forms register nothing and
// navigate freely.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface UnsavedChangesContextValue {
  setDirty: (id: string, dirty: boolean) => void;
  isDirty: boolean;
  /** Returns true when it's safe to navigate (pristine, or the user confirmed
   * discarding). Clears all dirty state on confirm so the destination form
   * starts clean. */
  confirmDiscard: () => boolean;
}

const UnsavedChangesContext = createContext<UnsavedChangesContextValue | null>(
  null,
);

const DISCARD_MESSAGE =
  "You have unsaved changes. Leave this tab and discard them?";

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const dirtyIds = useRef<Set<string>>(new Set());
  const [isDirty, setIsDirty] = useState(false);

  const setDirty = useCallback((id: string, dirty: boolean) => {
    const set = dirtyIds.current;
    const had = set.has(id);
    if (dirty && !had) set.add(id);
    else if (!dirty && had) set.delete(id);
    else return;
    setIsDirty(set.size > 0);
  }, []);

  const confirmDiscard = useCallback(() => {
    if (dirtyIds.current.size === 0) return true;
    const ok =
      typeof window === "undefined" ? true : window.confirm(DISCARD_MESSAGE);
    if (ok) {
      dirtyIds.current.clear();
      setIsDirty(false);
    }
    return ok;
  }, []);

  // Native prompt for browser back / refresh / tab-close while dirty.
  useEffect(() => {
    if (!isDirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy Chrome requires a non-empty returnValue to trigger the prompt.
      event.returnValue = DISCARD_MESSAGE;
      return DISCARD_MESSAGE;
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  const value = useMemo(
    () => ({ setDirty, isDirty, confirmDiscard }),
    [setDirty, isDirty, confirmDiscard],
  );

  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}
    </UnsavedChangesContext.Provider>
  );
}

/** Read the guard. Returns a no-op fallback when used outside the provider so
 * a stray consumer never crashes. */
export function useUnsavedChanges(): UnsavedChangesContextValue {
  const ctx = useContext(UnsavedChangesContext);
  if (ctx) return ctx;
  return {
    setDirty: () => {},
    isDirty: false,
    confirmDiscard: () => true,
  };
}

/** Register a form's dirty state with the shared guard. */
export function useUnsavedChangesGuard(dirty: boolean): void {
  const { setDirty } = useUnsavedChanges();
  const id = useId();
  useEffect(() => {
    setDirty(id, dirty);
  }, [dirty, id, setDirty]);
  // Deregister on unmount so a discarded/navigated form stops blocking.
  useEffect(() => {
    return () => setDirty(id, false);
  }, [id, setDirty]);
}

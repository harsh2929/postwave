// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Command registry (GOV-056): lets route pages push contextual actions into
// the shared ⌘K palette. A page calls useRegisterCommands([...]) and its
// entries appear under an "On this page" group while it's mounted; they're
// removed automatically on unmount. Each call site owns one slot (keyed by a
// stable useId), so re-registration replaces cleanly and callers only need to
// memoize their command array.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface PageCommand {
  /** Stable identifier within the page. */
  id: string;
  label: string;
  /** Extra search terms for the palette's fuzzy match. */
  keywords?: string;
  /** Invoked when the user selects the command. */
  run: () => void;
}

// Empty registrations carry no command identity, so canonicalize them at the
// hook boundary. This keeps a conditional `enabled ? commands : []` branch
// from re-registering forever even if the caller forgets to memoize the empty
// array. Non-empty command arrays still need to be memoized as documented.
const EMPTY_PAGE_COMMANDS: PageCommand[] = [];

interface RegistryValue {
  commands: PageCommand[];
  register: (slot: string, cmds: PageCommand[]) => () => void;
}

const CommandRegistryContext = createContext<RegistryValue | null>(null);

export function CommandRegistryProvider({ children }: { children: ReactNode }) {
  const [slots, setSlots] = useState<Record<string, PageCommand[]>>({});

  const register = useCallback((slot: string, cmds: PageCommand[]) => {
    // Return the SAME object when nothing changed so React can bail out of the
    // re-render. Unconditionally spreading produced a new `slots` on every
    // call, which re-derived `commands` and the context value even when the
    // registration was identical.
    setSlots((prev) =>
      prev[slot] === cmds ? prev : { ...prev, [slot]: cmds },
    );
    return () =>
      setSlots((prev) => {
        if (!(slot in prev)) return prev;
        const next = { ...prev };
        delete next[slot];
        return next;
      });
  }, []);

  const commands = useMemo(() => Object.values(slots).flat(), [slots]);
  const value = useMemo<RegistryValue>(
    () => ({ commands, register }),
    [commands, register],
  );

  return (
    <CommandRegistryContext.Provider value={value}>
      {children}
    </CommandRegistryContext.Provider>
  );
}

/** Read the currently-registered page commands (used by the palette). */
export function useCommandRegistry(): PageCommand[] {
  return useContext(CommandRegistryContext)?.commands ?? [];
}

/**
 * Register a page's contextual commands for the lifetime of the component.
 * `cmds` MUST be memoized (useMemo) so this doesn't re-register every render.
 */
export function useRegisterCommands(cmds: PageCommand[]): void {
  // Depend on `register` (stable, useCallback with no deps) — NOT on the whole
  // context value. The value's identity changes whenever `commands` changes,
  // and registering is what changes `commands`, so listing `ctx` in the deps
  // fed the effect its own output: register → new value → deps changed →
  // unregister + register → … The page span until React tore the tree down,
  // and memoizing `cmds` could not help because the loop ran through the
  // context, not the argument.
  const register = useContext(CommandRegistryContext)?.register;
  const slot = useId();
  const registeredCommands = cmds.length === 0 ? EMPTY_PAGE_COMMANDS : cmds;
  useEffect(() => {
    if (!register) return;
    return register(slot, registeredCommands);
  }, [register, slot, registeredCommands]);
}

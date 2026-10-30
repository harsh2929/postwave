/**
 * useListPreferences — remembered sort/filter state for a list screen.
 *
 *   const [prefs, setPrefs] = useListPreferences("suppressions", {
 *     sort: "newest",
 *     filter: "all",
 *   });
 *
 * Reads are asynchronous, so the hook renders with the defaults first and
 * swaps in stored values once AsyncStorage answers. That ordering matters: the
 * alternative — blocking the first paint on a disk read — would add a blank
 * frame to every list screen to save one re-render.
 *
 * The identity comes from the online-query gate, so preferences are scoped to
 * origin + tenant + user exactly like the persisted query cache.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  readListPreferences,
  writeListPreferences,
} from "@/lib/listPreferences";

export function useListPreferences<T extends Record<string, string>>(
  screen: string,
  defaults: T,
): [T, (next: Partial<T>) => void, { hydrated: boolean }] {
  const gate = useOnlineQueryGate();
  const [values, setValues] = useState<T>(defaults);
  const [hydrated, setHydrated] = useState(false);

  // Defaults are frequently an inline object literal, so depending on them
  // directly would re-run the effect every render. The first value wins.
  const defaultsRef = useRef(defaults);
  // Has the user changed anything since this identity's read was started?
  //
  // Without this the hook loses writes: the read is issued on mount, and a
  // control tapped before it lands is overwritten a tick later by whatever was
  // on disk BEFORE the write. It is a narrow window on a warm process, but it
  // is exactly the window a preference control is tapped in — the user reaches
  // for it the moment the screen paints — and the symptom (a chip that flicks
  // back on its own) is indistinguishable from a broken control.
  const dirtyRef = useRef(false);

  const identity = {
    baseUrl: gate.baseUrl,
    tenantId: gate.tenantId,
    principalId: gate.userId,
  };
  const identityKey = `${identity.baseUrl ?? ""}|${identity.tenantId ?? ""}|${identity.principalId ?? ""}`;

  useEffect(() => {
    let cancelled = false;
    dirtyRef.current = false;
    setHydrated(false);
    void readListPreferences(screen, identity, defaultsRef.current).then(
      (stored) => {
        if (cancelled) return;
        // A write that happened while this read was in flight is NEWER than
        // what the read returned — it has already gone to disk. Adopting the
        // stale snapshot here would undo the user's tap.
        if (!dirtyRef.current) setValues(stored);
        setHydrated(true);
      },
    );
    return () => {
      cancelled = true;
    };
    // Re-reads when the ACCOUNT changes, which is what makes switching
    // workspaces load that workspace's preferences instead of carrying the
    // previous one's forward.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, identityKey]);

  const update = useCallback(
    (next: Partial<T>) => {
      dirtyRef.current = true;
      setValues((current) => {
        const merged = { ...current, ...next };
        void writeListPreferences(screen, identity, merged);
        return merged;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [screen, identityKey],
  );

  return [values, update, { hydrated }];
}

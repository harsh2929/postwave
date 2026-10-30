/**
 * useMoreNavPreferences — pinned + recent destinations for the More menu.
 *
 * Reads asynchronously and renders the un-personalised list first, exactly like
 * useListPreferences: blocking More's first paint on a disk read would add a
 * blank frame to every visit to save one re-render.
 *
 * Identity comes from the online-query gate, so pins are scoped to
 * origin + tenant + user like the persisted query cache. An incomplete identity
 * yields no key at all (see navPreferencesKey), which means a signed-out or
 * half-hydrated app reads and writes nothing rather than falling back to a
 * shared bucket.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  EMPTY_NAV_PREFERENCES,
  readNavPreferences,
  withFavorite,
  withVisit,
  writeNavPreferences,
  type MoreNavPreferences,
} from "@/lib/navPreferences";

export interface MoreNavPreferencesApi {
  preferences: MoreNavPreferences;
  hydrated: boolean;
  /** Pin or unpin. Returns the resulting pinned state for feedback copy. */
  toggleFavorite: (key: string) => boolean;
  recordVisit: (key: string) => void;
}

export function useMoreNavPreferences(): MoreNavPreferencesApi {
  const gate = useOnlineQueryGate();
  const [preferences, setPreferences] = useState<MoreNavPreferences>(
    EMPTY_NAV_PREFERENCES,
  );
  const [hydrated, setHydrated] = useState(false);

  const identity = {
    baseUrl: gate.baseUrl,
    tenantId: gate.tenantId,
    principalId: gate.userId,
  };
  const identityKey = `${identity.baseUrl ?? ""}|${identity.tenantId ?? ""}|${identity.principalId ?? ""}`;
  // The write path needs the CURRENT identity without making every callback
  // re-created on each render.
  const identityRef = useRef(identity);
  identityRef.current = identity;
  // A mirror of the state, so the mutators can compute their result
  // SYNCHRONOUSLY. Deriving it inside a `setState(fn)` updater would not work:
  // React runs updaters during the next render, so the value the caller reads
  // back in the same tick (to pick "Pinned" vs "Unpinned" feedback) would be
  // whatever the variable was initialised to.
  const prefsRef = useRef(preferences);
  prefsRef.current = preferences;

  useEffect(() => {
    let cancelled = false;
    setHydrated(false);
    // Reset to empty first: without this, switching accounts would leave the
    // previous workspace's pins on screen until the read resolves.
    prefsRef.current = EMPTY_NAV_PREFERENCES;
    setPreferences(EMPTY_NAV_PREFERENCES);
    void readNavPreferences(identityRef.current).then((stored) => {
      if (cancelled) return;
      prefsRef.current = stored;
      setPreferences(stored);
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, [identityKey]);

  const commit = useCallback((next: MoreNavPreferences) => {
    prefsRef.current = next;
    setPreferences(next);
    void writeNavPreferences(identityRef.current, next);
  }, []);

  const toggleFavorite = useCallback(
    (key: string): boolean => {
      const favorites = withFavorite(prefsRef.current.favorites, key);
      commit({ ...prefsRef.current, favorites });
      return favorites.includes(key);
    },
    [commit],
  );

  const recordVisit = useCallback(
    (key: string): void => {
      const current = prefsRef.current;
      const recents = withVisit(current.recents, key);
      // Already the most recent — skip the write and the re-render rather than
      // churning storage on every repeat tap.
      if (
        recents.length === current.recents.length &&
        recents.every((entry, i) => entry === current.recents[i])
      ) {
        return;
      }
      commit({ ...current, recents });
    },
    [commit],
  );

  return { preferences, hydrated, toggleFavorite, recordVisit };
}

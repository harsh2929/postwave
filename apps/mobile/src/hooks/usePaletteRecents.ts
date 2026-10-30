/**
 * usePaletteRecents — the palette's per-identity "you were just here" memory,
 * bound to React.
 *
 * Storage and the ordering rule live in lib/paletteRecents (pure, node-tested).
 * This owns the three things a component must do with them: read on mount,
 * re-read when the ACCOUNT changes, and record a launch. Extracted from the
 * Search screen when its component crossed the 300-line function ceiling; the
 * seam is the one the lib already draws.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import type { PreferenceIdentity } from "@/lib/listPreferences";
import { readPaletteRecents, recordPaletteRecent } from "@/lib/paletteRecents";

/** The three scalars that name an account — `useOnlineQueryGate` carries them. */
export interface PaletteRecentsSource {
  baseUrl: string | null;
  tenantId: string | null;
  userId: string | null;
}

export function usePaletteRecents(source: PaletteRecentsSource): {
  recentIds: readonly string[];
  remember: (id: string) => void;
} {
  const [recentIds, setRecentIds] = useState<readonly string[]>([]);
  const identity = useMemo<PreferenceIdentity>(
    () => ({
      baseUrl: source.baseUrl,
      tenantId: source.tenantId,
      principalId: source.userId,
    }),
    [source.baseUrl, source.tenantId, source.userId],
  );

  // Keyed on the memoised identity, so it re-reads exactly when the ACCOUNT
  // changes and one operator's recents never show under another on a shared
  // device.
  useEffect(() => {
    let cancelled = false;
    void readPaletteRecents(identity)
      .then((ids) => {
        if (!cancelled) setRecentIds(ids);
      })
      // Recents are a convenience, not the screen: a failed read leaves the
      // "Jump back in" section empty rather than becoming an unhandled
      // rejection that reaches no reporter.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [identity]);

  const remember = useCallback(
    (id: string) => {
      void recordPaletteRecent(identity, id)
        .then((next) => {
          if (next.length) setRecentIds(next);
        })
        .catch(() => undefined);
    },
    [identity],
  );

  return { recentIds, remember };
}

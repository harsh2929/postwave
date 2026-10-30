// SPDX-License-Identifier: AGPL-3.0-only
//
// Client-side favorites/pinning for flows (FLOW-046, favorites portion). There
// is no backend field for pinned/tagged flows, so this persists a per-tenant
// set of pinned flow ids in localStorage — enough to float the flows an
// operator cares about to the top of the list. Tags/folders remain a backend
// gap (reported PARTIAL). Hydration-safe: starts empty on the server and reads
// storage after mount so SSR and first client render agree.
"use client";

import { useCallback, useEffect, useState } from "react";

function storageKey(tenantId: string): string {
  return `pw.flows.pinned.${tenantId || "anon"}`;
}

function readPinned(tenantId: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(tenantId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function usePinnedFlows(tenantId: string) {
  const [pinned, setPinned] = useState<Set<string>>(() => new Set());
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setPinned(new Set(readPinned(tenantId)));
    setHydrated(true);
  }, [tenantId]);

  const persist = useCallback(
    (next: Set<string>) => {
      setPinned(next);
      try {
        window.localStorage.setItem(
          storageKey(tenantId),
          JSON.stringify([...next]),
        );
      } catch {
        // Storage unavailable (private mode / quota) — pinning stays in-memory.
      }
    },
    [tenantId],
  );

  const toggle = useCallback(
    (id: string) => {
      const next = new Set(pinned);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persist(next);
    },
    [pinned, persist],
  );

  const isPinned = useCallback((id: string) => pinned.has(id), [pinned]);

  return { pinned, isPinned, toggle, hydrated };
}

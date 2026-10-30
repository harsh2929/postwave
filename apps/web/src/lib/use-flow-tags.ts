// SPDX-License-Identifier: AGPL-3.0-only
//
// Client-side tags for flows (FLOW-046, tags portion). There is no backend
// field for flow tags, so — like pinning — this persists a per-tenant map of
// flow id -> tag list in localStorage. Enough to group and filter the flows an
// operator cares about without a schema change. Hydration-safe: empty on the
// server, read from storage after mount.
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

function storageKey(tenantId: string): string {
  return `pw.flows.tags.${tenantId || "anon"}`;
}

function readTags(tenantId: string): Record<string, string[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(storageKey(tenantId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string[]> = {};
    for (const [id, tags] of Object.entries(parsed)) {
      if (Array.isArray(tags)) {
        out[id] = tags.filter((t): t is string => typeof t === "string");
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Normalize a raw comma- or newline-separated tag string into a clean, unique,
 * lowercased list capped at 12 entries. Spaces are *not* separators — a tag
 * may contain them ("high value"), so only "," and "\n" split.
 */
export function parseTagInput(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\n]/)) {
    const t = part.trim().toLowerCase();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out.slice(0, 12);
}

export function useFlowTags(tenantId: string) {
  const [map, setMap] = useState<Record<string, string[]>>({});

  useEffect(() => {
    setMap(readTags(tenantId));
  }, [tenantId]);

  const persist = useCallback(
    (next: Record<string, string[]>) => {
      setMap(next);
      try {
        window.localStorage.setItem(storageKey(tenantId), JSON.stringify(next));
      } catch {
        // Storage unavailable — tags stay in-memory for this session.
      }
    },
    [tenantId],
  );

  const tagsFor = useCallback((id: string) => map[id] ?? [], [map]);

  const setTags = useCallback(
    (id: string, tags: string[]) => {
      const next = { ...map };
      if (tags.length === 0) delete next[id];
      else next[id] = tags;
      persist(next);
    },
    [map, persist],
  );

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const tags of Object.values(map)) for (const t of tags) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [map]);

  return { tagsFor, setTags, allTags };
}

// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

// Types only, and from the import-free module: `nav-index.ts` statically
// imports the OpenAPI spec and the generated skill catalogue, and this file is
// a client component. A value import here risks bundling megabytes of JSON
// into the browser — the very cost this whole change removes.
import type { DocsNavData } from "@/lib/docs/nav-types";

export type {
  DocsNavData,
  SidebarApiTagGroup,
  SidebarSkillCategoryGroup,
} from "@/lib/docs/nav-types";

/** True once a payload carries item-level data, i.e. it is the full index. */
function isFullDocsNav(nav: DocsNavData): boolean {
  return (
    nav.apiGroups.every((g) => g.items !== undefined) &&
    nav.skillGroups.every((g) => g.items !== undefined)
  );
}

/** Where the docs layout's summary payload is topped up from (RSC-01). */
export const DOCS_NAV_INDEX_URL = "/api/docs/nav";

interface DocsNavContextValue {
  /** The summary until the index arrives, then the full tree. */
  nav: DocsNavData;
  /** False while groups still have counts but no items. */
  indexLoaded: boolean;
  /** Idempotent; safe to call from render-adjacent effects and handlers. */
  loadIndex: () => void;
}

const DocsNavContext = createContext<DocsNavContextValue | null>(null);

export function DocsNavProvider({
  value,
  children,
}: {
  value: DocsNavData;
  children: ReactNode;
}): JSX.Element {
  // A provider handed a complete tree (tests, and any future caller that has
  // one) never fetches: it is already loaded.
  const seeded = isFullDocsNav(value);
  const [index, setIndex] = useState<DocsNavData | null>(seeded ? value : null);
  const inFlight = useRef(false);

  const loadIndex = useCallback(() => {
    if (seeded || inFlight.current) return;
    inFlight.current = true;
    void fetch(DOCS_NAV_INDEX_URL, { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? (r.json() as Promise<DocsNavData>) : null))
      .then((data) => {
        if (data) setIndex(data);
        // Leave inFlight set on success: the tree is immutable per deploy.
        else inFlight.current = false;
      })
      .catch(() => {
        // Let a later interaction retry — a collapsed group the reader cannot
        // open is worse than a second request.
        inFlight.current = false;
      });
  }, [seeded]);

  const ctx = useMemo<DocsNavContextValue>(
    () => ({
      nav: index ?? value,
      indexLoaded: index !== null,
      loadIndex,
    }),
    [index, value, loadIndex],
  );

  return (
    <DocsNavContext.Provider value={ctx}>{children}</DocsNavContext.Provider>
  );
}

export function useDocsNav(): DocsNavContextValue {
  const value = useContext(DocsNavContext);
  if (!value) throw new Error("Docs navigation must be inside DocsNavProvider");
  return value;
}

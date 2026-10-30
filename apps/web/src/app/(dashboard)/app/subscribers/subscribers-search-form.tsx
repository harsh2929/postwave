// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Search, X } from "lucide-react";

import { useDirectoryKeyboardShortcuts } from "@/components/subscribers/useDirectoryKeyboardShortcuts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

// The browse toolbar carries the directory API and the live-additions stream,
// neither of which the search box or the first list read needs. It loads right
// after first paint in its own chunk, behind a placeholder of the same shape,
// so the directory stays under the dashboard bundle budget.
const DirectoryToolbar = dynamic(
  () =>
    import("@/components/subscribers/DirectoryToolbar").then(
      (module) => module.DirectoryToolbar,
    ),
  {
    ssr: false,
    loading: () => (
      <section
        role="status"
        aria-live="polite"
        aria-label="Loading directory view"
        className="space-y-2"
      >
        <p className="text-sm text-muted-foreground">Loading directory view…</p>
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-9 w-full sm:w-72" />
          <Skeleton className="ml-auto h-9 w-full sm:w-96" />
        </div>
      </section>
    ),
  },
);

/**
 * The subscribers search box, with its draft state.
 *
 * This lives in its own component for one reason: the draft used to be state on
 * the page, so every keystroke re-rendered the 50-row table, the growth trend
 * and the audience-intelligence panel alongside the input. Nothing in this app
 * is `React.memo`'d and the table is handed fresh inline closures each render,
 * so no subtree could bail out. Keeping the per-keystroke state here means a
 * keystroke re-renders only this form; the page learns the query on submit.
 *
 * The directory's browse toolbar (status chips, sort, saved views, lookalike,
 * refresh, reset, live additions, insights) sits directly under the search box,
 * as it does on desktop. It drives the page through the shared URL state and is
 * memoised, so the per-keystroke re-render above still stops at this form.
 * `/` focuses the search box from anywhere on the directory.
 */
export function SubscribersSearchForm({
  appliedQuery,
  onSearch,
  onClear,
}: {
  /** The query currently reflected in the URL/table. */
  appliedQuery: string;
  /** Submit handler — receives the trimmed draft. */
  onSearch: (query: string) => void;
  /** Clear button handler. */
  onClear: () => void;
}): JSX.Element {
  const [query, setQuery] = useState(appliedQuery);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the input in sync when the URL changes (Back/Forward/deep-link) and
  // when the page clears filters from elsewhere.
  useEffect(() => setQuery(appliedQuery), [appliedQuery]);

  useDirectoryKeyboardShortcuts({
    onFocusSearch: () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    },
  });

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault();
    onSearch(query.trim());
  };

  return (
    <div className="space-y-3">
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={handleSubmit}>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            className="pl-9 pr-9"
            aria-label="Search subscribers"
            aria-keyshortcuts="/"
            placeholder="Search by email, name, or tag"
            title="Press / to search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
                onClear();
              }}
              className="absolute right-1 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      <DirectoryToolbar />
    </div>
  );
}

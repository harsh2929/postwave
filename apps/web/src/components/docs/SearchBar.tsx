// Moosewave docs - Cmd/Ctrl+K search modal.
//
// Production queries a small server endpoint so the full OpenAPI/skills index
// is not serialized into every docs page. Tests may inject an index directly.
// Arrow keys move the highlight; Enter navigates. Cmd+K is a deliberate
// pick: the existing tour launcher already owns Cmd+/.

"use client";

import { useRouter } from "next/navigation";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { X } from "lucide-react";

import { POPULAR } from "@/lib/docs/popular";
import { trapFocus } from "@/lib/focus-trap";
import {
  type SearchIndex,
  searchIndex as runSearch,
  type SearchDoc,
} from "@/lib/docs/search";
import { asRoute } from "@/lib/typed-routes";
import { cn } from "@/lib/utils";

// Persisted recent queries for the ⌘K empty state (MKTN-020). Bounded so the
// list stays a quick-pick, not a history dump.
const RECENTS_KEY = "postwave.docs.recent-searches";
const MAX_RECENTS = 5;

// A selectable row in the results panel. On an empty query we show recent
// searches then a curated Popular list; on a real query we show search hits.
// Unifying them lets one highlight index + aria-activedescendant drive keyboard
// navigation across whichever set is visible.
type DisplayOption =
  | { kind: "result"; key: string; title: string; sub: string; url: string }
  | { kind: "popular"; key: string; label: string; url: string }
  | { kind: "recent"; key: string; term: string };

export interface SearchBarProps {
  index?: SearchIndex;
}

type SearchResult = {
  doc: Pick<SearchDoc, "id" | "title" | "url" | "section">;
  score: number;
};

export function SearchBar({ index }: SearchBarProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [remoteResults, setRemoteResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  // Starts empty on the server and first client render (hydration-safe); the
  // persisted list is loaded from localStorage in an effect after mount.
  const [recent, setRecent] = useState<string[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const router = useRouter();

  // Stable ids so the combobox input can point aria-controls at the listbox
  // and aria-activedescendant at the highlighted option (ARIA 1.2 / MKTN-006).
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = useCallback((i: number) => `${baseId}-opt-${i}`, [baseId]);

  const rememberFocus = useCallback(() => {
    if (restoreFocusRef.current?.isConnected) return;
    const active = document.activeElement;
    restoreFocusRef.current =
      active instanceof HTMLElement && active !== document.body
        ? active
        : triggerRef.current;
  }, []);

  const restoreFocus = useCallback(() => {
    const target = restoreFocusRef.current ?? triggerRef.current;
    restoreFocusRef.current = null;
    if (!target) return;
    requestAnimationFrame(() => {
      if (target.isConnected) target.focus();
    });
  }, []);

  const openSearch = useCallback(() => {
    rememberFocus();
    setOpen(true);
  }, [rememberFocus]);

  const closeSearch = useCallback(() => {
    setOpen(false);
    restoreFocus();
  }, [restoreFocus]);

  // Cmd/Ctrl+K toggle.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const meta = isMac ? e.metaKey : e.ctrlKey;
      if (meta && e.key.toLowerCase() === "k") {
        // Closing is unconditional. The "don't steal the shortcut while
        // someone is typing" guard below only makes sense for opening: once
        // the dialog is up, focus is in its own search input, which IS an
        // HTMLInputElement — so the guard swallowed the keystroke and the
        // advertised toggle could never close what it had just opened.
        if (open) {
          e.preventDefault();
          closeSearch();
          return;
        }
        const target = e.target;
        if (
          target instanceof HTMLElement &&
          (target.isContentEditable ||
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            target instanceof HTMLSelectElement)
        ) {
          return;
        }
        e.preventDefault();
        openSearch();
      } else if (e.key === "Escape" && open) {
        closeSearch();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeSearch, open, openSearch]);

  // Focus the input when the dialog opens.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  // This is a modal surface, so the page behind it must not keep scrolling on
  // touch devices while the results panel is open.
  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  // Load persisted recent searches after mount (client-only; hydration-safe).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(RECENTS_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setRecent(
          parsed
            .filter((v): v is string => typeof v === "string" && v.length > 0)
            .slice(0, MAX_RECENTS),
        );
      }
    } catch {
      // Corrupt/unavailable storage: fall back to no recents.
    }
  }, []);

  const recordRecent = useCallback(
    (term: string) => {
      const trimmed = term.trim();
      if (!trimmed) return;
      // Persist outside the updater — clearRecent below already does it this
      // way. React may invoke an updater more than once per update, and a
      // discarded render would still leave the storage write committed.
      const next = [
        trimmed,
        ...recent.filter((v) => v.toLowerCase() !== trimmed.toLowerCase()),
      ].slice(0, MAX_RECENTS);
      setRecent(next);
      try {
        window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage write failures (private mode / quota).
      }
    },
    [recent],
  );

  const clearRecent = useCallback(() => {
    setRecent([]);
    try {
      window.localStorage.removeItem(RECENTS_KEY);
    } catch {
      // Ignore storage failures.
    }
  }, []);

  const localResults: SearchResult[] = useMemo(() => {
    if (!index) return [];
    if (!query.trim()) return [];
    return runSearch(index, query, 12);
  }, [query, index]);
  const results = index ? localResults : remoteResults;

  useEffect(() => {
    if (index) return undefined;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setRemoteResults([]);
      setSearching(false);
      setSearchError(false);
      return undefined;
    }

    const controller = new AbortController();
    setSearching(true);
    setSearchError(false);
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: trimmed });
      void fetch(`/api/docs/search?${params.toString()}`, {
        signal: controller.signal,
        credentials: "omit",
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("docs search failed");
          return response.json() as Promise<{ results?: SearchResult[] }>;
        })
        .then((body) => {
          setRemoteResults(body.results ?? []);
          setSearching(false);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") {
            return;
          }
          setRemoteResults([]);
          setSearching(false);
          setSearchError(true);
        });
    }, 150);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [index, query]);

  // Reset highlight when results shift.
  useEffect(() => {
    setHighlight(0);
  }, [query]);

  const trimmedQuery = query.trim();
  const showEmptyState = trimmedQuery.length === 0;

  // The rows currently visible and selectable, in render order. On an empty
  // query: recent searches then the curated Popular list; otherwise the search
  // hits. A single index/aria-activedescendant then drives all of them.
  const options: DisplayOption[] = useMemo(() => {
    if (showEmptyState) {
      const recents: DisplayOption[] = recent.map((term) => ({
        kind: "recent",
        key: `recent:${term}`,
        term,
      }));
      const populars: DisplayOption[] = POPULAR.map((p) => ({
        kind: "popular",
        key: `popular:${p.href}`,
        label: p.label,
        url: p.href,
      }));
      return [...recents, ...populars];
    }
    return results.map((r) => ({
      kind: "result",
      key: `result:${r.doc.id}`,
      title: r.doc.title,
      sub: `${r.doc.section} · ${r.doc.url}`,
      url: r.doc.url,
    }));
  }, [showEmptyState, recent, results]);

  const activeIndex =
    options.length > 0 ? Math.min(highlight, options.length - 1) : -1;

  // Keep the highlighted option visible. The listbox is capped at 60vh and
  // routinely holds more than fits — up to 12 search hits, or 5 recents plus
  // 8 popular links in the empty state. Arrow keys moved aria-activedescendant
  // and the visual highlight, but nothing scrolled, so past the fourth or
  // fifth row the reader was steering something they could no longer see.
  // "nearest" is a no-op when the option is already on screen. Declared after
  // activeIndex, not next to the other effects — reading a const above its
  // declaration is a TDZ throw at render, not a lint nit.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document
      .getElementById(optionId(activeIndex))
      ?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex, optionId]);

  const activate = useCallback(
    (opt: DisplayOption) => {
      if (opt.kind === "recent") {
        // Re-run the search for a past term rather than navigating away.
        setQuery(opt.term);
        inputRef.current?.focus();
        return;
      }
      if (opt.kind === "result") recordRecent(trimmedQuery);
      setOpen(false);
      setQuery("");
      restoreFocus();
      router.push(asRoute(opt.url));
    },
    [recordRecent, restoreFocus, router, trimmedQuery],
  );

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      activate(options[activeIndex]!);
    }
  };

  const onDialogKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeSearch();
      return;
    }
    if (e.key !== "Tab") return;
    // Delegate to the shared trap rather than re-deriving the edge cases. The
    // hand-rolled version here only compared activeElement against the first
    // and last focusable, so clicking dead space inside the panel (which moves
    // focus to <body>) matched neither branch, nothing called preventDefault,
    // and the next Tab walked out of the dialog into the page behind it.
    // lib/focus-trap.ts already handles both "focus outside the root" and
    // "inside the root but not itself tabbable".
    trapFocus(e.nativeEvent, panelRef.current);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openSearch}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center gap-2 rounded-md border border-pw-line bg-white px-0 text-sm text-pw-muted-on-paper transition-colors hover:border-pw-ember-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 sm:w-full sm:max-w-sm sm:px-3"
      >
        <svg
          aria-hidden
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <span className="sr-only flex-1 text-left sm:not-sr-only">
          Search docs…
        </span>
        <kbd
          aria-hidden
          className="hidden sm:inline-flex items-center rounded border border-pw-line bg-pw-surface px-1.5 py-0.5 text-[10px] font-mono"
        >
          ⌘K
        </kbd>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal
          aria-label="Search documentation"
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pb-4 pt-4 backdrop-blur-sm sm:pt-[10vh]"
          onKeyDown={onDialogKeyDown}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeSearch();
          }}
        >
          <div
            ref={panelRef}
            className="flex max-h-[calc(100dvh-2rem)] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-pw-line bg-white shadow-xl sm:max-h-[80dvh]"
          >
            <div className="flex min-h-12 items-center gap-2 border-b border-pw-line px-3 sm:px-4">
              <svg
                aria-hidden
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-pw-muted-on-paper"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKey}
                placeholder="Search endpoints, skills, guides…"
                className="min-w-0 flex-1 bg-transparent py-3 text-base outline-none placeholder:text-pw-muted-on-paper sm:text-sm"
                aria-label="Search query"
                role="combobox"
                aria-controls={listboxId}
                aria-expanded="true"
                aria-activedescendant={
                  activeIndex >= 0 ? optionId(activeIndex) : undefined
                }
                aria-autocomplete="list"
                autoComplete="off"
                spellCheck={false}
              />
              <kbd className="hidden text-[10px] font-mono text-pw-muted-on-paper sm:block">
                esc
              </kbd>
              <button
                type="button"
                onClick={closeSearch}
                aria-label="Close search"
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-pw-muted-on-paper hover:bg-pw-surface hover:text-pw-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 sm:h-9 sm:w-9"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <div role="status" aria-live="polite" className="sr-only">
              {searching
                ? "Searching documentation"
                : searchError
                  ? "Search is temporarily unavailable"
                  : !showEmptyState && options.length === 0
                    ? `No results for ${query}`
                    : !showEmptyState
                      ? `${options.length} search result${options.length === 1 ? "" : "s"}`
                      : ""}
            </div>
            <ul
              id={listboxId}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain sm:max-h-[60vh]"
              role="listbox"
              aria-label="Search results"
            >
              {!showEmptyState && searching ? (
                <li
                  role="presentation"
                  className="px-4 py-8 text-center text-sm text-pw-muted-on-paper"
                >
                  Searching…
                </li>
              ) : null}
              {!showEmptyState && searchError ? (
                <li
                  role="presentation"
                  className="px-4 py-8 text-center text-sm text-pw-muted-on-paper"
                >
                  Search is temporarily unavailable. Try again.
                </li>
              ) : null}
              {!showEmptyState &&
              !searching &&
              !searchError &&
              options.length === 0 ? (
                <li
                  role="presentation"
                  className="px-4 py-8 text-center text-sm text-pw-muted-on-paper"
                >
                  No results for <span className="font-mono">{query}</span>
                </li>
              ) : null}
              {options.map((opt, i) => {
                const active = i === activeIndex;
                const showRecentHeader = opt.kind === "recent" && i === 0;
                const showPopularHeader =
                  opt.kind === "popular" && options[i - 1]?.kind !== "popular";
                return (
                  <Fragment key={opt.key}>
                    {showRecentHeader ? (
                      <li
                        role="presentation"
                        className="flex items-center justify-between px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-pw-muted-on-paper"
                      >
                        <span>Recent</span>
                        <button
                          type="button"
                          onClick={clearRecent}
                          className="inline-flex min-h-6 items-center rounded px-1 font-sans text-[11px] normal-case tracking-normal text-pw-muted-on-paper hover:text-pw-ink2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
                        >
                          Clear
                        </button>
                      </li>
                    ) : null}
                    {showPopularHeader ? (
                      <li
                        role="presentation"
                        className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-pw-muted-on-paper"
                      >
                        Popular
                      </li>
                    ) : null}
                    <li
                      id={optionId(i)}
                      role="option"
                      aria-selected={active}
                      data-testid={
                        opt.kind === "result" ? "search-result" : undefined
                      }
                    >
                      <button
                        type="button"
                        onClick={() => activate(opt)}
                        onMouseEnter={() => setHighlight(i)}
                        className={cn(
                          "block min-h-11 w-full border-l-2 px-4 py-2.5 text-left",
                          active
                            ? "bg-pw-ember-500/5 border-pw-ember-500"
                            : "border-transparent hover:bg-pw-surface",
                        )}
                      >
                        {opt.kind === "result" ? (
                          <>
                            <div className="text-sm font-medium text-pw-ink2 truncate">
                              {opt.title}
                            </div>
                            <div className="text-[11px] text-pw-muted-on-paper truncate">
                              {opt.sub}
                            </div>
                          </>
                        ) : opt.kind === "popular" ? (
                          <div className="flex items-center gap-2 text-sm text-pw-ink2 truncate">
                            <span
                              aria-hidden
                              className="h-1 w-1 flex-none rounded-full bg-pw-ember-500"
                            />
                            {opt.label}
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 text-sm text-pw-ink2 truncate">
                            <svg
                              aria-hidden
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="flex-none text-pw-muted-on-paper"
                            >
                              <path d="M3 3v5h5" />
                              <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
                              <path d="M12 7v5l3 3" />
                            </svg>
                            {opt.term}
                          </div>
                        )}
                      </button>
                    </li>
                  </Fragment>
                );
              })}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}

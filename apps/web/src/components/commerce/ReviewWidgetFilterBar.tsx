// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Storefront review-widget inventory controls: Refresh, search, lifecycle
 * filter, and clear. Desktop parity: components/reviews/WidgetsTab.tsx
 * (search + refresh 158-181, lifecycle rail 189-210, Reset view 295-300).
 *
 * Refresh is the host's re-read of GET /api/v1/reviews/widgets — this bar
 * never fetches on its own, so the host keeps one query and one error state.
 * Search and lifecycle filtering are client-side over that listing. The
 * known lifecycle states are always offered (with zero counts) so an
 * operator can see that no widget is paused rather than wonder whether the
 * state exists; any state the server reports beyond them is added as-is.
 */
import { useId, useMemo, useState, type ReactNode } from "react";
import { RefreshCw, Search, SearchX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ReviewWidget } from "@/lib/reviews-api";
import { cn } from "@/lib/utils";

export const ALL_WIDGET_STATES = "__all__";
const KNOWN_LIFECYCLE = ["active", "draft", "paused", "archived"] as const;

export function widgetLifecycleLabel(status: string): string {
  const value = status.trim();
  if (!value) return "Unknown";
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/gu, " ");
}

export function filterReviewWidgets(
  widgets: readonly ReviewWidget[],
  query: string,
  status: string,
): ReviewWidget[] {
  const needle = query.trim().toLocaleLowerCase();
  const order = (value: string) => {
    const index = (KNOWN_LIFECYCLE as readonly string[]).indexOf(value);
    return index === -1 ? KNOWN_LIFECYCLE.length : index;
  };
  return widgets
    .filter(
      (widget) => status === ALL_WIDGET_STATES || widget.status === status,
    )
    .filter(
      (widget) =>
        !needle ||
        [widget.name, widget.widget_type, widget.language, widget.slug].some(
          (value) => value.toLocaleLowerCase().includes(needle),
        ),
    )
    .sort(
      (left, right) =>
        order(left.status) - order(right.status) ||
        left.name.localeCompare(right.name),
    );
}

export function ReviewWidgetFilterBar({
  widgets,
  refreshing,
  onRefresh,
  children,
}: {
  widgets: readonly ReviewWidget[];
  refreshing: boolean;
  onRefresh: () => void;
  /** Receives the visible widgets; [] only when the inventory is empty. */
  children: (visible: ReviewWidget[]) => ReactNode;
}) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>(ALL_WIDGET_STATES);
  const counts = useMemo(() => {
    const next: Record<string, number> = {};
    for (const widget of widgets) {
      next[widget.status] = (next[widget.status] ?? 0) + 1;
    }
    return next;
  }, [widgets]);
  const lifecycleStates = useMemo(
    () => [
      ...new Set<string>([
        ...KNOWN_LIFECYCLE,
        ...widgets.map((widget) => widget.status),
      ]),
    ],
    [widgets],
  );
  const visible = useMemo(
    () => filterReviewWidgets(widgets, query, status),
    [query, status, widgets],
  );
  const narrowed = query.trim() !== "" || status !== ALL_WIDGET_STATES;
  const reset = () => {
    setQuery("");
    setStatus(ALL_WIDGET_STATES);
  };
  const chip = (active: boolean) =>
    cn(
      "inline-flex min-h-11 items-center gap-2 rounded-full border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9",
      active
        ? "border-primary bg-primary/10 text-foreground"
        : "bg-background text-muted-foreground hover:text-foreground",
    );

  return (
    <div className="space-y-3" aria-busy={refreshing || undefined}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <label htmlFor={searchId} className="sr-only">
            Search loaded review widgets
          </label>
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                setQuery("");
              }
            }}
            placeholder="Search widget name, type, language, or slug"
            autoComplete="off"
            className="pl-8"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={onRefresh}
          disabled={refreshing}
          aria-busy={refreshing}
        >
          <RefreshCw
            aria-hidden
            className={
              refreshing ? "animate-spin motion-reduce:animate-none" : undefined
            }
          />
          {refreshing ? "Verifying…" : "Refresh"}
        </Button>
      </div>

      <div
        role="group"
        aria-label="Filter widgets by lifecycle state"
        className="flex flex-wrap gap-2"
      >
        <button
          type="button"
          aria-pressed={status === ALL_WIDGET_STATES}
          className={chip(status === ALL_WIDGET_STATES)}
          onClick={() => setStatus(ALL_WIDGET_STATES)}
        >
          All <strong className="tabular-nums">{widgets.length}</strong>
        </button>
        {lifecycleStates.map((state) => (
          <button
            key={state}
            type="button"
            aria-pressed={status === state}
            className={chip(status === state)}
            onClick={() => setStatus(state)}
          >
            {widgetLifecycleLabel(state)}{" "}
            <strong className="tabular-nums">{counts[state] ?? 0}</strong>
          </button>
        ))}
        {narrowed ? (
          <Button type="button" variant="ghost" size="sm" onClick={reset}>
            Clear filters
          </Button>
        ) : null}
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {visible.length} {visible.length === 1 ? "widget" : "widgets"} shown.{" "}
        {status === ALL_WIDGET_STATES
          ? "All loaded lifecycle states."
          : `${widgetLifecycleLabel(status)} lifecycle state.`}
      </p>

      {visible.length === 0 && widgets.length > 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-6 text-center">
          <SearchX className="size-5 text-muted-foreground" aria-hidden />
          <div>
            <p className="text-sm font-medium">No widgets match this view</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Clear the search or choose another lifecycle state to inspect the
              {` ${widgets.length.toLocaleString()}`} loaded{" "}
              {widgets.length === 1 ? "widget" : "widgets"}.
            </p>
          </div>
          <Button type="button" variant="outline" onClick={reset}>
            Reset view
          </Button>
        </div>
      ) : (
        children(visible)
      )}
    </div>
  );
}

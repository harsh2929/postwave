// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// One shared sequence-template browser used by BOTH /app/sequence-templates
// and the /app/sequences/new picker (SEQ-039), so search, category chips,
// favorites, and empty-state behaviour never drift between the two entry
// points. Card actions are injected by the caller so each route keeps its own
// CTA (Preview+Use vs Use-in-new-flow) over identical chrome.

import { Search, Star, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { pluralize } from "@/lib/analytics-format";
import { useTableUrlState } from "@/lib/use-table-url-state";
import { stringParam } from "@/lib/table-url-state";
import type { SequenceTemplate } from "@/lib/voice-types";

const PINS_KEY = "postwave:pinned-sequence-templates";

function readPins(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PINS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

const BROWSER_SCHEMA = {
  q: stringParam(""),
  cat: stringParam("All"),
  fav: stringParam("0"),
};

export interface TemplateBrowserProps {
  templates: SequenceTemplate[];
  /** Per-card CTA(s). */
  actions: (template: SequenceTemplate) => ReactNode;
  loadError?: string | null;
  /** Reflect filters into the URL (default true). Off for secondary embeds. */
  persistInUrl?: boolean;
  /** Show star pins + a Favorites filter (default true). */
  enableFavorites?: boolean;
  /** Copy shown when the catalog itself is empty (not a failed search). */
  emptyCatalogMessage?: string;
}

export function TemplateBrowser({
  templates,
  actions,
  loadError = null,
  persistInUrl = true,
  enableFavorites = true,
  emptyCatalogMessage = "No sequence templates are available yet.",
}: TemplateBrowserProps): JSX.Element {
  const urlState = useTableUrlState(BROWSER_SCHEMA);
  const [localState, setLocalState] = useState({ q: "", cat: "All", fav: "0" });
  const state = persistInUrl ? urlState.state : localState;
  const setState = persistInUrl
    ? urlState.setState
    : (patch: Partial<typeof localState>) =>
        setLocalState((prev) => ({ ...prev, ...patch }));

  const [pins, setPins] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (enableFavorites) setPins(new Set(readPins()));
  }, [enableFavorites]);

  const togglePin = (id: string) => {
    // Persist outside the updater — React may invoke an updater more than once
    // per update, and a discarded render would still leave the write behind.
    const next = new Set(pins);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPins(next);
    try {
      window.localStorage.setItem(PINS_KEY, JSON.stringify([...next]));
    } catch {
      /* private mode / quota — pins are best-effort */
    }
  };

  const categories = useMemo(
    () => [
      "All",
      ...Array.from(new Set(templates.map((t) => t.category))).sort(),
    ],
    [templates],
  );
  const category = categories.includes(state.cat) ? state.cat : "All";
  const query = state.q;
  const favOnly = enableFavorites && state.fav === "1";

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = templates.filter((template) => {
      if (category !== "All" && template.category !== category) return false;
      if (favOnly && !pins.has(template.id)) return false;
      if (!q) return true;
      return `${template.name} ${template.description}`
        .toLowerCase()
        .includes(q);
    });
    if (!enableFavorites) return list;
    // Pinned rise to the top, otherwise original order is preserved.
    return [...list].sort(
      (a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id)),
    );
  }, [templates, category, query, favOnly, pins, enableFavorites]);

  const hasFilters = query.trim() !== "" || category !== "All" || favOnly;
  const catalogEmpty = templates.length === 0;

  const loadErrorAlert = loadError ? (
    <Alert variant="destructive" className="text-foreground">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <span>
          Sequence templates could not be loaded: {loadError}
          {!catalogEmpty ? " Showing the templates already available." : ""}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => window.location.reload()}
        >
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  ) : null;

  // With no cached rows, an error is not an empty catalog. Stop here instead
  // of immediately contradicting the alert with “No templates available”.
  if (loadError && catalogEmpty) return loadErrorAlert!;

  return (
    <div className="space-y-5">
      {loadErrorAlert}

      <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 sm:p-4">
        {/*
          The clear button is a SIBLING of the label, not a child of it.
          Interactive content inside a <label> is invalid HTML, and the label
          forwards activation to the control it labels — so clicking "Clear
          search" also fired a click on the input. The wrapper carries the
          `relative` box both absolute children position against, so the layout
          is unchanged.
        */}
        <div className="relative sm:max-w-sm">
          <label className="block">
            <span className="sr-only">Search sequence templates</span>
            <Input
              value={query}
              onChange={(event) => setState({ q: event.target.value })}
              placeholder="Search sequence templates"
              className="pl-9 pr-9"
            />
          </label>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setState({ q: "" })}
              className="absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {enableFavorites ? (
            <button
              type="button"
              onClick={() => setState({ fav: favOnly ? "0" : "1" })}
              aria-pressed={favOnly}
              className={cn(
                "inline-flex min-h-8 items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                favOnly
                  ? "border-foreground bg-foreground text-background"
                  : "hover:bg-muted",
              )}
            >
              <Star
                className={cn("h-3.5 w-3.5", favOnly && "fill-current")}
                aria-hidden
              />
              Favorites
            </button>
          ) : null}
          {categories.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setState({ cat: item })}
              aria-pressed={category === item}
              className={cn(
                "min-h-8 max-w-full rounded-full border px-3 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                category === item
                  ? "border-foreground bg-foreground text-background"
                  : "hover:bg-muted",
              )}
            >
              {item}
            </button>
          ))}
          <span className="ml-auto text-xs text-muted-foreground">
            {filtered.length} {pluralize(filtered.length, "template")}
          </span>
        </div>
      </div>

      {filtered.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((template) => (
            <Card key={template.id} className="flex flex-col">
              <CardContent className="flex flex-1 flex-col gap-3 p-5">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="min-w-0 break-words font-medium leading-snug">
                    {template.name}
                  </h2>
                  <div className="flex shrink-0 items-center gap-1">
                    {enableFavorites ? (
                      <button
                        type="button"
                        onClick={() => togglePin(template.id)}
                        aria-label={
                          pins.has(template.id)
                            ? `Unpin ${template.name}`
                            : `Pin ${template.name}`
                        }
                        aria-pressed={pins.has(template.id)}
                        className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <Star
                          className={cn(
                            "h-4 w-4",
                            pins.has(template.id) &&
                              "fill-warning-emphasis text-warning-emphasis",
                          )}
                        />
                      </button>
                    ) : null}
                    <Badge
                      variant="outline"
                      className="max-w-32 truncate"
                      title={template.category}
                    >
                      {template.category}
                    </Badge>
                  </div>
                </div>
                <p className="line-clamp-3 flex-1 text-sm text-muted-foreground">
                  {template.description}
                </p>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {template.length} {pluralize(template.length, "email")}
                  </span>
                  <span>
                    {template.variables.length}{" "}
                    {pluralize(template.variables.length, "variable")}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  {actions(template)}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="space-y-3 py-12 text-center text-sm text-muted-foreground">
            {catalogEmpty ? (
              <p>{emptyCatalogMessage}</p>
            ) : (
              <>
                <p>No sequence templates match your filters.</p>
                {hasFilters ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setState({ q: "", cat: "All", fav: "0" })}
                  >
                    Clear filters
                  </Button>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

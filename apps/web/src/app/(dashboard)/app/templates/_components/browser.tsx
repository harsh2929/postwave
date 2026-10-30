// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  Archive,
  LayoutGrid,
  Search,
  SlidersHorizontal,
  Sparkles,
  Star,
  Upload,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ApiError, apiErrorMessage } from "@/lib/api";
import { useVerifiedAuthScopeOptional } from "@/lib/auth-scope";
import {
  CAMPAIGN_TEMPLATE_SORTS,
  campaignTemplateCapabilities,
  archiveCampaignTemplate,
  cloneCampaignTemplate,
  facetOptions,
  favoriteCampaignTemplate,
  restoreCampaignTemplate,
  searchCampaignTemplates,
  type CampaignTemplateFacets,
  type CampaignTemplateSavedSearchFilters,
  type CampaignTemplateSearchResponse,
  type CampaignTemplateSortKey,
  type CampaignTemplateSummary,
} from "@/lib/campaign-templates-api";
import {
  campaignTemplateCardElementID,
  CAMPAIGN_TEMPLATE_RETURN_FOCUS_PARAM,
  validCampaignTemplateFocusToken,
} from "@/lib/campaign-template-navigation";
import type { FieldSpec } from "@/lib/table-url-state";
import { enumParam, stringParam } from "@/lib/table-url-state";
import { asRoute } from "@/lib/typed-routes";
import { useTableUrlState } from "@/lib/use-table-url-state";
import { useTemplateGenerationAvailability } from "@/lib/use-template-generation-availability";
import { cn } from "@/lib/utils";

import {
  LIBRARY_VIEW_IDS,
  LIBRARY_VIEW_SCOPES,
  OWNERSHIP_SOURCES,
  TEMPLATE_KIND_FILTERS,
  type LibraryView,
} from "./library-view-scopes";
import type { TemplateGalleryProps } from "./template-gallery";

// The bulk bar (and the lifecycle confirmation it carries) only renders once
// a card is selected, so its module loads on demand; the fallback keeps the
// bar's region shell so the layout does not shift when it arrives.
const TemplatesBulkBar = dynamic(
  () =>
    import("./templates-bulk-bar").then((module) => module.TemplatesBulkBar),
  {
    ssr: false,
    loading: () => (
      <div
        className="sticky top-2 z-20 flex flex-wrap items-center gap-3 rounded-md border border-primary/30 bg-primary/5 px-4 py-2.5 text-sm shadow-sm backdrop-blur"
        role="region"
        aria-label="Bulk template actions"
        aria-busy="true"
      >
        <span
          className="font-medium tabular-nums"
          role="status"
          aria-live="polite"
        >
          Loading bulk actions…
        </span>
      </div>
    ),
  },
);

const LazyGenerateTemplateDialog = dynamic(
  () =>
    import("./generate-template-dialog").then(
      (module) => module.GenerateTemplateDialog,
    ),
  {
    ssr: false,
    loading: () => (
      <span className="sr-only" role="status" aria-live="polite">
        Loading template generator…
      </span>
    ),
  },
);

const LazyTemplateDiscoveryTools = dynamic(
  () =>
    import("./template-discovery-tools").then(
      (module) => module.TemplateDiscoveryTools,
    ),
  {
    ssr: false,
    loading: () => (
      <p
        role="status"
        aria-live="polite"
        className="text-sm text-muted-foreground"
      >
        Loading personal library tools…
      </p>
    ),
  },
);

const LazyTemplateGallery = dynamic(
  () => import("./template-gallery").then((module) => module.TemplateGallery),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        aria-live="polite"
        aria-label="Loading template gallery"
        className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      >
        {Array.from({ length: 8 }, (_, index) => (
          <CardSkeleton key={index} />
        ))}
      </div>
    ),
  },
);

interface BrowserProps {
  initialResult: CampaignTemplateSearchResponse;
  initialLoadError?: string | null;
  initialLoadStatus?: number;
  initialRequiresRefresh?: boolean;
  autoOpenGenerate?: boolean;
  galleryComponent?: ComponentType<TemplateGalleryProps>;
}

const EMPTY_SEARCH_RESULT: CampaignTemplateSearchResponse = {
  items: [],
  next_cursor: null,
  total: 0,
  facets: {},
};

type TemplateLoadFailureKind =
  | "favorites-access-denied"
  | "catalog-unavailable"
  | "other";

function templateLoadFailureKind(
  error: unknown,
  view: LibraryView,
): TemplateLoadFailureKind {
  if (
    view === "favorites" &&
    error instanceof ApiError &&
    [401, 403].includes(error.status)
  ) {
    return "favorites-access-denied";
  }
  if (error instanceof ApiError && error.status === 503) {
    return "catalog-unavailable";
  }
  return "other";
}

// Goal is special: the default is "newsletter" and "" means "All". A plain
// stringParam can't distinguish "" (a meaningful non-default) from the omitted
// default, so we map "" ↔ "all" in the URL.
const goalParam: FieldSpec<string> = {
  default: "newsletter",
  decode: (raw) => (raw === "all" ? "" : raw),
  encode: (value) =>
    value === "newsletter" ? null : value === "" ? "all" : value,
};

const boolParam = (): FieldSpec<boolean> => ({
  default: false,
  decode: (raw) => raw === "1" || raw === "true",
  encode: (value) => (value ? "1" : null),
});

const optionalBoolParam = (): FieldSpec<boolean | undefined> => ({
  default: undefined,
  decode: (raw) => {
    if (raw === "1" || raw === "true") return true;
    if (raw === "0" || raw === "false") return false;
    return null;
  },
  encode: (value) => (value === undefined ? null : String(value)),
});

// Search / filters / goal / sort persisted in the URL so refresh, Back after
// opening a template, and shared links all restore the same view (TMPL-006).
// `page` (the load-more window) is intentionally local — a deep link restores
// the filtered view, not an accumulated multi-page scroll position.
// The defaults are the Inspiration scope, so the canonical library URL is a
// bare /app/templates and the other tabs carry their scope explicitly.
const listSchema = {
  view: enumParam(LIBRARY_VIEW_IDS, "inspiration"),
  q: stringParam(""),
  goal: goalParam,
  category: stringParam(""),
  style: stringParam(""),
  industry: stringParam(""),
  layout: stringParam(""),
  source: stringParam(LIBRARY_VIEW_SCOPES.inspiration.source),
  provider: stringParam(""),
  kind: enumParam(TEMPLATE_KIND_FILTERS, LIBRARY_VIEW_SCOPES.inspiration.kind),
  tag: stringParam(""),
  featured: optionalBoolParam(),
  favorited: boolParam(),
  sort: enumParam(CAMPAIGN_TEMPLATE_SORTS, "recommended"),
  archived: enumParam(["active", "archived", "all"] as const, "active"),
} as const;

export const campaignTemplateLibraryUrlSchema = listSchema;

/**
 * URL patch that switches the library to a tab: its full scope, with the
 * narrowing filters a scope owns (provider, archived) reset. Every tab
 * switch, reset and "Browse inspiration" action goes through this one
 * mapping, so the tabs cannot drift apart again.
 */
function libraryViewPatch(view: LibraryView) {
  const scope = LIBRARY_VIEW_SCOPES[view];
  return {
    view,
    source: scope.source,
    kind: scope.kind,
    favorited: scope.favorited,
    goal: scope.goal,
    provider: "",
    archived: "active" as const,
  };
}

// Provider slugs as people know them. Templates made in this app, including
// the built-in starters, carry the product's own provider slug.
const PROVIDER_LABELS: Record<string, string> = {
  postwave: "Made in this app",
  reallygoodemails: "Really Good Emails",
  aura_build: "Aura",
};

function providerLabel(value: string) {
  return PROVIDER_LABELS[value] ?? humanize(value);
}

export function campaignTemplateSavedSearchUrlPatch(
  filters: CampaignTemplateSavedSearchFilters,
) {
  const kind =
    filters.kind === "editable" || filters.kind === "reference"
      ? filters.kind
      : ("all" as const);
  // Searches saved from the old Source dropdown carry a provider slug in the
  // ownership field. Read it as the provider it meant, with no ownership
  // scope, instead of replaying it as `source` (TMPL-A2).
  const savedSource = filters.source?.trim() ?? "";
  const providerInSource =
    savedSource !== "" && !OWNERSHIP_SOURCES.has(savedSource);
  const source = providerInSource || savedSource === "" ? "all" : savedSource;
  const provider = filters.provider || (providerInSource ? savedSource : "");
  const view: LibraryView | undefined =
    filters.favorited === true
      ? "favorites"
      : source === "mine"
        ? "mine"
        : undefined;
  return {
    ...(view ? { view } : {}),
    q: filters.q?.trim() ?? "",
    goal: filters.goal ?? "",
    category: filters.category ?? "",
    style: filters.style ?? "",
    industry: filters.industry ?? "",
    layout: filters.layout ?? "",
    source,
    provider,
    kind,
    tag: filters.tags?.join(",") ?? "",
    featured: filters.featured,
    favorited: filters.favorited === true,
    sort: filters.sort ?? "recommended",
    archived:
      filters.archived === "archived" || filters.archived === "all"
        ? filters.archived
        : ("active" as const),
  };
}

const LIBRARY_VIEWS: Array<{
  value: LibraryView;
  label: string;
  description: string;
}> = [
  {
    value: "inspiration",
    label: "Inspiration",
    description: "Ready-to-use starters and curated designs",
  },
  {
    value: "mine",
    label: "My templates",
    description: "Templates you created or imported",
  },
  {
    value: "favorites",
    label: "Favorites",
    description: "Designs you saved for later",
  },
];

const SORT_LABELS: Record<CampaignTemplateSortKey, string> = {
  recommended: "Recommended",
  name: "Name (A–Z)",
  most_used: "Most used",
};

function humanize(value: string) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function valuesFromItems(
  items: CampaignTemplateSummary[],
  key:
    | "goal"
    | "category"
    | "style"
    | "industry"
    | "layout_archetype"
    | "source",
) {
  return Array.from(
    new Set(
      items
        .map((item) => item[key])
        .filter(
          (value): value is string =>
            typeof value === "string" && Boolean(value),
        ),
    ),
  ).sort((a, b) => a.localeCompare(b));
}

function availableOptions(
  facets: CampaignTemplateFacets,
  items: CampaignTemplateSummary[],
  facetKeys: string[],
  itemKey: Parameters<typeof valuesFromItems>[1],
) {
  for (const key of facetKeys) {
    const values = facetOptions(facets[key]);
    if (values.length) return values;
  }
  return valuesFromItems(items, itemKey);
}

function SelectFilter({
  label,
  value,
  options,
  onChange,
  formatOption = humanize,
  allLabel,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  formatOption?: (value: string) => string;
  allLabel?: string;
}) {
  return (
    <label className="grid min-w-[150px] gap-1 text-xs font-medium text-muted-foreground">
      {label}
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{allLabel ?? `All ${label.toLowerCase()}`}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {formatOption(option)}
          </option>
        ))}
      </Select>
    </label>
  );
}

function TemplateSearchInput({
  query,
  onCommit,
}: {
  /** The committed query currently reflected in the URL. */
  query: string;
  /** Called with the trimmed draft once typing settles. */
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(query);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the box in sync when the URL changes (Back/Forward/deep-link).
  useEffect(() => setDraft(query), [query]);

  // Debounce the input into the URL-backed `q`; the fetch effect keys off it.
  useEffect(() => {
    const trimmed = draft.trim();
    if (trimmed === query) return;
    const timer = window.setTimeout(() => onCommit(trimmed), 300);
    return () => window.clearTimeout(timer);
  }, [draft, onCommit, query]);

  return (
    <label className="grid flex-1 gap-1 text-xs font-medium text-muted-foreground">
      Search designs
      <span className="relative block">
        <Search
          className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
          aria-hidden
        />
        <Input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && draft) {
              event.preventDefault();
              setDraft("");
            }
          }}
          placeholder="Search by layout, topic, industry, or design style"
          className="pl-9 pr-9"
        />
        {draft ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setDraft("");
              inputRef.current?.focus();
            }}
            className="absolute right-1 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </span>
    </label>
  );
}

function CardSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="aspect-[4/5] animate-pulse bg-muted" />
      <div className="space-y-3 p-4">
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
        <div className="h-8 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}

export function TemplatesBrowser({
  initialResult,
  initialLoadError = null,
  initialLoadStatus,
  initialRequiresRefresh = false,
  autoOpenGenerate = false,
  galleryComponent: GalleryComponent = LazyTemplateGallery,
}: BrowserProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const verifiedScope = useVerifiedAuthScopeOptional();
  const canCreateTemplates = verifiedScope?.canWriteCampaigns ?? true;
  const generationAvailability = useTemplateGenerationAvailability(canCreateTemplates);
  const { state, setState } = useTableUrlState(listSchema);
  const {
    view,
    q: search,
    goal,
    category,
    style,
    industry,
    layout,
    source: sourceParam,
    provider,
    kind,
    tag,
    featured,
    favorited,
    sort,
    archived,
  } = state;
  // A link that names a tab but not its ownership scope was written while
  // `source` defaulted to "all" (Favorites links, captured return_to values).
  // Read it as that tab's scope rather than Inspiration's, so an old
  // Favorites link still shows your own starred templates.
  const source =
    searchParams.get("view") !== null && searchParams.get("source") === null
      ? LIBRARY_VIEW_SCOPES[view].source
      : sourceParam;

  const [storedResult, setResult] = useState(initialResult);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(initialRequiresRefresh);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(initialLoadError);
  const [failureKind, setFailureKind] =
    useState<TemplateLoadFailureKind | null>(
      initialLoadError
        ? initialLoadStatus === 503
          ? "catalog-unavailable"
          : "other"
        : null,
    );
  const [retryNonce, setRetryNonce] = useState(0);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generateActivated, setGenerateActivated] = useState(false);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState<boolean | null>(null);
  const openGenerate = useCallback(() => {
    if (generationAvailability !== "available") return;
    setGenerateActivated(true);
    setGenerateOpen(true);
  }, [generationAvailability]);

  useEffect(() => {
    if (!autoOpenGenerate || generationAvailability !== "available") return;
    setGenerateActivated(true);
    setGenerateOpen(true);
  }, [autoOpenGenerate, generationAvailability]);
  // TMPL-031: multi-select for bulk favorite/delete over the card grid.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [compareSelection, setCompareSelection] = useState<
    CampaignTemplateSummary[]
  >([]);
  const [organizerTemplate, setOrganizerTemplate] =
    useState<CampaignTemplateSummary | null>(null);
  const firstSearch = useRef(true);
  const requestSequence = useRef(0);
  const searchController = useRef<AbortController | null>(null);
  const loadMoreController = useRef<AbortController | null>(null);
  const duplicating = useRef<Set<string>>(new Set());
  const queryKey = `${view}|${search}|${goal}|${category}|${style}|${industry}|${layout}|${source}|${provider}|${kind}|${tag}|${String(featured)}|${favorited}|${sort}|${archived}`;
  const searchKey = `${queryKey}|${retryNonce}`;
  const displayedQueryKey = useRef(queryKey);
  const activeQueryKey = useRef(queryKey);
  // Update during render, not in an effect: a just-resolved old-page request
  // must see the new identity before it can append after a URL/filter change.
  activeQueryKey.current = queryKey;
  const result =
    displayedQueryKey.current === queryKey ? storedResult : EMPTY_SEARCH_RESULT;
  const galleryPath = useMemo(() => {
    const query = searchParams.toString();
    return query ? `${pathname}?${query}` : pathname;
  }, [pathname, searchParams]);
  const returnFocusToken = validCampaignTemplateFocusToken(
    searchParams.get(CAMPAIGN_TEMPLATE_RETURN_FOCUS_PARAM),
  );

  useEffect(() => {
    if (!returnFocusToken) return;
    const card = document.getElementById(
      campaignTemplateCardElementID(returnFocusToken),
    );
    if (!card) return;
    card.focus({ preventScroll: true });
    card.scrollIntoView?.({ block: "nearest" });
    const next = new URLSearchParams(searchParams.toString());
    next.delete(CAMPAIGN_TEMPLATE_RETURN_FOCUS_PARAM);
    const query = next.toString();
    router.replace(asRoute(query ? `${pathname}?${query}` : pathname), {
      scroll: false,
    });
  }, [pathname, result.items, returnFocusToken, router, searchParams]);

  // Stable identity: TemplateSearchInput restarts its debounce timer whenever
  // this callback changes.
  const commitSearch = useCallback(
    (next: string) => setState({ q: next }),
    [setState],
  );

  // Strip the auto-open `?generate=1` trigger once so a refresh/Back after
  // closing the dialog doesn't silently reopen it (TMPL-034).
  useEffect(() => {
    if (searchParams.get("generate") !== "1") return;
    const next = new URLSearchParams(searchParams.toString());
    next.delete("generate");
    const query = next.toString();
    router.replace(asRoute(query ? `${pathname}?${query}` : pathname), {
      scroll: false,
    });
  }, [pathname, router, searchParams]);

  // Drop any selection when the result set changes underneath it (TMPL-031),
  // so a bulk action never targets cards that scrolled out of the filter.
  useEffect(() => {
    setSelected((current) => (current.size === 0 ? current : new Set()));
  }, [searchKey]);

  useEffect(() => {
    if (firstSearch.current) {
      firstSearch.current = false;
      const inspiration = LIBRARY_VIEW_SCOPES.inspiration;
      const matchesSeed =
        view === "inspiration" &&
        search === "" &&
        goal === inspiration.goal &&
        !category &&
        !style &&
        !industry &&
        !layout &&
        source === inspiration.source &&
        provider === "" &&
        kind === inspiration.kind &&
        !tag &&
        featured === undefined &&
        favorited === inspiration.favorited &&
        sort === "recommended" &&
        archived === "active";
      // The server preloaded exactly this query (page.tsx); reuse it and skip
      // the redundant client fetch. A deep-linked filtered view falls through
      // and fetches to match the URL.
      if (matchesSeed && !initialRequiresRefresh) return;
    }
    const sequence = ++requestSequence.current;
    searchController.current?.abort();
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    const controller = new AbortController();
    searchController.current = controller;
    setLoading(true);
    setLoadingMore(false);
    setPage(1);
    setError(null);
    setFailureKind(null);
    void searchCampaignTemplates(
      {
        q: search,
        goal,
        category,
        style,
        industry,
        layout,
        source,
        provider,
        kind: kind === "all" ? undefined : kind,
        tags: tag,
        featured,
        favorited,
        sort,
        archived,
        page: 1,
        perPage: 24,
      },
      { signal: controller.signal },
    )
      .then((next) => {
        if (
          sequence !== requestSequence.current ||
          activeQueryKey.current !== queryKey
        ) {
          return;
        }
        displayedQueryKey.current = queryKey;
        setResult(next);
        setPage(1);
        setFailureKind(null);
      })
      .catch((err: unknown) => {
        if (
          sequence !== requestSequence.current ||
          activeQueryKey.current !== queryKey
        ) {
          return;
        }
        if (err instanceof ApiError && err.kind === "aborted") return;
        const nextFailureKind = templateLoadFailureKind(err, view);
        setFailureKind(nextFailureKind);
        // A private Favorites denial is not a refresh of the previously
        // visible public gallery. Do not leave those cards looking like
        // accessible favorites under an access-denied tab.
        if (nextFailureKind === "favorites-access-denied") {
          setResult({
            items: [],
            next_cursor: null,
            total: 0,
            facets: {},
          });
          setPage(1);
        }
        setError(apiErrorMessage(err, "Templates could not be loaded."));
      })
      .finally(() => {
        if (
          sequence === requestSequence.current &&
          activeQueryKey.current === queryKey
        ) {
          setLoading(false);
        }
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey]);

  const loadMore = async () => {
    const identity = queryKey;
    const searchSequence = requestSequence.current;
    const cursor = result.next_cursor;
    if (!cursor) return;
    const nextPage = page + 1;
    loadMoreController.current?.abort();
    const controller = new AbortController();
    loadMoreController.current = controller;
    setLoadingMore(true);
    setError(null);
    setFailureKind(null);
    try {
      const next = await searchCampaignTemplates(
        {
          q: search,
          goal,
          category,
          style,
          industry,
          layout,
          source,
          provider,
          kind: kind === "all" ? undefined : kind,
          tags: tag,
          featured,
          favorited,
          sort,
          archived,
          cursor,
          page: nextPage,
          perPage: 24,
        },
        { signal: controller.signal },
      );
      if (
        controller.signal.aborted ||
        loadMoreController.current !== controller ||
        requestSequence.current !== searchSequence ||
        activeQueryKey.current !== identity ||
        displayedQueryKey.current !== identity
      ) {
        return;
      }
      setResult((current) => {
        // Set membership, not a nested `.some()`: the gallery accumulates 24
        // cards per "Load more", so the pairwise scan cost 24 x n comparisons
        // on every click.
        const loaded = new Set(current.items.map((item) => item.id));
        return {
          items: [
            ...current.items,
            ...next.items.filter((candidate) => !loaded.has(candidate.id)),
          ],
          next_cursor: next.next_cursor,
          total: next.total,
          facets: Object.keys(next.facets).length
            ? next.facets
            : current.facets,
        };
      });
      setPage(nextPage);
      setFailureKind(null);
    } catch (err) {
      if (
        loadMoreController.current !== controller ||
        activeQueryKey.current !== identity
      ) {
        return;
      }
      if (err instanceof ApiError && err.kind === "aborted") return;
      const nextFailureKind = templateLoadFailureKind(err, view);
      setFailureKind(nextFailureKind);
      if (nextFailureKind === "favorites-access-denied") {
        setResult({
          items: [],
          next_cursor: null,
          total: 0,
          facets: {},
        });
        setPage(1);
      }
      setError(apiErrorMessage(err, "More templates could not be loaded."));
    } finally {
      if (
        loadMoreController.current === controller &&
        activeQueryKey.current === identity
      ) {
        loadMoreController.current = null;
        setLoadingMore(false);
      }
    }
  };

  useEffect(
    () => () => {
      searchController.current?.abort();
      loadMoreController.current?.abort();
    },
    [],
  );

  const patchItem = (id: string, patch: Partial<CampaignTemplateSummary>) =>
    setResult((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    }));

  const toggleFavorite = async (template: CampaignTemplateSummary) => {
    if (!campaignTemplateCapabilities(template).can_favorite) {
      toast.info("This design must be approved before it can be favorited.");
      return;
    }
    const next = !template.is_favorited;
    patchItem(template.id, { is_favorited: next });
    // When browsing the Favorites view, drop an un-favorited card immediately.
    if ((view === "favorites" || favorited) && !next) {
      setResult((current) => ({
        ...current,
        items: current.items.filter((item) => item.id !== template.id),
        total: Math.max(0, current.total - 1),
      }));
    }
    try {
      await favoriteCampaignTemplate(template.id, next);
    } catch (err) {
      patchItem(template.id, { is_favorited: !next });
      if ((view === "favorites" || favorited) && !next) {
        setRetryNonce((value) => value + 1);
      }
      toast.error(apiErrorMessage(err, "Could not update favorite."));
    }
  };

  const duplicate = async (template: CampaignTemplateSummary) => {
    // The clone POST carries no idempotency key and the overflow menu closes
    // on select, so a slow clone reads as a missed click: without this guard a
    // second pick creates a second copy the user then has to hunt down and
    // archive. The toast is the acknowledgement the closed menu can't give.
    if (duplicating.current.has(template.id)) return;
    duplicating.current.add(template.id);
    const toastId = `duplicate-template-${template.id}`;
    toast.info("Duplicating design…", {
      id: toastId,
      description: template.name,
    });
    try {
      const copy = await cloneCampaignTemplate(template.id);
      toast.success("Template duplicated", { id: toastId });
      router.push(`/app/templates/${copy.id}`);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Could not duplicate the template."), {
        id: toastId,
      });
    } finally {
      duplicating.current.delete(template.id);
    }
  };

  const removeResultItems = (ids: Set<string>) => {
    if (!ids.size) return;
    setResult((current) => ({
      ...current,
      items: current.items.filter((item) => !ids.has(item.id)),
      total: Math.max(0, current.total - ids.size),
    }));
  };

  const changeLifecycle = async (
    template: CampaignTemplateSummary,
    next: "archived" | "active",
  ) => {
    if (!template.etag) {
      toast.error("Reload the library to get the latest template version.");
      return;
    }
    try {
      if (next === "archived") {
        await archiveCampaignTemplate(template.id, template.etag);
        toast.success("Template archived", {
          description: "Find it anytime under My templates → Archived.",
        });
      } else {
        await restoreCampaignTemplate(template.id, template.etag);
        toast.success("Template restored", {
          description: "It is editable and ready to use again.",
        });
      }
      removeResultItems(new Set([template.id]));
      setSelected((current) => {
        if (!current.has(template.id)) return current;
        const updated = new Set(current);
        updated.delete(template.id);
        return updated;
      });
    } catch (err) {
      toast.error(
        apiErrorMessage(
          err,
          next === "archived"
            ? "Could not archive the template. Reload and try again."
            : "Could not restore the template. Reload and try again.",
        ),
      );
      setRetryNonce((value) => value + 1);
    }
  };

  // TMPL-031: bulk selection + actions. No bulk endpoint exists, so each
  // action loops the existing per-item calls with allSettled and reports
  // partial failures rather than failing the whole batch.
  const toggleSelect = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Built once per render instead of an O(n) `.some()` scan per rendered card
  // (the grid grows by 24 with every "Load more").
  const compareSelectedIds = useMemo(
    () => new Set(compareSelection.map((candidate) => candidate.id)),
    [compareSelection],
  );
  const toggleCompare = (template: CampaignTemplateSummary) => {
    // The cap toast used to live inside the setCompareSelection updater.
    // React may run an updater more than once per update — StrictMode always
    // does — so picking a fifth template stacked two identical toasts.
    if (compareSelectedIds.has(template.id)) {
      setCompareSelection((current) =>
        current.filter((candidate) => candidate.id !== template.id),
      );
      return;
    }
    if (compareSelection.length >= 4) {
      toast.info("Comparison supports up to four templates.");
      return;
    }
    setCompareSelection((current) => [...current, template]);
  };
  const clearSelection = () => setSelected(new Set());
  const selectedTemplates = () =>
    result.items.filter((item) => selected.has(item.id));
  const archivableSelected = () =>
    selectedTemplates().filter(
      (item) =>
        Boolean(item.etag) && campaignTemplateCapabilities(item).can_archive,
    );
  const favoriteableSelected = () =>
    selectedTemplates().filter(
      (item) =>
        campaignTemplateCapabilities(item).can_favorite && !item.is_favorited,
    );
  const restorableSelected = () =>
    selectedTemplates().filter(
      (item) =>
        Boolean(item.etag) && campaignTemplateCapabilities(item).can_restore,
    );

  const bulkFavorite = async () => {
    const targets = selectedTemplates().filter(
      (item) =>
        campaignTemplateCapabilities(item).can_favorite && !item.is_favorited,
    );
    if (targets.length === 0) {
      toast.info("Selected templates are already favorited.");
      return;
    }
    targets.forEach((item) => patchItem(item.id, { is_favorited: true }));
    const results = await Promise.allSettled(
      targets.map((item) => favoriteCampaignTemplate(item.id, true)),
    );
    const failed = results.reduce(
      (acc, r, i) => (r.status === "rejected" ? [...acc, targets[i]] : acc),
      [] as CampaignTemplateSummary[],
    );
    failed.forEach((item) => patchItem(item.id, { is_favorited: false }));
    if (failed.length > 0) {
      toast.error(
        `Favorited ${targets.length - failed.length} of ${targets.length}; ${failed.length} failed.`,
      );
      setSelected(new Set(failed.map((item) => item.id)));
    } else {
      toast.success(
        `Added ${targets.length} template${targets.length === 1 ? "" : "s"} to favorites.`,
      );
      clearSelection();
    }
  };

  const bulkLifecycle = async (next: "archived" | "active") => {
    const targets =
      next === "archived" ? archivableSelected() : restorableSelected();
    if (targets.length === 0) return;
    const results = await Promise.allSettled(
      targets.map((item) =>
        next === "archived"
          ? archiveCampaignTemplate(item.id, item.etag ?? "")
          : restoreCampaignTemplate(item.id, item.etag ?? ""),
      ),
    );
    const changedIds = new Set<string>();
    const failed: CampaignTemplateSummary[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") changedIds.add(targets[i].id);
      else failed.push(targets[i]);
    });
    removeResultItems(changedIds);
    if (failed.length > 0) {
      toast.error(
        `${next === "archived" ? "Archived" : "Restored"} ${changedIds.size} of ${targets.length}; ${failed.length} need a reload or retry.`,
      );
      setSelected(new Set(failed.map((item) => item.id)));
    } else {
      toast.success(
        `${next === "archived" ? "Archived" : "Restored"} ${changedIds.size} template${changedIds.size === 1 ? "" : "s"}.`,
      );
      clearSelection();
    }
  };

  const bulkArchive = () => bulkLifecycle("archived");
  const bulkRestore = () => bulkLifecycle("active");

  const options = useMemo(
    () => ({
      goals: availableOptions(
        result.facets,
        result.items,
        ["goals", "goal"],
        "goal",
      ),
      categories: availableOptions(
        result.facets,
        result.items,
        ["categories", "category"],
        "category",
      ),
      styles: availableOptions(
        result.facets,
        result.items,
        ["styles", "style"],
        "style",
      ),
      industries: availableOptions(
        result.facets,
        result.items,
        ["industries", "industry"],
        "industry",
      ),
      layouts: availableOptions(
        result.facets,
        result.items,
        ["layouts", "layout_archetypes", "layout"],
        "layout_archetype",
      ),
      sources: availableOptions(
        result.facets,
        result.items,
        ["providers", "sources", "source"],
        "source",
      ),
      tags: facetOptions(result.facets.tags),
    }),
    [result.facets, result.items],
  );
  // When facets are absent the options are derived from the loaded page only,
  // so they can under-represent a large library (TMPL-011, partial).
  const facetsDerived = Object.keys(result.facets).length === 0;

  // Search ordering is global and cursor-stable on the server. Preserve that
  // exact order when appending pages instead of re-sorting only the loaded
  // browser window.
  const displayItems = result.items;
  const allLoadedSelected =
    displayItems.length > 0 &&
    displayItems.every((template) => selected.has(template.id));
  const toggleAllLoaded = () =>
    setSelected((current) => {
      const next = new Set(current);
      if (allLoadedSelected) {
        displayItems.forEach((template) => next.delete(template.id));
      } else {
        displayItems.forEach((template) => next.add(template.id));
      }
      return next;
    });

  const navigateLibraryTabs = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const current = LIBRARY_VIEWS.findIndex((item) => item.value === view);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? LIBRARY_VIEWS.length - 1
          : (current +
              (event.key === "ArrowRight" ? 1 : -1) +
              LIBRARY_VIEWS.length) %
            LIBRARY_VIEWS.length;
    const nextView = LIBRARY_VIEWS[next];
    if (!nextView) return;
    setState(libraryViewPatch(nextView.value));
    event.currentTarget
      .querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [next]?.focus();
  };

  // A filter is "active" when it narrows the current view beyond its own
  // scope; the scope itself (e.g. My templates = source=mine) is not a filter.
  const baseline = LIBRARY_VIEW_SCOPES[view];
  const activeFilterCount =
    Number(goal !== baseline.goal) +
    Number(Boolean(category)) +
    Number(Boolean(style)) +
    Number(Boolean(industry)) +
    Number(Boolean(layout)) +
    Number(source !== baseline.source) +
    Number(Boolean(provider)) +
    Number(kind !== baseline.kind) +
    Number(Boolean(tag)) +
    Number(featured !== undefined) +
    Number(favorited !== baseline.favorited) +
    Number(archived !== "active");
  const hasActiveQueryOrFilter = activeFilterCount > 0 || Boolean(search);
  const advancedFilterCount =
    [category, style, layout, industry, provider, tag].filter(Boolean).length +
    Number(featured === true);
  const advancedFiltersActive = advancedFilterCount > 0;
  const advancedFiltersVisible = showAdvancedFilters ?? advancedFiltersActive;
  // The cursor is the only signal loadMore can act on (it returns immediately
  // without one). `total` disagrees with the loaded count whenever a page
  // repeats an id we already hold or a concurrent archive/insert shifts the
  // count, and gating on that offered a "Load more" that fired no request.
  const hasMore = Boolean(result.next_cursor);
  const showingStaleResults = Boolean(error && result.items.length > 0);

  const clearFilters = () => {
    setState({
      ...libraryViewPatch(view),
      q: "",
      category: "",
      style: "",
      industry: "",
      layout: "",
      tag: "",
      featured: undefined,
      sort: "recommended",
    });
  };

  const currentDiscoveryFilters =
    useMemo<CampaignTemplateSavedSearchFilters>(() => {
      const filters: CampaignTemplateSavedSearchFilters = {
        ...(search ? { q: search } : {}),
        ...(goal ? { goal } : {}),
        ...(category ? { category } : {}),
        ...(style ? { style } : {}),
        ...(industry ? { industry } : {}),
        ...(layout ? { layout } : {}),
        ...(source !== "all" ? { source } : {}),
        ...(provider ? { provider } : {}),
        ...(kind !== "all" ? { kind } : {}),
        ...(tag
          ? {
              tags: tag
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
            }
          : {}),
        ...(featured !== undefined ? { featured } : {}),
        favorited,
        archived,
        ...(sort !== "recommended" ? { sort } : {}),
      };
      return filters;
    }, [
      archived,
      category,
      favorited,
      featured,
      goal,
      industry,
      layout,
      kind,
      provider,
      search,
      sort,
      source,
      style,
      tag,
    ]);

  const applySavedSearch = (filters: CampaignTemplateSavedSearchFilters) => {
    const patch = campaignTemplateSavedSearchUrlPatch(filters);
    const nextView =
      patch.view ??
      (view === "favorites" && !patch.favorited
        ? "inspiration"
        : view === "mine" && patch.source !== "mine"
          ? "inspiration"
          : view);
    setState({ ...patch, view: nextView });
    toast.success("Saved search opened", {
      description:
        "The filters are in the URL, so Back and refresh still work.",
    });
  };

  return (
    <div className="space-y-6">
      <header className="space-y-5">
        <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
          <div className="max-w-3xl">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-primary">
              <LayoutGrid className="h-4 w-4" aria-hidden />
              Design library
            </div>
            <h1 className="font-display text-2xl font-semibold tracking-tight">
              Newsletter templates
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground sm:text-base">
              Explore curated starting points below, build with blocks, or bring
              your own HTML/MJML. Review every design before using it in a
              campaign. Nothing is sent automatically.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="ghost">
              <Link href={asRoute("/app/sequence-templates")}>
                Sequence templates
              </Link>
            </Button>
            {canCreateTemplates ? (
              <>
                <Button asChild variant="outline">
                  <Link href={asRoute("/app/templates/new")}>
                    Start with blocks
                  </Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href={asRoute("/app/templates/new?mode=import")}>
                    <Upload className="h-4 w-4" aria-hidden />
                    Import HTML/MJML
                  </Link>
                </Button>
                <Button
                  type="button"
                  onClick={openGenerate}
                  disabled={generationAvailability !== "available"}
                  title={generationAvailability === "unavailable"
                    ? "AI template creation is coming soon to this workspace"
                    : generationAvailability === "error"
                      ? "AI availability could not be checked. Try again shortly."
                      : undefined}
                >
                  <Sparkles className="h-4 w-4" />
                  {generationAvailability === "available"
                    ? "Generate with AI"
                    : generationAvailability === "checking"
                      ? "Checking AI availability…"
                      : generationAvailability === "error"
                        ? "AI temporarily unavailable"
                        : "AI designs · Coming soon"}
                </Button>
              </>
            ) : null}
          </div>
        </div>

        <div
          className="grid gap-2 rounded-lg border bg-muted/20 p-1.5 sm:grid-cols-3"
          role="tablist"
          aria-label="Template library"
          onKeyDown={navigateLibraryTabs}
        >
          {LIBRARY_VIEWS.map((item) => {
            const active = view === item.value;
            return (
              <button
                key={item.value}
                id={`template-library-tab-${item.value}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls="template-library-results"
                tabIndex={active ? 0 : -1}
                onClick={() => setState(libraryViewPatch(item.value))}
                className={cn(
                  "rounded-md px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                )}
              >
                <span className="block text-sm font-medium">{item.label}</span>
                <span className="mt-0.5 block text-xs">{item.description}</span>
              </button>
            );
          })}
        </div>

        {view === "mine" ? (
          <div
            className="flex w-fit rounded-lg border bg-muted/20 p-1"
            role="group"
            aria-label="Template lifecycle"
          >
            {(["active", "archived"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={archived === value}
                onClick={() => setState({ archived: value })}
                className={cn(
                  "min-h-11 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9",
                  archived === value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {value === "active" ? "Active" : "Archived"}
              </button>
            ))}
          </div>
        ) : null}

        <div className="rounded-lg border bg-card p-3 shadow-sm sm:p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <TemplateSearchInput query={search} onCommit={commitSearch} />
            <Button
              type="button"
              variant="outline"
              aria-expanded={advancedFiltersVisible}
              aria-controls="template-advanced-filters"
              onClick={() => setShowAdvancedFilters(!advancedFiltersVisible)}
            >
              <SlidersHorizontal className="h-4 w-4" />
              {advancedFiltersVisible ? "Hide filters" : "More filters"}
              {advancedFiltersActive ? ` · ${advancedFilterCount}` : ""}
            </Button>
            {hasActiveQueryOrFilter ? (
              <Button type="button" variant="ghost" onClick={clearFilters}>
                <X className="h-3.5 w-3.5" /> Clear filters
              </Button>
            ) : null}
          </div>
          <div
            id="template-advanced-filters"
            hidden={!advancedFiltersVisible}
            style={{ display: advancedFiltersVisible ? undefined : "none" }}
            className="mt-3 flex flex-wrap items-end gap-3 border-t pt-3"
          >
            <SelectFilter label="Category" value={category} options={options.categories} onChange={(value) => setState({ category: value })} />
            <SelectFilter label="Style" value={style} options={options.styles} onChange={(value) => setState({ style: value })} />
            <SelectFilter label="Layout" value={layout} options={options.layouts} onChange={(value) => setState({ layout: value })} />
            <SelectFilter
              label="Industry"
              value={industry}
              options={options.industries}
              onChange={(value) => setState({ industry: value })}
            />
            {/* The provider axis. The tab owns `source` (ownership); writing a
                provider into `source` dropped the tab's scope (TMPL-A2). */}
            <SelectFilter
              label="Source"
              allLabel="All sources"
              value={provider}
              options={options.sources.filter(
                (entry) => !OWNERSHIP_SOURCES.has(entry),
              )}
              formatOption={providerLabel}
              onChange={(value) => setState({ provider: value })}
            />
            {options.tags.length ? (
              <SelectFilter
                label="Topic"
                value={tag}
                options={options.tags}
                onChange={(value) => setState({ tag: value })}
              />
            ) : null}
            <Button
              type="button"
              size="sm"
              variant={featured ? "secondary" : "outline"}
              aria-pressed={featured === true}
              onClick={() =>
                setState({ featured: featured === true ? undefined : true })
              }
            >
              <Sparkles className="h-3.5 w-3.5" /> Featured
            </Button>
            <Button
              type="button"
              size="sm"
              variant={view === "favorites" ? "secondary" : "outline"}
              aria-pressed={view === "favorites"}
              onClick={() =>
                setState(
                  libraryViewPatch(
                    view === "favorites" ? "inspiration" : "favorites",
                  ),
                )
              }
            >
              <Star className="h-3.5 w-3.5" /> Favorites
            </Button>
          </div>
          {facetsDerived && advancedFiltersVisible ? (
            <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
              Filter options reflect the designs loaded so far. Load more or
              search to surface additional values.
            </p>
          ) : null}
        </div>

        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label="Filter by goal"
        >
          <span className="mr-1 text-xs font-medium text-muted-foreground">
            Goal
          </span>
          <button
            type="button"
            aria-pressed={goal === ""}
            onClick={() => setState({ goal: "" })}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              goal === ""
                ? "border-foreground bg-foreground text-background"
                : "hover:bg-muted",
            )}
          >
            All
          </button>
          {Array.from(new Set(["newsletter", ...options.goals])).map(
            (value) => (
              <button
                key={value}
                type="button"
                aria-pressed={goal === value}
                onClick={() => setState({ goal: value })}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  goal === value
                    ? "border-foreground bg-foreground text-background"
                    : "hover:bg-muted",
                )}
              >
                {humanize(value)}
              </button>
            ),
          )}
        </div>
      </header>

      <LazyTemplateDiscoveryTools
        currentFilters={currentDiscoveryFilters}
        compareSelection={compareSelection}
        organizerTemplate={organizerTemplate}
        onRemoveCompare={(id) =>
          setCompareSelection((current) =>
            current.filter((template) => template.id !== id),
          )
        }
        onClearCompare={() => setCompareSelection([])}
        onOrganizerTemplateChange={setOrganizerTemplate}
        onApplySavedSearch={applySavedSearch}
      />

      {selected.size > 0 ? (
        <TemplatesBulkBar
          count={selected.size}
          favoriteableCount={favoriteableSelected().length}
          archivableCount={archivableSelected().length}
          restorableCount={restorableSelected().length}
          onClear={clearSelection}
          onFavorite={bulkFavorite}
          onArchive={bulkArchive}
          onRestore={bulkRestore}
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {error && !showingStaleResults
            ? "Results unavailable"
            : showingStaleResults
              ? `Showing ${displayItems.length.toLocaleString()} previously loaded design${displayItems.length === 1 ? "" : "s"} · Refresh failed`
              : loading
                ? "Finding designs…"
                : `Showing ${displayItems.length.toLocaleString()} of ${result.total.toLocaleString()} design${result.total === 1 ? "" : "s"}`}
        </p>
        <div className="flex items-center gap-3">
          {displayItems.length ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-pressed={allLoadedSelected}
              onClick={toggleAllLoaded}
            >
              {allLoadedSelected
                ? "Deselect loaded"
                : `Select ${displayItems.length.toLocaleString()} loaded`}
            </Button>
          ) : null}
          {activeFilterCount ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {activeFilterCount} active filter
              {activeFilterCount === 1 ? "" : "s"}
            </span>
          ) : null}
          <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <span className="sr-only sm:not-sr-only">Sort</span>
            <Select
              aria-label="Sort designs"
              value={sort}
              onChange={(event) =>
                setState({
                  sort: event.target.value as CampaignTemplateSortKey,
                })
              }
              className="h-8 w-40"
            >
              {CAMPAIGN_TEMPLATE_SORTS.map((key) => (
                <option key={key} value={key}>
                  {SORT_LABELS[key]}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </div>

      {error ? (
        <Alert variant={showingStaleResults ? "warning" : "destructive"}>
          <AlertTitle>
            {showingStaleResults
              ? "Refresh failed"
              : failureKind === "favorites-access-denied"
                ? "Favorites aren’t available in this workspace"
                : failureKind === "catalog-unavailable"
                  ? "Template catalogue temporarily unavailable"
                  : "Templates could not be loaded"}
          </AlertTitle>
          <AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <span>
              {showingStaleResults
                ? `Showing the last verified results because the refresh failed: ${error}`
                : failureKind === "favorites-access-denied"
                  ? "Your templates are unchanged. Ask a workspace admin for personal-library access, or keep browsing the shared inspiration catalogue."
                  : failureKind === "catalog-unavailable"
                    ? "The template catalogue could not be reached. No local or previously saved design was removed."
                    : error}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                if (
                  !showingStaleResults &&
                  failureKind === "favorites-access-denied"
                ) {
                  setState(libraryViewPatch("inspiration"));
                  return;
                }
                setRetryNonce((value) => value + 1);
              }}
            >
              {!showingStaleResults && failureKind === "favorites-access-denied"
                ? "Browse inspiration"
                : "Try again"}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <section
        id="template-library-results"
        role="tabpanel"
        aria-labelledby={`template-library-tab-${view}`}
      >
        {loading && result.items.length === 0 ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }, (_, index) => (
              <CardSkeleton key={index} />
            ))}
          </div>
        ) : result.items.length === 0 ? (
          // Suppress the "no results" empty card while an error is showing —
          // a server failure isn't a too-narrow-filters problem (TMPL-001).
          error ? null : (
            <Card>
              {view === "favorites" && !hasActiveQueryOrFilter ? (
                <EmptyState
                  icon={Star}
                  title="No favorite designs yet"
                  description="Use the star on any available design to keep a private shortlist in this workspace."
                  action={
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setState(libraryViewPatch("inspiration"))}
                    >
                      Browse inspiration
                    </Button>
                  }
                />
              ) : view === "mine" &&
                archived === "archived" &&
                !search &&
                activeFilterCount === 1 ? (
                <EmptyState
                  icon={Archive}
                  title="No archived templates"
                  description="Templates you archive will stay safely recoverable here. Your active library is unchanged."
                  action={
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setState({ archived: "active" })}
                    >
                      View active templates
                    </Button>
                  }
                />
              ) : hasActiveQueryOrFilter ? (
                <EmptyState
                  icon={Search}
                  title="No designs match these filters"
                  description="Broaden the style, layout, or industry filters, or generate a new design directly from your brief."
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={clearFilters}
                      >
                        Clear filters
                      </Button>
                      {canCreateTemplates ? (
                        <Button
                          type="button"
                          onClick={openGenerate}
                          disabled={generationAvailability !== "available"}
                        >
                          <Sparkles className="h-4 w-4" />
                          {generationAvailability === "available"
                            ? "Generate design"
                            : generationAvailability === "checking"
                              ? "Checking AI availability…"
                              : generationAvailability === "error"
                                ? "AI temporarily unavailable"
                                : "AI designs · Coming soon"}
                        </Button>
                      ) : null}
                    </div>
                  }
                />
              ) : view === "mine" ? (
                <EmptyState
                  icon={LayoutGrid}
                  title="You haven’t made a template yet"
                  description="Start from a ready-to-use design in Inspiration, save a finished campaign as a template, or build one from scratch. Your templates appear here."
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button
                        type="button"
                        onClick={() => setState(libraryViewPatch("inspiration"))}
                      >
                        Browse inspiration
                      </Button>
                      {canCreateTemplates ? (
                        <Button asChild variant="outline">
                          <Link href={asRoute("/app/templates/new")}>
                            Create template
                          </Link>
                        </Button>
                      ) : null}
                    </div>
                  }
                />
              ) : (
                <EmptyState
                  icon={LayoutGrid}
                  title="No designs for this goal yet"
                  description="The catalogue has nothing for this goal right now. Show every goal, or create a design of your own."
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button type="button" onClick={() => setState({ goal: "" })}>
                        Show all goals
                      </Button>
                      {canCreateTemplates ? (
                        <Button asChild variant="outline">
                          <Link href={asRoute("/app/templates/new")}>
                            Create template
                          </Link>
                        </Button>
                      ) : null}
                    </div>
                  }
                />
              )}
            </Card>
          )
        ) : (
          <GalleryComponent
            templates={displayItems}
            galleryPath={galleryPath}
            selected={selected}
            compareSelectedIds={compareSelectedIds}
            loading={loading}
            loadingMore={loadingMore}
            onToggleFavorite={(template) => void toggleFavorite(template)}
            onDuplicate={(template) => void duplicate(template)}
            onArchive={(template) => void changeLifecycle(template, "archived")}
            onRestore={(template) => void changeLifecycle(template, "active")}
            onToggleSelect={toggleSelect}
            onToggleCompare={toggleCompare}
            onAddToCollection={setOrganizerTemplate}
          />
        )}
      </section>

      {!error && hasMore && result.items.length ? (
        <div className="flex justify-center pt-2">
          <Button
            type="button"
            variant="outline"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? "Loading more…" : "Load more designs"}
          </Button>
        </div>
      ) : null}

      {canCreateTemplates && generateActivated ? (
        <LazyGenerateTemplateDialog
          open={generateOpen}
          onOpenChange={setGenerateOpen}
          templates={result.items}
        />
      ) : null}
    </div>
  );
}

/**
 * Templates — campaign template library (v2).
 *
 * The v2 rewrite (audit-driven; see commit "feat(templates) v2") turns
 * the page from a hardcoded starter row + flat library grid into a
 * real discovery surface:
 *
 *   - Stat tiles (Total / Used 30d / Most used / Favorites) backed by
 *     /api/v1/campaign-templates/stats.
 *   - Source tabs: All · Moosewave Gallery · Team · Mine · Favorites.
 *   - Goal filter rail (Welcome / Newsletter / Announcement /
 *     Promotional / Re-engagement / Transactional / Automation) with
 *     per-bucket counts from /api/v1/campaign-templates/goals.
 *   - Safe image previews with an inert unavailable state; catalog cards
 *     never execute operator-provided template HTML.
 *   - Per-card favorite star + usage badge + featured badge.
 *   - Slideover gains real device/dark preview, variables editor,
 *     clone button (see TemplateDetailSlideover).
 *   - Server-side filtering — the list endpoint accepts query / goal /
 *     source / favorited via api.listCampaignTemplates(opts).
 *
 * The four hardcoded starter cards from v1 are gone — the migration
 * 0187 backfill seeded equivalent platform templates that surface via
 * the gallery tab + goal filter, so the starter row was structurally
 * duplicating the gallery.
 */

import {
  type Dispatch,
  type MutableRefObject,
  type ReactElement,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ConfirmModal } from "../components/ConfirmModal";
import { TemplateDetailSlideover } from "../components/TemplateDetailSlideover";
import { AiTemplateGeneratorModal } from "../components/templates/AiTemplateGeneratorModal";
import { TemplateDiscoveryHub } from "../components/templates/TemplateDiscoveryHub";
import { TemplateLeaderboardSection } from "../components/templates/TemplateLeaderboardSection";
import {
  TemplateLibraryBody,
  TemplatesOverview,
} from "../components/templates/TemplatesLibraryView";
import {
  decodeCampaignTemplate,
  decodeSavedBlock,
  decodeSavedBlockDeleteReceipt,
  decodeSavedBlocks,
  decodeTemplateGoalCounts,
  decodeTemplateSearchResponse,
  decodeTemplateStats,
} from "../components/templates/template-runtime";
import {
  EMPTY_TEMPLATE_CREATE_DRAFT as EMPTY_DRAFT,
  type SavedBlockDraft,
  type TemplateCreateDraft as CreateDraft,
  TemplateCreateModal,
  SavedBlockCreateModal,
  type TemplateSource as Source,
  templateSlugify as slugify,
  validateSavedBlockDraft,
} from "../components/templates/TemplateLibraryPrimitives";
import { toast } from "../components/Toast";
import { usePersistentLifecycleOperation } from "../hooks/usePersistentLifecycleOperation";
import { useDiscardOnlyDraftLifecycle } from "../hooks/useSettingsDraftLifecycle";
import {
  type CampaignTemplate,
  type SavedBlock,
  type TemplateGoal,
  type TemplateGoalCount,
  type TemplateStats,
  api,
  apiSendTimeAssets,
} from "../lib/api-client";
import { queueReceiptMessage } from "../lib/api/result";
import {
  campaignTemplateDiscoveryApi,
  type CampaignTemplateSavedSearchFilters,
} from "../lib/api/campaign-template-discovery";
import {
  type CampaignTemplateDiscoveryLifecycle,
  type CampaignTemplateDiscoverySort,
  type CampaignTemplateDiscoveryView,
  readCampaignTemplateDiscoveryPreferences,
  writeCampaignTemplateDiscoveryPreferences,
} from "../lib/campaign-template-discovery-preferences";
import {
  appendCampaignTemplatePage,
  CAMPAIGN_TEMPLATE_PAGE_SIZE,
  hasMoreCampaignTemplates,
} from "../lib/campaign-template-pagination";
import { writeClipboardText } from "../lib/clipboard";
import { consumeDesktopTaskIntent } from "../lib/desktop-task-intents";
import { desktopRouteIdentityScope } from "../lib/desktop-router";
import {
  consumePendingDeepLinkTarget,
  onPendingDeepLinkTarget,
} from "../lib/deep-link";
import {
  remoteFailureFromError,
  type RemoteApiError,
} from "../lib/remote-resource";
import { setSection, useCanWrite, useMe } from "../lib/store";
import { useWriteDesktopTaskIntent } from "../hooks/useDesktopTaskIntent";

function exactCount(value: number | null | undefined): string {
  return Number.isFinite(value)
    ? Math.max(0, value ?? 0).toLocaleString()
    : "0";
}

function safeTemplateFailure(error: RemoteApiError): string {
  const failure = remoteFailureFromError(error);
  const references = [
    failure.code ? `Code ${failure.code}.` : null,
    failure.requestId ? `Request ${failure.requestId}.` : null,
  ].filter(Boolean);
  return [failure.message, ...references].join(" ");
}

function unexpectedTemplateFailure(): string {
  return safeTemplateFailure({ kind: "network" });
}

function invalidTemplateResponse(resource: string): string {
  return `The server returned an invalid ${resource} response. No unverified data was applied. Refresh after the service contract is repaired.`;
}

function templateTotalLabel(
  rows: CampaignTemplate[] | null,
  total: number | null,
  loading: boolean,
): string {
  if (!rows)
    return loading ? "Loading template catalog…" : "Template count unavailable";
  const knownTotal = total ?? rows.length;
  const label =
    knownTotal.toLocaleString() + " template" + (knownTotal === 1 ? "" : "s");
  return rows.length < knownTotal
    ? `${rows.length.toLocaleString()} of ${label}`
    : label;
}

function useTemplateSelectionController(
  rows: CampaignTemplate[] | null,
  onRecentViewRecorded: () => void,
) {
  const [selectedId, setSelectedIdState] = useState<string | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] =
    useState<CampaignTemplate | null>(null);
  const [pendingDeepLinkId, setPendingDeepLinkId] = useState<string | null>(
    null,
  );
  const [deepLinkBusyId, setDeepLinkBusyId] = useState<string | null>(null);
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  const [failedDeepLinkId, setFailedDeepLinkId] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const deepLinkSequence = useRef(0);

  useEffect(
    () => () => {
      mountedRef.current = false;
      deepLinkSequence.current += 1;
    },
    [],
  );

  const recordRecentView = useCallback(
    (template: CampaignTemplate): void => {
      void campaignTemplateDiscoveryApi
        .recordView(template.id)
        .then((response) => {
          if (!mountedRef.current) return;
          if (response.error) {
            toast.error({
              message: "Template opened, but recent history was not updated.",
              detail: safeTemplateFailure(response.error),
            });
            return;
          }
          onRecentViewRecorded();
        })
        .catch(() => {
          if (mountedRef.current) {
            toast.error({
              message: "Template opened, but recent history was not updated.",
              detail: unexpectedTemplateFailure(),
            });
          }
        });
    },
    [onRecentViewRecorded],
  );

  const openVerifiedId = useCallback(
    (id: string): void => {
      const requestId = ++deepLinkSequence.current;
      setDeepLinkBusyId(id);
      setDeepLinkError(null);
      setFailedDeepLinkId(null);
      void (async (): Promise<void> => {
        try {
          const response = await api.getCampaignTemplate(id);
          if (!mountedRef.current || requestId !== deepLinkSequence.current) {
            return;
          }
          if (response.error) {
            setDeepLinkError(safeTemplateFailure(response.error));
            setFailedDeepLinkId(id);
            return;
          }
          const template = decodeCampaignTemplate(response.data);
          if (!template) {
            setDeepLinkError(invalidTemplateResponse("template detail"));
            setFailedDeepLinkId(id);
            return;
          }
          setSelectedSnapshot(template);
          setSelectedIdState(template.id);
          recordRecentView(template);
        } catch {
          if (mountedRef.current && requestId === deepLinkSequence.current) {
            setDeepLinkError(unexpectedTemplateFailure());
            setFailedDeepLinkId(id);
          }
        } finally {
          if (mountedRef.current && requestId === deepLinkSequence.current) {
            setDeepLinkBusyId(null);
          }
        }
      })();
    },
    [recordRecentView],
  );

  useEffect(() => {
    const accept = (target: { section: string; id: string } | null): void => {
      if (target?.section === "templates" && target.id) {
        setPendingDeepLinkId(target.id);
      }
    };
    accept(consumePendingDeepLinkTarget());
    return onPendingDeepLinkTarget((target) => {
      if (target.section !== "templates") return;
      consumePendingDeepLinkTarget();
      accept(target);
    });
  }, []);

  useEffect(() => {
    if (!pendingDeepLinkId) return;
    const id = pendingDeepLinkId;
    setPendingDeepLinkId(null);
    openVerifiedId(id);
  }, [openVerifiedId, pendingDeepLinkId]);

  const selected = useMemo<CampaignTemplate | null>(() => {
    if (!selectedId) return null;
    return rows?.find((row) => row.id === selectedId) ?? selectedSnapshot;
  }, [rows, selectedId, selectedSnapshot]);

  const cancelPending = useCallback((): void => {
    deepLinkSequence.current += 1;
    setDeepLinkBusyId(null);
    setDeepLinkError(null);
    setFailedDeepLinkId(null);
  }, []);
  const select = useCallback(
    (template: CampaignTemplate): void => {
      openVerifiedId(template.id);
    },
    [openVerifiedId],
  );
  const setSelectedId = useCallback(
    (id: string | null): void => {
      cancelPending();
      setSelectedSnapshot((current) => (current?.id === id ? current : null));
      setSelectedIdState(id);
    },
    [cancelPending],
  );

  return {
    closeSelected: (): void => setSelectedId(null),
    deepLinkBusyId,
    deepLinkError,
    failedDeepLinkId,
    retryDeepLink: (): void => {
      if (failedDeepLinkId) setPendingDeepLinkId(failedDeepLinkId);
    },
    select,
    selected,
    selectedId,
    setSelectedId,
    setSelectedSnapshot,
    updateFavoriteSnapshot: (
      id: string,
      isFavorited: boolean | undefined,
    ): void => {
      setSelectedSnapshot((current) =>
        current?.id === id
          ? { ...current, is_favorited: isFavorited }
          : current,
      );
    },
  };
}

function useTemplateFavoriteController({
  catalogGenerationRef,
  identityScope,
  refreshCatalog,
  refreshStats,
  rows,
  source,
  setRows,
  setTotal,
  updateFavoriteSnapshot,
}: {
  catalogGenerationRef: MutableRefObject<number>;
  identityScope: string | null;
  refreshCatalog: () => Promise<void>;
  refreshStats: () => Promise<void>;
  rows: CampaignTemplate[] | null;
  source: Source;
  setRows: Dispatch<SetStateAction<CampaignTemplate[] | null>>;
  setTotal: Dispatch<SetStateAction<number | null>>;
  updateFavoriteSnapshot: (
    id: string,
    isFavorited: boolean | undefined,
  ) => void;
}) {
  const [favoriteBusyIds, setFavoriteBusyIds] = useState<Set<string>>(
    () => new Set(),
  );
  const favoriteBusyRef = useRef(new Set<string>());
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const refreshCatalogRef = useRef(refreshCatalog);
  refreshCatalogRef.current = refreshCatalog;
  const mountedRef = useRef(true);
  const identityScopeRef = useRef(identityScope);
  useEffect(() => {
    identityScopeRef.current = identityScope;
    favoriteBusyRef.current.clear();
    setFavoriteBusyIds(new Set());
  }, [identityScope]);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const toggleFavorite = useCallback(
    async (template: CampaignTemplate): Promise<void> => {
      if (!identityScope) return;
      const requestIdentityScope = identityScope;
      const requestCatalogGeneration = catalogGenerationRef.current;
      if (favoriteBusyRef.current.has(template.id)) return;
      favoriteBusyRef.current.add(template.id);
      setFavoriteBusyIds((current) => new Set(current).add(template.id));
      const willFavorite = !template.is_favorited;
      const snapshotRows = rowsRef.current;
      const snapshotIndex =
        snapshotRows?.findIndex((row) => row.id === template.id) ?? -1;
      const snapshot =
        snapshotIndex >= 0
          ? (snapshotRows?.[snapshotIndex] ?? template)
          : template;
      const removedFromFavorites = source === "favorited" && !willFavorite;
      setRows((current) => {
        if (!current) return current;
        if (removedFromFavorites) {
          return current.filter((row) => row.id !== template.id);
        }
        return current.map((row) =>
          row.id === template.id ? { ...row, is_favorited: willFavorite } : row,
        );
      });
      if (removedFromFavorites) {
        setTotal((current) =>
          current === null ? current : Math.max(0, current - 1),
        );
      }
      updateFavoriteSnapshot(template.id, willFavorite);
      const rollback = (): void => {
        if (!mountedRef.current) return;
        setRows((current) => {
          if (!current) return current;
          const currentIndex = current.findIndex(
            (row) => row.id === template.id,
          );
          if (currentIndex >= 0) {
            return current.map((row, index) =>
              index === currentIndex ? snapshot : row,
            );
          }
          if (!removedFromFavorites) return current;
          const next = [...current];
          next.splice(
            Math.min(Math.max(snapshotIndex, 0), next.length),
            0,
            snapshot,
          );
          return next;
        });
        if (removedFromFavorites) {
          setTotal((current) => (current === null ? current : current + 1));
        }
        updateFavoriteSnapshot(template.id, snapshot.is_favorited);
      };
      const reconcileFailure = (): void => {
        if (catalogGenerationRef.current === requestCatalogGeneration) {
          rollback();
          return;
        }
        void refreshCatalogRef.current();
      };
      try {
        const response = willFavorite
          ? await api.favoriteCampaignTemplate(template.id)
          : await api.unfavoriteCampaignTemplate(template.id);
        if (
          !mountedRef.current ||
          identityScopeRef.current !== requestIdentityScope
        ) {
          return;
        }
        if (response.error) {
          toast.error({
            message: willFavorite
              ? "Couldn't favorite template"
              : "Couldn't remove template from favorites",
            detail: safeTemplateFailure(response.error),
          });
          reconcileFailure();
          return;
        }
        void refreshStats();
      } catch {
        if (
          mountedRef.current &&
          identityScopeRef.current === requestIdentityScope
        ) {
          reconcileFailure();
          toast.error({
            message: "The favorite request did not complete.",
            detail: unexpectedTemplateFailure(),
          });
        }
      } finally {
        if (identityScopeRef.current === requestIdentityScope) {
          favoriteBusyRef.current.delete(template.id);
        }
        if (
          mountedRef.current &&
          identityScopeRef.current === requestIdentityScope
        ) {
          setFavoriteBusyIds((current) => {
            const next = new Set(current);
            next.delete(template.id);
            return next;
          });
        }
      }
    },
    [
      identityScope,
      catalogGenerationRef,
      refreshStats,
      setRows,
      setTotal,
      source,
      updateFavoriteSnapshot,
    ],
  );

  return { favoriteBusyIds, toggleFavorite };
}

function useTemplateRecordCallbacks({
  refreshStats,
  selectedId,
  source,
  setRows,
  setSelectedId,
  setSelectedSnapshot,
  setTotal,
}: {
  refreshStats: () => Promise<void>;
  selectedId: string | null;
  source: Source;
  setRows: Dispatch<SetStateAction<CampaignTemplate[] | null>>;
  setSelectedId: (id: string | null) => void;
  setSelectedSnapshot: Dispatch<SetStateAction<CampaignTemplate | null>>;
  setTotal: Dispatch<SetStateAction<number | null>>;
}) {
  const update = useCallback(
    (template: CampaignTemplate): void => {
      setRows(
        (current) =>
          current?.map((row) => (row.id === template.id ? template : row)) ??
          current,
      );
      setSelectedSnapshot(template);
    },
    [setRows, setSelectedSnapshot],
  );
  const deleted = useCallback(
    (id: string): void => {
      setRows(
        (current) =>
          current?.filter((template) => template.id !== id) ?? current,
      );
      if (selectedId === id) setSelectedId(null);
      setTotal((current) =>
        current === null ? current : Math.max(0, current - 1),
      );
      void refreshStats();
    },
    [refreshStats, selectedId, setRows, setSelectedId, setTotal],
  );
  const favoriteChanged = useCallback(
    (template: CampaignTemplate): void => {
      setRows((current) => {
        if (!current) return current;
        if (source === "favorited" && !template.is_favorited) {
          return current.filter((row) => row.id !== template.id);
        }
        return current.map((row) =>
          row.id === template.id
            ? { ...row, is_favorited: template.is_favorited }
            : row,
        );
      });
      if (source === "favorited" && !template.is_favorited) {
        setTotal((current) =>
          current === null ? current : Math.max(0, current - 1),
        );
      }
      setSelectedSnapshot(template);
      void refreshStats();
    },
    [refreshStats, setRows, setSelectedSnapshot, setTotal, source],
  );
  return { deleted, favoriteChanged, update };
}

function useTemplateStatsRefresh({
  mountedRef,
  setStats,
  setWarnings,
  statsSequence,
}: {
  mountedRef: MutableRefObject<boolean>;
  setStats: Dispatch<SetStateAction<TemplateStats | null>>;
  setWarnings: Dispatch<SetStateAction<string[]>>;
  statsSequence: MutableRefObject<number>;
}): () => Promise<void> {
  return useCallback(async (): Promise<void> => {
    const requestId = ++statsSequence.current;
    try {
      const response = await api.getCampaignTemplateStats();
      if (!mountedRef.current || requestId !== statsSequence.current) return;
      if (response.error) {
        const failure = remoteFailureFromError(response.error);
        if (failure.access === "denied") setStats(null);
        setWarnings((current) => [
          ...current.filter((item) => !item.startsWith("Library statistics")),
          `Library statistics: ${safeTemplateFailure(response.error)}`,
        ]);
      } else {
        const nextStats = decodeTemplateStats(response.data);
        if (!nextStats) {
          setWarnings((current) => [
            ...current.filter((item) => !item.startsWith("Library statistics")),
            `Library statistics: ${invalidTemplateResponse("template statistics")}`,
          ]);
          return;
        }
        setStats(nextStats);
        setWarnings((current) =>
          current.filter((item) => !item.startsWith("Library statistics")),
        );
      }
    } catch {
      if (mountedRef.current && requestId === statsSequence.current) {
        setWarnings((current) => [
          ...current.filter((item) => !item.startsWith("Library statistics")),
          "Library statistics could not be refreshed.",
        ]);
      }
    }
  }, [mountedRef, setStats, setWarnings, statsSequence]);
}

function useDebouncedTemplateQuery(
  query: string,
  composing: boolean,
  identityScope: string | null,
): string {
  const [debounced, setDebounced] = useState<{
    identityScope: string | null;
    query: string;
  }>({ identityScope, query: "" });
  useEffect(() => {
    if (composing) return;
    const timer = window.setTimeout(
      () => setDebounced({ identityScope, query }),
      280,
    );
    return () => window.clearTimeout(timer);
  }, [composing, identityScope, query]);
  return debounced.identityScope === identityScope ? debounced.query : "";
}

function templateApiSource(
  source: Source,
): "all" | "platform" | "team" | "mine" {
  return source === "favorited" ||
    source === "archived" ||
    source === "all" ||
    source === "saved_blocks"
    ? "all"
    : source;
}

function useUnmountInvalidation(
  mountedRef: MutableRefObject<boolean>,
  listSequence: MutableRefObject<number>,
  statsSequence: MutableRefObject<number>,
): void {
  useEffect(
    () => () => {
      mountedRef.current = false;
      listSequence.current += 1;
      statsSequence.current += 1;
    },
    [listSequence, mountedRef, statsSequence],
  );
}

function useTemplateGoalCountMap(
  goals: TemplateGoalCount[],
): Map<string, number> {
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const goal of goals) counts.set(goal.goal, goal.count);
    return counts;
  }, [goals]);
}

function useCloseLostSelection(
  rows: CampaignTemplate[] | null,
  error: string | null,
  hasVerifiedListRef: MutableRefObject<boolean>,
  close: (id: string | null) => void,
): void {
  useEffect(() => {
    if (rows === null && error && !hasVerifiedListRef.current) close(null);
  }, [close, error, hasVerifiedListRef, rows]);
}

function useTemplateLibraryController(
  onRecentViewRecorded: () => void,
  identityScope: string | null,
) {
  const [rows, setRows] = useState<CampaignTemplate[] | null>(null);
  const [stats, setStats] = useState<TemplateStats | null>(null);
  const [goals, setGoals] = useState<TemplateGoalCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [catalogPage, setCatalogPage] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [stale, setStale] = useState(false);
  const [lastVerifiedAt, setLastVerifiedAt] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [queryComposing, setQueryComposing] = useState(false);
  const debouncedQuery = useDebouncedTemplateQuery(
    query,
    queryComposing,
    identityScope,
  );
  const [source, setSource] = useState<Source>("all");
  const [goalFilter, setGoalFilter] = useState<TemplateGoal | "">("");
  const [sort, setSort] =
    useState<CampaignTemplateDiscoverySort>("recommended");
  const [view, setView] = useState<CampaignTemplateDiscoveryView>("grid");
  const [lifecycle, setLifecycle] =
    useState<CampaignTemplateDiscoveryLifecycle>("active");
  const [preferencesHydratedScope, setPreferencesHydratedScope] = useState<
    string | null
  >(null);
  const mountedRef = useRef(true);
  const listSequence = useRef(0);
  const statsSequence = useRef(0);
  const loadingRef = useRef(true);
  const loadingMoreRef = useRef(false);
  const loadPromiseRef = useRef<Promise<void> | null>(null);
  const hasVerifiedListRef = useRef(false);
  const catalogAbortRef = useRef<AbortController | null>(null);

  useUnmountInvalidation(mountedRef, listSequence, statsSequence);
  useEffect(
    () => () => {
      catalogAbortRef.current?.abort();
      catalogAbortRef.current = null;
    },
    [],
  );

  useEffect(() => {
    catalogAbortRef.current?.abort();
    catalogAbortRef.current = null;
    listSequence.current += 1;
    statsSequence.current += 1;
    loadPromiseRef.current = null;
    loadingRef.current = true;
    loadingMoreRef.current = false;
    hasVerifiedListRef.current = false;
    setRows(null);
    setStats(null);
    setGoals([]);
    setCatalogPage(0);
    setTotal(null);
    setError(null);
    setPageError(null);
    setWarnings([]);
    setStale(false);
    setLastVerifiedAt(null);
    setLoading(true);
    setLoadingMore(false);
    setQueryComposing(false);
    const preferences = readCampaignTemplateDiscoveryPreferences(identityScope);
    setQuery(preferences.query);
    setGoalFilter(preferences.goal);
    setSource(preferences.source);
    setSort(preferences.sort);
    setView(preferences.view);
    setLifecycle(preferences.lifecycle);
    setPreferencesHydratedScope(identityScope);
  }, [identityScope]);

  useEffect(() => {
    if (!identityScope || preferencesHydratedScope !== identityScope) {
      return;
    }
    writeCampaignTemplateDiscoveryPreferences(identityScope, {
      query,
      goal: goalFilter,
      source,
      sort,
      view,
      lifecycle,
    });
  }, [
    goalFilter,
    identityScope,
    lifecycle,
    preferencesHydratedScope,
    query,
    sort,
    source,
    view,
  ]);

  const load = useCallback(
    (
      options: { supersede?: boolean; refreshSupporting?: boolean } = {},
    ): Promise<void> => {
      if (!identityScope || preferencesHydratedScope !== identityScope) {
        return Promise.resolve();
      }
      if (!options.supersede && loadPromiseRef.current) {
        return loadPromiseRef.current;
      }
      const requestId = ++listSequence.current;
      const statsRequestId = ++statsSequence.current;
      const refreshSupporting = options.refreshSupporting === true;
      catalogAbortRef.current?.abort();
      const controller = new AbortController();
      catalogAbortRef.current = controller;
      loadingRef.current = true;
      loadingMoreRef.current = false;
      setLoading(true);
      setLoadingMore(false);
      setError(null);
      setPageError(null);
      setStale(hasVerifiedListRef.current);
      const templateSource = templateApiSource(source);
      const listOptions = {
        query: debouncedQuery.trim() || undefined,
        goal: goalFilter || undefined,
        source: templateSource,
        favorited: source === "favorited",
        archived: lifecycle,
        sort,
      } as const;

      const task = (async (): Promise<void> => {
        const [listOutcome, statsOutcome, goalsOutcome] =
          await Promise.allSettled([
            Promise.resolve().then(() =>
              api.searchCampaignTemplates(
                {
                  ...listOptions,
                  page: 1,
                  per_page: CAMPAIGN_TEMPLATE_PAGE_SIZE,
                },
                { signal: controller.signal },
              ),
            ),
            refreshSupporting
              ? Promise.resolve().then(() => api.getCampaignTemplateStats())
              : Promise.resolve(null),
            refreshSupporting
              ? Promise.resolve().then(() => api.listCampaignTemplateGoals())
              : Promise.resolve(null),
          ]);
        if (!mountedRef.current || requestId !== listSequence.current) return;

        const nextWarnings: string[] = [];
        let listAccessDenied = false;
        if (listOutcome.status === "rejected") {
          setError(unexpectedTemplateFailure());
        } else if (listOutcome.value.error) {
          const failure = remoteFailureFromError(listOutcome.value.error);
          setError(safeTemplateFailure(listOutcome.value.error));
          if (failure.access === "denied") {
            listAccessDenied = true;
            hasVerifiedListRef.current = false;
            setRows(null);
            setTotal(null);
            setStale(false);
            setStats(null);
            setGoals([]);
            setLastVerifiedAt(null);
          }
        } else {
          const data = decodeTemplateSearchResponse(listOutcome.value.data);
          if (!data) {
            setError(invalidTemplateResponse("template catalog"));
            return;
          }
          const items = data.items;
          const responseTotal = data?.total;
          hasVerifiedListRef.current = true;
          setRows(items);
          let loaded = items;
          let page = Number.isFinite(data?.page) ? Math.max(1, data.page) : 1;
          const expectedTotal = Number.isFinite(responseTotal)
            ? Math.max(items.length, responseTotal)
            : items.length;
          setCatalogPage(page);
          setTotal(expectedTotal);
          setLastVerifiedAt(Date.now());
          setStale(false);

          // A desktop session is commonly used to browse the whole catalog
          // during an offline or in-person demo. Continue through every page
          // automatically so the library is complete without requiring the
          // operator to discover and repeatedly press “Load more”. Keeping
          // this sequential also preserves the server's stable catalog order
          // and makes cancellation on a changed filter immediate.
          while (loaded.length < expectedTotal) {
            const nextResult = await api.searchCampaignTemplates(
              {
                ...listOptions,
                page: page + 1,
                per_page: CAMPAIGN_TEMPLATE_PAGE_SIZE,
              },
              { signal: controller.signal },
            );
            if (!mountedRef.current || requestId !== listSequence.current) {
              return;
            }
            if (nextResult.error) {
              const failure = remoteFailureFromError(nextResult.error);
              const safeFailure = safeTemplateFailure(nextResult.error);
              if (failure.access === "denied") {
                hasVerifiedListRef.current = false;
                setRows(null);
                setTotal(null);
                setStats(null);
                setGoals([]);
                setLastVerifiedAt(null);
                setWarnings([]);
                setPageError(null);
                setError(safeFailure);
              } else {
                setPageError(safeFailure);
              }
              break;
            }
            const nextData = decodeTemplateSearchResponse(nextResult.data);
            if (!nextData) {
              setPageError(invalidTemplateResponse("template catalog page"));
              break;
            }
            const nextItems = nextData.items;
            if (nextItems.length === 0) break;
            loaded = appendCampaignTemplatePage(loaded, nextItems);
            page = Number.isFinite(nextData.page)
              ? Math.max(page + 1, nextData.page)
              : page + 1;
            setRows((current) =>
              appendCampaignTemplatePage(current ?? items, nextItems),
            );
            setCatalogPage(page);
            if (Number.isFinite(nextData.total)) {
              setTotal((current) => Math.max(current ?? 0, nextData.total));
            }
            setLastVerifiedAt(Date.now());
          }
        }

        if (
          refreshSupporting &&
          !listAccessDenied &&
          statsRequestId === statsSequence.current &&
          statsOutcome.status === "fulfilled" &&
          statsOutcome.value
        ) {
          if (statsOutcome.value.error) {
            const failure = remoteFailureFromError(statsOutcome.value.error);
            nextWarnings.push(
              `Library statistics: ${safeTemplateFailure(statsOutcome.value.error)}`,
            );
            if (failure.access === "denied") setStats(null);
          } else {
            const nextStats = decodeTemplateStats(statsOutcome.value.data);
            if (nextStats) setStats(nextStats);
            else {
              nextWarnings.push(invalidTemplateResponse("template statistics"));
            }
          }
        } else if (refreshSupporting && statsOutcome.status === "rejected") {
          nextWarnings.push("Library statistics could not be refreshed.");
        }
        if (listAccessDenied) {
          setGoals([]);
        } else if (refreshSupporting && goalsOutcome.status === "rejected") {
          nextWarnings.push("Template goal counts could not be refreshed.");
        } else if (
          refreshSupporting &&
          goalsOutcome.status === "fulfilled" &&
          goalsOutcome.value?.error
        ) {
          const failure = remoteFailureFromError(goalsOutcome.value.error);
          nextWarnings.push(
            `Template goal counts: ${safeTemplateFailure(goalsOutcome.value.error)}`,
          );
          if (failure.access === "denied") setGoals([]);
        } else if (
          refreshSupporting &&
          goalsOutcome.status === "fulfilled" &&
          goalsOutcome.value
        ) {
          const nextGoals = decodeTemplateGoalCounts(goalsOutcome.value.data);
          if (nextGoals) setGoals(nextGoals);
          else nextWarnings.push(invalidTemplateResponse("template goals"));
        }
        if (listAccessDenied) setWarnings([]);
        else if (refreshSupporting) setWarnings(nextWarnings);
      })();

      let tracked: Promise<void>;
      tracked = task
        .catch(() => {
          if (mountedRef.current && requestId === listSequence.current) {
            setError(unexpectedTemplateFailure());
          }
        })
        .finally(() => {
          if (loadPromiseRef.current === tracked) loadPromiseRef.current = null;
          if (catalogAbortRef.current === controller) {
            catalogAbortRef.current = null;
          }
          if (mountedRef.current && requestId === listSequence.current) {
            loadingRef.current = false;
            setLoading(false);
          }
        });
      loadPromiseRef.current = tracked;
      return tracked;
    },
    [
      debouncedQuery,
      goalFilter,
      identityScope,
      lifecycle,
      preferencesHydratedScope,
      sort,
      source,
    ],
  );

  const loadMore = useCallback(async (): Promise<void> => {
    if (
      !identityScope ||
      preferencesHydratedScope !== identityScope ||
      loadingRef.current ||
      loadingMoreRef.current ||
      rows === null ||
      !hasMoreCampaignTemplates(rows.length, total)
    ) {
      return;
    }
    const requestId = ++listSequence.current;
    const page = catalogPage + 1;
    catalogAbortRef.current?.abort();
    const controller = new AbortController();
    catalogAbortRef.current = controller;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setPageError(null);
    const templateSource = templateApiSource(source);
    try {
      const result = await api.searchCampaignTemplates(
        {
          query: debouncedQuery.trim() || undefined,
          goal: goalFilter || undefined,
          source: templateSource,
          favorited: source === "favorited",
          archived: lifecycle,
          sort,
          page,
          per_page: CAMPAIGN_TEMPLATE_PAGE_SIZE,
        },
        { signal: controller.signal },
      );
      if (!mountedRef.current || requestId !== listSequence.current) return;
      if (result.error) {
        const failure = remoteFailureFromError(result.error);
        const safeFailure = safeTemplateFailure(result.error);
        setPageError(safeFailure);
        if (failure.access === "denied") {
          hasVerifiedListRef.current = false;
          setRows(null);
          setTotal(null);
          setStats(null);
          setGoals([]);
          setLastVerifiedAt(null);
          setWarnings([]);
          setPageError(null);
          setError(safeFailure);
        }
        return;
      }
      const data = decodeTemplateSearchResponse(result.data);
      if (!data) {
        setPageError(invalidTemplateResponse("template catalog page"));
        return;
      }
      const items = data.items;
      setRows((current) => appendCampaignTemplatePage(current ?? rows, items));
      setCatalogPage(
        Number.isFinite(data.page) ? Math.max(1, data.page) : page,
      );
      if (Number.isFinite(data.total)) {
        setTotal((current) => Math.max(current ?? 0, data.total));
      }
      setLastVerifiedAt(Date.now());
      setStale(false);
    } catch {
      if (mountedRef.current && requestId === listSequence.current) {
        setPageError(unexpectedTemplateFailure());
      }
    } finally {
      if (mountedRef.current && requestId === listSequence.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
      if (catalogAbortRef.current === controller) {
        catalogAbortRef.current = null;
      }
    }
  }, [
    catalogPage,
    debouncedQuery,
    goalFilter,
    identityScope,
    lifecycle,
    preferencesHydratedScope,
    rows,
    sort,
    source,
    total,
  ]);

  useEffect(() => {
    if (source === "saved_blocks") {
      listSequence.current += 1;
      loadingRef.current = false;
      loadingMoreRef.current = false;
      setLoading(false);
      setLoadingMore(false);
      return;
    }
    void load({
      supersede: true,
      refreshSupporting: !hasVerifiedListRef.current,
    });
  }, [load, source]);

  const goalCountMap = useTemplateGoalCountMap(goals);

  const refreshStats = useTemplateStatsRefresh({
    mountedRef,
    setStats,
    setWarnings,
    statsSequence,
  });
  const refreshCatalogAfterFavoriteFailure = useCallback(
    () => load({ supersede: true, refreshSupporting: true }),
    [load],
  );

  const selection = useTemplateSelectionController(rows, onRecentViewRecorded);
  useEffect(() => {
    selection.setSelectedId(null);
  }, [identityScope, selection.setSelectedId]);
  useCloseLostSelection(
    rows,
    error,
    hasVerifiedListRef,
    selection.setSelectedId,
  );
  const favorites = useTemplateFavoriteController({
    catalogGenerationRef: listSequence,
    identityScope,
    refreshCatalog: refreshCatalogAfterFavoriteFailure,
    refreshStats,
    rows,
    source,
    setRows,
    setTotal,
    updateFavoriteSnapshot: selection.updateFavoriteSnapshot,
  });
  const recordCallbacks = useTemplateRecordCallbacks({
    refreshStats,
    selectedId: selection.selectedId,
    source,
    setRows,
    setSelectedId: selection.setSelectedId,
    setSelectedSnapshot: selection.setSelectedSnapshot,
    setTotal,
  });
  const changeSource = useCallback((nextSource: Source): void => {
    setSource(nextSource);
    if (nextSource === "archived") {
      setLifecycle("archived");
    } else {
      setLifecycle((current) => (current === "archived" ? "active" : current));
    }
  }, []);
  const changeLifecycle = useCallback(
    (nextLifecycle: CampaignTemplateDiscoveryLifecycle): void => {
      setLifecycle(nextLifecycle);
      if (source === "archived" && nextLifecycle !== "archived") {
        setSource("all");
      } else if (nextLifecycle === "archived") {
        setSource("archived");
      }
    },
    [source],
  );

  return {
    clearFilters: (): void => {
      setSource("all");
      setLifecycle("active");
      setGoalFilter("");
      setQuery("");
      setQueryComposing(false);
    },
    ...selection,
    ...recordCallbacks,
    error,
    ...favorites,
    goalCountMap,
    goalFilter,
    hasMore: hasMoreCampaignTemplates(rows?.length ?? 0, total),
    jumpToGallery: (): void => {
      setSource("platform");
      setLifecycle("active");
      setGoalFilter("");
      setQuery("");
      setQueryComposing(false);
    },
    lastVerifiedAt,
    lifecycle,
    load,
    refreshAll: (): Promise<void> => load({ refreshSupporting: true }),
    loadMore,
    loading,
    loadingMore,
    pageError,
    query,
    queryPending: query !== debouncedQuery,
    rows,
    setGoalFilter,
    setLifecycle: changeLifecycle,
    setQuery,
    setQueryComposing,
    setSort,
    setSource: changeSource,
    setView,
    sort,
    source,
    stale,
    stats,
    total,
    view,
    warnings,
  };
}

function useTemplateCreateController({
  canMutate,
  onReload,
  onSelect,
}: {
  canMutate: boolean;
  onReload: () => Promise<void>;
  onSelect: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CreateDraft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [slugTouched, setSlugTouched] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const mountedRef = useRef(true);
  const operation = usePersistentLifecycleOperation({
    ownerId: "template-create",
    label: "Template create request",
    detail:
      "Wait for the template create request to finish before leaving Moosewave.",
  });

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const dirty =
    open &&
    (draft.name !== EMPTY_DRAFT.name ||
      draft.slug !== EMPTY_DRAFT.slug ||
      draft.kind !== EMPTY_DRAFT.kind ||
      draft.category !== EMPTY_DRAFT.category ||
      draft.goal !== EMPTY_DRAFT.goal ||
      draft.subject !== EMPTY_DRAFT.subject ||
      draft.preview_text !== EMPTY_DRAFT.preview_text ||
      draft.body_html !== EMPTY_DRAFT.body_html);
  const discard = useCallback((): void => {
    setDraft({ ...EMPTY_DRAFT });
    setSlugTouched(false);
    setError(null);
    setDiscardConfirmOpen(false);
    setOpen(false);
  }, []);
  const finishTask = useCallback((): void => {
    discard();
    consumeDesktopTaskIntent("new-template");
  }, [discard]);
  const requestClose = useCallback((): void => {
    if (operation.promiseRef.current) return;
    if (dirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    finishTask();
  }, [dirty, finishTask, operation.promiseRef]);
  useDiscardOnlyDraftLifecycle({
    ownerId: "template-create",
    label: "Template create draft",
    dirty,
    operationRef: operation.promiseRef,
    discard,
    detail:
      "This template has not been created. Return to the form or explicitly discard it.",
    operationDetail:
      "Wait for the template create request to finish before leaving Moosewave.",
    enabled: open,
  });

  const openBlank = useCallback((): void => {
    if (!canMutate) {
      toast.error(
        "Viewer access is read-only. Ask an editor or admin to create templates.",
      );
      return;
    }
    setDraft({ ...EMPTY_DRAFT });
    setSlugTouched(false);
    setError(null);
    setDiscardConfirmOpen(false);
    setOpen(true);
  }, [canMutate]);
  useWriteDesktopTaskIntent({
    intent: "new-template",
    open,
    canMutate,
    onOpen: openBlank,
    onRouteExit: () => setOpen(false),
  });

  const duplicate = async (template: CampaignTemplate): Promise<void> => {
    if (!canMutate) {
      toast.error(
        "Viewer access is read-only. Ask an editor or admin to clone templates.",
      );
      return;
    }
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    const request = operation.run(async (): Promise<void> => {
      try {
        const response = await api.cloneCampaignTemplate(template.id, {
          name: template.name + " (copy)",
        });
        if (!mountedRef.current) return;
        if (response.error) {
          toast.error({
            message: "Template wasn't cloned.",
            detail: `${safeTemplateFailure(response.error)} No fallback copy was created, so retrying cannot duplicate an ambiguous commit.`,
          });
          return;
        }
        const cloned = decodeCampaignTemplate(response.data);
        if (!cloned) {
          toast.error({
            message: "The clone response could not be verified.",
            detail:
              "Refresh the library before retrying; the server may already have created the copy.",
          });
          await onReload().catch(() => undefined);
          return;
        }
        toast.success('Template cloned as "' + cloned.name + '"');
        await onReload();
        if (mountedRef.current) onSelect(cloned.id);
      } catch {
        if (!mountedRef.current) return;
        toast.error({
          message: "The clone request did not complete.",
          detail: `${unexpectedTemplateFailure()} Refresh before retrying so an ambiguous commit is not duplicated.`,
        });
      }
    });
    if (request) await request;
  };

  const submit = async (): Promise<void> => {
    const name = draft.name.trim();
    const slug = draft.slug.trim() || slugify(name);
    if (!name) {
      setError("Name is required.");
      return;
    }
    if (!canMutate) {
      setError(
        "Viewer access is read-only. Ask an editor or admin to create templates.",
      );
      return;
    }
    if (!slug || !/^[a-z][a-z0-9-]{0,79}$/.test(slug)) {
      setError(
        "Slug must start with a letter and use only lowercase letters, digits, or dashes.",
      );
      return;
    }
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    setSubmitting(true);
    setError(null);
    const requestedDraft = { ...draft };
    const request = operation.run(async (): Promise<void> => {
      try {
        const res = await api.createCampaignTemplate(
          {
            slug,
            name,
            subject: requestedDraft.subject,
            preview_text: requestedDraft.preview_text,
            body_html: requestedDraft.body_html,
            category: requestedDraft.category,
            kind: requestedDraft.kind,
            ...(requestedDraft.goal ? { goal: requestedDraft.goal } : {}),
          },
          {},
        );
        if (!mountedRef.current) return;
        if (res.error) {
          setError(safeTemplateFailure(res.error));
          return;
        }
        if (res.queued) {
          finishTask();
          toast.info({
            message: queueReceiptMessage(res.receipt),
            detail:
              "“" +
              name +
              "” will appear after the server confirms the create.",
          });
          return;
        }
        const created = decodeCampaignTemplate(res.data);
        const createdId = created?.id;
        if (!createdId) {
          finishTask();
          toast.error(
            "The template may have been created, but the server returned no template id. Refresh the library before trying again.",
          );
          await onReload().catch(() => undefined);
          return;
        }
        if (!mountedRef.current) return;
        finishTask();
        onSelect(createdId);
        toast.success('Template "' + name + '" created');
        try {
          await onReload();
        } catch {
          if (mountedRef.current) {
            toast.error(
              "The template was created, but the library could not be refreshed. " +
                unexpectedTemplateFailure(),
            );
          }
        }
      } catch {
        if (mountedRef.current) {
          setError(
            "The template create request did not complete. " +
              unexpectedTemplateFailure(),
          );
        }
      } finally {
        if (mountedRef.current) setSubmitting(false);
      }
    });
    if (request) await request;
  };

  return {
    discardConfirmOpen,
    draft,
    duplicate,
    error,
    finishTask,
    open,
    openBlank,
    operationActive: operation.active,
    requestClose,
    setDiscardConfirmOpen,
    setDraft,
    setSlugTouched,
    slugTouched,
    submit,
    submitting,
  };
}

function savedBlockCopyValue(block: SavedBlock): string | null {
  if (block.body_html.trim()) return block.body_html;
  try {
    const json = JSON.stringify(block.body_json, null, 2);
    return json && json !== "{}" && json !== "null" ? json : null;
  } catch {
    return null;
  }
}

function filterSavedBlocks(
  items: SavedBlock[] | null,
  query: string,
): SavedBlock[] | null {
  if (!items) return null;
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return items;
  return items.filter((block) =>
    [block.name, block.kind, block.id].some((value) =>
      value.toLocaleLowerCase().includes(normalized),
    ),
  );
}

function useSavedBlockClipboardController() {
  const [copyBusyIds, setCopyBusyIds] = useState<Set<string>>(() => new Set());
  const [copyStatus, setCopyStatus] = useState<Record<string, string>>({});
  const copyBusyRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const copy = useCallback((block: SavedBlock): void => {
    if (copyBusyRef.current.has(block.id)) return;
    const copyValue = savedBlockCopyValue(block);
    if (!copyValue) {
      setCopyStatus((current) => ({
        ...current,
        [block.id]: "This block has no HTML or JSON content to copy.",
      }));
      return;
    }
    copyBusyRef.current.add(block.id);
    setCopyBusyIds((current) => new Set(current).add(block.id));
    setCopyStatus((current) => ({
      ...current,
      [block.id]: `Copying ${block.name}…`,
    }));
    writeClipboardText(copyValue, {
      contentClass: "personal",
      label: "Saved block",
    })
      .then((result) => {
        if (!mountedRef.current) return;
        if (result.ok) {
          setCopyStatus((current) => ({
            ...current,
            [block.id]: `${block.name} copied. Paste it into a template body.`,
          }));
          toast.success(
            '"' + block.name + '" copied — paste it into a template body',
          );
        } else {
          setCopyStatus((current) => ({
            ...current,
            [block.id]: result.message,
          }));
          toast.error(result.message);
        }
      })
      .catch(() => {
        if (!mountedRef.current) return;
        const message = "The saved block couldn't be copied.";
        setCopyStatus((current) => ({ ...current, [block.id]: message }));
        toast.error(message);
      })
      .finally(() => {
        copyBusyRef.current.delete(block.id);
        if (mountedRef.current) {
          setCopyBusyIds((current) => {
            const next = new Set(current);
            next.delete(block.id);
            return next;
          });
        }
      });
  }, []);

  return { copy, copyBusyIds, copyStatus };
}

function useSavedBlockLibrary(source: Source, canMutate: boolean) {
  const [items, setItems] = useState<SavedBlock[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [lastVerifiedAt, setLastVerifiedAt] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SavedBlock | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [draft, setDraft] = useState<SavedBlockDraft>({
    name: "",
    body_html: "",
    body_json: "{}",
  });
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const mountedRef = useRef(true);
  const readSequence = useRef(0);
  const readPromiseRef = useRef<Promise<void> | null>(null);
  const readAbortRef = useRef<AbortController | null>(null);
  const hasVerifiedItemsRef = useRef(false);
  const operation = usePersistentLifecycleOperation({
    ownerId: "saved-block-library",
    label: "Saved-block library request",
    detail:
      "Wait for the saved-block request to finish before leaving Moosewave.",
  });

  useEffect(
    () => () => {
      mountedRef.current = false;
      readSequence.current += 1;
      readAbortRef.current?.abort();
      readAbortRef.current = null;
    },
    [],
  );

  const load = useCallback(
    (options: { supersede?: boolean } = {}): Promise<void> => {
      if (!options.supersede && readPromiseRef.current) {
        return readPromiseRef.current;
      }
      const requestId = ++readSequence.current;
      readAbortRef.current?.abort();
      const controller = new AbortController();
      readAbortRef.current = controller;
      setLoading(true);
      setLoadError(null);
      setStale(hasVerifiedItemsRef.current);
      const task = Promise.resolve()
        .then(() =>
          apiSendTimeAssets.listSavedBlocks({}, { signal: controller.signal }),
        )
        .then((response) => {
          if (!mountedRef.current || requestId !== readSequence.current) return;
          if (response.error) {
            const failure = remoteFailureFromError(response.error);
            setLoadError(safeTemplateFailure(response.error));
            if (failure.access === "denied") {
              hasVerifiedItemsRef.current = false;
              setItems(null);
              setStale(false);
            }
            return;
          }
          const nextItems = decodeSavedBlocks(response.data);
          if (!nextItems) {
            setLoadError(invalidTemplateResponse("saved-block library"));
            return;
          }
          hasVerifiedItemsRef.current = true;
          setItems(nextItems);
          setLastVerifiedAt(Date.now());
          setStale(false);
        })
        .catch(() => {
          if (mountedRef.current && requestId === readSequence.current) {
            setLoadError(unexpectedTemplateFailure());
          }
        });
      let tracked: Promise<void>;
      tracked = task.finally(() => {
        if (readPromiseRef.current === tracked) readPromiseRef.current = null;
        if (readAbortRef.current === controller) {
          readAbortRef.current = null;
        }
        if (mountedRef.current && requestId === readSequence.current) {
          setLoading(false);
        }
      });
      readPromiseRef.current = tracked;
      return tracked;
    },
    [],
  );

  const dirty =
    createOpen &&
    (draft.name !== "" || draft.body_html !== "" || draft.body_json !== "{}");
  const discardDraft = useCallback((): void => {
    setDraft({ name: "", body_html: "", body_json: "{}" });
    setDiscardConfirmOpen(false);
    setCreateOpen(false);
  }, []);
  const requestClose = useCallback((): void => {
    if (operation.promiseRef.current) return;
    if (dirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    discardDraft();
  }, [dirty, discardDraft, operation.promiseRef]);
  useDiscardOnlyDraftLifecycle({
    ownerId: "saved-block-create",
    label: "Saved block draft",
    dirty,
    operationRef: operation.promiseRef,
    discard: discardDraft,
    detail:
      "This reusable block has not been saved. Return to the form or explicitly discard it.",
    operationDetail:
      "Wait for the saved-block request to finish before leaving Moosewave.",
    enabled: createOpen,
  });

  useEffect(() => {
    if (source !== "saved_blocks") {
      readSequence.current += 1;
      readAbortRef.current?.abort();
      readAbortRef.current = null;
      setLoading(false);
      return;
    }
    void load({ supersede: true });
  }, [load, source]);

  const submit = async (): Promise<void> => {
    const name = draft.name.trim();
    const validation = validateSavedBlockDraft(draft);
    if (validation.nameMissing) {
      toast.error("Block name is required. The draft has been preserved.");
      return;
    }
    if (!canMutate) {
      toast.error(
        "Viewer access is read-only. Ask an editor or admin to save blocks.",
      );
      return;
    }
    if (validation.jsonError) {
      toast.error(`${validation.jsonError} The draft has been preserved.`);
      return;
    }
    if (validation.contentMissing) {
      toast.error(
        "Add HTML or non-empty block JSON before saving this reusable block.",
      );
      return;
    }
    let bodyJson: unknown;
    try {
      bodyJson = draft.body_json ? JSON.parse(draft.body_json) : {};
    } catch {
      toast.error(
        "Block JSON must be valid JSON. The draft has been preserved.",
      );
      return;
    }
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    setSaving(true);
    const requestedHtml = draft.body_html;
    const request = operation.run(async (): Promise<void> => {
      try {
        const response = await apiSendTimeAssets.createSavedBlock({
          name,
          kind: "block",
          body_html: requestedHtml,
          body_json: bodyJson,
        });
        if (!mountedRef.current) return;
        if (response.error) {
          toast.error({
            message: "Saved block wasn't created.",
            detail: safeTemplateFailure(response.error),
          });
          return;
        }
        const created = decodeSavedBlock(response.data);
        if (!created) {
          toast.error({
            message: "The saved-block response could not be verified.",
            detail:
              "The block may already exist. Refresh the saved-block library before retrying so an ambiguous commit is not duplicated.",
          });
          if (source === "saved_blocks") {
            await load({ supersede: true }).catch(() => undefined);
          }
          return;
        }
        toast.success('Saved block "' + name + '"');
        hasVerifiedItemsRef.current = true;
        setItems((current) => {
          const remaining = (current ?? []).filter(
            (item) => item.id !== created.id,
          );
          return [created, ...remaining];
        });
        discardDraft();
        if (source === "saved_blocks") {
          await load({ supersede: true });
        }
      } catch {
        if (mountedRef.current) {
          toast.error({
            message: "Saved block wasn't created.",
            detail: unexpectedTemplateFailure(),
          });
        }
      } finally {
        if (mountedRef.current) setSaving(false);
      }
    });
    if (request) await request;
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    if (!canMutate) {
      toast.error(
        "Viewer access is read-only. Ask an editor or admin to delete blocks.",
      );
      return;
    }
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    const target = deleteTarget;
    setDeleteBusy(true);
    const request = operation.run(async (): Promise<void> => {
      try {
        const exactRead = await apiSendTimeAssets.getSavedBlock(target.id);
        if (exactRead.error) {
          toast.error({
            message: "Saved block wasn't deleted.",
            detail: safeTemplateFailure(exactRead.error),
          });
          return;
        }
        const current = decodeSavedBlock(exactRead.data);
        if (
          !current ||
          current.id !== target.id ||
          current.version !== target.version
        ) {
          toast.error({
            message: "Saved block wasn't deleted.",
            detail:
              "The saved block changed after it was selected. Refresh and review the current version before deleting it.",
          });
          return;
        }
        const response = await apiSendTimeAssets.deleteSavedBlock(
          target.id,
          current.version,
        );
        if (!mountedRef.current) return;
        if (response.error) {
          toast.error({
            message: "Saved block wasn't deleted.",
            detail: safeTemplateFailure(response.error),
          });
          return;
        }
        if (
          !decodeSavedBlockDeleteReceipt(
            response.data,
            target.id,
            current.version,
          )
        ) {
          toast.error({
            message: "The delete acknowledgement could not be verified.",
            detail:
              "The saved-block library will refresh before the result is trusted.",
          });
          await load({ supersede: true }).catch(() => undefined);
          return;
        }
        setItems((current) =>
          current ? current.filter((item) => item.id !== target.id) : current,
        );
        toast.success("Saved block deleted");
        setDeleteTarget(null);
      } catch {
        if (mountedRef.current) {
          toast.error({
            message: "Saved block wasn't deleted.",
            detail: unexpectedTemplateFailure(),
          });
        }
      } finally {
        if (mountedRef.current) setDeleteBusy(false);
      }
    });
    if (request) await request;
  };

  const clipboard = useSavedBlockClipboardController();
  return {
    closeDelete: (): void => {
      if (!operation.promiseRef.current) setDeleteTarget(null);
    },
    confirmDelete,
    ...clipboard,
    createOpen,
    deleteBusy,
    deleteTarget,
    discardConfirmOpen,
    discardDraft,
    draft,
    items,
    lastVerifiedAt,
    load,
    loadError,
    loading,
    openCreate: (): void => {
      if (!canMutate) return;
      setDiscardConfirmOpen(false);
      setCreateOpen(true);
    },
    operationActive: operation.active,
    requestClose,
    requestDelete: (block: SavedBlock): void => {
      if (canMutate && !operation.promiseRef.current) setDeleteTarget(block);
    },
    saving,
    setDiscardConfirmOpen,
    setDraft,
    submit,
    stale,
  };
}

function TemplatesIdentitySurface({
  canMutate,
  discoveryRecoveryScope,
}: {
  canMutate: boolean;
  discoveryRecoveryScope: string | null;
}): ReactElement {
  const [recentRefreshToken, setRecentRefreshToken] = useState(0);
  const [compareSelection, setCompareSelection] = useState<string[]>([]);
  const onRecentViewRecorded = useCallback(
    () => setRecentRefreshToken((current) => current + 1),
    [],
  );
  const library = useTemplateLibraryController(
    onRecentViewRecorded,
    discoveryRecoveryScope,
  );
  const compareIds = useMemo(
    () => new Set(compareSelection),
    [compareSelection],
  );
  useEffect(() => {
    setCompareSelection([]);
    setRecentRefreshToken(0);
  }, [discoveryRecoveryScope]);

  const toggleCompare = useCallback((template: CampaignTemplate): void => {
    setCompareSelection((current) => {
      if (current.includes(template.id)) {
        return current.filter((id) => id !== template.id);
      }
      if (current.length >= 4) {
        toast.info(
          "Compare up to four templates at a time. Remove one from the tray first.",
        );
        return current;
      }
      return [...current, template.id];
    });
  }, []);

  const applySavedSearch = useCallback(
    (filters: CampaignTemplateSavedSearchFilters): void => {
      library.setQuery(filters.q ?? "");
      library.setQueryComposing(false);
      library.setGoalFilter(filters.goal ?? "");
      let nextSource: Source = "all";
      if (filters.source) {
        nextSource = filters.source;
      } else if (filters.favorited) {
        nextSource = "favorited";
      } else if (filters.archived === "archived") {
        nextSource = "archived";
      }
      library.setSource(nextSource);
      library.setLifecycle(filters.archived ?? "active");
      library.setSort(filters.sort ?? "recommended");
      toast.success(
        "Supported saved-search filters were applied to the template library.",
      );
    },
    [library],
  );

  // Roadmap R7: on-brand AI template generator modal. The modal owns
  // its own generate/review/save lifecycle; the page only reloads and
  // opens the saved row.
  const [aiOpen, setAiOpen] = useState(false);
  const [aiAdaptSource, setAiAdaptSource] = useState<CampaignTemplate | null>(
    null,
  );
  const savedBlockLibrary = useSavedBlockLibrary(library.source, canMutate);
  const templateCreate = useTemplateCreateController({
    canMutate,
    onReload: library.refreshAll,
    onSelect: library.setSelectedId,
  });
  const visibleSavedBlocks = useMemo(
    () => filterSavedBlocks(savedBlockLibrary.items, library.query),
    [library.query, savedBlockLibrary.items],
  );
  const savedBlockTotal = savedBlockLibrary.items?.length ?? null;
  const totalLabel =
    library.source === "saved_blocks"
      ? visibleSavedBlocks && savedBlockTotal !== null
        ? `${visibleSavedBlocks.length < savedBlockTotal ? `${exactCount(visibleSavedBlocks.length)} of ` : ""}${exactCount(savedBlockTotal)} loaded saved block${savedBlockTotal === 1 ? "" : "s"}`
        : savedBlockLibrary.loading
          ? "Loading saved blocks…"
          : "Loaded saved-block count unavailable"
      : templateTotalLabel(library.rows, library.total, library.loading);

  return (
    <div className="tpl-page-surface">
      <TemplatesOverview
        canMutate={canMutate}
        deepLinkBusyId={library.deepLinkBusyId}
        deepLinkError={library.deepLinkError}
        error={library.source === "saved_blocks" ? null : library.error}
        failedDeepLinkId={library.failedDeepLinkId}
        goalCountMap={library.goalCountMap}
        goalFilter={library.goalFilter}
        lastVerifiedAt={
          library.source === "saved_blocks" ? null : library.lastVerifiedAt
        }
        lifecycle={library.lifecycle}
        loading={
          library.source === "saved_blocks"
            ? savedBlockLibrary.loading
            : library.loading
        }
        query={library.query}
        queryPending={
          library.source === "saved_blocks" ? false : library.queryPending
        }
        sort={library.sort}
        source={library.source}
        stale={library.source === "saved_blocks" ? false : library.stale}
        stats={library.stats}
        totalLabel={totalLabel}
        view={library.view}
        warnings={library.source === "saved_blocks" ? [] : library.warnings}
        onGenerate={() => {
          setAiAdaptSource(null);
          setAiOpen(true);
        }}
        onGoalChange={library.setGoalFilter}
        onLifecycleChange={library.setLifecycle}
        onNew={templateCreate.openBlank}
        onQueryChange={library.setQuery}
        onQueryCompositionChange={library.setQueryComposing}
        onRefresh={() => {
          if (library.source === "saved_blocks") {
            void savedBlockLibrary.load();
          } else {
            void library.refreshAll();
          }
        }}
        onRetryDeepLink={library.retryDeepLink}
        onSortChange={library.setSort}
        onSourceChange={(nextSource) => {
          if (
            nextSource === "saved_blocks" ||
            library.source === "saved_blocks"
          ) {
            library.setQuery("");
            library.setQueryComposing(false);
            library.setGoalFilter("");
          }
          library.setSource(nextSource);
        }}
        onViewChange={library.setView}
      />

      <TemplateDiscoveryHub
        key={discoveryRecoveryScope ?? "unresolved-workspace"}
        compareSelection={compareSelection}
        currentGoal={library.goalFilter}
        currentLifecycle={library.lifecycle}
        currentQuery={library.query}
        currentSort={library.sort}
        currentSource={library.source}
        recoveryScope={discoveryRecoveryScope}
        recentRefreshToken={recentRefreshToken}
        rows={library.rows}
        onApplySavedSearch={applySavedSearch}
        onCompareSelectionChange={setCompareSelection}
        onOpenTemplate={library.select}
      />

      <TemplateLibraryBody
        blockOperationActive={savedBlockLibrary.operationActive}
        catalogError={library.error}
        canMutate={canMutate}
        compareIds={compareIds}
        compareLimitReached={compareSelection.length >= 4}
        copyBusyIds={savedBlockLibrary.copyBusyIds}
        copyStatus={savedBlockLibrary.copyStatus}
        favoriteBusyIds={library.favoriteBusyIds}
        goalFilter={library.goalFilter}
        hasMore={library.hasMore}
        loading={library.loading}
        loadingMore={library.loadingMore}
        pageError={library.pageError}
        query={library.query}
        rows={library.rows}
        savedBlockError={savedBlockLibrary.loadError}
        savedBlockLastVerifiedAt={savedBlockLibrary.lastVerifiedAt}
        savedBlockLoading={savedBlockLibrary.loading}
        savedBlockStale={savedBlockLibrary.stale}
        savedBlockTotal={savedBlockTotal}
        savedBlocks={visibleSavedBlocks}
        source={library.source}
        view={library.view}
        onClearFilters={library.clearFilters}
        onDeleteBlock={savedBlockLibrary.requestDelete}
        onInsertBlock={savedBlockLibrary.copy}
        onJumpToGallery={library.jumpToGallery}
        onLoadMore={() => void library.loadMore()}
        onNewBlank={templateCreate.openBlank}
        onOpenTemplate={library.select}
        onSaveBlock={savedBlockLibrary.openCreate}
        onRetrySavedBlocks={() => void savedBlockLibrary.load()}
        onClearSavedBlockSearch={() => {
          library.setQuery("");
          library.setQueryComposing(false);
        }}
        onToggleCompare={toggleCompare}
        onToggleFavorite={(template) => void library.toggleFavorite(template)}
      />

      {/* ----- template performance leaderboard (roadmap R3) -----
          Collapsible + lazy: the events scan only runs when the
          operator expands it. Rendered on every tab — it reports on
          the whole library, not the current filter view. */}
      <TemplateLeaderboardSection />

      {/* ----- detail slide-over ----- */}
      {library.selected ? (
        <TemplateDetailSlideover
          template={library.selected}
          onClose={library.closeSelected}
          onUpdated={library.update}
          onDeleted={library.deleted}
          onDuplicate={(cloned) => {
            library.select(cloned);
            void library.refreshAll();
          }}
          onAdapt={(t) => {
            if (!canMutate) {
              toast.error(
                "Viewer access is read-only. Ask an editor or admin to adapt templates.",
              );
              return;
            }
            setAiAdaptSource(t);
            setAiOpen(true);
          }}
          onFavoriteChanged={library.favoriteChanged}
        />
      ) : null}

      {/* ----- AI generator modal (roadmap R7) ----- */}
      <AiTemplateGeneratorModal
        open={aiOpen}
        adaptSource={aiAdaptSource}
        workspaceScope={discoveryRecoveryScope ?? undefined}
        onClose={() => {
          setAiOpen(false);
          setAiAdaptSource(null);
        }}
        onSaved={(t) => {
          setAiOpen(false);
          setAiAdaptSource(null);
          // Open the saved template immediately (snapshot keeps the
          // slideover alive even if the current filters hide the row),
          // then reconcile the list/stats from the server.
          library.select(t);
          void library.refreshAll();
        }}
        onCampaignCreated={() => {
          setAiOpen(false);
          setAiAdaptSource(null);
          setSection("campaigns");
        }}
        onOpenCampaigns={() => {
          setAiOpen(false);
          setAiAdaptSource(null);
          setSection("campaigns");
        }}
      />

      <TemplateCreateModal
        draft={templateCreate.draft}
        open={templateCreate.open}
        operationActive={templateCreate.operationActive}
        slugTouched={templateCreate.slugTouched}
        submitErr={templateCreate.error}
        submitting={templateCreate.submitting}
        onClose={templateCreate.requestClose}
        onDraftChange={templateCreate.setDraft}
        onSlugTouched={() => templateCreate.setSlugTouched(true)}
        onSubmit={() => void templateCreate.submit()}
      />
      <SavedBlockCreateModal
        draft={savedBlockLibrary.draft}
        open={savedBlockLibrary.createOpen}
        operationActive={savedBlockLibrary.operationActive}
        saving={savedBlockLibrary.saving}
        onClose={savedBlockLibrary.requestClose}
        onDraftChange={savedBlockLibrary.setDraft}
        onSubmit={() => void savedBlockLibrary.submit()}
      />

      {/* Delete-saved-block confirm. Replaces the legacy native confirm()
          so the destructive prompt matches the rest of the admin surface
          and works inside Tauri webviews. */}
      <ConfirmModal
        open={savedBlockLibrary.deleteTarget !== null}
        title="Delete saved block?"
        description={
          savedBlockLibrary.deleteTarget
            ? `Delete saved block "${savedBlockLibrary.deleteTarget.name}" (saved-block ID ${savedBlockLibrary.deleteTarget.id})? It will no longer be insertable into template bodies.`
            : ""
        }
        confirmLabel="Delete block"
        danger
        busy={savedBlockLibrary.deleteBusy}
        onConfirm={savedBlockLibrary.confirmDelete}
        onClose={savedBlockLibrary.closeDelete}
      />
      <ConfirmModal
        open={templateCreate.discardConfirmOpen}
        title="Discard this template?"
        description="The name, content, classification, and body have not been created."
        confirmLabel="Discard template"
        danger
        onConfirm={templateCreate.finishTask}
        onClose={() => templateCreate.setDiscardConfirmOpen(false)}
      />
      <ConfirmModal
        open={savedBlockLibrary.discardConfirmOpen}
        title="Discard this saved block?"
        description="The reusable block name, HTML, and JSON have not been saved."
        confirmLabel="Discard block"
        danger
        onConfirm={savedBlockLibrary.discardDraft}
        onClose={() => savedBlockLibrary.setDiscardConfirmOpen(false)}
      />
    </div>
  );
}

export function Templates(): ReactElement {
  // The key is the complete identity boundary for catalog rows, saved blocks,
  // compare state, and every always-mounted create/AI draft controller.
  const canMutate = useCanWrite();
  const me = useMe();
  const discoveryRecoveryScope = desktopRouteIdentityScope(
    me?.user,
    me?.tenant,
  );
  return (
    <TemplatesIdentitySurface
      key={discoveryRecoveryScope ?? "unresolved-workspace"}
      canMutate={canMutate}
      discoveryRecoveryScope={discoveryRecoveryScope}
    />
  );
}

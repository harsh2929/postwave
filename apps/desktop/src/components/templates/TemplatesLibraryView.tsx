import {
  memo,
  type CSSProperties,
  type ReactElement,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { Card } from "../Card";
import { HeroEmptyState } from "../HeroEmptyState";
import { PendingSyncStatus } from "../PendingSyncStatus";
import {
  TemplateFilters,
  TEMPLATE_GOAL_LABELS as GOAL_LABELS,
  type TemplateKind as Kind,
  type TemplateSource as Source,
} from "./TemplateLibraryPrimitives";
import type {
  CampaignTemplate,
  SavedBlock,
  TemplateGoal,
  TemplateStats,
} from "../../lib/api-client";
import type {
  CampaignTemplateDiscoveryLifecycle,
  CampaignTemplateDiscoverySort,
  CampaignTemplateDiscoveryView,
} from "../../lib/campaign-template-discovery-preferences";
import { HERO } from "../../lib/heroAssets";

import "../../styles-templates-v2.css";
import "../../styles-gift-stats.css";

const TEMPLATE_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "long",
});
const VIRTUALIZE_TEMPLATE_THRESHOLD = 200;
const VIRTUAL_TEMPLATE_GAP_PX = 12;
const VIRTUAL_TEMPLATE_CARD_HEIGHT_PX = 470;
const VIRTUAL_TEMPLATE_COMPACT_HEIGHT_PX = 280;

function exactCount(value: number | null | undefined): string {
  return Number.isFinite(value)
    ? Math.max(0, value ?? 0).toLocaleString()
    : "0";
}

function safeTimestamp(value: string | null | undefined): {
  dateTime?: string;
  label: string;
} {
  const candidate = value?.trim();
  if (!candidate) return { label: "Not recorded" };
  const parsed = new Date(candidate);
  if (!Number.isFinite(parsed.getTime())) return { label: "Invalid timestamp" };
  return {
    dateTime: parsed.toISOString(),
    label: TEMPLATE_TIMESTAMP_FORMATTER.format(parsed),
  };
}

function TemplateTimestamp({
  value,
}: {
  value: string | null | undefined;
}): ReactElement {
  const timestamp = safeTimestamp(value);
  return timestamp.dateTime ? (
    <time dateTime={timestamp.dateTime}>{timestamp.label}</time>
  ) : (
    <span>{timestamp.label}</span>
  );
}

function deriveKind(template: CampaignTemplate): Kind {
  const explicit = (template.kind ?? "").toLowerCase();
  if (explicit === "automation" || explicit === "broadcast") return explicit;
  if (explicit === "regular") return "regular";
  const kindTag = (template.tags ?? []).find((tag) => tag.startsWith("kind:"));
  if (kindTag) {
    const value = kindTag.slice("kind:".length).toLowerCase();
    if (
      value === "automation" ||
      value === "broadcast" ||
      value === "regular"
    ) {
      return value;
    }
  }
  return "regular";
}

function goalDisplay(goal: unknown): string | null {
  if (typeof goal !== "string" || goal === "") return null;
  return GOAL_LABELS[goal as TemplateGoal] ?? goal;
}

function templateCapability(template: CampaignTemplate): {
  description: string;
  label: string;
  tone: "accent" | "warning" | null;
} {
  const isReference = template.template_kind === "reference";
  const capabilities = template.capabilities;
  const warning = template.warnings?.[0];
  if (!capabilities) {
    return {
      description:
        "Action availability has not been verified by the server yet. Open or refresh the template before continuing.",
      label: "Availability unverified",
      tone: "warning",
    };
  }
  if (isReference && capabilities.can_adapt) {
    return {
      description:
        "The server permits an original editable adaptation while the inspiration stays unchanged.",
      label: "Ready to make yours",
      tone: "accent",
    };
  }
  if (!isReference && capabilities.can_create_campaign) {
    return {
      description: capabilities.can_clone
        ? "The server permits campaign creation and an editable workspace copy."
        : "The server permits direct campaign creation from this template.",
      label: "Ready to use",
      tone: "accent",
    };
  }
  if (capabilities.can_preview) {
    return {
      description:
        warning?.message ??
        "The server currently permits previewing this template, but not adaptation or campaign creation.",
      label:
        warning?.code === "review_pending" ? "Awaiting review" : "Preview only",
      tone: "warning",
    };
  }
  return {
    description:
      warning?.message ??
      "The server has not granted preview or content actions for this template.",
    label: "Unavailable",
    tone: "warning",
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

function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
  icon,
  loading = false,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "success" | "warning";
  icon?: ReactElement;
  loading?: boolean;
}): ReactElement {
  return (
    <div className={`gift-stat-tile tone-${tone}`}>
      <div
        className="gift-stat-label"
        style={{ display: "flex", alignItems: "center" }}
      >
        {icon ? <span className="tpl-stat-icon">{icon}</span> : null}
        {label}
      </div>
      <div className="gift-stat-value">
        {loading ? (
          <span
            className="skel"
            style={{
              display: "inline-block",
              width: 48,
              height: 16,
              verticalAlign: "middle",
            }}
          />
        ) : (
          value
        )}
      </div>
      {hint ? <div className="gift-stat-hint">{hint}</div> : null}
    </div>
  );
}

function LibraryIcon(): ReactElement {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 19V5a2 2 0 0 1 2-2h12v18" />
      <path d="M4 19a2 2 0 0 0 2 2h12" />
      <path d="M8 7h6" />
    </svg>
  );
}

function UsageIcon(): ReactElement {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M14 7h7v7" />
    </svg>
  );
}

function TrophyIcon(): ReactElement {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 21h8" />
      <path d="M12 17v4" />
      <path d="M7 4h10v3a5 5 0 0 1-10 0V4Z" />
      <path d="M7 4H4v2a3 3 0 0 0 3 3" />
      <path d="M17 4h3v2a3 3 0 0 1-3 3" />
    </svg>
  );
}

function StarIcon(): ReactElement {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="12 2 15 9 22 9.3 17 14 18.5 21 12 17.3 5.5 21 7 14 2 9.3 9 9 12 2" />
    </svg>
  );
}

export interface TemplatesOverviewProps {
  canMutate: boolean;
  deepLinkBusyId: string | null;
  deepLinkError: string | null;
  error: string | null;
  failedDeepLinkId: string | null;
  goalCountMap: Map<string, number>;
  goalFilter: TemplateGoal | "";
  lastVerifiedAt: number | null;
  lifecycle: CampaignTemplateDiscoveryLifecycle;
  loading: boolean;
  query: string;
  queryPending: boolean;
  sort: CampaignTemplateDiscoverySort;
  source: Source;
  stale: boolean;
  stats: TemplateStats | null;
  totalLabel: string;
  view: CampaignTemplateDiscoveryView;
  warnings: string[];
  onGenerate: () => void;
  onGoalChange: (goal: TemplateGoal | "") => void;
  onLifecycleChange: (lifecycle: CampaignTemplateDiscoveryLifecycle) => void;
  onNew: () => void;
  onQueryChange: (query: string) => void;
  onQueryCompositionChange: (composing: boolean) => void;
  onRefresh: () => void;
  onRetryDeepLink: () => void;
  onSortChange: (sort: CampaignTemplateDiscoverySort) => void;
  onSourceChange: (source: Source) => void;
  onViewChange: (view: CampaignTemplateDiscoveryView) => void;
}

export function TemplatesOverview({
  canMutate,
  deepLinkBusyId,
  deepLinkError,
  error,
  failedDeepLinkId,
  goalCountMap,
  goalFilter,
  lastVerifiedAt,
  lifecycle,
  loading,
  query,
  queryPending,
  sort,
  source,
  stale,
  stats,
  totalLabel,
  view,
  warnings,
  onGenerate,
  onGoalChange,
  onLifecycleChange,
  onNew,
  onQueryChange,
  onQueryCompositionChange,
  onRefresh,
  onRetryDeepLink,
  onSortChange,
  onSourceChange,
  onViewChange,
}: TemplatesOverviewProps): ReactElement {
  const createGate = canMutate ? undefined : "template-create-gate";
  const refreshStatus = loading ? "template-refresh-status" : undefined;
  return (
    <>
      <div className="page-header tpl-page-header">
        <div>
          <h1 className="page-title">Templates</h1>
          <div className="page-subtitle" aria-live="polite">
            {totalLabel}
          </div>
        </div>
        <div className="tpl-header-actions">
          {!canMutate ? (
            <div id="template-create-gate" className="muted">
              Viewer role can browse templates but cannot create them.
            </div>
          ) : null}
          {loading ? (
            <div id="template-refresh-status" className="muted" role="status">
              Refresh in progress. Refresh is available again when this request
              finishes.
            </div>
          ) : null}
          <div className="row tpl-header-buttons">
            <button
              type="button"
              className={`btn${loading ? " pw-discoverable-unavailable" : ""}`}
              onClick={() => {
                if (!loading) onRefresh();
              }}
              aria-busy={loading}
              aria-disabled={loading}
              aria-describedby={refreshStatus}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
            <button
              type="button"
              className={`btn${!canMutate ? " pw-discoverable-unavailable" : ""}`}
              onClick={() => {
                if (canMutate) onGenerate();
              }}
              aria-disabled={!canMutate}
              aria-describedby={createGate}
            >
              Generate with AI
            </button>
            <button
              type="button"
              className={`btn btn-primary${!canMutate ? " pw-discoverable-unavailable" : ""}`}
              onClick={() => {
                if (canMutate) onNew();
              }}
              aria-disabled={!canMutate}
              aria-describedby={createGate}
            >
              New template
            </button>
          </div>
        </div>
      </div>
      {queryPending || stale || lastVerifiedAt ? (
        <div className="tpl-resource-truth" aria-live="polite">
          {queryPending ? (
            <span role="status">Search update pending…</span>
          ) : null}
          {stale ? (
            <span role="status">
              Showing the previous verified catalog while the current view is
              refreshed.
            </span>
          ) : null}
          {lastVerifiedAt ? (
            <span>
              Catalog last verified{" "}
              <TemplateTimestamp
                value={new Date(lastVerifiedAt).toISOString()}
              />
              .
            </span>
          ) : null}
        </div>
      ) : null}
      {source !== "saved_blocks" ? (
        <>
          <PendingSyncStatus resource="campaign-templates" />
          <div className="gift-stat-grid" style={{ marginBottom: 12 }}>
            <StatTile
              icon={<LibraryIcon />}
              label="In your library"
              value={
                typeof stats?.total === "number"
                  ? stats.total.toLocaleString()
                  : loading
                    ? ""
                    : "Unavailable"
              }
              loading={!stats && loading}
              hint={
                typeof stats?.mine === "number" &&
                typeof stats?.featured === "number"
                  ? `${stats.mine.toLocaleString()} workspace-owned · ${stats.featured.toLocaleString()} featured`
                  : undefined
              }
            />
            <StatTile
              icon={<UsageIcon />}
              label="Used (30d)"
              value={
                stats
                  ? exactCount(stats.used_last_30d)
                  : loading
                    ? ""
                    : "Unavailable"
              }
              loading={!stats && loading}
              tone={stats && stats.used_last_30d > 0 ? "success" : "neutral"}
            />
            <StatTile
              icon={<TrophyIcon />}
              label="Most used"
              value={
                stats
                  ? exactCount(stats.top_usage_count)
                  : loading
                    ? ""
                    : "Unavailable"
              }
              loading={!stats && loading}
              hint={
                stats
                  ? (stats.top_template_name ?? "Nothing used yet")
                  : loading
                    ? undefined
                    : "Statistics unavailable"
              }
              tone={stats?.top_usage_count ? "success" : "neutral"}
            />
            <StatTile
              icon={<StarIcon />}
              label="Your favorites"
              value={
                stats
                  ? exactCount(stats.favorites)
                  : loading
                    ? ""
                    : "Unavailable"
              }
              loading={!stats && loading}
              hint={
                stats
                  ? stats.favorites
                    ? "Tap a star to add more"
                    : "Star a card to save it"
                  : loading
                    ? undefined
                    : "Statistics unavailable"
              }
            />
          </div>
        </>
      ) : null}
      <TemplateFilters
        goalCountMap={goalCountMap}
        goalFilter={goalFilter}
        lifecycle={lifecycle}
        query={query}
        sort={sort}
        source={source}
        stats={stats}
        view={view}
        onGoalChange={onGoalChange}
        onLifecycleChange={onLifecycleChange}
        onQueryChange={onQueryChange}
        onQueryCompositionChange={onQueryCompositionChange}
        onSortChange={onSortChange}
        onSourceChange={onSourceChange}
        onViewChange={onViewChange}
      />
      {error ? (
        <div className="notice tpl-notice" role="alert">
          <span>
            The template catalog could not be verified. {error}
            {stale ? " The previous verified catalog remains visible." : ""}
          </span>
          <button
            type="button"
            className={`btn btn-sm${loading ? " pw-discoverable-unavailable" : ""}`}
            aria-disabled={loading}
            aria-describedby={refreshStatus}
            onClick={() => {
              if (!loading) onRefresh();
            }}
          >
            Retry template catalog
          </button>
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div className="notice tpl-notice" role="status">
          <span>The catalog is available with partial supporting data.</span>
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {deepLinkBusyId ? (
        <div className="notice" role="status">
          Opening template ID <code>{deepLinkBusyId}</code>…
        </div>
      ) : null}
      {deepLinkError && failedDeepLinkId ? (
        <div className="notice tpl-notice" role="alert">
          <span>
            Template ID <code>{failedDeepLinkId}</code> could not be opened.{" "}
            {deepLinkError}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onRetryDeepLink}
          >
            Retry opening template
          </button>
        </div>
      ) : null}
    </>
  );
}

export interface TemplateLibraryBodyProps {
  blockOperationActive: boolean;
  catalogError: string | null;
  canMutate: boolean;
  compareIds?: ReadonlySet<string>;
  compareLimitReached?: boolean;
  copyBusyIds: Set<string>;
  copyStatus: Record<string, string>;
  favoriteBusyIds: Set<string>;
  goalFilter: TemplateGoal | "";
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  pageError: string | null;
  query: string;
  rows: CampaignTemplate[] | null;
  savedBlockError: string | null;
  savedBlockLastVerifiedAt: number | null;
  savedBlockLoading: boolean;
  savedBlockStale: boolean;
  savedBlockTotal: number | null;
  savedBlocks: SavedBlock[] | null;
  source: Source;
  view: CampaignTemplateDiscoveryView;
  onClearFilters: () => void;
  onClearSavedBlockSearch: () => void;
  onDeleteBlock: (block: SavedBlock) => void;
  onInsertBlock: (block: SavedBlock) => void;
  onJumpToGallery: () => void;
  onLoadMore: () => void;
  onNewBlank: () => void;
  onOpenTemplate: (template: CampaignTemplate) => void;
  onSaveBlock: () => void;
  onRetrySavedBlocks: () => void;
  onToggleCompare?: (template: CampaignTemplate) => void;
  onToggleFavorite: (template: CampaignTemplate) => void;
}

export function TemplateLibraryBody({
  blockOperationActive,
  catalogError,
  canMutate,
  compareIds = new Set<string>(),
  compareLimitReached = false,
  copyBusyIds,
  copyStatus,
  favoriteBusyIds,
  goalFilter,
  hasMore,
  loading,
  loadingMore,
  pageError,
  query,
  rows,
  savedBlockError,
  savedBlockLastVerifiedAt,
  savedBlockLoading,
  savedBlockStale,
  savedBlockTotal,
  savedBlocks,
  source,
  view,
  onClearFilters,
  onClearSavedBlockSearch,
  onDeleteBlock,
  onInsertBlock,
  onJumpToGallery,
  onLoadMore,
  onNewBlank,
  onOpenTemplate,
  onSaveBlock,
  onRetrySavedBlocks,
  onToggleCompare,
  onToggleFavorite,
}: TemplateLibraryBodyProps): ReactElement {
  if (source === "saved_blocks") {
    return (
      <SavedBlocksPanel
        items={savedBlocks}
        loading={savedBlockLoading}
        busy={blockOperationActive}
        canMutate={canMutate}
        copyBusyIds={copyBusyIds}
        copyStatus={copyStatus}
        error={savedBlockError}
        lastVerifiedAt={savedBlockLastVerifiedAt}
        query={query}
        stale={savedBlockStale}
        total={savedBlockTotal}
        onClearSearch={onClearSavedBlockSearch}
        onSaveAs={onSaveBlock}
        onInsert={onInsertBlock}
        onDelete={onDeleteBlock}
        onRetry={onRetrySavedBlocks}
      />
    );
  }
  if (loading && !rows) {
    return (
      <div className="card-grid" aria-label="Loading templates" role="status">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="card" style={{ minHeight: 220 }}>
            <div className="skel" style={{ height: 140, marginBottom: 12 }} />
            <div className="skel" style={{ height: 12, width: "60%" }} />
            <div
              className="skel"
              style={{ height: 10, width: "80%", marginTop: 8 }}
            />
          </div>
        ))}
      </div>
    );
  }
  if (!loading && rows === null && catalogError) {
    return (
      <div className="empty-state" role="status">
        <h2>Template catalog unavailable</h2>
        <p>
          No verified catalog is available for this view. Use “Retry template
          catalog” above when the service is ready.
        </p>
      </div>
    );
  }
  if (rows?.length === 0) {
    return (
      <EmptyState
        source={source}
        query={query}
        goalFilter={goalFilter}
        canMutate={canMutate}
        onNewBlank={onNewBlank}
        onJumpToGallery={onJumpToGallery}
        onClearFilters={onClearFilters}
      />
    );
  }
  return (
    <>
      {(rows?.length ?? 0) > VIRTUALIZE_TEMPLATE_THRESHOLD ? (
        <VirtualTemplateGrid
          compareIds={compareIds}
          compareLimitReached={compareLimitReached}
          favoriteBusyIds={favoriteBusyIds}
          loading={loading}
          rows={rows ?? []}
          view={view}
          onOpenTemplate={onOpenTemplate}
          onToggleCompare={onToggleCompare}
          onToggleFavorite={onToggleFavorite}
        />
      ) : (
        <ul
          className={`card-grid tpl-library-grid${view === "compact" ? " is-compact" : ""}`}
          aria-label="Template catalog"
          aria-busy={loading}
        >
          {(rows ?? []).map((template) => (
            <TemplateLibraryCard
              key={template.id}
              compareSelected={compareIds.has(template.id)}
              compareUnavailable={
                !onToggleCompare ||
                (compareLimitReached && !compareIds.has(template.id))
              }
              favoriteBusy={favoriteBusyIds.has(template.id)}
              template={template}
              onOpen={onOpenTemplate}
              onToggleCompare={onToggleCompare}
              onToggleFavorite={onToggleFavorite}
            />
          ))}
        </ul>
      )}
      {pageError ? (
        <div className="notice tpl-notice" role="alert" id="tpl-page-error">
          <span>
            More templates could not be loaded. {pageError} The templates
            already shown remain verified.
          </span>
        </div>
      ) : null}
      {hasMore ? (
        <div
          className="row"
          style={{ justifyContent: "center", marginTop: 16 }}
        >
          <button
            type="button"
            className={`btn${loading || loadingMore ? " pw-discoverable-unavailable" : ""}`}
            aria-disabled={loading || loadingMore}
            aria-describedby={
              pageError
                ? "tpl-page-error"
                : loading || loadingMore
                  ? "tpl-load-more-status"
                  : undefined
            }
            aria-busy={loadingMore}
            onClick={() => {
              if (!loading && !loadingMore) onLoadMore();
            }}
          >
            {loadingMore
              ? "Loading more…"
              : pageError
                ? "Retry loading more templates"
                : "Load more templates"}
          </button>
          {loading || loadingMore ? (
            <span id="tpl-load-more-status" className="muted" role="status">
              The next page can be requested after the active catalog request
              finishes.
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function VirtualTemplateGrid({
  compareIds,
  compareLimitReached,
  favoriteBusyIds,
  loading,
  rows,
  view,
  onOpenTemplate,
  onToggleCompare,
  onToggleFavorite,
}: {
  compareIds: ReadonlySet<string>;
  compareLimitReached: boolean;
  favoriteBusyIds: Set<string>;
  loading: boolean;
  rows: CampaignTemplate[];
  view: CampaignTemplateDiscoveryView;
  onOpenTemplate: (template: CampaignTemplate) => void;
  onToggleCompare?: (template: CampaignTemplate) => void;
  onToggleFavorite: (template: CampaignTemplate) => void;
}): ReactElement {
  const gridRef = useRef<HTMLUListElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [columnCount, setColumnCount] = useState(view === "compact" ? 1 : 4);
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    const scroller = document.getElementById("main-content");
    if (!grid || !scroller) return;
    setScrollElement(scroller);
    const measure = (): void => {
      const nextColumns =
        view === "compact"
          ? 1
          : Math.max(
              1,
              Math.floor(
                (grid.clientWidth + VIRTUAL_TEMPLATE_GAP_PX) /
                  (240 + VIRTUAL_TEMPLATE_GAP_PX),
              ),
            );
      setColumnCount((current) =>
        current === nextColumns ? current : nextColumns,
      );
      const gridTop =
        scroller.scrollTop +
        grid.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top;
      setScrollMargin((current) =>
        Math.abs(current - gridTop) < 0.5 ? current : gridTop,
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => measure());
    observer?.observe(grid);
    observer?.observe(scroller);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [rows.length, view]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    estimateSize: () =>
      (view === "compact"
        ? VIRTUAL_TEMPLATE_COMPACT_HEIGHT_PX
        : VIRTUAL_TEMPLATE_CARD_HEIGHT_PX) + VIRTUAL_TEMPLATE_GAP_PX,
    getItemKey: (index) => rows[index]?.id ?? index,
    lanes: columnCount,
    overscan: Math.max(12, columnCount * 3),
    scrollMargin,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const widthPercent = 100 / columnCount;
  const widthGap = (VIRTUAL_TEMPLATE_GAP_PX * (columnCount - 1)) / columnCount;

  return (
    <>
      <span className="visually-hidden" role="status">
        The complete catalog contains {exactCount(rows.length)} templates.
        Visible cards are windowed to keep scrolling responsive.
      </span>
      <ul
        ref={gridRef}
        className={`tpl-library-grid is-virtualized${view === "compact" ? " is-compact" : ""}`}
        aria-label="Template catalog"
        aria-busy={loading}
        style={{
          height: virtualizer.getTotalSize(),
          minHeight: virtualItems.length === 0 ? 1 : undefined,
          position: "relative",
        }}
      >
        {virtualItems.map((virtualItem) => {
          const template = rows[virtualItem.index];
          if (!template) return null;
          const lane = virtualItem.lane;
          const virtualLayout: CSSProperties = {
            position: "absolute",
            top: virtualItem.start - scrollMargin,
            left: `calc(${lane * widthPercent}% + ${(lane * VIRTUAL_TEMPLATE_GAP_PX) / columnCount}px)`,
            width: `calc(${widthPercent}% - ${widthGap}px)`,
            height: virtualItem.size - VIRTUAL_TEMPLATE_GAP_PX,
            overflow: "hidden",
          };
          return (
            <TemplateLibraryCard
              key={template.id}
              compareSelected={compareIds.has(template.id)}
              compareUnavailable={
                !onToggleCompare ||
                (compareLimitReached && !compareIds.has(template.id))
              }
              favoriteBusy={favoriteBusyIds.has(template.id)}
              showInlineDetails={false}
              template={template}
              virtualLayout={virtualLayout}
              onOpen={onOpenTemplate}
              onToggleCompare={onToggleCompare}
              onToggleFavorite={onToggleFavorite}
            />
          );
        })}
      </ul>
    </>
  );
}

const TemplateLibraryCard = memo(function TemplateLibraryCard({
  compareSelected,
  compareUnavailable,
  favoriteBusy,
  showInlineDetails = true,
  template,
  virtualLayout,
  onOpen,
  onToggleCompare,
  onToggleFavorite,
}: {
  compareSelected: boolean;
  compareUnavailable: boolean;
  favoriteBusy: boolean;
  showInlineDetails?: boolean;
  template: CampaignTemplate;
  virtualLayout?: CSSProperties;
  onOpen: (template: CampaignTemplate) => void;
  onToggleCompare?: (template: CampaignTemplate) => void;
  onToggleFavorite: (template: CampaignTemplate) => void;
}): ReactElement {
  const goal = goalDisplay(template.goal);
  const generatedId = useId();
  const titleId = `${generatedId}-title`;
  const favoriteStatusId = `${generatedId}-favorite-status`;
  const sourceProvider = template.source_provider?.trim();
  const sourceBrand = template.source_brand?.trim();
  const capability = templateCapability(template);
  const usageCount = Math.max(0, template.usage_count ?? 0);
  const favoriteUnavailable =
    favoriteBusy || template.capabilities?.can_favorite !== true;
  return (
    <Card
      as="li"
      aria-labelledby={titleId}
      className="tpl-card"
      data-featured={template.is_featured ? "true" : undefined}
      data-platform={!template.tenant_id ? "true" : undefined}
      data-goal={
        typeof template.goal === "string" && template.goal
          ? template.goal
          : undefined
      }
      data-archived={template.archived_at ? "true" : undefined}
      style={virtualLayout}
    >
      <TemplateCardVisual template={template} />
      <div
        className="row"
        style={{ marginTop: 10, alignItems: "center", gap: 6 }}
      >
        <button
          type="button"
          className="link-button tpl-name tpl-card-open"
          style={{ flex: 1, minWidth: 0, textAlign: "left" }}
          onClick={() => onOpen(template)}
          aria-label={`Open template ${template.name}`}
          id={titleId}
        >
          {template.name}
        </button>
        <button
          type="button"
          className="tpl-card-compare"
          aria-pressed={compareSelected}
          disabled={compareUnavailable}
          aria-label={
            compareSelected
              ? `Remove ${template.name} from comparison`
              : `Add ${template.name} to comparison`
          }
          title={
            compareUnavailable
              ? "Compare up to four templates at a time."
              : undefined
          }
          onClick={() => {
            if (!compareUnavailable) onToggleCompare?.(template);
          }}
        >
          {compareSelected ? "Selected" : "Compare"}
        </button>
        <button
          type="button"
          className="tpl-fav"
          aria-pressed={Boolean(template.is_favorited)}
          aria-busy={favoriteBusy}
          aria-disabled={favoriteUnavailable}
          disabled={template.capabilities?.can_favorite !== true}
          aria-describedby={favoriteBusy ? favoriteStatusId : undefined}
          aria-label={
            favoriteBusy
              ? `Updating favorite for ${template.name}`
              : template.is_favorited
                ? `Remove ${template.name} from favorites`
                : `Add ${template.name} to favorites`
          }
          onClick={() => {
            if (!favoriteUnavailable) onToggleFavorite(template);
          }}
        >
          <FavoriteIcon filled={Boolean(template.is_favorited)} />
        </button>
      </div>
      {favoriteBusy ? (
        <div id={favoriteStatusId} className="muted" role="status">
          Updating favorite for {template.name}…
        </div>
      ) : null}
      <p className="muted tpl-card-subject">
        <strong>Subject:</strong>{" "}
        {template.subject || <em>No subject has been set.</em>}
      </p>
      <div className="row" style={{ marginTop: 8, gap: 4, flexWrap: "wrap" }}>
        <span
          className={`badge${capability.tone ? ` ${capability.tone}` : ""}`}
        >
          {capability.label}
        </span>
        {sourceBrand ? (
          <span className="badge">
            {template.template_kind === "reference"
              ? `Inspired by ${sourceBrand}`
              : `From ${sourceBrand}`}
          </span>
        ) : null}
        {!template.tenant_id ? (
          <span className="badge accent">Moosewave</span>
        ) : null}
        {template.is_featured ? (
          <span className="badge accent">★ Featured</span>
        ) : null}
        {template.archived_at ? (
          <span className="badge warning">Archived · recoverable</span>
        ) : null}
        {goal ? (
          <span
            className="goal-pill"
            data-goal={
              typeof template.goal === "string" ? template.goal : undefined
            }
          >
            <span className="goal-pill-dot" aria-hidden="true" />
            {goal}
          </span>
        ) : (
          <span className="badge">uncategorised</span>
        )}
        <span className="spacer" />
        {usageCount > 0 ? (
          <span className="badge">Used {exactCount(usageCount)} times</span>
        ) : null}
      </div>
      <p className="muted tpl-card-capability">{capability.description}</p>
      {usageCount > 0 ? (
        <p className="muted tpl-card-time">
          Last used: <TemplateTimestamp value={template.last_used_at} />
        </p>
      ) : null}
      {showInlineDetails ? (
        <details className="tpl-record-details">
          <summary>Source and template details</summary>
          <dl className="tpl-metadata-list">
            <div>
              <dt>Template ID</dt>
              <dd>
                <code>{template.id}</code>
              </dd>
            </div>
            <div>
              <dt>Slug</dt>
              <dd>
                <code>{template.slug || "Not recorded"}</code>
              </dd>
            </div>
            <div>
              <dt>Template format</dt>
              <dd>{deriveKind(template)}</dd>
            </div>
            <div>
              <dt>How you can use it</dt>
              <dd>{capability.label}</dd>
            </div>
            <div>
              <dt>Source review</dt>
              <dd>
                {template.review_status?.replaceAll("-", " ") ?? "Not recorded"}
              </dd>
            </div>
            <div>
              <dt>Usage rights</dt>
              <dd>
                {template.source_license_status?.replaceAll("-", " ") ??
                  "Not recorded"}
              </dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>
                <TemplateTimestamp value={template.updated_at} />
              </dd>
            </div>
            {sourceBrand ? (
              <div>
                <dt>Source brand</dt>
                <dd>{sourceBrand}</dd>
              </div>
            ) : null}
            {sourceProvider ? (
              <div>
                <dt>Source provider</dt>
                <dd>{sourceProvider}</dd>
              </div>
            ) : null}
            {template.source_external_id ? (
              <div>
                <dt>External source ID</dt>
                <dd>
                  <code>{template.source_external_id}</code>
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Tags</dt>
              <dd>
                {template.tags?.length ? template.tags.join(", ") : "None"}
              </dd>
            </div>
          </dl>
        </details>
      ) : null}
    </Card>
  );
});

/**
 * A network-silent catalog fingerprint. The authenticated PNG route is not a
 * production contract yet, and raw template HTML must never run in a card.
 * This summary remains useful for scanning while the verified detail preview
 * is fetched only after selection.
 */
function TemplateCardVisual({
  template,
}: {
  template: CampaignTemplate;
}): ReactElement {
  const goal =
    typeof template.goal === "string" && template.goal
      ? template.goal
      : "uncategorised";
  const subject = template.subject?.trim() || "Subject not set";
  const preview = template.preview_text?.trim() || "Preview text not set";
  return (
    <>
      <div
        className="tpl-card-visual"
        data-goal={goal}
        data-kind={template.template_kind ?? "editable"}
        aria-hidden="true"
      >
        <div className="tpl-card-visual-chrome">
          <span />
          <span />
          <span />
          <i>
            {template.template_kind === "reference"
              ? "Inspiration"
              : "Editable email"}
          </i>
        </div>
        <div className="tpl-card-visual-canvas">
          <span className="tpl-card-visual-kicker">
            {template.source_brand?.trim() || "Moosewave workspace"}
          </span>
          <strong>{subject}</strong>
          <span className="tpl-card-visual-preview">{preview}</span>
          <span className="tpl-card-visual-line is-long" />
          <span className="tpl-card-visual-line" />
          <span className="tpl-card-visual-cta" />
        </div>
        <span className="tpl-card-visual-safety">Open for a full preview</span>
      </div>
      <span className="visually-hidden">
        Preview text: {preview}. Open {template.name} for its verified content
        preview.
      </span>
    </>
  );
}

function EmptyState({
  source,
  query,
  goalFilter,
  canMutate,
  onNewBlank,
  onJumpToGallery,
  onClearFilters,
}: {
  source: Source;
  query: string;
  goalFilter: TemplateGoal | "";
  canMutate: boolean;
  onNewBlank: () => void;
  onJumpToGallery: () => void;
  onClearFilters: () => void;
}): ReactElement {
  const hasFilters = Boolean(query || goalFilter);
  let title = "No templates yet";
  let body = "Save your first template to reuse it across campaigns.";
  let primary: ReactElement | null = canMutate ? (
    <button type="button" className="btn btn-primary" onClick={onNewBlank}>
      New template
    </button>
  ) : null;
  let secondary: ReactElement | null = null;

  if (!hasFilters && source === "all") {
    return (
      <HeroEmptyState
        tone="blue"
        eyebrow="Library"
        title="Don't start from blank."
        subtitle="Browse inspiration, make a design your own, and customize it in the editor. New templates ship weekly."
        imageSrc={HERO.templates}
        imageAlt="Fanned-out email template cards"
        {...(canMutate
          ? { primaryCta: { label: "New template", onClick: onNewBlank } }
          : {})}
      />
    );
  }
  if (hasFilters) {
    title = `No matches${query ? ` for "${query}"` : ""}`;
    body = "Try a different goal, source, or clear the filters.";
    primary = (
      <button
        type="button"
        className="btn btn-primary"
        onClick={onClearFilters}
      >
        Clear filters
      </button>
    );
  } else if (source === "archived") {
    title = "No archived templates";
    body =
      "Archived templates stay recoverable here with their immutable revision history.";
    primary = null;
  } else if (source === "favorited") {
    title = "No favorites yet";
    body = "Tap a star on any template to save it here.";
    primary = (
      <button
        type="button"
        className="btn btn-primary"
        onClick={onJumpToGallery}
      >
        Browse inspiration
      </button>
    );
  } else if (source === "mine") {
    title = "You haven't authored any templates yet";
    body =
      "Save a polished campaign as a template, or start from scratch with New template.";
    secondary = (
      <button type="button" className="btn" onClick={onJumpToGallery}>
        Browse inspiration
      </button>
    );
  } else if (source === "team") {
    title = "No team templates yet";
    body = "Templates authored by teammates show up here.";
    primary = (
      <button
        type="button"
        className="btn btn-primary"
        onClick={onJumpToGallery}
      >
        Browse inspiration
      </button>
    );
  }
  return (
    <div className="empty-state">
      <div className="empty-state-icon" aria-hidden="true">
        ·
      </div>
      <h3>{title}</h3>
      <p>{body}</p>
      <div className="row" style={{ gap: 8, justifyContent: "center" }}>
        {primary}
        {secondary}
      </div>
    </div>
  );
}

interface SavedBlocksPanelProps {
  items: SavedBlock[] | null;
  loading: boolean;
  busy: boolean;
  canMutate: boolean;
  copyBusyIds: Set<string>;
  copyStatus: Record<string, string>;
  error: string | null;
  lastVerifiedAt: number | null;
  query: string;
  stale: boolean;
  total: number | null;
  onClearSearch: () => void;
  onSaveAs: () => void;
  onInsert: (block: SavedBlock) => void;
  onDelete: (block: SavedBlock) => void;
  onRetry: () => void;
}

function SavedBlocksPanel({
  items,
  loading,
  busy,
  canMutate,
  copyBusyIds,
  copyStatus,
  error,
  lastVerifiedAt,
  query,
  stale,
  total,
  onClearSearch,
  onSaveAs,
  onInsert,
  onDelete,
  onRetry,
}: SavedBlocksPanelProps): ReactElement {
  const createReasonId = "tpl-saved-block-create-reason";
  const operationReason = busy
    ? "Wait for the active saved-block request to finish."
    : null;
  const permissionReason = !canMutate
    ? "Viewer role can inspect and copy saved blocks but cannot create or delete them."
    : null;
  const createUnavailable = !canMutate || busy;
  return (
    <section aria-labelledby="tpl-saved-blocks-heading">
      <div className="tpl-saved-block-toolbar">
        <div>
          <h2 id="tpl-saved-blocks-heading" className="section-title">
            Saved blocks
          </h2>
          <p className="muted tpl-saved-block-intro">
            Saved blocks are reusable snippets for template bodies. Copy a block
            here, open an editable template, then paste it at the intended
            cursor position. This explicit flow works equally with a keyboard or
            assistive technology.
          </p>
          <div className="tpl-resource-truth" aria-live="polite">
            <span>
              {items && total !== null
                ? `${items.length < total ? `${exactCount(items.length)} of ` : ""}${exactCount(total)} loaded saved block${total === 1 ? "" : "s"}`
                : loading
                  ? "Loading saved blocks…"
                  : "Loaded saved-block count unavailable"}
            </span>
            {stale ? (
              <span>Showing previously verified saved blocks.</span>
            ) : null}
            {lastVerifiedAt ? (
              <span>
                Last verified{" "}
                <TemplateTimestamp
                  value={new Date(lastVerifiedAt).toISOString()}
                />
                .
              </span>
            ) : null}
          </div>
        </div>
        <div className="tpl-saved-block-create">
          <button
            type="button"
            className={`btn${createUnavailable ? " pw-discoverable-unavailable" : ""}`}
            onClick={() => {
              if (!createUnavailable) onSaveAs();
            }}
            aria-disabled={createUnavailable}
            aria-describedby={createUnavailable ? createReasonId : undefined}
          >
            New saved block
          </button>
          {createUnavailable ? (
            <span id={createReasonId} className="pw-action-status">
              {permissionReason ?? operationReason}
            </span>
          ) : (
            <span className="pw-action-status">
              Opens a form for the block name, HTML, and optional JSON.
            </span>
          )}
        </div>
      </div>
      {error ? (
        <div className="notice tpl-notice" role="alert">
          <span>
            Saved blocks could not be verified. {error}
            {stale ? " Previously verified blocks remain visible." : ""}
          </span>
          <button
            type="button"
            className={`btn btn-sm${loading ? " pw-discoverable-unavailable" : ""}`}
            aria-disabled={loading}
            onClick={() => {
              if (!loading) onRetry();
            }}
          >
            Retry saved blocks
          </button>
        </div>
      ) : null}
      {items && items.length >= 50 ? (
        <div className="notice" role="note">
          This view currently receives one server page. Search covers these 50
          loaded blocks; additional workspace blocks may not be visible until
          saved-block pagination is available.
        </div>
      ) : null}
      {loading && items === null ? (
        <div
          className="card-grid"
          role="status"
          aria-label="Loading saved blocks"
        >
          {[0, 1, 2].map((index) => (
            <div key={index} className="card" style={{ minHeight: 160 }}>
              <div className="skel" style={{ height: 80, marginBottom: 12 }} />
              <div className="skel" style={{ height: 12, width: "60%" }} />
            </div>
          ))}
        </div>
      ) : items === null ? (
        <div className="empty-state" role="status">
          <h3>Saved-block library unavailable</h3>
          <p>No verified saved-block list is available. Retry when ready.</p>
        </div>
      ) : items.length === 0 && query.trim() ? (
        <div className="empty-state">
          <div className="empty-state-icon" aria-hidden="true">
            ·
          </div>
          <h3>No saved blocks match “{query}”</h3>
          <p>Search by saved-block name, kind, or complete record ID.</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onClearSearch}
          >
            Clear saved-block search
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon" aria-hidden="true">
            ·
          </div>
          <h3>No saved blocks yet</h3>
          <p>
            Save a polished section from a template to drop it into future
            campaigns without rebuilding.
          </p>
        </div>
      ) : (
        <ul
          className="card-grid tpl-library-grid"
          aria-label="Saved blocks"
          aria-busy={loading}
        >
          {items.map((block) => (
            <SavedBlockCard
              key={block.id}
              block={block}
              busy={busy}
              canMutate={canMutate}
              copyBusy={copyBusyIds.has(block.id)}
              copyStatus={copyStatus[block.id]}
              onCopy={onInsert}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SavedBlockCard({
  block,
  busy,
  canMutate,
  copyBusy,
  copyStatus,
  onCopy,
  onDelete,
}: {
  block: SavedBlock;
  busy: boolean;
  canMutate: boolean;
  copyBusy: boolean;
  copyStatus?: string;
  onCopy: (block: SavedBlock) => void;
  onDelete: (block: SavedBlock) => void;
}): ReactElement {
  const generatedId = useId();
  const hintId = `${generatedId}-usage-hint`;
  const copyStatusId = `${generatedId}-copy-status`;
  const deleteReasonId = `${generatedId}-delete-reason`;
  const copyAvailable = savedBlockCopyValue(block) !== null;
  const deleteUnavailable = !canMutate || busy;
  const copyUnavailable = copyBusy || !copyAvailable;
  return (
    <li
      className="card pw-saved-block-card"
      data-kind={block.kind}
      aria-describedby={hintId}
    >
      <div className="tpl-saved-block-preview" aria-hidden="true">
        <span>{block.body_html.trim() ? "HTML block" : "JSON block"}</span>
      </div>
      <div className="row tpl-saved-block-title-row">
        <h3 className="tpl-name">{block.name}</h3>
        <span className="badge">Block kind: {block.kind}</span>
      </div>
      <p id={hintId} className="muted tpl-card-time">
        Copy this block, then paste it into the HTML body of an editable
        template. Nothing is inserted until you save that template.
      </p>
      <dl className="tpl-metadata-list">
        <div>
          <dt>Saved-block ID</dt>
          <dd>
            <code>{block.id}</code>
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            <TemplateTimestamp value={block.created_at} />
          </dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>
            <TemplateTimestamp value={block.updated_at} />
          </dd>
        </div>
      </dl>
      <div className="row tpl-card-actions">
        <button
          type="button"
          className={`btn btn-sm btn-primary${copyUnavailable ? " pw-discoverable-unavailable" : ""}`}
          aria-busy={copyBusy}
          aria-disabled={copyUnavailable}
          aria-describedby={copyStatusId}
          onClick={() => {
            if (!copyUnavailable) onCopy(block);
          }}
        >
          {copyBusy ? "Copying…" : "Copy block content"}
        </button>
        <button
          type="button"
          className={`btn btn-sm btn-danger${deleteUnavailable ? " pw-discoverable-unavailable" : ""}`}
          aria-disabled={deleteUnavailable}
          aria-describedby={deleteUnavailable ? deleteReasonId : undefined}
          onClick={() => {
            if (!deleteUnavailable) onDelete(block);
          }}
        >
          Delete block
        </button>
      </div>
      <p
        id={copyStatusId}
        className="pw-action-status"
        role={copyStatus || copyBusy ? "status" : undefined}
      >
        {copyStatus ??
          (copyAvailable
            ? "Copies the complete saved-block content to the clipboard."
            : "This saved block has no HTML or JSON content to copy.")}
      </p>
      {deleteUnavailable ? (
        <p id={deleteReasonId} className="pw-action-status">
          {!canMutate
            ? "Viewer role cannot delete saved blocks."
            : "Wait for the active saved-block request to finish."}
        </p>
      ) : null}
    </li>
  );
}

function FavoriteIcon({ filled }: { filled: boolean }): ReactElement {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

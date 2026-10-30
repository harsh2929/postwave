import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";

import { PageHeader } from "../../components/PageHeader";
import { ChoiceGroup } from "../../components/ChoiceGroup";
import { SectionHeader } from "../../components/SectionHeader";
import type {
  IntegrationBadge,
  IntegrationCatalogItem,
  IntegrationCategory,
  IntegrationConnection,
} from "../../lib/api-client";
import {
  ALL_FILTER,
  badgeLabel,
  categoryLabel,
  nativeConnectTarget,
  nativeProviderFamily,
} from "../integrations-helpers";
import {
  CoveragePanel,
  Metric,
  RecipeLibrary,
  StacksPanel,
} from "./IntegrationPanels";
import {
  badgeTone,
  healthTone,
  IconArrow,
  IconPlug,
  IconRefresh,
} from "./IntegrationPresentation";
import type { IntegrationLifecycleController } from "./useIntegrationLifecycleController";
import type { IntegrationRecipeController } from "./useIntegrationRecipeController";
import type {
  IntegrationsCatalogController,
  IntegrationsViewId,
  RecipeAvailability,
} from "./useIntegrationsCatalogController";

const BADGES: Array<{
  value: IntegrationBadge | typeof ALL_FILTER;
  label: string;
}> = [
  { value: ALL_FILTER, label: "All badges" },
  { value: "native", label: "Native" },
  { value: "partner", label: "Partner" },
  { value: "zapier", label: "Zapier" },
  { value: "webhook", label: "Webhook" },
  { value: "api_sdk", label: "API/SDK" },
  { value: "migration_only", label: "Migration-only" },
  { value: "planned", label: "Planned" },
];

const VIEWS: Array<{
  id: IntegrationsViewId;
  label: string;
  description: string;
}> = [
  {
    id: "catalog",
    label: "Connections",
    description: "Connected systems and discovery",
  },
  {
    id: "recipes",
    label: "Recipes",
    description: "Reviewed setup playbooks",
  },
  {
    id: "coverage",
    label: "Readiness",
    description: "Evidence, blockers, and next work",
  },
  {
    id: "stacks",
    label: "Use cases",
    description: "Readiness by customer architecture",
  },
];

function monogramColors(seed: string): { bg: string; fg: string } {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  const hue = hash % 360;
  return { bg: `hsl(${hue} 60% 93%)`, fg: `hsl(${hue} 52% 34%)` };
}

function BrandIcon({
  slug,
  name,
}: {
  slug: string;
  name: string;
}): ReactElement {
  const letter = (name.trim()[0] || "?").toUpperCase();
  const colors = monogramColors(name || slug);
  const initials = name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
  return (
    <span
      className="brand-icon-tile int-brand-monogram"
      aria-hidden="true"
      style={
        {
          "--int-brand-bg": colors.bg,
          "--int-brand-fg": colors.fg,
        } as CSSProperties
      }
    >
      {initials || letter}
    </span>
  );
}

function connectionNeedsAttention(connection: IntegrationConnection): boolean {
  const health = (connection.health_state ?? connection.status).toLowerCase();
  return (
    Boolean(connection.last_error?.trim()) ||
    [
      "action_required",
      "degraded",
      "error",
      "failed",
      "needs_attention",
      "unhealthy",
    ].includes(health)
  );
}

function formatVerifiedAt(value: number | null): string {
  if (value === null) return "Not yet checked";
  return `Checked ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value)}`;
}

export function IntegrationsHeaderControls({
  state,
}: {
  state: IntegrationsCatalogController;
}): ReactElement {
  const categories = state.catalog?.categories ?? [];
  const allItems = state.catalog?.items ?? [];
  const attentionCount = state.connections.filter(
    connectionNeedsAttention,
  ).length;
  const unavailable = new Set(
    state.resourceIssues.map((issue) => issue.resource),
  );
  const connectionIssue = unavailable.has("connections");
  const coverageIssue = unavailable.has("coverage");
  const readinessIssue = unavailable.has("readiness");
  const recipesIssue = unavailable.has("recipes");
  const catalogKnown = state.catalog !== null;
  const connectionsKnown =
    state.lastUpdatedAt !== null &&
    (!connectionIssue || state.connections.length > 0);
  const coverageKnown =
    state.lastUpdatedAt !== null && (!coverageIssue || state.coverage !== null);
  const readinessKnown =
    state.lastUpdatedAt !== null &&
    (!readinessIssue || state.readiness !== null);
  const recipesKnown =
    state.lastUpdatedAt !== null && (!recipesIssue || state.recipes.length > 0);
  const blockerCount = state.readiness?.issue_counts["severity:blocker"] ?? 0;
  const posture = state.error
    ? {
        tone: "danger",
        kicker: "Verification unavailable",
        title: "Catalog truth could not be confirmed",
        detail:
          "Previously loaded information stays visible where available. Refresh before changing a connection.",
      }
    : state.loading && !state.catalog
      ? {
          tone: "neutral",
          kicker: "Verifying workspace",
          title: "Checking every integration surface",
          detail:
            "Catalog ownership, connection state, readiness, recipes, coverage, and stack evidence are being reconciled.",
        }
      : state.resourceIssues.length > 0
        ? {
            tone: "warning",
            kicker: "Partial verification",
            title: `${state.resourceIssues.length} ${state.resourceIssues.length === 1 ? "resource needs" : "resources need"} another look`,
            detail:
              "The catalog is usable, but affected evidence is marked unavailable and stale values are not presented as newly verified.",
          }
        : blockerCount > 0 || attentionCount > 0
          ? {
              tone: "warning",
              kicker: "Operator review",
              title: `${blockerCount + attentionCount} ${blockerCount + attentionCount === 1 ? "item needs" : "items need"} attention`,
              detail:
                "Start with connection health and readiness blockers before adding another data path.",
            }
          : {
              tone: "success",
              kicker: "Workspace verified",
              title: `${state.stats.connected} configured ${state.stats.connected === 1 ? "integration" : "integrations"}, no reported blockers`,
              detail:
                "Ownership, setup path, and runtime posture are current for every loaded catalog entry.",
            };
  return (
    <>
      <PageHeader
        eyebrow="Data & connections"
        title="Integrations"
        subtitle="Connect systems with a clear owner, scoped setup path, observable health, and an honest boundary between available, delegated, and planned work."
        meta={
          <div className="int-header-meta" aria-label="Catalog verification">
            <span className={`int-live-dot int-live-dot--${posture.tone}`} />
            {state.lastUpdatedAt === null ? (
              <span>{formatVerifiedAt(null)}</span>
            ) : (
              <time dateTime={new Date(state.lastUpdatedAt).toISOString()}>
                {formatVerifiedAt(state.lastUpdatedAt)}
              </time>
            )}
            <span aria-hidden="true">·</span>
            <span>Schema {state.catalog?.schema_version ?? "unverified"}</span>
          </div>
        }
        actions={[
          {
            label: state.loading ? "Verifying" : "Refresh evidence",
            onClick: () => void state.refresh(),
            icon: <IconRefresh />,
            disabled: state.loading,
            title: state.loading
              ? "Wait for the current verification pass to finish."
              : "Recheck catalog, connection, readiness, recipe, coverage, and stack evidence.",
          },
        ]}
      />
      <section
        className={`int-command-center int-command-center--${posture.tone}`}
        aria-label="Integration workspace posture"
      >
        <div className="int-posture">
          <div className="int-posture-orbit" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="int-posture-copy">
            <div className="int-kicker">{posture.kicker}</div>
            <h2>{posture.title}</h2>
            <p>{posture.detail}</p>
            <div className="int-evidence-rail" aria-label="Supporting evidence">
              <span>
                {coverageKnown
                  ? (state.coverage?.bridge_ready ?? state.stats.delegated)
                  : "—"}{" "}
                bridge-ready{coverageIssue && coverageKnown ? " · stale" : ""}
              </span>
              <span>
                {recipesKnown
                  ? (state.coverage?.available_recipes ??
                    state.recipeSummary.available ??
                    0)
                  : "—"}{" "}
                ready recipes{recipesIssue && recipesKnown ? " · stale" : ""}
              </span>
              <span>
                {coverageKnown
                  ? (state.coverage?.planned ?? state.stats.planned)
                  : "—"}{" "}
                roadmap{coverageIssue && coverageKnown ? " · stale" : ""}
              </span>
            </div>
          </div>
        </div>
        <div className="int-primary-metrics">
          <Metric
            label="Catalog"
            value={
              catalogKnown
                ? (state.coverage?.public_entries ?? state.stats.total)
                : "—"
            }
            sub="truth-labelled entries"
            tone="info"
          />
          <Metric
            label="Configured"
            value={connectionsKnown ? state.stats.connected : "—"}
            sub={
              connectionsKnown
                ? connectionIssue
                  ? "stale connection snapshot"
                  : attentionCount
                    ? `${attentionCount} need attention`
                    : "healthy footprint"
                : "connection state unavailable"
            }
            tone={
              !connectionsKnown || connectionIssue
                ? "neutral"
                : attentionCount
                  ? "warning"
                  : "success"
            }
          />
          <Metric
            label="API-verified"
            value={coverageKnown ? (state.coverage?.native_verified ?? 0) : "—"}
            sub={
              coverageKnown
                ? coverageIssue
                  ? "stale coverage snapshot"
                  : `${state.coverage?.native_partial ?? 0} partial foundations`
                : "coverage unavailable"
            }
            tone="neutral"
          />
          <Metric
            label="Blockers"
            value={readinessKnown ? blockerCount : "—"}
            sub={
              readinessKnown
                ? readinessIssue
                  ? "stale readiness snapshot"
                  : state.readiness?.marketable_public_claim
                    ? "claim qualified"
                    : "review required"
                : "readiness unavailable"
            }
            tone={
              !readinessKnown || readinessIssue
                ? "neutral"
                : blockerCount
                  ? "danger"
                  : "success"
            }
          />
        </div>
      </section>
      {state.readiness && !state.readiness.marketable_public_claim ? (
        <section
          className="int-readiness-callout"
          aria-label="Readiness boundary"
        >
          <span className="int-readiness-icon" aria-hidden="true">
            !
          </span>
          <div>
            <strong>
              {readinessIssue
                ? "Last verified public-claim boundary · stale"
                : "Public-claim boundary"}
            </strong>
            <p>{state.readiness.public_claim}</p>
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => state.setView("coverage")}
          >
            Review evidence
          </button>
        </section>
      ) : null}
      {state.resourceIssues.length > 0 ? (
        <section
          className="int-resource-issues"
          role="status"
          aria-live="polite"
        >
          <div>
            <strong>Some evidence could not be refreshed</strong>
            <p>
              {state.resourceIssues
                .map((issue) => `${issue.resource}: ${issue.message}`)
                .join(" · ")}
            </p>
          </div>
          <button
            type="button"
            className="btn"
            disabled={state.loading}
            onClick={() => void state.refresh()}
          >
            Retry verification
          </button>
        </section>
      ) : null}
      {!state.error || state.catalog ? (
        <>
          <ChoiceGroup
            legend="Integration view"
            value={state.view}
            onChange={(view) => setView(state, view)}
            className="int-view-switcher"
            optionClassName="int-view-option"
            options={VIEWS.map((item) => ({
              value: item.id,
              label: (
                <span className="int-view-label">
                  <strong>{item.label}</strong>
                  <span>{item.description}</span>
                </span>
              ),
              className: state.view === item.id ? "is-active" : undefined,
            }))}
          />
          <IntegrationFilters state={state} categories={categories} />
        </>
      ) : null}
      {state.error ? (
        <section className="int-fatal-error" role="alert">
          <div>
            <strong>Integration evidence is unavailable</strong>
            <p>{state.error}</p>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={state.loading}
            onClick={() => void state.refresh()}
          >
            Try again
          </button>
        </section>
      ) : null}
      {!state.error || state.catalog ? (
        <CurrentViewHeader state={state} totalItems={allItems.length} />
      ) : null}
    </>
  );
}

function setView(
  state: IntegrationsCatalogController,
  view: IntegrationsViewId,
): void {
  state.setView(view);
  if (view === "recipes") state.setCategory(ALL_FILTER);
  else state.setRecipeAvailability("all");
}

function IntegrationFilters({
  state,
  categories,
}: {
  state: IntegrationsCatalogController;
  categories: IntegrationCategory[];
}): ReactElement {
  const connectionEvidenceUnavailable = state.resourceIssues.some(
    (issue) => issue.resource === "connections",
  );
  const activeFilterCount = [
    state.query.trim() !== "",
    state.category !== ALL_FILTER,
    state.badge !== ALL_FILTER,
    state.view === "catalog" && state.connectionFilter !== "all",
    state.view === "recipes" && state.recipeAvailability !== "all",
  ].filter(Boolean).length;
  return (
    <section className="int-filter-bar" aria-label="Filter integrations">
      <label className="int-search-field">
        <span className="sr-only">Search integrations</span>
        <span className="int-search-icon" aria-hidden="true" />
        <input
          className="input"
          type="search"
          value={state.query}
          onChange={(event) => state.setQuery(event.currentTarget.value)}
          placeholder="Search providers, capabilities, or setup paths"
        />
        {state.query ? (
          <button
            type="button"
            className="int-search-clear"
            aria-label="Clear integration search"
            onClick={() => state.setQuery("")}
          >
            ×
          </button>
        ) : null}
      </label>
      {state.view !== "recipes" ? (
        <label className="int-filter-field">
          <span>Category</span>
          <select
            className="input"
            value={state.category}
            onChange={(event) => state.setCategory(event.currentTarget.value)}
          >
            <option value={ALL_FILTER}>All categories</option>
            {categories.map((category) => (
              <option key={category.key} value={category.key}>
                {category.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="int-filter-field">
        <span>Ownership</span>
        <select
          className="input"
          value={state.badge}
          onChange={(event) => state.setBadge(event.currentTarget.value)}
        >
          {BADGES.map((badge) => (
            <option key={badge.value} value={badge.value}>
              {badge.label}
            </option>
          ))}
        </select>
      </label>
      {state.view === "catalog" ? (
        <label className="int-filter-field">
          <span>
            Workspace state
            {connectionEvidenceUnavailable ? " · unavailable" : ""}
          </span>
          <select
            className="input"
            value={state.connectionFilter}
            disabled={
              connectionEvidenceUnavailable && state.connections.length === 0
            }
            onChange={(event) =>
              state.setConnectionFilter(
                event.currentTarget
                  .value as IntegrationsCatalogController["connectionFilter"],
              )
            }
          >
            <option value="all">All states</option>
            <option value="connected">Configured</option>
            <option value="attention">Needs attention</option>
            <option value="available">Ready to connect</option>
            <option value="planned">Planned</option>
          </select>
        </label>
      ) : null}
      {state.view === "catalog" ? (
        <label className="int-filter-field">
          <span>Sort</span>
          <select
            className="input"
            value={state.sort}
            onChange={(event) =>
              state.setSort(
                event.currentTarget
                  .value as IntegrationsCatalogController["sort"],
              )
            }
          >
            <option value="recommended">Operator priority</option>
            <option value="status">Connection status</option>
            <option value="name">Name A–Z</option>
            <option value="category">Category</option>
          </select>
        </label>
      ) : null}
      {state.view === "recipes" ? (
        <label className="int-filter-field">
          <span>Availability</span>
          <select
            className="input"
            value={state.recipeAvailability}
            onChange={(event) =>
              state.setRecipeAvailability(
                event.currentTarget.value as RecipeAvailability,
              )
            }
          >
            <option value="all">All recipes</option>
            <option value="ready">Ready recipes</option>
            <option value="planned">Planned recipes</option>
          </select>
        </label>
      ) : null}
      <div className="int-filter-actions">
        <span aria-live="polite">
          {activeFilterCount
            ? `${activeFilterCount} active ${activeFilterCount === 1 ? "filter" : "filters"}`
            : "No active filters"}
        </span>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={activeFilterCount === 0}
          onClick={state.clearFilters}
        >
          Reset
        </button>
      </div>
    </section>
  );
}

function CurrentViewHeader({
  state,
  totalItems,
}: {
  state: IntegrationsCatalogController;
  totalItems: number;
}): ReactElement {
  switch (state.view) {
    case "catalog":
      return (
        <SectionHeader
          title="Connections"
          description={`${state.filtered.length} of ${totalItems} entries. Connection health is prioritized; badges describe the actual owner and setup boundary.`}
        />
      );
    case "recipes":
      return (
        <SectionHeader
          title="Recipes"
          description={`${state.filteredRecipes.length} of ${state.recipes.length} bridge and native recipes shown. Ready recipes can be used today through native surfaces, webhooks, API, or Zapier-style bridges.`}
        />
      );
    case "coverage":
      return (
        <SectionHeader
          title="Readiness"
          description="Category maturity, public parity, native-managed progress, generated recipe breadth, and the next priority native gaps."
        />
      );
    case "stacks":
      return (
        <SectionHeader
          title="Customer use cases"
          description="Computed readiness for the newsletter, commerce, SaaS, agency, data, messaging, and enterprise stacks customers actually bring."
        />
      );
  }
}

export function IntegrationsBody({
  state,
  lifecycle,
  recipe,
  canAdmin,
}: {
  state: IntegrationsCatalogController;
  lifecycle: IntegrationLifecycleController;
  recipe: IntegrationRecipeController;
  canAdmin: boolean;
}): ReactElement {
  if (state.error && !state.catalog) return <></>;
  const allItems = state.catalog?.items ?? [];
  if (
    state.view === "recipes" &&
    state.recipes.length === 0 &&
    state.resourceIssues.some((issue) => issue.resource === "recipes")
  ) {
    return (
      <section className="int-report-unavailable" role="status">
        <span aria-hidden="true">?</span>
        <div>
          <h3>Recipe evidence is unavailable</h3>
          <p>
            Moosewave will not represent a failed recipe inventory as an empty
            library. Retry verification before choosing an implementation path.
          </p>
        </div>
      </section>
    );
  }
  const openBySlug = (slug: string): void => {
    const item = allItems.find((candidate) => candidate.slug === slug);
    if (item) void lifecycle.openDetail(item);
  };
  switch (state.view) {
    case "stacks":
      return (
        <StacksPanel
          report={state.stacks}
          loading={state.loading && !state.stacks}
          query={state.query}
          category={state.category}
          badge={state.badge}
          categoryLabels={state.categoryLabels}
          onOpenIntegration={openBySlug}
        />
      );
    case "coverage":
      return (
        <CoveragePanel
          coverage={state.coverage}
          readiness={state.readiness}
          loading={state.loading && !state.coverage}
          query={state.query}
          category={state.category}
          badge={state.badge}
          categoryLabels={state.categoryLabels}
          onOpenGap={openBySlug}
        />
      );
    case "recipes":
      return (
        <RecipeLibrary
          recipes={state.filteredRecipes}
          loading={state.loading && state.recipes.length === 0}
          onOpenRecipe={(item) => void recipe.openRecipeDetail(item)}
          onApplyRecipe={(item) => void recipe.applyRecipe(item)}
          applyingRecipeID={recipe.recipeApplyBusy}
          onOpenSource={openBySlug}
          canAdmin={canAdmin}
        />
      );
    case "catalog":
      return (
        <CatalogGrid
          items={state.filtered}
          connections={state.connectionMap}
          categoryLabels={state.categoryLabels}
          loading={state.loading && !state.catalog}
          busySlug={lifecycle.busySlug}
          canAdmin={canAdmin}
          onRunAction={lifecycle.runAction}
          onOpenDetail={lifecycle.openDetail}
          onOpenManage={lifecycle.openManage}
          onClearFilters={state.clearFilters}
        />
      );
  }
}

function CatalogGrid({
  items,
  connections,
  categoryLabels,
  loading,
  busySlug,
  canAdmin,
  onRunAction,
  onOpenDetail,
  onOpenManage,
  onClearFilters,
}: {
  items: IntegrationCatalogItem[];
  connections: Map<string, IntegrationConnection>;
  categoryLabels: Map<string, string>;
  loading: boolean;
  busySlug: string;
  canAdmin: boolean;
  onRunAction: IntegrationLifecycleController["runAction"];
  onOpenDetail: IntegrationLifecycleController["openDetail"];
  onOpenManage: IntegrationLifecycleController["openManage"];
  onClearFilters: () => void;
}): ReactElement {
  const pageSize = 48;
  const [visibleCount, setVisibleCount] = useState(pageSize);

  useEffect(() => {
    setVisibleCount(pageSize);
  }, [items]);

  if (loading) {
    return (
      <div className="int-catalog-grid" aria-label="Loading integrations">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="int-catalog-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
        ))}
        <span className="sr-only" role="status">
          Verifying the integration catalog.
        </span>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <section className="int-empty-state">
        <span className="int-empty-orbit" aria-hidden="true" />
        <div>
          <h3>No integrations match this view</h3>
          <p>
            Broaden the search or reset filters to return to the verified
            catalog.
          </p>
        </div>
        <button type="button" className="btn" onClick={onClearFilters}>
          Reset filters
        </button>
      </section>
    );
  }
  const visibleItems = items.slice(0, visibleCount);
  return (
    <>
      <div className="int-catalog-grid" aria-label="Integration catalog">
        {visibleItems.map((item) => (
          <CatalogCard
            key={item.slug}
            item={item}
            connection={connections.get(item.slug)}
            categoryLabels={categoryLabels}
            busy={busySlug === item.slug}
            operationBusy={busySlug !== ""}
            canAdmin={canAdmin}
            onRunAction={onRunAction}
            onOpenDetail={onOpenDetail}
            onOpenManage={onOpenManage}
          />
        ))}
      </div>
      {visibleItems.length < items.length ? (
        <div className="int-catalog-more">
          <span aria-live="polite">
            Showing {visibleItems.length} of {items.length} integrations
          </span>
          <button
            type="button"
            className="btn"
            onClick={() =>
              setVisibleCount((current) =>
                Math.min(items.length, current + pageSize),
              )
            }
          >
            Show {Math.min(pageSize, items.length - visibleItems.length)} more
          </button>
        </div>
      ) : null}
    </>
  );
}

function CatalogCard({
  item,
  connection,
  categoryLabels,
  busy,
  operationBusy,
  canAdmin,
  onRunAction,
  onOpenDetail,
  onOpenManage,
}: {
  item: IntegrationCatalogItem;
  connection?: IntegrationConnection;
  categoryLabels: Map<string, string>;
  busy: boolean;
  operationBusy: boolean;
  canAdmin: boolean;
  onRunAction: IntegrationLifecycleController["runAction"];
  onOpenDetail: IntegrationLifecycleController["openDetail"];
  onOpenManage: IntegrationLifecycleController["openManage"];
}): ReactElement {
  const connected = connection?.connected ?? false;
  const status =
    connection?.status ??
    (item.runtime_status === "planned" ? "planned" : "not_configured");
  const connectionCount = Math.max(
    connection?.count ?? 0,
    connection?.connection_ids?.length ?? 0,
  );
  const supportRuntimeHeld =
    nativeProviderFamily(item) === "support_integration";
  const unavailableReason =
    item.runtime_status === "planned"
      ? "This integration is planned and cannot connect yet."
      : !canAdmin
        ? "Admin role required to configure or sync integrations."
        : connected && connectionCount > 1
          ? "Choose one exact configured account in Manage before syncing."
          : operationBusy
            ? "Wait for the current integration operation to finish."
            : null;
  const actionReasonId = `integration-card-${item.slug}-action-reason`;
  const titleId = `integration-card-${item.slug}-title`;
  const capabilityOverflow = Math.max(0, item.capabilities.length - 3);
  const configurationOnly =
    !connected && nativeConnectTarget(item, "connect") !== null;
  return (
    <article
      className="int-catalog-card"
      data-connected={connected ? "true" : undefined}
      data-attention={
        connection && connectionNeedsAttention(connection) ? "true" : undefined
      }
      data-runtime={item.runtime_status}
      aria-labelledby={titleId}
    >
      <div className="int-card-accent" aria-hidden="true" />
      <header className="int-card-header">
        <div className="int-card-identity">
          <BrandIcon slug={item.slug} name={item.name} />
          <div>
            <h3 id={titleId}>{item.name}</h3>
            <div className="int-card-category">
              {categoryLabel(item.category, categoryLabels)}
            </div>
          </div>
        </div>
        <span
          className="int-owner-badge"
          style={
            {
              "--int-badge-tone": badgeTone(item.badge),
              color: badgeTone(item.badge),
            } as CSSProperties
          }
        >
          {badgeLabel(item.badge, item.runtime_status)}
        </span>
      </header>
      <p className="int-card-summary">{item.summary}</p>
      <div className="int-card-capabilities" aria-label="Capabilities">
        {(item.capabilities ?? []).slice(0, 3).map((capability) => (
          <span key={capability} className="int-capability-chip">
            {categoryLabel(capability, new Map())}
          </span>
        ))}
        {capabilityOverflow > 0 ? (
          <span className="int-capability-more">+{capabilityOverflow}</span>
        ) : null}
      </div>
      <div className="int-card-footer">
        <CatalogCardStatus
          item={item}
          connection={connection}
          connected={connected}
          status={status}
        />
        <div className="int-card-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={Boolean(unavailableReason)}
            aria-describedby={unavailableReason ? actionReasonId : undefined}
            onClick={() => {
              if (unavailableReason) return;
              void onRunAction(item, connected ? "sync" : "connect");
            }}
          >
            {connected ? <IconRefresh /> : <IconPlug />}
            {busy
              ? "Working"
              : supportRuntimeHeld
                ? "View hold"
              : connected
                ? "Sync now"
                : item.runtime_status === "planned"
                  ? "Planned"
                  : configurationOnly
                    ? "Configure"
                    : "Connect"}
          </button>
          {unavailableReason ? (
            <span id={actionReasonId} className="int-action-reason">
              {unavailableReason}
            </span>
          ) : null}
          <button
            type="button"
            className="btn"
            onClick={() => void onOpenDetail(item)}
          >
            Inspect
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              supportRuntimeHeld
                ? void onOpenDetail(item)
                : onOpenManage(
                    connection?.manage_path ?? item.setup_path ?? item.docs_url,
                    item,
                  )
            }
          >
            <IconArrow />
            {supportRuntimeHeld
              ? "Catalog record"
              : connected
                ? "Manage"
                : "Setup guide"}
          </button>
        </div>
      </div>
    </article>
  );
}

function CatalogCardStatus({
  item,
  connection,
  connected,
  status,
}: {
  item: IntegrationCatalogItem;
  connection?: IntegrationConnection;
  connected: boolean;
  status: string;
}): ReactElement {
  const healthState =
    connection?.health_state ?? (connected ? "healthy" : status);
  const lastSync = connection?.last_sync_at
    ? new Date(connection.last_sync_at)
    : null;
  const validLastSync =
    lastSync && !Number.isNaN(lastSync.valueOf()) ? lastSync : null;
  return (
    <div className="int-card-status">
      <div className="int-health-line">
        <span
          className="int-health-state"
          style={
            { "--int-health-tone": healthTone(healthState) } as CSSProperties
          }
        >
          <span aria-hidden="true" />
          {categoryLabel(healthState, new Map())}
        </span>
        {connection?.count ? (
          <span className="int-card-count">{connection.count} configured</span>
        ) : item.phase ? (
          <span className="int-card-count">Month {item.phase}</span>
        ) : null}
      </div>
      {validLastSync ? (
        <time className="int-last-sync" dateTime={validLastSync.toISOString()}>
          Last sync{" "}
          {new Intl.DateTimeFormat(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }).format(validLastSync)}
        </time>
      ) : null}
      {connection?.last_error ? (
        <div
          className="int-card-message int-card-message--danger"
          role="status"
        >
          {connection.last_error}
        </div>
      ) : connection?.health_message ? (
        <div className="int-card-message">{connection.health_message}</div>
      ) : null}
    </div>
  );
}

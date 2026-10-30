import {
  type ReactElement,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import type { RemoteResourceController } from "../../hooks/useRemoteResource";
import type {
  MigrationJob,
  MigrationSource,
  MigrationSourceCapability,
} from "../../lib/api-client";
import { HERO } from "../../lib/heroAssets";
import {
  applyRuntimeMigrationCapability,
  findSource,
  MIGRATION_SOURCES,
  type MigrationSourceDef,
  type MigrationSourceId,
} from "../../lib/migration-sources";
import { ChoiceGroup } from "../ChoiceGroup";
import { HeroEmptyState } from "../HeroEmptyState";
import {
  formatMigrationAbsoluteTime,
  formatMigrationCount,
  formatMigrationRelativeTime,
  isMigrationCancellable,
  isMigrationInFlight,
  MIGRATION_FILTERS,
  migrationOverallProgress,
  migrationRollbackEligibility,
  migrationStatusLabel,
  migrationStatusTone,
  migrationTimeDateTime,
  type MigrationCounts,
  type MigrationStatusFilter,
} from "./migrations-surface-helpers";
import { useMigrationClock } from "./useMigrationClock";

interface MigrationHistorySurfaceProps {
  jobs: RemoteResourceController<MigrationJob[]>;
  sources: RemoteResourceController<MigrationSourceCapability[]>;
  filteredJobs: MigrationJob[];
  counts: MigrationCounts;
  filter: MigrationStatusFilter;
  canAdmin: boolean;
  refreshing: boolean;
  onFilter: (filter: MigrationStatusFilter) => void;
  onRefresh: () => void;
  onStart: (source?: MigrationSourceId) => void;
  onView: (job: MigrationJob) => void;
  onRollback: (job: MigrationJob) => void;
  onCancel: (job: MigrationJob) => void;
}

export function MigrationHistorySurface({
  jobs,
  sources,
  filteredJobs,
  counts,
  filter,
  canAdmin,
  refreshing,
  onFilter,
  onRefresh,
  onStart,
  onView,
  onRollback,
  onCancel,
}: MigrationHistorySurfaceProps): ReactElement {
  const actionReasonId = useId();
  const refreshReasonId = useId();
  const now = useMigrationClock();
  const sourceSectionRef = useRef<HTMLElement>(null);
  const sourceSearchRef = useRef<HTMLInputElement>(null);
  const verifiedJobs = jobs.data ?? [];
  const initialHistoryFailure =
    jobs.data === null && jobs.transport === "error";
  const startUnavailableReason = migrationStartUnavailableReason(
    canAdmin,
    sources,
  );
  const summary = initialHistoryFailure
    ? "Migration history could not be verified"
    : jobs.data === null
      ? "Migration history is being verified"
      : verifiedJobs.length === 0
        ? "No migration jobs in the verified history"
        : `${verifiedJobs.length} verified job${verifiedJobs.length === 1 ? "" : "s"} · ${counts.completed} completed${counts.in_flight > 0 ? ` · ${counts.in_flight} in flight` : ""}`;

  return (
    <div className="migration-surface">
      <header className="migration-page-header">
        <div>
          <h1 className="page-title">Migrations</h1>
          <p className="page-subtitle" aria-live="polite">
            {summary}
          </p>
          {jobs.lastVerifiedAt !== null ? (
            <p className="migration-verification-stamp">
              History verified{" "}
              <TimeEvidence value={jobs.lastVerifiedAt} now={now} />
              {jobs.stale ? " · showing the last verified snapshot" : ""}
            </p>
          ) : null}
        </div>
        <div className="migration-header-actions">
          <button
            type="button"
            className="btn"
            aria-disabled={refreshing || undefined}
            aria-describedby={refreshing ? refreshReasonId : undefined}
            onClick={() => {
              if (!refreshing) onRefresh();
            }}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            aria-disabled={startUnavailableReason ? true : undefined}
            aria-describedby={
              startUnavailableReason ? actionReasonId : undefined
            }
            onClick={() => {
              if (!startUnavailableReason) onStart();
            }}
          >
            New migration
          </button>
          {refreshing ? (
            <span id={refreshReasonId} className="migration-action-reason">
              A history and capability refresh is already in progress.
            </span>
          ) : null}
          {startUnavailableReason ? (
            <span id={actionReasonId} className="migration-action-reason">
              {startUnavailableReason}
            </span>
          ) : null}
        </div>
      </header>

      <MigrationOperationsOverview
        jobs={jobs}
        sources={sources}
        counts={counts}
        canAdmin={canAdmin}
        onFilter={onFilter}
        onChooseSource={() => {
          sourceSectionRef.current?.scrollIntoView({
            block: "start",
            behavior: "smooth",
          });
          sourceSearchRef.current?.focus();
        }}
      />

      <MigrationSourcePlatforms
        resource={sources}
        canAdmin={canAdmin}
        refreshing={refreshing}
        permissionReasonId={actionReasonId}
        sectionRef={sourceSectionRef}
        searchInputRef={sourceSearchRef}
        now={now}
        onRetry={onRefresh}
        onStart={onStart}
      />

      <MigrationHistory
        resource={jobs}
        jobs={filteredJobs}
        counts={counts}
        filter={filter}
        canAdmin={canAdmin}
        refreshing={refreshing}
        now={now}
        permissionReasonId={actionReasonId}
        onFilter={onFilter}
        onRetry={onRefresh}
        onStart={onStart}
        onView={onView}
        onRollback={onRollback}
        onCancel={onCancel}
      />
    </div>
  );
}

function migrationStartUnavailableReason(
  canAdmin: boolean,
  sources: RemoteResourceController<MigrationSourceCapability[]>,
): string | null {
  if (!canAdmin) {
    return "Viewer mode: an admin role is required to start, stop, resume, or roll back tenant migrations.";
  }
  if (sources.data === null && sources.transport === "error") {
    return "Migration setup is unavailable until the source capability catalog is successfully reverified.";
  }
  if (sources.data === null) {
    return "Migration setup will be available after the source capability catalog is verified.";
  }
  if (sources.stale) {
    return "Migration setup is unavailable while the source capability catalog is stale. Retry verification first.";
  }
  if (sources.transport !== "ready") {
    return "Migration setup is unavailable while the source capability catalog is being refreshed.";
  }
  return null;
}

function MigrationOperationsOverview({
  jobs,
  sources,
  counts,
  canAdmin,
  onFilter,
  onChooseSource,
}: {
  jobs: RemoteResourceController<MigrationJob[]>;
  sources: RemoteResourceController<MigrationSourceCapability[]>;
  counts: MigrationCounts;
  canAdmin: boolean;
  onFilter: (filter: MigrationStatusFilter) => void;
  onChooseSource: () => void;
}): ReactElement {
  const capabilityPosture = useMemo(
    () => migrationCapabilityPosture(sources.data),
    [sources.data],
  );
  const verified = jobs.data !== null;
  const initialHistoryFailure = !verified && jobs.transport === "error";
  const nextAction = jobs.stale
    ? {
        eyebrow: "Fresh verification required",
        title: "Refresh before making an operator decision",
        body: "The last verified snapshot remains useful for review, but no stale read is promoted into a migration decision.",
        label: null,
        action: null,
      }
    : initialHistoryFailure
      ? {
          eyebrow: "Verification required",
          title: "Migration history is unavailable",
          body: "Retry the history read before making an operator decision. No lifecycle count or job action is inferred from an unverified response.",
          label: null,
          action: null,
        }
      : !verified
        ? {
            eyebrow: "Establishing operational truth",
            title: "Waiting for verified migration history",
            body: "Lifecycle counts stay unavailable until the server response passes the migration contract.",
            label: null,
            action: null,
          }
        : counts.failed > 0
          ? {
              eyebrow: "Attention first",
              title: `${counts.failed.toLocaleString()} migration${counts.failed === 1 ? " needs" : "s need"} review`,
              body: "Inspect the exact checkpoint and verification evidence before retrying, resuming, or rolling back.",
              label: "Review failed jobs",
              action: () => onFilter("failed"),
            }
          : counts.in_flight > 0
            ? {
                eyebrow: "Work in motion",
                title: `${counts.in_flight.toLocaleString()} migration${counts.in_flight === 1 ? " is" : "s are"} active`,
                body: "Monitor durable checkpoints and keep the source available until reconciliation completes.",
                label: "Monitor active jobs",
                action: () => onFilter("in_flight"),
              }
            : counts.completed > 0
              ? {
                  eyebrow: "Reconciliation window",
                  title: "Review completed migration evidence",
                  body: "Completion is not cutover certification. Confirm destination counts, limitations, and rollback timing.",
                  label: "Review completed jobs",
                  action: () => onFilter("completed"),
                }
              : {
                  eyebrow: "Ready to scope",
                  title: "Start with a verified source adapter",
                  body: "Choose a source, authorize the minimum required access, and inspect a dry-run before any destination write.",
                  label: canAdmin ? "Choose a source" : null,
                  action: canAdmin ? onChooseSource : null,
                };

  return (
    <section
      className="migration-control-room"
      aria-labelledby="migration-control-room-title"
    >
      <div className="migration-control-room-main">
        <div className="migration-control-room-heading">
          <div>
            <span className="migration-eyebrow">Migration control room</span>
            <h2 id="migration-control-room-title">Operational posture</h2>
          </div>
          <span
            className={`migration-live-signal${counts.in_flight > 0 ? " is-live" : ""}`}
          >
            <span aria-hidden="true" />
            {jobs.stale
              ? "Last verified snapshot"
              : verified
                ? counts.in_flight > 0
                  ? "Live work detected"
                  : "History verified"
                : initialHistoryFailure
                  ? "Verification required"
                  : "Verification pending"}
          </span>
        </div>
        <dl className="migration-operations-metrics">
          <div>
            <dt>In flight</dt>
            <dd>
              <strong>
                {verified ? counts.in_flight.toLocaleString() : "—"}
              </strong>
              <span>durable jobs</span>
            </dd>
          </div>
          <div className={counts.failed > 0 ? "is-attention" : undefined}>
            <dt>Needs review</dt>
            <dd>
              <strong>{verified ? counts.failed.toLocaleString() : "—"}</strong>
              <span>failed jobs</span>
            </dd>
          </div>
          <div>
            <dt>Completed</dt>
            <dd>
              <strong>
                {verified ? counts.completed.toLocaleString() : "—"}
              </strong>
              <span>not cutover proof</span>
            </dd>
          </div>
          <div>
            <dt>Write-ready sources</dt>
            <dd>
              <strong>
                {sources.data === null
                  ? "—"
                  : capabilityPosture.writeReady.toLocaleString()}
              </strong>
              <span>
                {capabilityPosture.dryRunOnly > 0
                  ? `${capabilityPosture.dryRunOnly.toLocaleString()} dry-run only`
                  : "deployment attested"}
              </span>
            </dd>
          </div>
        </dl>
        <div className="migration-assurance-strip" aria-label="Safety gates">
          <span>
            <strong>1</strong> Verify adapter
          </span>
          <span>
            <strong>2</strong> Scope source
          </span>
          <span>
            <strong>3</strong> Review dry-run
          </span>
          <span>
            <strong>4</strong> Reconcile evidence
          </span>
        </div>
      </div>
      <aside className="migration-next-action" aria-label="Recommended action">
        <span className="migration-eyebrow">{nextAction.eyebrow}</span>
        <strong>{nextAction.title}</strong>
        <p>{nextAction.body}</p>
        {nextAction.label && nextAction.action ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={nextAction.action}
          >
            {nextAction.label}
          </button>
        ) : null}
      </aside>
    </section>
  );
}

function migrationCapabilityPosture(
  capabilities: MigrationSourceCapability[] | null,
): { writeReady: number; dryRunOnly: number; blocked: number } {
  if (capabilities === null) {
    return { writeReady: 0, dryRunOnly: 0, blocked: 0 };
  }
  let writeReady = 0;
  let dryRunOnly = 0;
  let blocked = 0;
  for (const capability of capabilities) {
    const definition = findSource(capability.source);
    if (!definition) {
      blocked += 1;
      continue;
    }
    const source = applyRuntimeMigrationCapability(definition, capability);
    if (!source.serverSupport || source.intakeAvailable === false) {
      blocked += 1;
    } else if (source.commitAvailable === true) {
      writeReady += 1;
    } else {
      dryRunOnly += 1;
    }
  }
  return { writeReady, dryRunOnly, blocked };
}

type MigrationSourceView =
  | "all"
  | "ready"
  | "dry_run"
  | "blocked"
  | "oauth2"
  | "api_key"
  | "csv_upload";

function MigrationSourcePlatforms({
  resource,
  canAdmin,
  refreshing,
  permissionReasonId,
  sectionRef,
  searchInputRef,
  now,
  onRetry,
  onStart,
}: {
  resource: RemoteResourceController<MigrationSourceCapability[]>;
  canAdmin: boolean;
  refreshing: boolean;
  permissionReasonId: string;
  sectionRef: RefObject<HTMLElement | null>;
  searchInputRef: RefObject<HTMLInputElement | null>;
  now: number;
  onRetry: () => void;
  onStart: (source?: MigrationSourceId) => void;
}): ReactElement {
  const freshnessReasonId = useId();
  const sourceSearchId = useId();
  const sourceViewId = useId();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<MigrationSourceView>("all");
  const capabilities = resource.data;
  const sources = useMemo(
    () =>
      capabilities === null
        ? []
        : MIGRATION_SOURCES.map((source) => {
            const capability = capabilities.find(
              (candidate) => candidate.source === source.id,
            );
            return {
              source: applyRuntimeMigrationCapability(source, capability),
              capability,
            };
          }).filter(
            (
              candidate,
            ): candidate is {
              source: MigrationSourceDef;
              capability: MigrationSourceCapability;
            } => Boolean(candidate.capability),
          ),
    [capabilities],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleSources = useMemo(
    () =>
      sources.filter(({ source, capability }) => {
        const matchesQuery =
          !normalizedQuery ||
          [
            source.name,
            source.id,
            authMethodLabel(capability.auth_method),
            sourceCapabilitySummary(capability),
          ].some((value) =>
            value.toLocaleLowerCase().includes(normalizedQuery),
          );
        if (!matchesQuery) return false;
        const blocked =
          !source.serverSupport || source.intakeAvailable === false;
        if (view === "ready")
          return !blocked && source.commitAvailable === true;
        if (view === "dry_run") {
          return !blocked && source.commitAvailable !== true;
        }
        if (view === "blocked") return blocked;
        if (view === "oauth2" || view === "api_key" || view === "csv_upload") {
          return capability.auth_method === view;
        }
        return true;
      }),
    [normalizedQuery, sources, view],
  );

  return (
    <section
      ref={sectionRef}
      className="migration-source-section"
      aria-labelledby="migration-sources-title"
      tabIndex={-1}
    >
      <div className="migration-section-heading">
        <div>
          <h2 id="migration-sources-title">
            Server-supported source platforms
          </h2>
          <p>
            Search the server-verified catalog. Readiness, authorization, and
            destination-write posture come from this deployment—not from a
            static compatibility claim.
          </p>
        </div>
      </div>
      {resource.failure ? (
        <SafeResourceNotice
          stale={resource.stale}
          message={resource.failure.message}
          reference={failureReference(resource.failure)}
          refreshing={refreshing}
          onRetry={onRetry}
        />
      ) : null}
      {capabilities === null && resource.failure === null ? (
        <div
          className="migration-source-grid"
          aria-busy="true"
          aria-label="Verifying migration source availability"
        >
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="migration-source-card migration-source-card-skeleton"
              aria-hidden="true"
            />
          ))}
        </div>
      ) : capabilities === null ? (
        <div className="migration-empty-panel" role="status">
          <strong>No verified source catalog is available.</strong>
          <span>
            Retry verification before choosing a migration source. Static
            marketing claims are not being substituted for server capability.
          </span>
        </div>
      ) : sources.length === 0 ? (
        <div className="migration-empty-panel" role="status">
          <strong>
            No compatible migration adapters are available in this desktop
            build.
          </strong>
          <span>
            The server returned a verified catalog with no source and
            authorization combination this client can start.
          </span>
        </div>
      ) : (
        <>
          <div className="migration-source-controls">
            <div className="field">
              <label className="field-label" htmlFor={sourceSearchId}>
                Search source platforms
              </label>
              <div className="migration-search-input-row">
                <input
                  ref={searchInputRef}
                  id={sourceSearchId}
                  className="input"
                  type="search"
                  value={query}
                  placeholder="Platform, authorization, or resource"
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setQuery("")}
                  >
                    Clear source search
                  </button>
                ) : null}
              </div>
            </div>
            <div className="field">
              <label className="field-label" htmlFor={sourceViewId}>
                Show sources
              </label>
              <select
                id={sourceViewId}
                className="select"
                value={view}
                onChange={(event) =>
                  setView(event.target.value as MigrationSourceView)
                }
              >
                <option value="all">All verified adapters</option>
                <option value="ready">Write-ready</option>
                <option value="dry_run">Dry-run only</option>
                <option value="blocked">Setup blocked</option>
                <option value="oauth2">OAuth</option>
                <option value="api_key">API credential</option>
                <option value="csv_upload">File upload</option>
              </select>
            </div>
            <p className="migration-source-result-count" aria-live="polite">
              {visibleSources.length.toLocaleString()} of{" "}
              {sources.length.toLocaleString()} verified adapter
              {sources.length === 1 ? "" : "s"}
            </p>
          </div>
          {visibleSources.length === 0 ? (
            <div className="migration-empty-panel" role="status">
              <strong>No source matches this view.</strong>
              <span>
                Change the readiness filter or clear the source search; the
                verified catalog remains unchanged.
              </span>
            </div>
          ) : (
            <ul
              className="migration-source-grid"
              aria-label="Verified migration sources"
            >
              {visibleSources.map(({ source, capability }) => (
                <MigrationSourceCard
                  key={source.id}
                  source={source}
                  capability={capability}
                  canAdmin={canAdmin}
                  stale={resource.stale}
                  permissionReasonId={permissionReasonId}
                  freshnessReasonId={freshnessReasonId}
                  onStart={() => onStart(source.id)}
                />
              ))}
            </ul>
          )}
        </>
      )}
      {resource.stale ? (
        <p id={freshnessReasonId} className="migration-action-reason">
          Starting from a source card is unavailable until the capability
          catalog is freshly verified. Retry verification first.
        </p>
      ) : null}
      {resource.lastVerifiedAt !== null ? (
        <p className="migration-verification-stamp">
          Capability catalog verified{" "}
          <TimeEvidence value={resource.lastVerifiedAt} now={now} />
          {resource.stale ? " · last verified data retained" : ""}
        </p>
      ) : null}
    </section>
  );
}

function MigrationSourceCard({
  source,
  capability,
  canAdmin,
  stale,
  permissionReasonId,
  freshnessReasonId,
  onStart,
}: {
  source: MigrationSourceDef;
  capability: MigrationSourceCapability;
  canAdmin: boolean;
  stale: boolean;
  permissionReasonId: string;
  freshnessReasonId: string;
  onStart: () => void;
}): ReactElement {
  const localReasonId = `migration-source-${safeDomId(source.id)}-reason`;
  const blockedReason = !source.serverSupport
    ? (source.runtimeCompatibilityError ??
      "This desktop cannot satisfy the deployment authorization contract.")
    : source.intakeAvailable === false
      ? (source.intakeUnavailableReason ??
        "This deployment has not attested a safe source-intake path.")
      : null;
  const unavailableReason = !canAdmin
    ? "Admin role required"
    : stale
      ? "Capability verification is stale"
      : blockedReason;
  const canStart = unavailableReason === null;
  const posture = blockedReason
    ? "Setup blocked"
    : source.commitAvailable === true
      ? "Write-ready"
      : "Dry-run only";
  const postureTone = blockedReason
    ? "is-blocked"
    : source.commitAvailable === true
      ? "is-ready"
      : "is-review";

  return (
    <li>
      <article className={`migration-source-card ${postureTone}`}>
        <header className="migration-source-card-header">
          <SourceIdentity source={source.id} size="large" />
          <span className={`migration-source-posture ${postureTone}`}>
            {posture}
          </span>
        </header>
        <div className="migration-source-chip-row">
          <span>{authMethodLabel(capability.auth_method)}</span>
          {capability.supports?.automation_mode === "runtime" ? (
            <span>Paused automation import</span>
          ) : capability.supports?.automation_mode === "rebuild_review" ? (
            <span>Automation rebuild evidence</span>
          ) : null}
        </div>
        <p className="migration-source-summary">
          {sourceCapabilitySummary(capability)}
        </p>
        {blockedReason ? (
          <p id={localReasonId} className="migration-source-blocked-reason">
            {blockedReason}
          </p>
        ) : source.commitAvailable !== true ? (
          <p className="migration-source-blocked-reason">
            {source.commitUnavailableReason ??
              "A real import is unavailable until the deployment attests an isolated destination."}
          </p>
        ) : null}
        <details className="migration-source-disclosure">
          <summary>Imports, evidence, and limitations</summary>
          <p>{sourceCapabilityTruth(source.id, capability)}</p>
        </details>
        <footer className="migration-source-card-footer">
          <span>
            {blockedReason
              ? "No credentials accepted"
              : source.commitAvailable === true
                ? "Dry-run required before writes"
                : "Review remains non-writing"}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            aria-label={
              canStart
                ? `Start ${source.name} migration`
                : `Start ${source.name} migration unavailable: ${unavailableReason}`
            }
            aria-disabled={!canStart || undefined}
            aria-describedby={
              !canAdmin
                ? permissionReasonId
                : stale
                  ? freshnessReasonId
                  : blockedReason
                    ? localReasonId
                    : undefined
            }
            onClick={() => {
              if (canStart) onStart();
            }}
          >
            {blockedReason
              ? "Unavailable"
              : source.commitAvailable === true
                ? "Prepare migration"
                : "Prepare dry-run"}
          </button>
        </footer>
      </article>
    </li>
  );
}

function sourceCapabilitySummary(
  capability: MigrationSourceCapability,
): string {
  const labels: Array<
    [keyof NonNullable<MigrationSourceCapability["supports"]>, string]
  > = [
    ["subscribers", "subscribers"],
    ["segments", "segments"],
    ["templates", "templates"],
    ["campaign_archive", "campaign history"],
    ["paid_subs", "paid-membership evidence"],
    ["consent_timestamps", "consent timestamps"],
    ["crm", "CRM evidence"],
    ["custom_objects", "custom-object evidence"],
    ["sms", "SMS evidence"],
  ];
  const supported = labels
    .filter(([key]) => capability.supports?.[key] === true)
    .map(([, label]) => label);
  if (supported.length === 0) {
    return "The adapter is registered; preflight will enumerate exact resource coverage.";
  }
  const visible = supported.slice(0, 3);
  const remainder = supported.length - visible.length;
  return `Covers ${visible.join(", ")}${remainder > 0 ? `, plus ${remainder.toLocaleString()} more evidence area${remainder === 1 ? "" : "s"}` : ""}. Preflight remains authoritative.`;
}

function MigrationHistory({
  resource,
  jobs,
  counts,
  filter,
  canAdmin,
  refreshing,
  now,
  permissionReasonId,
  onFilter,
  onRetry,
  onStart,
  onView,
  onRollback,
  onCancel,
}: {
  resource: RemoteResourceController<MigrationJob[]>;
  jobs: MigrationJob[];
  counts: MigrationCounts;
  filter: MigrationStatusFilter;
  canAdmin: boolean;
  refreshing: boolean;
  now: number;
  permissionReasonId: string;
  onFilter: (filter: MigrationStatusFilter) => void;
  onRetry: () => void;
  onStart: (source?: MigrationSourceId) => void;
  onView: (job: MigrationJob) => void;
  onRollback: (job: MigrationJob) => void;
  onCancel: (job: MigrationJob) => void;
}): ReactElement {
  const [query, setQuery] = useState("");
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(0);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const searchedJobs = useMemo(
    () =>
      normalizedQuery
        ? jobs.filter((job) => {
            const sourceName = findSource(job.source)?.name ?? "";
            return [
              job.id,
              job.source,
              sourceName,
              migrationStatusLabel(job.status),
            ].some((value) =>
              value.toLocaleLowerCase().includes(normalizedQuery),
            );
          })
        : jobs,
    [jobs, normalizedQuery],
  );
  const pageCount = Math.max(1, Math.ceil(searchedJobs.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visibleJobs = searchedJobs.slice(
    safePage * pageSize,
    safePage * pageSize + pageSize,
  );

  useEffect(() => setPage(0), [filter, normalizedQuery, pageSize]);
  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1);
  }, [page, pageCount]);

  const options = MIGRATION_FILTERS.map(({ value, label }) => ({
    value,
    label: (
      <span>
        {label} <span className="tabular">({counts[value]})</span>
      </span>
    ),
  }));
  return (
    <section aria-labelledby="migration-history-heading">
      <div className="migration-section-heading">
        <div>
          <h2 id="migration-history-heading">Migration history</h2>
          <p>
            Every row is a server-verified job. Open one for live checkpoints,
            source limitations, and verification evidence. Completed jobs expose
            their exact rollback deadline; an absent or expired deadline is
            never treated as eligible.
          </p>
        </div>
      </div>
      {resource.data !== null ? (
        <>
          <ChoiceGroup
            legend="Filter migration history by status"
            value={filter}
            options={options}
            onChange={onFilter}
            className="migration-filter-group"
          />
          <MigrationHistoryControls
            query={query}
            pageSize={pageSize}
            page={safePage}
            pageCount={pageCount}
            resultCount={searchedJobs.length}
            onQuery={setQuery}
            onPageSize={setPageSize}
            onPage={setPage}
          />
        </>
      ) : null}
      {resource.failure ? (
        <SafeResourceNotice
          stale={resource.stale}
          message={resource.failure.message}
          reference={failureReference(resource.failure)}
          refreshing={refreshing}
          onRetry={onRetry}
        />
      ) : null}
      {resource.data === null && resource.failure === null ? (
        <div
          className="migration-history-loading"
          aria-busy="true"
          aria-label="Verifying migration history"
        >
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="skel-row" aria-hidden="true" />
          ))}
        </div>
      ) : resource.data === null ? (
        <div className="migration-empty-panel" role="status">
          <strong>No verified migration history is available.</strong>
          <span>
            Retry the read. No empty-history claim or job action is available
            until the server response is verified.
          </span>
        </div>
      ) : visibleJobs.length === 0 ? (
        resource.data.length === 0 ? (
          <HeroEmptyState
            tone="neutral"
            eyebrow="Verified empty history"
            title="Move from a supported platform with a dry-run first."
            subtitle="Moosewave imports only source-supported data, preserves verification evidence, and identifies automations, dynamic rules, billing objects, or metadata that require review or rebuild."
            primaryCta={
              canAdmin
                ? { label: "Start migration", onClick: () => onStart() }
                : undefined
            }
            imageSrc={HERO.migrations}
            imageAlt="Two moving boxes representing a data transfer"
          />
        ) : (
          <div className="migration-empty-panel" role="status">
            <strong>No jobs match the current filter and search.</strong>
            <span>
              Change or clear the search and status filter; the verified history
              remains unchanged.
            </span>
          </div>
        )
      ) : (
        <div
          className="migration-table-region"
          role="region"
          aria-label="Migration job history"
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard users must be able to reach and scroll the overflow region
          tabIndex={0}
        >
          <table className="migration-history-table">
            <caption className="sr-only">
              Verified migration jobs with source, identifier, status, timing,
              progress, and available actions
            </caption>
            <thead>
              <tr>
                <th scope="col">Source and job</th>
                <th scope="col">Status</th>
                <th scope="col">Started</th>
                <th scope="col">Progress</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleJobs.map((job) => (
                <MigrationHistoryRow
                  key={job.id}
                  job={job}
                  canAdmin={canAdmin}
                  permissionReasonId={permissionReasonId}
                  now={now}
                  onView={() => onView(job)}
                  onRollback={() => onRollback(job)}
                  onCancel={() => onCancel(job)}
                />
              ))}
            </tbody>
          </table>
          <MigrationPaginationSummary
            page={safePage}
            pageSize={pageSize}
            count={searchedJobs.length}
          />
        </div>
      )}
    </section>
  );
}

function MigrationHistoryControls({
  query,
  pageSize,
  page,
  pageCount,
  resultCount,
  onQuery,
  onPageSize,
  onPage,
}: {
  query: string;
  pageSize: number;
  page: number;
  pageCount: number;
  resultCount: number;
  onQuery: (value: string) => void;
  onPageSize: (value: number) => void;
  onPage: (value: number) => void;
}): ReactElement {
  const queryId = useId();
  const clearReasonId = useId();
  const pageSizeId = useId();
  const previousReasonId = useId();
  const nextReasonId = useId();
  const atStart = page === 0;
  const atEnd = page >= pageCount - 1;
  return (
    <div className="migration-history-controls">
      <div className="field migration-history-search">
        <label className="field-label" htmlFor={queryId}>
          Search verified jobs
        </label>
        <div className="migration-search-input-row">
          <input
            id={queryId}
            className="input"
            type="search"
            value={query}
            placeholder="Job ID, source, or status"
            onChange={(event) => onQuery(event.target.value)}
          />
          <button
            type="button"
            className="btn btn-sm"
            aria-disabled={!query || undefined}
            aria-describedby={!query ? clearReasonId : undefined}
            onClick={() => {
              if (query) onQuery("");
            }}
          >
            Clear search
          </button>
          {!query ? (
            <span id={clearReasonId} className="sr-only">
              The search field is already empty.
            </span>
          ) : null}
        </div>
      </div>
      <div className="field migration-page-size">
        <label className="field-label" htmlFor={pageSizeId}>
          Jobs per page
        </label>
        <select
          id={pageSizeId}
          className="select"
          value={pageSize}
          onChange={(event) => onPageSize(Number(event.target.value))}
        >
          <option value={25}>25</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>
      </div>
      <div
        className="migration-page-actions"
        aria-label="Migration history pages"
      >
        <span aria-live="polite">
          {resultCount.toLocaleString()} matching job
          {resultCount === 1 ? "" : "s"} · page {page + 1} of {pageCount}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          aria-disabled={atStart || undefined}
          aria-describedby={atStart ? previousReasonId : undefined}
          onClick={() => {
            if (!atStart) onPage(page - 1);
          }}
        >
          Previous page
        </button>
        <button
          type="button"
          className="btn btn-sm"
          aria-disabled={atEnd || undefined}
          aria-describedby={atEnd ? nextReasonId : undefined}
          onClick={() => {
            if (!atEnd) onPage(page + 1);
          }}
        >
          Next page
        </button>
        {atStart ? (
          <span id={previousReasonId} className="sr-only">
            Already on the first results page.
          </span>
        ) : null}
        {atEnd ? (
          <span id={nextReasonId} className="sr-only">
            Already on the final results page.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function MigrationPaginationSummary({
  page,
  pageSize,
  count,
}: {
  page: number;
  pageSize: number;
  count: number;
}): ReactElement {
  const first = count === 0 ? 0 : page * pageSize + 1;
  const last = Math.min(count, page * pageSize + pageSize);
  return (
    <p className="migration-pagination-summary">
      Showing <span className="tabular">{first.toLocaleString()}</span>–
      <span className="tabular">{last.toLocaleString()}</span> of{" "}
      <span className="tabular">{count.toLocaleString()}</span> matching jobs
    </p>
  );
}

function MigrationHistoryRow({
  job,
  canAdmin,
  permissionReasonId,
  now,
  onView,
  onRollback,
  onCancel,
}: {
  job: MigrationJob;
  canAdmin: boolean;
  permissionReasonId: string;
  now: number;
  onView: () => void;
  onRollback: () => void;
  onCancel: () => void;
}): ReactElement {
  const inFlight = isMigrationInFlight(job.status);
  const cancellable = isMigrationCancellable(job.status);
  const rollback = migrationRollbackEligibility(job, canAdmin, now);
  const progress = migrationOverallProgress(job.progress, job.source);
  const subscribersDone =
    job.verification_report?.subscribers_imported ??
    job.progress?.subscribers_done;
  const subscribersTotal = job.progress?.subscribers_total;
  const progressLabel =
    subscribersDone !== undefined &&
    subscribersTotal !== undefined &&
    subscribersTotal > 0
      ? `${formatMigrationCount(subscribersDone)} of ${formatMigrationCount(subscribersTotal)} subscribers`
      : `${formatMigrationCount(subscribersDone)} subscribers reported`;
  const rollbackReasonId = `migration-rollback-${safeDomId(job.id)}`;

  return (
    <tr>
      <td data-label="Source and job">
        <SourceIdentity source={job.source} />
        <code className="migration-job-id">Job {job.id}</code>
      </td>
      <td data-label="Status">
        <MigrationStatusBadge status={job.status} />
      </td>
      <td data-label="Started">
        <TimeEvidence value={job.started_at} now={now} />
      </td>
      <td data-label="Progress">
        {job.status === "rolling_back" ? (
          <span className="migration-progress-count">
            Rollback is in progress. Original import scope: {progressLabel}.
            Open details for live rollback checkpoints.
          </span>
        ) : inFlight ? (
          <MigrationProgressMeter value={progress} label={progressLabel} />
        ) : (
          <span className="migration-progress-count">{progressLabel}</span>
        )}
      </td>
      <td data-label="Actions">
        <div className="migration-row-actions">
          <button type="button" className="btn btn-sm" onClick={onView}>
            View details
          </button>
          {cancellable ? (
            <button
              type="button"
              className="btn btn-sm btn-danger"
              aria-disabled={!canAdmin || undefined}
              aria-describedby={!canAdmin ? permissionReasonId : undefined}
              onClick={() => {
                if (canAdmin) onCancel();
              }}
            >
              Cancel job
            </button>
          ) : null}
          {job.status === "completed" ? (
            <button
              type="button"
              className="btn btn-sm btn-danger"
              aria-disabled={!rollback.allowed || undefined}
              aria-describedby={rollback.allowed ? undefined : rollbackReasonId}
              onClick={() => {
                if (rollback.allowed) onRollback();
              }}
            >
              Roll back
            </button>
          ) : null}
        </div>
        {job.status === "completed" && !rollback.allowed ? (
          <span id={rollbackReasonId} className="migration-row-reason">
            {rollback.reason}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

export function MigrationStatusBadge({
  status,
}: {
  status: MigrationJob["status"] | string | undefined;
}): ReactElement {
  const tone = migrationStatusTone(status);
  const className =
    tone === "neutral"
      ? "badge"
      : `badge ${tone === "accent" ? "accent" : tone}`;
  return <span className={className}>{migrationStatusLabel(status)}</span>;
}

export function MigrationProgressMeter({
  value,
  label,
}: {
  value: number | null;
  label: string;
}): ReactElement {
  const indeterminate = value === null;
  const fill = indeterminate ? 40 : value;
  return (
    <div className="migration-progress">
      <div
        className="migration-progress-track"
        role="progressbar"
        aria-label="Migration progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : fill}
        aria-valuetext={
          indeterminate
            ? `Verified percentage unavailable. ${label}`
            : `${fill}%. ${label}`
        }
      >
        <span
          className={`migration-progress-fill${indeterminate ? " is-indeterminate" : ""}${fill >= 100 ? " is-complete" : ""}`}
          style={{ width: `${fill}%` }}
        />
      </div>
      <span className="migration-progress-label">
        {label}
        {indeterminate ? " · percentage pending" : ` · ${fill}%`}
      </span>
    </div>
  );
}

export function TimeEvidence({
  value,
  now = Date.now(),
}: {
  value: unknown;
  now?: number;
}): ReactElement {
  const dateTime = migrationTimeDateTime(value);
  if (!dateTime) return <span className="migration-time">Not recorded</span>;
  return (
    <time className="migration-time" dateTime={dateTime}>
      <span>{formatMigrationAbsoluteTime(value)}</span>
      <span className="migration-time-relative">
        {formatMigrationRelativeTime(value, now)}
      </span>
    </time>
  );
}

export function SourceIdentity({
  source,
  size = "small",
}: {
  source: MigrationSource;
  size?: "small" | "large";
}): ReactElement {
  const definition = findSource(source);
  const initials = definition?.initials ?? "??";
  const foreground = definition?.darkText ? "#0a0a0a" : "#ffffff";
  return (
    <span className={`migration-source-identity is-${size}`}>
      <span
        aria-hidden="true"
        className="migration-source-logo"
        style={{
          background: definition?.color ?? "var(--pw-fg-muted)",
          // eslint-disable-next-line no-restricted-syntax -- source catalog owns tested text/background brand pairs
          color: foreground,
        }}
      >
        {initials}
      </span>
      <span>
        <strong>{definition?.name ?? "Unknown source"}</strong>
        <code>Source {source}</code>
      </span>
    </span>
  );
}

function SafeResourceNotice({
  stale,
  message,
  reference,
  refreshing,
  onRetry,
}: {
  stale: boolean;
  message: string;
  reference: string | null;
  refreshing: boolean;
  onRetry: () => void;
}): ReactElement {
  const reasonId = useId();
  return (
    <div
      className="migration-resource-notice"
      role={stale ? "status" : "alert"}
    >
      <div>
        <strong>
          {stale
            ? "Refresh could not be verified."
            : "Data could not be verified."}
        </strong>
        <span>{message}</span>
        {stale ? (
          <span>The last verified snapshot remains visible.</span>
        ) : null}
        {reference ? <code>{reference}</code> : null}
      </div>
      <button
        type="button"
        className="btn btn-sm"
        aria-disabled={refreshing || undefined}
        aria-describedby={refreshing ? reasonId : undefined}
        onClick={() => {
          if (!refreshing) onRetry();
        }}
      >
        {refreshing ? "Retrying…" : "Retry verification"}
      </button>
      {refreshing ? (
        <span id={reasonId} className="migration-row-reason">
          A verification request is already in progress.
        </span>
      ) : null}
    </div>
  );
}

export function sourceCapabilityTruth(
  source: MigrationSource,
  capability: MigrationSourceCapability | undefined,
): string {
  if (source === "beehiiv") {
    return "Imports subscribers, suppression and sent-post evidence. Segments and automations remain rebuild evidence; premium memberships are metadata only, never Stripe billing objects.";
  }
  if (source === "klaviyo") {
    return "Imports the primary email identity exposed by stable profile retrieval, enumerated send-targetable list/segment projections after validated list-level suppressions, renderable templates, and sent email campaign-archive evidence. No separate raw membership count is exposed. Unnamed audiences use deterministic Klaviyo list/segment ID labels; predictive profile reads use the stricter 10/second, 150/minute tier. Secondary addresses and independent per-address consent require the multi-email source-archive record plus consent and ecosystem review. Draft campaign-message and flow definitions may be null and then require provider recovery or retirement; campaign tags retain IDs, not hydrated names/groups. Eight unconditional source_total=1 static checklist rows do not prove product inventory. A stable-ID email A→B change blocks incremental replay until a full snapshot materializes B and disables source-owned A. Sent SMS/push history remains non-executable source-archive evidence. Reporting API metrics, SMS runtime and consent continuity, and ecommerce are not imported. A completed initial import is not cutover certification: freeze source changes and run the final full-snapshot delta with fresh verification.";
  }
  if (source === "customerio") {
    return 'Imports email-addressable profiles under immutable cio_id ownership from one explicitly bound US/EU workspace, frozen segment/topic membership snapshots, exact-source Design Studio templates, and eligible sent email newsletter archive history. Newsletter history requires at least one explicit language="" default and provably composable source HTML; the lowest stable content ID represents a multi-default/A-B set with an explicit warning, all variants remain evidence, translations are never silently selected, invalid layout/body composition remains evidence, and neither newsletter nor Design Studio HTML is provider-rendered output. Campaign and API-broadcast workflows are rebuild-only; transactional, non-email, channel, preference, object, deliverability, and ecosystem records remain read-only source evidence. Profiles without email and GDPR-hidden identifiers require separate disposition. A completed initial import is not cutover certification: there is no complete source-event replay feed, so freeze changes and run a final full snapshot, fresh shadow verification, rollback rehearsal, and all six review gates.';
  }
  const supports = capability?.supports;
  const capabilityLabels: Array<
    [keyof NonNullable<MigrationSourceCapability["supports"]>, string]
  > = [
    ["subscribers", "subscribers"],
    ["segments", "segments"],
    ["campaign_archive", "campaign archive"],
    ["paid_subs", "paid-subscription records"],
    ["consent_timestamps", "consent timestamps"],
    ["templates", "templates"],
    ["campaigns", "campaigns"],
    ["reports", "reports"],
    ["groups", "groups"],
    ["forms", "forms"],
    ["landing_pages", "landing pages"],
    ["ecommerce", "ecommerce records"],
    ["crm", "CRM records"],
    ["custom_objects", "custom objects"],
    ["sms", "SMS records"],
  ];
  const supported = capabilityLabels
    .filter(([key]) => supports?.[key] === true)
    .map(([, label]) => label);
  if (
    supports?.automations === true &&
    supports.automation_mode === "runtime"
  ) {
    supported.push("supported automations");
  }
  const unavailable = capabilityLabels
    .filter(([key]) => supports?.[key] === false)
    .map(([, label]) => label);
  const base =
    supported.length > 0
      ? `Runtime-supported: ${supported.join(", ")}.`
      : "The adapter is available; the dry run is authoritative for resource coverage.";
  const explicitLimitations =
    unavailable.length > 0
      ? ` Not supported by this adapter: ${unavailable.join(", ")}.`
      : "";
  if (supports?.automation_mode === "rebuild_review") {
    return `${base}${explicitLimitations} Automation definitions are evidence for manual rebuild and review, not active runtime flows.`;
  }
  if (supports?.automation_mode === "none") {
    return `${base}${explicitLimitations} Automations are not imported; rebuild them manually after verification.`;
  }
  return `${base}${explicitLimitations} Source fields and historical evidence remain limited to what the provider exposes.`;
}

function authMethodLabel(value: string | undefined): string {
  switch (value) {
    case "oauth2":
      return "OAuth 2 authorization";
    case "api_key":
      return "Dedicated API credential";
    case "csv_upload":
      return "Local CSV upload";
    default:
      return "Authorization verified in the wizard";
  }
}

function failureReference(failure: {
  code?: string;
  requestId?: string;
}): string | null {
  const values = [
    failure.code ? `Code ${failure.code}` : null,
    failure.requestId ? `Request ${failure.requestId}` : null,
  ].filter((value): value is string => value !== null);
  return values.length > 0 ? values.join(" · ") : null;
}

function safeDomId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
}

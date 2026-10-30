/**
 * PrivacyIncidents — operator dashboard for the privacy-incident
 * breach-response workflow.
 *
 *   - List + filter by state, search by title / id prefix
 *   - StatStrip: explicitly loaded-window counts and scope completeness
 *   - Create-incident modal
 *   - Detail slideover (size=lg) with the six required sections:
 *       1. Overview      (id, detected_at, signoff_by, description, ...)
 *       2. State         (current + allowed next states with a confirm)
 *       3. Counsel signoff (read-only claim + static release hold)
 *       4. Notifications (read-only loaded records + release hold)
 *       5. Packets       (draft slots + static release hold)
 *       6. Activity      (loaded transition + notification records)
 *
 * The state-transition adjacency is mirrored in `STATE_TRANSITIONS`
 * below — kept in lock-step with `validIncidentTransitions` in
 * apps/api/internal/privacy/incidents.go. Don't refactor it into a
 * fetched value: the matrix is tiny and stable, and gating it on a
 * network call would make the operator UI feel sluggish.
 */

import {
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ConfirmModal } from "../components/ConfirmModal";
import { FieldError, FormField } from "../components/FormField";
import { HeroEmptyState } from "../components/HeroEmptyState";
import { Icon } from "../components/Icon";
import { Modal, ModalFooter } from "../components/Modal";
import { Notice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import {
  PrivacyIncidentActivitySection,
  PrivacyIncidentPacketsSection,
} from "../components/privacy/PrivacyIncidentEvidenceSections";
import { PrivacyIncidentReleaseHold } from "../components/privacy/PrivacyIncidentReleaseHold";
import {
  PrivacyIncidentSeverityIndicator as SeverityIndicator,
  PrivacyIncidentStatePill as StatePill,
} from "../components/privacy/PrivacyIncidentBadges";
import { RemoteDataNotice } from "../components/RemoteDataNotice";
import { SectionHeader } from "../components/SectionHeader";
import { SlideoverShell } from "../components/SlideoverShell";
import { StatStrip, type StatCell } from "../components/StatStrip";
import {
  DataTable,
  DataTableLoadMore,
  type DataTableColumn,
} from "../components/table/DataTable";
import { toast } from "../components/Toast";
import { ValuePropCard } from "../components/ValuePropCard";
import {
  type PrivacyIncident,
  type PrivacyIncidentEvent,
  type PrivacyIncidentSeverity,
  type PrivacyIncidentState,
  type PrivacyJurisdictionReference,
  api,
} from "../lib/api-client";
import { useRemoteResource } from "../hooks/useRemoteResource";
import { useDraftLifecycleController } from "../hooks/useDraftLifecycleController";
import { lifecycleOperationError } from "../hooks/useSettingsDraftLifecycle";
import { onContextEpochObserved, readContextEpoch } from "../lib/context-epoch";
import { newUUIDv7 } from "../lib/http-fetch";
import {
  desktopRouteIdentityScope,
  getDesktopRoute,
  requestDesktopRouteNavigation,
  type DesktopRoute,
  useDesktopRouteSnapshot,
} from "../lib/desktop-router";
import {
  isInitialRemoteLoad,
  type RemoteApiError,
  type RemoteResource,
  remoteFailureFromError,
} from "../lib/remote-resource";
import { useMe } from "../lib/store";

/* ===================================================================
 * State machine — mirrors validIncidentTransitions in
 * apps/api/internal/privacy/incidents.go.
 * ================================================================== */

const STATE_TRANSITIONS: Record<PrivacyIncidentState, PrivacyIncidentState[]> =
  {
    open: ["contained", "notifications_pending", "closed"],
    contained: ["notifications_pending", "closed"],
    notifications_pending: ["closed", "contained"],
    closed: [],
  };

const TERMINAL_STATES: PrivacyIncidentState[] = ["closed"];
type NonTerminalIncidentState = Exclude<PrivacyIncidentState, "closed">;

const STATE_LABEL: Record<PrivacyIncidentState, string> = {
  open: "Open",
  contained: "Contained",
  notifications_pending: "Notifying",
  closed: "Closed",
};

/* ===================================================================
 * Filter chip set — "All" plus the four canonical states.
 * ================================================================== */
type FilterKey = "all" | PrivacyIncidentState;

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "contained", label: "Contained" },
  { key: "notifications_pending", label: "Notifying" },
  { key: "closed", label: "Closed" },
];

const PRIVACY_INCIDENT_FILTER_KEY = "state";
const PRIVACY_INCIDENT_DETAIL_OVERLAY = "privacy-incident-detail";
const PRIVACY_INCIDENT_CREATE_OVERLAY = "privacy-incident-create";

function privacyIncidentViewFromRoute(route: DesktopRoute): {
  filter: FilterKey;
  query: string;
  selectedId: string | null;
  creating: boolean;
} {
  if (route.section !== "privacyIncidents") {
    return { filter: "all", query: "", selectedId: null, creating: false };
  }
  const requestedFilter = route.filters?.find(
    (entry) => entry.key === PRIVACY_INCIDENT_FILTER_KEY,
  )?.value;
  const filter = FILTERS.some((entry) => entry.key === requestedFilter)
    ? (requestedFilter as FilterKey)
    : "all";
  return {
    filter,
    query: route.query ?? "",
    selectedId:
      route.overlay?.name === PRIVACY_INCIDENT_DETAIL_OVERLAY
        ? (route.overlay.resourceId ?? null)
        : null,
    creating: route.overlay?.name === PRIVACY_INCIDENT_CREATE_OVERLAY,
  };
}

function routeWithPrivacyIncidentView(
  route: DesktopRoute,
  filter: FilterKey,
  query: string,
): DesktopRoute {
  const retainedFilters =
    route.section === "privacyIncidents"
      ? (route.filters ?? []).filter(
          (entry) => entry.key !== PRIVACY_INCIDENT_FILTER_KEY,
        )
      : [];
  const filters = [
    ...retainedFilters,
    ...(filter === "all"
      ? []
      : [{ key: PRIVACY_INCIDENT_FILTER_KEY, value: filter }]),
  ];
  return {
    ...(route.section === "privacyIncidents"
      ? route
      : { section: "privacyIncidents" as const }),
    section: "privacyIncidents",
    query: query.trim() ? query.slice(0, 256) : undefined,
    filters: filters.length > 0 ? filters : undefined,
  };
}

function routeWithPrivacyIncidentOverlay(
  route: DesktopRoute,
  overlay: DesktopRoute["overlay"],
): DesktopRoute {
  const next: DesktopRoute = {
    ...(route.section === "privacyIncidents"
      ? route
      : { section: "privacyIncidents" as const }),
    section: "privacyIncidents",
  };
  if (overlay) next.overlay = overlay;
  else delete next.overlay;
  return next;
}

/* ===================================================================
 * Date helpers
 * ================================================================== */
function fmtAbs(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function fmtRelative(iso: string | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diffSec = Math.round((Date.now() - t) / 1000);
  const future = diffSec < 0;
  const elapsed = Math.abs(diffSec);
  const relative = (value: number, unit: string): string =>
    future ? `in ${value}${unit}` : `${value}${unit} ago`;
  if (elapsed < 5) return "just now";
  if (elapsed < 60) return relative(elapsed, "s");
  if (elapsed < 3600) return relative(Math.floor(elapsed / 60), "m");
  if (elapsed < 86400) return relative(Math.floor(elapsed / 3600), "h");
  if (elapsed < 86400 * 7) return relative(Math.floor(elapsed / 86400), "d");
  return fmtAbs(iso);
}

function AbsoluteRelativeTime({
  value,
  fallback = "Not recorded",
  exact = false,
}: {
  value: string | undefined;
  fallback?: string;
  exact?: boolean;
}): ReactElement {
  if (!value) return <span className="muted">{fallback}</span>;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return <span>{value}</span>;
  return (
    <time
      dateTime={new Date(timestamp).toISOString()}
      className="tabular privacy-incident-time"
    >
      <span>{fmtAbs(value)}</span>
      {exact ? (
        <code className="privacy-incident-exact-time">
          {new Date(timestamp).toISOString()}
        </code>
      ) : null}
      <span className="muted privacy-incident-relative-time">
        {fmtRelative(value)}
      </span>
    </time>
  );
}

function safeOperationFailure(error: RemoteApiError, fallback: string): string {
  const failure = remoteFailureFromError(error);
  const message =
    failure.message === "The server could not verify this data."
      ? fallback
      : failure.message;
  return failure.requestId
    ? `${message} Reference: ${failure.requestId}.`
    : message;
}

function isAmbiguousMutationFailure(error: RemoteApiError): boolean {
  if (
    error.kind === "network" ||
    error.kind === "offline" ||
    error.kind === "timeout"
  ) {
    return true;
  }
  if (error.status === undefined || error.status >= 500) return true;
  return [408, 409, 425, 429].includes(error.status);
}

function formatStructuredValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "This structured value could not be displayed.";
  }
}

/** A local-input datetime string ("2026-06-02T14:30") for the create form. */
function nowDatetimeLocal(): string {
  const d = new Date();
  const tz = d.getTimezoneOffset();
  const adjusted = new Date(d.getTime() - tz * 60_000);
  return adjusted.toISOString().slice(0, 16);
}

/** Convert "2026-06-02T14:30" (local) to ISO 8601 UTC. */
function datetimeLocalToISO(local: string): string {
  if (!local) return "";
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

function localTimeZoneLabel(): string {
  return (
    Intl.DateTimeFormat().resolvedOptions().timeZone || "device local time"
  );
}

function parsePreliminaryList(value: string): string[] {
  const unique = new Map<string, string>();
  for (const item of value.split(/[\n,]/)) {
    const normalized = item.trim().replace(/\s+/g, " ");
    if (!normalized) continue;
    const key = normalized.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, normalized);
  }
  return [...unique.values()];
}

function composePreliminarySummary(title: string, description: string): string {
  const summary = title.trim();
  const detail = description.trim();
  return detail ? `${summary}\n\n${detail}` : summary;
}

function unicodeScalarCount(value: string): number {
  return Array.from(value).length;
}

function validatePreliminaryList(
  values: string[],
  label: string,
): string | null {
  if (values.length > 64) return `${label} can contain at most 64 entries.`;
  if (values.some((value) => unicodeScalarCount(value) > 256)) {
    return `Each ${label.toLocaleLowerCase()} entry must be 256 characters or fewer.`;
  }
  return null;
}

function ExactTimePreview({
  label,
  local,
}: {
  label: string;
  local: string;
}): ReactElement | null {
  const iso = datetimeLocalToISO(local);
  if (!iso) return null;
  return (
    <div className="privacy-incident-time-preview" aria-live="polite">
      <span>
        {label} in {localTimeZoneLabel()}
      </span>
      <code>{iso}</code>
    </div>
  );
}

function usePrivacyIncidentIdentityScope(): string {
  const me = useMe();
  const [contextEpoch, setContextEpoch] = useState(
    () => readContextEpoch() ?? "unobserved",
  );
  useEffect(
    () => onContextEpochObserved((epoch) => setContextEpoch(epoch)),
    [],
  );
  const routeScope =
    desktopRouteIdentityScope(me?.user, me?.tenant) ?? "unresolved";
  return `${routeScope}:${me?.effectiveRole ?? "unknown"}:${contextEpoch}`;
}

/* ===================================================================
 * Page
 * ================================================================== */

export interface PrivacyIncidentStats {
  loadedCount: number;
  openCount: number;
  openOver24h: number;
  priorityCount: number;
  operationalTargetPassedCount: number;
  completeScopeCount: number;
}

export interface PrivacyIncidentScopeSignal {
  recorded: number;
  total: 4;
  missing: string[];
}

export type PrivacyIncidentResponseTone =
  | "danger"
  | "warning"
  | "info"
  | "neutral";

export interface PrivacyIncidentResponseSignal {
  label: string;
  nextCheckpoint: string;
  rank: number;
  tone: PrivacyIncidentResponseTone;
}

export function privacyIncidentScopeSignal(
  incident: PrivacyIncident,
): PrivacyIncidentScopeSignal {
  const missing: string[] = [];
  if (!incident.affected_regions?.length) missing.push("regions");
  if (!incident.affected_data_categories?.length)
    missing.push("data categories");
  if (incident.affected_subject_count == null) missing.push("subject estimate");
  if (!incident.jurisdictions?.length) missing.push("jurisdictions");
  return { recorded: 4 - missing.length, total: 4, missing };
}

export function privacyIncidentResponseSignal(
  incident: PrivacyIncident,
  now = Date.now(),
): PrivacyIncidentResponseSignal {
  if (incident.status === "closed") {
    return {
      label: "Historical record",
      nextCheckpoint: "Review stored evidence",
      rank: 5,
      tone: "neutral",
    };
  }
  const target = incident.gdpr_72h_deadline
    ? new Date(incident.gdpr_72h_deadline).getTime()
    : Number.NaN;
  if (Number.isFinite(target) && target < now) {
    return {
      label: "Target passed",
      nextCheckpoint: "Prioritize operational review",
      rank: 0,
      tone: "danger",
    };
  }
  if (incident.severity === "critical") {
    return {
      label: "Critical priority",
      nextCheckpoint: "Prioritize operational triage",
      rank: 1,
      tone: "danger",
    };
  }
  if (incident.severity === "high") {
    return {
      label: "High priority",
      nextCheckpoint: "Review current response state",
      rank: 2,
      tone: "warning",
    };
  }
  const scope = privacyIncidentScopeSignal(incident);
  if (scope.recorded < scope.total) {
    return {
      label: "Scope incomplete",
      nextCheckpoint: "Complete triage fields externally",
      rank: 3,
      tone: "warning",
    };
  }
  return {
    label: "Active response",
    nextCheckpoint:
      incident.status === "notifications_pending"
        ? "Collect approved external evidence"
        : "Review current response state",
    rank: 4,
    tone: "info",
  };
}

export function summarizePrivacyIncidents(
  rows: PrivacyIncident[] | null,
  now = Date.now(),
): PrivacyIncidentStats {
  const source = rows ?? [];
  const dayAgo = now - 24 * 3_600_000;
  let openCount = 0;
  let openOver24h = 0;
  let priorityCount = 0;
  let operationalTargetPassedCount = 0;
  let completeScopeCount = 0;
  for (const incident of source) {
    const terminal = TERMINAL_STATES.includes(incident.status);
    const detected = new Date(incident.detected_at).getTime();
    const response = privacyIncidentResponseSignal(incident, now);
    if (response.rank <= 2) priorityCount += 1;
    if (response.label === "Target passed") operationalTargetPassedCount += 1;
    const scope = privacyIncidentScopeSignal(incident);
    if (scope.recorded === scope.total) completeScopeCount += 1;
    if (!terminal) {
      openCount += 1;
      if (Number.isFinite(detected) && detected <= dayAgo) {
        openOver24h += 1;
      }
    }
  }
  return {
    loadedCount: source.length,
    openCount,
    openOver24h,
    priorityCount,
    operationalTargetPassedCount,
    completeScopeCount,
  };
}

interface PrivacyIncidentRegisterSnapshot {
  incidents: PrivacyIncident[];
  knownJurisdictions: PrivacyJurisdictionReference[];
  nextCursor: string | null;
}

interface PrivacyIncidentAppendState {
  appended: PrivacyIncident[];
  base: PrivacyIncidentRegisterSnapshot | null;
  failure: string | null;
  generation: number;
  loading: boolean;
  nextCursor: string | null;
}

function PrivacyIncidentTrustMasthead({
  loadedCount,
  hasMore,
  loading,
  available,
}: {
  loadedCount: number;
  hasMore: boolean;
  loading: boolean;
  available: boolean;
}): ReactElement {
  const title = !available
    ? loading
      ? "Loading register snapshot"
      : "Register snapshot unavailable"
    : loading
      ? "Refreshing the loaded snapshot"
      : "Loaded register snapshot";
  return (
    <section
      className="privacy-incident-trust-masthead"
      aria-labelledby="privacy-incident-trust-title"
      data-testid="privacy-incident-trust-masthead"
    >
      <span className="privacy-incident-trust-icon" aria-hidden="true">
        <Icon name="shield-check" size={20} />
      </span>
      <div className="privacy-incident-trust-copy">
        <span className="privacy-incident-kicker">Evidence boundary</span>
        <h2 id="privacy-incident-trust-title">{title}</h2>
        <p>
          {available
            ? `${loadedCount.toLocaleString()} row${loadedCount === 1 ? "" : "s"} loaded from the current server response${hasMore ? "; more rows exist beyond this window" : ""}. This is not an independently reconciled total.`
            : "No incident row is represented as verified or empty until the server response succeeds."}
        </p>
      </div>
      <ul
        className="privacy-incident-trust-facts"
        aria-label="Route safeguards"
      >
        <li>Admin workspace</li>
        <li>Legal actions held</li>
        <li>Loaded evidence only</li>
      </ul>
    </section>
  );
}

function PrivacyIncidentResponseIndicator({
  incident,
  now,
}: {
  incident: PrivacyIncident;
  now: number;
}): ReactElement {
  const signal = privacyIncidentResponseSignal(incident, now);
  return (
    <span className="privacy-incident-response-signal">
      <span className={`privacy-incident-response-label is-${signal.tone}`}>
        <span aria-hidden="true" />
        {signal.label}
      </span>
      <span className="privacy-incident-next-checkpoint">
        {signal.nextCheckpoint}
      </span>
    </span>
  );
}

function PrivacyIncidentScopeMeter({
  incident,
}: {
  incident: PrivacyIncident;
}): ReactElement {
  const scope = privacyIncidentScopeSignal(incident);
  const label = `${scope.recorded} of ${scope.total} triage scope fields recorded${scope.missing.length ? `. Missing: ${scope.missing.join(", ")}` : ""}`;
  return (
    <span className="privacy-incident-scope-meter" aria-label={label}>
      <span className="privacy-incident-scope-segments" aria-hidden="true">
        {Array.from({ length: scope.total }, (_, index) => (
          <span
            key={index}
            data-recorded={index < scope.recorded || undefined}
          />
        ))}
      </span>
      <span>
        {scope.recorded} / {scope.total} recorded
      </span>
    </span>
  );
}

function PrivacyIncidentTable({
  rows,
  now,
  loading,
  hasSourceRows,
  onOpen,
  onResetFilters,
}: {
  rows: PrivacyIncident[];
  now: number;
  loading: boolean;
  hasSourceRows: boolean;
  onOpen: (incident: PrivacyIncident, opener: HTMLButtonElement) => void;
  onResetFilters: () => void;
}): ReactElement {
  const columns: readonly DataTableColumn<PrivacyIncident>[] = [
    {
      id: "signal",
      header: "Response signal",
      width: "190px",
      cell: (incident) => (
        <PrivacyIncidentResponseIndicator incident={incident} now={now} />
      ),
    },
    {
      id: "summary",
      header: "Title and description",
      width: "34%",
      cell: (incident) => (
        <span className="privacy-incident-summary-cell">
          <strong>{incident.summary || "Untitled incident"}</strong>
          <SeverityIndicator severity={incident.severity} />
        </span>
      ),
    },
    {
      id: "state",
      header: "State",
      width: "130px",
      cell: (incident) => <StatePill state={incident.status} />,
    },
    {
      id: "deadline",
      header: "Stored operational 72h target",
      width: "180px",
      cell: (incident) => {
        const dueBy = incident.gdpr_72h_deadline;
        const dueTime = dueBy ? new Date(dueBy).getTime() : Number.NaN;
        const overdue =
          Number.isFinite(dueTime) &&
          dueTime < now &&
          !TERMINAL_STATES.includes(incident.status);
        return (
          <span
            className={overdue ? "privacy-incident-target-passed" : undefined}
          >
            <AbsoluteRelativeTime value={dueBy} fallback="Not calculated" />
            {overdue ? (
              <strong style={{ display: "block", fontSize: 12 }}>
                Target passed
              </strong>
            ) : null}
          </span>
        );
      },
    },
    {
      id: "scope",
      header: "Triage scope",
      width: "150px",
      cell: (incident) => <PrivacyIncidentScopeMeter incident={incident} />,
    },
    {
      id: "actions",
      header: <span className="visually-hidden">Incident actions</span>,
      width: "100px",
      align: "end",
      cell: (incident) => (
        <button
          type="button"
          className="btn btn-sm"
          onClick={(event) => onOpen(incident, event.currentTarget)}
          aria-label={`Open privacy incident ${incident.summary || incident.id}`}
        >
          Open
        </button>
      ),
    },
  ];

  return (
    <DataTable
      caption="Privacy incidents"
      description={
        loading && rows.length > 0
          ? "Refreshing · showing the last loaded incident register"
          : `${rows.length.toLocaleString()} incident${rows.length === 1 ? "" : "s"} shown`
      }
      columns={columns}
      rows={rows}
      getRowKey={(incident) => incident.id}
      loading={loading && rows.length === 0}
      loadingLabel="Loading the privacy incident register…"
      emptyState={
        hasSourceRows ? (
          <div>
            <strong>No incidents match these filters.</strong>
            <div className="muted" style={{ margin: "4px 0 8px" }}>
              Widen the state filter or clear the title and ID search.
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={onResetFilters}
            >
              Reset filters
            </button>
          </div>
        ) : (
          "No incident records are available in the loaded response."
        )
      }
      density="compact"
      className="privacy-incident-register-table"
      rowClassName={(incident) =>
        `privacy-incident-row is-${privacyIncidentResponseSignal(incident, now).tone}`
      }
    />
  );
}

function PrivacyIncidentCards({
  rows,
  now,
  loading,
  hasSourceRows,
  onOpen,
  onResetFilters,
}: {
  rows: PrivacyIncident[];
  now: number;
  loading: boolean;
  hasSourceRows: boolean;
  onOpen: (incident: PrivacyIncident, opener: HTMLButtonElement) => void;
  onResetFilters: () => void;
}): ReactElement {
  if (loading && rows.length === 0) {
    return (
      <div className="privacy-incident-mobile-register" role="status">
        Loading the privacy incident register…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="privacy-incident-mobile-register privacy-incident-mobile-empty">
        <strong>
          {hasSourceRows
            ? "No incidents match these filters."
            : "No incident records are available in the loaded response."}
        </strong>
        {hasSourceRows ? (
          <button type="button" className="btn" onClick={onResetFilters}>
            Reset filters
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <ol
      className="privacy-incident-mobile-register"
      aria-label="Privacy incidents"
    >
      {rows.map((incident) => {
        const dueBy = incident.gdpr_72h_deadline;
        const targetPassed =
          Boolean(dueBy) &&
          Date.parse(dueBy ?? "") < now &&
          !TERMINAL_STATES.includes(incident.status);
        const signal = privacyIncidentResponseSignal(incident, now);
        return (
          <li
            key={incident.id}
            className={`privacy-incident-mobile-card is-${signal.tone}`}
          >
            <div className="privacy-incident-mobile-card-heading">
              <PrivacyIncidentResponseIndicator incident={incident} now={now} />
              <StatePill state={incident.status} />
            </div>
            <h3>{incident.summary || "Untitled incident"}</h3>
            <SeverityIndicator severity={incident.severity} />
            <dl>
              <div>
                <dt>Stored operational target</dt>
                <dd
                  className={
                    targetPassed ? "privacy-incident-target-passed" : undefined
                  }
                >
                  <AbsoluteRelativeTime
                    value={dueBy}
                    fallback="Not calculated"
                  />
                </dd>
              </div>
              <div>
                <dt>Triage scope</dt>
                <dd>
                  <PrivacyIncidentScopeMeter incident={incident} />
                </dd>
              </div>
            </dl>
            <button
              type="button"
              className="btn"
              onClick={(event) => onOpen(incident, event.currentTarget)}
              aria-label={`Open privacy incident ${incident.summary || incident.id}`}
            >
              Review incident
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function PrivacyIncidents(): ReactElement {
  const identityScope = usePrivacyIncidentIdentityScope();
  const routeSnapshot = useDesktopRouteSnapshot();
  const routeView = privacyIncidentViewFromRoute(routeSnapshot.route);
  const { filter, query, selectedId, creating } = routeView;
  const [timeSnapshot, setTimeSnapshot] = useState(() => Date.now());
  const [learning, setLearning] = useState(false);
  const createOpenerRef = useRef<HTMLElement | null>(null);
  const detailOpenerRef = useRef<HTMLElement | null>(null);
  const registerFocusRef = useRef<HTMLHeadingElement | null>(null);
  const registerGenerationRef = useRef(0);
  const identityScopeRef = useRef(identityScope);
  const previousIdentityScopeRef = useRef(identityScope);
  const appendOperationRef = useRef<Promise<void> | null>(null);
  const snapshotRef = useRef<PrivacyIncidentRegisterSnapshot | null>(null);
  const [appendState, setAppendState] = useState<PrivacyIncidentAppendState>({
    appended: [],
    base: null,
    failure: null,
    generation: 0,
    loading: false,
    nextCursor: null,
  });
  identityScopeRef.current = identityScope;

  useEffect(() => {
    const timer = window.setInterval(() => setTimeSnapshot(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const incidentsResource = useRemoteResource<PrivacyIncidentRegisterSnapshot>(
    async () => {
      const res = await api.listPrivacyIncidents();
      if ("error" in res && res.error) return { error: res.error };
      // A refresh is allowed to keep the complete last-verified base + append
      // window while it is pending or fails. Only a newly verified base
      // invalidates cursor work owned by the previous snapshot.
      registerGenerationRef.current += 1;
      appendOperationRef.current = null;
      return {
        data: {
          incidents: res.data.incidents ?? [],
          knownJurisdictions: res.data.known_jurisdictions ?? [],
          nextCursor: res.data.nextCursor ?? null,
        },
      };
    },
    { identity: `privacy-incidents:${identityScope}` },
  );
  const snapshot = incidentsResource.data;
  snapshotRef.current = snapshot;
  const appendMatchesBase = snapshot !== null && appendState.base === snapshot;
  const rows = snapshot
    ? [
        ...snapshot.incidents,
        ...(appendMatchesBase ? appendState.appended : []),
      ]
    : null;
  const nextCursor = appendMatchesBase
    ? appendState.nextCursor
    : (snapshot?.nextCursor ?? null);
  const loadingMore = appendMatchesBase && appendState.loading;
  const loadMoreFailure = appendMatchesBase ? appendState.failure : null;
  const initialLoading = isInitialRemoteLoad(incidentsResource);

  useEffect(() => {
    if (!snapshot) return;
    setAppendState({
      appended: [],
      base: snapshot,
      failure: null,
      generation: registerGenerationRef.current,
      loading: false,
      nextCursor: snapshot.nextCursor,
    });
  }, [snapshot]);

  useEffect(() => {
    if (previousIdentityScopeRef.current === identityScope) return;
    previousIdentityScopeRef.current = identityScope;
    registerGenerationRef.current += 1;
    appendOperationRef.current = null;
    createOpenerRef.current = null;
    detailOpenerRef.current = null;
    setAppendState({
      appended: [],
      base: null,
      failure: null,
      generation: registerGenerationRef.current,
      loading: false,
      nextCursor: null,
    });
    setLearning(false);
    const currentRoute = getDesktopRoute();
    const resetView = routeWithPrivacyIncidentView(currentRoute, "all", "");
    void requestDesktopRouteNavigation(
      routeWithPrivacyIncidentOverlay(resetView, undefined),
      { replace: true, source: "identity" },
    );
  }, [identityScope]);

  const isScopeCurrent = useCallback(
    (scope: string): boolean => identityScopeRef.current === scope,
    [],
  );

  const loadMore = useCallback(async (): Promise<void> => {
    if (appendOperationRef.current) return await appendOperationRef.current;
    const base = snapshotRef.current;
    const generation = registerGenerationRef.current;
    const state = appendState;
    const cursor = state.base === base ? state.nextCursor : base?.nextCursor;
    if (!base || !cursor) return;

    const request = (async (): Promise<void> => {
      setAppendState((current) => ({
        ...(current.base === base
          ? { ...current, generation }
          : {
              appended: [],
              base,
              generation,
              nextCursor: base.nextCursor,
            }),
        failure: null,
        loading: true,
      }));
      let response: Awaited<ReturnType<typeof api.listPrivacyIncidents>>;
      try {
        response = await api.listPrivacyIncidents({ cursor });
      } catch {
        if (
          snapshotRef.current === base &&
          registerGenerationRef.current === generation
        ) {
          setAppendState((current) =>
            current.base === base && current.generation === generation
              ? {
                  ...current,
                  failure:
                    "The next incident window couldn't be loaded. Check the connection and retry.",
                  loading: false,
                }
              : current,
          );
        }
        return;
      }
      if (
        snapshotRef.current !== base ||
        registerGenerationRef.current !== generation
      )
        return;
      if (response.error) {
        setAppendState((current) =>
          current.base === base && current.generation === generation
            ? {
                ...current,
                failure: safeOperationFailure(
                  response.error,
                  "The next incident window couldn't be loaded.",
                ),
                loading: false,
              }
            : current,
        );
        return;
      }
      const next = response.data.nextCursor ?? null;
      if (next === cursor) {
        setAppendState((current) =>
          current.base === base && current.generation === generation
            ? {
                ...current,
                failure:
                  "The server repeated the same incident cursor. Loaded rows were kept; retry after refreshing the register.",
                loading: false,
              }
            : current,
        );
        return;
      }
      setAppendState((current) => {
        if (current.base !== base || current.generation !== generation)
          return current;
        const ids = new Set([
          ...base.incidents.map((incident) => incident.id),
          ...current.appended.map((incident) => incident.id),
        ]);
        const appended = response.data.incidents.filter((incident) => {
          if (ids.has(incident.id)) return false;
          ids.add(incident.id);
          return true;
        });
        return {
          ...current,
          appended: [...current.appended, ...appended],
          failure: null,
          loading: false,
          nextCursor: next,
        };
      });
    })();
    appendOperationRef.current = request;
    try {
      await request;
    } finally {
      if (appendOperationRef.current === request)
        appendOperationRef.current = null;
    }
  }, [appendState]);

  const selected = useMemo<PrivacyIncident | null>(() => {
    if (!selectedId || !rows) return null;
    return rows.find((r) => r.id === selectedId) ?? null;
  }, [selectedId, rows]);

  /* ----- stats: every value is explicitly scoped to loaded rows ------- */
  const stats = useMemo(
    () => summarizePrivacyIncidents(rows, timeSnapshot),
    [rows, timeSnapshot],
  );

  const statCells: StatCell[] = [
    {
      label: "Needs attention",
      value: (
        <span
          className={
            stats.priorityCount > 0 ? "privacy-incident-stat-danger" : undefined
          }
        >
          {stats.priorityCount.toLocaleString()}
        </span>
      ),
      hint: "Loaded non-terminal rows whose stored operational target has passed or whose recorded severity is high or critical. This is a triage signal, not a legal determination.",
    },
    {
      label: "Operational target passed",
      value: stats.operationalTargetPassedCount.toLocaleString(),
      hint: "Loaded non-terminal rows whose stored system target is earlier than now. The target is not represented as a legal deadline.",
    },
    {
      label: "Loaded non-terminal",
      value: stats.openCount.toLocaleString(),
      hint: "Loaded rows in open, contained, or notifying state. State is an operator record, not independent containment or delivery proof.",
    },
    {
      label: "Scope fields complete",
      value: `${stats.completeScopeCount.toLocaleString()} / ${stats.loadedCount.toLocaleString()}`,
      hint: "Loaded rows with stored regions, data categories, subject estimate, and jurisdictions. Four present fields do not establish correct or complete legal scope.",
    },
  ];

  const filterCounts = useMemo<Record<FilterKey, number>>(() => {
    const counts: Record<FilterKey, number> = {
      all: rows?.length ?? 0,
      open: 0,
      contained: 0,
      notifications_pending: 0,
      closed: 0,
    };
    for (const incident of rows ?? []) counts[incident.status] += 1;
    return counts;
  }, [rows]);

  /* ----- filtering + search ----------------------------------------- */
  const filtered = useMemo<PrivacyIncident[]>(() => {
    const source = rows ?? [];
    const q = query.trim().toLowerCase();
    return source
      .filter((r) => {
        if (filter !== "all" && r.status !== filter) return false;
        if (!q) return true;
        if (r.summary.toLowerCase().includes(q)) return true;
        if (r.id.toLowerCase().startsWith(q)) return true;
        return false;
      })
      .sort((left, right) => {
        const rankDelta =
          privacyIncidentResponseSignal(left, timeSnapshot).rank -
          privacyIncidentResponseSignal(right, timeSnapshot).rank;
        if (rankDelta !== 0) return rankDelta;
        return Date.parse(left.detected_at) - Date.parse(right.detected_at);
      });
  }, [rows, filter, query, timeSnapshot]);

  const focusRegisterFallback = useCallback((): void => {
    window.requestAnimationFrame(() => {
      registerFocusRef.current?.focus({ preventScroll: true });
    });
  }, []);

  const updateRouteView = useCallback(
    (nextFilter: FilterKey, nextQuery: string): void => {
      void requestDesktopRouteNavigation(
        routeWithPrivacyIncidentView(getDesktopRoute(), nextFilter, nextQuery),
        { replace: true, source: "navigation" },
      );
    },
    [],
  );

  const resetRouteView = useCallback((): void => {
    void requestDesktopRouteNavigation(
      routeWithPrivacyIncidentView(getDesktopRoute(), "all", ""),
      { replace: true, source: "navigation" },
    ).then((result) => {
      if (result === "proceeded") focusRegisterFallback();
    });
  }, [focusRegisterFallback]);

  const openRouteOverlay = useCallback(
    (name: string, resourceId?: string): void => {
      void requestDesktopRouteNavigation(
        routeWithPrivacyIncidentOverlay(getDesktopRoute(), {
          name,
          ...(resourceId ? { resourceId } : {}),
        }),
        { source: "navigation" },
      );
    },
    [],
  );

  const closeDetail = useCallback((): void => {
    const opener = detailOpenerRef.current;
    void requestDesktopRouteNavigation(
      routeWithPrivacyIncidentOverlay(getDesktopRoute(), undefined),
      { replace: true, source: "navigation" },
    ).then((result) => {
      if (result !== "proceeded") return;
      window.requestAnimationFrame(() => {
        if (opener?.isConnected) opener.focus({ preventScroll: true });
        else registerFocusRef.current?.focus({ preventScroll: true });
      });
    });
  }, []);

  useEffect(() => {
    if (!selectedId || rows === null || !detailOpenerRef.current) return;
    const rowStillLoaded = Boolean(rows?.some((row) => row.id === selectedId));
    const openerStillRepresented = filtered.some(
      (row) => row.id === selectedId,
    );
    if (rowStillLoaded && openerStillRepresented) return;
    detailOpenerRef.current = null;
    void requestDesktopRouteNavigation(
      routeWithPrivacyIncidentOverlay(getDesktopRoute(), undefined),
      { replace: true, source: "navigation" },
    ).then((result) => {
      if (result === "proceeded") focusRegisterFallback();
    });
  }, [filtered, focusRegisterFallback, rows, selectedId]);

  return (
    <div
      className="privacy-incident-workspace"
      data-testid="privacy-incident-workspace"
    >
      <PageHeader
        eyebrow="Compliance"
        title="Privacy incidents"
        subtitle="Review preliminary incident records, non-terminal workflow state, and loaded activity. Legal approvals, delivery proof, packets, and closure remain release-held."
        actions={[
          {
            label: "New preliminary record",
            onClick: () => {
              const active = document.activeElement;
              createOpenerRef.current =
                active instanceof HTMLElement ? active : null;
              openRouteOverlay(PRIVACY_INCIDENT_CREATE_OVERLAY);
            },
            variant: "primary",
          },
          {
            label:
              incidentsResource.transport === "loading"
                ? "Refreshing…"
                : "Refresh",
            onClick: () => void incidentsResource.reload(),
            disabled: incidentsResource.transport === "loading",
            title:
              incidentsResource.transport === "loading"
                ? "The privacy incident register is already refreshing."
                : "Reload the incident register from the server.",
          },
        ]}
      />

      <PrivacyIncidentTrustMasthead
        loadedCount={rows?.length ?? 0}
        hasMore={Boolean(nextCursor)}
        loading={incidentsResource.transport === "loading"}
        available={rows !== null}
      />

      {rows ? <StatStrip cells={statCells} /> : null}

      <RemoteDataNotice
        resource={incidentsResource}
        label="privacy incidents"
        onRetry={() => void incidentsResource.reload()}
      />

      <section
        className="privacy-incident-register"
        aria-labelledby="privacy-incident-register-title"
      >
        <header className="privacy-incident-register-header">
          <div>
            <span className="privacy-incident-kicker">Urgency-first queue</span>
            <h2
              id="privacy-incident-register-title"
              ref={registerFocusRef}
              tabIndex={-1}
            >
              Incident register
            </h2>
            <p>
              Loaded rows are ordered by derived response signal, then detection
              time. These are operational checkpoints, not legal conclusions.
            </p>
          </div>
          {rows ? (
            <div className="privacy-incident-register-count" role="status">
              <strong>{filtered.length.toLocaleString()}</strong>
              <span>of {rows.length.toLocaleString()} loaded</span>
            </div>
          ) : null}
        </header>

        {rows ? (
          <div className="privacy-incident-toolbar">
            <div
              className="chips privacy-incident-filter-chips"
              role="group"
              aria-label="Filter privacy incidents by state"
            >
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={`chip${filter === f.key ? " is-active" : ""}`}
                  aria-pressed={filter === f.key}
                  aria-label={`${f.label}, ${filterCounts[f.key].toLocaleString()} loaded`}
                  onClick={() => updateRouteView(f.key, query)}
                >
                  <span>{f.label}</span>
                  <span
                    className="privacy-incident-filter-count"
                    aria-hidden="true"
                  >
                    {filterCounts[f.key].toLocaleString()}
                  </span>
                </button>
              ))}
            </div>
            <label className="privacy-incident-search">
              <span className="label">Search loaded incidents</span>
              <input
                type="search"
                className="input"
                placeholder="Title or incident ID prefix"
                value={query}
                onChange={(event) =>
                  updateRouteView(filter, event.target.value)
                }
              />
            </label>
          </div>
        ) : null}

        {rows === null && !initialLoading ? null : !initialLoading &&
          rows?.length === 0 ? (
          <HeroEmptyState
            tone="blue"
            eyebrow="Privacy incidents"
            title="No incidents on file."
            subtitle="Open a preliminary operational record when a possible incident is detected. Jurisdiction analysis, legal approval, notification delivery, packet readiness, and closure must be completed in an approved external process while those controls remain release-held here."
            primaryCta={{
              label: "Create preliminary record",
              onClick: () => openRouteOverlay(PRIVACY_INCIDENT_CREATE_OVERLAY),
            }}
            secondaryCta={{
              label: "Learn the workflow",
              onClick: () => setLearning(true),
            }}
          />
        ) : (
          <>
            <PrivacyIncidentTable
              rows={filtered}
              now={timeSnapshot}
              loading={incidentsResource.transport === "loading"}
              hasSourceRows={Boolean(rows?.length)}
              onOpen={(incident, opener) => {
                detailOpenerRef.current = opener;
                openRouteOverlay(PRIVACY_INCIDENT_DETAIL_OVERLAY, incident.id);
              }}
              onResetFilters={() => {
                resetRouteView();
              }}
            />
            <PrivacyIncidentCards
              rows={filtered}
              now={timeSnapshot}
              loading={incidentsResource.transport === "loading"}
              hasSourceRows={Boolean(rows?.length)}
              onOpen={(incident, opener) => {
                detailOpenerRef.current = opener;
                openRouteOverlay(PRIVACY_INCIDENT_DETAIL_OVERLAY, incident.id);
              }}
              onResetFilters={() => {
                resetRouteView();
              }}
            />
          </>
        )}
        {rows && rows.length > 0 ? (
          loadMoreFailure ? (
            <Notice
              tone="warning"
              announcement="polite"
              className="privacy-incident-load-more-failure"
              title="Couldn’t load the next incident window"
              action={
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void loadMore()}
                >
                  Retry
                </button>
              }
            >
              {loadMoreFailure} The {rows.length.toLocaleString()} already
              loaded rows remain available.
            </Notice>
          ) : (
            <DataTableLoadMore
              label="Privacy incidents"
              loadedCount={rows.length}
              hasMore={Boolean(nextCursor)}
              busy={loadingMore}
              onLoadMore={() => void loadMore()}
              endLabel="End of loaded incident register"
            />
          )
        ) : null}
      </section>

      <CreateIncidentModal
        key={`privacy-incident-create:${identityScope}`}
        open={creating}
        knownJurisdictions={snapshot?.knownJurisdictions ?? []}
        identityScope={identityScope}
        isScopeCurrent={isScopeCurrent}
        returnFocusRef={createOpenerRef}
        onClose={() => {
          const opener = createOpenerRef.current;
          // Explicit discard updates the lifecycle guard in React state. Let
          // that verified local close commit before asking the router to
          // remove the URL-owned overlay, otherwise the just-discarded draft
          // can incorrectly intercept its own close navigation.
          window.setTimeout(() => {
            void requestDesktopRouteNavigation(
              routeWithPrivacyIncidentOverlay(getDesktopRoute(), undefined),
              { replace: true, source: "navigation" },
            ).then((result) => {
              if (result !== "proceeded") return;
              window.requestAnimationFrame(() => {
                if (opener?.isConnected) opener.focus({ preventScroll: true });
                else registerFocusRef.current?.focus({ preventScroll: true });
              });
            });
          }, 0);
        }}
        onCreated={() => {
          const opener = createOpenerRef.current;
          window.setTimeout(() => {
            void requestDesktopRouteNavigation(
              routeWithPrivacyIncidentOverlay(getDesktopRoute(), undefined),
              { replace: true, source: "navigation" },
            ).then((result) => {
              if (result !== "proceeded") return;
              window.requestAnimationFrame(() => {
                if (opener?.isConnected) opener.focus({ preventScroll: true });
                else registerFocusRef.current?.focus({ preventScroll: true });
              });
            });
          }, 0);
          void incidentsResource.reload();
        }}
      />

      <LearnWorkflowModal open={learning} onClose={() => setLearning(false)} />

      {selectedId ? (
        <IncidentDetailSlideover
          key={`privacy-incident-detail:${identityScope}:${selectedId}`}
          incidentId={selectedId}
          initialIncident={selected ?? undefined}
          identityScope={identityScope}
          isScopeCurrent={isScopeCurrent}
          onClose={closeDetail}
          returnFocusRef={detailOpenerRef}
          onMutated={() => void incidentsResource.reload()}
        />
      ) : null}
    </div>
  );
}

/* ===================================================================
 * Create modal
 * ================================================================== */

const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: "unknown", label: "Unknown / assessing" },
  { value: "contact_data", label: "Contact data" },
  { value: "credentials", label: "Credentials or secrets" },
  { value: "financial_data", label: "Financial data" },
  { value: "health_data", label: "Health data" },
  { value: "behavioral_data", label: "Behavioral data" },
];

interface CreateProps {
  open: boolean;
  identityScope: string;
  isScopeCurrent: (scope: string) => boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  knownJurisdictions: PrivacyJurisdictionReference[];
  onClose: () => void;
  onCreated: () => void;
}

function CreateIncidentModal({
  open,
  identityScope,
  isScopeCurrent,
  returnFocusRef,
  knownJurisdictions,
  onClose,
  onCreated,
}: CreateProps): ReactElement {
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<PrivacyIncidentSeverity>("medium");
  const [categories, setCategories] = useState<string[]>(["unknown"]);
  const [detectedAt, setDetectedAt] = useState<string>(nowDatetimeLocal());
  const [discoveredAt, setDiscoveredAt] = useState("");
  const [regionsInput, setRegionsInput] = useState("");
  const [jurisdictionsInput, setJurisdictionsInput] = useState("");
  const [selectedJurisdictions, setSelectedJurisdictions] = useState<string[]>(
    [],
  );
  const [subjectEstimate, setSubjectEstimate] = useState("");
  const [description, setDescription] = useState("");
  const [initialDetectedAt, setInitialDetectedAt] = useState(detectedAt);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [titleErr, setTitleErr] = useState<string | null>(null);
  const [detectedAtErr, setDetectedAtErr] = useState<string | null>(null);
  const [discoveredAtErr, setDiscoveredAtErr] = useState<string | null>(null);
  const [regionsErr, setRegionsErr] = useState<string | null>(null);
  const [jurisdictionsErr, setJurisdictionsErr] = useState<string | null>(null);
  const [subjectEstimateErr, setSubjectEstimateErr] = useState<string | null>(
    null,
  );
  const [ambiguousAttemptFingerprint, setAmbiguousAttemptFingerprint] =
    useState<string | null>(null);
  const draftIdempotencyKeyRef = useRef(newUUIDv7());
  const createCommittedRef = useRef(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const detectedAtRef = useRef<HTMLInputElement>(null);
  const discoveredAtRef = useRef<HTMLInputElement>(null);
  const regionsRef = useRef<HTMLTextAreaElement>(null);
  const jurisdictionsRef = useRef<HTMLTextAreaElement>(null);
  const subjectEstimateRef = useRef<HTMLInputElement>(null);
  const summaryCharacterCount = unicodeScalarCount(
    composePreliminarySummary(title, description),
  );
  const summaryCharactersRemaining = 4_000 - summaryCharacterCount;

  // Re-seed defaults on each open so a previous cancellation doesn't
  // leak into the next incident.
  useEffect(() => {
    if (!open) return;
    createCommittedRef.current = false;
    setTitle("");
    setSeverity("medium");
    setCategories(["unknown"]);
    const openingDetectedAt = nowDatetimeLocal();
    setDetectedAt(openingDetectedAt);
    setInitialDetectedAt(openingDetectedAt);
    setDiscoveredAt("");
    setRegionsInput("");
    setJurisdictionsInput("");
    setSelectedJurisdictions([]);
    setSubjectEstimate("");
    setDescription("");
    setSubmitErr(null);
    setTitleErr(null);
    setDetectedAtErr(null);
    setDiscoveredAtErr(null);
    setRegionsErr(null);
    setJurisdictionsErr(null);
    setSubjectEstimateErr(null);
    setAmbiguousAttemptFingerprint(null);
    draftIdempotencyKeyRef.current = newUUIDv7();
  }, [open]);

  const submit = async (): Promise<boolean> => {
    setSubmitErr(null);
    setTitleErr(null);
    setDetectedAtErr(null);
    setDiscoveredAtErr(null);
    setRegionsErr(null);
    setJurisdictionsErr(null);
    setSubjectEstimateErr(null);
    const summary = title.trim();
    if (!summary) {
      setTitleErr("Enter a concise incident title.");
      titleRef.current?.focus();
      return false;
    }
    const combinedSummary = composePreliminarySummary(summary, description);
    if (unicodeScalarCount(combinedSummary) > 4_000) {
      setTitleErr(
        "The title and description together must be 4,000 characters or fewer.",
      );
      titleRef.current?.focus();
      return false;
    }
    const detectedISO = datetimeLocalToISO(detectedAt);
    if (!detectedISO) {
      setDetectedAtErr("Enter a valid detection date and time.");
      detectedAtRef.current?.focus();
      return false;
    }
    if (new Date(detectedISO).getTime() > Date.now() + 5 * 60_000) {
      setDetectedAtErr(
        "Detected at cannot be more than five minutes in the future.",
      );
      detectedAtRef.current?.focus();
      return false;
    }
    const discoveredISO = discoveredAt
      ? datetimeLocalToISO(discoveredAt)
      : undefined;
    if (discoveredAt && !discoveredISO) {
      setDiscoveredAtErr("Enter a valid discovery date and time.");
      discoveredAtRef.current?.focus();
      return false;
    }
    if (
      discoveredISO &&
      new Date(discoveredISO).getTime() > Date.now() + 5 * 60_000
    ) {
      setDiscoveredAtErr(
        "Discovered at cannot be more than five minutes in the future.",
      );
      discoveredAtRef.current?.focus();
      return false;
    }
    const regions = parsePreliminaryList(regionsInput);
    const regionFailure = validatePreliminaryList(regions, "Regions");
    if (regionFailure) {
      setRegionsErr(regionFailure);
      regionsRef.current?.focus();
      return false;
    }
    const jurisdictions = parsePreliminaryList(
      [...selectedJurisdictions, jurisdictionsInput].join(","),
    );
    const jurisdictionFailure = validatePreliminaryList(
      jurisdictions,
      "Jurisdictions",
    );
    if (jurisdictionFailure) {
      setJurisdictionsErr(jurisdictionFailure);
      jurisdictionsRef.current?.focus();
      return false;
    }
    let affectedSubjectCount: number | undefined;
    if (subjectEstimate.trim()) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(subjectEstimate.trim())) {
        setSubjectEstimateErr(
          "Enter a whole number from 0 to 2,147,483,647, or leave it blank.",
        );
        subjectEstimateRef.current?.focus();
        return false;
      }
      affectedSubjectCount = Number(subjectEstimate.trim());
      if (
        !Number.isSafeInteger(affectedSubjectCount) ||
        affectedSubjectCount > 2_147_483_647
      ) {
        setSubjectEstimateErr(
          "Enter a whole number from 0 to 2,147,483,647, or leave it blank.",
        );
        subjectEstimateRef.current?.focus();
        return false;
      }
    }
    const operationScope = identityScope;
    const input = {
      severity,
      summary: combinedSummary,
      detected_at: detectedISO,
      discovered_at: discoveredISO,
      affected_regions: regions,
      affected_data_categories: categories,
      affected_subject_count: affectedSubjectCount,
      jurisdictions,
    };
    const attemptFingerprint = JSON.stringify(input);
    if (
      ambiguousAttemptFingerprint &&
      ambiguousAttemptFingerprint !== attemptFingerprint
    ) {
      setSubmitErr(
        "The outcome of the previous create request is unknown, so this draft cannot send an edited payload with that request key. Discard only after checking the register, or restore the exact attempted values and retry.",
      );
      return false;
    }
    let res: Awaited<ReturnType<typeof api.createPrivacyIncident>>;
    try {
      res = await api.createPrivacyIncident(input, {
        idempotencyKey: draftIdempotencyKeyRef.current,
      });
    } catch {
      if (isScopeCurrent(operationScope)) {
        setAmbiguousAttemptFingerprint(attemptFingerprint);
        setSubmitErr(
          "The create request may have reached the service, but its outcome could not be verified. Fields are locked and the exact request key will be reused on retry. Check the register before discarding.",
        );
      }
      return false;
    }
    if (!isScopeCurrent(operationScope)) return false;
    if (res.error) {
      if (isAmbiguousMutationFailure(res.error)) {
        setAmbiguousAttemptFingerprint(attemptFingerprint);
        setSubmitErr(
          "The create request may have reached the service, but its outcome could not be verified. Fields are locked and the exact request key will be reused on retry. Check the register before discarding.",
        );
      } else {
        setAmbiguousAttemptFingerprint(null);
        draftIdempotencyKeyRef.current = newUUIDv7();
        setSubmitErr(
          safeOperationFailure(
            res.error,
            "The preliminary incident record couldn't be created.",
          ),
        );
      }
      return false;
    }
    setAmbiguousAttemptFingerprint(null);
    draftIdempotencyKeyRef.current = newUUIDv7();
    // The server confirmed this exact request. Mark the local lifecycle clean
    // before the URL-owned overlay closes so the draft guard cannot intercept
    // its own successful completion.
    createCommittedRef.current = true;
    setTitle("");
    toast.success("Preliminary incident record created");
    onCreated();
    return true;
  };

  const lifecycle = useDraftLifecycleController({
    ownerId: "privacy-incident-create",
    label: "New preliminary privacy incident draft",
    mode: "create",
    enabled: open,
    dirty:
      !createCommittedRef.current &&
      (Boolean(title.trim()) ||
        severity !== "medium" ||
        categories.length !== 1 ||
        categories[0] !== "unknown" ||
        detectedAt !== initialDetectedAt ||
        Boolean(discoveredAt) ||
        Boolean(regionsInput.trim()) ||
        Boolean(jurisdictionsInput.trim()) ||
        selectedJurisdictions.length > 0 ||
        Boolean(subjectEstimate.trim()) ||
        Boolean(description.trim())),
    save: submit,
    discard: () => {
      createCommittedRef.current = false;
      setTitle("");
      setSeverity("medium");
      setCategories(["unknown"]);
      setDetectedAt(initialDetectedAt);
      setDiscoveredAt("");
      setRegionsInput("");
      setJurisdictionsInput("");
      setSelectedJurisdictions([]);
      setSubjectEstimate("");
      setDescription("");
      setSubmitErr(null);
      setTitleErr(null);
      setDetectedAtErr(null);
      setDiscoveredAtErr(null);
      setRegionsErr(null);
      setJurisdictionsErr(null);
      setSubjectEstimateErr(null);
      setAmbiguousAttemptFingerprint(null);
      draftIdempotencyKeyRef.current = newUUIDv7();
    },
    close: onClose,
    detail:
      "This preliminary privacy incident record has not been created. Return to it or explicitly discard it.",
    operationDetail:
      "Wait for the privacy-incident request to finish before leaving Moosewave.",
    onError: (error) => {
      if (!isScopeCurrent(identityScope)) return;
      setSubmitErr(
        lifecycleOperationError(
          error,
          "The preliminary incident record couldn't be created.",
        ),
      );
    },
  });
  const fieldsLocked = lifecycle.active || ambiguousAttemptFingerprint !== null;

  return (
    <Modal
      open={open}
      onClose={lifecycle.requestClose}
      closeOnBackdrop={!lifecycle.active}
      closeOnEscape={!lifecycle.active}
      closeDisabled={lifecycle.active}
      size="lg"
      title="New preliminary incident record"
      description="Create an operational record from the facts known now. This does not complete jurisdiction analysis or trigger a legally verified notification workflow."
      returnFocusRef={returnFocusRef}
    >
      <form
        className="privacy-incident-create-form"
        aria-busy={lifecycle.active || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          if (!lifecycle.active) void lifecycle.submit();
        }}
      >
        <FormField label="Title" required error={titleErr}>
          <input
            ref={titleRef}
            className="input"
            maxLength={4_000}
            aria-describedby="privacy-incident-summary-counter"
            value={title}
            disabled={fieldsLocked}
            onChange={(event) => {
              if (
                unicodeScalarCount(
                  composePreliminarySummary(event.target.value, description),
                ) > 4_000
              ) {
                setTitleErr(
                  "The title and description together must be 4,000 characters or fewer.",
                );
                return;
              }
              setTitle(event.target.value);
              if (titleErr) setTitleErr(null);
            }}
            placeholder="e.g. Vendor pipeline leaked subscriber emails"
          />
        </FormField>
        <FormField
          label="Severity"
          help="Critical and high incidents receive the strongest visual escalation."
        >
          <select
            className="input"
            value={severity}
            disabled={fieldsLocked}
            onChange={(event) =>
              setSeverity(event.target.value as PrivacyIncidentSeverity)
            }
          >
            <option value="investigating">Investigating</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </FormField>
        <fieldset className="privacy-incident-category-fieldset">
          <legend>Preliminary data categories</legend>
          <p>
            Select every category known now. These are triage tags, not a
            counsel-approved classification.
          </p>
          <div className="privacy-incident-category-grid">
            {CATEGORY_OPTIONS.map((option) => (
              <label key={option.value}>
                <input
                  type="checkbox"
                  value={option.value}
                  checked={categories.includes(option.value)}
                  disabled={fieldsLocked}
                  onChange={(event) => {
                    setCategories((current) => {
                      if (event.target.checked) {
                        return option.value === "unknown"
                          ? ["unknown"]
                          : [
                              ...current.filter((value) => value !== "unknown"),
                              option.value,
                            ];
                      }
                      const next = current.filter(
                        (value) => value !== option.value,
                      );
                      return next.length > 0 ? next : ["unknown"];
                    });
                  }}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <FormField
          label="Detected at"
          required
          help="Defaults to now. Any derived 72-hour target is provisional until jurisdiction and legal obligations are confirmed. Times use this device's local timezone."
          error={detectedAtErr}
        >
          <input
            ref={detectedAtRef}
            type="datetime-local"
            className="input"
            value={detectedAt}
            disabled={fieldsLocked}
            onChange={(event) => {
              setDetectedAt(event.target.value);
              if (detectedAtErr) setDetectedAtErr(null);
            }}
          />
        </FormField>
        <ExactTimePreview label="Detected timestamp" local={detectedAt} />
        <FormField
          label="Discovered at"
          help="Optional. If blank, discovery time remains unknown and is not recorded. This is factual chronology, not a legal awareness determination."
          error={discoveredAtErr}
        >
          <input
            ref={discoveredAtRef}
            type="datetime-local"
            className="input"
            value={discoveredAt}
            disabled={fieldsLocked}
            onChange={(event) => {
              setDiscoveredAt(event.target.value);
              if (discoveredAtErr) setDiscoveredAtErr(null);
            }}
          />
        </FormField>
        <ExactTimePreview label="Discovered timestamp" local={discoveredAt} />
        <FormField
          label="Affected regions"
          help="Optional geographic scope in plain language. Separate values with commas or new lines."
          error={regionsErr}
        >
          <textarea
            ref={regionsRef}
            className="input privacy-incident-compact-textarea"
            value={regionsInput}
            disabled={fieldsLocked}
            onChange={(event) => {
              setRegionsInput(event.target.value);
              if (regionsErr) setRegionsErr(null);
            }}
            placeholder="e.g. European Economic Area, United States"
          />
        </FormField>
        <fieldset className="privacy-incident-category-fieldset">
          <legend>Potential jurisdictions</legend>
          <p>
            Choose every catalog code supported by the service. This is
            provisional data capture, not an obligation or reportability
            determination.
          </p>
          {knownJurisdictions.length > 0 ? (
            <div className="privacy-incident-jurisdiction-grid">
              {knownJurisdictions.map((jurisdiction) => (
                <label key={jurisdiction.code}>
                  <input
                    type="checkbox"
                    aria-label={`${jurisdiction.code}: ${jurisdiction.name}`}
                    value={jurisdiction.code}
                    checked={selectedJurisdictions.includes(jurisdiction.code)}
                    disabled={fieldsLocked}
                    onChange={(event) => {
                      setSelectedJurisdictions((current) =>
                        event.target.checked
                          ? [...current, jurisdiction.code]
                          : current.filter(
                              (code) => code !== jurisdiction.code,
                            ),
                      );
                    }}
                  />
                  <span>
                    <strong>{jurisdiction.code}</strong>
                    <small>{jurisdiction.name}</small>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p role="status">
              No verified jurisdiction catalog was returned. Use the explicit
              custom path below for facts known now.
            </p>
          )}
          <FormField
            label="Other or unknown jurisdiction"
            help="Optional custom codes or names; separate with commas or new lines."
            error={jurisdictionsErr}
          >
            <textarea
              ref={jurisdictionsRef}
              className="input privacy-incident-compact-textarea"
              value={jurisdictionsInput}
              disabled={fieldsLocked}
              onChange={(event) => {
                setJurisdictionsInput(event.target.value);
                if (jurisdictionsErr) setJurisdictionsErr(null);
              }}
              placeholder="Enter a code or jurisdiction name not listed above"
            />
          </FormField>
        </fieldset>
        <FormField
          label="Estimated affected subjects"
          help="Optional current estimate. Zero records an explicit estimate, not proof that nobody was affected; blank means unknown. The estimate does not establish reportability."
          error={subjectEstimateErr}
        >
          <input
            ref={subjectEstimateRef}
            type="number"
            min={0}
            max={2_147_483_647}
            step={1}
            inputMode="numeric"
            className="input"
            value={subjectEstimate}
            disabled={fieldsLocked}
            onChange={(event) => {
              setSubjectEstimate(event.target.value);
              if (subjectEstimateErr) setSubjectEstimateErr(null);
            }}
            placeholder="Unknown"
          />
        </FormField>
        <FormField
          label="Description"
          help="Record what happened, discovery context, affected people and data, and current containment evidence."
        >
          <textarea
            className="input privacy-incident-description"
            maxLength={4_000}
            aria-describedby="privacy-incident-summary-counter"
            value={description}
            disabled={fieldsLocked}
            onChange={(event) => {
              if (
                unicodeScalarCount(
                  composePreliminarySummary(title, event.target.value),
                ) > 4_000
              ) {
                setTitleErr(
                  "The title and description together must be 4,000 characters or fewer.",
                );
                return;
              }
              setDescription(event.target.value);
              if (titleErr) setTitleErr(null);
            }}
            placeholder="What happened, when did you discover it, who's affected?"
          />
        </FormField>
        <div
          id="privacy-incident-summary-counter"
          className="privacy-incident-character-count"
        >
          {summaryCharactersRemaining.toLocaleString()} of 4,000 characters
          remaining across title and description
        </div>
        {ambiguousAttemptFingerprint ? (
          <Notice
            tone="warning"
            announcement="assertive"
            title="Create outcome not yet verified"
          >
            The exact attempted fields and request key are locked. Retry to
            reconcile that same request, or check the register before choosing
            to discard this draft.
          </Notice>
        ) : null}
        {submitErr ? <FieldError>{submitErr}</FieldError> : null}
        {lifecycle.active ? (
          <div className="muted" role="status" aria-live="polite">
            Creating the preliminary incident record…
          </div>
        ) : null}
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={lifecycle.requestClose}
            aria-disabled={lifecycle.active || undefined}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            aria-disabled={lifecycle.active || undefined}
          >
            {lifecycle.active
              ? "Creating…"
              : ambiguousAttemptFingerprint
                ? "Retry exact create request"
                : "Create preliminary record"}
          </button>
        </ModalFooter>
      </form>
      <ConfirmModal
        open={lifecycle.discardConfirmOpen}
        title="Discard privacy-incident draft?"
        description="The preliminary incident record has not been created."
        confirmLabel="Discard draft"
        danger
        busy={lifecycle.active}
        onConfirm={lifecycle.discardAndClose}
        onClose={lifecycle.keepEditing}
      />
    </Modal>
  );
}

/* ===================================================================
 * Learn workflow modal (Hero secondary CTA)
 * ================================================================== */

function LearnWorkflowModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactElement {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="The breach-response workflow"
      description="What this release records—and what still requires an approved external legal process."
    >
      <ValuePropCard
        title="Open"
        body="Create a preliminary incident record when a possible breach is detected. Stored timestamps and targets support triage but do not determine jurisdiction or legal obligations."
      />
      <ValuePropCard
        title="Contained"
        body="Record an operator-reported containment state and reason. This is workflow context, not independently verified containment evidence."
      />
      <ValuePropCard
        title="Notifications pending"
        body="Record that the workflow is awaiting notifications. Packet generation, approval, download, and manual delivery claims are release-held."
      />
      <ValuePropCard
        title="Closed (release-held)"
        body="Closure is unavailable until independent counsel identity, notification decisions, delivery receipts, and an atomic state transition are enforced and verified end to end."
      />
      <ModalFooter>
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Got it
        </button>
      </ModalFooter>
    </Modal>
  );
}

/* ===================================================================
 * Detail slideover
 * ================================================================== */

interface DetailProps {
  incidentId: string;
  initialIncident?: PrivacyIncident;
  identityScope: string;
  isScopeCurrent: (scope: string) => boolean;
  onClose: () => void;
  onMutated: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}

function IncidentDetailSlideover({
  incidentId,
  initialIncident,
  identityScope,
  isScopeCurrent,
  onClose,
  onMutated,
  returnFocusRef,
}: DetailProps): ReactElement {
  // Re-fetch a fresh single-incident view on open so the slideover
  // can't drift behind the list-snapshot's notification_decisions /
  // stored signoff fields.
  const detailResource = useRemoteResource<PrivacyIncident>(
    async () => {
      const res = await api.getPrivacyIncident(incidentId);
      if ("error" in res && res.error) return { error: res.error };
      return { data: res.data };
    },
    {
      identity: `privacy-incident:${identityScope}:${incidentId}`,
      ...(initialIncident ? { initialData: initialIncident } : {}),
    },
  );
  const eventsResource = useRemoteResource<PrivacyIncidentEvent[]>(
    async () => {
      const res = await api.listPrivacyIncidentEvents(incidentId);
      if ("error" in res && res.error) return { error: res.error };
      return { data: res.data.events ?? [] };
    },
    { identity: `privacy-incident-events:${identityScope}:${incidentId}` },
  );
  const detail = detailResource.data;

  const refresh = async (): Promise<boolean> => {
    const [detailResult, eventsResult] = await Promise.all([
      detailResource.reloadResult(),
      eventsResource.reloadResult(),
    ]);
    return Boolean(
      detailResult &&
      "data" in detailResult &&
      eventsResult &&
      "data" in eventsResult,
    );
  };

  const configuredNextStates = detail
    ? (STATE_TRANSITIONS[detail.status] ?? [])
    : [];
  const allowedNextStates = configuredNextStates.filter(
    (state): state is NonTerminalIncidentState => state !== "closed",
  );

  return (
    <SlideoverShell
      open
      onClose={onClose}
      size="lg"
      className="privacy-incident-detail"
      returnFocusRef={returnFocusRef}
      eyebrow="Privacy incident"
      title={
        <span className="privacy-incident-detail-title">
          {detail ? <SeverityIndicator severity={detail.severity} /> : null}
          <span>{detail?.summary || "Incident unavailable"}</span>
        </span>
      }
      subtitle={
        <span className="privacy-incident-detail-subtitle">
          {detail ? <StatePill state={detail.status} /> : null}
          <span className="muted tabular">{incidentId}</span>
        </span>
      }
    >
      <RemoteDataNotice
        resource={detailResource}
        label="incident details"
        onRetry={() => void detailResource.reload()}
      />
      {detail ? (
        <>
          <OverviewSection detail={detail} />
          <StateSection
            detail={detail}
            allowed={allowedNextStates}
            closeReleaseHeld={configuredNextStates.includes("closed")}
            identityScope={identityScope}
            isScopeCurrent={isScopeCurrent}
            onConflict={refresh}
            onTransitioned={() => {
              void refresh();
              onMutated();
            }}
          />
          <SignoffSection detail={detail} />
          <NotificationsSection
            resource={eventsResource}
            onRetry={() => void eventsResource.reload()}
          />
          <PrivacyIncidentPacketsSection />
          <PrivacyIncidentActivitySection
            resource={eventsResource}
            onRetry={() => void eventsResource.reload()}
          />
        </>
      ) : null}
    </SlideoverShell>
  );
}

/* ----- Overview --------------------------------------------------- */

function OverviewSection({
  detail,
}: {
  detail: PrivacyIncident;
}): ReactElement {
  const affectedRegions = Array.isArray(detail.affected_regions)
    ? detail.affected_regions
    : [];
  const affectedDataCategories = Array.isArray(detail.affected_data_categories)
    ? detail.affected_data_categories
    : [];
  const jurisdictions = Array.isArray(detail.jurisdictions)
    ? detail.jurisdictions
    : [];
  return (
    <section className="privacy-incident-detail-section">
      <SectionHeader
        title="Overview"
        description="Stored timer fields are operational response records, not legal deadline determinations."
      />
      <dl className="privacy-incident-detail-grid">
        <dt className="muted">Incident ID</dt>
        <dd className="tabular">{detail.id}</dd>
        <dt className="muted">Detected at</dt>
        <dd>
          <AbsoluteRelativeTime value={detail.detected_at} exact />
        </dd>
        <dt className="muted">Severity</dt>
        <dd>
          <SeverityIndicator severity={detail.severity} />
        </dd>
        <dt className="muted">State</dt>
        <dd>
          <StatePill state={detail.status} />
        </dd>
        <dt className="muted">Discovered at</dt>
        <dd>
          <AbsoluteRelativeTime value={detail.discovered_at} exact />
        </dd>
        <dt className="muted">Stored operational timer start</dt>
        <dd>
          <AbsoluteRelativeTime value={detail.clock_started_at} exact />
        </dd>
        <dt className="muted">Stored operational 72h target</dt>
        <dd>
          <AbsoluteRelativeTime
            value={detail.gdpr_72h_deadline}
            fallback="Not calculated"
            exact
          />
        </dd>
        <dt className="muted">Last updated</dt>
        <dd>
          <AbsoluteRelativeTime value={detail.updated_at} exact />
        </dd>
        <dt className="muted">Created at</dt>
        <dd>
          <AbsoluteRelativeTime value={detail.created_at} exact />
        </dd>
        <dt className="muted">Stored sign-off identity</dt>
        <dd>{detail.signoff_by || "No stored sign-off claim"}</dd>
        <dt className="muted">Stored sign-off time</dt>
        <dd>
          <AbsoluteRelativeTime
            value={detail.counsel_signoff_at}
            fallback="No stored sign-off time"
            exact
          />
        </dd>
        <dt className="muted">Affected subjects</dt>
        <dd className="tabular">
          {detail.affected_subject_count == null
            ? "Not estimated"
            : detail.affected_subject_count.toLocaleString()}
        </dd>
        <dt className="muted">Affected regions</dt>
        <dd>
          {affectedRegions.length > 0
            ? affectedRegions.join(", ")
            : "None recorded"}
        </dd>
        <dt className="muted">Data categories</dt>
        <dd>
          {affectedDataCategories.length > 0
            ? affectedDataCategories.join(", ")
            : "None recorded"}
        </dd>
        <dt className="muted">Jurisdictions</dt>
        <dd>
          {jurisdictions.length > 0
            ? jurisdictions.join(", ")
            : "None recorded"}
        </dd>
        <dt className="muted">Draft packet template reference</dt>
        <dd className="mono">{detail.template_version || "Not recorded"}</dd>
      </dl>
      <h3 className="section-title privacy-incident-scope-heading">
        Description and incident scope
      </h3>
      <p className="privacy-incident-scope-copy">
        {detail.summary || "No summary was recorded."}
      </p>
      <details className="privacy-incident-structured-details">
        <summary>Notification decisions and jurisdiction resolution</summary>
        <div className="privacy-incident-structured-copy">
          Stored structured fields returned for this record. They may be
          incomplete and must not be treated as a legal determination of
          audiences, deadlines, authorities, or content requirements.
        </div>
        <pre className="mono privacy-incident-structured-value">
          {formatStructuredValue({
            notification_decisions: detail.notification_decisions,
            jurisdiction_resolution: detail.jurisdiction_resolution ?? null,
          })}
        </pre>
      </details>
    </section>
  );
}

/* ----- State (transition buttons) --------------------------------- */

interface StateProps {
  detail: PrivacyIncident;
  allowed: NonTerminalIncidentState[];
  closeReleaseHeld: boolean;
  identityScope: string;
  isScopeCurrent: (scope: string) => boolean;
  onConflict: () => Promise<boolean>;
  onTransitioned: () => void;
}

function StateSection({
  detail,
  allowed,
  closeReleaseHeld,
  identityScope,
  isScopeCurrent,
  onConflict,
  onTransitioned,
}: StateProps): ReactElement {
  const [target, setTarget] = useState<NonTerminalIncidentState | null>(null);
  const [reason, setReason] = useState("");
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const [confirmationEpoch, setConfirmationEpoch] = useState(0);
  const [conflictRefreshBlocked, setConflictRefreshBlocked] = useState(false);
  const [refreshingConflict, setRefreshingConflict] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const reasonCharactersRemaining = 2_000 - unicodeScalarCount(reason);

  const submit = async (): Promise<boolean> => {
    if (!target) return false;
    const trimmed = reason.trim();
    if (!trimmed) {
      setConfirmErr("A reason is required for state transitions.");
      reasonRef.current?.focus();
      return false;
    }
    setConfirmErr(null);
    if (conflictRefreshBlocked) return false;
    const operationScope = identityScope;
    let res: Awaited<ReturnType<typeof api.transitionPrivacyIncident>>;
    try {
      res = await api.transitionPrivacyIncident(
        detail.id,
        target,
        trimmed,
        detail.status,
      );
    } catch {
      if (isScopeCurrent(operationScope)) {
        setConfirmErr(
          "The transition request couldn't reach the service. Your reason is still here; try again when ready.",
        );
      }
      return false;
    }
    if (!isScopeCurrent(operationScope)) return false;
    if (res.error) {
      const staleIntent =
        res.error.code === "stale_incident_state" ||
        res.error.code === "transition_conflict";
      const semanticRejection =
        res.error.code === "no_op" || res.error.code === "invalid_transition";
      if (staleIntent || semanticRejection) {
        const refreshed = await onConflict();
        if (!isScopeCurrent(operationScope)) return false;
        setConfirmationEpoch((current) => current + 1);
        setConflictRefreshBlocked(!refreshed);
        if (!refreshed) {
          setConfirmErr(
            "The transition was rejected and the current incident state could not be verified. Your reason is preserved. Retry the state check before confirmation is available.",
          );
        } else if (staleIntent) {
          setConfirmErr(
            "This incident changed after you opened it. Verified detail and activity were reloaded; review them, then re-enter the confirmation phrase for this preserved reason.",
          );
        } else {
          setConfirmErr(
            res.error.code === "no_op"
              ? "The service reported that the requested state was already current. Verified detail and activity were reloaded; review them before choosing another action."
              : "The service rejected this transition from the current state. Verified detail and activity were reloaded; review the available actions. Your reason is preserved.",
          );
        }
        reasonRef.current?.focus();
        return false;
      }
      setConfirmErr(
        safeOperationFailure(res.error, "The transition request failed."),
      );
      return false;
    }
    toast.success(`Moved to ${STATE_LABEL[target]}`);
    setTarget(null);
    setReason("");
    onTransitioned();
    return true;
  };

  const retryConflictRefresh = async (): Promise<void> => {
    if (refreshingConflict || lifecycle.active) return;
    const operationScope = identityScope;
    setRefreshingConflict(true);
    const refreshed = await onConflict();
    if (!isScopeCurrent(operationScope)) return;
    setRefreshingConflict(false);
    setConflictRefreshBlocked(!refreshed);
    setConfirmationEpoch((current) => current + 1);
    setConfirmErr(
      refreshed
        ? "Verified detail and activity were reloaded. Review the current state, then re-enter the confirmation phrase."
        : "The current state is still unavailable. Your reason is preserved; retry the state check before confirmation is available.",
    );
  };

  const lifecycle = useDraftLifecycleController({
    ownerId: `privacy-incident-transition-${detail.id}`,
    label: "Privacy incident transition draft",
    mode: "action",
    enabled: target !== null,
    dirty: Boolean(reason.trim()),
    save: submit,
    discard: () => {
      setReason("");
      setConfirmErr(null);
    },
    close: () => setTarget(null),
    detail:
      "This privacy-incident transition reason has not been submitted. Return to it or explicitly discard it.",
    operationDetail:
      "Wait for the incident transition request to finish before leaving Moosewave.",
    onError: (error) =>
      setConfirmErr(
        lifecycleOperationError(error, "The transition request failed."),
      ),
  });

  return (
    <section className="privacy-incident-detail-section">
      <SectionHeader
        title="State"
        description="Available controls record non-terminal workflow state and an operator-supplied reason. They do not independently verify containment or notification delivery."
      />
      <div className="privacy-incident-state-current">
        <span className="muted">Current:</span>
        <StatePill state={detail.status} />
      </div>
      <div
        className="privacy-incident-state-actions"
        role="group"
        aria-label="Available incident state transitions"
      >
        {allowed.length === 0 ? (
          <span className="muted">
            No further transitions — incident is terminal.
          </span>
        ) : (
          allowed.map((next) => (
            <button
              key={next}
              type="button"
              className="btn btn-sm"
              aria-disabled={lifecycle.active || undefined}
              onClick={() => {
                if (lifecycle.active) return;
                setReason("");
                setConfirmErr(null);
                setConflictRefreshBlocked(false);
                setTarget(next);
              }}
            >
              Move to {STATE_LABEL[next]}
            </button>
          ))
        )}
      </div>
      {closeReleaseHeld ? (
        <div className="privacy-incident-state-hold">
          <PrivacyIncidentReleaseHold
            title="Incident closure is on release hold"
            description="No close control is mounted. A stored sign-off value alone cannot prove an independent authenticated counsel decision, completed notification obligations, or an atomic and race-safe closure."
            checkpoints={[
              "A second authenticated principal, current authorization, and durable sign-off receipt.",
              "Complete jurisdiction decisions and required delivery evidence.",
              "An atomic expected-state transition with concurrency and audit guarantees.",
            ]}
            testId="privacy-incident-close-release-hold"
          />
        </div>
      ) : null}
      {lifecycle.active ? (
        <div className="muted" role="status" aria-live="polite">
          Recording the state transition…
        </div>
      ) : null}

      {/* Keyed so a re-open after cancel reseeds the type-to-confirm input. */}
      <ConfirmModal
        key={`${target ?? "no-target"}:${confirmationEpoch}`}
        open={target !== null}
        title={target ? `Transition to ${STATE_LABEL[target]}?` : ""}
        description="This records an operator-supplied non-terminal state and reason. It is not independent verification of the underlying event."
        confirmLabel={
          target ? `Transition to ${STATE_LABEL[target]}` : "Confirm"
        }
        typeToConfirm={target ? STATE_LABEL[target] : undefined}
        busy={lifecycle.active}
        confirmDisabled={
          conflictRefreshBlocked || Boolean(target && !allowed.includes(target))
        }
        onClose={lifecycle.requestClose}
        onConfirm={() => void lifecycle.submit()}
      >
        <div>
          <FormField
            label="Reason"
            required
            helpTooltip="Returned in the loaded incident activity when the server accepts it. Record the source of the operational claim."
            error={confirmErr}
          >
            <textarea
              ref={reasonRef}
              id="transition-reason"
              className="input privacy-incident-transition-reason"
              maxLength={2_000}
              aria-describedby="privacy-incident-transition-reason-counter"
              value={reason}
              disabled={lifecycle.active}
              onChange={(event) => {
                setReason(event.target.value);
                if (confirmErr) setConfirmErr(null);
              }}
              placeholder="e.g. Containment confirmed by SRE. Vendor pipeline credentials rotated."
            />
          </FormField>
          <div
            id="privacy-incident-transition-reason-counter"
            className="privacy-incident-character-count"
          >
            {reasonCharactersRemaining.toLocaleString()} of 2,000 characters
            remaining
          </div>
          {conflictRefreshBlocked ? (
            <button
              type="button"
              className="btn"
              disabled={refreshingConflict}
              onClick={() => void retryConflictRefresh()}
            >
              {refreshingConflict
                ? "Checking current state…"
                : "Retry current state check"}
            </button>
          ) : null}
        </div>
      </ConfirmModal>
      <ConfirmModal
        open={lifecycle.discardConfirmOpen}
        title="Discard transition reason?"
        description="The privacy incident state has not changed."
        confirmLabel="Discard reason"
        danger
        busy={lifecycle.active}
        onConfirm={lifecycle.discardAndClose}
        onClose={lifecycle.keepEditing}
      />
    </section>
  );
}

/* ----- Counsel signoff -------------------------------------------- */

function SignoffSection({ detail }: { detail: PrivacyIncident }): ReactElement {
  const signed = Boolean(detail.counsel_signoff_at);

  return (
    <section style={{ marginBottom: 24 }}>
      <SectionHeader
        title="Counsel sign-off"
        description="Read-only legacy values are shown as unverified claims. This release cannot create or validate counsel approval."
      />
      <PrivacyIncidentReleaseHold
        title="Counsel approval is on release hold"
        description="Legacy incident schemas and stored records can contain caller-supplied identity text; they do not prove that a separate, authorized counsel principal authenticated and approved this exact incident version. No sign-off control is mounted."
        checkpoints={[
          "Independent authenticated counsel identity with current tenant authority.",
          "Step-up authentication and a receipt bound to the exact incident revision.",
          "Immutable actor, decision, timestamp, policy version, and audit evidence.",
        ]}
        testId="privacy-incident-signoff-release-hold"
      >
        <p>
          {signed ? (
            <>
              <strong>Unverified legacy claim:</strong>{" "}
              <span style={{ overflowWrap: "anywhere" }}>
                {detail.signoff_by || "Identity not recorded"}
              </span>
              <span aria-hidden="true"> · </span>
              <AbsoluteRelativeTime value={detail.counsel_signoff_at} exact />
            </>
          ) : (
            "No stored sign-off claim is present."
          )}
        </p>
      </PrivacyIncidentReleaseHold>
    </section>
  );
}

/* ----- Notifications ledger --------------------------------------- */

interface NotificationLedgerRow {
  event: PrivacyIncidentEvent;
}

function notificationAudienceLabel(audience: string | undefined): string {
  if (!audience) return "Not recorded";
  if (audience === "authority") return "Supervisory authority";
  if (audience === "data_subject") return "Data subject";
  if (audience === "customer") return "Customer";
  return audience.replaceAll("_", " ");
}

function NotificationLedger({
  notifications,
  loading,
  unavailable,
}: {
  notifications: PrivacyIncidentEvent[];
  loading: boolean;
  unavailable: boolean;
}): ReactElement {
  const rows = notifications.map((event) => ({ event }));
  const columns: readonly DataTableColumn<NotificationLedgerRow>[] = [
    {
      id: "audience",
      header: "Audience",
      width: "180px",
      cell: ({ event }) => notificationAudienceLabel(event.audience),
    },
    {
      id: "recipient",
      header: "Recipient reference",
      width: "280px",
      cell: ({ event }) => (
        <span style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
          {event.recipient_ref ? "Withheld in this view" : "Not recorded"}
        </span>
      ),
    },
    {
      id: "template",
      header: "Template",
      width: "200px",
      cell: ({ event }) => (
        <span
          className="mono"
          style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}
        >
          {event.template_key || "Not recorded"}
        </span>
      ),
    },
    {
      id: "actor",
      header: "Recorded by",
      width: "220px",
      cell: ({ event }) => (
        <span style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
          {event.actor || "Actor not recorded"}
        </span>
      ),
    },
    {
      id: "sent",
      header: "Recorded at",
      width: "180px",
      cell: ({ event }) => <AbsoluteRelativeTime value={event.at} />,
    },
  ];
  return (
    <>
      <DataTable
        caption="Loaded notification records"
        description={`${rows.length.toLocaleString()} loaded operator record${rows.length === 1 ? "" : "s"}; delivery is not independently verified`}
        columns={columns}
        rows={rows}
        getRowKey={(row) => `${row.event.source}:${row.event.event_id}`}
        loading={loading && rows.length === 0}
        loadingLabel="Loading notification records…"
        emptyState={
          unavailable
            ? "Notification records are unavailable. Retry before relying on this loaded view."
            : "No notification records are loaded for this incident."
        }
        density="compact"
        className="privacy-incident-notification-table"
      />
      <ol
        className="privacy-incident-notification-cards"
        aria-label="Loaded notification records"
      >
        {rows.map(({ event }) => (
          <li key={`${event.source}:${event.event_id}`}>
            <div>
              <strong>{notificationAudienceLabel(event.audience)}</strong>
              <span>Delivery not independently verified</span>
            </div>
            <dl>
              <div>
                <dt>Recipient reference</dt>
                <dd>
                  {event.recipient_ref
                    ? "Withheld in this view"
                    : "Not recorded"}
                </dd>
              </div>
              <div>
                <dt>Template</dt>
                <dd className="mono">{event.template_key || "Not recorded"}</dd>
              </div>
              <div>
                <dt>Recorded by</dt>
                <dd>{event.actor || "Actor not recorded"}</dd>
              </div>
              <div>
                <dt>Recorded at</dt>
                <dd>
                  <AbsoluteRelativeTime value={event.at} exact />
                </dd>
              </div>
            </dl>
          </li>
        ))}
        {rows.length === 0 ? (
          <li className="privacy-incident-mobile-empty">
            {loading
              ? "Loading notification records…"
              : unavailable
                ? "Notification records are unavailable. Retry before relying on this loaded view."
                : "No notification records are loaded for this incident."}
          </li>
        ) : null}
      </ol>
    </>
  );
}

function NotificationsSection({
  resource,
  onRetry,
}: {
  resource: RemoteResource<PrivacyIncidentEvent[]>;
  onRetry: () => void;
}): ReactElement {
  const events = resource.data;

  // Extract the notification-shaped entries in the currently loaded response.
  const notifications = useMemo<PrivacyIncidentEvent[]>(() => {
    if (!events) return [];
    return events.filter((e) => e.kind === "notification");
  }, [events]);

  return (
    <section style={{ marginBottom: 24 }}>
      <SectionHeader
        title="Notifications"
        description="Read-only operator records returned in the loaded event response. A record does not by itself prove content, recipients, transmission, or receipt."
      />
      <PrivacyIncidentReleaseHold
        title="Manual delivery recording is on release hold"
        description="No record-as-sent control is mounted. Legacy notification records can contain a manually asserted recipient reference without a packet body hash, provider delivery receipt, or atomic linkage to approved content."
        checkpoints={[
          "An approved packet digest bound to audience, jurisdiction, and incident revision.",
          "Provider or authority receipt with durable recipient, channel, and delivery status.",
          "Append-only, paginated evidence with explicit failure and reconciliation states.",
        ]}
        testId="privacy-incident-notification-release-hold"
      />
      <RemoteDataNotice
        resource={resource}
        label="notification records"
        onRetry={onRetry}
      />
      <div style={{ marginTop: 8 }}>
        <NotificationLedger
          notifications={notifications}
          loading={isInitialRemoteLoad(resource)}
          unavailable={events === null && resource.failure !== null}
        />
      </div>
    </section>
  );
}

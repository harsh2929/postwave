/**
 * Consent — admin-only, read-only inspection of contract-validated
 * receipt/proof and consent-event pages exposed by the current workspace.
 *
 * The source APIs are cursor-paged response families over separate storage
 * planes. Their insert-visibility boundary is not an immutable DB snapshot.
 * Nothing in this renderer turns those pages into a complete cross-channel
 * ledger, a legal conclusion, or an append-only/certified evidence claim.
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

import { HeroEmptyState } from "../components/HeroEmptyState";
import { Icon } from "../components/Icon";
import { Notice } from "../components/Notice";
import { PageHeader } from "../components/PageHeader";
import { RemoteDataNotice } from "../components/RemoteDataNotice";
import { StatStrip, type StatCell } from "../components/StatStrip";
import {
  DataTableLoadMore,
  DataTablePagination,
} from "../components/table/DataTable";
import {
  ConsentEvidenceCards,
  ConsentEvidenceTable,
} from "../components/consent/ConsentEvidenceRegister";
import {
  MissingReceiptDrawer,
  ReceiptDrawer,
} from "../components/consent/ConsentReceiptDrawer";
import { useRemoteResource } from "../hooks/useRemoteResource";
import {
  api,
  type ConsentEvent,
  type ConsentEventsResponse,
  type ConsentReceipt,
  type ConsentReceiptsResponse,
} from "../lib/api-client";
import { onContextEpochObserved, readContextEpoch } from "../lib/context-epoch";
import {
  consentOutcomeGroup,
  consentReceiptIdentity as receiptIdentity,
  formatConsentTimestamp as formatTimestamp,
  validConsentTimestamp as validTimestamp,
} from "../lib/consent-evidence-view";
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

import "../styles-consent.css";

export { ReceiptDrawer } from "../components/consent/ConsentReceiptDrawer";
export { consentOutcomeGroup } from "../lib/consent-evidence-view";

type SourceFilter =
  | "all"
  | "form"
  | "api"
  | "import"
  | "public-record"
  | "other";
type OutcomeFilter = "all" | "opt-in" | "opt-out" | "pending" | "other";
type EvidenceFilter = "all" | ConsentReceipt["kind"];
type PeriodFilter = "all" | "7d" | "30d" | "90d";

interface ConsentRouteView {
  source: SourceFilter;
  outcome: OutcomeFilter;
  evidence: EvidenceFilter;
  period: PeriodFilter;
  query: string;
  direction: "asc" | "desc";
  selectedIdentity: string | null;
}

interface ConsentIdentity {
  scope: string;
  workspaceId: string;
}

interface ReceiptAppendState {
  base: ConsentReceiptsResponse | null;
  rows: ConsentReceipt[];
  nextCursor: string | null;
  hasMore: boolean;
  loading: boolean;
  failure: string | null;
  generation: number;
}

interface EventAppendState {
  base: ConsentEventsResponse | null;
  rows: ConsentEvent[];
  nextCursor: string | null;
  hasMore: boolean;
  loading: boolean;
  failure: string | null;
  generation: number;
}

interface GpcSubjectSummary {
  subscriberEmails: ReadonlySet<string>;
  knownSubjectCount: number;
  unknownIdentityRows: number;
}

const PAGE_LIMIT = 200;
const DEFAULT_LOCAL_PAGE_SIZE = 50;
const RECEIPT_OVERLAY = "consent-receipt-evidence";
const PROOF_OVERLAY = "consent-proof-evidence";
const FILTER_KEYS = {
  source: "source",
  outcome: "outcome",
  evidence: "evidence",
  period: "period",
} as const;

const SOURCE_FILTERS: ReadonlyArray<{ id: SourceFilter; label: string }> = [
  { id: "all", label: "All sources" },
  { id: "form", label: "Forms" },
  { id: "api", label: "API" },
  { id: "import", label: "Imports" },
  { id: "public-record", label: "Migration / public" },
  { id: "other", label: "Other" },
];

const OUTCOME_FILTERS: ReadonlyArray<{
  id: OutcomeFilter;
  label: string;
}> = [
  { id: "all", label: "All outcomes" },
  { id: "opt-in", label: "Opt-in" },
  { id: "opt-out", label: "Opt-out" },
  { id: "pending", label: "Pending" },
  { id: "other", label: "Other recorded state" },
];

const EVIDENCE_FILTERS: ReadonlyArray<{
  id: EvidenceFilter;
  label: string;
}> = [
  { id: "all", label: "All evidence" },
  { id: "receipt", label: "State-change receipt" },
  { id: "proof", label: "Structured proof" },
];

const PERIOD_FILTERS: ReadonlyArray<{
  id: PeriodFilter;
  label: string;
}> = [
  { id: "all", label: "Any loaded time" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
];

function isOneOf<T extends string>(
  value: string | undefined,
  values: readonly T[],
): value is T {
  return Boolean(value && (values as readonly string[]).includes(value));
}

export function consentSourceBucket(source: string | undefined): SourceFilter {
  const normalized = (source ?? "").trim().toLowerCase();
  if (normalized.startsWith("form")) return "form";
  if (normalized.startsWith("api")) return "api";
  if (normalized === "csv_import" || normalized.startsWith("import")) {
    return "import";
  }
  if (normalized.startsWith("migration") || normalized.startsWith("public")) {
    return "public-record";
  }
  return "other";
}

function selectedIdentityFromRoute(route: DesktopRoute): string | null {
  const overlay = route.overlay;
  if (!overlay?.resourceId) return null;
  if (overlay.name === RECEIPT_OVERLAY) {
    return "receipt:" + overlay.resourceId;
  }
  if (overlay.name === PROOF_OVERLAY) {
    return "proof:" + overlay.resourceId;
  }
  return null;
}

function isWithinPeriod(
  value: string | undefined,
  period: PeriodFilter,
): boolean {
  if (period === "all") return true;
  const parsed = validTimestamp(value);
  if (parsed === null) return false;
  const days = period === "7d" ? 7 : period === "30d" ? 30 : 90;
  const now = Date.now();
  return parsed <= now && parsed >= now - days * 86_400_000;
}

function isWithinDays(value: string | undefined, days: number): boolean {
  const parsed = validTimestamp(value);
  const now = Date.now();
  return parsed !== null && parsed <= now && parsed >= now - days * 86_400_000;
}

function isGpcEvent(event: ConsentEvent): boolean {
  return (
    event.preferences?.["gpc"] === true ||
    event.source.trim().toLowerCase() === "gpc"
  );
}

function gpcSubjectSummary(events: readonly ConsentEvent[]): GpcSubjectSummary {
  const knownSubjectKeys = new Set<string>();
  const subscriberEmails = new Set<string>();
  let unknownIdentityRows = 0;
  for (const event of events) {
    if (!isGpcEvent(event)) continue;
    const subjectId = event.subject_id?.trim();
    const email = event.subject_email?.trim().toLowerCase();
    const subjectKey = subjectId
      ? event.subject_type + ":id:" + subjectId
      : email
        ? event.subject_type + ":email:" + email
        : null;
    if (!subjectKey) {
      unknownIdentityRows += 1;
      continue;
    }
    knownSubjectKeys.add(subjectKey);
    if (email) subscriberEmails.add(email);
  }
  return {
    subscriberEmails,
    knownSubjectCount: knownSubjectKeys.size,
    unknownIdentityRows,
  };
}

function consentRouteView(route: DesktopRoute): ConsentRouteView {
  if (route.section !== "consent") {
    return {
      source: "all",
      outcome: "all",
      evidence: "all",
      period: "all",
      query: "",
      direction: "desc",
      selectedIdentity: null,
    };
  }
  const filters = new Map(
    (route.filters ?? []).map((entry) => [entry.key, entry.value]),
  );
  const source = filters.get(FILTER_KEYS.source);
  const outcome = filters.get(FILTER_KEYS.outcome);
  const evidence = filters.get(FILTER_KEYS.evidence);
  const period = filters.get(FILTER_KEYS.period);
  return {
    source: isOneOf(
      source,
      SOURCE_FILTERS.map((entry) => entry.id),
    )
      ? source
      : "all",
    outcome: isOneOf(
      outcome,
      OUTCOME_FILTERS.map((entry) => entry.id),
    )
      ? outcome
      : "all",
    evidence: isOneOf(
      evidence,
      EVIDENCE_FILTERS.map((entry) => entry.id),
    )
      ? evidence
      : "all",
    period: isOneOf(
      period,
      PERIOD_FILTERS.map((entry) => entry.id),
    )
      ? period
      : "all",
    query: route.query ?? "",
    direction:
      route.sort?.field === "recorded-at" && route.sort.direction === "asc"
        ? "asc"
        : "desc",
    selectedIdentity: selectedIdentityFromRoute(route),
  };
}

function routeWithConsentView(
  route: DesktopRoute,
  view: Omit<ConsentRouteView, "selectedIdentity">,
): DesktopRoute {
  const ownedKeys = new Set<string>(Object.values(FILTER_KEYS));
  const retainedFilters =
    route.section === "consent"
      ? (route.filters ?? []).filter((entry) => !ownedKeys.has(entry.key))
      : [];
  const filters = [
    ...retainedFilters,
    ...(view.source === "all"
      ? []
      : [{ key: FILTER_KEYS.source, value: view.source }]),
    ...(view.outcome === "all"
      ? []
      : [{ key: FILTER_KEYS.outcome, value: view.outcome }]),
    ...(view.evidence === "all"
      ? []
      : [{ key: FILTER_KEYS.evidence, value: view.evidence }]),
    ...(view.period === "all"
      ? []
      : [{ key: FILTER_KEYS.period, value: view.period }]),
  ];
  const next: DesktopRoute = {
    ...(route.section === "consent" ? route : { section: "consent" as const }),
    section: "consent",
    sort: { field: "recorded-at", direction: view.direction },
  };
  if (view.query.trim()) next.query = view.query.trim().slice(0, 256);
  else delete next.query;
  if (filters.length > 0) next.filters = filters;
  else delete next.filters;
  return next;
}

function routeWithConsentOverlay(
  route: DesktopRoute,
  receipt?: ConsentReceipt,
): DesktopRoute {
  const next: DesktopRoute = {
    ...(route.section === "consent" ? route : { section: "consent" as const }),
    section: "consent",
  };
  if (receipt) {
    next.overlay = {
      name: receipt.kind === "proof" ? PROOF_OVERLAY : RECEIPT_OVERLAY,
      resourceId: receipt.id,
    };
  } else {
    delete next.overlay;
  }
  return next;
}

function useConsentIdentity(): ConsentIdentity {
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
  return {
    scope:
      routeScope + ":" + (me?.effectiveRole ?? "unknown") + ":" + contextEpoch,
    workspaceId: me?.tenant ?? "",
  };
}

function resourceStateLabel<T>(
  resource: RemoteResource<T>,
  noun: string,
): { label: string; detail: string; state: string } {
  if (isInitialRemoteLoad(resource)) {
    return {
      label: "Checking " + noun,
      detail:
        "No remote evidence is shown until the response contract is validated.",
      state: "loading",
    };
  }
  if (resource.data === null) {
    return {
      label: noun + " unavailable",
      detail:
        resource.access === "denied"
          ? "Access was denied and any previously loaded evidence was removed."
          : "No contract-validated response is available for this source plane.",
      state: "unavailable",
    };
  }
  const verified = resource.lastVerifiedAt
    ? new Date(resource.lastVerifiedAt).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "this session";
  if (resource.stale) {
    return {
      label: "Last validated " + noun,
      detail:
        "Refresh failed; the response validated at " +
        verified +
        " remains visible.",
      state: "stale",
    };
  }
  if (resource.transport === "loading") {
    return {
      label: "Refreshing " + noun,
      detail: "The response validated at " + verified + " remains visible.",
      state: "refreshing",
    };
  }
  return {
    label: noun + " response validated",
    detail:
      "Latest contract-valid read in this window: " + verified + ".",
    state: "verified",
  };
}

function safeAppendFailure(error: RemoteApiError, fallback: string): string {
  return remoteFailureFromError(error).message || fallback;
}

function timestampFractionRemainder(value: string): number {
  const match = /\.(\d{1,9})(?:Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) return 0;
  const nanoseconds = match[1]!.padEnd(9, "0");
  return Number(nanoseconds.slice(3));
}

function compareConsentTimestamp(left: string, right: string): number {
  const milliseconds = Date.parse(left) - Date.parse(right);
  if (milliseconds !== 0) return milliseconds;
  return timestampFractionRemainder(left) - timestampFractionRemainder(right);
}

function compareReceiptNewest(
  left: ConsentReceipt,
  right: ConsentReceipt,
): number {
  const time = compareConsentTimestamp(right.recorded_at, left.recorded_at);
  if (time !== 0) return time;
  const kind = right.kind.localeCompare(left.kind);
  if (kind !== 0) return kind;
  return right.id.localeCompare(left.id);
}

function compareEventNewest(left: ConsentEvent, right: ConsentEvent): number {
  const time = compareConsentTimestamp(right.recorded_at, left.recorded_at);
  if (time !== 0) return time;
  return right.id.localeCompare(left.id);
}

function canAppendReceiptPage(
  existing: readonly ConsentReceipt[],
  incoming: readonly ConsentReceipt[],
): boolean {
  if (incoming.length === 0) return true;
  const identities = new Set(existing.map(receiptIdentity));
  if (incoming.some((row) => identities.has(receiptIdentity(row)))) {
    return false;
  }
  const combined = [...existing, ...incoming];
  return combined.every(
    (row, index) =>
      index === 0 || compareReceiptNewest(combined[index - 1]!, row) < 0,
  );
}

function canAppendEventPage(
  existing: readonly ConsentEvent[],
  incoming: readonly ConsentEvent[],
): boolean {
  if (incoming.length === 0) return true;
  const identities = new Set(existing.map((event) => event.id));
  if (incoming.some((event) => identities.has(event.id))) return false;
  const combined = [...existing, ...incoming];
  return combined.every(
    (row, index) =>
      index === 0 || compareEventNewest(combined[index - 1]!, row) < 0,
  );
}

export function Consent(): ReactElement {
  const identity = useConsentIdentity();
  const identityScopeRef = useRef(identity.scope);
  const routeSnapshot = useDesktopRouteSnapshot();
  const view = consentRouteView(routeSnapshot.route);
  const previousIdentityRef = useRef(identity.scope);
  const detailOpenerRef = useRef<HTMLElement | null>(null);
  const registerHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const receiptBaseRef = useRef<ConsentReceiptsResponse | null>(null);
  const eventBaseRef = useRef<ConsentEventsResponse | null>(null);
  const receiptAppendPromiseRef = useRef<Promise<void> | null>(null);
  const eventAppendPromiseRef = useRef<Promise<void> | null>(null);
  const receiptGenerationRef = useRef(0);
  const eventGenerationRef = useRef(0);
  const [localPage, setLocalPage] = useState(1);
  const [localPageSize, setLocalPageSize] = useState(DEFAULT_LOCAL_PAGE_SIZE);
  const [receiptAppend, setReceiptAppend] = useState<ReceiptAppendState>({
    base: null,
    rows: [],
    nextCursor: null,
    hasMore: false,
    loading: false,
    failure: null,
    generation: 0,
  });
  const [eventAppend, setEventAppend] = useState<EventAppendState>({
    base: null,
    rows: [],
    nextCursor: null,
    hasMore: false,
    loading: false,
    failure: null,
    generation: 0,
  });
  const receiptAppendRef = useRef(receiptAppend);
  const eventAppendRef = useRef(eventAppend);
  identityScopeRef.current = identity.scope;
  receiptAppendRef.current = receiptAppend;
  eventAppendRef.current = eventAppend;

  const receiptsResource = useRemoteResource<ConsentReceiptsResponse>(
    async () => {
      const response = await api.listConsentReceipts({
        workspaceId: identity.workspaceId,
        limit: PAGE_LIMIT,
      });
      if (response.error) return { error: response.error };
      return { data: response.data };
    },
    { identity: "consent-receipts:" + identity.scope },
  );
  const eventsResource = useRemoteResource<ConsentEventsResponse>(
    async () => {
      const response = await api.listConsentEvents({
        workspaceId: identity.workspaceId,
        limit: PAGE_LIMIT,
      });
      if (response.error) return { error: response.error };
      return { data: response.data };
    },
    { identity: "consent-events:" + identity.scope },
  );

  const receiptBase = receiptsResource.data;
  const eventBase = eventsResource.data;
  receiptBaseRef.current = receiptBase;
  eventBaseRef.current = eventBase;

  useEffect(() => {
    if (!receiptBase) return;
    const generation = ++receiptGenerationRef.current;
    receiptAppendPromiseRef.current = null;
    setReceiptAppend({
      base: receiptBase,
      rows: [],
      nextCursor: receiptBase.next_cursor ?? null,
      hasMore: receiptBase.has_more,
      loading: false,
      failure: null,
      generation,
    });
  }, [receiptBase]);

  useEffect(() => {
    if (!eventBase) return;
    const generation = ++eventGenerationRef.current;
    eventAppendPromiseRef.current = null;
    setEventAppend({
      base: eventBase,
      rows: [],
      nextCursor: eventBase.next_cursor ?? null,
      hasMore: eventBase.has_more,
      loading: false,
      failure: null,
      generation,
    });
  }, [eventBase]);

  useEffect(() => {
    if (previousIdentityRef.current === identity.scope) return;
    previousIdentityRef.current = identity.scope;
    receiptGenerationRef.current += 1;
    eventGenerationRef.current += 1;
    receiptAppendPromiseRef.current = null;
    eventAppendPromiseRef.current = null;
    detailOpenerRef.current = null;
    setReceiptAppend({
      base: null,
      rows: [],
      nextCursor: null,
      hasMore: false,
      loading: false,
      failure: null,
      generation: receiptGenerationRef.current,
    });
    setEventAppend({
      base: null,
      rows: [],
      nextCursor: null,
      hasMore: false,
      loading: false,
      failure: null,
      generation: eventGenerationRef.current,
    });
    setLocalPage(1);
    const current = getDesktopRoute();
    const reset = routeWithConsentView(current, {
      source: "all",
      outcome: "all",
      evidence: "all",
      period: "all",
      query: "",
      direction: "desc",
    });
    void requestDesktopRouteNavigation(routeWithConsentOverlay(reset), {
      replace: true,
      source: "identity",
    });
  }, [identity.scope]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.key !== "/" ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const receiptAppendMatches =
    receiptBase !== null && receiptAppend.base === receiptBase;
  const eventAppendMatches =
    eventBase !== null && eventAppend.base === eventBase;
  const receiptRows = useMemo(
    () =>
      receiptBase
        ? [
            ...receiptBase.receipts,
            ...(receiptAppendMatches ? receiptAppend.rows : []),
          ]
        : null,
    [receiptAppend.rows, receiptAppendMatches, receiptBase],
  );
  const eventRows = useMemo(
    () =>
      eventBase
        ? [...eventBase.events, ...(eventAppendMatches ? eventAppend.rows : [])]
        : null,
    [eventAppend.rows, eventAppendMatches, eventBase],
  );
  const receiptHasMore = receiptAppendMatches
    ? receiptAppend.hasMore
    : Boolean(receiptBase?.has_more);
  const eventHasMore = eventAppendMatches
    ? eventAppend.hasMore
    : Boolean(eventBase?.has_more);
  const receiptLoadingOlder = receiptAppendMatches && receiptAppend.loading;
  const eventLoadingOlder = eventAppendMatches && eventAppend.loading;
  const receiptAppendFailure = receiptAppendMatches
    ? receiptAppend.failure
    : null;
  const eventAppendFailure = eventAppendMatches ? eventAppend.failure : null;
  const initialLoading = isInitialRemoteLoad(receiptsResource);

  const loadOlderReceipts = useCallback(async (): Promise<void> => {
    if (receiptAppendPromiseRef.current) {
      return await receiptAppendPromiseRef.current;
    }
    const base = receiptBaseRef.current;
    const state = receiptAppendRef.current;
    const cursor =
      state.base === base ? state.nextCursor : (base?.next_cursor ?? null);
    if (!base || !cursor) return;
    const generation = receiptGenerationRef.current;
    const operationScope = identityScopeRef.current;
    const operation = (async (): Promise<void> => {
      setReceiptAppend((current) => ({
        ...(current.base === base
          ? current
          : {
              base,
              rows: [],
              nextCursor: base.next_cursor ?? null,
              hasMore: base.has_more,
              generation,
            }),
        loading: true,
        failure: null,
      }));
      let response: Awaited<ReturnType<typeof api.listConsentReceipts>>;
      try {
        response = await api.listConsentReceipts({
          workspaceId: identity.workspaceId,
          limit: PAGE_LIMIT,
          cursor,
        });
      } catch {
        if (
          receiptBaseRef.current === base &&
          identityScopeRef.current === operationScope &&
          receiptGenerationRef.current === generation
        ) {
          setReceiptAppend((current) =>
            current.base === base
              ? {
                  ...current,
                  loading: false,
                  failure:
                    "The older receipt/proof page could not be reached. Loaded evidence was kept.",
                }
              : current,
          );
        }
        return;
      }
      if (
        receiptBaseRef.current !== base ||
        identityScopeRef.current !== operationScope ||
        receiptGenerationRef.current !== generation
      ) {
        return;
      }
      if (response.error) {
        setReceiptAppend((current) =>
          current.base === base
            ? {
                ...current,
                loading: false,
                failure: safeAppendFailure(
                  response.error,
                  "The older receipt/proof page could not be verified.",
                ),
              }
            : current,
        );
        return;
      }
      const page = response.data;
      const current = receiptAppendRef.current;
      const alreadyLoaded = [
        ...base.receipts,
        ...(current.base === base ? current.rows : []),
      ];
      if (
        page.snapshot_at !== base.snapshot_at ||
        page.workspace_id !== base.workspace_id ||
        (page.receipts.length === 0 && page.has_more) ||
        page.next_cursor === cursor ||
        !canAppendReceiptPage(alreadyLoaded, page.receipts)
      ) {
        setReceiptAppend((previous) =>
          previous.base === base
            ? {
                ...previous,
                loading: false,
                failure:
                  "The server returned an inconsistent older receipt/proof page. Loaded evidence was kept; refresh from a new boundary before retrying.",
              }
            : previous,
        );
        return;
      }
      setReceiptAppend((previous) =>
        previous.base === base && previous.generation === generation
          ? {
              ...previous,
              rows: [...previous.rows, ...page.receipts],
              nextCursor: page.next_cursor ?? null,
              hasMore: page.has_more,
              loading: false,
              failure: null,
            }
          : previous,
      );
    })();
    receiptAppendPromiseRef.current = operation;
    try {
      await operation;
    } finally {
      if (receiptAppendPromiseRef.current === operation) {
        receiptAppendPromiseRef.current = null;
      }
    }
  }, [identity.workspaceId]);

  const loadOlderEvents = useCallback(async (): Promise<void> => {
    if (eventAppendPromiseRef.current) {
      return await eventAppendPromiseRef.current;
    }
    const base = eventBaseRef.current;
    const state = eventAppendRef.current;
    const cursor =
      state.base === base ? state.nextCursor : (base?.next_cursor ?? null);
    if (!base || !cursor) return;
    const generation = eventGenerationRef.current;
    const operationScope = identityScopeRef.current;
    const operation = (async (): Promise<void> => {
      setEventAppend((current) => ({
        ...(current.base === base
          ? current
          : {
              base,
              rows: [],
              nextCursor: base.next_cursor ?? null,
              hasMore: base.has_more,
              generation,
            }),
        loading: true,
        failure: null,
      }));
      let response: Awaited<ReturnType<typeof api.listConsentEvents>>;
      try {
        response = await api.listConsentEvents({
          workspaceId: identity.workspaceId,
          limit: PAGE_LIMIT,
          cursor,
        });
      } catch {
        if (
          eventBaseRef.current === base &&
          identityScopeRef.current === operationScope &&
          eventGenerationRef.current === generation
        ) {
          setEventAppend((current) =>
            current.base === base
              ? {
                  ...current,
                  loading: false,
                  failure:
                    "The older event page could not be reached. Loaded correlation evidence was kept.",
                }
              : current,
          );
        }
        return;
      }
      if (
        eventBaseRef.current !== base ||
        identityScopeRef.current !== operationScope ||
        eventGenerationRef.current !== generation
      ) {
        return;
      }
      if (response.error) {
        setEventAppend((current) =>
          current.base === base
            ? {
                ...current,
                loading: false,
                failure: safeAppendFailure(
                  response.error,
                  "The older event page could not be verified.",
                ),
              }
            : current,
        );
        return;
      }
      const page = response.data;
      const current = eventAppendRef.current;
      const alreadyLoaded = [
        ...base.events,
        ...(current.base === base ? current.rows : []),
      ];
      if (
        page.snapshot_at !== base.snapshot_at ||
        page.workspace_id !== base.workspace_id ||
        (page.events.length === 0 && page.has_more) ||
        page.next_cursor === cursor ||
        !canAppendEventPage(alreadyLoaded, page.events)
      ) {
        setEventAppend((previous) =>
          previous.base === base
            ? {
                ...previous,
                loading: false,
                failure:
                  "The server returned an inconsistent older event page. Loaded correlation evidence was kept; refresh from a new boundary before retrying.",
              }
            : previous,
        );
        return;
      }
      setEventAppend((previous) =>
        previous.base === base && previous.generation === generation
          ? {
              ...previous,
              rows: [...previous.rows, ...page.events],
              nextCursor: page.next_cursor ?? null,
              hasMore: page.has_more,
              loading: false,
              failure: null,
            }
          : previous,
      );
    })();
    eventAppendPromiseRef.current = operation;
    try {
      await operation;
    } finally {
      if (eventAppendPromiseRef.current === operation) {
        eventAppendPromiseRef.current = null;
      }
    }
  }, [identity.workspaceId]);

  const sourceCounts = useMemo(() => {
    const counts: Record<SourceFilter, number> = {
      all: 0,
      form: 0,
      api: 0,
      import: 0,
      "public-record": 0,
      other: 0,
    };
    for (const receipt of receiptRows ?? []) {
      counts.all += 1;
      counts[consentSourceBucket(receipt.source)] += 1;
    }
    return counts;
  }, [receiptRows]);

  const stats = useMemo(() => {
    let optIns30d = 0;
    let optOuts30d = 0;
    let futureOccurrences = 0;
    const now = Date.now();
    for (const receipt of receiptRows ?? []) {
      const occurredAt = validTimestamp(receipt.at);
      if (occurredAt !== null && occurredAt > now) {
        futureOccurrences += 1;
        continue;
      }
      if (!isWithinDays(receipt.at, 30)) continue;
      const group = consentOutcomeGroup(receipt.new_state);
      if (group === "opt-in") optIns30d += 1;
      else if (group === "opt-out") optOuts30d += 1;
    }
    for (const event of eventRows ?? []) {
      const occurredAt = validTimestamp(event.created_at);
      if (occurredAt !== null && occurredAt > now) futureOccurrences += 1;
    }
    const gpc30d = gpcSubjectSummary(
      (eventRows ?? []).filter((event) => isWithinDays(event.created_at, 30)),
    );
    return { optIns30d, optOuts30d, gpc30d, futureOccurrences };
  }, [eventRows, receiptRows]);

  const loadedGpc = useMemo(
    () => gpcSubjectSummary(eventRows ?? []),
    [eventRows],
  );

  const filtered = useMemo(() => {
    const needle = view.query.trim().toLowerCase();
    const next = (receiptRows ?? []).filter((receipt) => {
      if (
        view.source !== "all" &&
        consentSourceBucket(receipt.source) !== view.source
      ) {
        return false;
      }
      if (
        view.outcome !== "all" &&
        consentOutcomeGroup(receipt.new_state) !== view.outcome
      ) {
        return false;
      }
      if (view.evidence !== "all" && receipt.kind !== view.evidence) {
        return false;
      }
      if (!isWithinPeriod(receipt.at, view.period)) return false;
      if (!needle) return true;
      return [
        receipt.subscriber_email,
        receiptIdentity(receipt),
        receipt.source,
        receipt.source_detail,
        receipt.privacy_policy_version,
        receipt.new_state,
      ].some((value) => (value ?? "").toLowerCase().includes(needle));
    });
    return next.sort((left, right) => {
      const ordered = compareReceiptNewest(left, right);
      return view.direction === "asc" ? -ordered : ordered;
    });
  }, [receiptRows, view]);

  useEffect(
    () => setLocalPage(1),
    [
      identity.scope,
      view.direction,
      view.evidence,
      view.outcome,
      view.period,
      view.query,
      view.source,
    ],
  );

  const localPageCount = Math.max(
    1,
    Math.ceil(filtered.length / localPageSize),
  );
  const boundedLocalPage = Math.min(localPage, localPageCount);
  const pageRows = filtered.slice(
    (boundedLocalPage - 1) * localPageSize,
    boundedLocalPage * localPageSize,
  );
  const selected =
    view.selectedIdentity && receiptRows
      ? (receiptRows.find(
          (receipt) => receiptIdentity(receipt) === view.selectedIdentity,
        ) ?? null)
      : null;

  const updateView = useCallback(
    (patch: Partial<Omit<ConsentRouteView, "selectedIdentity">>): void => {
      const current = getDesktopRoute();
      const currentView = consentRouteView(current);
      void requestDesktopRouteNavigation(
        routeWithConsentView(current, {
          source: patch.source ?? currentView.source,
          outcome: patch.outcome ?? currentView.outcome,
          evidence: patch.evidence ?? currentView.evidence,
          period: patch.period ?? currentView.period,
          query: patch.query ?? currentView.query,
          direction: patch.direction ?? currentView.direction,
        }),
        { replace: true, source: "navigation" },
      );
    },
    [],
  );

  const resetView = useCallback((): void => {
    void requestDesktopRouteNavigation(
      routeWithConsentView(getDesktopRoute(), {
        source: "all",
        outcome: "all",
        evidence: "all",
        period: "all",
        query: "",
        direction: "desc",
      }),
      { replace: true, source: "navigation" },
    ).then((result) => {
      if (result !== "proceeded") return;
      window.requestAnimationFrame(() =>
        registerHeadingRef.current?.focus({ preventScroll: true }),
      );
    });
  }, []);

  const openDetail = useCallback(
    (receipt: ConsentReceipt, opener: HTMLElement): void => {
      detailOpenerRef.current = opener;
      void requestDesktopRouteNavigation(
        routeWithConsentOverlay(getDesktopRoute(), receipt),
        { source: "navigation" },
      );
    },
    [],
  );

  const closeDetail = useCallback((): void => {
    const opener = detailOpenerRef.current;
    void requestDesktopRouteNavigation(
      routeWithConsentOverlay(getDesktopRoute()),
      { replace: true, source: "navigation" },
    ).then((result) => {
      if (result !== "proceeded") return;
      window.requestAnimationFrame(() => {
        if (opener?.isConnected) opener.focus({ preventScroll: true });
        else registerHeadingRef.current?.focus({ preventScroll: true });
      });
    });
  }, []);

  const activeFilterCount = [
    view.source !== "all",
    view.outcome !== "all",
    view.evidence !== "all",
    view.period !== "all",
    Boolean(view.query.trim()),
    view.direction !== "desc",
  ].filter(Boolean).length;

  const statCells: StatCell[] = [
    {
      label: "Loaded receipt / proof rows",
      value: receiptRows ? receiptRows.length.toLocaleString() : "—",
      hint: "Rows loaded from the contract-validated receipt/proof response. This is not a workspace-wide or cross-channel total.",
    },
    {
      label: "Loaded opt-ins · 30d",
      value: receiptRows ? stats.optIns30d.toLocaleString() : "—",
      hint: "Loaded receipt/proof rows in the last 30 days whose exact state maps to opt-in.",
    },
    {
      label: "Loaded opt-outs · 30d",
      value: receiptRows ? stats.optOuts30d.toLocaleString() : "—",
      hint: "Loaded receipt/proof rows in the last 30 days whose exact state maps to opt-out.",
    },
    {
      label: "Known GPC subjects · 30d",
      value: eventRows ? stats.gpc30d.knownSubjectCount.toLocaleString() : "—",
      hint: eventRows
        ? "Unique known subjects with a GPC-tagged row in the loaded 30-day event window, deduplicated by subject type and stable ID or email. Recording does not prove enforcement."
        : "The consent-event response is unavailable, so GPC subject correlation cannot be evaluated.",
    },
  ];

  return (
    <div
      className="consent-command-center"
      data-testid="consent-command-center"
    >
      <PageHeader
        eyebrow="Compliance evidence"
        title="Consent evidence"
        titleBadge={<span className="consent-read-only-badge">Read-only</span>}
        subtitle="Inspect contract-validated receipt/proof pages and a separate consent-event correlation window. This workspace does not represent either source as a complete consent ledger or a legal conclusion."
        actions={[
          {
            label:
              receiptsResource.transport === "loading" ||
              eventsResource.transport === "loading"
                ? "Refreshing…"
                : "Refresh evidence",
            icon: <Icon name="arrow-right" size={15} />,
            onClick: () => {
              void receiptsResource.reload();
              void eventsResource.reload();
            },
            disabled:
              receiptsResource.transport === "loading" ||
              eventsResource.transport === "loading",
            title:
              receiptsResource.transport === "loading" ||
              eventsResource.transport === "loading"
                ? "The two evidence sources are already refreshing."
                : "Request fresh responses for both source planes.",
          },
        ]}
      />

      <ConsentTrustMasthead
        receipts={receiptsResource}
        events={eventsResource}
        receiptRows={receiptRows}
        eventRows={eventRows}
        receiptHasMore={receiptHasMore}
        eventHasMore={eventHasMore}
        eventLoadingOlder={
          eventLoadingOlder || eventsResource.transport === "loading"
        }
        eventAppendFailure={eventAppendFailure}
        gpc={loadedGpc}
        onLoadOlderEvents={() => void loadOlderEvents()}
      />

      <ConsentEvidenceBoundaries />

      {receiptRows ? <StatStrip cells={statCells} /> : null}

      <RemoteDataNotice
        resource={receiptsResource}
        label="receipt and proof evidence"
        onRetry={() => void receiptsResource.reload()}
      />
      <RemoteDataNotice
        resource={eventsResource}
        label="consent-event correlation"
        onRetry={() => void eventsResource.reload()}
      />

      {stats.gpc30d.unknownIdentityRows > 0 && eventRows ? (
        <Notice
          tone="warning"
          title="Some loaded GPC signal rows have no correlatable subject"
          announcement="off"
          className="consent-scope-notice"
        >
          {stats.gpc30d.unknownIdentityRows.toLocaleString() +
            " loaded 30-day GPC-tagged " +
            (stats.gpc30d.unknownIdentityRows === 1 ? "row has" : "rows have") +
            " no stable subject ID or email. Those rows are not counted as known subjects and cannot be correlated to receipt/proof rows here."}
        </Notice>
      ) : null}

      {stats.futureOccurrences > 0 ? (
        <Notice
          tone="warning"
          title="Future-dated evidence excluded from rolling metrics"
          announcement="off"
          className="consent-scope-notice"
        >
          {stats.futureOccurrences.toLocaleString() +
            " loaded occurrence " +
            (stats.futureOccurrences === 1
              ? "timestamp is"
              : "timestamps are") +
            " later than this device's current time. The rows remain inspectable, but they are excluded from rolling metrics and bounded time filters so they cannot inflate recent activity."}
        </Notice>
      ) : null}

      <section
        className="consent-register"
        aria-labelledby="consent-register-title"
      >
        <header className="consent-register-header">
          <div>
            <span className="consent-kicker">Receipt / proof register</span>
            <h2
              id="consent-register-title"
              ref={registerHeadingRef}
              tabIndex={-1}
            >
              Loaded consent evidence
            </h2>
            <p>
              Search and filter the exact rows loaded from consent_receipts and
              consent_records. Consent events, SMS consent, suppressions, and
              channel eligibility are separate evidence planes.
            </p>
          </div>
          {receiptRows ? (
            <div
              className="consent-result-count"
              role="status"
              aria-live="polite"
            >
              <strong>{filtered.length.toLocaleString()}</strong>{" "}
              <span>of {receiptRows.length.toLocaleString()} loaded</span>
            </div>
          ) : null}
        </header>

        {receiptRows ? (
          <ConsentFilters
            view={view}
            sourceCounts={sourceCounts}
            activeFilterCount={activeFilterCount}
            searchRef={searchRef}
            onChange={updateView}
            onReset={resetView}
          />
        ) : null}

        {initialLoading ? (
          <ConsentRegisterSkeleton />
        ) : receiptRows === null ? null : receiptRows.length === 0 ? (
          <HeroEmptyState
            tone="blue"
            eyebrow="Validated empty page"
            title="No receipt or proof evidence was returned."
            subtitle="The current receipt/proof page is empty. This does not establish consent, suppression, or delivery eligibility for any subscriber."
          />
        ) : filtered.length === 0 ? (
          <ConsentFilterEmptyState onReset={resetView} />
        ) : (
          <>
            <ConsentEvidenceTable
              rows={pageRows}
              gpcSubjects={loadedGpc.subscriberEmails}
              eventCorrelationAvailable={eventRows !== null}
              onOpen={openDetail}
            />
            <ConsentEvidenceCards
              rows={pageRows}
              gpcSubjects={loadedGpc.subscriberEmails}
              eventCorrelationAvailable={eventRows !== null}
              onOpen={openDetail}
            />
            <DataTablePagination
              label="loaded receipt and proof evidence"
              page={boundedLocalPage}
              pageCount={localPageCount}
              hasPrevious={boundedLocalPage > 1}
              hasNext={boundedLocalPage < localPageCount}
              onPrevious={() =>
                setLocalPage((current) => Math.max(1, current - 1))
              }
              onNext={() =>
                setLocalPage((current) => Math.min(localPageCount, current + 1))
              }
              onFirst={() => setLocalPage(1)}
              onLast={() => setLocalPage(localPageCount)}
              itemSummary={
                <span>
                  Showing{" "}
                  {(
                    (boundedLocalPage - 1) * localPageSize +
                    1
                  ).toLocaleString()}
                  –
                  {Math.min(
                    boundedLocalPage * localPageSize,
                    filtered.length,
                  ).toLocaleString()}{" "}
                  of {filtered.length.toLocaleString()} matching loaded rows
                </span>
              }
              pageSize={localPageSize}
              pageSizeOptions={[25, 50, 100]}
              onPageSizeChange={(next) => {
                setLocalPageSize(next);
                setLocalPage(1);
              }}
            />
          </>
        )}

        {receiptRows && receiptRows.length > 0 ? (
          receiptAppendFailure ? (
            <Notice
              tone="warning"
              title="Could not verify the next receipt / proof page"
              announcement="polite"
              className="consent-load-older-notice"
              action={
                <button
                  type="button"
                  className="btn"
                  onClick={() => void loadOlderReceipts()}
                >
                  Retry older page
                </button>
              }
            >
              {receiptAppendFailure}
            </Notice>
          ) : (
            <div className="consent-load-older">
              <DataTableLoadMore
                label="receipt and proof evidence"
                loadedCount={receiptRows.length}
                hasMore={receiptHasMore}
                busy={
                  receiptLoadingOlder ||
                  receiptsResource.transport === "loading"
                }
                onLoadMore={() => void loadOlderReceipts()}
                endLabel="End of the loaded receipt / proof page family"
              />
            </div>
          )
        ) : null}
      </section>

      {selected ? (
        <ReceiptDrawer
          key={identity.scope + ":" + receiptIdentity(selected)}
          receipt={selected}
          gpcSignalInLoadedWindow={
            eventRows === null
              ? null
              : loadedGpc.subscriberEmails.has(
                  selected.subscriber_email.trim().toLowerCase(),
                )
          }
          onClose={closeDetail}
        />
      ) : view.selectedIdentity && receiptRows ? (
        <MissingReceiptDrawer
          identity={view.selectedIdentity}
          onClose={closeDetail}
        />
      ) : null}
    </div>
  );
}

function ConsentTrustMasthead({
  receipts,
  events,
  receiptRows,
  eventRows,
  receiptHasMore,
  eventHasMore,
  eventLoadingOlder,
  eventAppendFailure,
  gpc,
  onLoadOlderEvents,
}: {
  receipts: RemoteResource<ConsentReceiptsResponse>;
  events: RemoteResource<ConsentEventsResponse>;
  receiptRows: ConsentReceipt[] | null;
  eventRows: ConsentEvent[] | null;
  receiptHasMore: boolean;
  eventHasMore: boolean;
  eventLoadingOlder: boolean;
  eventAppendFailure: string | null;
  gpc: GpcSubjectSummary;
  onLoadOlderEvents: () => void;
}): ReactElement {
  const receiptState = resourceStateLabel(receipts, "receipt / proof");
  const eventState = resourceStateLabel(events, "event");
  return (
    <section
      className="consent-trust-masthead"
      aria-labelledby="consent-trust-title"
    >
      <div className="consent-trust-copy">
        <span className="consent-kicker">Evidence posture</span>
        <h2 id="consent-trust-title">Know exactly what this view can prove.</h2>
        <p>
          Each source response is contract-validated independently. A cursor
          excludes rows committed after page one, but governed changes can
          affect later pages; this is not an immutable database snapshot.
        </p>
        <div className="consent-assurance-row" aria-label="Surface assurances">
          <span>
            <Icon name="lock" size={14} /> Admin-only
          </span>
          <span>
            <Icon name="eye" size={14} /> Inspection-only
          </span>
          <span>
            <Icon name="shield-check" size={14} /> Identity-bound reads
          </span>
        </div>
      </div>
      <div className="consent-stream-grid">
        <article
          className="consent-stream-card"
          data-state={receiptState.state}
        >
          <div className="consent-stream-card-topline">
            <span>Receipt / proof</span>
            <strong>
              {receiptRows ? receiptRows.length.toLocaleString() : "—"}
            </strong>
          </div>
          <h3>{receiptState.label}</h3>
          <p>{receiptState.detail}</p>
          {receipts.data ? (
            <>
              <code className="consent-stream-snapshot">
                Boundary {formatTimestamp(receipts.data.snapshot_at)}
              </code>
              <span className="consent-stream-scope">
                {receiptHasMore
                  ? "Older pages available"
                  : "Loaded to continuation end"}
              </span>
            </>
          ) : null}
        </article>
        <article className="consent-stream-card" data-state={eventState.state}>
          <div className="consent-stream-card-topline">
            <span>Event correlation</span>
            <strong>
              {eventRows ? eventRows.length.toLocaleString() : "—"}
            </strong>
          </div>
          <h3>{eventState.label}</h3>
          <p>{eventState.detail}</p>
          {events.data ? (
            <>
              <code className="consent-stream-snapshot">
                Boundary {formatTimestamp(events.data.snapshot_at)}
              </code>
              <span className="consent-stream-scope">
                {gpc.knownSubjectCount.toLocaleString()} known GPC{" "}
                {gpc.knownSubjectCount === 1 ? "subject" : "subjects"} loaded
              </span>
              {eventAppendFailure ? (
                <span className="consent-stream-failure" role="status">
                  {eventAppendFailure}
                </span>
              ) : null}
              {eventHasMore || eventAppendFailure ? (
                <button
                  type="button"
                  className="btn"
                  disabled={eventLoadingOlder}
                  onClick={onLoadOlderEvents}
                >
                  {eventLoadingOlder
                    ? "Loading older events…"
                    : "Load older events"}
                </button>
              ) : null}
            </>
          ) : null}
        </article>
      </div>
    </section>
  );
}

function ConsentEvidenceBoundaries(): ReactElement {
  const boundaries = [
    {
      title: "Separate source planes",
      detail:
        "This register does not include consent_events, SMS consent, suppressions, or every channel-specific decision.",
    },
    {
      title: "Integrity qualification held",
      detail:
        "No signed or certified export, complete retention proof, or legal-hold evidence is available from this renderer.",
    },
    {
      title: "Append-only is source-specific",
      detail:
        "Governed identifier redaction and deletion semantics differ by source; this view makes no global append-only claim.",
    },
    {
      title: "Legal conclusions held",
      detail:
        "A stored row is evidence to review, not a determination of legal sufficiency or current send eligibility.",
    },
  ];
  return (
    <section
      className="consent-boundary-panel"
      aria-labelledby="consent-boundary-title"
    >
      <div>
        <span className="consent-kicker">Release status</span>
        <h2 id="consent-boundary-title">Evidence boundaries</h2>
        <p>
          Capabilities without an approved evidence chain stay visible as
          non-interactive boundaries. This page intentionally has no export or
          mutation action.
        </p>
      </div>
      <ul className="consent-boundary-list">
        {boundaries.map((boundary) => (
          <li key={boundary.title}>
            <span className="consent-boundary-icon" aria-hidden="true">
              <Icon name="lock" size={14} />
            </span>
            <span>
              <strong>{boundary.title}</strong>
              <span>{boundary.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ConsentFilters({
  view,
  sourceCounts,
  activeFilterCount,
  searchRef,
  onChange,
  onReset,
}: {
  view: ConsentRouteView;
  sourceCounts: Record<SourceFilter, number>;
  activeFilterCount: number;
  searchRef: RefObject<HTMLInputElement | null>;
  onChange: (
    patch: Partial<Omit<ConsentRouteView, "selectedIdentity">>,
  ) => void;
  onReset: () => void;
}): ReactElement {
  return (
    <div className="consent-filter-shell">
      <div
        className="consent-source-filters"
        role="group"
        aria-label="Filter by recorded source"
      >
        {SOURCE_FILTERS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={
              "consent-source-chip" +
              (view.source === entry.id ? " is-active" : "")
            }
            aria-pressed={view.source === entry.id}
            aria-label={
              entry.label +
              ", " +
              sourceCounts[entry.id].toLocaleString() +
              " loaded"
            }
            onClick={() => onChange({ source: entry.id })}
          >
            <span>{entry.label}</span>
            <span className="consent-source-count" aria-hidden="true">
              {sourceCounts[entry.id].toLocaleString()}
            </span>
          </button>
        ))}
      </div>

      <div className="consent-filter-controls">
        <label className="consent-search-control">
          <span>Search loaded evidence</span>
          <span className="consent-search-input-wrap">
            <Icon name="eye" size={15} />
            <input
              ref={searchRef}
              type="search"
              className="input"
              placeholder="Email, source, policy, or record identity"
              maxLength={256}
              autoComplete="off"
              value={view.query}
              onChange={(event) =>
                onChange({ query: event.currentTarget.value })
              }
              onKeyDown={(event) => {
                if (event.key !== "Escape" || !view.query) return;
                event.preventDefault();
                onChange({ query: "" });
              }}
            />
            <kbd aria-label="Keyboard shortcut slash">/</kbd>
          </span>
        </label>
        <label>
          <span>Recorded outcome</span>
          <select
            className="select"
            value={view.outcome}
            onChange={(event) =>
              onChange({
                outcome: event.currentTarget.value as OutcomeFilter,
              })
            }
          >
            {OUTCOME_FILTERS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Evidence type</span>
          <select
            className="select"
            value={view.evidence}
            onChange={(event) =>
              onChange({
                evidence: event.currentTarget.value as EvidenceFilter,
              })
            }
          >
            {EVIDENCE_FILTERS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Occurred</span>
          <select
            className="select"
            value={view.period}
            onChange={(event) =>
              onChange({
                period: event.currentTarget.value as PeriodFilter,
              })
            }
          >
            {PERIOD_FILTERS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Loaded order</span>
          <select
            className="select"
            value={view.direction}
            onChange={(event) =>
              onChange({
                direction: event.currentTarget.value as "asc" | "desc",
              })
            }
          >
            <option value="desc">Newest recorded first</option>
            <option value="asc">Oldest loaded first</option>
          </select>
        </label>
      </div>

      <div className="consent-filter-summary">
        <span role="status" aria-live="polite">
          {activeFilterCount === 0
            ? "No filters applied · newest recorded evidence first"
            : activeFilterCount.toLocaleString() +
              " " +
              (activeFilterCount === 1 ? "filter" : "filters") +
              " applied"}
        </span>
        {activeFilterCount > 0 ? (
          <button type="button" className="btn btn-ghost" onClick={onReset}>
            Reset view
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ConsentRegisterSkeleton(): ReactElement {
  return (
    <div
      className="consent-register-skeleton"
      aria-busy="true"
      aria-label="Loading consent evidence"
    >
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <div key={index} className="consent-skeleton-row" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
      ))}
      <span className="visually-hidden">Loading consent evidence…</span>
    </div>
  );
}

function ConsentFilterEmptyState({
  onReset,
}: {
  onReset: () => void;
}): ReactElement {
  return (
    <div className="consent-filter-empty">
      <div className="consent-filter-empty-icon" aria-hidden="true">
        <Icon name="eye-off" size={22} />
      </div>
      <h3>No loaded evidence matches this view.</h3>
      <p>
        Broaden the source, state, evidence type, or occurrence window. Search
        applies only to receipt/proof pages currently loaded in this page family.
      </p>
      <button type="button" className="btn" onClick={onReset}>
        Reset view
      </button>
    </div>
  );
}

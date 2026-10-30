import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  api,
  type ApiResult,
  type Campaign,
  type CampaignsResponse,
  type DashboardRange,
  type DashboardStatsResponse,
} from "../../lib/api-client";
import {
  notifyMilestoneCrossings,
  notifyNewAnomalies,
} from "../../lib/dashboard-notifier";
import { qk } from "../../lib/query-keys";
import { connectDashboardLive, type SseStatus } from "../../lib/sse";
import { type Role, setActiveSend, setLiveSubs } from "../../lib/store";
import { useQueryInvalidationReload } from "../../lib/use-query-invalidation-reload";
import {
  useDashboardCampaignPolling,
  useDashboardPolling,
} from "./useDashboardPolling";

const STALE_TICK_MS = 1000;
const DASHBOARD_RECENT_AUDIT_MAX_ROWS = 20;
const DASHBOARD_CAMPAIGN_PREVIEW_ROWS = 5;
const DASHBOARD_SHORT_TEXT_MAX_LENGTH = 256;
const DASHBOARD_NAME_MAX_LENGTH = 1024;
const DASHBOARD_DESCRIPTION_MAX_LENGTH = 2048;
const DASHBOARD_NESTED_FIELD_MAX_COUNT = 16;
const CAMPAIGN_STATUSES = new Set([
  "draft",
  "scheduled",
  "sending",
  "sent",
  "paused",
  "cancelled",
  "failed",
]);
const INBOX_HEALTH_STATES = new Set([
  "healthy",
  "good",
  "watch",
  "degraded",
  "critical",
]);

export type DashboardLoadState = "initial" | "range" | "refresh" | "ready";

export type DashboardStatsFailureKind =
  | "offline"
  | "access"
  | "unavailable"
  | "service"
  | "invalid"
  | "generic";

export interface DashboardStatsFailure {
  kind: DashboardStatsFailureKind;
  /** Stable presentation copy; never derived from an upstream message. */
  message: string;
}

interface DashboardDataOptions {
  hasIdentity: boolean;
  notificationScope: string | null;
  range: DashboardRange;
  role: Role | null;
  tenantId: string;
}

export interface DashboardDataController {
  stats: DashboardStatsResponse | null;
  campaigns: Campaign[] | null;
  campaignsLoading: boolean;
  campaignsError: boolean;
  campaignsStale: boolean;
  loading: boolean;
  loadState: DashboardLoadState;
  resolvedRange: DashboardRange | null;
  lastSuccessAt: number;
  error: string | null;
  statsFailure: DashboardStatsFailure | null;
  liveStatus: SseStatus;
  lastEventAt: number;
  now: number;
  load: () => Promise<void>;
  refreshCampaigns: () => Promise<void>;
}

interface DashboardStatsResolution {
  data: DashboardStatsResponse;
  range: DashboardRange;
  receivedAt: number;
  tenantId: string;
}

interface DashboardCampaignResolution {
  data: Campaign[];
  tenantId: string;
}

interface DashboardRequestContext {
  hasIdentity: boolean;
  range: DashboardRange;
  tenantId: string;
}

interface DashboardPendingRequest {
  key: string;
  promise: Promise<void>;
}

interface DashboardTransportController {
  liveStatus: SseStatus;
  lastEventAt: number;
  now: number;
}

const RANGE_VALUES: readonly DashboardRange[] = ["7d", "30d", "90d"];
const COUNT_FIELDS = [
  "subscribers_total",
  "subscribers_added_30d",
  "subscribers_unsubbed_30d",
  "campaigns_sent_30d",
  "emails_sent_30d",
  "opens_total_30d",
  "unique_opens_30d",
  "clicks_total_30d",
  "unique_clicks_30d",
  "bounces_total_30d",
  "unique_bounces_30d",
  "unique_delivered_30d",
  "unique_sent_30d",
  "active_sequences_count",
] as const;
const PREVIOUS_COUNT_FIELDS = [
  "subscribers_added",
  "subscribers_unsubbed",
  "campaigns_sent",
  "emails_sent",
  "opens_total",
  "unique_opens",
  "clicks_total",
  "unique_clicks",
  "bounces_total",
  "unique_bounces",
  "unique_delivered",
  "unique_sent",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteInRange(
  value: unknown,
  minimum = Number.NEGATIVE_INFINITY,
  maximum = Number.POSITIVE_INFINITY,
): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function validOptionalNumber(
  record: Record<string, unknown>,
  key: string,
  minimum = Number.NEGATIVE_INFINITY,
  maximum = Number.POSITIVE_INFINITY,
): boolean {
  return (
    record[key] === undefined || isFiniteInRange(record[key], minimum, maximum)
  );
}

function isSafeIntegerInRange(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function validOptionalCount(
  record: Record<string, unknown>,
  key: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): boolean {
  return (
    record[key] === undefined ||
    isSafeIntegerInRange(record[key], minimum, maximum)
  );
}

function validOptionalString(
  record: Record<string, unknown>,
  key: string,
  maximumLength: number,
): boolean {
  const value = record[key];
  return (
    value === undefined ||
    (typeof value === "string" && value.length <= maximumLength)
  );
}

function isDashboardAuditEvent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!validOptionalString(value, "id", DASHBOARD_SHORT_TEXT_MAX_LENGTH)) {
    return false;
  }
  if (!validOptionalString(value, "action", DASHBOARD_SHORT_TEXT_MAX_LENGTH)) {
    return false;
  }
  if (!validOptionalString(value, "actor", DASHBOARD_NAME_MAX_LENGTH)) {
    return false;
  }
  if (
    !validOptionalString(value, "description", DASHBOARD_DESCRIPTION_MAX_LENGTH)
  ) {
    return false;
  }
  if (!validOptionalString(value, "at", DASHBOARD_SHORT_TEXT_MAX_LENGTH)) {
    return false;
  }
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    return false;
  }
  const hasContent = [value.description, value.action].some(
    (field) => typeof field === "string" && field.trim().length > 0,
  );
  if (!hasContent) return false;
  const at = value.at;
  return at === undefined || Number.isFinite(Date.parse(at as string));
}

function sparklinePointLimit(range: unknown): number {
  if (range === "7d") return 7;
  if (range === "90d") return 90;
  return 30;
}

/** Reject malformed transport data before it can update receipt freshness. */
function isDashboardStatsPayload(
  value: unknown,
): value is DashboardStatsResponse {
  if (!isRecord(value)) return false;
  if (
    value.range !== undefined &&
    !RANGE_VALUES.some((range) => range === value.range)
  ) {
    return false;
  }
  if (COUNT_FIELDS.some((key) => !validOptionalCount(value, key))) {
    return false;
  }
  if (value.previous !== undefined) {
    if (!isRecord(value.previous)) return false;
    if (
      PREVIOUS_COUNT_FIELDS.some(
        (key) =>
          !validOptionalCount(value.previous as Record<string, unknown>, key),
      )
    ) {
      return false;
    }
  }
  if (value.sparklines !== undefined) {
    if (!isRecord(value.sparklines)) return false;
    if (
      Object.keys(value.sparklines).length > DASHBOARD_NESTED_FIELD_MAX_COUNT ||
      Object.values(value.sparklines).some(
        (series) =>
          !Array.isArray(series) ||
          series.length > sparklinePointLimit(value.range) ||
          series.some((point) => !isSafeIntegerInRange(point)),
      )
    ) {
      return false;
    }
  }
  if (value.anomalies !== undefined) {
    if (
      !isRecord(value.anomalies) ||
      Object.keys(value.anomalies).length > DASHBOARD_NESTED_FIELD_MAX_COUNT ||
      Object.values(value.anomalies).some((flag) => typeof flag !== "boolean")
    ) {
      return false;
    }
  }
  if (value.inbox_health !== undefined && value.inbox_health !== null) {
    if (!isRecord(value.inbox_health)) return false;
    if (!validOptionalCount(value.inbox_health, "score", 0, 100)) return false;
    const state = value.inbox_health.state;
    if (
      state !== undefined &&
      (typeof state !== "string" ||
        state.length > DASHBOARD_SHORT_TEXT_MAX_LENGTH ||
        !INBOX_HEALTH_STATES.has(state.trim().toLowerCase()))
    ) {
      return false;
    }
  }
  if (value.recent_audit !== undefined) {
    if (
      !Array.isArray(value.recent_audit) ||
      value.recent_audit.length > DASHBOARD_RECENT_AUDIT_MAX_ROWS ||
      value.recent_audit.some((event) => !isDashboardAuditEvent(event))
    ) {
      return false;
    }
  }
  if (value.subscribers !== undefined) {
    if (!isRecord(value.subscribers)) return false;
    if (!validOptionalCount(value.subscribers, "total")) return false;
    if (
      !validOptionalCount(
        value.subscribers,
        "delta_30d",
        -Number.MAX_SAFE_INTEGER,
      )
    ) {
      return false;
    }
  }
  if (value.open_rate !== undefined) {
    if (!isRecord(value.open_rate)) return false;
    if (!validOptionalNumber(value.open_rate, "rate", 0, 1)) return false;
    if (!validOptionalNumber(value.open_rate, "delta")) return false;
  }
  if (value.campaigns_sent !== undefined) {
    if (!isRecord(value.campaigns_sent)) return false;
    if (!validOptionalCount(value.campaigns_sent, "this_month")) return false;
    if (!validOptionalNumber(value.campaigns_sent, "delta")) return false;
  }
  if (value.active_sequences !== undefined) {
    if (!isRecord(value.active_sequences)) return false;
    if (!validOptionalCount(value.active_sequences, "count")) return false;
    if (!validOptionalNumber(value.active_sequences, "delta")) return false;
  }
  const hasFlatCore = isSafeIntegerInRange(value.subscribers_total);
  const hasLegacyCore =
    isRecord(value.subscribers) &&
    isSafeIntegerInRange(value.subscribers.total);
  return hasFlatCore || hasLegacyCore;
}

function campaignRows(data: CampaignsResponse | undefined): Campaign[] | null {
  const runtime = data as CampaignsResponse | Campaign[] | undefined;
  const rows = Array.isArray(runtime)
    ? runtime
    : isRecord(runtime)
      ? [runtime.items, runtime.results, runtime.data].find(Array.isArray)
      : undefined;
  if (!rows) return null;
  const preview = rows.slice(0, DASHBOARD_CAMPAIGN_PREVIEW_ROWS);
  const normalized: Campaign[] = [];
  for (const row of preview) {
    const campaign = normalizeCampaignRow(row);
    if (!campaign) return null;
    normalized.push(campaign);
  }
  return normalized;
}

function normalizeCampaignRow(value: unknown): Campaign | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  if (
    !(
      (typeof id === "string" &&
        id.trim().length > 0 &&
        id.length <= DASHBOARD_SHORT_TEXT_MAX_LENGTH) ||
      (typeof id === "number" && Number.isSafeInteger(id) && id >= 0)
    )
  ) {
    return null;
  }
  for (const key of ["name", "subject"] as const) {
    const field = value[key];
    if (
      field !== undefined &&
      field !== null &&
      (typeof field !== "string" || field.length > DASHBOARD_NAME_MAX_LENGTH)
    ) {
      return null;
    }
  }
  for (const key of ["status", "sent_at", "created_at"] as const) {
    const field = value[key];
    if (
      field !== undefined &&
      field !== null &&
      (typeof field !== "string" ||
        field.length > DASHBOARD_SHORT_TEXT_MAX_LENGTH)
    ) {
      return null;
    }
  }
  const hasName = [value.name, value.subject].some(
    (field) => typeof field === "string" && field.trim().length > 0,
  );
  if (!hasName) return null;
  if (
    typeof value.status === "string" &&
    !CAMPAIGN_STATUSES.has(value.status.trim().toLowerCase())
  ) {
    return null;
  }
  for (const key of ["sent_at", "created_at"] as const) {
    const field = value[key];
    if (typeof field === "string" && !Number.isFinite(Date.parse(field))) {
      return null;
    }
  }
  for (const key of ["open_rate", "click_rate"] as const) {
    const field = value[key];
    if (
      field !== undefined &&
      field !== null &&
      !isFiniteInRange(field, 0, 1)
    ) {
      return null;
    }
  }
  return {
    id: typeof id === "string" ? id.trim() : (id as number),
    ...(typeof value.name === "string" ? { name: value.name.trim() } : {}),
    ...(typeof value.subject === "string"
      ? { subject: value.subject.trim() }
      : {}),
    ...(typeof value.status === "string"
      ? { status: value.status.trim().toLowerCase() }
      : {}),
    ...(typeof value.sent_at === "string"
      ? { sent_at: value.sent_at.trim() }
      : {}),
    ...(typeof value.created_at === "string"
      ? { created_at: value.created_at.trim() }
      : {}),
    ...(typeof value.open_rate === "number"
      ? { open_rate: value.open_rate }
      : {}),
    ...(typeof value.click_rate === "number"
      ? { click_rate: value.click_rate }
      : {}),
  };
}

function statsTransportFailure(
  response: ApiResult<DashboardStatsResponse> | null,
): DashboardStatsFailure {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return offlineStatsFailure();
  }
  if (response?.error) {
    const { kind, status } = response.error;
    if (status === 401 || status === 403) {
      return {
        kind: "access",
        message: "Your current access can't read dashboard metrics.",
      };
    }
    if (status !== undefined && status >= 500) {
      return {
        kind: "service",
        message: "The metrics service couldn't complete this request.",
      };
    }
    if (kind === "network" || kind === "timeout" || kind === "invalid_config") {
      return {
        kind: "unavailable",
        message: "Dashboard metrics couldn't be reached. Try again.",
      };
    }
  }
  return {
    kind: "generic",
    message: "Dashboard metrics couldn't be verified. Try again.",
  };
}

function offlineStatsFailure(): DashboardStatsFailure {
  return {
    kind: "offline",
    message: "You're offline. Reconnect to refresh dashboard metrics.",
  };
}

function invalidStatsFailure(): DashboardStatsFailure {
  return {
    kind: "invalid",
    message:
      "Dashboard metrics couldn't be verified for this reporting window.",
  };
}

export function useDashboardData({
  hasIdentity,
  notificationScope,
  range,
  role,
  tenantId,
}: DashboardDataOptions): DashboardDataController {
  const queryClient = useQueryClient();
  const activeRef = useRef(true);
  const requestContextRef = useRef<DashboardRequestContext>({
    hasIdentity,
    range,
    tenantId,
  });
  requestContextRef.current = { hasIdentity, range, tenantId };
  const statsRequestRef = useRef(0);
  const lastStatsRangeRef = useRef(range);
  const campaignRequestRef = useRef(0);
  const refreshStatsRef = useRef<() => Promise<void>>(async () => undefined);
  const refreshCampaignsRef = useRef<() => Promise<void>>(
    async () => undefined,
  );
  const markCampaignsUnavailableRef = useRef<() => void>(() => undefined);
  const statsResolutionRef = useRef<DashboardStatsResolution | null>(null);
  const statsInFlightRef = useRef<DashboardPendingRequest | null>(null);
  const campaignsInFlightRef = useRef<DashboardPendingRequest | null>(null);
  const [statsResolution, setStatsResolution] =
    useState<DashboardStatsResolution | null>(null);
  const [campaignResolution, setCampaignResolution] =
    useState<DashboardCampaignResolution | null>(null);
  const [loading, setLoading] = useState(true);
  const [campaignsLoading, setCampaignsLoading] = useState(true);
  const [campaignsError, setCampaignsError] = useState(false);
  const [campaignsVerified, setCampaignsVerified] = useState(false);
  const [loadState, setLoadState] = useState<DashboardLoadState>("initial");
  const [lastSuccessAt, setLastSuccessAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [statsFailure, setStatsFailure] =
    useState<DashboardStatsFailure | null>(null);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      statsRequestRef.current += 1;
      campaignRequestRef.current += 1;
      statsInFlightRef.current = null;
      campaignsInFlightRef.current = null;
    };
  }, []);

  useEffect(() => {
    statsRequestRef.current += 1;
    campaignRequestRef.current += 1;
    statsInFlightRef.current = null;
    campaignsInFlightRef.current = null;
    statsResolutionRef.current = null;
    setStatsResolution(null);
    setCampaignResolution(null);
    setError(null);
    setStatsFailure(null);
    setCampaignsError(false);
    setCampaignsVerified(false);
    setLastSuccessAt(0);
    setLoadState("initial");
    setLoading(true);
    setCampaignsLoading(true);
  }, [hasIdentity, tenantId]);

  useEffect(() => {
    setCampaignsVerified(false);
  }, [hasIdentity, range, tenantId]);

  const beginStatsLoad = useCallback(
    (requestRange: DashboardRange, requestTenantId: string): void => {
      const current = statsResolutionRef.current;
      const changedRange = lastStatsRangeRef.current !== requestRange;
      lastStatsRangeRef.current = requestRange;
      if (!current || current.tenantId !== requestTenantId) {
        setLoadState("initial");
        setLastSuccessAt(0);
      } else if (current.range !== requestRange) {
        setLoadState("range");
        setLastSuccessAt(0);
      } else {
        setLoadState("refresh");
        setLastSuccessAt(current.receivedAt);
      }
      if (changedRange) {
        setError(null);
        setStatsFailure(null);
      }
    },
    [],
  );

  const finishStatsResponse = useCallback(
    (
      response: ApiResult<DashboardStatsResponse> | null,
      requestRange: DashboardRange,
      requestTenantId: string,
    ): void => {
      if (!response || response.error) {
        const failure = statsTransportFailure(response);
        setStatsFailure(failure);
        setError(failure.message);
        setLoadState("ready");
        return;
      }
      if (!isDashboardStatsPayload(response.data)) {
        const failure = invalidStatsFailure();
        setStatsFailure(failure);
        setError(failure.message);
        setLoadState("ready");
        return;
      }
      const responseRange = response.data.range;
      if (
        (requestRange !== "30d" && responseRange !== requestRange) ||
        (responseRange !== undefined && responseRange !== requestRange)
      ) {
        const failure = invalidStatsFailure();
        setStatsFailure(failure);
        setError(failure.message);
        setLoadState("ready");
        return;
      }
      const receivedAt = Date.now();
      const next: DashboardStatsResolution = {
        data: response.data,
        range: requestRange,
        receivedAt,
        tenantId: requestTenantId,
      };
      statsResolutionRef.current = next;
      setStatsResolution(next);
      setError(null);
      setStatsFailure(null);
      setLastSuccessAt(receivedAt);
      setLoadState("ready");
    },
    [],
  );

  const requestStats = useCallback(
    (foreground: boolean): Promise<void> => {
      if (!hasIdentity) return Promise.resolve();
      const requestRange = range;
      const requestTenantId = tenantId;
      const key = `${requestTenantId}:${requestRange}`;
      const pending = statsInFlightRef.current;
      if (pending?.key === key) {
        if (foreground) setLoading(true);
        return pending.promise;
      }
      const requestId = ++statsRequestRef.current;
      beginStatsLoad(requestRange, requestTenantId);
      if (foreground) setLoading(true);
      let promise!: Promise<void>;
      promise = (async (): Promise<void> => {
        let response: ApiResult<DashboardStatsResponse> | null = null;
        try {
          response = await api.getDashboardStats({
            range: requestRange,
            compare: true,
            sparklines: true,
          });
        } catch {
          // Older adapters can still throw despite the no-throw API contract.
        }
        const context = requestContextRef.current;
        if (
          !activeRef.current ||
          requestId !== statsRequestRef.current ||
          !context.hasIdentity ||
          context.tenantId !== requestTenantId ||
          context.range !== requestRange
        ) {
          return;
        }
        finishStatsResponse(response, requestRange, requestTenantId);
        setLoading(false);
      })().finally(() => {
        if (statsInFlightRef.current?.promise === promise) {
          statsInFlightRef.current = null;
        }
      });
      statsInFlightRef.current = { key, promise };
      return promise;
    },
    [beginStatsLoad, finishStatsResponse, hasIdentity, range, tenantId],
  );

  const refreshCampaigns = useCallback((): Promise<void> => {
    if (!hasIdentity) return Promise.resolve();
    const requestTenantId = tenantId;
    const pending = campaignsInFlightRef.current;
    if (pending?.key === requestTenantId) return pending.promise;
    const requestId = ++campaignRequestRef.current;
    setCampaignsLoading(true);
    let promise!: Promise<void>;
    promise = (async (): Promise<void> => {
      let response: ApiResult<CampaignsResponse> | null = null;
      try {
        response = await api.listCampaigns();
      } catch {
        // Preserve the last verified rows and expose a stable retry surface.
      }
      const context = requestContextRef.current;
      if (
        !activeRef.current ||
        requestId !== campaignRequestRef.current ||
        !context.hasIdentity ||
        context.tenantId !== requestTenantId
      ) {
        return;
      }
      const rows =
        response && !response.error ? campaignRows(response.data) : null;
      const online =
        typeof navigator === "undefined" || navigator.onLine !== false;
      if (rows === null || !online) {
        setCampaignsError(true);
        setCampaignsVerified(false);
      } else {
        setCampaignResolution({ data: rows, tenantId: requestTenantId });
        setCampaignsError(false);
        setCampaignsVerified(true);
      }
      setCampaignsLoading(false);
    })().finally(() => {
      if (campaignsInFlightRef.current?.promise === promise) {
        campaignsInFlightRef.current = null;
      }
    });
    campaignsInFlightRef.current = { key: requestTenantId, promise };
    return promise;
  }, [hasIdentity, tenantId]);
  refreshCampaignsRef.current = refreshCampaigns;
  markCampaignsUnavailableRef.current = (): void => {
    if (!requestContextRef.current.hasIdentity) return;
    campaignRequestRef.current += 1;
    campaignsInFlightRef.current = null;
    setCampaignsError(true);
    setCampaignsVerified(false);
  };

  const refreshStats = useCallback(
    (): Promise<void> => requestStats(false),
    [requestStats],
  );
  refreshStatsRef.current = refreshStats;

  const load = useCallback(async (): Promise<void> => {
    await Promise.all([requestStats(true), refreshCampaigns()]);
  }, [refreshCampaigns, requestStats]);

  useEffect(() => {
    if (!hasIdentity) return;
    void load();
  }, [hasIdentity, load]);

  useQueryInvalidationReload("dashboard", () => void load());

  const resolvedRange =
    hasIdentity && statsResolution?.tenantId === tenantId
      ? statsResolution.range
      : null;
  const stats =
    resolvedRange === range ? (statsResolution?.data ?? null) : null;
  const campaigns =
    hasIdentity && campaignResolution?.tenantId === tenantId
      ? campaignResolution.data
      : null;
  const campaignsStale = campaignsError && campaigns !== null;

  useEffect(() => {
    if (!hasIdentity || !stats) return;
    queryClient.setQueryData(qk.dashboard(tenantId, role, { range }), stats);
  }, [hasIdentity, queryClient, range, role, stats, tenantId]);

  const transport = useDashboardTransport({
    activeRef,
    hasIdentity,
    lastSuccessAt,
    range,
    refreshStatsRef,
    requestContextRef,
    setError,
    setLastSuccessAt,
    setLoading,
    setLoadState,
    setStatsFailure,
    setStatsResolution,
    statsInFlightRef,
    statsRequestRef,
    statsResolutionRef,
    tenantId,
  });
  useDashboardCampaignPolling(
    hasIdentity,
    refreshCampaignsRef,
    markCampaignsUnavailableRef,
  );
  useDashboardSignals(
    stats,
    campaigns,
    campaignsVerified,
    notificationScope,
    stats !== null && error === null,
  );

  return {
    stats,
    campaigns,
    campaignsLoading,
    campaignsError,
    campaignsStale,
    loading,
    loadState,
    resolvedRange,
    lastSuccessAt,
    error,
    statsFailure,
    liveStatus: transport.liveStatus,
    lastEventAt: transport.lastEventAt,
    now: transport.now,
    load,
    refreshCampaigns,
  };
}

interface DashboardTransportOptions {
  activeRef: MutableRefObject<boolean>;
  hasIdentity: boolean;
  lastSuccessAt: number;
  range: DashboardRange;
  refreshStatsRef: MutableRefObject<() => Promise<void>>;
  requestContextRef: MutableRefObject<DashboardRequestContext>;
  setError: Dispatch<SetStateAction<string | null>>;
  setLastSuccessAt: Dispatch<SetStateAction<number>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setLoadState: Dispatch<SetStateAction<DashboardLoadState>>;
  setStatsFailure: Dispatch<SetStateAction<DashboardStatsFailure | null>>;
  setStatsResolution: Dispatch<SetStateAction<DashboardStatsResolution | null>>;
  statsInFlightRef: MutableRefObject<DashboardPendingRequest | null>;
  statsRequestRef: MutableRefObject<number>;
  statsResolutionRef: MutableRefObject<DashboardStatsResolution | null>;
  tenantId: string;
}

function useDashboardTransport({
  activeRef,
  hasIdentity,
  lastSuccessAt,
  range,
  refreshStatsRef,
  requestContextRef,
  setError,
  setLastSuccessAt,
  setLoading,
  setLoadState,
  setStatsFailure,
  setStatsResolution,
  statsInFlightRef,
  statsRequestRef,
  statsResolutionRef,
  tenantId,
}: DashboardTransportOptions): DashboardTransportController {
  const [liveStatus, setLiveStatus] = useState<SseStatus>("closed");
  const [networkAvailable, setNetworkAvailable] = useState(
    typeof navigator === "undefined" || navigator.onLine !== false,
  );
  const [documentVisible, setDocumentVisible] = useState(
    typeof document === "undefined" || !document.hidden,
  );
  const [lastEventAt, setLastEventAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => setLastEventAt(0), [hasIdentity, range, tenantId]);
  useEffect(() => {
    const onOffline = (): void => setNetworkAvailable(false);
    const onOnline = (): void => setNetworkAvailable(true);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);
  useEffect(() => {
    const onVisibility = (): void => setDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const applyLiveSnapshot = useCallback(
    (snapshot: DashboardStatsResponse): void => {
      const context = requestContextRef.current;
      const snapshotRange = snapshot.range ?? "30d";
      if (
        !context.hasIdentity ||
        (typeof navigator !== "undefined" && navigator.onLine === false) ||
        context.range !== "30d" ||
        snapshotRange !== "30d" ||
        !isDashboardStatsPayload(snapshot)
      ) {
        return;
      }
      const current = statsResolutionRef.current;
      const data = {
        ...(current?.tenantId === context.tenantId &&
        current.range === snapshotRange
          ? current.data
          : {}),
        ...snapshot,
      };
      if (!isDashboardStatsPayload(data)) return;
      const receivedAt = Date.now();
      const next: DashboardStatsResolution = {
        data,
        range: "30d",
        receivedAt,
        tenantId: context.tenantId,
      };
      statsRequestRef.current += 1;
      statsInFlightRef.current = null;
      statsResolutionRef.current = next;
      setStatsResolution(next);
      setError(null);
      setStatsFailure(null);
      setLoadState("ready");
      setLoading(false);
      setLastEventAt(receivedAt);
      setLastSuccessAt(receivedAt);
      setNow(receivedAt);
    },
    [
      requestContextRef,
      setError,
      setLastSuccessAt,
      setLoading,
      setLoadState,
      setStatsFailure,
      setStatsResolution,
      statsInFlightRef,
      statsRequestRef,
      statsResolutionRef,
    ],
  );
  const liveEnabled =
    hasIdentity && range === "30d" && networkAvailable && documentVisible;
  useDashboardLive(
    liveEnabled,
    tenantId,
    activeRef,
    requestContextRef,
    applyLiveSnapshot,
    setLiveStatus,
  );
  const effectiveLiveStatus = liveEnabled ? liveStatus : "closed";
  const markStatsUnavailableRef = useRef<() => void>(() => undefined);
  markStatsUnavailableRef.current = (): void => {
    if (!requestContextRef.current.hasIdentity) return;
    statsRequestRef.current += 1;
    statsInFlightRef.current = null;
    const failure = offlineStatsFailure();
    setStatsFailure(failure);
    setError(failure.message);
    setLoadState("ready");
    setLoading(false);
    setLiveSubs(null);
  };
  useDashboardPolling(
    hasIdentity,
    effectiveLiveStatus,
    refreshStatsRef,
    markStatsUnavailableRef,
  );
  useEffect(() => {
    if (!hasIdentity || lastSuccessAt === 0) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), STALE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [hasIdentity, lastSuccessAt]);

  return { liveStatus: effectiveLiveStatus, lastEventAt, now };
}

function useDashboardLive(
  enabled: boolean,
  tenantId: string,
  activeRef: MutableRefObject<boolean>,
  requestContextRef: MutableRefObject<DashboardRequestContext>,
  onSnapshot: (snapshot: DashboardStatsResponse) => void,
  setLiveStatus: Dispatch<SetStateAction<SseStatus>>,
): void {
  useEffect(() => {
    if (!enabled) {
      setLiveStatus("closed");
      return undefined;
    }
    let connected = true;
    const isCurrentContext = (): boolean => {
      const context = requestContextRef.current;
      return (
        connected &&
        activeRef.current &&
        context.hasIdentity &&
        context.tenantId === tenantId &&
        context.range === "30d"
      );
    };
    const disconnect = connectDashboardLive(
      (snapshot) => {
        if (!isCurrentContext()) return;
        onSnapshot(snapshot);
      },
      undefined,
      (status) => {
        if (isCurrentContext()) setLiveStatus(status);
      },
    );
    return () => {
      connected = false;
      disconnect();
    };
  }, [
    activeRef,
    enabled,
    onSnapshot,
    requestContextRef,
    setLiveStatus,
    tenantId,
  ]);
}

function useDashboardSignals(
  stats: DashboardStatsResponse | null,
  campaigns: Campaign[] | null,
  campaignsVerified: boolean,
  notificationScope: string | null,
  statsAvailable: boolean,
): void {
  const subscriberTotal = stats?.subscribers_total;
  const subscribers =
    typeof subscriberTotal === "number" &&
    Number.isFinite(subscriberTotal) &&
    subscriberTotal >= 0
      ? subscriberTotal
      : 0;
  useEffect(() => {
    if (!statsAvailable || subscribers <= 0) return;
    void notifyMilestoneCrossings(subscribers, notificationScope).catch(
      () => undefined,
    );
  }, [notificationScope, statsAvailable, subscribers]);

  const bounceAnomalyActive = stats?.anomalies?.bounces === true;
  useEffect(() => {
    if (!statsAvailable || !bounceAnomalyActive) return undefined;
    let active = true;
    void (async (): Promise<void> => {
      try {
        const response = await api.listDashboardAnomalies({ limit: 5 });
        if (active && response.data?.items) {
          await notifyNewAnomalies(response.data.items);
        }
      } catch {
        // Notification enrichment must never affect dashboard availability.
      }
    })();
    return () => {
      active = false;
    };
  }, [bounceAnomalyActive, statsAvailable]);

  useEffect(() => {
    if (!stats || !statsAvailable) {
      setLiveSubs(null);
      return;
    }
    const rawAdded = stats.subscribers_added_30d;
    const added =
      typeof rawAdded === "number" && Number.isFinite(rawAdded) && rawAdded >= 0
        ? rawAdded
        : 0;
    setLiveSubs({
      total: subscribers,
      added,
      at: Date.now(),
    });
  }, [stats, statsAvailable, subscribers]);
  useEffect(() => () => setLiveSubs(null), []);

  useEffect(() => {
    if (!campaignsVerified) {
      setActiveSend(null);
      return;
    }
    const sending = campaigns?.find(
      (campaign) => String(campaign.status ?? "").toLowerCase() === "sending",
    );
    setActiveSend(
      sending
        ? {
            campaignId: String(sending.id ?? ""),
            name: String(sending.name ?? sending.subject ?? "Untitled"),
            openRate: sending.open_rate ?? null,
            clickRate: sending.click_rate ?? null,
          }
        : null,
    );
  }, [campaigns, campaignsVerified]);
  useEffect(() => () => setActiveSend(null), []);
}

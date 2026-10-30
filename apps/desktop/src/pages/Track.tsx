/**
 * Track / Product Events — operator view of incoming product events.
 *
 * Refined Product Events PR 1: substantial rewrite around four
 * additions to PR 0:
 *
 *   1. EventInsightsRow at the top — total events / unique subs /
 *      distinct event names + daily sparkline. Driven by /track/stats.
 *   2. EventCatalog below the insights — one row per distinct
 *      event_name with volume, subscribers, first/last seen and a
 *      7-day inline sparkline. Click a row to filter the events
 *      list below to that event_name. Driven by /track/catalog.
 *   3. Server-side event_name filter on the events list (the API
 *      param landed in this PR; the prior page only filtered
 *      client-side).
 *   4. SSE live tail toggle (matches the audit live-tail pattern):
 *      opens an EventSource against /track/stream, prepends new
 *      events to the list as they arrive.
 *   5. CSV export button.
 *   6. In-app EventComposer — fire a synthetic event from the page to
 *      validate automations end-to-end.
 *
 * Subscriber narrowing still works (id or email picker). One UTC
 * calendar-window contract now drives the client-side feed, CSV lower
 * bound, catalog, and insights so their period labels do not imply
 * incompatible rolling-hour semantics.
 *
 * Full-surface wiring (#32): a "Conversions" section at the bottom —
 * the conversion feed (bare-array wire, ?before= cursor paging),
 * tracking-key management (create shows the plaintext exactly ONCE),
 * and a curl snippet for the public ingest endpoint.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { toast } from "../components/Toast";
import { HeroEmptyState } from "../components/HeroEmptyState";
import { InlineHelp } from "../components/InlineHelp";
import { HERO } from "../lib/heroAssets";
import { EventCatalog } from "../components/track/EventCatalog";
import { EventComposer } from "../components/track/EventComposer";
import { EventInsightsRow } from "../components/track/EventInsightsRow";
import { ConversionsSection } from "../components/track/ConversionsSection";
import {
  boundedJsonPreview,
  isProductEvent,
  parseProductEventCatalog,
  parseProductEventStats,
  parseProductEvents,
  parseSubscriberChoices,
  safeAbsoluteTime,
  safeRemoteFailureText,
  safeTrackFailure,
} from "../components/track/track-maturity";
import { TrackEventSlideover } from "../components/TrackEventSlideover";
import { DataTable, type DataTableColumn } from "../components/table/DataTable";
import { useRemoteResource } from "../hooks/useRemoteResource";
import {
  type ProductEvent,
  type ProductEventCatalogRow,
  type ProductEventCatalogResponse,
  type ProductEventStatsResponse,
  type Subscriber,
  api,
} from "../lib/api-client";
import { downloadUrlToFile } from "../lib/file-transfer";
import { isRemotePermissionError } from "../lib/remote-resource";
import { useCanAdmin, useCanWrite } from "../lib/store";
import "../styles-track.css";

type RangeFilter = "24h" | "7d" | "30d" | "90d";

const RANGE_DAYS: Record<RangeFilter, number> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

const RANGE_LABELS: Record<RangeFilter, string> = {
  "24h": "Today (UTC)",
  "7d": "Last 7 UTC days",
  "30d": "Last 30 UTC days",
  "90d": "Last 90 UTC days",
};

function utcDailyWindowStart(now: number, range: RangeFilter): number {
  const asOf = new Date(now);
  return Date.UTC(
    asOf.getUTCFullYear(),
    asOf.getUTCMonth(),
    asOf.getUTCDate() - (RANGE_DAYS[range] - 1),
  );
}

function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const refreshClock = (): void => setNow(Date.now());
    const timer = window.setInterval(refreshClock, 60_000);
    window.addEventListener("focus", refreshClock);
    document.addEventListener("visibilitychange", refreshClock);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshClock);
      document.removeEventListener("visibilitychange", refreshClock);
    };
  }, []);
  return now;
}

function productEventTimestamp(event: ProductEvent): number {
  return Date.parse(
    event.occurredAt ??
      event.occurred_at ??
      event.receivedAt ??
      event.received_at ??
      "",
  );
}

function useRangeFilteredEvents(
  rows: ProductEvent[] | null,
  range: RangeFilter,
  now: number,
): { filtered: ProductEvent[]; invalidTimestampCount: number } {
  return useMemo(() => {
    if (!rows) return { filtered: [], invalidTimestampCount: 0 };
    const cutoff = utcDailyWindowStart(now, range);
    let invalidTimestampCount = 0;
    const filtered = rows.filter((event) => {
      const timestamp = productEventTimestamp(event);
      if (Number.isNaN(timestamp)) {
        invalidTimestampCount += 1;
        return true;
      }
      return timestamp >= cutoff && timestamp <= now;
    });
    return { filtered, invalidTimestampCount };
  }, [now, range, rows]);
}

function EventTime({
  value,
}: {
  value: string | null | undefined;
}): ReactElement {
  if (!value) return <span className="muted">Not recorded</span>;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return <span className="muted">Invalid timestamp</span>;
  }
  return (
    <time dateTime={value} className="tabular">
      {safeAbsoluteTime(value)}
    </time>
  );
}

function formatEventProperties(props: ProductEvent["properties"]): string {
  if (!props || typeof props !== "object") return "—";
  const keys = Object.keys(props);
  if (keys.length === 0) return "—";
  return boundedJsonPreview(props, 1_200);
}

function useProductEventCatalog(range: RangeFilter): {
  catalog: ProductEventCatalogRow[] | null;
  totalDistinctEventNames: number | null;
  asOf: string | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
  reload: () => Promise<boolean>;
} {
  const resource = useRemoteResource<ProductEventCatalogResponse>(
    async () => {
      const response = await api.getProductEventCatalog({
        days: RANGE_DAYS[range],
      });
      if (response.error) return { error: response.error };
      const parsed = parseProductEventCatalog(response.data);
      if (!parsed || parsed.periodDays !== RANGE_DAYS[range]) {
        return {
          error: {
            message: "Invalid event catalog response",
            kind: "parse",
          },
        };
      }
      return { data: parsed };
    },
    { identity: `product-event-catalog:${range}` },
  );
  return {
    catalog: resource.data?.items ?? null,
    totalDistinctEventNames: resource.data?.totalDistinctEventNames ?? null,
    asOf: resource.data?.asOf ?? null,
    loading: resource.transport === "loading",
    error: resource.failure ? safeRemoteFailureText(resource.failure) : null,
    stale: resource.stale,
    reload: async () => {
      const outcome = await resource.reloadResult();
      return Boolean(outcome && !("error" in outcome));
    },
  };
}

function useProductEventStats(
  range: RangeFilter,
  eventName: string,
): {
  stats: ProductEventStatsResponse | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
  reload: () => Promise<boolean>;
} {
  const resource = useRemoteResource<ProductEventStatsResponse>(
    async () => {
      const response = await api.getProductEventStats({
        days: RANGE_DAYS[range],
        ...(eventName ? { eventName } : {}),
      });
      if (response.error) return { error: response.error };
      const parsed = parseProductEventStats(response.data);
      if (!parsed || parsed.periodDays !== RANGE_DAYS[range]) {
        return {
          error: {
            message: "Invalid event statistics response",
            kind: "parse",
          },
        };
      }
      return { data: parsed };
    },
    { identity: `product-event-stats:${range}:${eventName}` },
  );
  return {
    stats: resource.data,
    loading: resource.transport === "loading",
    error: resource.failure ? safeRemoteFailureText(resource.failure) : null,
    stale: resource.stale,
    reload: async () => {
      const outcome = await resource.reloadResult();
      return Boolean(outcome && !("error" in outcome));
    },
  };
}

interface SubscriberResolution {
  id: string | null;
  label: string | null;
  error: string | null;
}

/** Resolve a subscriber id from "uuid-or-email" input. */
async function resolveSubscriberId(
  input: string,
): Promise<SubscriberResolution> {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      id: null,
      label: null,
      error: "Enter a subscriber ID or email address.",
    };
  }
  if (trimmed.length > 512 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return {
      id: null,
      label: null,
      error:
        "Enter an ID or email without control characters (512 characters maximum).",
    };
  }
  if (trimmed.includes("@")) {
    if (trimmed.length > 320) {
      return {
        id: null,
        label: null,
        error: "Email addresses must be 320 characters or fewer.",
      };
    }
    const res = await api.listSubscribers({ query: trimmed, perPage: 5 });
    if (res.error) {
      return {
        id: null,
        label: null,
        error: safeTrackFailure(
          res.error,
          "Moosewave couldn't resolve that subscriber right now.",
        ),
      };
    }
    const list = parseSubscriberChoices(res.data);
    if (!list) {
      return {
        id: null,
        label: null,
        error:
          "Moosewave couldn't verify the subscriber lookup response. Retry before changing the filter.",
      };
    }
    const match = list.find(
      (subscriber) => subscriber.email.toLowerCase() === trimmed.toLowerCase(),
    );
    if (!match || match.id === undefined) {
      return {
        id: null,
        label: null,
        error:
          "No subscriber matched that email address. Check the spelling or enter a subscriber ID.",
      };
    }
    return { id: String(match.id), label: match.email, error: null };
  }
  return { id: trimmed, label: trimmed, error: null };
}

interface ProductEventResult {
  scope: string;
  rows: ProductEvent[] | null;
  error: string | null;
  accessDenied: boolean;
}

interface ScopedOperationStatus {
  scope: string;
  message: string;
  failed: boolean;
}

function productEventScope(
  subscriberId: string | null,
  eventName: string,
): string {
  return `${subscriberId ?? "workspace"}:${eventName || "all-events"}`;
}

function productEventIdentity(event: ProductEvent): string {
  const explicitId = event.id;
  if (explicitId !== undefined && explicitId !== null)
    return String(explicitId);
  return [
    event.eventName ?? event.event_name ?? "unknown-event",
    event.subscriberId ??
      event.subscriber_id ??
      event.subscriber_email ??
      "unknown-subscriber",
    event.occurredAt ??
      event.occurred_at ??
      event.receivedAt ??
      event.received_at ??
      "unknown-time",
  ].join(":");
}

function useProductEventFeed(
  subscriberId: string | null,
  eventName: string,
): {
  rows: ProductEvent[] | null;
  loading: boolean;
  error: string | null;
  accessDenied: boolean;
  reload: () => Promise<boolean>;
  prependLiveEvent: (event: ProductEvent) => boolean;
} {
  const scope = productEventScope(subscriberId, eventName);
  const [result, setResult] = useState<ProductEventResult | null>(null);
  const [loadingScope, setLoadingScope] = useState<string | null>(scope);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const flightRef = useRef<{
    scope: string;
    promise: Promise<boolean>;
  } | null>(null);
  const seenEventIdsByScopeRef = useRef<Map<string, Set<string>>>(new Map());
  const pendingLiveEventsRef = useRef<Map<string, ProductEvent[]>>(new Map());
  const accessDeniedScopesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      flightRef.current = null;
      pendingLiveEventsRef.current.clear();
      seenEventIdsByScopeRef.current.clear();
      accessDeniedScopesRef.current.clear();
    };
  }, []);

  const load = useCallback(
    (id: string | null, name: string): Promise<boolean> => {
      const requestedScope = productEventScope(id, name);
      const existing = flightRef.current;
      if (existing?.scope === requestedScope) return existing.promise;
      const generation = ++generationRef.current;
      for (const pendingScope of pendingLiveEventsRef.current.keys()) {
        if (pendingScope !== requestedScope) {
          pendingLiveEventsRef.current.delete(pendingScope);
        }
      }
      for (const seenScope of seenEventIdsByScopeRef.current.keys()) {
        if (seenScope !== requestedScope) {
          seenEventIdsByScopeRef.current.delete(seenScope);
        }
      }
      for (const deniedScope of accessDeniedScopesRef.current) {
        if (deniedScope !== requestedScope) {
          accessDeniedScopesRef.current.delete(deniedScope);
        }
      }
      setLoadingScope(requestedScope);
      setResult((previous) =>
        previous?.scope === requestedScope
          ? { ...previous, error: null }
          : previous,
      );
      const request = (async (): Promise<boolean> => {
        try {
          const response = await api.listProductEvents({
            ...(id ? { subscriberId: id } : {}),
            ...(name ? { eventName: name } : {}),
            limit: 200,
          });
          if (!mountedRef.current || generation !== generationRef.current) {
            return false;
          }
          if (response.error) {
            const accessRevoked = isRemotePermissionError(response.error);
            if (accessRevoked) {
              accessDeniedScopesRef.current.add(requestedScope);
              pendingLiveEventsRef.current.delete(requestedScope);
              seenEventIdsByScopeRef.current.delete(requestedScope);
            }
            const accessDenied =
              accessRevoked ||
              accessDeniedScopesRef.current.has(requestedScope);
            const error = safeTrackFailure(
              response.error,
              "Moosewave couldn't load product events.",
            );
            setResult((previous) => ({
              scope: requestedScope,
              rows: accessDenied
                ? null
                : previous?.scope === requestedScope
                  ? previous.rows
                  : null,
              error,
              accessDenied,
            }));
            return false;
          }
          const nextRows = parseProductEvents(response.data);
          if (!nextRows) {
            setResult((previous) => ({
              scope: requestedScope,
              rows: previous?.scope === requestedScope ? previous.rows : null,
              error:
                "Moosewave couldn't verify the product-event response. Retry before relying on this feed.",
              accessDenied: accessDeniedScopesRef.current.has(requestedScope),
            }));
            return false;
          }
          const pendingLiveRows =
            pendingLiveEventsRef.current.get(requestedScope) ?? [];
          pendingLiveEventsRef.current.delete(requestedScope);
          const mergedRows: ProductEvent[] = [];
          const mergedIds = new Set<string>();
          for (const row of [...pendingLiveRows, ...nextRows]) {
            const identity = productEventIdentity(row);
            if (mergedIds.has(identity)) continue;
            mergedIds.add(identity);
            mergedRows.push(row);
            if (mergedRows.length === 200) break;
          }
          seenEventIdsByScopeRef.current.set(requestedScope, mergedIds);
          accessDeniedScopesRef.current.delete(requestedScope);
          setResult({
            scope: requestedScope,
            rows: mergedRows,
            error: null,
            accessDenied: false,
          });
          return true;
        } catch {
          if (!mountedRef.current || generation !== generationRef.current) {
            return false;
          }
          setResult((previous) => ({
            scope: requestedScope,
            rows: accessDeniedScopesRef.current.has(requestedScope)
              ? null
              : previous?.scope === requestedScope
                ? previous.rows
                : null,
            error:
              "Moosewave couldn't load product events. Check the connection and retry.",
            accessDenied: accessDeniedScopesRef.current.has(requestedScope),
          }));
          return false;
        } finally {
          if (mountedRef.current && generation === generationRef.current) {
            setLoadingScope(null);
          }
        }
      })();
      flightRef.current = { scope: requestedScope, promise: request };
      void request.finally(() => {
        if (flightRef.current?.promise === request) flightRef.current = null;
      });
      return request;
    },
    [],
  );

  useEffect(() => {
    void load(subscriberId, eventName);
  }, [eventName, load, subscriberId]);

  const reload = useCallback(
    () => load(subscriberId, eventName),
    [eventName, load, subscriberId],
  );

  const prependLiveEvent = useCallback(
    (event: ProductEvent): boolean => {
      const identity = productEventIdentity(event);
      if (accessDeniedScopesRef.current.has(scope)) return false;
      const seen =
        seenEventIdsByScopeRef.current.get(scope) ?? new Set<string>();
      if (seen.has(identity)) return false;
      // The visible feed is capped at 200, so its dedupe index must obey the
      // same bound during a long-running live session.
      seenEventIdsByScopeRef.current.set(
        scope,
        new Set([identity, ...seen].slice(0, 200)),
      );
      const pending = pendingLiveEventsRef.current.get(scope) ?? [];
      pendingLiveEventsRef.current.set(
        scope,
        [event, ...pending].slice(0, 200),
      );
      setResult((previous) => {
        if (previous?.scope !== scope) {
          return { scope, rows: [event], error: null, accessDenied: false };
        }
        return {
          ...previous,
          rows: [event, ...(previous.rows ?? [])].slice(0, 200),
        };
      });
      return true;
    },
    [scope],
  );

  const current = result?.scope === scope ? result : null;
  return {
    rows: current?.rows ?? null,
    loading: current === null || loadingScope === scope,
    error: current?.error ?? null,
    accessDenied: current?.accessDenied ?? false,
    reload,
    prependLiveEvent,
  };
}

function useSubscriberPicker(): {
  input: string;
  setInput: (value: string) => void;
  subscriberId: string | null;
  subscriberLabel: string | null;
  recent: Subscriber[];
  recentError: string | null;
  resolving: boolean;
  resolveError: string | null;
  submit: () => Promise<boolean>;
  pickRecent: (subscriber: Subscriber) => void;
  clear: () => void;
} {
  const [input, setInputState] = useState("");
  const [subscriberId, setSubscriberId] = useState<string | null>(null);
  const [subscriberLabel, setSubscriberLabel] = useState<string | null>(null);
  const [recent, setRecent] = useState<Subscriber[]>([]);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const resolveGenerationRef = useRef(0);
  const resolveFlightRef = useRef<{
    input: string;
    promise: Promise<boolean>;
  } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      try {
        const response = await api.listSubscribers({ perPage: 8 });
        if (!mountedRef.current) return;
        if (response.error) {
          setRecentError(
            safeTrackFailure(
              response.error,
              "Recent subscribers couldn't be loaded.",
            ),
          );
          return;
        }
        const parsed = parseSubscriberChoices(response.data);
        if (!parsed) {
          setRecentError(
            "Recent subscribers couldn't be verified. You can still enter an ID or email.",
          );
          return;
        }
        setRecent(
          parsed
            .filter((subscriber) => subscriber.id !== undefined)
            .slice(0, 8),
        );
        setRecentError(null);
      } catch {
        if (mountedRef.current) {
          setRecentError(
            "Recent subscribers couldn't be loaded. You can still enter an ID or email.",
          );
        }
      }
    })();
    return () => {
      mountedRef.current = false;
      resolveGenerationRef.current += 1;
      resolveFlightRef.current = null;
    };
  }, []);

  const setInput = useCallback((value: string): void => {
    resolveGenerationRef.current += 1;
    resolveFlightRef.current = null;
    setResolving(false);
    setInputState(value);
    setResolveError(null);
  }, []);

  const submit = useCallback((): Promise<boolean> => {
    const normalizedInput = input.trim();
    const existing = resolveFlightRef.current;
    if (existing?.input === normalizedInput) return existing.promise;
    const generation = ++resolveGenerationRef.current;
    setResolving(true);
    setResolveError(null);
    const request = (async (): Promise<boolean> => {
      try {
        const resolution = await resolveSubscriberId(normalizedInput);
        if (
          !mountedRef.current ||
          generation !== resolveGenerationRef.current
        ) {
          return false;
        }
        if (!resolution.id) {
          setResolveError(
            resolution.error ?? "No matching subscriber was found.",
          );
          return false;
        }
        setSubscriberId(resolution.id);
        setSubscriberLabel(resolution.label ?? resolution.id);
        return true;
      } catch {
        if (mountedRef.current && generation === resolveGenerationRef.current) {
          setResolveError(
            "Moosewave couldn't resolve that subscriber. Check the connection and retry.",
          );
        }
        return false;
      } finally {
        if (mountedRef.current && generation === resolveGenerationRef.current) {
          setResolving(false);
        }
      }
    })();
    resolveFlightRef.current = { input: normalizedInput, promise: request };
    void request.finally(() => {
      if (resolveFlightRef.current?.promise === request) {
        resolveFlightRef.current = null;
      }
    });
    return request;
  }, [input]);

  const pickRecent = useCallback((subscriber: Subscriber): void => {
    if (subscriber.id === undefined) return;
    resolveGenerationRef.current += 1;
    resolveFlightRef.current = null;
    setResolving(false);
    setInputState(subscriber.email);
    setResolveError(null);
    setSubscriberId(String(subscriber.id));
    setSubscriberLabel(subscriber.email);
  }, []);

  const clear = useCallback((): void => {
    resolveGenerationRef.current += 1;
    resolveFlightRef.current = null;
    setResolving(false);
    setResolveError(null);
    setSubscriberId(null);
    setSubscriberLabel(null);
    setInputState("");
  }, []);

  return {
    input,
    setInput,
    subscriberId,
    subscriberLabel,
    recent,
    recentError,
    resolving,
    resolveError,
    submit,
    pickRecent,
    clear,
  };
}

type LiveTailStatus =
  | "off"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "paused"
  | "blocked";

function verifiedEventStreamUrl(value: string): string | null {
  try {
    const parsed = new URL(value, window.location.href);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function useProductEventLiveTail({
  eventName,
  subscriberId,
  blocked,
  resetKey,
  onEvent,
}: {
  eventName: string;
  subscriberId: string | null;
  blocked: boolean;
  resetKey: string;
  onEvent: (event: ProductEvent) => boolean;
}): {
  active: boolean;
  count: number;
  status: LiveTailStatus;
  statusMessage: string;
  blocked: boolean;
  toggle: () => void;
} {
  const [active, setActive] = useState(false);
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState<LiveTailStatus>("off");
  const [statusMessage, setStatusMessage] = useState(
    "Live tail is off. Start it to stream new events without polling.",
  );

  const toggle = useCallback((): void => {
    if (blocked) return;
    setActive((current) => {
      const next = !current;
      if (next) {
        setStatus("connecting");
        setStatusMessage("Connecting to the live product-event stream…");
      } else {
        setStatus("paused");
        setStatusMessage(
          "Live tail is paused. Events already loaded remain visible.",
        );
      }
      return next;
    });
  }, [blocked]);

  useEffect(() => {
    if (blocked) {
      setActive(false);
      setStatus("blocked");
      setStatusMessage(
        "Live tail is unavailable because the current session cannot read the product-event feed.",
      );
      return;
    }
    setStatus((current) => (current === "blocked" ? "off" : current));
    setStatusMessage((current) =>
      current.startsWith("Live tail is unavailable")
        ? "Live tail is off. Start it to stream new events without polling."
        : current,
    );
  }, [blocked]);

  useEffect(() => {
    if (!active) return;
    setCount(0);
  }, [active, resetKey]);

  useEffect(() => {
    if (!active) return;
    let source: EventSource | null = null;
    let stopped = false;
    let retryTimer: number | null = null;
    let backoffMs = 1_000;
    let reconnectAttempt = 0;
    const maxBackoffMs = 30_000;

    const cleanupSource = (): void => {
      if (!source) return;
      source.onopen = null;
      source.onerror = null;
      if (typeof source.removeEventListener === "function") {
        source.removeEventListener("track", handleTrackEvent);
      }
      try {
        source.close();
      } catch {
        // The source is already closed; no operator action is required.
      }
      source = null;
    };

    const scheduleReconnect = (reason = "Live stream disconnected."): void => {
      if (stopped || retryTimer !== null) return;
      const wait = Math.min(
        maxBackoffMs,
        Math.round(backoffMs * (0.8 + Math.random() * 0.4)),
      );
      reconnectAttempt += 1;
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      setStatus("reconnecting");
      setStatusMessage(
        `${reason} Reconnect attempt ${reconnectAttempt.toLocaleString()} starts in ${Math.ceil(wait / 1_000).toLocaleString()} seconds.`,
      );
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void openSource();
      }, wait);
    };

    const handleTrackEvent = (event: MessageEvent): void => {
      if (stopped) return;
      try {
        const row: unknown = JSON.parse(event.data);
        if (!isProductEvent(row)) return;
        if (
          subscriberId &&
          String(row.subscriberId ?? row.subscriber_id) !== subscriberId
        ) {
          return;
        }
        if (
          eventName &&
          String(row.eventName ?? row.event_name) !== eventName
        ) {
          return;
        }
        if (onEvent(row)) setCount((current) => current + 1);
      } catch {
        // Malformed frames are ignored; the connection remains usable.
      }
    };

    const openSource = async (): Promise<void> => {
      if (stopped) return;
      setStatus((current) =>
        current === "reconnecting" ? current : "connecting",
      );
      let candidateUrl: string;
      try {
        candidateUrl = await api.productEventStreamUrlAuthed(
          eventName || undefined,
        );
      } catch {
        scheduleReconnect(
          "Moosewave couldn't obtain an authorized live-stream address.",
        );
        return;
      }
      if (stopped) return;
      const url = verifiedEventStreamUrl(candidateUrl);
      if (!url) {
        scheduleReconnect(
          "The service returned an invalid live-stream address; Moosewave did not open it.",
        );
        return;
      }
      try {
        source = new EventSource(url, { withCredentials: true });
      } catch {
        scheduleReconnect("Moosewave couldn't open the live-stream address.");
        return;
      }
      source.onopen = (): void => {
        if (stopped) return;
        backoffMs = 1_000;
        reconnectAttempt = 0;
        setStatus("connected");
        setStatusMessage(
          eventName
            ? `Live tail connected and filtering to ${eventName}.`
            : "Live tail connected to all product events.",
        );
      };
      source.addEventListener("track", handleTrackEvent);
      source.onerror = (): void => {
        if (stopped) return;
        cleanupSource();
        scheduleReconnect();
      };
    };

    setStatus("connecting");
    setStatusMessage("Connecting to the live product-event stream…");
    void openSource();
    return () => {
      stopped = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      cleanupSource();
    };
  }, [active, eventName, onEvent, subscriberId]);

  return { active, count, status, statusMessage, blocked, toggle };
}

function ProductEventsTable({
  rows,
  filteredRows,
  invalidTimestampCount,
  loading,
  error,
  eventName,
  range,
  subscriberId,
  subscriberLabel,
  onEventNameChange,
  onOpen,
  onClearScope,
  onWidenPeriod,
}: {
  rows: ProductEvent[] | null;
  filteredRows: ProductEvent[];
  invalidTimestampCount: number;
  loading: boolean;
  error: string | null;
  eventName: string;
  range: RangeFilter;
  subscriberId: string | null;
  subscriberLabel: string | null;
  onEventNameChange: (name: string) => void;
  onOpen: (event: ProductEvent) => void;
  onClearScope: () => void;
  onWidenPeriod: () => void;
}): ReactElement {
  const columns: readonly DataTableColumn<ProductEvent>[] = [
    {
      id: "time",
      header: "Occurred",
      width: "170px",
      cell: (event) => (
        <EventTime
          value={
            event.occurredAt ??
            event.occurred_at ??
            event.receivedAt ??
            event.received_at
          }
        />
      ),
    },
    {
      id: "subscriber",
      header: "Subscriber",
      width: "210px",
      cell: (event) => (
        <span
          className="mono"
          style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}
        >
          {String(
            event.subscriber_email ??
              event.subscriberId ??
              event.subscriber_id ??
              "Not recorded",
          )}
        </span>
      ),
    },
    {
      id: "event",
      header: "Event",
      width: "190px",
      cell: (event) => {
        const name = event.eventName || event.event_name || "Unnamed event";
        const selected = eventName === name;
        return (
          <button
            type="button"
            className="btn btn-sm btn-ghost track-event-filter"
            aria-pressed={selected}
            onClick={() => onEventNameChange(selected ? "" : name)}
          >
            {selected ? `Clear ${name} filter` : `Filter to ${name}`}
          </button>
        );
      },
    },
    {
      id: "properties",
      header: "Properties",
      width: "min(360px, 34vw)",
      cell: (event) => (
        <code
          className="mono"
          style={{
            display: "block",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            fontSize: 11,
          }}
        >
          {formatEventProperties(event.properties)}
        </code>
      ),
    },
    {
      id: "actions",
      header: <span className="visually-hidden">Event actions</span>,
      width: "90px",
      align: "end",
      cell: (event) => {
        const name = event.eventName || event.event_name || "unnamed event";
        return (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onOpen(event)}
            aria-label={`Open ${name} event details`}
          >
            Open
          </button>
        );
      },
    },
  ];
  const hasServerScope = Boolean(eventName || subscriberId);
  const emptyState =
    rows === null && error ? (
      <div>
        <strong>Product events are unavailable.</strong>
        <div className="muted" style={{ marginTop: 4 }}>
          {error}
        </div>
      </div>
    ) : rows?.length === 0 && hasServerScope ? (
      <div>
        <strong>No events were found for this investigation scope.</strong>
        <div className="muted" style={{ margin: "4px 0 8px" }}>
          {subscriberId
            ? `No loaded events belong to ${subscriberLabel ?? subscriberId}${eventName ? ` with event name ${eventName}` : ""}.`
            : `No loaded events use the event name ${eventName}.`}
        </div>
        <button type="button" className="btn btn-sm" onClick={onClearScope}>
          Clear investigation scope
        </button>
      </div>
    ) : rows !== null && rows.length > 0 && filteredRows.length === 0 ? (
      <div>
        <strong>No loaded events occurred during {RANGE_LABELS[range]}.</strong>
        <div className="muted" style={{ margin: "4px 0 8px" }}>
          The server returned events for this scope, but none fall inside the
          selected reporting period.
        </div>
        <button type="button" className="btn btn-sm" onClick={onWidenPeriod}>
          Show the widest period
        </button>
      </div>
    ) : (
      <HeroEmptyState
        tone="blush"
        eyebrow="Real-time"
        title="Watch your product breathe in real time."
        subtitle="POST events from your app, see them stream in, and fire sequences when they happen."
        meta={
          <span>
            POST <span className="mono">/api/v1/track</span> to send your first
            event.
          </span>
        }
        imageSrc={HERO.track}
        imageAlt="A phone showing real-time event notifications"
      />
    );

  return (
    <>
      {error ? (
        <div className="notice" role="alert" style={{ marginBottom: 8 }}>
          Product event feed: {error}
        </div>
      ) : null}
      <DataTable
        caption="Product event feed"
        description={
          loading && rows
            ? "Refreshing · showing the last verified event feed"
            : error && rows
              ? "Refresh failed · showing the last verified event feed"
              : `${filteredRows.length.toLocaleString()} loaded event${filteredRows.length === 1 ? "" : "s"}${rows && rows.length >= 200 ? " · latest 200 server cap" : ""}${invalidTimestampCount > 0 ? ` · ${invalidTimestampCount.toLocaleString()} with invalid timestamps retained for review` : ""}`
        }
        columns={columns}
        rows={filteredRows}
        getRowKey={productEventIdentity}
        loading={loading && rows === null}
        loadingLabel="Loading product events…"
        emptyState={emptyState}
        density="compact"
      />
    </>
  );
}

function trackFeedSummary({
  rows,
  filteredCount,
  eventName,
  subscriberId,
  subscriberLabel,
  totalEvents,
  totalEventsStale,
  range,
}: {
  rows: ProductEvent[] | null;
  filteredCount: number;
  eventName: string;
  subscriberId: string | null;
  subscriberLabel: string | null;
  totalEvents: number | undefined;
  totalEventsStale: boolean;
  range: RangeFilter;
}): string {
  if (!rows) return "Loading recent events…";
  const atCap = rows.length >= 200;
  const eventSuffix = eventName ? ` · filtered to ${eventName}` : "";
  if (subscriberId) {
    return `${filteredCount.toLocaleString()} event${filteredCount === 1 ? "" : "s"} for ${subscriberLabel ?? subscriberId} during ${RANGE_LABELS[range]}${atCap ? " (latest 200)" : ""}${eventSuffix}`;
  }
  if (typeof totalEvents === "number") {
    return `${totalEventsStale ? "Last verified: " : ""}${totalEvents.toLocaleString()} event${totalEvents === 1 ? "" : "s"} across this workspace during ${RANGE_LABELS[range]}${eventSuffix}`;
  }
  return `${filteredCount.toLocaleString()} event${filteredCount === 1 ? "" : "s"} across this workspace during ${RANGE_LABELS[range]}${atCap ? " (latest 200 loaded)" : ""}${eventSuffix}`;
}

function TrackPageHeader({
  rows,
  filteredCount,
  eventName,
  subscriberId,
  subscriberLabel,
  totalEvents,
  totalEventsStale,
  range,
  liveTail,
  exporting,
  exportStatus,
  exportError,
  onComposerSent,
  onExport,
  canAdmin,
}: {
  rows: ProductEvent[] | null;
  filteredCount: number;
  eventName: string;
  subscriberId: string | null;
  subscriberLabel: string | null;
  totalEvents: number | undefined;
  totalEventsStale: boolean;
  range: RangeFilter;
  liveTail: ReturnType<typeof useProductEventLiveTail>;
  exporting: boolean;
  exportStatus: string | null;
  exportError: string | null;
  onComposerSent: () => void;
  onExport: () => void;
  canAdmin: boolean;
}): ReactElement {
  const liveStatusId = useId();
  const exportStatusId = useId();
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Product events</h1>
          <div className="page-subtitle">
            {trackFeedSummary({
              rows,
              filteredCount,
              eventName,
              subscriberId,
              subscriberLabel,
              totalEvents,
              totalEventsStale,
              range,
            })}
            {eventName ? (
              <InlineHelp
                text={`Server-side filter — only events named "${eventName}" are returned by the API and, when active, by the live tail.`}
              />
            ) : null}
          </div>
        </div>
        <div
          className="row track-action-cluster"
          style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}
        >
          {liveTail.active && liveTail.count > 0 ? (
            <span className="track-live-pill">
              {liveTail.count.toLocaleString()} new live{" "}
              {liveTail.count === 1 ? "event" : "events"}
            </span>
          ) : null}
          <button
            type="button"
            className="btn"
            aria-pressed={liveTail.active}
            aria-disabled={liveTail.blocked || undefined}
            aria-describedby={liveStatusId}
            onClick={() => {
              if (!liveTail.blocked) liveTail.toggle();
            }}
          >
            {liveTail.blocked
              ? "Live tail unavailable"
              : liveTail.active
                ? "Pause live tail"
                : liveTail.status === "paused"
                  ? "Resume live tail"
                  : "Start live tail"}
          </button>
          <EventComposer
            initialEventName={eventName}
            onSent={onComposerSent}
            canSend={canAdmin}
          />
          <button
            type="button"
            className="btn"
            aria-disabled={exporting || liveTail.blocked || undefined}
            aria-describedby={exportStatusId}
            onClick={() => {
              if (!exporting && !liveTail.blocked) onExport();
            }}
          >
            {exporting
              ? "Exporting…"
              : liveTail.blocked
                ? "Export unavailable"
                : "Export CSV"}
          </button>
        </div>
      </div>
      <div
        className="track-operation-status"
        style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}
      >
        <span
          id={liveStatusId}
          className="muted"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-live-status={liveTail.status}
        >
          {liveTail.statusMessage}
        </span>
        <span
          id={exportStatusId}
          className={exportError ? "field-error" : "muted"}
          role={exportError ? "alert" : "status"}
        >
          {exportError ??
            exportStatus ??
            (liveTail.blocked
              ? "CSV export is unavailable because the current session cannot read product events."
              : `CSV exports include up to 10,000 events from the current event, subscriber, and ${RANGE_LABELS[range]} scope.`)}
        </span>
      </div>
    </>
  );
}

function TrackScopeToolbar({
  picker,
  range,
  eventName,
  refreshing,
  refreshStatus,
  refreshFailed,
  onRangeChange,
  onEventNameChange,
  onRefresh,
}: {
  picker: ReturnType<typeof useSubscriberPicker>;
  range: RangeFilter;
  eventName: string;
  refreshing: boolean;
  refreshStatus: string | null;
  refreshFailed: boolean;
  onRangeChange: (range: RangeFilter) => void;
  onEventNameChange: (eventName: string) => void;
  onRefresh: () => void;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const guidanceId = useId();
  const statusId = useId();
  const submit = useCallback(async (): Promise<void> => {
    const resolved = await picker.submit();
    if (!resolved) inputRef.current?.focus();
  }, [picker]);
  return (
    <section
      className="track-scope-toolbar"
      aria-labelledby={`${guidanceId}-heading`}
    >
      <div className="track-scope-heading">
        <div>
          <div className="track-scope-eyebrow">Investigation scope</div>
          <h2 id={`${guidanceId}-heading`} className="track-scope-title">
            Focus the signal before you inspect it
          </h2>
          <p className="track-scope-subtitle">
            Period and event name shape workspace analytics. Subscriber scope
            applies to the event feed, live tail, and CSV export.
          </p>
        </div>
        <button
          type="button"
          className="btn"
          aria-disabled={refreshing || undefined}
          aria-describedby={statusId}
          onClick={() => {
            if (!refreshing) onRefresh();
          }}
        >
          {refreshing ? "Refreshing…" : "Refresh all event data"}
        </button>
      </div>

      <div
        className="track-scope-current"
        aria-label="Active product event investigation scope"
      >
        <span className="track-scope-current-label">Active</span>
        <span className="track-scope-token is-fixed">Workspace</span>
        <span className="track-scope-token">{RANGE_LABELS[range]}</span>
        {eventName ? (
          <button
            type="button"
            className="track-scope-token is-removable"
            onClick={() => onEventNameChange("")}
            aria-label={`Remove the ${eventName} event-name scope`}
          >
            Event: <span className="mono">{eventName}</span>
            <span aria-hidden="true"> ×</span>
          </button>
        ) : (
          <span className="track-scope-token">All event names</span>
        )}
        {picker.subscriberId ? (
          <button
            type="button"
            className="track-scope-token is-removable"
            onClick={picker.clear}
            aria-label={`Remove the ${picker.subscriberLabel ?? picker.subscriberId} subscriber scope`}
          >
            Subscriber: {picker.subscriberLabel ?? picker.subscriberId}
            <span aria-hidden="true"> ×</span>
          </button>
        ) : (
          <span className="track-scope-token">All subscribers</span>
        )}
      </div>
      <span className="visually-hidden" role="status" aria-live="polite">
        Active scope: workspace, {RANGE_LABELS[range]},{" "}
        {eventName ? `event ${eventName}` : "all event names"},{" "}
        {picker.subscriberLabel ??
          (picker.subscriberId ? "selected subscriber" : "all subscribers")}
        .
      </span>

      <div className="track-scope-grid">
        <fieldset className="track-scope-fieldset">
          <legend>Reporting period</legend>
          <div
            className="chips"
            role="group"
            aria-label="Product event reporting period"
          >
            {(["24h", "7d", "30d", "90d"] as RangeFilter[]).map((option) => (
              <button
                key={option}
                type="button"
                className={`chip${range === option ? " is-active" : ""}`}
                aria-pressed={range === option}
                onClick={() => onRangeChange(option)}
              >
                {RANGE_LABELS[option]}
              </button>
            ))}
          </div>
          <span className="track-scope-field-help">
            One UTC calendar window governs analytics, the visible feed, and CSV
            export; future-dated events are excluded.
          </span>
        </fieldset>

        <div className="track-scope-field">
          <label
            htmlFor={`${guidanceId}-input`}
            className="track-scope-field-label"
          >
            Subscriber ID or email
          </label>
          <div className="track-scope-subscriber-input">
            <input
              ref={inputRef}
              id={`${guidanceId}-input`}
              className="input"
              placeholder="subscriber@example.com or subscriber ID"
              value={picker.input}
              maxLength={512}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={picker.resolveError ? "true" : undefined}
              aria-describedby={`${guidanceId}-help${picker.resolveError ? ` ${guidanceId}-error` : ""}`}
              onChange={(event) => picker.setInput(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <button
              type="button"
              className="btn btn-primary"
              aria-disabled={
                picker.resolving || !picker.input.trim() || undefined
              }
              aria-describedby={`${guidanceId}-help`}
              onClick={() => {
                if (!picker.resolving && picker.input.trim()) void submit();
              }}
            >
              {picker.resolving ? "Resolving…" : "Load events"}
            </button>
          </div>
          {picker.resolveError ? (
            <div
              id={`${guidanceId}-error`}
              className="field-error"
              role="alert"
            >
              {picker.resolveError}
            </div>
          ) : null}
          <div id={`${guidanceId}-help`} className="track-scope-field-help">
            {picker.resolving
              ? "Resolving this subscriber. A second activation reuses the same request."
              : picker.subscriberId
                ? `Feed, live tail, and export are scoped to ${picker.subscriberLabel}.`
                : !picker.input.trim()
                  ? "Optional. Workspace analytics remain visible when a subscriber is selected."
                  : "Loads the latest 200 events for this subscriber and preserves the event-name scope."}
          </div>
        </div>
      </div>

      <div className="track-scope-footer">
        <div
          id={statusId}
          className={refreshFailed ? "field-error" : "muted"}
          role={
            refreshFailed
              ? "alert"
              : refreshing || refreshStatus
                ? "status"
                : undefined
          }
          aria-live="polite"
        >
          {refreshing
            ? "Refreshing the feed, catalog, and activity summary."
            : refreshStatus
              ? refreshStatus
              : "Scope changes are applied immediately; verified snapshots remain visible during refreshes."}
        </div>
        <div className="track-scope-provenance">
          <span>Analytics: workspace · {RANGE_LABELS[range]}</span>
          <span>
            Feed:{" "}
            {picker.subscriberLabel ??
              (picker.subscriberId ? "selected subscriber" : "workspace")}{" "}
            · {RANGE_LABELS[range]}
          </span>
        </div>
      </div>

      {picker.recent.length > 0 || picker.recentError ? (
        <details className="track-recent-subscribers">
          <summary>
            Recent subscribers
            {picker.recent.length > 0
              ? ` · ${picker.recent.length.toLocaleString()}`
              : ""}
          </summary>
          {picker.recent.length > 0 ? (
            <ul
              className="chips"
              aria-label="Recent subscribers"
              style={{ listStyle: "none", margin: 0, padding: 0 }}
            >
              {picker.recent.map((subscriber) => (
                <li key={String(subscriber.id ?? subscriber.email)}>
                  <button
                    type="button"
                    className="chip"
                    aria-pressed={String(subscriber.id) === picker.subscriberId}
                    onClick={() => picker.pickRecent(subscriber)}
                  >
                    {subscriber.email}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {picker.recentError ? (
            <div className="notice" role="status">
              {picker.recentError}
            </div>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}

interface TrackRouteViewProps {
  canAdmin: boolean;
  canCreateSequence: boolean;
  catalog: ProductEventCatalogRow[] | null;
  catalogAsOf: string | null;
  catalogError: string | null;
  catalogLoading: boolean;
  catalogStale: boolean;
  clearSubscriber: () => void;
  error: string | null;
  eventName: string;
  exportError: string | null;
  exporting: boolean;
  exportStatus: string | null;
  filtered: ProductEvent[];
  invalidTimestampCount: number;
  liveTail: ReturnType<typeof useProductEventLiveTail>;
  loading: boolean;
  onExport: () => void;
  onRefresh: () => void;
  range: RangeFilter;
  refreshFailed: boolean;
  refreshing: boolean;
  refreshStatus: string | null;
  rows: ProductEvent[] | null;
  selected: ProductEvent | null;
  setEventName: (eventName: string) => void;
  setRange: (range: RangeFilter) => void;
  setSelected: (event: ProductEvent | null) => void;
  stats: ProductEventStatsResponse | null;
  statsError: string | null;
  statsLoading: boolean;
  statsStale: boolean;
  subscriberPicker: ReturnType<typeof useSubscriberPicker>;
  totalDistinctEventNames: number | null;
}

function TrackRouteView({
  canAdmin,
  canCreateSequence,
  catalog,
  catalogAsOf,
  catalogError,
  catalogLoading,
  catalogStale,
  clearSubscriber,
  error,
  eventName,
  exportError,
  exporting,
  exportStatus,
  filtered,
  invalidTimestampCount,
  liveTail,
  loading,
  onExport,
  onRefresh,
  range,
  refreshFailed,
  refreshing,
  refreshStatus,
  rows,
  selected,
  setEventName,
  setRange,
  setSelected,
  stats,
  statsError,
  statsLoading,
  statsStale,
  subscriberPicker,
  totalDistinctEventNames,
}: TrackRouteViewProps): ReactElement {
  const { subscriberId, subscriberLabel } = subscriberPicker;
  return (
    <>
      <TrackPageHeader
        rows={rows}
        filteredCount={filtered.length}
        eventName={eventName}
        subscriberId={subscriberId}
        subscriberLabel={subscriberLabel}
        totalEvents={stats?.totalEvents}
        totalEventsStale={statsStale}
        range={range}
        liveTail={liveTail}
        exporting={exporting}
        exportStatus={exportStatus}
        exportError={exportError}
        onComposerSent={onRefresh}
        onExport={onExport}
        canAdmin={canAdmin}
      />

      <TrackScopeToolbar
        picker={subscriberPicker}
        range={range}
        eventName={eventName}
        refreshing={refreshing}
        refreshStatus={refreshStatus}
        refreshFailed={refreshFailed}
        onRangeChange={setRange}
        onEventNameChange={setEventName}
        onRefresh={onRefresh}
      />

      <section
        className="track-surface-section"
        aria-labelledby="track-signal-heading"
      >
        <div className="track-surface-heading">
          <div>
            <div className="track-surface-eyebrow">Workspace analytics</div>
            <h2 id="track-signal-heading">Signal overview</h2>
            <p>
              Verified activity and the event-name catalog for the selected
              period{eventName ? `, focused on ${eventName}` : ""}.
            </p>
          </div>
          <div className="track-surface-scope" aria-label="Analytics scope">
            <span>Workspace</span>
            <span>{RANGE_LABELS[range]}</span>
            {eventName ? <span className="mono">{eventName}</span> : null}
          </div>
        </div>
        <EventInsightsRow stats={stats} loading={statsLoading && !stats} />
        {statsError ? (
          <div className="notice" role="alert" style={{ marginBottom: 8 }}>
            {statsStale
              ? "Event activity refresh failed; the last verified summary remains visible: "
              : "Event activity summary is unavailable: "}
            {statsError}
          </div>
        ) : null}
        <EventCatalog
          items={catalog}
          asOf={catalogAsOf}
          loading={catalogLoading}
          error={catalogError}
          stale={catalogStale}
          totalDistinctEventNames={totalDistinctEventNames}
          selectedEvent={eventName}
          onPick={(name) => setEventName(eventName === name ? "" : name)}
        />
      </section>

      <section
        className="track-surface-section"
        aria-labelledby="track-feed-heading"
      >
        <div className="track-surface-heading">
          <div>
            <div className="track-surface-eyebrow">Event evidence</div>
            <h2 id="track-feed-heading">Activity stream</h2>
            <p>
              The latest verified events for{" "}
              {subscriberLabel ??
                (subscriberId ? "the selected subscriber" : "the workspace")}
              . Open any row to inspect its recorded event details. Properties
              are raw workspace evidence and may contain personal data.
            </p>
          </div>
          <div className="track-surface-scope" aria-label="Event feed scope">
            <span>{subscriberId ? "Subscriber" : "Workspace"}</span>
            <span>{RANGE_LABELS[range]}</span>
            {eventName ? <span className="mono">{eventName}</span> : null}
            {rows && rows.length >= 200 ? <span>Latest 200</span> : null}
          </div>
        </div>
        <ProductEventsTable
          rows={rows}
          filteredRows={filtered}
          invalidTimestampCount={invalidTimestampCount}
          loading={loading}
          error={error}
          eventName={eventName}
          range={range}
          subscriberId={subscriberId}
          subscriberLabel={subscriberLabel}
          onEventNameChange={setEventName}
          onOpen={setSelected}
          onClearScope={() => {
            setEventName("");
            clearSubscriber();
          }}
          onWidenPeriod={() => setRange("90d")}
        />
      </section>

      <ConversionsSection />

      {selected ? (
        <TrackEventSlideover
          event={selected}
          onClose={() => setSelected(null)}
          canCreateSequence={canCreateSequence}
        />
      ) : null}
    </>
  );
}

export function Track(): ReactElement {
  const canAdmin = useCanAdmin();
  const canCreateSequence = useCanWrite();
  const subscriberPicker = useSubscriberPicker();
  const { subscriberId, clear: clearSubscriber } = subscriberPicker;
  const [range, setRange] = useState<RangeFilter>("7d");
  const [eventName, setEventName] = useState<string>("");
  const now = useMinuteClock();
  const scopeKey = `${range}:${eventName || "all-events"}:${subscriberId ?? "workspace"}`;
  const activeScopeRef = useRef(scopeKey);
  activeScopeRef.current = scopeKey;
  const eventFeed = useProductEventFeed(subscriberId, eventName);
  const {
    rows,
    loading,
    error: err,
    accessDenied: eventAccessDenied,
    reload: loadEvents,
    prependLiveEvent,
  } = eventFeed;

  const {
    catalog,
    totalDistinctEventNames,
    asOf: catalogAsOf,
    loading: catalogLoading,
    error: catalogError,
    stale: catalogStale,
    reload: loadCatalog,
  } = useProductEventCatalog(range);
  const {
    stats,
    loading: statsLoading,
    error: statsError,
    stale: statsStale,
    reload: loadStats,
  } = useProductEventStats(range, eventName);

  const liveTail = useProductEventLiveTail({
    eventName,
    subscriberId,
    blocked: eventAccessDenied,
    resetKey: `${range}:${eventName}:${subscriberId ?? "workspace"}`,
    onEvent: prependLiveEvent,
  });

  const [selected, setSelected] = useState<ProductEvent | null>(null);
  const [refreshingScope, setRefreshingScope] = useState<string | null>(null);
  const [refreshOutcome, setRefreshOutcome] =
    useState<ScopedOperationStatus | null>(null);
  const refreshFlightRef = useRef<Promise<void> | null>(null);
  const [exportingScope, setExportingScope] = useState<string | null>(null);
  const [exportOutcome, setExportOutcome] =
    useState<ScopedOperationStatus | null>(null);
  const exportFlightRef = useRef<Promise<void> | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const eventAccessDeniedRef = useRef(eventAccessDenied);
  eventAccessDeniedRef.current = eventAccessDenied;
  const refreshing = refreshingScope === scopeKey;
  const refreshStatus =
    refreshOutcome?.scope === scopeKey ? refreshOutcome.message : null;
  const refreshFailed =
    refreshOutcome?.scope === scopeKey && refreshOutcome.failed;
  const exporting = exportingScope === scopeKey;
  const exportStatus =
    exportOutcome?.scope === scopeKey && !exportOutcome.failed
      ? exportOutcome.message
      : null;
  const exportError =
    exportOutcome?.scope === scopeKey && exportOutcome.failed
      ? exportOutcome.message
      : null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshFlightRef.current = null;
      exportFlightRef.current = null;
      exportAbortRef.current?.abort();
      exportAbortRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!eventAccessDenied) return;
    exportAbortRef.current?.abort();
    exportAbortRef.current = null;
    exportFlightRef.current = null;
    setExportingScope(null);
    setExportOutcome(null);
    setSelected(null);
  }, [eventAccessDenied]);

  useEffect(() => {
    refreshFlightRef.current = null;
    setRefreshingScope(null);
    setRefreshOutcome(null);
    exportAbortRef.current?.abort();
    exportAbortRef.current = null;
    exportFlightRef.current = null;
    setExportingScope(null);
    setExportOutcome(null);
    setSelected(null);
  }, [scopeKey]);

  const { filtered, invalidTimestampCount } = useRangeFilteredEvents(
    rows,
    range,
    now,
  );

  const refreshAll = useCallback((): Promise<void> => {
    if (refreshFlightRef.current) return refreshFlightRef.current;
    const requestedScope = scopeKey;
    setRefreshingScope(requestedScope);
    setRefreshOutcome(null);
    const reads = [
      { label: "event feed", request: loadEvents() },
      { label: "event catalog", request: loadCatalog() },
      { label: "activity summary", request: loadStats() },
    ] as const;
    const request = Promise.allSettled(reads.map((read) => read.request))
      .then((results) => {
        if (!mountedRef.current || activeScopeRef.current !== requestedScope) {
          return;
        }
        const failedLabels = results.flatMap((result, index) =>
          result.status === "rejected" || result.value !== true
            ? [reads[index]?.label ?? "unknown read"]
            : [],
        );
        const succeeded = reads.length - failedLabels.length;
        if (failedLabels.length === 0) {
          setRefreshOutcome({
            scope: requestedScope,
            message:
              "Refresh verified the event feed, event catalog, and activity summary. Each analytics read retains its own visible snapshot time.",
            failed: false,
          });
        } else {
          setRefreshOutcome({
            scope: requestedScope,
            message: `${succeeded} of ${reads.length} event reads verified. Could not verify: ${failedLabels.join(", ")}. Any previous verified snapshots remain visible.`,
            failed: true,
          });
        }
      })
      .finally(() => {
        if (mountedRef.current && refreshFlightRef.current === request) {
          refreshFlightRef.current = null;
          setRefreshingScope(null);
        }
      });
    refreshFlightRef.current = request;
    return request;
  }, [loadCatalog, loadEvents, loadStats, scopeKey]);

  const onExportCsv = useCallback((): Promise<void> => {
    if (eventAccessDeniedRef.current) return Promise.resolve();
    if (exportFlightRef.current) return exportFlightRef.current;
    const requestedScope = scopeKey;
    setExportingScope(requestedScope);
    setExportOutcome(null);
    const controller = new AbortController();
    exportAbortRef.current = controller;
    const request = (async (): Promise<void> => {
      try {
        const url = await api.productEventsCsvUrlAuthed({
          ...(eventName ? { eventName } : {}),
          ...(subscriberId ? { subscriberId } : {}),
          occurredAfter: new Date(
            utcDailyWindowStart(Date.now(), range),
          ).toISOString(),
          limit: 10_000,
        });
        if (
          !mountedRef.current ||
          eventAccessDeniedRef.current ||
          activeScopeRef.current !== requestedScope
        ) {
          return;
        }
        const saved = await downloadUrlToFile({
          url,
          suggestedName: `product-events-${new Date().toISOString().slice(0, 10)}.csv`,
          label: "Product events export",
          privacy: "confidential",
          mimeType: "text/csv;charset=utf-8",
          maxBytes: 256 * 1024 * 1024,
          signal: controller.signal,
          captureResponseHeaders: [
            "X-Postwave-Export-Limit",
            "X-Postwave-Truncated",
          ],
        });
        if (
          !mountedRef.current ||
          eventAccessDeniedRef.current ||
          activeScopeRef.current !== requestedScope
        ) {
          return;
        }
        if (!saved.ok) {
          setExportOutcome({
            scope: requestedScope,
            message: saved.message,
            failed: true,
          });
          toast.error(saved.message);
        } else if (saved.status === "cancelled") {
          setExportOutcome({
            scope: requestedScope,
            message: "Export save cancelled. No CSV file was written.",
            failed: false,
          });
        } else {
          const exportLimit =
            Number.parseInt(
              saved.responseHeaders?.["x-postwave-export-limit"] ?? "",
              10,
            ) || 10_000;
          const truncated =
            saved.responseHeaders?.["x-postwave-truncated"] === "true";
          const message = truncated
            ? `Product events CSV saved with the newest ${exportLimit.toLocaleString()} matching events. Additional matches were excluded; narrow the investigation scope for a complete export.`
            : "Product events CSV saved.";
          setExportOutcome({
            scope: requestedScope,
            message,
            failed: false,
          });
          toast.success(
            truncated
              ? "Product events CSV saved with a disclosed row limit"
              : "Product events CSV saved",
          );
        }
      } catch {
        if (
          !mountedRef.current ||
          eventAccessDeniedRef.current ||
          activeScopeRef.current !== requestedScope
        ) {
          return;
        }
        const message =
          "The product events export couldn't be prepared. Check the connection and retry.";
        setExportOutcome({
          scope: requestedScope,
          message,
          failed: true,
        });
        toast.error(message);
      }
    })().finally(() => {
      if (mountedRef.current && exportFlightRef.current === request) {
        exportFlightRef.current = null;
        if (exportAbortRef.current === controller) {
          exportAbortRef.current = null;
        }
        setExportingScope(null);
      }
    });
    exportFlightRef.current = request;
    return request;
  }, [eventName, range, scopeKey, subscriberId]);
  return (
    <TrackRouteView
      canAdmin={canAdmin}
      canCreateSequence={canCreateSequence}
      catalog={catalog}
      catalogAsOf={catalogAsOf}
      catalogError={catalogError}
      catalogLoading={catalogLoading}
      catalogStale={catalogStale}
      clearSubscriber={clearSubscriber}
      error={err}
      eventName={eventName}
      exportError={exportError}
      exporting={exporting}
      exportStatus={exportStatus}
      filtered={filtered}
      invalidTimestampCount={invalidTimestampCount}
      liveTail={liveTail}
      loading={loading}
      onExport={() => void onExportCsv()}
      onRefresh={() => void refreshAll()}
      range={range}
      refreshFailed={refreshFailed}
      refreshing={refreshing}
      refreshStatus={refreshStatus}
      rows={rows}
      selected={selected}
      setEventName={setEventName}
      setRange={setRange}
      setSelected={setSelected}
      stats={stats}
      statsError={statsError}
      statsLoading={statsLoading}
      statsStale={statsStale}
      subscriberPicker={subscriberPicker}
      totalDistinctEventNames={totalDistinctEventNames}
    />
  );
}

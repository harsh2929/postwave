import { useCallback, useEffect, useReducer, useRef } from "react";

import {
  type BenchmarkMetric,
  type BounceCounts,
  type CampaignAnomaly,
  type CampaignBenchmarkResponse,
  type CampaignGoalResults,
  type CampaignLocaleStat,
  type CampaignReport,
  type CampaignTimeseries,
  type DeviceRow,
  type EngagementPanel,
  type GeographyRow,
  type LinkRow,
  api,
} from "../../lib/api-client";
import {
  type RemoteApiError,
  type RemoteFailure,
  remoteFailureFromError,
} from "../../lib/remote-resource";

export type CampaignAnalyticsTab = "overview" | "audience" | "delivery";

export type CampaignAnalyticsResourceKey =
  | "report"
  | "benchmark"
  | "engagement"
  | "timeseries"
  | "goal"
  | "anomalies"
  | "links"
  | "geo"
  | "devices"
  | "locales"
  | "bounces";

export interface CampaignAnalyticsResource<T> {
  data: T | null;
  status: "idle" | "loading" | "ready" | "error";
  failure: RemoteFailure | null;
  verifiedAt: number | null;
}

export interface CampaignAnalyticsCache {
  report: CampaignAnalyticsResource<CampaignReport>;
  benchmark: CampaignAnalyticsResource<CampaignBenchmarkResponse>;
  engagement: CampaignAnalyticsResource<EngagementPanel>;
  timeseries: CampaignAnalyticsResource<CampaignTimeseries>;
  goal: CampaignAnalyticsResource<CampaignGoalResults>;
  anomalies: CampaignAnalyticsResource<CampaignAnomaly[]>;
  links: CampaignAnalyticsResource<LinkRow[]>;
  geo: CampaignAnalyticsResource<GeographyRow[]>;
  devices: CampaignAnalyticsResource<DeviceRow[]>;
  locales: CampaignAnalyticsResource<CampaignLocaleStat[]>;
  bounces: CampaignAnalyticsResource<BounceCounts>;
}

interface ResourceLoadResult {
  data?: unknown;
  error?: RemoteApiError;
}

export const CAMPAIGN_ANALYTICS_TAB_RESOURCES: Readonly<
  Record<CampaignAnalyticsTab, readonly CampaignAnalyticsResourceKey[]>
> = {
  overview: [
    "report",
    "benchmark",
    "engagement",
    "timeseries",
    "goal",
    "anomalies",
  ],
  audience: ["report", "links", "geo", "devices", "locales"],
  delivery: ["report", "bounces"],
};

export const CAMPAIGN_ANALYTICS_RESOURCE_LABELS: Readonly<
  Record<CampaignAnalyticsResourceKey, string>
> = {
  report: "Campaign report",
  benchmark: "90-day benchmark",
  engagement: "Engagement trust signals",
  timeseries: "Hourly engagement",
  goal: "Conversion goal",
  anomalies: "Anomaly analysis",
  links: "Link performance",
  geo: "Geography",
  devices: "Mail clients",
  locales: "Recipient languages",
  bounces: "Bounce classification",
};

function emptyResource<T>(): CampaignAnalyticsResource<T> {
  return {
    data: null,
    status: "idle",
    failure: null,
    verifiedAt: null,
  };
}

function emptyCache(): CampaignAnalyticsCache {
  return {
    report: emptyResource(),
    benchmark: emptyResource(),
    engagement: emptyResource(),
    timeseries: emptyResource(),
    goal: emptyResource(),
    anomalies: emptyResource(),
    links: emptyResource(),
    geo: emptyResource(),
    devices: emptyResource(),
    locales: emptyResource(),
    bounces: emptyResource(),
  };
}

async function loadResourceRequest(
  key: CampaignAnalyticsResourceKey,
  campaignId: string,
): Promise<ResourceLoadResult> {
  switch (key) {
    case "report": {
      const result = await api.getCampaignReport(campaignId);
      return result.error ? { error: result.error } : { data: result.data };
    }
    case "benchmark": {
      const result = await api.getCampaignBenchmark(campaignId);
      return result.error ? { error: result.error } : { data: result.data };
    }
    case "engagement": {
      const result = await api.getCampaignEngagement(campaignId);
      return result.error ? { error: result.error } : { data: result.data };
    }
    case "timeseries": {
      const result = await api.getCampaignTimeseries(campaignId);
      return result.error ? { error: result.error } : { data: result.data };
    }
    case "goal": {
      const result = await api.getCampaignGoalResults(campaignId);
      return result.error ? { error: result.error } : { data: result.data };
    }
    case "anomalies": {
      const result = await api.getCampaignAnomalies(campaignId);
      return result.error
        ? { error: result.error }
        : { data: result.data?.anomalies ?? [] };
    }
    case "links": {
      const result = await api.getCampaignLinkReport(campaignId);
      return result.error
        ? { error: result.error }
        : { data: result.data ?? [] };
    }
    case "geo": {
      const result = await api.getCampaignGeography(campaignId);
      return result.error
        ? { error: result.error }
        : { data: result.data ?? [] };
    }
    case "devices": {
      const result = await api.getCampaignDevices(campaignId);
      return result.error
        ? { error: result.error }
        : { data: result.data ?? [] };
    }
    case "locales": {
      const result = await api.getCampaignLocaleReport(campaignId);
      return result.error
        ? { error: result.error }
        : { data: result.data?.locales ?? [] };
    }
    case "bounces": {
      const result = await api.getCampaignBounces(campaignId);
      return result.error ? { error: result.error } : { data: result.data };
    }
  }
}

function safeThrownFailure(): RemoteFailure {
  return remoteFailureFromError({ kind: "network" });
}

type UntypedCache = Record<
  CampaignAnalyticsResourceKey,
  CampaignAnalyticsResource<unknown>
>;

function resourceRecord(cache: CampaignAnalyticsCache): UntypedCache {
  return cache as unknown as UntypedCache;
}

export interface CampaignAnalyticsTabStatus {
  errorCount: number;
  loadingCount: number;
  readyCount: number;
  totalCount: number;
  verifiedAt: number | null;
}

export function campaignAnalyticsTabStatus(
  cache: CampaignAnalyticsCache,
  tab: CampaignAnalyticsTab,
): CampaignAnalyticsTabStatus {
  const resources = resourceRecord(cache);
  const statuses = CAMPAIGN_ANALYTICS_TAB_RESOURCES[tab].map(
    (key) => resources[key],
  );
  const verifiedTimes = statuses
    .map((resource) => resource.verifiedAt)
    .filter((value): value is number => value !== null);
  return {
    errorCount: statuses.filter((resource) => resource.status === "error")
      .length,
    loadingCount: statuses.filter((resource) => resource.status === "loading")
      .length,
    readyCount: statuses.filter((resource) => resource.status === "ready")
      .length,
    totalCount: statuses.length,
    verifiedAt: verifiedTimes.length > 0 ? Math.max(...verifiedTimes) : null,
  };
}

export interface CampaignAnalyticsDrilldown {
  cache: CampaignAnalyticsCache;
  retryTab: (tab: CampaignAnalyticsTab) => void;
}

/**
 * Campaign-scoped, progressive read controller.
 *
 * Verified responses stay cached per campaign for this slideover's lifetime.
 * Every resource is single-flight within the active campaign generation, and
 * a late response from an earlier campaign identity is discarded.
 */
export function useCampaignAnalyticsDrilldown(
  campaignId: string,
  activeTab: CampaignAnalyticsTab,
): CampaignAnalyticsDrilldown {
  const cachesRef = useRef(new Map<string, CampaignAnalyticsCache>());
  const inflightRef = useRef(new Map<string, Promise<void>>());
  const campaignRef = useRef(campaignId);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  const [, renderRevision] = useReducer((value: number) => value + 1, 0);
  campaignRef.current = campaignId;

  const ensureCache = useCallback((id: string): CampaignAnalyticsCache => {
    const existing = cachesRef.current.get(id);
    if (existing) return existing;
    const created = emptyCache();
    cachesRef.current.set(id, created);
    return created;
  }, []);

  const loadResource = useCallback(
    (
      id: string,
      key: CampaignAnalyticsResourceKey,
      generation: number,
    ): Promise<void> => {
      const cache = ensureCache(id);
      const resources = resourceRecord(cache);
      const current = resources[key];
      const flightKey = `${generation}\u0000${id}\u0000${key}`;
      if (current.status === "ready") return Promise.resolve();
      const existingFlight = inflightRef.current.get(flightKey);
      if (existingFlight) return existingFlight;

      resources[key] = {
        ...current,
        status: "loading",
        failure: null,
      };
      if (mountedRef.current) renderRevision();

      const request = Promise.resolve()
        .then(() => loadResourceRequest(key, id))
        .then((result) => {
          if (
            !mountedRef.current ||
            campaignRef.current !== id ||
            generationRef.current !== generation
          ) {
            return;
          }
          const latest = resourceRecord(ensureCache(id))[key];
          if (result.error) {
            resourceRecord(ensureCache(id))[key] = {
              ...latest,
              status: "error",
              failure: remoteFailureFromError(result.error),
            };
          } else {
            resourceRecord(ensureCache(id))[key] = {
              data: result.data ?? null,
              status: "ready",
              failure: null,
              verifiedAt: Date.now(),
            };
          }
          renderRevision();
        })
        .catch(() => {
          if (
            !mountedRef.current ||
            campaignRef.current !== id ||
            generationRef.current !== generation
          ) {
            return;
          }
          const latest = resourceRecord(ensureCache(id))[key];
          resourceRecord(ensureCache(id))[key] = {
            ...latest,
            status: "error",
            failure: safeThrownFailure(),
          };
          renderRevision();
        })
        .finally(() => {
          inflightRef.current.delete(flightKey);
        });
      inflightRef.current.set(flightKey, request);
      return request;
    },
    [ensureCache],
  );

  const loadTab = useCallback(
    (id: string, tab: CampaignAnalyticsTab, generation: number): void => {
      for (const key of CAMPAIGN_ANALYTICS_TAB_RESOURCES[tab]) {
        void loadResource(id, key, generation);
      }
    },
    [loadResource],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    ensureCache(campaignId);
    loadTab(campaignId, "overview", generation);
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [campaignId, ensureCache, loadTab]);

  useEffect(() => {
    loadTab(campaignId, activeTab, generationRef.current);
  }, [activeTab, campaignId, loadTab]);

  const retryTab = useCallback(
    (tab: CampaignAnalyticsTab): void => {
      loadTab(campaignId, tab, generationRef.current);
    },
    [campaignId, loadTab],
  );

  return {
    cache: ensureCache(campaignId),
    retryTab,
  };
}

// Keep the imported benchmark metric reachable for downstream source
// contracts without weakening the resource map to `any`.
export type CampaignAnalyticsBenchmarkMetric = BenchmarkMetric;

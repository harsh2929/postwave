import {
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type BenchmarkMetric,
  type BounceCounts,
  type Campaign,
  type CampaignBenchmarkResponse,
  type CampaignReport,
  type CohortRow,
  type DashboardStatsResponse,
  type DeviceRow,
  type GeographyRow,
  type LinkRow,
  type RepliesSummary,
  type ReplyTimeseriesResponse,
  type ReplyTopSendersResponse,
  type SequenceFunnel,
  type SubscriberTimeseriesPoint,
  api,
} from "../../lib/api-client";
import { connectDashboardLive } from "../../lib/sse";
import {
  HIGHLIGHT_MS,
  RANGE_INDEPENDENT_SSE_KEYS,
  type Range,
  campaignKey,
  metricKeyToCard,
  parseAnalyticsHash,
  rangeDays,
} from "../../components/analytics/AnalyticsPresentation";
import type { CustomRange } from "../../components/analytics/DateRangePicker";
import type { GroupByDimension } from "../../components/analytics/GroupByMenu";
import { groupedChartDimension } from "../../components/analytics/grouped-series";
import {
  type KpiEntry,
  loadLayout,
  saveLayout,
} from "../../components/analytics/KpiConfigMenu";
import {
  desktopRouteIdentityScope,
  useDesktopRouteTab,
} from "../../lib/desktop-router";
import {
  isRemotePermissionError,
  remoteFailureFromError,
  type RemoteApiError,
} from "../../lib/remote-resource";
import { useMe } from "../../lib/store";

type Setter<T> = Dispatch<SetStateAction<T>>;

const ANALYTICS_DATA_TABS = [
  "overview",
  "campaigns",
  "audience",
  "revenue",
  "predictive",
  "reports",
] as const;
type AnalyticsDataTab = (typeof ANALYTICS_DATA_TABS)[number];

interface AnalyticsLoadActions {
  setAllCampaigns: Setter<Campaign[]>;
  setBenchmark: Setter<BenchmarkMetric[]>;
  setBenchmarkResponse: Setter<CampaignBenchmarkResponse | null>;
  setBounces: Setter<BounceCounts | null>;
  setCampaignReports: Setter<Record<string, CampaignReport>>;
  setCampaigns: Setter<Campaign[]>;
  setCohorts: Setter<CohortRow[]>;
  setDevices: Setter<DeviceRow[]>;
  setDataScope: Setter<string | null>;
  setErr: Setter<string | null>;
  setGeography: Setter<GeographyRow[]>;
  setLastUpdated: Setter<number | null>;
  setIssues: Setter<AnalyticsResourceIssue[]>;
  setRepliesSummary: Setter<RepliesSummary | null>;
  setRepliesTs: Setter<ReplyTimeseriesResponse | null>;
  setSeqFunnel: Setter<SequenceFunnel | null>;
  setSeries: Setter<SubscriberTimeseriesPoint[] | null>;
  setStats: Setter<DashboardStatsResponse | null>;
  setTopLinks: Setter<LinkRow[]>;
  setTopResponders: Setter<ReplyTopSendersResponse | null>;
}

export interface AnalyticsResourceIssue {
  resource: string;
  label: string;
  message: string;
  code?: string;
  requestId?: string;
  retained: boolean;
  primary: boolean;
  severity: "error" | "warning";
}

function resourceIssue(
  resource: string,
  label: string,
  error: RemoteApiError | undefined,
  options: { retained: boolean; primary?: boolean },
): AnalyticsResourceIssue | null {
  if (!error) return null;
  const failure = remoteFailureFromError(error);
  return {
    resource,
    label,
    message: failure.message,
    ...(failure.code ? { code: failure.code } : {}),
    ...(failure.requestId ? { requestId: failure.requestId } : {}),
    retained: options.retained && failure.access !== "denied",
    primary: options.primary ?? false,
    severity: options.primary ? "error" : "warning",
  };
}

export function unwrapCampaignList(value: unknown): Campaign[] {
  if (Array.isArray(value)) return value as Campaign[];
  const envelope = value as
    | { items?: Campaign[]; results?: Campaign[]; data?: Campaign[] }
    | undefined;
  return envelope?.items ?? envelope?.results ?? envelope?.data ?? [];
}

export function unwrapCohorts(value: unknown): CohortRow[] {
  if (Array.isArray(value)) return value as CohortRow[];
  const items =
    value && typeof value === "object" && "items" in value
      ? (value as { items?: unknown }).items
      : undefined;
  return Array.isArray(items) ? (items as CohortRow[]) : [];
}

async function loadAnalyticsDashboard(
  range: Range,
  activeTab: AnalyticsDataTab,
  loadSeqRef: MutableRefObject<number>,
  actions: AnalyticsLoadActions,
  retainPrevious: boolean,
  identityScope: string,
): Promise<void> {
  const loadSeq = ++loadSeqRef.current;
  const days = rangeDays(range);
  const wantsOverview = activeTab === "overview";
  const wantsCampaigns = activeTab === "campaigns";
  const wantsAudience = activeTab === "audience";
  const wantsRecentCampaigns = wantsOverview || wantsCampaigns || wantsAudience;
  const wantsAllCampaigns = wantsOverview || wantsCampaigns;
  const wantsTimeseries = wantsOverview || wantsAudience;
  const wantsSequences = wantsOverview;
  const wantsReplies = wantsOverview;
  const wantsCohorts = wantsOverview || wantsAudience;
  const wantsReports = wantsOverview || wantsCampaigns;
  const wantsBounces = wantsOverview;
  const wantsBenchmark = wantsOverview || wantsCampaigns;
  const [
    stats,
    campaigns,
    allCampaigns,
    timeseries,
    sequences,
    replies,
    replySeries,
    responders,
    cohorts,
  ] = await Promise.all([
    api.getDashboardStats({ range, compare: true, sparklines: true }),
    wantsRecentCampaigns
      ? api.listCampaigns({ page: 1, perPage: 5 })
      : Promise.resolve(null),
    wantsAllCampaigns
      ? api.listCampaigns({ page: 1, perPage: 20 })
      : Promise.resolve(null),
    wantsTimeseries
      ? api.getSubscriberTimeseries(range)
      : Promise.resolve(null),
    wantsSequences ? api.listSequences() : Promise.resolve(null),
    wantsReplies ? api.getRepliesSummary(days) : Promise.resolve(null),
    wantsReplies ? api.getRepliesTimeseries(days) : Promise.resolve(null),
    wantsReplies
      ? api.getRepliesTopSenders({ days, limit: 8 })
      : Promise.resolve(null),
    wantsCohorts
      ? api.getCohorts({ bucket: "month", metric: "open_rate", weeks: 8 })
      : Promise.resolve(null),
  ]);
  if (loadSeq !== loadSeqRef.current) return;
  actions.setDataScope(identityScope);

  const issues: AnalyticsResourceIssue[] = [];
  const addIssue = (
    resource: string,
    label: string,
    error: RemoteApiError | undefined,
    primary = false,
  ): void => {
    const issue = resourceIssue(resource, label, error, {
      retained: retainPrevious,
      primary,
    });
    if (issue) issues.push(issue);
  };
  addIssue("dashboard_stats", "Dashboard totals", stats.error, true);
  if (campaigns) {
    addIssue("recent_campaigns", "Recent campaigns", campaigns.error, true);
  }
  if (timeseries) {
    addIssue(
      "subscriber_timeseries",
      "Subscriber timeseries",
      timeseries.error,
      true,
    );
  }
  if (allCampaigns) {
    addIssue("all_campaigns", "Campaign catalog", allCampaigns.error);
  }
  if (sequences) {
    addIssue("sequences", "Sequence catalog", sequences.error);
  }
  if (replies) {
    addIssue("replies_summary", "Replies summary", replies.error);
  }
  if (replySeries) {
    addIssue("replies_timeseries", "Replies timeseries", replySeries.error);
  }
  if (responders) {
    addIssue("top_responders", "Top responders", responders.error);
  }
  if (cohorts) addIssue("cohorts", "Cohorts", cohorts.error);

  actions.setErr(
    stats.error ? remoteFailureFromError(stats.error).message : null,
  );
  if (!stats.error) {
    actions.setStats(stats.data ?? null);
  } else if (isRemotePermissionError(stats.error)) {
    actions.setStats(null);
  }
  if (replies && !replies.error) {
    actions.setRepliesSummary(replies.data ?? null);
  } else if (replies?.error && isRemotePermissionError(replies.error)) {
    actions.setRepliesSummary(null);
  }
  if (replySeries && !replySeries.error) {
    actions.setRepliesTs(replySeries.data ?? null);
  } else if (replySeries?.error && isRemotePermissionError(replySeries.error)) {
    actions.setRepliesTs(null);
  }
  if (responders && !responders.error) {
    actions.setTopResponders(responders.data ?? null);
  } else if (responders?.error && isRemotePermissionError(responders.error)) {
    actions.setTopResponders(null);
  }
  if (cohorts && !cohorts.error) {
    actions.setCohorts(unwrapCohorts(cohorts.data as unknown));
  } else if (cohorts?.error && isRemotePermissionError(cohorts.error)) {
    actions.setCohorts([]);
  }
  if (allCampaigns && !allCampaigns.error) {
    actions.setAllCampaigns(unwrapCampaignList(allCampaigns.data));
  } else if (
    allCampaigns?.error &&
    isRemotePermissionError(allCampaigns.error)
  ) {
    actions.setAllCampaigns([]);
  }
  if (timeseries && !timeseries.error) {
    actions.setSeries(
      timeseries.data &&
        Array.isArray(timeseries.data.points) &&
        timeseries.data.points.length > 0
        ? timeseries.data.points
        : null,
    );
  } else if (timeseries?.error && isRemotePermissionError(timeseries.error)) {
    actions.setSeries(null);
  }

  const primaryAccepted =
    !stats.error &&
    (!campaigns || !campaigns.error) &&
    (!timeseries || !timeseries.error);
  let recentCampaigns: Campaign[] | null = null;
  if (campaigns && !campaigns.error) {
    recentCampaigns = unwrapCampaignList(campaigns.data).slice(0, 5);
    actions.setCampaigns(recentCampaigns);
  } else if (campaigns?.error && isRemotePermissionError(campaigns.error)) {
    actions.setCampaigns([]);
  }

  if (sequences && !sequences.error) {
    const sequenceList = sequences.data
      ? (sequences.data.items ??
        sequences.data.sequences ??
        sequences.data.data ??
        [])
      : [];
    const firstSequenceId = sequenceList.find((item) => item.id != null)?.id;
    if (firstSequenceId != null) {
      const funnel = await api.getSequenceFunnel(firstSequenceId);
      if (loadSeq !== loadSeqRef.current) return;
      addIssue("sequence_funnel", "Sequence funnel", funnel.error);
      if (!funnel.error) {
        actions.setSeqFunnel(
          funnel.data?.steps && funnel.data.steps.length > 0
            ? funnel.data
            : null,
        );
      }
    } else {
      actions.setSeqFunnel(null);
    }
  } else if (sequences?.error && isRemotePermissionError(sequences.error)) {
    actions.setSeqFunnel(null);
  }

  if (wantsRecentCampaigns && recentCampaigns === null) {
    if (campaigns?.error && isRemotePermissionError(campaigns.error)) {
      if (wantsReports) actions.setCampaignReports({});
      if (wantsAudience) {
        actions.setDevices([]);
        actions.setGeography([]);
        actions.setTopLinks([]);
      }
      if (wantsBounces) actions.setBounces(null);
      if (wantsBenchmark) {
        actions.setBenchmark([]);
        actions.setBenchmarkResponse(null);
      }
    }
    actions.setIssues(issues);
    return;
  }
  const ids = (recentCampaigns ?? []).map(campaignKey).filter(Boolean);
  if (ids.length === 0) {
    if (wantsReports) actions.setCampaignReports({});
    if (wantsAudience) {
      actions.setDevices([]);
      actions.setGeography([]);
      actions.setTopLinks([]);
    }
    if (wantsBounces) actions.setBounces(null);
    if (wantsBenchmark) {
      actions.setBenchmark([]);
      actions.setBenchmarkResponse(null);
    }
    actions.setIssues(issues);
    if (primaryAccepted) actions.setLastUpdated(Date.now());
    return;
  }
  if (!wantsReports && !wantsBounces && !wantsAudience && !wantsBenchmark) {
    actions.setIssues(issues);
    if (primaryAccepted) actions.setLastUpdated(Date.now());
    return;
  }

  const [details, benchmarkResult] = await Promise.all([
    Promise.all(
      ids.map(async (id) => {
        const [report, devices, geography, bounces, links] = await Promise.all([
          wantsReports ? api.getCampaignReport(id) : Promise.resolve(null),
          wantsAudience ? api.getCampaignDevices(id) : Promise.resolve(null),
          wantsAudience ? api.getCampaignGeography(id) : Promise.resolve(null),
          wantsBounces ? api.getCampaignBounces(id) : Promise.resolve(null),
          wantsAudience ? api.getCampaignLinkReport(id) : Promise.resolve(null),
        ]);
        return { id, report, devices, geography, bounces, links };
      }),
    ),
    wantsBenchmark ? api.getCampaignBenchmark(ids[0]!) : Promise.resolve(null),
  ]);
  if (loadSeq !== loadSeqRef.current) return;

  const reports: Record<string, CampaignReport> = {};
  const deviceTotals = new Map<string, DeviceRow>();
  const geographyTotals = new Map<string, GeographyRow>();
  const linkTotals = new Map<string, LinkRow>();
  const deniedReportIds = new Set<string>();
  const bounceTotals: BounceCounts = {
    hard: 0,
    soft: 0,
    spam_trap: 0,
    total: 0,
  };

  details.forEach(({ id, report, devices, geography, bounces, links }) => {
    if (wantsReports) {
      addIssue(`campaign_report:${id}`, "Campaign report", report?.error);
      if (report?.error && isRemotePermissionError(report.error)) {
        deniedReportIds.add(id);
      }
    }
    if (wantsAudience) {
      addIssue(
        `campaign_devices:${id}`,
        "Campaign mail clients",
        devices?.error,
      );
      addIssue(
        `campaign_geography:${id}`,
        "Campaign geography",
        geography?.error,
      );
      addIssue(`campaign_links:${id}`, "Campaign link report", links?.error);
    }
    if (wantsBounces) {
      addIssue(`campaign_bounces:${id}`, "Campaign bounces", bounces?.error);
    }
    if (report?.data) reports[id] = report.data;
    if (Array.isArray(devices?.data)) {
      for (const row of devices.data) {
        const key = row.client || "Unknown";
        const total = deviceTotals.get(key) ?? {
          client: key,
          opens: 0,
          clicks: 0,
        };
        total.opens += row.opens ?? 0;
        total.clicks += row.clicks ?? 0;
        deviceTotals.set(key, total);
      }
    }
    if (Array.isArray(geography?.data)) {
      for (const row of geography.data) {
        const key = row.country || "Unknown";
        const total = geographyTotals.get(key) ?? {
          country: key,
          opens: 0,
          clicks: 0,
        };
        total.opens += row.opens ?? 0;
        total.clicks += row.clicks ?? 0;
        geographyTotals.set(key, total);
      }
    }
    if (bounces?.data) {
      bounceTotals.hard += bounces.data.hard ?? 0;
      bounceTotals.soft += bounces.data.soft ?? 0;
      bounceTotals.spam_trap += bounces.data.spam_trap ?? 0;
      bounceTotals.total += bounces.data.total ?? 0;
    }
    if (Array.isArray(links?.data)) {
      for (const row of links.data) {
        const key = row.url || "";
        if (!key) continue;
        const total = linkTotals.get(key) ?? {
          url: key,
          clicks: 0,
          unique_clickers: 0,
          ctr: 0,
        };
        total.clicks += row.clicks ?? 0;
        total.unique_clickers += row.unique_clickers ?? 0;
        if ((row.ctr ?? 0) > total.ctr) total.ctr = row.ctr ?? 0;
        linkTotals.set(key, total);
      }
    }
  });

  if (wantsReports) {
    actions.setCampaignReports((previous) => {
      const next: Record<string, CampaignReport> = {};
      for (const id of ids) {
        const verified = deniedReportIds.has(id)
          ? undefined
          : (reports[id] ?? previous[id]);
        if (verified) next[id] = verified;
      }
      return next;
    });
  }
  if (wantsAudience) {
    if (
      details.some(
        ({ devices }) =>
          devices?.error && isRemotePermissionError(devices.error),
      )
    ) {
      actions.setDevices([]);
    } else if (details.every(({ devices }) => !devices?.error)) {
      actions.setDevices(
        [...deviceTotals.values()].sort((a, b) => b.opens - a.opens),
      );
    }
  }
  if (wantsAudience) {
    if (
      details.some(
        ({ geography }) =>
          geography?.error && isRemotePermissionError(geography.error),
      )
    ) {
      actions.setGeography([]);
    } else if (details.every(({ geography }) => !geography?.error)) {
      actions.setGeography(
        [...geographyTotals.values()].sort((a, b) => b.opens - a.opens),
      );
    }
  }
  if (wantsBounces) {
    if (
      details.some(
        ({ bounces }) =>
          bounces?.error && isRemotePermissionError(bounces.error),
      )
    ) {
      actions.setBounces(null);
    } else if (details.every(({ bounces }) => !bounces?.error)) {
      actions.setBounces(bounceTotals);
    }
  }
  if (wantsAudience) {
    if (
      details.some(
        ({ links }) => links?.error && isRemotePermissionError(links.error),
      )
    ) {
      actions.setTopLinks([]);
    } else if (details.every(({ links }) => !links?.error)) {
      actions.setTopLinks(
        [...linkTotals.values()]
          .sort((a, b) => b.clicks - a.clicks)
          .slice(0, 8),
      );
    }
  }
  if (benchmarkResult) {
    addIssue("campaign_benchmark", "Campaign benchmark", benchmarkResult.error);
    if (!benchmarkResult.error) {
      actions.setBenchmarkResponse(benchmarkResult.data);
      actions.setBenchmark(
        Array.isArray(benchmarkResult.data.metrics)
          ? benchmarkResult.data.metrics
          : [],
      );
    } else if (isRemotePermissionError(benchmarkResult.error)) {
      actions.setBenchmark([]);
      actions.setBenchmarkResponse(null);
    }
  }
  actions.setIssues(issues);
  if (primaryAccepted) actions.setLastUpdated(Date.now());
}

function useAnalyticsHashHighlights(
  highlightedMetric: string | null,
  setHighlightedMetric: Setter<string | null>,
  highlightedChart: string | null,
  setHighlightedChart: Setter<string | null>,
): void {
  useEffect(() => {
    if (!highlightedMetric) return;
    const scroll = window.setTimeout(() => {
      document
        .querySelector(`[data-kpi-metric="${highlightedMetric}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    const clear = window.setTimeout(
      () => setHighlightedMetric(null),
      HIGHLIGHT_MS,
    );
    return () => {
      window.clearTimeout(scroll);
      window.clearTimeout(clear);
    };
  }, [highlightedMetric, setHighlightedMetric]);

  useEffect(() => {
    if (!highlightedChart) return;
    const scroll = window.setTimeout(() => {
      document
        .getElementById(highlightedChart)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    const clear = window.setTimeout(
      () => setHighlightedChart(null),
      HIGHLIGHT_MS,
    );
    return () => {
      window.clearTimeout(scroll);
      window.clearTimeout(clear);
    };
  }, [highlightedChart, setHighlightedChart]);
}

function useDashboardLive(
  identityScope: string,
  rangeRef: MutableRefObject<Range>,
  setDataScope: Setter<string | null>,
  setStats: Setter<DashboardStatsResponse | null>,
  setLastUpdated: Setter<number | null>,
  setLiveStatus: Setter<"connecting" | "open" | "closed">,
  setLiveUnavailable: Setter<boolean>,
): void {
  useEffect(() => {
    setLiveStatus("connecting");
    setLiveUnavailable(false);
    const giveUp = window.setTimeout(() => setLiveUnavailable(true), 25_000);
    const stop = connectDashboardLive(
      (snapshot) => {
        setDataScope(identityScope);
        setStats((previous) => {
          const base = previous ?? {};
          if (rangeRef.current === "30d") return { ...base, ...snapshot };
          const merged: Record<string, unknown> = { ...base };
          const record = snapshot as Record<string, unknown>;
          for (const key of RANGE_INDEPENDENT_SSE_KEYS) {
            if (key in record) merged[key] = record[key];
          }
          return merged as DashboardStatsResponse;
        });
        setLastUpdated(Date.now());
      },
      undefined,
      (status) => {
        if (status !== "open" && status !== "connecting" && status !== "closed")
          return;
        setLiveStatus(status);
        if (status === "open") {
          window.clearTimeout(giveUp);
          setLiveUnavailable(false);
        }
      },
    );
    return () => {
      window.clearTimeout(giveUp);
      stop();
    };
  }, [
    identityScope,
    rangeRef,
    setDataScope,
    setLastUpdated,
    setLiveStatus,
    setLiveUnavailable,
    setStats,
  ]);
}

function useIdentityScopedKpiLayout(
  scope: string | null,
): [KpiEntry[], Setter<KpiEntry[]>] {
  const [storage, setStorage] = useState(() => ({
    scope,
    layout: loadLayout(scope),
  }));
  const layout = storage.scope === scope ? storage.layout : loadLayout(scope);

  useEffect(() => {
    if (storage.scope === scope) return;
    setStorage({ scope, layout: loadLayout(scope) });
  }, [scope, storage.scope]);

  useEffect(() => {
    if (storage.scope === scope) saveLayout(scope, storage.layout);
  }, [scope, storage]);

  const setLayout = useCallback<Setter<KpiEntry[]>>(
    (action) => {
      setStorage((current) => {
        const previous =
          current.scope === scope ? current.layout : loadLayout(scope);
        const next = typeof action === "function" ? action(previous) : action;
        return { scope, layout: next };
      });
    },
    [scope],
  );
  return [layout, setLayout];
}

export function useAnalyticsDashboardController() {
  const me = useMe();
  const storageScope = desktopRouteIdentityScope(me?.user, me?.tenant);
  const identityScope = storageScope ?? "__signed_out__";
  const [activeDataTab] = useDesktopRouteTab<AnalyticsDataTab>(
    "analytics",
    ANALYTICS_DATA_TABS,
    "overview",
  );
  const initialHash = typeof window === "undefined" ? {} : parseAnalyticsHash();
  const [range, setRange] = useState<Range>(initialHash.range ?? "30d");
  const [vsPrevious, setVsPrevious] = useState(true);
  const [groupBy, setGroupBy] = useState<GroupByDimension>("none");
  const groupedDimension = groupedChartDimension(groupBy);
  const [kpiLayout, setKpiLayout] = useIdentityScopedKpiLayout(storageScope);
  const [highlightedMetric, setHighlightedMetric] = useState<string | null>(
    initialHash.metric ? metricKeyToCard(initialHash.metric) : null,
  );
  const [highlightedChart, setHighlightedChart] = useState<string | null>(
    initialHash.focus ?? null,
  );
  useAnalyticsHashHighlights(
    highlightedMetric,
    setHighlightedMetric,
    highlightedChart,
    setHighlightedChart,
  );

  const [stats, setStats] = useState<DashboardStatsResponse | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignReports, setCampaignReports] = useState<
    Record<string, CampaignReport>
  >({});
  const [series, setSeries] = useState<SubscriberTimeseriesPoint[] | null>(
    null,
  );
  const [seqFunnel, setSeqFunnel] = useState<SequenceFunnel | null>(null);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [geography, setGeography] = useState<GeographyRow[]>([]);
  const [bounces, setBounces] = useState<BounceCounts | null>(null);
  const [topLinks, setTopLinks] = useState<LinkRow[]>([]);
  const [benchmark, setBenchmark] = useState<BenchmarkMetric[]>([]);
  const [benchmarkResponse, setBenchmarkResponse] =
    useState<CampaignBenchmarkResponse | null>(null);
  const [repliesSummary, setRepliesSummary] = useState<RepliesSummary | null>(
    null,
  );
  const [repliesTs, setRepliesTs] = useState<ReplyTimeseriesResponse | null>(
    null,
  );
  const [topResponders, setTopResponders] =
    useState<ReplyTopSendersResponse | null>(null);
  const [cohorts, setCohorts] = useState<CohortRow[]>([]);
  const [liveStatus, setLiveStatus] = useState<
    "connecting" | "open" | "closed"
  >("closed");
  const [liveUnavailable, setLiveUnavailable] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [customRange, setCustomRange] = useState<CustomRange | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [issues, setIssues] = useState<AnalyticsResourceIssue[]>([]);
  const [dataScope, setDataScope] = useState<string | null>(null);
  const [drillTarget, setDrillTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [allCampaigns, setAllCampaigns] = useState<Campaign[]>([]);
  const loadSeqRef = useRef(0);
  const dataScopeRef = useRef<string | null>(null);
  const loadFlightRef = useRef<{
    key: string;
    promise: Promise<void>;
  } | null>(null);
  const rangeRef = useRef<Range>(range);
  const subscriberChartRef = useRef<HTMLDivElement | null>(null);
  const engagementChartRef = useRef<HTMLDivElement | null>(null);

  const acceptDataScope = useCallback<Setter<string | null>>((action) => {
    setDataScope((previous) => {
      const next = typeof action === "function" ? action(previous) : action;
      dataScopeRef.current = next;
      return next;
    });
  }, []);

  // Identity is part of the data contract, not just the preference key. Hide
  // and invalidate the previous tenant synchronously on the identity render;
  // this effect then clears its backing state and cancels its generation.
  useEffect(() => {
    loadSeqRef.current += 1;
    loadFlightRef.current = null;
    dataScopeRef.current = null;
    setDataScope(null);
    setStats(null);
    setCampaigns([]);
    setAllCampaigns([]);
    setCampaignReports({});
    setSeries(null);
    setSeqFunnel(null);
    setDevices([]);
    setGeography([]);
    setBounces(null);
    setTopLinks([]);
    setBenchmark([]);
    setBenchmarkResponse(null);
    setRepliesSummary(null);
    setRepliesTs(null);
    setTopResponders(null);
    setCohorts([]);
    setIssues([]);
    setErr(null);
    setLastUpdated(null);
    setLiveStatus("closed");
    setLiveUnavailable(false);
    return () => {
      loadSeqRef.current += 1;
      loadFlightRef.current = null;
    };
  }, [identityScope]);

  const load = useCallback(
    (nextRange: Range): Promise<void> => {
      const key = `${identityScope}:${nextRange}:${activeDataTab}`;
      if (loadFlightRef.current?.key === key) {
        return loadFlightRef.current.promise;
      }
      const retainPrevious = dataScopeRef.current === identityScope;
      setRefreshing(true);
      let promise!: Promise<void>;
      promise = loadAnalyticsDashboard(
        nextRange,
        activeDataTab,
        loadSeqRef,
        {
          setAllCampaigns,
          setBenchmark,
          setBenchmarkResponse,
          setBounces,
          setCampaignReports,
          setCampaigns,
          setCohorts,
          setDataScope: acceptDataScope,
          setDevices,
          setErr,
          setGeography,
          setIssues,
          setLastUpdated,
          setRepliesSummary,
          setRepliesTs,
          setSeqFunnel,
          setSeries,
          setStats,
          setTopLinks,
          setTopResponders,
        },
        retainPrevious,
        identityScope,
      )
        .catch(() => {
          if (loadFlightRef.current?.promise !== promise) return;
          acceptDataScope(identityScope);
          const failure = remoteFailureFromError({ kind: "network" });
          setErr(failure.message);
          setIssues([
            {
              resource: "analytics_snapshot",
              label: "Analytics snapshot",
              message: failure.message,
              retained: retainPrevious,
              primary: true,
              severity: "error",
            },
          ]);
        })
        .finally(() => {
          if (loadFlightRef.current?.promise !== promise) return;
          loadFlightRef.current = null;
          setRefreshing(false);
        });
      loadFlightRef.current = { key, promise };
      return promise;
    },
    [acceptDataScope, activeDataTab, identityScope],
  );

  useEffect(() => {
    rangeRef.current = range;
    void load(range);
  }, [load, range]);
  useDashboardLive(
    identityScope,
    rangeRef,
    acceptDataScope,
    setStats,
    setLastUpdated,
    setLiveStatus,
    setLiveUnavailable,
  );

  const scopeCurrent = dataScope === identityScope;
  const loading = refreshing && !scopeCurrent;

  return {
    allCampaigns: scopeCurrent ? allCampaigns : [],
    benchmark: scopeCurrent ? benchmark : [],
    benchmarkResponse: scopeCurrent ? benchmarkResponse : null,
    bounces: scopeCurrent ? bounces : null,
    campaignReports: scopeCurrent ? campaignReports : {},
    campaigns: scopeCurrent ? campaigns : [],
    cohorts: scopeCurrent ? cohorts : [],
    customRange,
    devices: scopeCurrent ? devices : [],
    drillTarget,
    engagementChartRef: engagementChartRef as RefObject<HTMLDivElement | null>,
    err: scopeCurrent ? err : null,
    geography: scopeCurrent ? geography : [],
    groupBy,
    groupedDimension,
    highlightedChart,
    highlightedMetric,
    issues: scopeCurrent ? issues : [],
    kpiLayout,
    lastUpdated: scopeCurrent ? lastUpdated : null,
    liveStatus,
    liveUnavailable,
    load,
    loading,
    refreshing,
    range,
    repliesSummary: scopeCurrent ? repliesSummary : null,
    repliesTs: scopeCurrent ? repliesTs : null,
    revenueCurrency: null,
    revenueTotalCents: null,
    seqFunnel: scopeCurrent ? seqFunnel : null,
    series: scopeCurrent ? series : null,
    setCustomRange,
    setDrillTarget,
    setGroupBy,
    setKpiLayout,
    setRange,
    setVsPrevious,
    stats: scopeCurrent ? stats : null,
    subscriberChartRef: subscriberChartRef as RefObject<HTMLDivElement | null>,
    topLinks: scopeCurrent ? topLinks : [],
    topResponders: scopeCurrent ? topResponders : null,
    vsPrevious,
  };
}

export type AnalyticsDashboardController = ReturnType<
  typeof useAnalyticsDashboardController
>;

/**
 * RepliesOverviewCard (#16, full-surface wiring 2026-06-11)
 *
 * Tenant-wide reply analytics, mounted as a collapsible section on the
 * Campaigns page:
 *
 *   - summary strip: total replies + matched/unmatched split for the
 *     selected window;
 *   - top campaigns by replies (names resolved from the page's loaded
 *     campaign rows; honest shortened-id fallback otherwise) with a
 *     per-campaign drill-down via GET /replies/by-campaign/{id};
 *   - top senders table;
 *   - replies/day timeseries on the shared LineChart.
 *
 * Honest-UI: "No replies tracked yet" renders ONLY when the summary
 * fetch succeeded with total === 0; any fetch error renders a notice
 * with a Retry button instead. Read-only surface, no RBAC gates.
 */

import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import { LineChart } from "../charts/LineChart";
import {
  type Campaign,
  type RepliesSummary,
  type ReplyByCampaignResponse,
  type ReplyTimeseriesResponse,
  type ReplyTopSendersResponse,
  replyAnalyticsApi,
} from "../../lib/api-client";
import { fmtDayMonth } from "../../lib/format-date";
import { remoteFailureFromError } from "../../lib/remote-resource";
import {
  DEFAULT_REPLY_WINDOW,
  REPLY_WINDOW_OPTIONS,
  buildTopCampaignRows,
  campaignDisplayName,
  fmtReplyRate,
  summaryIsEmpty,
  timeseriesToLinePoints,
} from "./replies-helpers";

interface Props {
  /** Loaded campaign rows from the page — used for id → name lookup. */
  campaigns: Campaign[] | null;
}

interface DrilldownState {
  campaignId: string;
  loading: boolean;
  err: string | null;
  data: ReplyByCampaignResponse | null;
}

function ReplySummaryStrip({
  summary,
}: {
  summary: RepliesSummary;
}): ReactElement {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        gap: 12,
        marginBottom: 16,
      }}
    >
      <SummaryStat
        label="Total replies"
        value={summary.total.toLocaleString()}
      />
      <SummaryStat
        label="Matched to a campaign"
        value={summary.matched.toLocaleString()}
        hint="Replies whose In-Reply-To matched an outbound Message-ID."
      />
      <SummaryStat
        label="Unmatched"
        value={summary.unmatched.toLocaleString()}
        hint="Inbound replies we couldn't attribute to a specific campaign."
      />
    </div>
  );
}

function ReplyTimeseriesPanel({
  days,
  timeseries,
}: {
  days: number;
  timeseries: ReplyTimeseriesResponse | null;
}): ReactElement {
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="label" style={{ marginBottom: 6 }}>
        Replies per day
      </div>
      {timeseries ? (
        timeseries.points.length > 0 ? (
          <LineChart
            data={timeseriesToLinePoints(timeseries.points)}
            height={160}
            title="Replies per day"
            valueLabel="Replies"
            provenance={{
              source: "Moosewave reply-analytics timeseries API",
              asOf: null,
              scope: `Current workspace · last ${days} days`,
            }}
            exportFileName={`replies-per-day-${days}d.csv`}
            exportPrivacy="confidential"
          />
        ) : (
          <div className="muted" style={{ fontSize: 12 }}>
            No reply activity in this window.
          </div>
        )
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>
          Timeseries unavailable.
        </div>
      )}
    </div>
  );
}

function useRepliesOverviewController() {
  const bodyId = useId();
  const drillBaseId = useId();
  const activeRef = useRef(true);
  const loadRequestRef = useRef(0);
  const loadFlightRef = useRef<{
    windowDays: number;
    promise: Promise<void>;
  } | null>(null);
  const drillRequestRef = useRef(0);
  const drillFlightRef = useRef<{
    campaignId: string;
    promise: Promise<void>;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<number>(DEFAULT_REPLY_WINDOW);

  const [summary, setSummary] = useState<RepliesSummary | null>(null);
  const [topSenders, setTopSenders] = useState<ReplyTopSendersResponse | null>(
    null,
  );
  const [timeseries, setTimeseries] = useState<ReplyTimeseriesResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);

  const [drill, setDrill] = useState<DrilldownState | null>(null);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const load = async (windowDays: number): Promise<void> => {
    if (loadFlightRef.current?.windowDays === windowDays) {
      return loadFlightRef.current.promise;
    }
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setErr(null);
    const request = (async (): Promise<void> => {
      try {
        const [summaryResponse, senderResponse, timeseriesResponse] =
          await Promise.all([
            Promise.resolve().then(() => replyAnalyticsApi.summary(windowDays)),
            Promise.resolve().then(() =>
              replyAnalyticsApi.topSenders(windowDays),
            ),
            Promise.resolve().then(() =>
              replyAnalyticsApi.timeseries(windowDays),
            ),
          ]);
        if (!activeRef.current || requestId !== loadRequestRef.current) return;
        if (summaryResponse.error) {
          setErr(remoteFailureFromError(summaryResponse.error).message);
          setSummary(null);
          setTopSenders(null);
          setTimeseries(null);
          return;
        }
        setSummary(summaryResponse.data);
        setTopSenders(senderResponse.error ? null : senderResponse.data);
        setTimeseries(
          timeseriesResponse.error ? null : timeseriesResponse.data,
        );
      } catch {
        if (!activeRef.current || requestId !== loadRequestRef.current) return;
        setErr(remoteFailureFromError({ kind: "network" }).message);
        setSummary(null);
        setTopSenders(null);
        setTimeseries(null);
      } finally {
        if (activeRef.current && requestId === loadRequestRef.current) {
          setLoading(false);
          setLoadedOnce(true);
        }
      }
    })();
    loadFlightRef.current = { windowDays, promise: request };
    try {
      await request;
    } finally {
      if (loadFlightRef.current?.promise === request) {
        loadFlightRef.current = null;
      }
    }
  };

  // Lazy: fetch on first expand, refetch on window change while open.
  useEffect(() => {
    if (open) void load(days);
    else {
      loadRequestRef.current += 1;
      loadFlightRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, days]);

  const loadDrill = (campaignId: string): void => {
    if (drillFlightRef.current?.campaignId === campaignId) return;
    const requestId = ++drillRequestRef.current;
    setDrill({ campaignId, loading: true, err: null, data: null });
    const request = (async (): Promise<void> => {
      try {
        const response = await Promise.resolve().then(() =>
          replyAnalyticsApi.byCampaign(campaignId),
        );
        if (!activeRef.current || requestId !== drillRequestRef.current) return;
        setDrill((current) => {
          if (!current || current.campaignId !== campaignId) return current;
          if (response.error) {
            return {
              ...current,
              loading: false,
              err: remoteFailureFromError(response.error).message,
            };
          }
          return { ...current, loading: false, data: response.data };
        });
      } catch {
        if (!activeRef.current || requestId !== drillRequestRef.current) return;
        setDrill((current) =>
          current?.campaignId === campaignId
            ? {
                ...current,
                loading: false,
                err: remoteFailureFromError({ kind: "network" }).message,
              }
            : current,
        );
      }
    })();
    drillFlightRef.current = { campaignId, promise: request };
    void request.finally(() => {
      if (drillFlightRef.current?.promise === request) {
        drillFlightRef.current = null;
      }
    });
  };

  const toggleDrill = (campaignId: string): void => {
    if (drill?.campaignId === campaignId) {
      drillRequestRef.current += 1;
      drillFlightRef.current = null;
      setDrill(null);
      return;
    }
    loadDrill(campaignId);
  };

  return {
    bodyId,
    days,
    drill,
    drillBaseId,
    err,
    loadedOnce,
    loading,
    open,
    summary,
    timeseries,
    topSenders,
    load,
    loadDrill,
    setDays,
    setOpen,
    toggleDrill,
  };
}

export function RepliesOverviewCard({ campaigns }: Props): ReactElement {
  const {
    bodyId,
    days,
    drill,
    drillBaseId,
    err,
    loadedOnce,
    loading,
    open,
    summary,
    timeseries,
    topSenders,
    load,
    loadDrill,
    setDays,
    setOpen,
    toggleDrill,
  } = useRepliesOverviewController();

  const topRows = buildTopCampaignRows(summary, campaigns);

  return (
    <section className="card" style={{ marginTop: 16, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={bodyId}
          style={{ fontWeight: 600, fontSize: 13 }}
        >
          {open ? "▾" : "▸"} Reply analytics
        </button>
        {summary ? (
          <span className="muted tabular" style={{ fontSize: 12 }}>
            {summary.total.toLocaleString()}{" "}
            {summary.total === 1 ? "reply" : "replies"} / {summary.window_days}d
          </span>
        ) : null}
        <span className="spacer" />
        {open ? (
          <>
            <select
              className="input"
              style={{ maxWidth: 130 }}
              value={days}
              aria-label="Replies window"
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {REPLY_WINDOW_OPTIONS.map((w) => (
                <option key={w} value={w}>
                  Last {w} days
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void load(days)}
              aria-disabled={loading || undefined}
              aria-busy={loading || undefined}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </>
        ) : null}
      </div>

      {open ? (
        <div id={bodyId} style={{ marginTop: 12 }}>
          {loading && loadedOnce ? (
            <div className="muted" role="status" style={{ marginBottom: 8 }}>
              Refreshing the last {days} days
              {summary && summary.window_days !== days
                ? `; showing the last verified ${summary.window_days}-day result until the refresh completes.`
                : "."}
            </div>
          ) : null}
          {loading && !loadedOnce ? (
            <div
              className="skel"
              role="status"
              aria-label={`Loading reply analytics for the last ${days} days`}
              style={{ height: 60 }}
            />
          ) : err ? (
            <div className="notice" role="alert">
              <span>Couldn&apos;t load reply analytics: {err}</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void load(days)}
              >
                Retry
              </button>
            </div>
          ) : summaryIsEmpty(summary) ? (
            <div className="muted" style={{ fontSize: 13 }}>
              No replies tracked yet in the last {summary!.window_days} days.
              Replies appear here once subscribers respond to your campaigns
              (matched via the outbound Message-ID).
            </div>
          ) : summary ? (
            <>
              <ReplySummaryStrip summary={summary} />

              <ReplyTimeseriesPanel days={days} timeseries={timeseries} />

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                  gap: 16,
                }}
              >
                {/* Top campaigns + drilldown */}
                <div>
                  <div className="label" style={{ marginBottom: 6 }}>
                    Top campaigns by replies
                  </div>
                  {topRows.length === 0 ? (
                    <div className="muted" style={{ fontSize: 12 }}>
                      No campaign-matched replies in this window.
                    </div>
                  ) : (
                    <div
                      style={{
                        border: "1px solid var(--pw-border)",
                        borderRadius: 6,
                      }}
                    >
                      {topRows.map((row, i) => (
                        <div key={row.campaignId}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              padding: "8px 10px",
                              borderTop:
                                i > 0
                                  ? "1px solid var(--pw-border)"
                                  : undefined,
                              fontSize: 13,
                            }}
                          >
                            <span
                              style={{
                                flex: 1,
                                minWidth: 0,
                                overflowWrap: "anywhere",
                              }}
                            >
                              <span style={{ display: "block" }}>
                                {row.name}
                              </span>
                              <span
                                className="mono muted"
                                style={{ display: "block", fontSize: 10 }}
                              >
                                Campaign ID: {row.campaignId}
                              </span>
                            </span>
                            <span className="tabular muted">
                              {row.replies.toLocaleString()}
                            </span>
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              onClick={() => toggleDrill(row.campaignId)}
                              aria-expanded={
                                drill?.campaignId === row.campaignId
                              }
                              aria-controls={
                                drill?.campaignId === row.campaignId
                                  ? `${drillBaseId}-${i}`
                                  : undefined
                              }
                            >
                              {drill?.campaignId === row.campaignId
                                ? "Hide"
                                : "Details"}
                            </button>
                          </div>
                          {drill?.campaignId === row.campaignId ? (
                            <CampaignDrilldown
                              id={`${drillBaseId}-${i}`}
                              drill={drill}
                              campaigns={campaigns}
                              onRetry={() => loadDrill(row.campaignId)}
                            />
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Top senders */}
                <div>
                  <div className="label" style={{ marginBottom: 6 }}>
                    Top senders
                  </div>
                  {topSenders == null ? (
                    <div className="muted" style={{ fontSize: 12 }}>
                      Top senders unavailable.
                    </div>
                  ) : topSenders.senders.length === 0 ? (
                    <div className="muted" style={{ fontSize: 12 }}>
                      No senders in this window.
                    </div>
                  ) : (
                    <div
                      style={{
                        border: "1px solid var(--pw-border)",
                        borderRadius: 6,
                      }}
                    >
                      {topSenders.senders.map((s, i) => (
                        <div
                          key={s.recipient_email}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "8px 10px",
                            borderTop:
                              i > 0 ? "1px solid var(--pw-border)" : undefined,
                            fontSize: 13,
                          }}
                        >
                          <span
                            className="mono"
                            style={{
                              flex: 1,
                              minWidth: 0,
                              fontSize: 12,
                              overflowWrap: "anywhere",
                            }}
                          >
                            {s.recipient_email}
                          </span>
                          <span className="tabular muted">
                            {s.replies.toLocaleString()}
                          </span>
                          <time
                            dateTime={s.last_at}
                            className="muted tabular"
                            style={{ fontSize: 11 }}
                          >
                            {fmtDayMonth(s.last_at)}
                          </time>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function CampaignDrilldown({
  id,
  drill,
  campaigns,
  onRetry,
}: {
  id: string;
  drill: DrilldownState;
  campaigns: Campaign[] | null;
  onRetry: () => void;
}): ReactElement {
  return (
    <div
      id={id}
      style={{
        padding: "8px 10px 10px",
        borderTop: "1px solid var(--pw-border)",
        background: "var(--pw-bg-elev-2, transparent)",
        fontSize: 12,
      }}
    >
      {drill.loading ? (
        <div className="skel" style={{ height: 28 }} />
      ) : drill.err ? (
        <div className="notice">
          <span>Couldn&apos;t load campaign replies: {drill.err}</span>
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : drill.data ? (
        <>
          <div
            style={{
              display: "flex",
              gap: 16,
              flexWrap: "wrap",
              marginBottom: drill.data.recent.length > 0 ? 8 : 0,
            }}
          >
            <span>
              <span className="muted">Replies:</span>{" "}
              <span className="tabular">
                {drill.data.replies.toLocaleString()}
              </span>
            </span>
            <span>
              <span className="muted">Distinct replyers:</span>{" "}
              <span className="tabular">
                {drill.data.distinct_replyers.toLocaleString()}
              </span>
            </span>
            <span>
              <span className="muted">
                Reply rate (distinct replyers ÷ unique recipients):
              </span>{" "}
              <span className="tabular">
                {fmtReplyRate(drill.data.reply_rate)}
              </span>
            </span>
          </div>
          {drill.data.recent.length > 0 ? (
            <div style={{ display: "grid", gap: 6 }}>
              {drill.data.recent.slice(0, 5).map((r, i) => (
                <div key={`${r.recipient_email}-${r.received_at}-${i}`}>
                  <span className="mono" style={{ overflowWrap: "anywhere" }}>
                    {r.recipient_email}
                  </span>
                  {r.subject ? (
                    <span className="muted"> — {r.subject}</span>
                  ) : null}
                  <time
                    dateTime={r.received_at}
                    className="muted tabular"
                    style={{ marginLeft: 6 }}
                  >
                    {fmtDayMonth(r.received_at)}
                  </time>
                </div>
              ))}
            </div>
          ) : (
            <div className="muted">
              No recent reply previews for{" "}
              {campaignDisplayName(campaigns, drill.campaignId)}.
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function SummaryStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): ReactElement {
  return (
    <div>
      <div className="muted" style={{ fontSize: 11 }}>
        {label}
      </div>
      <div className="tabular" style={{ fontSize: 18, fontWeight: 600 }}>
        {value}
      </div>
      {hint ? (
        <div className="muted" style={{ fontSize: 10, lineHeight: 1.35 }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

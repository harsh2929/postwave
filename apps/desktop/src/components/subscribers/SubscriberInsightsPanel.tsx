import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  type ContactHistoryEvent,
  type EngagementScoreResponse,
  type SubscriberAISummary,
  type SubscriberDetail,
  type SubscriberRatingView,
  api,
  contactRatingsApi,
  engagementScoresApi,
  getSubscriberAISummary,
  listSubscriberHistory,
  setSubscriberRating,
} from "../../lib/api-client";
import { fmtDate } from "../../lib/format-date";
import { toast } from "../Toast";
import { engagementScoreDisplay } from "./engagement-score-helpers";
import { PredictiveCurrencySafetyNotice } from "./PredictiveCurrencySafetyNotice";
import { ratingSignalRows } from "./subscriber-insights";

interface SubscriberInsightsPanelProps {
  subscriberId: string | number | null | undefined;
  detail: SubscriberDetail;
  canMutate: boolean;
  onHistoryChange: (
    history: ContactHistoryEvent[],
    nextCursor?: string,
  ) => void;
  formatRelativeTime: (timestamp: string | undefined | null) => string;
}

type EngagementScoreState = "loading" | "loaded" | "unavailable" | "error";
type RatingViewState = "loading" | "loaded" | "none" | "unavailable" | "error";

function churnRiskBadge(risk: number): { label: string; className: string } {
  const normalizedRisk = Math.max(0, Math.min(1, risk));
  if (normalizedRisk >= 0.66) {
    return { label: "High risk", className: "badge danger" };
  }
  if (normalizedRisk >= 0.33) {
    return { label: "Medium risk", className: "badge warning" };
  }
  return { label: "Low risk", className: "badge success" };
}

function impactBadgeClass(impact: string): string {
  switch (impact) {
    case "high":
      return "badge danger";
    case "medium":
      return "badge warning";
    default:
      return "badge";
  }
}

function dataSufficiencyBadge(band: string): {
  label: string;
  className: string;
  tip: string;
} {
  switch (band) {
    case "sufficient":
      return {
        label: "Sufficient data",
        className: "badge success",
        tip: "The model had enough signal to score this profile with confidence.",
      };
    case "limited":
      return {
        label: "Limited data",
        className: "badge warning",
        tip: "Sparse history — treat these figures as directional.",
      };
    default:
      return {
        label: "Insufficient data",
        className: "badge",
        tip: "Too little history to score this profile reliably.",
      };
  }
}

function useCurrentSubscriberGuard(): () => boolean {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(() => mounted.current, []);
}

function useAiSummary(
  subscriberId: string | number | null | undefined,
  isCurrent: () => boolean,
) {
  const [summary, setSummary] = useState<SubscriberAISummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const requestId = useRef(0);
  const inFlightRef = useRef(false);

  const load = useCallback(
    async (refresh: boolean): Promise<void> => {
      if (subscriberId == null || inFlightRef.current) return;
      const currentRequest = ++requestId.current;
      inFlightRef.current = true;
      setLoading(true);
      setError(null);
      let result: Awaited<ReturnType<typeof getSubscriberAISummary>>;
      try {
        result = await getSubscriberAISummary(subscriberId, { refresh });
      } catch {
        inFlightRef.current = false;
        if (!isCurrent() || requestId.current !== currentRequest) return;
        setLoading(false);
        setError(
          "Couldn't load the AI summary. Check your connection and retry.",
        );
        return;
      }
      inFlightRef.current = false;
      if (!isCurrent() || requestId.current !== currentRequest) return;
      setLoading(false);
      if (result.error) {
        if (result.error.kind === "http" && result.error.status === 404) {
          setHidden(true);
        } else {
          setHidden(false);
          setError(
            "Couldn't load the AI summary. Retry when the service is available.",
          );
        }
        return;
      }
      setHidden(false);
      setSummary(result.data);
    },
    [isCurrent, subscriberId],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  return {
    error,
    expanded,
    hidden,
    loading,
    load,
    setExpanded,
    summary,
  };
}

function useEngagementScore(subscriberId: string | number | null | undefined) {
  const [score, setScore] = useState<EngagementScoreResponse | null>(null);
  const [state, setState] = useState<EngagementScoreState>("loading");

  useEffect(() => {
    let cancelled = false;
    setScore(null);
    if (subscriberId == null) {
      setState("unavailable");
      return () => {
        cancelled = true;
      };
    }
    setState("loading");
    void (async () => {
      let result: Awaited<ReturnType<typeof engagementScoresApi.get>>;
      try {
        result = await engagementScoresApi.get(String(subscriberId));
      } catch {
        if (!cancelled) setState("error");
        return;
      }
      if (cancelled) return;
      if (result.error) {
        setState(
          result.error.kind === "http" && result.error.status === 404
            ? "unavailable"
            : "error",
        );
        return;
      }
      setScore(result.data);
      setState("loaded");
    })();
    return () => {
      cancelled = true;
    };
  }, [subscriberId]);

  return { score, state };
}

function useRatingController({
  subscriberId,
  detail,
  canMutate,
  onHistoryChange,
  isCurrent,
}: Omit<SubscriberInsightsPanelProps, "formatRelativeTime"> & {
  isCurrent: () => boolean;
}) {
  const detailRating = (detail as SubscriberDetail & { rating?: number | null })
    .rating;
  const [rating, setRating] = useState<number | null>(detailRating ?? null);
  const [ratingBusy, setRatingBusy] = useState(false);
  const [view, setView] = useState<SubscriberRatingView | null>(null);
  const [viewState, setViewState] = useState<RatingViewState>("loading");
  const [viewError, setViewError] = useState<string | null>(null);
  const [recomputeBusy, setRecomputeBusy] = useState(false);
  const ratingRequestInFlight = useRef(false);
  const recomputeRequestInFlight = useRef(false);
  const viewRequestId = useRef(0);

  useEffect(() => {
    if (detailRating !== undefined) setRating(detailRating);
  }, [detailRating]);

  const loadView = useCallback(async (): Promise<void> => {
    const currentRequest = ++viewRequestId.current;
    if (subscriberId == null) {
      setViewState("unavailable");
      return;
    }
    setViewError(null);
    setViewState("loading");
    let result: Awaited<ReturnType<typeof contactRatingsApi.get>>;
    try {
      result = await contactRatingsApi.get(subscriberId);
    } catch {
      if (!isCurrent() || viewRequestId.current !== currentRequest) return;
      setViewError("Rating signals are temporarily unavailable.");
      setViewState("error");
      return;
    }
    if (!isCurrent() || viewRequestId.current !== currentRequest) return;
    if (result.error) {
      if (result.error.kind === "http" && result.error.status === 404) {
        setView(null);
        setViewState("none");
      } else {
        setViewError(result.error.message);
        setViewState("error");
      }
      return;
    }
    setView(result.data);
    setViewState("loaded");
  }, [isCurrent, subscriberId]);

  useEffect(() => {
    void loadView();
  }, [loadView]);

  const setManualRating = async (next: number): Promise<void> => {
    if (subscriberId == null || !canMutate || ratingRequestInFlight.current) {
      return;
    }
    ratingRequestInFlight.current = true;
    setRatingBusy(true);
    const previousRating = rating;
    const nextRating = previousRating === next ? 0 : next;
    setRating(nextRating === 0 ? null : nextRating);
    let result: Awaited<ReturnType<typeof setSubscriberRating>>;
    try {
      result = await setSubscriberRating(subscriberId, nextRating);
    } catch {
      ratingRequestInFlight.current = false;
      if (isCurrent()) {
        setRatingBusy(false);
        setRating(previousRating);
        toast.error("Couldn't set rating. Check your connection and retry.");
      }
      return;
    }
    if (!isCurrent()) return;
    if (result.error) {
      ratingRequestInFlight.current = false;
      setRatingBusy(false);
      setRating(previousRating);
      toast.error(`Couldn't set rating: ${result.error.message}`);
      return;
    }
    setRating(result.data?.rating ?? null);
    let history: Awaited<ReturnType<typeof listSubscriberHistory>>;
    try {
      history = await listSubscriberHistory(subscriberId, { limit: 50 });
    } catch {
      ratingRequestInFlight.current = false;
      if (isCurrent()) {
        setRatingBusy(false);
        toast.error("Rating saved, but contact history couldn't be refreshed.");
      }
      return;
    }
    if (!isCurrent()) return;
    ratingRequestInFlight.current = false;
    setRatingBusy(false);
    if (history.data) {
      onHistoryChange(history.data.items ?? [], history.data.next_cursor);
    }
  };

  const recompute = async (): Promise<void> => {
    if (!canMutate || recomputeRequestInFlight.current) return;
    recomputeRequestInFlight.current = true;
    setRecomputeBusy(true);
    let result: Awaited<ReturnType<typeof contactRatingsApi.recompute>>;
    try {
      result = await contactRatingsApi.recompute();
    } catch {
      recomputeRequestInFlight.current = false;
      if (isCurrent()) {
        setRecomputeBusy(false);
        toast.error(
          "Couldn't recompute ratings. Check your connection and retry.",
        );
      }
      return;
    }
    if (!isCurrent()) return;
    if (result.error) {
      recomputeRequestInFlight.current = false;
      setRecomputeBusy(false);
      toast.error(`Couldn't recompute: ${result.error.message}`);
      return;
    }
    toast.success(
      `Recomputed ratings tenant-wide: ${result.data.updated.toLocaleString()} updated of ${result.data.scanned.toLocaleString()} scanned (${result.data.window_days}d window)`,
    );
    void loadView();
    if (subscriberId != null) {
      let subscriberResult: Awaited<ReturnType<typeof api.getSubscriber>>;
      try {
        subscriberResult = await api.getSubscriber(subscriberId);
      } catch {
        recomputeRequestInFlight.current = false;
        if (isCurrent()) {
          setRecomputeBusy(false);
          toast.error(
            "Ratings were recomputed, but this subscriber's rating couldn't be refreshed.",
          );
        }
        return;
      }
      if (!isCurrent()) return;
      const updatedRating = (
        subscriberResult.data as
          | (SubscriberDetail & { rating?: number | null })
          | undefined
      )?.rating;
      if (updatedRating !== undefined) setRating(updatedRating);
    }
    recomputeRequestInFlight.current = false;
    setRecomputeBusy(false);
  };

  return {
    loadView,
    rating,
    ratingBusy,
    recompute,
    recomputeBusy,
    setManualRating,
    view,
    viewError,
    viewState,
  };
}

export function SubscriberInsightsPanel(
  props: SubscriberInsightsPanelProps,
): ReactElement {
  const subscriberKey =
    props.subscriberId == null
      ? "none"
      : `${typeof props.subscriberId}:${String(props.subscriberId)}`;
  return <SubscriberInsightsPanelState key={subscriberKey} {...props} />;
}

function SubscriberInsightsPanelState({
  subscriberId,
  detail,
  canMutate,
  onHistoryChange,
  formatRelativeTime,
}: SubscriberInsightsPanelProps): ReactElement {
  const isCurrent = useCurrentSubscriberGuard();
  const aiSummary = useAiSummary(subscriberId, isCurrent);
  const engagementScore = useEngagementScore(subscriberId);
  const rating = useRatingController({
    subscriberId,
    detail,
    canMutate,
    onHistoryChange,
    isCurrent,
  });

  return (
    <>
      <AiSummaryCard {...aiSummary} formatRelativeTime={formatRelativeTime} />
      <ManualRatingRow
        rating={rating.rating}
        busy={rating.ratingBusy}
        canMutate={canMutate}
        onChange={rating.setManualRating}
      />
      <EngagementScoreRow
        score={engagementScore.score}
        state={engagementScore.state}
        formatRelativeTime={formatRelativeTime}
      />
      {detail.prediction ? (
        <PredictiveInsightsCard
          prediction={detail.prediction}
          formatRelativeTime={formatRelativeTime}
        />
      ) : null}
      <RatingSignalsPanel
        canMutate={canMutate}
        view={rating.view}
        state={rating.viewState}
        error={rating.viewError}
        recomputeBusy={rating.recomputeBusy}
        onRetry={rating.loadView}
        onRecompute={rating.recompute}
        formatRelativeTime={formatRelativeTime}
      />
    </>
  );
}

function AiSummaryCard({
  summary,
  loading,
  hidden,
  error,
  expanded,
  setExpanded,
  load,
  formatRelativeTime,
}: ReturnType<typeof useAiSummary> & {
  formatRelativeTime: SubscriberInsightsPanelProps["formatRelativeTime"];
}): ReactElement | null {
  const refreshHelpId = useId();
  if (hidden || (!loading && !summary && !error)) return null;
  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: 10,
        margin: "4px 0 10px",
        background: "color-mix(in srgb, var(--pw-accent) 4%, transparent)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            color: "var(--pw-fg-muted)",
          }}
        >
          AI summary
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-xs btn-ghost"
          onClick={() => void load(true)}
          disabled={loading}
          aria-describedby={refreshHelpId}
          style={{ fontSize: 11 }}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div
        id={refreshHelpId}
        className="muted"
        style={{ fontSize: 10, marginBottom: 6 }}
      >
        Refresh regenerates this summary without using cached results.
      </div>
      {error && summary ? (
        <div role="alert" style={{ fontSize: 11, marginBottom: 6 }}>
          {error} The previous summary remains visible.
        </div>
      ) : null}
      {loading && !summary ? (
        <div className="muted" style={{ fontSize: 12 }} role="status">
          Generating subscriber summary…
        </div>
      ) : error && !summary ? (
        <div role="alert" style={{ fontSize: 12 }}>
          {error}
          <div style={{ marginTop: 6 }}>
            <button
              type="button"
              className="btn btn-xs"
              onClick={() => void load(false)}
            >
              Retry summary
            </button>
          </div>
        </div>
      ) : summary ? (
        <>
          <p
            style={{
              fontSize: 13,
              lineHeight: 1.45,
              margin: 0,
              color: "var(--pw-fg)",
            }}
          >
            {summary.summary}
          </p>
          {summary.drivers && summary.drivers.length > 0 ? (
            <div style={{ marginTop: 6 }}>
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                onClick={() => setExpanded((current) => !current)}
                aria-expanded={expanded}
                style={{ fontSize: 11, padding: "1px 4px" }}
              >
                {expanded ? "▾" : "▸"} Why is this person here?
              </button>
              {expanded ? (
                <ul
                  style={{
                    margin: "4px 0 0",
                    padding: "0 0 0 16px",
                    listStyle: "disc",
                    fontSize: 12,
                    color: "var(--pw-fg-muted)",
                  }}
                >
                  {summary.drivers.map((driver) => (
                    <li key={driver.key} style={{ marginBottom: 2 }}>
                      <span style={{ color: "var(--pw-fg)" }}>
                        {driver.label}:
                      </span>{" "}
                      {driver.value}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {summary.cache_hit ? (
            <div className="muted" style={{ fontSize: 10, marginTop: 6 }}>
              Cached · last updated {formatRelativeTime(summary.last_updated)}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ManualRatingRow({
  rating,
  busy,
  canMutate,
  onChange,
}: {
  rating: number | null;
  busy: boolean;
  canMutate: boolean;
  onChange: (rating: number) => Promise<void>;
}): ReactElement {
  const guidanceId = useId();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        margin: "4px 0 8px",
      }}
    >
      <span className="muted" style={{ fontSize: 11 }}>
        Rating
      </span>
      <StarRating
        value={rating ?? 0}
        busy={busy}
        canMutate={canMutate}
        describedBy={guidanceId}
        onChange={(next) => void onChange(next)}
      />
      {rating != null ? (
        <span className="muted tabular" style={{ fontSize: 11 }}>
          {rating}/5
        </span>
      ) : (
        <span className="muted" style={{ fontSize: 11 }}>
          Unrated
        </span>
      )}
      <span
        id={guidanceId}
        className="muted"
        role="status"
        style={{ fontSize: 11 }}
      >
        {busy
          ? "Saving rating."
          : !canMutate
            ? "Viewer role can inspect the rating but can't change it."
            : "Choose the current star again to clear a manual rating."}
      </span>
    </div>
  );
}

function EngagementScoreRow({
  score,
  state,
  formatRelativeTime,
}: {
  score: EngagementScoreResponse | null;
  state: EngagementScoreState;
  formatRelativeTime: SubscriberInsightsPanelProps["formatRelativeTime"];
}): ReactElement | null {
  if (state === "unavailable") return null;
  const view = score
    ? engagementScoreDisplay(
        score.score,
        score.computed_at
          ? `${fmtDate(score.computed_at)} (${formatRelativeTime(
              score.computed_at,
            )})`
          : undefined,
      )
    : null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 6,
        margin: "0 0 8px",
        flexWrap: "wrap",
      }}
    >
      <span className="muted" style={{ fontSize: 11 }}>
        Engagement score
      </span>
      {state === "loading" ? (
        <span className="skel" style={{ width: 60, height: 12 }} />
      ) : state === "error" ? (
        <span className="muted" style={{ fontSize: 11 }}>
          Couldn&apos;t load score.
        </span>
      ) : view ? (
        <>
          <span
            className={view.scored ? "tabular" : "muted"}
            style={{
              fontSize: view.scored ? 13 : 11,
              fontWeight: view.scored ? 600 : 400,
            }}
          >
            {view.label}
          </span>
          {view.detail ? (
            <span className="muted" style={{ fontSize: 11 }}>
              · {view.detail}
            </span>
          ) : null}
        </>
      ) : null}
      <span className="muted" style={{ flexBasis: "100%", fontSize: 10 }}>
        Computed from the last 90 days of events and the workspace&apos;s
        scoring-rule weights.
      </span>
    </div>
  );
}

function PredictiveInsightsCard({
  prediction,
  formatRelativeTime,
}: {
  prediction: NonNullable<SubscriberDetail["prediction"]>;
  formatRelativeTime: SubscriberInsightsPanelProps["formatRelativeTime"];
}): ReactElement {
  const churn = churnRiskBadge(prediction.churn_risk);
  const sufficiency = dataSufficiencyBadge(prediction.data_sufficiency);
  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: 10,
        margin: "0 0 10px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            color: "var(--pw-fg-muted)",
          }}
        >
          Insights
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <span className={sufficiency.className}>{sufficiency.label}</span>
        {prediction.confidence > 0 ? (
          <span className="muted tabular" style={{ fontSize: 11 }}>
            Model confidence {Math.round(prediction.confidence * 100)}%
          </span>
        ) : null}
      </div>
      <div className="muted" style={{ fontSize: 10, margin: "-4px 0 8px" }}>
        {sufficiency.tip}
      </div>
      <PredictiveCurrencySafetyNotice />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: prediction.churn_drivers.length > 0 ? 6 : 0,
        }}
      >
        <span className="muted" style={{ fontSize: 11 }}>
          Churn risk
        </span>
        <span className={churn.className}>{churn.label}</span>
        <span className="muted tabular" style={{ fontSize: 11 }}>
          {Math.round(Math.max(0, Math.min(1, prediction.churn_risk)) * 100)}%
        </span>
      </div>
      {prediction.churn_drivers.length > 0 ? (
        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {prediction.churn_drivers.slice(0, 3).map((driver) => (
            <li
              key={driver.key}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(100px, auto) minmax(0, 1fr) auto",
                alignItems: "baseline",
                gap: 8,
                fontSize: 12,
              }}
            >
              <span style={{ color: "var(--pw-fg)" }}>{driver.label}</span>
              <span
                className="muted"
                style={{
                  overflowWrap: "anywhere",
                  whiteSpace: "normal",
                }}
              >
                {driver.value}
              </span>
              <span
                className={impactBadgeClass(driver.impact)}
                style={{ fontSize: 10 }}
              >
                {driver.impact} impact
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {prediction.calculated_at ? (
        <div className="muted" style={{ fontSize: 10, marginTop: 6 }}>
          Scored{" "}
          <time dateTime={prediction.calculated_at}>
            {formatRelativeTime(prediction.calculated_at)}
          </time>
        </div>
      ) : null}
    </div>
  );
}

function RatingSignalsPanel({
  canMutate,
  view,
  state,
  error,
  recomputeBusy,
  onRetry,
  onRecompute,
  formatRelativeTime,
}: {
  canMutate: boolean;
  view: SubscriberRatingView | null;
  state: RatingViewState;
  error: string | null;
  recomputeBusy: boolean;
  onRetry: () => Promise<void>;
  onRecompute: () => Promise<void>;
  formatRelativeTime: SubscriberInsightsPanelProps["formatRelativeTime"];
}): ReactElement | null {
  const recomputeGuidanceId = useId();
  if (state === "unavailable") return null;
  return (
    <details style={{ margin: "0 0 8px" }}>
      <summary className="muted" style={{ cursor: "pointer", fontSize: 11 }}>
        Rating signals
      </summary>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          padding: "6px 8px",
          marginTop: 4,
          background: "var(--pw-bg-elev-2)",
          borderRadius: 4,
          fontSize: 12,
        }}
      >
        <RatingSignalsBody
          view={view}
          state={state}
          error={error}
          onRetry={onRetry}
          formatRelativeTime={formatRelativeTime}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 2,
          }}
        >
          <button
            type="button"
            className="btn btn-xs"
            style={{ fontSize: 11 }}
            onClick={() => void onRecompute()}
            disabled={recomputeBusy}
            aria-disabled={!canMutate || undefined}
            aria-describedby={recomputeGuidanceId}
          >
            {recomputeBusy ? "Recomputing…" : "Recompute (tenant-wide)"}
          </button>
          <span
            id={recomputeGuidanceId}
            className="muted"
            role="status"
            style={{ fontSize: 10 }}
          >
            {!canMutate ? "Viewer role can't start rating recomputation. " : ""}
            Sweeps every subscriber in the workspace without a manual rating;
            manual ratings are never overwritten.
          </span>
        </div>
      </div>
    </details>
  );
}

function RatingSignalsBody({
  view,
  state,
  error,
  onRetry,
  formatRelativeTime,
}: {
  view: SubscriberRatingView | null;
  state: RatingViewState;
  error: string | null;
  onRetry: () => Promise<void>;
  formatRelativeTime: SubscriberInsightsPanelProps["formatRelativeTime"];
}): ReactElement | null {
  if (state === "loading" && !view) {
    return <div className="skel" style={{ height: 28 }} />;
  }
  if (state === "error" && !view) {
    return (
      <div
        role="alert"
        style={{ display: "flex", alignItems: "center", gap: 8 }}
      >
        <span className="muted" style={{ fontSize: 12 }}>
          Couldn&apos;t load rating signals{error ? `: ${error}` : "."}
        </span>
        <button
          type="button"
          className="btn btn-xs"
          style={{ fontSize: 11 }}
          onClick={() => void onRetry()}
        >
          Retry
        </button>
      </div>
    );
  }
  if (state === "none") {
    return (
      <div className="muted" style={{ fontSize: 12 }}>
        No rating signal recorded yet — neither a manual rating nor an
        engagement score exists for this subscriber.
      </div>
    );
  }
  if (!view) return null;
  return (
    <>
      {state === "error" ? (
        <div
          role="alert"
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          <span className="muted" style={{ fontSize: 12 }}>
            Couldn&apos;t refresh rating signals{error ? `: ${error}` : "."}
          </span>
          <button
            type="button"
            className="btn btn-xs"
            style={{ fontSize: 11 }}
            onClick={() => void onRetry()}
          >
            Retry
          </button>
        </div>
      ) : null}
      {ratingSignalRows(view).map((row) => (
        <div
          key={row.label}
          style={{
            display: "grid",
            gridTemplateColumns: "130px 1fr",
            gap: 8,
          }}
        >
          <span className="muted">{row.label}</span>
          <span>
            {row.label === "Score computed"
              ? `${fmtDate(row.value)} (${formatRelativeTime(row.value)})`
              : row.value}
          </span>
        </div>
      ))}
    </>
  );
}

function StarRating({
  value,
  busy,
  canMutate,
  describedBy,
  onChange,
}: {
  value: number;
  busy: boolean;
  canMutate: boolean;
  describedBy: string;
  onChange: (rating: number) => void;
}): ReactElement {
  const unavailable = busy || !canMutate;
  const moveSelection = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    current: number,
  ): void => {
    if (
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229 ||
      unavailable
    ) {
      return;
    }
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = current === 5 ? 1 : current + 1;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = current === 1 ? 5 : current - 1;
    } else if (event.key === "Home") {
      next = 1;
    } else if (event.key === "End") {
      next = 5;
    }
    if (next == null) return;
    event.preventDefault();
    const target =
      event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
        `button[data-rating="${next}"]`,
      );
    target?.focus();
    onChange(next);
  };
  return (
    <div
      role="radiogroup"
      aria-label="Rating"
      aria-describedby={describedBy}
      style={{ display: "inline-flex", gap: 2 }}
    >
      {[1, 2, 3, 4, 5].map((rating) => {
        const filled = rating <= value;
        return (
          <button
            key={rating}
            type="button"
            role="radio"
            aria-checked={value === rating}
            aria-label={`${rating} star${rating === 1 ? "" : "s"}`}
            aria-disabled={!canMutate || undefined}
            aria-describedby={describedBy}
            disabled={busy}
            data-rating={rating}
            tabIndex={
              value === rating || (value === 0 && rating === 1) ? 0 : -1
            }
            onClick={() => {
              if (!unavailable) onChange(rating);
            }}
            onKeyDown={(event) => moveSelection(event, rating)}
            style={{
              background: "transparent",
              border: "none",
              cursor: unavailable ? "default" : "pointer",
              padding: 2,
              fontSize: 16,
              color: filled ? "var(--pw-warning)" : "var(--pw-fg-subtle)",
              opacity: unavailable ? 0.7 : 1,
            }}
          >
            {filled ? "★" : "☆"}
          </button>
        );
      })}
    </div>
  );
}

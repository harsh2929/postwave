/**
 * BenchmarksCard — an honest selected-window comparison against the benchmark
 * service's illustrative industry baseline.
 *
 * Workspace rates use distinct campaign-recipient evidence. Open/click prefer
 * uniquely delivered recipients with a bounded unique-sent fallback; bounce
 * uses uniquely sent recipients. Gross events and campaign count are never
 * substituted. Benchmark provenance remains visible beside the chart.
 */

import {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useState,
} from "react";

import {
  type DashboardBenchmarksResponse,
  type DashboardRange,
  type DashboardStatsResponse,
  api,
} from "../../lib/api-client";
import {
  rateFromCounts,
  rateFromUniqueRecipients,
} from "../../lib/dashboard-helpers";
import { AccessibleChartData } from "../charts/AccessibleChartData";
import { dux025Provenance } from "../charts/dux-025-visual-manifest";

import "./dashboard-insight-cards.css";

interface Props {
  stats: DashboardStatsResponse | null;
  range: DashboardRange;
}

type BenchmarkDirection = "higher" | "lower" | "context";
type ComparisonTone = "positive" | "attention" | "neutral";

interface BenchmarkViewRow {
  metric: string;
  label: string;
  direction: BenchmarkDirection;
  directionLabel: string;
  own: number | null;
  average: number | null;
  source: string;
  comparison: {
    label: string;
    detail: string;
    tone: ComparisonTone;
  };
}

const METRIC_META: Record<
  string,
  { label: string; direction: BenchmarkDirection }
> = {
  opens: { label: "Open rate", direction: "higher" },
  clicks: { label: "Click rate", direction: "higher" },
  bounces: { label: "Bounce rate", direction: "lower" },
  unsubs: { label: "Unsubscribe rate", direction: "lower" },
};

const MATCH_TOLERANCE = 0.00005;
const MIN_VISUAL_MAX = 0.5;

function fmtPct(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(2)}%`;
}

function metricMeta(metric: string): {
  label: string;
  direction: BenchmarkDirection;
  directionLabel: string;
} {
  const meta = METRIC_META[metric] ?? {
    label: metric,
    direction: "context" as const,
  };
  const directionLabel =
    meta.direction === "higher"
      ? "Higher is better"
      : meta.direction === "lower"
        ? "Lower is better"
        : "Context only";
  return { ...meta, directionLabel };
}

function validAverage(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : null;
}

function validCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function compareRate(
  own: number | null,
  average: number | null,
  direction: BenchmarkDirection,
): BenchmarkViewRow["comparison"] {
  if (own === null) {
    return {
      label: "Awaiting your data",
      detail: "Workspace rate unavailable",
      tone: "neutral",
    };
  }
  if (average === null) {
    return {
      label: "No reference",
      detail: "Benchmark rate unavailable",
      tone: "neutral",
    };
  }
  if (direction === "context") {
    return {
      label: "Context only",
      detail: `${Math.abs(own - average) * 100 < MATCH_TOLERANCE ? "0.00" : (Math.abs(own - average) * 100).toFixed(2)} pp difference`,
      tone: "neutral",
    };
  }

  const advantage = direction === "lower" ? average - own : own - average;
  if (Math.abs(advantage) <= MATCH_TOLERANCE) {
    return {
      label: "In line",
      detail: "Within 0.01 pp of benchmark",
      tone: "neutral",
    };
  }
  const points = `${Math.abs(advantage * 100).toFixed(2)} pp`;
  return advantage > 0
    ? { label: "Ahead", detail: `${points} better`, tone: "positive" }
    : {
        label: "Opportunity",
        detail: `${points} from benchmark`,
        tone: "attention",
      };
}

function toViewRows(
  rows: readonly unknown[],
  ownRates: Record<string, number | null>,
): BenchmarkViewRow[] {
  const seen = new Set<string>();
  return rows.flatMap((candidate) => {
    if (candidate === null || typeof candidate !== "object") return [];
    const row = candidate as Record<string, unknown>;
    const metric = typeof row.metric === "string" ? row.metric.trim() : "";
    if (!metric || seen.has(metric)) return [];
    seen.add(metric);
    const meta = metricMeta(metric);
    const own = ownRates[metric] ?? null;
    const average = validAverage(row.average);
    const source =
      typeof row.source === "string" && row.source.trim()
        ? row.source.trim()
        : "Source not supplied";
    return [
      {
        metric,
        label: meta.label,
        direction: meta.direction,
        directionLabel: meta.directionLabel,
        own,
        average,
        source,
        comparison: compareRate(own, average, meta.direction),
      },
    ];
  });
}

function rangeDescription(range: DashboardRange): string {
  switch (range) {
    case "7d":
      return "selected 7-day window";
    case "90d":
      return "selected 90-day window";
    default:
      return "selected 30-day window";
  }
}

export function BenchmarksCard({ stats, range }: Props): ReactElement {
  const titleId = useId();
  const workspaceWindow = rangeDescription(range);
  const [bench, setBench] = useState<DashboardBenchmarksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setBench(null);
    void (async () => {
      try {
        const res = await api.getDashboardBenchmarks();
        if (cancelled) return;
        if (res.error) {
          setFailed(true);
        } else if (res.data) {
          setBench(res.data);
        } else {
          setFailed(true);
        }
      } catch {
        if (!cancelled) {
          setFailed(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  if (loading) {
    return (
      <BenchmarksFrame titleId={titleId} workspaceWindow={workspaceWindow} busy>
        <div
          className="dashboard-insight-state dashboard-insight-state--loading dashboard-benchmark-skeletons"
          role="status"
          aria-label="Loading industry benchmarks"
        >
          <span className="visually-hidden">Loading industry benchmarks…</span>
          {[0, 1, 2].map((key) => (
            <div className="dashboard-benchmark-skeleton" key={key}>
              <div className="skel dashboard-benchmark-skeleton__label" />
              <div className="skel dashboard-benchmark-skeleton__bar" />
            </div>
          ))}
        </div>
      </BenchmarksFrame>
    );
  }

  if (failed) {
    return (
      <BenchmarksFrame titleId={titleId} workspaceWindow={workspaceWindow}>
        <div
          className="dashboard-insight-state dashboard-insight-state--error"
          role="alert"
        >
          <div className="dashboard-insight-state__copy">
            <h3>Industry comparison unavailable</h3>
            <p>
              We couldn&apos;t load industry benchmarks. Check your connection
              and try again.
            </p>
          </div>
          <button
            type="button"
            className="btn dashboard-insight-state__action"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            Retry
          </button>
        </div>
      </BenchmarksFrame>
    );
  }

  if (!stats || !bench) {
    return (
      <BenchmarksFrame titleId={titleId} workspaceWindow={workspaceWindow}>
        <div className="dashboard-insight-state" role="status">
          <div className="dashboard-insight-state__copy">
            <h3>Waiting for workspace statistics</h3>
            <p>Your comparison will appear when dashboard totals are ready.</p>
          </div>
        </div>
      </BenchmarksFrame>
    );
  }

  const uniqueOpens = validCount(stats.unique_opens_30d);
  const uniqueClicks = validCount(stats.unique_clicks_30d);
  const uniqueBounces = validCount(stats.unique_bounces_30d);
  const uniqueDelivered = validCount(stats.unique_delivered_30d);
  const uniqueSent = validCount(stats.unique_sent_30d);

  if (
    uniqueOpens === null ||
    uniqueClicks === null ||
    uniqueBounces === null ||
    uniqueDelivered === null ||
    uniqueSent === null ||
    (uniqueDelivered === 0 && uniqueSent === 0)
  ) {
    return (
      <BenchmarksFrame titleId={titleId} workspaceWindow={workspaceWindow}>
        <div className="dashboard-insight-state" role="status">
          <div className="dashboard-insight-state__copy">
            <h3>Verified recipient rates unavailable</h3>
            <p>
              Comparisons need unique open, click, bounce, delivered, and sent
              counts. Gross event totals and campaign count are never used as
              substitutes.
            </p>
          </div>
        </div>
      </BenchmarksFrame>
    );
  }

  const ownRates: Record<string, number | null> = {
    opens: rateFromUniqueRecipients(uniqueOpens, uniqueDelivered, uniqueSent),
    clicks: rateFromUniqueRecipients(uniqueClicks, uniqueDelivered, uniqueSent),
    bounces: rateFromCounts(uniqueBounces, uniqueSent),
    // DashboardStats does not expose unsubscribe totals yet.
    unsubs: null,
  };
  const rawRows = Array.isArray(bench.rows) ? bench.rows : [];
  const rows = toViewRows(rawRows, ownRates);
  const benchmarkNote =
    typeof bench.note === "string" && bench.note.trim()
      ? bench.note.trim()
      : "No benchmark methodology note supplied.";

  if (rows.length === 0) {
    return (
      <BenchmarksFrame titleId={titleId} workspaceWindow={workspaceWindow}>
        <div className="dashboard-insight-state" role="status">
          <div className="dashboard-insight-state__copy">
            <h3>No benchmark metrics available</h3>
            <p>
              The current comparison cohort did not return any rate metrics.
            </p>
          </div>
        </div>
      </BenchmarksFrame>
    );
  }

  const visualMax = Math.max(
    MIN_VISUAL_MAX,
    ...rows.flatMap((row) =>
      [row.own, row.average].filter((value): value is number => value !== null),
    ),
  );

  return (
    <BenchmarksFrame titleId={titleId} workspaceWindow={workspaceWindow}>
      <div className="dashboard-benchmark-body">
        <div
          className="dashboard-benchmark-legend"
          aria-label={`Chart legend. Uniform scale from zero to ${fmtPct(visualMax)}.`}
        >
          <span>
            <i
              className="dashboard-benchmark-legend__self"
              aria-hidden="true"
            />
            You
          </span>
          <span>
            <i
              className="dashboard-benchmark-legend__reference"
              aria-hidden="true"
            />
            Benchmark
          </span>
          <span className="dashboard-benchmark-legend__scale">
            Uniform scale 0–{fmtPct(visualMax)}
          </span>
        </div>

        <ul className="dashboard-benchmark-list" aria-label="Rate comparisons">
          {rows.map((row) => (
            <BenchmarkRow key={row.metric} row={row} visualMax={visualMax} />
          ))}
        </ul>

        <div className="dashboard-benchmark-methodology">
          <strong>Methodology</strong>
          <p>{benchmarkNote}</p>
          <p>
            Open and click rates use {uniqueDelivered.toLocaleString()} unique
            delivered campaign-recipient pairs when each numerator is covered,
            with {uniqueSent.toLocaleString()} unique sent pairs as a bounded
            fallback. Bounce rate uses unique sent pairs. Window:{" "}
            {workspaceWindow}. Benchmark snapshot time was not supplied.
          </p>
        </div>

        <AccessibleChartData
          title="Workspace rates compared with industry benchmarks"
          summary={`${rows.length} benchmark metrics use unique campaign-recipient evidence: delivered with a bounded sent fallback for open and click, and sent for bounce. ${benchmarkNote}`}
          rowHeaderLabel="Metric"
          columns={[
            { key: "workspace", label: "Workspace rate (%)" },
            { key: "benchmark", label: "Industry benchmark (%)" },
            { key: "comparison", label: "Comparison" },
            { key: "direction", label: "Preferred direction" },
            { key: "source", label: "Benchmark source" },
          ]}
          rows={rows.map((row) => ({
            key: row.metric,
            label: row.label,
            values: {
              workspace: fmtPct(row.own),
              benchmark: fmtPct(row.average),
              comparison: `${row.comparison.label}: ${row.comparison.detail}`,
              direction: row.directionLabel,
              source: row.source,
            },
            exportValues: {
              workspace: row.own == null ? null : row.own * 100,
              benchmark: row.average == null ? null : row.average * 100,
              comparison: `${row.comparison.label}: ${row.comparison.detail}`,
              direction: row.directionLabel,
              source: row.source,
            },
          }))}
          provenance={dux025Provenance("dashboardBenchmarks", {
            scope: `Current workspace · ${workspaceWindow} · ${uniqueDelivered.toLocaleString()} unique delivered · ${uniqueSent.toLocaleString()} unique sent`,
            note: `${benchmarkNote} Open/click use unique delivered with a bounded unique-sent fallback; bounce uses unique sent. Benchmark snapshot time was not supplied.`,
          })}
          exportFileName="workspace-industry-rate-benchmarks.csv"
          exportPrivacy="confidential"
        />
      </div>
    </BenchmarksFrame>
  );
}

function BenchmarkRow({
  row,
  visualMax,
}: {
  row: BenchmarkViewRow;
  visualMax: number;
}): ReactElement {
  const selfPosition =
    row.own === null ? 0 : Math.min(Math.max(row.own / visualMax, 0), 1);
  const referencePosition =
    row.average === null
      ? 0
      : Math.min(Math.max(row.average / visualMax, 0), 1);
  const style = {
    "--dashboard-benchmark-self": `${selfPosition * 100}%`,
    "--dashboard-benchmark-reference": `${referencePosition * 100}%`,
  } as CSSProperties;
  return (
    <li className="dashboard-benchmark-row">
      <div className="dashboard-benchmark-row__header">
        <div className="dashboard-benchmark-row__identity">
          <strong>{row.label}</strong>
          <span>{row.directionLabel}</span>
        </div>
        <span
          className={`dashboard-benchmark-comparison dashboard-benchmark-comparison--${row.comparison.tone}`}
        >
          {row.comparison.label}
        </span>
      </div>

      <div
        className="dashboard-benchmark-track"
        aria-hidden="true"
        style={style}
      >
        {row.own !== null ? (
          <span
            className="dashboard-benchmark-track__self"
            aria-hidden="true"
          />
        ) : null}
        {row.average !== null ? (
          <span
            className="dashboard-benchmark-track__reference"
            aria-hidden="true"
          />
        ) : null}
      </div>

      <dl className="dashboard-benchmark-values tabular">
        <div>
          <dt>You</dt>
          <dd>{fmtPct(row.own)}</dd>
        </div>
        <div>
          <dt>Benchmark</dt>
          <dd>{fmtPct(row.average)}</dd>
        </div>
        <div>
          <dt>Difference</dt>
          <dd>{row.comparison.detail}</dd>
        </div>
      </dl>

      <p className="dashboard-benchmark-row__source">
        <span>Source</span> {row.source}
      </p>
    </li>
  );
}

function BenchmarksFrame({
  children,
  titleId,
  workspaceWindow,
  busy = false,
}: {
  children: ReactNode;
  titleId: string;
  workspaceWindow: string;
  busy?: boolean;
}): ReactElement {
  return (
    <section
      className="card pw-data-visual dashboard-insight-card dashboard-benchmarks-card"
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
    >
      <header className="dashboard-insight-card__header">
        <div className="dashboard-insight-card__heading">
          <span className="dashboard-insight-card__eyebrow">
            Performance context
          </span>
          <h2 id={titleId} className="dashboard-insight-card__title">
            How you stack up
          </h2>
          <p className="dashboard-insight-card__subtitle">
            Your rates from the {workspaceWindow} compared with the supplied
            industry baseline.
          </p>
        </div>
        <span className="badge dashboard-benchmarks-card__cohort">
          Industry comparison
        </span>
      </header>
      <div
        className="dashboard-insight-card__provenance"
        aria-label="Benchmark data provenance"
      >
        <span>Moosewave benchmark service</span>
        <span>Current workspace · {workspaceWindow}</span>
        <span>Benchmark timestamp unavailable</span>
      </div>
      {children}
    </section>
  );
}

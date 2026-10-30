/**
 * SegmentGrowthReport — SUB-031 per-segment growth report.
 *
 * Mounts inside SegmentDetailSlideover (below SegmentDecaySection).
 * Where SegmentGrowthCard (R11) charts a single net delta, this report
 * goes further: one row per day carrying the running membership count
 * AND the adds/drops that produced it (segment_membership_log), plus the
 * anomaly markers the decay radar already detected, correlated onto the
 * matching snapshot_date. A CSV export streams the same series.
 *
 * Honest-UI: the series is populated by a background snapshot worker, so
 * early/quiet segments see a sparse or empty series — the server's `note`
 * field is rendered verbatim when present. capped_adds/capped_drops
 * disclose days that hit the membership-log per-direction cap ("≥N")
 * rather than implying the log is exhaustive.
 */

import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import {
  type SegmentGrowthReportResponse,
  segmentInsightsApi,
} from "../../lib/api-client";
import { anomalyKindLabel, anomalyKindTone } from "../../lib/decay-helpers";
import { saveFile } from "../../lib/file-transfer";
import { toast } from "../Toast";
import { AccessibleChartData } from "../charts/AccessibleChartData";
import {
  buildGrowthReportGeometry,
  growthReportSummaryCopy,
} from "./segment-growth-report-helpers";
import { parseSegmentGrowthReport } from "./segment-growth-report-contract";

const WINDOWS = [30, 90, 365] as const;
const SVG_W = 560;
const SVG_H = 120;

function GrowthAnomalies({
  anomalies,
}: {
  anomalies: SegmentGrowthReportResponse["anomalies"];
}): ReactElement | null {
  if (anomalies.length === 0) return null;

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
        Anomaly events ({anomalies.length})
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {anomalies.map((anomaly) => {
          const tone = anomalyKindTone(anomaly.anomaly_kind);
          return (
            <div
              key={`${anomaly.date}-${anomaly.anomaly_kind}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 11,
                flexWrap: "wrap",
              }}
            >
              <span
                className="badge"
                style={{
                  fontSize: 10,
                  color: tone === "warn" ? "var(--pw-warning)" : undefined,
                }}
                title={`Anomaly: ${anomaly.anomaly_kind}`}
              >
                {anomalyKindLabel(anomaly.anomaly_kind)}
              </span>
              <span className="muted">{anomaly.date}</span>
              <span className="muted tabular">
                {anomaly.prior_count.toLocaleString()} →{" "}
                {anomaly.new_count.toLocaleString()}
              </span>
              {anomaly.leaver_count > 0 ? (
                <span
                  className="muted tabular"
                  style={{ color: "var(--pw-danger)" }}
                >
                  −{anomaly.leaver_count.toLocaleString()} left
                </span>
              ) : null}
              {anomaly.entrant_count > 0 ? (
                <span
                  className="muted tabular"
                  style={{ color: "var(--pw-success)" }}
                >
                  +{anomaly.entrant_count.toLocaleString()} joined
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface SegmentGrowthReportProps {
  segmentId: string;
  segmentName: string;
}

function GrowthReportHeader({
  days,
  downloading,
  exportUnavailableReason,
  exportReasonId,
  onDaysChange,
  onExport,
}: {
  days: number;
  downloading: boolean;
  exportUnavailableReason: string | null;
  exportReasonId: string;
  onDaysChange: (days: number) => void;
  onExport: () => void;
}): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 8,
        flexWrap: "wrap",
      }}
    >
      <div className="section-title" style={{ marginBottom: 0, flex: 1 }}>
        Growth report
      </div>
      <div className="chips">
        {WINDOWS.map((windowDays) => (
          <button
            key={windowDays}
            type="button"
            className={`chip${days === windowDays ? " is-active" : ""}`}
            onClick={() => onDaysChange(windowDays)}
          >
            {windowDays}d
          </button>
        ))}
      </div>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={onExport}
        aria-disabled={exportUnavailableReason ? true : undefined}
        aria-describedby={exportUnavailableReason ? exportReasonId : undefined}
      >
        {downloading ? "Exporting…" : "Export CSV"}
      </button>
      {exportUnavailableReason ? (
        <span id={exportReasonId} className="muted" style={{ fontSize: 11 }}>
          {exportUnavailableReason}
        </span>
      ) : null}
    </div>
  );
}

function SegmentGrowthReportBody({
  segmentId,
  segmentName,
}: SegmentGrowthReportProps): ReactElement {
  const activeRef = useRef(true);
  const exportReasonId = useId();
  const [days, setDays] = useState<number>(90);
  const [resp, setResp] = useState<SegmentGrowthReportResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void (async () => {
      const res = await segmentInsightsApi.growthReport(segmentId, { days });
      if (cancelled) return;
      setLoading(false);
      const payload = parseSegmentGrowthReport(res.data);
      if (res.error || !payload) {
        setResp(null);
        setErr(
          res.error?.kind === "http" && res.error.status === 404
            ? "This segment no longer exists on the server — refresh the list."
            : (res.error?.message ?? "The growth report response was invalid"),
        );
        return;
      }
      setResp(payload);
    })();
    return () => {
      cancelled = true;
    };
  }, [segmentId, days]);

  const series = resp?.series ?? [];
  const geom = buildGrowthReportGeometry(series, SVG_W, SVG_H);
  const summary = resp ? growthReportSummaryCopy(resp) : null;
  const exportUnavailableReason = downloading
    ? "The growth report export is already being prepared."
    : loading
      ? "Wait for the growth snapshots to load."
      : series.length === 0
        ? "No snapshots are available to export yet."
        : null;

  const downloadCsv = async (): Promise<void> => {
    setDownloading(true);
    const res = await segmentInsightsApi.growthReportCSV(segmentId, { days });
    if (!activeRef.current) return;
    setDownloading(false);
    if (
      res.error ||
      !res.data ||
      !(res.data.blob instanceof Blob) ||
      typeof res.data.filename !== "string"
    ) {
      toast.error(
        `Couldn't export growth report: ${res.error?.message ?? "invalid export response"}`,
      );
      return;
    }
    const { blob, filename } = res.data;
    const saved = await saveFile({
      data: blob,
      suggestedName: filename,
      label: `${segmentName} growth report`,
      privacy: "personal",
      mimeType: "text/csv;charset=utf-8",
    });
    if (!saved.ok) toast.error(saved.message);
  };

  return (
    <div className="card" style={{ padding: 12 }}>
      <GrowthReportHeader
        days={days}
        downloading={downloading}
        exportUnavailableReason={exportUnavailableReason}
        exportReasonId={exportReasonId}
        onDaysChange={setDays}
        onExport={() => {
          if (exportUnavailableReason) return;
          void downloadCsv();
        }}
      />

      <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
        Daily adds and drops for this segment over time, with the membership
        count and any anomaly events the decay radar flagged.
      </div>

      {err ? (
        <div className="notice" role="alert" style={{ fontSize: 12 }}>
          <span>Couldn&apos;t load the growth report: {err}</span>
        </div>
      ) : loading ? (
        <div className="skel" style={{ height: SVG_H }} />
      ) : resp ? (
        <>
          {/* Server note — explains a sparse/empty series. Rendered verbatim. */}
          {resp.note ? (
            <div
              className="notice"
              style={{ fontSize: 11, padding: "4px 8px", marginBottom: 8 }}
            >
              {resp.note}
            </div>
          ) : null}

          {geom.countPath ? (
            <svg
              width="100%"
              viewBox={`0 0 ${SVG_W} ${SVG_H}`}
              aria-hidden="true"
              style={{ display: "block", marginBottom: 8 }}
            >
              {/* Per-day adds (up) / drops (down) bars around the baseline. */}
              {geom.bars.map((b) => (
                <g key={`bar-${b.date}`}>
                  {b.addsHeight > 0 ? (
                    <rect
                      x={b.x - geom.barHalfWidth}
                      y={geom.midY - b.addsHeight}
                      width={geom.barHalfWidth * 2}
                      height={b.addsHeight}
                      fill="var(--pw-success)"
                      opacity={0.55}
                    >
                      <title>{`${b.date}: +${b.adds.toLocaleString()} added${b.cappedAdds ? " (≥cap)" : ""}`}</title>
                    </rect>
                  ) : null}
                  {b.dropsHeight > 0 ? (
                    <rect
                      x={b.x - geom.barHalfWidth}
                      y={geom.midY}
                      width={geom.barHalfWidth * 2}
                      height={b.dropsHeight}
                      fill="var(--pw-danger)"
                      opacity={0.55}
                    >
                      <title>{`${b.date}: −${b.drops.toLocaleString()} dropped${b.cappedDrops ? " (≥cap)" : ""}`}</title>
                    </rect>
                  ) : null}
                </g>
              ))}
              {/* Baseline (zero churn). */}
              <line
                x1={0}
                y1={geom.midY}
                x2={SVG_W}
                y2={geom.midY}
                stroke="var(--pw-border)"
                strokeWidth="1"
              />
              {/* Running membership count line. */}
              <path
                d={geom.countPath}
                stroke="var(--pw-accent)"
                strokeWidth="1.5"
                fill="none"
              />
              {/* Anomaly markers. */}
              {geom.anomalyMarkers.map((m) => (
                <circle
                  key={`anom-${m.date}`}
                  cx={m.x}
                  cy={m.y}
                  r="3.5"
                  fill="var(--pw-warning)"
                  stroke="var(--pw-bg-elev)"
                  strokeWidth="1"
                >
                  <title>{`${m.date}: ${anomalyKindLabel(m.anomalyKind)}`}</title>
                </circle>
              ))}
            </svg>
          ) : series.length === 1 ? (
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              One snapshot so far ({series[0]!.date}:{" "}
              {series[0]!.count.toLocaleString()} members) — a trend needs at
              least two.
            </div>
          ) : null}

          {/* Legend + summary. */}
          {geom.countPath ? (
            <div
              style={{
                display: "flex",
                gap: 12,
                flexWrap: "wrap",
                fontSize: 11,
                marginBottom: 8,
              }}
            >
              <LegendSwatch color="var(--pw-accent)" label="Count" line />
              <LegendSwatch color="var(--pw-success)" label="Adds" />
              <LegendSwatch color="var(--pw-danger)" label="Drops" />
              {geom.anomalyMarkers.length > 0 ? (
                <LegendSwatch color="var(--pw-warning)" label="Anomaly" />
              ) : null}
            </div>
          ) : null}

          {series.length > 0 ? (
            <AccessibleChartData
              title={`${segmentName} membership count and daily churn`}
              summary={`${series.length} reported days over the last ${resp.days} days; ${resp.total_adds.toLocaleString()} additions and ${resp.total_drops.toLocaleString()} drops.`}
              rowHeaderLabel="Date"
              columns={[
                { key: "count", label: "Members" },
                { key: "adds", label: "Added" },
                { key: "drops", label: "Dropped" },
                { key: "delta", label: "Net change" },
                { key: "anomaly", label: "Anomaly" },
              ]}
              rows={series.map((point) => ({
                key: point.date,
                label: point.date,
                values: {
                  count: point.count.toLocaleString(),
                  adds: `${point.capped_adds ? "≥" : ""}${point.adds.toLocaleString()}`,
                  drops: `${point.capped_drops ? "≥" : ""}${point.drops.toLocaleString()}`,
                  delta: point.delta.toLocaleString(undefined, {
                    signDisplay: "always",
                  }),
                  anomaly: point.anomaly_kind
                    ? anomalyKindLabel(point.anomaly_kind)
                    : "—",
                },
                exportValues: {
                  count: point.count,
                  adds: point.adds,
                  drops: point.drops,
                  delta: point.delta,
                  anomaly: point.anomaly_kind ?? "",
                },
              }))}
              provenance={{
                source: "Moosewave segment growth-report API",
                asOf: null,
                scope: `${segmentName} · last ${resp.days} days`,
                note:
                  resp.note ||
                  "The adjacent server export is authoritative and preserves capped-day metadata.",
              }}
              allowExport={false}
              exportFileName="segment-growth-report.csv"
              exportPrivacy="confidential"
            />
          ) : null}

          {summary ? (
            <div
              style={{
                display: "flex",
                gap: 12,
                flexWrap: "wrap",
                fontSize: 12,
              }}
            >
              <span className="tabular" style={{ color: "var(--pw-success)" }}>
                +{resp.total_adds.toLocaleString()} added
              </span>
              <span className="tabular" style={{ color: "var(--pw-danger)" }}>
                −{resp.total_drops.toLocaleString()} dropped
              </span>
              <span className="tabular" style={{ color: summary.netColor }}>
                {summary.netLabel}
              </span>
              <span className="muted">{summary.caption}</span>
            </div>
          ) : null}

          <GrowthAnomalies anomalies={resp.anomalies} />
        </>
      ) : null}
    </div>
  );
}

/** Reset fetched/chart/export state when the selected segment changes. */
export function SegmentGrowthReport(
  props: SegmentGrowthReportProps,
): ReactElement {
  return <SegmentGrowthReportBody key={props.segmentId} {...props} />;
}

function LegendSwatch({
  color,
  label,
  line,
}: {
  color: string;
  label: string;
  line?: boolean;
}): ReactElement {
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
      className="muted"
    >
      <span
        aria-hidden="true"
        style={{
          width: 10,
          height: line ? 2 : 8,
          borderRadius: line ? 0 : 2,
          background: color,
        }}
      />
      {label}
    </span>
  );
}

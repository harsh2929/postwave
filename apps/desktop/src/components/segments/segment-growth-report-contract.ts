import type {
  SegmentGrowthReportAnomaly,
  SegmentGrowthReportPoint,
  SegmentGrowthReportResponse,
} from "../../lib/api-client";

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function isPoint(value: unknown): value is SegmentGrowthReportPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  return (
    typeof point.date === "string" &&
    finite(point.count) &&
    finite(point.adds) &&
    finite(point.drops) &&
    finite(point.delta) &&
    (point.capped_adds === undefined || typeof point.capped_adds === "boolean") &&
    (point.capped_drops === undefined || typeof point.capped_drops === "boolean") &&
    (point.anomaly_kind === undefined || typeof point.anomaly_kind === "string")
  );
}

function isAnomaly(value: unknown): value is SegmentGrowthReportAnomaly {
  if (!value || typeof value !== "object") return false;
  const anomaly = value as Record<string, unknown>;
  return (
    typeof anomaly.date === "string" &&
    typeof anomaly.anomaly_kind === "string" &&
    finite(anomaly.prior_count) &&
    finite(anomaly.new_count) &&
    finite(anomaly.leaver_count) &&
    finite(anomaly.entrant_count)
  );
}

export function parseSegmentGrowthReport(
  value: unknown,
): SegmentGrowthReportResponse | null {
  if (!value || typeof value !== "object") return null;
  const report = value as Record<string, unknown>;
  if (
    typeof report.segment_id !== "string" ||
    !finite(report.days) ||
    !Array.isArray(report.series) ||
    !report.series.every(isPoint) ||
    !Array.isArray(report.anomalies) ||
    !report.anomalies.every(isAnomaly) ||
    !finite(report.total_adds) ||
    !finite(report.total_drops) ||
    !finite(report.net_delta) ||
    !finite(report.net_pct) ||
    (report.note !== undefined && typeof report.note !== "string")
  ) {
    return null;
  }
  return report as unknown as SegmentGrowthReportResponse;
}

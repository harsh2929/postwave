import type { ReactElement } from "react";

import type {
  SegmentBestSendTime,
  SegmentHeatmapResponse,
} from "../../lib/api-client";
import { Icon, type IconName } from "../Icon";

interface Props {
  heatmap: SegmentHeatmapResponse;
  segmentBest: SegmentBestSendTime | null;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatPeak(day: number, hour: number): string {
  if (
    !Number.isInteger(day) ||
    day < 0 ||
    day > 6 ||
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23
  ) {
    return "Unavailable";
  }
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${DAY_LABELS[day]} · ${hour12} ${hour < 12 ? "AM" : "PM"}`;
}

export function SendTimeStatStrip({
  heatmap,
  segmentBest,
}: Props): ReactElement {
  const reach = Math.max(0, heatmap.subscribers_with_data ?? 0);
  const coverage =
    typeof segmentBest?.confidence === "number" &&
    Number.isFinite(segmentBest.confidence)
      ? Math.max(0, Math.min(1, segmentBest.confidence))
      : null;
  const hasSecondary =
    (heatmap.has_secondary ?? heatmap.has_secondary_window) &&
    heatmap.secondary_dow != null &&
    heatmap.secondary_hour != null;

  return (
    <div
      className="stx-stat-strip"
      aria-label="Audience recommendation summary"
    >
      <Stat
        icon="clock"
        label="Strongest window"
        value={formatPeak(heatmap.best_dow, heatmap.best_hour)}
        detail="UTC source bucket · recommendation"
        tone="accent"
      />
      <Stat
        icon="chart-bars"
        label="Model coverage"
        value={
          coverage == null
            ? "Unavailable"
            : `${Math.round(coverage * 100).toLocaleString()}%`
        }
        detail={
          coverage == null
            ? "Coverage metadata was not returned"
            : "Share of scoped members with cached signal"
        }
        tone={coverage != null && coverage >= 0.7 ? "positive" : "neutral"}
      />
      <Stat
        icon="users"
        label="Signal-ready members"
        value={reach.toLocaleString()}
        detail="Members contributing qualifying engagement"
        tone="neutral"
      />
      <Stat
        icon="git-branch"
        label="Secondary window"
        value={
          hasSecondary
            ? formatPeak(
                heatmap.secondary_dow as number,
                heatmap.secondary_hour as number,
              )
            : "No clear second peak"
        }
        detail={
          hasSecondary
            ? "A second behavioral cluster is visible"
            : "One weekly window currently dominates"
        }
        tone="neutral"
      />
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: IconName;
  label: string;
  value: string;
  detail: string;
  tone: "accent" | "positive" | "neutral";
}): ReactElement {
  return (
    <div className={`stx-stat is-${tone}`}>
      <div className="stx-stat-label">
        <Icon name={icon} size={14} />
        {label}
      </div>
      <div className="stx-stat-value tabular">{value}</div>
      <div className="stx-stat-detail">{detail}</div>
    </div>
  );
}

import type { ReactElement } from "react";

import {
  AccessibleChartData,
  type RequiredChartSupportProps,
} from "./AccessibleChartData";

export interface CategoricalDistributionSegment {
  key: string;
  label: string;
  value: number;
  /** Fraction in [0,1]. Derived from values when omitted. */
  share?: number;
  color: string;
  onSelect?: () => void;
}

interface Props extends RequiredChartSupportProps {
  title: string;
  segments: readonly CategoricalDistributionSegment[];
  valueLabel: string;
  formatValue?: (value: number) => string;
  height?: number;
}

const MARKERS = ["●", "◆", "■", "▲", "✦", "⬟", "✚", "◉"] as const;
const PATTERNS = [
  "none",
  "repeating-linear-gradient(45deg, transparent 0 3px, rgba(255,255,255,.35) 3px 4px)",
  "repeating-linear-gradient(90deg, transparent 0 4px, rgba(255,255,255,.3) 4px 5px)",
  "repeating-linear-gradient(135deg, transparent 0 2px, rgba(255,255,255,.35) 2px 3px)",
  "radial-gradient(circle at center, rgba(255,255,255,.5) 0 1px, transparent 1.5px)",
] as const;

/**
 * Non-color categorical distribution with exact text/table/export parity.
 * The bar is decorative; the adjacent marker+label legend and disclosure are
 * the authoritative operable representation.
 */
export function CategoricalDistributionChart({
  title,
  segments,
  valueLabel,
  formatValue = (value) => value.toLocaleString(),
  height = 22,
  provenance,
  exportFileName,
  exportPrivacy,
  allowExport,
}: Props): ReactElement {
  const normalized = segments.map((segment) => ({
    ...segment,
    normalizedValue:
      Number.isFinite(segment.value) && segment.value >= 0
        ? segment.value
        : null,
  }));
  const total = normalized.reduce(
    (sum, segment) => sum + (segment.normalizedValue ?? 0),
    0,
  );
  const rendered = normalized.map((segment) => {
    const suppliedShare = segment.share;
    const share =
      typeof suppliedShare === "number" && Number.isFinite(suppliedShare)
        ? suppliedShare
        : segment.normalizedValue != null && total > 0
          ? segment.normalizedValue / total
          : 0;
    return {
      ...segment,
      normalizedShare: Math.max(0, Math.min(1, share)),
    };
  });
  const summary = `${title}. ${rendered
    .map(
      (segment) =>
        `${segment.label} ${segment.normalizedValue == null ? "No data" : formatValue(segment.normalizedValue)}, ${segment.normalizedValue == null ? "share unavailable" : `${(segment.normalizedShare * 100).toFixed(1)}%`}`,
    )
    .join("; ")}.`;

  return (
    <div className="pw-data-visual pw-categorical-chart">
      {total > 0 ? (
        <div
          className="pw-categorical-chart__bar"
          style={{ height }}
          aria-hidden="true"
        >
          {rendered.map((segment, index) =>
            segment.normalizedShare <= 0 ? null : (
              <span
                key={segment.key}
                style={{
                  width: `${segment.normalizedShare * 100}%`,
                  backgroundColor: segment.color,
                  backgroundImage: PATTERNS[index % PATTERNS.length],
                  backgroundSize:
                    index % PATTERNS.length === 4 ? "6px 6px" : undefined,
                }}
              />
            ),
          )}
        </div>
      ) : (
        <div className="pw-chart-empty" role="status">
          No category values are available for {title}.
        </div>
      )}
      <p className="visually-hidden">{summary}</p>
      <ul
        className="pw-categorical-chart__legend"
        aria-label={`${title} legend`}
      >
        {rendered.map((segment, index) => {
          const content = (
            <>
              <span
                className="pw-categorical-chart__marker"
                style={{ color: segment.color }}
                aria-hidden="true"
              >
                {MARKERS[index % MARKERS.length]}
              </span>
              <span className="pw-categorical-chart__label">
                {segment.label}
              </span>
              <span className="muted tabular">
                {segment.normalizedValue == null
                  ? "No data"
                  : `${formatValue(segment.normalizedValue)} · ${(segment.normalizedShare * 100).toFixed(1)}%`}
              </span>
            </>
          );
          return (
            <li key={segment.key}>
              {segment.onSelect ? (
                <button
                  type="button"
                  className="pw-categorical-chart__item"
                  onClick={segment.onSelect}
                >
                  {content}
                </button>
              ) : (
                <span className="pw-categorical-chart__item">{content}</span>
              )}
            </li>
          );
        })}
      </ul>
      <AccessibleChartData
        title={title}
        summary={summary}
        rowHeaderLabel="Category"
        columns={[
          { key: "value", label: valueLabel },
          { key: "share", label: "Share" },
        ]}
        rows={rendered.map((segment) => ({
          key: segment.key,
          label: segment.label,
          values: {
            value:
              segment.normalizedValue == null
                ? "No data"
                : formatValue(segment.normalizedValue),
            share:
              segment.normalizedValue == null
                ? "No data"
                : `${(segment.normalizedShare * 100).toFixed(1)}%`,
          },
          exportValues: {
            value: segment.normalizedValue ?? "",
            share:
              segment.normalizedValue == null
                ? ""
                : `${(segment.normalizedShare * 100).toFixed(1)}%`,
          },
        }))}
        provenance={provenance}
        exportFileName={exportFileName}
        exportPrivacy={exportPrivacy}
        {...(allowExport != null ? { allowExport } : {})}
      />
    </div>
  );
}

import type { ReactElement, ReactNode } from "react";

import { categoryLabel } from "../integrations-helpers";

export function BlueprintTokenList({
  title,
  values,
  empty,
}: {
  title: string;
  values: string[];
  empty: string;
}): ReactElement {
  return (
    <section className="int-token-group">
      <h4>{title}</h4>
      {values.length === 0 ? (
        <p className="int-token-empty">{empty}</p>
      ) : (
        <div className="int-token-list">
          {values.map((value) => (
            <span key={value} className="int-token">
              {categoryLabel(value, new Map())}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

export function MiniMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactElement {
  return (
    <div className="int-mini-metric">
      <div className="int-mini-metric-label">{label}</div>
      <div className="int-mini-metric-value">{value}</div>
    </div>
  );
}

export function Metric({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
}): ReactElement {
  return (
    <div className={`int-metric int-metric--${tone}`}>
      <div className="int-metric-label">{label}</div>
      <div className="int-metric-value">{value}</div>
      {sub ? <div className="int-metric-sub">{sub}</div> : null}
    </div>
  );
}

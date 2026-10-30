/**
 * BounceClassBreakdownChart — stacked horizontal bar of bounce classes.
 *
 * Renders a 100%-wide bar segmented by class (hard / soft / block /
 * mailbox_full / dns / content / other), with a legend below showing
 * the absolute counts. Pure SVG — no chart-lib dependency.
 *
 * GAP-LS-138 (bounce-class observability).
 */

import type { ReactElement } from "react";

import type { BounceClassBreakdownResponse } from "../../lib/api-client";
import { CategoricalDistributionChart } from "../charts/CategoricalDistributionChart";

interface Props {
  data: BounceClassBreakdownResponse | null;
  loading: boolean;
}

/** Stable colour per class so the bar reads at a glance. */
const CLASS_COLOR: Record<string, string> = {
  hard: "var(--pw-danger)",
  block: "#a855f7",
  soft: "var(--pw-warning)",
  mailbox_full: "#0ea5e9",
  dns: "#14b8a6",
  content: "#f97316",
  other: "var(--pw-fg-muted)",
};

function colorFor(code: string): string {
  return CLASS_COLOR[code] ?? "var(--pw-fg-muted)";
}

export function BounceClassBreakdownChart({
  data,
  loading,
}: Props): ReactElement {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontWeight: 600 }}>Bounce class breakdown</div>
        <div className="muted" style={{ fontSize: 12 }}>
          {data
            ? `Last ${data.window_days}d · ${data.total_bounces.toLocaleString()} bounces`
            : "Last 30d"}
        </div>
      </div>

      {loading ? (
        <div className="skel" style={{ height: 24, width: "100%" }} />
      ) : !data || data.classes.length === 0 ? (
        <div
          className="muted"
          style={{
            padding: 20,
            textAlign: "center",
            fontSize: 13,
          }}
        >
          No bounces recorded in the window.
        </div>
      ) : (
        <CategoricalDistributionChart
          title="Bounce class distribution"
          valueLabel="Bounces"
          segments={data.classes.map((item) => ({
            key: item.class_code,
            label: item.label,
            value: item.count,
            share: item.share,
            color: colorFor(item.class_code),
          }))}
          provenance={{
            source: "Moosewave deliverability API",
            asOf: null,
            scope: `Last ${data.window_days} days`,
          }}
          exportFileName="bounce-class-distribution.csv"
          exportPrivacy="confidential"
        />
      )}
    </div>
  );
}

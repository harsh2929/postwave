/**
 * Funnel — stacked horizontal bars where each step's width is proportional
 * to its count vs the first step. Used both for the 30d engagement funnel
 * (Sent → Delivered → Opened → Clicked) and per-position sequence funnels.
 *
 * Pure SVG/HTML, no external charting. Numbers + percentages displayed
 * directly on each bar.
 */

import type { ReactElement } from "react";

import {
  AccessibleChartData,
  type RequiredChartSupportProps,
} from "./AccessibleChartData";

export interface FunnelRow {
  label: string;
  value: number;
  /** Optional secondary count (e.g., clicks within an opened step). */
  sub?: { label: string; value: number };
}

export interface FunnelProps extends RequiredChartSupportProps {
  rows: FunnelRow[];
  /** Total used as the 100% reference. Defaults to the first row's value. */
  total?: number;
  /** Compact mode shrinks the row height for nested per-position usage. */
  compact?: boolean;
  /**
   * When true, renders the stage-to-stage conversion percentage between
   * each row (e.g. "Sent → Delivered (98%)"). Helps users see WHERE the
   * funnel is leaking, not just absolute counts at each step.
   */
  showConversion?: boolean;
  title: string;
  valueLabel: string;
}

function pct(num: number, denom: number): string {
  if (denom <= 0) return "0%";
  const v = (num / denom) * 100;
  if (v >= 10) return `${v.toFixed(0)}%`;
  return `${v.toFixed(1)}%`;
}

export function Funnel(props: FunnelProps): ReactElement {
  const {
    rows,
    compact = false,
    showConversion = false,
    title,
    valueLabel,
  } = props;
  const total = props.total ?? rows[0]?.value ?? 0;
  const rowH = compact ? 22 : 30;
  const secondaryLabel = rows.find((row) => row.sub)?.sub?.label;
  const summary = `${rows.length} stages. ${total.toLocaleString()} at the starting stage; ${rows.at(-1)?.value.toLocaleString() ?? "0"} at the final stage.`;

  if (rows.length === 0) {
    return (
      <div className="pw-data-visual">
        <div className="pw-chart-empty" role="status">
          No data available for {title}.
        </div>
        <AccessibleChartData
          title={title}
          summary={summary}
          rowHeaderLabel="Stage"
          columns={[{ key: "value", label: valueLabel }]}
          rows={[]}
          provenance={props.provenance}
          exportFileName={props.exportFileName}
          exportPrivacy={props.exportPrivacy}
          {...(props.allowExport != null
            ? { allowExport: props.allowExport }
            : {})}
        />
      </div>
    );
  }

  return (
    <div className="pw-data-visual">
      <div
        role="list"
        aria-label={`${title}. ${summary}`}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: compact ? 4 : 8,
          width: "100%",
        }}
      >
        {rows.map((r, i) => {
          const prev = i > 0 ? rows[i - 1] : null;
          const stepConv =
            showConversion && prev && prev.value > 0
              ? (r.value / prev.value) * 100
              : null;
          const w = total > 0 ? Math.max(0, Math.min(1, r.value / total)) : 0;
          const subW =
            r.sub && r.value > 0
              ? Math.max(0, Math.min(1, r.sub.value / r.value)) * w
              : 0;
          return (
            <div
              key={i}
              role="listitem"
              aria-label={`${r.label}: ${r.value.toLocaleString()}, ${pct(r.value, total)} of the starting total}${stepConv != null ? `, ${stepConv.toFixed(1)}% from the prior stage` : ""}${r.sub ? `, ${r.sub.label} ${r.sub.value.toLocaleString()}` : ""}`}
            >
              <FunnelRowGroup stepConv={stepConv} prevLabel={prev?.label}>
                <div
                  className="pw-funnel-row-grid"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "100px 1fr 80px",
                    alignItems: "center",
                    gap: 8,
                    fontSize: compact ? 11 : 12,
                  }}
                >
                  <div
                    className="muted"
                    style={{
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {r.label}
                  </div>
                  <div
                    style={{
                      position: "relative",
                      height: rowH,
                      background: "var(--pw-bg-elev-2)",
                      borderRadius: 4,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: `${w * 100}%`,
                        background: "var(--pw-accent)",
                        opacity: 0.85,
                        transition: "width 200ms ease-out",
                      }}
                    />
                    {r.sub ? (
                      <div
                        style={{
                          position: "absolute",
                          left: 0,
                          top: 0,
                          bottom: 0,
                          width: `${subW * 100}%`,
                          background: "var(--pw-accent)",
                          transition: "width 200ms ease-out",
                        }}
                        title={`${r.sub.label}: ${r.sub.value.toLocaleString()}`}
                      />
                    ) : null}
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        alignItems: "center",
                        paddingLeft: 8,
                        fontSize: 11,
                        color: "var(--pw-fg)",
                        fontVariantNumeric: "tabular-nums",
                        mixBlendMode: "normal",
                        textShadow:
                          "0 1px 1px color-mix(in srgb, var(--pw-shadow-color) 45%, transparent)",
                      }}
                    >
                      {r.value.toLocaleString()}
                      {r.sub ? (
                        <span
                          style={{
                            marginLeft: 8,
                            color: "var(--pw-fg-muted)",
                          }}
                        >
                          · {r.sub.label} {r.sub.value.toLocaleString()}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div
                    className="muted tabular"
                    style={{ textAlign: "right", fontSize: 11 }}
                  >
                    {pct(r.value, total)}
                  </div>
                </div>
              </FunnelRowGroup>
            </div>
          );
        })}
      </div>
      <AccessibleChartData
        title={title}
        summary={summary}
        rowHeaderLabel="Stage"
        columns={[
          { key: "value", label: valueLabel },
          ...(secondaryLabel
            ? [
                {
                  key: "secondary",
                  label: secondaryLabel,
                },
              ]
            : []),
          { key: "startingShare", label: "Share of starting stage" },
          { key: "priorConversion", label: "Conversion from prior stage" },
        ]}
        rows={rows.map((row, index) => ({
          key: `${index}-${row.label}`,
          label: row.label,
          values: {
            value: row.value.toLocaleString(),
            ...(secondaryLabel
              ? {
                  secondary: row.sub
                    ? row.sub.value.toLocaleString()
                    : "Not available",
                }
              : {}),
            startingShare: pct(row.value, total),
            priorConversion:
              index > 0
                ? pct(row.value, rows[index - 1]?.value ?? 0)
                : "Starting stage",
          },
          exportValues: {
            value: row.value,
            ...(secondaryLabel ? { secondary: row.sub?.value ?? "" } : {}),
            startingShare: pct(row.value, total),
            priorConversion:
              index > 0
                ? pct(row.value, rows[index - 1]?.value ?? 0)
                : "Starting stage",
          },
        }))}
        provenance={props.provenance}
        exportFileName={props.exportFileName}
        exportPrivacy={props.exportPrivacy}
        {...(props.allowExport != null
          ? { allowExport: props.allowExport }
          : {})}
      />
    </div>
  );
}

function FunnelRowGroup({
  stepConv,
  prevLabel,
  children,
}: {
  stepConv: number | null;
  prevLabel: string | undefined;
  children: React.ReactNode;
}): ReactElement {
  return (
    <>
      {stepConv != null ? (
        <div
          className="pw-funnel-row-grid pw-funnel-conversion"
          style={{
            display: "grid",
            gridTemplateColumns: "100px 1fr 80px",
            gap: 8,
            alignItems: "center",
            fontSize: 10,
            color: "var(--pw-fg-subtle)",
            marginTop: -4,
            marginBottom: -4,
            lineHeight: 1,
          }}
        >
          <span />
          <span
            style={{
              borderLeft: "1px dashed var(--pw-border)",
              paddingLeft: 8,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            ↓ {stepConv >= 10 ? stepConv.toFixed(0) : stepConv.toFixed(1)}%
            {prevLabel ? ` from ${prevLabel.toLowerCase()}` : ""}
          </span>
          <span />
        </div>
      ) : null}
      {children}
    </>
  );
}

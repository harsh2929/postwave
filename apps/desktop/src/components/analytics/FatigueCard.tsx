/**
 * FatigueCard — send-fatigue analysis from analyticsExtrasApi.fatigue.
 *
 * The backend buckets subscribers into deciles by how many emails
 * they received in the window (rows are keyed by a `sends_bucket`
 * LABEL, not a numeric range — ROADMAP-WRAPPERS deviation #8) and
 * reports each bucket's open and unsubscribe rates as 0..1 fractions.
 *
 * Rendered as a table rather than a paired bar chart on purpose:
 * open rates (~20–60%) and unsub rates (~0.05–2%) differ by two
 * orders of magnitude, so sharing one bar-chart y-axis would flatten
 * the unsub series into invisibility. The table keeps both readable
 * and adds an inline open-rate bar for the gradient read; the
 * derived one-line read (fatigueRead) states whether engagement
 * actually decays as send volume rises — and says "no signature"
 * when it doesn't.
 */

import { type ReactElement, useEffect, useState } from "react";

import { type FatigueDecile, analyticsExtrasApi } from "../../lib/api-client";
import { remoteFailureFromError } from "../../lib/remote-resource";
import { AccessibleChartData } from "../charts/AccessibleChartData";
import { dux025Provenance } from "../charts/dux-025-visual-manifest";
import { InlineHelp } from "../InlineHelp";
import { fatigueRead, fmtFraction, maxOpenRate } from "./fatigue";

interface Props {
  /** Window in days — follows the page's range chips. */
  days: number;
}

const CELL_PAD = "6px 8px";

export function FatigueCard({ days }: Props): ReactElement {
  const [deciles, setDeciles] = useState<FatigueDecile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      setLoading(true);
      setErr(null);
      setDeciles(null);
      try {
        const res = await analyticsExtrasApi.fatigue({ days });
        if (cancelled) return;
        if (res.error) {
          setErr(remoteFailureFromError(res.error).message);
        } else {
          setDeciles(res.data.deciles ?? []);
        }
      } catch {
        if (cancelled) return;
        setErr(remoteFailureFromError({ kind: "network" }).message);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [days, reloadKey]);

  const rows = deciles ?? [];
  const peakOpen = maxOpenRate(rows);
  const read = fatigueRead(rows);

  return (
    <div className="card pw-chart-card" style={{ marginTop: 12 }}>
      <div className="pw-chart-head">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Send fatigue
          <InlineHelp text="Subscribers are bucketed by unique campaign–recipient send exposures recorded in this window. Duplicate provider events collapse to one sent, opened, or unsubscribed outcome per campaign and recipient; outcomes without a matching in-window send are excluded. Falling open rates and rising unsubscribe rates toward the highest-exposure buckets indicate a fatigue pattern." />
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          by recorded send exposure · last {days} days
        </div>
      </div>

      {err ? (
        <div className="notice" role="alert">
          <span>Couldn&apos;t load fatigue analysis: {err}</span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            Retry
          </button>
        </div>
      ) : loading ? (
        <div className="pw-chart-empty" role="status">
          Computing send-frequency deciles…
        </div>
      ) : rows.length === 0 ? (
        <div className="pw-chart-empty" role="status">
          Not enough send history in the last {days} days to bucket subscribers
          by frequency — fatigue analysis appears once sends accumulate.
        </div>
      ) : (
        <>
          <div style={{ overflowX: "auto" }}>
            <table
              className="data-table"
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
              }}
            >
              <caption className="visually-hidden">
                Send-frequency fatigue by recipient decile
              </caption>
              <thead>
                <tr>
                  <th scope="col" style={headStyle("left")}>
                    Send exposures
                  </th>
                  <th scope="col" style={headStyle("right")}>
                    Subscribers
                  </th>
                  <th scope="col" style={headStyle("left")}>
                    Open rate
                  </th>
                  <th scope="col" style={headStyle("right")}>
                    Unsub rate
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.sends_bucket}>
                    <th
                      scope="row"
                      className="tabular"
                      style={{
                        padding: CELL_PAD,
                        borderBottom: "1px solid var(--pw-border)",
                        color: "var(--pw-fg)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {d.sends_bucket}
                    </th>
                    <td
                      className="tabular"
                      style={{
                        padding: CELL_PAD,
                        borderBottom: "1px solid var(--pw-border)",
                        textAlign: "right",
                        color: "var(--pw-fg-muted)",
                      }}
                    >
                      {d.subscribers.toLocaleString()}
                    </td>
                    <td
                      style={{
                        padding: CELL_PAD,
                        borderBottom: "1px solid var(--pw-border)",
                        minWidth: 160,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <div
                          aria-hidden="true"
                          style={{
                            position: "relative",
                            flex: 1,
                            height: 14,
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
                              width: `${peakOpen > 0 ? (d.open_rate / peakOpen) * 100 : 0}%`,
                              background: "var(--pw-accent)",
                              backgroundImage:
                                "repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in srgb, var(--pw-bg) 45%, transparent) 3px 4px)",
                              opacity: 0.8,
                            }}
                          />
                        </div>
                        <span
                          className="tabular"
                          style={{
                            fontSize: 11,
                            color: "var(--pw-fg)",
                            width: 48,
                            textAlign: "right",
                          }}
                        >
                          {fmtFraction(d.open_rate)}
                        </span>
                      </div>
                    </td>
                    <td
                      className="tabular"
                      style={{
                        padding: CELL_PAD,
                        borderBottom: "1px solid var(--pw-border)",
                        textAlign: "right",
                        color: "var(--pw-fg)",
                      }}
                    >
                      {fmtFraction(d.unsub_rate, 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Data-derived read — only renders with ≥2 buckets, and says
           * "no fatigue signature" when the gradient isn't there. */}
          {read ? (
            <div
              className="muted"
              style={{ fontSize: 11, marginTop: 8, lineHeight: 1.5 }}
            >
              {read}
            </div>
          ) : null}
          <AccessibleChartData
            title="Send-frequency fatigue by recipient decile"
            summary={`${rows.length} server-defined send-frequency buckets for the trailing ${days} days. ${read ?? "No directional fatigue read is available."}`}
            rowHeaderLabel="Recorded send-exposure bucket"
            columns={[
              { key: "subscribers", label: "Subscribers" },
              { key: "openRate", label: "Open rate (%)" },
              { key: "unsubRate", label: "Unsubscribe rate (%)" },
            ]}
            rows={rows.map((row) => ({
              key: row.sends_bucket,
              label: row.sends_bucket,
              values: {
                subscribers: row.subscribers.toLocaleString(),
                openRate: fmtFraction(row.open_rate),
                unsubRate: fmtFraction(row.unsub_rate, 2),
              },
              exportValues: {
                subscribers: row.subscribers,
                openRate: row.open_rate * 100,
                unsubRate: row.unsub_rate * 100,
              },
            }))}
            provenance={dux025Provenance("sendFatigue", {
              scope: `Current workspace · trailing ${days} days · ${rows.length} returned buckets`,
            })}
            exportFileName="send-frequency-fatigue.csv"
            exportPrivacy="confidential"
            includeTable={false}
          />
        </>
      )}
    </div>
  );
}

function headStyle(align: "left" | "right"): React.CSSProperties {
  return {
    textAlign: align,
    padding: CELL_PAD,
    borderBottom: "1px solid var(--pw-border)",
    color: "var(--pw-fg-subtle)",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    fontWeight: 600,
    whiteSpace: "nowrap",
  };
}

/**
 * CohortRetentionPanel — the first UI for the retention-cohort engine
 * (apps/api/internal/cohorts). The backend computes a Mixpanel-style retention
 * matrix (signup cohort × periods-since-signup) with pure SQL and its doc says
 * the frontend "renders this as the canonical retention heatmap" — but there was
 * no client at all. This renders the heatmap: rows are signup cohorts, columns
 * are periods since signup, and each cell's colour intensity is that cohort's
 * retained-engagement percentage for that period.
 */
import { useEffect, useState } from "react";

import { cohortsApi } from "../../lib/api-client";
import type { CohortMatrix, CohortPeriod } from "../../lib/api/cohorts";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; matrix: CohortMatrix };

const PCT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

// cellBackground maps a retention percentage (0..100) to an ember-tinted
// background, so denser retention reads darker — the heatmap's whole point.
function cellBackground(pct: number): string {
  const alpha = Math.max(0, Math.min(1, pct / 100));
  return `color-mix(in srgb, var(--pw-accent) ${Math.round(alpha * 72)}%, transparent)`;
}

export function CohortRetentionPanel() {
  const [period, setPeriod] = useState<CohortPeriod>("week");
  const [windows, setWindows] = useState(12);
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    cohortsApi
      .getCohorts(period, windows)
      .then((res) => {
        if (!alive) return;
        setState(
          res.error
            ? { kind: "error", message: res.error.message }
            : { kind: "ready", matrix: res.data },
        );
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setState({
          kind: "error",
          message:
            error instanceof Error ? error.message : "Unexpected request error",
        });
      });
    return () => {
      alive = false;
    };
  }, [period, windows]);

  return (
    <section
      aria-label="Cohort retention"
      style={{ display: "grid", gap: 12, padding: 12 }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: 14 }}>Retention cohorts</h3>
          <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
            Engaged subscribers by signup cohort, per {period} since signup.
          </p>
        </div>
        <label style={{ marginLeft: "auto", fontSize: 12 }} className="muted">
          Period{" "}
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as CohortPeriod)}
          >
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
          </select>
        </label>
        <label style={{ fontSize: 12 }} className="muted">
          Windows{" "}
          <select
            value={windows}
            onChange={(e) => setWindows(Number(e.target.value))}
          >
            {[6, 12, 24, 52].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </header>

      {state.kind === "loading" ? (
        <div className="skel" style={{ height: 12, width: "60%" }} />
      ) : null}
      {state.kind === "error" ? (
        <p
          role="alert"
          className="muted"
          style={{ fontSize: 12, margin: 0, color: "var(--pw-danger)" }}
        >
          Couldn’t load cohorts: {state.message}
        </p>
      ) : null}
      {state.kind === "ready" && state.matrix.cohorts.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          No cohorts yet — subscribers need signup + engagement history.
        </p>
      ) : null}

      {state.kind === "ready" && state.matrix.cohorts.length > 0 ? (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              borderCollapse: "collapse",
              fontSize: 11,
              minWidth: "100%",
            }}
          >
            <thead>
              <tr className="muted">
                <th style={{ ...headCell, textAlign: "left" }}>Cohort</th>
                <th style={headCell}>Size</th>
                {state.matrix.average_pcts.map((_, i) => (
                  <th key={i} style={headCell}>
                    +{i}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.matrix.cohorts.map((row) => (
                <tr key={row.cohort_start}>
                  <td
                    style={{
                      ...bodyCell,
                      textAlign: "left",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row.cohort_start}
                  </td>
                  <td style={bodyCell} className="tabular">
                    {PCT.format(row.size)}
                  </td>
                  {row.pcts.map((pct, i) => (
                    <td
                      key={i}
                      className="tabular"
                      title={`${PCT.format(row.engagements[i] ?? 0)} of ${PCT.format(row.size)}`}
                      style={{ ...bodyCell, background: cellBackground(pct) }}
                    >
                      {pct > 0 ? `${PCT.format(pct)}%` : "·"}
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <td style={{ ...bodyCell, textAlign: "left", fontWeight: 600 }}>
                  Average
                </td>
                <td style={bodyCell} />
                {state.matrix.average_pcts.map((pct, i) => (
                  <td
                    key={i}
                    className="tabular"
                    style={{ ...bodyCell, fontWeight: 600 }}
                  >
                    {pct > 0 ? `${PCT.format(pct)}%` : "·"}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

const headCell = {
  padding: "4px 8px",
  textAlign: "center" as const,
  fontWeight: 600,
};
const bodyCell = {
  padding: "4px 8px",
  textAlign: "center" as const,
  borderTop: "1px solid var(--pw-border-soft, var(--pw-border))",
};

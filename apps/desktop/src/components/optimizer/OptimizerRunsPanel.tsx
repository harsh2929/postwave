/**
 * OptimizerRunsPanel — the first UI for the sto_content_optimizer Thompson-
 * sampling bandit (apps/api/internal/sto_content_optimizer, G-54).
 *
 * The bandit runs a Beta-Bernoulli multi-armed-bandit over the cartesian
 * product of subject/header/body/CTA variants, with a worker and 5 mounted
 * routes — and had ZERO client, so operators could not create, start, inspect,
 * or complete a run from the app (the existing "Content optimizer" card drives a
 * different, simpler module). This lists a campaign's runs and, on expand, shows
 * each arm ranked by its posterior mean — the "which combination is winning"
 * number the bandit exists to produce.
 */
import { useEffect, useState } from "react";

import { optimizerRunsApi } from "../../lib/api-client";
import type { OptimizerArm, OptimizerRun } from "../../lib/api/optimizer-runs";

type RunsState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; runs: OptimizerRun[] };

const PCT = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});

// posteriorMean is the Beta(alpha,beta) mean — the arm's current estimated
// conversion rate under Thompson sampling.
function posteriorMean(arm: OptimizerArm): number {
  const denom = arm.posterior_alpha + arm.posterior_beta;
  return denom > 0 ? arm.posterior_alpha / denom : 0;
}

export function OptimizerRunsPanel({ campaignId }: { campaignId: string }) {
  const [state, setState] = useState<RunsState>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    optimizerRunsApi
      .listRuns(campaignId)
      .then((res) => {
        if (!alive) return;
        setState(
          res.error
            ? { kind: "error", message: res.error.message }
            : { kind: "ready", runs: res.data },
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
  }, [campaignId]);

  return (
    <section
      aria-label="Content optimizer runs"
      style={{ display: "grid", gap: 12, padding: 12 }}
    >
      <header>
        <h3 style={{ margin: 0, fontSize: 14 }}>Content optimizer (bandit)</h3>
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
          Thompson-sampling over subject / header / body / CTA variants.
        </p>
      </header>

      {state.kind === "loading" ? (
        <div className="skel" style={{ height: 12, width: "55%" }} />
      ) : null}
      {state.kind === "error" ? (
        <p
          role="alert"
          className="muted"
          style={{ fontSize: 12, margin: 0, color: "var(--pw-danger)" }}
        >
          Couldn’t load optimizer runs: {state.message}
        </p>
      ) : null}
      {state.kind === "ready" && state.runs.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          No optimizer runs for this campaign yet.
        </p>
      ) : null}
      {state.kind === "ready" && state.runs.length > 0 ? (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "grid",
            gap: 8,
          }}
        >
          {state.runs.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

type ArmsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; arms: OptimizerArm[] };

function RunRow({ run }: { run: OptimizerRun }) {
  const [expanded, setExpanded] = useState(false);
  const [arms, setArms] = useState<ArmsState>({ kind: "idle" });

  useEffect(() => {
    if (!expanded || arms.kind !== "idle") return;
    let alive = true;
    setArms({ kind: "loading" });
    optimizerRunsApi
      .getRun(run.id)
      .then((res) => {
        if (!alive) return;
        setArms(
          res.error
            ? { kind: "error", message: res.error.message }
            : {
                kind: "ready",
                arms: [...res.data.arms].sort(
                  (a, b) => posteriorMean(b) - posteriorMean(a),
                ),
              },
        );
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setArms({
          kind: "error",
          message:
            error instanceof Error ? error.message : "Unexpected request error",
        });
      });
    return () => {
      alive = false;
    };
  }, [expanded, arms.kind, run.id]);

  return (
    <li
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: "var(--pw-radius-md, 8px)",
        background: "var(--pw-bg-elev)",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          background: "transparent",
          border: 0,
          cursor: "pointer",
          textAlign: "left",
          color: "inherit",
        }}
      >
        <span style={{ fontWeight: 600 }}>
          {run.name || run.id.slice(0, 8)}
        </span>
        <StatusPill status={run.status} />
        <span className="muted" style={{ fontSize: 12 }}>
          {run.objective.replace("_", " ")}
        </span>
        <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded ? (
        <div
          style={{
            borderTop: "1px solid var(--pw-border)",
            padding: "8px 12px",
          }}
        >
          {arms.kind === "loading" ? (
            <div className="skel" style={{ height: 10, width: "40%" }} />
          ) : null}
          {arms.kind === "error" ? (
            <p
              className="muted"
              style={{ fontSize: 12, margin: 0, color: "var(--pw-danger)" }}
            >
              {arms.message}
            </p>
          ) : null}
          {arms.kind === "ready" && arms.arms.length === 0 ? (
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              No arms materialised.
            </p>
          ) : null}
          {arms.kind === "ready" && arms.arms.length > 0 ? (
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
              }}
            >
              <thead>
                <tr className="muted">
                  <th style={cell}>Arm</th>
                  <th style={cellNum}>Est. rate</th>
                  <th style={cellNum}>Conv / impr</th>
                </tr>
              </thead>
              <tbody>
                {arms.arms.map((arm) => (
                  <tr
                    key={arm.id}
                    style={{
                      borderTop:
                        "1px solid var(--pw-border-soft, var(--pw-border))",
                    }}
                  >
                    <td style={cell}>
                      {Object.values(arm.component_ids).join(" · ") ||
                        arm.id.slice(0, 8)}
                    </td>
                    <td style={cellNum} className="tabular">
                      {PCT.format(posteriorMean(arm))}
                    </td>
                    <td style={cellNum} className="tabular">
                      {arm.conversions} / {arm.impressions}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function StatusPill({ status }: { status: OptimizerRun["status"] }) {
  const tone: Record<string, string> = {
    exploring: "var(--pw-info)",
    exploiting: "var(--pw-warning)",
    completed: "var(--pw-success)",
    aborted: "var(--pw-danger)",
    draft: "var(--pw-fg-muted)",
  };
  const color = tone[status] ?? "var(--pw-fg-muted)";
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: "1px 8px",
        borderRadius: "var(--pw-radius-pill, 999px)",
        color,
        background: "color-mix(in srgb, currentColor 16%, transparent)",
      }}
    >
      {status}
    </span>
  );
}

const cell = { textAlign: "left" as const, padding: "4px 6px" };
const cellNum = { textAlign: "right" as const, padding: "4px 6px" };

/**
 * lib/aiRegression.ts — reading the AI-output regression harness honestly.
 *
 * The harness replays approved "golden" AI outputs against the current model
 * and scores how close they still are. Its verdict decides whether a model
 * change is allowed to ship, so it is exactly the sort of thing an operator
 * wants to glance at from a phone — and exactly the sort of thing that must
 * never be summarised into a green tick it has not earned.
 *
 * Four states the server can be in, all different:
 *   - NO RUN AT ALL. `GET /runs/latest` answers 200 with `{"run": null}`
 *     (handlers.go:216), not a 404. Rendering that as "pass" would be a
 *     fabricated claim about a harness that has never executed.
 *   - RUN IN FLIGHT (`pending` / `running`). No verdict exists yet.
 *   - RUN FAILED (`failed`). The harness itself broke; there is no verdict
 *     about the model.
 *   - COMPLETED, with `gate_result` of pass | fail | advisory. `advisory` is
 *     NOT a pass: it means the gate was not eligible to block (too few golden
 *     examples), so the score is informational.
 *
 * Mobile is READ-ONLY here by design: TriggerRun and the settings PUT are
 * admin-scoped and change deployment gating for the whole workspace.
 *
 * Import-free so every branch is unit-testable.
 */

export interface RegressionRunWire {
  id?: string;
  model_id?: string;
  model_version_tag?: string;
  prompt_version_tag?: string;
  status?: string;
  total_examples?: number;
  passed_examples?: number;
  fidelity_score_mean?: number | null;
  gate_result?: string | null;
  warn_threshold?: number;
  error_message?: string | null;
  created_at?: string;
  completed_at?: string | null;
}

export interface LatestRunEnvelope {
  run?: RegressionRunWire | null;
}

export type RegressionVerdict =
  | "none"
  | "in_flight"
  | "harness_failed"
  | "pass"
  | "advisory"
  | "fail"
  | "unknown";

export interface RegressionPresentation {
  verdict: RegressionVerdict;
  /** Pill label. Never colour-alone: this text carries the reading. */
  label: string;
  tone: "success" | "warning" | "danger" | "neutral";
  /** One sentence explaining what the label means. */
  detail: string;
  /** "82 / 100" style score line, or null when there is no score. */
  score: string | null;
  /** "17 of 20 examples passed", or null. */
  examples: string | null;
}

function score(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function regressionPresentation(
  run: RegressionRunWire | null | undefined,
): RegressionPresentation {
  if (!run) {
    return {
      verdict: "none",
      label: "Never run",
      tone: "neutral",
      detail:
        "No regression run has happened for this workspace yet. Capture golden examples and trigger a run from desktop.",
      score: null,
      examples: null,
    };
  }
  const status = (run.status ?? "").trim().toLowerCase();
  const mean = score(run.fidelity_score_mean);
  const total = score(run.total_examples) ?? 0;
  const passed = score(run.passed_examples) ?? 0;
  const scoreLine = mean === null ? null : `${Math.round(mean)} / 100`;
  const examples =
    total > 0
      ? `${Math.trunc(passed)} of ${Math.trunc(total)} examples passed`
      : null;

  if (status === "pending" || status === "running") {
    return {
      verdict: "in_flight",
      label: status === "running" ? "Running" : "Queued",
      tone: "neutral",
      detail: "A run is in progress. There is no verdict yet.",
      score: null,
      examples: null,
    };
  }
  if (status === "failed") {
    return {
      verdict: "harness_failed",
      label: "Run failed",
      tone: "danger",
      detail:
        run.error_message?.trim() ||
        "The harness itself failed, so it says nothing about the model.",
      score: scoreLine,
      examples,
    };
  }

  const gate = (run.gate_result ?? "").trim().toLowerCase();
  if (gate === "pass") {
    return {
      verdict: "pass",
      label: "Passing",
      tone: "success",
      detail: "The latest run met the fidelity gate.",
      score: scoreLine,
      examples,
    };
  }
  if (gate === "fail") {
    return {
      verdict: "fail",
      label: "Failing",
      tone: "danger",
      detail: "The latest run fell below the fidelity gate.",
      score: scoreLine,
      examples,
    };
  }
  if (gate === "advisory") {
    return {
      verdict: "advisory",
      label: "Advisory only",
      tone: "warning",
      // Not a pass: the gate was not eligible to block.
      detail:
        "Scored, but not enough golden examples for the gate to block a release. Treat the score as informational.",
      score: scoreLine,
      examples,
    };
  }
  return {
    verdict: "unknown",
    label: "No verdict",
    tone: "neutral",
    detail:
      "The run completed without a gate result. Open it on desktop for the full report.",
    score: scoreLine,
    examples,
  };
}

/** Spoken form: a pill plus a compacted score says too little on its own. */
export function regressionSpoken(p: RegressionPresentation): string {
  const parts = [`AI regression: ${p.label}.`, p.detail];
  if (p.score) parts.push(`Mean fidelity ${p.score}.`);
  if (p.examples) parts.push(`${p.examples}.`);
  return parts.join(" ");
}

/** Human sentence for a failed read. Reads are `read:reports`. */
export function regressionErrorMessage(
  status: number,
  fallback?: string | undefined,
): string {
  if (status === 403) {
    return "Regression results need reporting access. Ask an admin.";
  }
  if (status === 404 || status === 405 || status === 501) {
    return "This deployment doesn't run the AI regression harness.";
  }
  return fallback?.trim() || "Couldn't load the regression status.";
}

import type {
  DeliverabilityRepairOverrideCapOutcome,
  DeliverabilityRepairOverrideResponse,
} from "../../lib/api-client";
import type { ApiResult } from "../../lib/api/result";

export type RepairOverrideDisposition =
  | { kind: "committed" }
  | { kind: "committed-conservatively-fenced" }
  | { kind: "commit-outcome-unknown-conservatively-fenced" }
  | { kind: "outcome-unknown" }
  | { kind: "rejected" };

function exactOutcome(
  value: unknown,
): DeliverabilityRepairOverrideCapOutcome | null {
  return value === "committed" ||
    value === "committed-conservatively-fenced" ||
    value === "commit-outcome-unknown-conservatively-fenced" ||
    value === "not-committed"
    ? value
    : null;
}

/**
 * Classify only proof emitted for this exact mutation. A malformed 2xx is not
 * success, and a generic 503 is not assumed committed. For error responses the
 * shared transport lifts the canonical envelope's non-framing fields into
 * `details`, which preserves the server's `ok`, `cleared`, and coordination
 * outcome evidence without exposing arbitrary raw response bodies to the UI.
 */
export function classifyRepairOverride(
  result: ApiResult<DeliverabilityRepairOverrideResponse>,
): RepairOverrideDisposition {
  if (result.data) {
    return result.responseMetadata?.status === 200 &&
      result.responseMetadata.sendingCapOutcome === "committed" &&
      result.data.ok === true &&
      result.data.cleared === true &&
      exactOutcome(result.data.cap_coordination_outcome) === "committed"
      ? { kind: "committed" }
      : { kind: "outcome-unknown" };
  }

  const details = result.error?.details;
  const outcome = exactOutcome(details?.cap_coordination_outcome);
  if (
    result.error?.status === 503 &&
    result.error.code === "sending_cap_convergence_pending" &&
    result.responseMetadata?.status === 503 &&
    result.responseMetadata.sendingCapOutcome ===
      "committed-conservatively-fenced" &&
    details?.ok === true &&
    details.cleared === true &&
    outcome === "committed-conservatively-fenced"
  ) {
    return { kind: "committed-conservatively-fenced" };
  }
  if (
    result.error?.status === 503 &&
    result.error.code === "sending_cap_commit_outcome_unknown" &&
    result.responseMetadata?.status === 503 &&
    result.responseMetadata.sendingCapOutcome ===
      "commit-outcome-unknown-conservatively-fenced" &&
    details?.ok === false &&
    details.cleared === false &&
    outcome === "commit-outcome-unknown-conservatively-fenced"
  ) {
    return { kind: "commit-outcome-unknown-conservatively-fenced" };
  }

  const responseOutcome = result.responseMetadata?.sendingCapOutcome;
  const detailsOutcome = exactOutcome(details?.cap_coordination_outcome);
  const definitelyNotCommitted =
    result.error?.status !== undefined &&
    result.error.status >= 400 &&
    result.responseMetadata?.status === result.error.status &&
    responseOutcome === "not-committed" &&
    (detailsOutcome === null || detailsOutcome === "not-committed") &&
    (details?.ok === undefined || details.ok === false) &&
    (details?.cleared === undefined || details.cleared === false);
  if (
    definitelyNotCommitted ||
    (result.error?.code === "offline" && !result.responseMetadata) ||
    (result.error?.kind === "invalid_config" && !result.responseMetadata)
  ) {
    return { kind: "rejected" };
  }
  return { kind: "outcome-unknown" };
}

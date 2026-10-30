import { describe, expect, it } from "vitest";

import { classifyRepairOverride } from "../../components/deliverability/repair-override-contract";
import type { DeliverabilityRepairOverrideResponse } from "../../lib/api-client";
import type { ApiResult } from "../../lib/api/result";

function failure(
  details?: Record<string, unknown>,
  status = 503,
): ApiResult<DeliverabilityRepairOverrideResponse> {
  const outcome = details?.cap_coordination_outcome;
  const code =
    outcome === "committed-conservatively-fenced"
      ? "sending_cap_convergence_pending"
      : outcome === "commit-outcome-unknown-conservatively-fenced"
        ? "sending_cap_commit_outcome_unknown"
        : `http_${status}`;
  return {
    error: {
      kind: "http",
      status,
      code,
      message: "Request failed.",
      ...(details ? { details } : {}),
    },
    ...(typeof outcome === "string"
      ? {
          responseMetadata: {
            status,
            sendingCapOutcome: outcome as
              | "not-committed"
              | "committed"
              | "committed-conservatively-fenced"
              | "commit-outcome-unknown-conservatively-fenced",
          },
        }
      : {}),
  };
}

describe("deliverability repair-override response contract", () => {
  it("accepts only the exact committed 200 acknowledgement", () => {
    expect(
      classifyRepairOverride({
        data: {
          ok: true,
          cleared: true,
          cap_coordination_outcome: "committed",
        },
        responseMetadata: {
          status: 200,
          sendingCapOutcome: "committed",
        },
      }),
    ).toEqual({ kind: "committed" });

    expect(
      classifyRepairOverride({
        data: {
          ok: true,
          cleared: false,
          cap_coordination_outcome: "committed",
        },
        responseMetadata: {
          status: 200,
          sendingCapOutcome: "committed",
        },
      }),
    ).toEqual({ kind: "outcome-unknown" });
  });

  it("recognizes a durably cleared 503 only from all exact evidence", () => {
    const exact = {
      ok: true,
      cleared: true,
      cap_coordination_outcome: "committed-conservatively-fenced",
    };
    expect(classifyRepairOverride(failure(exact))).toEqual({
      kind: "committed-conservatively-fenced",
    });

    expect(
      classifyRepairOverride(failure({ ...exact, cleared: false })),
    ).toEqual({ kind: "outcome-unknown" });
    expect(classifyRepairOverride(failure(exact, 500))).toEqual({
      kind: "outcome-unknown",
    });
    const missingHeader = failure(exact);
    delete missingHeader.responseMetadata;
    expect(classifyRepairOverride(missingHeader)).toEqual({
      kind: "outcome-unknown",
    });
    expect(
      classifyRepairOverride({
        ...failure(exact),
        responseMetadata: {
          status: 503,
          sendingCapOutcome: "commit-outcome-unknown-conservatively-fenced",
        },
      }),
    ).toEqual({ kind: "outcome-unknown" });
  });

  it("keeps the exact commit-unknown 503 distinct from a rejection", () => {
    expect(
      classifyRepairOverride(
        failure({
          ok: false,
          cleared: false,
          cap_coordination_outcome:
            "commit-outcome-unknown-conservatively-fenced",
        }),
      ),
    ).toEqual({
      kind: "commit-outcome-unknown-conservatively-fenced",
    });

    expect(classifyRepairOverride(failure())).toEqual({
      kind: "outcome-unknown",
    });
    expect(
      classifyRepairOverride(
        failure({
          ok: true,
          cleared: true,
          cap_coordination_outcome: "not-committed",
        }),
      ),
    ).toEqual({ kind: "outcome-unknown" });

    expect(
      classifyRepairOverride({
        error: {
          kind: "http",
          status: 409,
          code: "cap_changed",
          message: "The cap changed.",
        },
        responseMetadata: {
          status: 409,
          sendingCapOutcome: "not-committed",
        },
      }),
    ).toEqual({ kind: "rejected" });
  });
});

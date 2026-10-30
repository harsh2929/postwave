import { describe, expect, it } from "vitest";

import {
  newRunOperationKey,
  runNowBlockedReason,
  runNowCopy,
  runNowErrorMessage,
  runNowResultMessage,
  type RunNowSubject,
} from "./audienceSyncRunNow";

function subject(overrides: Partial<RunNowSubject> = {}): RunNowSubject {
  return {
    name: "Warehouse mirror",
    enabled: true,
    schedule: "daily",
    destinationType: "webhook",
    destinationLabel: "Webhook",
    sourceLabel: "Segment",
    ...overrides,
  };
}

describe("what the confirm sheet promises", () => {
  it("says plainly that real subscriber records leave the platform", () => {
    // `MemberRow` carries email, status, tags and the consent receipt. Anything
    // vaguer than this is a consent problem, not a copy preference.
    const copy = runNowCopy(subject());
    expect(copy.message).toMatch(/real subscriber records/);
    expect(copy.message).toMatch(/email, status, tags and consent/);
  });

  it("names the batch size and the cap the runner actually enforces", () => {
    const copy = runNowCopy(subject());
    expect(copy.message).toMatch(/batches of 500/);
    expect(copy.message).toMatch(/50,000/);
  });

  it("states that the firewall withholds rather than silently drops", () => {
    expect(runNowCopy(subject()).message).toMatch(/withheld and counted/);
  });

  it("warns a scheduled sync that the clock restarts", () => {
    // `finishSyncOperationTx` stamps last_run_at, and claimDue measures the
    // next automatic run from it — so a manual run defers the automatic one.
    expect(runNowCopy(subject({ schedule: "daily" })).message).toMatch(
      /restarts the schedule clock/,
    );
    expect(runNowCopy(subject({ schedule: "manual" })).message).not.toMatch(
      /restarts the schedule clock/,
    );
  });

  it("does not paint a delivery red", () => {
    // It creates nothing and destroys nothing. Reserving the destructive colour
    // keeps it meaningful where it matters.
    expect(runNowCopy(subject()).destructive).toBe(false);
  });

  it("says it cannot be recalled, because no endpoint recalls a batch", () => {
    expect(runNowCopy(subject()).consequence).toMatch(/cannot be cancelled or recalled/);
  });
});

describe("when the button must not be offered", () => {
  it("refuses on a paused sync, because the SERVER refuses it", () => {
    // beginSyncOperation returns ErrLifecycleBlocked → 409. Offering a button
    // whose only possible outcome is an error is worse than not offering it.
    const reason = runNowBlockedReason({ enabled: false }, true);
    expect(reason).toMatch(/paused/);
    expect(reason).toMatch(/server refuses/);
  });

  it("refuses offline, and says why it is not queued for later", () => {
    expect(runNowBlockedReason({ enabled: true }, false)).toMatch(
      /never queued for later/,
    );
  });

  it("allows an enabled sync on a live connection", () => {
    expect(runNowBlockedReason({ enabled: true }, true)).toBeNull();
  });

  it("reports the paused reason before the offline one", () => {
    // Being online would not help; the lifecycle block is the real answer.
    expect(runNowBlockedReason({ enabled: false }, false)).toMatch(/paused/);
  });
});

describe("reading what came back", () => {
  function outcome(overrides: Record<string, unknown> = {}) {
    return {
      status: "succeeded",
      rowsExported: 1200,
      excludedCount: 0,
      error: "",
      ...overrides,
    };
  }

  it("does NOT treat a resolved request as a successful run", () => {
    // The single most important behaviour on this surface: a failed run is
    // HTTP 200 with status:"failed", so `mutateAsync` resolving proves nothing.
    const result = runNowResultMessage(
      outcome({ status: "failed", rowsExported: 0, error: "connection refused" }),
      "Warehouse mirror",
    );
    expect(result.kind).toBe("error");
    expect(result.message).toMatch(/connection refused/);
  });

  it("reports a success with the number actually delivered", () => {
    const result = runNowResultMessage(outcome(), "Warehouse mirror");
    expect(result.kind).toBe("success");
    expect(result.message).toMatch(/1,200 members/);
  });

  it("names the firewall's withholding when there was any", () => {
    const result = runNowResultMessage(outcome({ excludedCount: 40 }), "Mirror");
    expect(result.message).toMatch(/40 withheld by the consent firewall/);
  });

  it("stays silent about withholding when there was none", () => {
    expect(runNowResultMessage(outcome({ excludedCount: 0 }), "Mirror").message).not.toMatch(
      /withheld/,
    );
  });

  it("says an unrecorded delivery count is unrecorded, not zero", () => {
    expect(runNowResultMessage(outcome({ rowsExported: null }), "Mirror").message).toMatch(
      /unrecorded number of members/,
    );
  });

  it("treats a partial run as a failure with a divergence, not a success", () => {
    const result = runNowResultMessage(
      outcome({ status: "partial", error: "502 from receiver" }),
      "Mirror",
    );
    expect(result.kind).toBe("error");
    expect(result.message).toMatch(/holds part of the audience/);
  });

  it("explains a rejection as the cap, because that is the only cause", () => {
    const result = runNowResultMessage(outcome({ status: "rejected" }), "Mirror");
    expect(result.kind).toBe("error");
    expect(result.message).toMatch(/50,000-member per-run cap/);
  });

  it("tells an operator to check the destination by hand after a lost outcome", () => {
    const result = runNowResultMessage(
      outcome({ status: "needs_reconciliation" }),
      "Mirror",
    );
    expect(result.kind).toBe("error");
    expect(result.message).toMatch(/by hand/);
  });

  it("reads a still-running answer as normal, not as a fault", () => {
    // The client gives up at 30s and retries under the same idempotency key;
    // the server converges on the in-flight operation and answers `running`.
    const result = runNowResultMessage(outcome({ status: "running" }), "Mirror");
    expect(result.kind).toBe("info");
    expect(result.message).toMatch(/still running on the server/);
  });

  it("does not claim nothing happened when the body carried no run", () => {
    // A run WAS opened server-side before the response was written.
    const result = runNowResultMessage(null, "Mirror");
    expect(result.kind).toBe("info");
    expect(result.message).toMatch(/was started/);
  });
});

describe("failure copy", () => {
  it("names a deployment fact rather than telling someone to retry forever", () => {
    expect(runNowErrorMessage({ code: "runner_unavailable", status: 503 })).toMatch(
      /switched off on this workspace/,
    );
  });

  it("explains a 409 in-progress without inviting a second delivery", () => {
    expect(
      runNowErrorMessage({ code: "audience_operation_in_progress", status: 409 }),
    ).toMatch(/already running/);
  });

  it("explains the paused 409 the same way the disabled button does", () => {
    expect(
      runNowErrorMessage({ code: "audience_operation_blocked", status: 409 }),
    ).toMatch(/paused sync cannot be run by hand/);
  });

  it("promises no duplication after a client timeout, because there is none", () => {
    expect(runNowErrorMessage({ code: "request_timeout", status: 0 })).toMatch(
      /not duplicated/,
    );
  });

  it("maps the role boundary to the role, not to a generic failure", () => {
    expect(runNowErrorMessage({ status: 403 })).toMatch(/editor role/);
  });

  it("only blames the network when a status was present and zero", () => {
    expect(runNowErrorMessage({ status: 0 })).toMatch(/never reached the server/);
    // No status key at all carries no evidence about the network; inventing
    // "check your connection" sends someone to debug a working one.
    expect(runNowErrorMessage({ message: "boom" })).toBe("boom");
    expect(runNowErrorMessage(null)).toBe("Please try again.");
  });
});

describe("the idempotency key", () => {
  it("is fresh per press, so a second press is a real second answer", () => {
    expect(newRunOperationKey("s-1")).not.toBe(newRunOperationKey("s-1"));
  });

  it("carries the sync id and nothing subscriber-derived", () => {
    const key = newRunOperationKey("s-1");
    expect(key).toMatch(/^mobile-audience-sync-s-1-/);
    expect(key).not.toMatch(/@/);
  });
});

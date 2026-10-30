/**
 * Transport-seam tests for the hub ops / recovery / evidence modules: given
 * exactly what `rawRequest` really resolves to — the {data, error} ENVELOPE —
 * does the right row, throw, or null come out, and does the right body go up?
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearRepairOverride,
  fetchWebhookErrors,
} from "./deliverabilityHubOps";
import {
  fetchAutoSuppress,
  fetchRetryEvents,
  fetchSpamTrapHits,
  runSoftBounceRecovery,
  setAutoSuppress,
  setRetryEventStatus,
} from "./deliverabilityRecovery";
import {
  fetchAuthChecks,
  fetchFeedbackHistory,
  fetchPlacementReport,
  isServiceUnavailable,
  scoreEqDraft,
} from "./deliverabilityEvidence";
import { diagnoseCampaign } from "./deliverabilityDiagnose";

const { rawRequest, sdkResource } = vi.hoisted(() => ({
  rawRequest: vi.fn(),
  sdkResource: vi.fn(),
}));
vi.mock("@/api/request", () => ({ rawRequest, sdkResource }));

// Braces matter: a beforeEach that RETURNS the mock (mockReset returns it)
// registers the mock itself as a cleanup hook, and vitest then calls it with
// no arguments at teardown — straight into any mockImplementation.
beforeEach(() => {
  rawRequest.mockReset();
  sdkResource.mockReset();
});

const err = (status: number, message = "nope") => ({
  data: null,
  error: { status, message, code: undefined },
});

describe("clearRepairOverride", () => {
  it("POSTs the exact route and returns only on a CONFIRMED restoration", async () => {
    const request = vi.fn(
      async (
        _method: string,
        _path: string,
        options: { onResponseHeaders?: (headers: Headers) => void },
      ) => {
        options.onResponseHeaders?.(
          new Headers({ "X-Postwave-Sending-Cap-Outcome": "committed" }),
        );
        return {
          ok: true,
          cleared: true,
          cap_coordination_outcome: "committed",
        };
      },
    );
    sdkResource.mockImplementationOnce(
      async (call: (client: unknown) => unknown) => ({
        data: await call({ request }),
        error: null,
      }),
    );
    await expect(clearRepairOverride()).resolves.toEqual({
      kind: "committed",
      cleared: true,
      capCoordinationOutcome: "committed",
    });
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/api/v1/deliverability/hub/repair-override",
      {
        body: {},
        idempotencyKey: null,
        expectedStatus: 200,
        onResponseHeaders: expect.any(Function),
      },
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("holds a 200 with no confirmation instead of exposing a retry", async () => {
    sdkResource.mockResolvedValue({ data: {}, error: null });
    await expect(clearRepairOverride()).resolves.toMatchObject({
      kind: "outcome-unknown",
      cleared: false,
      requiresReconciliation: true,
    });
  });

  it("surfaces a coherently proven not-committed 409", async () => {
    sdkResource.mockResolvedValue({
      data: null,
      error: {
        status: 409,
        code: "cap_changed",
        responseMetadata: { sendingCapOutcome: "not-committed" },
        message: "cap changed since the throttle",
        payload: {
          error: {
            code: "cap_changed",
            message: "cap changed since the throttle",
          },
        },
      },
    });
    await expect(clearRepairOverride()).rejects.toThrow(
      "cap changed since the throttle",
    );
  });

  it("classifies committed-with-fence from the exact retained 503 payload", async () => {
    sdkResource.mockResolvedValue({
      data: null,
      error: {
        status: 503,
        code: "sending_cap_convergence_pending",
        responseMetadata: {
          sendingCapOutcome: "committed-conservatively-fenced",
        },
        message:
          "the override was cleared, but sending-cap convergence is still pending",
        payload: {
          error: {
            code: "sending_cap_convergence_pending",
            message:
              "the override was cleared, but sending-cap convergence is still pending",
          },
          ok: true,
          cleared: true,
          cap_coordination_outcome: "committed-conservatively-fenced",
        },
      },
    });

    await expect(clearRepairOverride()).resolves.toEqual({
      kind: "committed-conservatively-fenced",
      cleared: true,
      capCoordinationOutcome: "committed-conservatively-fenced",
      message:
        "the override was cleared, but sending-cap convergence is still pending",
      requiresReconciliation: true,
    });
    expect(sdkResource).toHaveBeenCalledTimes(1);
  });

  it("classifies commit-outcome-unknown without retrying or claiming success", async () => {
    sdkResource.mockResolvedValue({
      data: null,
      error: {
        status: 503,
        code: "sending_cap_commit_outcome_unknown",
        responseMetadata: {
          sendingCapOutcome: "commit-outcome-unknown-conservatively-fenced",
        },
        message:
          "the database commit outcome could not be proven; sends remain conservatively fenced",
        payload: {
          error: {
            code: "sending_cap_commit_outcome_unknown",
            message:
              "the database commit outcome could not be proven; sends remain conservatively fenced",
          },
          ok: false,
          cleared: false,
          cap_coordination_outcome:
            "commit-outcome-unknown-conservatively-fenced",
        },
      },
    });

    await expect(clearRepairOverride()).resolves.toEqual({
      kind: "commit-outcome-unknown",
      cleared: false,
      capCoordinationOutcome: "commit-outcome-unknown-conservatively-fenced",
      message:
        "the database commit outcome could not be proven; sends remain conservatively fenced",
      requiresReconciliation: true,
    });
    expect(sdkResource).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a result-bearing 503 has contradictory fields", async () => {
    sdkResource.mockResolvedValue({
      data: null,
      error: {
        status: 503,
        code: "sending_cap_convergence_pending",
        message: "pending",
        payload: {
          error: {
            code: "sending_cap_convergence_pending",
            message: "pending",
          },
          ok: true,
          cleared: false,
          cap_coordination_outcome: "committed-conservatively-fenced",
        },
      },
    });

    await expect(clearRepairOverride()).resolves.toMatchObject({
      kind: "outcome-unknown",
      requiresReconciliation: true,
    });
    expect(sdkResource).toHaveBeenCalledTimes(1);

    sdkResource.mockResolvedValue({
      data: null,
      error: {
        status: 503,
        code: "sending_cap_convergence_pending",
        message: "top-level convergence pending",
        payload: {
          error: {
            code: "sending_cap_commit_outcome_unknown",
            message: "nested outcome unknown",
          },
          ok: true,
          cleared: true,
          cap_coordination_outcome: "committed-conservatively-fenced",
        },
      },
    });

    await expect(clearRepairOverride()).resolves.toMatchObject({
      kind: "outcome-unknown",
      requiresReconciliation: true,
    });
    expect(sdkResource).toHaveBeenCalledTimes(2);
  });

  it("holds result-bearing 503s when the outcome header is missing or contradictory", async () => {
    const payload = {
      error: {
        code: "sending_cap_convergence_pending",
        message: "pending",
      },
      ok: true,
      cleared: true,
      cap_coordination_outcome: "committed-conservatively-fenced",
    };
    sdkResource.mockResolvedValue({
      data: null,
      error: {
        status: 503,
        code: "sending_cap_convergence_pending",
        message: "missing proof",
        payload,
      },
    });
    await expect(clearRepairOverride()).resolves.toMatchObject({
      kind: "outcome-unknown",
      requiresReconciliation: true,
    });

    sdkResource.mockResolvedValue({
      data: null,
      error: {
        status: 503,
        code: "sending_cap_convergence_pending",
        message: "contradictory proof",
        responseMetadata: {
          sendingCapOutcome: "commit-outcome-unknown-conservatively-fenced",
        },
        payload,
      },
    });
    await expect(clearRepairOverride()).resolves.toMatchObject({
      kind: "outcome-unknown",
      requiresReconciliation: true,
    });
    expect(sdkResource).toHaveBeenCalledTimes(2);
  });

  it("reconciles only an exact no_override payload", async () => {
    sdkResource.mockResolvedValue({
      data: null,
      error: {
        status: 404,
        code: "no_override",
        responseMetadata: { sendingCapOutcome: "not-committed" },
        message: "no active throttle to clear",
        payload: {
          error: {
            code: "no_override",
            message: "no active throttle to clear",
          },
        },
      },
    });
    await expect(clearRepairOverride()).resolves.toEqual({
      kind: "nothing-to-clear",
      cleared: false,
      message: "no active throttle to clear",
    });

    sdkResource.mockResolvedValue({
      data: null,
      error: {
        status: 404,
        code: "not_found",
        responseMetadata: { sendingCapOutcome: "not-committed" },
        message: "route missing",
        payload: {
          error: { code: "not_found", message: "route missing" },
        },
      },
    });
    await expect(clearRepairOverride()).rejects.toThrow("route missing");
  });
});

describe("fetchWebhookErrors", () => {
  it("reads items + failed verifications from the real envelope", async () => {
    rawRequest.mockResolvedValue({
      data: {
        items: [
          {
            id: "wh-1",
            event: "bounce",
            url: "https://hook",
            error: "timeout",
            status_code: 504,
            attempt_count: 3,
            last_attempt_at: "2026-08-28T00:00:00Z",
            status: "failing",
          },
          { event: "no-id-row-dropped" },
        ],
        failed_verifications: [
          { identity_id: "i1", domain: "a.com", verify_state: "failed" },
        ],
        window: "7d",
      },
      error: null,
    });
    const report = await fetchWebhookErrors();
    expect(report.items).toHaveLength(1);
    expect(report.items[0]?.statusCode).toBe(504);
    expect(report.failedVerifications[0]?.domain).toBe("a.com");
  });
});

describe("blocklist auto-suppress", () => {
  it("parses the state and sends the PATCH body the handler decodes", async () => {
    rawRequest.mockResolvedValue({
      data: {
        auto_suppress: true,
        eligible_now: 2,
        active_suppressions: 1,
        observed_at: "2026-08-28T00:00:00Z",
      },
      error: null,
    });
    const state = await fetchAutoSuppress();
    expect(state).toMatchObject({ autoSuppress: true, eligibleNow: 2 });

    await setAutoSuppress(false);
    expect(rawRequest).toHaveBeenLastCalledWith(
      "PATCH",
      "/api/v1/blocklist/auto-suppress",
      { auto_suppress: false },
    );
  });
});

describe("spam-trap hits", () => {
  it("accepts both the {hits} envelope and a bare array", async () => {
    const row = { email: "trap@x.com", hit_count: 2, status: "blocklisted" };
    rawRequest.mockResolvedValue({ data: { hits: [row] }, error: null });
    expect((await fetchSpamTrapHits(30))[0]?.email).toBe("trap@x.com");
    expect(rawRequest).toHaveBeenLastCalledWith(
      "GET",
      "/api/v1/spam-trap-guard/hits?days=30",
    );
    rawRequest.mockResolvedValue({ data: [row], error: null });
    expect((await fetchSpamTrapHits())[0]?.hitCount).toBe(2);
  });
});

describe("runSoftBounceRecovery", () => {
  it("reports expired_suppressions, the number that actually moved", async () => {
    rawRequest.mockResolvedValue({
      data: { recovered: 0, expired_suppressions: 7 },
      error: null,
    });
    await expect(runSoftBounceRecovery()).resolves.toEqual({
      expiredSuppressions: 7,
    });
  });
});

describe("intelligent retry", () => {
  const REVISION = "2026-08-29T00:01:02.123456789Z";
  const TENANT_ID = "22222222-2222-4222-8222-222222222222";

  const event = (overrides: Record<string, unknown> = {}) => ({
    id: "ev-1",
    tenant_id: TENANT_ID,
    campaign_id: "c1",
    subscriber_email: "a@b.com",
    reason: "soft_bounce",
    status: "pending",
    retry_after: "2026-08-29T01:00:00Z",
    attempts: 1,
    created_at: "2026-08-29T00:00:00Z",
    updated_at: REVISION,
    ...overrides,
  });

  it("retains the exact row revision and sends it as a single-attempt CAS", async () => {
    rawRequest.mockResolvedValue({
      data: { items: [event()] },
      error: null,
    });
    const events = await fetchRetryEvents(TENANT_ID);
    expect(events[0]).toMatchObject({
      status: "pending",
      tenantId: TENANT_ID,
      updatedAt: REVISION,
    });

    rawRequest.mockResolvedValue({
      data: event({ status: "ready", updated_at: "2026-08-29T00:02:00Z" }),
      error: null,
    });
    await setRetryEventStatus("ev-1", "mark-ready", REVISION, TENANT_ID);
    expect(rawRequest).toHaveBeenLastCalledWith(
      "POST",
      "/api/v1/intelligent-retry/events/ev-1/mark-ready",
      { expected_updated_at: REVISION },
      { idempotencyKey: null },
    );
  });

  it("rejects a non-canonical list envelope and a row without its CAS token", async () => {
    rawRequest.mockResolvedValue({ data: [event()], error: null });
    await expect(fetchRetryEvents(TENANT_ID)).rejects.toThrow(
      /unexpected retry events/iu,
    );

    rawRequest.mockResolvedValue({
      data: { items: [event({ updated_at: undefined })] },
      error: null,
    });
    await expect(fetchRetryEvents(TENANT_ID)).rejects.toThrow(
      /unexpected retry event/iu,
    );
  });

  it("rejects the whole list and mutation receipt on a tenant mismatch", async () => {
    rawRequest.mockResolvedValue({
      data: {
        items: [event(), event({ id: "ev-2", tenant_id: "wrong-tenant" })],
      },
      error: null,
    });
    await expect(fetchRetryEvents(TENANT_ID)).rejects.toThrow(
      /unexpected retry event/iu,
    );

    rawRequest.mockResolvedValue({
      data: event({ status: "dismissed", tenant_id: "wrong-tenant" }),
      error: null,
    });
    await expect(
      setRetryEventStatus("ev-1", "dismiss", REVISION, TENANT_ID),
    ).rejects.toThrow(/unexpected retry event/iu);
  });

  it("refuses a malformed revision before dispatching a status write", async () => {
    await expect(
      setRetryEventStatus("ev-1", "dismiss", ` ${REVISION}`, TENANT_ID),
    ).rejects.toThrow(/unexpected retry event revision/iu);
    expect(rawRequest).not.toHaveBeenCalled();
  });
});

describe("fetchFeedbackHistory", () => {
  it("sends the address in the BODY and reads both trails", async () => {
    rawRequest.mockResolvedValue({
      data: {
        bounces: [{ id: 1, bounce_type: "hard", esp: "ses", received_at: "t" }],
        complaints: [
          { id: 2, complaint_type: "abuse", esp: "ses", received_at: "t" },
        ],
      },
      error: null,
    });
    const history = await fetchFeedbackHistory("who@x.com");
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/feedback/history",
      {
        email: "who@x.com",
      },
    );
    expect(history.bounces[0]?.bounceType).toBe("hard");
    expect(history.complaints[0]?.complaintType).toBe("abuse");
  });
});

describe("fetchAuthChecks", () => {
  it("reads the BARE ARRAY the proxy returns", async () => {
    rawRequest.mockResolvedValue({
      data: [
        {
          domain: "a.com",
          spf: { status: "ok", detail: "" },
          dkim: { status: "fail", detail: "no key" },
        },
      ],
      error: null,
    });
    const rows = await fetchAuthChecks();
    expect(rows[0]?.checks.dkim.status).toBe("fail");
    // Missing cells become unknown, never a crash.
    expect(rows[0]?.checks.ptr.status).toBe("");
  });

  it("marks 502/503 as service-unavailable, distinct from other failures", async () => {
    rawRequest.mockResolvedValue(err(503));
    await expect(fetchAuthChecks()).rejects.toSatisfy((thrown: unknown) =>
      isServiceUnavailable(thrown),
    );
    rawRequest.mockResolvedValue(err(500));
    await expect(fetchAuthChecks()).rejects.toSatisfy(
      (thrown: unknown) => !isServiceUnavailable(thrown),
    );
  });
});

describe("fetchPlacementReport", () => {
  it("returns null on 404 — a real empty state, not an error", async () => {
    rawRequest.mockResolvedValue(err(404));
    await expect(fetchPlacementReport("c1")).resolves.toBeNull();
  });

  it("throws on 503 so 'not configured' is never rendered as 'no report'", async () => {
    rawRequest.mockResolvedValue(err(503));
    await expect(fetchPlacementReport("c1")).rejects.toThrow();
  });

  it("parses the report body", async () => {
    rawRequest.mockResolvedValue({
      data: {
        campaign_id: "c1",
        overall_pct: { primary: 0.8, spam: 0.2 },
        providers: [{ provider: "gmail", placements: { primary: 8, spam: 2 } }],
        total_inboxes: 10,
        generated_at: "t",
      },
      error: null,
    });
    const report = await fetchPlacementReport("c1");
    expect(report?.overallPct.primary).toBe(0.8);
    expect(report?.providers[0]?.provider).toBe("gmail");
  });
});

describe("scoreEqDraft", () => {
  it("clamps the score and keeps the skipped-pillar list", async () => {
    rawRequest.mockResolvedValue({
      data: {
        score: 140,
        grade: "A",
        content: { score: 90, weight: 0.4, reasons: [] },
        skippedSubScores: ["auth", 42],
      },
      error: null,
    });
    const result = await scoreEqDraft({ from: "a@b.com", subject: "s" });
    expect(result.score).toBe(100);
    expect(result.skippedSubScores).toEqual(["auth"]);
  });
});

describe("diagnoseCampaign", () => {
  it("NEVER sends the AI request when no evidence could be verified", async () => {
    // auth-checks fails, placement 404s → zero verified signals.
    rawRequest.mockImplementation(async (_method: string, path: string) => {
      if (path === "/api/v1/auth-checks") return err(503);
      if (path.startsWith("/api/v1/inbox-reality/campaigns/")) return err(404);
      throw new Error(`unexpected request: ${path}`);
    });
    await expect(diagnoseCampaign("c1")).rejects.toThrow(/was not sent/);
    expect(
      rawRequest.mock.calls.filter(([, path]) =>
        String(path).startsWith("/api/v1/diagnose/"),
      ),
    ).toHaveLength(0);
  });

  it("sends the gathered signals and reports which evidence reached the model", async () => {
    rawRequest.mockImplementation(async (_method: string, path: string) => {
      if (path === "/api/v1/auth-checks") {
        return {
          data: [{ domain: "a.com", spf: { status: "ok", detail: "" } }],
          error: null,
        };
      }
      if (path.startsWith("/api/v1/inbox-reality/campaigns/")) return err(404);
      if (path === "/api/v1/diagnose/c1") {
        return {
          data: {
            campaign_id: "c1",
            diagnosis: "## Cause\nDKIM broken.",
            fixes: [{ action: "Rotate the DKIM key", impact: "high" }],
            generated_at: "t",
          },
          error: null,
        };
      }
      throw new Error(`unexpected request: ${path}`);
    });
    const diagnosis = await diagnoseCampaign("c1");
    expect(diagnosis.evidence).toEqual({
      authentication: true,
      placement: false,
    });
    expect(diagnosis.fixes[0]?.action).toBe("Rotate the DKIM key");
    const diagnoseCall = rawRequest.mock.calls.find(
      ([, path]) => path === "/api/v1/diagnose/c1",
    );
    expect(diagnoseCall?.[2]).toMatchObject({
      campaign_id: "c1",
      domain: "a.com",
    });
  });

  it("says 'not configured' for a 503 from the diagnose service itself", async () => {
    rawRequest.mockImplementation(async (_method: string, path: string) => {
      if (path === "/api/v1/auth-checks") {
        return { data: [{ domain: "a.com" }], error: null };
      }
      if (path.startsWith("/api/v1/inbox-reality/campaigns/")) return err(404);
      return err(503);
    });
    await expect(diagnoseCampaign("c1")).rejects.toThrow(/isn't configured/);
  });
});

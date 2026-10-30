// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { post: mocks.post } }));

import { clearRepairOverride } from "@/lib/deliverability-hub-api";

beforeEach(() => {
  // `mockReset()` returns the mock. Returning it from beforeEach registers the
  // mock itself as a cleanup hook, so Vitest calls the production-shaped mock
  // with zero arguments after the test.
  mocks.post.mockReset();
});

function observe(
  options: { onResponse?: (response: Response) => void },
  status: number,
  outcome: string,
): void {
  options.onResponse?.(
    new Response(null, {
      status,
      headers: { "X-Postwave-Sending-Cap-Outcome": outcome },
    }),
  );
}

function resultError(
  status: number,
  code: string,
  body: Record<string, unknown>,
): { status: number; code: string; body: Record<string, unknown> } {
  return { status, code, body };
}

describe("deliverability throttle repair", () => {
  it("is online-only and single-attempt", async () => {
    mocks.post.mockImplementation(
      async (
        _path: string,
        _body: unknown,
        options: { onResponse?: (response: Response) => void },
      ) => {
        observe(options, 200, "committed");
        return {
          ok: true,
          cleared: true,
          cap_coordination_outcome: "committed",
        };
      },
    );
    await expect(clearRepairOverride()).resolves.toEqual({
      kind: "committed",
      cleared: true,
      capCoordinationOutcome: "committed",
    });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/deliverability/hub/repair-override",
      {},
      {
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: null,
        onResponse: expect.any(Function),
      },
    );
  });

  it("treats only the route's exact no_override code as healthy absence", async () => {
    mocks.post.mockImplementationOnce(
      async (
        _path: string,
        _body: unknown,
        options: { onResponse?: (response: Response) => void },
      ) => {
        observe(options, 404, "not-committed");
        throw resultError(404, "no_override", {
          error: {
            code: "no_override",
            message: "no active throttle to clear",
          },
        });
      },
    );
    await expect(clearRepairOverride()).resolves.toEqual({
      kind: "nothing-to-clear",
      cleared: false,
      nothingToClear: true,
    });

    const missingRoute = resultError(404, "not_found", {
      error: { code: "not_found", message: "route missing" },
    });
    mocks.post.mockRejectedValueOnce(missingRoute);
    await expect(clearRepairOverride()).resolves.toMatchObject({
      kind: "outcome-unknown",
      requiresReconciliation: true,
    });
  });

  it("returns a truthful committed-with-fence result for the exact 503 receipt", async () => {
    mocks.post.mockImplementationOnce(
      async (
        _path: string,
        _body: unknown,
        options: { onResponse?: (response: Response) => void },
      ) => {
        observe(options, 503, "committed-conservatively-fenced");
        throw resultError(503, "sending_cap_convergence_pending", {
          error: {
            code: "sending_cap_convergence_pending",
            message:
              "the override was cleared, but sending-cap convergence is still pending",
          },
          ok: true,
          cleared: true,
          cap_coordination_outcome: "committed-conservatively-fenced",
        });
      },
    );

    await expect(clearRepairOverride()).resolves.toEqual({
      kind: "committed-conservatively-fenced",
      cleared: true,
      capCoordinationOutcome: "committed-conservatively-fenced",
      message:
        "the override was cleared, but sending-cap convergence is still pending",
      requiresReconciliation: true,
    });
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it("holds the exact commit-outcome-unknown 503 for reconciliation", async () => {
    mocks.post.mockImplementationOnce(
      async (
        _path: string,
        _body: unknown,
        options: { onResponse?: (response: Response) => void },
      ) => {
        observe(options, 503, "commit-outcome-unknown-conservatively-fenced");
        throw resultError(503, "sending_cap_commit_outcome_unknown", {
          error: {
            code: "sending_cap_commit_outcome_unknown",
            message:
              "the database commit outcome could not be proven; sends remain conservatively fenced",
          },
          ok: false,
          cleared: false,
          cap_coordination_outcome:
            "commit-outcome-unknown-conservatively-fenced",
        });
      },
    );

    await expect(clearRepairOverride()).resolves.toEqual({
      kind: "commit-outcome-unknown",
      cleared: false,
      capCoordinationOutcome: "commit-outcome-unknown-conservatively-fenced",
      message:
        "the database commit outcome could not be proven; sends remain conservatively fenced",
      requiresReconciliation: true,
    });
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it("fails closed when any status, header, code, or body claim disagrees", async () => {
    const malformed = resultError(503, "sending_cap_convergence_pending", {
      error: {
        code: "sending_cap_convergence_pending",
        message: "pending",
      },
      ok: true,
      cleared: false,
      cap_coordination_outcome: "committed-conservatively-fenced",
    });
    mocks.post.mockImplementationOnce(
      async (
        _path: string,
        _body: unknown,
        options: { onResponse?: (response: Response) => void },
      ) => {
        observe(options, 503, "committed-conservatively-fenced");
        throw malformed;
      },
    );
    await expect(clearRepairOverride()).resolves.toMatchObject({
      kind: "outcome-unknown",
      requiresReconciliation: true,
    });

    mocks.post.mockImplementationOnce(
      async (
        _path: string,
        _body: unknown,
        options: { onResponse?: (response: Response) => void },
      ) => {
        observe(options, 200, "not-committed");
        return {
          ok: true,
          cleared: true,
          cap_coordination_outcome: "committed",
        };
      },
    );
    await expect(clearRepairOverride()).resolves.toMatchObject({
      kind: "outcome-unknown",
      requiresReconciliation: true,
    });

    const wrong503Header = resultError(503, "sending_cap_convergence_pending", {
      error: {
        code: "sending_cap_convergence_pending",
        message: "pending",
      },
      ok: true,
      cleared: true,
      cap_coordination_outcome: "committed-conservatively-fenced",
    });
    mocks.post.mockImplementationOnce(
      async (
        _path: string,
        _body: unknown,
        options: { onResponse?: (response: Response) => void },
      ) => {
        observe(options, 503, "not-committed");
        throw wrong503Header;
      },
    );
    await expect(clearRepairOverride()).resolves.toMatchObject({
      kind: "outcome-unknown",
      requiresReconciliation: true,
    });

    mocks.post.mockImplementationOnce(
      async (
        _path: string,
        _body: unknown,
        options: { onResponse?: (response: Response) => void },
      ) => {
        observe(options, 200, "committed");
        return {
          ok: true,
          cleared: true,
          cap_coordination_outcome:
            "commit-outcome-unknown-conservatively-fenced",
        };
      },
    );
    await expect(clearRepairOverride()).resolves.toMatchObject({
      kind: "outcome-unknown",
      requiresReconciliation: true,
    });
  });

  it("keeps a coherently proven not-committed refusal retryable", async () => {
    const refused = resultError(409, "cap_changed", {
      error: { code: "cap_changed", message: "the cap changed" },
      ok: false,
      cleared: false,
      cap_coordination_outcome: "not-committed",
    });
    mocks.post.mockImplementationOnce(
      async (
        _path: string,
        _body: unknown,
        options: { onResponse?: (response: Response) => void },
      ) => {
        observe(options, 409, "not-committed");
        throw refused;
      },
    );

    await expect(clearRepairOverride()).rejects.toBe(refused);
  });
});

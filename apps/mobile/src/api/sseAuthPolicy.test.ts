/**
 * When an SSE open failure stops being worth retrying.
 *
 * The property that matters: an authorization refusal must not be able to
 * become an unbounded reconnect loop, because every `connectSse` attempt
 * re-runs `buildRequest` — a POST /api/v1/streams/token. A stream aimed at a
 * route the caller's role cannot open was minting a fresh credential and
 * eating a 403 every ≤30s for as long as the screen was mounted.
 *
 * And the counter-property, which is why 401 is not treated like 403: a 401 is
 * the NORMAL answer to a stream-token mint that failed transiently, so making
 * it terminal on the first occurrence would kill the live-send tail for the
 * rest of a send over one flaky radio moment.
 */
import { describe, expect, it } from "vitest";

import {
  isAuthRefusalStatus,
  sseOpenFailureAction,
  SSE_UNAUTHORIZED_RETRY_BUDGET,
} from "./sseAuthPolicy";

describe("isAuthRefusalStatus", () => {
  it("is exactly the two refusal statuses", () => {
    expect(isAuthRefusalStatus(401)).toBe(true);
    expect(isAuthRefusalStatus(403)).toBe(true);
    expect(isAuthRefusalStatus(400)).toBe(false);
    expect(isAuthRefusalStatus(404)).toBe(false);
    expect(isAuthRefusalStatus(500)).toBe(false);
    expect(isAuthRefusalStatus(503)).toBe(false);
  });
});

describe("sseOpenFailureAction", () => {
  it("stops on the FIRST 403 — a fresh token carries the same scopes", () => {
    expect(
      sseOpenFailureAction({ status: 403, unauthorizedAttempts: 0 }),
    ).toBe("stop");
  });

  it("retries a transient 401 rather than killing the stream", () => {
    expect(
      sseOpenFailureAction({ status: 401, unauthorizedAttempts: 1 }),
    ).toBe("retry");
    expect(
      sseOpenFailureAction({
        status: 401,
        unauthorizedAttempts: SSE_UNAUTHORIZED_RETRY_BUDGET - 1,
      }),
    ).toBe("retry");
  });

  it("stops once the 401s stop looking transient", () => {
    expect(
      sseOpenFailureAction({
        status: 401,
        unauthorizedAttempts: SSE_UNAUTHORIZED_RETRY_BUDGET,
      }),
    ).toBe("stop");
    expect(
      sseOpenFailureAction({
        status: 401,
        unauthorizedAttempts: SSE_UNAUTHORIZED_RETRY_BUDGET + 3,
      }),
    ).toBe("stop");
  });

  it("keeps retrying every other failure, however many times", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(
        sseOpenFailureAction({ status, unauthorizedAttempts: 99 }),
      ).toBe("retry");
    }
  });

  it("honours an explicit budget", () => {
    expect(
      sseOpenFailureAction({ status: 401, unauthorizedAttempts: 1, budget: 1 }),
    ).toBe("stop");
    expect(
      sseOpenFailureAction({ status: 401, unauthorizedAttempts: 1, budget: 9 }),
    ).toBe("retry");
  });

  it("has a budget that is bounded and greater than one", () => {
    // A budget of 1 would make 401 behave like 403 (the regression this
    // separation exists to avoid); an unbounded one restores the defect.
    expect(SSE_UNAUTHORIZED_RETRY_BUDGET).toBeGreaterThan(1);
    expect(Number.isFinite(SSE_UNAUTHORIZED_RETRY_BUDGET)).toBe(true);
  });
});

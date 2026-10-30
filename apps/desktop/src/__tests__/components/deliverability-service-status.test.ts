/**
 * service-status — the honest-UI classifier for the proxied
 * deliverability routes (#42-#44). The contract under test:
 *
 *   503 → "unconfigured", leading with the stable copy and keeping the
 *         server's reason as a parenthetical (NOT an empty state);
 *   429 → "rate_limited", surfacing retryAfterSeconds when present;
 *   404 → "not_found" (a REAL empty state, e.g. no seed test yet);
 *   everything else → "error" with the verbatim message.
 */

import { describe, expect, it } from "vitest";

import {
  SERVICE_UNCONFIGURED_COPY,
  describeServiceError,
} from "../../components/deliverability/service-status";

describe("describeServiceError — 503 service unconfigured", () => {
  it("leads with the stable copy and keeps the server reason", () => {
    const v = describeServiceError({
      message: "diagnostician not configured",
      status: 503,
    });
    expect(v.kind).toBe("unconfigured");
    expect(v.message.startsWith(SERVICE_UNCONFIGURED_COPY)).toBe(true);
    expect(v.message).toContain("diagnostician not configured");
  });

  it("works without a server detail", () => {
    const v = describeServiceError({ message: "", status: 503 });
    expect(v.kind).toBe("unconfigured");
    expect(v.message).toBe(SERVICE_UNCONFIGURED_COPY);
  });
});

describe("describeServiceError — 429 rate limited", () => {
  it("surfaces retry-after when the server sent one", () => {
    const v = describeServiceError({
      message: "too many requests",
      status: 429,
      retryAfterSeconds: 30,
    });
    expect(v.kind).toBe("rate_limited");
    expect(v.message).toContain("~30s");
  });

  it("falls back to generic copy without retry-after", () => {
    const v = describeServiceError({ message: "slow down", status: 429 });
    expect(v.kind).toBe("rate_limited");
    expect(v.message).toContain("Try again shortly");
  });

  it("rounds fractional retry-after up (never promise too early)", () => {
    const v = describeServiceError({
      message: "x",
      status: 429,
      retryAfterSeconds: 0.4,
    });
    expect(v.message).toContain("~1s");
  });
});

describe("describeServiceError — other statuses", () => {
  it("404 is a not_found (real empty state)", () => {
    const v = describeServiceError({
      message: "no placement report",
      status: 404,
    });
    expect(v.kind).toBe("not_found");
    expect(v.message).toBe("no placement report");
  });

  it("anything else is a verbatim error", () => {
    const v = describeServiceError({ message: "boom", status: 500 });
    expect(v).toEqual({ kind: "error", message: "boom" });
  });

  it("network errors (no status) are verbatim errors too", () => {
    const v = describeServiceError({ message: "request timed out" });
    expect(v.kind).toBe("error");
    expect(v.message).toBe("request timed out");
  });
});

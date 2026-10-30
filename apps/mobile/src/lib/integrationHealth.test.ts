import { describe, expect, it } from "vitest";

import {
  isEmptyHealth,
  narrowSeverity,
  normalizeIntegrationHealth,
  retryPolicySummary,
  safeDocsUrl,
  syncAttemptSpoken,
  SYNC_HISTORY_CAP,
} from "./integrationHealth";

describe("narrowSeverity", () => {
  it("passes through the four known states", () => {
    expect(narrowSeverity("ok")).toBe("ok");
    expect(narrowSeverity("error")).toBe("error");
    expect(narrowSeverity("info")).toBe("info");
    expect(narrowSeverity("warning")).toBe("warning");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(narrowSeverity("  OK ")).toBe("ok");
    expect(narrowSeverity("Error")).toBe("error");
  });

  it("never lets an UNKNOWN state read as an all-clear", () => {
    // This is the one mapping that costs someone an outage if it is wrong: a
    // server state this build has never heard of must degrade to a warning,
    // never to "ok".
    for (const unknown of ["degraded_soft", "", null, undefined, 7, {}]) {
      expect(narrowSeverity(unknown)).toBe("warning");
    }
  });
});

describe("safeDocsUrl", () => {
  it("accepts an absolute https url", () => {
    expect(safeDocsUrl("https://docs.example.com/slack")).toBe(
      "https://docs.example.com/slack",
    );
  });

  it("rejects everything that is not https", () => {
    expect(safeDocsUrl("http://docs.example.com")).toBeNull();
    expect(safeDocsUrl("javascript:alert(1)")).toBeNull();
    expect(safeDocsUrl("moosewave://docs")).toBeNull();
    expect(safeDocsUrl("/docs/slack")).toBeNull();
    expect(safeDocsUrl("")).toBeNull();
    expect(safeDocsUrl(undefined)).toBeNull();
  });

  it("rejects credentials embedded in the url", () => {
    expect(safeDocsUrl("https://user:pw@docs.example.com")).toBeNull();
  });
});

describe("normalizeIntegrationHealth", () => {
  it("returns a fully-formed empty report for junk input", () => {
    for (const junk of [null, undefined, 42, "nope", []]) {
      const health = normalizeIntegrationHealth(junk);
      expect(health.checks).toEqual([]);
      expect(health.syncHistory).toEqual([]);
      expect(health.retryPolicy).toBeNull();
      expect(health.severity).toBe("warning");
      expect(isEmptyHealth(health)).toBe(true);
    }
  });

  it("projects the Go HealthReport shape", () => {
    const health = normalizeIntegrationHealth({
      state: "needs_attention",
      severity: "warning",
      message: "Two deliveries failed in the last hour.",
      monitoring_surface: "Outbound webhooks",
      docs_url: "https://docs.example.com/slack",
      checks: [
        { key: "auth", label: "Auth", state: "ok", message: "Token valid." },
        { key: "delivery", label: "Delivery", state: "error", message: "429s." },
      ],
      retry_policy: {
        mode: "automatic",
        max_attempts: 5,
        backoff: "exponential",
        dead_letter: "dlq",
        idempotency: "delivery_id",
      },
      sync_history: [
        {
          at: "2026-07-25T10:00:00Z",
          action: "sync",
          status: "failed",
          attempts: 3,
          message: "",
          error: "429 Too Many Requests",
        },
      ],
    });

    expect(health.state).toBe("needs_attention");
    expect(health.severity).toBe("warning");
    expect(health.monitoringSurface).toBe("Outbound webhooks");
    expect(health.docsUrl).toBe("https://docs.example.com/slack");
    expect(health.checks).toHaveLength(2);
    expect(health.checks[1]).toEqual({
      key: "delivery",
      label: "Delivery",
      state: "error",
      message: "429s.",
    });
    expect(health.retryPolicy?.maxAttempts).toBe(5);
    expect(health.syncHistory[0]?.attempts).toBe(3);
    expect(isEmptyHealth(health)).toBe(false);
  });

  it("drops checks and attempts that carry no information", () => {
    const health = normalizeIntegrationHealth({
      checks: [{ key: "pad" }, { label: "Auth", message: "ok" }],
      sync_history: [{}, { action: "sync", status: "ok" }],
    });
    expect(health.checks).toHaveLength(1);
    expect(health.checks[0]?.label).toBe("Auth");
    expect(health.syncHistory).toHaveLength(1);
  });

  it("treats the always-present-but-empty retry policy as absent", () => {
    // RetryPolicy is a VALUE in the Go struct, so it is serialised even for
    // surfaces with no retry story — as zeroes. Rendering that is a card that
    // says nothing five times.
    const health = normalizeIntegrationHealth({
      retry_policy: {
        mode: "",
        max_attempts: 0,
        backoff: "",
        dead_letter: "",
        idempotency: "",
      },
    });
    expect(health.retryPolicy).toBeNull();
  });

  it("caps the attempt list so one card cannot become a scroll trap", () => {
    const history = Array.from({ length: 20 }).map((_, i) => ({
      action: "sync",
      status: "ok",
      at: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    const health = normalizeIntegrationHealth({ sync_history: history });
    expect(health.syncHistory).toHaveLength(SYNC_HISTORY_CAP);
    expect(health.syncHistory[0]?.at).toBe("2026-07-01T00:00:00Z");
  });

  it("coerces a negative or fractional attempt count to a whole number", () => {
    const health = normalizeIntegrationHealth({
      sync_history: [{ action: "sync", status: "ok", attempts: -4 }],
    });
    expect(health.syncHistory[0]?.attempts).toBe(0);
  });
});

describe("retryPolicySummary", () => {
  it("is empty for an absent policy so the caller can skip the row", () => {
    expect(retryPolicySummary(null)).toBe("");
  });

  it("joins only the parts that were sent", () => {
    expect(
      retryPolicySummary({
        mode: "automatic",
        maxAttempts: 5,
        backoff: "exponential",
        deadLetter: "",
        idempotency: "",
      }),
    ).toBe("automatic · 5 attempts · exponential backoff");
  });

  it("singularises a one-attempt policy", () => {
    expect(
      retryPolicySummary({
        mode: "",
        maxAttempts: 1,
        backoff: "",
        deadLetter: "",
        idempotency: "",
      }),
    ).toBe("1 attempt");
  });
});

describe("syncAttemptSpoken", () => {
  it("prefers the error over the message and expands the attempt count", () => {
    expect(
      syncAttemptSpoken(
        {
          at: "2026-07-25T10:00:00Z",
          action: "sync",
          status: "failed",
          attempts: 3,
          message: "Retrying",
          error: "429 Too Many Requests",
        },
        "25 July 2026 at 10:00",
      ),
    ).toBe(
      "sync, failed. 25 July 2026 at 10:00. 3 attempts. 429 Too Many Requests.",
    );
  });

  it("omits a single attempt and an absent timestamp", () => {
    expect(
      syncAttemptSpoken(
        {
          at: "",
          action: "backfill",
          status: "ok",
          attempts: 1,
          message: "Completed",
          error: "",
        },
        "",
      ),
    ).toBe("backfill, ok. Completed.");
  });
});

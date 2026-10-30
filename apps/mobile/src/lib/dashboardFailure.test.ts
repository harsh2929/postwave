import { describe, expect, it } from "vitest";

import {
  classifyDashboardFailure,
  hidesMetrics,
  statusOf,
} from "./dashboardFailure";
import { DashboardPayloadError } from "./dashboardStatsSchema";

function httpError(status: number, message = "boom"): Error {
  return Object.assign(new Error(message), { status });
}

describe("statusOf", () => {
  it("reads the SDK's numeric status and falls back to 0", () => {
    expect(statusOf(httpError(503))).toBe(503);
    expect(statusOf(new Error("network down"))).toBe(0);
    expect(statusOf({ status: "403" })).toBe(0);
    expect(statusOf(null)).toBe(0);
  });
});

describe("classifyDashboardFailure", () => {
  it("never echoes the raw transport message", () => {
    const failure = classifyDashboardFailure(
      httpError(500, "pq: relation campaign_report_events does not exist"),
    );
    expect(failure.message).not.toContain("pq:");
    expect(failure.kind).toBe("server");
  });

  it("reads 403 as an access boundary with no retry affordance", () => {
    const failure = classifyDashboardFailure(httpError(403));
    expect(failure.kind).toBe("restricted");
    expect(failure.retryLabel).toBeNull();
    expect(hidesMetrics(failure)).toBe(true);
  });

  it("separates an expired session from a permission boundary", () => {
    const failure = classifyDashboardFailure(httpError(401));
    expect(failure.kind).toBe("unauthenticated");
    expect(failure.retryLabel).toBe("Try again");
    expect(hidesMetrics(failure)).toBe(true);
  });

  it("titles each condition as itself, never as the neighbouring one", () => {
    // Both 401 and 403 hide the tiles, so they used to share one heading.
    // "Metrics are restricted" on an expired session sends the user to a
    // workspace admin for a problem only signing in again can fix.
    const expired = classifyDashboardFailure(httpError(401));
    const forbidden = classifyDashboardFailure(httpError(403));
    expect(expired.title).not.toBe(forbidden.title);
    expect(expired.title.toLowerCase()).toContain("session");
    expect(forbidden.title.toLowerCase()).toContain("restricted");
  });

  it("gives every failure a heading that is not the raw transport string", () => {
    for (const error of [
      httpError(401),
      httpError(403),
      httpError(429, "429 Too Many Requests"),
      httpError(500, "pq: fatal"),
      new DashboardPayloadError(),
      new Error("Network request failed"),
    ]) {
      const failure = classifyDashboardFailure(error, { online: false });
      expect(failure.title.trim().length).toBeGreaterThan(0);
      expect(failure.title).not.toContain("pq:");
      expect(failure.title).not.toContain("429");
    }
  });

  it("classifies a rate limit and a 5xx distinctly", () => {
    expect(classifyDashboardFailure(httpError(429)).kind).toBe("rate_limited");
    expect(classifyDashboardFailure(httpError(502)).kind).toBe("server");
  });

  it("classifies an unreadable payload as invalid, not as an empty workspace", () => {
    const failure = classifyDashboardFailure(new DashboardPayloadError());
    expect(failure.kind).toBe("invalid");
    expect(failure.retryLabel).toBe("Try again");
    expect(hidesMetrics(failure)).toBe(false);
  });

  it("recognises a payload error thrown across a module/realm boundary", () => {
    // React Query serialises nothing, but a re-thrown error can lose its
    // prototype chain in dev tooling; the name marker keeps the branch alive.
    const clone = Object.assign(new Error("unreadable"), {
      name: "DashboardPayloadError",
    });
    expect(classifyDashboardFailure(clone).kind).toBe("invalid");
  });

  it("distinguishes offline from an unexplained failure", () => {
    expect(
      classifyDashboardFailure(new Error("Network request failed"), {
        online: false,
      }).kind,
    ).toBe("offline");
    expect(
      classifyDashboardFailure(new Error("Network request failed"), {
        online: true,
      }).kind,
    ).toBe("unknown");
  });

  it("prefers a real HTTP status over the offline heuristic", () => {
    // A 403 received just before the radio dropped is still a 403.
    expect(
      classifyDashboardFailure(httpError(403), { online: false }).kind,
    ).toBe("restricted");
  });
});

describe("hidesMetrics", () => {
  it("keeps tiles visible for transport failures so cached values can show", () => {
    expect(hidesMetrics(classifyDashboardFailure(httpError(500)))).toBe(false);
    expect(hidesMetrics(null)).toBe(false);
  });
});

describe("no offline copy on this device", () => {
  it("names the real condition instead of 'something went wrong'", () => {
    // Reached when the session is cached-only (gate closed) or the device is
    // offline AND the vault holds nothing. Falling through to `unknown` told
    // the user the product was broken when it was simply out of reach.
    const failure = classifyDashboardFailure(
      Object.assign(new Error("No saved dashboard snapshot is available offline."), {
        name: "OfflineSnapshotUnavailableError",
        code: "offline_snapshot_unavailable",
      }),
      { online: true },
    );
    expect(failure.kind).toBe("offline");
    expect(failure.title).toBe("Nothing saved for offline");
    expect(failure.retryLabel).toBe("Try again");
    // Never leaks the internal sentence the loader threw with.
    expect(failure.message).not.toContain("snapshot");
  });

  it("recognises a prototype-stripped error off a rehydrated cache", () => {
    const plain = { code: "offline_snapshot_unavailable" };
    expect(classifyDashboardFailure(plain, { online: true }).kind).toBe(
      "offline",
    );
  });

  it("does not hide the tiles — em-dashes are the right answer here", () => {
    const failure = classifyDashboardFailure(
      { name: "OfflineSnapshotUnavailableError" },
      { online: false },
    );
    expect(hidesMetrics(failure)).toBe(false);
  });
});

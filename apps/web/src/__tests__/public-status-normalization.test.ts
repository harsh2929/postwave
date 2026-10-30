// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import { normalizePublicStatus } from "@/lib/public-status-api";

describe("public status normalization", () => {
  it("turns malformed snapshots into the explicit unavailable shape", () => {
    expect(normalizePublicStatus(null)).toMatchObject({
      overall_status: "down",
      generated_at: "",
      services: [],
      history_90d: {},
    });
    expect(normalizePublicStatus({ overall_status: "green" })).toMatchObject({
      generated_at: "",
      services: [],
    });
  });

  it("bounds metrics and drops malformed nested rows without throwing", () => {
    const snapshot = normalizePublicStatus({
      overall_status: "degraded",
      generated_at: "2026-08-26T00:00:00Z",
      services: [
        {
          service: " API ",
          status: "ok",
          uptime_30d: 4,
          latency_ms: -20,
          last_pinged_at: "2026-08-26T00:00:00Z",
        },
        { service: "broken", status: "mystery" },
      ],
      active_incidents: [
        {
          id: "inc-1",
          title: "Queue delay",
          severity: "minor",
          status: "monitoring",
          affected_services: ["API", 42],
          started_at: "2026-08-26T00:00:00Z",
        },
        { id: "broken" },
      ],
      recent_incidents: "not-an-array",
      history_90d: {
        API: [{ day: "2026-08-26", uptime: -1, incidents: -3 }, null],
      },
    });

    expect(snapshot.services).toEqual([
      expect.objectContaining({
        service: "API",
        status: "ok",
        uptime_30d: 1,
        latency_ms: 0,
      }),
    ]);
    expect(snapshot.active_incidents).toHaveLength(1);
    expect(snapshot.active_incidents[0]?.affected_services).toEqual(["API"]);
    expect(snapshot.recent_incidents).toEqual([]);
    expect(snapshot.history_90d.API).toEqual([
      { day: "2026-08-26", uptime: 0, incidents: 0 },
    ]);
  });
});

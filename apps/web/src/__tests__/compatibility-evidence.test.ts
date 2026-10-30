// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { optimizationEvidenceRows } from "@/app/(dashboard)/app/compatibility/compatibility-detail-sections";
import { providerGateReady } from "@/app/(dashboard)/app/compatibility/compatibility-ui";

describe("compatibility evidence rendering", () => {
  it("surfaces cold-start confidence, method, and data-point caveats", () => {
    const rows = optimizationEvidenceRows("STO", {
      campaign_id: "cmp_1",
      recommendation: {
        label: "Tuesday 10:00",
        score: 0.5,
        confidence: "low",
        reason: "cold start",
        grade: "good",
        method_note: "Cold-start prior; gather engagement data.",
      },
      data_points: 0,
      method: "cold_start_prior",
    });

    expect(rows).toContain("STO confidence: low; 0 data points");
    expect(rows).toContain(
      "STO method: Cold-start prior; gather engagement data.",
    );
  });

  it("matches backend readiness aliases for provider gates", () => {
    for (const ready of [
      "configured",
      "connected",
      "approved",
      "verified",
      "ready",
      "pass",
      "complete",
      "done",
      "not_required",
      "waived",
    ]) {
      expect(providerGateReady(ready), ready).toBe(true);
    }
    expect(providerGateReady("requires_setup")).toBe(false);
  });
});

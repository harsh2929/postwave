import { describe, expect, it } from "vitest";

import type {
  PrivacyIncident,
  PrivacyIncidentState,
} from "../../lib/api-client";
import { summarizePrivacyIncidents } from "../../pages/PrivacyIncidents";

const NOW = new Date("2026-07-16T12:00:00Z").getTime();

describe("privacy incident list statistics", () => {
  it("reports only explicitly loaded-window counts", () => {
    const stats = summarizePrivacyIncidents(
      [
        incident("open-new", "open", "2026-07-16T10:00:00Z"),
        incident("open-old", "contained", "2026-07-14T10:00:00Z"),
        incident(
          "closed-recent",
          "closed",
          "2026-07-15T08:00:00Z",
          "2026-07-15T12:00:00Z",
        ),
        incident(
          "closed-old",
          "closed",
          "2026-05-01T08:00:00Z",
          "2026-05-01T12:00:00Z",
        ),
      ],
      NOW,
    );

    expect(stats).toEqual({
      loadedCount: 4,
      openCount: 2,
      openOver24h: 1,
      priorityCount: 0,
      operationalTargetPassedCount: 0,
      completeScopeCount: 0,
    });
  });

  it("does not infer closure time or delivery from updated-at timestamps", () => {
    const stats = summarizePrivacyIncidents(
      [
        incident("invalid", "closed", "invalid", "2026-07-15T12:00:00Z"),
        incident(
          "backwards",
          "closed",
          "2026-07-15T12:00:00Z",
          "2026-07-15T11:00:00Z",
        ),
      ],
      NOW,
    );
    expect(stats).toEqual({
      loadedCount: 2,
      openCount: 0,
      openOver24h: 0,
      priorityCount: 0,
      operationalTargetPassedCount: 0,
      completeScopeCount: 0,
    });
  });

  it("counts complete four-field triage scope without claiming correctness", () => {
    const withJurisdiction = {
      ...incident("scoped", "open", "2026-07-16T10:00:00Z"),
      jurisdictions: ["DE"],
      affected_regions: ["EEA"],
      affected_data_categories: ["contact_data"],
      affected_subject_count: 0,
    };
    const withoutJurisdiction = incident(
      "unscoped",
      "contained",
      "2026-07-16T10:00:00Z",
    );

    expect(
      summarizePrivacyIncidents([withJurisdiction, withoutJurisdiction], NOW)
        .completeScopeCount,
    ).toBe(1);
  });
});

function incident(
  id: string,
  status: PrivacyIncidentState,
  detectedAt: string,
  updatedAt = detectedAt,
): PrivacyIncident {
  return {
    id,
    status,
    summary: id,
    detected_at: detectedAt,
    updated_at: updatedAt,
  } as PrivacyIncident;
}

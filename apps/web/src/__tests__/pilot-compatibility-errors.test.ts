// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { optionalPilotEvidence, scopePilotJobs } from "@/lib/pilot-evidence";

describe("partial command-center failures", () => {
  it("records pilot section failures instead of turning them into empty data", async () => {
    const errors: string[] = [];
    const value = await optionalPilotEvidence(
      "Pilot acceptance",
      async () => {
        throw new Error("service unavailable");
      },
      errors,
    );

    expect(value).toBeNull();
    expect(errors).toEqual(["Pilot acceptance: service unavailable"]);
  });
});

describe("pilot source scope", () => {
  it("selects only ActiveCampaign and HubSpot while exposing excluded jobs", () => {
    const result = scopePilotJobs([
      {
        id: "mailchimp-newest",
        source: "mailchimp",
        started_at: "2026-08-26T12:00:00Z",
      },
      {
        id: "hubspot-middle",
        source: "hubspot",
        started_at: "2026-08-26T11:00:00Z",
      },
      {
        id: "activecampaign-oldest",
        source: "activecampaign",
        started_at: "2026-08-26T10:00:00Z",
      },
      {
        id: "convertkit",
        source: "convertkit",
        started_at: "2026-08-26T09:00:00Z",
      },
    ]);

    expect(result.inScope.map((job) => job.id)).toEqual([
      "hubspot-middle",
      "activecampaign-oldest",
    ]);
    expect(result.excluded).toBe(2);
    expect(result.total).toBe(4);
  });

  it("does not fall back to an excluded source when no pilot jobs exist", () => {
    const result = scopePilotJobs([
      {
        id: "mailchimp-only",
        source: "mailchimp",
        started_at: "2026-08-26T12:00:00Z",
      },
    ]);

    expect(result.inScope).toEqual([]);
    expect(result.excluded).toBe(1);
    expect(result.total).toBe(1);
  });
});

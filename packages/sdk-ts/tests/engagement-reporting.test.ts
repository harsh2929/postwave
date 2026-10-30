import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";

describe("Analytics engagement reporting", () => {
  it("sends the bounded report scope and preserves floor/band provenance", async () => {
    const requests: string[] = [];
    const accepts: Array<string | null> = [];
    const coverage = [
      {
        classifier_version: "classifier-v2",
        methodology_version: "method-v2",
        registry_version: "registry-v2",
        configuration_hash: "a".repeat(64),
        shadow_mode: true,
        event_count: 9,
        unclassified: false,
      },
      {
        shadow_mode: true,
        event_count: 1,
        unclassified: true,
      },
    ];
    const incrementalLift = {
      evidence_pointer: {
        result_id: "00000000-0000-4000-8000-000000000303",
        evidence_sha256: "d".repeat(64),
      },
      powered: true as const,
      result_version: "f02-lift-result-v1",
      metric: "purchase",
      window_start: "2026-08-01T00:00:00Z",
      window_end: "2026-08-13T00:00:00Z",
      n_treatment: 1000,
      n_control: 1000,
      conversions_treatment: 150,
      conversions_control: 100,
      rate_treatment: 0.15,
      rate_control: 0.1,
      absolute_lift: 0.05,
      relative_lift: 50,
      incremental_conversions: 50,
      p_value: 0.001,
      ci_low: 0.02,
      ci_high: 0.08,
      minimum_detectable_effect: 0.02,
      methodology_version: "two-proportion-z-v1",
      methodology_statement:
        "Intent-to-treat two-proportion comparison over the frozen assignment set.",
      generated_at: "2026-08-13T00:00:01Z",
    };
    const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      requests.push(url);
      accepts.push(new Headers(init.headers).get("Accept"));
      const shared = {
        tenant_id: "00000000-0000-4000-8000-000000000101",
        campaign_id: "00000000-0000-4000-8000-000000000202",
        window_start: "2026-08-01T00:00:00Z",
        window_end: "2026-08-13T00:00:00Z",
        generated_at: "2026-08-13T00:00:01Z",
        classifier_version: "",
        methodology_version: "",
        registry_version: "",
        configuration_hash: "",
        classifier_version_coverage: coverage,
        mixed_classifier_versions: true,
        shadow_mode: true,
      };
      const reach = {
        ...shared,
        headline:
          "human-engaged reach floor: 4, with up to 2 additional unclassified",
        provider_accepted_recipients: 12,
        human_engaged_reach_floor: 4,
        unknown_band: 2,
        human_engaged_reach_upper_bound: 6,
        machine_only_recipients: 3,
        no_interaction_recipients: 3,
        machine_by_subtype: { apple_mpp: 3 },
        methodology: "A floor with an unallocated unknown band.",
        incremental_lift: incrementalLift,
      };
      const body = url.includes("human-engaged-reach/export")
        ? {
            artifact_schema_version:
              "postwave.human-engaged-reach-evidence.v1",
            artifact_kind: "human_engaged_reach_evidence",
            artifact_id: `sha256:${"c".repeat(64)}`,
            generated_at: "2026-08-13T00:00:01Z",
            integrity: {
              algorithm: "sha-256",
              digest_sha256: "c".repeat(64),
              scope: "evidence_payload",
              canonicalization: "postwave-fixed-schema-json-v1",
              authenticity: "not_signed",
            },
            evidence_payload: {
              evidence_semantics: {
                observed_evidence: ["Provider delivery and interaction events."],
                inferred_evidence: ["Versioned classifier predictions."],
                not_observed: ["Human attention."],
                human_reach_claim: "Lower bound.",
                unknown_treatment: "Separate band.",
                acceptance_boundary: "Acceptance is not attention.",
              },
              report: {
                ...reach,
                campaign_id: shared.campaign_id,
                machine_by_subtype: [
                  { subtype: "apple_mpp", recipients: 3 },
                ],
                generated_at: undefined,
              },
            },
          }
        : url.includes("human-engaged-reach")
        ? {
            ...reach,
          }
        : {
            ...shared,
            unit: "interaction_events",
            methodology: "Three mutually exclusive event buckets.",
            human: 4,
            machine: 5,
            unknown: 1,
            total: 10,
            machine_by_subtype: { apple_mpp: 5 },
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "content-type": url.includes("human-engaged-reach/export")
            ? "application/vnd.postwave.human-engaged-reach-evidence+json"
            : "application/json",
        },
      });
    });
    const client = new PostwaveClient({
      apiKey: "pw_read_reports",
      fetch,
      retries: 0,
    });
    const query = {
      campaignId: "00000000-0000-4000-8000-000000000202",
      since: "2026-08-01T00:00:00Z",
      until: "2026-08-13T00:00:00Z",
    };

    const summary = await client.analytics.engagementClassificationSummary(query);
    const reach = await client.analytics.humanEngagedReach(query);
    const artifact = await client.analytics.exportHumanEngagedReachEvidence(query);

    expect(requests).toHaveLength(3);
    expect(requests[0]).toContain(
      "/api/v1/analytics/engagement-classification/summary?",
    );
    expect(requests[1]).toContain("/api/v1/analytics/human-engaged-reach?");
    expect(requests[2]).toContain(
      "/api/v1/analytics/human-engaged-reach/export?",
    );
    expect(accepts[2]).toBe(
      "application/vnd.postwave.human-engaged-reach-evidence+json",
    );
    for (const request of requests) {
      expect(request).toContain(`campaign_id=${query.campaignId}`);
      expect(request).toContain("since=2026-08-01T00%3A00%3A00Z");
      expect(request).toContain("until=2026-08-13T00%3A00%3A00Z");
    }
    expect(summary.human + summary.machine + summary.unknown).toBe(summary.total);
    expect(summary.classifier_version_coverage).toEqual(coverage);
    expect(reach.human_engaged_reach_upper_bound).toBe(
      reach.human_engaged_reach_floor + reach.unknown_band,
    );
    expect(
      reach.human_engaged_reach_floor +
        reach.unknown_band +
        reach.machine_only_recipients +
        reach.no_interaction_recipients,
    ).toBe(reach.provider_accepted_recipients);
    expect(reach.headline).toContain("2 additional unclassified");
    expect(reach.incremental_lift?.powered).toBe(true);
    expect(reach.incremental_lift?.evidence_pointer.evidence_sha256).toBe(
      "d".repeat(64),
    );
    expect(artifact.integrity.authenticity).toBe("not_signed");
    expect(artifact.generated_at).toBe("2026-08-13T00:00:01Z");
    expect(artifact.evidence_payload.evidence_semantics.inferred_evidence[0]).toContain(
      "predictions",
    );
    expect("generated_at" in artifact.evidence_payload.report).toBe(false);
    expect(artifact.evidence_payload.report.incremental_lift).toEqual(
      incrementalLift,
    );
  });
});

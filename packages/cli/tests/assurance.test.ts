// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";

import { createClient } from "../src/lib/client.js";
import {
  assuranceApply,
  assuranceCancel,
  assuranceFindings,
  assuranceGet,
  assuranceOverride,
  assuranceRun,
} from "../src/commands/assurance.js";

vi.mock("../src/lib/client.js", () => ({ createClient: vi.fn() }));

const measurement = {
  name: "Predicted Agent Comprehension" as const,
  interpretation: "A modeled prediction, not a provider observation.",
  source_classes: [
    { class: "deterministic" as const, present: true, meaning: "checks" },
    { class: "modeled" as const, present: false, meaning: "model" },
  ],
};

function makeClient() {
  const run = {
    id: "run_1",
    state: "complete",
    gate_decision: "block",
    overall_score: 81,
    score_min: 79,
    score_max: 83,
    blocking_finding_count: 1,
    finding_count: 2,
  };
  const campaignAssurance = {
    createRun: vi.fn().mockResolvedValue({
      measurement,
      data: {
        run_id: "run_1",
        state: "queued",
        profile: "full",
        required_scenario_count: 2,
        required_extraction_count: 6,
      },
    }),
    getLatest: vi.fn().mockResolvedValue({
      measurement,
      data: {
        detail: { run },
        applicability: {
          freshness: "frozen_snapshot_current",
          applicable_to_frozen_snapshot: true,
        },
      },
    }),
    getRun: vi.fn().mockResolvedValue({
      measurement,
      data: { run },
    }),
    getEvidence: vi.fn().mockResolvedValue({
      measurement,
      data: {
        findings: {
          items: [
            {
              id: "finding_1",
              source_class: "deterministic",
              code: "critical_fact_missing",
              severity: "critical",
              blocking: true,
              overridable: true,
              dimension: "fact_recovery",
              explanation: "The deadline is missing.",
            },
          ],
        },
      },
    }),
    overrideFinding: vi.fn().mockResolvedValue({
      measurement,
      data: {
        id: "override_1",
        run_id: "run_1",
        finding_id: "finding_1",
        decision: "allow_send",
        actor_role: "admin",
      },
    }),
    applyFinding: vi.fn().mockResolvedValue({
      measurement,
      data: {
        application: {
          id: "application_1",
          finding_id: "finding_1",
          base_content_revision_id: "revision_1",
          created_content_revision_id: "revision_2",
        },
        revision: { id: "revision_2", revision_no: 2 },
        campaign_etag: '"campaign-new-version"',
        originating_run_state: "stale",
        rerun_required: true,
      },
    }),
    cancelRun: vi.fn().mockResolvedValue({ measurement, data: run }),
  };
  vi.mocked(createClient).mockReturnValue({ campaignAssurance } as never);
  return campaignAssurance;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("Campaign Assurance CLI", () => {
  it("starts an exact frozen run with stable retry identities", async () => {
    const assurance = makeClient();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await assuranceRun({
      campaignId: "cmp_1",
      contentRevisionId: "revision_1",
      sendPlanId: "plan_1",
      profile: "calibration",
      requestId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "assurance-run-1",
    });

    expect(assurance.createRun).toHaveBeenCalledWith(
      "cmp_1",
      {
        profile: "calibration",
        content_revision_id: "revision_1",
        send_plan_id: "plan_1",
        request_id: "11111111-1111-4111-8111-111111111111",
      },
      { idempotencyKey: "assurance-run-1" },
    );
  });

  it("fails closed when a send plan is supplied without its exact revision", async () => {
    const assurance = makeClient();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await assuranceRun({ campaignId: "cmp_1", sendPlanId: "plan_1" });

    expect(assurance.createRun).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("lets the server freeze the current draft when immutable IDs are omitted", async () => {
    const assurance = makeClient();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await assuranceRun({
      campaign: "cmp_1",
      profile: "full",
      requestId: "77777777-7777-4777-8777-777777777777",
    });

    expect(assurance.createRun).toHaveBeenCalledWith(
      "cmp_1",
      {
        profile: "full",
        request_id: "77777777-7777-4777-8777-777777777777",
      },
      { idempotencyKey: undefined },
    );
  });

  it("wires --seed and named surfaces without claiming availability", async () => {
    const assurance = makeClient();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await assuranceRun({
      campaign: "cmp_1",
      profile: "full",
      requestId: "88888888-8888-4888-8888-888888888888",
      seed: true,
      observedSurfaces: "gmail.web.inbox,outlook.mobile.focused",
    });

    expect(assurance.createRun).toHaveBeenCalledWith(
      "cmp_1",
      {
        profile: "full",
        request_id: "88888888-8888-4888-8888-888888888888",
        include_seed_test: true,
        observed_surfaces: ["gmail.web.inbox", "outlook.mobile.focused"],
      },
      { idempotencyKey: undefined },
    );
  });

  it("rejects observed surfaces unless --seed is explicit", async () => {
    const assurance = makeClient();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await assuranceRun({
      campaign: "cmp_1",
      observedSurfaces: "gmail.web.inbox",
    });

    expect(assurance.createRun).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("gets latest by default and an exact run when requested", async () => {
    const assurance = makeClient();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await assuranceGet({ campaignId: "cmp_1" });
    await assuranceGet({ campaignId: "cmp_1", runId: "run_1" });

    expect(assurance.getLatest).toHaveBeenCalledWith("cmp_1");
    expect(assurance.getRun).toHaveBeenCalledWith("cmp_1", "run_1");
  });

  it("returns the unmodified versioned envelope for JSON output", async () => {
    makeClient();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await assuranceGet({ campaignId: "cmp_1", output: "json" });

    const parsed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(parsed.measurement.name).toBe("Predicted Agent Comprehension");
    expect(parsed.data.detail.run.id).toBe("run_1");
  });

  it("paginates immutable findings and labels their source", async () => {
    const assurance = makeClient();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await assuranceFindings({
      campaignId: "cmp_1",
      runId: "run_1",
      limit: "25",
      offset: "50",
    });

    expect(assurance.getEvidence).toHaveBeenCalledWith("cmp_1", "run_1", {
      limit: 25,
      offset: 50,
    });
    expect(String(log.mock.calls[0]?.[0])).toContain("deterministic");
    expect(String(log.mock.calls[0]?.[0])).toContain("critical_fact_missing");
  });

  it("records an explicit governed override without changing content", async () => {
    const assurance = makeClient();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await assuranceOverride({
      campaignId: "cmp_1",
      runId: "run_1",
      findingId: "finding_1",
      decision: "allow_send",
      reason: "Reviewed against the signed launch contract.",
      requestId: "22222222-2222-4222-8222-222222222222",
      idempotencyKey: "override-1",
    });

    expect(assurance.overrideFinding).toHaveBeenCalledWith(
      "cmp_1",
      "run_1",
      "finding_1",
      {
        request_id: "22222222-2222-4222-8222-222222222222",
        decision: "allow_send",
        reason: "Reviewed against the signed launch contract.",
      },
      { idempotencyKey: "override-1" },
    );
  });

  it("requires explicit confirmation before cancellation", async () => {
    const assurance = makeClient();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await assuranceCancel({ campaignId: "cmp_1", runId: "run_1" });
    expect(assurance.cancelRun).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    await assuranceCancel({
      campaignId: "cmp_1",
      runId: "run_1",
      yes: true,
      idempotencyKey: "cancel-1",
    });
    expect(assurance.cancelRun).toHaveBeenCalledWith("cmp_1", "run_1", {
      idempotencyKey: "cancel-1",
    });
  });

  it("requires confirmation and an exact reviewed ETag before applying the stored patch", async () => {
    const assurance = makeClient();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await assuranceApply({
      campaignId: "cmp_1",
      runId: "run_1",
      findingId: "finding_1",
      ifMatch: '"campaign-reviewed-version"',
    });
    expect(assurance.applyFinding).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    await assuranceApply({
      campaignId: "cmp_1",
      runId: "run_1",
      findingId: "finding_1",
      ifMatch: '"campaign-reviewed-version"',
      requestId: "33333333-3333-4333-8333-333333333333",
      idempotencyKey: "assurance-apply-1",
      yes: true,
    });
    expect(assurance.applyFinding).toHaveBeenCalledWith(
      "cmp_1",
      "run_1",
      "finding_1",
      { request_id: "33333333-3333-4333-8333-333333333333" },
      {
        ifMatch: '"campaign-reviewed-version"',
        idempotencyKey: "assurance-apply-1",
      },
    );
  });
});

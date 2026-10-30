// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";

import { campaignAssuranceTools } from "../../src/tools/campaign-assurance.js";

function makeClient() {
  const campaignAssurance = {
    createRun: vi.fn().mockResolvedValue({ data: { run_id: "run_1" } }),
    getLatest: vi.fn().mockResolvedValue({ data: { latest: true } }),
    getRun: vi.fn().mockResolvedValue({ data: { run_id: "run_1" } }),
    getManifest: vi.fn().mockResolvedValue({ data: { artifacts: [] } }),
    getEvidence: vi.fn().mockResolvedValue({ data: { findings: [] } }),
    getEvents: vi.fn().mockResolvedValue({
      data: { event_history_available: false },
    }),
    applyFinding: vi.fn().mockResolvedValue({
      data: { revision: { id: "revision_2" }, rerun_required: true },
    }),
    overrideFinding: vi.fn().mockResolvedValue({ data: { id: "override_1" } }),
    cancelRun: vi.fn().mockResolvedValue({ data: { state: "cancelled" } }),
  };
  return {
    client: { campaignAssurance },
    campaignAssurance,
  };
}

describe("campaignAssuranceTools", () => {
  it("exposes only mounted Campaign Assurance actions", () => {
    const { client } = makeClient();
    const tools = campaignAssuranceTools(client as never);
    expect(tools.map((tool) => tool.name)).toEqual([
      "campaign_assurance_run",
      "campaign_assurance_get",
      "campaign_assurance_apply_fix",
      "campaign_assurance_override",
      "campaign_assurance_cancel",
    ]);
  });

  it("publishes explicit read, mutation, governance, and scope annotations", () => {
    const { client } = makeClient();
    const byName = new Map(
      campaignAssuranceTools(client as never).map((tool) => [tool.name, tool]),
    );

    expect(byName.get("campaign_assurance_run")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(byName.get("campaign_assurance_get")?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(
      byName.get("campaign_assurance_override")?.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(byName.get("campaign_assurance_apply_fix")?.annotations).toEqual({
      title: "Apply Campaign Assurance Fix",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName.get("campaign_assurance_run")?.requiredScopes).toEqual([
      "write:campaigns",
    ]);
    expect(byName.get("campaign_assurance_get")?.requiredScopes).toEqual([
      "read:campaigns",
    ]);
    expect(byName.get("campaign_assurance_override")?.requiredScopes).toEqual([
      "write:campaigns",
      "send:transactional",
    ]);
    expect(byName.get("campaign_assurance_apply_fix")?.requiredScopes).toEqual([
      "write:campaigns",
    ]);
  });

  it("starts a run with both stable request identities", async () => {
    const fixture = makeClient();
    const tool = campaignAssuranceTools(fixture.client as never).find(
      (candidate) => candidate.name === "campaign_assurance_run",
    )!;
    const input = {
      campaign_id: "cmp_1",
      content_revision_id: "revision_1",
      send_plan_id: "plan_1",
      profile: "full" as const,
      request_id: "11111111-1111-4111-8111-111111111111",
      idempotency_key: "assurance-run-1",
    };

    expect(tool.schema.safeParse(input).success).toBe(true);
    await tool.handler(input);

    expect(fixture.campaignAssurance.createRun).toHaveBeenCalledWith(
      "cmp_1",
      {
        content_revision_id: "revision_1",
        send_plan_id: "plan_1",
        profile: "full",
        request_id: "11111111-1111-4111-8111-111111111111",
      },
      { idempotencyKey: "assurance-run-1" },
    );
  });

  it("routes every read view and rejects ambiguous latest reads", async () => {
    const fixture = makeClient();
    const tool = campaignAssuranceTools(fixture.client as never).find(
      (candidate) => candidate.name === "campaign_assurance_get",
    )!;

    await tool.handler({ campaign_id: "cmp_1", view: "latest" });
    await tool.handler({ campaign_id: "cmp_1", run_id: "run_1", view: "run" });
    await tool.handler({
      campaign_id: "cmp_1",
      run_id: "run_1",
      view: "manifest",
    });
    await tool.handler({
      campaign_id: "cmp_1",
      run_id: "run_1",
      view: "evidence",
      limit: 25,
      offset: 50,
    });
    await tool.handler({
      campaign_id: "cmp_1",
      run_id: "run_1",
      view: "events",
    });

    expect(fixture.campaignAssurance.getLatest).toHaveBeenCalledWith("cmp_1");
    expect(fixture.campaignAssurance.getRun).toHaveBeenCalledWith(
      "cmp_1",
      "run_1",
    );
    expect(fixture.campaignAssurance.getManifest).toHaveBeenCalledWith(
      "cmp_1",
      "run_1",
    );
    expect(fixture.campaignAssurance.getEvidence).toHaveBeenCalledWith(
      "cmp_1",
      "run_1",
      { limit: 25, offset: 50 },
    );
    expect(fixture.campaignAssurance.getEvents).toHaveBeenCalledWith(
      "cmp_1",
      "run_1",
    );
    await expect(
      tool.handler({ campaign_id: "cmp_1", run_id: "run_1", view: "latest" }),
    ).rejects.toThrow(/not accepted/);
  });

  it("forwards one governed finding decision and stable retry key", async () => {
    const fixture = makeClient();
    const tool = campaignAssuranceTools(fixture.client as never).find(
      (candidate) => candidate.name === "campaign_assurance_override",
    )!;
    const input = {
      campaign_id: "cmp_1",
      run_id: "run_1",
      finding_id: "finding_1",
      decision: "allow_send" as const,
      reason: "Owner reviewed the exact immutable finding.",
      request_id: "22222222-2222-4222-8222-222222222222",
      idempotency_key: "override-1",
    };

    await tool.handler(input);

    expect(fixture.campaignAssurance.overrideFinding).toHaveBeenCalledWith(
      "cmp_1",
      "run_1",
      "finding_1",
      {
        decision: "allow_send",
        reason: "Owner reviewed the exact immutable finding.",
        request_id: "22222222-2222-4222-8222-222222222222",
      },
      { idempotencyKey: "override-1" },
    );
  });

  it("applies only the stored finding identity under explicit strong concurrency", async () => {
    const fixture = makeClient();
    const tool = campaignAssuranceTools(fixture.client as never).find(
      (candidate) => candidate.name === "campaign_assurance_apply_fix",
    )!;
    const input = {
      campaign_id: "cmp_1",
      run_id: "run_1",
      finding_id: "finding_1",
      request_id: "33333333-3333-4333-8333-333333333333",
      idempotency_key: "apply-1",
      if_match: '"campaign-reviewed-version"',
    };

    expect(tool.description).toContain("explicit user approval");
    expect(tool.schema.safeParse(input).success).toBe(true);
    await tool.handler(input);

    expect(fixture.campaignAssurance.applyFinding).toHaveBeenCalledWith(
      "cmp_1",
      "run_1",
      "finding_1",
      { request_id: "33333333-3333-4333-8333-333333333333" },
      {
        ifMatch: '"campaign-reviewed-version"',
        idempotencyKey: "apply-1",
      },
    );
    expect(Object.keys(input)).not.toContain("typed_patch");
  });

  it("rejects unstable or unsafe mutation identities", () => {
    const fixture = makeClient();
    const run = campaignAssuranceTools(fixture.client as never).find(
      (candidate) => candidate.name === "campaign_assurance_run",
    )!;
    const base = {
      campaign_id: "cmp_1",
      content_revision_id: "revision_1",
      send_plan_id: "plan_1",
      profile: "full",
      request_id: "11111111-1111-4111-8111-111111111111",
      idempotency_key: "run-1",
    };

    expect(
      run.schema.safeParse({ ...base, request_id: "random" }).success,
    ).toBe(false);
    expect(
      run.schema.safeParse({ ...base, idempotency_key: "unsafe\nkey" }).success,
    ).toBe(false);

    const apply = campaignAssuranceTools(fixture.client as never).find(
      (candidate) => candidate.name === "campaign_assurance_apply_fix",
    )!;
    const applyBase = {
      campaign_id: "cmp_1",
      run_id: "run_1",
      finding_id: "finding_1",
      request_id: "33333333-3333-4333-8333-333333333333",
      idempotency_key: "apply-1",
      if_match: '"campaign-reviewed-version"',
    };
    for (const if_match of ["*", 'W/"weak"', '"one", "two"', "bare"]) {
      expect(apply.schema.safeParse({ ...applyBase, if_match }).success).toBe(
        false,
      );
    }
    expect(
      apply.schema.safeParse({ ...applyBase, typed_patch: { operation: "x" } })
        .success,
    ).toBe(false);
  });
});

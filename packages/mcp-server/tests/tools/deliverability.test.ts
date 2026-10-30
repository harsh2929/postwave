// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import { deliverabilityTools } from "../../src/tools/deliverability.js";

function makeClient() {
  const inboxReality = {
    diagnose: vi.fn().mockResolvedValue({ campaign_id: "cmp_001", fixes: [] }),
    predict: vi.fn().mockResolvedValue({ verdict: "primary", score: 0.8 }),
    render: vi.fn().mockResolvedValue({ previews: [] }),
    getCampaignReport: vi
      .fn()
      .mockResolvedValue({ campaign_id: "cmp_001", placements: [] }),
  };
  const reputation = { get: vi.fn().mockResolvedValue({ sender_score: 90 }) };
  const authChecks = {
    list: vi.fn().mockResolvedValue([{ kind: "spf", pass: true }]),
  };
  const campaignAssurance = {
    createRun: vi.fn(),
    getLatest: vi.fn(),
    getRun: vi.fn(),
    getManifest: vi.fn(),
    getEvidence: vi.fn(),
    getEvents: vi.fn(),
    applyFinding: vi.fn(),
    overrideFinding: vi.fn(),
    cancelRun: vi.fn(),
  };
  return {
    client: { inboxReality, reputation, authChecks, campaignAssurance },
    inboxReality,
    reputation,
    authChecks,
  };
}

describe("deliverabilityTools", () => {
  it("exposes 12 tools with the expected names", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = deliverabilityTools(client as any);
    expect(tools).toHaveLength(12);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "campaign_assurance_apply_fix",
      "campaign_assurance_cancel",
      "campaign_assurance_get",
      "campaign_assurance_override",
      "campaign_assurance_run",
      "check_auth",
      "check_reputation",
      "diagnose_campaign",
      "inbox_report",
      "predict_placement",
      "render_cross_client",
      "render_preview_html",
    ]);
  });

  it("every tool has a Zod object schema", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const t of deliverabilityTools(client as any)) {
      expect(t.schema).toBeInstanceOf(z.ZodObject);
    }
  });

  it("diagnose_campaign forwards campaign_id", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = deliverabilityTools(c.client as any).find(
      (x) => x.name === "diagnose_campaign",
    )!;
    await t.handler({ campaign_id: "cmp_xyz" });
    expect(c.inboxReality.diagnose).toHaveBeenCalledWith("cmp_xyz");
  });

  it("predict_placement forwards html + subject", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = deliverabilityTools(c.client as any).find(
      (x) => x.name === "predict_placement",
    )!;
    await t.handler({ html: "<p>x</p>", subject: "S" });
    expect(c.inboxReality.predict).toHaveBeenCalledWith({
      html: "<p>x</p>",
      subject: "S",
    });
  });

  it("check_reputation calls reputation.get", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = deliverabilityTools(c.client as any).find(
      (x) => x.name === "check_reputation",
    )!;
    await t.handler({});
    expect(c.reputation.get).toHaveBeenCalledTimes(1);
  });

  it("check_auth calls authChecks.list", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = deliverabilityTools(c.client as any).find(
      (x) => x.name === "check_auth",
    )!;
    await t.handler({});
    expect(c.authChecks.list).toHaveBeenCalledTimes(1);
  });

  it("render_cross_client defaults environments to []", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = deliverabilityTools(c.client as any).find(
      (x) => x.name === "render_cross_client",
    )!;
    await t.handler({ html: "<p>x</p>" });
    expect(c.inboxReality.render).toHaveBeenCalledWith({
      html: "<p>x</p>",
      environments: [],
    });
  });

  it("inbox_report forwards campaign id to getCampaignReport", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = deliverabilityTools(c.client as any).find(
      (x) => x.name === "inbox_report",
    )!;
    await t.handler({ campaign_id: "cmp_001" });
    expect(c.inboxReality.getCampaignReport).toHaveBeenCalledWith("cmp_001");
  });

  it("predict_placement schema rejects missing html", () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = deliverabilityTools(c.client as any).find(
      (x) => x.name === "predict_placement",
    )!;
    expect(t.schema.safeParse({ subject: "S" }).success).toBe(false);
  });
});

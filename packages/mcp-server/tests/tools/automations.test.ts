// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import { automationTools } from "../../src/tools/automations.js";

function makeClient() {
  const automations = {
    create: vi.fn().mockResolvedValue({ id: "atm_001", status: "draft" }),
    list: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    update: vi.fn().mockResolvedValue({ id: "atm_001", status: "active" }),
    createBehavioralTrigger: vi.fn().mockResolvedValue({ id: "bt_001", automation_id: "atm_001" }),
  };
  return { client: { automations }, automations };
}

describe("automationTools", () => {
  it("exposes 4 tools with unique zod schemas", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = automationTools(client as any);
    expect(tools).toHaveLength(4);
    for (const t of tools) {
      expect(t.schema).toBeInstanceOf(z.ZodObject);
      expect(t.description.length).toBeGreaterThan(20);
    }
    expect(tools.map((t) => t.name).sort()).toEqual([
      "automation_create",
      "automation_create_behavioral_trigger",
      "automation_list",
      "automation_update",
    ]);
  });

  it("automation_create forwards graph payload", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = automationTools(c.client as any).find((x) => x.name === "automation_create")!;
    await t.handler({
      name: "n",
      triggers: [{ type: "manual" }],
      nodes: [{ id: "n1", type: "send_email" }],
      edges: [],
    });
    expect(c.automations.create).toHaveBeenCalledTimes(1);
  });

  it("automation_create_behavioral_trigger splits id from rest", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = automationTools(c.client as any).find(
      (x) => x.name === "automation_create_behavioral_trigger",
    )!;
    await t.handler({
      automation_id: "atm_001",
      trigger_type: "campaign_opened",
      campaign_id: "cmp_001",
      within_days: 7,
    });
    expect(c.automations.createBehavioralTrigger).toHaveBeenCalledWith("atm_001", {
      trigger_type: "campaign_opened",
      campaign_id: "cmp_001",
      within_days: 7,
    });
  });

  it("automation_list wraps SDK errors", async () => {
    const c = makeClient();
    c.automations.list.mockRejectedValueOnce(new Error("boom"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = automationTools(c.client as any).find((x) => x.name === "automation_list")!;
    await expect(t.handler({})).rejects.toThrow(/automation_list/);
  });
});

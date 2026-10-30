// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import { agentPrimitiveTools } from "../../src/tools/agent_primitives.js";

function makeClient() {
  const audit = { query: vi.fn().mockResolvedValue({ items: [], next_cursor: null }) };
  const approvals = {
    list: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    decide: vi.fn().mockResolvedValue({ id: "ap_001", status: "approved" }),
  };
  const sandbox = {
    status: vi.fn().mockResolvedValue({
      campaign_id: "cmp_001",
      state: "running",
      scheduled_remaining: 5,
      events: [],
    }),
  };
  const cost = {
    aggregate: vi.fn().mockResolvedValue({ since: "2026-01-01", group_by: "kind", buckets: [] }),
  };
  const safety = {
    check: vi.fn().mockResolvedValue({ ok: true, blocking: false, findings: [] }),
  };
  return {
    client: { audit, approvals, sandbox, cost, safety },
    audit,
    approvals,
    sandbox,
    cost,
    safety,
  };
}

describe("agentPrimitiveTools", () => {
  it("exposes 6 tools", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = agentPrimitiveTools(client as any);
    expect(tools).toHaveLength(6);
    for (const t of tools) expect(t.schema).toBeInstanceOf(z.ZodObject);
  });

  it("approvals_decide forwards id and decision", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = agentPrimitiveTools(c.client as any).find((x) => x.name === "approvals_decide")!;
    await t.handler({ id: "ap_001", decision: "approve", notes: "lgtm" });
    expect(c.approvals.decide).toHaveBeenCalledWith("ap_001", { decision: "approve", notes: "lgtm" });
  });

  it("cost_aggregate requires since + group_by", () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = agentPrimitiveTools(c.client as any).find((x) => x.name === "cost_aggregate")!;
    expect(t.schema.safeParse({}).success).toBe(false);
    expect(t.schema.safeParse({ since: "2026-01-01", group_by: "day" }).success).toBe(true);
  });

  it("safety_check wraps SDK errors", async () => {
    const c = makeClient();
    c.safety.check.mockRejectedValueOnce(new Error("nope"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = agentPrimitiveTools(c.client as any).find((x) => x.name === "safety_check")!;
    await expect(
      t.handler({
        subject: "s",
        body_html: "<p>x</p>",
        body_text: "x",
        intended_audience_count: 100,
      }),
    ).rejects.toThrow(/safety_check/);
  });
});

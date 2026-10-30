// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import { eventTools } from "../../src/tools/events.js";

function makeClient() {
  const events = {
    subscribe: vi.fn().mockResolvedValue({
      subscription_id: "sub_001",
      resource_uri: "moosewave://events/stream?type=opened",
    }),
  };
  return { client: { events }, events };
}

describe("eventTools", () => {
  it("exposes 1 tool", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = eventTools(client as any);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("events_subscribe");
    expect(tools[0]!.schema).toBeInstanceOf(z.ZodObject);
  });

  it("events_subscribe forwards filter payload", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = eventTools(c.client as any)[0]!;
    await t.handler({ event_types: ["opened"], campaign_id: "cmp_001" });
    expect(c.events.subscribe).toHaveBeenCalledWith({
      event_types: ["opened"],
      campaign_id: "cmp_001",
    });
  });

  it("events_subscribe wraps SDK errors", async () => {
    const c = makeClient();
    c.events.subscribe.mockRejectedValueOnce(new Error("boom"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = eventTools(c.client as any)[0]!;
    await expect(t.handler({})).rejects.toThrow(/events_subscribe/);
  });
});

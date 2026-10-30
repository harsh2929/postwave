// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import { topicTools } from "../../src/tools/topics.js";

function makeClient() {
  const topics = {
    create: vi.fn().mockResolvedValue({ id: "tpc_001", slug: "news" }),
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue({ ok: true }),
    subscribe: vi.fn().mockResolvedValue({ ok: true }),
    unsubscribe: vi.fn().mockResolvedValue({ ok: true }),
  };
  return { client: { topics }, topics };
}

describe("topicTools", () => {
  it("exposes 5 tools", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = topicTools(client as any);
    expect(tools).toHaveLength(5);
    for (const t of tools) expect(t.schema).toBeInstanceOf(z.ZodObject);
  });

  it("topic_subscribe forwards both args", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = topicTools(c.client as any).find((x) => x.name === "topic_subscribe")!;
    await t.handler({ subscriber_email: "user@example.invalid", topic_id: "tpc_001" });
    expect(c.topics.subscribe).toHaveBeenCalledWith("user@example.invalid", "tpc_001");
  });

  it("topic_create wraps SDK errors", async () => {
    const c = makeClient();
    c.topics.create.mockRejectedValueOnce(new Error("dup"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = topicTools(c.client as any).find((x) => x.name === "topic_create")!;
    await expect(t.handler({ slug: "news", name: "News" })).rejects.toThrow(/topic_create/);
  });
});

// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import { subscriberTools } from "../../src/tools/subscribers.js";

function makeClient() {
  const subscribers = {
    list: vi.fn().mockResolvedValue({ items: [] }),
    search: vi.fn().mockResolvedValue({ items: [] }),
    create: vi.fn().mockResolvedValue({ id: "s_001", email: "x@example.invalid" }),
    suppress: vi.fn().mockResolvedValue(undefined),
    customFieldCreate: vi.fn().mockResolvedValue({
      id: "cf_001",
      key: "plan",
      label: "Plan",
      type: "string",
    }),
  };
  const segments = {
    create: vi.fn().mockResolvedValue({ id: "seg_001", name: "n" }),
    list: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    delete: vi.fn().mockResolvedValue({ ok: true }),
    compileFromNaturalLanguage: vi.fn().mockResolvedValue({ query_ast: { op: "leaf" } }),
  };
  const request = vi.fn().mockResolvedValue({ count: 0, sample: [] });
  return { client: { subscribers, segments, request }, subscribers, segments, request };
}

describe("subscriberTools", () => {
  it("exposes 11 tools", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = subscriberTools(client as any);
    expect(tools).toHaveLength(11);
    for (const t of tools) expect(t.schema).toBeInstanceOf(z.ZodObject);
  });

  it("custom_field_create forwards args to SDK", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = subscriberTools(c.client as any).find((x) => x.name === "custom_field_create")!;
    await t.handler({ key: "plan", label: "Plan", type: "string" });
    expect(c.subscribers.customFieldCreate).toHaveBeenCalledWith({
      key: "plan",
      label: "Plan",
      type: "string",
    });
  });

  it("segment_compile_from_text forwards text", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = subscriberTools(c.client as any).find((x) => x.name === "segment_compile_from_text")!;
    await t.handler({ text: "openers in last 7 days" });
    expect(c.segments.compileFromNaturalLanguage).toHaveBeenCalledWith("openers in last 7 days");
  });

  it("segment_create forwards full payload", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = subscriberTools(c.client as any).find((x) => x.name === "segment_create")!;
    await t.handler({
      name: "n",
      description: "d",
      query_ast: { op: "leaf", field: "email", comparator: "eq", value: "x" },
    });
    expect(c.segments.create).toHaveBeenCalledTimes(1);
  });
});

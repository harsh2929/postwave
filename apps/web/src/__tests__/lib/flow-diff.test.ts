// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import { diffGraphs, stableStringify, summarizeDiff } from "@/lib/flow-diff";
import type { FlowGraph } from "@/lib/flows-api";

const base: FlowGraph = {
  entry_id: "a",
  triggers: [{ type: "list_joined" }],
  nodes: [
    { id: "a", type: "send_email", template_id: "t1" },
    { id: "b", type: "wait", duration_seconds: 60 },
  ],
  edges: [{ from: "a", to: "b" }],
};

describe("diffGraphs", () => {
  it("reports identical for the same graph", () => {
    expect(diffGraphs(base, base).identical).toBe(true);
    expect(summarizeDiff(diffGraphs(base, base))).toBe("No changes");
  });

  it("detects added, removed, and changed nodes", () => {
    const next: FlowGraph = {
      entry_id: "a",
      triggers: [{ type: "list_joined" }],
      nodes: [
        { id: "a", type: "send_email", template_id: "t2" }, // changed
        { id: "c", type: "send_sms", sms_body: "hi" }, // added
      ],
      edges: [],
    };
    const d = diffGraphs(base, next);
    expect(d.changedNodes).toEqual(["a"]);
    expect(d.addedNodes).toEqual(["c"]);
    expect(d.removedNodes).toEqual(["b"]);
    expect(d.identical).toBe(false);
  });

  it("is insensitive to key order when comparing node bodies", () => {
    const reordered: FlowGraph = {
      ...base,
      nodes: [
        { type: "send_email", id: "a", template_id: "t1" },
        { duration_seconds: 60, type: "wait", id: "b" },
      ],
    };
    expect(diffGraphs(base, reordered).identical).toBe(true);
  });
});

describe("stableStringify", () => {
  it("sorts object keys recursively", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });
});

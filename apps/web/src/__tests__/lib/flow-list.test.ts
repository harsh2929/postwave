// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import { countFlowStatuses, filterSortFlows } from "@/lib/flow-list";
import type { Flow } from "@/lib/flows-api";

const flow = (over: Partial<Flow>): Flow => ({
  id: over.id ?? "1",
  name: over.name ?? "Flow",
  status: over.status ?? "draft",
  version: 1,
  graph: { nodes: [] },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: over.updated_at ?? "2026-01-01T00:00:00Z",
  ...over,
});

const flows: Flow[] = [
  flow({ id: "1", name: "Welcome", status: "active", updated_at: "2026-01-03T00:00:00Z" }),
  flow({ id: "2", name: "Abandoned cart", status: "draft", updated_at: "2026-01-05T00:00:00Z" }),
  flow({ id: "3", name: "Win-back", status: "paused", updated_at: "2026-01-01T00:00:00Z" }),
];

describe("filterSortFlows", () => {
  it("filters by status", () => {
    const out = filterSortFlows(flows, {
      q: "",
      status: "active",
      sort: "updated",
      order: "desc",
    });
    expect(out.map((f) => f.id)).toEqual(["1"]);
  });

  it("searches by name (case-insensitive)", () => {
    const out = filterSortFlows(flows, {
      q: "win",
      status: "all",
      sort: "updated",
      order: "desc",
    });
    expect(out.map((f) => f.id)).toEqual(["3"]);
  });

  it("sorts by updated desc (newest first) by default", () => {
    const out = filterSortFlows(flows, {
      q: "",
      status: "all",
      sort: "updated",
      order: "desc",
    });
    expect(out.map((f) => f.id)).toEqual(["2", "1", "3"]);
  });

  it("sorts by name asc", () => {
    const out = filterSortFlows(flows, {
      q: "",
      status: "all",
      sort: "name",
      order: "asc",
    });
    expect(out.map((f) => f.name)).toEqual([
      "Abandoned cart",
      "Welcome",
      "Win-back",
    ]);
  });
});

describe("countFlowStatuses", () => {
  it("counts per status and total", () => {
    const c = countFlowStatuses(flows);
    expect(c.all).toBe(3);
    expect(c.active).toBe(1);
    expect(c.draft).toBe(1);
    expect(c.paused).toBe(1);
    expect(c.archived).toBe(0);
  });
});

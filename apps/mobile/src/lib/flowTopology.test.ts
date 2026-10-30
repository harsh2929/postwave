/**
 * lib/flowTopology.test.ts — the ordering rules, and the honesty of the claim
 * the order makes.
 *
 * The three cases that matter are the three `FlowTopology.origin` values: only
 * "entry" is EXECUTION order, and a screen that rendered the other two as
 * though they were would be asserting an ordering the server never claimed.
 */
import { describe, expect, it } from "vitest";

import { parseFlow, type MobileFlow } from "./flowWire";
import {
  buildFlowTopology,
  flowNodeKind,
  flowNodeLabel,
  flowRuntimeExecuting,
  flowStatusPresentation,
  flowTopologyOrderNote,
  flowTriggerLabel,
  reEnrollmentLabel,
  FLOW_TOPOLOGY_MAX_DEPTH,
} from "./flowTopology";

function flow(graph: Record<string, unknown>): MobileFlow {
  return parseFlow({ id: "f-1", name: "F", status: "draft", graph })!;
}

const ids = (topology: ReturnType<typeof buildFlowTopology>) =>
  topology.rows.map((row) => row.node.id);

describe("flowStatusPresentation", () => {
  it("refuses to call a flow Active while the runtime is contained", () => {
    // flowbuilder.go:27 `flowRuntimeQualified = false` — ActivateFlow is a
    // bare 503, so "active" is a stored label, never a claim about the world.
    const contained = flowStatusPresentation("active", false);

    expect(contained.label).toBe("Legacy active");
    expect(contained.tone).toBe("warning");
    expect(contained.spoken).toMatch(/not running/i);
  });

  it("says Active plainly on the day execution is genuinely enabled", () => {
    const live = flowStatusPresentation("active", true);

    expect(live.label).toBe("Active");
    expect(live.tone).toBe("success");
  });

  it("gives every state a spoken sentence, so state is never colour-alone", () => {
    for (const status of ["draft", "active", "paused", "archived"]) {
      expect(flowStatusPresentation(status, false).spoken.length).toBeGreaterThan(0);
    }
  });

  it("shows an unrecognised status verbatim rather than guessing", () => {
    const unknown = flowStatusPresentation("quarantined", false);

    expect(unknown.label).toBe("quarantined");
    expect(unknown.tone).toBe("neutral");
  });
});

describe("flowRuntimeExecuting", () => {
  it("treats an absent descriptor as contained, never as running", () => {
    expect(flowRuntimeExecuting(null)).toBe(false);
    expect(flowRuntimeExecuting({ executionEnabled: false })).toBe(false);
    expect(flowRuntimeExecuting({ executionEnabled: true })).toBe(true);
  });
});

describe("reEnrollmentLabel", () => {
  it("distinguishes an unset policy from the 'once' default", () => {
    // Inventing "Enters once" for a blank column states a policy nobody set.
    expect(reEnrollmentLabel("", null)).toBe("Re-entry policy not set");
    expect(reEnrollmentLabel("once", null)).toBe("Enters once");
  });

  it("names the cooldown window when there is one, and omits it when there is not", () => {
    expect(reEnrollmentLabel("cooldown", 48)).toBe("Can re-enter after 48h");
    expect(reEnrollmentLabel("cooldown", null)).toBe(
      "Can re-enter after a cooldown",
    );
  });
});

describe("labels", () => {
  it("mirrors the server catalog for known keys", () => {
    expect(flowNodeLabel("send_email")).toBe("Email message");
    expect(flowTriggerLabel("list_joined")).toBe("Joined list");
  });

  it("falls back to the raw key so a newer server is not described as broken", () => {
    expect(flowNodeLabel("send_whatsapp")).toBe("send_whatsapp");
    expect(flowTriggerLabel("cart_abandoned")).toBe("cart_abandoned");
  });

  it("groups the node types a reader scans for", () => {
    expect(flowNodeKind("wait")).toBe("wait");
    expect(flowNodeKind("send_sms")).toBe("message");
    expect(flowNodeKind("branch")).toBe("split");
    expect(flowNodeKind("exit")).toBe("control");
    expect(flowNodeKind("webhook")).toBe("action");
  });
});

describe("buildFlowTopology — origin: entry", () => {
  it("walks from entry_id, which is the only true execution order", () => {
    const topology = buildFlowTopology(
      flow({
        entry_id: "a",
        nodes: [{ id: "c", type: "exit" }, { id: "a", type: "send_email" }, { id: "b", type: "wait" }],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "c" },
        ],
      }),
    );

    expect(topology.origin).toBe("entry");
    expect(topology.entryId).toBe("a");
    // Stored order was c, a, b — the walk order is what is rendered.
    expect(ids(topology)).toEqual(["a", "b", "c"]);
    expect(flowTopologyOrderNote(topology)).toMatch(/entry step/i);
  });

  it("prints a branch's yes leg above its no leg, each under the split", () => {
    const topology = buildFlowTopology(
      flow({
        entry_id: "split",
        nodes: [
          { id: "split", type: "branch", true_next: "yes", false_next: "no" },
          { id: "yes", type: "send_email" },
          { id: "no", type: "exit" },
        ],
      }),
    );

    expect(ids(topology)).toEqual(["split", "yes", "no"]);
    expect(topology.rows[1]?.leg).toBe("true");
    expect(topology.rows[2]?.leg).toBe("false");
    // Depth-first: the consequences sit under the split, not beside it.
    expect(topology.rows[1]?.depth).toBe(1);
  });

  it("ignores an entry_id that names no node and falls back to roots", () => {
    const topology = buildFlowTopology(
      flow({
        entry_id: "ghost",
        nodes: [{ id: "a", type: "wait" }, { id: "b", type: "exit" }],
        edges: [{ from: "a", to: "b" }],
      }),
    );

    expect(topology.origin).toBe("roots");
    expect(topology.entryId).toBeNull();
    expect(ids(topology)).toEqual(["a", "b"]);
  });
});

describe("buildFlowTopology — origin: roots and declaration", () => {
  it("starts from the nodes nothing points at when there is no entry", () => {
    const topology = buildFlowTopology(
      flow({
        nodes: [{ id: "a", type: "wait" }, { id: "b", type: "exit" }],
        edges: [{ from: "a", to: "b" }],
      }),
    );

    expect(topology.origin).toBe("roots");
    expect(flowTopologyOrderNote(topology)).toMatch(/names no entry step/i);
  });

  it("admits it cannot infer an order for a ring, and shows stored order", () => {
    const topology = buildFlowTopology(
      flow({
        nodes: [{ id: "a", type: "wait" }, { id: "b", type: "wait" }],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      }),
    );

    expect(topology.origin).toBe("declaration");
    expect(ids(topology)).toEqual(["a", "b"]);
    expect(flowTopologyOrderNote(topology)).toMatch(/not execution order/i);
  });

  it("does NOT cry 'unreachable' over every node of a ring", () => {
    // In the declaration case nothing was walked, so flagging all of them
    // would be a false alarm about a perfectly ordinary graph.
    const topology = buildFlowTopology(
      flow({
        nodes: [{ id: "a", type: "wait" }, { id: "b", type: "wait" }],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      }),
    );

    expect(topology.unreachableCount).toBe(0);
    expect(topology.rows.every((row) => row.unreachable === false)).toBe(true);
  });
});

describe("buildFlowTopology — safety and completeness", () => {
  it("terminates on a cycle instead of hanging the screen", () => {
    const topology = buildFlowTopology(
      flow({
        entry_id: "a",
        nodes: [{ id: "a", type: "wait" }, { id: "b", type: "wait" }],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      }),
    );

    expect(ids(topology)).toEqual(["a", "b"]);
  });

  it("survives a chain far deeper than the JS call stack", () => {
    // The reason the walk is an explicit stack rather than recursion: a
    // generated flow can be a long single chain, and a RangeError here takes
    // the whole screen down.
    const size = 20_000;
    const nodes = Array.from({ length: size }, (_, i) => ({
      id: `n${i}`,
      type: "wait",
    }));
    const edges = Array.from({ length: size - 1 }, (_, i) => ({
      from: `n${i}`,
      to: `n${i + 1}`,
    }));

    const topology = buildFlowTopology(flow({ entry_id: "n0", nodes, edges }));

    expect(topology.rows).toHaveLength(size);
    expect(topology.rows[0]?.node.id).toBe("n0");
    expect(topology.rows[size - 1]?.node.id).toBe(`n${size - 1}`);
  });

  it("shows an orphaned node instead of dropping it, and counts it", () => {
    // Dropping it would make the preview claim the flow is smaller than it is,
    // and an orphan is usually the reason someone opened the flow at all.
    const topology = buildFlowTopology(
      flow({
        entry_id: "a",
        nodes: [
          { id: "a", type: "send_email" },
          { id: "orphan", type: "send_sms" },
        ],
      }),
    );

    expect(ids(topology)).toEqual(["a", "orphan"]);
    expect(topology.unreachableCount).toBe(1);
    expect(topology.rows[1]?.unreachable).toBe(true);
  });

  it("caps rendered indent so deep nesting cannot run off the screen", () => {
    const depth = FLOW_TOPOLOGY_MAX_DEPTH + 4;
    const nodes = Array.from({ length: depth + 1 }, (_, i) => ({
      id: `n${i}`,
      type: "wait",
    }));
    const edges = Array.from({ length: depth }, (_, i) => ({
      from: `n${i}`,
      to: `n${i + 1}`,
    }));

    const topology = buildFlowTopology(flow({ entry_id: "n0", nodes, edges }));

    expect(Math.max(...topology.rows.map((row) => row.depth))).toBe(
      FLOW_TOPOLOGY_MAX_DEPTH,
    );
  });

  it("is empty, not broken, for a flow with no steps", () => {
    const topology = buildFlowTopology(flow({ nodes: [] }));

    expect(topology.rows).toEqual([]);
    expect(topology.origin).toBe("declaration");
  });

  it("is empty for a null flow rather than throwing", () => {
    expect(buildFlowTopology(null).rows).toEqual([]);
  });

  it("ignores an edge pointing at a node that does not exist", () => {
    const topology = buildFlowTopology(
      flow({
        entry_id: "a",
        nodes: [{ id: "a", type: "wait" }],
        edges: [{ from: "a", to: "ghost" }],
      }),
    );

    expect(ids(topology)).toEqual(["a"]);
    expect(topology.rows[0]?.nextIds).toEqual([]);
  });
});

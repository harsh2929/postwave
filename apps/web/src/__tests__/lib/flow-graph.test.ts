// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import {
  describeCondition,
  errorNodeIds,
  flowStatusBadgeVariant,
  hasTrigger,
  nodeOptionLabel,
  nodeRequiresReview,
  nodesRequiringReview,
  nodeSummary,
  removeFlowNode,
  serializeFlowState,
  triggerSummary,
} from "@/lib/flow-graph";
import type {
  CatalogItem,
  ConditionFieldSpec,
  FlowNode,
} from "@/lib/flows-api";

describe("removing a connected flow step", () => {
  it("cleans linear, conditional and weighted routes without losing variant settings", () => {
    const graph = {
      entry_id: "target",
      triggers: [{ type: "list_joined" }],
      nodes: [
        { id: "target", type: "send_email" },
        {
          id: "branch",
          type: "branch",
          true_next: "target",
          false_next: "keep",
        },
        {
          id: "ab",
          type: "ab_test",
          variants: [
            { id: "a", weight: 60, next: "target", label: "Offer A" },
            { id: "b", weight: 40, next: "keep" },
          ],
        },
        { id: "keep", type: "exit" },
      ],
      edges: [
        { from: "target", to: "keep" },
        { from: "keep", to: "target" },
      ],
      goals: [{ field: "custom.purchased", comparator: "exists" }],
    };
    const result = removeFlowNode(graph, "target");
    expect(result.nodes.map((node) => node.id)).toEqual([
      "branch",
      "ab",
      "keep",
    ]);
    expect(result.nodes[0]).toEqual({
      id: "branch",
      type: "branch",
      false_next: "keep",
    });
    expect(result.nodes[1].variants).toEqual([
      { id: "a", weight: 60, next: "", label: "Offer A" },
      { id: "b", weight: 40, next: "keep" },
    ]);
    expect(result.entry_id).toBe("branch");
    expect(result.edges).toEqual([]);
    expect(result.triggers).toEqual(graph.triggers);
    expect(result.goals).toEqual(graph.goals);
    expect(graph.nodes[1].true_next).toBe("target");
    expect(
      removeFlowNode(
        { nodes: [{ id: "only", type: "exit" }], entry_id: "only" },
        "only",
      ),
    ).toMatchObject({ nodes: [], entry_id: undefined });
  });
});

const nodeCatalog: CatalogItem[] = [
  {
    key: "send_email",
    label: "Email message",
    category: "message",
    runtime_status: "supported",
    requires_review: true,
  },
  {
    key: "wait",
    label: "Time delay",
    category: "wait",
    runtime_status: "supported",
  },
  {
    key: "branch",
    label: "Conditional split",
    category: "split",
    runtime_status: "supported",
  },
];

const conditionFields: ConditionFieldSpec[] = [
  {
    key: "custom.predicted_churn_risk",
    label: "Predicted churn risk",
    type: "number",
    category: "predictive",
  },
];

const triggerCatalog: CatalogItem[] = [
  {
    key: "list_joined",
    label: "Joined list",
    category: "trigger",
    runtime_status: "supported",
  },
  {
    key: "tag_added",
    label: "Tag added",
    category: "trigger",
    runtime_status: "supported",
  },
];

describe("flowStatusBadgeVariant", () => {
  it("never maps active to the brand-red default variant", () => {
    expect(flowStatusBadgeVariant("active")).toBe("success");
  });
  it("distinguishes paused / draft / archived", () => {
    expect(flowStatusBadgeVariant("paused")).toBe("warning");
    expect(flowStatusBadgeVariant("draft")).toBe("secondary");
    expect(flowStatusBadgeVariant("archived")).toBe("outline");
  });
});

describe("describeCondition", () => {
  it("resolves the dotted field key to its catalog label", () => {
    const out = describeCondition(
      { field: "custom.predicted_churn_risk", comparator: "gt", value: 0.5 },
      conditionFields,
    );
    expect(out).toBe("Predicted churn risk > 0.5");
  });
  it("handles the exists comparator and empty conditions", () => {
    expect(
      describeCondition({ field: "email", comparator: "exists" }, []),
    ).toBe("email exists");
    expect(describeCondition(null, conditionFields)).toBe("No condition set");
  });
});

describe("nodeSummary", () => {
  it("shows the resolved template name when a resolver is provided", () => {
    const node: FlowNode = {
      id: "a",
      type: "send_email",
      template_id: "tpl_9",
    };
    expect(
      nodeSummary(node, { resolveTemplateName: () => "Welcome email" }),
    ).toBe("Welcome email");
    expect(nodeSummary(node)).toBe("Template tpl_9");
  });
});

describe("nodeOptionLabel", () => {
  it("leads with a human label and disambiguates configured steps", () => {
    const a: FlowNode = { id: "n_a", type: "send_email", template_id: "t1" };
    const b: FlowNode = { id: "n_b", type: "send_email" };
    expect(nodeOptionLabel(a, nodeCatalog)).toBe("Email message — Template t1");
    // Unconfigured falls back to id but still leads with the human label.
    expect(nodeOptionLabel(b, nodeCatalog)).toBe("Email message · n_b");
  });
});

describe("hasTrigger / triggerSummary", () => {
  it("detects presence of a trigger", () => {
    expect(hasTrigger({ nodes: [], triggers: [] })).toBe(false);
    expect(hasTrigger({ nodes: [], triggers: [{ type: "list_joined" }] })).toBe(
      true,
    );
  });
  it("summarizes one and many triggers", () => {
    expect(
      triggerSummary(
        { nodes: [], triggers: [{ type: "list_joined" }] },
        triggerCatalog,
      ),
    ).toBe("Joined list");
    expect(
      triggerSummary(
        {
          nodes: [],
          triggers: [{ type: "list_joined" }, { type: "tag_added" }],
        },
        triggerCatalog,
      ),
    ).toBe("Joined list +1 more");
    expect(triggerSummary({ nodes: [] }, triggerCatalog)).toBe("No trigger");
  });
});

describe("review helpers", () => {
  it("flags nodes whose catalog entry requires review", () => {
    const email: FlowNode = { id: "e", type: "send_email" };
    const wait: FlowNode = { id: "w", type: "wait" };
    expect(nodeRequiresReview(email, nodeCatalog)).toBe(true);
    expect(nodeRequiresReview(wait, nodeCatalog)).toBe(false);
    expect(nodesRequiringReview([email, wait], nodeCatalog)).toEqual([email]);
  });
});

describe("errorNodeIds", () => {
  it("extracts quoted and bare node ids referenced by errors", () => {
    const nodes: FlowNode[] = [
      { id: "step_1", type: "send_email" },
      { id: "n_ab12", type: "wait" },
    ];
    const ids = errorNodeIds(
      ['node "step_1": duplicate id', "n_ab12 has no template"],
      nodes,
    );
    expect(ids.has("step_1")).toBe(true);
    expect(ids.has("n_ab12")).toBe(true);
  });
  it("does not match an id that is only a substring of another token", () => {
    const nodes: FlowNode[] = [{ id: "step", type: "wait" }];
    const ids = errorNodeIds(["problem in step_1 config"], nodes);
    expect(ids.has("step")).toBe(false);
  });
});

describe("serializeFlowState", () => {
  it("is stable for unchanged state and changes on graph edits", () => {
    const base = serializeFlowState({
      name: "A",
      reEnrollment: "once",
      cooldownHours: 72,
      graph: { nodes: [{ id: "x", type: "wait" }] },
    });
    const same = serializeFlowState({
      name: "A",
      reEnrollment: "once",
      cooldownHours: 999, // ignored while not on cooldown
      graph: { nodes: [{ id: "x", type: "wait" }] },
    });
    const changed = serializeFlowState({
      name: "A",
      reEnrollment: "once",
      cooldownHours: 72,
      graph: { nodes: [{ id: "x", type: "wait", duration_seconds: 60 }] },
    });
    expect(base).toBe(same);
    expect(base).not.toBe(changed);
  });
});

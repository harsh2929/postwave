// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  buildJourneySteps,
  describeNode,
} from "@/app/(dashboard)/app/flows/_components/flow-journey";
import type { FlowGraph } from "@/lib/flows-api";

const label = (t: string) => t.toUpperCase();

describe("buildJourneySteps (FLOW-010)", () => {
  it("walks a linear path from entry_id in order", () => {
    const g: FlowGraph = {
      entry_id: "a",
      nodes: [
        { id: "a", type: "send_email", template_id: "tpl1" },
        { id: "b", type: "wait", duration_seconds: 172800 },
        { id: "c", type: "send_email", template_id: "tpl2" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    };
    const steps = buildJourneySteps(g, label);
    expect(steps.map((s) => s.nodeId)).toEqual(["a", "b", "c"]);
    expect(steps[0]!.templateId).toBe("tpl1");
    expect(steps.every((s) => s.depth === 0)).toBe(true);
  });

  it("expands both legs of a branch, nested and labeled", () => {
    const g: FlowGraph = {
      entry_id: "cond",
      nodes: [
        { id: "cond", type: "branch", true_next: "yes", false_next: "no" },
        { id: "yes", type: "send_email", template_id: "y" },
        { id: "no", type: "exit" },
      ],
      edges: [],
    };
    const steps = buildJourneySteps(g, label);
    expect(steps.map((s) => s.nodeId)).toEqual(["cond", "yes", "no"]);
    const yes = steps.find((s) => s.nodeId === "yes")!;
    const no = steps.find((s) => s.nodeId === "no")!;
    expect(yes.branchLabel).toBe("Yes");
    expect(no.branchLabel).toBe("No");
    expect(yes.depth).toBe(1);
    expect(no.depth).toBe(1);
  });

  it("stops on a cycle with a loop-back note", () => {
    const g: FlowGraph = {
      entry_id: "a",
      nodes: [
        { id: "a", type: "send_email" },
        { id: "b", type: "wait", duration_seconds: 60 },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" }, // cycle
      ],
    };
    const steps = buildJourneySteps(g, label);
    // a, b, then a-again is annotated as a loop and not expanded further.
    expect(steps).toHaveLength(3);
    expect(steps[2]!.note).toMatch(/loops back/);
  });

  it("annotates a dangling edge target as a dead-end", () => {
    const g: FlowGraph = {
      entry_id: "a",
      nodes: [{ id: "a", type: "send_email" }],
      edges: [{ from: "a", to: "ghost" }],
    };
    const steps = buildJourneySteps(g, label);
    expect(steps[1]!.type).toBe("missing");
    expect(steps[1]!.note).toBe("dead-end");
  });

  it("falls back to the first node when entry_id is unset/invalid", () => {
    const g: FlowGraph = {
      nodes: [{ id: "first", type: "send_email" }],
      edges: [],
    };
    expect(buildJourneySteps(g, label)[0]!.nodeId).toBe("first");
  });
});

describe("describeNode", () => {
  it("humanizes a multi-day wait", () => {
    expect(describeNode({ id: "w", type: "wait", duration_seconds: 172800 })).toContain(
      "2 days",
    );
  });
  it("notes a template-less email honestly", () => {
    expect(describeNode({ id: "e", type: "send_email" })).toMatch(/no template/i);
  });

  // TMPL-C: the journey preview read "Sends the email from template
  // 8b7d95b5-…" while the canvas named the same template.
  const TEMPLATE_ID = "8b7d95b5-9d6c-4ff3-bc37-616ad388fe49";
  const email = { id: "e", type: "send_email", template_id: TEMPLATE_ID };

  it("names the template a send step uses", () => {
    const names = new Map([[TEMPLATE_ID, "First-Sentence Welcome"]]);
    const detail = describeNode(email, (id) => names.get(id));
    expect(detail).toBe("Sends “First-Sentence Welcome”");
    expect(detail).not.toContain(TEMPLATE_ID);
  });

  it.each([
    ["no resolver", undefined],
    ["an unknown id", () => undefined],
    ["a blank name", () => "   "],
  ])("never shows the raw id with %s", (_case, resolver) => {
    const detail = describeNode(email, resolver);
    expect(detail).toBe("Sends an email from a template that couldn’t be loaded");
    expect(detail).not.toContain(TEMPLATE_ID);
  });

  it("threads the resolver through the journey walk", () => {
    const graph: FlowGraph = {
      entry_id: "e",
      nodes: [email],
      edges: [],
    } as unknown as FlowGraph;
    const [step] = buildJourneySteps(graph, (type) => type, (id) =>
      id === TEMPLATE_ID ? "First-Sentence Welcome" : undefined,
    );
    expect(step?.detail).toBe("Sends “First-Sentence Welcome”");
    // The preview action still needs the id.
    expect(step?.templateId).toBe(TEMPLATE_ID);
  });
});

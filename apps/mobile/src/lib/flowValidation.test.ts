/**
 * The wiring check has exactly two ways to lie, and both are worse than not
 * shipping it:
 *
 *   1. Send a graph the server cannot judge and report the answer anyway. The
 *      server's required-field check reads values that are authored FLAT on the
 *      node, so a request body that narrows a node to {id,type,…} strips the
 *      evidence and comes back claiming fields are missing that are present.
 *   2. Drop a warning. The runtime-status lines are noise TODAY because the
 *      runtime is contained; a filter that is one character too loose would
 *      silently swallow a real defect.
 *
 * Every payload below is the literal `fmt.Sprintf` output of
 * flowbuilder.go's Validate().
 */
import { describe, expect, it } from "vitest";

import {
  flowValidateBody,
  flowValidationErrorMessage,
  flowValidationSummary,
  isRuntimeStatusWarning,
  parseFlowValidation,
} from "@/lib/flowValidation";

const GRAPH = {
  entryId: "n1",
  triggers: [{ raw: { type: "list_joined", list_id: "7" } }],
  nodes: [
    // Exactly as apps/web authors it: template_id FLAT, plus canvas position.
    {
      raw: {
        id: "n1",
        type: "send_email",
        template_id: "42",
        position: { x: 120, y: 40 },
      },
    },
    { raw: { id: "n2", type: "exit" } },
  ],
  edges: [{ from: "n1", to: "n2" }],
};

describe("flowValidateBody", () => {
  it("SENDS THE NODE WHOLE — narrowing it is what breaks the verdict", () => {
    const body = flowValidateBody(GRAPH);
    expect(body.nodes[0]).toEqual({
      id: "n1",
      type: "send_email",
      template_id: "42",
      position: { x: 120, y: 40 },
    });
    // `template_id` is the field the server's required-field check looks for.
    // A projection down to NodeSpec's five keys would drop it and the server
    // would answer "required field template_id is missing" about a node that
    // carries one.
    expect(body.nodes[0]).toHaveProperty("template_id", "42");
  });

  it("copies each node rather than aliasing the cached graph", () => {
    const body = flowValidateBody(GRAPH);
    expect(body.nodes[0]).not.toBe(GRAPH.nodes[0]!.raw);
  });

  it("omits entry_id when the graph names none", () => {
    // `graphFromJourney` assembles a graph with no entry_id at all. Sending ""
    // would make the validator check a reference nobody ever wrote.
    const body = flowValidateBody({ ...GRAPH, entryId: null });
    expect("entry_id" in body).toBe(false);
    expect(flowValidateBody(GRAPH).entry_id).toBe("n1");
  });

  it("omits empty trigger and edge arrays instead of sending []", () => {
    const body = flowValidateBody({
      entryId: null,
      triggers: [],
      nodes: [{ raw: { id: "a", type: "exit" } }],
      edges: [],
    });
    expect("triggers" in body).toBe(false);
    expect("edges" in body).toBe(false);
    expect(body.nodes).toHaveLength(1);
  });

  it("narrows an edge to from/to, which is all EdgeSpec has", () => {
    const body = flowValidateBody(GRAPH);
    expect(body.edges).toEqual([{ from: "n1", to: "n2" }]);
  });
});

describe("isRuntimeStatusWarning", () => {
  it("matches the runtime-status line for each status Validate can emit", () => {
    for (const status of ["unavailable", "planned", "partial"]) {
      expect(
        isRuntimeStatusWarning(`node "n1": type "send_email" is ${status}`),
      ).toBe(true);
    }
  });

  it("NEVER swallows a warning that names a real defect", () => {
    // Dropping one of these is strictly worse than printing a redundant line.
    expect(
      isRuntimeStatusWarning(
        'node "n4" (send_email): required field "template_id" is missing',
      ),
    ).toBe(false);
    expect(
      isRuntimeStatusWarning(
        'branch node "n7" should define true_next and false_next',
      ),
    ).toBe(false);
    // A future warning that merely starts the same way must survive too.
    expect(
      isRuntimeStatusWarning('node "n1": type "send_email" is deprecated soon'),
    ).toBe(false);
  });
});

describe("parseFlowValidation", () => {
  it("partitions the runtime noise out of the real findings", () => {
    const parsed = parseFlowValidation({
      valid: true,
      executable: false,
      warnings: [
        'node "n1": type "send_email" is unavailable',
        'node "n2": type "wait" is unavailable',
        'node "n3": type "exit" is unavailable',
        'node "n1" (send_email): required field "template_id" is missing',
        'branch node "n4" should define true_next and false_next',
      ],
      supported_nodes: 0,
      planned_nodes: 3,
      unsupported_nodes: 0,
      runtime: {
        capability: "flow_execution",
        runtime_status: "unavailable",
        execution_enabled: false,
        message: "Flow execution is unavailable",
      },
    })!;

    expect(parsed.runtimeWarningCount).toBe(3);
    expect(parsed.graphWarnings).toEqual([
      'node "n1" (send_email): required field "template_id" is missing',
      'branch node "n4" should define true_next and false_next',
    ]);
    expect(parsed.runtime?.executionEnabled).toBe(false);
  });

  it("reads the 422 body — the case a status-only client cannot report", () => {
    const parsed = parseFlowValidation({
      valid: false,
      executable: false,
      errors: [
        "entry_id does not reference a node",
        'edge to "ghost" does not reference a node',
      ],
      supported_nodes: 1,
      planned_nodes: 0,
      unsupported_nodes: 0,
    })!;
    expect(parsed.valid).toBe(false);
    expect(parsed.errors).toHaveLength(2);
    expect(parsed.supported).toBe(1);
  });

  it("only a literal true may claim a graph is executable", () => {
    expect(parseFlowValidation({ valid: true })!.executable).toBe(false);
    expect(
      parseFlowValidation({ valid: true, executable: "yes" })!.executable,
    ).toBe(false);
    expect(
      parseFlowValidation({ valid: true, executable: true })!.executable,
    ).toBe(true);
  });

  it("returns null for a body carrying no verdict at all", () => {
    expect(parseFlowValidation(null)).toBeNull();
    expect(parseFlowValidation({ error: { code: "not_found" } })).toBeNull();
    expect(parseFlowValidation("nope")).toBeNull();
  });

  it("never turns a missing count into a confident number", () => {
    const parsed = parseFlowValidation({ valid: true })!;
    expect(parsed.supported).toBe(0);
    expect(parsed.planned).toBe(0);
    expect(parsed.graphWarnings).toEqual([]);
    expect(parsed.runtime).toBeNull();
  });
});

describe("flowValidationSummary", () => {
  const base = {
    valid: true,
    executable: false,
    errors: [] as string[],
    graphWarnings: [] as string[],
    runtimeWarningCount: 0,
    supported: 0,
    planned: 0,
    unsupported: 0,
    runtime: null,
  };

  it("leads with errors when there are any", () => {
    const s = flowValidationSummary({
      ...base,
      valid: false,
      errors: ["entry_id does not reference a node"],
      graphWarnings: ["something else"],
    });
    expect(s.tone).toBe("danger");
    expect(s.headline).toBe("1 problem in this flow's wiring");
  });

  it("reports incomplete steps when the wiring itself holds", () => {
    const s = flowValidationSummary({
      ...base,
      graphWarnings: ["a", "b"],
    });
    expect(s.tone).toBe("warning");
    expect(s.headline).toBe("2 steps need attention");
  });

  it("DOES NOT fold `executable` into the verdict", () => {
    // `executable` is false for every flow in every workspace while the
    // runtime is contained. Folding it in would report a perfectly wired flow
    // as a problem, and the screen already states the containment once above.
    const s = flowValidationSummary({ ...base, executable: false });
    expect(s.tone).toBe("success");
    expect(s.headline).toBe("No wiring problems found");
  });

  it("mentions unrecognised step types on an otherwise clean graph", () => {
    const s = flowValidationSummary({ ...base, unsupported: 2 });
    expect(s.tone).toBe("success");
    expect(s.detail).toContain("2 steps");
  });
});

describe("flowValidationErrorMessage", () => {
  it("calls an OLD API what it is, not a broken flow", () => {
    // `ValidateGraph` used to reject any authored node with 400 unknown_field.
    // Reporting that as "your flow has problems" would be a lie about the
    // operator's data.
    const message = flowValidationErrorMessage(
      Object.assign(new Error("Request body contains an unknown field."), {
        status: 400,
        code: "unknown_field",
      }),
    );
    expect(message).toContain("older than this app");
    expect(message).toContain("Nothing is wrong with the flow itself");
  });

  it("names the role floor on a 403 rather than blaming the flow", () => {
    expect(
      flowValidationErrorMessage(
        Object.assign(new Error("forbidden"), { status: 403 }),
      ),
    ).toContain("edit access to campaigns");
  });

  it("distinguishes an unreachable server from a rejected request", () => {
    expect(
      flowValidationErrorMessage(
        Object.assign(new Error("network down"), { status: 0 }),
      ),
    ).toContain("Couldn't reach the server");
    expect(
      flowValidationErrorMessage(
        Object.assign(new Error("boom"), { status: 503 }),
      ),
    ).toContain("unavailable right now");
  });
});

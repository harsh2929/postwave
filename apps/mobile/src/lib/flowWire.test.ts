/**
 * lib/flowWire.test.ts — the parse contract against payloads shaped exactly
 * like the Go handlers write them.
 *
 * The failures pinned here are the ones that empty a screen silently: the two
 * routes use DIFFERENT envelopes (a bare object vs `pagination.Envelope`), and
 * a missing `execution_enabled` must never read as "yes, this flow is running".
 */
import { describe, expect, it } from "vitest";

import {
  flowTimestamp,
  parseFlow,
  parseFlowPage,
  parseFlowRuntime,
  parseFlowVersion,
  parseFlowVersionList,
} from "./flowWire";

/** `annotateFlowRuntime` stamps exactly this onto every Flow. */
const RUNTIME = {
  capability: "flow_execution",
  runtime_status: "unavailable",
  execution_enabled: false,
  code: "flow_runtime_unavailable",
  message: "Flow execution is unavailable; the flow was not activated.",
  prerequisites: ["tenant_scoped_worker_authority", "durable_claim_recovery"],
};

function flowPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "f-1",
    name: "Welcome series",
    status: "draft",
    version: 3,
    re_enrollment: "once",
    re_enrollment_cooldown_hours: 0,
    graph: {
      entry_id: "n1",
      triggers: [{ type: "list_joined", list_id: "l-1" }],
      nodes: [
        { id: "n1", type: "send_email", template_id: "tpl-1" },
        { id: "n2", type: "wait", duration_seconds: 86_400 },
      ],
      edges: [{ from: "n1", to: "n2" }],
      goals: [],
    },
    published_at: null,
    created_at: "2026-06-01T09:00:00Z",
    updated_at: "2026-07-01T09:00:00Z",
    runtime: RUNTIME,
    ...overrides,
  };
}

describe("flowTimestamp", () => {
  it("rejects Go's zero time rather than rendering the year 1", () => {
    expect(flowTimestamp("0001-01-01T00:00:00Z")).toBeNull();
  });

  it("rejects an unparseable string rather than passing it to a date renderer", () => {
    expect(flowTimestamp("not a date")).toBeNull();
    expect(flowTimestamp("")).toBeNull();
    expect(flowTimestamp(null)).toBeNull();
  });

  it("keeps a real instant untouched", () => {
    expect(flowTimestamp("2026-07-01T09:00:00Z")).toBe("2026-07-01T09:00:00Z");
  });
});

describe("parseFlowRuntime", () => {
  it("carries the containment descriptor the server actually sends", () => {
    const runtime = parseFlowRuntime(RUNTIME);

    expect(runtime).not.toBeNull();
    expect(runtime?.executionEnabled).toBe(false);
    expect(runtime?.code).toBe("flow_runtime_unavailable");
    expect(runtime?.prerequisites).toHaveLength(2);
  });

  it("treats a MISSING execution_enabled as not executing", () => {
    // The single most consequential claim on the surface. A truthy default
    // would paint a green "Active" pill on a flow that has never run.
    const runtime = parseFlowRuntime({
      capability: "flow_execution",
      runtime_status: "unavailable",
    });

    expect(runtime?.executionEnabled).toBe(false);
  });

  it("treats a string 'true' as not executing, because only a literal counts", () => {
    const runtime = parseFlowRuntime({
      capability: "flow_execution",
      runtime_status: "available",
      execution_enabled: "true",
    });

    expect(runtime?.executionEnabled).toBe(false);
  });

  it("is null when the field is absent, rather than a hollow descriptor", () => {
    expect(parseFlowRuntime(undefined)).toBeNull();
    expect(parseFlowRuntime({})).toBeNull();
  });
});

describe("parseFlow", () => {
  it("parses the graph the list row already carries", () => {
    const flow = parseFlow(flowPayload())!;

    expect(flow.id).toBe("f-1");
    expect(flow.entryId).toBe("n1");
    expect(flow.nodes).toHaveLength(2);
    expect(flow.edges).toEqual([{ from: "n1", to: "n2" }]);
    expect(flow.triggers[0]?.type).toBe("list_joined");
  });

  it("returns null for a row with no id, which cannot be keyed or fetched", () => {
    expect(parseFlow({ name: "orphan" })).toBeNull();
    expect(parseFlow(null)).toBeNull();
  });

  it("labels an unnamed flow without claiming the field held that text", () => {
    expect(parseFlow(flowPayload({ name: "" }))!.name).toBe("Untitled flow");
  });

  it("drops a node with no id: it cannot be an edge target or a list key", () => {
    const flow = parseFlow(
      flowPayload({
        graph: { nodes: [{ type: "wait" }, { id: "n9", type: "exit" }] },
      }),
    )!;

    expect(flow.nodes).toHaveLength(1);
    expect(flow.nodes[0]?.id).toBe("n9");
  });

  it("carries cooldown hours ONLY under the cooldown policy", () => {
    // Otherwise a UI prints "0 h" beside "Enters once", which is a policy
    // nobody set rendered as a number.
    const once = parseFlow(
      flowPayload({ re_enrollment: "once", re_enrollment_cooldown_hours: 48 }),
    )!;
    const cooldown = parseFlow(
      flowPayload({
        re_enrollment: "cooldown",
        re_enrollment_cooldown_hours: 48,
      }),
    )!;

    expect(once.reEnrollmentCooldownHours).toBeNull();
    expect(cooldown.reEnrollmentCooldownHours).toBe(48);
  });

  it("reports a missing entry_id as null rather than inventing a first node", () => {
    const flow = parseFlow(
      flowPayload({
        graph: { nodes: [{ id: "n1", type: "exit" }] },
      }),
    )!;

    expect(flow.entryId).toBeNull();
  });

  it("keeps the raw node map so type-specific fields survive", () => {
    const flow = parseFlow(flowPayload())!;

    expect(flow.nodes[1]?.raw["duration_seconds"]).toBe(86_400);
  });
});

describe("parseFlowPage", () => {
  it("reads pagination.Envelope, which is what ListFlows writes", () => {
    const page = parseFlowPage({
      items: [flowPayload(), flowPayload({ id: "f-2" })],
      nextCursor: "abc",
    });

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe("abc");
  });

  it("reads an ABSENT nextCursor as 'this was the last page'", () => {
    // `nextCursor` is omitempty server-side, so absence is the signal — never
    // a row count compared against a guessed page size.
    expect(parseFlowPage({ items: [flowPayload()] }).nextCursor).toBeNull();
  });

  it("returns an empty page rather than throwing on a drifted envelope", () => {
    expect(parseFlowPage({ data: [flowPayload()] }).items).toEqual([]);
    expect(parseFlowPage(null).items).toEqual([]);
  });
});

describe("parseFlowVersion", () => {
  it("counts only nodes that have an id", () => {
    const version = parseFlowVersion({
      id: "v-1",
      flow_id: "f-1",
      version: 2,
      status: "active",
      generated_by: "ai",
      graph: { nodes: [{ id: "a" }, {}, { id: "b" }] },
      published_at: "2026-06-05T00:00:00Z",
      created_at: "2026-06-04T00:00:00Z",
    })!;

    expect(version.nodeCount).toBe(2);
    expect(version.generatedBy).toBe("ai");
  });

  it("reads the version list envelope", () => {
    const list = parseFlowVersionList({
      items: [{ id: "v-1", version: 1 }, { version: 2 }],
    });

    // The second row has no id and cannot be keyed, so it is dropped.
    expect(list).toHaveLength(1);
  });
});

/**
 * lib/flowValidation.ts — asking the server's own validator what is wrong with
 * a stored flow, and separating what it says into signal and ceremony.
 *
 * Import-free (node-testable). Parses `GraphValidateResponse`
 * (flowbuilder.go:125) and builds the request body from a parsed MobileFlow.
 *
 * WHY A READ-ONLY SURFACE CALLS A VALIDATOR AT ALL. The obvious reading of
 * `POST /api/v1/flow-builder/validate` is "check the graph I am about to save",
 * and mobile saves nothing — which is why this endpoint sat unused here. But
 * the validator does not care whether a graph is on its way to a database. It
 * answers a question a phone is a perfectly good place to ask: *is this flow
 * actually wired up?* Dangling edges, an entry_id pointing at a node that was
 * deleted, a branch with one leg, a send_email with no template — these are
 * exactly what someone is hunting when they open a flow on a phone because it
 * "stopped working", and none of them is visible by looking at the picture.
 *
 * THE GRAPH IS SENT AS STORED, NOT PROJECTED, AND THAT IS LOAD-BEARING.
 * `FlowGraph.Nodes` is `[]map[string]any` and every authoring surface writes
 * type-specific values FLAT on the node (`template_id`, `duration_seconds`,
 * `webhook_url` — apps/web/src/lib/flows-api.ts:48). Sending a node narrowed to
 * {id,type,true_next,false_next,action} would strip precisely the fields the
 * required-field check looks for, and the server would answer "template_id is
 * missing" about a node that carries one. So `node.raw` goes on the wire whole.
 *
 * THE SERVER USED TO REFUSE THAT BODY. `ValidateGraph` decoded straight into
 * `[]NodeSpec` with unknown fields rejected, so any real node — one with a
 * `position`, or a flat `template_id` — answered 400 `unknown_field`. It now
 * decodes the envelope strictly and the graph free-form
 * (flowbuilder.go:graphValidateWire), which is also what made this screen
 * possible. A workspace running an API older than that fix still answers 400,
 * and `flowValidationErrorMessage` says so in those words rather than
 * reporting a fault the operator could act on.
 *
 * WARNINGS ARE PARTITIONED BECAUSE ONE KIND OF THEM IS PURE NOISE HERE.
 * `Catalog()` stamps every item `runtime_status: "unavailable"` while the flow
 * runtime is contained, so `Validate` emits `node "x": type "y" is unavailable`
 * for EVERY node — a wall of identical lines restating the sentence this screen
 * already leads with, on top of the two warnings that actually name a defect.
 * They are counted, reported as one line, and kept out of the list.
 */

/** `runtimecapability.Descriptor`, as it arrives on `runtime`. */
export interface FlowValidationRuntime {
  executionEnabled: boolean;
  message: string;
}

export interface MobileFlowValidation {
  /** No structural ERRORS. Warnings do not make a graph invalid. */
  valid: boolean;
  /** The server's end-to-end claim; false while the runtime is contained. */
  executable: boolean;
  errors: readonly string[];
  /** Warnings that name a defect in THIS graph. */
  graphWarnings: readonly string[];
  /** How many warnings were only restating that the runtime is contained. */
  runtimeWarningCount: number;
  supported: number;
  planned: number;
  unsupported: number;
  runtime: FlowValidationRuntime | null;
}

/** The wire body `POST /flow-builder/validate` accepts. */
export interface FlowValidateBody {
  entry_id?: string;
  triggers?: Record<string, unknown>[];
  nodes: Record<string, unknown>[];
  edges?: { from: string; to: string }[];
}

interface FlowGraphSource {
  entryId: string | null;
  triggers: readonly { raw: Readonly<Record<string, unknown>> }[];
  nodes: readonly { raw: Readonly<Record<string, unknown>> }[];
  edges: readonly { from: string; to: string }[];
}

/**
 * The request body for a stored flow.
 *
 * Structurally typed on the three fields it reads rather than on MobileFlow, so
 * this module stays independent of lib/flowWire and a caller holding a version's
 * graph can use it too.
 */
export function flowValidateBody(flow: FlowGraphSource): FlowValidateBody {
  return {
    // `entry_id` is `omitempty` server-side and is frequently absent — a flow
    // assembled by `graphFromJourney` has none. Sending "" would make the
    // validator check a reference nobody wrote.
    ...(flow.entryId ? { entry_id: flow.entryId } : {}),
    ...(flow.triggers.length > 0
      ? { triggers: flow.triggers.map((trigger) => ({ ...trigger.raw })) }
      : {}),
    nodes: flow.nodes.map((node) => ({ ...node.raw })),
    ...(flow.edges.length > 0
      ? { edges: flow.edges.map((edge) => ({ from: edge.from, to: edge.to })) }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/* response                                                            */
/* ------------------------------------------------------------------ */

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
    : [];
}

function count(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * `node "n1": type "send_email" is unavailable` — the exact `fmt.Sprintf("node
 * %q: type %q is %s", …)` shape `Validate` emits for a node whose catalog entry
 * is not "supported".
 *
 * Matched narrowly ON PURPOSE. A looser pattern would swallow a future warning
 * that happens to start with `node "…"`, and silently dropping a defect the
 * server took the trouble to report is far worse than printing one redundant
 * line. The three statuses are the only ones `Validate`'s switch can produce.
 */
const RUNTIME_STATUS_WARNING =
  /^node "[^"]*": type "[^"]*" is (?:unavailable|planned|partial)$/;

export function isRuntimeStatusWarning(warning: string): boolean {
  return RUNTIME_STATUS_WARNING.test(warning.trim());
}

/**
 * Parse `GraphValidateResponse`. Returns null for a body that is not one.
 *
 * `valid` is read as `!== false` rather than `=== true`: the field is a plain
 * bool with no omitempty, so it is always present on a real response — but if a
 * proxy ever strips it, treating the absence as "invalid" would put a red
 * verdict on a graph nobody assessed. The ERRORS array is the load-bearing
 * evidence and it is read verbatim.
 */
export function parseFlowValidation(
  value: unknown,
): MobileFlowValidation | null {
  const row = record(value);
  const hasVerdict =
    typeof row["valid"] === "boolean" || typeof row["executable"] === "boolean";
  if (!hasVerdict) return null;

  const warnings = strings(row["warnings"]);
  const graphWarnings = warnings.filter((w) => !isRuntimeStatusWarning(w));
  const runtimeDescriptor = record(row["runtime"]);
  const hasRuntime = typeof runtimeDescriptor["capability"] === "string";

  return {
    valid: row["valid"] !== false,
    // Only a literal true. This is the one field that claims a flow could run
    // end to end, and a missing field must never read as yes.
    executable: row["executable"] === true,
    errors: strings(row["errors"]),
    graphWarnings,
    runtimeWarningCount: warnings.length - graphWarnings.length,
    supported: count(row["supported_nodes"]),
    planned: count(row["planned_nodes"]),
    unsupported: count(row["unsupported_nodes"]),
    runtime: hasRuntime
      ? {
          executionEnabled: runtimeDescriptor["execution_enabled"] === true,
          message:
            typeof runtimeDescriptor["message"] === "string"
              ? runtimeDescriptor["message"]
              : "",
        }
      : null,
  };
}

/* ------------------------------------------------------------------ */
/* presentation                                                        */
/* ------------------------------------------------------------------ */

export type FlowValidationTone = "success" | "warning" | "danger";

export interface FlowValidationSummary {
  tone: FlowValidationTone;
  headline: string;
  /** One sentence of context; "" when the headline says everything. */
  detail: string;
}

function items(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * The verdict in one line.
 *
 * `executable` is deliberately NOT part of this. It is false for every flow in
 * every workspace while the runtime is contained, so folding it in would make
 * a perfectly wired flow report as a problem — and the screen states the
 * containment once, in the server's own words, above this card.
 */
export function flowValidationSummary(
  result: MobileFlowValidation,
): FlowValidationSummary {
  if (result.errors.length > 0) {
    return {
      tone: "danger",
      headline: `${items(result.errors.length, "problem")} in this flow's wiring`,
      detail:
        "The server's validator rejects this graph. It has to be repaired in the desktop flow builder before it could run.",
    };
  }
  if (result.graphWarnings.length > 0) {
    return {
      tone: "warning",
      headline: `${items(result.graphWarnings.length, "step")} need attention`,
      detail:
        "The wiring holds, but these steps are missing something they need, so they would fail for anyone who reached them.",
    };
  }
  return {
    tone: "success",
    headline: "No wiring problems found",
    detail:
      result.unsupported > 0
        ? `${items(result.unsupported, "step")} use a type this server does not recognise.`
        : "",
  };
}

/**
 * What went wrong when the CHECK itself failed — never a verdict on the graph.
 *
 * The 400 case is the one that matters: `unknown_field` from this route means
 * the workspace's API predates the fix that let `ValidateGraph` accept an
 * authored node. Reporting that as "your flow is broken" would be a lie about
 * the operator's data, so it is reported as what it is.
 */
export function flowValidationErrorMessage(error: unknown): string {
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;

  if (code === "unknown_field" || status === 400) {
    return "This workspace's API is older than this app and can't check a stored flow. Nothing is wrong with the flow itself.";
  }
  if (status === 403) {
    return "Checking a flow needs edit access to campaigns, which this account doesn't have.";
  }
  if (status === 401) {
    return "Your session expired. Sign in again to check this flow.";
  }
  if (typeof status === "number" && status >= 500) {
    return "The validator is unavailable right now. Try again in a moment.";
  }
  if (status === 0) {
    return "Couldn't reach the server to check this flow.";
  }
  return error instanceof Error && error.message
    ? error.message
    : "Couldn't check this flow.";
}

/**
 * lib/flowWire.ts — the flow-builder wire shapes, parsed.
 *
 * Import-free by construction (no react-native, no expo, no netinfo) so the
 * node vitest environment can drive it with real payloads — the pattern
 * established by lib/reviewQueue.ts and lib/approvalPolicy.ts.
 *
 * EVERY SHAPE BELOW WAS READ OFF THE GO SOURCE, not off openapi.json:
 *
 *   apps/api/internal/flowbuilder/flowbuilder.go
 *     MountRoutes:227-235   the six routes this cluster uses
 *     Flow                  :163-184
 *     FlowVersion           :186-197
 *     FlowGraph             :136-142  (nodes/edges/triggers/goals are
 *                                      []map[string]any — free-form by design)
 *     ListFlows             :278      pagination.Envelope → {items, nextCursor?}
 *     GetFlow               :325      a BARE Flow object, no envelope
 *     ListVersions          :393      pagination.Envelope again
 *   apps/api/internal/pagination/cursor.go:175  Envelope{items,nextCursor?}
 *   apps/api/internal/runtimecapability/runtimecapability.go:18  Descriptor
 *
 * THREE SERVER FACTS THAT SHAPE THIS MODULE
 *
 *  1. THE LIST ALREADY CARRIES THE WHOLE GRAPH. `flowSelectSQL` (repo.go:541)
 *     LEFT JOINs the latest `automation_flow_versions` row and `scanFlow`
 *     replaces the journey-column graph with the version graph when that is
 *     non-empty. So a list row is not a summary — it holds every node. The
 *     detail sheet can therefore draw the topology from the tapped row on the
 *     very first frame, and the single-flow read exists only to make what you
 *     are reading CURRENT, not to make it complete.
 *
 *  2. `entry_id` IS OFTEN ABSENT. It is not a column: `graphFromJourney`
 *     assembles the graph from `triggers/nodes/edges/goals` alone, so a flow
 *     whose latest version has no stored graph comes back with `entry_id: ""`.
 *     `entryId` is therefore `string | null`, never a fabricated first node —
 *     lib/flowTopology decides what to do about it and SAYS which rule it used.
 *
 *  3. EXECUTION IS CONTAINED. `flowRuntimeQualified = false`
 *     (flowbuilder.go:27) and `annotateFlowRuntime` stamps the same
 *     `runtime` descriptor onto every Flow the API returns. A flow whose
 *     status reads "active" is NOT running. Dropping that field on the floor
 *     would make this screen claim otherwise, so it is parsed and rendered.
 */

/** flowbuilder.go:480 — the statuses the server's own catalog enumerates. */
export const FLOW_STATUSES = ["draft", "active", "paused", "archived"] as const;

export type FlowStatus = (typeof FLOW_STATUSES)[number];

/** runtimecapability.Descriptor, as it arrives on `Flow.runtime`. */
export interface MobileFlowRuntime {
  capability: string;
  runtimeStatus: string;
  executionEnabled: boolean;
  code: string;
  message: string;
  prerequisites: readonly string[];
}

export interface MobileFlowNode {
  id: string;
  type: string;
  /** branch legs; null when the node is not a branch or left them unwired. */
  trueNext: string | null;
  falseNext: string | null;
  /** The untouched node map — type-specific fields live here. */
  raw: Readonly<Record<string, unknown>>;
}

export interface MobileFlowEdge {
  from: string;
  to: string;
}

export interface MobileFlowTrigger {
  id: string;
  type: string;
  raw: Readonly<Record<string, unknown>>;
}

export interface MobileFlowVersion {
  id: string;
  flowID: string;
  version: number;
  status: string;
  generatedBy: string;
  sourceRef: string;
  publishedAt: string | null;
  createdAt: string | null;
  nodeCount: number;
}

export interface MobileFlow {
  id: string;
  name: string;
  status: string;
  version: number;
  reEnrollment: string;
  /** Only meaningful when reEnrollment === "cooldown"; null otherwise. */
  reEnrollmentCooldownHours: number | null;
  entryId: string | null;
  triggers: readonly MobileFlowTrigger[];
  nodes: readonly MobileFlowNode[];
  edges: readonly MobileFlowEdge[];
  goalCount: number;
  latestVersion: MobileFlowVersion | null;
  publishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Absent only if the server ever stops annotating; never invented. */
  runtime: MobileFlowRuntime | null;
}

export interface FlowPage {
  items: readonly MobileFlow[];
  /** Non-null means the server has more rows than this page. */
  nextCursor: string | null;
}

/* ------------------------------------------------------------------ */
/* primitives                                                          */
/* ------------------------------------------------------------------ */

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function int(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * ISO timestamp, or null. Go's zero `time.Time` serialises as
 * "0001-01-01T00:00:00Z" and would otherwise render as a real date in the
 * year 1 — the classic "absence is not zero" failure this codebase bans.
 */
export function flowTimestamp(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  if (raw.startsWith("0001-01-01")) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/* ------------------------------------------------------------------ */
/* parsers                                                             */
/* ------------------------------------------------------------------ */

export function parseFlowRuntime(value: unknown): MobileFlowRuntime | null {
  const row = record(value);
  const capability = str(row["capability"]);
  const runtimeStatus = str(row["runtime_status"]);
  if (!capability || !runtimeStatus) return null;
  return {
    capability,
    runtimeStatus,
    // Only a literal `true` counts. A missing field must not read as "yes,
    // this runs" — that is the single most consequential claim on the screen.
    executionEnabled: row["execution_enabled"] === true,
    code: str(row["code"]),
    message: str(row["message"]),
    prerequisites: list(row["prerequisites"]).map(str).filter(Boolean),
  };
}

function parseNode(value: unknown): MobileFlowNode | null {
  const row = record(value);
  const id = str(row["id"]);
  const type = str(row["type"]);
  // A node with no id cannot be an edge target and cannot be keyed in a list.
  if (!id) return null;
  return {
    id,
    type,
    trueNext: str(row["true_next"]) || null,
    falseNext: str(row["false_next"]) || null,
    raw: row,
  };
}

function parseEdge(value: unknown): MobileFlowEdge | null {
  const row = record(value);
  const from = str(row["from"]);
  const to = str(row["to"]);
  if (!from || !to) return null;
  return { from, to };
}

function parseTrigger(value: unknown, index: number): MobileFlowTrigger | null {
  const row = record(value);
  const type = str(row["type"]);
  if (!type) return null;
  // TriggerSpec.ID is `omitempty` server-side, so a trigger legitimately has
  // no id. The index keeps React keys stable within one payload.
  return { id: str(row["id"]) || `trigger-${index}`, type, raw: row };
}

export function parseFlowVersion(value: unknown): MobileFlowVersion | null {
  const row = record(value);
  const id = str(row["id"]);
  if (!id) return null;
  const graph = record(row["graph"]);
  return {
    id,
    flowID: str(row["flow_id"]),
    version: int(row["version"]),
    status: str(row["status"]),
    generatedBy: str(row["generated_by"]),
    sourceRef: str(row["source_ref"]),
    publishedAt: flowTimestamp(row["published_at"]),
    createdAt: flowTimestamp(row["created_at"]),
    nodeCount: list(graph["nodes"]).filter(
      (node) => str(record(node)["id"]) !== "",
    ).length,
  };
}

export function parseFlow(value: unknown): MobileFlow | null {
  const row = record(value);
  const id = str(row["id"]);
  if (!id) return null;
  const graph = record(row["graph"]);
  const reEnrollment = str(row["re_enrollment"]);
  const cooldown = int(row["re_enrollment_cooldown_hours"]);
  return {
    id,
    // A flow may genuinely be unnamed (name is not NOT NULL-checked on
    // create). "Untitled flow" is the row's label, not a claim about data.
    name: str(row["name"]) || "Untitled flow",
    status: str(row["status"]),
    version: int(row["version"]),
    reEnrollment,
    // The hours field is only meaningful under the cooldown policy; carrying
    // it otherwise invites a UI that prints "0 h" beside "Enters once".
    reEnrollmentCooldownHours:
      reEnrollment === "cooldown" && cooldown > 0 ? cooldown : null,
    entryId: str(graph["entry_id"]) || null,
    triggers: list(graph["triggers"])
      .map(parseTrigger)
      .filter((t): t is MobileFlowTrigger => t !== null),
    nodes: list(graph["nodes"])
      .map(parseNode)
      .filter((n): n is MobileFlowNode => n !== null),
    edges: list(graph["edges"])
      .map(parseEdge)
      .filter((e): e is MobileFlowEdge => e !== null),
    goalCount: list(graph["goals"]).length,
    latestVersion: parseFlowVersion(row["latest_version"]),
    publishedAt: flowTimestamp(row["published_at"]),
    createdAt: flowTimestamp(row["created_at"]),
    updatedAt: flowTimestamp(row["updated_at"]),
    runtime: parseFlowRuntime(row["runtime"]),
  };
}

/**
 * `pagination.Envelope[Flow]` → rows plus the honest "there is more" signal.
 *
 * `nextCursor` is `omitempty`, so its ABSENCE is the server saying "this was
 * the last page". The screen uses that rather than comparing a row count to a
 * guessed page size, which would be wrong the moment the default moves.
 */
export function parseFlowPage(value: unknown): FlowPage {
  const row = record(value);
  return {
    items: list(row["items"])
      .map(parseFlow)
      .filter((f): f is MobileFlow => f !== null),
    nextCursor: str(row["nextCursor"]) || null,
  };
}

export function parseFlowVersionList(
  value: unknown,
): readonly MobileFlowVersion[] {
  return list(record(value)["items"])
    .map(parseFlowVersion)
    .filter((v): v is MobileFlowVersion => v !== null);
}

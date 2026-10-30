/**
 * lib/flowCatalog.ts — the SERVER's node/trigger catalogue, parsed, with the
 * app's own table demoted to a fallback.
 *
 * Import-free (node-testable). Companion to lib/flowTopology, which owns the
 * fallback table and the topology walk.
 *
 * WHY THIS EXISTS. `GET /api/v1/flow-builder/catalog` (flowbuilder.go:221,
 * read:campaigns) publishes 12 triggers and 15 node types with typed FieldSpecs
 * and a per-item runtime status, under the schema id "klv03.flow-builder.v1".
 * It is published PRECISELY so clients stop keeping their own copy. Mobile kept
 * one anyway — `NODE_LABELS` / `TRIGGER_LABELS` in lib/flowTopology are a
 * hand-transcribed mirror of `Catalog()` — which means a flow authored with a
 * node type this build predates renders as its raw key (`send_whatsapp`) on a
 * phone while every other client in the estate shows a name.
 *
 * THE MIRROR IS NOT DELETED, AND THAT IS DELIBERATE. This screen must still
 * draw a topology while offline, on a cold start, and in the second before the
 * catalogue lands — and the persisted query cache can hand back a graph long
 * before any network call resolves. So the mirror stays as the floor and the
 * server's labels are an OVERLAY on top of it. `flowLabels(null)` is exactly
 * today's behaviour; `flowLabels(catalog)` is today's behaviour plus every key
 * this build has never heard of.
 *
 * NOTHING HERE READS `runtime_status`. `Catalog()` overwrites every item's
 * status with "unavailable" before returning (flowbuilder.go:566-572) because
 * the shared flow runtime is contained — so the field carries no per-item
 * information today, and a UI that surfaced it would be printing the same word
 * fifteen times next to the sentence the screen already leads with. The field
 * is parsed and carried; it is not rendered.
 */
import { flowNodeLabel, flowTriggerLabel } from "@/lib/flowTopology";

/** The schema id `Catalog()` stamps (flowbuilder.go:454). */
export const FLOW_CATALOG_SCHEMA = "klv03.flow-builder.v1";

export interface MobileFlowFieldSpec {
  key: string;
  type: string;
  required: boolean;
  options: readonly string[];
}

export interface MobileFlowCatalogItem {
  key: string;
  label: string;
  category: string;
  /** "" when the item is not channel-specific. */
  channel: string;
  runtimeStatus: string;
  requiresReview: boolean;
  fields: readonly MobileFlowFieldSpec[];
}

export interface MobileFlowConditionField {
  key: string;
  label: string;
  type: string;
  category: string;
}

export interface MobileFlowCatalog {
  /** Verbatim; never defaulted to FLOW_CATALOG_SCHEMA. */
  schemaVersion: string;
  triggers: readonly MobileFlowCatalogItem[];
  nodes: readonly MobileFlowCatalogItem[];
  actions: readonly MobileFlowCatalogItem[];
  statuses: readonly string[];
  conditionFields: readonly MobileFlowConditionField[];
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

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseFieldSpec(value: unknown): MobileFlowFieldSpec | null {
  const row = record(value);
  const key = str(row["key"]);
  if (!key) return null;
  return {
    key,
    type: str(row["type"]),
    // `required` is `omitempty`, so its ABSENCE means false. Only a literal
    // true may make a field required — coercing a truthy value here would
    // manufacture a constraint the server never declared.
    required: row["required"] === true,
    options: list(row["options"]).map(str).filter(Boolean),
  };
}

function parseCatalogItem(value: unknown): MobileFlowCatalogItem | null {
  const row = record(value);
  const key = str(row["key"]);
  if (!key) return null;
  return {
    key,
    // A catalogue entry with no label is a server that shipped a key without a
    // name. The KEY is then the only honest thing to show, which is the same
    // rule the fallback table uses.
    label: str(row["label"]) || key,
    category: str(row["category"]),
    channel: str(row["channel"]),
    runtimeStatus: str(row["runtime_status"]),
    requiresReview: row["requires_review"] === true,
    fields: list(row["fields"])
      .map(parseFieldSpec)
      .filter((f): f is MobileFlowFieldSpec => f !== null),
  };
}

function parseConditionField(value: unknown): MobileFlowConditionField | null {
  const row = record(value);
  const key = str(row["key"]);
  if (!key) return null;
  return {
    key,
    label: str(row["label"]) || key,
    type: str(row["type"]),
    category: str(row["category"]),
  };
}

/**
 * The catalogue, or null.
 *
 * NULL IS A REAL ANSWER AND THE CALLER MUST BE ABLE TO SEE IT. A body with no
 * node types is not a catalogue — it is a different endpoint, a proxy error
 * page, or a cache entry written by a build whose fetcher returned another
 * shape (this app PERSISTS its query cache to disk, so that last one is not
 * hypothetical). Returning an empty catalogue instead would silently replace
 * every label with a raw key; returning null keeps the fallback table in play.
 */
export function parseFlowCatalog(value: unknown): MobileFlowCatalog | null {
  const row = record(value);
  const nodes = list(row["nodes"])
    .map(parseCatalogItem)
    .filter((n): n is MobileFlowCatalogItem => n !== null);
  if (nodes.length === 0) return null;
  return {
    schemaVersion: str(row["schema_version"]),
    nodes,
    triggers: list(row["triggers"])
      .map(parseCatalogItem)
      .filter((n): n is MobileFlowCatalogItem => n !== null),
    actions: list(row["actions"])
      .map(parseCatalogItem)
      .filter((n): n is MobileFlowCatalogItem => n !== null),
    statuses: list(row["statuses"]).map(str).filter(Boolean),
    conditionFields: list(row["condition_fields"])
      .map(parseConditionField)
      .filter((f): f is MobileFlowConditionField => f !== null),
  };
}

/* ------------------------------------------------------------------ */
/* labels                                                              */
/* ------------------------------------------------------------------ */

/**
 * How a screen turns a node/trigger TYPE into words. One object rather than two
 * loose functions so a component takes a single prop and cannot be wired up
 * with the server's node labels but the local trigger labels.
 */
export interface FlowLabels {
  node(type: string): string;
  trigger(type: string): string;
}

/** The offline floor: lib/flowTopology's hand-kept mirror. */
export const STATIC_FLOW_LABELS: FlowLabels = {
  node: flowNodeLabel,
  trigger: flowTriggerLabel,
};

/**
 * key → label, tolerating a value that is not the array it is typed as.
 *
 * THE TYPE IS NOT A GUARANTEE HERE, AND THAT IS NOT PARANOIA. This app
 * PERSISTS its query cache to an encrypted vault, so a cache entry written by
 * an older build — whose fetcher returned a different shape — can be rehydrated
 * straight into a `MobileFlowCatalog`-typed slot after an app update.
 * `.map` on that value throws INSIDE RENDER, and the error boundary turns that
 * into a blank screen with no way back. Falling through to the built-in mirror
 * is the recoverable failure; a thrown render is not. This is the same rule
 * app/(tabs)/flows.tsx applies to its version list.
 */
function overlay(items: unknown): ReadonlyMap<string, string> {
  if (!Array.isArray(items)) return new Map();
  const out = new Map<string, string>();
  for (const item of items as readonly MobileFlowCatalogItem[]) {
    if (item && typeof item.key === "string" && typeof item.label === "string") {
      out.set(item.key, item.label);
    }
  }
  return out;
}

/**
 * Server labels where the server has one, the local mirror everywhere else.
 *
 * The fallback runs on a MISS, not only on a null catalogue — so a catalogue
 * that simply does not mention `coupon_assign` still gets "Assign coupon" from
 * the mirror rather than the bare key. That also means a rehydrated non-
 * catalogue degrades to exactly the shipped behaviour instead of to raw keys.
 */
export function flowLabels(catalog: MobileFlowCatalog | null): FlowLabels {
  if (!catalog) return STATIC_FLOW_LABELS;
  const nodes = overlay(catalog.nodes);
  const triggers = overlay(catalog.triggers);
  if (nodes.size === 0 && triggers.size === 0) return STATIC_FLOW_LABELS;
  return {
    node: (type) => nodes.get(type) ?? flowNodeLabel(type),
    trigger: (type) => triggers.get(type) ?? flowTriggerLabel(type),
  };
}

/**
 * True when the catalogue is the schema this build was written against.
 *
 * Labels are safe to take from ANY schema — a string that names a node type is
 * a string. This exists so a screen can decline to reason about `fields` or
 * `condition_fields`, whose MEANING is what a schema bump would change.
 */
export function flowCatalogSchemaKnown(
  catalog: MobileFlowCatalog | null,
): boolean {
  return catalog?.schemaVersion === FLOW_CATALOG_SCHEMA;
}

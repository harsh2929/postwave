/**
 * api-reference-helpers — pure logic behind the API Playground's
 * "Reference" tab (#58, GET /api/v1/openapi.json).
 *
 * Transforms the raw OpenAPI 3 document into a navigable tree:
 * tag → operations → (method, path, summary, params, request/response
 * schema NAMES). Deliberately shallow — we surface schema names from
 * $ref pointers rather than walking/inlining full schemas, which keeps
 * this dependency-free and fast on a multi-hundred-KB spec.
 */

export interface RefParam {
  name: string;
  /** path | query | header */
  location: string;
  required: boolean;
  type?: string;
  description?: string;
}

export interface RefResponse {
  status: string;
  description?: string;
  /** Schema name (from $ref), "Foo[]" for ref arrays, or a JSON type. */
  schema?: string;
}

export interface RefOperation {
  method: string;
  path: string;
  summary?: string;
  description?: string;
  deprecated: boolean;
  params: RefParam[];
  requestSchema?: string;
  responses: RefResponse[];
}

export interface RefTagGroup {
  tag: string;
  operations: RefOperation[];
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** "#/components/schemas/CampaignRow" → "CampaignRow". */
export function schemaNameFromRef(ref: string): string {
  const parts = ref.split("/");
  return parts[parts.length - 1] || ref;
}

interface SchemaLike {
  $ref?: string;
  type?: string;
  items?: SchemaLike;
}

/**
 * Best-effort display name for a schema object: $ref name,
 * "Name[]" for arrays of refs, or the plain JSON type. Returns
 * undefined when there's nothing meaningful to show.
 */
export function schemaNameOf(schema: unknown): string | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const s = schema as SchemaLike;
  if (typeof s.$ref === "string") return schemaNameFromRef(s.$ref);
  if (s.type === "array") {
    const inner = schemaNameOf(s.items);
    return inner ? `${inner}[]` : "array";
  }
  if (typeof s.type === "string") return s.type;
  return undefined;
}

interface RawParameter {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: SchemaLike;
}

interface RawOperation {
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: RawParameter[];
  requestBody?: {
    content?: Record<string, { schema?: unknown }>;
  };
  responses?: Record<
    string,
    { description?: string; content?: Record<string, { schema?: unknown }> }
  >;
}

function extractParams(raw: RawParameter[] | undefined): RefParam[] {
  if (!Array.isArray(raw)) return [];
  const out: RefParam[] = [];
  for (const p of raw) {
    if (!p || typeof p.name !== "string") continue;
    out.push({
      name: p.name,
      location: typeof p.in === "string" ? p.in : "query",
      required: Boolean(p.required),
      type: schemaNameOf(p.schema),
      description: p.description,
    });
  }
  return out;
}

function firstContentSchema(
  content: Record<string, { schema?: unknown }> | undefined,
): string | undefined {
  if (!content) return undefined;
  const json = content["application/json"];
  if (json) return schemaNameOf(json.schema);
  const first = Object.values(content)[0];
  return first ? schemaNameOf(first.schema) : undefined;
}

function extractResponses(
  raw: RawOperation["responses"],
): RefResponse[] {
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw)
    .map(([status, r]) => ({
      status,
      description: r?.description,
      schema: firstContentSchema(r?.content),
    }))
    .sort((a, b) => a.status.localeCompare(b.status));
}

/**
 * Spec document → sorted tag groups. Operations inside a tag sort by
 * path, then by canonical method order. Untagged operations land in
 * "general" (matches the Explore tab's grouping).
 */
export function buildReferenceTree(spec: unknown): RefTagGroup[] {
  if (!spec || typeof spec !== "object") return [];
  const paths = (spec as { paths?: unknown }).paths;
  if (!paths || typeof paths !== "object") return [];

  const byTag = new Map<string, RefOperation[]>();
  for (const [path, methods] of Object.entries(
    paths as Record<string, unknown>,
  )) {
    if (!methods || typeof methods !== "object") continue;
    for (const method of METHODS) {
      const raw = (methods as Record<string, unknown>)[method];
      if (!raw || typeof raw !== "object") continue;
      const op = raw as RawOperation;
      const tag = op.tags?.[0] ?? "general";
      const entry: RefOperation = {
        method,
        path,
        summary: op.summary,
        description: op.description,
        deprecated: Boolean(op.deprecated),
        params: extractParams(op.parameters),
        requestSchema: firstContentSchema(op.requestBody?.content),
        responses: extractResponses(op.responses),
      };
      const arr = byTag.get(tag) ?? [];
      arr.push(entry);
      byTag.set(tag, arr);
    }
  }

  const methodRank = (m: string): number => {
    const i = METHODS.indexOf(m as (typeof METHODS)[number]);
    return i === -1 ? METHODS.length : i;
  };

  return Array.from(byTag.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([tag, operations]) => ({
      tag,
      operations: operations.sort((a, b) =>
        a.path === b.path
          ? methodRank(a.method) - methodRank(b.method)
          : a.path.localeCompare(b.path),
      ),
    }));
}

/** Total operation count across the tree (header chrome). */
export function countOperations(tree: RefTagGroup[]): number {
  return tree.reduce((n, g) => n + g.operations.length, 0);
}

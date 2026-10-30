// SPDX-License-Identifier: MIT
import { z, type ZodTypeAny } from "zod";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  formatError,
  formatResult,
  withTimeout,
  type FormattedToolResult,
} from "./format.js";
import { withToolContext } from "./tool-context.js";
import { MCP_SERVER_VERSION } from "../client.js";

/**
 * Definition of a single MCP tool. Each tool category builds an array of
 * these and the central registrar wires them into the MCP server.
 */
/** MCP tool behavior hints (spec 2025-06-18). All optional. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef<S extends ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  /** Default 30s. Migration tools override to 60s. */
  timeoutMs?: number;
  /**
   * MCP annotations. They are emitted only when explicitly reviewed on the
   * tool definition. Names are never used to infer read-only safety: e.g.
   * `list_create` is a mutation despite its prefix.
   */
  annotations?: ToolAnnotations;
  /** Optional JSON-Schema for the result, enabling typed structuredContent. */
  outputSchema?: Record<string, unknown>;
  /**
   * API-key scopes required to use this tool. When the proxy knows the
   * key's held scopes (via /api-keys/me), tools whose requiredScopes aren't
   * satisfied are hidden from tools/list and refused on tools/call. A small
   * reviewed legacy map classifies named privileged tools; every other missing
   * classification fails closed.
   */
  requiredScopes?: string[];
  handler: (input: z.infer<S>) => Promise<unknown>;
}

/** Registry-friendly view used by `registerTools`. */
export type AnyToolDef = ToolDef<ZodTypeAny>;

/** Convert a Zod schema to a JSON schema fragment compatible with MCP. */
function zodToInputSchema(schema: ZodTypeAny): Record<string, unknown> {
  // A top-level refinement still accepts the exact input shape of its inner
  // schema. Unwrap it so refined closed objects do not degrade in tools/list
  // to an open `{ additionalProperties: true }` contract. Preprocessors can
  // widen their accepted input and therefore remain deliberately opaque.
  while (schema instanceof z.ZodEffects) {
    const definition = (
      schema as unknown as {
        _def: { effect?: { type?: string }; schema: ZodTypeAny };
      }
    )._def;
    if (definition.effect?.type === "preprocess") break;
    schema = definition.schema;
  }
  // Minimal converter — we only use object schemas for tool inputs. For more
  // exotic shapes, the SDK consumers can pass a pre-built JSON Schema in a
  // future iteration. Keeping this in-tree avoids a dep on zod-to-json-schema.
  if (schema instanceof z.ZodObject) {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      const v = value as ZodTypeAny;
      properties[key] = zodFieldToJson(v);
      if (!v.isOptional()) required.push(key);
    }
    return {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    };
  }
  return { type: "object", additionalProperties: true };
}

function zodFieldToJson(v: ZodTypeAny): Record<string, unknown> {
  // Strip wrappers to find the input type. Refinements and transforms still
  // parse through their inner schema, so publishing that shape is accurate
  // for MCP clients. A preprocess effect is different: it can accept an
  // arbitrary value before the inner schema sees it, so leave that unknown.
  let inner: ZodTypeAny = v;
  while (true) {
    if (
      inner instanceof z.ZodOptional ||
      inner instanceof z.ZodDefault ||
      inner instanceof z.ZodNullable
    ) {
      inner = (inner as unknown as { _def: { innerType: ZodTypeAny } })._def
        .innerType;
      continue;
    }
    if (inner instanceof z.ZodEffects) {
      const definition = (
        inner as unknown as {
          _def: {
            effect?: { type?: string };
            schema: ZodTypeAny;
          };
        }
      )._def;
      if (definition.effect?.type === "preprocess") break;
      inner = definition.schema;
      continue;
    }
    break;
  }
  const description = (v as unknown as { _def: { description?: string } })._def
    .description;
  const base: Record<string, unknown> = {};
  if (description) base.description = description;

  if (inner instanceof z.ZodString) return { ...base, type: "string" };
  if (inner instanceof z.ZodNumber) return { ...base, type: "number" };
  if (inner instanceof z.ZodBoolean) return { ...base, type: "boolean" };
  if (inner instanceof z.ZodEnum)
    return { ...base, type: "string", enum: inner.options };
  if (inner instanceof z.ZodLiteral) return { ...base, const: inner.value };
  if (inner instanceof z.ZodArray) {
    return {
      ...base,
      type: "array",
      items: zodFieldToJson(inner.element as ZodTypeAny),
    };
  }
  if (inner instanceof z.ZodObject) {
    return { ...base, ...zodToInputSchema(inner) };
  }
  if (inner instanceof z.ZodUnion) {
    return {
      ...base,
      anyOf: (inner.options as ZodTypeAny[]).map((o) => zodFieldToJson(o)),
    };
  }
  if (inner instanceof z.ZodRecord) {
    return { ...base, type: "object", additionalProperties: true };
  }
  return { ...base };
}

/**
 * Register a flat list of tool definitions on the MCP server. Wires the
 * `tools/list` and `tools/call` JSON-RPC handlers, applies the per-tool
 * timeout, validates input with Zod, and wraps both successes and errors
 * in MCP-compatible result envelopes.
 */
const SEARCH_TOOL_NAME = "search_tools";

// Retained as a compatibility export for downstream tests/imports. Unknown
// behavior has no hint: annotations are untrusted client UX metadata and must
// be an explicit per-tool review, never a name heuristic.
export function deriveAnnotations(_name: string): ToolAnnotations {
  return {};
}

function descriptorFor(t: AnyToolDef) {
  const annotations = t.annotations ?? {};
  return {
    name: t.name,
    description: t.description,
    inputSchema: zodToInputSchema(t.schema),
    ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}

// buildSearchTool returns a synthetic meta-tool that searches the full
// catalog by keyword, so a token-conscious client can discover the right
// tool without loading every schema. Additive: the full list is still
// served by tools/list.
function buildSearchTool(tools: AnyToolDef[]): AnyToolDef {
  return {
    name: SEARCH_TOOL_NAME,
    description:
      "Search the available Moosewave tools by keyword and get back the best-matching tool names + descriptions, so you can find the right tool without listing all of them. Use when you know what you want to do but not the exact tool name.",
    annotations: { readOnlyHint: true },
    // The meta-tool returns only descriptors that separately pass the same
    // verified-scope predicate; an empty list is an explicit reviewed scope.
    requiredScopes: [],
    schema: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          "Keywords for the capability you need, e.g. 'send campaign' or 'subscriber tags'.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe("Max results. Default 15."),
    }),
    handler: async (input) => {
      const { query, limit } = input as { query: string; limit?: number };
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const scored = tools
        .filter(allowedByScopes)
        .map((t) => {
          const name = t.name.toLowerCase();
          const desc = t.description.toLowerCase();
          let score = 0;
          for (const term of terms) {
            if (name.includes(term)) score += 3;
            if (desc.includes(term)) score += 1;
          }
          return { t, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit ?? 15)
        .map((x) => ({
          name: x.t.name,
          description: x.t.description,
          ...(x.t.annotations ? { annotations: x.t.annotations } : {}),
        }));
      return { query, count: scored.length, tools: scored };
    },
  };
}

// pageSizeFromEnv: 0 (default) means "no pagination" so naive clients that
// don't follow nextCursor still receive every tool. Operators with strict
// context budgets set POSTWAVE_MCP_PAGE_SIZE to opt into spec pagination.
function pageSizeFromEnv(): number {
  const raw = Number(process.env.POSTWAVE_MCP_PAGE_SIZE ?? 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

function encodeOffset(n: number): string {
  return Buffer.from(String(n), "utf8").toString("base64url");
}
function decodeOffset(cursor?: string): number {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

// heldScopes is the scope set the configured API key holds, resolved once
// at startup via /api-keys/me (SetHeldScopes). null = unknown and fails closed:
// no proxy tools are discovered or callable until authority is verified.
let heldScopes: Set<string> | null = null;

// SetHeldScopes installs the resolved scopes for the process's API key.
export function SetHeldScopes(s: Set<string> | null): void {
  heldScopes = s;
}

// HIGH_RISK_SCOPES is a narrow compatibility backstop for a few historically
// privileged tools. It is not a complete registry authorization model: tools
// absent from both explicit metadata and this map are hidden and denied.
// Public/hosted use remains release-held until every tool has generated,
// reviewed scope metadata and that parity is publication-bound.
const HIGH_RISK_SCOPES: Record<string, string[]> = {
  api_key_create: ["admin"],
  api_key_revoke: ["admin"],
  api_key_rotate: ["admin"],
  migrate_commit: ["admin"],
  migrate_credentials: ["admin"],
  migrate_start: ["admin"],
  migrate_rollback: ["admin"],
  developer_marketplace_installation_revoke: ["admin"],
  developer_marketplace_oauth_client_revoke: ["admin"],
  developer_marketplace_oauth_revoke: ["admin"],
};

function scopesFor(t: AnyToolDef): string[] | null {
  return t.requiredScopes ?? HIGH_RISK_SCOPES[t.name] ?? null;
}

// allowedByScopes reports whether the held key may use a tool. Unknown scope
// resolution and missing per-tool classification both fail closed. The admin
// scope grants classified tools only; it cannot turn absent metadata into an
// authorization decision.
function allowedByScopes(t: AnyToolDef): boolean {
  if (heldScopes === null) return false;
  const need = scopesFor(t);
  if (need === null) return false;
  if (need.length === 0) return true;
  if (heldScopes.has("admin")) return true;
  return need.every((s) => heldScopes!.has(s));
}

export function registerToolList(server: Server, tools: AnyToolDef[]): void {
  // search_tools is exposed first so a client can discover tools without
  // paging the whole catalog.
  const all: AnyToolDef[] = [buildSearchTool(tools), ...tools];
  const byName = new Map<string, AnyToolDef>();
  for (const t of all) byName.set(t.name, t);

  server.setRequestHandler(ListToolsRequestSchema, async (req) => {
    // Hide tools the configured key isn't scoped for. Unknown authority hides
    // every tool, including search_tools, rather than leaking the catalogue.
    const descriptors = all.filter(allowedByScopes).map(descriptorFor);
    const size = pageSizeFromEnv();
    if (size <= 0) {
      return { tools: descriptors };
    }
    const start = decodeOffset(req.params?.cursor);
    const page = descriptors.slice(start, start + size);
    const hasMore = start + size < descriptors.length;
    return hasMore
      ? { tools: page, nextCursor: encodeOffset(start + size) }
      : { tools: page };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const def = byName.get(req.params.name);
    if (!def) {
      return formatError(
        new Error(`unknown tool: ${req.params.name}`),
      ) satisfies FormattedToolResult;
    }
    if (!allowedByScopes(def)) {
      return formatError(
        new Error(
          `permission denied: your API key lacks a required scope for ${def.name}`,
        ),
      ) satisfies FormattedToolResult;
    }
    const parsed = def.schema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return formatError(
        new Error(`invalid arguments for ${def.name}: ${parsed.error.message}`),
      );
    }
    try {
      // Wrap the handler in withToolContext so every outbound HTTP
      // call the SDK fires inside it carries X-Postwave-MCP-Tool:
      // <def.name>. The wrapped fetch in client.ts reads this via
      // AsyncLocalStorage. Without the wrap, the API falls back to
      // its DeriveToolName heuristic — accurate enough for routing
      // but loses the logical tool label in the MCP dashboard.
      const result = await withToolContext(
        { toolName: def.name, serverVersion: MCP_SERVER_VERSION },
        () =>
          withTimeout(
            () => def.handler(parsed.data),
            def.timeoutMs ?? 30_000,
            def.name,
          ),
      );
      return formatResult(result);
    } catch (err) {
      return formatError(err);
    }
  });
}

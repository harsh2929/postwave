// SPDX-License-Identifier: AGPL-3.0-only
//
// Build-time loader for the OpenAPI 3.1 spec at packages/openapi/openapi.json.
// Import the file as an inline base64 asset and parse it here so
// generateStaticParams() and the per-endpoint page still render entirely at
// build time — no runtime fetch, no /api/openapi proxy, no CORS surprises. A
// normal webpack JSON-module (or raw-string) import is unsafe for this artifact:
// schema patterns intentionally contain the textual escape `\\uD800`, and
// webpack 5 can emit that as a lone surrogate inside its generated JSON.parse
// string. Next then fails while collecting the docs routes even though the
// source JSON is valid. Base64 has no escape sequences for webpack to reinterpret.
//
// The OpenAPI spec is the source of truth. If something is missing here, fix
// the spec, not the renderer. We DO log a console warning at module load time
// for any operation that lacks a description so the spec gap is visible during
// `pnpm build`.

import { Buffer } from "node:buffer";

import openapiSpecDataUrl from "../../../../../packages/openapi/openapi.json?base64";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export const HTTP_METHODS: HttpMethod[] = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
];

export interface OpenAPIParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

export interface OpenAPIRef {
  $ref: string;
}

export type ParameterOrRef = OpenAPIParameter | OpenAPIRef;

export interface OpenAPIResponse {
  description?: string;
  content?: Record<string, { schema?: Record<string, unknown> }>;
}

export interface OpenAPIRequestBody {
  description?: string;
  required?: boolean;
  content?: Record<string, { schema?: Record<string, unknown> }>;
}

export interface OpenAPIOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: ParameterOrRef[];
  requestBody?: OpenAPIRequestBody;
  responses?: Record<string, OpenAPIResponse | OpenAPIRef>;
  deprecated?: boolean;
}

export interface OpenAPIPathItem {
  get?: OpenAPIOperation;
  post?: OpenAPIOperation;
  put?: OpenAPIOperation;
  patch?: OpenAPIOperation;
  delete?: OpenAPIOperation;
  parameters?: ParameterOrRef[];
}

export interface OpenAPISpec {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: { url: string; description?: string }[];
  tags?: { name: string; description?: string }[];
  paths?: Record<string, OpenAPIPathItem>;
  components?: Record<string, unknown>;
  [key: string]: unknown;
}

const OPENAPI_DATA_URL_PREFIX = "data:application/json;base64,";

if (!openapiSpecDataUrl.startsWith(OPENAPI_DATA_URL_PREFIX)) {
  throw new Error("OpenAPI build asset is not canonical base64 JSON");
}

const openapiSpecSource = Buffer.from(
  openapiSpecDataUrl.slice(OPENAPI_DATA_URL_PREFIX.length),
  "base64",
).toString("utf8");
const spec = JSON.parse(openapiSpecSource) as OpenAPISpec;

function isRef(x: unknown): x is OpenAPIRef {
  return typeof x === "object" && x !== null && "$ref" in (x as object);
}

function resolveRef<T>(ref: string): T | null {
  const segs = ref.replace(/^#\//, "").split("/");
  let cur: unknown = spec;
  for (const s of segs) {
    if (
      typeof cur === "object" &&
      cur !== null &&
      s in (cur as Record<string, unknown>)
    ) {
      cur = (cur as Record<string, unknown>)[s];
    } else {
      return null;
    }
  }
  return cur as T;
}

function resolveParameter(p: ParameterOrRef): OpenAPIParameter | null {
  if (isRef(p)) {
    const r = resolveRef<OpenAPIParameter>(p.$ref);
    return r ?? null;
  }
  return p;
}

function resolveResponse(
  r: OpenAPIResponse | OpenAPIRef,
): OpenAPIResponse | null {
  if (isRef(r)) {
    return resolveRef<OpenAPIResponse>(r.$ref);
  }
  return r;
}

export function getSpec(): OpenAPISpec {
  return spec;
}

/**
 * A flattened view of one operation. We carry the original method + path,
 * a stable URL slug for the per-endpoint page, and the resolved operation
 * payload. Tags collapse to a single primary tag for sidebar grouping.
 */
export interface FlatOperation {
  slug: string;
  method: HttpMethod;
  path: string;
  operationId: string;
  primaryTag: string;
  tags: string[];
  summary: string;
  description: string;
  operation: OpenAPIOperation;
  parameters: OpenAPIParameter[];
}

function slugify(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[A-Z]+/g, (m) => m.toLowerCase())
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

let cachedFlat: FlatOperation[] | null = null;

export function listOperations(): FlatOperation[] {
  if (cachedFlat) return cachedFlat;
  const out: FlatOperation[] = [];
  const seenSlugs = new Map<string, number>();
  const paths = spec.paths ?? {};
  for (const rawPath of Object.keys(paths).sort()) {
    const item = paths[rawPath]!;
    const pathLevelParams = item.parameters ?? [];
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      const opId = op.operationId ?? `${method}-${rawPath}`;
      const baseSlug = slugify(opId);
      // Disambiguate slug collisions. Dormant as of this writing — all 1903
      // operationIds currently slugify uniquely, so nothing carries a "-2"
      // suffix (the older note here claimed four known collisions; that has
      // not been true for some time). Kept because slugify is lossy: it
      // lowercases uppercase runs, so getMCPTools and getMcpTools would both
      // land on get-mcptools. __tests__/openapi-slugs.test.ts asserts the
      // result is collision-free either way.
      const count = seenSlugs.get(baseSlug) ?? 0;
      seenSlugs.set(baseSlug, count + 1);
      const slug = count === 0 ? baseSlug : `${baseSlug}-${count + 1}`;
      const tags = op.tags ?? ["Other"];
      const primaryTag = tags[0] ?? "Other";
      const rawParams = [...pathLevelParams, ...(op.parameters ?? [])];
      const params: OpenAPIParameter[] = rawParams
        .map(resolveParameter)
        .filter((p): p is OpenAPIParameter => p !== null);
      // Resolve response refs ahead of time so the renderer never has to.
      const resolvedResponses: Record<string, OpenAPIResponse> = {};
      for (const [code, r] of Object.entries(op.responses ?? {})) {
        const rr = resolveResponse(r);
        if (rr) resolvedResponses[code] = rr;
      }
      const operationResolved: OpenAPIOperation = {
        ...op,
        parameters: params,
        responses: resolvedResponses,
      };
      out.push({
        slug,
        method,
        path: rawPath,
        operationId: opId,
        primaryTag,
        tags,
        summary: op.summary ?? opId,
        description: op.description ?? "",
        operation: operationResolved,
        parameters: params,
      });
    }
  }
  cachedFlat = out;
  return out;
}

export function listOperationSlugs(): { endpoint: string }[] {
  return listOperations().map((o) => ({ endpoint: o.slug }));
}

export function findOperationBySlug(slug: string): FlatOperation | undefined {
  return listOperations().find((o) => o.slug === slug);
}

export interface TaggedOperationGroup {
  tag: string;
  slug: string;
  operations: FlatOperation[];
}

// SRV-02: the docs layout calls this on every render, and /docs/api calls it a
// second time in the same request. The spec is frozen for the process lifetime,
// so the grouping is byte-identical every time — memoize it the way
// listOperations() already memoizes the flat list. Callers must treat the
// result as read-only; it is the same array on every call.
let cachedByTag: TaggedOperationGroup[] | null = null;

/**
 * Group operations by their primary tag. Sorted by tag name, then by path
 * within each tag. Used to render the API sidebar tree.
 */
export function operationsByTag(): TaggedOperationGroup[] {
  if (cachedByTag) return cachedByTag;
  const map = new Map<string, FlatOperation[]>();
  for (const op of listOperations()) {
    if (!map.has(op.primaryTag)) map.set(op.primaryTag, []);
    map.get(op.primaryTag)!.push(op);
  }
  // Anchor slug, disambiguated the same way operation slugs are. The spec
  // carries two primary tags that differ only in case — "SMS" (33 management
  // endpoints) and "Sms" (59 public provider webhooks) — and both lowercased
  // to "sms". That put two sections with the same DOM id on /docs/api, so one
  // jump-chip could never reach its group and any #sms link resolved to
  // whichever rendered first.
  const seen = new Map<string, number>();
  cachedByTag = Array.from(map.entries())
    .map(([tag, operations]) => {
      const base = tag.replace(/\s+/g, "-").toLowerCase();
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return {
        tag,
        slug: count === 0 ? base : `${base}-${count + 1}`,
        operations: operations.sort((a, b) =>
          a.path === b.path
            ? a.method.localeCompare(b.method)
            : a.path.localeCompare(b.path),
        ),
      };
    })
    .sort((a, b) => a.tag.localeCompare(b.tag));
  return cachedByTag;
}

export function defaultServerUrl(): string {
  return spec.servers?.[0]?.url ?? "https://api.moosewave.com";
}

// Build-time spec audit. We log warnings for missing descriptions so the
// gaps are visible in CI logs but never fail the build.
function auditSpec(): void {
  const ops = listOperations();
  let missingDescription = 0;
  for (const op of ops) {
    if (!op.description) missingDescription += 1;
  }
  if (missingDescription > 0 && process.env.NODE_ENV !== "production") {
    console.warn(
      `[docs] OpenAPI spec: ${missingDescription}/${ops.length} operations have no description field`,
    );
  }
}

if (typeof window === "undefined") {
  auditSpec();
}

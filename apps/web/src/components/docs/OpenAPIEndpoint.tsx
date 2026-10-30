// Moosewave docs - render one OpenAPI 3.1 operation.
//
// Server component. Receives a flattened operation (see lib/docs/loadOpenAPI)
// and prints:
//
//   - Method badge + path (with parameter highlights).
//   - Summary, description (markdown).
//   - Parameters table grouped by location (path / query / header).
//   - Request body schema (formatted JSON).
//   - Response shapes per status code.
//   - A static curl snippet generator.
//   - Error codes that the operation emits.
//   - Link back to the source spec.
//
// Schemas are dereferenced lazily: we only resolve $refs one level deep so
// the page stays compact. Full schema introspection is a future iteration.

import type { JSX } from "react";

import {
  type FlatOperation,
  type OpenAPIOperation,
  type OpenAPIParameter,
  defaultServerUrl,
  getSpec,
} from "@/lib/docs/loadOpenAPI";

import { CodeBlock } from "./CodeBlock";

const METHOD_COLORS: Record<string, string> = {
  GET: "text-emerald-700 bg-emerald-50 border-emerald-200",
  POST: "text-blue-700 bg-blue-50 border-blue-200",
  PUT: "text-amber-700 bg-amber-50 border-amber-200",
  PATCH: "text-orange-700 bg-orange-50 border-orange-200",
  DELETE: "text-red-700 bg-red-50 border-red-200",
};

function MethodPill({ method }: { method: string }): JSX.Element {
  const m = method.toUpperCase();
  const color =
    METHOD_COLORS[m] ?? "text-pw-muted-on-paper bg-pw-surface border-pw-line";
  return (
    <span
      className={`inline-flex items-center justify-center rounded-md border px-2 py-1 text-xs font-mono font-bold ${color}`}
    >
      {m}
    </span>
  );
}

function PathDisplay({ path }: { path: string }): JSX.Element {
  // Highlight {param} segments in red.
  const parts = path.split(/(\{[^}]+\})/g);
  return (
    <span className="font-mono text-sm break-all">
      {parts.map((p, i) =>
        /^\{[^}]+\}$/.test(p) ? (
          <span key={i} className="text-pw-ember-700 font-semibold">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  );
}

function resolveRef(ref: string): Record<string, unknown> | null {
  // "#/components/schemas/Foo"
  const path = ref.replace(/^#\//, "").split("/");
  let cur: unknown = getSpec();
  for (const seg of path) {
    if (
      typeof cur === "object" &&
      cur !== null &&
      seg in (cur as Record<string, unknown>)
    ) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return null;
    }
  }
  return (cur ?? null) as Record<string, unknown> | null;
}

function dereferenceShallow(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!schema) return null;
  const ref = (schema as { $ref?: string }).$ref;
  if (typeof ref === "string") {
    const r = resolveRef(ref);
    if (r) return r;
  }
  return schema;
}

function formatSchemaJson(schema: Record<string, unknown> | undefined): string {
  const expanded = dereferenceShallow(schema);
  if (!expanded) return "null";
  try {
    return JSON.stringify(expanded, null, 2);
  } catch {
    return "{ /* unserializable schema */ }";
  }
}

function renderType(schema: Record<string, unknown> | undefined): string {
  if (!schema) return "—";
  const s = dereferenceShallow(schema) ?? {};
  if (typeof (s as { type?: string }).type === "string") {
    const t = (s as { type: string }).type;
    if (t === "array") {
      const items = (s as { items?: Record<string, unknown> }).items;
      return `array<${renderType(items)}>`;
    }
    return t;
  }
  if ((s as { $ref?: string }).$ref) {
    const ref = (s as { $ref: string }).$ref;
    return ref.split("/").pop() ?? "object";
  }
  if ((s as { oneOf?: unknown[] }).oneOf) return "oneOf";
  if ((s as { anyOf?: unknown[] }).anyOf) return "anyOf";
  if ((s as { allOf?: unknown[] }).allOf) return "allOf";
  return "object";
}

export function buildCurl(op: FlatOperation): string {
  const base = defaultServerUrl();
  const url = `${base}${op.path}`;
  // curl treats {} and [] in a URL as glob patterns, so a pasted
  //   curl "https://api.moosewave.com/api/v1/subscribers/{id}"
  // does not request that path — curl expands the single-item set and asks for
  // /api/v1/subscribers/id, then the reader gets a 404 that looks like a bad
  // key or a wrong endpoint. 807 of the spec's 1538 paths are parameterised,
  // so this was every one of their examples. --globoff keeps the placeholder
  // visible and the request literal.
  const globs = /[{[]/.test(op.path) ? "--globoff " : "";
  const lines: string[] = [
    `curl ${globs}-X ${op.method.toUpperCase()} "${url}" \\`,
  ];
  lines.push(`  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\`);
  const hasBody = Boolean(op.operation.requestBody);
  if (hasBody) {
    lines.push(`  -H "Content-Type: application/json" \\`);
    lines.push(`  -H "Idempotency-Key: $(uuidgen)" \\`);
    lines.push(`  -d '{ }'`);
  } else {
    // strip trailing slash + space
    lines[lines.length - 1] = lines[lines.length - 1]!.replace(
      /\\$/,
      "",
    ).trimEnd();
  }
  return lines.join("\n");
}

function ParametersTable({
  params,
}: {
  params: OpenAPIParameter[];
}): JSX.Element | null {
  if (params.length === 0) return null;
  const grouped: Record<string, OpenAPIParameter[]> = {};
  for (const p of params) {
    const where = p.in ?? "query";
    if (!grouped[where]) grouped[where] = [];
    grouped[where]!.push(p);
  }
  const order = ["path", "query", "header", "cookie"] as const;
  return (
    <div className="space-y-4">
      {order
        .filter((g) => grouped[g])
        .map((g) => (
          <div key={g}>
            <h3 className="mt-3 mb-2 text-xs font-semibold uppercase tracking-wider text-pw-muted-on-paper">
              {g} parameters
            </h3>
            <div
              role="region"
              aria-label={`${g} parameters`}
              tabIndex={0}
              className="overflow-x-auto rounded-md border border-pw-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
            >
              <table className="w-full text-sm">
                <thead className="bg-pw-surface">
                  <tr className="text-left">
                    <th scope="col" className="px-3 py-2 font-medium">
                      Name
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Type
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Required
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Description
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-pw-line">
                  {grouped[g]!.map((p) => (
                    <tr key={`${p.in}-${p.name}`}>
                      {/* The parameter name is the row header — without it a
                          screen reader reads "string / required / …" with no
                          way to tell which parameter is being described. */}
                      <th
                        scope="row"
                        className="px-3 py-2 text-left font-mono text-xs font-normal text-pw-ink2"
                      >
                        {p.name}
                      </th>
                      <td className="px-3 py-2 font-mono text-xs text-pw-muted-on-paper">
                        {renderType(p.schema)}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {p.required ? (
                          <span className="text-pw-ember-700 font-medium">
                            required
                          </span>
                        ) : (
                          <span className="text-pw-muted-on-paper">
                            optional
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-pw-muted-on-paper">
                        {p.description ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
    </div>
  );
}

async function RequestBodyBlock({
  op,
}: {
  op: OpenAPIOperation;
}): Promise<JSX.Element | null> {
  if (!op.requestBody) return null;
  const content = op.requestBody.content ?? {};
  const json = content["application/json"]?.schema;
  if (!json) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold">Request body</h2>
      {op.requestBody.description ? (
        <p className="text-sm text-pw-muted-on-paper">
          {op.requestBody.description}
        </p>
      ) : null}
      <CodeBlock
        code={formatSchemaJson(json)}
        language="json"
        caption="application/json"
      />
    </section>
  );
}

async function ResponsesBlock({
  op,
}: {
  op: OpenAPIOperation;
}): Promise<JSX.Element | null> {
  const responses = op.responses;
  if (!responses) return null;
  const codes = Object.keys(responses).sort();
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">Responses</h2>
      {codes.map((code) => {
        const raw = responses[code]!;
        const r =
          "$ref" in raw
            ? ({} as {
                description?: string;
                content?: Record<string, { schema?: Record<string, unknown> }>;
              })
            : raw;
        const json = r.content?.["application/json"]?.schema;
        return (
          <div key={code} className="rounded-md border border-pw-line bg-white">
            <div className="flex items-center gap-3 border-b border-pw-line px-3 py-2">
              <span
                className={`font-mono text-xs font-semibold ${
                  code.startsWith("2")
                    ? "text-emerald-700"
                    : code.startsWith("4")
                      ? "text-amber-700"
                      : code.startsWith("5")
                        ? "text-red-700"
                        : "text-pw-muted-on-paper"
                }`}
              >
                {code}
              </span>
              <span className="text-sm">{r.description ?? ""}</span>
            </div>
            {json ? (
              <CodeBlock
                code={formatSchemaJson(json)}
                language="json"
                caption="application/json"
                className="m-3"
              />
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

function ErrorCodes({ op }: { op: OpenAPIOperation }): JSX.Element | null {
  const codes = Object.keys(op.responses ?? {}).filter(
    (c) => c.startsWith("4") || c.startsWith("5"),
  );
  if (codes.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold">Error codes</h2>
      <ul className="text-sm space-y-1">
        {codes.map((c) => {
          const raw = op.responses![c]!;
          const desc = "$ref" in raw ? "" : raw.description;
          return (
            <li key={c} className="font-mono text-xs">
              <span className="font-semibold mr-2">{c}</span>
              <span className="text-pw-muted-on-paper">{desc ?? "—"}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function OpenAPIEndpoint({ op }: { op: FlatOperation }): JSX.Element {
  return (
    <article className="space-y-8">
      <header className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <MethodPill method={op.method} />
          <PathDisplay path={op.path} />
        </div>
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">
          {op.summary}
        </h1>
        <div className="flex flex-wrap gap-2">
          {op.tags.map((t) => (
            <span
              key={t}
              className="rounded-full border border-pw-line bg-pw-surface px-2 py-0.5 text-[11px] text-pw-muted-on-paper"
            >
              {t}
            </span>
          ))}
        </div>
        {op.description ? (
          <p className="text-pw-muted-on-paper leading-relaxed">
            {op.description}
          </p>
        ) : (
          <p className="text-xs italic text-pw-muted-on-paper">
            (no description in spec)
          </p>
        )}
      </header>

      {op.parameters.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">Parameters</h2>
          <ParametersTable params={op.parameters} />
        </section>
      ) : null}

      <RequestBodyBlock op={op.operation} />
      <ResponsesBlock op={op.operation} />

      <section className="space-y-2">
        <h2 className="text-base font-semibold">Try it · curl</h2>
        <CodeBlock
          code={buildCurl(op)}
          language="bash"
          caption={`${op.method.toUpperCase()} ${op.path}`}
        />
      </section>

      <ErrorCodes op={op.operation} />

      <section className="text-xs text-pw-muted-on-paper border-t border-pw-line pt-3 space-y-1">
        <div>
          <span className="font-medium">operationId:</span>{" "}
          <span className="font-mono">{op.operationId}</span>
        </div>
        <div>
          Source:{" "}
          <a href="/api/openapi.json" className="underline hover:text-pw-ink2">
            bundled OpenAPI document
          </a>
        </div>
      </section>
    </article>
  );
}

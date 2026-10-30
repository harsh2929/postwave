/**
 * PlaygroundCodeGen — emits a copy-paste-ready snippet in curl,
 * JavaScript (fetch), or Python (requests) for the request the
 * operator has built up in the playground form.
 *
 * Why this lives next to the playground rather than as a generic
 * "go from OpenAPI to client SDK" helper: the playground already
 * knows the resolved URL, the per-request body, the custom headers
 * the operator added, and the idempotency key. Rebuilding any of
 * that in a separate snippet view would drift quickly.
 *
 * Three flavours, language-tab-switched. Each sends the already-validated
 * body bytes verbatim so code generation cannot round numbers, collapse
 * duplicate keys, or otherwise drift from the reviewed request.
 *
 * Caller passes the same RequestPlan struct the Send button uses,
 * so generated snippets always match what the playground would
 * actually fire.
 */

import { type ReactElement, useMemo, useState } from "react";

import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import { CopyButton } from "./Copy";

export type CodeLang = "curl" | "js" | "python";

export interface RequestPlan {
  method: string;
  url: string;
  headers: Record<string, string>;
  /**
   * Raw body string the playground sends on the wire. Empty when
   * the request has no body. JSON-shaped bodies are detected at
   * the field level (set by the caller); we just render verbatim.
   */
  body: string;
  /** True when the body is JSON. Drives the syntax of the snippet. */
  bodyIsJSON: boolean;
  /** Authentication is represented by a safe environment placeholder only. */
  authMode: "workspace" | "session" | "unsupported";
  /** True only for an operation admitted by the exact reviewed runner policy. */
  snippetAllowed: boolean;
  /** Safe policy reason shown when snippet generation is unavailable. */
  snippetUnavailableReason?: string;
}

interface Props {
  plan: RequestPlan;
}

const TABS: { id: CodeLang; label: string }[] = [
  { id: "curl", label: "cURL" },
  { id: "js", label: "JavaScript" },
  { id: "python", label: "Python" },
];

const JSON_SNIPPET_MAX_UTF8_BYTES = 64 * 1024;
const JSON_SNIPPET_MAX_DEPTH = 32;
const JSON_SNIPPET_MAX_NODES = 4096;
const encoder = new TextEncoder();

type PreparedJSONBody =
  | { kind: "not-json" | "parsed" }
  | { kind: "unavailable"; reason: string };

export function PlaygroundCodeGen({ plan }: Props): ReactElement {
  const [lang, setLang] = useState<CodeLang>("curl");
  const snippets = useMemo(() => buildSnippets(plan), [plan]);
  const snippet = snippets[lang];
  const tabs = useTabsInteraction({
    value: lang,
    items: TABS.map((item) => ({ value: item.id })),
    onChange: setLang,
  });

  return (
    <div className="play-codegen">
      <div className="play-codegen-bar">
        <div
          ref={tabs.listRef}
          className="chips"
          {...tabs.listProps}
          aria-label="Snippet language"
          style={{ background: "transparent", border: 0, padding: 0 }}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              {...tabs.getTabProps(t.id)}
              className={`chip${lang === t.id ? " is-active" : ""}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <CopyButton
          value={snippet}
          label={`${TABS.find((t) => t.id === lang)?.label} snippet`}
          contentClass="secret"
          clearIfUnchangedAfterMs={60_000}
        />
      </div>
      {TABS.map((item) => (
        <pre
          key={item.id}
          {...tabs.getPanelProps(item.id)}
          className="play-code"
          aria-label={`${item.label} snippet`}
        >
          <code>{snippets[item.id]}</code>
        </pre>
      ))}
    </div>
  );
}

/* ---------- snippet builders --------------------------------------- */

export function buildSnippet(plan: RequestPlan, lang: CodeLang): string {
  const authReason = unavailableAuthReason(plan);
  if (authReason) return unavailableSnippet(authReason);
  return buildPreparedSnippet(plan, lang, prepareJSONBody(plan));
}

function buildSnippets(plan: RequestPlan): Record<CodeLang, string> {
  const authReason = unavailableAuthReason(plan);
  if (authReason) {
    const snippet = unavailableSnippet(authReason);
    return { curl: snippet, js: snippet, python: snippet };
  }

  const preparedJSON = prepareJSONBody(plan);
  return {
    curl: buildPreparedSnippet(plan, "curl", preparedJSON),
    js: buildPreparedSnippet(plan, "js", preparedJSON),
    python: buildPreparedSnippet(plan, "python", preparedJSON),
  };
}

function buildPreparedSnippet(
  plan: RequestPlan,
  lang: CodeLang,
  preparedJSON: PreparedJSONBody,
): string {
  if (preparedJSON.kind === "unavailable") {
    return unavailableSnippet(preparedJSON.reason);
  }

  switch (lang) {
    case "curl":
      return curlSnippet(plan);
    case "js":
      return jsSnippet(plan);
    case "python":
      return pythonSnippet(plan);
  }
}

/** cURL — multi-line with `\` continuations. */
function curlSnippet(plan: RequestPlan): string {
  const lines: string[] = [];
  const method = plan.method.toUpperCase();
  // -X is omitted for GET (curl default), explicit otherwise so the
  // snippet survives accidental "edit just the URL" reuse.
  if (method === "GET") {
    lines.push(`curl '${shellEscape(plan.url)}' \\`);
  } else {
    lines.push(`curl -X ${method} '${shellEscape(plan.url)}' \\`);
  }
  if (plan.authMode === "workspace") {
    lines.push('  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\');
  }
  for (const [k, v] of Object.entries(plan.headers)) {
    lines.push(`  -H '${shellEscape(`${k}: ${v}`)}' \\`);
  }
  if (plan.body) {
    // --data-binary preserves whitespace; safer than -d for JSON.
    lines.push(`  --data-binary $'${shellEscapeMultiline(plan.body)}'`);
  } else {
    // Drop the trailing backslash from the last header line.
    const last = lines.length - 1;
    lines[last] = lines[last]!.replace(/ \\$/, "");
  }
  return lines.join("\n");
}

/** JavaScript fetch — top-level await with the exact reviewed body string. */
function jsSnippet(plan: RequestPlan): string {
  const method = plan.method.toUpperCase();
  const headerLines: string[] = [];
  if (plan.authMode === "workspace") {
    headerLines.push(
      "    Authorization: `Bearer ${process.env.POSTWAVE_API_KEY}`,",
    );
  }
  headerLines.push(
    ...Object.entries(plan.headers).map(
      ([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)},`,
    ),
  );
  const lines: string[] = [];
  lines.push(`const res = await fetch(${JSON.stringify(plan.url)}, {`);
  lines.push(`  method: ${JSON.stringify(method)},`);
  if (headerLines.length > 0) {
    lines.push(`  headers: {`);
    lines.push(...headerLines);
    lines.push(`  },`);
  }
  if (plan.body) {
    lines.push(`  body: ${JSON.stringify(plan.body)},`);
  }
  lines.push(`  redirect: "error",`);
  // The snippet authenticates with a bearer placeholder. Do not mix an
  // ambient browser session into a copied API-key request.
  lines.push(`  credentials: "omit",`);
  lines.push(`});`);
  lines.push(`const contentType = res.headers.get("content-type") ?? "";`);
  lines.push(
    `const data = contentType.includes("json") ? await res.json() : await res.text();`,
  );
  lines.push(`console.log(res.status, data);`);
  return lines.join("\n");
}

/** Python requests — sends the exact reviewed UTF-8 body bytes. */
function pythonSnippet(plan: RequestPlan): string {
  const method = plan.method.toUpperCase();
  const lines: string[] = [];
  if (plan.authMode === "workspace") lines.push(`import os`);
  lines.push(`import requests`);
  lines.push("");
  const headerEntries = Object.entries(plan.headers);
  if (headerEntries.length > 0 || plan.authMode === "workspace") {
    lines.push(`headers = {`);
    if (plan.authMode === "workspace") {
      lines.push(
        `    "Authorization": f"Bearer {os.environ['POSTWAVE_API_KEY']}",`,
      );
    }
    for (const [k, v] of headerEntries) {
      lines.push(`    ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
    }
    lines.push(`}`);
  }
  if (plan.body) {
    lines.push(`payload = ${JSON.stringify(plan.body)}`);
  }
  const args = [`"${method.toLowerCase()}"`, JSON.stringify(plan.url)];
  if (headerEntries.length > 0 || plan.authMode === "workspace") {
    args.push("headers=headers");
  }
  if (plan.body) args.push('data=payload.encode("utf-8")');
  args.push("allow_redirects=False");
  lines.push(`res = requests.request(${args.join(", ")})`);
  lines.push(
    `data = res.json() if "json" in res.headers.get("content-type", "") else res.text`,
  );
  lines.push(`print(res.status_code, data)`);
  return lines.join("\n");
}

/* ---------- helpers ------------------------------------------------- */

function unavailableAuthReason(plan: RequestPlan): string | null {
  if (plan.snippetAllowed !== true) {
    const reason =
      plan.snippetUnavailableReason?.slice(0, 512) ??
      "the operation is reference-only";
    return `live code generation is disabled by the reviewed runner policy: ${reason}`;
  }
  if (plan.authMode === "session") {
    return "browser-managed session authentication cannot be safely represented outside the signed-in playground; authentication was not included";
  }
  if (plan.authMode === "unsupported") {
    return "the operation's authentication scheme is not supported by code generation; authentication was not included";
  }
  if (plan.authMode !== "workspace") {
    return "the operation's authentication contract is missing or unsupported; authentication was not included";
  }
  return null;
}

function unavailableSnippet(reason: string): string {
  return `Snippet unavailable: ${reason}. No executable snippet was generated.`;
}

function shellEscape(s: string): string {
  // Single-quote within a single-quoted shell string requires the
  // '\'' shuffle. cURL header values rarely contain quotes so this
  // is mostly defensive.
  return s.replace(/'/g, `'\\''`);
}

function shellEscapeMultiline(s: string): string {
  // $'...' bash-style: literal newlines as \n, backslashes doubled,
  // single quotes as \'.
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");
}

function prepareJSONBody(plan: RequestPlan): PreparedJSONBody {
  if (!plan.body || !plan.bodyIsJSON) return { kind: "not-json" };

  if (
    plan.body.length > JSON_SNIPPET_MAX_UTF8_BYTES ||
    encoder.encode(plan.body).byteLength > JSON_SNIPPET_MAX_UTF8_BYTES
  ) {
    return {
      kind: "unavailable",
      reason: `JSON body exceeds the ${JSON_SNIPPET_MAX_UTF8_BYTES.toLocaleString("en-US")} UTF-8 byte preview limit`,
    };
  }

  if (exceedsJSONNestingLimit(plan.body)) {
    return {
      kind: "unavailable",
      reason: `JSON body exceeds the ${JSON_SNIPPET_MAX_DEPTH}-level nesting preview limit`,
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(plan.body);
  } catch {
    return {
      kind: "unavailable",
      reason: "JSON body is not valid JSON",
    };
  }

  if (exceedsJSONNodeLimit(value)) {
    return {
      kind: "unavailable",
      reason: `JSON body exceeds the ${JSON_SNIPPET_MAX_NODES.toLocaleString("en-US")}-value preview limit`,
    };
  }

  return { kind: "parsed" };
}

function exceedsJSONNestingLimit(source: string): boolean {
  let depth = 0;
  let escaped = false;
  let inString = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > JSON_SNIPPET_MAX_DEPTH) return true;
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
  }

  return false;
}

function exceedsJSONNodeLimit(root: unknown): boolean {
  const pending: unknown[] = [root];
  let nodes = 0;

  while (pending.length > 0) {
    const value = pending.pop();
    nodes += 1;
    if (nodes > JSON_SNIPPET_MAX_NODES) return true;

    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        pending.push(value[index]);
      }
    } else if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) pending.push(record[key]);
    }
  }

  return false;
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// API playground — the request half: loads the live contract, turns an
// operator's draft into ONE exact request, and dispatches it.
//
// WHY THIS DOES NOT GO THROUGH `api.*`. Every other web call names a literal
// /api/v1 path so src/__tests__/client-calls-mounted-routes.test.ts can prove
// it reaches a mounted route. A playground's path is chosen at run time by the
// operator, so it cannot be literal. The substitute guarantee is structural:
// the only URL this module will build is an operation path template taken
// from the server's own OpenAPI document, with each `{placeholder}` replaced
// by ONE percent-encoded segment (dot, slash, backslash, control characters
// and encoded traversal rejected), plus declared query parameters. There is
// no free-text URL field, and no way to set Authorization, Cookie, tenant or
// Moosewave identity headers.
//
// Transport contract (desktop api-playground-transport.ts:124 is the session
// branch this mirrors): same-origin, `credentials: "include"`, `cache:
// "no-store"`, `redirect: "error"`, one attempt — no retry, no offline queue —
// a 20 s ceiling, cancellable, and a 2 MiB response preview after which the
// stream is cancelled rather than buffered.

import pkg from "../../package.json";
import { fetchTextAuthed } from "@/lib/api";
import {
  normalizePlaygroundCatalog,
  PlaygroundCatalogError,
  playgroundEnumValues,
  type PlaygroundCatalog,
  type PlaygroundOperation,
  type PlaygroundPolicy,
} from "@/lib/api-playground-catalog";
import { CONTEXT_EPOCH_HEADER, observeContextEpoch } from "@/lib/context-epoch";
import { newUUIDv7 } from "@/lib/http-fetch";
import { parseErrorEnvelope } from "@postwave/errors";

export const PLAYGROUND_CATALOG_MAX_BYTES = 8 * 1024 * 1024;
export const PLAYGROUND_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const PLAYGROUND_REQUEST_BODY_MAX_BYTES = 256 * 1024;
export const PLAYGROUND_PATH_VALUE_MAX_BYTES = 2 * 1024;
export const PLAYGROUND_QUERY_MAX_BYTES = 32 * 1024;
export const PLAYGROUND_HEADER_VALUE_MAX_BYTES = 8 * 1024;
export const PLAYGROUND_REQUEST_TIMEOUT_MS = 20_000;

const CLIENT_VERSION = (pkg as { version?: string }).version || "dev";

/** GET /api/v1/openapi.json → normalized catalog. Fails closed. */
export async function loadPlaygroundCatalog(
  signal?: AbortSignal,
): Promise<PlaygroundCatalog> {
  // The contract is ~5 MiB, past the shared 2 MiB JSON ceiling, so it rides
  // the reviewed text transport with an explicit bound instead.
  const body = await fetchTextAuthed("/api/v1/openapi.json", {
    signal,
    maxBytes: PLAYGROUND_CATALOG_MAX_BYTES,
  });
  let document: unknown;
  try {
    document = JSON.parse(body) as unknown;
  } catch {
    throw new PlaygroundCatalogError("The API contract is not valid JSON.");
  }
  return normalizePlaygroundCatalog(document);
}

// ---------------------------------------------------------------------------
// Drafts and exact request plans
// ---------------------------------------------------------------------------

export interface PlaygroundDraft {
  path: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  /** Minted per attempt; sent only when the operation declares the header. */
  idempotencyKey: string;
}

export interface PlaygroundIssue {
  field: "path" | "query" | "header" | "body";
  name: string;
  message: string;
}

export interface PlaygroundPlan {
  method: string;
  /** Same-origin, relative: `/api/v1/...?...`. */
  url: string;
  /** The operator-visible headers this request adds (transport headers aside). */
  headers: Record<string, string>;
  body: string;
}

export interface BuiltPlaygroundRequest {
  plan: PlaygroundPlan;
  issues: PlaygroundIssue[];
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

function decodedForms(value: string): string[] {
  const values = [value];
  let current = value;
  for (let index = 0; index < 8; index += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      values.push(decoded);
      current = decoded;
    } catch {
      break;
    }
  }
  return values;
}

/** Why a path value cannot become exactly one safe segment, or null. */
export function unsafePlaygroundPathValue(value: string): string | null {
  for (const candidate of decodedForms(value)) {
    if (hasControlCharacter(candidate)) return "Control characters are not allowed.";
    if (candidate.includes("/") || candidate.includes("\\")) {
      return "Path values cannot contain slash or backslash characters.";
    }
    if (candidate === "." || candidate === "..") {
      return "Dot path segments are not allowed.";
    }
    if (/%(?:2e|2f|5c)/i.test(candidate)) {
      return "Encoded dot and slash path segments are not allowed.";
    }
  }
  return null;
}

function scalarExample(value: unknown): string | undefined {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? String(value)
    : undefined;
}

export function newPlaygroundIdempotencyKey(): string {
  return newUUIDv7();
}

/** Seed a draft from declared examples/defaults, like desktop's initialDraft. */
export function initialPlaygroundDraft(
  operation: PlaygroundOperation,
): PlaygroundDraft {
  const seeded = (location: "path" | "query" | "header") => {
    const out: Record<string, string> = {};
    for (const parameter of operation.parameters) {
      if (parameter.location !== location) continue;
      if (parameter.name.toLowerCase() === "idempotency-key") continue;
      const value =
        scalarExample(parameter.example) ??
        scalarExample(parameter.schema?.example) ??
        scalarExample(parameter.schema?.default);
      if (value !== undefined) out[parameter.name] = value;
    }
    return out;
  };
  let body = "";
  const example = operation.requestBody?.example;
  if (example !== undefined) {
    try {
      body = JSON.stringify(example, null, 2);
      if (byteLength(body) > PLAYGROUND_REQUEST_BODY_MAX_BYTES) body = "";
    } catch {
      body = "";
    }
  }
  return {
    path: seeded("path"),
    query: seeded("query"),
    headers: seeded("header"),
    body,
    idempotencyKey: newPlaygroundIdempotencyKey(),
  };
}

/** A blank draft: history never retains values, so a replay starts empty. */
export function blankPlaygroundDraft(): PlaygroundDraft {
  return {
    path: {},
    query: {},
    headers: {},
    body: "",
    idempotencyKey: newPlaygroundIdempotencyKey(),
  };
}

export function buildPlaygroundRequest(
  operation: PlaygroundOperation,
  policy: PlaygroundPolicy,
  draft: PlaygroundDraft,
): BuiltPlaygroundRequest {
  const issues: PlaygroundIssue[] = [];

  const segments = operation.path.split("/").map((segment) => {
    const match = /^\{([^{}]+)\}$/.exec(segment);
    if (!match) return segment;
    const name = match[1]!;
    const value = (draft.path[name] ?? "").trim();
    if (!value) {
      issues.push({ field: "path", name, message: `Path parameter ${name} is required.` });
      return segment;
    }
    const unsafe = unsafePlaygroundPathValue(value);
    if (unsafe) {
      issues.push({ field: "path", name, message: `${name}: ${unsafe}` });
      return segment;
    }
    if (byteLength(value) > PLAYGROUND_PATH_VALUE_MAX_BYTES) {
      issues.push({ field: "path", name, message: `${name} is too long.` });
      return segment;
    }
    return encodeURIComponent(value);
  });

  const search = new URLSearchParams();
  for (const parameter of operation.parameters) {
    if (parameter.location !== "query") continue;
    const value = draft.query[parameter.name] ?? "";
    if (!value.trim()) {
      if (parameter.required) {
        issues.push({
          field: "query",
          name: parameter.name,
          message: `Query parameter ${parameter.name} is required.`,
        });
      }
      continue;
    }
    const allowed = playgroundEnumValues(parameter);
    if (allowed.length > 0 && !allowed.includes(value)) {
      issues.push({
        field: "query",
        name: parameter.name,
        message: `${parameter.name} must be one of ${allowed.join(", ")}.`,
      });
    }
    search.append(parameter.name, value);
  }
  const query = search.toString();
  if (byteLength(query) > PLAYGROUND_QUERY_MAX_BYTES) {
    issues.push({ field: "query", name: "", message: "The query string is too long." });
  }

  const headers: Record<string, string> = {};
  for (const parameter of policy.editableHeaders) {
    const value = (draft.headers[parameter.name] ?? "").trim();
    if (!value) {
      if (parameter.required) {
        issues.push({
          field: "header",
          name: parameter.name,
          message: `Header ${parameter.name} is required.`,
        });
      }
      continue;
    }
    if (hasControlCharacter(value) || byteLength(value) > PLAYGROUND_HEADER_VALUE_MAX_BYTES) {
      issues.push({
        field: "header",
        name: parameter.name,
        message: `Header ${parameter.name} contains an unsafe or oversized value.`,
      });
      continue;
    }
    headers[parameter.name] = value;
  }
  if (policy.idempotency !== "none") {
    headers["Idempotency-Key"] = draft.idempotencyKey;
  }

  let body = "";
  const requestBody = operation.requestBody;
  if (requestBody) {
    const raw = draft.body.trim();
    if (!raw) {
      if (requestBody.required) {
        issues.push({ field: "body", name: "body", message: "A JSON request body is required." });
      }
    } else if (byteLength(raw) > PLAYGROUND_REQUEST_BODY_MAX_BYTES) {
      issues.push({ field: "body", name: "body", message: "The request body exceeds 256 KiB." });
    } else if (
      operation.maxBodyBytes !== undefined &&
      byteLength(raw) > operation.maxBodyBytes
    ) {
      issues.push({
        field: "body",
        name: "body",
        message: `The request body exceeds this route's ${operation.maxBodyBytes}-byte limit.`,
      });
    } else {
      try {
        JSON.parse(raw);
        body = raw;
        headers["Content-Type"] = requestBody.jsonMediaType ?? "application/json";
      } catch (cause) {
        issues.push({
          field: "body",
          name: "body",
          message: `The request body is not valid JSON: ${cause instanceof Error ? cause.message : "parse error"}.`,
        });
      }
    }
  }

  return {
    plan: {
      method: operation.method.toUpperCase(),
      url: `${segments.join("/")}${query ? `?${query}` : ""}`,
      headers,
      body,
    },
    issues,
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface PlaygroundResponse {
  status: number;
  statusText: string;
  body: string;
  headers: Record<string, string>;
  contentType: string;
  previewBytes: number;
  truncated: boolean;
  durationMs: number;
  outcome: "http" | "aborted" | "timeout" | "network";
  /**
   * The server may have applied a write whose outcome this tab cannot prove:
   * a cancel, timeout or network loss after dispatch, or a 408/429/5xx.
   */
  ambiguous: boolean;
  requestId: string;
  /** The server's own sentence for an error status, verbatim. */
  serverMessage?: string;
}

async function readTextLimited(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!response.body) {
    const encoded = new TextEncoder().encode(await response.text());
    const bounded = encoded.slice(0, maxBytes);
    return {
      text: new TextDecoder().decode(bounded),
      bytes: bounded.byteLength,
      truncated: encoded.byteLength > maxBytes,
    };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode(), bytes, truncated: false };
    const remaining = maxBytes - bytes;
    if (value.byteLength > remaining) {
      if (remaining > 0) {
        text += decoder.decode(value.slice(0, remaining), { stream: true });
        bytes += remaining;
      }
      await reader.cancel("playground-preview-limit").catch(() => undefined);
      return { text: text + decoder.decode(), bytes, truncated: true };
    }
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
}

function serverMessageFor(
  status: number,
  body: string,
  headers: Headers,
): string | undefined {
  if (status < 400 || !body.trim()) return undefined;
  let parsed: unknown = body;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    // A plain-text error body is itself the server's sentence.
  }
  return parseErrorEnvelope(parsed, headers).message?.slice(0, 2_000);
}

export async function executePlaygroundRequest(
  plan: PlaygroundPlan,
  policy: PlaygroundPolicy,
  signal: AbortSignal,
): Promise<PlaygroundResponse> {
  const started = performance.now();
  // newUUIDv7 degrades to Math.random where crypto.randomUUID does not exist
  // (a plain-http LAN origin is not a secure context).
  const requestId = newUUIDv7();
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort("playground-timeout");
  }, PLAYGROUND_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(plan.url, {
      method: plan.method,
      headers: {
        Accept: "application/json",
        "X-Postwave-Client": "web",
        "X-Postwave-Version": CLIENT_VERSION,
        "X-Request-Id": requestId,
        ...plan.headers,
      },
      body: plan.body || undefined,
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    observeContextEpoch(response.headers.get(CONTEXT_EPOCH_HEADER));
    const body = await readTextLimited(response, PLAYGROUND_PREVIEW_MAX_BYTES);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      status: response.status,
      statusText: response.statusText,
      body: body.text,
      headers,
      contentType: response.headers.get("content-type") ?? "",
      previewBytes: body.bytes,
      truncated: body.truncated,
      durationMs: Math.round(performance.now() - started),
      outcome: "http",
      ambiguous:
        policy.effect !== "read" &&
        (response.status === 408 || response.status === 429 || response.status >= 500),
      requestId: response.headers.get("x-request-id") ?? requestId,
      serverMessage: serverMessageFor(response.status, body.text, response.headers),
    };
  } catch {
    const aborted = signal.aborted && !timedOut;
    return {
      status: 0,
      statusText: timedOut ? "Timed out" : aborted ? "Cancelled" : "Network error",
      body: timedOut
        ? "The request exceeded the 20-second playground limit."
        : aborted
          ? "The request was cancelled before a response completed."
          : "The request failed before a response completed.",
      headers: {},
      contentType: "text/plain",
      previewBytes: 0,
      truncated: false,
      durationMs: Math.round(performance.now() - started),
      outcome: timedOut ? "timeout" : aborted ? "aborted" : "network",
      // Once a write has left the tab, a local cancel cannot prove the server
      // did not commit it.
      ambiguous: policy.effect !== "read",
      requestId,
    };
  } finally {
    window.clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

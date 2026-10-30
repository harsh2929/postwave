// SPDX-License-Identifier: AGPL-3.0-only

import { loadOpsRuntimeConfig, type OpsRuntimeConfig } from "./opsConfig";

export const MAX_ACTION_BODY_BYTES = 20 * 1024;
export const MAX_INCIDENT_BODY_BYTES = 20 * 1024;
export const MAX_ACTION_RESPONSE_BYTES = 64 * 1024;
export const MAX_BOARD_RESPONSE_BYTES = 1024 * 1024;
// Cap on an action/snooze `result` string, enforced as both code points and
// UTF-8 bytes so neither a wide-character nor a byte blow-up slips through.
export const MAX_ACTION_RESULT_CHARS = 2_048;
export const MAX_ACTION_RESULT_BYTES = 2_048;
// Upstream timeouts: mutations may block on an audit write, views are read-only.
export const OPS_MUTATION_TIMEOUT_MS = 35_000;
export const OPS_VIEW_TIMEOUT_MS = 5_000;
export const CSRF_HEADER = "x-postwave-ops-csrf";
export const CSRF_VALUE = "same-origin";

// The operator-facing wording for the HTTP statuses every ops surface maps the
// same way (board reader, view reader, mutation proxy). Returns undefined for
// statuses a caller words per-surface, so the shared strings live in one place
// and cannot drift between read and write paths.
export function knownOpsStatusMessage(status: number | undefined): string | undefined {
  if (status === 401) return "operator authentication is required";
  if (status === 403) return "operator access was denied";
  if (status === 429) return "the ops service rate limit was reached";
  return undefined;
}

const SESSION_VALUE = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u;
const REPO_RUNBOOK = /^docs\/runbooks\/([a-z0-9][a-z0-9._/-]*\.md)$/u;

export class BodyLimitError extends Error {
  constructor() {
    super("request or response body exceeds the configured limit");
    this.name = "BodyLimitError";
  }
}

export function sessionCookieOnly(raw: string | null): string | undefined {
  if (!raw) return undefined;
  let session: string | undefined;
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== "pw_session") continue;
    if (session !== undefined) return undefined;
    const value = part.slice(separator + 1).trim();
    if (!SESSION_VALUE.test(value)) return undefined;
    session = `pw_session=${value}`;
  }
  return session;
}

// A forwarded chain of IPv4/IPv6 literals. Anything else (obfuscated node
// identifiers, "unknown", a CR/LF injection attempt) is dropped rather than
// relayed: the API treats a malformed hop as an ambiguous chain anyway, and a
// header we cannot vouch for is worse than no header.
const FORWARDED_CHAIN = /^[0-9A-Fa-f:.[\]]+(?:\s*,\s*[0-9A-Fa-f:.[\]]+)*$/u;
const MAX_FORWARDED_CHAIN_CHARS = 512;

/**
 * forwardedClientHeaders relays the browser's address to the API.
 *
 * The API's third factor for a platform operator is the client IP checked
 * against `platform_operators.ip_allowlist`, and it reads that from the
 * request it receives — so a console request built from scratch presents the
 * console's own egress address for every operator and the allowlist decides
 * nothing. We therefore pass through the chain our ingress produced, exactly
 * as received: `middleware.ResolveClientIP` walks it rightmost-first and
 * honours it only when our egress address is inside
 * POSTWAVE_TRUSTED_PROXY_CIDRS, so an entry a client prepended can never win,
 * and until that CIDR is registered the API simply ignores what we send.
 *
 * This makes the console a proxy in the trust chain: it must stay behind an
 * ingress that sets X-Forwarded-For itself. Exposing it directly would let a
 * caller choose the address the allowlist sees.
 */
export function forwardedClientHeaders(headers: Headers): Record<string, string> {
  for (const name of ["x-forwarded-for", "x-real-ip"]) {
    const raw = headers.get(name)?.trim();
    if (!raw || raw.length > MAX_FORWARDED_CHAIN_CHARS) continue;
    if (FORWARDED_CHAIN.test(raw)) return { "x-forwarded-for": raw };
  }
  return {};
}

export function requestHasValidOrigin(
  req: Request,
  config: OpsRuntimeConfig,
): boolean {
  if (req.headers.get(CSRF_HEADER) !== CSRF_VALUE) return false;
  const origin = req.headers.get("origin");
  if (!origin) return !config.production;
  try {
    const parsed = new URL(origin);
    return (
      parsed.origin === config.publicOrigin &&
      parsed.href === `${parsed.origin}/` &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

export async function readBodyBounded(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  declaredLength?: string | null,
): Promise<string> {
  if (declaredLength) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > limit) {
      throw new BodyLimitError();
    }
  }
  if (!body) return "";

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new BodyLimitError();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof BodyLimitError) throw error;
    throw new Error("body could not be decoded as UTF-8");
  } finally {
    reader.releaseLock();
  }
}

export async function readJSONResponseBounded(
  response: Response,
  limit: number,
): Promise<unknown> {
  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json" && mediaType !== "application/problem+json") {
    throw new Error("response is not JSON");
  }
  const text = await readBodyBounded(
    response.body,
    limit,
    response.headers.get("content-length"),
  );
  return JSON.parse(text) as unknown;
}

export function resolveRunbookHref(
  raw: string,
  config: OpsRuntimeConfig,
): string | undefined {
  const candidate = raw.trim();
  const repoMatch = REPO_RUNBOOK.exec(candidate);
  if (repoMatch && !repoMatch[1].split("/").includes("..")) {
    return new URL(repoMatch[1], config.runbookBaseURL).toString();
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  const base = new URL(config.runbookBaseURL);
  if (
    url.protocol !== base.protocol ||
    url.origin !== base.origin ||
    !url.pathname.startsWith(base.pathname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return undefined;
  }
  return url.toString();
}

export function normalizedUpstreamError(status: number): Response {
  const safeStatus = status >= 400 && status <= 599 ? status : 502;
  const message =
    knownOpsStatusMessage(safeStatus) ??
    (safeStatus === 409
      ? "the ops request conflicts with current state or a prior idempotent intent"
      : safeStatus >= 500
        ? "the ops service is unavailable"
        : "the ops request was rejected");
  return safeJSON(safeStatus, "ops_request_rejected", message);
}

export function safeJSON(
  status: number,
  code: string,
  message: string,
  payload?: Record<string, unknown>,
): Response {
  return new Response(
    JSON.stringify(payload ?? { error: { code, message } }),
    {
      status,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/iu;

// The mutation-proxy envelope every ops POST shares: load config, gate on
// same-origin CSRF, require a JSON body within `bodyLimit`, validate it,
// forward it to `path` with the operator cookie + CSRF header (no laundering —
// upstream status/errors pass through), and normalize a 200 body. Only the
// per-endpoint parts differ, supplied via `spec`:
//   - validate: parse+shape-check the request; return the re-serialized body
//     plus a context for normalize, or null to reject with 400.
//   - normalize: shape-check the upstream 200 body given that context; return
//     the response object, or undefined to reject with 502.
//   - unreachableMessage: the 502 wording when the upstream never answered
//     (each caller states its own retry semantics — idempotent vs keyed).
// Callers validate any path id (check/tenant/incident) and build `path` BEFORE
// calling this, so a bad id 400s before any config load or upstream call.
export interface OpsMutationSpec<C> {
  path: string;
  bodyLimit: number;
  unreachableMessage: string;
  validate: (parsed: unknown) => { body: Record<string, unknown>; context: C } | null;
  normalize: (payload: unknown, context: C) => Record<string, unknown> | undefined;
}

export async function forwardOpsMutation<C>(
  req: Request,
  spec: OpsMutationSpec<C>,
): Promise<Response> {
  let config: OpsRuntimeConfig;
  try {
    config = loadOpsRuntimeConfig();
  } catch (error) {
    console.error("ops runtime configuration is invalid", {
      cause: error instanceof Error ? error.name : "unknown",
    });
    return safeJSON(503, "ops_not_configured", "the ops console is not configured safely");
  }
  if (!requestHasValidOrigin(req, config)) {
    return safeJSON(403, "csrf_rejected", "the request did not come from the ops console");
  }
  if (!JSON_CONTENT_TYPE.test(req.headers.get("content-type") ?? "")) {
    return safeJSON(415, "json_required", "the request must be JSON");
  }

  let body: string;
  let context: C;
  try {
    const raw = await readBodyBounded(
      req.body,
      spec.bodyLimit,
      req.headers.get("content-length"),
    );
    const parsed = JSON.parse(raw) as unknown;
    const validated = spec.validate(parsed);
    if (!validated) {
      return safeJSON(400, "invalid_json", "the request must be a JSON object");
    }
    body = JSON.stringify(validated.body);
    context = validated.context;
  } catch (error) {
    return safeJSON(
      error instanceof BodyLimitError ? 413 : 400,
      error instanceof BodyLimitError ? "body_too_large" : "invalid_json",
      error instanceof BodyLimitError
        ? "the request body is too large"
        : "the request body is not valid JSON",
    );
  }

  const cookie = sessionCookieOnly(req.headers.get("cookie"));
  let res: Response;
  try {
    res = await fetch(`${config.apiOrigin}${spec.path}`, {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        origin: config.publicOrigin,
        [CSRF_HEADER]: CSRF_VALUE,
        ...forwardedClientHeaders(req.headers),
        ...(cookie ? { cookie } : {}),
      },
      body,
      signal: AbortSignal.timeout(OPS_MUTATION_TIMEOUT_MS),
    });
  } catch {
    // Unreachable is NOT "did not run": the request may have landed. Callers
    // keep their idempotency key on this outcome so a retry replays.
    return safeJSON(502, "ops_api_unreachable", spec.unreachableMessage);
  }

  if (!res.ok) {
    try {
      await readJSONResponseBounded(res, MAX_ACTION_RESPONSE_BYTES);
    } catch {
      // Consume only a bounded body; upstream details stay server-side.
    }
    return normalizedUpstreamError(res.status);
  }

  let payload: unknown;
  try {
    payload = await readJSONResponseBounded(res, MAX_ACTION_RESPONSE_BYTES);
  } catch {
    return safeJSON(502, "invalid_ops_response", "the ops service returned invalid data");
  }
  const normalized = spec.normalize(payload, context);
  if (!normalized) {
    return safeJSON(502, "invalid_ops_response", "the ops service returned invalid data");
  }
  return safeJSON(200, "", "", normalized);
}

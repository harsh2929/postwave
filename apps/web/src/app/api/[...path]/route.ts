// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from "next/server";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const PUBLIC_RESPONSE_BLOCKED_HEADERS = new Set([
  "authorization",
  "proxy-authenticate",
  "server",
  "set-cookie",
  "www-authenticate",
  "x-listmonk-version",
  "x-powered-by",
  "x-postwave-token",
]);

// Headers that the gateway treats as authoritative tenant/role identity in
// dev mode. We strip them off EVERY incoming request unconditionally — only
// this proxy is allowed to set them, and only in non-production.
const CLIENT_BANNED_HEADERS = new Set([
  "x-tenant-slug",
  "x-tenant-id",
  "x-postwave-role",
  "x-postwave-tenant-id",
  "x-postwave-actor-type",
]);

const PUBLIC_SAFE_COOKIE_NAMES = new Set(["NEXT_LOCALE"]);

const PRIVATE_COOKIE_NAMES = new Set([
  "__session",
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
  "pw_session",
]);

const isProduction = process.env.NODE_ENV === "production";
const JSON_PROXY_TIMEOUT_MS = positiveIntEnv(
  "POSTWAVE_API_PROXY_TIMEOUT_MS",
  15_000,
  1_000,
);
const STREAM_PROXY_TIMEOUT_MS = positiveIntEnv(
  "POSTWAVE_API_STREAM_TIMEOUT_MS",
  310_000,
  30_000,
);
const EXPORT_PROXY_TIMEOUT_MS = positiveIntEnv(
  "POSTWAVE_API_EXPORT_TIMEOUT_MS",
  30 * 60_000,
  60_000,
);
const MAX_PROXY_BODY_BYTES = positiveIntEnv(
  "POSTWAVE_API_PROXY_MAX_BODY_BYTES",
  25 * 1024 * 1024,
  1 * 1024 * 1024,
);

function positiveIntEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.floor(parsed);
}

function isUnsafeProxySegment(segment: string): boolean {
  if (!segment || segment !== segment.trim()) return true;

  let decoded = segment;
  for (let i = 0; i < 2; i += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      break;
    }
  }

  for (const value of [segment, decoded]) {
    if (!value || value === "." || value === "..") return true;
    if (/[\u0000-\u001f\u007f\\]/.test(value)) return true;
  }
  return false;
}

function isLongRunningApiPath(pathname: string): boolean {
  return (
    pathname === "/api/v1/subscribers/import" ||
    (pathname.startsWith("/api/v1/privacy/export-requests/") &&
      pathname.endsWith("/download")) ||
    (pathname.startsWith("/api/v1/exports/") && pathname.endsWith("/download"))
  );
}

function isWorkspaceExportDownload(pathname: string): boolean {
  return (
    pathname.startsWith("/api/v1/exports/") && pathname.endsWith("/download")
  );
}

function apiProxyPath(path: string[]): string {
  if (!path.length || path.some(isUnsafeProxySegment)) {
    throw new Error("Unsafe API proxy path.");
  }
  return `/api/${path.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

// Defense in depth: if the deploy somehow shipped with a tenant slug or
// auth-bypass flag set, refuse to load the proxy module. Same posture as
// apps/web/src/middleware.ts.
if (isProduction) {
  for (const name of [
    "POSTWAVE_AUTH_BYPASS",
    "POSTWAVE_LOCAL_AUTH_BYPASS",
    "NEXT_PUBLIC_USE_MOCKS",
  ]) {
    if (process.env[name] === "1") {
      throw new Error(
        `[postwave/api-proxy] refusing to start: ${name}=1 in NODE_ENV=production. ` +
          `These flags inject anonymous owner-role headers; they must not be set in prod.`,
      );
    }
  }
}

function apiBaseURL(): string {
  const raw = (
    process.env.API_URL ||
    process.env.POSTWAVE_API_URL ||
    "http://localhost:8080"
  )
    .trim()
    .replace(/\/+$/, "");
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error(
      "[postwave/api-proxy] API base URL must not contain control characters.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("[postwave/api-proxy] API base URL must be a valid URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("[postwave/api-proxy] API base URL must use http(s).");
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      "[postwave/api-proxy] API base URL must not include credentials.",
    );
  }
  if (parsed.search || parsed.hash) {
    throw new Error(
      "[postwave/api-proxy] API base URL must not include a query string or fragment.",
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

function defaultTenantSlug(): string | undefined {
  if (isProduction) return undefined;
  return (
    process.env.POSTWAVE_TENANT_SLUG ||
    process.env.NEXT_PUBLIC_TENANT_SLUG ||
    process.env.NEXT_PUBLIC_POSTWAVE_TENANT_SLUG
  );
}

function localDevRole(): string | undefined {
  if (isProduction) return undefined;
  if (
    process.env.POSTWAVE_LOCAL_AUTH_BYPASS === "1" ||
    process.env.POSTWAVE_AUTH_BYPASS === "1"
  ) {
    return "owner";
  }
  return undefined;
}

function isStreamPath(pathname: string): boolean {
  if (pathname === "/api/v1/events" || pathname === "/api/v1/dashboard/live") {
    return true;
  }
  return (
    (pathname.startsWith("/api/v1/campaigns/") &&
      pathname.endsWith("/events")) ||
    (pathname.startsWith("/api/v1/migrations/") &&
      pathname.endsWith("/events")) ||
    // CSV import progress (subscriber_import.Progress) is server-sent events.
    (pathname.startsWith("/api/v1/subscriber-imports/") &&
      pathname.endsWith("/progress"))
  );
}

function isPublicPath(pathname: string): boolean {
  return pathname === "/api/public" || pathname.startsWith("/api/public/");
}

function proxyErrorMessage(code: string): string {
  switch (code) {
    case "request_too_large":
      return "The request body is too large for the Moosewave API proxy.";
    case "unsafe_proxy_path":
      return "The requested API path is not allowed.";
    case "upstream_timeout":
      return "The Moosewave API did not respond in time.";
    case "upstream_network_error":
      return "The Moosewave API is unreachable.";
    default:
      return "The Moosewave API proxy failed.";
  }
}

function clientClosedResponse(): Response {
  return new Response(null, {
    status: 499,
    statusText: "Client Closed Request",
  });
}

function sanitizeLogText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        if (url.search) url.search = "?redacted=1";
        if (url.hash) url.hash = "";
        return url.toString();
      } catch {
        return "[redacted-url]";
      }
    })
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|stream[_-]?token)=([^&\s]+)/gi,
      "$1=[redacted]",
    )
    .slice(0, 500);
}

function sanitizeErrorForLog(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return {
      name: err.name || "Error",
      message: sanitizeLogText(err.message || "request failed"),
    };
  }
  return {
    name: typeof err,
    message: sanitizeLogText(String(err)),
  };
}

async function readProxyBody(
  request: Request,
): Promise<{ body?: ArrayBuffer; tooLarge: boolean }> {
  if (request.method === "GET" || request.method === "HEAD") {
    return { tooLarge: false };
  }
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_PROXY_BODY_BYTES) {
    return { tooLarge: true };
  }
  if (!request.body) return { tooLarge: false };

  const reader = request.body.getReader();
  const cancelRead = () => {
    void reader.cancel(request.signal.reason).catch(() => undefined);
  };
  if (request.signal.aborted) {
    cancelRead();
  } else {
    request.signal.addEventListener("abort", cancelRead, { once: true });
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROXY_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    request.signal.removeEventListener("abort", cancelRead);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: body.buffer, tooLarge: false };
}

function abortError(name: "AbortError" | "TimeoutError", message: string) {
  const error = new Error(message);
  error.name = name;
  return error;
}

type ProxyAbortKind = "downstream" | "request" | "timeout" | "upstream";

function createProxyLifecycle(requestSignal: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let abortKind: ProxyAbortKind | undefined;
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    requestSignal.removeEventListener("abort", abortForRequest);
  };

  const cancelReader = async (reason: unknown) => {
    if (!reader) return;
    await reader.cancel(reason).catch(() => undefined);
  };

  const abort = async (reason: unknown, kind: ProxyAbortKind) => {
    abortKind ??= kind;
    dispose();
    if (!controller.signal.aborted) controller.abort(reason);
    await cancelReader(reason);
  };

  const abortForRequest = () => {
    void abort(
      requestSignal.reason ??
        abortError("AbortError", "The downstream request was aborted."),
      "request",
    );
  };

  const timer = setTimeout(() => {
    void abort(
      abortError("TimeoutError", "The upstream response timed out."),
      "timeout",
    );
  }, timeoutMs);

  if (requestSignal.aborted) {
    abortForRequest();
  } else {
    requestSignal.addEventListener("abort", abortForRequest, { once: true });
  }

  const wrapBody = (
    body: ReadableStream<Uint8Array>,
  ): ReadableStream<Uint8Array> => {
    reader = body.getReader();
    if (controller.signal.aborted) {
      void cancelReader(controller.signal.reason);
    }

    return new ReadableStream<Uint8Array>({
      async pull(streamController) {
        try {
          const chunk = await reader?.read();
          if (!chunk || chunk.done) {
            dispose();
            try {
              streamController.close();
            } catch {
              // The downstream may already have cancelled while a read was in flight.
            }
            return;
          }
          streamController.enqueue(chunk.value);
        } catch (error) {
          await abort(error, "upstream");
          if (abortKind === "request" || abortKind === "downstream") {
            try {
              streamController.close();
            } catch {
              // Cancellation already closed the exposed response stream.
            }
            return;
          }
          streamController.error(error);
        }
      },
      async cancel(reason) {
        await abort(
          reason ??
            abortError("AbortError", "The downstream response was cancelled."),
          "downstream",
        );
      },
    });
  };

  return {
    abort,
    abortKind: () => abortKind,
    dispose,
    signal: controller.signal,
    wrapBody,
  };
}

function filterPublicCookieHeader(cookie: string | null): string | null {
  if (!cookie) return null;
  const kept: string[] = [];
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const name = eq >= 0 ? trimmed.slice(0, eq) : trimmed;
    if (PRIVATE_COOKIE_NAMES.has(name)) continue;
    if (PUBLIC_SAFE_COOKIE_NAMES.has(name)) kept.push(trimmed);
  }
  return kept.length ? kept.join("; ") : null;
}

function forwardHeaders(request: Request, pathname: string): Headers {
  const headers = new Headers(request.headers);
  const publicRequest = isPublicPath(pathname);
  for (const name of HOP_BY_HOP_HEADERS) {
    headers.delete(name);
  }
  // Always strip client-supplied tenant/role headers BEFORE any potential
  // re-injection. The browser cannot impersonate a tenant or role, ever.
  for (const name of CLIENT_BANNED_HEADERS) {
    headers.delete(name);
  }
  if (publicRequest) {
    headers.delete("authorization");
    headers.delete("x-postwave-token");
    const publicCookie = filterPublicCookieHeader(headers.get("cookie"));
    if (publicCookie) {
      headers.set("cookie", publicCookie);
    } else {
      headers.delete("cookie");
    }
  }
  headers.set("accept", headers.get("accept") || "application/json");
  // Re-inject dev-only identity headers for local development. In production
  // these helpers always return undefined, so nothing is added.
  if (!publicRequest) {
    const slug = defaultTenantSlug();
    if (slug) headers.set("x-tenant-slug", slug);
    const role = localDevRole();
    if (role) headers.set("x-postwave-role", role);
  }
  return headers;
}

function responseHeadersFor(headers: Headers, pathname: string): Headers {
  const outgoing = new Headers();
  const publicResponse = isPublicPath(pathname);

  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    // Fetch's Headers iteration may collapse multiple Set-Cookie fields. Copy
    // them separately through getSetCookie() below so no auth cookie is lost.
    if (lower === "set-cookie") return;
    if (HOP_BY_HOP_HEADERS.has(lower)) return;
    if (lower === "server" || lower === "x-powered-by") return;
    if (
      publicResponse &&
      (PUBLIC_RESPONSE_BLOCKED_HEADERS.has(lower) ||
        lower.startsWith("x-listmonk-"))
    ) {
      return;
    }
    outgoing.set(key, value);
  });

  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  const cookies = getSetCookie
    ? getSetCookie.call(headers)
    : [headers.get("set-cookie")].filter((value): value is string =>
        Boolean(value),
      );
  if (!publicResponse) {
    for (const cookie of cookies) outgoing.append("set-cookie", cookie);
  }

  return outgoing;
}

async function proxy(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await params;
  const source = new URL(request.url);
  let target: URL;
  let proxyPath: string;
  try {
    proxyPath = apiProxyPath(path);
    target = new URL(
      `${proxyPath.replace(/^\/+/, "")}${source.search}`,
      `${apiBaseURL()}/`,
    );
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "unsafe_proxy_path",
          message: proxyErrorMessage("unsafe_proxy_path"),
        },
      },
      { status: 400 },
    );
  }
  let body: ArrayBuffer | undefined;
  let tooLarge: boolean;
  try {
    ({ body, tooLarge } = await readProxyBody(request));
  } catch (error) {
    if (request.signal.aborted) return clientClosedResponse();
    throw error;
  }
  if (tooLarge) {
    return NextResponse.json(
      {
        error: {
          code: "request_too_large",
          message: proxyErrorMessage("request_too_large"),
        },
      },
      { status: 413 },
    );
  }
  const timeoutMs = isWorkspaceExportDownload(proxyPath)
    ? EXPORT_PROXY_TIMEOUT_MS
    : isStreamPath(proxyPath) || isLongRunningApiPath(proxyPath)
      ? STREAM_PROXY_TIMEOUT_MS
      : JSON_PROXY_TIMEOUT_MS;
  const lifecycle = createProxyLifecycle(request.signal, timeoutMs);

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers: forwardHeaders(request, proxyPath),
      body,
      cache: "no-store",
      redirect: "manual",
      signal: lifecycle.signal,
    });
    const responseHeaders = responseHeadersFor(upstream.headers, proxyPath);
    const responseBody = upstream.body
      ? lifecycle.wrapBody(upstream.body)
      : null;
    if (!responseBody) lifecycle.dispose();
    return new Response(responseBody, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    await lifecycle.abort(err, "upstream");
    const abortKind = lifecycle.abortKind();
    if (abortKind === "request" || abortKind === "downstream") {
      return clientClosedResponse();
    }
    const timedOut = abortKind === "timeout";
    const code = timedOut ? "upstream_timeout" : "upstream_network_error";
    const requestId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : undefined;
    if (!isProduction) {
      console.warn(
        "[postwave/api-proxy] upstream failed:",
        sanitizeErrorForLog(err),
      );
    }
    return NextResponse.json(
      {
        error: {
          code,
          message: proxyErrorMessage(code),
          ...(requestId ? { request_id: requestId } : {}),
        },
      },
      {
        status: timedOut ? 504 : 502,
        headers: requestId ? { "x-request-id": requestId } : undefined,
      },
    );
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;

import type { RequestPlan } from "../components/playground/PlaygroundCodeGen";
import {
  NATIVE_CLIENT_HEADERS,
  getApiKey,
  nextClientEventSeq,
} from "../lib/api-client";
import { apiIdentityAwareNativeFetch } from "../lib/api-identity-native-fetch";
import { tauriApi } from "../lib/tauri";
import {
  CONTEXT_EPOCH_HEADER,
  observeContextEpoch,
} from "../lib/context-epoch";
import {
  type PlaygroundExecutionPolicy,
  isExactReviewedExecution,
} from "./api-playground-policy";
import {
  PLAYGROUND_HEADER_VALUE_MAX_BYTES,
  PLAYGROUND_QUERY_MAX_BYTES,
  PLAYGROUND_REQUEST_BODY_MAX_BYTES,
  PLAYGROUND_REQUEST_MAX_HEADER_BYTES,
  PLAYGROUND_REQUEST_MAX_HEADERS,
  unsafePlaygroundPathValue,
} from "./api-playground-request";

export const PLAYGROUND_CATALOG_MAX_BYTES = 8 * 1024 * 1024;
export const PLAYGROUND_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const PLAYGROUND_REQUEST_TIMEOUT_MS = 20_000;
export const PLAYGROUND_CATALOG_TIMEOUT_MS = 30_000;

export interface PlaygroundTransportResponse {
  status: number;
  statusText: string;
  body: string;
  headers: Record<string, string>;
  contentType: string;
  previewBytes: number;
  contentLength?: number;
  truncated: boolean;
  durationMs: number;
  outcome: "http" | "aborted" | "timeout" | "network" | "contract";
  ambiguous: boolean;
  requestId?: string;
}

interface LimitedText {
  text: string;
  bytes: number;
  truncated: boolean;
}

class PlaygroundCatalogTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaygroundCatalogTransportError";
  }
}

function normalizeBrowserKey(): string | null {
  const raw = (getApiKey() ?? "").trim();
  if (!raw) return null;
  return raw.startsWith("pw_") ? raw : `pw_${raw}`;
}

/**
 * Route44 must never review a cookie-session identity and then dispatch with
 * a different bearer identity. The self-info contract does not expose a
 * server-signed credential fingerprint, so coexistence cannot be proven safe
 * in the renderer and is deliberately blocked.
 */
export function playgroundHasApiCredentialFor(baseURL: string): boolean {
  if (normalizeBrowserKey()) return true;
  const status = tauriApi.apiBrokerStatus();
  if (!status.configured || !status.baseUrl) return false;
  try {
    const configured = new URL(status.baseUrl);
    const requested = new URL(baseURL);
    return (
      configured.origin === requested.origin &&
      configured.pathname.replace(/\/+$/u, "") ===
        requested.pathname.replace(/\/+$/u, "")
    );
  } catch {
    return false;
  }
}

export async function playgroundApiCredentialFingerprintSuffix(
  baseURL: string,
): Promise<string | null> {
  const browserKey = normalizeBrowserKey();
  if (browserKey) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(browserKey),
    );
    return Array.from(new Uint8Array(digest).slice(-4), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }
  const status = tauriApi.apiBrokerStatus();
  if (
    !status.credentialFingerprint ||
    !playgroundHasApiCredentialFor(baseURL)
  ) {
    return null;
  }
  return status.credentialFingerprint.slice(-8);
}

function abortBundle(
  callerSignal: AbortSignal | null,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let timeout = false;
  const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = window.setTimeout(() => {
    timeout = true;
    controller.abort("playground-timeout");
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    dispose: () => {
      window.clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

async function readTextLimited(
  response: Response,
  maxBytes: number,
): Promise<LimitedText> {
  if (!response.body) {
    const text = await response.text();
    const encoded = new TextEncoder().encode(text);
    if (encoded.byteLength <= maxBytes) {
      return { text, bytes: encoded.byteLength, truncated: false };
    }
    const bounded = encoded.slice(0, maxBytes);
    return {
      text: new TextDecoder().decode(bounded),
      bytes: bounded.byteLength,
      truncated: true,
    };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      text += decoder.decode();
      return { text, bytes, truncated: false };
    }
    const remaining = maxBytes - bytes;
    if (value.byteLength > remaining) {
      if (remaining > 0) {
        text += decoder.decode(value.slice(0, remaining), { stream: true });
        bytes += remaining;
      }
      await reader.cancel("playground-preview-limit").catch(() => undefined);
      text += decoder.decode();
      return { text, bytes, truncated: true };
    }
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
}

function authenticatedHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...NATIVE_CLIENT_HEADERS,
    ...extra,
  };
  const key = normalizeBrowserKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

function isJSONMediaType(value: string): boolean {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mediaType === "application/json" ||
    /^application\/[!#$%&'*+.^_`|~0-9a-z-]+\+json$/u.test(mediaType)
  );
}

function catalogURL(baseURL: string): string {
  let base: URL;
  try {
    base = new URL(baseURL);
  } catch {
    throw new PlaygroundCatalogTransportError(
      "Configured API authority is invalid.",
    );
  }
  if (
    (base.protocol !== "http:" && base.protocol !== "https:") ||
    base.username ||
    base.password
  ) {
    throw new PlaygroundCatalogTransportError(
      "Configured API authority is invalid.",
    );
  }
  const path =
    `${base.pathname.replace(/\/+$/, "")}/api/v1/openapi.json`.replace(
      /\/{2,}/g,
      "/",
    );
  const url = new URL(base.origin);
  url.pathname = path;
  return url.toString();
}

export async function loadPlaygroundCatalogDocument(
  baseURL: string,
  callerSignal: AbortSignal | null = null,
): Promise<unknown> {
  const abort = abortBundle(callerSignal, PLAYGROUND_CATALOG_TIMEOUT_MS);
  try {
    const response = await apiIdentityAwareNativeFetch(catalogURL(baseURL), {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      headers: authenticatedHeaders(),
      signal: abort.signal,
    });
    observeContextEpoch(response.headers.get(CONTEXT_EPOCH_HEADER));
    if (!response.ok) {
      throw new PlaygroundCatalogTransportError(
        `Catalog request failed with HTTP ${response.status}.`,
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!isJSONMediaType(contentType)) {
      throw new PlaygroundCatalogTransportError(
        `Catalog returned unsupported content type “${contentType || "unknown"}”.`,
      );
    }
    const declaredLength = contentLength(response);
    if (
      declaredLength !== undefined &&
      declaredLength > PLAYGROUND_CATALOG_MAX_BYTES
    ) {
      await response.body
        ?.cancel("playground-catalog-content-length-limit")
        .catch(() => undefined);
      throw new PlaygroundCatalogTransportError(
        `Catalog exceeds the ${PLAYGROUND_CATALOG_MAX_BYTES}-byte safety ceiling.`,
      );
    }
    const body = await readTextLimited(response, PLAYGROUND_CATALOG_MAX_BYTES);
    if (body.truncated) {
      throw new PlaygroundCatalogTransportError(
        `Catalog exceeds the ${PLAYGROUND_CATALOG_MAX_BYTES}-byte safety ceiling.`,
      );
    }
    try {
      return JSON.parse(body.text) as unknown;
    } catch {
      throw new PlaygroundCatalogTransportError(
        "Catalog response is not valid JSON.",
      );
    }
  } catch (error) {
    if (abort.timedOut()) {
      throw new PlaygroundCatalogTransportError("Catalog request timed out.");
    }
    if (callerSignal?.aborted) {
      throw new PlaygroundCatalogTransportError(
        "Catalog request was cancelled.",
      );
    }
    if (error instanceof PlaygroundCatalogTransportError) throw error;
    throw new PlaygroundCatalogTransportError(
      "Catalog request failed before a response completed. Native transport diagnostics are not rendered because they may contain private request details.",
    );
  } finally {
    abort.dispose();
  }
}

function transportContractError(
  plan: RequestPlan,
  baseURL: string,
  policy: PlaygroundExecutionPolicy,
): string | null {
  try {
    const target = new URL(plan.url);
    const base = new URL(baseURL);
    if (
      (target.protocol !== "http:" && target.protocol !== "https:") ||
      (base.protocol !== "http:" && base.protocol !== "https:") ||
      base.username ||
      base.password ||
      target.hash ||
      plan.snippetAllowed !== true ||
      plan.authMode !== policy.authMode
    ) {
      return "Reviewed request no longer matches the configured API authority.";
    }
    const basePath = base.pathname.replace(/\/+$/, "");
    const relativePath = basePath
      ? target.pathname.startsWith(`${basePath}/`)
        ? target.pathname.slice(basePath.length)
        : ""
      : target.pathname;
    if (
      target.origin !== base.origin ||
      target.username ||
      target.password ||
      !relativePath.startsWith("/api/")
    ) {
      return "Reviewed request no longer matches the configured API authority.";
    }
    if (/[\u0000-\u001f\\]/.test(target.pathname)) {
      return "Reviewed request contains an unsafe path.";
    }
    if (
      new TextEncoder().encode(target.search.slice(1)).byteLength >
      PLAYGROUND_QUERY_MAX_BYTES
    ) {
      return "Reviewed request exceeds the safe query boundary.";
    }
    if (
      new TextEncoder().encode(plan.body).byteLength >
      PLAYGROUND_REQUEST_BODY_MAX_BYTES
    ) {
      return "Reviewed request exceeds the safe body boundary.";
    }
    const allowedHeaders = new Set([
      "accept",
      "content-type",
      "idempotency-key",
      "if-match",
    ]);
    const seenHeaders = new Set<string>();
    for (const [name, value] of Object.entries(plan.headers)) {
      const normalized = name.trim().toLowerCase();
      if (
        name.length > 128 ||
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        !allowedHeaders.has(normalized) ||
        seenHeaders.has(normalized) ||
        /[\u0000-\u001f\u007f]/.test(value) ||
        new TextEncoder().encode(value).byteLength >
          PLAYGROUND_HEADER_VALUE_MAX_BYTES
      ) {
        return "Reviewed request headers no longer match the protected transport boundary.";
      }
      seenHeaders.add(normalized);
    }
    const dispatchHeaders = new Map(
      Object.entries(plan.headers).map(([name, value]) => [
        name.trim().toLowerCase(),
        value,
      ]),
    );
    if (!dispatchHeaders.has("accept")) {
      dispatchHeaders.set("accept", "application/json");
    }
    dispatchHeaders.set("x-request-id", "00000000-0000-4000-8000-000000000000");
    if (policy.effect !== "read") {
      dispatchHeaders.set(
        "x-postwave-event-seq",
        String(Number.MAX_SAFE_INTEGER),
      );
    }
    let aggregateBytes = 0;
    for (const [name, value] of dispatchHeaders) {
      aggregateBytes += new TextEncoder().encode(name).byteLength;
      aggregateBytes += new TextEncoder().encode(value).byteLength;
    }
    if (
      dispatchHeaders.size > PLAYGROUND_REQUEST_MAX_HEADERS ||
      aggregateBytes > PLAYGROUND_REQUEST_MAX_HEADER_BYTES
    ) {
      return "Reviewed request headers exceed the protected native transport boundary.";
    }
    if (
      !isExactReviewedExecution(policy) ||
      plan.method.toUpperCase() !== policy.method.toUpperCase()
    ) {
      return "Reviewed request no longer matches its approved operation.";
    }
    const targetSegments = relativePath.split("/");
    const templateSegments = policy.pathTemplate.split("/");
    if (
      targetSegments.length !== templateSegments.length ||
      templateSegments.some((templateSegment, index) => {
        const targetSegment = targetSegments[index] ?? "";
        if (/^\{[^{}]+\}$/.test(templateSegment)) {
          return (
            !targetSegment || unsafePlaygroundPathValue(targetSegment) !== null
          );
        }
        return targetSegment !== templateSegment;
      })
    ) {
      return "Reviewed request no longer matches its approved operation.";
    }
    return null;
  } catch {
    return "Reviewed request URL is invalid.";
  }
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

function contentLength(response: Response): number | undefined {
  const parsed = Number(response.headers.get("content-length"));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function declaredResponseMedia(
  policy: PlaygroundExecutionPolicy,
  status: number,
): readonly string[] | undefined {
  const range = `${Math.floor(status / 100)}XX`;
  return (
    policy.responseMediaTypesByStatus[String(status)] ??
    policy.responseMediaTypesByStatus[range] ??
    policy.responseMediaTypesByStatus[range.toLowerCase()] ??
    policy.responseMediaTypesByStatus.default
  );
}

function responseMediaMismatch(
  contentType: string,
  status: number,
  policy: PlaygroundExecutionPolicy,
  declaredLength: number | undefined,
): string | null {
  const declared = declaredResponseMedia(policy, status);
  if (!declared) {
    return `Response preview was withheld because status ${status} is not declared by this operation.`;
  }
  if (status === 204 || status === 205) return null;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (declared.length === 0) {
    return mediaType || (declaredLength !== undefined && declaredLength > 0)
      ? "Response preview was withheld because this status declares no response body media."
      : null;
  }
  if (
    !mediaType ||
    !declared.some(
      (item) => item.split(";", 1)[0]?.trim().toLowerCase() === mediaType,
    )
  ) {
    return `Response preview was withheld because the server returned ${mediaType || "an unknown media type"} instead of declared JSON media (${declared.join(", ")}).`;
  }
  return null;
}

function responseIsAmbiguous(
  policy: PlaygroundExecutionPolicy,
  status: number,
): boolean {
  return (
    policy.effect !== "read" &&
    (status === 408 || status === 429 || status >= 500)
  );
}

function responseContractIsAmbiguous(
  policy: PlaygroundExecutionPolicy,
): boolean {
  // A response proves that dispatch completed, but a malformed response cannot
  // prove whether a mutation committed. Keep reads retryable while requiring
  // state verification before another effectful or destructive attempt.
  return policy.effect !== "read";
}

export async function executePlaygroundRequest(
  baseURL: string,
  plan: RequestPlan,
  policy: PlaygroundExecutionPolicy,
  callerSignal: AbortSignal,
): Promise<PlaygroundTransportResponse> {
  const started = performance.now();
  const contractError = transportContractError(plan, baseURL, policy);
  if (contractError || !policy.executable) {
    return {
      status: 0,
      statusText: "Contract blocked",
      body: contractError ?? policy.reason ?? "Operation is reference-only.",
      headers: {},
      contentType: "text/plain",
      previewBytes: 0,
      truncated: false,
      durationMs: 0,
      outcome: "contract",
      ambiguous: false,
    };
  }
  const abort = abortBundle(callerSignal, PLAYGROUND_REQUEST_TIMEOUT_MS);
  const requestId = crypto.randomUUID();
  try {
    const headers = authenticatedHeaders({
      ...plan.headers,
      "X-Request-Id": requestId,
      ...(policy.effect === "read"
        ? {}
        : { "X-Postwave-Event-Seq": String(nextClientEventSeq()) }),
    });
    const response = await apiIdentityAwareNativeFetch(plan.url, {
      method: plan.method.toUpperCase(),
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      headers,
      body: plan.body || undefined,
      signal: abort.signal,
    });
    observeContextEpoch(response.headers.get(CONTEXT_EPOCH_HEADER));
    const responseContentType = response.headers.get("content-type") ?? "";
    const responseContentLength = contentLength(response);
    const mediaMismatch = responseMediaMismatch(
      responseContentType,
      response.status,
      policy,
      responseContentLength,
    );
    if (mediaMismatch) {
      await response.body
        ?.cancel("playground-response-media-mismatch")
        .catch(() => undefined);
      return {
        status: response.status,
        statusText: "Unexpected response media",
        body: mediaMismatch,
        headers: responseHeaders(response),
        contentType: responseContentType,
        previewBytes: 0,
        contentLength: responseContentLength,
        truncated: false,
        durationMs: Math.round(performance.now() - started),
        outcome: "contract",
        ambiguous: responseContractIsAmbiguous(policy),
        requestId,
      };
    }
    const body = await readTextLimited(response, PLAYGROUND_PREVIEW_MAX_BYTES);
    const durationMs = Math.round(performance.now() - started);
    const declaredMedia = declaredResponseMedia(policy, response.status);
    if (declaredMedia?.length === 0 && body.bytes > 0) {
      return {
        status: response.status,
        statusText: "Unexpected response body",
        body: "Response preview was withheld because this status declares no response body media.",
        headers: responseHeaders(response),
        contentType: responseContentType,
        previewBytes: 0,
        contentLength: responseContentLength,
        truncated: false,
        durationMs,
        outcome: "contract",
        ambiguous: responseContractIsAmbiguous(policy),
        requestId,
      };
    }
    if (
      !body.truncated &&
      response.status !== 204 &&
      response.status !== 205 &&
      isJSONMediaType(responseContentType)
    ) {
      try {
        JSON.parse(body.text);
      } catch {
        return {
          status: response.status,
          statusText: "Invalid JSON response",
          body: "Response preview was withheld because the server returned invalid JSON for a declared JSON response.",
          headers: responseHeaders(response),
          contentType: responseContentType,
          previewBytes: 0,
          contentLength: responseContentLength,
          truncated: false,
          durationMs,
          outcome: "contract",
          ambiguous: responseContractIsAmbiguous(policy),
          requestId,
        };
      }
    }
    return {
      status: response.status,
      statusText: response.statusText,
      body: body.text,
      headers: responseHeaders(response),
      contentType: responseContentType,
      previewBytes: body.bytes,
      contentLength: responseContentLength,
      truncated: body.truncated,
      durationMs,
      outcome: "http",
      ambiguous: responseIsAmbiguous(policy, response.status),
      requestId,
    };
  } catch {
    const durationMs = Math.round(performance.now() - started);
    const timedOut = abort.timedOut();
    const aborted = callerSignal.aborted && !timedOut;
    return {
      status: 0,
      statusText: timedOut
        ? "Timed out"
        : aborted
          ? "Cancelled"
          : "Network error",
      body: timedOut
        ? "The request exceeded the 20-second preview limit."
        : aborted
          ? "The request was cancelled before a response completed."
          : "The request failed before a response completed. Native transport diagnostics are not rendered because they may contain private request details.",
      headers: {},
      contentType: "text/plain",
      previewBytes: 0,
      truncated: false,
      durationMs,
      outcome: timedOut ? "timeout" : aborted ? "aborted" : "network",
      // Once an effectful request has entered the transport, a local cancel
      // cannot prove that the server did not commit it. Treat cancellation,
      // timeout, and network loss alike until a server response is observed.
      ambiguous: policy.effect !== "read",
      requestId,
    };
  } finally {
    abort.dispose();
  }
}

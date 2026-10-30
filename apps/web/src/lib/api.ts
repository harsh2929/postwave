// SPDX-License-Identifier: AGPL-3.0-only

import { CONTEXT_EPOCH_HEADER, observeContextEpoch } from "./context-epoch";
import { AUTH_SESSION_EXPIRED_EVENT } from "./auth-session-events";
import {
  OFFLINE_REPLAY_POLICY_CHANGED_MESSAGE,
  OUTBOX_MAX_ATTEMPTS,
  enqueueOfflineMutation,
  hasOfflineStorageIdentity,
  isOfflineCacheableGet,
  isQueueableMutation,
  queuedMutationAck,
  readCachedResponse,
  removeOfflineMutation,
  updateOfflineMutation,
  writeCachedResponse,
  type OfflineMutation,
} from "./offline-store";
import {
  denialGuidance,
  formatErrorMessage,
  isDenialReason,
  parseErrorEnvelope,
  type ApiDenial,
} from "@postwave/errors";

import pkg from "../../package.json";
import { httpFetch, isMutationMethod, newUUIDv7 } from "./http-fetch";
import {
  parseStepUpChallenge,
  requestStepUpProof,
  type StepUpChallenge,
} from "./step-up";
import {
  getOnlineStatus,
  noteRequestFailure,
  noteRequestSuccess,
} from "./online-manager";

export { AUTH_SESSION_EXPIRED_EVENT } from "./auth-session-events";

const IS_PRODUCTION = process.env.NODE_ENV === "production";

const API_ORIGIN =
  typeof window === "undefined"
    ? process.env.API_URL ||
      process.env.POSTWAVE_API_URL ||
      "http://localhost:8080"
    : "";
// Server components call the API origin directly, so they cannot rely on the
// browser-facing proxy to inject the local development tenant. Keep the
// server-only escape hatch server-only: browser requests may use only values
// that Next intentionally exposes with the NEXT_PUBLIC_ prefix.
const TENANT_SLUG = !IS_PRODUCTION
  ? typeof window === "undefined"
    ? process.env.POSTWAVE_TENANT_SLUG ||
      process.env.NEXT_PUBLIC_TENANT_SLUG ||
      process.env.NEXT_PUBLIC_POSTWAVE_TENANT_SLUG
    : process.env.NEXT_PUBLIC_TENANT_SLUG ||
      process.env.NEXT_PUBLIC_POSTWAVE_TENANT_SLUG
  : undefined;
const LOCAL_DEV_ROLE =
  !IS_PRODUCTION &&
  typeof window === "undefined" &&
  (process.env.POSTWAVE_LOCAL_AUTH_BYPASS === "1" ||
    process.env.POSTWAVE_AUTH_BYPASS === "1")
    ? "owner"
    : undefined;
// Client-version fabric (dim 10): identify this surface + its build so the
// gateway can enforce a min-version (X-Postwave-Client "web" is NOT in the
// CSRF native-client trust set, so it changes no auth behaviour — it only
// names the client for version enforcement + observability).
const CLIENT_NAME = "web";
const CLIENT_VERSION = (pkg as { version?: string }).version || "dev";
const REQUEST_TIMEOUT_MS = positiveIntEnv(
  "NEXT_PUBLIC_API_TIMEOUT_MS",
  15_000,
  1_000,
);
const MAX_API_RESPONSE_TEXT_BYTES = 2 * 1024 * 1024;

function positiveIntEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.floor(parsed);
}

export type ApiErrorKind =
  | "http"
  | "offline"
  | "timeout"
  | "aborted"
  | "network"
  | "parse";

/**
 * Turns a server denial into guidance the reader can act on.
 *
 * Keyed on the REASON the server sent, not on a code string or the status. That
 * distinction is the entire purpose of the denial vocabulary: "your plan does
 * not include this" and "your role does not permit this" need different
 * affordances, and a client holding only prose cannot tell them apart — which
 * is how a paywall gets shown to someone who needs an admin to change their
 * role.
 *
 * The implementation now lives in @postwave/errors, next to the parser that
 * already reads this envelope for web AND desktop. It was web-only, and that
 * was the whole gap: desktop rendered the server's sentence unchanged and
 * mobile branched on bare HTTP status, so the same refusal got three different
 * explanations. Re-exported (rather than moved) because this name is already a
 * web call-site contract.
 */
export { denialGuidance } from "@postwave/errors";

/** The loose half of `ApiError`'s details bag that can describe a refusal. */
interface DenialDetails {
  denial?: ApiDenial;
  code?: string;
  reason?: string;
  remedy?: string;
  requiredRole?: string;
  retryAfterSeconds?: number;
}

/**
 * The one place a refusal becomes an `ApiDenial`, for both the message and the
 * typed field — so the sentence the user reads and the class a screen branches
 * on can never be derived from different inputs.
 *
 * Prefers the PARSED denial. It was previously rebuilt from three loose fields
 * at every throw site, which silently dropped `subject`, `tier`, `resource`,
 * `limit` and `current` — so web's `denial` was a lossy subset of the object
 * desktop and mobile carry, while this file's own comment claimed the three
 * were interchangeable. A plan-ceiling screen could not show the numbers the
 * server had already sent it.
 *
 * `retryAfterSeconds` is merged rather than taken from the body alone: the
 * server mirrors it into the `Retry-After` header, a proxy can strip either
 * one, and the caller has already reconciled the pair. Desktop's
 * `errorFromResponse` does the same merge.
 */
function denialFromDetails(details: DenialDetails): ApiDenial | undefined {
  if (details.denial) {
    return details.retryAfterSeconds !== undefined &&
      details.denial.retryAfterSeconds === undefined
      ? { ...details.denial, retryAfterSeconds: details.retryAfterSeconds }
      : details.denial;
  }
  // The hand-built path: a call site (or a test) that names the class itself
  // rather than passing a parsed envelope. `isDenialReason` keeps an
  // unrecognised class from being presented as one this client understands.
  if (!isDenialReason(details.reason)) return undefined;
  return {
    reason: details.reason,
    ...(details.code ? { code: details.code } : {}),
    ...(details.remedy ? { remedy: details.remedy } : {}),
    ...(details.requiredRole ? { requiredRole: details.requiredRole } : {}),
    ...(details.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: details.retryAfterSeconds }
      : {}),
  };
}

export class ApiError extends Error {
  readonly code: string;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
  readonly method?: string;
  readonly path?: string;
  readonly kind: ApiErrorKind;
  /**
   * Set when the server asked for a fresh possession proof and the prompt did
   * not produce one (cancelled, nothing listening, or a second consecutive
   * challenge). Carried so a call site can say "you were not signed out" rather
   * than rendering a bare 401.
   */
  readonly stepUp?: StepUpChallenge;
  /**
   * The server's structured refusal, when this was one.
   *
   * The message already carries the guidance, but a screen that wants to render
   * an affordance — an upgrade link, "ask <role>", a countdown — needs the
   * CLASS, not a sentence to pattern-match. Desktop's `ApiErr.error.denial` and
   * mobile's `AIApiError.denial` carry the same object, so a branch written for
   * one surface means the same thing on the other two.
   */
  readonly denial?: ApiDenial;

  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
    details: {
      code?: string;
      // The parsed refusal, straight off `parseErrorEnvelope`. Preferred over
      // the three loose fields below because it is the WHOLE denial — subject,
      // tier, resource, limit, current included — and those are exactly what a
      // screen needs to render "4,980 of 5,000 contacts" instead of repeating
      // the sentence the message already carries.
      denial?: ApiDenial;
      // The server's own statement of what resolves the denial. Read rather
      // than inferred: see the constructor.
      remedy?: string;
      // The machine-readable denial CLASS (plan/role/flag/quota/policy/runtime).
      // The whole point of the vocabulary: "your plan does not include this" and
      // "your role does not permit this" need different affordances, and a
      // client with only a message string cannot tell them apart.
      reason?: string;
      // For a role denial, the role that WOULD be permitted. Turns "forbidden"
      // into something the reader can act on.
      requiredRole?: string;
      requestId?: string;
      retryAfterSeconds?: number;
      method?: string;
      path?: string;
      kind?: ApiErrorKind;
      // The unanswered step-up challenge this 401 carried, if any.
      stepUp?: StepUpChallenge;
    } = {},
  ) {
    super(
      // Keyed off the REMEDY the server asserted, not inferred from a code.
      //
      // This used to append "Upgrade your plan…" whenever the code was
      // `plan_limit_exceeded`. The server decides whether an upgrade resolves a
      // denial — it withholds the claim on the top tier, and for ceilings no
      // plan raises — and the client re-deriving it from a string meant the two
      // could disagree. They did: a `pro` tenant at a deliverability allowance
      // saw an upgrade prompt for a plan that does not exist, pointing at a
      // ceiling only a workspace admin can move.
      denialGuidance(message, denialFromDetails(details)),
    );
    this.name = "ApiError";
    this.code =
      details.code ?? (status > 0 ? `http_${status}` : "network_error");
    this.requestId = details.requestId;
    this.retryAfterSeconds = details.retryAfterSeconds;
    this.method = details.method;
    this.path = details.path;
    this.stepUp = details.stepUp;
    this.denial = denialFromDetails(details);
    this.kind =
      details.kind ??
      (status > 0
        ? "http"
        : this.code === "request_timeout"
          ? "timeout"
          : "network");
  }
}

export class OfflineQueuedError extends Error {
  readonly code = "offline_queued";

  constructor(public readonly queued: ReturnType<typeof queuedMutationAck>) {
    super("Saved offline. This change will sync when the connection returns.");
    this.name = "OfflineQueuedError";
  }
}

export function isOfflineQueuedError(err: unknown): err is OfflineQueuedError {
  return err instanceof OfflineQueuedError;
}

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  rawBody?: BodyInit;
  query?: Record<string, string | number | boolean | undefined>;
  /** Per-call timeout override (replaces the global REQUEST_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Override the retry attempt count (default 3). */
  maxAttempts?: number;
  /**
   * When true the caller refuses to be queued offline — the request
   * either runs online or fails fast with an offline error. Used for
   * send-now / billing / privacy surfaces (feature 10).
   */
  requireOnline?: boolean;
  /**
   * Override automatic mutation idempotency. `null` is reserved for reviewed
   * read-only or reveal-once/non-replayable POSTs; it also refuses offline
   * mutation queue admission.
   */
  idempotencyKey?: string | null;
  /** Observe response headers without bypassing the shared parser/retry shell. */
  onResponse?: (response: Response) => void;
  /**
   * Whether a successful step-up proof may transparently repeat this request.
   * Set false for reviewed one-attempt operations whose outcome contract
   * forbids every automatic replay, including the retry outside httpFetch.
   */
  allowStepUpRetry?: boolean;
};

let replayInFlight = false;

/**
 * Carried across a step-up retry. Never part of `RequestOptions`: a call site
 * has no business setting either field, and the whole point of the retry guard
 * is that only `request` itself can say a request has already been retried.
 */
interface StepUpRetryState {
  /**
   * The idempotency key the FIRST attempt sent. Reused verbatim so the retry is
   * the same write, not a second one — a mutation that reached the server and
   * was refused at the gate is indistinguishable, from here, from one that was
   * applied, and re-minting would let a step-up prompt double a charge.
   */
  idempotencyKey?: string;
  /** True once this request has already been retried after a proof. */
  retried?: boolean;
}

/**
 * Whether this request can be sent a second time byte-for-byte.
 *
 * `body` is re-serialised from the same value, and every `rawBody` shape web
 * actually uses (string, Blob, FormData, URLSearchParams, ArrayBuffer) can be
 * re-read. A ReadableStream cannot: it is consumed by the first attempt, so a
 * retry would send an empty body and turn a prompt into silent data loss.
 */
function isReplayableBody(rawBody: BodyInit | undefined): boolean {
  if (rawBody === undefined) return true;
  return !(
    typeof ReadableStream !== "undefined" && rawBody instanceof ReadableStream
  );
}

async function forwardedServerHeaders(): Promise<Record<string, string>> {
  if (typeof window !== "undefined") return {};
  try {
    const { headers } = await import("next/headers");
    const incoming = await headers();
    const out: Record<string, string> = {};
    const cookie = incoming.get("cookie");
    const authorization = incoming.get("authorization");
    if (cookie) out.cookie = cookie;
    if (authorization) out.authorization = authorization;
    return out;
  } catch {
    return {};
  }
}

/**
 * The fetch cache mode for a request whose caller did not choose one.
 *
 * Server: opt out of Next's Data Cache. Authenticated responses are per-user
 * and per-tenant, so caching them by URL is a cross-tenant leak waiting to
 * happen. But only as a DEFAULT: a caller that passed `next: { revalidate }`
 * has explicitly asked for caching on a public read, and forcing `no-store`
 * alongside it both ignores the request and puts two conflicting cache
 * directives on the same fetch.
 *
 * Browser: a read revalidates with the server every time ("no-cache"). The
 * query client owns read reuse — staleTime, and the invalidation that follows
 * every write — and its refetch exists to get the server's current answer.
 * Left to the default mode, the browser answered that refetch from its HTTP
 * cache whenever a response had carried any freshness, so a page showed its
 * pre-write data straight after its own write, and a stale ETag taken from
 * that answer earned the next If-Match save a 412. "no-cache" still sends the
 * stored validator, so an unchanged read costs a 304, not a body.
 */
function defaultCacheMode(
  method: string,
  options: RequestOptions,
): { cache?: RequestCache } {
  if (options.cache !== undefined) return {};
  if (typeof window === "undefined") {
    return (options as { next?: unknown }).next === undefined
      ? { cache: "no-store" }
      : {};
  }
  return method === "GET" || method === "HEAD" ? { cache: "no-cache" } : {};
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const rawPath = String(path || "");
  if (rawPath.trim() !== rawPath || /[\r\n]/.test(rawPath)) {
    throw new Error("Unsafe API path");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath) || rawPath.startsWith("//")) {
    throw new Error("Unsafe API path");
  }
  const pathOnly = rawPath.split(/[?#]/, 1)[0] ?? "";
  if (
    pathOnly.split("/").some((segment) => {
      const lower = segment.toLowerCase();
      return (
        segment === "." ||
        segment === ".." ||
        lower === "%2e" ||
        lower === "%2e." ||
        lower === ".%2e" ||
        lower === "%2e%2e"
      );
    })
  ) {
    throw new Error("Unsafe API path");
  }
  const base = API_ORIGIN
    ? API_ORIGIN.endsWith("/")
      ? API_ORIGIN
      : `${API_ORIGIN}/`
    : "http://postwave.local/";
  const url = new URL(rawPath.replace(/^\/+/, ""), base);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  if (!API_ORIGIN) {
    return `${url.pathname}${url.search}`;
  }
  return url.toString();
}

async function request<T>(
  method: string,
  path: string,
  opts: RequestOptions = {},
  stepUpRetry: StepUpRetryState = {},
): Promise<T> {
  const {
    body,
    rawBody,
    query,
    headers,
    timeoutMs,
    maxAttempts,
    requireOnline,
    idempotencyKey,
    onResponse,
    allowStepUpRetry = true,
    ...rest
  } = opts;
  if (body !== undefined && rawBody !== undefined) {
    throw new Error("api.request: pass either body or rawBody, not both");
  }
  const cachePath = buildUrl(path, query);
  // Mint a UUIDv7 idempotency key up front for mutations so an offline enqueue
  // and any future replay reuse the same key. Reviewed read-only and
  // reveal-once/non-replayable POSTs opt out; a step-up retry otherwise reuses
  // the original key.
  const mintedIdempotencyKey =
    isMutationMethod(method) && idempotencyKey !== null
      ? (stepUpRetry.idempotencyKey ?? idempotencyKey ?? newUUIDv7())
      : undefined;
  const refusesOfflineQueue = requireOnline === true || idempotencyKey === null;
  const browserIsOffline =
    typeof window !== "undefined" &&
    ((typeof navigator !== "undefined" && navigator.onLine === false) ||
      getOnlineStatus() === "offline");
  if (browserIsOffline) {
    if (method === "GET" && isOfflineCacheableGet(cachePath)) {
      const cached = readCachedResponse<T>(cachePath);
      if (cached !== null) return cached;
    }
    if (
      !refusesOfflineQueue &&
      hasOfflineStorageIdentity() &&
      (method !== "PATCH" || hasIfMatchHeader(headers)) &&
      isQueueableMutation(method, path, body)
    ) {
      const queued = enqueueOfflineMutation({
        method,
        path,
        query,
        body,
        headers,
        idempotencyKey: mintedIdempotencyKey,
      });
      throw new OfflineQueuedError(queuedMutationAck(queued));
    }
    throw new ApiError("You appear to be offline", 0, undefined, {
      code: "offline",
      kind: "offline",
      method,
      path,
    });
  }
  if (typeof window !== "undefined") {
    void flushQueuedMutations();
  }
  const omitCredentials = rest.credentials === "omit";
  const serverHeaders = omitCredentials ? {} : await forwardedServerHeaders();
  const init: RequestInit = {
    method,
    headers: {
      Accept: "application/json",
      "X-Postwave-Client": CLIENT_NAME,
      "X-Postwave-Version": CLIENT_VERSION,
      ...serverHeaders,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(TENANT_SLUG ? { "X-Tenant-Slug": TENANT_SLUG } : {}),
      ...(LOCAL_DEV_ROLE ? { "X-Postwave-Role": LOCAL_DEV_ROLE } : {}),
      ...(mintedIdempotencyKey
        ? { "Idempotency-Key": mintedIdempotencyKey }
        : {}),
      ...headers,
    },
    ...(rawBody !== undefined
      ? { body: rawBody }
      : body !== undefined
        ? { body: JSON.stringify(body) }
        : {}),
    ...(rest.credentials === undefined ? { credentials: "include" } : {}),
    ...defaultCacheMode(method, rest),
    ...rest,
  };
  if (idempotencyKey === null) {
    const withoutIdempotency = new Headers(init.headers);
    withoutIdempotency.delete("Idempotency-Key");
    init.headers = withoutIdempotency;
  }

  const { res, err, timedOut } = await httpFetch(cachePath, init, {
    timeoutMs: timeoutMs ?? REQUEST_TIMEOUT_MS,
    maxAttempts,
    signal: rest.signal ?? null,
  });

  if (!res) {
    const aborted = err instanceof Error && err.name === "AbortError";
    if (typeof window !== "undefined" && !aborted) {
      noteRequestFailure();
    }
    if (
      typeof window !== "undefined" &&
      !aborted &&
      !refusesOfflineQueue &&
      hasOfflineStorageIdentity() &&
      (method !== "PATCH" || hasIfMatchHeader(headers)) &&
      isQueueableMutation(method, path, body)
    ) {
      const queued = enqueueOfflineMutation({
        method,
        path,
        query,
        body,
        headers,
        idempotencyKey: mintedIdempotencyKey,
      });
      throw new OfflineQueuedError(queuedMutationAck(queued));
    }
    throw new ApiError(
      timedOut
        ? "Request timed out. Check your connection and try again."
        : aborted
          ? "Request was cancelled"
          : err instanceof Error && err.message
            ? err.message
            : "Network request failed",
      0,
      err,
      {
        code: timedOut
          ? "request_timeout"
          : aborted
            ? "request_aborted"
            : "network_error",
        kind: timedOut ? "timeout" : aborted ? "aborted" : "network",
        method,
        path,
      },
    );
  }
  if (typeof window !== "undefined") {
    // Any HTTP response proves the transport is reachable; a 4xx/5xx may be
    // an application failure, but it must not flip the app into offline mode.
    noteRequestSuccess();
  }
  onResponse?.(res);
  // Record the context this response was computed under, before anything reads
  // the body. Placed on the ONE path every JSON API call goes through, so an
  // epoch change cannot be missed by whichever endpoint happens to notice it
  // first. Anonymous responses carry no header and are ignored by design.
  observeContextEpoch(res.headers.get(CONTEXT_EPOCH_HEADER));
  const text = await readTextLimited(res, MAX_API_RESPONSE_TEXT_BYTES);
  const parsed: unknown = text ? safeJson(text) : undefined;

  if (!res.ok) {
    const env = parseApiErrorBody(parsed);
    // A step-up challenge is a live session asking a question, not a dead one.
    // Resolved BEFORE the session-expired branch below, because that branch
    // clears the query cache, wipes offline storage and redirects to /login —
    // the exact "treated it as a dead session and logged the user out" outcome
    // the server's own header exists to prevent.
    const challenge = parseStepUpChallenge(res.status, res.headers, parsed);
    if (challenge) {
      // Exactly one retry, and only for a request that can be re-sent
      // unchanged. Bounded on purpose: a proof that does not actually refresh
      // the server's freshness clock (a clock skew, a session rotated
      // mid-prompt) would otherwise prompt, retry, prompt, retry forever, and
      // an unbounded loop asking for authenticator codes is indistinguishable
      // from an attack on the person using it.
      if (!stepUpRetry.retried && isReplayableBody(rawBody)) {
        const proved = await requestStepUpProof(challenge);
        if (proved && allowStepUpRetry) {
          return request<T>(method, path, opts, {
            idempotencyKey: mintedIdempotencyKey,
            retried: true,
          });
        }
      }
      throw new ApiError(
        env.message ||
          `${method} ${path} failed: ${res.status} ${res.statusText}`,
        res.status,
        parsed,
        {
          code: env.code,
          requestId: res.headers.get("x-request-id") ?? env.requestId,
          method,
          path,
          stepUp: challenge,
        },
      );
    }
    if (
      res.status === 401 &&
      !isFailedReauthAttempt(env.code) &&
      typeof window !== "undefined" &&
      (window.location.pathname === "/app" ||
        window.location.pathname.startsWith("/app/"))
    ) {
      window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT));
    }
    throw new ApiError(
      env.message ||
        `${method} ${path} failed: ${res.status} ${res.statusText}`,
      res.status,
      parsed,
      {
        code: env.code,
        denial: env.denial,
        requestId: res.headers.get("x-request-id") ?? env.requestId,
        retryAfterSeconds: parseRetryAfter(
          res.headers.get("retry-after"),
          env.retryAfterSeconds,
        ),
        method,
        path,
      },
    );
  }
  if (method === "GET" && isOfflineCacheableGet(cachePath)) {
    writeCachedResponse(cachePath, parsed);
  }
  return parsed as T;
}

// A 401 that means "that code was wrong", not "your session is gone".
//
// Every 401 on an /app path used to dispatch AUTH_SESSION_EXPIRED_EVENT, which
// clears the query cache, wipes offline storage and redirects to /login. That
// is right for a dead session and exactly wrong for a re-authentication attempt:
// the TOTP endpoints answer a failed possession proof with 401 too, so mistyping
// one digit of a six-digit code logged the user out of the workspace they were
// proving they still owned.
//
// It bites hardest where it is least acceptable — the step-up prompt exists to
// avoid logging someone out mid-action, and this turned its most likely path
// (a wrong code, first try) back into a logout. It also affected TOTP enrolment,
// which shares this transport.
//
// Keyed on the CODE rather than the path, deliberately. `/totp/verify` also
// returns 401 `no_session` when the session really has died, and that must still
// log out — a path-based exemption would swallow it and leave the user typing
// codes at a session that no longer exists.
// Exactly the codes the server emits, checked against
// internal/auth/totp_handlers.go rather than guessed. `no_session` is
// deliberately absent: it is the one 401 from these endpoints that DOES mean the
// session is gone.
const FAILED_REAUTH_CODES = new Set([
  "invalid_code",
  "missing_code",
  "not_enrolled",
]);

function isFailedReauthAttempt(code: string | undefined): boolean {
  return typeof code === "string" && FAILED_REAUTH_CODES.has(code);
}

function hasIfMatchHeader(headers?: HeadersInit): boolean {
  if (!headers) return false;
  const value = new Headers(headers).get("if-match");
  return typeof value === "string" && value.trim().length > 0;
}

export async function flushQueuedMutations(): Promise<{
  replayed: number;
  conflicts: number;
  failed: number;
}> {
  if (replayInFlight || typeof window === "undefined") {
    return { replayed: 0, conflicts: 0, failed: 0 };
  }
  if (
    (typeof navigator !== "undefined" && navigator.onLine === false) ||
    getOnlineStatus() === "offline"
  ) {
    return { replayed: 0, conflicts: 0, failed: 0 };
  }
  replayInFlight = true;
  try {
    // Loaded on demand. The outbox is mutation-replay machinery: it can only
    // matter once a session has queued something. Importing it at module scope
    // put IndexedDB queue + dead-letter code into the initial chunk of every
    // page that touches the API client, including /login, where there is no
    // session and nothing that could ever have been queued.
    const { drainOutbox, moveToDeadLetter } = await import("./outbox");
    // Per-resource FIFO via outbox: items in different buckets replay
    // concurrently, items within a bucket replay serially so conflicts
    // can't reorder later edits to the same resource.
    const summary = await drainOutbox(async (item) => {
      if (!isQueueableMutation(item.method, item.path, item.body)) {
        updateOfflineMutation(item.id, {
          status: "failed",
          body: undefined,
          headers: undefined,
          lastError: OFFLINE_REPLAY_POLICY_CHANGED_MESSAGE,
        });
        return "failed";
      }
      // Honor a server Retry-After captured on a prior 429: don't replay
      // (or even hit the network for) an item still inside its backoff
      // window. Returning "failed" parks the bucket this drain; the item
      // stays `pending`, so the next drain after the window replays it.
      if (item.retryableAt && item.retryableAt > Date.now()) {
        return "failed";
      }
      const nextAttempts = item.attempts + 1;
      updateOfflineMutation(item.id, {
        status: "replaying",
        attempts: nextAttempts,
      });
      try {
        const res = await replayMutation(item);
        if (res.status === 409 || res.status === 412) {
          updateOfflineMutation(item.id, {
            status: "conflict",
            conflictStatus: res.status,
            lastError: `Server reported a write conflict (${res.status}).`,
          });
          return "conflict";
        }
        if (res.status === 401 || res.status === 403) {
          // Authentication state is not an item failure. Park the bucket
          // without consuming retry budget; a post-login request will drain it.
          updateOfflineMutation(item.id, {
            status: "pending",
            attempts: item.attempts,
            lastError: "Sign in again to sync this queued change.",
          });
          return "failed";
        }
        if (res.status === 429) {
          // Rate limiting isn't the item's fault — roll back the attempt
          // we speculatively counted so a burst of 429s can't dead-letter
          // a valid mutation, and record the server's Retry-After backoff.
          const waitS = parseRetryAfter(res.headers.get("retry-after"));
          const retryableAt =
            typeof waitS === "number" && waitS > 0
              ? Date.now() + waitS * 1000
              : null;
          // Keep status `pending` (not `failed`) and roll back the attempt
          // so a rate-limit burst can't dead-letter a valid mutation; the
          // retryableAt guard above resumes it in order once the window
          // passes. Returning "failed" parks the bucket for this drain.
          updateOfflineMutation(item.id, {
            status: "pending",
            attempts: item.attempts,
            ...(retryableAt ? { retryableAt } : {}),
            lastError: waitS
              ? `Rate limited; retry after ~${waitS}s.`
              : "Rate limited; will retry.",
          });
          return "failed";
        }
        if (!res.ok) {
          const msg = `Replay failed with HTTP ${res.status}.`;
          if (nextAttempts >= OUTBOX_MAX_ATTEMPTS) {
            moveToDeadLetter(item.id, msg);
          } else {
            updateOfflineMutation(item.id, {
              status: "failed",
              lastError: msg,
            });
          }
          return "failed";
        }
        removeOfflineMutation(item.id);
        return "replayed";
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Replay failed.";
        if (nextAttempts >= OUTBOX_MAX_ATTEMPTS) {
          moveToDeadLetter(item.id, msg);
        } else {
          updateOfflineMutation(item.id, { status: "failed", lastError: msg });
        }
        return "failed";
      }
    });
    return {
      replayed: summary.replayed,
      conflicts: summary.conflicts,
      failed: summary.failed,
    };
  } finally {
    replayInFlight = false;
  }
}

async function replayMutation(item: OfflineMutation): Promise<Response> {
  const serverHeaders = await forwardedServerHeaders();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(buildUrl(item.path, item.query), {
      method: item.method,
      headers: {
        Accept: "application/json",
        ...serverHeaders,
        ...(item.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...(TENANT_SLUG ? { "X-Tenant-Slug": TENANT_SLUG } : {}),
        ...(LOCAL_DEV_ROLE ? { "X-Postwave-Role": LOCAL_DEV_ROLE } : {}),
        ...(item.headers ?? {}),
        "Idempotency-Key": item.idempotencyKey,
        ...(item.baseVersion ? { "If-Match": item.baseVersion } : {}),
      },
      ...(item.body !== undefined ? { body: JSON.stringify(item.body) } : {}),
      credentials: "include",
      cache: "no-store",
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readTextLimited(
  res: Response,
  maxBytes: number,
): Promise<string> {
  const contentLength = Number(res.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ApiError(
      "API response was too large to process",
      res.status,
      undefined,
      {
        code: "response_too_large",
        kind: "parse",
      },
    );
  }
  if (!res.body) {
    const read = res.text.bind(res);
    const text = await read();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new ApiError(
        "API response was too large to process",
        res.status,
        undefined,
        {
          code: "response_too_large",
          kind: "parse",
        },
      );
    }
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ApiError(
        "API response was too large to process",
        res.status,
        undefined,
        {
          code: "response_too_large",
          kind: "parse",
        },
      );
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

function parseApiErrorBody(body: unknown): {
  code?: string;
  /**
   * The server's structured refusal, whole. Carried as one object rather than
   * as the remedy/reason/requiredRole triple it used to be flattened into:
   * that triple dropped `subject`, `tier`, `resource`, `limit` and `current`
   * on the floor between the parser and `ApiError`, which is precisely the
   * numeric context a plan-ceiling screen needs and had no other way to get.
   */
  denial?: ApiDenial;
  message?: string;
  requestId?: string;
  retryAfterSeconds?: number;
} {
  // A plain string body is the message, truncated so a giant text body can't
  // become a giant error message (web's long-standing cap). Everything else
  // goes through the one shared envelope parser (@postwave/errors) — its
  // superset covers this surface's former nested/flat/`{error:"string"}` cases.
  if (typeof body === "string") {
    return body ? { message: body.slice(0, 300) } : {};
  }
  const e = parseErrorEnvelope(body);
  return {
    code: e.code,
    // The parser's typed `denial`, not hand-picked keys out of the untyped
    // `details` bag: the bag version quietly accepted any string as a reason,
    // while `denial` is only populated for a value inside the closed
    // vocabulary, which is what every branch downstream assumes.
    denial: e.denial,
    message: e.message,
    requestId: e.requestId,
    retryAfterSeconds: e.retryAfterSeconds,
  };
}

export function parseRetryAfter(
  headerValue: string | null,
  bodyValue?: number,
): number | undefined {
  if (typeof bodyValue === "number" && bodyValue > 0) return bodyValue;
  if (!headerValue) return undefined;
  const numeric = Number(headerValue);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  const asDate = Date.parse(headerValue);
  if (!Number.isNaN(asDate)) {
    const seconds = Math.ceil((asDate - Date.now()) / 1000);
    if (seconds > 0) return seconds;
  }
  return undefined;
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export function apiErrorMessage(
  err: unknown,
  fallback = "Something went wrong",
): string {
  if (err instanceof ApiError) {
    // Shared render (@postwave/errors) — same `${message||fallback} (request
    // <id>)` shape, one source across web + desktop.
    return formatErrorMessage(err.message, err.requestId, fallback);
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export const api = {
  head: <T = unknown>(path: string, opts?: RequestOptions) =>
    request<T>("HEAD", path, opts),
  get: <T = unknown>(path: string, opts?: RequestOptions) =>
    request<T>("GET", path, opts),
  post: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>("POST", path, { ...opts, body }),
  postRaw: <T = unknown>(
    path: string,
    rawBody: BodyInit,
    opts?: RequestOptions,
  ) => request<T>("POST", path, { ...opts, rawBody }),
  put: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>("PUT", path, { ...opts, body }),
  putRaw: <T = unknown>(
    path: string,
    rawBody: BodyInit,
    opts?: RequestOptions,
  ) => request<T>("PUT", path, { ...opts, rawBody }),
  patch: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>("PATCH", path, { ...opts, body }),
  delete: <T = unknown>(path: string, opts?: RequestOptions) =>
    request<T>("DELETE", path, opts),
};

/**
 * Fetches a non-JSON (e.g. text/csv) authed endpoint and returns the body as
 * text. Reuses the same credential + tenant-header conventions as `request`
 * so cookie-authed CSV exports stream correctly; a bare anchor download can't
 * attach the X-Tenant-Slug header. Throws ApiError on non-2xx.
 */
export interface FetchTextAuthedOptions {
  signal?: AbortSignal;
  /** Inspect status/headers while retaining the shared authenticated transport. */
  onResponse?: (response: Response) => void;
  /** Reviewed response ceiling; defaults to the shared 2 MiB JSON limit. */
  maxBytes?: number;
}

export async function fetchTextAuthed(
  path: string,
  options: FetchTextAuthedOptions = {},
): Promise<string> {
  return fetchTextAuthedOnce(path, false, options);
}

/**
 * `stepUpRetried` is the same one-shot guard `request` uses. This path needs it
 * independently because it does not go through `request` at all — and
 * `GET /api/v1/subscribers/export.csv` is BOTH the route web downloads this way
 * and one of the seven the server's step-up policy protects. Detection wired
 * only into the JSON path would have left the highest-stakes action in the
 * table — taking every subscriber's address out of the building — as the one
 * that still logged the user out.
 */
async function fetchTextAuthedOnce(
  path: string,
  stepUpRetried: boolean,
  options: FetchTextAuthedOptions,
): Promise<string> {
  const maxBytes = options.maxBytes ?? MAX_API_RESPONSE_TEXT_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > 64 * 1024 * 1024
  ) {
    throw new Error(
      "fetchTextAuthed: maxBytes must be between 1 byte and 64 MiB",
    );
  }
  const url = buildUrl(path);
  const serverHeaders = await forwardedServerHeaders();
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "text/csv, text/plain, */*",
      "X-Postwave-Client": CLIENT_NAME,
      "X-Postwave-Version": CLIENT_VERSION,
      ...serverHeaders,
      ...(TENANT_SLUG ? { "X-Tenant-Slug": TENANT_SLUG } : {}),
      ...(LOCAL_DEV_ROLE ? { "X-Postwave-Role": LOCAL_DEV_ROLE } : {}),
    },
    credentials: "include",
    cache: "no-store",
    signal: options.signal,
  });
  options.onResponse?.(res);
  const text = await readTextLimited(res, maxBytes);
  if (!res.ok) {
    const parsed = text ? safeJson(text) : undefined;
    const env = parseApiErrorBody(parsed);
    const challenge = parseStepUpChallenge(res.status, res.headers, parsed);
    if (challenge) {
      // A GET with no body is trivially replayable, so the only guard needed is
      // the one-shot.
      if (!stepUpRetried && (await requestStepUpProof(challenge))) {
        return fetchTextAuthedOnce(path, true, options);
      }
      throw new ApiError(
        env.message || `GET ${path} failed: ${res.status} ${res.statusText}`,
        res.status,
        undefined,
        {
          code: env.code,
          requestId: res.headers.get("x-request-id") ?? env.requestId,
          method: "GET",
          path,
          stepUp: challenge,
        },
      );
    }
    throw new ApiError(
      env.message || `GET ${path} failed: ${res.status} ${res.statusText}`,
      res.status,
      undefined,
      {
        code: env.code,
        denial: env.denial,
        requestId: res.headers.get("x-request-id") ?? env.requestId,
        // This path never passed it, so a quota refusal here arrived without
        // the one number that makes waiting actionable — on the route that
        // exports every subscriber, which is exactly the kind the server meters.
        retryAfterSeconds: parseRetryAfter(
          res.headers.get("retry-after"),
          env.retryAfterSeconds,
        ),
        method: "GET",
        path,
      },
    );
  }
  return text;
}

/**
 * Fetches an authed endpoint whose body is BINARY and returns it whole.
 *
 * Separate from `fetchTextAuthed` because decoding a `.tar.gz` (or any other
 * archive) as UTF-8 text silently corrupts it: the replacement character is
 * substituted for every invalid sequence, so the bytes that come back are not
 * the bytes the server signed. An evidence bundle that fails its own offline
 * verifier is worse than no bundle at all, so this path never touches a
 * TextDecoder on the success branch.
 */
export interface FetchBlobAuthedOptions {
  signal?: AbortSignal;
  /** Sent as `Accept`; defaults to a permissive octet-stream preference. */
  accept?: string;
  /** Reviewed response ceiling in bytes. Defaults to 32 MiB. */
  maxBytes?: number;
}

export interface AuthedBlobDownload {
  blob: Blob;
  /**
   * The `filename` the server named in `Content-Disposition`, sanitised, or
   * null when it named none. Null is an answer the caller must handle (pick
   * its own name) rather than a failure.
   */
  filename: string | null;
}

const MAX_API_BLOB_BYTES = 32 * 1024 * 1024;
/** Error bodies are JSON envelopes; cap the read so a huge one can't be held. */
const MAX_API_BLOB_ERROR_BYTES = 64 * 1024;

/**
 * The `filename` from a `Content-Disposition` header, made safe to hand to an
 * anchor's `download` attribute.
 *
 * The value is server-authored but still untrusted here: a path separator or a
 * control character in it would be written straight into the filesystem name
 * the browser proposes. Directory traversal is stripped rather than rejected,
 * so a server that adds a prefix later degrades to a plain name instead of
 * failing the download.
 */
export function contentDispositionFilename(
  header: string | null,
): string | null {
  if (!header) return null;
  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/iu.exec(header)?.[1];
  const quoted = /filename\s*=\s*"([^"]*)"/iu.exec(header)?.[1];
  const bare = /filename\s*=\s*([^;"\s]+)/iu.exec(header)?.[1];
  let raw = quoted ?? bare ?? null;
  if (extended) {
    try {
      raw = decodeURIComponent(extended);
    } catch {
      // Malformed percent-encoding: fall back to the plain parameter.
    }
  }
  if (!raw) return null;
  const cleaned = raw
    // Control characters are exactly what must not reach a filename.
    .replaceAll(/[\u0000-\u001F\u007F]/gu, "")
    .replaceAll("\\", "/")
    .split("/")
    .pop()
    ?.trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  return cleaned.slice(0, 180);
}

export async function fetchBlobAuthed(
  path: string,
  options: FetchBlobAuthedOptions = {},
): Promise<AuthedBlobDownload> {
  return fetchBlobAuthedOnce(path, false, options);
}

/** `stepUpRetried` is the same one-shot guard `request`/`fetchTextAuthed` use. */
async function fetchBlobAuthedOnce(
  path: string,
  stepUpRetried: boolean,
  options: FetchBlobAuthedOptions,
): Promise<AuthedBlobDownload> {
  const maxBytes = options.maxBytes ?? MAX_API_BLOB_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > 64 * 1024 * 1024
  ) {
    throw new Error(
      "fetchBlobAuthed: maxBytes must be between 1 byte and 64 MiB",
    );
  }
  const url = buildUrl(path);
  const serverHeaders = await forwardedServerHeaders();
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: options.accept ?? "application/octet-stream, */*",
      "X-Postwave-Client": CLIENT_NAME,
      "X-Postwave-Version": CLIENT_VERSION,
      ...serverHeaders,
      ...(TENANT_SLUG ? { "X-Tenant-Slug": TENANT_SLUG } : {}),
      ...(LOCAL_DEV_ROLE ? { "X-Postwave-Role": LOCAL_DEV_ROLE } : {}),
    },
    credentials: "include",
    cache: "no-store",
    signal: options.signal,
  });
  if (!res.ok) {
    const text = await readTextLimited(res, MAX_API_BLOB_ERROR_BYTES).catch(
      () => "",
    );
    const parsed = text ? safeJson(text) : undefined;
    const env = parseApiErrorBody(parsed);
    const challenge = parseStepUpChallenge(res.status, res.headers, parsed);
    if (challenge) {
      if (!stepUpRetried && (await requestStepUpProof(challenge))) {
        return fetchBlobAuthedOnce(path, true, options);
      }
      throw new ApiError(
        env.message || `GET ${path} failed: ${res.status} ${res.statusText}`,
        res.status,
        undefined,
        {
          code: env.code,
          requestId: res.headers.get("x-request-id") ?? env.requestId,
          method: "GET",
          path,
          stepUp: challenge,
        },
      );
    }
    throw new ApiError(
      env.message || `GET ${path} failed: ${res.status} ${res.statusText}`,
      res.status,
      undefined,
      {
        code: env.code,
        denial: env.denial,
        requestId: res.headers.get("x-request-id") ?? env.requestId,
        retryAfterSeconds: parseRetryAfter(
          res.headers.get("retry-after"),
          env.retryAfterSeconds,
        ),
        method: "GET",
        path,
      },
    );
  }
  const declared = Number(res.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError(
      "API response was too large to download",
      res.status,
      undefined,
      { code: "response_too_large", kind: "parse", method: "GET", path },
    );
  }
  const blob = await res.blob();
  // Re-checked after the read: Content-Length can be absent (chunked) or a lie.
  if (blob.size > maxBytes) {
    throw new ApiError(
      "API response was too large to download",
      res.status,
      undefined,
      { code: "response_too_large", kind: "parse", method: "GET", path },
    );
  }
  return {
    blob,
    filename: contentDispositionFilename(
      res.headers.get("content-disposition"),
    ),
  };
}

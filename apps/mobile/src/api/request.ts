import { parseErrorEnvelope } from "@postwave/errors";
import type {
  PostwaveClient,
  PostwaveResponseMetadata,
  RequestOptions,
} from "@postwave/sdk";
import {
  capabilityEnvelopeFromError,
  type CapabilityEnvelope,
} from "@/lib/capabilityEnvelope";
import { denialFromError, type ApiDenial } from "@/lib/denialEnvelope";

import { ApiRequestError } from "./apiRequestError";
import { getClient } from "./sdkClient";

/**
 * Common error envelope so the UI can branch on status without needing
 * to import the SDK error hierarchy. `requestId` mirrors the server's
 * `x-request-id` / body `request_id` (the SDK's PostwaveError already carries
 * it) so mobile can surface it in support/error UI like web and desktop do —
 * previously mobile dropped it (Apple-level integration dim 7 fold).
 */
export type AIApiError = {
  status: number;
  message: string;
  requestId?: string;
  /**
   * The server's machine-readable error code from the `{error:{code,message}}`
   * envelope, carried by the SDK's PostwaveError as `.code`.
   *
   * This used to be dropped at the mobile boundary, which forced every screen
   * to branch on bare HTTP status — so two semantically different failures
   * with the same status collapsed into one wrong message. Concretely: a 403
   * from `/agency/children` is `not_agency` (this tenant has no sub-accounts)
   * OR `not_authorized` (your token lost the scope), and mobile told the
   * second user their agency does not exist.
   */
  code?: string;
  /**
   * The backend's machine-readable "this capability is intentionally off"
   * envelope (apps/api/internal/runtimecapability). A 503 carrying these is a
   * PRODUCT BOUNDARY, not a fault: `retryable` is false by contract and a
   * Retry button on it can never work.
   *
   * Screens branch on `isCapabilityUnavailable` (lib/capabilityEnvelope)
   * rather than extending a 404/405/501 literal list, because "your
   * deployment does not have this" and "your deployment has it and it is
   * switched off" are different sentences to a user.
   */
  capability?: string;
  runtimeStatus?: string;
  retryable?: boolean;
  /**
   * The server's structured refusal (apps/api/internal/entitlement), when this
   * failure was one.
   *
   * `reason` is a closed vocabulary — plan / role / flag / quota / policy /
   * runtime — and the six need six different answers. Mobile dropped it here
   * and branched on bare HTTP status instead, so `role`, `flag` and `policy`
   * all arrived as one 403 with one sentence ("Ask a workspace administrator
   * if you need it"), which is right for exactly one of the three; and a 402
   * plan ceiling fell past every arm into "Something went wrong loading this."
   *
   * Web's `ApiError.denial` and desktop's `ApiErr.error.denial` carry the same
   * object, so a branch written on one surface means the same thing here.
   */
  denial?: ApiDenial;
  /**
   * The DECODED RESPONSE BODY of the failing request, when the SDK captured
   * one (`PostwaveError.payload`).
   *
   * Almost every caller wants `message`/`code` and nothing else — but a
   * handful of endpoints answer a non-2xx whose body IS the result rather than
   * an error envelope, and for those, discarding the body discards the answer.
   * `POST /api/v1/flow-builder/validate` is the clear case: it returns 422 with
   * the full `GraphValidateResponse` precisely when the graph has errors, so a
   * client that only reads the status can report every outcome EXCEPT the one
   * worth reporting.
   *
   * Untyped on purpose. A caller that wants it must parse it, exactly like any
   * other response body.
   */
  payload?: unknown;
  /**
   * Per-field validation errors from a 422, as `{path, message}`.
   *
   * These were DROPPED at this boundary. The SDK already types them on
   * ValidationError and the shared parser (@postwave/errors) recovers them
   * from any envelope, and mobile read neither -- so a form that failed on one
   * field could only say "Something went wrong" while web and desktop
   * highlighted the field. This was the HIGH item in the ecosystem
   * blueprint's dim-7 fold: "mobile silently drops validation-fields".
   */
  fields?: Array<{ path: string; message: string }>;
  /**
   * Seconds the server asked us to wait before retrying (429/503). Typed on
   * the SDK's RateLimitError from the Retry-After header; otherwise read from
   * the body by the shared parser. Without it a Retry button appears with no
   * idea whether "try in a second" or "try tomorrow" is the truth.
   */
  retryAfterSeconds?: number;
  /**
   * Server-supplied context beyond the framing fields (e.g. a `fire_id` beside
   * a `{error:{code,message}}` frame), lifted by the shared parser. It is what
   * lets a screen prove an error belongs to the request it just made.
   */
  details?: Record<string, unknown>;
  /** From a 421: the tenant's region and the host that actually serves it. */
  region?: string;
  correctEndpoint?: string;
  /** Exact, allow-listed response proof retained by the SDK transport. */
  responseMetadata?: PostwaveResponseMetadata;
};
export type AIApiResult<T> =
  | { data: T; error: null }
  | { data: null; error: AIApiError };

/**
 * Pull a numeric status off a thrown error. The SDK raises PostwaveError
 * subclasses with a `.status` property; generic errors map to 0.
 */
export function statusFromError(err: unknown): number {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return 0;
}

export function messageFromError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Pull the server request id off a thrown error. The SDK's PostwaveError
 * exposes it as `.requestId`; returns undefined for non-SDK errors.
 */
export function requestIdFromError(err: unknown): string | undefined {
  if (err && typeof err === "object" && "requestId" in err) {
    const id = (err as { requestId?: unknown }).requestId;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

/**
 * Pull the server's machine-readable error code off a thrown error. The
 * SDK's PostwaveError exposes it as `.code`; returns undefined for
 * non-SDK errors and for the empty-string code the SDK uses when the
 * server sent no envelope (an empty code carries no information and
 * would defeat `code === "x"` guards by looking present).
 */
export function codeFromError(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) return code;
  }
  return undefined;
}

/**
 * Pull the decoded response body off a thrown error. The SDK's PostwaveError
 * carries it as `.payload`; returns undefined for non-SDK errors and for an
 * error the SDK raised with no body to attach.
 */
export function payloadFromError(err: unknown): unknown {
  if (err && typeof err === "object" && "payload" in err) {
    return (err as { payload?: unknown }).payload;
  }
  return undefined;
}

function responseMetadataFromError(
  err: unknown,
): PostwaveResponseMetadata | undefined {
  if (!err || typeof err !== "object" || !("responseMetadata" in err)) {
    return undefined;
  }
  const metadata = (err as { responseMetadata?: unknown }).responseMetadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const outcome = (metadata as { sendingCapOutcome?: unknown })
    .sendingCapOutcome;
  return outcome === "not-committed" ||
    outcome === "committed" ||
    outcome === "committed-conservatively-fenced" ||
    outcome === "commit-outcome-unknown-conservatively-fenced"
    ? { sendingCapOutcome: outcome }
    : undefined;
}

/**
 * Run the thrown error's decoded body through the ONE shared envelope parser.
 *
 * Web (`lib/api.ts`) and desktop (`lib/api-client.ts`) both normalise through
 * `parseErrorEnvelope`; mobile hand-rolled its own reads off PostwaveError and
 * so recovered a strict subset -- no `fields`, no `retryAfterSeconds`, no
 * `details`. Three parsers for one wire shape is the drift the ecosystem
 * blueprint names; this is the third surface adopting the first.
 *
 * The SDK's TYPED properties (ValidationError.fields, RateLimitError
 * .retryAfterSeconds, WrongRegionError.region) are preferred when present,
 * because the SDK derived some of them from response HEADERS the body cannot
 * carry (Retry-After). The parser fills whatever the SDK did not type.
 */
function sharedEnvelopeFromError(err: unknown) {
  const payload = payloadFromError(err);
  const env = payload === undefined ? {} : parseErrorEnvelope(payload);
  const typed = (err ?? {}) as {
    fields?: unknown;
    retryAfterSeconds?: unknown;
    region?: unknown;
    correctEndpoint?: unknown;
  };
  const fields =
    Array.isArray(typed.fields) && typed.fields.length
      ? (typed.fields as Array<{ path: string; message: string }>)
      : env.fields;
  const retryAfterSeconds =
    typeof typed.retryAfterSeconds === "number"
      ? typed.retryAfterSeconds
      : env.retryAfterSeconds;
  const region =
    typeof typed.region === "string" && typed.region
      ? typed.region
      : env.region;
  const correctEndpoint =
    typeof typed.correctEndpoint === "string" && typed.correctEndpoint
      ? typed.correctEndpoint
      : env.correctEndpoint;
  return {
    ...(fields ? { fields } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...(env.details ? { details: env.details } : {}),
    ...(region ? { region } : {}),
    ...(correctEndpoint ? { correctEndpoint } : {}),
  } satisfies Partial<AIApiError>;
}

/**
 * Run one SDK call and wrap success/failure in the mobile result envelope.
 *
 * GOVERNANCE#57: this is the seam that lets an api module reach the SDK's
 * TYPED resources (`client.scim.listTokens()`) instead of hand-writing the
 * verb and path, while every screen keeps branching on `res.error.status` /
 * `.code` exactly as before. `rawRequest` is now just this function with the
 * low-level `client.request` as its call — so both paths map errors
 * identically and cannot drift.
 */
export async function sdkResult<T>(
  call: () => Promise<T>,
): Promise<AIApiResult<T>> {
  try {
    return { data: await call(), error: null };
  } catch (err) {
    const requestId = requestIdFromError(err);
    const code = codeFromError(err);
    const capability = capabilityEnvelopeFromError(err);
    const denial = denialFromError(err);
    const payload = payloadFromError(err);
    const responseMetadata = responseMetadataFromError(err);
    return {
      data: null,
      error: {
        status: statusFromError(err),
        message: messageFromError(err),
        // Only include when present — mobile's tsconfig uses
        // exactOptionalPropertyTypes, so an explicit `undefined` is a type error.
        ...(requestId ? { requestId } : {}),
        ...(code ? { code } : {}),
        ...(denial ? { denial } : {}),
        ...(payload !== undefined ? { payload } : {}),
        ...(responseMetadata ? { responseMetadata } : {}),
        ...capabilityFields(capability),
        ...sharedEnvelopeFromError(err),
      },
    };
  }
}

/**
 * Call a TYPED SDK resource and wrap the outcome in the mobile envelope.
 *
 * `sdkResult(() => getClient().client.x.y())` is the same thing written out,
 * and several api modules do exactly that. This exists because an api module
 * that reaches for `getClient` itself pulls `./sdkClient` — and therefore
 * `react-native` — into its own import graph, and mobile's vitest runs in a
 * NODE environment: the moment that happens, no `.test.ts` can import the
 * module at all, and every unit test of its request-shaping logic disappears.
 *
 * Going through this seam keeps `./request` the ONLY impure import an api
 * module needs, which is precisely the seam a test already mocks. That is not a
 * hypothetical: src/api/sequences.test.ts pins the If-Match header and the
 * fail-closed version guard, and it can only do so while api/sequences.ts
 * imports nothing that reaches react-native.
 */
export async function sdkResource<T>(
  call: (client: PostwaveClient) => Promise<T>,
): Promise<AIApiResult<T>> {
  return sdkResult<T>(() => call(getClient().client));
}

/**
 * Route a verb + path (+ optional body) through the SDK's low-level
 * request() method and wrap success/failure in the mobile result envelope.
 *
 * Prefer `sdkResult(() => client.<resource>.<method>())` when the SDK ships a
 * typed resource for the endpoint; this stays for the routes it does not
 * (and for one-off paths built at runtime).
 */
export async function rawRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  requestOptions?: Pick<
    RequestOptions,
    "idempotencyKey" | "headers" | "signal" | "onResponseHeaders"
  >,
): Promise<AIApiResult<T>> {
  return sdkResult<T>(() => {
    const { client } = getClient();
    const options: RequestOptions = {};
    if (body !== undefined) options.body = body;
    if (requestOptions?.idempotencyKey !== undefined) {
      options.idempotencyKey = requestOptions.idempotencyKey;
    }
    if (requestOptions?.headers !== undefined) {
      options.headers = requestOptions.headers;
    }
    if (requestOptions?.signal !== undefined) {
      options.signal = requestOptions.signal;
    }
    if (requestOptions?.onResponseHeaders !== undefined) {
      options.onResponseHeaders = requestOptions.onResponseHeaders;
    }
    return client.request<T>(method, path, options);
  });
}

/** Spread-ready capability fields; empty when the body carried no envelope. */
function capabilityFields(
  envelope: CapabilityEnvelope | null,
): Partial<Pick<AIApiError, "capability" | "runtimeStatus" | "retryable">> {
  if (!envelope) return {};
  return {
    capability: envelope.capability,
    runtimeStatus: envelope.runtimeStatus,
    retryable: envelope.retryable,
  };
}

/**
 * Convert the mobile result envelope into a rejecting mutation promise.
 *
 * The rejection is an ApiRequestError, which re-tags the envelope's fields by
 * the rules in api/apiRequestError.ts. The api modules' own error classes
 * extend it, so a query's error state and a mutation's `onError` see the same
 * fields.
 */
export async function checkedApiResult<T>(
  promise: Promise<AIApiResult<T>>,
): Promise<AIApiResult<T>> {
  const result = await promise;
  if (result.error) throw new ApiRequestError(result.error);
  return result;
}

/**
 * Transport result shared by domain API modules.
 *
 * A queued write is deliberately a different union member from a server
 * success. In particular it has no `data` property: an outbox id must never be
 * cast to a Form, Tag, Campaign, or any other domain entity. Consumers either
 * render the durable receipt or handle the server entity after replay.
 *
 * Keep this module free of imports so domain clients can depend on the result
 * contract without importing the large API facade or creating cycles. The one
 * exception below is TYPE-only and therefore erased at build time.
 */

import type { ApiDenial } from "@postwave/errors";

export type SendingCapOutcome =
  | "not-committed"
  | "committed"
  | "committed-conservatively-fenced"
  | "commit-outcome-unknown-conservatively-fenced";

/** Narrow response proof retained only for sending-cap control mutations. */
export interface ApiResponseMetadata {
  status: number;
  sendingCapOutcome: SendingCapOutcome;
}

export type QueueReceiptState =
  | "pending"
  | "replaying"
  | "conflict"
  | "failed"
  | "dead-letter";

export interface QueueReceipt {
  /** Stable local journal id. This is not a server/domain id. */
  queueId: string;
  queuedAt: string;
  state: QueueReceiptState;
  resource: string;
  /** Human-readable journal copy, e.g. “Update campaign draft”. */
  action: string;
  /** Human-readable target, never a raw request path. */
  record: string;
}

export interface ApiOk<T> {
  data: T;
  error?: never;
  queued?: never;
  receipt?: never;
  /** ETag or server resource-version header when one was supplied. */
  serverVersion?: string;
  /** Exact response Location header when the server identifies a new resource. */
  responseLocation?: string;
  /** Exact status/header proof for a sending-cap control-plane response. */
  responseMetadata?: ApiResponseMetadata;
}

export interface ApiQueued<TOptimistic = never> {
  queued: true;
  receipt: QueueReceipt;
  /**
   * Optional caller-authored optimistic entity. The transport never invents
   * this value and never casts a receipt into T.
   */
  optimisticEntity?: TOptimistic;
  data?: never;
  error?: never;
  serverVersion?: never;
  responseLocation?: never;
  responseMetadata?: never;
}

export type ApiRetryability =
  | "automatic"
  | "after-reconnect"
  | "manual"
  | "not-retryable";

export interface ApiErr {
  data?: never;
  queued?: never;
  receipt?: never;
  serverVersion?: never;
  responseLocation?: never;
  /** Exact status/header proof for a sending-cap control-plane response. */
  responseMetadata?: ApiResponseMetadata;
  error: {
    message: string;
    status?: number;
    code?: string;
    requestId?: string;
    retryAfterSeconds?: number;
    kind?: "http" | "network" | "timeout" | "parse" | "invalid_config";
    details?: Record<string, unknown>;
    /**
     * The server's structured refusal (`apps/api/internal/entitlement`), when
     * this was one.
     *
     * Desktop already lifted `reason` / `remedy` / `required_role` into the
     * untyped `details` bag and then ignored them: every refusal reached the
     * user as the server's sentence and nothing else, so a role denial, a
     * paywall and a policy block — three refusals with three different
     * remedies — rendered identically. `message` now carries the guidance and
     * this carries the CLASS, for a screen that wants to render an affordance
     * rather than pattern-match prose.
     */
    denial?: ApiDenial;
  };
  /** How the UI should offer recovery for this specific failure. */
  retryability?: ApiRetryability;
  /**
   * Mutation input retained in this in-memory result so the form can stay
   * populated when queue admission or transport fails. It is never logged.
   */
  preservedDraft?: unknown;
}

/** Results for operations that are guaranteed to talk to the server. */
export type ApiResult<T> = ApiOk<T> | ApiErr;

/** Results for the small, explicitly reviewed offline-write allowlist. */
export type QueueableApiResult<T, TOptimistic = never> =
  | ApiResult<T>
  | ApiQueued<TOptimistic>;

export function queuedResult<TOptimistic = never>(
  receipt: QueueReceipt,
  optimisticEntity?: TOptimistic,
): ApiQueued<TOptimistic> {
  return {
    queued: true,
    receipt,
    ...(optimisticEntity === undefined ? {} : { optimisticEntity }),
  };
}

export function queueReceiptMessage(receipt: QueueReceipt): string {
  return `${receipt.action} saved on this device · pending sync`;
}

/** Internal transport controls available to domain method factories. */
export interface ApiRequesterOptions {
  /** Override the per-call timeout. */
  timeoutMs?: number;
  /** Override the retry attempt count. */
  maxAttempts?: number;
  /** Refuse offline queue admission and require a live request. */
  requireOnline?: boolean;
  /** Caller-supplied cancellation signal. */
  signal?: AbortSignal;
  /** Observe final response headers for endpoint-specific provenance checks. */
  onResponseHeaders?: (headers: Headers) => void;
  /**
   * Override automatic mutation idempotency. `null` is the reviewed opt-out
   * for endpoint contracts that forbid the header and require non-replayable
   * one-attempt transport; it also makes the request ineligible for offline
   * mutation queueing.
   */
  idempotencyKey?: string | null;
}

/** Minimal transport dependency injected into domain method factories. */
export type ApiRequester = <T>(
  path: string,
  init?: RequestInit,
  options?: ApiRequesterOptions,
) => Promise<ApiResult<T>>;

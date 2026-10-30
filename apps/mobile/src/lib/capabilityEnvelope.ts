/**
 * lib/capabilityEnvelope.ts — the "this capability is intentionally off"
 * contract, parsed.
 *
 * The backend has a dedicated writer for execution paths that are deliberately
 * fail-closed while their control plane stays up
 * (apps/api/internal/runtimecapability/runtimecapability.go). It emits:
 *
 *   HTTP 503
 *   X-Postwave-Capability-Status: unavailable
 *   {"error":{"code":…,"message":…,"capability":…,
 *             "runtime_status":"unavailable","retryable":false}}
 *
 * Its whole point is that a client can "stop retrying and render an honest
 * unavailable state without learning infrastructure details". Mobile modelled
 * none of it: `AIApiError` carried `{status, message, requestId, code}`, so
 * every automation screen had to hardcode a 404/405/501 literal list and
 * treated this 503 as a retryable fault — the exact opposite of the contract.
 * `flowbuilder` emits it from five call sites and `zerocopy_triggers` from
 * four, so any flows or warehouse-trigger surface hits it immediately.
 *
 * Parsed from the response BODY. The SDK's `PostwaveError` carries the decoded
 * payload but not the response headers, so `X-Postwave-Capability-Status` is
 * not reachable from here; `runtime_status` in the body is the same signal and
 * is what this reads.
 *
 * Import-free so the parser is unit-testable in the node environment.
 */

export interface CapabilityEnvelope {
  /** Capability name, e.g. "flow_runtime". Generic by contract — never a
   *  config value or internal error text. */
  capability: string;
  /** Server's runtime status; "unavailable" is the only value it emits. */
  runtimeStatus: string;
  /** Always false on this envelope: retrying cannot change the answer. */
  retryable: boolean;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Read the capability fields off a decoded error body. Returns null unless the
 * body actually carries the envelope — an ordinary `{error:{code,message}}`
 * must not be mistaken for an intentional product boundary.
 */
export function parseCapabilityEnvelope(
  payload: unknown,
): CapabilityEnvelope | null {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const capability = nonEmptyString(record.capability);
  const runtimeStatus = nonEmptyString(record.runtime_status);
  // BOTH are required. `capability` alone could be any envelope field a future
  // handler adds; the pair is what runtimecapability.WriteUnavailable emits.
  if (!capability || !runtimeStatus) return null;
  return {
    capability,
    runtimeStatus,
    retryable: record.retryable === true,
  };
}

/** Pull the SDK error's decoded body (`PostwaveError.payload`). */
export function capabilityEnvelopeFromError(
  err: unknown,
): CapabilityEnvelope | null {
  if (!err || typeof err !== "object" || !("payload" in err)) return null;
  return parseCapabilityEnvelope((err as { payload?: unknown }).payload);
}

/** The shape any mobile error envelope needs to answer the question. */
export interface CapabilityAwareError {
  status?: number;
  capability?: string | undefined;
  runtimeStatus?: string | undefined;
  retryable?: boolean | undefined;
}

/**
 * True when the server said "this capability is deliberately off", as opposed
 * to "something broke".
 *
 * Screens should branch on this INSTEAD of extending a 404/405/501 literal
 * list: the two mean different things to a user (a 404 is "your deployment
 * doesn't have this"; this is "your deployment has it and it is switched off
 * on purpose"), and only one of them should hide a Retry button.
 */
export function isCapabilityUnavailable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as CapabilityAwareError;
  return (
    e.status === 503 &&
    Boolean(e.capability) &&
    e.runtimeStatus === "unavailable"
  );
}

/**
 * Sentence for a capability-unavailable answer. Uses the server's message when
 * it sent one — those strings are static product-contract data and are safe to
 * show verbatim (runtimecapability.go's own comment says so) — and falls back
 * to naming the capability rather than inventing a reason.
 */
export function capabilityUnavailableMessage(
  envelope: CapabilityEnvelope,
  serverMessage?: string | undefined,
): string {
  const message = serverMessage?.trim();
  if (message) return message;
  return `${envelope.capability} is switched off in this deployment. Nothing to retry.`;
}

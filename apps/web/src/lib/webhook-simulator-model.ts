// SPDX-License-Identifier: AGPL-3.0-only
/**
 * lib/webhook-simulator-model.ts — the pure decisions behind the webhook
 * simulator page. Port of desktop's pages/webhook-simulator-model.ts.
 *
 * The one decision that matters most is `classifyFireFailure`: whether a
 * failed fire PROVABLY never reached the receiver (safe to start a new logical
 * fire) or might have (the fire stays fenced for reconciliation). A 4xx
 * refusal — the rate limit's 429 included — is proof of non-dispatch. A
 * transport failure, a timeout, a cancelled wait, or a 5xx is not: the API may
 * have crossed the receiver boundary before its receipt reached the browser.
 */
import { apiErrorMessage, isApiError } from "@/lib/api";
import {
  MAX_SIMULATOR_PAYLOAD_BYTES,
  type PlaygroundFireReceipt,
  type PlaygroundFireRequest,
  type SimulatorTarget,
} from "@/lib/developer-reference-api";
import { newUUIDv7 } from "@/lib/http-fetch";

const textEncoder = new TextEncoder();

export function simulatorPayloadBytes(payload: string): number {
  return textEncoder.encode(payload).byteLength;
}

/** Mint ONE logical fire. Its identity is retained through every retry. */
export function mintSimulatorFire(
  target: Pick<SimulatorTarget, "id" | "config_version">,
  eventType: string,
  payloadJSON: string,
): PlaygroundFireRequest {
  const fireId = newUUIDv7();
  return {
    fireId,
    idempotencyKey: `webhook-playground:${fireId}`,
    webhookId: target.id,
    expectedWebhookConfigVersion: target.config_version ?? 0,
    eventType,
    payloadJSON,
  };
}

export type SimulatorPayloadValidation =
  | { ok: true; error: null }
  | { ok: false; error: string };

export function validateSimulatorPayload(
  payload: string,
): SimulatorPayloadValidation {
  if (simulatorPayloadBytes(payload) > MAX_SIMULATOR_PAYLOAD_BYTES) {
    return {
      ok: false,
      error: "Reduce the payload to 262,144 UTF-8 bytes or fewer before firing.",
    };
  }
  if (!payload.trim()) {
    return { ok: false, error: "Enter a JSON object before firing." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    return {
      ok: false,
      error: `Payload isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: "The payload must be a JSON object (the event's data), not an array or a bare value.",
    };
  }
  return { ok: true, error: null };
}

/** Why this destination cannot take a fire right now, or null when it can. */
export function webhookFireReadinessReason(
  target: SimulatorTarget | undefined,
): string | null {
  if (!target) return "Add an outbound webhook before firing an event.";
  if (!target.active) return "Resume this paused webhook before firing.";
  if (target.url_status !== "ready") {
    return "Repair the destination URL before firing.";
  }
  if (target.auth_config_status !== "ready") {
    return "Finish securing receiver authentication before firing.";
  }
  if (target.delivery_policy_status !== "ready") {
    return "Repair the delivery filter or transform before firing.";
  }
  if (target.config_version === null || target.config_version < 1) {
    return "This destination did not report its configuration revision. Refresh the targets before firing.";
  }
  return null;
}

export function signingAlgorithmLabel(algorithm: string): string {
  switch (algorithm) {
    case "ecdsa_p256":
      return "ECDSA P-256";
    case "ed25519":
      return "Ed25519";
    default:
      return "HMAC-SHA256";
  }
}

/**
 * The catalog serves `{ note: "no sample payload registered for …" }` for an
 * event with no representative sample. That body is not what a handler
 * receives, so the page must say so instead of implying it is.
 */
export function isPlaceholderSample(payload: Record<string, unknown>): boolean {
  const note = payload.note;
  return (
    typeof note === "string" && note.startsWith("no sample payload registered")
  );
}

export type FireFailureClass =
  /** 410 proven for THIS identity: consumed server-side, receipt gone. */
  | { kind: "receipt_expired"; message: string }
  /** 409 outcome pending: reserved, no terminal receiver outcome yet. */
  | { kind: "pending"; message: string }
  /** The receiver may or may not have been contacted. */
  | { kind: "ambiguous"; message: string; cancelled: boolean }
  /** Refused before dispatch — including the 429 rate limit. */
  | { kind: "not_dispatched"; message: string; code: string };

export function classifyFireFailure(
  error: unknown,
  fireId: string,
): FireFailureClass {
  const message = apiErrorMessage(
    error,
    "The signed test delivery failed before a response was received.",
  );
  if (!isApiError(error)) {
    return { kind: "ambiguous", message, cancelled: false };
  }
  if (error.kind === "aborted") {
    return { kind: "ambiguous", message, cancelled: true };
  }
  if (error.kind === "offline") {
    // requireOnline refused the request before anything was sent.
    return { kind: "not_dispatched", message, code: error.code };
  }
  if (
    error.kind === "network" ||
    error.kind === "timeout" ||
    error.kind === "parse"
  ) {
    return { kind: "ambiguous", message, cancelled: false };
  }
  if (error.code === "playground_fire_receipt_expired") {
    const body =
      error.body && typeof error.body === "object"
        ? (error.body as Record<string, unknown>)
        : {};
    return error.status === 410 &&
      body.fire_id === fireId &&
      body.state === "receipt_expired"
      ? { kind: "receipt_expired", message }
      : { kind: "ambiguous", message, cancelled: false };
  }
  if (error.code === "playground_fire_outcome_pending") {
    return { kind: "pending", message };
  }
  if (error.status === 0 || error.status === 408 || error.status >= 500) {
    return { kind: "ambiguous", message, cancelled: false };
  }
  return { kind: "not_dispatched", message, code: error.code };
}

/** A receipt is only evidence about the fire it names. */
export function receiptMatchesFire(
  receipt: PlaygroundFireReceipt,
  request: PlaygroundFireRequest,
): boolean {
  return (
    receipt.fire_id === request.fireId &&
    receipt.webhook_id === request.webhookId &&
    receipt.event_type === request.eventType
  );
}

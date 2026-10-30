import type { RecentFire } from "../components/webhook-simulator/RecentFiresPanel";
import { sanitizeInspectableUrl } from "../components/webhook-simulator/ResponseInspector";
import type {
  OutboundWebhook,
  WebhookPlaygroundFireReceipt,
} from "../lib/api-client";
import { validateWebhookPlaygroundRawJSONObject } from "../lib/api/webhook-playground-contract";
import { newUUIDv7 } from "../lib/http-fetch";
import type {
  WebhookPlaygroundFireRecoveryAuthority,
  WebhookPlaygroundFireRecoveryHoldReason,
  WebhookPlaygroundFireSnapshot,
} from "../lib/webhook-playground-fire-recovery";
import {
  MAX_SIMULATOR_PAYLOAD_BYTES,
  type EventCatalogEntry,
  type FireSnapshot,
  type PayloadReplacement,
  simulatorPayloadBytes,
} from "./webhook-simulator-surface";

export type FireRecoveryGate =
  | { status: "loading"; authorityKey: string }
  | { status: "ready"; authorityKey: string }
  | {
      status: "held";
      authorityKey: string;
      reason: WebhookPlaygroundFireRecoveryHoldReason;
    };

export interface SimulatorFireError {
  message: string;
  status?: number;
  code?: string;
  kind?: "http" | "network" | "timeout" | "parse" | "invalid_config";
  details?: Record<string, unknown>;
}

export type SimulatorFireDisposition =
  | "identity_consumed"
  | "resolved"
  | "unresolved"
  | "not_dispatched"
  | "not_started";

export function fireErrorProvesExpiredIdentity(
  error: SimulatorFireError,
  expectedFireID: string,
): boolean {
  return (
    error.status === 410 &&
    error.code === "playground_fire_receipt_expired" &&
    error.details?.fire_id === expectedFireID &&
    error.details.state === "receipt_expired"
  );
}

export function fireErrorClaimsExpiredIdentity(
  error: SimulatorFireError,
): boolean {
  return (
    error.status === 410 && error.code === "playground_fire_receipt_expired"
  );
}

export function fireErrorHasAmbiguousDispatch(
  error: SimulatorFireError,
): boolean {
  if (error.kind === "invalid_config") return false;
  if (error.code === "playground_fire_outcome_pending") return true;
  if (
    error.kind === "network" ||
    error.kind === "timeout" ||
    error.kind === "parse"
  ) {
    return true;
  }
  // A proxy/server 5xx can be emitted after the API crossed the receiver
  // boundary but before its encrypted receipt reached this client. Keep the
  // logical fire fenced until its caller-known identity is reconciled.
  return (
    error.status === undefined || error.status === 408 || error.status >= 500
  );
}

export function catalogEventType(
  events: EventCatalogEntry[],
  candidate: string,
  fallback: string,
): string {
  return events.some((event) => event.event_type === candidate)
    ? candidate
    : fallback;
}

export function savedPayloadReplacement(
  payload: string,
  requestedEventType: string,
  events: EventCatalogEntry[],
  currentEventType: string,
): PayloadReplacement {
  return {
    source: "Saved payload",
    payload,
    eventType: catalogEventType(events, requestedEventType, currentEventType),
  };
}

export function recentFireReplacement(
  fire: RecentFire,
  events: EventCatalogEntry[],
  currentEventType: string,
  webhooks: OutboundWebhook[],
): PayloadReplacement {
  return {
    source: "Recent fire",
    payload: fire.payload,
    eventType: catalogEventType(events, fire.event_type, currentEventType),
    ...(webhooks.some((webhook) => webhook.id === fire.webhook_id)
      ? { webhookID: fire.webhook_id }
      : {}),
  };
}

export function eventSampleReplacement(
  events: EventCatalogEntry[],
  eventType: string,
): PayloadReplacement | null {
  const entry = events.find((item) => item.event_type === eventType);
  if (!entry) return null;
  return {
    source: `${eventType} sample`,
    eventType,
    payload: JSON.stringify(entry.sample_payload, null, 2),
  };
}

export function simulatorFireSnapshot(
  webhook: OutboundWebhook,
  eventType: string,
  payload: string,
): FireSnapshot {
  const fireID = newUUIDv7();
  return {
    fireID,
    idempotencyKey: `webhook-playground:${fireID}`,
    webhookID: webhook.id,
    webhookConfigVersion: webhook.config_version,
    webhookURL: sanitizeInspectableUrl(webhook.url).url,
    eventType,
    payload,
  };
}

export const SIMULATOR_TARGET_PAGE_SIZE = 200;

/**
 * D12-comms-webhooks#5: the gateway's PlaygroundEvents catalog serves a
 * `{ note: "no sample payload registered for …" }` placeholder for any event
 * whose SamplePayloadFor arm is missing (playground.go default branch — the
 * arms were keyed to a different webhooks catalog, so most AllowedEvents fall
 * through). That placeholder is NOT a production-accurate payload, so the UI
 * must not present it as one — warn the operator instead of implying the
 * sample matches what their handler will receive.
 */
export function isPlaceholderSample(payload: Record<string, unknown>): boolean {
  const note = payload.note;
  return (
    typeof note === "string" && note.startsWith("no sample payload registered")
  );
}

export type SimulatorPayloadValidation =
  | { parsed: Record<string, unknown>; error: null; kind: "valid" }
  | {
      parsed: null;
      error: string;
      kind: "too_large" | "syntax" | "shape" | "limits";
    };

export function validateSimulatorPayload(
  payload: string,
): SimulatorPayloadValidation {
  const payloadBytes = simulatorPayloadBytes(payload);
  if (payloadBytes > MAX_SIMULATOR_PAYLOAD_BYTES) {
    return {
      parsed: null,
      error:
        "Reduce the payload to 262,144 UTF-8 bytes or fewer before firing.",
      kind: "too_large",
    };
  }
  if (!payload.trim()) {
    return {
      parsed: null,
      error: "Enter a JSON object before firing.",
      kind: "shape",
    };
  }
  try {
    return {
      parsed: validateWebhookPlaygroundRawJSONObject(payload, "payload").parsed,
      error: null,
      kind: "valid",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const kind = message.includes("JSON object root")
      ? "shape"
      : /depth|duplicate|limit|oversized|too many/iu.test(message)
        ? "limits"
        : "syntax";
    return {
      parsed: null,
      error: message,
      kind,
    };
  }
}

export function recoveryAuthorityKey(
  authority: WebhookPlaygroundFireRecoveryAuthority | null,
): string {
  return authority
    ? `${authority.scope}:${authority.apiIdentityGeneration}`
    : "identity-unresolved";
}

export function recoverySnapshotFromFire(
  snapshot: FireSnapshot,
): WebhookPlaygroundFireSnapshot {
  return {
    fireId: snapshot.fireID,
    idempotencyKey: snapshot.idempotencyKey,
    webhookId: snapshot.webhookID,
    expectedWebhookConfigVersion: snapshot.webhookConfigVersion,
    eventType: snapshot.eventType,
    payloadJSON: snapshot.payload,
  };
}

export function fireSnapshotFromRecovery(
  snapshot: WebhookPlaygroundFireSnapshot,
): FireSnapshot | null {
  const validation = validateSimulatorPayload(snapshot.payloadJSON);
  if (!validation.parsed) return null;
  return {
    fireID: snapshot.fireId,
    idempotencyKey: snapshot.idempotencyKey,
    webhookID: snapshot.webhookId,
    webhookConfigVersion: snapshot.expectedWebhookConfigVersion,
    webhookURL: "the retained webhook destination",
    eventType: snapshot.eventType,
    payload: snapshot.payloadJSON,
  };
}

export function playgroundReceiptMatchesSnapshot(
  receipt: WebhookPlaygroundFireReceipt,
  snapshot: FireSnapshot,
): boolean {
  return (
    receipt.fire_id === snapshot.fireID &&
    receipt.webhook_id === snapshot.webhookID &&
    receipt.event_type === snapshot.eventType
  );
}

export function recoveryHoldDetail(
  reason: WebhookPlaygroundFireRecoveryHoldReason,
): string {
  switch (reason) {
    case "foreign-checkpoint":
      return "Another encrypted webhook fire identity exists outside the current API scope. New fires stay blocked until Moosewave is reopened under that exact credential and the checkpoint is reconciled.";
    case "vault-corrupt":
      return "The encrypted fire checkpoint is corrupt and has been quarantined. A new fire remains blocked so the original identity cannot be silently replaced.";
    case "checkpoint-conflict":
    case "checkpoint-exists":
    case "checkpoint-mismatch":
      return "A different encrypted fire checkpoint already owns this signed-in workspace. Reload that exact checkpoint before doing anything else.";
    case "identity-changed":
      return "The API identity changed while Moosewave was checking the encrypted fire checkpoint. Retry after the workspace transition finishes.";
    case "identity-unresolved":
      return "Moosewave cannot bind recovery to a verified session or API-key workspace yet.";
    case "snapshot-invalid":
      return "The exact fire snapshot failed local safety validation and was not sent.";
    case "vault-unavailable":
    default:
      return "The encrypted local vault is unavailable. Moosewave will not create a fire identity until it can prove that no unresolved checkpoint already exists.";
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
/**
 * lib/webhook-playground-fire-recovery.ts — the local recovery authority for
 * one webhook simulator fire. Port of desktop's
 * lib/webhook-playground-fire-recovery.ts.
 *
 * WHY A CHECKPOINT EXISTS AT ALL. A simulator fire is one real signed POST at
 * a customer handler. If the browser loses the answer (timeout, dropped
 * connection, reload, the operator pressing "Stop waiting") the receiver may
 * already have executed its side effect. Minting a NEW fire identity at that
 * point is how an order ships twice. So before the request leaves, the exact
 * request identity (fire id, idempotency key, target, revision, event, payload
 * text) is written here, and a new identity stays blocked until that exact
 * fire is reconciled against the server receipt, restored with the SAME
 * identity, or explicitly released by the operator.
 *
 * WEB DIFFERENCES FROM DESKTOP, deliberately:
 *   - Storage is `sessionStorage`, not an encrypted vault. It survives reloads
 *     and in-app navigation in this tab (the cases where a browser loses a
 *     response) and is discarded when the tab closes. Closing the tab can at
 *     worst let a NEW identity fire later; it can never redispatch the old one,
 *     because the server fences every fire id permanently. The payload text is
 *     not written to durable, cross-session storage that sign-out would have to
 *     purge.
 *   - Scope is the verified `/auth/me` tenant + user. A checkpoint written by
 *     another identity in the same tab is never adopted (different key).
 *   - Storage is synchronous, so the desktop's promise chain that serialises
 *     vault operations is unnecessary.
 *
 * Every operation fails CLOSED: storage it cannot read, a checkpoint it cannot
 * parse, or a checkpoint that differs from the one being settled all hold the
 * fence rather than guessing. An unreadable checkpoint is preserved, never
 * deleted — it is the only evidence that a fire may be outstanding.
 */
import {
  MAX_SIMULATOR_PAYLOAD_BYTES,
  type PlaygroundFireRequest,
} from "@/lib/developer-reference-api";

const VERSION = 1;

export const WEBHOOK_PLAYGROUND_FIRE_RECOVERY_PREFIX =
  "postwave:webhook-playground-fire-recovery:v1";

const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTITY_SEGMENT_RE = /^[A-Za-z0-9_-]{1,128}$/u;
const EVENT_TYPE_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const CONTROL_RE = /\p{Cc}/u;
const MAX_IDEMPOTENCY_KEY_BYTES = 255;
const MAX_EVENT_TYPE_BYTES = 200;
const textEncoder = new TextEncoder();

/** The exact request identity needed to reconcile or safely replay a fire. */
export type WebhookPlaygroundFireSnapshot = PlaygroundFireRequest;

export interface WebhookPlaygroundFireRecoveryAuthority {
  readonly tenantId: string;
  readonly userId: string;
  readonly scope: string;
}

export type WebhookPlaygroundFireRecoveryHoldReason =
  | "identity-unresolved"
  | "snapshot-invalid"
  | "storage-unavailable"
  | "checkpoint-corrupt"
  | "checkpoint-exists"
  | "checkpoint-conflict"
  | "checkpoint-mismatch";

export type WebhookPlaygroundFireRecoveryLoadResult =
  | { status: "clear" }
  | { status: "ready"; snapshot: WebhookPlaygroundFireSnapshot }
  | {
      status: "held";
      reason: "identity-unresolved" | "storage-unavailable" | "checkpoint-corrupt";
    };

export type WebhookPlaygroundFireRecoveryPrepareResult =
  | { status: "ready"; snapshot: WebhookPlaygroundFireSnapshot }
  | {
      status: "held";
      reason:
        | "identity-unresolved"
        | "snapshot-invalid"
        | "storage-unavailable"
        | "checkpoint-corrupt"
        | "checkpoint-exists"
        | "checkpoint-conflict";
    };

export type WebhookPlaygroundFireRecoverySettleResult =
  | { status: "clear" | "cleared" }
  | {
      status: "held";
      reason:
        | "identity-unresolved"
        | "snapshot-invalid"
        | "storage-unavailable"
        | "checkpoint-corrupt"
        | "checkpoint-mismatch";
    };

type CheckpointRead =
  | { status: "ready"; snapshot: WebhookPlaygroundFireSnapshot }
  | { status: "missing" }
  | { status: "unavailable" }
  | { status: "corrupt" };

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === "string") &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function validIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    utf8Bytes(value) <= MAX_IDEMPOTENCY_KEY_BYTES &&
    isWellFormedUnicode(value) &&
    !CONTROL_RE.test(value)
  );
}

function validEventType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    utf8Bytes(value) <= MAX_EVENT_TYPE_BYTES &&
    EVENT_TYPE_RE.test(value)
  );
}

/** A JSON OBJECT, as exact well-formed text within the server's byte ceiling. */
export function isSimulatorPayloadJSONObject(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    utf8Bytes(value) > MAX_SIMULATOR_PAYLOAD_BYTES ||
    !isWellFormedUnicode(value)
  ) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    );
  } catch {
    return false;
  }
}

function normalizeSnapshot(value: unknown): WebhookPlaygroundFireSnapshot | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (
      !hasOnlyKeys(row, [
        "fireId",
        "idempotencyKey",
        "webhookId",
        "expectedWebhookConfigVersion",
        "eventType",
        "payloadJSON",
      ]) ||
      typeof row.fireId !== "string" ||
      !CANONICAL_UUID_RE.test(row.fireId) ||
      !validIdempotencyKey(row.idempotencyKey) ||
      typeof row.webhookId !== "string" ||
      !CANONICAL_UUID_RE.test(row.webhookId) ||
      typeof row.expectedWebhookConfigVersion !== "number" ||
      !Number.isSafeInteger(row.expectedWebhookConfigVersion) ||
      row.expectedWebhookConfigVersion < 1 ||
      !validEventType(row.eventType) ||
      !isSimulatorPayloadJSONObject(row.payloadJSON)
    ) {
      return null;
    }
    return {
      fireId: row.fireId,
      idempotencyKey: row.idempotencyKey,
      webhookId: row.webhookId,
      expectedWebhookConfigVersion: row.expectedWebhookConfigVersion,
      eventType: row.eventType,
      payloadJSON: row.payloadJSON,
    };
  } catch {
    return null;
  }
}

function snapshotsMatch(
  left: WebhookPlaygroundFireSnapshot,
  right: WebhookPlaygroundFireSnapshot,
): boolean {
  return (
    left.fireId === right.fireId &&
    left.idempotencyKey === right.idempotencyKey &&
    left.webhookId === right.webhookId &&
    left.expectedWebhookConfigVersion === right.expectedWebhookConfigVersion &&
    left.eventType === right.eventType &&
    left.payloadJSON === right.payloadJSON
  );
}

/** Scope a checkpoint to the verified `/auth/me` tenant and user. */
export function createWebhookPlaygroundFireRecoveryAuthority(
  me: { tenant_id?: unknown; user_id?: unknown } | null | undefined,
): WebhookPlaygroundFireRecoveryAuthority | null {
  const tenantId = me?.tenant_id;
  const userId = me?.user_id;
  if (
    typeof tenantId !== "string" ||
    typeof userId !== "string" ||
    !IDENTITY_SEGMENT_RE.test(tenantId) ||
    !IDENTITY_SEGMENT_RE.test(userId)
  ) {
    return null;
  }
  return Object.freeze({ tenantId, userId, scope: `${tenantId}:${userId}` });
}

function resolveAuthority(
  value: WebhookPlaygroundFireRecoveryAuthority | null | undefined,
): WebhookPlaygroundFireRecoveryAuthority | null {
  const expected = createWebhookPlaygroundFireRecoveryAuthority(
    value ? { tenant_id: value.tenantId, user_id: value.userId } : null,
  );
  return expected && expected.scope === value?.scope ? expected : null;
}

/** The storage key for one authority's checkpoint. */
export function webhookPlaygroundFireRecoveryKey(
  authority: WebhookPlaygroundFireRecoveryAuthority,
): string {
  return `${WEBHOOK_PLAYGROUND_FIRE_RECOVERY_PREFIX}:${authority.scope}`;
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readCheckpoint(
  authority: WebhookPlaygroundFireRecoveryAuthority,
): CheckpointRead {
  const store = storage();
  if (!store) return { status: "unavailable" };
  let raw: string | null;
  try {
    raw = store.getItem(webhookPlaygroundFireRecoveryKey(authority));
  } catch {
    return { status: "unavailable" };
  }
  if (raw === null) return { status: "missing" };
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return { status: "corrupt" };
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return { status: "corrupt" };
  }
  const record = envelope as Record<string, unknown>;
  const snapshot = normalizeSnapshot(record.snapshot);
  if (
    !hasOnlyKeys(record, ["version", "scope", "snapshot"]) ||
    record.version !== VERSION ||
    record.scope !== authority.scope ||
    !snapshot
  ) {
    return { status: "corrupt" };
  }
  return { status: "ready", snapshot };
}

export const webhookPlaygroundFireRecovery = {
  /** Read this identity's checkpoint without changing it. */
  load(
    value: WebhookPlaygroundFireRecoveryAuthority | null | undefined,
  ): WebhookPlaygroundFireRecoveryLoadResult {
    const authority = resolveAuthority(value);
    if (!authority) return { status: "held", reason: "identity-unresolved" };
    const checkpoint = readCheckpoint(authority);
    if (checkpoint.status === "missing") return { status: "clear" };
    if (checkpoint.status === "unavailable") {
      return { status: "held", reason: "storage-unavailable" };
    }
    if (checkpoint.status === "corrupt") {
      return { status: "held", reason: "checkpoint-corrupt" };
    }
    return { status: "ready", snapshot: checkpoint.snapshot };
  },

  /**
   * Write the checkpoint BEFORE the request leaves. Refuses to overwrite any
   * existing checkpoint, and proves the write by reading it back.
   */
  prepare(
    value: WebhookPlaygroundFireRecoveryAuthority | null | undefined,
    input: WebhookPlaygroundFireSnapshot,
  ): WebhookPlaygroundFireRecoveryPrepareResult {
    const authority = resolveAuthority(value);
    if (!authority) return { status: "held", reason: "identity-unresolved" };
    const snapshot = normalizeSnapshot(input);
    if (!snapshot) return { status: "held", reason: "snapshot-invalid" };
    const existing = readCheckpoint(authority);
    if (existing.status === "unavailable") {
      return { status: "held", reason: "storage-unavailable" };
    }
    if (existing.status === "corrupt") {
      return { status: "held", reason: "checkpoint-corrupt" };
    }
    if (existing.status === "ready") {
      return {
        status: "held",
        reason: snapshotsMatch(existing.snapshot, snapshot)
          ? "checkpoint-exists"
          : "checkpoint-conflict",
      };
    }
    const store = storage();
    if (!store) return { status: "held", reason: "storage-unavailable" };
    try {
      store.setItem(
        webhookPlaygroundFireRecoveryKey(authority),
        JSON.stringify({ version: VERSION, scope: authority.scope, snapshot }),
      );
    } catch {
      return { status: "held", reason: "storage-unavailable" };
    }
    const persisted = readCheckpoint(authority);
    if (persisted.status === "missing" || persisted.status === "unavailable") {
      return { status: "held", reason: "storage-unavailable" };
    }
    if (persisted.status === "corrupt") {
      return { status: "held", reason: "checkpoint-corrupt" };
    }
    if (!snapshotsMatch(persisted.snapshot, snapshot)) {
      return { status: "held", reason: "checkpoint-conflict" };
    }
    return { status: "ready", snapshot: persisted.snapshot };
  },

  /**
   * Remove the checkpoint — only when it is exactly the fire being settled,
   * and only once removal is proven by a read-back.
   */
  settle(
    value: WebhookPlaygroundFireRecoveryAuthority | null | undefined,
    input: WebhookPlaygroundFireSnapshot,
  ): WebhookPlaygroundFireRecoverySettleResult {
    const authority = resolveAuthority(value);
    if (!authority) return { status: "held", reason: "identity-unresolved" };
    const snapshot = normalizeSnapshot(input);
    if (!snapshot) return { status: "held", reason: "snapshot-invalid" };
    const existing = readCheckpoint(authority);
    if (existing.status === "missing") return { status: "clear" };
    if (existing.status === "unavailable") {
      return { status: "held", reason: "storage-unavailable" };
    }
    if (existing.status === "corrupt") {
      return { status: "held", reason: "checkpoint-corrupt" };
    }
    if (!snapshotsMatch(existing.snapshot, snapshot)) {
      return { status: "held", reason: "checkpoint-mismatch" };
    }
    const store = storage();
    if (!store) return { status: "held", reason: "storage-unavailable" };
    try {
      store.removeItem(webhookPlaygroundFireRecoveryKey(authority));
    } catch {
      return { status: "held", reason: "storage-unavailable" };
    }
    const deleted = readCheckpoint(authority);
    if (deleted.status === "corrupt") {
      return { status: "held", reason: "checkpoint-corrupt" };
    }
    if (deleted.status !== "missing") {
      return { status: "held", reason: "storage-unavailable" };
    }
    return { status: "cleared" };
  },
} as const;

/** The operator-facing sentence for a hold. */
export function webhookPlaygroundFireRecoveryHoldDetail(
  reason: WebhookPlaygroundFireRecoveryHoldReason,
): string {
  switch (reason) {
    case "identity-unresolved":
      return "Moosewave cannot bind fire recovery to a verified workspace session yet. New fires stay blocked until it can.";
    case "snapshot-invalid":
      return "The exact fire snapshot failed local safety validation and was not sent.";
    case "checkpoint-corrupt":
      return "This tab's fire checkpoint is unreadable and has been preserved as evidence. New fires stay blocked so the original identity cannot be silently replaced; close this tab to discard it once you have checked the receiver.";
    case "checkpoint-exists":
    case "checkpoint-conflict":
    case "checkpoint-mismatch":
      return "A different fire checkpoint already owns this tab. Reconcile that exact fire before doing anything else.";
    case "storage-unavailable":
    default:
      return "Browser session storage is unavailable. Moosewave will not create a fire identity until it can prove no unresolved fire checkpoint already exists.";
  }
}

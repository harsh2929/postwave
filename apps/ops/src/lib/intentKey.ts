// SPDX-License-Identifier: AGPL-3.0-only

// newIntentKey produces a canonical UUID for the API's durable idempotency
// ledger. The fallback is RFC 4122 version 4, not an unshaped hex string.
export function newIntentKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new Error("secure randomness is unavailable");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface PayloadBoundIntent {
  key: string;
  fingerprint: string;
}

// bindPayloadIntent returns the existing key only when the complete canonical
// payload fingerprint is unchanged. Editing a reason, duration, check, or
// action input is a new intent and therefore earns a new durable key.
export function bindPayloadIntent(
  current: PayloadBoundIntent | null,
  fingerprint: string,
  createKey: () => string = newIntentKey,
): PayloadBoundIntent {
  if (current?.fingerprint === fingerprint) return current;
  return { key: createKey(), fingerprint };
}

export type IntentOutcome =
  | { kind: "network-error" }
  | { kind: "http-error"; status: number }
  | { kind: "operation"; status: "running" | "succeeded" | "failed" };

// shouldRetireIntent is the safety policy shared by check actions and
// snoozes. Network/5xx answers are ambiguous, and a durable running row must
// only ever be queried with its original key. A failed snooze can also be an
// ambiguous database acknowledgement (the UPDATE may have committed before a
// connection error), so callers may elect to retain it. A terminal success or
// a definitive 4xx refusal can safely retire the intent.
export function shouldRetireIntent(
  outcome: IntentOutcome,
  retainFailed = false,
): boolean {
  if (outcome.kind === "network-error") return false;
  if (outcome.kind === "http-error") return outcome.status >= 400 && outcome.status < 500;
  if (outcome.status === "running") return false;
  if (outcome.status === "failed" && retainFailed) return false;
  return true;
}

/**
 * lib/offlineQueueView.ts — presentation rules for the offline queue.
 *
 * Extracted so the counting, the expiry wording and the status→tone mapping
 * are unit-tested in the node environment: the previous home for all three was
 * a string built inside a component and handed to `Alert.alert`, which meant
 * "expires in 0m" and off-by-one bucket bugs were unobservable (NATIVE#35).
 *
 * Free of react-native imports on purpose. `PillTone` is a plain string union
 * in the component layer; it is re-declared structurally here rather than
 * imported so this module stays testable.
 */
import type { OfflineMutationStatus } from "./offlineMutationQueue";

export interface OfflineQueueCounts {
  queued: number;
  syncing: number;
  failed: number;
  sent: number;
}

/**
 * Count by status.
 *
 * `journalledFailures` is the DURABLE failure count from the vault. A failure
 * can exist in both places (a paused mutation that failed AND a journal row),
 * so the queue's own `failed` items are only counted when the journal has none
 * — double-counting the same failure was the concrete defect in the banner's
 * summary string.
 */
export function offlineQueueCounts(
  items: readonly { status: OfflineMutationStatus }[],
  journalledFailures = 0,
): OfflineQueueCounts {
  const counts: OfflineQueueCounts = {
    queued: 0,
    syncing: 0,
    failed: 0,
    sent: 0,
  };
  for (const item of items) counts[item.status] += 1;
  counts.failed = Math.max(counts.failed, journalledFailures);
  return counts;
}

/**
 * Expiry in words. An offline write has a TTL — past it the change is dropped
 * rather than sent against a stale world — and "expired" has to be stated
 * plainly, because the row otherwise looks like it is still waiting its turn.
 */
export function describeOfflineExpiry(
  expiresAt: number,
  now = Date.now(),
): string {
  const remaining = expiresAt - now;
  if (!Number.isFinite(expiresAt) || remaining <= 0) {
    return "expired — it will not be sent";
  }
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `expires in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `expires in ${hours}h${rest > 0 ? ` ${rest}m` : ""}`;
}

/** Last 8 characters of the operation id — enough for support to match a row. */
export function shortOperationId(value: string): string {
  return `#${value.slice(-8)}`;
}

export type OfflineQueueTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info";

/**
 * Status → tone. Colour is never the ONLY signal: the pill always carries the
 * status word too, so this is reinforcement rather than encoding.
 */
export function statusTone(status: OfflineMutationStatus): OfflineQueueTone {
  switch (status) {
    case "failed":
      return "danger";
    case "syncing":
      return "info";
    case "sent":
      return "success";
    case "queued":
    default:
      return "warning";
  }
}

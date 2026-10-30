/**
 * deliverabilitySnapshotKeys — the PURE half of the deliverability snapshot
 * layer: the vault-id namespacing and the staleness copy.
 *
 * Split out because `deliverabilitySnapshots.ts` imports `connectivity`, which
 * imports `@react-native-community/netinfo` and `react-native` — neither of
 * which the node test environment can transform. That made the two rules most
 * worth testing (ids never collide; a cached read always admits it is cached)
 * untestable by association. This module imports nothing.
 */

export type DeliverabilitySnapshotResource =
  | "custom-domains"
  | "dmarc-reports"
  | "archive-index"
  | "sending-settings"
  | "deliverability-hub"
  | "suppression-page";

/**
 * Small, slow-changing REFERENCE catalogues that behave the same way offline
 * (COMMERCE#15, AUDIENCE#66). They are not deliverability resources, so they
 * take their own id prefix — but they want every property this layer already
 * provides: identity scoping, the 12h TTL, the logout purge, and the
 * `fromSnapshot` / `capturedAt` provenance that stops a cached list being
 * presented as live.
 */
export type ReferenceSnapshotResource = "discounts" | "lists" | "tags";

export type SnapshotResource =
  | DeliverabilitySnapshotResource
  | ReferenceSnapshotResource;

const REFERENCE_RESOURCES = new Set<string>([
  "discounts",
  "lists",
  "tags",
]);

/**
 * Vault id for a resource. Prefixed so it can never collide with the
 * suppression page stored at id `latest` — and so the two families above can
 * never collide with each other. The `deliverability.` prefix is load-bearing
 * for the six original resources: changing it would orphan every snapshot
 * already on a device.
 */
export function snapshotVaultId(resource: SnapshotResource): string {
  return REFERENCE_RESOURCES.has(resource)
    ? `reference.${resource}`
    : `deliverability.${resource}`;
}

export interface SnapshotBacked<T> {
  value: T;
  /** True when the value came from the vault rather than the network. */
  fromSnapshot: boolean;
  /** Epoch ms the value was captured; null when unknown (legacy payloads). */
  capturedAt: number | null;
}

/**
 * The banner copy for a snapshot-backed read. Returns null when the data is
 * live, so the caller renders nothing in the common case.
 */
export function snapshotNotice(
  backing: { fromSnapshot: boolean; capturedAt: number | null } | undefined,
  relative: (value: number) => string,
): string | null {
  if (!backing?.fromSnapshot) return null;
  if (backing.capturedAt == null) return "Cached copy — reconnect to refresh.";
  return `Cached ${relative(backing.capturedAt)} — reconnect to refresh.`;
}

/**
 * The vault silently DROPS any payload over its 24 KB ceiling
 * (`vaultSetJSON` returns without writing). A workspace with a few hundred
 * discount codes or a few thousand tags therefore cached nothing at all, and
 * the failure was invisible — the screen simply had no offline data and no
 * reason why.
 *
 * So a reference snapshot is capped BEFORE it is handed to the vault: trim
 * rows from the tail until the serialised payload fits, and report how many
 * survived so the screen can say the copy is partial instead of implying the
 * workspace has only 40 tags.
 *
 * Trimming from the TAIL, not sampling: these lists arrive in the server's own
 * order, and the head is what a picker shows first.
 */
export interface CappedRows<T> {
  rows: T[];
  /** True when rows were dropped to fit — the cached copy is a prefix. */
  truncated: boolean;
}

/**
 * Budget for a reference catalogue's serialised rows. `secureVault`'s own
 * ceiling is 24 KB for the WHOLE record; this leaves comfortable room for the
 * envelope it wraps around the value (kind, id, scope, timestamps) plus the
 * `{value, capturedAt}` wrapper this layer adds.
 */
export const REFERENCE_SNAPSHOT_MAX_BYTES = 18_000;

export function capRowsForVault<T>(
  rows: readonly T[],
  maxBytes: number,
  measure: (value: unknown) => number = (value) =>
    JSON.stringify(value).length,
): CappedRows<T> {
  if (rows.length === 0) return { rows: [], truncated: false };
  if (measure(rows) <= maxBytes) {
    return { rows: [...rows], truncated: false };
  }
  // Binary search for the longest prefix that fits. Linear trimming is O(n²)
  // in the serialiser on a catalogue that is mostly over budget.
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(rows.slice(0, mid)) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return { rows: rows.slice(0, low), truncated: low < rows.length };
}

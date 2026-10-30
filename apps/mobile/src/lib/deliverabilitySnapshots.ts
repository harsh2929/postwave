/**
 * deliverabilitySnapshots — offline projections for the deliverability
 * surfaces, WITH honest provenance.
 *
 * Two problems this closes.
 *
 * 1. Only suppressions and inbound webhooks had an offline snapshot. Custom
 *    domains, DMARC, the archive index and the sending config were plain gated
 *    queries that rendered nothing offline — and two of them rendered
 *    something worse than nothing ("Nothing published yet", "Sending is
 *    uncapped"). For an offline-first app the DNS records you already fetched
 *    should still be in your pocket on a plane.
 *
 * 2. `loadOfflineCapableSnapshot` returns the cached value BARE: no flag, no
 *    capture time. So on the snapshot path a screen renders a successful
 *    query — `isError` false, `isFetching` false — and shows day-old data as
 *    if it were live. An operator can tell a customer "you're still
 *    suppressed" from a stale list. Every read here carries `fromSnapshot` and
 *    `capturedAt` so the screen can say "Cached · 3h ago".
 *
 * Storage rides the existing `suppression` vault kind with a namespaced id
 * rather than adding new kinds, so the identity scoping, the 12h TTL, the
 * size caps and — critically — the logout purge (`vaultClear` walks the
 * manifest, not a kind list) all apply unchanged.
 */
import { isProbablyOnline } from "./connectivity";
import {
  snapshotVaultId,
  type SnapshotBacked,
  type SnapshotResource,
} from "./deliverabilitySnapshotKeys";
import { loadOfflineCapableSnapshot } from "./offlineSnapshots";
import { vaultGetJSON, vaultScopeForClient, vaultSetJSON } from "./secureVault";

/**
 * The only accepted cache identity: origin + tenant + human user + role.
 * Returns null (rather than throwing) when any part is missing, because an
 * api-key session legitimately has no human user/role boundary.
 */
export function snapshotScope(identity: {
  baseUrl: string | null;
  tenantId: string | null;
  userId: string | null;
  effectiveRole: string | null;
}): string | null {
  const { baseUrl, tenantId, userId, effectiveRole } = identity;
  if (!baseUrl || !tenantId || !userId || !effectiveRole) return null;
  try {
    return vaultScopeForClient({
      baseUrl,
      tenantId,
      userId,
      role: effectiveRole,
    });
  } catch {
    return null;
  }
}

interface StoredSnapshot<T> {
  value: T;
  capturedAt: number;
}

function isStored<T>(value: unknown): value is StoredSnapshot<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    typeof (value as { capturedAt?: unknown }).capturedAt === "number"
  );
}

export interface SnapshotQueryInput<T> {
  resource: SnapshotResource;
  /** Identity scope from `vaultScopeForClient`; null disables persistence. */
  scope: string | null;
  canUseNetwork: boolean;
  loadNetwork: () => Promise<T>;
  unavailableMessage: string;
  /**
   * Only the canonical (unfiltered) view may be written to the vault. A
   * filtered page cached as "the" snapshot would show an offline operator a
   * subset and call it the whole list.
   */
  persist?: boolean;
  /**
   * Shrink the value on its way to the vault ONLY.
   *
   * The 24 KB ceiling is a property of the storage, not of the screen, so
   * capping in `loadNetwork` would hide rows from an ONLINE user to satisfy a
   * disk limit — the live list must always be whole. Applied after the
   * network read and before the write; the returned value is what the caller
   * renders, untouched.
   */
  minimizeForSnapshot?: (value: T) => T;
}

/**
 * Run a query that survives airplane mode, returning the value together with
 * where it came from.
 */
export async function loadSnapshotBacked<T>(
  input: SnapshotQueryInput<T>,
): Promise<SnapshotBacked<T>> {
  const id = snapshotVaultId(input.resource);
  const scopeOption = input.scope ? { scope: input.scope } : {};
  const persist = input.persist !== false && Boolean(input.scope);

  return loadOfflineCapableSnapshot<SnapshotBacked<T>>({
    canUseNetwork: input.canUseNetwork,
    loadNetwork: async () => ({
      value: await input.loadNetwork(),
      fromSnapshot: false,
      capturedAt: Date.now(),
    }),
    readSnapshot: async () => {
      if (!input.scope) return null;
      const cached = await vaultGetJSON<unknown>("suppression", id, scopeOption);
      if (!isStored<T>(cached)) return null;
      return {
        value: cached.value,
        fromSnapshot: true,
        capturedAt: cached.capturedAt,
      };
    },
    ...(persist
      ? {
          writeSnapshot: async (result: SnapshotBacked<T>) => {
            // Never re-persist what we just read out of the vault, and never
            // persist a filtered view.
            if (result.fromSnapshot) return;
            const stored = input.minimizeForSnapshot
              ? input.minimizeForSnapshot(result.value)
              : result.value;
            await vaultSetJSON(
              "suppression",
              id,
              { value: stored, capturedAt: result.capturedAt ?? Date.now() },
              scopeOption,
            );
          },
        }
      : {}),
    networkAvailable: isProbablyOnline,
    unavailableMessage: input.unavailableMessage,
  });
}

// The pure half lives in deliverabilitySnapshotKeys so it is testable without
// a native transform; re-exported here so call sites keep one import.
export {
  REFERENCE_SNAPSHOT_MAX_BYTES,
  capRowsForVault,
  snapshotNotice,
  snapshotVaultId,
  type DeliverabilitySnapshotResource,
  type ReferenceSnapshotResource,
  type SnapshotBacked,
  type SnapshotResource,
} from "./deliverabilitySnapshotKeys";

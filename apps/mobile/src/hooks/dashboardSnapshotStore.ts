/**
 * hooks/dashboardSnapshotStore.ts — the device side of the dashboard's
 * cold-offline read.
 *
 * Split out of hooks/useDashboard.ts so the query hook stays about the QUERY:
 * everything here is about what may be written to this phone, under which
 * identity, and for how long. The projection itself (which fields survive) is
 * one level further down, in lib/dashboardOfflineProjection.ts, and is pure.
 *
 * IDENTITY IS PART OF THE KEY. `vaultScopeForClient` binds a snapshot to
 * (origin, tenant, user, role). Two people sharing a phone, or one person
 * switching workspaces, therefore cannot read each other's numbers back — and
 * a role downgrade invalidates the cache rather than serving figures the user
 * is no longer entitled to.
 */
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  projectDashboardStatsForVault,
  readDashboardStatsSnapshot,
} from "@/lib/dashboardOfflineProjection";
import type { DashboardStats } from "@/lib/dashboardStatsSchema";
import { vaultGetJSON, vaultScopeForClient, vaultSetJSON } from "@/lib/secureVault";

/**
 * How long a cached dashboard may be served offline.
 *
 * Shorter than the vault default (12h) on purpose: a subscriber count from
 * yesterday morning is a fact about yesterday morning, and the screen's
 * "cached" notice is a label, not an excuse. Past this the cold-offline launch
 * goes back to em-dashes, which is the honest answer.
 */
export const DASHBOARD_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;

/** One vault slot per reporting window — a 7d capture is not a 90d answer. */
export function dashboardSnapshotSlot(range: string): string {
  return `stats-${range}`;
}

/**
 * The identity a snapshot is filed under, or null when the session is not
 * complete enough to name one (API-key mode has no human user or role, so it
 * deliberately gets no offline projection).
 */
export function dashboardVaultScope(gate: OnlineQueryGate): string | null {
  if (!gate.baseUrl || !gate.tenantId || !gate.userId || !gate.effectiveRole) {
    return null;
  }
  return vaultScopeForClient({
    baseUrl: gate.baseUrl,
    tenantId: gate.tenantId,
    userId: gate.userId,
    role: gate.effectiveRole,
  });
}

/**
 * NO SCOPE MEANS NO SNAPSHOT — never the vault's default scope.
 *
 * `vaultSetJSON` falls back to a shared "global" scope when none is supplied.
 * Passing a null scope through would therefore file one workspace's counts in
 * a slot every other identity on the device also reads. API-key mode has no
 * human user or role and so has no scope: it gets the network, and nothing on
 * disk.
 */
export async function readDashboardSnapshot(
  slot: string,
  scope: string | null,
): Promise<DashboardStats | null> {
  if (!scope) return null;
  const raw = await vaultGetJSON<unknown>("dashboard", slot, { scope });
  // Re-projected on the way out as well as in, so a rule tightened today also
  // applies to a blob written yesterday.
  return readDashboardStatsSnapshot(raw);
}

/**
 * Minimum gap between two writes of an UNCHANGED projection.
 *
 * The stats query polls every 30 seconds. Writing the vault on each successful
 * poll is ~120 Keychain round-trips an hour to persist bytes that did not
 * move; the only reason to rewrite identical figures is to push the 6h expiry
 * forward, and once an hour does that with room to spare. A CHANGED projection
 * always writes immediately — staleness is the thing this cache is for.
 */
const UNCHANGED_REWRITE_MS = 60 * 60 * 1000;

const lastWritten = new Map<string, { fingerprint: string; at: number }>();

/** Test seam: the module-level write ledger is per-process, not per-session. */
export function resetDashboardSnapshotWriteLedger(): void {
  lastWritten.clear();
}

export async function writeDashboardSnapshot(
  slot: string,
  scope: string | null,
  stats: DashboardStats,
): Promise<void> {
  if (!scope) return;
  const projected = projectDashboardStatsForVault(stats);
  // Nothing usable survived the allowlist: leave the previous snapshot alone
  // rather than replacing it with an empty husk that would read back later as
  // a successful load of a zero workspace.
  if (!projected) return;

  const key = `${scope}|${slot}`;
  const fingerprint = JSON.stringify(projected);
  const previous = lastWritten.get(key);
  if (
    previous &&
    previous.fingerprint === fingerprint &&
    Date.now() - previous.at < UNCHANGED_REWRITE_MS
  ) {
    return;
  }

  await vaultSetJSON("dashboard", slot, projected, {
    scope,
    ttlMs: DASHBOARD_SNAPSHOT_TTL_MS,
  });
  // Recorded only AFTER a write that resolved: a rejected SecureStore call
  // must not suppress the next attempt for an hour.
  lastWritten.set(key, { fingerprint, at: Date.now() });
}

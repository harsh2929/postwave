/**
 * subscriberListVault — the secure-vault side of the offline subscribers
 * list, kept out of hooks/useSubscribers.ts so that file stays inside its
 * size budget and the vault contract has one place to live.
 *
 * WHY A SINGLE FIXED ID: only ONE view is snapshotted (page 1, unfiltered,
 * default order — see lib/subscriberListSnapshot.ts for why). A per-query id
 * would let the vault accumulate projections that no screen ever reads back,
 * against a store with a 256-key manifest ceiling.
 */
import {
  projectSubscriberListSnapshot,
  snapshotAsPage,
  type SubscriberListSnapshot,
} from "@/lib/subscriberListSnapshot";
import { vaultGetJSON, vaultSetJSON } from "@/lib/secureVault";

const SNAPSHOT_ID = "__list_page1";

/** Read the stored projection back as the page shape the list consumes. */
export async function readSubscriberListSnapshot(
  scope: string,
): Promise<{ items: unknown[]; total?: number; page: number } | null> {
  const stored = await vaultGetJSON<SubscriberListSnapshot>(
    "subscriber",
    SNAPSHOT_ID,
    { scope },
  );
  return stored ? snapshotAsPage(stored) : null;
}

/**
 * Project and store one live page.
 *
 * A payload that is not a page projects to `null`, and that case RETURNS
 * without writing: overwriting a good projection with an empty one would turn
 * a single bad response into a permanently empty offline list.
 */
export async function writeSubscriberListSnapshot(
  scope: string,
  page: unknown,
): Promise<void> {
  const projected = projectSubscriberListSnapshot(page, Date.now());
  if (!projected) return;
  await vaultSetJSON("subscriber", SNAPSHOT_ID, projected, { scope });
}

/**
 * lib/campaignSnapshot.ts — what a campaign row looks like on disk.
 *
 * The campaign list and detail had no offline snapshot at all, unlike
 * subscribers, audit and ops: opening the Campaigns tab on a plane showed an
 * empty screen and a notice, on the client whose defining condition is
 * intermittent connectivity.
 *
 * The projection lives HERE rather than beside the hook for two reasons:
 *
 *  1. SIZE. The encrypted vault silently DROPS an entry over its per-entry
 *     ceiling (secureVault.ts vaultSetJSON returns without writing). A list
 *     row on the wire can carry the whole email body, so an unprojected write
 *     would leave the snapshot permanently empty and nobody would ever see an
 *     error saying so.
 *  2. TESTABILITY. src/hooks/useCampaigns.ts now transitively imports
 *     react-native (through lib/connectivity), so it cannot be imported in the
 *     node vitest environment. This module imports nothing.
 */

/** The fields a campaign LIST ROW renders. Keep in sync with CampaignListRow. */
export interface CampaignSnapshotRow {
  id: string;
  name?: string;
  subject?: string;
  status?: string;
  scheduled_at?: string | null;
  sent_at?: string | null;
  created_at?: string;
  open_rate?: number;
  click_rate?: number;
  is_ab_test?: boolean;
  delivery_settings?: Record<string, unknown>;
  /** Kept so the folder filter still groups correctly from a cold, offline start. */
  folder_id?: string;
}

/**
 * Project a wire row down to what the list renders. Absent keys are OMITTED
 * rather than written as explicit `undefined`: exactOptionalPropertyTypes is
 * on, and an explicit undefined survives the JSON round-trip as a present key
 * with a null-ish value.
 */
export function campaignListSnapshotRow<T extends CampaignSnapshotRow>(
  c: T,
): CampaignSnapshotRow {
  return {
    id: c.id,
    ...(c.name !== undefined ? { name: c.name } : {}),
    ...(c.subject !== undefined ? { subject: c.subject } : {}),
    ...(c.status !== undefined ? { status: c.status } : {}),
    ...(c.scheduled_at !== undefined ? { scheduled_at: c.scheduled_at } : {}),
    ...(c.sent_at !== undefined ? { sent_at: c.sent_at } : {}),
    ...(c.created_at !== undefined ? { created_at: c.created_at } : {}),
    ...(c.open_rate !== undefined ? { open_rate: c.open_rate } : {}),
    ...(c.click_rate !== undefined ? { click_rate: c.click_rate } : {}),
    ...(c.is_ab_test !== undefined ? { is_ab_test: c.is_ab_test } : {}),
    ...(c.folder_id !== undefined ? { folder_id: c.folder_id } : {}),
    // The A/B badge reads delivery_settings.ab_test.is_parent; keeping only
    // that sub-object costs nothing and preserves the pill offline.
    ...(c.delivery_settings && typeof c.delivery_settings === "object"
      ? {
          delivery_settings: {
            ab_test: (c.delivery_settings as { ab_test?: unknown }).ab_test,
          },
        }
      : {}),
  };
}

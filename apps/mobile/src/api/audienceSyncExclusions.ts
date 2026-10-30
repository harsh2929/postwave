/**
 * api/audienceSyncExclusions.ts — the activation firewall's two read surfaces.
 *
 *   GET /api/v1/audience-syncs/{id}/exclusion-preview          → JSON
 *   GET /api/v1/audience-sync-runs/{run_id}/exclusion-receipt  → text/csv
 *
 * A NEW MODULE, not additions to api/audienceSyncs.ts: these routes are mounted
 * by a DIFFERENT package (`internal/activation_firewall`, whose header explains
 * that the firewall deliberately owns its own HTTP surface end-to-end), and
 * api/audienceSyncs.ts documents itself as the mirror of
 * `audience_destinations`' sync mount. Keeping the seam means the comment above
 * each URL can keep pointing at the file that actually serves it.
 *
 * ROLES, read off the guards on the routes (MountSyncRoutes,
 * activation_firewall/sync_handlers.go:95-107):
 *   - preview: `RequireScope(ScopeReadSubscribers)` — in `readOnlyScopes`
 *     (apikeys/middleware.go:367+), so any authenticated session clears it,
 *     viewer included.
 *   - receipt:  `RequireScope(ScopeAdmin)` — NOT read-only and NOT in
 *     `editorWriteScopes`, so `sessionRoleAllowsScopes` admits owner and admin
 *     only. The rows carry subscriber emails, which is why. The generated
 *     manifest records `viewer` for this path with
 *     `review_status: "fail_closed_default"` — a default, not a reading of the
 *     guard — so the guard wins and the UI gates at admin.
 *
 * Parsing and bounding live in lib/audienceSyncExclusions so vitest can reach
 * them in the node environment; this module is only URLs and envelopes.
 */
import {
  parseSyncExclusionPreview,
  type SyncExclusionPreview,
} from "@/lib/audienceSyncExclusions";

import { checkedApiResult, rawRequest, sdkResource } from "./request";

export function syncExclusionPreviewPath(syncId: string): string {
  return `/api/v1/audience-syncs/${encodeURIComponent(syncId)}/exclusion-preview`;
}

export function syncExclusionReceiptPath(runId: string): string {
  return `/api/v1/audience-sync-runs/${encodeURIComponent(runId)}/exclusion-receipt`;
}

/**
 * The forecast, not a record: the handler runs the firewall in count-only mode
 * and writes no receipts. A resolvable source answers real counts; an
 * unresolvable one answers -1 for every count, which the parser turns into null
 * so nothing downstream can render it as zero.
 */
export async function fetchSyncExclusionPreview(
  syncId: string,
): Promise<SyncExclusionPreview> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", syncExclusionPreviewPath(syncId)),
  );
  return parseSyncExclusionPreview(res.data);
}

/**
 * The run's receipt as TEXT for the share sheet — the same treatment
 * `fetchFormSubmissionsCsv` gives its CSV, and for the same reason: this route
 * answers `text/csv` with a `Content-Disposition: attachment`, and a phone has
 * nowhere to put an attachment.
 *
 * Through `sdkResource` rather than `getClient`: reaching for the client here
 * would pull react-native into this module's import graph and take every node
 * test of it down.
 */
export async function fetchSyncExclusionReceiptCsv(
  runId: string,
): Promise<string> {
  const res = await checkedApiResult(
    sdkResource<string>((client) =>
      client.request<string>("GET", syncExclusionReceiptPath(runId), {
        asText: true,
      }),
    ),
  );
  return res.data ?? "";
}

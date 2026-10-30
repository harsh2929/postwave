/**
 * hooks/useCampaigns.ts — typed list + detail queries for campaigns.
 *
 * The SDK already exposes `client.campaigns.list()` and
 * `client.campaigns.get(id)`, both of which speak to the same
 * /api/v1/campaigns endpoints the desktop uses. We wrap those into
 * TanStack queries so the mobile screens can render skeletons and
 * pull-to-refresh without per-screen state machines.
 *
 * Detail-screen note: the SDK's `Campaign` type doesn't include the
 * report stats (open_rate, click_rate). The Go API returns those on
 * GET /api/v1/campaigns/{id}/report — we expose `useCampaignReport`
 * so the detail screen can render the 4-card grid using real data,
 * with a graceful fallback when the report isn't available yet.
 */
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { useCampaignReportStream } from "@/hooks/useCampaignReportStream";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isLiveSendStatus, LIVE_SEND_POLL_MS } from "@/lib/campaignProgress";
import { campaignListSnapshotRow } from "@/lib/campaignSnapshot";
import {
  CAMPAIGN_PAGE_SIZE,
  campaignLifecycleActions,
  isDraftCampaignStatus,
  isValidTestEmail,
  nextCampaignPage,
  resendSummaryMessage,
  type CampaignLifecycleAction,
} from "@/lib/campaignPolicy";
import { campaignVaultScope } from "@/lib/campaignVaultScope";
import { campaignsQueryRootKey } from "@/lib/detailSeedKeys";
import { isProbablyOnline } from "@/lib/connectivity";
import { loadOfflineCapableSnapshot } from "@/lib/offlineSnapshots";
import { vaultGetJSON, vaultSetJSON } from "@/lib/secureVault";

/**
 * Campaign list-row shape. The SDK's `Campaign` type lives inside
 * resources/campaigns.ts and isn't re-exported from the top-level
 * `@postwave/sdk` entry, so we mirror it here. Keep in sync with
 * packages/sdk-ts/src/resources/campaigns.ts::Campaign.
 */
export interface Campaign {
  id: string;
  tenant_id?: string;
  name?: string;
  subject?: string;
  status?: string;
  body_html?: string;
  body_mjml?: string;
  list_id?: string;
  segment_id?: string;
  scheduled_at?: string | null;
  sent_at?: string | null;
  created_at?: string;
  updated_at?: string;
  /**
   * Engagement rates, attached to EVERY list row by the Go handler as 0..1
   * fractions (apps/api/internal/campaigns/types.go OpenRate/ClickRate,
   * attachListRates in repo.go). They were missing from this mirror, which
   * forced an `as unknown as {open_rate?: number}` cast at the one call site
   * that read them and made click rate unreachable entirely.
   */
  open_rate?: number;
  click_rate?: number;
  /**
   * A/B parentage. `delivery_settings.ab_test.is_parent` is the canonical
   * signal desktop reads; `is_ab_test` is the flattened convenience flag.
   * Consumed through isCampaignAbTest() in src/lib/campaignAbTest.ts.
   */
  is_ab_test?: boolean;
  delivery_settings?: Record<string, unknown>;
  /**
   * The folder this campaign is filed under, or the EMPTY STRING for
   * uncategorised — the Go projection is `COALESCE(folder_id::text, '')`
   * (apps/api/internal/campaigns/repo.go:762, `campaignColumns`), so it is
   * never null on the wire and a `== null` test buckets nothing. Present on
   * every list row, which is what makes the folder filter possible at all;
   * read it through lib/campaignFolders, never directly.
   */
  folder_id?: string;
}

/**
 * Mirrors `CampaignReport` in apps/api/internal/analytics/analytics.go.
 * Only the fields the mobile detail screen renders are required; the
 * rest are typed but optional so the gateway can evolve.
 */
export interface CampaignReport {
  campaign_id: string;
  sent: number;
  delivered: number;
  opens: number;
  unique_opens: number;
  clicks: number;
  unique_clicks: number;
  bounces: number;
  complaints: number;
  unsubscribes: number;
  open_rate: number;
  click_rate: number;
  click_to_open_rate: number;
  bounce_rate: number;
  unsub_rate: number;
  top_links?: { url: string; clicks: number }[];
  /**
   * MPP-stripped ("human") engagement. Apple Mail Privacy Protection inflates
   * raw opens 25–40%, so the Go report ships a parallel set of human_* fields
   * (apps/api/internal/analytics/analytics.go) and the desktop's engagement
   * toggle DEFAULTS to them. Mobile omitted every one of these, so the same
   * campaign showed a different open rate on the phone than on the desk.
   */
  human_opens?: number;
  human_unique_opens?: number;
  human_clicks?: number;
  human_unique_clicks?: number;
  human_open_rate?: number;
  human_click_rate?: number;
  human_click_to_open_rate?: number;
  human_top_links?: { url: string; clicks: number }[];
  /** Non-empty when bot/MPP signatures were subtracted from the raw counts. */
  bot_signatures_applied?: string[];
}

/**
 * Extended campaign shape with the body fields the API returns on
 * /api/v1/campaigns/{id}. The list endpoint omits these to keep the
 * payload small.
 */
export interface CampaignDetail extends Campaign {
  preview_text?: string;
  body_html?: string;
  body_mjml?: string;
  plain_text?: string;
  /** Authoritative structured campaign nodes returned by the detail endpoint. */
  content_blocks?: { type?: string; [key: string]: unknown }[];
  /** Authoritative content identity paired with content_blocks by the API. */
  source_mode?: "semantic" | "legacy_html";
  content_schema_version?: number;
  from_name?: string;
  /**
   * NOT a top-level field on the Go struct — the gateway carries the sending
   * address at `delivery_settings.from_email` (send.go:128, abrollout.go:114).
   * Kept only as a forward-compatible alias; read it through
   * `campaignFromEmail()` in src/lib/campaignSender.ts, never directly, or the
   * value is permanently undefined. Guarded by campaignWireContract.test.ts.
   */
  from_email?: string;
  reply_to?: string;
  /**
   * Public web-archive surfacing (Go: ArchivePublic/ArchiveSlug,
   * types.go:85-86). Present once the campaign has been published to the
   * public archive; the pair is what a shareable "web version" URL is built
   * from.
   */
  archive_public?: boolean;
  archive_slug?: string;
  /** Per-recipient send-time optimization configured on desktop. */
  per_recipient_optimize?: boolean;
  send_window_start?: string | null;
  send_window_end?: string | null;
}


type CampaignListParams = {
  query?: string;
  page?: number;
  per_page?: number;
  limit?: number;
};

async function listCampaigns(
  client: unknown,
  params: CampaignListParams,
): Promise<Campaign[]> {
  // The workspace SDK source supports these params; cast through a narrow
  // seam so mobile type-checking also works before the SDK dist is rebuilt.
  const resource = (client as { campaigns: unknown }).campaigns as {
    list: (input?: CampaignListParams) => Promise<unknown>;
  };
  const list = await resource.list(params);
  return Array.isArray(list) ? (list as Campaign[]) : [];
}

/**
 * The test-send + resend mutations live in useCampaignSendActions.ts (this
 * file was over its size budget); re-exported here so every existing call site
 * keeps importing from one place.
 */
export {
  useResendToNonOpeners,
  useSendTestCampaign,
  type ResendToNonOpenersResponse,
} from "@/hooks/useCampaignSendActions";

/**
 * Pure campaign policy lives in an import-free module so it stays testable in
 * the node vitest environment — this file transitively imports react-native
 * through lib/connectivity. Re-exported so call sites keep one import path.
 */
export {
  CAMPAIGN_PAGE_SIZE,
  campaignLifecycleActions,
  isDraftCampaignStatus,
  isValidTestEmail,
  nextCampaignPage,
  resendSummaryMessage,
  type CampaignLifecycleAction,
};

export function useCampaignsList() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: campaignsQueryRootKey(gate.tenantId),
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: async (): Promise<Campaign[]> => {
      const { client } = getClient();
      // The SDK's `Campaign` type isn't re-exported, so we cast through
      // unknown to our locally-mirrored shape. The runtime payload is
      // identical — the cast just satisfies TypeScript.
      return listCampaigns(client, {
        limit: 10,
      });
    },
  });
}

/** Paginated, server-searched source for the full Campaigns screen. */
export function useCampaignsPaginated(query: string) {
  const gate = useOnlineQueryGate();
  const normalizedQuery = query.trim();
  const vaultScope = campaignVaultScope(gate);
  // Only the unfiltered first page is the offline baseline; a search is a
  // transient act, not something to serve from disk hours later.
  const snapshotEligible = normalizedQuery.length === 0;
  return useInfiniteQuery({
    queryKey: [
      // Same builder as the plain list above, so the detail header's cache
      // seed addresses BOTH with one prefix (src/lib/detailSeedKeys.ts).
      ...campaignsQueryRootKey(gate.tenantId),
      "paged",
      normalizedQuery,
      gate.userId,
      gate.effectiveRole,
      gate.enabled ? "network" : "snapshot",
    ],
    enabled:
      gate.enabled ||
      (gate.canReadOfflineSnapshots && Boolean(vaultScope) && snapshotEligible),
    // networkMode "always" so the queryFn still runs offline and can answer
    // from the encrypted snapshot instead of the query being paused.
    networkMode: "always",
    // Each debounced search term is a fresh cache key. Without this the list
    // emptied on every keystroke — typing a five-word search strobed the
    // screen five times — because `data` went undefined while the new key
    // loaded. Keep the prior results on screen and refine them in place.
    placeholderData: keepPreviousData,
    initialPageParam: 1,
    queryFn: async ({ pageParam }): Promise<Campaign[]> => {
      const fetchPage = async (): Promise<Campaign[]> => {
        const { client } = getClient();
        return listCampaigns(client, {
          page: pageParam,
          per_page: CAMPAIGN_PAGE_SIZE,
          ...(normalizedQuery ? { query: normalizedQuery } : {}),
        });
      };
      if (pageParam !== 1 || !snapshotEligible || !vaultScope) {
        // Later pages have nothing cached to fall back to; let the query error
        // so the footer can offer a retry rather than silently ending the list.
        return fetchPage();
      }
      return loadOfflineCapableSnapshot<Campaign[]>({
        canUseNetwork: gate.enabled,
        loadNetwork: fetchPage,
        readSnapshot: () =>
          vaultGetJSON<Campaign[]>("campaign", "list-page-1", {
            scope: vaultScope,
          }),
        writeSnapshot: (rows) =>
          // Projected to what a list ROW renders. The wire row can carry a
          // whole email body, and the vault silently drops an oversize entry —
          // an unprojected write would leave the snapshot permanently empty.
          vaultSetJSON(
            "campaign",
            "list-page-1",
            rows.slice(0, 40).map(campaignListSnapshotRow),
            { scope: vaultScope },
          ),
        networkAvailable: isProbablyOnline,
        unavailableMessage:
          "No saved campaign list is available offline. Reconnect to load your campaigns.",
      });
    },
    getNextPageParam: nextCampaignPage,
  });
}

/** Typed pause/resume/cancel mutations backed by the SDK lifecycle methods. */
export function useCampaignLifecycleAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      action: CampaignLifecycleAction;
    }) => {
      const { client } = getClient();
      if (input.action === "pause") return client.campaigns.pause(input.id);
      if (input.action === "resume") return client.campaigns.resume(input.id);
      return client.campaigns.cancel(input.id);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["campaign"] });
      void queryClient.invalidateQueries({ queryKey: ["campaign-report"] });
    },
  });
}

export function useCampaign(id: string | undefined) {
  const gate = useOnlineQueryGate();
  const vaultScope = campaignVaultScope(gate);
  return useQuery({
    queryKey: [
      // `id` stays in position 2 so the ["campaign", tenantId, id] prefix used
      // by every mutation's invalidation still partial-matches this query.
      "campaign",
      gate.tenantId,
      id,
      gate.userId,
      gate.effectiveRole,
      gate.enabled ? "network" : "snapshot",
    ],
    enabled:
      (gate.enabled || gate.canReadOfflineSnapshots) &&
      Boolean(gate.tenantId && id && vaultScope),
    networkMode: "always",
    queryFn: async (): Promise<CampaignDetail> =>
      loadOfflineCapableSnapshot<CampaignDetail>({
        canUseNetwork: gate.enabled,
        loadNetwork: async () => {
          const { client } = getClient();
          // The SDK types `get` as the narrower Campaign shape but the API
          // returns the wider detail shape. Cast through unknown to broaden.
          return (await client.campaigns.get(id!)) as unknown as CampaignDetail;
        },
        readSnapshot: () =>
          vaultGetJSON<CampaignDetail>("campaign", id!, {
            ...(vaultScope ? { scope: vaultScope } : {}),
          }),
        writeSnapshot: (campaign) =>
          // The body can be hundreds of KB and the vault caps an entry; the
          // snapshot is for identity, status and audience, not for reading the
          // email offline.
          vaultSetJSON(
            "campaign",
            id!,
            { ...campaign, body_html: undefined, body_mjml: undefined },
            { ...(vaultScope ? { scope: vaultScope } : {}) },
          ),
        networkAvailable: isProbablyOnline,
        unavailableMessage:
          "No saved copy of this campaign is available offline.",
      }),
  });
}

/**
 * Returns null only when the report endpoint is genuinely optional/missing on
 * older deployments. Auth, network, and 5xx failures rethrow so the detail
 * screen and query retry path see real errors.
 */
function optionalReportStatus(err: unknown): number {
  if (err && typeof err === "object" && "status" in err) {
    return Number((err as { status?: unknown }).status) || 0;
  }
  return 0;
}

function isOptionalReportError(err: unknown): boolean {
  const status = optionalReportStatus(err);
  return status === 404 || status === 405 || status === 501;
}

/**
 * Per-campaign report.
 *
 * `status` is accepted so a campaign that is ACTIVELY SENDING re-reads itself
 * on a bounded cadence. Without it a campaign in `sending` looked identical to
 * one that had finished — the same frozen tiles — at the exact moment an
 * operator most wants their phone. Polling only runs while the app is
 * foregrounded: TanStack's focusManager is bridged to AppState in
 * src/lib/connectivity.ts and `refetchIntervalInBackground` is left false.
 *
 * THE POLL IS THE FLOOR, NOT THE CEILING. While a send is live, the SSE
 * stream at `/campaigns/{id}/events` is opened alongside it
 * (hooks/useCampaignReportStream) and writes fresh reports into THIS query's
 * cache entry, so the numbers move at the server's 2s cadence instead of 10s.
 * The poll below is deliberately unchanged: every way the stream can fail —
 * no stream token, a 401, a tunnel — lands back on exactly the behaviour that
 * shipped before it, with nothing in the UI branching on which source won.
 */
export function useCampaignReport(
  id: string | undefined,
  options: { status?: string | null | undefined } = {},
) {
  const gate = useOnlineQueryGate();
  const live = isLiveSendStatus(options.status);
  useCampaignReportStream(id, { live });
  return useQuery({
    queryKey: ["campaign-report", gate.tenantId, id],
    enabled: gate.enabled && Boolean(gate.tenantId && id),
    ...(live ? { refetchInterval: LIVE_SEND_POLL_MS } : {}),
    queryFn: async (): Promise<CampaignReport | null> => {
      const { client } = getClient();
      try {
        const res = await client.request<CampaignReport>(
          "GET",
          `/api/v1/campaigns/${encodeURIComponent(id!)}/report`,
        );
        return res ?? null;
      } catch (err) {
        if (!isOptionalReportError(err)) throw err;
        return null;
      }
    },
  });
}

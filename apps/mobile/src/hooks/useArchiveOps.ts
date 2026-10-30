/**
 * useArchiveOps — the published-issue index, paged and SEARCHED on the server.
 *
 * The old hook fetched one 50-row page, threw away `nextCursor`, and let the
 * screen filter that page client-side. A five-year weekly newsletter has ~260
 * issues, so searching for anything from year one produced an authoritative
 * "Nothing matches" — while the backend had supported `q` all along
 * (apps/api/internal/archive/archive.go AdminList → listsearch.ReadQuery,
 * repo ANDs `subject ILIKE '%'||$n||'%' OR archive_slug ILIKE …`).
 *
 * The first page is snapshot-backed so the index survives airplane mode;
 * subsequent cursor pages need the network, which is correct — an offline
 * "load more" cannot invent rows it never fetched.
 *
 * Endpoints:
 *   GET  /api/v1/archive?limit=&cursor=&q=
 *   GET  /api/v1/admin/archive/tenant-settings
 *   GET  /api/v1/archive/stats
 *   GET  /api/v1/admin/archive/issues/{slug}/preview   (read:reports|admin)
 *   POST /api/v1/campaigns/{id}/unpublish-archive      (admin)
 *
 * The last two are mounted in Go (archive.go MountAdminRoutes :649/:654) but
 * neither is in openapi.json, so neither exists on the generated SDK surface —
 * both go through `client.request` directly, which is what desktop does too.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { archiveIssuesQueryRootKey } from "@/lib/detailSeedKeys";
import { getClient } from "@/api/sdkClient";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isProbablyOnline } from "@/lib/connectivity";
import {
  parseArchiveIssuePreview,
  parseArchivePage,
  parseArchiveTenantSettings,
  type ArchiveIssue,
  type ArchiveIssuePreview,
  type ArchivePage,
  type ArchiveTenantSettings,
} from "@/lib/archiveContracts";
import {
  loadSnapshotBacked,
  snapshotScope,
} from "@/lib/deliverabilitySnapshots";

export type {
  ArchiveIssue,
  ArchiveIssuePreview,
  ArchivePage,
  ArchiveTenantSettings,
};

const PAGE_SIZE = 50;

/** Server-side search needs at least this much to be worth a round trip. */
export const ARCHIVE_SEARCH_MIN = 2;

function archivePath(cursor: string | null, query: string): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) params.set("cursor", cursor);
  if (query) params.set("q", query);
  return `/api/v1/archive?${params.toString()}`;
}

/**
 * A page plus where it came from. The screen needs the provenance on the FIRST
 * page to render "Cached · 3h ago"; without it a vault read renders as a
 * successful live fetch and day-old issues pass themselves off as current.
 */
export type ArchivePageBacked = ArchivePage & {
  fromSnapshot: boolean;
  capturedAt: number | null;
};

export function useArchiveIssues(rawQuery = "") {
  const gate = useOnlineQueryGate();
  const scope = snapshotScope(gate);
  const query = rawQuery.trim();
  const searching = query.length >= ARCHIVE_SEARCH_MIN;
  const effectiveQuery = searching ? query : "";

  return useInfiniteQuery({
    queryKey: [
      ...archiveIssuesQueryRootKey(gate.tenantId),
      gate.userId,
      gate.enabled ? "network" : "snapshot",
      effectiveQuery || "all",
    ],
    enabled: gate.canReadOfflineSnapshots,
    networkMode: "always",
    initialPageParam: null as string | null,
    getNextPageParam: (last: ArchivePageBacked) => last.nextCursor,
    queryFn: async ({ pageParam }): Promise<ArchivePageBacked> => {
      const cursor = pageParam as string | null;
      // Only the first, unfiltered page is worth keeping offline.
      if (cursor === null && !effectiveQuery) {
        const backed = await loadSnapshotBacked<ArchivePage>({
          resource: "archive-index",
          scope,
          canUseNetwork: gate.enabled,
          loadNetwork: async () => {
            const { client } = getClient();
            return parseArchivePage(
              await client.request<unknown>("GET", archivePath(null, "")),
            );
          },
          unavailableMessage:
            "No saved copy of your archive is available offline.",
        });
        // RE-PARSE THE VAULT COPY. `loadSnapshotBacked` validates only that the
        // stored envelope carries a numeric `capturedAt` (deliverabilitySnapshots
        // `isStored`) and then CASTS `value` to the requested type — so a
        // snapshot written by an older build, or a partial write, reaches the
        // screen as an "ArchivePage" whose `items` is not an array. The screen
        // flatMaps it and the archive route tears down on `row.subject`. The
        // network branch below has always gone through `parseArchivePage`;
        // the offline branch has to as well, or the guard only covers the path
        // that was never the risk.
        const page = backed.fromSnapshot
          ? parseArchivePage(backed.value)
          : backed.value;
        // A cached page cannot be paged past — its cursor points at rows the
        // device never fetched, so "load more" would fail silently.
        return {
          items: page.items,
          nextCursor: backed.fromSnapshot ? null : page.nextCursor,
          fromSnapshot: backed.fromSnapshot,
          capturedAt: backed.capturedAt ?? null,
        };
      }
      const { client } = getClient();
      const page = parseArchivePage(
        await client.request<unknown>(
          "GET",
          archivePath(cursor, effectiveQuery),
        ),
      );
      return { ...page, fromSnapshot: false, capturedAt: Date.now() };
    },
  });
}

/**
 * The two columns the PUBLIC archive resolver actually matches on. Without
 * these mobile cannot build a working public link — see src/lib/archiveLinks.ts.
 */
export function useArchiveTenantSettings() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["archive-tenant-settings", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<ArchiveTenantSettings> => {
      const { client } = getClient();
      return parseArchiveTenantSettings(
        await client.request<unknown>(
          "GET",
          "/api/v1/admin/archive/tenant-settings",
        ),
      );
    },
  });
}

/**
 * The rollup behind the header line. The wire keys are `totalIssues`,
 * `views30d` and `uniqueVisitors30d` (archive.Stats in views.go) — an earlier
 * draft of this hook guessed `issues`/`views`/`uniqueVisitors` and would have
 * rendered "0 issues · 0 views" on a healthy workspace. The aliases below are
 * kept as fallbacks, but the real names come first.
 */
export interface ArchiveStats {
  issues: number;
  pinned: number;
  views: number;
  uniqueVisitors: number;
}

export function useArchiveStats() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["archive-stats", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ArchiveStats> => {
      const { client } = getClient();
      const raw = (await client.request<unknown>(
        "GET",
        "/api/v1/archive/stats",
      )) as Record<string, unknown> | null;
      const read = (...keys: string[]): number => {
        for (const key of keys) {
          const value = raw?.[key];
          if (typeof value === "number" && Number.isFinite(value)) return value;
          if (typeof value === "string" && value.trim() !== "") {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) return parsed;
          }
        }
        return 0;
      };
      return {
        issues: read("totalIssues", "issues", "issueCount"),
        pinned: read("pinnedIssues", "pinned"),
        views: read("views30d", "views", "viewCount"),
        uniqueVisitors: read("uniqueVisitors30d", "uniqueVisitors", "visitors"),
      };
    },
  });
}

/**
 * The ADMIN preview of one issue — subject, authorship and the rendered body,
 * read straight from the workspace rather than from the public archive host.
 *
 * This is the only way to see what actually went out when the tenant has no
 * public archive routing configured, which is exactly the situation in which
 * the public link 404s. Deliberately NOT snapshot-backed: an issue body is
 * large, rarely re-read, and a stale copy of "what we published" is a worse
 * answer than an honest offline refusal.
 */
export function useArchiveIssuePreview(slug: string | null) {
  const gate = useOnlineQueryGate();
  const target = (slug ?? "").trim();
  return useQuery({
    queryKey: ["archive-issue-preview", gate.tenantId, target],
    enabled: gate.enabled && Boolean(gate.tenantId) && target.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ArchiveIssuePreview> => {
      const { client } = getClient();
      return parseArchiveIssuePreview(
        await client.request<unknown>(
          "GET",
          `/api/v1/admin/archive/issues/${encodeURIComponent(target)}/preview`,
        ),
      );
    },
  });
}

/**
 * Unpublishing needs a connection. It is the "the wrong link went out, pull it
 * now" lever, and a write that silently queues until the phone finds signal is
 * the opposite of what the operator asked for — they need to know whether the
 * issue is down.
 */
export class ArchiveOfflineError extends Error {
  readonly code = "offline_write_refused";

  constructor() {
    super("Unpublishing needs a connection. Reconnect and try again.");
    this.name = "ArchiveOfflineError";
  }
}

/**
 * The row carries no campaign id when the server predates the admin list's
 * `campaignId` projection. Named so the screen can explain the refusal instead
 * of POSTing to `/api/v1/campaigns//unpublish-archive`, which chi resolves to a
 * different route entirely.
 */
export class ArchiveCampaignUnknownError extends Error {
  readonly code = "campaign_id_missing";

  constructor() {
    super(
      "This issue didn't come with a campaign id, so it can't be unpublished from the app. Use the web admin.",
    );
    this.name = "ArchiveCampaignUnknownError";
  }
}

/**
 * POST /api/v1/campaigns/{id}/unpublish-archive — flips `archive_public` to
 * false so the public page and the RSS entry both stop resolving.
 *
 * Guarded by `apikeys.RequireScope(apikeys.ScopeAdmin)` (archive.go:649), which
 * on the session-cookie path means owner/admin only — see
 * apikeys/middleware.go:211 `requireAdminRoleForScopes`. The screen mirrors
 * that floor so a viewer never sees a control that can only 403.
 */
export function useUnpublishArchiveIssue() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (input: { campaignId: string; slug: string }) => {
      if (!input.campaignId) throw new ArchiveCampaignUnknownError();
      if (!isProbablyOnline()) throw new ArchiveOfflineError();
      const { client } = getClient();
      await client.request<unknown>(
        "POST",
        `/api/v1/campaigns/${encodeURIComponent(input.campaignId)}/unpublish-archive`,
      );
      return input;
    },
    onSuccess: (input) => {
      // The row disappears from the index and the stats rollup changes; the
      // preview for that slug is now a 404, so drop it rather than serve a
      // cached body for an issue that is no longer public.
      void queryClient.invalidateQueries({ queryKey: ["archive", tenantId] });
      void queryClient.invalidateQueries({
        queryKey: ["archive-stats", tenantId],
      });
      queryClient.removeQueries({
        queryKey: ["archive-issue-preview", tenantId, input.slug],
      });
    },
  });
}

/**
 * The three archive verbs mobile lacked, alongside the unpublish it already had.
 *
 * M5 — the asymmetry was the wrong way round. A phone could RETRACT an issue and
 * not restore it, which is the worse half to be missing: an accidental or panicked
 * unpublish stranded the operator until they found a desk. All four routes are
 * mounted together at archive.go:729-732 behind the same admin scope, so there was
 * never a server-side reason for the split.
 *
 *   POST /api/v1/campaigns/{id}/publish-archive    put the issue back
 *   POST /api/v1/campaigns/{id}/archive/pin        feature it on the index
 *   POST /api/v1/campaigns/{id}/archive/unpin
 */
type ArchiveWriteVerb = "archive/pin" | "archive/unpin";

function useArchiveWrite(verb: ArchiveWriteVerb) {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (input: { campaignId: string; slug: string }) => {
      // An empty id would POST to /api/v1/campaigns//publish-archive, which chi
      // resolves to a DIFFERENT route — the trap this file already documents.
      if (!input.campaignId) throw new ArchiveCampaignUnknownError();
      if (!isProbablyOnline()) throw new ArchiveOfflineError();
      const { client } = getClient();
      await client.request<unknown>(
        "POST",
        `/api/v1/campaigns/${encodeURIComponent(input.campaignId)}/${verb}`,
      );
      return input;
    },
    onSuccess: (input) => {
      void queryClient.invalidateQueries({ queryKey: ["archive", tenantId] });
      void queryClient.invalidateQueries({
        queryKey: ["archive-stats", tenantId],
      });
      // Publishing makes a previously-404 preview resolve, and pinning changes the
      // index ordering; in both directions the cached preview is now wrong.
      queryClient.removeQueries({
        queryKey: ["archive-issue-preview", tenantId, input.slug],
      });
    },
  });
}

/**
 * NO usePublishArchiveIssue, and this absence is load-bearing.
 *
 * One existed, was exported, and was pinned in place by a contract test
 * asserting "mobile exports all four verbs the server mounts together". It
 * could never have worked. `useArchiveWrite` posts with NO BODY, while
 * `AdminPublish` (archive.go) decodes a `PublishInput` and answers 422
 * `slug_required` when the slug is empty — then validates excerpt, meta
 * description, author name, OG image, hero image and canonical URL. Every call
 * would have failed on the first check.
 *
 * `app/(tabs)/archive.tsx` had already reasoned its way to the same place from
 * the product side ("re-publishing needs the slug, excerpt and SEO fields the
 * phone never collected, so an 'Undo' here could only ever half-restore the
 * issue") and declined to offer the undo. That comment was right.
 *
 * It is also consistent with `lib/stoppingHalfPolicy`: unpublish is the
 * STOPPING half and ships here; publish is the STARTING half, needs a form
 * this platform does not have, and stays on a desk.
 *
 * The verb set below is therefore the three that take no body and work.
 */

/** Feature an issue at the top of the public index. */
export function usePinArchiveIssue() {
  return useArchiveWrite("archive/pin");
}

/** Remove the feature. */
export function useUnpinArchiveIssue() {
  return useArchiveWrite("archive/unpin");
}

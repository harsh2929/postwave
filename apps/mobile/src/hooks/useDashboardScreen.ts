/**
 * hooks/useDashboardScreen.ts — everything the dashboard READS, in one place.
 *
 * The screen's own header claims it is "composition only". It had stopped
 * being that: six queries, a preference, a failure taxonomy, an audit-fallback
 * decision, a telemetry effect and a widget mirror all lived inside the
 * component, which is how a screen quietly becomes untestable.
 *
 * Everything here is data. Nothing here renders, and nothing here decides
 * layout — the screen still owns all of that.
 *
 * The two decisions worth keeping visible:
 *
 *  - THE AUDIT QUERY IS A FALLBACK, BUT IT DOES NOT WAIT ON STATS. It is still
 *    a fallback in the sense that `stats.recent_audit` WINS when it is present
 *    — but it never is: `DashboardStats.RecentAudit` is `omitempty` and nothing
 *    in apps/api/internal/analytics ever assigns it, which is what the
 *    `auditFailed` note below already says. Gating the fallback on "stats has
 *    come back without it" therefore did not save a request in production; it
 *    only put the activity feed one full round trip behind the tiles on the
 *    landing screen, on every launch (nothing is persisted — `shouldPersistQuery`
 *    returns false, so stats is always cold). The gate is now the payload
 *    check alone, so the two reads go out together and the preference for
 *    `recent_audit` is unchanged.
 *  - A FAILURE IS REPORTED ONCE PER FAILURE, not once per render. The
 *    telemetry effect is keyed on the taxonomy kind + status, so a session
 *    stuck on a 503 emits one event rather than one every thirty seconds.
 */
import { useEffect, useMemo } from "react";

import { cachedSessionNotice } from "@/components/CachedSessionNotice";
import { useAuditLog } from "@/hooks/useAudit";
import { usePendingApprovalsPublishable } from "@/hooks/useApprovals";
import { useCampaignsList } from "@/hooks/useCampaigns";
import {
  DEFAULT_DASHBOARD_RANGE,
  isDashboardRange,
  mapAuditRowToDashboardEvent,
  useDashboardStatsQuery,
  type DashboardRange,
} from "@/hooks/useDashboard";
import { useDashboardAnomalies } from "@/hooks/useDashboardAnomalies";
import { useDashboardLayoutOrder } from "@/hooks/useDashboardLayout";
import { useGoalsProgress } from "@/hooks/useGoals";
import { useListPreferences } from "@/hooks/useListPreferences";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useWidgetMirror } from "@/hooks/useWidgetMirror";
import { isProbablyOnline } from "@/lib/connectivity";
import { classifyDashboardFailure, hidesMetrics } from "@/lib/dashboardFailure";
import { dashboardNeedsAuditFallback } from "@/lib/dashboardStatsSchema";
import {
  parseHiddenTiles,
  resolveTileOrder,
  serialiseHiddenTiles,
  toggleHiddenTile,
  type MobileTileKey,
} from "@/lib/dashboardLayout";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { track } from "@/lib/telemetry";
import { useAuthStore } from "@/store/auth";
import { EVENTS } from "@postwave/telemetry";

export interface DashboardScreenOptions {
  /** Whether the tab is on screen. Suspends polling and the freshness clock. */
  focused: boolean;
}

export function useDashboardScreen({ focused }: DashboardScreenOptions) {
  const onlineGate = useOnlineQueryGate();
  const gateNotice = cachedSessionNotice({
    gateEnabled: onlineGate.enabled,
    hasTenant: Boolean(onlineGate.tenantId),
    surface: "dashboard",
  });

  const [prefs, setPrefs, prefsState] = useListPreferences("dashboard", {
    range: DEFAULT_DASHBOARD_RANGE as string,
    hiddenTiles: "",
  });
  const range: DashboardRange = isDashboardRange(prefs.range)
    ? prefs.range
    : DEFAULT_DASHBOARD_RANGE;

  // ORDER is a per-user server preference shared with the desktop; VISIBILITY
  // is a device preference. Two authorities, two properties, no overlap — the
  // reasoning is in lib/dashboardLayout.ts.
  const layout = useDashboardLayoutOrder();
  const tileOrder = useMemo(
    () => resolveTileOrder(layout.data ?? null),
    [layout.data],
  );
  const hiddenTiles = useMemo(
    () => parseHiddenTiles(prefs.hiddenTiles),
    [prefs.hiddenTiles],
  );

  const stats = useDashboardStatsQuery({ range, focused });
  const campaigns = useCampaignsList();
  // A payload question, not a timing one — see dashboardNeedsAuditFallback for
  // why the old `!stats.isLoading &&` term cost a round trip and bought nothing.
  const auditFallbackNeeded = dashboardNeedsAuditFallback(stats.data);
  const audit = useAuditLog(6, undefined, { enabled: auditFallbackNeeded });
  const anomalies = useDashboardAnomalies();
  const goals = useGoalsProgress();

  const mode = useAuthStore((s) => s.mode);
  const tenantId = useAuthStore((s) => s.tenantId ?? s.session?.tenantId);
  const workspaceName = useAuthStore((s) => s.session?.workspaceName);

  const failure = stats.isError
    ? classifyDashboardFailure(stats.error, { online: isProbablyOnline() })
    : null;
  const failureKind = failure?.kind ?? null;
  const failureStatus = failure?.status ?? 0;
  useEffect(() => {
    if (!failureKind) return;
    track(EVENTS.MOBILE_DASHBOARD_ERROR, {
      kind: failureKind,
      status_code: failureStatus,
      range,
    });
  }, [failureKind, failureStatus, range]);

  const statsRecentAudit = stats.data?.recent_audit;
  const auditEvents = useMemo(
    () =>
      Array.isArray(statsRecentAudit)
        ? statsRecentAudit
        : // Infinite query: flatten the cursor pages before mapping. The
          // dashboard only ever shows the newest few, so page one is enough.
          audit.data?.pages
            .flatMap((page) => page.rows)
            .map(mapAuditRowToDashboardEvent),
    [audit.data, statsRecentAudit],
  );

  // GET /api/v1/approvals is owner/admin-only (requireAdmin in
  // approvals/handlers.go), so this was firing a guaranteed 403 every 60s for
  // every editor and viewer with the dashboard open — and then publishing the
  // resulting "0" to the home-screen widget as if the queue were empty.
  // Gated on the role, and NULL (not 0) whenever the answer is unknown.
  const pendingApprovals = usePendingApprovalsPublishable(
    canAccessMinimumRole("admin", onlineGate.effectiveRole, mode),
  );
  useWidgetMirror({ stats: stats.data, workspaceName, pending: pendingApprovals });

  return {
    onlineGate,
    gateNotice,
    range,
    setRange: (next: DashboardRange) => setPrefs({ range: next }),
    /** Tile render order, honouring the layout saved for this account. */
    tileOrder,
    /** Tiles hidden on THIS device. */
    hiddenTiles,
    toggleTile: (tile: MobileTileKey) =>
      setPrefs({
        hiddenTiles: serialiseHiddenTiles(
          toggleHiddenTile(tileOrder, hiddenTiles, tile),
        ),
      }),
    /**
     * The picker is offered only once the stored preference has been read. It
     * is an async disk read, so opening the sheet before it lands would show
     * an empty hidden set and a first toggle would silently discard whatever
     * was stored.
     */
    tilePrefsReady: prefsState.hydrated,
    /** True once the account's saved order has actually been read back. */
    tileOrderFromServer: Array.isArray(layout.data) && layout.data.length > 0,
    stats,
    campaigns,
    anomalies,
    goals,
    auditEvents,
    auditLoading:
      stats.isLoading || (!Array.isArray(statsRecentAudit) && audit.isLoading),
    /**
     * The feed's fetch failed and there is nothing to show for it.
     *
     * Not a corner case: the dashboard handler declares `recent_audit` with
     * `omitempty` and deliberately never populates it, so this fallback query
     * IS the feed in production. Without this flag a 403 (no `audit:read`) or a
     * 5xx renders "No recent activity." on the landing screen.
     */
    auditFailed:
      !Array.isArray(statsRecentAudit) &&
      audit.isError &&
      !audit.data?.pages.length,
    failure,
    /** A restricted or lapsed session must not paint a grid of em-dashes. */
    restricted: hidesMetrics(failure),
    /** Offline with nothing cached: em-dashes rather than stale zeros. */
    metricsBlocked: Boolean(gateNotice && !stats.data),
    workspaceName,
    // Prefer the human-readable workspace name; the tenant UUID is an opaque
    // fallback only when the name isn't on the session (e.g. API-key mode).
    headerSubtitle: workspaceName || tenantId || undefined,
  };
}

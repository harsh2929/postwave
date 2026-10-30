/**
 * useWidgetBackgroundRefresh — registers the OS background task and supplies
 * the work it performs (DASHBOARD#50 / NATIVE#19).
 *
 * The task body lives HERE rather than in `lib/widgetBackgroundRefresh.ts`
 * because it needs the API client and the same `pick*` helpers the dashboard
 * screen uses; keeping the OS wiring in a module with no app dependencies is
 * what lets that module stay a thin, reviewable boundary.
 *
 * Ordering inside the work function is the whole safety argument:
 *
 *   1. CONSENT BEFORE NETWORK. `getWidgetMetricsEnabled()` reads the App Group
 *      synchronously. If the user has not opted in — or logout/app-lock has
 *      revoked it — the task ends without a request, so a background wake can
 *      never fetch workspace data for a widget that is not allowed to show it.
 *   2. IDENTITY BEFORE REQUEST. A background launch starts with an unhydrated
 *      auth store; without the await, `getClient()` would build a client with
 *      no credentials and 401.
 *   3. APPROVALS ARE ROLE-GATED. GET /api/v1/approvals calls `requireAdmin`
 *      (approvals/handlers.go:226), so a non-admin must not request it — a
 *      background 403 every couple of hours is exactly the kind of silent
 *      noise nobody would ever notice. Their widget keeps the pending figure
 *      it already had rather than being told there are none.
 */
import { useEffect } from "react";

import { getClient } from "@/api/client";
import { fetchCommerceAnalytics } from "@/api/commerce";
import {
  dashboardStatsPath,
  pickCampaignsSent30d,
  pickOpenRate,
  pickSubscribersTotal,
} from "@/hooks/useDashboard";
import { parseDashboardStats } from "@/lib/dashboardStatsSchema";
import { parseDeliverabilityHub } from "@/lib/deliverabilityContracts";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import {
  defineWidgetRefreshTask,
  registerWidgetRefreshTask,
  setWidgetRefreshWork,
  unregisterWidgetRefreshTask,
} from "@/lib/widgetBackgroundRefresh";
import {
  clearCommerceWidgetSnapshot,
  readPublishedCommerceStoreId,
  readPublishedCommerceStoreLabel,
  writeCommerceWidgetSnapshot,
} from "@/lib/widgetCommerce";
import {
  clearDeliverabilityWidgetSnapshot,
  hasPublishedDeliverabilityWidget,
  writeDeliverabilityWidgetSnapshot,
} from "@/lib/widgetDeliverability";
import { computedAtMs } from "@/lib/widgetDeliverabilitySnapshot";
import {
  getWidgetMetricsEnabled,
  readPublishedWidgetPending,
  writeWidgetSnapshot,
} from "@/lib/widgetData";
import { useAuthStore } from "@/store/auth";

/** Pending approvals, or null when we must not or could not ask. */
async function readPendingApprovals(canDecide: boolean): Promise<number | null> {
  if (!canDecide) return null;
  try {
    const { client } = getClient();
    const res = await client.request<unknown>(
      "GET",
      "/api/v1/approvals?status=pending",
    );
    if (Array.isArray(res)) return res.length;
    const items = (res as { items?: unknown } | null)?.items;
    return Array.isArray(items) ? items.length : null;
  } catch {
    return null;
  }
}

/**
 * Re-read the ONE store the person already chose on the Stores tab, and
 * re-stamp the widget's commerce record with the time the answer landed.
 *
 * WHY THIS IS SAFE FOR EVERY ROLE, unlike the approvals read above. The store
 * the record names comes out of the App Group, so this never calls
 * `GET /api/v1/commerce/integrations` — which is `RequireScope(ScopeAdmin)`
 * (commerce/handlers.go:138) and, on the session path, a hard owner/admin role
 * check (apikeys/middleware.go:211-220). The route it DOES call,
 * `GET /{id}/analytics`, is `ScopeReadReports` (:166), which is in the
 * read-only allowlist (middleware.go:332-337) and therefore clears any session
 * that could have opened the screen in the first place. No role gate is needed
 * and none is invented.
 *
 * WHY IT EXISTS AT ALL: without it the commerce record is only ever written
 * while somebody is looking at the Stores tab, so the home screen would carry
 * whatever was true the last time anyone opened it. The record states its own
 * age either way — this is what keeps that age small.
 *
 * A 404 PURGES rather than waits out the twelve-hour expiry: the integration
 * has been deleted, and totals for a shop that no longer exists are not a
 * stale measurement, they are a wrong one.
 */
async function refreshCommerceInBackground(): Promise<boolean> {
  const storeId = readPublishedCommerceStoreId();
  // Nothing has ever been published, so there is no store to refresh and no
  // way to pick one from here. The widget says "open Stores in Moosewave".
  if (!storeId) return false;
  const storeLabel = readPublishedCommerceStoreLabel();
  if (!storeLabel) return false;
  try {
    const analytics = await fetchCommerceAnalytics(storeId);
    return (
      writeCommerceWidgetSnapshot({
        storeId,
        storeLabel,
        orders: analytics.orders,
        revenueCents: analytics.revenueCents,
        currency: analytics.currency,
        // "Now" is the truth here and only here: the response landed on this
        // line. The foreground mirror cannot say that, which is why it uses
        // the query's own `dataUpdatedAt` instead.
        measuredAtMs: Date.now(),
      }) !== null
    );
  } catch (err) {
    if (Number((err as { status?: unknown } | null)?.status) === 404) {
      clearCommerceWidgetSnapshot();
    }
    return false;
  }
}

/**
 * Re-read the workspace's sender health and re-stamp the widget's third record.
 *
 * WHY IT IS GATED ON AN EXISTING RECORD, exactly like the commerce refresh
 * above. `GET /api/v1/deliverability/hub` is `RequireScope(ScopeReadReports)`
 * (deliverability_hub/handlers.go:36), a read-only scope any session that could
 * open the Deliverability tab already clears — so no ROLE gate is needed and
 * none is invented. What the gate buys is restraint: a background wake refreshes
 * what somebody has already asked to see rather than speculatively pulling a
 * workspace-health report onto a device whose owner has never opened that tab.
 *
 * A 403 PURGES rather than waiting out the twelve-hour expiry: the session's
 * scope has changed under it, and a score somebody may no longer read must not
 * sit on their home screen for another half day.
 *
 * `computed_at` is the measurement time — see useDeliverabilityWidgetMirror.
 * A response without one publishes nothing.
 */
async function refreshDeliverabilityInBackground(): Promise<boolean> {
  if (!hasPublishedDeliverabilityWidget()) return false;
  try {
    const { client } = getClient();
    const hub = parseDeliverabilityHub(
      await client.request<unknown>("GET", "/api/v1/deliverability/hub"),
    );
    return (
      writeDeliverabilityWidgetSnapshot({
        score: hub.score,
        grade: hub.grade,
        status: hub.status,
        autoThrottled: hub.autoThrottled,
        breaches: hub.breaches.length,
        sends7d: hub.sends7d,
        measuredAtMs: computedAtMs(hub.computedAt),
      }) !== null
    );
  } catch (err) {
    if (Number((err as { status?: unknown } | null)?.status) === 403) {
      clearDeliverabilityWidgetSnapshot();
    }
    return false;
  }
}

async function refreshWidgetInBackground(): Promise<boolean> {
  // 1. Consent, before anything touches the network.
  if (!getWidgetMetricsEnabled()) return false;

  // 2. Identity. A background launch has an empty store until this resolves.
  const store = useAuthStore.getState();
  if (!store.hydrated) {
    await store.hydrate().catch(() => undefined);
  }
  const after = useAuthStore.getState();
  if (!after.canUseOnlineServices()) return false;

  // Three independent records in one container (lib/widgetCommerceSnapshot.ts,
  // lib/widgetDeliverabilitySnapshot.ts). Sequenced rather than raced so a
  // background wake makes at most one request at a time, and kept out of the
  // try below so a dashboard failure cannot cancel them — any one of the three
  // succeeding is a useful wake.
  const commerceRefreshed = await refreshCommerceInBackground();
  const deliverabilityRefreshed = await refreshDeliverabilityInBackground();
  const sideRefreshed = commerceRefreshed || deliverabilityRefreshed;

  try {
    const { client } = getClient();
    const stats = parseDashboardStats(
      await client.request<unknown>("GET", dashboardStatsPath({})),
    );
    // 3. Role gate — see the module note.
    const pending = await readPendingApprovals(
      canAccessMinimumRole(
        "admin",
        after.session?.effectiveRole ?? null,
        after.mode,
      ),
    );
    // The App Group contract has no "unknown" for pending, and publishing a
    // zero we never measured would tell a governance surface there is nothing
    // to decide. Carry the last PUBLISHED value forward; if there has never
    // been one, write nothing and leave the previous snapshot (which still
    // shows real numbers, with their own age) in place.
    const publishablePending = pending ?? readPublishedWidgetPending();
    if (publishablePending === null) return sideRefreshed;

    const openRate = pickOpenRate(stats);
    const wroteDashboard = writeWidgetSnapshot({
      subscribers: pickSubscribersTotal(stats),
      openRate: openRate === null ? null : openRate * 100,
      sent30d: pickCampaignsSent30d(stats),
      pending: publishablePending,
      // Same source the foreground mirror uses (useDashboardScreen), so a
      // background write can never relabel the widget's header.
      workspace: after.session?.workspaceName || after.tenantId || "Moosewave",
    });
    // Any record landing makes this a wake worth having done.
    return wroteDashboard || sideRefreshed;
  } catch {
    return sideRefreshed;
  }
}

/**
 * Define the OS-facing task and install the work it performs.
 *
 * MUST be called from MODULE SCOPE — it is invoked from `app/_layout.tsx`
 * beside `initSentry()` and `registerOfflineMutationDefaults()`, which are
 * there for the same reason. Both halves used to live in `useEffect`s inside
 * `useWidgetBackgroundRefresh`, which is mounted by `ShellLifecycle` BELOW the
 * launch gate's `if (!proceed) return null`. A `BGAppRefreshTask` wake runs the
 * bundle and then asks TaskManager for the handler; the app's own hydration,
 * splash and gate sit between that and the first effect, so the OS could find
 * no task at all — or find one whose `work` was still null, which the handler
 * reports as `Failed` (lib/widgetBackgroundRefresh.ts). Repeated failures cost
 * future scheduling budget, so the widget got quieter the less it worked.
 *
 * Defining costs nothing and reaches no network: the task body re-checks
 * consent and identity on every run. SCHEDULING stays in the hook below,
 * because that genuinely needs an authenticated identity to decide.
 * Idempotent — a background launch re-executes module scope.
 */
export function installWidgetRefreshTask(): void {
  setWidgetRefreshWork(refreshWidgetInBackground);
  defineWidgetRefreshTask();
}

export function useWidgetBackgroundRefresh(): void {
  const canEnterApp = useAuthStore((s) => s.canEnterApp());

  useEffect(() => {
    if (!canEnterApp) {
      void unregisterWidgetRefreshTask();
      return;
    }
    // Belt and braces: `app/_layout.tsx` already did this at module scope, and
    // the call is idempotent. It is repeated here so that scheduling a task
    // whose handler has no work — the failure the module-scope call exists to
    // prevent — cannot be reintroduced by mounting this hook from anywhere
    // else.
    installWidgetRefreshTask();
    // Registration is idempotent, and the task itself re-checks consent on
    // every run, so there is nothing to undo when the user toggles the widget
    // off — the next wake simply does no work.
    void registerWidgetRefreshTask();
  }, [canEnterApp]);
}

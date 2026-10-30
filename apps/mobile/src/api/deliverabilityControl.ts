/**
 * api/deliverabilityControl.ts — the sending-infrastructure control surface
 * (KLV-14 spine, apps/api/internal/deliverability_control).
 *
 *   GET /api/v1/deliverability-control/domain-setups    (viewer)
 *   GET /api/v1/deliverability-control/click-tracking   (viewer)
 *   GET /api/v1/deliverability-control/ip-routing       (viewer)
 *   GET /api/v1/deliverability-control/entitlements     (viewer)
 *
 * Desktop's WIRED panel (DeliverabilityControlPanel.tsx) is read-only — its
 * only verbs are refresh and navigation — so read-parity is full parity with
 * what desktop actually ships. The admin PUTs exist server-side but no client
 * drives them; mirroring that here keeps the two clients agreeing about what
 * an operator can change from a screen.
 */
import { rawRequest, type AIApiError } from "./request";

import { itemsOf, numberOr, str, WireShapeError } from "@/lib/deliverabilityContracts";

class ControlError extends Error {
  readonly status: number;

  constructor(error: AIApiError, fallback: string) {
    super(error.message || fallback);
    this.name = "ControlError";
    this.status = error.status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ControlDomainSetup {
  domain: string;
  setupMode: string;
  status: string;
  sslStatus: string;
  routingStatus: string;
}

/** `{items: [...]}` — deliverability_control.go:186. */
export async function fetchControlDomainSetups(): Promise<ControlDomainSetup[]> {
  const res = await rawRequest<unknown>(
    "GET",
    "/api/v1/deliverability-control/domain-setups",
  );
  if (res.error) {
    throw new ControlError(res.error, "Couldn't load domain setups.");
  }
  if (!isRecord(res.data)) throw new WireShapeError("domain setups");
  const out: ControlDomainSetup[] = [];
  for (const row of itemsOf(res.data.items ?? [], "domain setups")) {
    if (!isRecord(row)) continue;
    const domain = str(row.domain).trim();
    if (!domain) continue;
    out.push({
      domain,
      setupMode: str(row.setup_mode),
      status: str(row.status),
      sslStatus: str(row.ssl_status),
      routingStatus: str(row.routing_status),
    });
  }
  return out;
}

export interface ClickTrackingPolicy {
  trackingDomain: string;
  status: string;
  sslStatus: string;
  disableSyntax: string[];
  /** Timestamp + count of the last untracked-links report; nulls when none. */
  lastUntrackedAt: string;
  lastUntrackedCount: number | null;
}

/** Bare policy object — deliverability_control.go:225. */
export async function fetchClickTrackingPolicy(): Promise<ClickTrackingPolicy> {
  const res = await rawRequest<unknown>(
    "GET",
    "/api/v1/deliverability-control/click-tracking",
  );
  if (res.error) {
    throw new ControlError(res.error, "Couldn't load the click-tracking policy.");
  }
  if (!isRecord(res.data)) throw new WireShapeError("click-tracking policy");
  const report = isRecord(res.data.last_untracked_report)
    ? res.data.last_untracked_report
    : {};
  const untracked = numberOr(report.untracked_links, Number.NaN);
  return {
    trackingDomain: str(res.data.tracking_domain),
    status: str(res.data.status),
    sslStatus: str(res.data.ssl_status),
    disableSyntax: Array.isArray(res.data.disable_syntax)
      ? res.data.disable_syntax.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
    lastUntrackedAt: str(report.created_at) || str(report.scanned_at),
    lastUntrackedCount: Number.isFinite(untracked) ? untracked : null,
  };
}

export interface RoutingPolicy {
  status: string;
  strategy: string;
  dedicatedPool: string;
  sharedPool: string;
  /** Percent 0–100, derived by the server from basis points. */
  effectiveDedicatedPercent: number;
  effectiveSharedPercent: number;
  lastEvaluatedAt: string;
}

/** Bare policy object — deliverability_control.go:270. */
export async function fetchRoutingPolicy(): Promise<RoutingPolicy> {
  const res = await rawRequest<unknown>(
    "GET",
    "/api/v1/deliverability-control/ip-routing",
  );
  if (res.error) {
    throw new ControlError(res.error, "Couldn't load the IP-routing policy.");
  }
  if (!isRecord(res.data)) throw new WireShapeError("IP-routing policy");
  // `omitempty` drops a 0 effective percent; recompute from basis points so
  // "0% dedicated" renders as the number it is instead of a blank.
  const dedicatedBp = numberOr(res.data.dedicated_percentage_bp, 0);
  const effDedicated = numberOr(
    res.data.effective_dedicated_percent,
    dedicatedBp / 100,
  );
  return {
    status: str(res.data.status),
    strategy: str(res.data.strategy),
    dedicatedPool: str(res.data.dedicated_pool),
    sharedPool: str(res.data.shared_pool),
    effectiveDedicatedPercent: Math.max(0, Math.min(100, effDedicated)),
    effectiveSharedPercent: Math.max(
      0,
      Math.min(100, numberOr(res.data.effective_shared_percent, 100 - effDedicated)),
    ),
    lastEvaluatedAt: str(res.data.last_evaluated_at),
  };
}

export interface SendingEntitlement {
  planTier: string;
  periodStart: string;
  inboxTestsMonthly: number;
  inboxTestsUsed: number;
  inboxTestsRemaining: number;
  renderPreviewsMonthly: number;
  renderPreviewsUsed: number;
  renderPreviewsRemaining: number;
  overagePolicy: string;
}

/** Bare entitlement object — deliverability_control.go:306. */
export async function fetchSendingEntitlement(): Promise<SendingEntitlement> {
  const res = await rawRequest<unknown>(
    "GET",
    "/api/v1/deliverability-control/entitlements",
  );
  if (res.error) {
    throw new ControlError(res.error, "Couldn't load sending entitlements.");
  }
  if (!isRecord(res.data)) throw new WireShapeError("sending entitlements");
  return {
    planTier: str(res.data.plan_tier),
    periodStart: str(res.data.period_start),
    inboxTestsMonthly: Math.max(0, numberOr(res.data.inbox_tests_monthly, 0)),
    inboxTestsUsed: Math.max(0, numberOr(res.data.inbox_tests_used, 0)),
    inboxTestsRemaining: Math.max(0, numberOr(res.data.inbox_tests_remaining, 0)),
    renderPreviewsMonthly: Math.max(
      0,
      numberOr(res.data.render_previews_monthly, 0),
    ),
    renderPreviewsUsed: Math.max(0, numberOr(res.data.render_previews_used, 0)),
    renderPreviewsRemaining: Math.max(
      0,
      numberOr(res.data.render_previews_remaining, 0),
    ),
    overagePolicy: str(res.data.overage_policy),
  };
}

// Typed client for the deliverability-control surface — the KLV-14 "spine"
// mounted at /api/v1/deliverability-control/* (apps/api/internal/deliverability_control).
// G-55: 1,174 LOC and 12 mounted routes ran with ZERO UI callers, so operators
// could not see or configure their sending-domain setup, click-tracking domain,
// IP-routing strategy, or inbox-test entitlements from either client. This is
// the client layer the desktop Deliverability > Control panel drives. Shapes
// verified against internal/deliverability_control/deliverability_control.go +
// untracked_reports.go.
import type { ApiRequester, ApiResult } from "./result";

export interface DnsRecord {
  type: string;
  name: string;
  value: string;
  required: boolean;
}

export interface DomainSetup {
  id?: string;
  tenant_id?: string;
  domain: string;
  setup_mode: string;
  status: string;
  dns_records?: DnsRecord[];
  health_checks?: Record<string, unknown>;
  rollback_guidance?: Record<string, unknown>;
  ssl_status: string;
  routing_status: string;
  created_at?: string;
  updated_at?: string;
}

export interface ClickTrackingPolicy {
  tenant_id?: string;
  tracking_domain: string;
  status: string;
  ssl_status: string;
  caa_guidance?: Record<string, unknown>;
  disable_syntax: string[];
  last_untracked_report?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface RoutingPolicy {
  tenant_id?: string;
  status: string;
  strategy: string;
  dedicated_pool: string;
  shared_pool: string;
  dedicated_percentage_bp: number;
  max_dedicated_percentage_bp: number;
  warmup_rules?: Record<string, unknown>;
  last_evaluated_at?: string;
  created_at?: string;
  updated_at?: string;
  effective_dedicated_percent?: number;
  effective_shared_percent?: number;
}

export interface Entitlement {
  tenant_id?: string;
  period_start: string;
  plan_tier: string;
  inbox_tests_monthly: number;
  render_previews_monthly: number;
  inbox_tests_used: number;
  render_previews_used: number;
  overage_policy: string;
  account_controls?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  inbox_tests_remaining: number;
  render_previews_remaining: number;
}

export interface LinkFinding {
  url: string;
  tracked: boolean;
  reason?: string;
  raw_anchor?: string;
}

export interface LinkScanReport {
  links: LinkFinding[];
  total_links: number;
  tracked_links: number;
  untracked_links: number;
}

export interface UntrackedReport {
  id: string;
  campaign_id?: string;
  scanned_at: string;
  total_links: number;
  tracked_links: number;
  untracked_links: number;
  findings: LinkFinding[];
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
}

// DeliverabilityCatalog is the reference set the UI uses to render option lists
// (setup modes, SSL states, routing strategies) with honest runtime status.
export interface DeliverabilityCatalog {
  schema_version: string;
  domain_setup_modes: { key: string; label: string; runtime_status: string }[];
  click_tracking: {
    ssl_states: string[];
    disable_syntax: string[];
    caa_guidance: Record<string, unknown>;
  };
  ip_routing_strategies: string[];
  entitlement_resources: string[];
}

interface Items<T> {
  items: T[];
}

const BASE = "/api/v1/deliverability-control";

function putJson(body: unknown): RequestInit {
  return {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
function postJson(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

// createDeliverabilityControlApi wires typed methods over the 12 mounted routes.
export function createDeliverabilityControlApi(request: ApiRequester) {
  return {
    // GET /catalog — reference option lists + honest runtime status.
    catalog(): Promise<ApiResult<DeliverabilityCatalog>> {
      return request<DeliverabilityCatalog>(`${BASE}/catalog`);
    },

    // GET /domain-setups — the tenant's sending-domain setups.
    listDomainSetups(): Promise<ApiResult<DomainSetup[]>> {
      return request<Items<DomainSetup>>(`${BASE}/domain-setups`).then(
        unwrapItems,
      );
    },

    // POST /domain-setups/validate — dry-run validation without persisting.
    validateDomainSetup(
      setup: DomainSetup,
    ): Promise<ApiResult<ValidationResult>> {
      return request<ValidationResult>(
        `${BASE}/domain-setups/validate`,
        postJson(setup),
      );
    },

    // PUT /domain-setups/{domain} — create or update a sending-domain setup.
    putDomainSetup(
      domain: string,
      setup: DomainSetup,
    ): Promise<ApiResult<DomainSetup>> {
      return request<DomainSetup>(
        `${BASE}/domain-setups/${encodeURIComponent(domain)}`,
        putJson(setup),
      );
    },

    // GET /click-tracking — the tenant's click-tracking-domain policy.
    getClickTracking(): Promise<ApiResult<ClickTrackingPolicy>> {
      return request<ClickTrackingPolicy>(`${BASE}/click-tracking`);
    },

    // PUT /click-tracking — update the click-tracking policy (admin).
    putClickTracking(
      policy: Partial<ClickTrackingPolicy>,
    ): Promise<ApiResult<ClickTrackingPolicy>> {
      return request<ClickTrackingPolicy>(
        `${BASE}/click-tracking`,
        putJson(policy),
      );
    },

    // POST /click-tracking/scan — scan email HTML for untracked links.
    scanLinks(html: string): Promise<ApiResult<LinkScanReport>> {
      return request<LinkScanReport>(
        `${BASE}/click-tracking/scan`,
        postJson({ html }),
      );
    },

    // GET /click-tracking/untracked-reports — history of past link scans.
    listUntrackedReports(): Promise<ApiResult<UntrackedReport[]>> {
      return request<Items<UntrackedReport>>(
        `${BASE}/click-tracking/untracked-reports`,
      ).then(unwrapItems);
    },

    // GET /ip-routing — the shared/dedicated pool routing policy.
    getRoutingPolicy(): Promise<ApiResult<RoutingPolicy>> {
      return request<RoutingPolicy>(`${BASE}/ip-routing`);
    },

    // PUT /ip-routing — update the routing policy (admin).
    putRoutingPolicy(
      policy: Partial<RoutingPolicy>,
    ): Promise<ApiResult<RoutingPolicy>> {
      return request<RoutingPolicy>(`${BASE}/ip-routing`, putJson(policy));
    },

    // GET /entitlements — inbox-test / render-preview quotas + usage.
    getEntitlement(): Promise<ApiResult<Entitlement>> {
      return request<Entitlement>(`${BASE}/entitlements`);
    },

    // PUT /entitlements — update entitlements (admin).
    putEntitlement(
      entitlement: Partial<Entitlement>,
    ): Promise<ApiResult<Entitlement>> {
      return request<Entitlement>(`${BASE}/entitlements`, putJson(entitlement));
    },
  };
}

// unwrapItems flattens the server's {items: T[]} envelope to T[], preserving
// the ApiErr branch unchanged so callers still discriminate on `.error`.
function unwrapItems<T>(res: ApiResult<Items<T>>): ApiResult<T[]> {
  if (res.error) return res;
  const envelope = res.data as unknown as { items?: unknown } | null;
  return { data: envelope?.items as T[] };
}

export type DeliverabilityControlApi = ReturnType<
  typeof createDeliverabilityControlApi
>;

// SPDX-License-Identifier: AGPL-3.0-only
import { api } from "@/lib/api";

type Json = Record<string, unknown>;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/u;
const WRITE_OPTIONS = {
  cache: "no-store" as const,
  requireOnline: true,
  maxAttempts: 1,
} as const;
const object = (value: unknown, label: string): Json => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label} response`);
  }
  return value as Json;
};
const text = (value: unknown, label: string, maxLength = 512): string => {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > maxLength ||
    CONTROL_CHAR.test(value)
  )
    throw new Error(`Invalid ${label}`);
  return value;
};
const count = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error(`Invalid ${label}`);
  return Number(value);
};
const items = (value: unknown, label: string, maxItems: number): unknown[] => {
  if (!Array.isArray(value) || value.length > maxItems)
    throw new Error(`Invalid ${label}`);
  return value;
};
const timestamp = (value: unknown, label: string): string => {
  const parsed = text(value, label, 64);
  if (!Number.isFinite(Date.parse(parsed))) throw new Error(`Invalid ${label}`);
  return parsed;
};

export interface DomainSetup {
  domain: string;
  setup_mode: string;
  status: string;
  ssl_status: string;
  routing_status: string;
}
export interface ClickTracking {
  tracking_domain: string;
  status: string;
  ssl_status: string;
}
export interface RoutingPolicy {
  status: string;
  strategy: string;
  dedicated_percentage_bp: number;
  max_dedicated_percentage_bp: number;
}
export interface Entitlement {
  plan_tier: string;
  inbox_tests_monthly: number;
  inbox_tests_used: number;
  inbox_tests_remaining: number;
  render_previews_monthly: number;
  render_previews_used: number;
  render_previews_remaining: number;
  overage_policy: string;
}
export interface RetryEvent {
  id: string;
  tenant_id: string;
  campaign_id: string;
  subscriber_email: string;
  reason: string;
  status: string;
  retry_after: string;
  attempts: number;
  created_at: string;
  updated_at: string;
}
export interface FeedbackEvent {
  id?: number;
  kind: string;
  esp?: string;
  received_at: string;
}
export interface FeedbackHistory {
  bounces: FeedbackEvent[];
  complaints: FeedbackEvent[];
}
export interface SoftBounceStats {
  disabled_count: number;
  eligible_now: number;
  eligible_suppressions_now: number;
  recovery_window_days: number;
  automatic_reactivation_active: boolean;
}

function domain(v: unknown): DomainSetup {
  const o = object(v, "domain setup");
  return {
    domain: text(o.domain, "domain", 253),
    setup_mode: text(o.setup_mode, "setup mode", 64),
    status: text(o.status, "status", 64),
    ssl_status: text(o.ssl_status, "SSL status", 64),
    routing_status: text(o.routing_status, "routing status", 64),
  };
}
export async function listDomainSetups(): Promise<DomainSetup[]> {
  const o = object(
    await api.get<unknown>("/api/v1/deliverability-control/domain-setups"),
    "domain setups",
  );
  return items(o.items, "domain setup items", 1_000).map(domain);
}
export async function getClickTracking(): Promise<ClickTracking> {
  const o = object(
    await api.get<unknown>("/api/v1/deliverability-control/click-tracking"),
    "click tracking",
  );
  return {
    tracking_domain: text(o.tracking_domain, "tracking domain", 253),
    status: text(o.status, "status", 64),
    ssl_status: text(o.ssl_status, "SSL status", 64),
  };
}
export async function getRoutingPolicy(): Promise<RoutingPolicy> {
  const o = object(
    await api.get<unknown>("/api/v1/deliverability-control/ip-routing"),
    "routing policy",
  );
  return {
    status: text(o.status, "status", 64),
    strategy: text(o.strategy, "strategy", 64),
    dedicated_percentage_bp: count(
      o.dedicated_percentage_bp,
      "dedicated percentage",
    ),
    max_dedicated_percentage_bp: count(
      o.max_dedicated_percentage_bp,
      "maximum dedicated percentage",
    ),
  };
}
export async function getEntitlement(): Promise<Entitlement> {
  const o = object(
    await api.get<unknown>("/api/v1/deliverability-control/entitlements"),
    "entitlement",
  );
  return {
    plan_tier: text(o.plan_tier, "plan tier", 64),
    inbox_tests_monthly: count(o.inbox_tests_monthly, "inbox test quota"),
    inbox_tests_used: count(o.inbox_tests_used, "inbox tests used"),
    inbox_tests_remaining: count(
      o.inbox_tests_remaining,
      "inbox tests remaining",
    ),
    render_previews_monthly: count(o.render_previews_monthly, "preview quota"),
    render_previews_used: count(o.render_previews_used, "previews used"),
    render_previews_remaining: count(
      o.render_previews_remaining,
      "previews remaining",
    ),
    overage_policy: text(o.overage_policy, "overage policy", 128),
  };
}
export async function listRetryEvents(
  expectedTenantId: string,
): Promise<RetryEvent[]> {
  const tenantId = text(expectedTenantId, "retry tenant identity", 128);
  if (tenantId.trim() !== tenantId) {
    throw new Error("Invalid retry tenant identity");
  }
  const o = object(
    await api.get<unknown>("/api/v1/intelligent-retry/events?limit=50"),
    "retry events",
  );
  return items(o.items, "retry event items", 50).map((v) => {
    const x = object(v, "retry event");
    const rowTenantId = text(x.tenant_id, "retry event tenant id", 128);
    if (rowTenantId !== tenantId) {
      // Never filter an isolation failure into an apparently valid partial
      // queue. A single foreign row invalidates the complete envelope.
      throw new Error("Invalid retry event tenant id");
    }
    return {
      id: text(x.id, "event id", 128),
      tenant_id: rowTenantId,
      campaign_id: text(x.campaign_id, "campaign id", 128),
      subscriber_email: text(x.subscriber_email, "subscriber email", 254),
      reason: text(x.reason, "reason", 256),
      status: text(x.status, "status", 64),
      retry_after: timestamp(x.retry_after, "retry time"),
      attempts: count(x.attempts, "attempts"),
      created_at: timestamp(x.created_at, "created time"),
      updated_at: timestamp(x.updated_at, "updated time"),
    };
  });
}
function feedback(v: unknown, kindKey: string): FeedbackEvent {
  const o = object(v, "feedback event");
  const id = o.id === undefined ? undefined : count(o.id, "feedback id");
  return {
    id,
    kind: text(o[kindKey], "feedback kind", 128),
    esp: o.esp === undefined ? undefined : text(o.esp, "feedback ESP", 128),
    received_at: timestamp(o.received_at, "received time"),
  };
}
export async function getFeedbackHistory(
  email: string,
  options: { signal?: AbortSignal } = {},
): Promise<FeedbackHistory> {
  const normalizedEmail = email.trim();
  if (
    normalizedEmail.length === 0 ||
    normalizedEmail.length > 254 ||
    CONTROL_CHAR.test(normalizedEmail) ||
    /\s/u.test(normalizedEmail) ||
    normalizedEmail.indexOf("@") <= 0 ||
    normalizedEmail.lastIndexOf("@") !== normalizedEmail.indexOf("@") ||
    normalizedEmail.endsWith("@")
  ) {
    throw new Error("Invalid subscriber email");
  }
  const o = object(
    await api.post<unknown>(
      "/api/v1/feedback/history",
      { email: normalizedEmail },
      { ...WRITE_OPTIONS, signal: options.signal },
    ),
    "feedback history",
  );
  return {
    bounces: items(o.bounces, "bounces", 5_000).map((v) =>
      feedback(v, "bounce_type"),
    ),
    complaints: items(o.complaints, "complaints", 5_000).map((v) =>
      feedback(v, "complaint_type"),
    ),
  };
}
export async function getSoftBounceStats(): Promise<SoftBounceStats> {
  const o = object(
    await api.get<unknown>("/api/v1/soft-bounce-recovery/stats"),
    "soft bounce stats",
  );
  if (typeof o.automatic_reactivation_active !== "boolean")
    throw new Error("Invalid reactivation state");
  return {
    disabled_count: count(o.disabled_count, "disabled count"),
    eligible_now: count(o.eligible_now, "eligible count"),
    eligible_suppressions_now: count(
      o.eligible_suppressions_now,
      "eligible suppressions",
    ),
    recovery_window_days: count(o.recovery_window_days, "recovery window"),
    automatic_reactivation_active: o.automatic_reactivation_active,
  };
}
export async function runSoftBounceCleanup(): Promise<{
  recovered: number;
  expired_suppressions: number;
}> {
  const o = object(
    await api.post<unknown>(
      "/api/v1/soft-bounce-recovery/run-now",
      {},
      WRITE_OPTIONS,
    ),
    "cleanup receipt",
  );
  const recovered = count(o.recovered, "recovered count");
  if (recovered !== 0) throw new Error("Invalid recovered count");
  return {
    recovered,
    expired_suppressions: count(o.expired_suppressions, "expired suppressions"),
  };
}

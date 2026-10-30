import type {
  ClickTrackingPolicy,
  DomainSetup,
  Entitlement,
  RoutingPolicy,
} from "../../lib/api/deliverability-control";
import type { BotOpenSignature, BotOpenStats } from "../../lib/api/bot-opens";
import type { WarmupPlan } from "../../lib/api/domain-warmup";

const MAX_ROWS = 10_000;
const MAX_TEXT = 8_192;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_TEXT &&
    (allowEmpty || value.trim().length > 0)
  );
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || value === null || isText(value, true);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalRecord(value: unknown): boolean {
  return value === undefined || isRecord(value);
}

function isBoundedArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length <= MAX_ROWS;
}

export function parseBotOpenStats(value: unknown): BotOpenStats | null {
  if (
    !isRecord(value) ||
    !isText(value.since) ||
    !isCount(value.total_opens) ||
    !isCount(value.bot_opens) ||
    !isCount(value.human_opens) ||
    !isBoundedArray(value.by_signature)
  ) {
    return null;
  }
  if (
    !value.by_signature.every(
      (entry) => isRecord(entry) && isText(entry.label) && isCount(entry.opens),
    )
  ) {
    return null;
  }
  return value as unknown as BotOpenStats;
}

export function parseBotOpenSignatures(
  value: unknown,
): BotOpenSignature[] | null {
  if (!isBoundedArray(value)) return null;
  if (
    !value.every(
      (signature) =>
        isRecord(signature) &&
        isText(signature.id) &&
        isOptionalText(signature.tenant_id) &&
        typeof signature.is_default === "boolean" &&
        isText(signature.label) &&
        isText(signature.pattern, true) &&
        isText(signature.kind) &&
        typeof signature.enabled === "boolean" &&
        isText(signature.created_at),
    )
  ) {
    return null;
  }
  return value as BotOpenSignature[];
}

export function parseWarmupPlans(value: unknown): WarmupPlan[] | null {
  if (!isBoundedArray(value)) return null;
  if (!value.every(isWarmupPlan)) return null;
  return value as WarmupPlan[];
}

function isWarmupPlan(value: unknown): boolean {
  if (!isRecord(value) || !isBoundedArray(value.schedule)) return false;
  return (
    isText(value.id) &&
    isText(value.domain) &&
    isCount(value.target_daily) &&
    isCount(value.days) &&
    value.days > 0 &&
    isText(value.started_on) &&
    isText(value.status) &&
    value.schedule.length <= value.days &&
    value.schedule.every(isCount) &&
    isCount(value.last_sent_count) &&
    isOptionalText(value.last_observed_at) &&
    isText(value.created_at) &&
    isText(value.updated_at)
  );
}

export function parseDomainSetups(value: unknown): DomainSetup[] | null {
  if (!isBoundedArray(value)) return null;
  if (!value.every(isDomainSetup)) return null;
  return value as DomainSetup[];
}

function isDomainSetup(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const dnsRecords = value.dns_records;
  const validDnsRecords =
    dnsRecords === undefined ||
    (isBoundedArray(dnsRecords) &&
      dnsRecords.every(
        (record) =>
          isRecord(record) &&
          isText(record.type) &&
          isText(record.name) &&
          isText(record.value, true) &&
          typeof record.required === "boolean",
      ));
  return (
    isOptionalText(value.id) &&
    isOptionalText(value.tenant_id) &&
    isText(value.domain) &&
    isText(value.setup_mode) &&
    isText(value.status) &&
    validDnsRecords &&
    isOptionalRecord(value.health_checks) &&
    isOptionalRecord(value.rollback_guidance) &&
    isText(value.ssl_status) &&
    isText(value.routing_status) &&
    isOptionalText(value.created_at) &&
    isOptionalText(value.updated_at)
  );
}

export function parseClickTrackingPolicy(
  value: unknown,
): ClickTrackingPolicy | null {
  if (!isRecord(value) || !isBoundedArray(value.disable_syntax)) return null;
  if (
    !isOptionalText(value.tenant_id) ||
    !isText(value.tracking_domain, true) ||
    !isText(value.status) ||
    !isText(value.ssl_status) ||
    !isOptionalRecord(value.caa_guidance) ||
    !value.disable_syntax.every((item) => isText(item)) ||
    !isOptionalRecord(value.last_untracked_report) ||
    !isOptionalRecord(value.settings) ||
    !isOptionalText(value.created_at) ||
    !isOptionalText(value.updated_at)
  ) {
    return null;
  }
  return value as unknown as ClickTrackingPolicy;
}

export function parseRoutingPolicy(value: unknown): RoutingPolicy | null {
  if (!isRecord(value)) return null;
  const effectiveDedicated = value.effective_dedicated_percent;
  const effectiveShared = value.effective_shared_percent;
  if (
    !isOptionalText(value.tenant_id) ||
    !isText(value.status) ||
    !isText(value.strategy) ||
    !isText(value.dedicated_pool, true) ||
    !isText(value.shared_pool, true) ||
    !isCount(value.dedicated_percentage_bp) ||
    !isCount(value.max_dedicated_percentage_bp) ||
    !isOptionalRecord(value.warmup_rules) ||
    !isOptionalText(value.last_evaluated_at) ||
    !isOptionalText(value.created_at) ||
    !isOptionalText(value.updated_at) ||
    (effectiveDedicated !== undefined &&
      !isFinitePercentage(effectiveDedicated)) ||
    (effectiveShared !== undefined && !isFinitePercentage(effectiveShared))
  ) {
    return null;
  }
  return value as unknown as RoutingPolicy;
}

function isFinitePercentage(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}

export function parseEntitlement(value: unknown): Entitlement | null {
  if (!isRecord(value)) return null;
  if (
    !isOptionalText(value.tenant_id) ||
    !isText(value.period_start) ||
    !isText(value.plan_tier) ||
    !isCount(value.inbox_tests_monthly) ||
    !isCount(value.render_previews_monthly) ||
    !isCount(value.inbox_tests_used) ||
    !isCount(value.render_previews_used) ||
    !isText(value.overage_policy) ||
    !isOptionalRecord(value.account_controls) ||
    !isOptionalText(value.created_at) ||
    !isOptionalText(value.updated_at) ||
    !isCount(value.inbox_tests_remaining) ||
    !isCount(value.render_previews_remaining)
  ) {
    return null;
  }
  return value as unknown as Entitlement;
}

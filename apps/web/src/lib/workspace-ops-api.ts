// SPDX-License-Identifier: AGPL-3.0-only
/** Strict read clients for the workspace-operations evidence surface. */
import { api } from "@/lib/api";

export class WorkspaceOpsContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceOpsContractError";
  }
}

export interface FeatureFlag {
  id: string;
  key: string;
  value: string;
  note: string;
  tenantId: string;
  isDefault: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function listFeatureFlags(): Promise<FeatureFlag[]> {
  const response = object(
    await api.get<unknown>("/api/v1/feature-flags"),
    "feature flags response",
  );
  return array(response.flags, "flags").map((value, index) => {
    const flag = object(value, `flags[${index}]`);
    return {
      id: string(flag.id, `flags[${index}].id`),
      key: string(flag.key, `flags[${index}].key`),
      value: string(flag.value, `flags[${index}].value`),
      note: optionalString(flag.note, `flags[${index}].note`),
      tenantId: optionalString(flag.tenant_id, `flags[${index}].tenant_id`),
      isDefault: boolean(flag.is_default, `flags[${index}].is_default`),
      enabled: boolean(flag.enabled, `flags[${index}].enabled`),
      createdAt: string(flag.created_at, `flags[${index}].created_at`),
      updatedAt: string(flag.updated_at, `flags[${index}].updated_at`),
    };
  });
}

export interface ExportRetention {
  /** Exports older than this are deleted. */
  retention_days: number;
  max_per_tenant: number;
  current_storage_bytes: number;
  updated_at: string;
}

export async function getExportRetention(): Promise<ExportRetention> {
  const response = object(
    await api.get<unknown>("/api/v1/exports/retention-policy"),
    "export retention response",
  );
  return {
    retention_days: nonNegativeNumber(
      response.retention_days,
      "retention_days",
    ),
    max_per_tenant: nonNegativeNumber(
      response.max_per_tenant,
      "max_per_tenant",
    ),
    current_storage_bytes: nonNegativeNumber(
      response.current_storage_bytes,
      "current_storage_bytes",
    ),
    updated_at: optionalString(response.updated_at, "updated_at"),
  };
}

export interface EmailBlockField {
  key: string;
  label: string;
  type: string;
  options: string[];
  help: string;
}

export interface EmailBlock {
  id: string;
  name: string;
  category: string;
  description: string;
  fields: EmailBlockField[];
  defaults: Record<string, unknown>;
}

export interface EmailBlockCatalog {
  blocks: EmailBlock[];
  brand: EmailBlockBrand;
}

export interface EmailBlockBrand {
  primary_color: string;
  body_font: string;
  heading_font: string;
  background_color: string;
}

export interface EmailBlockInstance {
  block_id: string;
  config: Record<string, unknown>;
}

export interface EmailBlockComposeInput {
  brand: EmailBlockBrand;
  blocks: EmailBlockInstance[];
  subscriber_email?: string;
  subject?: string;
}

export interface EmailBlockComposeResult {
  mjml: string;
  warnings: string[];
}

export async function getEmailBlockCatalog(): Promise<EmailBlockCatalog> {
  const response = object(
    await api.get<unknown>("/api/v1/email-blocks/catalog"),
    "email block catalog",
  );
  const rawBrand = object(response.brand, "brand");
  const brand: EmailBlockBrand = {
    primary_color: boundedString(rawBrand.primary_color, "brand.primary_color", 32),
    body_font: boundedString(rawBrand.body_font, "brand.body_font", 256),
    heading_font: boundedString(rawBrand.heading_font, "brand.heading_font", 256),
    background_color: boundedString(
      rawBrand.background_color,
      "brand.background_color",
      32,
    ),
  };
  const blocks = array(response.blocks, "blocks").map((value, index) => {
    const block = object(value, `blocks[${index}]`);
    const fields = array(block.fields, `blocks[${index}].fields`).map(
      (fieldValue, fieldIndex) => {
        const field = object(
          fieldValue,
          `blocks[${index}].fields[${fieldIndex}]`,
        );
        return {
          key: string(field.key, `blocks[${index}].fields[${fieldIndex}].key`),
          label: string(
            field.label,
            `blocks[${index}].fields[${fieldIndex}].label`,
          ),
          type: string(
            field.type,
            `blocks[${index}].fields[${fieldIndex}].type`,
          ),
          options: optionalStringArray(
            field.options,
            `blocks[${index}].fields[${fieldIndex}].options`,
          ),
          help: optionalString(
            field.help,
            `blocks[${index}].fields[${fieldIndex}].help`,
          ),
        };
      },
    );
    return {
      id: string(block.id, `blocks[${index}].id`),
      name: string(block.name, `blocks[${index}].name`),
      category: string(block.category, `blocks[${index}].category`),
      description: string(block.description, `blocks[${index}].description`),
      fields,
      defaults:
        block.defaults == null
          ? {}
          : object(block.defaults, `blocks[${index}].defaults`),
    };
  });
  return { blocks, brand };
}

export interface DnsHealthIssue {
  id: string;
  domain: string;
  verifyState: string;
  spfVerifiedAt: string;
  dkimVerifiedAt: string;
  dmarcVerifiedAt: string;
  lastAttemptAt: string;
  lastError: string;
  isStale: boolean;
  hoursSinceLastCheck: number;
}

export async function getDnsHealthIssues(): Promise<DnsHealthIssue[]> {
  const response = object(
    await api.get<unknown>("/api/v1/dns-health/issues"),
    "DNS health response",
  );
  return array(response.identities, "identities").map((value, index) => {
    const item = object(value, `identities[${index}]`);
    return {
      id: string(item.id, `identities[${index}].id`),
      domain: string(item.domain, `identities[${index}].domain`),
      verifyState: string(
        item.verify_state,
        `identities[${index}].verify_state`,
      ),
      spfVerifiedAt: optionalString(
        item.spf_verified_at,
        `identities[${index}].spf_verified_at`,
      ),
      dkimVerifiedAt: optionalString(
        item.dkim_verified_at,
        `identities[${index}].dkim_verified_at`,
      ),
      dmarcVerifiedAt: optionalString(
        item.dmarc_verified_at,
        `identities[${index}].dmarc_verified_at`,
      ),
      lastAttemptAt: optionalString(
        item.last_attempt_at,
        `identities[${index}].last_attempt_at`,
      ),
      lastError: optionalString(
        item.last_error,
        `identities[${index}].last_error`,
      ),
      isStale: boolean(item.is_stale, `identities[${index}].is_stale`),
      hoursSinceLastCheck: number(
        item.hours_since_last_check,
        `identities[${index}].hours_since_last_check`,
      ),
    };
  });
}

export interface WarmupPlan {
  id: string;
  domain: string;
  targetDaily: number;
  days: number;
  startedOn: string;
  status: string;
  schedule: number[];
  lastSentCount: number;
  lastObservedAt: string;
  createdAt: string;
  updatedAt: string;
}

export async function listWarmupPlans(): Promise<WarmupPlan[]> {
  const response = object(
    await api.get<unknown>("/api/v1/domain-warmup"),
    "domain warm-up response",
  );
  return array(response.plans, "plans").map((value, index) => {
    const plan = object(value, `plans[${index}]`);
    return {
      id: string(plan.id, `plans[${index}].id`),
      domain: string(plan.domain, `plans[${index}].domain`),
      targetDaily: nonNegativeNumber(
        plan.target_daily,
        `plans[${index}].target_daily`,
      ),
      days: nonNegativeNumber(plan.days, `plans[${index}].days`),
      startedOn: string(plan.started_on, `plans[${index}].started_on`),
      status: string(plan.status, `plans[${index}].status`),
      schedule: numberArray(plan.schedule, `plans[${index}].schedule`),
      lastSentCount: nonNegativeNumber(
        plan.last_sent_count,
        `plans[${index}].last_sent_count`,
      ),
      lastObservedAt: optionalString(
        plan.last_observed_at,
        `plans[${index}].last_observed_at`,
      ),
      createdAt: string(plan.created_at, `plans[${index}].created_at`),
      updatedAt: string(plan.updated_at, `plans[${index}].updated_at`),
    };
  });
}

export interface EngagementBucket {
  range: string;
  min: number;
  max: number;
  count: number;
}

export async function getEngagementDistribution(): Promise<EngagementBucket[]> {
  const response = object(
    await api.get<unknown>("/api/v1/engagement-scores/distribution"),
    "engagement distribution response",
  );
  return array(response.buckets, "buckets").map((value, index) => {
    const bucket = object(value, `buckets[${index}]`);
    return {
      range: string(bucket.range, `buckets[${index}].range`),
      min: number(bucket.min, `buckets[${index}].min`),
      max: number(bucket.max, `buckets[${index}].max`),
      count: nonNegativeNumber(bucket.count, `buckets[${index}].count`),
    };
  });
}

export interface DmarcReport {
  id: string;
  orgName: string;
  reportId: string;
  domain: string;
  policyP: string;
  policyPct: number | null;
  dateBegin: string;
  dateEnd: string;
  passCount: number;
  failCount: number;
  receivedAt: string;
}

export interface DmarcReports {
  items: DmarcReport[];
  returned: number;
  totalReports: number;
  hasMore: boolean;
  /** Domains represented by stored aggregate reports, not a DNS inventory. */
  availableDomains: string[];
  domainInventoryTruncated: boolean;
  generatedAt: string;
}

export async function getDmarcReports(): Promise<DmarcReports> {
  const response = object(
    await api.get<unknown>("/api/v1/deliverability/dmarc-reports"),
    "DMARC reports response",
  );
  const meta = object(response.meta, "meta");
  const items = array(response.items, "items").map((value, index) => {
    const report = object(value, `items[${index}]`);
    return {
      id: string(report.id, `items[${index}].id`),
      orgName: string(report.orgName, `items[${index}].orgName`),
      reportId: string(report.reportId, `items[${index}].reportId`),
      domain: string(report.domain, `items[${index}].domain`),
      policyP: string(report.policyP, `items[${index}].policyP`),
      policyPct: nullableNumber(report.policyPct, `items[${index}].policyPct`),
      dateBegin: string(report.dateBegin, `items[${index}].dateBegin`),
      dateEnd: string(report.dateEnd, `items[${index}].dateEnd`),
      passCount: nonNegativeNumber(
        report.passCount,
        `items[${index}].passCount`,
      ),
      failCount: nonNegativeNumber(
        report.failCount,
        `items[${index}].failCount`,
      ),
      receivedAt: string(report.receivedAt, `items[${index}].receivedAt`),
    };
  });
  return {
    items,
    returned: nonNegativeNumber(meta.returned, "meta.returned"),
    totalReports: nonNegativeNumber(meta.totalReports, "meta.totalReports"),
    hasMore: boolean(meta.hasMore, "meta.hasMore"),
    availableDomains: stringArray(
      meta.availableDomains,
      "meta.availableDomains",
    ),
    domainInventoryTruncated: boolean(
      meta.domainInventoryTruncated,
      "meta.domainInventoryTruncated",
    ),
    generatedAt: string(meta.generatedAt, "meta.generatedAt"),
  };
}

/** A zero report count is evidence only that this aggregate-report view is empty. */
export function dmarcHasNoReports(reports: DmarcReports): boolean {
  return reports.totalReports === 0;
}

/** Renders ordered, configured catalog blocks to MJML. It does not send. */
export async function composeEmailBlocks(
  input: EmailBlockComposeInput,
): Promise<EmailBlockComposeResult> {
  if (input.blocks.length < 1 || input.blocks.length > 100) {
    throw new WorkspaceOpsContractError("blocks must contain 1 to 100 entries");
  }
  const request = {
    brand: validateComposeBrand(input.brand),
    blocks: input.blocks.map((block, index) => {
      if (!/^[a-z][a-z0-9_]{0,63}$/u.test(block.block_id)) {
        throw new WorkspaceOpsContractError(
          `blocks[${index}].block_id is invalid`,
        );
      }
      const config = object(block.config, `blocks[${index}].config`);
      if (serializedLength(config, `blocks[${index}].config`) > 32_768) {
        throw new WorkspaceOpsContractError(
          `blocks[${index}].config is too large`,
        );
      }
      return { block_id: block.block_id, config };
    }),
    ...(input.subscriber_email?.trim()
      ? { subscriber_email: composeEmail(input.subscriber_email) }
      : {}),
    ...(input.subject?.trim()
      ? { subject: boundedString(input.subject.trim(), "subject", 998) }
      : {}),
  };
  const response = object(
    await api.post<unknown>(
    "/api/v1/email-blocks/compose",
      request,
      { requireOnline: true, maxAttempts: 1 },
    ),
    "email block compose response",
  );
  return {
    mjml: boundedMarkup(response.mjml, "mjml", 1_048_576),
    warnings: optionalStringArray(response.warnings, "warnings")
      .slice(0, 100)
      .map((warning, index) =>
        boundedString(warning, `warnings[${index}]`, 2_000),
      ),
  };
}

function validateComposeBrand(brand: EmailBlockBrand): EmailBlockBrand {
  const parsed = {
    primary_color: boundedString(brand.primary_color, "brand.primary_color", 32),
    body_font: boundedString(brand.body_font, "brand.body_font", 256),
    heading_font: boundedString(brand.heading_font, "brand.heading_font", 256),
    background_color: boundedString(
      brand.background_color,
      "brand.background_color",
      32,
    ),
  };
  if (
    !/^#[0-9a-f]{6}$/iu.test(parsed.primary_color) ||
    !/^#[0-9a-f]{6}$/iu.test(parsed.background_color)
  ) {
    throw new WorkspaceOpsContractError("brand colors must be six-digit hex");
  }
  return parsed;
}

function composeEmail(value: string): string {
  const parsed = boundedString(value.trim().toLowerCase(), "subscriber_email", 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(parsed)) {
    throw new WorkspaceOpsContractError("subscriber_email is invalid");
  }
  return parsed;
}

function serializedLength(value: unknown, label: string): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    throw new WorkspaceOpsContractError(`${label} is not serializable`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceOpsContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new WorkspaceOpsContractError(`${label} must be an array`);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkspaceOpsContractError(`${label} must be a non-empty string`);
  }
  return value;
}

function boundedString(value: unknown, label: string, max: number): string {
  const parsed = string(value, label);
  if (parsed.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(parsed)) {
    throw new WorkspaceOpsContractError(`${label} is invalid`);
  }
  return parsed;
}

function boundedMarkup(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new WorkspaceOpsContractError(`${label} is invalid`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new WorkspaceOpsContractError(`${label} must be a string`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new WorkspaceOpsContractError(`${label} must be a boolean`);
  }
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WorkspaceOpsContractError(`${label} must be a finite number`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  const parsed = number(value, label);
  if (parsed < 0) {
    throw new WorkspaceOpsContractError(`${label} cannot be negative`);
  }
  return parsed;
}

function nullableNumber(value: unknown, label: string): number | null {
  return value === null ? null : number(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) =>
    string(item, `${label}[${index}]`),
  );
}

function optionalStringArray(value: unknown, label: string): string[] {
  return value === undefined || value === null ? [] : stringArray(value, label);
}

function numberArray(value: unknown, label: string): number[] {
  return array(value, label).map((item, index) =>
    nonNegativeNumber(item, `${label}[${index}]`),
  );
}

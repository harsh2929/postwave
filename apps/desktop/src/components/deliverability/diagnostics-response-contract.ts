import type {
  CampaignDiagnosis,
  CampaignPlacementReport,
  ISPBucket,
} from "../../lib/api-client";
import { parseIspBuckets } from "./isp-breakdown-helpers";

const MAX_ROWS = 10_000;
const MAX_TEXT = 32_768;

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

function isFraction(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isBoundedArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length <= MAX_ROWS;
}

function isNumberMap(
  value: unknown,
  predicate: (candidate: unknown) => boolean,
): value is Record<string, number> {
  if (!isRecord(value) || Object.keys(value).length > MAX_ROWS) return false;
  return Object.entries(value).every(
    ([key, candidate]) => isText(key) && predicate(candidate),
  );
}

export function parseTenantIspResponse(
  value: unknown,
): { buckets: ISPBucket[]; windowDays: number } | null {
  if (
    !isRecord(value) ||
    !isCount(value.window_days) ||
    value.window_days < 1
  ) {
    return null;
  }
  const buckets = parseIspBuckets(value.buckets);
  return buckets ? { buckets, windowDays: value.window_days } : null;
}

export function parseCampaignIspResponse(
  value: unknown,
  expectedCampaignId?: string,
): ISPBucket[] | null {
  if (
    !isRecord(value) ||
    !isText(value.campaign_id) ||
    (expectedCampaignId !== undefined &&
      value.campaign_id !== expectedCampaignId)
  ) {
    return null;
  }
  return parseIspBuckets(value.buckets);
}

export function parsePlacementReport(
  value: unknown,
  expectedCampaignId?: string,
): CampaignPlacementReport | null {
  if (
    !isRecord(value) ||
    !isText(value.campaign_id) ||
    (expectedCampaignId !== undefined &&
      value.campaign_id !== expectedCampaignId) ||
    !isBoundedArray(value.providers) ||
    !value.providers.every(isPlacementProvider) ||
    !isNumberMap(value.overall_pct, isFraction) ||
    !isCount(value.total_inboxes) ||
    !isText(value.generated_at) ||
    !isOptionalText(value.diagnostic_id) ||
    !isOptionalPlacementReports(value.reports)
  ) {
    return null;
  }
  return value as unknown as CampaignPlacementReport;
}

function isPlacementProvider(value: unknown): boolean {
  return (
    isRecord(value) &&
    isText(value.provider) &&
    isCount(value.total) &&
    isNumberMap(value.placements, isCount)
  );
}

function isOptionalPlacementReports(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isBoundedArray(value)) return false;
  return value.every(
    (report) =>
      isRecord(report) &&
      isText(report.campaign_id) &&
      isText(report.provider) &&
      isText(report.mailbox_id) &&
      isText(report.placement) &&
      isText(report.checked_at),
  );
}

export function parseCampaignDiagnosis(
  value: unknown,
): CampaignDiagnosis | null {
  if (
    !isRecord(value) ||
    !isText(value.campaign_id) ||
    !isText(value.diagnosis, true) ||
    !isBoundedArray(value.fixes) ||
    !value.fixes.every(isDiagnosisFix) ||
    !isNumberMap(value.predicted_impact, isFraction) ||
    !isText(value.generated_at)
  ) {
    return null;
  }
  return value as unknown as CampaignDiagnosis;
}

function isDiagnosisFix(value: unknown): boolean {
  return (
    isRecord(value) &&
    isText(value.title) &&
    isText(value.detail, true) &&
    isText(value.action) &&
    (value.dns_record === undefined || isRecord(value.dns_record)) &&
    isFraction(value.estimated_impact)
  );
}

/**
 * lib/data-controls-api.ts — PII scanning, profile transforms, import
 * templates, inbound webhooks.
 *
 * Five paths were reached by desktop and by no web file.
 *
 * `pii-scan-config` CARRIES THREE DIFFERENT CAPABILITY STATES AND THEY ARE NOT
 * THE SAME QUESTION:
 *
 *     available: true                  the scanner exists in this build
 *     scan_enabled: false              it is switched off for this workspace
 *     scheduled_scans_available: false scheduled runs are not offered at all
 *
 * "Off" and "not offered" lead to different actions — one is a setting, the
 * other is a limitation — and collapsing them into a single enabled/disabled
 * badge loses the difference. The named scanner, detector and policy versions
 * are carried too, because "PII scanning is on" means little without knowing
 * WHICH detector and WHICH policy decided what counts as PII.
 *
 * COVERAGE: this module wires 4 of them:
 *   /api/v1/inbound-webhooks
 *   /api/v1/pii-scan-config
 *   /api/v1/profile-transform-rules
 *   /api/v1/subscriber-import-templates
 * The remaining 1 are not called from web. The sentence above
 * describes the gap that was found, not the part that was closed.
 */
import { api } from "@/lib/api";

export type ProfileTransformKind =
  | "copy"
  | "lowercase"
  | "uppercase"
  | "trim"
  | "date"
  | "number"
  | "boolean"
  | "json_path";

export type ProfileTransformStatus = "active" | "paused" | "archived";

/** A server row, with nullable detail fields so older deployments remain
 * visible as incomplete evidence instead of being misreported as an empty list. */
export interface ProfileTransformRule {
  id: string;
  name: string | null;
  source_path: string | null;
  target_key: string | null;
  transform: ProfileTransformKind | string | null;
  status: ProfileTransformStatus | string | null;
}

export interface SubscriberImportTemplate {
  id: string;
  name: string | null;
  mapping: Record<string, unknown> | null;
  source_hint: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface InboundWebhookSummary {
  id: string;
  slug: string | null;
  name: string | null;
  enabled: boolean | null;
  created_at: string | null;
}

export interface PiiScanConfig {
  /** The scanner exists in this build. */
  available: boolean;
  /** It is switched on for this workspace. */
  scan_enabled: boolean;
  /** Scheduled runs are offered — separate from being enabled. */
  scheduled_scans_available: boolean;
  status: string;
  execution_mode?: string;
  scanner_name?: string;
  scanner_version?: string;
  detector_name?: string;
  detector_version?: string;
  policy_name?: string;
  policy_version?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseItems<T>(
  surface: string,
  value: unknown,
  parse: (row: Record<string, unknown>, index: number) => T,
): T[] {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error(`${surface} response was malformed.`);
  }
  return value.items.map((row, index) => {
    if (!isRecord(row)) {
      throw new Error(`${surface} row ${index + 1} was malformed.`);
    }
    return parse(row, index);
  });
}

function requiredRowId(
  surface: string,
  row: Record<string, unknown>,
  index: number,
): string {
  const id = nullableString(row.id);
  if (!id) throw new Error(`${surface} row ${index + 1} was malformed.`);
  return id;
}

export async function getPiiScanConfig(): Promise<PiiScanConfig> {
  const res = await api.get<PiiScanConfig>("/api/v1/pii-scan-config");
  return {
    available: res?.available === true,
    scan_enabled: res?.scan_enabled === true,
    scheduled_scans_available: res?.scheduled_scans_available === true,
    status: typeof res?.status === "string" ? res.status : "unknown",
    execution_mode: res?.execution_mode,
    scanner_name: res?.scanner_name,
    scanner_version: res?.scanner_version,
    detector_name: res?.detector_name,
    detector_version: res?.detector_version,
    policy_name: res?.policy_name,
    policy_version: res?.policy_version,
  };
}

export async function listProfileTransformRules(): Promise<
  ProfileTransformRule[]
> {
  const res = await api.get<unknown>("/api/v1/profile-transform-rules");
  return parseItems("Profile transform rules", res, (row, index) => ({
    id: requiredRowId("Profile transform rules", row, index),
    name: nullableString(row.name),
    source_path: nullableString(row.source_path),
    target_key: nullableString(row.target_key),
    transform: nullableString(row.transform),
    status: nullableString(row.status),
  }));
}

export async function listImportTemplates(): Promise<
  SubscriberImportTemplate[]
> {
  const res = await api.get<unknown>("/api/v1/subscriber-import-templates");
  return parseItems("Subscriber import templates", res, (row, index) => ({
    id: requiredRowId("Subscriber import templates", row, index),
    name: nullableString(row.name),
    mapping: isRecord(row.mapping) ? row.mapping : null,
    source_hint: nullableString(row.source_hint),
    created_at: nullableString(row.created_at),
    updated_at: nullableString(row.updated_at),
  }));
}

export async function listInboundWebhooks(): Promise<InboundWebhookSummary[]> {
  const res = await api.get<unknown>("/api/v1/inbound-webhooks");
  return parseItems("Inbound webhooks", res, (row, index) => ({
    id: requiredRowId("Inbound webhooks", row, index),
    slug: nullableString(row.slug),
    name: nullableString(row.name),
    enabled: typeof row.enabled === "boolean" ? row.enabled : null,
    created_at: nullableString(row.createdAt ?? row.created_at),
  }));
}

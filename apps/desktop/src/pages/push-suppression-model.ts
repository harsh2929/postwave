import {
  PUSH_PLATFORMS,
  PUSH_SUPPRESSION_REASONS,
  type PushSuppressionPlatform,
  type PushSuppressionReason,
  type PushSuppressionRow,
} from "../lib/api/push-suppressions";

export const PUSH_SUPPRESSION_PAGE_SIZE = 50;

export type PushPlatformFilter = "all" | PushSuppressionPlatform;
export type PushReasonFilter = "all" | PushSuppressionReason;
export type PushSourceFilter = "all" | PushSuppressionRow["source"];

export interface VerifiedPushSuppressionPage {
  criteriaKey: string;
  cursor?: string;
  items: PushSuppressionRow[];
  total: number;
  nextCursor: string | null;
  snapshotAt: string;
}

export interface PushSuppressionImportItem {
  device_token: string;
  platform: PushSuppressionPlatform;
  reason: "manual";
}

export type PushSuppressionImportParseResult =
  | {
      ok: true;
      items: PushSuppressionImportItem[];
      platformCounts: Record<PushSuppressionPlatform, number>;
    }
  | { ok: false; message: string };

const CONTROL_OR_BIDI =
  /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const LONE_SURROGATE = /[\ud800-\udfff]/u;
const APNS_TOKEN = /^[0-9a-fA-F]{64}$/u;
const HASH_PREFIX = /^[0-9a-f]{8,16}$/u;

export const PLATFORM_FILTERS: ReadonlyArray<{
  value: PushPlatformFilter;
  label: string;
}> = [{ value: "all", label: "All platforms" }, ...PUSH_PLATFORMS];

export const REASON_FILTERS: ReadonlyArray<{
  value: PushReasonFilter;
  label: string;
}> = [{ value: "all", label: "All reasons" }, ...PUSH_SUPPRESSION_REASONS];

export function pushCriteriaKey(
  platform: PushPlatformFilter,
  reason: PushReasonFilter,
  query: string,
): string {
  return `${platform}\u0000${reason}\u0000${query}`;
}

export function validateFingerprintPrefix(value: string): string | null {
  if (!value) return null;
  if (value !== value.toLowerCase()) {
    return "Use lowercase hexadecimal characters.";
  }
  if (!HASH_PREFIX.test(value)) {
    return "Enter 8–16 lowercase hexadecimal characters.";
  }
  return null;
}

export function validateRawPushToken(
  value: string,
  platform: PushSuppressionPlatform,
): string | null {
  if (!value) return "Enter the raw device token.";
  const byteLength = new TextEncoder().encode(value).byteLength;
  if (byteLength < 20 || byteLength > 4096) {
    return "The token must contain 20–4,096 encoded bytes.";
  }
  if (value.trim() !== value || /\s/u.test(value)) {
    return "Tokens cannot contain whitespace; paste the canonical token exactly.";
  }
  if (CONTROL_OR_BIDI.test(value)) {
    return "Tokens cannot contain control or direction-changing characters.";
  }
  if (LONE_SURROGATE.test(value)) {
    return "Tokens cannot contain unsupported characters.";
  }
  if (platform === "apns" && !APNS_TOKEN.test(value)) {
    return "An APNs token must be exactly 64 hexadecimal characters.";
  }
  return null;
}

export function platformLabel(platform: PushSuppressionPlatform): string {
  return (
    PUSH_PLATFORMS.find((entry) => entry.value === platform)?.label ?? platform
  );
}

export function reasonLabel(reason: PushSuppressionReason): string {
  return (
    PUSH_SUPPRESSION_REASONS.find((entry) => entry.value === reason)?.label ??
    reason
  );
}

export function sourceLabel(source: PushSuppressionRow["source"]): string {
  const labels: Record<PushSuppressionRow["source"], string> = {
    dashboard: "Dashboard",
    provider: "Provider",
    user: "User authority",
    complaint: "Complaint authority",
    legacy: "Legacy",
  };
  return labels[source];
}

export function lockedReasonLabel(
  reason: NonNullable<PushSuppressionRow["locked_reason"]>,
): string {
  const labels: Record<
    NonNullable<PushSuppressionRow["locked_reason"]>,
    string
  > = {
    provider_authority: "Provider authority",
    user_opt_out_authority: "User opt-out authority",
    complaint_authority: "Complaint authority",
    legacy_authority_requires_review: "Legacy authority requires review",
  };
  return labels[reason];
}

export function rowCanBeRemoved(row: PushSuppressionRow): boolean {
  return (
    row.reversible &&
    row.reason === "manual" &&
    row.source === "dashboard" &&
    row.locked_reason === undefined
  );
}

export function rowAuthorityLabel(row: PushSuppressionRow): string {
  if (rowCanBeRemoved(row)) {
    return "Dashboard manual · reversible";
  }
  return `${sourceLabel(row.source)} · locked`;
}

export function sourceOptions(
  rows: readonly PushSuppressionRow[],
): ReadonlyArray<{ value: PushSourceFilter; label: string }> {
  const unique = Array.from(new Set(rows.map((row) => row.source))).sort(
    (left, right) => sourceLabel(left).localeCompare(sourceLabel(right)),
  );
  return [
    { value: "all", label: "All sources" },
    ...unique.map((value) => ({ value, label: sourceLabel(value) })),
  ];
}

export function filterRowsBySource(
  rows: readonly PushSuppressionRow[],
  source: PushSourceFilter,
): PushSuppressionRow[] {
  return source === "all"
    ? [...rows]
    : rows.filter((row) => row.source === source);
}

function csvCell(value: string | number | boolean): string {
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function buildPushSuppressionCsv(
  rows: readonly PushSuppressionRow[],
): string {
  const header = [
    "fingerprint",
    "platform",
    "reason",
    "source",
    "created_at",
    "updated_at",
    "version",
    "reversible",
    "locked_reason",
  ];
  const records = rows.map((row) =>
    [
      row.device_token_hash,
      row.platform,
      row.reason,
      row.source,
      row.created_at,
      row.updated_at,
      row.version,
      row.reversible,
      row.locked_reason ?? "",
    ]
      .map(csvCell)
      .join(","),
  );
  return `\uFEFF${[header.join(","), ...records].join("\r\n")}\r\n`;
}

function parseCsvFields(line: string): string[] | null {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
        closedQuote = true;
      }
    } else if (closedQuote) {
      if (character !== ",") return null;
      fields.push(field);
      field = "";
      closedQuote = false;
    } else if (character === ",") {
      fields.push(field);
      field = "";
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === '"') {
      return null;
    } else {
      field += character;
    }
  }
  if (quoted) return null;
  fields.push(field);
  return fields;
}

export function parsePushSuppressionImportCsv(
  raw: string,
): PushSuppressionImportParseResult {
  if (raw.length === 0 || raw.length > 512 * 1024) {
    return { ok: false, message: "Choose a non-empty CSV no larger than 512 KB." };
  }
  const source = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  if (CONTROL_OR_BIDI.test(source.replace(/[\r\n]/gu, ""))) {
    return { ok: false, message: "The CSV contains unsupported control characters." };
  }
  const lines = source.split(/\r?\n/u);
  while (lines.at(-1) === "") lines.pop();
  const header = lines.shift();
  if (header !== "platform,device_token") {
    return {
      ok: false,
      message: "The CSV header must be exactly platform,device_token.",
    };
  }
  if (lines.length < 1 || lines.length > 100) {
    return { ok: false, message: "Include 1–100 reviewed token rows." };
  }
  const platformCounts: Record<PushSuppressionPlatform, number> = {
    apns: 0,
    fcm: 0,
    web: 0,
  };
  const items: PushSuppressionImportItem[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const fields = parseCsvFields(lines[index]!);
    const platform = fields?.[0];
    const token = fields?.[1];
    if (
      fields?.length !== 2 ||
      (platform !== "apns" && platform !== "fcm" && platform !== "web") ||
      token === undefined
    ) {
      return { ok: false, message: `Row ${index + 2} must contain a supported platform and one token.` };
    }
    const validation = validateRawPushToken(token, platform);
    if (validation) {
      return { ok: false, message: `Row ${index + 2}: ${validation}` };
    }
    const key = `${platform}\u0000${token}`;
    if (seen.has(key)) {
      return { ok: false, message: `Row ${index + 2} repeats an earlier platform and token.` };
    }
    seen.add(key);
    platformCounts[platform] += 1;
    items.push({ device_token: token, platform, reason: "manual" });
  }
  return { ok: true, items, platformCounts };
}

export function isFailClosedListError(error: {
  status?: number;
  code?: string;
}): boolean {
  return (
    error.status === 404 ||
    error.status === 405 ||
    error.code === "invalid_push_suppression_response" ||
    error.code === "identity_changed"
  );
}

export function isConflictError(error: {
  status?: number;
  code?: string;
}): boolean {
  return error.status === 409 || error.code === "version_conflict";
}

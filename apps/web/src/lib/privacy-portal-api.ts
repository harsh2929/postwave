// SPDX-License-Identifier: AGPL-3.0-only

/** Strict, tenant-bound contracts for the exact-admin privacy portal. */
import { api } from "@/lib/api";
import { isSafePublicHttpsAssetURL } from "@/lib/preference-branding-security";

const TENANT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ROW_UUID = TENANT_UUID;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/u;
const REGION_CODE = /^[A-Z0-9]{2,8}(?:-[A-Z0-9]{1,8})*$/u;
const CURSOR = /^[A-Za-z0-9_-]{8,4096}$/u;
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/u;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const UNSAFE_MULTILINE =
  /[\p{Cf}\p{Cs}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const FRAMEWORKS = ["gdpr", "ccpa", "lgpd", "pipeda", "apo", "other"] as const;

export type PrivacyFramework = (typeof FRAMEWORKS)[number];

export interface PrivacyRegion {
  id: string;
  tenantId: string;
  region_code: string;
  framework: PrivacyFramework;
  requires_double_optin: boolean;
  requires_explicit_consent: boolean;
  do_not_sell_default: boolean;
  gpc_honored: boolean;
  created_at: string;
  updated_at: string;
}

export interface PrivacyRegionInput {
  region_code: string;
  framework: PrivacyFramework;
  requires_double_optin: boolean;
  requires_explicit_consent: boolean;
  do_not_sell_default: boolean;
  gpc_honored: boolean;
}

export interface PrivacyDsarSummary {
  request_type: string;
  open: number;
  overdue: number;
  closed: number;
}

export interface SuppressionBreakdownRow {
  reason: string;
  count: number;
}

export interface ConsentProofRow {
  source: string;
  count: number;
}

export interface PrivacyPortal {
  tenantId: string;
  regions: PrivacyRegion[];
  dsar_requests: PrivacyDsarSummary[];
  suppression_breakdown: SuppressionBreakdownRow[];
  consent_proof_summary: ConsentProofRow[];
  gpc_signaled_count: number;
  do_not_sell_count: number;
  double_optin_pending: number;
  generated_at: string;
}

export interface PreferenceCentreBranding {
  tenantId: string;
  logo_url: string;
  primary_color: string;
  footer_text: string;
  show_postwave_badge: boolean;
}

export type PreferenceCentreBrandingInput = Omit<
  PreferenceCentreBranding,
  "tenantId"
>;

export interface DoubleOptInPendingRow {
  id: string;
  email: string;
  list_id?: string;
  sent_at: string;
  expires_at: string;
}

export interface DoubleOptInPendingPage {
  tenantId: string;
  count: number;
  pending: DoubleOptInPendingRow[];
  nextCursor?: string;
  requestCursor?: string;
}

export interface PrivacyPortalMutationReceipt {
  ok: true;
  tenantId: string;
  id: string;
}

export function mergeDoubleOptInPendingPages(
  pages: readonly DoubleOptInPendingPage[],
  expectedTenantId: string,
): DoubleOptInPendingRow[] {
  requireTenant(expectedTenantId);
  const rows: DoubleOptInPendingRow[] = [];
  const ids = new Set<string>();
  let expectedCursor: string | undefined;
  let previousSent = Number.POSITIVE_INFINITY;
  let previousId = "";
  for (const [index, page] of pages.entries()) {
    if (
      page.tenantId !== expectedTenantId ||
      page.count !== page.pending.length ||
      (index === 0 && page.requestCursor !== undefined) ||
      (index > 0 && page.requestCursor !== expectedCursor)
    ) {
      throw new Error("Invalid pending double-opt-in page chain");
    }
    for (const row of page.pending) {
      const sent = Number(timestamp(row.sent_at));
      if (
        ids.has(row.id) ||
        !Number.isFinite(sent) ||
        sent > previousSent ||
        (sent === previousSent && previousId !== "" && row.id >= previousId)
      ) {
        throw new Error("Invalid pending double-opt-in page inventory");
      }
      ids.add(row.id);
      previousSent = sent;
      previousId = row.id;
      rows.push(row);
    }
    expectedCursor = page.nextCursor;
  }
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function requireTenant(tenantId: string): void {
  if (!TENANT_UUID.test(tenantId)) {
    throw new Error("Privacy portal requires a canonical workspace identity");
  }
}

function requireRowId(id: string): void {
  if (!ROW_UUID.test(id)) {
    throw new Error("Privacy portal requires a canonical row identity");
  }
}

function safeText(
  value: unknown,
  maxScalars: number,
  maxBytes: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    [...value].length <= maxScalars &&
    new TextEncoder().encode(value).length <= maxBytes &&
    !UNSAFE_TEXT.test(value)
  );
}

function safeMultiline(value: unknown): value is string {
  return (
    typeof value === "string" &&
    [...value].length <= 4096 &&
    new TextEncoder().encode(value).length <= 4096 &&
    !UNSAFE_MULTILINE.test(value)
  );
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = RFC3339.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = Date.parse(value);
  if (
    year < 2000 ||
    year >= 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59 ||
    Number(match[9] ?? 0) > 14 ||
    (Number(match[9] ?? 0) === 14 && Number(match[10] ?? 0) !== 0) ||
    Number(match[10] ?? 0) > 59 ||
    !Number.isFinite(parsed) ||
    parsed < Date.UTC(2000, 0, 1) ||
    parsed >= Date.UTC(2100, 0, 1)
  ) {
    return null;
  }
  return parsed;
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function framework(value: unknown): value is PrivacyFramework {
  return FRAMEWORKS.includes(value as PrivacyFramework);
}

function decodeRegion(value: unknown, expectedTenantId: string): PrivacyRegion {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "tenantId",
      "region_code",
      "framework",
      "requires_double_optin",
      "requires_explicit_consent",
      "do_not_sell_default",
      "gpc_honored",
      "created_at",
      "updated_at",
    ]) ||
    typeof value.id !== "string" ||
    !ROW_UUID.test(value.id) ||
    value.tenantId !== expectedTenantId ||
    typeof value.region_code !== "string" ||
    !REGION_CODE.test(value.region_code) ||
    !framework(value.framework) ||
    typeof value.requires_double_optin !== "boolean" ||
    typeof value.requires_explicit_consent !== "boolean" ||
    typeof value.do_not_sell_default !== "boolean" ||
    typeof value.gpc_honored !== "boolean" ||
    timestamp(value.created_at) === null ||
    timestamp(value.updated_at) === null ||
    Number(timestamp(value.updated_at)) < Number(timestamp(value.created_at))
  ) {
    throw new Error("Invalid privacy-region response");
  }
  return value as unknown as PrivacyRegion;
}

function canonicalRegionInput(input: PrivacyRegionInput): PrivacyRegionInput {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "region_code",
      "framework",
      "requires_double_optin",
      "requires_explicit_consent",
      "do_not_sell_default",
      "gpc_honored",
    ])
  ) {
    throw new Error("Invalid privacy-region input");
  }
  const regionCode =
    typeof input.region_code === "string"
      ? input.region_code.trim().toUpperCase()
      : "";
  if (
    !REGION_CODE.test(regionCode) ||
    !framework(input.framework) ||
    typeof input.requires_double_optin !== "boolean" ||
    typeof input.requires_explicit_consent !== "boolean" ||
    typeof input.do_not_sell_default !== "boolean" ||
    typeof input.gpc_honored !== "boolean"
  ) {
    throw new Error("Invalid privacy-region input");
  }
  return { ...input, region_code: regionCode };
}

function decodeDsar(value: unknown): PrivacyDsarSummary {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["request_type", "open", "overdue", "closed"]) ||
    !safeText(value.request_type, 64, 256) ||
    !count(value.open) ||
    !count(value.overdue) ||
    !count(value.closed) ||
    value.overdue > value.open
  ) {
    throw new Error("Invalid privacy DSAR summary");
  }
  return value as unknown as PrivacyDsarSummary;
}

function decodeCountRow(
  value: unknown,
  key: "reason" | "source",
): SuppressionBreakdownRow | ConsentProofRow {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [key, "count"]) ||
    !safeText(value[key], 128, 512) ||
    !count(value.count)
  ) {
    throw new Error("Invalid privacy count summary");
  }
  return value as unknown as SuppressionBreakdownRow | ConsentProofRow;
}

export async function getPrivacyPortal(
  expectedTenantId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<PrivacyPortal> {
  requireTenant(expectedTenantId);
  const value = await api.get<unknown>("/api/v1/privacy/portal", opts);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "tenantId",
      "regions",
      "dsar_requests",
      "suppression_breakdown",
      "consent_proof_summary",
      "gpc_signaled_count",
      "do_not_sell_count",
      "double_optin_pending",
      "generated_at",
    ]) ||
    value.tenantId !== expectedTenantId ||
    !Array.isArray(value.regions) ||
    value.regions.length > 1_000 ||
    !Array.isArray(value.dsar_requests) ||
    value.dsar_requests.length > 128 ||
    !Array.isArray(value.suppression_breakdown) ||
    value.suppression_breakdown.length > 256 ||
    !Array.isArray(value.consent_proof_summary) ||
    value.consent_proof_summary.length > 256 ||
    !count(value.gpc_signaled_count) ||
    !count(value.do_not_sell_count) ||
    !count(value.double_optin_pending) ||
    timestamp(value.generated_at) === null
  ) {
    throw new Error("Invalid privacy-portal response");
  }
  const seenIds = new Set<string>();
  const seenCodes = new Set<string>();
  let previousCode = "";
  const regions = value.regions.map((candidate) => {
    const row = decodeRegion(candidate, expectedTenantId);
    if (
      seenIds.has(row.id) ||
      seenCodes.has(row.region_code) ||
      (previousCode !== "" && row.region_code <= previousCode)
    ) {
      throw new Error("Invalid privacy-region inventory");
    }
    seenIds.add(row.id);
    seenCodes.add(row.region_code);
    previousCode = row.region_code;
    return row;
  });
  const dsar = value.dsar_requests.map(decodeDsar);
  const dsarTypes = new Set(dsar.map((row) => row.request_type));
  if (dsarTypes.size !== dsar.length) {
    throw new Error("Invalid privacy DSAR inventory");
  }
  return {
    tenantId: expectedTenantId,
    regions,
    dsar_requests: dsar,
    suppression_breakdown: value.suppression_breakdown.map((row) =>
      decodeCountRow(row, "reason"),
    ) as SuppressionBreakdownRow[],
    consent_proof_summary: value.consent_proof_summary.map((row) =>
      decodeCountRow(row, "source"),
    ) as ConsentProofRow[],
    gpc_signaled_count: Number(value.gpc_signaled_count),
    do_not_sell_count: Number(value.do_not_sell_count),
    double_optin_pending: Number(value.double_optin_pending),
    generated_at: value.generated_at as string,
  };
}

export function isSafePreferenceLogoURL(value: string): boolean {
  return isSafePublicHttpsAssetURL(value);
}

function decodeBranding(
  value: unknown,
  expectedTenantId: string,
): PreferenceCentreBranding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "tenantId",
      "logo_url",
      "primary_color",
      "footer_text",
      "show_postwave_badge",
    ]) ||
    value.tenantId !== expectedTenantId ||
    typeof value.logo_url !== "string" ||
    !isSafePreferenceLogoURL(value.logo_url) ||
    typeof value.primary_color !== "string" ||
    !HEX_COLOR.test(value.primary_color) ||
    !safeMultiline(value.footer_text) ||
    typeof value.show_postwave_badge !== "boolean"
  ) {
    throw new Error("Invalid preference-centre customization response");
  }
  return value as unknown as PreferenceCentreBranding;
}

function canonicalBrandingInput(
  input: PreferenceCentreBrandingInput,
): PreferenceCentreBrandingInput {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "logo_url",
      "primary_color",
      "footer_text",
      "show_postwave_badge",
    ]) ||
    typeof input.logo_url !== "string" ||
    typeof input.primary_color !== "string" ||
    !safeMultiline(input.footer_text) ||
    typeof input.show_postwave_badge !== "boolean"
  ) {
    throw new Error("Invalid preference-centre customization input");
  }
  const logo = input.logo_url.trim();
  const color = input.primary_color.trim() || "#5B6CFF";
  if (!isSafePreferenceLogoURL(logo) || !HEX_COLOR.test(color)) {
    throw new Error("Invalid preference-centre customization input");
  }
  return { ...input, logo_url: logo, primary_color: color };
}

export async function getPreferenceCentreBranding(
  expectedTenantId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<PreferenceCentreBranding> {
  requireTenant(expectedTenantId);
  return decodeBranding(
    await api.get<unknown>("/api/v1/privacy/portal/preference-center", opts),
    expectedTenantId,
  );
}

export async function savePreferenceCentreBranding(
  input: PreferenceCentreBrandingInput,
  expectedTenantId: string,
  signal?: AbortSignal,
): Promise<PreferenceCentreBranding> {
  requireTenant(expectedTenantId);
  const canonical = canonicalBrandingInput(input);
  const result = decodeBranding(
    await api.patch<unknown>(
      "/api/v1/privacy/portal/preference-center",
      canonical,
      { requireOnline: true, signal },
    ),
    expectedTenantId,
  );
  if (
    result.logo_url !== canonical.logo_url ||
    result.primary_color !== canonical.primary_color ||
    result.footer_text !== canonical.footer_text ||
    result.show_postwave_badge !== canonical.show_postwave_badge
  ) {
    throw new Error("Invalid preference-centre customization receipt");
  }
  return result;
}

function decodePendingRow(value: unknown): DoubleOptInPendingRow {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ["id", "email", "sent_at", "expires_at"],
      ["list_id"],
    ) ||
    typeof value.id !== "string" ||
    !ROW_UUID.test(value.id) ||
    !safeText(value.email, 320, 1_280) ||
    !value.email.includes("@") ||
    (value.list_id !== undefined &&
      (typeof value.list_id !== "string" || !ROW_UUID.test(value.list_id))) ||
    timestamp(value.sent_at) === null ||
    timestamp(value.expires_at) === null ||
    Number(timestamp(value.expires_at)) <= Number(timestamp(value.sent_at))
  ) {
    throw new Error("Invalid pending double-opt-in row");
  }
  return value as unknown as DoubleOptInPendingRow;
}

export async function getDoubleOptInPending(input: {
  tenantId: string;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<DoubleOptInPendingPage> {
  requireTenant(input.tenantId);
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Pending confirmation page size must be 1–500");
  }
  if (input.cursor !== undefined && !CURSOR.test(input.cursor)) {
    throw new Error("Invalid pending confirmation cursor");
  }
  const value = await api.get<unknown>(
    "/api/v1/privacy/portal/double-optin/pending",
    {
      query: { limit, cursor: input.cursor },
      signal: input.signal,
    },
  );
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["tenantId", "pending", "count"], ["nextCursor"]) ||
    value.tenantId !== input.tenantId ||
    !Array.isArray(value.pending) ||
    value.pending.length > limit ||
    !count(value.count) ||
    value.count !== value.pending.length ||
    (value.nextCursor !== undefined &&
      (typeof value.nextCursor !== "string" ||
        !CURSOR.test(value.nextCursor) ||
        value.pending.length !== limit))
  ) {
    throw new Error("Invalid pending double-opt-in response");
  }
  const seen = new Set<string>();
  let previousSent = Number.POSITIVE_INFINITY;
  let previousId = "";
  const pending = value.pending.map((candidate) => {
    const row = decodePendingRow(candidate);
    const sent = Number(timestamp(row.sent_at));
    if (
      seen.has(row.id) ||
      sent > previousSent ||
      (sent === previousSent && previousId !== "" && row.id >= previousId)
    ) {
      throw new Error("Invalid pending double-opt-in inventory");
    }
    seen.add(row.id);
    previousSent = sent;
    previousId = row.id;
    return row;
  });
  return {
    tenantId: input.tenantId,
    count: pending.length,
    pending,
    ...(typeof value.nextCursor === "string"
      ? { nextCursor: value.nextCursor }
      : {}),
    ...(input.cursor ? { requestCursor: input.cursor } : {}),
  };
}

function decodeMutationReceipt(
  value: unknown,
  expectedTenantId: string,
  expectedId: string,
): PrivacyPortalMutationReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["ok", "tenantId", "id"]) ||
    value.ok !== true ||
    value.tenantId !== expectedTenantId ||
    value.id !== expectedId
  ) {
    throw new Error("Invalid privacy-portal mutation receipt");
  }
  return { ok: true, tenantId: expectedTenantId, id: expectedId };
}

export async function createPrivacyRegion(
  input: PrivacyRegionInput,
  expectedTenantId: string,
  signal?: AbortSignal,
): Promise<PrivacyRegion> {
  requireTenant(expectedTenantId);
  const canonical = canonicalRegionInput(input);
  const row = decodeRegion(
    await api.post<unknown>("/api/v1/privacy/portal/regions", canonical, {
      requireOnline: true,
      signal,
    }),
    expectedTenantId,
  );
  if (
    row.region_code !== canonical.region_code ||
    row.framework !== canonical.framework ||
    row.requires_double_optin !== canonical.requires_double_optin ||
    row.requires_explicit_consent !== canonical.requires_explicit_consent ||
    row.do_not_sell_default !== canonical.do_not_sell_default ||
    row.gpc_honored !== canonical.gpc_honored
  ) {
    throw new Error("Invalid privacy-region creation receipt");
  }
  return row;
}

export async function deletePrivacyRegion(
  id: string,
  expectedTenantId: string,
  signal?: AbortSignal,
): Promise<PrivacyPortalMutationReceipt> {
  requireTenant(expectedTenantId);
  requireRowId(id);
  return decodeMutationReceipt(
    await api.delete<unknown>(
      `/api/v1/privacy/portal/regions/${encodeURIComponent(id)}`,
      { requireOnline: true, signal },
    ),
    expectedTenantId,
    id,
  );
}

async function mutatePendingConfirmation(
  id: string,
  action: "resend" | "cancel",
  expectedTenantId: string,
  signal?: AbortSignal,
): Promise<PrivacyPortalMutationReceipt> {
  requireTenant(expectedTenantId);
  requireRowId(id);
  const value = await api.post<unknown>(
    `/api/v1/privacy/portal/double-optin/${encodeURIComponent(id)}/${action}`,
    {},
    {
      maxAttempts: 1,
      requireOnline: true,
      signal,
    },
  );
  return decodeMutationReceipt(value, expectedTenantId, id);
}

/** Extends the existing token deadline. The current backend sends no email. */
export function extendDoubleOptInWindow(
  id: string,
  expectedTenantId: string,
  signal?: AbortSignal,
): Promise<PrivacyPortalMutationReceipt> {
  return mutatePendingConfirmation(id, "resend", expectedTenantId, signal);
}

export function cancelDoubleOptIn(
  id: string,
  expectedTenantId: string,
  signal?: AbortSignal,
): Promise<PrivacyPortalMutationReceipt> {
  return mutatePendingConfirmation(id, "cancel", expectedTenantId, signal);
}

export async function getPrivacyRegions(
  expectedTenantId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<PrivacyRegion[]> {
  requireTenant(expectedTenantId);
  const value = await api.get<unknown>("/api/v1/privacy/portal/regions", opts);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["tenantId", "regions", "count"]) ||
    value.tenantId !== expectedTenantId ||
    !Array.isArray(value.regions) ||
    value.regions.length > 1_000 ||
    !count(value.count) ||
    value.count !== value.regions.length
  ) {
    throw new Error("Invalid privacy-region inventory response");
  }
  const ids = new Set<string>();
  const codes = new Set<string>();
  let previousCode = "";
  return value.regions.map((candidate) => {
    const row = decodeRegion(candidate, expectedTenantId);
    if (
      ids.has(row.id) ||
      codes.has(row.region_code) ||
      (previousCode !== "" && row.region_code <= previousCode)
    ) {
      throw new Error("Invalid privacy-region inventory");
    }
    ids.add(row.id);
    codes.add(row.region_code);
    previousCode = row.region_code;
    return row;
  });
}

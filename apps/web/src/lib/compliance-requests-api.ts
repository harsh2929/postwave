/**
 * lib/compliance-requests-api.ts — statutory requests, zero-copy triggers and
 * brand voice.
 *
 * The statutory subject-access paths use strict bounded parsing because the
 * UI must distinguish an empty legal inventory from a failed or malformed
 * read. Access creation is deliberately operation-specific; this module does
 * not expose the coverage-held erasure mutation as a callable web action.
 *
 * NAMED `compliance-requests-api` BECAUSE `reporting-api` WAS ALREADY TAKEN.
 * The first draft of this file overwrote the existing `reporting-api.ts`
 * (`reportingApi`, `ReportMetricDefinition`) which backs the /app/reports
 * page. Typecheck caught it, the file was restored, and the name checked
 * before rewriting — the second such collision in this sweep across ~40 new
 * `*-api.ts` files, in a directory that already holds 113 of them.
 *
 * `sar/requests` is the statutory one: "no outstanding requests" is a
 * compliance claim with a legal deadline attached, so an ERROR must never
 * render as that.
 *
 * `voice/brand-profile` answers 404 when none exists — a state, caught
 * specifically, with every other error still propagating.
 *
 * COVERAGE: this module wires these SAR routes plus the two existing
 * compliance helpers below:
 *   GET/POST /api/v1/sar/requests (POST is access-only)
 *   GET /api/v1/sar/requests/{id}/store-responses
 *   GET /api/v1/sar/requests/{id}.zip (validated browser navigation)
 *   /api/v1/voice/brand-profile
 *   /api/v1/zero-copy-triggers
 * Scheduled reports use the dedicated strict recipient-bearing contract in
 * `scheduled-reports-api.ts`.
 * Article 17 execution remains fail-closed by the server with
 * `erasure_coverage_incomplete` before its first write.
 */
import { api, ApiError } from "@/lib/api";

const SAR_PATH = "/api/v1/sar/requests";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,189}$/u;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const SAR_STATUSES = new Set<SarRequestStatus>([
  "pending",
  "ready",
  "failed",
]);
const SAR_PROVIDERS = new Set<SarStoreProvider>([
  "shopify",
  "woocommerce",
  "stripe",
  "square",
]);
const SAR_STORE_STATUSES = new Set<SarStoreStatus>([
  "found",
  "returned",
  "ack_required",
  "not_found",
  "error",
]);
const SAR_REGIONS = new Set<SarRegion>(["GDPR", "CCPA", "LGPD", "OTHER"]);

export const ARTICLE_17_ERASURE_HOLD_CODE = "erasure_coverage_incomplete";
export const ARTICLE_17_ERASURE_HOLD_REASON =
  "erasure is temporarily unavailable while retained-history coverage is being completed";

export type SarRequestKind = "access" | "erase";
export type SarRequestStatus = "pending" | "ready" | "failed";
export type SarRegion = "GDPR" | "CCPA" | "LGPD" | "OTHER";
export type SarStoreProvider =
  | "shopify"
  | "woocommerce"
  | "stripe"
  | "square";
export type SarStoreStatus =
  | "found"
  | "returned"
  | "ack_required"
  | "not_found"
  | "error";

export class SarContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SarContractError";
  }
}

export class SarInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SarInputError";
  }
}

export interface SarRequest {
  id: string;
  kind: SarRequestKind;
  subscriberEmail: string;
  status: SarRequestStatus;
  rowsDeleted: number | null;
  eventCount: number;
  consentCount: number;
  bundleBytes: number;
  requestedBy: string;
  requestedAt: string;
  readyAt: string | null;
  region: string;
  error: string;
}

export interface SarStoreResponse {
  id: string | null;
  provider: SarStoreProvider;
  customerId: string;
  status: SarStoreStatus;
  actionTaken: "return_only" | "none" | null;
  receiptUrl: string;
  createdAt: string | null;
}

export interface SarAccessReceipt {
  id: string;
  kind: "access";
  subscriberEmail: string;
  status: "ready";
  eventCount: number;
  consentCount: number;
  bundleBytes: number;
  downloadPath: string;
  storeResponses: SarStoreResponse[];
}

export interface BrandVoiceProfile {
  /** False when no profile exists — a 404, not a failure. */
  active: boolean;
  name?: string;
  [k: string]: unknown;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export async function listSarRequests(
  options: { email?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<SarRequest[]> {
  const query = new URLSearchParams();
  if (options.email !== undefined) {
    query.set("email", normalizeSarEmail(options.email));
  }
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new SarInputError("SAR list limit must be between 1 and 500.");
  }
  query.set("limit", String(limit));
  const response = record(
    await api.get<unknown>(`${SAR_PATH}?${query.toString()}`, {
      signal: options.signal,
      cache: "no-store",
    }),
    "SAR list response",
  );
  if (!Array.isArray(response.requests) || response.requests.length > 500) {
    throw contract("SAR requests must be a bounded array");
  }
  const requests = response.requests.map((value, index) =>
    parseSarRequest(value, `requests[${index}]`),
  );
  const seen = new Set<string>();
  for (const request of requests) {
    if (seen.has(request.id)) throw contract("SAR list contains duplicate ids");
    seen.add(request.id);
  }
  if (
    response.count !== undefined &&
    integer(response.count, "count") !== requests.length
  ) {
    throw contract("SAR list count does not match the returned rows");
  }
  return requests;
}

export async function createSarAccessRequest(
  input: {
    email: string;
    fanoutEnabled: boolean;
    notes?: string;
    region?: SarRegion;
  },
  options: { idempotencyKey: string; signal?: AbortSignal },
): Promise<SarAccessReceipt> {
  const email = normalizeSarEmail(input.email);
  if (typeof input.fanoutEnabled !== "boolean") {
    throw new SarInputError("Choose whether to search connected stores.");
  }
  const notes = optionalInputText(input.notes, "Notes", 4_096);
  const region = input.region ?? "OTHER";
  if (!SAR_REGIONS.has(region)) {
    throw new SarInputError("Choose a supported legal region.");
  }
  const idempotencyKey = boundedIdempotencyKey(options.idempotencyKey);
  const response = parseSarAccessReceipt(
    await api.post<unknown>(
      SAR_PATH,
      {
        kind: "access",
        email,
        fanout_enabled: input.fanoutEnabled,
        ...(notes ? { notes } : {}),
        region,
      },
      {
        idempotencyKey,
        requireOnline: true,
        maxAttempts: 1,
        signal: options.signal,
      },
    ),
  );
  if (response.subscriberEmail !== email) {
    throw contract("SAR create receipt does not match the requested subject");
  }
  return response;
}

export async function listSarStoreResponses(
  requestId: string,
  options: { signal?: AbortSignal } = {},
): Promise<SarStoreResponse[]> {
  const id = uuid(requestId, "SAR request id");
  const response = record(
    await api.get<unknown>(
      `${SAR_PATH}/${encodeURIComponent(id)}/store-responses`,
      {
        signal: options.signal,
        cache: "no-store",
      },
    ),
    "SAR store-response envelope",
  );
  if (uuid(response.request_id, "request_id") !== id) {
    throw contract("SAR store responses belong to another request");
  }
  if (
    !Array.isArray(response.store_responses) ||
    response.store_responses.length > 1_000
  ) {
    throw contract("SAR store responses must be a bounded array");
  }
  const rows = response.store_responses.map((value, index) =>
    parseSarStoreResponse(value, `store_responses[${index}]`),
  );
  if (integer(response.count, "count") !== rows.length) {
    throw contract("SAR store-response count does not match the rows");
  }
  return rows;
}

export function sarAccessDownloadPath(request: SarRequest): string {
  const id = uuid(request.id, "SAR request id");
  if (request.kind !== "access" || request.status !== "ready") {
    throw new SarInputError("Only ready subject-access bundles can be downloaded.");
  }
  return `${SAR_PATH}/${encodeURIComponent(id)}.zip`;
}

export function parseSarRequest(
  value: unknown,
  label = "SAR request",
): SarRequest {
  const row = record(value, label);
  const kindValue = text(row.kind, `${label}.kind`, 16);
  if (kindValue !== "access" && kindValue !== "erase") {
    throw contract(`${label}.kind is unsupported`);
  }
  const statusValue = text(row.status, `${label}.status`, 16);
  if (!SAR_STATUSES.has(statusValue as SarRequestStatus)) {
    throw contract(`${label}.status is unsupported`);
  }
  const status = statusValue as SarRequestStatus;
  const readyAt = optionalTimestamp(row.ready_at, `${label}.ready_at`);
  if (status === "ready" && readyAt === null) {
    throw contract(`${label}.ready_at is required for a ready request`);
  }
  const rowsDeleted = optionalInteger(
    row.rows_deleted,
    `${label}.rows_deleted`,
  );
  if (kindValue === "access" && rowsDeleted !== null) {
    throw contract(`${label} access row cannot report deleted rows`);
  }
  return {
    id: uuid(row.id, `${label}.id`),
    kind: kindValue,
    subscriberEmail: wireEmail(row.subscriber_email, `${label}.subscriber_email`),
    status,
    rowsDeleted,
    eventCount: integer(row.event_count, `${label}.event_count`),
    consentCount: integer(row.consent_count, `${label}.consent_count`),
    bundleBytes: integer(row.bundle_bytes, `${label}.bundle_bytes`),
    requestedBy: optionalText(row.requested_by, `${label}.requested_by`, 320),
    requestedAt: timestamp(row.requested_at, `${label}.requested_at`),
    readyAt,
    region: optionalText(row.region, `${label}.region`, 32),
    error: optionalText(row.error, `${label}.error`, 2_048),
  };
}

function parseSarAccessReceipt(value: unknown): SarAccessReceipt {
  const row = record(value, "SAR create receipt");
  if (text(row.kind, "kind", 16) !== "access") {
    throw contract("SAR create receipt kind must be access");
  }
  if (text(row.status, "status", 16) !== "ready") {
    throw contract("SAR access receipt status must be ready");
  }
  const id = uuid(row.id, "id");
  const expectedPath = `${SAR_PATH}/${encodeURIComponent(id)}.zip`;
  if (text(row.download_url, "download_url", 256) !== expectedPath) {
    throw contract("SAR receipt download route is not the authenticated bundle route");
  }
  const rawResponses = row.store_responses ?? [];
  if (!Array.isArray(rawResponses) || rawResponses.length > 1_000) {
    throw contract("SAR receipt store responses must be a bounded array");
  }
  return {
    id,
    kind: "access",
    subscriberEmail: wireEmail(row.subscriber_email, "subscriber_email"),
    status: "ready",
    eventCount: integer(row.event_count, "event_count"),
    consentCount: integer(row.consent_count, "consent_count"),
    bundleBytes: integer(row.bundle_bytes, "bundle_bytes"),
    downloadPath: expectedPath,
    storeResponses: rawResponses.map((response, index) =>
      parseSarStoreResponse(response, `store_responses[${index}]`),
    ),
  };
}

function parseSarStoreResponse(
  value: unknown,
  label: string,
): SarStoreResponse {
  const row = record(value, label);
  const providerValue = text(row.provider, `${label}.provider`, 32);
  if (!SAR_PROVIDERS.has(providerValue as SarStoreProvider)) {
    throw contract(`${label}.provider is unsupported`);
  }
  const statusValue = text(row.status, `${label}.status`, 32);
  if (statusValue === "deleted") {
    throw contract(
      `${label} reported deletion during a read-only access request`,
    );
  }
  if (!SAR_STORE_STATUSES.has(statusValue as SarStoreStatus)) {
    throw contract(`${label}.status is unsupported`);
  }
  const actionValue = optionalText(
    row.action_taken,
    `${label}.action_taken`,
    32,
  );
  if (
    actionValue !== "" &&
    actionValue !== "return_only" &&
    actionValue !== "none"
  ) {
    throw contract(
      `${label} reported a destructive or unsupported provider action`,
    );
  }
  const receiptUrl = optionalText(
    row.receipt_url,
    `${label}.receipt_url`,
    2_048,
  );
  if (receiptUrl && !isSafeHttpsUrl(receiptUrl)) {
    throw contract(`${label}.receipt_url must use HTTPS`);
  }
  return {
    id:
      row.id === undefined || row.id === null
        ? null
        : uuid(row.id, `${label}.id`),
    provider: providerValue as SarStoreProvider,
    customerId: optionalText(
      row.customer_id,
      `${label}.customer_id`,
      512,
    ),
    status: statusValue as SarStoreStatus,
    actionTaken:
      actionValue === "" ? null : (actionValue as "return_only" | "none"),
    receiptUrl,
    createdAt: optionalTimestamp(row.created_at, `${label}.created_at`),
  };
}

export function normalizeSarEmail(value: string): string {
  if (typeof value !== "string") {
    throw new SarInputError("Enter the data subject's email address.");
  }
  const email = value.trim().toLowerCase();
  if (
    email.length === 0 ||
    utf8Bytes(email) > 254 ||
    CONTROL_RE.test(email) ||
    !EMAIL_RE.test(email)
  ) {
    throw new SarInputError(
      "Enter a complete data-subject email address of 254 characters or fewer.",
    );
  }
  return email;
}

function boundedIdempotencyKey(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 255 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new SarInputError(
      "A stable 1–255 character idempotency key is required.",
    );
  }
  return value;
}

function optionalInputText(
  value: string | undefined,
  label: string,
  maxBytes: number,
): string {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new SarInputError(`${label} must be text.`);
  }
  const parsed = value.trim();
  if (utf8Bytes(parsed) > maxBytes || CONTROL_RE.test(parsed)) {
    throw new SarInputError(
      `${label} must be ${maxBytes.toLocaleString()} UTF-8 bytes or fewer and cannot contain control characters.`,
    );
  }
  return parsed;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contract(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    utf8Bytes(value) > maxBytes ||
    CONTROL_RE.test(value)
  ) {
    throw contract(`${label} must be bounded text`);
  }
  return value;
}

function optionalText(
  value: unknown,
  label: string,
  maxBytes: number,
): string {
  if (value === null || value === undefined) return "";
  return text(value, label, maxBytes);
}

function uuid(value: unknown, label: string): string {
  const parsed = text(value, label, 36);
  if (!UUID_RE.test(parsed)) throw contract(`${label} must be a canonical UUID`);
  return parsed;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw contract(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function optionalInteger(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return integer(value, label);
}

function timestamp(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (parsed.startsWith("0001-01-01") || !Number.isFinite(Date.parse(parsed))) {
    throw contract(`${label} must be a real timestamp`);
  }
  return parsed;
}

function optionalTimestamp(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return timestamp(value, label);
}

function wireEmail(value: unknown, label: string): string {
  const parsed = text(value, label, 254);
  if (parsed !== parsed.trim().toLowerCase() || !EMAIL_RE.test(parsed)) {
    throw contract(`${label} must be a normalized email address`);
  }
  return parsed;
}

function isSafeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function contract(message: string): SarContractError {
  return new SarContractError(`SAR response contract violation: ${message}.`);
}

export async function listZeroCopyTriggers(): Promise<unknown[]> {
  const res = await api.get<{ items?: unknown }>("/api/v1/zero-copy-triggers");
  return asArray(res?.items);
}

export async function getBrandVoiceProfile(): Promise<BrandVoiceProfile> {
  try {
    const res = await api.get<BrandVoiceProfile>("/api/v1/voice/brand-profile");
    return { ...res, active: true };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { active: false };
    throw err;
  }
}

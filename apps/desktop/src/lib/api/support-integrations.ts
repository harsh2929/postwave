import type {
  NativeIntegrationIngestSummary,
  NativeIntegrationRunsResponse,
} from "./crm-integrations";
import type { ApiResult } from "./result";

interface NativeProviderRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

type SupportIntegrationsRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: NativeProviderRequestOptions,
) => Promise<ApiResult<T>>;

export const SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE =
  "support_integration_runtime_held" as const;

function supportRuntimeHeld<T>(): Promise<ApiResult<T>> {
  return Promise.resolve({
    error: {
      message:
        "Support provider runtime is release-held. No support runtime request was sent.",
      status: 503,
      code: SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE,
      kind: "http",
    },
    retryability: "not-retryable",
  });
}

/* ---------- Native support integrations ------------------------------- */

export interface SupportProviderSpec {
  key: string;
  name: string;
  runtime_status: "held";
  hold_code: typeof SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE;
}

export interface SupportProviderCatalog {
  items: SupportProviderSpec[];
  complete: true;
  provenance: {
    tenant_bound: false;
    source: "static_server_catalog";
  };
}

export interface SupportIntegration {
  tenantId: string;
  tenant_id: string;
  id: string;
  provider: string;
  name: string;
  status: "connected" | "active" | "paused" | "error" | "disconnected";
  runtime_status: "held";
  hold_code: typeof SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE;
  credential_configured: boolean;
  created_at: string;
  updated_at: string;
}

export interface SupportIntegrationList {
  tenantId: string;
  items: SupportIntegration[];
  page: {
    has_more: boolean;
    next_cursor: string | null;
    as_of: string;
    consistency: "mutable_window";
    may_reorder: true;
  };
}

export interface SupportIntegrationPageWindow {
  asOf: string;
  consistency: "mutable_window";
}

export interface SupportIntegrationListOptions {
  limit?: number;
  cursor?: string;
  /** Required for a cursor page so a changed server window fails closed. */
  expectedWindow?: SupportIntegrationPageWindow;
  signal?: AbortSignal;
}

export interface SupportIntegrationInput {
  provider: string;
  name?: string;
  status?: string;
  scopes?: string[];
  credentials_ref?: string;
  settings?: Record<string, unknown>;
}

export interface SupportDisconnectCleanupEvidence {
  provider: string;
  status: string;
  recorded_at?: string;
  postwave_status: string;
  provider_cleanup_posture: string;
  managed_provider_cleanup: boolean;
  provider_scope_type?: string;
  provider_scope_id?: string;
  provider_webhook_id?: string;
  credential_ref_present?: boolean;
  webhook_secret_ref_present?: boolean;
  webhook_cleanup_status: string;
  credential_cleanup_status: string;
  postwave_effects?: string[];
  provider_console_actions?: string[];
  provider_cleanup_evidence?: string[];
}

export interface SupportDisconnectResponse {
  ok: boolean;
  provider_cleanup?: SupportDisconnectCleanupEvidence;
}

export interface SupportSyncSummary {
  integration_id: string;
  run_id?: string;
  status: string;
  tickets_seen: number;
  tickets_upserted: number;
  messages_seen: number;
  messages_upserted: number;
  profiles_upserted: number;
  events_seen: number;
  events_tracked: number;
  rows_failed: number;
  cursor?: string;
  error_message?: string;
}

const SAFE_KEY_RE = /^[a-z0-9_-]{1,64}$/u;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RFC3339_NANO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const DISPLAY_POISON_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
// The server emits and accepts only unpadded base64url cursor tokens. Keep the
// renderer contract exact so whitespace, query punctuation, and other hostile
// opaque values fail locally instead of reaching transport or being offered as
// a continuation token.
const OPAQUE_CURSOR_RE = /^[A-Za-z0-9_-]{1,4096}$/u;
const encoder = new TextEncoder();

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function boundedDisplay(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    encoder.encode(value).byteLength <= maxBytes &&
    !DISPLAY_POISON_RE.test(value)
  );
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !RFC3339_NANO_RE.test(value)) return false;
  const millis = Date.parse(value);
  const year = Number(value.slice(0, 4));
  return Number.isFinite(millis) && year >= 2000 && year < 2100;
}

export function decodeSupportProviderCatalog(
  value: unknown,
): SupportProviderCatalog | null {
  const envelope = record(value);
  if (
    !envelope ||
    !exactKeys(envelope, ["items", "complete", "provenance"]) ||
    envelope.complete !== true ||
    !Array.isArray(envelope.items) ||
    envelope.items.length > 100
  ) {
    return null;
  }
  const provenance = record(envelope.provenance);
  if (
    !provenance ||
    !exactKeys(provenance, ["tenant_bound", "source"]) ||
    provenance.tenant_bound !== false ||
    provenance.source !== "static_server_catalog"
  ) {
    return null;
  }
  const seen = new Set<string>();
  const items: SupportProviderSpec[] = [];
  for (const candidate of envelope.items) {
    const item = record(candidate);
    if (
      !item ||
      !exactKeys(item, ["key", "name", "runtime_status", "hold_code"]) ||
      typeof item.key !== "string" ||
      !SAFE_KEY_RE.test(item.key) ||
      seen.has(item.key) ||
      !boundedDisplay(item.name, 200) ||
      item.runtime_status !== "held" ||
      item.hold_code !== SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE
    ) {
      return null;
    }
    seen.add(item.key);
    items.push({
      key: item.key,
      name: item.name,
      runtime_status: "held",
      hold_code: SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE,
    });
  }
  return {
    items,
    complete: true,
    provenance: { tenant_bound: false, source: "static_server_catalog" },
  };
}

export function decodeSupportIntegrationList(
  value: unknown,
): SupportIntegrationList | null {
  const envelope = record(value);
  if (
    !envelope ||
    !exactKeys(envelope, ["tenantId", "items", "page"]) ||
    typeof envelope.tenantId !== "string" ||
    !UUID_RE.test(envelope.tenantId) ||
    !Array.isArray(envelope.items) ||
    envelope.items.length > 100
  ) {
    return null;
  }
  const page = record(envelope.page);
  if (
    !page ||
    !exactKeys(page, [
      "has_more",
      "next_cursor",
      "as_of",
      "consistency",
      "may_reorder",
    ]) ||
    typeof page.has_more !== "boolean" ||
    !timestamp(page.as_of) ||
    page.consistency !== "mutable_window" ||
    page.may_reorder !== true ||
    (page.next_cursor !== null &&
      (typeof page.next_cursor !== "string" ||
        !OPAQUE_CURSOR_RE.test(page.next_cursor))) ||
    page.has_more !== (page.next_cursor !== null)
  ) {
    return null;
  }
  const seen = new Set<string>();
  const items: SupportIntegration[] = [];
  for (const candidate of envelope.items) {
    const item = record(candidate);
    if (
      !item ||
      !exactKeys(item, [
        "tenantId",
        "tenant_id",
        "id",
        "provider",
        "name",
        "status",
        "runtime_status",
        "hold_code",
        "credential_configured",
        "created_at",
        "updated_at",
      ]) ||
      item.tenantId !== envelope.tenantId ||
      item.tenant_id !== envelope.tenantId ||
      typeof item.id !== "string" ||
      !UUID_RE.test(item.id) ||
      seen.has(item.id) ||
      typeof item.provider !== "string" ||
      !SAFE_KEY_RE.test(item.provider) ||
      !boundedDisplay(item.name, 200) ||
      !["connected", "active", "paused", "error", "disconnected"].includes(
        String(item.status),
      ) ||
      item.runtime_status !== "held" ||
      item.hold_code !== SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE ||
      typeof item.credential_configured !== "boolean" ||
      !timestamp(item.created_at) ||
      !timestamp(item.updated_at) ||
      Date.parse(item.updated_at) < Date.parse(item.created_at) ||
      Date.parse(item.updated_at) > Date.parse(page.as_of as string)
    ) {
      return null;
    }
    seen.add(item.id);
    items.push(item as unknown as SupportIntegration);
  }
  return {
    tenantId: envelope.tenantId,
    items,
    page: page as unknown as SupportIntegrationList["page"],
  };
}

function invalidProjection<T>(message: string): ApiResult<T> {
  return {
    error: {
      message,
      code: "support_integration_projection_invalid",
      kind: "parse",
    },
    retryability: "manual",
  };
}

function invalidListOptions<T>(message: string): ApiResult<T> {
  return {
    error: {
      message,
      code: "support_integration_list_options_invalid",
      kind: "invalid_config",
    },
    retryability: "not-retryable",
  };
}

function decodeExpectedPageWindow(
  value: unknown,
): SupportIntegrationPageWindow | null {
  try {
    const row = record(value);
    if (
      !row ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(row)) ||
      !exactKeys(row, ["asOf", "consistency"]) ||
      !timestamp(row.asOf) ||
      row.consistency !== "mutable_window"
    ) {
      return null;
    }
    return { asOf: row.asOf, consistency: "mutable_window" };
  } catch {
    return null;
  }
}

export function createSupportIntegrationsApi(
  request: SupportIntegrationsRequester,
) {
  return {
    async providers(
      signal?: AbortSignal,
    ): Promise<ApiResult<SupportProviderCatalog>> {
      const result = await request<unknown>(
        "/api/v1/support-integrations/providers",
        undefined,
        signal ? { signal } : undefined,
      );
      if (result.error) return result;
      const decoded = decodeSupportProviderCatalog(result.data);
      return decoded
        ? { data: decoded }
        : invalidProjection(
            "The support provider catalog did not match its static held projection.",
          );
    },
    async list(
      options: SupportIntegrationListOptions = {},
    ): Promise<ApiResult<SupportIntegrationList>> {
      const {
        cursor,
        expectedWindow: rawExpectedWindow,
        limit,
        signal,
      } = options;
      const expectedWindow =
        rawExpectedWindow === undefined
          ? null
          : decodeExpectedPageWindow(rawExpectedWindow);
      if (
        limit !== undefined &&
        (typeof limit !== "number" ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100)
      ) {
        return invalidListOptions(
          "Support integration page size must be an integer from 1 through 100.",
        );
      }
      if (
        cursor !== undefined &&
        (typeof cursor !== "string" || !OPAQUE_CURSOR_RE.test(cursor))
      ) {
        return invalidListOptions(
          "Support integration cursor did not match the bounded opaque cursor contract.",
        );
      }
      if (Boolean(cursor) !== (rawExpectedWindow !== undefined)) {
        return invalidListOptions(
          "A support integration cursor page requires its first-page window, and a first-page request cannot claim one.",
        );
      }
      if (rawExpectedWindow !== undefined && expectedWindow === null) {
        return invalidListOptions(
          "The expected support integration page window is invalid.",
        );
      }
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
      if (cursor !== undefined) params.set("cursor", cursor);
      const query = params.size > 0 ? `?${params.toString()}` : "";
      const result = await request<unknown>(
        `/api/v1/support-integrations${query}`,
        undefined,
        signal ? { signal } : undefined,
      );
      if (result.error) return result;
      const decoded = decodeSupportIntegrationList(result.data);
      if (!decoded) {
        return invalidProjection(
          "The support integration list did not match its minimized tenant projection.",
        );
      }
      if (
        expectedWindow &&
        (decoded.page.as_of !== expectedWindow.asOf ||
          decoded.page.consistency !== expectedWindow.consistency)
      ) {
        return invalidProjection(
          "The support integration cursor page changed its verified list window.",
        );
      }
      return { data: decoded };
    },
    create(
      _input: SupportIntegrationInput,
    ): Promise<ApiResult<SupportIntegration>> {
      return supportRuntimeHeld<SupportIntegration>();
    },
    sync(
      _id: string,
      _input: Record<string, unknown> = {},
    ): Promise<ApiResult<SupportSyncSummary>> {
      return supportRuntimeHeld<SupportSyncSummary>();
    },
    backfill(
      _id: string,
      _input: Record<string, unknown> = {},
    ): Promise<ApiResult<SupportSyncSummary>> {
      return supportRuntimeHeld<SupportSyncSummary>();
    },
    ingest(
      _id: string,
      _input: Record<string, unknown>,
    ): Promise<ApiResult<NativeIntegrationIngestSummary>> {
      return supportRuntimeHeld<NativeIntegrationIngestSummary>();
    },
    pause(_id: string): Promise<ApiResult<SupportIntegration>> {
      return supportRuntimeHeld<SupportIntegration>();
    },
    disconnect(_id: string): Promise<ApiResult<SupportDisconnectResponse>> {
      return supportRuntimeHeld<SupportDisconnectResponse>();
    },
    runs(
      _id: string,
      _limit = 25,
    ): Promise<ApiResult<NativeIntegrationRunsResponse>> {
      return supportRuntimeHeld<NativeIntegrationRunsResponse>();
    },
  };
}

import type { ApiResult } from "./result";

interface NativeFacadeRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

type ServiceSuiteRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: NativeFacadeRequestOptions,
) => Promise<ApiResult<T>>;

const OPAQUE_CURSOR_POISON_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;

function safeOpaqueCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !OPAQUE_CURSOR_POISON_RE.test(value)
  );
}

function invalidCursor<T>(): Promise<ApiResult<T>> {
  return Promise.resolve({
    error: {
      message:
        "The pagination cursor did not match the bounded opaque cursor contract.",
      code: "helpdesk_cursor_invalid",
      kind: "invalid_config",
    },
    retryability: "not-retryable",
  });
}

export interface ServiceSuitePageInfo {
  has_more: boolean;
  next_cursor?: string | null;
  as_of: string;
  consistency: string;
  may_reorder: boolean;
}

export interface ServiceSuiteCollection<T> {
  tenantId: string;
  items: T[];
  page: ServiceSuitePageInfo;
}

/* ---------- KLV-10 Service suite (helpdesk + customer hub + agent) --- */

/** GET /api/v1/service-suite/catalog — descriptor of enums + guardrail. */
export interface ServiceSuiteCatalog {
  schema_version: string;
  provenance: {
    tenant_bound: false;
    source: "static_server_catalog";
  };
  channels: unknown[];
  conversation_statuses: string[];
  agent_run_types: string[];
  capabilities: Record<string, unknown>;
  /** The agent guardrail descriptor (read-only display). */
  guardrail: unknown;
}

/** A support conversation (service_suite.Conversation), json tags 1:1. */
export interface ServiceConversation {
  tenantId: string;
  id?: string;
  tenant_id: string;
  /** Strong resource version mirrored by the response ETag. */
  version: string;
  channel_id?: string;
  channel_type: string;
  /** e.g. inbound_email | sms | web_chat — note inbound email is NOT
   *  auto-bridged today; only manually-created/SMS conversations populate. */
  source_type: string;
  subscriber_id?: string;
  requester_email?: string;
  requester_phone?: string;
  requester_name?: string;
  subject?: string;
  status: string;
  priority: string;
  assigned_to?: string;
  /** Verified server-derived tenant member identity for current assignments. */
  assigned_to_user_id?: string;
  assignment_state: "tenant_active_user" | "unassigned" | "legacy_unverified";
  tags?: string[];
  last_message_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

/** A message in a conversation (service_suite.Message). */
export interface ServiceMessage {
  tenantId: string;
  id?: string;
  tenant_id: string;
  conversation_id?: string;
  source_type?: string;
  /** inbound | outbound */
  direction: string;
  /** customer | agent | system | … */
  sender_type: string;
  sender?: string;
  body_text?: string;
  body_html?: string;
  /** New internal-note writes return these server-owned truth fields. */
  record_kind: string;
  delivery_status: string;
  body_omitted_reason?: string;
  attachment_count: number;
  projection_truncated: boolean;
  sent_at?: string;
  created_at?: string;
}

/** A support ticket associated with a conversation. `due_at` is recorded
 * timing evidence only; no governed service-level policy is exposed. */
export interface ServiceTicket {
  tenantId: string;
  id?: string;
  tenant_id: string;
  version: string;
  conversation_id?: string;
  ticket_number?: number;
  title: string;
  status: string;
  priority: string;
  assignee?: string;
  assignment_state: "unassigned" | "legacy_unverified";
  source_channel?: string;
  due_at?: string | null;
  resolved_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

/** A canned reply (service_suite.Macro). */
export interface ServiceMacro {
  tenantId: string;
  id?: string;
  tenant_id: string;
  version: string;
  name: string;
  body: string;
  channel_types?: string[];
  tags?: string[];
  status: string;
  use_count?: number;
  last_used_at?: string | null;
  usage_evidence_status: "unverified";
  created_at?: string;
  updated_at?: string;
}

/** Customer Hub config (service_suite.HubConfig). */
export interface ServiceHubConfig {
  tenantId: string;
  tenant_id: string;
  version: string;
  status: string;
  storefronts: unknown[];
  content_blocks: unknown[];
  personalization_rules: Record<string, unknown>;
  support_settings: Record<string, unknown>;
  order_history_enabled: boolean;
  favorites_enabled: boolean;
  coupons_enabled: boolean;
  recommendations_enabled: boolean;
  customer_agent_enabled: boolean;
  /** Server-owned release truth; persisted intent never implies runtime. */
  runtime_available: false;
  runtime_status: "held";
  runtime_reason_code: "customer_hub_runtime_unavailable";
  customer_agent_effective_enabled: false;
  styling: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

/** Complete body for replacement-semantics PUT /service-suite/config. */
export interface ServiceHubConfigReplacement {
  status: string;
  order_history_enabled: boolean;
  favorites_enabled: boolean;
  coupons_enabled: boolean;
  recommendations_enabled: boolean;
  customer_agent_enabled: boolean;
  storefronts: unknown[];
  content_blocks: unknown[];
  personalization_rules: Record<string, unknown>;
  support_settings: Record<string, unknown>;
  styling: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

/** Backward-compatible name. PUT is replacement semantics, not a patch. */
export type ServiceHubConfigPatch = ServiceHubConfigReplacement;

/** The result of an agent draft-reply run (service_suite.AgentRun). The
 *  guardrail fields (safety_flags, handoff_reason, tool_plan, status) MUST
 *  be rendered READ-ONLY — they prove the agent can't mutate orders/refunds
 *  and flag when a human handoff is required. */
export interface ServiceAgentRun {
  tenantId: string;
  id?: string;
  tenant_id: string;
  conversation_id?: string;
  ticket_id?: string;
  run_type?: string;
  /** drafted | needs_handoff | … */
  status: string;
  model?: string;
  prompt?: string;
  draft?: string;
  safety_flags?: string[];
  handoff_reason?: string;
  tool_plan?: Record<string, unknown>;
  /** Current foundation is deterministic local templating only. */
  execution_mode?: string;
  provider_executed?: boolean;
  created_at?: string;
  updated_at?: string;
}

const RESOURCE_VERSION_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

/** Exact server-owned version accepted by the service-suite strong ETag wire. */
export function isServiceSuiteResourceVersion(value: unknown): value is string {
  if (typeof value !== "string" || !RESOURCE_VERSION_RE.test(value)) {
    return false;
  }
  const fraction = /\.(\d+)Z$/u.exec(value)?.[1] ?? null;
  const parsed = Date.parse(value);
  return (
    (fraction === null || !fraction.endsWith("0")) &&
    Number.isFinite(parsed) &&
    parsed >= Date.parse("2000-01-01T00:00:00Z") &&
    parsed < Date.parse("2100-01-01T00:00:00Z") &&
    new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

/** The `absent` sentinel is valid only for the normalized no-row Hub config. */
export function isServiceSuiteHubConfigVersion(
  value: unknown,
): value is string {
  return value === "absent" || isServiceSuiteResourceVersion(value);
}

function ifMatch(version: string, allowAbsent = false): string {
  const valid = allowAbsent
    ? isServiceSuiteHubConfigVersion(version)
    : isServiceSuiteResourceVersion(version);
  if (!valid) {
    throw new TypeError(
      "A verified service-suite resource version is required.",
    );
  }
  return `"${version}"`;
}

export function createServiceSuiteApi(request: ServiceSuiteRequester) {
  return {
    /** GET /api/v1/service-suite/catalog. */
    catalog(): Promise<ApiResult<ServiceSuiteCatalog>> {
      return request<ServiceSuiteCatalog>("/api/v1/service-suite/catalog");
    },
    /** GET /api/v1/service-suite/config — current Customer Hub config. */
    config(
      opts: { signal?: AbortSignal } = {},
    ): Promise<ApiResult<ServiceHubConfig>> {
      return request<ServiceHubConfig>(
        "/api/v1/service-suite/config",
        undefined,
        opts.signal ? { signal: opts.signal } : undefined,
      );
    },
    /** PUT /api/v1/service-suite/config (admin), complete replacement. */
    updateConfig(
      replacement: ServiceHubConfigReplacement,
      version: string,
    ): Promise<ApiResult<ServiceHubConfig>> {
      return request<ServiceHubConfig>(
        "/api/v1/service-suite/config",
        {
          method: "PUT",
          headers: { "If-Match": ifMatch(version, true) },
          body: JSON.stringify(replacement),
        },
        { maxAttempts: 1 },
      );
    },
    /** GET /api/v1/service-suite/conversations?status= → `{items}`. */
    listConversations(
      opts: {
        status?: string;
        cursor?: string;
        limit?: number;
        signal?: AbortSignal;
      } = {},
    ): Promise<ApiResult<ServiceSuiteCollection<ServiceConversation>>> {
      if (opts.cursor !== undefined && !safeOpaqueCursor(opts.cursor)) {
        return invalidCursor();
      }
      const params = new URLSearchParams();
      if (opts.status) params.set("status", opts.status);
      if (opts.cursor) params.set("cursor", opts.cursor);
      if (opts.limit) params.set("limit", String(opts.limit));
      const qs = params.size > 0 ? `?${params.toString()}` : "";
      return request<ServiceSuiteCollection<ServiceConversation>>(
        `/api/v1/service-suite/conversations${qs}`,
        undefined,
        opts.signal ? { signal: opts.signal } : undefined,
      );
    },
    /** GET /api/v1/service-suite/conversations/{id}. */
    getConversation(
      id: string,
      opts: { signal?: AbortSignal } = {},
    ): Promise<ApiResult<ServiceConversation>> {
      return request<ServiceConversation>(
        `/api/v1/service-suite/conversations/${encodeURIComponent(id)}`,
        undefined,
        opts.signal ? { signal: opts.signal } : undefined,
      );
    },
    /** GET /api/v1/service-suite/conversations/{id}/messages → `{items}`. */
    listMessages(
      id: string,
      opts: {
        order?: "asc" | "desc";
        cursor?: string;
        limit?: number;
        signal?: AbortSignal;
      } = {},
    ): Promise<ApiResult<ServiceSuiteCollection<ServiceMessage>>> {
      if (opts.cursor !== undefined && !safeOpaqueCursor(opts.cursor)) {
        return invalidCursor();
      }
      const params = new URLSearchParams();
      if (opts.order) params.set("order", opts.order);
      if (opts.cursor) params.set("cursor", opts.cursor);
      if (opts.limit) params.set("limit", String(opts.limit));
      const qs = params.size > 0 ? `?${params.toString()}` : "";
      return request<ServiceSuiteCollection<ServiceMessage>>(
        `/api/v1/service-suite/conversations/${encodeURIComponent(id)}/messages${qs}`,
        undefined,
        opts.signal ? { signal: opts.signal } : undefined,
      );
    },
    /** GET /api/v1/service-suite/tickets?status= → `{items}`. Used read-only
     * to join authoritative ticket due dates onto the conversation queue. */
    listTickets(
      opts: {
        status?: string;
        conversationId?: string;
        cursor?: string;
        limit?: number;
        signal?: AbortSignal;
      } = {},
    ): Promise<ApiResult<ServiceSuiteCollection<ServiceTicket>>> {
      if (opts.cursor !== undefined && !safeOpaqueCursor(opts.cursor)) {
        return invalidCursor();
      }
      const params = new URLSearchParams();
      if (opts.status) params.set("status", opts.status);
      if (opts.conversationId)
        params.set("conversation_id", opts.conversationId);
      if (opts.cursor) params.set("cursor", opts.cursor);
      if (opts.limit) params.set("limit", String(opts.limit));
      const qs = params.size > 0 ? `?${params.toString()}` : "";
      return request<ServiceSuiteCollection<ServiceTicket>>(
        `/api/v1/service-suite/tickets${qs}`,
        undefined,
        opts.signal ? { signal: opts.signal } : undefined,
      );
    },
    /** Persist a durable internal note. The caller must prepare one encrypted,
     * identity-scoped key for the exact body hash/conversation intent. An
     * ambiguous outcome is held for review and is never auto-retried. */
    postInternalNote(
      id: string,
      input: { body_text: string },
      idempotencyKey: string,
    ): Promise<ApiResult<ServiceMessage>> {
      return request<ServiceMessage>(
        `/api/v1/service-suite/conversations/${encodeURIComponent(id)}/internal-notes`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({ body_text: input.body_text }),
        },
        { maxAttempts: 1 },
      );
    },
    /** POST .../conversations/{id}/assign (admin). */
    assign(
      id: string,
      input: { action: "assign_self" | "unassign"; reason?: string },
      version: string,
    ): Promise<ApiResult<ServiceConversation>> {
      return request<ServiceConversation>(
        `/api/v1/service-suite/conversations/${encodeURIComponent(id)}/assign`,
        {
          method: "POST",
          headers: { "If-Match": ifMatch(version) },
          body: JSON.stringify(input),
        },
        { maxAttempts: 1 },
      );
    },
    /** POST .../conversations/{id}/status (admin). */
    setStatus(
      id: string,
      status: string,
      version: string,
    ): Promise<ApiResult<ServiceConversation>> {
      return request<ServiceConversation>(
        `/api/v1/service-suite/conversations/${encodeURIComponent(id)}/status`,
        {
          method: "POST",
          headers: { "If-Match": ifMatch(version) },
          body: JSON.stringify({ status }),
        },
        { maxAttempts: 1 },
      );
    },
    /** GET /api/v1/service-suite/macros → `{items}`. */
    listMacros(
      opts: {
        cursor?: string;
        limit?: number;
        signal?: AbortSignal;
      } = {},
    ): Promise<ApiResult<ServiceSuiteCollection<ServiceMacro>>> {
      if (opts.cursor !== undefined && !safeOpaqueCursor(opts.cursor)) {
        return invalidCursor();
      }
      const params = new URLSearchParams();
      if (opts.cursor) params.set("cursor", opts.cursor);
      if (opts.limit) params.set("limit", String(opts.limit));
      const qs = params.size > 0 ? `?${params.toString()}` : "";
      return request<ServiceSuiteCollection<ServiceMacro>>(
        `/api/v1/service-suite/macros${qs}`,
        undefined,
        opts.signal ? { signal: opts.signal } : undefined,
      );
    },
    // Customer Agent draft creation is intentionally absent from this facade.
    // The backend source-holds that non-idempotent create with
    // `customer_agent_draft_write_held`; the renderer must not probe it.
  };
}

/** Strict catalog/config client for the web Service-suite availability page. */
import { api } from "@/lib/api";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TOKEN_RE = /^[a-z0-9_-]{1,64}$/u;
const RFC3339_NANO_UTC_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const SERVICE_SUITE_TIME_MIN_MS = Date.UTC(2000, 0, 1);
const SERVICE_SUITE_TIME_MAX_MS = Date.UTC(2100, 0, 1);
const UNSAFE_DISPLAY_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const CONFIG_STATUSES = new Set(["draft", "active", "paused", "archived"]);
const CONVERSATION_STATUSES = [
  "open",
  "pending",
  "waiting",
  "resolved",
  "closed",
  "spam",
  "archived",
] as const;
const CATALOG_CHANNELS = [
  ["web_chat", "Web chat"],
  ["email", "Email"],
  ["sms", "SMS"],
  ["instagram", "Instagram"],
  ["whatsapp", "WhatsApp"],
  ["facebook", "Facebook"],
] as const;

export class ServiceSuiteContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceSuiteContractError";
  }
}

/**
 * The object-shaped Hub fields this client never edits. PUT is a complete
 * replacement (the server rejects a body missing any of them), so they are
 * carried forward exactly as the verified GET returned them.
 */
export interface ServiceSuiteConfigCarry {
  storefronts: unknown[];
  content_blocks: unknown[];
  personalization_rules: Record<string, unknown>;
  support_settings: Record<string, unknown>;
  styling: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface ServiceSuiteConfig {
  tenantId: string;
  version: string;
  status: string;
  orderHistoryEnabled: boolean;
  favoritesEnabled: boolean;
  couponsEnabled: boolean;
  recommendationsEnabled: boolean;
  customerAgentEnabled: boolean;
  runtimeAvailable: false;
  runtimeStatus: "held";
  runtimeReasonCode: "customer_hub_runtime_unavailable";
  customerAgentEffectiveEnabled: false;
  updatedAt: string | null;
  /**
   * Null when any object-shaped field is missing, malformed, or oversized.
   * The record still displays, but no replacement may be built from it: a
   * guessed default would silently erase stored storefront configuration.
   */
  replacementCarry: ServiceSuiteConfigCarry | null;
}

/** The scalar subset the Customer Hub form edits. */
export interface CustomerHubDraft {
  status: string;
  orderHistoryEnabled: boolean;
  favoritesEnabled: boolean;
  couponsEnabled: boolean;
  recommendationsEnabled: boolean;
  customerAgentEnabled: boolean;
}

/** Record lifecycle values an administrator may choose. "active" is held. */
export const CUSTOMER_HUB_EDITABLE_STATUSES = [
  "draft",
  "paused",
  "archived",
] as const;

export const CUSTOMER_HUB_RELEASE_HOLD_MESSAGE =
  "Customer Hub publication and Customer Agent enablement are release-held.";

export interface ServiceChannel {
  key: string;
  label: string;
  runtimeStatus: string;
}

export interface ServiceCapability {
  key: string;
  status: string;
  code: string | null;
  executionMode: string | null;
}

export interface ServiceSuiteCatalog {
  schemaVersion: "postwave.service_suite.v2";
  provenance: {
    tenantBound: false;
    source: "static_server_catalog";
  };
  channels: ServiceChannel[];
  conversationStatuses: string[];
  capabilities: ServiceCapability[];
  guardrail: {
    draftOnly: true;
    providerExecuted: false;
    customerMutations: false;
    requiresHumanReview: true;
  };
}

// --- Customer Agent draft reply (messaging-51) ----------------------------
//
// Desktop parity: apps/desktop/src/components/helpdesk/CustomerAgentPanel.tsx
// renders "Generate draft — unavailable" and never probes the endpoint; its
// facade deliberately omits the transport. Web carries the transport so the
// verb is complete, but the ONLY gate is the server's own catalog signal: the
// `customer_agent` capability must report `available`. While it reports
// `held` (code `customer_agent_draft_write_held`) nothing leaves the client.

export const CUSTOMER_AGENT_DRAFT_HOLD_CODE =
  "customer_agent_draft_write_held" as const;

/** Body of POST /api/v1/service-suite/agent/draft-reply (DraftReplyRequest). */
export interface CustomerAgentDraftInput {
  conversation_id: string;
  ticket_id?: string;
  prompt?: string;
  tone?: string;
}

export interface CustomerAgentDraftRun {
  id?: string;
  run_type?: string;
  status?: string;
  draft?: string;
  [key: string]: unknown;
}

export class CustomerAgentDraftHeldError extends Error {
  readonly code: string;
  readonly status = 409;
  readonly retryable = false;

  constructor(code: string | null) {
    super(
      "Draft creation is release-held by the static catalog; no request was sent.",
    );
    this.name = "CustomerAgentDraftHeldError";
    this.code = code ?? CUSTOMER_AGENT_DRAFT_HOLD_CODE;
  }
}

/** The catalog's `customer_agent` capability row, or null when absent. */
export function customerAgentCapability(
  catalog: ServiceSuiteCatalog | null | undefined,
): ServiceCapability | null {
  if (!catalog || !Array.isArray(catalog.capabilities)) return null;
  return (
    catalog.capabilities.find((row) => row.key === "customer_agent") ?? null
  );
}

/** True only when the server catalog reports the draft verb as available. */
export function customerAgentDraftAvailable(
  catalog: ServiceSuiteCatalog | null | undefined,
): boolean {
  return customerAgentCapability(catalog)?.status === "available";
}

/**
 * Desktop parity `catalogGuardrailText`: the one sentence the panel shows
 * for the frozen guardrail, or a withholding sentence for anything else.
 */
export function catalogGuardrailText(
  catalog: ServiceSuiteCatalog | null | undefined,
): string {
  const guardrail = catalog?.guardrail;
  if (!guardrail) return "";
  if (
    guardrail.draftOnly === true &&
    guardrail.providerExecuted === false &&
    guardrail.customerMutations === false &&
    guardrail.requiresHumanReview === true
  ) {
    return "Draft only; no provider or customer mutation is executed, and human review is required.";
  }
  return "Unrecognized guardrail data was withheld; treat every output as a held draft requiring human review.";
}

/**
 * POST /api/v1/service-suite/agent/draft-reply — a non-idempotent create.
 * Callable only when `catalog` says the capability is available; otherwise
 * throws CustomerAgentDraftHeldError before transport.
 */
export async function draftCustomerAgentReply(
  catalog: ServiceSuiteCatalog | null | undefined,
  input: CustomerAgentDraftInput,
  options: { signal?: AbortSignal } = {},
): Promise<CustomerAgentDraftRun> {
  const capability = customerAgentCapability(catalog);
  if (capability?.status !== "available") {
    throw new CustomerAgentDraftHeldError(capability?.code ?? null);
  }
  const conversationId = input.conversation_id.trim();
  if (!conversationId) throw new Error("Pick a conversation to draft for.");
  const body: CustomerAgentDraftInput = { conversation_id: conversationId };
  if (input.ticket_id?.trim()) body.ticket_id = input.ticket_id.trim();
  if (input.prompt?.trim()) body.prompt = input.prompt.trim();
  if (input.tone?.trim()) body.tone = input.tone.trim();
  return api.post<CustomerAgentDraftRun>(
    "/api/v1/service-suite/agent/draft-reply",
    body,
    { ...options, requireOnline: true, maxAttempts: 1 },
  );
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceSuiteContractError(label + " must be an object");
  }
  return value as Record<string, unknown>;
}

function exactObject(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  const raw = object(value, label);
  const actual = Object.keys(raw).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new ServiceSuiteContractError(label + " has unsupported fields");
  }
  return raw;
}

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const rune of value) {
    const point = rune.codePointAt(0) as number;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function text(value: unknown, label: string, maxBytes = 500): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ServiceSuiteContractError(label + " is required");
  }
  if (UNSAFE_DISPLAY_RE.test(value) || utf8Bytes(value) > maxBytes) {
    throw new ServiceSuiteContractError(label + " is unsafe to display");
  }
  return value;
}

function token(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!TOKEN_RE.test(parsed)) {
    throw new ServiceSuiteContractError(label + " is invalid");
  }
  return parsed;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new ServiceSuiteContractError(label + " is invalid");
  }
  return value;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ServiceSuiteContractError(label + " must be a boolean");
  }
  return value;
}

function optionalTimestamp(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  const parsed = text(value, label);
  const match = RFC3339_NANO_UTC_RE.exec(parsed);
  const fraction = /\.(\d+)Z$/u.exec(parsed)?.[1] ?? null;
  const epochMillis = Date.parse(parsed);
  if (
    !match ||
    (fraction !== null && fraction.endsWith("0")) ||
    !Number.isFinite(epochMillis) ||
    !calendarTimestampMatches(parsed, epochMillis) ||
    epochMillis < SERVICE_SUITE_TIME_MIN_MS ||
    epochMillis >= SERVICE_SUITE_TIME_MAX_MS
  ) {
    throw new ServiceSuiteContractError(label + " is invalid");
  }
  return parsed;
}

function calendarTimestampMatches(raw: string, epochMillis: number): boolean {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/u.exec(raw);
  if (!parts) return false;
  const date = new Date(epochMillis);
  return (
    date.getUTCFullYear() === Number(parts[1]) &&
    date.getUTCMonth() + 1 === Number(parts[2]) &&
    date.getUTCDate() === Number(parts[3]) &&
    date.getUTCHours() === Number(parts[4]) &&
    date.getUTCMinutes() === Number(parts[5]) &&
    date.getUTCSeconds() === Number(parts[6])
  );
}

function version(value: unknown): string {
  if (value === "absent") return "absent";
  const parsed = optionalTimestamp(value, "version");
  if (!parsed) throw new ServiceSuiteContractError("version is required");
  return parsed;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new ServiceSuiteContractError(label + " must be an array");
  }
  const parsed = value.map((item, index) =>
    token(item, label + "[" + index + "]"),
  );
  if (new Set(parsed).size !== parsed.length) {
    throw new ServiceSuiteContractError(label + " contains duplicates");
  }
  return parsed;
}

const CARRY_MAX_BYTES = 64 << 10;
const CARRY_MAX_ITEMS = 128;

function boundedJson(value: unknown): boolean {
  try {
    return utf8Bytes(JSON.stringify(value)) <= CARRY_MAX_BYTES;
  } catch {
    return false;
  }
}

function carryArray(value: unknown): unknown[] | null {
  return Array.isArray(value) &&
    value.length <= CARRY_MAX_ITEMS &&
    boundedJson(value)
    ? value
    : null;
}

function carryRecord(value: unknown): Record<string, unknown> | null {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    boundedJson(value)
    ? (value as Record<string, unknown>)
    : null;
}

function replacementCarry(
  raw: Record<string, unknown>,
): ServiceSuiteConfigCarry | null {
  const storefronts = carryArray(raw["storefronts"]);
  const contentBlocks = carryArray(raw["content_blocks"]);
  const personalizationRules = carryRecord(raw["personalization_rules"]);
  const supportSettings = carryRecord(raw["support_settings"]);
  const styling = carryRecord(raw["styling"]);
  const metadata = carryRecord(raw["metadata"]);
  if (
    !storefronts ||
    !contentBlocks ||
    !personalizationRules ||
    !supportSettings ||
    !styling ||
    !metadata
  ) {
    return null;
  }
  return {
    storefronts,
    content_blocks: contentBlocks,
    personalization_rules: personalizationRules,
    support_settings: supportSettings,
    styling,
    metadata,
  };
}

export async function getServiceSuiteConfig(
  expectedTenantId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ServiceSuiteConfig> {
  return parseServiceSuiteConfig(
    await api.get<unknown>("/api/v1/service-suite/config", {
      ...(options.signal ? { signal: options.signal } : {}),
    }),
    expectedTenantId,
  );
}

/**
 * The complete PUT representation: the edited scalars plus every
 * object-shaped field carried forward from the verified record. Throws rather
 * than inventing a default when the carry could not be verified.
 */
export function buildCustomerHubReplacement(
  current: ServiceSuiteConfig,
  draft: CustomerHubDraft,
): Record<string, unknown> {
  if (!current.replacementCarry) {
    throw new ServiceSuiteContractError(
      "The stored advanced configuration could not be verified, so no complete replacement can be built.",
    );
  }
  const carry = current.replacementCarry;
  return {
    status: draft.status.trim(),
    order_history_enabled: draft.orderHistoryEnabled,
    favorites_enabled: draft.favoritesEnabled,
    coupons_enabled: draft.couponsEnabled,
    recommendations_enabled: draft.recommendationsEnabled,
    customer_agent_enabled: draft.customerAgentEnabled,
    storefronts: carry.storefronts,
    content_blocks: carry.content_blocks,
    personalization_rules: carry.personalization_rules,
    support_settings: carry.support_settings,
    styling: carry.styling,
    metadata: carry.metadata,
  };
}

/**
 * PUT /api/v1/service-suite/config — a version-guarded complete replacement.
 *
 * One attempt, never queued offline: the `If-Match` names the exact verified
 * record ("absent" for a workspace that has never saved one), so a replay
 * after an unknown outcome must be a deliberate, freshly verified write.
 */
export async function replaceServiceSuiteConfig(args: {
  expectedTenantId: string;
  current: ServiceSuiteConfig;
  draft: CustomerHubDraft;
}): Promise<ServiceSuiteConfig> {
  const { current, draft } = args;
  if (draft.status.trim() === "active" || draft.customerAgentEnabled) {
    throw new ServiceSuiteContractError(CUSTOMER_HUB_RELEASE_HOLD_MESSAGE);
  }
  const body = buildCustomerHubReplacement(current, draft);
  const expectedVersion = version(current.version);
  const raw = await api.put<unknown>("/api/v1/service-suite/config", body, {
    headers: { "If-Match": `"${expectedVersion}"` },
    requireOnline: true,
    maxAttempts: 1,
  });
  const next = parseServiceSuiteConfig(raw, args.expectedTenantId);
  if (next.version === "absent" || next.version === expectedVersion) {
    throw new ServiceSuiteContractError(
      "Service-suite config replacement did not advance its version",
    );
  }
  return next;
}

function parseServiceSuiteConfig(
  response: unknown,
  expectedTenantId: string,
): ServiceSuiteConfig {
  const raw = object(response, "service-suite config");
  const tenantId = uuid(raw["tenantId"], "tenantId");
  const rowTenantId = uuid(raw["tenant_id"], "tenant_id");
  if (tenantId !== expectedTenantId.toLowerCase() || rowTenantId !== tenantId) {
    throw new ServiceSuiteContractError(
      "Service-suite config crossed the active tenant boundary",
    );
  }
  const parsedVersion = version(raw["version"]);
  const createdAt = optionalTimestamp(raw["created_at"], "created_at");
  const updatedAt = optionalTimestamp(raw["updated_at"], "updated_at");
  if (
    (parsedVersion === "absent" &&
      (createdAt !== null || updatedAt !== null)) ||
    (parsedVersion !== "absent" &&
      (createdAt === null || parsedVersion !== updatedAt))
  ) {
    throw new ServiceSuiteContractError(
      "Service-suite config version and updated_at disagree",
    );
  }
  const status = token(raw["status"], "status");
  if (!CONFIG_STATUSES.has(status)) {
    throw new ServiceSuiteContractError("status is unsupported");
  }
  if (
    raw["runtime_available"] !== false ||
    raw["runtime_status"] !== "held" ||
    raw["runtime_reason_code"] !== "customer_hub_runtime_unavailable" ||
    raw["customer_agent_effective_enabled"] !== false
  ) {
    throw new ServiceSuiteContractError(
      "Service-suite config runtime hold is unsupported",
    );
  }
  return {
    tenantId,
    version: parsedVersion,
    status,
    orderHistoryEnabled: bool(
      raw["order_history_enabled"],
      "order_history_enabled",
    ),
    favoritesEnabled: bool(raw["favorites_enabled"], "favorites_enabled"),
    couponsEnabled: bool(raw["coupons_enabled"], "coupons_enabled"),
    recommendationsEnabled: bool(
      raw["recommendations_enabled"],
      "recommendations_enabled",
    ),
    customerAgentEnabled: bool(
      raw["customer_agent_enabled"],
      "customer_agent_enabled",
    ),
    runtimeAvailable: false,
    runtimeStatus: "held",
    runtimeReasonCode: "customer_hub_runtime_unavailable",
    customerAgentEffectiveEnabled: false,
    updatedAt,
    replacementCarry: replacementCarry(raw),
  };
}

function capability(
  source: Record<string, unknown>,
  key: string,
  expectedStatus: string,
  expectedCode: string | null,
  expectedExecutionMode: string | null = null,
): ServiceCapability {
  const raw = exactObject(source[key], "capabilities." + key, [
    "status",
    ...(expectedCode === null ? [] : ["code"]),
    ...(expectedExecutionMode === null ? [] : ["execution_mode"]),
  ]);
  const status = token(raw["status"], "capabilities." + key + ".status");
  const code =
    raw["code"] == null
      ? null
      : token(raw["code"], "capabilities." + key + ".code");
  const executionMode =
    raw["execution_mode"] == null
      ? null
      : token(raw["execution_mode"], "capabilities." + key + ".execution_mode");
  if (
    status !== expectedStatus ||
    code !== expectedCode ||
    executionMode !== expectedExecutionMode
  ) {
    throw new ServiceSuiteContractError(
      "Capability " + key + " does not match this client release",
    );
  }
  return { key, status, code, executionMode };
}

export async function getServiceSuiteCatalog(
  options: { signal?: AbortSignal } = {},
): Promise<ServiceSuiteCatalog> {
  const raw = exactObject(
    await api.get<unknown>("/api/v1/service-suite/catalog", {
      ...(options.signal ? { signal: options.signal } : {}),
    }),
    "service-suite catalog",
    [
      "schema_version",
      "provenance",
      "agent_run_types",
      "channels",
      "conversation_statuses",
      "capabilities",
      "guardrail",
    ],
  );
  if (raw["schema_version"] !== "postwave.service_suite.v2") {
    throw new ServiceSuiteContractError(
      "Service-suite schema version is unsupported",
    );
  }
  const provenance = exactObject(raw["provenance"], "provenance", [
    "tenant_bound",
    "source",
  ]);
  if (
    provenance["tenant_bound"] !== false ||
    provenance["source"] !== "static_server_catalog"
  ) {
    throw new ServiceSuiteContractError(
      "Service-suite catalog provenance is unsupported",
    );
  }
  if (!Array.isArray(raw["channels"])) {
    throw new ServiceSuiteContractError("channels must be an array");
  }
  const channels = raw["channels"].map((value, index) => {
    const channel = exactObject(value, "channels[" + index + "]", [
      "key",
      "label",
      "runtime_status",
    ]);
    return {
      key: token(channel["key"], "channels[" + index + "].key"),
      label: text(channel["label"], "channels[" + index + "].label", 100),
      runtimeStatus: token(
        channel["runtime_status"],
        "channels[" + index + "].runtime_status",
      ),
    };
  });
  if (
    channels.length !== CATALOG_CHANNELS.length ||
    channels.some(
      (channel, index) =>
        channel.key !== CATALOG_CHANNELS[index]?.[0] ||
        channel.label !== CATALOG_CHANNELS[index]?.[1] ||
        channel.runtimeStatus !== "held",
    )
  ) {
    throw new ServiceSuiteContractError(
      "channels do not match this client release",
    );
  }
  const capabilities = exactObject(raw["capabilities"], "capabilities", [
    "outbound_reply_delivery",
    "inbound_email_bridge",
    "internal_notes",
    "privacy_lifecycle",
    "customer_hub_runtime",
    "channel_runtime",
    "customer_agent",
    "macro_usage_evidence",
    "spam_assessment_write",
    "resource_creation",
  ]);
  const guardrail = exactObject(raw["guardrail"], "guardrail", [
    "draft_only",
    "provider_executed",
    "customer_mutations",
    "requires_human_review",
  ]);
  if (
    guardrail["draft_only"] !== true ||
    guardrail["provider_executed"] !== false ||
    guardrail["customer_mutations"] !== false ||
    guardrail["requires_human_review"] !== true
  ) {
    throw new ServiceSuiteContractError(
      "Service-suite guardrail is unsupported",
    );
  }
  const conversationStatuses = stringArray(
    raw["conversation_statuses"],
    "conversation_statuses",
  );
  if (
    conversationStatuses.length !== CONVERSATION_STATUSES.length ||
    conversationStatuses.some(
      (status, index) => status !== CONVERSATION_STATUSES[index],
    )
  ) {
    throw new ServiceSuiteContractError(
      "conversation_statuses do not match this client release",
    );
  }
  const agentRunTypes = stringArray(raw["agent_run_types"], "agent_run_types");
  const expectedAgentRunTypes = ["draft_reply", "triage", "handoff", "summary"];
  if (
    agentRunTypes.length !== expectedAgentRunTypes.length ||
    agentRunTypes.some(
      (runType, index) => runType !== expectedAgentRunTypes[index],
    )
  ) {
    throw new ServiceSuiteContractError(
      "agent_run_types do not match this client release",
    );
  }
  // The availability page validates these frozen run tokens but deliberately
  // exposes no agent action; catalog metadata is not runtime authority.
  return {
    schemaVersion: "postwave.service_suite.v2",
    provenance: { tenantBound: false, source: "static_server_catalog" },
    channels,
    conversationStatuses,
    capabilities: [
      capability(
        capabilities,
        "outbound_reply_delivery",
        "held",
        "helpdesk_delivery_unavailable",
      ),
      capability(capabilities, "inbound_email_bridge", "held", null),
      capability(capabilities, "internal_notes", "available", null),
      capability(capabilities, "privacy_lifecycle", "held", null),
      capability(
        capabilities,
        "customer_hub_runtime",
        "held",
        "customer_hub_runtime_unavailable",
      ),
      capability(
        capabilities,
        "channel_runtime",
        "held",
        "helpdesk_channel_runtime_unavailable",
      ),
      capability(
        capabilities,
        "customer_agent",
        "held",
        "customer_agent_draft_write_held",
        "deterministic_template_only",
      ),
      capability(
        capabilities,
        "macro_usage_evidence",
        "held",
        "macro_usage_evidence_unavailable",
      ),
      capability(
        capabilities,
        "spam_assessment_write",
        "held",
        "spam_assessment_write_held",
      ),
      capability(
        capabilities,
        "resource_creation",
        "held",
        "helpdesk_create_replay_unavailable",
      ),
    ],
    guardrail: {
      draftOnly: true,
      providerExecuted: false,
      customerMutations: false,
      requiresHumanReview: true,
    },
  };
}

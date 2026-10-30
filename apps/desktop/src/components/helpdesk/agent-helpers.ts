/**
 * agent-helpers — pure logic shared by the Customer Hub config form and the
 * Customer Agent draft-reply panel (KLV-10). Kept side-effect-free so it can
 * be unit-tested without React or the network.
 *
 * Two themes:
 *   1. Hub config — the editable boolean feature toggles (metadata + a
 *      minimal-patch differ so Save sends only what changed).
 *   2. Agent run — read-only guardrail classification. The agent's output
 *      MUST be shown honestly: `isHandoff` decides when the prominent
 *      "needs human handoff" banner shows, and `toolPlanEntries` safely
 *      flattens an arbitrary `tool_plan` object for read-only display.
 */

import type {
  ServiceAgentRun,
  ServiceMacro,
  ServiceSuiteCatalog,
  ServiceHubConfig,
  ServiceHubConfigReplacement,
} from "../../lib/api-client";
import {
  isCanonicalHelpdeskId,
  isSafeOpaqueHelpdeskCursor,
  utf8ByteLength,
} from "./helpdesk-helpers";

type UnknownRecord = Record<string, unknown>;

const CHANNEL_TYPES = new Set([
  "web_chat",
  "email",
  "sms",
  "instagram",
  "whatsapp",
  "facebook",
  "generic",
]);
const HUB_STATUSES = new Set(["draft", "active", "paused", "archived"]);
const MACRO_STATUSES = new Set(["active", "archived"]);
const AGENT_STATUSES = new Set([
  "drafted",
  "needs_handoff",
  "blocked",
  "accepted",
  "discarded",
]);
const FROZEN_CATALOG_STATUSES = [
  "open",
  "pending",
  "waiting",
  "resolved",
  "closed",
  "spam",
  "archived",
] as const;
const FROZEN_CATALOG_AGENT_RUN_TYPES = [
  "draft_reply",
  "triage",
  "handoff",
  "summary",
] as const;
const FROZEN_CATALOG_CHANNELS = [
  { key: "web_chat", label: "Web chat" },
  { key: "email", label: "Email" },
  { key: "sms", label: "SMS" },
  { key: "instagram", label: "Instagram" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "facebook", label: "Facebook" },
] as const;
const SAFE_TOKEN_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const RFC3339_NANO_UTC_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const DISPLAY_CONTROL_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
const PROJECTION_MIN_MS = Date.parse("2000-01-01T00:00:00Z");
const PROJECTION_MAX_MS = Date.parse("2100-01-01T00:00:00Z");

export interface DecodedHelpdeskValue<T> {
  value: T | null;
  error: string | null;
}

export interface DecodedMacroList {
  items: ServiceMacro[];
  rejected: number;
  envelopeError: string | null;
  page: {
    hasMore: boolean;
    nextCursor: string | null;
    asOf: string;
    consistency: "mutable_window";
    mayReorder: true;
  } | null;
}

/** The five boolean feature toggles the hub form edits, with humanized copy. */
export const HUB_TOGGLES: ReadonlyArray<{
  key: keyof ServiceHubConfig &
    (
      | "order_history_enabled"
      | "favorites_enabled"
      | "coupons_enabled"
      | "recommendations_enabled"
      | "customer_agent_enabled"
    );
  label: string;
  hint: string;
}> = [
  {
    key: "order_history_enabled",
    label: "Order history",
    hint: "Store the order-history configuration intent; no storefront runtime is connected.",
  },
  {
    key: "favorites_enabled",
    label: "Favorites",
    hint: "Store the favorites configuration intent; this does not publish a customer feature.",
  },
  {
    key: "coupons_enabled",
    label: "Coupons",
    hint: "Store the coupons configuration intent; customer visibility remains release-held.",
  },
  {
    key: "recommendations_enabled",
    label: "Recommendations",
    hint: "Store the recommendations intent without claiming runtime personalization.",
  },
  {
    key: "customer_agent_enabled",
    label: "Customer Agent",
    hint: "Release-held: no authenticated storefront or provider-backed Customer Agent runtime exists.",
  },
];

/** The object-shaped config fields that v1 does NOT edit (noted read-only). */
export const HUB_READ_ONLY_OBJECT_FIELDS: readonly string[] = [
  "storefronts",
  "content_blocks",
  "personalization_rules",
  "styling",
  "support_settings",
  "metadata",
];

/** A boolean coerced defensively — server may omit a field on older rows. */
export function asBool(v: unknown): boolean {
  return Boolean(v);
}

/**
 * Builds a minimal patch containing only the fields that differ between the
 * server `base` and the local `draft`. Returns {} when nothing changed (the
 * caller can short-circuit Save). Only the editable subset is considered.
 */
export function buildHubPatch(
  base: ServiceHubConfig,
  draft: { status: string } & Record<
    (typeof HUB_TOGGLES)[number]["key"],
    boolean
  >,
): Partial<ServiceHubConfigReplacement> {
  const patch: Partial<ServiceHubConfigReplacement> = {};
  const baseStatus = (base.status ?? "").trim();
  const draftStatus = (draft.status ?? "").trim();
  if (draftStatus !== baseStatus) patch.status = draftStatus;
  for (const t of HUB_TOGGLES) {
    if (Boolean(draft[t.key]) !== Boolean(base[t.key])) {
      patch[t.key] = Boolean(draft[t.key]);
    }
  }
  return patch;
}

/** True when a patch carries at least one changed field. */
export function patchHasChanges(patch: object): boolean {
  return Object.keys(patch).length > 0;
}

/** Build the complete representation required by PUT. Object-shaped fields
 * are carried forward byte-for-value from the strictly decoded GET response;
 * a sparse draft is never placed on the replacement endpoint. */
export function buildHubReplacement(
  base: ServiceHubConfig,
  draft: { status: string } & Record<
    (typeof HUB_TOGGLES)[number]["key"],
    boolean
  >,
): ServiceHubConfigReplacement {
  return {
    status: draft.status.trim(),
    order_history_enabled: Boolean(draft.order_history_enabled),
    favorites_enabled: Boolean(draft.favorites_enabled),
    coupons_enabled: Boolean(draft.coupons_enabled),
    recommendations_enabled: Boolean(draft.recommendations_enabled),
    customer_agent_enabled: Boolean(draft.customer_agent_enabled),
    storefronts: base.storefronts ?? [],
    content_blocks: base.content_blocks ?? [],
    personalization_rules: base.personalization_rules ?? {},
    support_settings: base.support_settings ?? {},
    styling: base.styling ?? {},
    metadata: base.metadata ?? {},
  };
}

export function decodeServiceSuiteCatalog(
  input: unknown,
): DecodedHelpdeskValue<ServiceSuiteCatalog> {
  const row = asRecord(input);
  if (!row) return invalid("The catalog response was not an object.");
  const schemaVersion = safeString(row.schema_version, 128, true);
  const provenance = asRecord(row.provenance);
  const statuses = safeStringList(row.conversation_statuses, 32, 64);
  const runTypes = safeStringList(row.agent_run_types, 32, 64);
  const channels = decodeFrozenCatalogChannels(row.channels);
  const guardrail = safeJson(row.guardrail, 0);
  const capabilities = safeJsonRecord(row.capabilities);
  if (
    !hasExactKeys(row, [
      "schema_version",
      "provenance",
      "agent_run_types",
      "channels",
      "conversation_statuses",
      "capabilities",
      "guardrail",
    ]) ||
    schemaVersion !== "postwave.service_suite.v2" ||
    !provenance ||
    !hasExactKeys(provenance, ["tenant_bound", "source"]) ||
    provenance.tenant_bound !== false ||
    provenance.source !== "static_server_catalog" ||
    !exactStringList(statuses, FROZEN_CATALOG_STATUSES) ||
    !exactStringList(runTypes, FROZEN_CATALOG_AGENT_RUN_TYPES) ||
    channels === null ||
    guardrail === INVALID_JSON ||
    !catalogGuardrailIsFrozen(guardrail) ||
    capabilities === null ||
    !catalogCapabilitiesAreFrozen(capabilities)
  ) {
    return invalid("The catalog response failed strict shape validation.");
  }
  return {
    value: {
      schema_version: schemaVersion,
      provenance: {
        tenant_bound: false,
        source: "static_server_catalog",
      },
      conversation_statuses: statuses,
      agent_run_types: runTypes,
      channels,
      guardrail,
      capabilities,
    },
    error: null,
  };
}

export function catalogGuardrailText(
  catalog: ServiceSuiteCatalog | null | undefined,
): string {
  const guardrail = catalog?.guardrail;
  if (typeof guardrail === "string") return guardrail.trim();
  if (guardrail && typeof guardrail === "object") {
    const row = guardrail as Record<string, unknown>;
    for (const key of ["description", "summary", "policy"]) {
      if (typeof row[key] === "string" && row[key].trim()) {
        return row[key].trim();
      }
    }
    if (
      row.draft_only === true &&
      row.provider_executed === false &&
      row.customer_mutations === false &&
      row.requires_human_review === true
    ) {
      return "Draft only; no provider or customer mutation is executed, and human review is required.";
    }
    return "Unrecognized guardrail data was withheld; treat every output as a held draft requiring human review.";
  }
  return "";
}

export function decodeHubConfig(
  input: unknown,
  expectedTenantId: string,
): DecodedHelpdeskValue<ServiceHubConfig> {
  const row = asRecord(input);
  if (!row || !tenantRowMatches(row, expectedTenantId)) {
    return invalid("The Customer Hub response did not match this workspace.");
  }
  const status = safeToken(row.status, HUB_STATUSES);
  const version =
    row.version === "absent"
      ? "absent"
      : strictProjectionTimestamp(row.version);
  const storefronts = safeUnknownArray(row.storefronts, 128, 64 << 10);
  const contentBlocks = safeUnknownArray(row.content_blocks, 128, 64 << 10);
  const personalizationRules = safeJsonRecordBounded(
    row.personalization_rules,
    64 << 10,
  );
  const supportSettings = safeJsonRecordBounded(row.support_settings, 64 << 10);
  const styling = safeJsonRecordBounded(row.styling, 64 << 10);
  const metadata = safeJsonRecordBounded(row.metadata, 64 << 10);
  const createdAt =
    version === "absent" ? null : strictProjectionTimestamp(row.created_at);
  const updatedAt =
    version === "absent" ? null : strictProjectionTimestamp(row.updated_at);
  const timestampProjectionIsConsistent =
    version === "absent"
      ? !Object.prototype.hasOwnProperty.call(row, "created_at") &&
        !Object.prototype.hasOwnProperty.call(row, "updated_at")
      : Boolean(
          createdAt &&
          updatedAt &&
          version === updatedAt &&
          Date.parse(updatedAt) >= Date.parse(createdAt),
        );
  const booleans = [
    "order_history_enabled",
    "favorites_enabled",
    "coupons_enabled",
    "recommendations_enabled",
    "customer_agent_enabled",
  ] as const;
  if (
    !status ||
    !version ||
    !timestampProjectionIsConsistent ||
    storefronts === null ||
    contentBlocks === null ||
    personalizationRules === null ||
    supportSettings === null ||
    styling === null ||
    metadata === null ||
    row.runtime_available !== false ||
    row.runtime_status !== "held" ||
    row.runtime_reason_code !== "customer_hub_runtime_unavailable" ||
    row.customer_agent_effective_enabled !== false ||
    booleans.some((key) => typeof row[key] !== "boolean")
  ) {
    return invalid("The Customer Hub response failed strict shape validation.");
  }
  return {
    value: {
      tenant_id: expectedTenantId,
      tenantId: expectedTenantId,
      version,
      status,
      storefronts,
      content_blocks: contentBlocks,
      personalization_rules: personalizationRules,
      support_settings: supportSettings,
      order_history_enabled: row.order_history_enabled as boolean,
      favorites_enabled: row.favorites_enabled as boolean,
      coupons_enabled: row.coupons_enabled as boolean,
      recommendations_enabled: row.recommendations_enabled as boolean,
      customer_agent_enabled: row.customer_agent_enabled as boolean,
      runtime_available: false,
      runtime_status: "held",
      runtime_reason_code: "customer_hub_runtime_unavailable",
      customer_agent_effective_enabled: false,
      styling,
      metadata,
      ...(createdAt ? { created_at: createdAt } : {}),
      ...(updatedAt ? { updated_at: updatedAt } : {}),
    },
    error: null,
  };
}

export function decodeMacroList(
  input: unknown,
  expectedTenantId: string,
): DecodedMacroList {
  const envelope = asRecord(input);
  const page = decodeCollectionPage(envelope?.page, "mutable_window");
  if (
    !envelope ||
    !hasExactKeys(envelope, ["tenantId", "items", "page"]) ||
    envelope.tenantId !== expectedTenantId ||
    !isCanonicalHelpdeskId(envelope.tenantId) ||
    !page ||
    !Array.isArray(envelope.items) ||
    envelope.items.length > 100
  ) {
    return {
      items: [],
      rejected: 0,
      envelopeError:
        "The macro response was not a valid workspace-bound collection.",
      page: null,
    };
  }
  const items: ServiceMacro[] = [];
  let rejected = 0;
  for (const raw of envelope.items) {
    const row = asRecord(raw);
    const id = isCanonicalHelpdeskId(row?.id) ? row.id : null;
    const version = strictProjectionTimestamp(row?.version);
    const name = displayString(row?.name, 200, true);
    const body = displayString(row?.body, 16 << 10, true);
    const status = safeToken(row?.status, MACRO_STATUSES);
    const channels = safeTokenList(
      row?.channel_types,
      CHANNEL_TYPES.size,
      CHANNEL_TYPES,
    );
    const tags = displayStringList(row?.tags, 32, 100);
    const lastUsedAt = strictProjectionTimestamp(row?.last_used_at, true);
    const createdAt = strictProjectionTimestamp(row?.created_at);
    const updatedAt = strictProjectionTimestamp(row?.updated_at);
    const useCount = row?.use_count;
    if (
      !row ||
      !tenantRowMatches(row, expectedTenantId) ||
      !id ||
      !version ||
      version !== updatedAt ||
      !name ||
      !body ||
      !status ||
      channels === null ||
      tags === null ||
      lastUsedAt === false ||
      !createdAt ||
      !updatedAt ||
      Date.parse(updatedAt) < Date.parse(createdAt) ||
      (lastUsedAt !== null && Date.parse(lastUsedAt) < Date.parse(createdAt)) ||
      (useCount !== undefined &&
        (!Number.isSafeInteger(useCount) || Number(useCount) < 0)) ||
      row.usage_evidence_status !== "unverified"
    ) {
      rejected += 1;
      continue;
    }
    items.push({
      id,
      tenantId: expectedTenantId,
      tenant_id: expectedTenantId,
      version,
      name,
      body,
      status,
      usage_evidence_status: "unverified",
      channel_types: channels,
      tags,
      ...(useCount === undefined ? {} : { use_count: Number(useCount) }),
      ...(lastUsedAt ? { last_used_at: lastUsedAt } : {}),
      created_at: createdAt,
      updated_at: updatedAt,
    });
  }
  return { items, rejected, envelopeError: null, page };
}

export function decodeAgentRun(
  input: unknown,
  expectedTenantId: string,
  expectedConversationId: string,
): DecodedHelpdeskValue<ServiceAgentRun> {
  const row = asRecord(input);
  const id = isCanonicalHelpdeskId(row?.id) ? row.id : null;
  const conversationId = isCanonicalHelpdeskId(row?.conversation_id)
    ? row.conversation_id
    : null;
  const status = safeToken(row?.status, AGENT_STATUSES);
  const runType = safeToken(row?.run_type);
  const model = safeToken(row?.model);
  const prompt = displayString(row?.prompt, 4 << 10);
  const draft = displayString(row?.draft, 16 << 10, true);
  const handoffReason = displayString(row?.handoff_reason, 2 << 10);
  const flags = displayStringList(row?.safety_flags, 32, 256);
  const toolPlan = safeJsonRecordBounded(row?.tool_plan, 32 << 10);
  const executionMode = safeToken(row?.execution_mode);
  const createdAt = strictProjectionTimestamp(row?.created_at);
  const updatedAt = strictProjectionTimestamp(row?.updated_at);
  const ticketId =
    row?.ticket_id === undefined ||
    row.ticket_id === null ||
    row.ticket_id === ""
      ? ""
      : isCanonicalHelpdeskId(row.ticket_id)
        ? row.ticket_id
        : null;
  if (
    !row ||
    !tenantRowMatches(row, expectedTenantId) ||
    !id ||
    conversationId !== expectedConversationId ||
    ticketId === null ||
    runType !== "draft_reply" ||
    !status ||
    !model ||
    prompt === null ||
    !draft ||
    handoffReason === null ||
    flags === null ||
    toolPlan === null ||
    executionMode !== "deterministic_template" ||
    row.provider_executed !== false ||
    !createdAt ||
    !updatedAt ||
    Date.parse(updatedAt) < Date.parse(createdAt)
  ) {
    return invalid("The agent response failed workspace and shape validation.");
  }
  return {
    value: {
      id,
      tenantId: expectedTenantId,
      tenant_id: expectedTenantId,
      conversation_id: conversationId,
      run_type: "draft_reply",
      ...(ticketId ? { ticket_id: ticketId } : {}),
      status,
      model,
      ...(prompt ? { prompt } : {}),
      draft,
      ...(handoffReason ? { handoff_reason: handoffReason } : {}),
      safety_flags: flags,
      tool_plan: toolPlan,
      execution_mode: executionMode,
      provider_executed: false,
      created_at: createdAt,
      updated_at: updatedAt,
    },
    error: null,
  };
}

function invalid<T>(error: string): DecodedHelpdeskValue<T> {
  return { value: null, error };
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function hasExactKeys(
  value: UnknownRecord,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function tenantRowMatches(
  row: UnknownRecord,
  expectedTenantId: string,
): boolean {
  return (
    isCanonicalHelpdeskId(expectedTenantId) &&
    row.tenantId === expectedTenantId &&
    row.tenant_id === expectedTenantId &&
    isCanonicalHelpdeskId(row.tenantId) &&
    isCanonicalHelpdeskId(row.tenant_id)
  );
}

function decodeCollectionPage(
  value: unknown,
  expectedConsistency: "mutable_window",
): DecodedMacroList["page"] {
  const page = asRecord(value);
  if (
    !page ||
    !hasExactKeys(page, [
      "has_more",
      "next_cursor",
      "as_of",
      "consistency",
      "may_reorder",
    ]) ||
    typeof page.has_more !== "boolean"
  ) {
    return null;
  }
  const cursor: string | null | false =
    page.next_cursor === null
      ? null
      : isSafeOpaqueHelpdeskCursor(page.next_cursor)
        ? page.next_cursor
        : false;
  const asOf = strictProjectionTimestamp(page.as_of);
  if (
    cursor === false ||
    page.has_more !== Boolean(cursor) ||
    !asOf ||
    page.consistency !== expectedConsistency ||
    page.may_reorder !== true
  ) {
    return null;
  }
  return {
    hasMore: page.has_more,
    nextCursor: cursor || null,
    asOf,
    consistency: "mutable_window",
    mayReorder: true,
  };
}

function catalogGuardrailIsFrozen(value: unknown): boolean {
  const guardrail = asRecord(value);
  return Boolean(
    guardrail &&
    hasExactKeys(guardrail, [
      "draft_only",
      "provider_executed",
      "customer_mutations",
      "requires_human_review",
    ]) &&
    guardrail.draft_only === true &&
    guardrail.provider_executed === false &&
    guardrail.customer_mutations === false &&
    guardrail.requires_human_review === true,
  );
}

function catalogCapabilitiesAreFrozen(value: UnknownRecord): boolean {
  const expected: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    outbound_reply_delivery: {
      status: "held",
      code: "helpdesk_delivery_unavailable",
    },
    inbound_email_bridge: { status: "held" },
    internal_notes: { status: "available" },
    privacy_lifecycle: { status: "held" },
    customer_hub_runtime: {
      status: "held",
      code: "customer_hub_runtime_unavailable",
    },
    channel_runtime: {
      status: "held",
      code: "helpdesk_channel_runtime_unavailable",
    },
    customer_agent: {
      status: "held",
      code: "customer_agent_draft_write_held",
      execution_mode: "deterministic_template_only",
    },
    macro_usage_evidence: {
      status: "held",
      code: "macro_usage_evidence_unavailable",
    },
    spam_assessment_write: {
      status: "held",
      code: "spam_assessment_write_held",
    },
    resource_creation: {
      status: "held",
      code: "helpdesk_create_replay_unavailable",
    },
  };
  if (!hasExactKeys(value, Object.keys(expected))) return false;
  return Object.entries(expected).every(([key, frozen]) => {
    const capability = asRecord(value[key]);
    return (
      capability !== null &&
      hasExactKeys(capability, Object.keys(frozen)) &&
      Object.entries(frozen).every(
        ([field, expectedValue]) => capability[field] === expectedValue,
      )
    );
  });
}

function exactStringList(
  value: string[] | null,
  expected: readonly string[],
): value is string[] {
  return (
    value !== null &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function decodeFrozenCatalogChannels(value: unknown): unknown[] | null {
  if (
    !Array.isArray(value) ||
    value.length !== FROZEN_CATALOG_CHANNELS.length
  ) {
    return null;
  }
  const channels: Array<{
    key: string;
    label: string;
    runtime_status: "held";
  }> = [];
  for (let index = 0; index < FROZEN_CATALOG_CHANNELS.length; index += 1) {
    const row = asRecord(value[index]);
    const frozen = FROZEN_CATALOG_CHANNELS[index];
    if (
      !row ||
      !frozen ||
      !hasExactKeys(row, ["key", "label", "runtime_status"]) ||
      safeToken(row.key, CHANNEL_TYPES) !== frozen.key ||
      displayString(row.label, 64, true) !== frozen.label ||
      row.runtime_status !== "held"
    ) {
      return null;
    }
    channels.push({
      key: frozen.key,
      label: frozen.label,
      runtime_status: "held",
    });
  }
  return channels;
}

const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const INVALID_JSON = Symbol("invalid-helpdesk-json");

function safeJson(
  value: unknown,
  depth: number,
): unknown | typeof INVALID_JSON {
  if (depth > 8) return INVALID_JSON;
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === "string") {
    return value.length <= 100_000 ? value : INVALID_JSON;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) return INVALID_JSON;
    const out: unknown[] = [];
    for (const item of value) {
      const safe = safeJson(item, depth + 1);
      if (safe === INVALID_JSON) return INVALID_JSON;
      out.push(safe);
    }
    return out;
  }
  const row = asRecord(value);
  if (!row || Object.keys(row).length > 1_000) return INVALID_JSON;
  const out: UnknownRecord = Object.create(null) as UnknownRecord;
  for (const [key, item] of Object.entries(row)) {
    if (FORBIDDEN_JSON_KEYS.has(key) || key.length > 256) return INVALID_JSON;
    const safe = safeJson(item, depth + 1);
    if (safe === INVALID_JSON) return INVALID_JSON;
    out[key] = safe;
  }
  return out;
}

function safeJsonRecord(value: unknown): UnknownRecord | null {
  const safe = safeJson(value ?? {}, 0);
  return safe === INVALID_JSON || !asRecord(safe)
    ? null
    : (safe as UnknownRecord);
}

function safeJsonRecordBounded(
  value: unknown,
  maxBytes: number,
): UnknownRecord | null {
  if (value === undefined || value === null) return null;
  const safe = safeJsonRecord(value);
  if (!safe) return null;
  try {
    return utf8ByteLength(JSON.stringify(safe)) <= maxBytes ? safe : null;
  } catch {
    return null;
  }
}

function safeUnknownArray(
  value: unknown,
  maxItems: number,
  maxBytes: number,
): unknown[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const safe = safeJson(value, 0);
  if (safe === INVALID_JSON || !Array.isArray(safe)) return null;
  try {
    return utf8ByteLength(JSON.stringify(safe)) <= maxBytes ? safe : null;
  } catch {
    return null;
  }
}

function safeString(
  value: unknown,
  max: number,
  required = false,
): string | null {
  if (value === undefined || value === null) return required ? null : "";
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (
    (required && !text) ||
    utf8ByteLength(text) > max ||
    /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(text)
  ) {
    return null;
  }
  return text;
}

function displayString(
  value: unknown,
  maxBytes: number,
  required = false,
): string | null {
  if (value === undefined || value === null || value === "") {
    return required ? null : "";
  }
  if (typeof value !== "string") return null;
  if (
    (required && !value.trim()) ||
    utf8ByteLength(value) > maxBytes ||
    DISPLAY_CONTROL_RE.test(value)
  ) {
    return null;
  }
  return value;
}

function safeToken(
  value: unknown,
  allowed?: ReadonlySet<string>,
): string | null {
  if (typeof value !== "string" || !SAFE_TOKEN_RE.test(value)) return null;
  return !allowed || allowed.has(value) ? value : null;
}

function safeStringList(
  value: unknown,
  maxItems: number,
  maxChars: number,
): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = safeString(item, maxChars, true);
    if (!text) return null;
    if (seen.has(text)) return null;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function displayStringList(
  value: unknown,
  maxItems: number,
  maxBytes: number,
): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = displayString(item, maxBytes, true);
    if (!text || seen.has(text)) return null;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function safeTokenList(
  value: unknown,
  maxItems: number,
  allowed: ReadonlySet<string>,
): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const token = safeToken(item, allowed);
    if (!token || seen.has(token)) return null;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function strictProjectionTimestamp(
  value: unknown,
  optional = false,
): string | null | false {
  if (value === undefined || value === null || value === "") {
    return optional ? null : false;
  }
  if (typeof value !== "string" || !RFC3339_NANO_UTC_RE.test(value)) {
    return false;
  }
  const fraction = /\.(\d+)Z$/u.exec(value)?.[1] ?? null;
  const parsed = Date.parse(value);
  const parsedDate = new Date(parsed);
  if (
    (fraction !== null && fraction.endsWith("0")) ||
    !Number.isFinite(parsed) ||
    parsed < PROJECTION_MIN_MS ||
    parsed >= PROJECTION_MAX_MS ||
    parsedDate.toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    return false;
  }
  return value;
}

/**
 * The terminal/handoff classification for an agent run. The draft-reply
 * endpoint returns a `status`; anything that is NOT the happy "drafted"
 * path is surfaced prominently as needing a human. We treat an explicit
 * "needs_handoff" (and any non-"drafted", non-empty status) as a handoff
 * so the UI never hides an escalation by failing closed.
 */
export function isHandoff(run: Pick<ServiceAgentRun, "status">): boolean {
  const s = (run.status ?? "").trim().toLowerCase();
  // Fail closed: ONLY the explicit "drafted" happy path is treated as clean.
  // An empty/aborted/unrecognized status means we cannot confirm the agent
  // finished safely, so we surface it as needing a human rather than letting
  // a blank status silently imply all-clear.
  return s !== "drafted";
}

/** A safety_flags array, always an array, with blanks dropped. */
export function safetyFlags(
  run: Pick<ServiceAgentRun, "safety_flags">,
): string[] {
  const arr = Array.isArray(run.safety_flags) ? run.safety_flags : [];
  return arr.filter(
    (f): f is string => typeof f === "string" && f.trim() !== "",
  );
}

/** Humanize a snake/kebab flag or status token for display. */
export function humanizeToken(token: string): string {
  return (token ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** One flattened, stringified tool_plan entry for the read-only key view. */
export interface ToolPlanEntry {
  key: string;
  value: string;
}

/**
 * Flattens an arbitrary `tool_plan` object into displayable key/value
 * strings. Guards null / non-object inputs (returns []) so we never call
 * Object.entries on a non-record. Nested values are JSON-stringified.
 */
export function toolPlanEntries(plan: unknown): ToolPlanEntry[] {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    return [];
  }
  return Object.entries(plan as Record<string, unknown>).map(
    ([key, value]) => ({
      key,
      value: stringifyToolValue(value),
    }),
  );
}

function stringifyToolValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Maps an ApiResult error to a friendly message, with a dedicated 403 line
 * for the admin-gated writes (Save config / draft a reply).
 */
export function describeWriteError(
  err: { kind?: string; status?: number; message: string },
  adminCopy: string,
): string {
  const status = err.kind === "http" ? err.status : undefined;
  if (status === 403) return adminCopy;
  return err.message;
}

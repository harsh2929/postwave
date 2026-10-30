/**
 * Customer Hub configuration record — strict decode, draft diffing and the
 * complete-replacement body for `PUT /api/v1/service-suite/config`.
 *
 * Node-safe on purpose (no react-native / expo imports): every rule here is
 * unit-tested, and the screen only renders what this file certified.
 *
 * Three things about this endpoint drive the whole design:
 *
 *  1. PUT IS A COMPLETE REPLACEMENT, not a patch. The Go wire type
 *     (`HubConfigPut.ValidateAndBuild`, apps/api/internal/service_suite/wire.go:119)
 *     rejects the body with "PUT requires a complete replacement; missing: …"
 *     unless all twelve editable members are present. So a mobile draft that
 *     only knows about six booleans MUST carry the six object-shaped fields
 *     (storefronts, content_blocks, personalization_rules, support_settings,
 *     styling, metadata) forward verbatim from the decoded GET. Sending `{}`
 *     for one of them would silently erase whatever a desktop operator built.
 *  2. TWO DRAFT VALUES ARE RELEASE-HELD BY THE SERVER. `status: "active"` and
 *     `customer_agent_enabled: true` are answered 409
 *     `customer_hub_runtime_unavailable` (service_suite.go:420). We refuse
 *     them locally using the server's own sentence rather than sending a
 *     request whose only possible outcome is that refusal.
 *  3. THE RECORD IS NOT A RUNTIME. Every response carries
 *     `runtime_available:false`, `runtime_status:"held"` and
 *     `customer_agent_effective_enabled:false`. The decoder REFUSES a response
 *     that says otherwise, so a contract change can never be absorbed into
 *     copy claiming a customer can see a feature.
 */

/** The four statuses `ValidateConfig` accepts (service_suite.go:1113). */
export const CUSTOMER_HUB_STATUSES = [
  "draft",
  "active",
  "paused",
  "archived",
] as const;
export type CustomerHubStatus = (typeof CUSTOMER_HUB_STATUSES)[number];

export type CustomerHubToggleKey =
  | "order_history_enabled"
  | "favorites_enabled"
  | "coupons_enabled"
  | "recommendations_enabled"
  | "customer_agent_enabled";

/** The five booleans the form edits, with copy that never claims a runtime. */
export const CUSTOMER_HUB_TOGGLES: readonly {
  key: CustomerHubToggleKey;
  label: string;
  hint: string;
}[] = [
  {
    key: "order_history_enabled",
    label: "Order history",
    hint: "Stores the order-history configuration intent; no storefront runtime is connected.",
  },
  {
    key: "favorites_enabled",
    label: "Favorites",
    hint: "Stores the favorites intent; this does not publish a customer feature.",
  },
  {
    key: "coupons_enabled",
    label: "Coupons",
    hint: "Stores the coupons intent; customer visibility remains release-held.",
  },
  {
    key: "recommendations_enabled",
    label: "Recommendations",
    hint: "Stores the recommendations intent without claiming runtime personalization.",
  },
  {
    key: "customer_agent_enabled",
    label: "Customer Agent",
    hint: "Release-held: the server refuses this value while no authenticated storefront or provider-backed agent runtime exists.",
  },
];

/** Object-shaped members this form does not edit; they are carried forward. */
export const CUSTOMER_HUB_CARRIED_FIELDS = [
  "storefronts",
  "content_blocks",
  "personalization_rules",
  "support_settings",
  "styling",
  "metadata",
] as const;

/**
 * The server's verbatim 409 sentence (service_suite.go:421). Rendered as-is
 * when a draft asks for a held value — never paraphrased into a promise.
 */
export const CUSTOMER_HUB_HELD_SENTENCE =
  "Customer Hub publication and Customer Agent enablement are release-held because no authenticated storefront runtime is configured.";

export const CUSTOMER_HUB_HELD_CODE = "customer_hub_runtime_unavailable";

/** The version a tenant with no stored row carries (repo.go:2132). */
export const CUSTOMER_HUB_ABSENT_VERSION = "absent";

export interface CustomerHubCarried {
  storefronts: unknown[];
  content_blocks: unknown[];
  personalization_rules: Record<string, unknown>;
  support_settings: Record<string, unknown>;
  styling: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface CustomerHubConfig {
  tenantId: string;
  /** RFC3339Nano `updated_at`, or `"absent"` when no row exists yet. */
  version: string;
  status: CustomerHubStatus;
  order_history_enabled: boolean;
  favorites_enabled: boolean;
  coupons_enabled: boolean;
  recommendations_enabled: boolean;
  customer_agent_enabled: boolean;
  /** Always "held" — the decoder rejects any other value. */
  runtimeStatus: "held";
  runtimeReasonCode: string;
  createdAt: string | null;
  updatedAt: string | null;
  carried: CustomerHubCarried;
}

export interface CustomerHubDraft {
  status: CustomerHubStatus;
  order_history_enabled: boolean;
  favorites_enabled: boolean;
  coupons_enabled: boolean;
  recommendations_enabled: boolean;
  customer_agent_enabled: boolean;
}

export interface CustomerHubDecode {
  value: CustomerHubConfig | null;
  error: string | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

function isCanonicalId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** An RFC3339 instant the server could actually have produced, or null. */
function projectionTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !RFC3339_RE.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function invalid(message: string): CustomerHubDecode {
  return { value: null, error: message };
}

/** A JSON object member carried forward untouched, or null when malformed. */
function carriedRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** A JSON array member carried forward untouched, or null when malformed. */
function carriedArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function isStatus(value: unknown): value is CustomerHubStatus {
  return (
    typeof value === "string" &&
    (CUSTOMER_HUB_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Strictly decode a `GET`/`PUT` Customer Hub response.
 *
 * Refuses on: a tenant that is not this session's, a status outside the
 * server's own set, a non-boolean toggle, a malformed carried object, an
 * inconsistent timestamp projection, and — deliberately — on any claim that
 * the runtime is available. A refusal returns a sentence for the UI; it never
 * downgrades to a partial record.
 */
export function parseCustomerHubConfig(
  input: unknown,
  expectedTenantId: string,
): CustomerHubDecode {
  const row = isRecord(input) ? input : null;
  if (
    !row ||
    !isCanonicalId(expectedTenantId) ||
    row.tenantId !== expectedTenantId ||
    row.tenant_id !== expectedTenantId
  ) {
    return invalid(
      "The Customer Hub response did not match this workspace, so nothing was shown.",
    );
  }
  const absent = row.version === CUSTOMER_HUB_ABSENT_VERSION;
  const version = absent
    ? CUSTOMER_HUB_ABSENT_VERSION
    : projectionTimestamp(row.version);
  const createdAt = absent ? null : projectionTimestamp(row.created_at);
  const updatedAt = absent ? null : projectionTimestamp(row.updated_at);
  const timestampsConsistent = absent
    ? !Object.prototype.hasOwnProperty.call(row, "created_at") &&
      !Object.prototype.hasOwnProperty.call(row, "updated_at")
    : Boolean(
        createdAt &&
          updatedAt &&
          version === updatedAt &&
          Date.parse(updatedAt) >= Date.parse(createdAt),
      );
  const carried: CustomerHubCarried | null = (() => {
    const storefronts = carriedArray(row.storefronts);
    const contentBlocks = carriedArray(row.content_blocks);
    const rules = carriedRecord(row.personalization_rules);
    const support = carriedRecord(row.support_settings);
    const styling = carriedRecord(row.styling);
    const metadata = carriedRecord(row.metadata);
    if (
      !storefronts ||
      !contentBlocks ||
      !rules ||
      !support ||
      !styling ||
      !metadata
    ) {
      return null;
    }
    return {
      storefronts,
      content_blocks: contentBlocks,
      personalization_rules: rules,
      support_settings: support,
      styling,
      metadata,
    };
  })();
  const togglesAreBoolean = CUSTOMER_HUB_TOGGLES.every(
    (toggle) => typeof row[toggle.key] === "boolean",
  );
  if (
    !version ||
    !isStatus(row.status) ||
    !timestampsConsistent ||
    !carried ||
    !togglesAreBoolean
  ) {
    return invalid(
      "The Customer Hub response failed its shape checks, so no configuration was shown.",
    );
  }
  if (
    row.runtime_available !== false ||
    row.runtime_status !== "held" ||
    typeof row.runtime_reason_code !== "string" ||
    !row.runtime_reason_code ||
    row.customer_agent_effective_enabled !== false
  ) {
    return invalid(
      "The Customer Hub response claimed a live storefront runtime this build cannot verify, so it was rejected.",
    );
  }
  return {
    value: {
      tenantId: expectedTenantId,
      version,
      status: row.status,
      order_history_enabled: row.order_history_enabled as boolean,
      favorites_enabled: row.favorites_enabled as boolean,
      coupons_enabled: row.coupons_enabled as boolean,
      recommendations_enabled: row.recommendations_enabled as boolean,
      customer_agent_enabled: row.customer_agent_enabled as boolean,
      runtimeStatus: "held",
      runtimeReasonCode: row.runtime_reason_code,
      createdAt,
      updatedAt,
      carried,
    },
    error: null,
  };
}

/** The editable slice of a decoded record. */
export function customerHubDraftFrom(
  config: CustomerHubConfig,
): CustomerHubDraft {
  return {
    status: config.status,
    order_history_enabled: config.order_history_enabled,
    favorites_enabled: config.favorites_enabled,
    coupons_enabled: config.coupons_enabled,
    recommendations_enabled: config.recommendations_enabled,
    customer_agent_enabled: config.customer_agent_enabled,
  };
}

/** The keys whose draft value differs from the verified record. */
export function customerHubChangedKeys(
  config: CustomerHubConfig,
  draft: CustomerHubDraft,
): string[] {
  const changed: string[] = [];
  if (draft.status !== config.status) changed.push("status");
  for (const toggle of CUSTOMER_HUB_TOGGLES) {
    if (draft[toggle.key] !== config[toggle.key]) changed.push(toggle.key);
  }
  return changed;
}

export function customerHubDraftChanged(
  config: CustomerHubConfig,
  draft: CustomerHubDraft,
): boolean {
  return customerHubChangedKeys(config, draft).length > 0;
}

/**
 * The server's refusal sentence when a draft asks for a release-held value,
 * or null when the draft is sendable. Mirrors service_suite.go:420 exactly so
 * mobile does not spend a round trip to be told no.
 */
export function customerHubHeldReason(draft: CustomerHubDraft): string | null {
  return draft.status === "active" || draft.customer_agent_enabled
    ? CUSTOMER_HUB_HELD_SENTENCE
    : null;
}

/**
 * The complete replacement body. Every editable member is present, and the
 * six object-shaped members are the exact values the decoder verified — a
 * mobile draft never narrows a record built elsewhere.
 */
export function buildCustomerHubReplacement(
  config: CustomerHubConfig,
  draft: CustomerHubDraft,
): Record<string, unknown> {
  return {
    status: draft.status,
    order_history_enabled: draft.order_history_enabled,
    favorites_enabled: draft.favorites_enabled,
    coupons_enabled: draft.coupons_enabled,
    recommendations_enabled: draft.recommendations_enabled,
    customer_agent_enabled: draft.customer_agent_enabled,
    storefronts: config.carried.storefronts,
    content_blocks: config.carried.content_blocks,
    personalization_rules: config.carried.personalization_rules,
    support_settings: config.carried.support_settings,
    styling: config.carried.styling,
    metadata: config.carried.metadata,
  };
}

/**
 * Whether a failed replacement could have committed anyway.
 *
 * `PUT` is not idempotent from the client's side once the ETag is spent: a
 * timeout or 5xx may have replaced the record. Those outcomes retire the
 * cached ETag and force a verified refresh; the server's frozen 4xx verdicts
 * are authoritative pre-effect refusals.
 */
const CUSTOMER_HUB_DEFINITIVE_NO_EFFECT_STATUSES = new Set([
  400, 401, 403, 404, 409, 412, 428, 429,
]);

export function customerHubWriteOutcomeIsAmbiguous(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const status = (error as { status?: unknown }).status;
  if (typeof status !== "number" || !Number.isSafeInteger(status)) return true;
  return !CUSTOMER_HUB_DEFINITIVE_NO_EFFECT_STATUSES.has(status);
}
